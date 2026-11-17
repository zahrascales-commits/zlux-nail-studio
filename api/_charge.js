// Charging a card on file, from Studio Manager, in one tap.
//
// The till can already do this, but only with the client standing there
// signing an iPad. Everything that happens after they have left — the
// balance on a visit, the set she did as a favour, the thing they said they
// would send and did not — had no door at all. So the money sat uncollected
// and the chasing happened by text.
//
// Four rules this is built around, all of them learned the hard way in this
// codebase:
//
//   · A visit's amount is calculated here, by the same code the booking
//     page and the till use, at the moment of charging — so a screen left
//     open for an hour cannot charge a stale number. She can type over it,
//     because a set that gained a repair or lost its art is a different
//     price; but then the number is one she has just read and typed, not
//     one the page was holding from an hour ago. A typed amount far above
//     the visit's own price is the one thing that stops and asks.
//
//   · A double tap is one charge. The key is the person, the amount, the
//     visit and the day, held UNIQUE in our own table and handed to Stripe
//     as well, so pressing twice finds the first charge instead of making a
//     second one. There is no confirm dialog in front of this by choice —
//     so this is the thing standing between a slipped finger and a real
//     charge on a real card.
//
//   · The money is written as the payment and re-summed. Never an
//     increment. That is the lesson from a client credited $255 against
//     $175 of real charges.
//
//   · Every charge is undoable in full, and undoing it puts the books back
//     exactly as they were — including the visit's status.
const { query, queryOne, execute } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const money = c => Math.max(0, Math.round(Number(c) || 0));
const lower = s => String(s || '').trim().toLowerCase();
const digits = p => String(p || '').replace(/[^0-9]/g, '');
const dollars = c => '$' + (money(c) / 100).toFixed(2);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* The studio's day, not the server's. Matched to _deposit-charge so the two
   screens that can take money never disagree about which day it is. */
