// One tap at the desk: what she just collected, written down.
//
// This is the hole the whole business was falling through. Deposits record
// themselves, because Stripe and the booking page write them. The balance
// is taken at the desk — cash, Zelle, her card reader — and for 60 of 64
// visits nothing wrote it down. So Studio Manager believed November was
// $442 when it was somewhere north of two thousand, her revenue report was
// a quarter of the truth, and Brianna's commission was understated by
// every balance ever handed over in person.
//
// The kiosk could already record a cash payment, but only with the client
// standing at the iPad signing. That is a flow for the client. This is a
// flow for her: she is the one who knows the money arrived, so one tap
// from the office is enough, and because SHE is tapping it, it counts as
// verified — unlike the kiosk, where a client tapping "I sent it on Venmo"
// is only a claim.
//
// Two rules, both learned the hard way in this codebase:
//
//   · The amount is calculated here, from the same bill the booking page
//     and the till quote, so the figure she confirms is the real one.
//     She can type over it, because she knows what she actually took.
//
//   · Money is written as a PAYMENT and re-summed, never incremented.
//     That is the lesson from a client credited $255 against $175 of real
//     charges. It also means cash and a card charge against the same visit
//     can live side by side without either wiping the other out — which
//     is why settleVisit() below is the single place a visit's money is
//     decided, and api/_charge.js now defers to it.
const { query, queryOne, execute } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const money = c => Math.max(0, Math.round(Number(c) || 0));
const dollars = c => '$' + (money(c) / 100).toFixed(2);
const lower = s => String(s || '').trim().toLowerCase();
const todayLA = () => new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10);
const shiftDay = (ymd, days) =>
  new Date(Date.parse(ymd + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);

/* How the money arrived. Anything she taps herself is money she has seen,
   so all of these are verified — the "said they paid" caveat belongs to
   the kiosk, where it is the client making the claim. */
const METHODS = {
  cash: 'Cash',
  card: 'Card reader',
  zelle: 'Zelle',
  venmo: 'Venmo',
  cashapp: 'Cash App',
  applepay: 'Apple Cash',
  other: 'Other',
};
const methodLabel = m => METHODS[lower(m)] || 'Cash';

/* How long after a payment an identical one is read as the same tap rather
   than a second payment. There is no confirm dialog in front of this, so
   this window is what stands between a slipped finger and the books saying
   she collected twice what she did. Ten minutes: long enough to cover a
   tap, a distraction and a tap, short enough that a genuine second payment
   for the same amount on the same visit is not swallowed. */
const DOUBLE_TAP_MS = 10 * 60 * 1000;

/* ── THE BOOK OF DESK PAYMENTS ──────────────────────────────────────── */
let _ready = null;
async function ensure() {
  if (_ready) return _ready;
  _ready = (async () => {
    await execute(`CREATE TABLE IF NOT EXISTS desk_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appointment_id INTEGER DEFAULT 0,
      client_name TEXT DEFAULT '',
      amount_cents INTEGER DEFAULT 0,
      tip_cents INTEGER DEFAULT 0,
      method TEXT DEFAULT 'cash',
      note TEXT DEFAULT '',
      prior_paid_cents INTEGER DEFAULT 0,
      prior_tip_cents INTEGER DEFAULT 0,
      prior_status TEXT DEFAULT '',
      prior_checked_out INTEGER DEFAULT 0,
      voided_ts INTEGER DEFAULT 0,
      ts INTEGER
    )`);
    try { await execute('CREATE INDEX IF NOT EXISTS desk_payments_appt ON desk_payments (appointment_id)'); } catch (_) {}
    try { await execute('CREATE INDEX IF NOT EXISTS desk_payments_ts ON desk_payments (ts)'); } catch (_) {}
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

const APPT_COLS = 'a.id, a.client_name, a.client_email, a.client_phone, a.service, a.date, a.time, '
  + "a.status, a.price_cents, a.deposit_cents, a.deposit_paid, a.member_id, a.notes, "
  + 'a.paid_cents, a.tip_cents, a.pay_method, a.checked_out_ts, a.checked_in_ts, '
  + "COALESCE(m.name,'') AS artist_name";

async function apptRow(id) {
  try {
    return await queryOne(
      'SELECT ' + APPT_COLS + ' FROM team_appointments a '
      + 'LEFT JOIN team_members m ON m.id = a.team_member_id WHERE a.id = ?', [Number(id) || 0]);
  } catch (_) { return null; }
}

/* The shape _kiosk-bill wants. Kept identical to the one in _charge.js so
   the three screens that can take money all quote the same number. */
function apptShape(r) {
  return {
    src: 't', id: Number(r.id), name: r.client_name || '', email: r.client_email || '',
    phone: r.client_phone || '', service: r.service || '', date: r.date || '',
    time: r.time || '', artist: r.artist_name || '', notes: r.notes || '',
    total_cents: money(r.price_cents), deposit_cents: money(r.deposit_cents),
    deposit_paid: Number(r.deposit_paid) ? 1 : 0, member_id: r.member_id || '',
  };
}

async function billOf(r) {
  try { return await require('./_kiosk-bill').billFor(apptShape(r)); } catch (_) { return null; }
}

/* ── THE ONE PLACE A VISIT'S MONEY IS DECIDED ───────────────────────────
   Everything that ever took money for a visit is a row in a book: desk
   payments here, card charges in card_charges. The visit's totals are the
   sum of what still stands in both, on top of whatever was already there
   before either tool first touched it.

   Re-summed from the rows every single time. So a refund is a charge that
   stopped counting, a voided cash entry is a payment that stopped
   counting, and no two tools can ever clobber each other's money. */
async function settleVisit(apptId) {
  const id = Number(apptId) || 0;
  if (!id) return null;
  await ensure();

  let desk = [];
  try { desk = await query('SELECT * FROM desk_payments WHERE appointment_id = ? ORDER BY id', [id]); } catch (_) {}

  let cards = [];
  try {
    cards = await query(
      `SELECT base_cents, tip_cents, refunded_cents, amount_cents, prior_paid_cents,
              prior_tip_cents, prior_status, prior_checked_out, ts
         FROM card_charges
        WHERE appointment_id = ? AND outcome = 'paid' ORDER BY id`, [id]);
  } catch (_) {}

  if (!desk.length && !cards.length) return null;

  /* What was on the visit before any of this existed. Whichever book wrote
     first holds the real baseline — taking the later one would count
     the earlier tool's own money as pre-existing and double it. */
  const all = []
    .concat(desk.map(r => ({ ts: Number(r.ts) || 0, r })))
    .concat(cards.map(r => ({ ts: Number(r.ts) || 0, r })))
    .sort((a, b) => a.ts - b.ts);
  const first = all[0].r;
  const prior = {
    paid: money(first.prior_paid_cents),
    tip: money(first.prior_tip_cents),
    status: first.prior_status || '',
    out: money(first.prior_checked_out),
  };

  /* What is still standing on a card charge: taken minus sent back, off
     the service first and the tip second, matching _charge.js. */
  const cardStanding = r => {
    const back = money(r.refunded_cents);
    const b = Math.max(0, money(r.base_cents) - back);
    const t = Math.max(0, money(r.tip_cents) - Math.max(0, back - money(r.base_cents)));
    return { b, t };
  };

  const liveDesk = desk.filter(r => !money(r.voided_ts));
  const liveCards = cards.map(cardStanding).filter(x => x.b + x.t > 0);

  const paid = prior.paid
    + liveDesk.reduce((s, r) => s + money(r.amount_cents), 0)
    + cards.reduce((s, r) => s + cardStanding(r).b, 0);
  const tip = prior.tip
    + liveDesk.reduce((s, r) => s + money(r.tip_cents), 0)
    + cards.reduce((s, r) => s + cardStanding(r).t, 0);

  const fields = { paid_cents: paid, tip_cents: tip };

  if (!liveDesk.length && !liveCards.length) {
    /* Everything taken has been given back or voided. Put the visit back
       exactly as it was, status and checkout time included, so an undone
       payment leaves no trace beyond the record of it having happened. */
    fields.pay_method = '';
    fields.status = prior.status || 'scheduled';
    fields.checked_out_ts = prior.out;
  } else {
    /* The most recent payment that still stands is how the visit got
       paid. Said plainly rather than as "split", because she reads this
       column to know where to look for the money. */
    const newestDesk = liveDesk.length ? liveDesk[liveDesk.length - 1] : null;
    const newestDeskTs = newestDesk ? Number(newestDesk.ts) || 0 : -1;
    const newestCardTs = cards.reduce(
      (t, r) => (cardStanding(r).b + cardStanding(r).t > 0 ? Math.max(t, Number(r.ts) || 0) : t), -1);
    fields.pay_method = newestDeskTs >= newestCardTs
      ? lower(newestDesk && newestDesk.method) || 'cash'
      : 'card_on_file';

    const r = await apptRow(id);
    /* A visit that has happened and is paid for is finished. A visit still
       to come is paid for and still to come — settling tomorrow's booking
       today must not claim tomorrow already happened. */
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

  /* The same visit can exist in the website book as well, and the reports
     keep the website row and drop the studio one when both are there. So
     money written to only one book is money a report cannot see. */
  try { await mirrorToWebsite(id, fields); } catch (_) {}

  return { paid_cents: paid, tip_cents: tip, pay_method: fields.pay_method || '' };
}

/* The twin row in the website book, matched on the same day, the same time
   and the same first name — the rule the kiosk already uses, kept the same
   here on purpose. Only ever written when exactly one row matches, because
   guessing which of two visits was paid for is worse than writing neither. */
async function mirrorToWebsite(apptId, fields) {
  const r = await apptRow(apptId);
  if (!r || !r.date || !r.time) return;
  const first = s => lower(s).split(/\s+/)[0] || '';
  const who = first(r.client_name);
  if (!who) return;
  const hhmm = String(r.time).slice(0, 5);

  const main = require('./_db');
  let rows = [];
  try {
    rows = await main.query(
      `SELECT a.id, a.guest_name, a.appointment_time AS time, m.full_name
         FROM appointments a LEFT JOIN members m ON a.member_id = m.member_id
        WHERE a.appointment_date = ?`, [r.date]);
  } catch (_) { return; }

  const hit = (rows || []).filter(x => String(x.time || '').slice(0, 5) === hhmm
    && first(x.full_name || x.guest_name) === who);
  if (hit.length !== 1) return;

  const id = Number(hit[0].id);
  for (const k of Object.keys(fields)) {
    try { await main.execute('UPDATE appointments SET ' + k + '=? WHERE id=?', [fields[k], id]); } catch (_) {}
  }
}

/* ── TAKING IT ──────────────────────────────────────────────────────── */

/* Record what she collected. Called once per tap; tapping twice inside a
   couple of minutes is read as the same payment rather than two, because
   there is no confirm dialog in front of this either. */
async function markPaid(opts) {
  await ensure();
  const o = opts || {};
  const id = Number(o.appointment_id) || 0;
  if (!id) return { ok: false, why: 'no_visit', message: 'Which visit?' };

  const appt = await apptRow(id);
  if (!appt) return { ok: false, why: 'gone', message: 'No appointment with that id.' };
  if (/cancel/i.test(String(appt.status || ''))) {
    return { ok: false, why: 'cancelled', message: 'That appointment is cancelled.' };
  }

  const bill = await billOf(appt);
  const already = money(appt.paid_cents);
  const suggested = Math.max(0, money(bill && bill.remainder_cents) - already);

  const asked = money(o.amount_cents);
  const amount = o.amount_cents === undefined || o.amount_cents === null || o.amount_cents === ''
    ? suggested : asked;
  const tip = money(o.tip_cents);

  if (!amount && !tip) {
    /* The ordinary way a second tap lands here: the first one already wrote
       the money down, so there is nothing left to suggest. Worth saying as
       reassurance rather than as an error — she pressed a button and needs
       to know whether it went down twice. */
    let mine = null;
    try {
      mine = await queryOne(
        'SELECT id, amount_cents, tip_cents, ts FROM desk_payments '
        + 'WHERE appointment_id = ? AND COALESCE(voided_ts,0) = 0 ORDER BY id DESC LIMIT 1', [id]);
    } catch (_) {}
    if (mine && Date.now() - (Number(mine.ts) || 0) < DOUBLE_TAP_MS) {
      return {
        ok: true, already: true, payment_id: Number(mine.id),
        amount_cents: money(mine.amount_cents),
        message: dollars(money(mine.amount_cents) + money(mine.tip_cents))
          + ' was already written down a moment ago — not twice.',
      };
    }
    return {
      ok: false, why: 'nothing_to_record',
      message: already
        ? dollars(already) + ' is already recorded against that visit. Type an amount if there was more.'
        : 'There is nothing left on that visit to record. Type an amount if there was more.',
    };
  }

  /* No confirm dialog, so a slipped finger sends this twice. The same
     visit, the same amount, the same method within two minutes is one
     payment — a genuine second payment a minute later is vanishingly rare
     next to a double tap, and voiding is one tap away either way. */
  const method = lower(o.method) in METHODS ? lower(o.method) : 'cash';
  try {
    const twin = await queryOne(
      'SELECT id, ts FROM desk_payments WHERE appointment_id = ? AND amount_cents = ? '
      + 'AND tip_cents = ? AND method = ? AND COALESCE(voided_ts,0) = 0 '
      + 'ORDER BY id DESC LIMIT 1', [id, amount, tip, method]);
    if (twin && Date.now() - (Number(twin.ts) || 0) < DOUBLE_TAP_MS) {
      return {
        ok: true, already: true, payment_id: Number(twin.id), amount_cents: amount,
        message: dollars(amount + tip) + ' was already written down a moment ago — not twice.',
      };
    }
  } catch (_) {}

  await execute(
    `INSERT INTO desk_payments
       (appointment_id, client_name, amount_cents, tip_cents, method, note,
        prior_paid_cents, prior_tip_cents, prior_status, prior_checked_out, voided_ts, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`,
    [id, appt.client_name || '', amount, tip, method,
     String(o.note || '').trim().slice(0, 160),
     money(appt.paid_cents), money(appt.tip_cents),
     appt.status || 'scheduled', money(appt.checked_out_ts), Date.now()]);

  const row = await queryOne(
    'SELECT id FROM desk_payments WHERE appointment_id = ? ORDER BY id DESC LIMIT 1', [id]);
  const applied = await settleVisit(id);

  return {
    ok: true,
    payment_id: Number(row && row.id) || 0,
    amount_cents: amount, tip_cents: tip,
    method, method_label: methodLabel(method),
    applied,
    message: dollars(amount + tip) + ' recorded as ' + methodLabel(method).toLowerCase() + '.',
  };
}

/* Undo. Voids the payment rather than deleting it, so the record of what
   happened survives, and re-sums the visit from what is left. */
async function voidPayment(paymentId) {
  await ensure();
  const row = await queryOne('SELECT * FROM desk_payments WHERE id = ?', [Number(paymentId) || 0]);
  if (!row) return { ok: false, why: 'No payment with that id.' };
  if (money(row.voided_ts)) {
    return { ok: true, already: true, message: 'That one was already taken off.' };
  }
  await execute('UPDATE desk_payments SET voided_ts = ? WHERE id = ?', [Date.now(), row.id]);
  const applied = row.appointment_id ? await settleVisit(row.appointment_id) : null;
  return {
    ok: true, amount_cents: money(row.amount_cents) + money(row.tip_cents), applied,
    message: dollars(money(row.amount_cents) + money(row.tip_cents)) + ' taken back off the books.',
  };
}

/* ── WHAT STILL NEEDS WRITING DOWN ──────────────────────────────────── */

/* Visits that happened and have no balance against them. This is the
   backlog she is working through, newest first, because the one she
   remembers best is the one she did yesterday.

   Deliberately NOT called money owed. Almost every one of these was paid
   at the desk and never written down — that is the whole reason this
   screen exists. The question each row asks is "what did you take?", not
   "who owes you?". */
async function unsettled({ days, limit } = {}) {
  await ensure();
  const back = Math.min(400, Math.max(1, Number(days) || 60));
  const cap = Math.min(200, Math.max(1, Number(limit) || 60));
  let rows = [];
  try {
    rows = await query(
      'SELECT ' + APPT_COLS + ' FROM team_appointments a '
      + 'LEFT JOIN team_members m ON m.id = a.team_member_id '
      + 'WHERE a.date >= ? AND a.date <= ? '
      + '  AND COALESCE(a.paid_cents,0) = 0 '
      + "  AND LOWER(COALESCE(a.status,'scheduled')) <> 'cancelled' "
      + 'ORDER BY a.date DESC, a.time DESC LIMIT ?',
      [shiftDay(todayLA(), -back), todayLA(), cap]);
  } catch (_) {}

  const visits = [];
  let covered = 0, prepaid = 0, unknownPrice = 0;
  for (const r of rows || []) {
    const b = await billOf(r);

    /* Two ways a visit can already be paid for in full, both ending with
       nothing left to collect at the desk, and both already counted by the
       recap because the money went through Stripe. Offering to write a
       second payment against either is offering to count the same visit
       twice:

         · their membership covered it
         · they prepaid the whole price online, so the "deposit" IS the
           bill — Ceadra's $120 Medium Gel X, Greenley's $65 Wednesday

       Neither is a judgement call: the remainder is zero and something
       verifiable accounts for the whole amount. */
    const remainder = money(b && b.remainder_cents);
    const byMembership = money(b && b.covered_by_membership);
    const depositTaken = money(b && b.deposit_taken_cents);
    if (remainder === 0 && byMembership > 0) { covered++; continue; }
    if (remainder === 0 && depositTaken > 0) { prepaid++; continue; }

    /* What is left either has a balance to record, or is a visit whose
       service is not on the price list at all. The second kind still
       belongs here — she did the work and took money for it — it just has
       no figure to suggest, so she types what she took. */
    if (!remainder) unknownPrice++;

    visits.push({
      id: Number(r.id),
      client: r.client_name || '',
      email: r.client_email || '',
      date: r.date || '',
      time: r.time || '',
      service: r.service || '',
      artist: r.artist_name || '',
      list_cents: money(b && b.list_cents),
      deposit_taken_cents: money(b && b.deposit_taken_cents),
      covered_by_membership: money(b && b.covered_by_membership),
      suggested_cents: money(b && b.remainder_cents),
      is_member: !!(b && b.is_member),
      tier_label: (b && b.tier_label) || '',
    });
  }
  return {
    visits,
    total_suggested_cents: visits.reduce((s, v) => s + v.suggested_cents, 0),
    days: back,
    /* Said out loud rather than quietly dropped. A list that silently
       hides rows is a list she cannot trust the length of. */
    covered_by_membership: covered,
    prepaid_in_full: prepaid,
    /* Visits whose service is not on the price list, so there is no figure
       to suggest and she has to type what she took. */
    price_unknown: unknownPrice,
    capped: visits.length >= cap,
  };
}

/* Everything written down this way, so a mistake can be found and undone. */
async function history({ from, to, limit } = {}) {
  await ensure();
  let rows = [];
  try {
    rows = await query(
      'SELECT * FROM desk_payments WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?',
      [Number(from) || 0, Number(to) || Date.now(), Math.min(300, Number(limit) || 60)]);
  } catch (_) {}

  const payments = (rows || []).map(r => ({
    id: Number(r.id),
    appointment_id: Number(r.appointment_id) || 0,
    client: r.client_name || '',
    amount_cents: money(r.amount_cents),
    tip_cents: money(r.tip_cents),
    method: r.method || 'cash',
    method_label: methodLabel(r.method),
    note: r.note || '',
    voided: !!money(r.voided_ts),
    ts: Number(r.ts) || 0,
  }));
  const live = payments.filter(p => !p.voided);
  return {
    payments,
    recorded_cents: live.reduce((s, p) => s + p.amount_cents + p.tip_cents, 0),
    recorded_count: live.length,
  };
}

/* ── THE DOOR ───────────────────────────────────────────────────────── */

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';
  const body = req.body || {};

  try {
    if (req.method === 'GET' && (action === 'unsettled' || !action)) {
      return res.json(await unsettled({ days: req.query.days, limit: req.query.limit }));
    }
    if (req.method === 'GET' && action === 'history') {
      const to = Number(req.query.to) || Date.now();
      const from = Number(req.query.from) || (to - 90 * 86400000);
      return res.json(await history({ from, to, limit: req.query.limit }));
    }
    if (req.method === 'GET' && action === 'methods') {
      return res.json({ methods: Object.keys(METHODS).map(k => ({ key: k, label: METHODS[k] })) });
    }
    if (req.method === 'POST' && action === 'paid') {
      const out = await markPaid(body);
      return res.status(out.ok ? 200 : 400).json(out);
    }
    if (req.method === 'POST' && action === 'void') {
      const out = await voidPayment(body.payment_id);
      return res.status(out.ok ? 200 : 400).json(out);
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};

module.exports.settleVisit = settleVisit;
module.exports.markPaid = markPaid;
module.exports.voidPayment = voidPayment;
module.exports.unsettled = unsettled;
module.exports.history = history;
module.exports.METHODS = METHODS;
module.exports.methodLabel = methodLabel;