const todayLA = () => new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10);
const shiftDay = (ymd, days) =>
  new Date(Date.parse(ymd + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);

/* An amount this far above the top of her menu is a decimal that slipped,
   not a decision. It is the one thing that stops and asks. */
const TYPO_CEILING = 100000;   // $1,000

/* ── THE BOOK OF CHARGES ────────────────────────────────────────────────
   Our own record, one row per charge, so the money on an appointment can
   always be re-summed from real payments rather than added to. */
let _ready = null;
async function ensure() {
  if (_ready) return _ready;
  _ready = (async () => {
    await execute(`CREATE TABLE IF NOT EXISTS card_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idem_key TEXT UNIQUE,
      client_name TEXT DEFAULT '',
      client_email TEXT DEFAULT '',
      appointment_id INTEGER DEFAULT 0,
      base_cents INTEGER DEFAULT 0,
      tip_cents INTEGER DEFAULT 0,
      amount_cents INTEGER DEFAULT 0,
      reason TEXT DEFAULT '',
      card_brand TEXT DEFAULT '',
      card_last4 TEXT DEFAULT '',
      customer TEXT DEFAULT '',
      payment_intent TEXT DEFAULT '',
      mandate TEXT DEFAULT '',
      prior_paid_cents INTEGER DEFAULT 0,
      prior_tip_cents INTEGER DEFAULT 0,
      prior_status TEXT DEFAULT '',
      prior_checked_out INTEGER DEFAULT 0,
      refunded_cents INTEGER DEFAULT 0,
      refund_id TEXT DEFAULT '',
      refunded_ts INTEGER DEFAULT 0,
      outcome TEXT DEFAULT '',
      ts INTEGER
    )`);
    try { await execute('CREATE INDEX IF NOT EXISTS card_charges_appt ON card_charges (appointment_id)'); } catch (_) {}
    try { await execute('CREATE INDEX IF NOT EXISTS card_charges_ts ON card_charges (ts)'); } catch (_) {}
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

/* ── STRIPE ─────────────────────────────────────────────────────────── */

async function sapi(key, path, params, extra) {
  const opts = {
    method: params ? 'POST' : 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + key }, extra || {}),
  };
  if (params) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(params).toString();
  }
  const r = await fetch('https://api.stripe.com/v1/' + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (j && j.error) || {};
    const err = new Error(e.message || ('Stripe returned ' + r.status));
    /* Shaped like a stripe-node error on purpose. _kiosk-charge.chargeProblem
       is what turns a failure into words for the screen, and it reads
       decline_code and .raw — the fields the library sets. Handing it the
       REST shape instead made every real decline come out as "a problem at
       our end, tell Zahra", which is the one message that must never appear
       for somebody's bank saying no. */
    err.code = e.code || '';
    err.decline_code = e.decline_code || '';
    err.decline = e.decline_code || '';
    err.raw = e;
    if (e.type === 'card_error') err.type = 'StripeCardError';
    throw err;
  }
  return j;
}

/* ── APPOINTMENTS ───────────────────────────────────────────────────── */

const APPT_COLS = `a.id, a.client_name, a.client_email, a.client_phone, a.service,
  a.date, a.time, a.status, a.price_cents, a.deposit_cents, a.deposit_paid,
  COALESCE(a.member_id,'') AS member_id,
  COALESCE(a.paid_cents,0)  AS paid_cents,
  COALESCE(a.tip_cents,0)   AS tip_cents,
  COALESCE(a.pay_method,'') AS pay_method,
  COALESCE(a.checked_out_ts,0) AS checked_out_ts,
  m.name AS artist_name`;

/* The shape _kiosk-bill prices. Identical to what the till hands it, so the
   two screens cannot quote different numbers for the same visit. */
function apptShape(r) {
  return {
    src: 't', id: Number(r.id), date: r.date || '',
    name: r.client_name || '', email: lower(r.client_email), phone: digits(r.client_phone),
    service: r.service || '', time: r.time || '', artist: r.artist_name || '',
    deposit_cents: Number(r.deposit_cents) || 0,
    deposit_paid: Number(r.deposit_paid) ? 1 : 0,
    // Usually nothing, and the menu decides. When set, it is the price
    // actually agreed and it wins over a later menu change.
    total_cents: Number(r.price_cents) > 0 ? Number(r.price_cents) : null,
    member_id: r.member_id || null,
  };
}

async function apptRow(id) {
  return queryOne(
    'SELECT ' + APPT_COLS + ' FROM team_appointments a '
    + 'LEFT JOIN team_members m ON m.id = a.team_member_id WHERE a.id = ?', [Number(id)]);
}

/* What one visit is worth, what has landed against it, and what is left. */
async function priceVisit(r) {
  const bill = require('./_kiosk-bill');
  let b = null;
  try { b = await bill.billFor(apptShape(r)); } catch (_) {}
  const paid = money(r.paid_cents);
  const outstanding = Math.max(0, money(b && b.remainder_cents) - paid);
  return {
    id: Number(r.id),
    date: r.date || '',
    time: r.time || '',
    service: r.service || '',
    artist: r.artist_name || '',
    status: r.status || 'scheduled',
    cancelled: /cancel/i.test(String(r.status || '')),
    list_cents: money(b && b.list_cents),
    due_cents: money(b && b.due_cents),
    deposit_taken_cents: money(b && b.deposit_taken_cents),
    covered_by_membership: money(b && b.covered_by_membership),
    paid_cents: paid,
    tip_cents: money(r.tip_cents),
    pay_method: r.pay_method || '',
    /* What is left on the menu price after a deposit and anything recorded.
       Named for what it is: a figure to charge if she wants to, NOT a debt.
       The studio records deposits and almost never records the balance, so
       a number here on a past visit usually means it was settled at the
       desk and never written down. */
    outstanding_cents: outstanding,
    // Whether anything at all is known about money on this visit.
    payment_recorded: !!(paid || money(b && b.deposit_taken_cents)),
    balance_recorded: paid > 0,
    is_member: !!(b && b.is_member),
    tier_label: (b && b.tier_label) || '',
    past: String(r.date || '') <= todayLA(),
  };
}

/* ── WHO CAN BE CHARGED ─────────────────────────────────────────────── */

/* Everyone with a card on file. The Stripe sweep is the slow part and is
   shared with the Cards on file tab rather than written twice. */
async function peopleList() {
  const pay = require('./_pay');
  const sk = await pay.getStripeSecret();
  if (!sk) return { people: [], stripe_ok: false };

  const cards = await require('./_cards').cardsByEmail(sk);

  const clients = await query(
    `SELECT id, name, email, phone, visits, last_visit FROM clients
      WHERE COALESCE(email,'') <> '' ORDER BY last_visit DESC, name LIMIT 400`)
    .catch(() => []);

  /* Members hold their customer id on the membership, so a member whose
     studio email differs from their Stripe one is still known. */
  const memberByEmail = {};
  try {
    const main = require('./_db');
    const rows = await main.query(
      "SELECT member_id, full_name, email, tier, stripe_customer_id, "
      + "COALESCE(partner_name,'') AS partner_name, COALESCE(partner_email,'') AS partner_email "
      + "FROM members WHERE COALESCE(status,'ACTIVE') <> 'CANCELLED'");
    for (const r of rows || []) {
      if (r.email) memberByEmail[lower(r.email)] = { tier: r.tier || '', holder: r.full_name || '', self: true };
      // The second name on a membership books on their own address.
      if (r.partner_email) {
        memberByEmail[lower(r.partner_email)] =
          { tier: r.tier || '', holder: r.full_name || '', self: false };
      }
    }
  } catch (_) {}

  /* How many visits are sitting unpaid, counted cheaply. The money itself
     is worked out when she taps somebody — pricing four hundred clients'
     appointments to draw a list would take longer than she will wait. */
  const unpaid = {};
  try {
    const rows = await query(
      `SELECT lower(COALESCE(client_email,'')) AS e, COUNT(*) AS n
         FROM team_appointments
        WHERE COALESCE(client_email,'') <> ''
          AND date >= ? AND date <= ?
          AND COALESCE(paid_cents,0) = 0
          AND LOWER(COALESCE(status,'scheduled')) <> 'cancelled'
        GROUP BY lower(COALESCE(client_email,''))`,
      [todayLA(), shiftDay(todayLA(), 45)]);
    for (const r of rows || []) unpaid[r.e] = Number(r.n) || 0;
  } catch (_) {}

  /* Who else is on each address. A card lives under an email, not under a
     person, so two client records sharing one address share one card — and
     the row has to say so before she takes money off it. */
  const housemates = {};
  for (const c of clients) {
    const k = lower(c.email);
    if (!k) continue;
    (housemates[k] = housemates[k] || []).push(c.name || '');
  }

  const nameKey = require('./_kiosk-bill').nameKey;

  /* One person, written two ways. A client record is often a first name, or
     a first name with an emoji on it, where the membership carries the full
     one — so "Ramille" is Ramille Wong and must not be warned about
     herself. The shorter name has to be the START of the longer one, so
     "Monica Robles" and "Justin Driggers" are still two people. */
  const samePerson = (a, b) => {
    const x = nameKey(a), y = nameKey(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return long.indexOf(short + ' ') === 0;
  };

  const people = [];
  for (const c of clients) {
    const key = lower(c.email);
    const hit = cards[key];
    if (!hit || !hit.card) continue;             // nothing to charge
    const mem = memberByEmail[key];
    /* The membership was found under this email — but the name on it may
       not be the name on this row. Monica's record carries her husband's
       address, so the membership behind it is his. */
    const ownMembership = !!mem && samePerson(c.name, mem.holder);
    people.push({
      id: Number(c.id),
      name: c.name || '',
      email: c.email || '',
      phone: c.phone || '',
      visits: Number(c.visits) || 0,
      last_visit: c.last_visit || '',
      card: hit.card.brand + ' ····' + hit.card.last4,
      card_exp: hit.card.exp || '',
      is_member: !!mem,
      tier: (mem && mem.tier) || '',
      // Said whenever the membership is in somebody else's name, whether
      // this row is the named second person or is simply using their
      // address. Either way the money is coming off their card.
      on_membership_of: mem && !ownMembership ? mem.holder : '',
      shared_with: (housemates[key] || []).filter(n => !samePerson(n, c.name)),
      unpaid_visits: unpaid[key] || 0,
    });
  }

  people.sort((a, b) => (b.unpaid_visits - a.unpaid_visits)
    || String(b.last_visit).localeCompare(String(a.last_visit))
    || String(a.name).localeCompare(String(b.name)));

  return { people, stripe_ok: true, count: people.length };
}

/* The visits actually waiting to be settled, priced properly. Deliberately
   a short list: these are the one-tap charges, and pricing each one costs
   real time. */
async function toSettle(limit) {
  const cap = Math.min(20, Math.max(1, Number(limit) || 12));
  let rows = [];
  try {
    rows = await query(
      'SELECT ' + APPT_COLS + ' FROM team_appointments a '
      + 'LEFT JOIN team_members m ON m.id = a.team_member_id '
      + "WHERE a.date >= ? AND a.date <= ? "
      + "  AND COALESCE(a.paid_cents,0) = 0 "
      + "  AND LOWER(COALESCE(a.status,'scheduled')) <> 'cancelled' "
      + "  AND COALESCE(a.client_email,'') <> '' "
      + 'ORDER BY a.date, a.time LIMIT ?',
      [todayLA(), shiftDay(todayLA(), 45), cap]);
  } catch (_) { return { visits: [] }; }

  const out = [];
  for (const r of rows || []) {
    const v = await priceVisit(r);
    if (!v.outstanding_cents) continue;
    v.client = r.client_name || '';
    v.email = r.client_email || '';
    out.push(v);
  }
  return { visits: out };
}

/* One person: their card, what they were told when they saved it, and every
   visit of theirs worth looking at. */
async function personDetail({ email, phone }) {
  const e = lower(email);
  const p = digits(phone).slice(-10);
  if (!e && !p) return { ok: false, why: 'Who?' };

  let rows = [];
  try {
    rows = await query(
      'SELECT ' + APPT_COLS + ' FROM team_appointments a '
      + 'LEFT JOIN team_members m ON m.id = a.team_member_id '
      + "WHERE lower(COALESCE(a.client_email,'')) = ? "
      + 'ORDER BY a.date DESC LIMIT 25', [e]);
  } catch (_) {}

  /* Somebody whose appointments were booked before an email was on file is
     found by their number instead. */
  if ((!rows || !rows.length) && p.length === 10) {
    try {
      const all = await query(
        'SELECT ' + APPT_COLS + ' FROM team_appointments a '
        + 'LEFT JOIN team_members m ON m.id = a.team_member_id '
        + 'ORDER BY a.date DESC LIMIT 400');
      rows = (all || []).filter(r => digits(r.client_phone).slice(-10) === p).slice(0, 25);
    } catch (_) {}
  }

  const visits = [];
  for (const r of rows || []) visits.push(await priceVisit(r));

  let memberId = '';
  try {
    const kb = require('./_kiosk-bill');
    const m = await kb.memberFor({ email: e, phone: p });
    if (m) memberId = m.member_id || '';
  } catch (_) {}

  const found = await require('./_deposit-charge').cardFor({ email: e, memberId });

  return {
    ok: true,
    email: e,
    member_id: memberId,
    can_charge: !!found.ok,
    card: found.ok ? found.card : null,
    mandate: found.ok ? found.mandate : null,
    why: found.ok ? '' : found.why,
    visits,
    outstanding_cents: visits.reduce((s, v) => s + (v.cancelled ? 0 : v.outstanding_cents), 0),
  };
}

/* ── WRITING THE MONEY ONTO THE VISIT ───────────────────────────────── */

/* The appointment's money is the sum of the charges standing against it,
   on top of whatever was already there before this tool first touched it.
   Re-summed every time, so a refund is simply a charge that stopped
   counting, and nothing is ever added twice. */
async function applyToAppointment(apptId) {
  const id = Number(apptId) || 0;
  if (!id) return null;

  const rows = await query(
    `SELECT base_cents, tip_cents, refunded_cents, prior_paid_cents, prior_tip_cents,
            prior_status, prior_checked_out
       FROM card_charges
      WHERE appointment_id = ? AND outcome = 'paid' ORDER BY id`, [id]);
  if (!rows || !rows.length) return null;

  const first = rows[0];

  /* What is still standing on each charge. A refund used to mean the whole
     row stopped counting; now $20 can come back off $95 and $75 keeps
     counting, so every row is worth what was taken minus what went back.
     Money off the service first, then the tip — a correction is almost
     always to the price of the work. */
  const standing = r => {
    const back = money(r.refunded_cents);
    const b = Math.max(0, money(r.base_cents) - back);
    const t = Math.max(0, money(r.tip_cents) - Math.max(0, back - money(r.base_cents)));
    return { b, t };
  };
  const live = rows.map(standing).filter(x => x.b + x.t > 0);
  const paid = money(first.prior_paid_cents) + rows.reduce((s, r) => s + standing(r).b, 0);
  const tip = money(first.prior_tip_cents) + rows.reduce((s, r) => s + standing(r).t, 0);

  const fields = { paid_cents: paid, tip_cents: tip };

  if (!live.length) {
    /* Everything we took has gone back. Put the row back exactly as it was,
       including the status, so an undone charge leaves no trace in the
       books beyond the record of it having happened. */
    fields.pay_method = '';
    fields.status = first.prior_status || 'scheduled';
    fields.checked_out_ts = money(first.prior_checked_out);
  } else {
    fields.pay_method = 'card_on_file';
    const r = await apptRow(id);
    /* A visit that has already happened and is now paid for is finished. A
       visit still to come is paid for and still to come — charging Monica
       today must not claim tomorrow's appointment already happened. */
    if (r && String(r.date || '') <= todayLA()) {
      fields.status = 'COMPLETED';
      if (!money(r.checked_out_ts)) fields.checked_out_ts = Date.now();
    }
  }

  const keys = Object.keys(fields);
  try {
    await execute('UPDATE team_appointments SET ' + keys.map(k => k + '=?').join(', ') + ' WHERE id=?',
      keys.map(k => fields[k]).concat([id]));
  } catch (_) {
    // One missing column must not cost the whole write.
    for (const k of keys) {
      try { await execute('UPDATE team_appointments SET ' + k + '=? WHERE id=?', [fields[k], id]); } catch (_) {}
    }
  }
  return { paid_cents: paid, tip_cents: tip };
}

/* ── TAKING IT ──────────────────────────────────────────────────────── */

async function doCharge(opts) {
  await ensure();
  const o = opts || {};
  const apptId = Number(o.appointment_id) || 0;

  let email = lower(o.email);
  let name = String(o.name || '').trim();
  let base = 0;
  let label = '';
  let visitCeiling = 0;
  let visitList = 0;
  let appt = null;
  let memberId = '';

  if (apptId) {
    appt = await apptRow(apptId);
    if (!appt) return { ok: false, why: 'gone', message: 'No appointment with that id.' };
    if (/cancel/i.test(String(appt.status || ''))) {
      return { ok: false, why: 'cancelled', message: 'That appointment is cancelled.' };
    }
    /* Re-priced here, so the figure on the row is never a stale one: the
       guard against a tab left open while the client paid, the price
       changed, or her membership covered it after all. */
    const v = await priceVisit(appt);

    /* She has typed over it. They added a repair, or skipped the art and
       kept them nude — the visit's price and what they owe for it are two
       different things, and only one of them is in the database. */
    const asked = money(o.amount_cents);
    base = asked || v.outstanding_cents;

    /* A typed amount is not compared against what is outstanding, so a
       visit that looks settled can still take the add-on she just did. */
    if (asked) {
      const list = money(v.list_cents) || money(v.outstanding_cents);
      visitList = list;
      /* Nothing under $200 ever asks, and nor does anything within a few
         hundred of the visit's own price. What this catches is $950 typed
         for a $95 set — the slipped decimal the thousand-dollar ceiling is
         too high to see. */
      visitCeiling = Math.max(list * 4, list + 30000, 20000);
    }
    if (!base) {
      /* The ordinary way a second tap lands here: the first one already
         took the money, so there is nothing left owing. Worth saying as
         reassurance rather than as an error — she pressed a button and
         needs to know whether a card was hit twice. It was not. */
      const mine = await queryOne(
        "SELECT amount_cents, ts FROM card_charges WHERE appointment_id = ? "
        + "AND outcome = 'paid' AND COALESCE(refunded_cents,0) = 0 ORDER BY id DESC LIMIT 1",
        [apptId]);
      if (mine && Date.now() - Number(mine.ts || 0) < 15 * 60 * 1000) {
        return {
          ok: true, already: true,
          amount_cents: money(mine.amount_cents),
          message: 'Already charged ' + dollars(mine.amount_cents)
            + ' a moment ago — nothing has been taken twice.',
        };
      }
      return {
        ok: false, why: 'nothing_owed',
        message: (appt.client_name || 'They') + ' has nothing outstanding on that visit'
          + (v.paid_cents ? ' — ' + dollars(v.paid_cents) + ' is already paid against it.' : '.'),
      };
    }
    label = (appt.service || 'Visit') + ' · ' + (appt.date || '');
    email = email || lower(appt.client_email);
    name = name || appt.client_name || '';
    memberId = appt.member_id && appt.member_id !== '-' ? appt.member_id : '';
  } else {
    base = money(o.amount_cents);
    label = String(o.reason || '').trim().slice(0, 120) || 'Studio charge';
    if (!base) return { ok: false, why: 'no_amount', message: 'How much?' };
  }

  if (!email) {
    return {
      ok: false, why: 'no_email',
      message: 'There is no email address for them, so there is no card to look for.',
    };
  }

  const tip = money(o.tip_cents);
  const total = base + tip;

  // Stripe will not take less than fifty cents, whatever we ask it.
  if (total < 50) {
    return { ok: false, why: 'too_small', message: 'A card charge has to be at least 50¢.' };
  }

  /* The only thing that stops and asks. There is no confirm dialog behind
     this, so this is the whole defence against a decimal in the wrong
     place — and it never asks twice. */
  const ceiling = visitCeiling ? Math.min(TYPO_CEILING, visitCeiling) : TYPO_CEILING;
  if (total > ceiling && o.allow_large !== true) {
    return {
      ok: false, why: 'too_big',
      message: 'That is ' + dollars(total)
        + (visitList ? ' on a visit priced ' + dollars(visitList) : '')
        + '. If you meant it, press it again and it will go — this only asks once, '
        + 'in case a decimal slipped.',
    };
  }

  if (!memberId) {
    try {
      const m = await require('./_kiosk-bill').memberFor({ email, phone: digits(o.phone) });
      if (m) memberId = m.member_id || '';
    } catch (_) {}
  }

  const found = await require('./_deposit-charge').cardFor({ email, memberId });
  if (!found.ok) {
    return {
      ok: false, why: found.why,
      message: found.why === 'no_card' || found.why === 'no_customer'
        ? 'No card saved for ' + (name || 'them') + '. Send them the link from Cards on file — '
          + 'one tap, and it is there for next time.'
        : (found.why || 'Could not find a card.'),
    };
  }

  /* ── ONE TAP, ONE CHARGE ──────────────────────────────────────────
     There is no confirm screen in front of this, so a slipped finger sends
     the same request twice. The key is what the charge IS — this person,
     this amount, this visit, this reason, today — so the second press
     finds the first charge rather than making another one. A genuinely
     different charge has a different key and is not blocked. */
  const idem = ['zola-chg', apptId || 'free', money(total), lower(email).slice(0, 40),
    (label || '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40), todayLA()].join('-').slice(0, 180);

  const had = await queryOne('SELECT * FROM card_charges WHERE idem_key = ?', [idem]);
  if (had && had.outcome === 'paid' && !(money(had.refunded_cents) > 0)) {
    return {
      ok: true, already: true, charge_id: Number(had.id),
      amount_cents: money(had.amount_cents),
      card: { brand: had.card_brand, last4: had.card_last4 },
      message: 'That one was already charged a moment ago — nothing has been taken twice.',
    };
  }

  const prior = appt
    ? {
        paid: money(appt.paid_cents), tip: money(appt.tip_cents),
        status: appt.status || 'scheduled', out: money(appt.checked_out_ts),
      }
    : { paid: 0, tip: 0, status: '', out: 0 };

  let pi;
  try {
    pi = await sapi(found.key, 'payment_intents', {
      amount: String(total),
      currency: 'usd',
      customer: found.customer,
      payment_method: found.payment_method,
      off_session: 'true',
      confirm: 'true',
      description: 'ZOLA · ' + label,
      'metadata[kind]': 'charged_by_owner',
      'metadata[appointment_id]': String(apptId || ''),
      'metadata[base_cents]': String(base),
      'metadata[tip_cents]': String(tip),
      'metadata[mandate]': String((found.mandate && found.mandate.kind) || ''),
    }, { 'Idempotency-Key': idem });
  } catch (err) {
    /* Their bank wants the cardholder to approve it. That is not a decline,
       and calling it one would be a lie that loses the money. */
    if (err.code === 'authentication_required') {
      await recordRow({ idem, name, email, apptId, base, tip, total, label, found, prior,
        pi: null, outcome: 'needs_them' });
      return {
        ok: false, why: 'needs_them',
        message: 'Their bank wants ' + (name || 'them') + ' to approve this one. A saved card '
          + 'cannot do that on its own — take it at the desk, or send them a payment link.',
      };
    }
    const p = require('./_kiosk-charge').chargeProblem(err);
    await recordRow({ idem, name, email, apptId, base, tip, total, label, found, prior,
      pi: null, outcome: ('failed: ' + (p.why || '')).slice(0, 180) });
    return { ok: false, why: p.declined ? 'declined' : 'our_end', message: p.why, detail: p.detail };
  }

  if (pi.status !== 'succeeded') {
    await recordRow({ idem, name, email, apptId, base, tip, total, label, found, prior,
      pi, outcome: 'failed: ' + pi.status });
    return { ok: false, why: 'declined', message: 'The card did not complete it (' + pi.status + ').' };
  }

  const row = await recordRow({ idem, name, email, apptId, base, tip, total, label, found, prior,
    pi, outcome: 'paid' });

  const applied = apptId ? await applyToAppointment(apptId) : null;

  // The authorisation book, where every card-on-file charge lands. The
  // signature line stays empty on purpose: there was no signature. What
  // there is, is a receipt.
  try {
    await require('./_kiosk-charge').recordAuthorization({
      ref: apptId ? ('t' + apptId) : 'manual',
      client_name: name, client_email: email,
      amount_cents: total, remainder_cents: base, tip_cents: tip,
      method: 'card_on_file', card_brand: found.card.brand, card_last4: found.card.last4,
      signature: '', payment_intent: pi.id,
      outcome: 'charged_by_owner · ' + ((found.mandate && found.mandate.kind) || '') + ' · ' + label,
    });
  } catch (_) {}

  let receipt = null;
  if (o.no_notify !== true) {
    try {
      receipt = await sendReceipt({
        email, name, base, tip, total, label, appt,
        card: found.card, what: o.reason || '',
      });
    } catch (_) {}
    try {
      await require('./_notify').notifyInApp('owner', null,
        '💳 ' + (name || email) + ' charged ' + dollars(total),
        found.card.brand + ' ····' + found.card.last4 + ' · ' + label);
    } catch (_) {}
  }

  return {
    ok: true,
    charge_id: Number(row && row.id) || 0,
    payment_intent: pi.id,
    amount_cents: total, base_cents: base, tip_cents: tip,
    card: found.card,
    mandate: found.mandate,
    label,
    applied,
    receipt,
  };
}

async function recordRow(x) {
  await execute(
    `INSERT OR IGNORE INTO card_charges
       (idem_key, client_name, client_email, appointment_id, base_cents, tip_cents,
        amount_cents, reason, card_brand, card_last4, customer, payment_intent, mandate,
        prior_paid_cents, prior_tip_cents, prior_status, prior_checked_out, outcome, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [x.idem, x.name || '', x.email || '', x.apptId || 0, money(x.base), money(x.tip),
     money(x.total), x.label || '', x.found.card.brand || '', x.found.card.last4 || '',
     x.found.customer || '', (x.pi && x.pi.id) || '',
     (x.found.mandate && x.found.mandate.kind) || '',
     money(x.prior.paid), money(x.prior.tip), x.prior.status || '', money(x.prior.out),
     x.outcome || '', Date.now()]);
  return queryOne('SELECT * FROM card_charges WHERE idem_key = ?', [x.idem]);
}

/* ── UNDOING IT ─────────────────────────────────────────────────────── */

/* Sending money back — all of it, or part of it. This is what stands in
   for a confirm dialog: the charge goes instantly, and a wrong one is one
   tap from never having happened. Partly wrong is the commoner kind — $95
   taken where $75 was right — so the amount is hers to set here too, and
   leaving it alone sends back everything. */
async function doRefund(chargeId, { reason, amount_cents } = {}) {
  await ensure();
  const row = await queryOne('SELECT * FROM card_charges WHERE id = ?', [Number(chargeId)]);
  if (!row) return { ok: false, why: 'No charge with that id.' };
  if (row.outcome !== 'paid') return { ok: false, why: 'That one never went through, so there is nothing to send back.' };
  if (!row.payment_intent) return { ok: false, why: 'No Stripe payment recorded against it.' };

  const took = money(row.amount_cents);
  const gone = money(row.refunded_cents);
  const left = Math.max(0, took - gone);
  if (!left) {
    return { ok: true, already: true, refunded_cents: gone, kept_cents: 0,
      message: 'All ' + dollars(took) + ' of that one has already gone back.' };
  }

  let want = money(amount_cents) || left;
  if (want > left) want = left;          // never more than is there
  const back = gone + want;              // what will have gone back in total
  const kept = took - back;
  const partial = kept > 0;

  const key = await require('./_pay').getStripeSecret();
  if (!key) return { ok: false, why: 'Payments are not switched on.' };

  let refund;
  try {
    refund = await sapi(key, 'refunds', {
      payment_intent: row.payment_intent,
      amount: String(want),
      'metadata[kind]': partial ? 'adjusted_by_owner' : 'undone_by_owner',
      'metadata[charge_row]': String(row.id),
    /* Keyed on the running total, not the row. Two taps of "send $20 back"
       in the same moment compute the same total and so are one refund;
       a genuine second $20 later is a different total and goes. */
    }, { 'Idempotency-Key': 'zola-rf-' + row.id + '-' + back });
  } catch (err) {
    return { ok: false, why: 'Stripe would not send it back: ' + (err.message || 'unknown') };
  }

  await execute(
    'UPDATE card_charges SET refunded_cents = ?, refund_id = ?, refunded_ts = ? WHERE id = ?',
    [back, [row.refund_id, refund.id].filter(Boolean).join(' ').slice(0, 300), Date.now(), row.id]);

  const applied = row.appointment_id ? await applyToAppointment(row.appointment_id) : null;

  /* A correction, not an accusation. Their card was charged and the charge
     was ours to undo, so the note says exactly that. */
  let note = null;
  const quick = Date.now() - Number(row.ts || 0) < 10 * 60 * 1000;
  try {
    note = await sendRefundNote({
      email: row.client_email, name: row.client_name,
      cents: want, took: took, kept: kept, label: row.reason || '',
      card: { brand: row.card_brand, last4: row.card_last4 },
      ourMistake: quick && !partial, reason: String(reason || '').trim(),
    });
  } catch (_) {}

  try {
    await require('./_notify').notifyInApp('owner', null,
      '↩︎ ' + dollars(want) + ' sent back to ' + (row.client_name || row.client_email),
      (partial ? 'They paid ' + dollars(kept) + ' in the end' : 'Undone' + (quick ? ' straight away' : ''))
        + ' · ' + (row.reason || ''));
  } catch (_) {}

  return {
    ok: true, refunded_cents: want, total_refunded_cents: back, kept_cents: kept,
    partial, refund_id: refund.id || '', applied, note,
  };
}

/* ── THE RECORD ─────────────────────────────────────────────────────── */

async function history({ from, to, limit }) {
  await ensure();
  const rows = await query(
    `SELECT id, client_name, client_email, appointment_id, base_cents, tip_cents, amount_cents,
            reason, card_brand, card_last4, payment_intent, mandate,
            refunded_cents, refund_id, refunded_ts, outcome, ts
       FROM card_charges
      WHERE ts >= ? AND ts <= ?
      ORDER BY ts DESC LIMIT ?`,
    [Number(from) || 0, Number(to) || Date.now(), Math.min(300, Number(limit) || 60)]);

  const charges = (rows || []).map(r => ({
    id: Number(r.id),
    name: r.client_name || '',
    email: r.client_email || '',
    appointment_id: Number(r.appointment_id) || 0,
    amount_cents: money(r.amount_cents),
    base_cents: money(r.base_cents),
    tip_cents: money(r.tip_cents),
    reason: r.reason || '',
    card: (r.card_brand || 'card') + ' ····' + (r.card_last4 || ''),
    payment_intent: r.payment_intent || '',
    mandate: r.mandate || '',
    paid: r.outcome === 'paid',
    outcome: r.outcome || '',
    refunded: money(r.refunded_cents) >= money(r.amount_cents) && money(r.refunded_cents) > 0,
    refunded_cents: money(r.refunded_cents),
    refundable_cents: Math.max(0, money(r.amount_cents) - money(r.refunded_cents)),
    refunded_ts: Number(r.refunded_ts) || 0,
    ts: Number(r.ts) || 0,
  }));

  const live = charges.filter(c => c.paid && c.refundable_cents > 0);
  return {
    charges,
    taken_cents: live.reduce((s, c) => s + c.refundable_cents, 0),
    taken_count: live.length,
  };
}

/* ── WHAT THEY GET ──────────────────────────────────────────────────── */

const SHELL = inner => `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px 14px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #eee5d8">
    <div style="background:#0D0D0D;padding:26px 24px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:6px;color:#F5EEE8">ZOLA</div>
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8B6A3E;margin-top:6px">Nail Studio · Porterville</div>
    </div>
    <div style="padding:28px 24px">${inner}</div>
  </div>
</div>`;

const LINE = (l, r, bold) =>
  '<div style="display:flex;justify-content:space-between;font-size:' + (bold ? '15' : '14')
  + 'px;color:#3a3027;padding:5px 0' + (bold ? ';font-weight:bold;border-top:1px solid #eee5d8;margin-top:6px' : '')
  + '"><span>' + l + '</span><span>' + r + '</span></div>';

/* A receipt, immediately. It is the client's answer to "what was that
   charge" and it is the studio's answer to a dispute, so it names the
   amount, what it was for, and the card — never just a total. */
async function sendReceipt({ email, name, base, tip, total, label, appt, card, what }) {
  const to = String(email || '').trim();
  if (!to || !/@/.test(to)) return { sent: false, why: 'no email' };

  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  let when = '';
  if (appt && appt.date) {
    try {
      const v = require('./_visit');
      when = v.pretty(appt.date) + (appt.time ? ' at ' + v.time12(appt.time) : '');
    } catch (_) { when = appt.date; }
  }

  const rows = [LINE(esc(appt ? (appt.service || 'Your visit') : (what || label || 'Studio charge')), dollars(base))]
    .concat(tip ? [LINE('Tip', dollars(tip))] : [])
    .concat([LINE('Paid', dollars(total), true)]);

  const body = SHELL(
    '<p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 16px">Hi ' + esc(first) + ',</p>'
    + '<p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 20px">'
    + 'Here is your receipt — taken from the card you have on file, so there is nothing for you to do.</p>'
    + '<div style="background:#faf7f4;border:1px solid #eee5d8;padding:16px 18px;margin:0 0 20px">'
    + (when ? '<div style="font-family:Georgia,serif;font-size:17px;color:#0D0D0D;margin-bottom:10px">' + esc(when) + '</div>' : '')
    + rows.join('')
    + '<div style="font-size:13px;color:#8C7A5E;margin-top:10px">'
    + esc((card && card.brand) || 'card') + ' ····' + esc((card && card.last4) || '')
    + '</div></div>'
    + '<p style="font-size:14px;line-height:1.7;color:#8C7A5E;margin:0">'
    + 'Anything here look wrong? Reply to this email and we will put it right — no need to ring your bank.'
    + '</p>');

  return require('./_notify').sendEmail(
    to, 'Your receipt ✦ ' + dollars(total) + ' — ZOLA', body, { kind: 'charge_receipt' });
}

/* When a charge is undone. Never written as though they did something: a
   charge the studio made and took back is the studio's to explain. */
async function sendRefundNote({ email, name, cents, took, kept, label, card, ourMistake, reason }) {
  const to = String(email || '').trim();
  if (!to || !/@/.test(to)) return { sent: false, why: 'no email' };
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';

  /* Three different things, and they must not be worded the same. Part of
     it back is an adjustment — the price changed, nobody did anything
     wrong, and an apology for a "muddle" would invent a problem. All of it
     back straight away is ours to own. All of it back later is just a
     refund. None of the three ever reads as though the client did it. */
  const partial = money(kept) > 0;
  const why = reason
    ? esc(reason)
    : (partial
        ? 'We have adjusted what we took for your visit.'
        : (ourMistake
            ? 'That charge was a mistake at our end, caught straight away.'
            : 'We have sent that one back.'));

  const body = SHELL(
    '<p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 16px">Hi ' + esc(first) + ',</p>'
    + '<p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 20px">'
    + why + ' ' + dollars(cents) + ' is on its way back to your '
    + esc((card && card.brand) || 'card') + ' ····' + esc((card && card.last4) || '')
    + ' — banks usually show it within a few working days.</p>'
    + (label || partial
        ? '<div style="background:#faf7f4;border:1px solid #eee5d8;padding:14px 18px;margin:0 0 20px">'
          + (partial
              ? LINE(esc(label || 'Charged'), dollars(took))
                + LINE('Sent back', '&minus;' + dollars(cents))
                + LINE('What you paid', dollars(kept), true)
              : LINE(esc(label), '&minus;' + dollars(cents)))
          + '</div>'
        : '')
    + '<p style="font-size:14px;line-height:1.7;color:#8C7A5E;margin:0">'
    + (partial
        ? 'Nothing for you to do — your receipt for ' + dollars(kept) + ' still stands.'
        : 'Nothing for you to do, and sorry for the muddle.') + '</p>');

  return require('./_notify').sendEmail(
    to,
    (partial ? 'Adjusted ✦ ' + dollars(cents) + ' back' : 'Sent back ✦ ' + dollars(cents)) + ' — ZOLA',
    body, { kind: 'charge_refund' });
}

/* ── THE DOOR ───────────────────────────────────────────────────────── */

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';
  const body = req.body || {};

  try {
    if (req.method === 'GET' && (action === 'people' || !action)) {
      return res.json(await peopleList());
    }

    if (req.method === 'GET' && action === 'settle') {
      return res.json(await toSettle(req.query.limit));
    }

    if (req.method === 'GET' && action === 'person') {
      const out = await personDetail({ email: req.query.email, phone: req.query.phone });
      return res.status(out.ok ? 200 : 400).json(out);
    }

    if (req.method === 'GET' && action === 'history') {
      const to = Number(req.query.to) || Date.now();
      const from = Number(req.query.from) || (to - 60 * 86400000);
      return res.json(await history({ from, to, limit: req.query.limit }));
    }

    if (req.method === 'POST' && action === 'charge') {
      const out = await doCharge(body);
      return res.status(out.ok ? 200 : 400).json(out);
    }

    if (req.method === 'POST' && action === 'refund') {
      const out = await doRefund(body.charge_id,
        { reason: body.reason, amount_cents: body.amount_cents });
      return res.status(out.ok ? 200 : 400).json(out);
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};

module.exports.peopleList = peopleList;
module.exports.toSettle = toSettle;
module.exports.personDetail = personDetail;
module.exports.doCharge = doCharge;
module.exports.doRefund = doRefund;
module.exports.history = history;
module.exports.applyToAppointment = applyToAppointment;
module.exports.priceVisit = priceVisit;
module.exports.apptShape = apptShape;
module.exports.TYPO_CEILING = TYPO_CEILING;
