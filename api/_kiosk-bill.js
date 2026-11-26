// What somebody owes at the front desk, and how they can pay it.
//
// The old till read a price off the appointment row. For anything the studio
// booked by hand there was no price on the row at all, so it said $0 and the
// client walked out without paying. And it knew nothing about memberships,
// so a member would have been charged full price for a service they had
// already paid for in their membership.
//
// This prices the visit the same way the booking page does — same menu, same
// membership rules — subtracts whatever deposit was actually taken, and says
// what is left.
const { query, queryOne } = require('./_team-db');

const money = c => Math.round(Number(c) || 0);

const COLS = 'member_id, full_name, email, phone, tier, stripe_customer_id, status, cancelled_at';

/* The same row plus the second person on it. Kept apart from COLS so a
   database that has not got these columns yet still answers every ordinary
   membership question. */
const PCOLS = COLS
  + ", COALESCE(partner_name,'') AS partner_name"
  + ", COALESCE(partner_email,'') AS partner_email"
  + ", COALESCE(partner_phone,'') AS partner_phone";

/* Added once per cold start, like every other column in this codebase.
   A membership is one subscription; the second name is a person it covers,
   not a second membership, so it lives on the same row. */
let _partnerReady = false;
async function ensurePartnerColumns() {
  if (_partnerReady) return;
  const main = require('./_db');
  for (const col of ['partner_name', 'partner_email', 'partner_phone']) {
    try { await main.execute("ALTER TABLE members ADD COLUMN " + col + " TEXT DEFAULT ''"); } catch (_) {}
  }
  _partnerReady = true;
}

/* Written on an appointment to mean "I have checked, and this is not a
   member" — so a phone or name that happens to look like somebody's does
   not quietly hand out a free service after she has said otherwise. */
const NOT_A_MEMBER = '-';

// Last ten digits, which is what matches a number typed any of the six ways
// people type one.
const tenDigits = p => String(p || '').replace(/[^0-9]/g, '').slice(-10);

/* A name, reduced to the part that is actually the name. "  elizabeth
   BANUELOS " and "Elizabeth Banuelos" are the same person; "Elizabeth B"
   is not, and is deliberately still a miss. */
const nameKey = n => String(n || '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/* The second person on somebody's membership.
 *
 * Deliberately weaker than every match against the member themselves: a
 * membership is identified by its holder first, and only then by who else
 * it covers. Returns the membership row with partner_matched set, so the
 * caller can say "Monica, on Justin's Elite" rather than calling her Justin.
 */
async function partnerMatch(appt) {
  const main = require('./_db');
  let rows = [];
  try {
    rows = await main.query(
      'SELECT ' + PCOLS + ' FROM members '
      + "WHERE COALESCE(partner_name,'') <> '' OR COALESCE(partner_email,'') <> '' "
      + "   OR COALESCE(partner_phone,'') <> ''");
  } catch (_) {
    return null;            // no such columns yet — nobody has a partner
  }
  if (!rows || !rows.length) return null;

  const take = (hits, how) => {
    // Exactly one, exactly as everywhere else: an ambiguous match is not an
    // answer, because a free service given to the wrong person is worse
    // than a deposit asked of the right one.
    if (hits.length !== 1) return null;
    const m = hits[0];
    return Object.assign(m, {
      matched_by: how,
      partner_matched: true,
      matched_name: m.partner_name || '',
    });
  };

  const email = String(appt.email || '').trim().toLowerCase();
  if (email) {
    const hit = take(rows.filter(r => String(r.partner_email || '').trim().toLowerCase() === email), 'partner_email');
    if (hit) return hit;
  }
  const phone = tenDigits(appt.phone);
  if (phone.length === 10) {
    const hit = take(rows.filter(r => tenDigits(r.partner_phone) === phone), 'partner_phone');
    if (hit) return hit;
  }
  const key = nameKey(appt.name);
  if (key) {
    const hit = take(rows.filter(r => nameKey(r.partner_name) === key), 'partner_name');
    if (hit) return hit;
  }
  return null;
}

/* Whether this person is a member, and on what.
 *
 * In order of how much each way of matching can be trusted. The first one
 * that answers wins, and nothing falls through to a weaker match after a
 * stronger one has already identified somebody.
 *
 *   member_id  she picked them, or it is already on the row. Final.
 *   email      what they type at the desk and what their membership is under.
 *   phone      what she types when she books by hand. Only when it names
 *              exactly one member — a number two members share is
 *              ambiguous, and a free service given to the wrong person is
 *              worse than a deposit asked of the right one.
 *   name       exact once case and spacing are set aside.
 *
 * The field matched_by comes back on the row so Studio Manager can show her how it
 * was decided rather than asking her to trust it. */
async function memberFor(appt) {
  const main = require('./_db');
  // The person the membership is in the name of, unless a partner match
  // says otherwise and sets its own.
  const mark = (m, how) => (m ? Object.assign(m, {
    matched_by: how, partner_matched: false, matched_name: m.full_name || '',
  }) : null);
  await ensurePartnerColumns();

  // She has said this person is not a member. That is an answer.
  if (String(appt.member_id || '') === NOT_A_MEMBER) return null;

  if (appt.member_id) {
    try {
      const m = await main.queryOne(
        'SELECT ' + COLS + ' FROM members WHERE member_id = ?', [appt.member_id]);
      if (m) return mark(m, 'member_id');
    } catch (_) {}
  }

  const email = String(appt.email || '').trim().toLowerCase();
  if (email) {
    try {
      const m = await main.queryOne(
        'SELECT ' + COLS + ' FROM members WHERE lower(email) = ?', [email]);
      if (m) return mark(m, 'email');
    } catch (_) {}
    // Nobody's membership is under that address — but it may be the second
    // name on somebody else's.
    const p = await partnerMatch({ email });
    if (p) return p;
  }

  /* The phone. Matched in here rather than in SQL because the column holds
     every format anybody has ever typed — 5595551234, (559) 555-1234,
     +1 559 555 1234 — and the last ten digits are the only part that is
     reliably the same number. */
  const phone = tenDigits(appt.phone);
  if (phone.length === 10) {
    try {
      const rows = await main.query(
        'SELECT ' + COLS + ' FROM members WHERE phone IS NOT NULL AND phone <> \'\'');
      const hits = (rows || []).filter(r => tenDigits(r.phone) === phone);
      // Exactly one, or it is not an answer.
      if (hits.length === 1) return mark(hits[0], 'phone');
    } catch (_) {}
    const p = await partnerMatch({ phone: appt.phone });
    if (p) return p;
  }

  const key = nameKey(appt.name);
  if (key) {
    try {
      const rows = await main.query('SELECT ' + COLS + ' FROM members');
      const hits = (rows || []).filter(r => nameKey(r.full_name) === key);
      if (hits.length === 1) return mark(hits[0], 'name');
    } catch (_) {}
    const p = await partnerMatch({ name: appt.name });
    if (p) return p;
  }
  return null;
}

// A membership that has been cancelled does not cover anything.
function memberTierOf(m) {
  if (!m) return null;
  if (m.cancelled_at) return null;
  if (/cancel/i.test(String(m.status || ''))) return null;
  return m.tier || null;
}

/* How many of their included services are still unspent this cycle. The
   booking flow already answers this; asking it again here means the till and
   the calendar can never disagree about whether something is covered. */
async function freeLeftFor(member) {
  const tier = memberTierOf(member);
  if (!member || !tier) return 0;
  try {
    return await require('./_pay').freeServicesLeft(member.member_id, tier);
  } catch (_) { return 0; }
}

/* The bill. Everything is derived, nothing is trusted from the browser. */
async function billFor(appt) {
  const pay = require('./_pay');
  const member = await memberFor(appt);
  const tier = memberTierOf(member);
  const freeLeft = await freeLeftFor(member);

  /* Her own rate, so the desk quotes the same number the booking page
     did. Two screens disagreeing about what somebody owes is the bug this
     studio has already been bitten by. */
  let ownRate = 0;
  try {
    ownRate = await require('./_client-rates').percentFor({
      email: appt.email || appt.client_email,
      phone: appt.phone || appt.client_phone,
      member_id: member && member.member_id,
    });
  } catch (_) {}

  /* Every service on the appointment, priced one at a time and added up.
     Booked by hand, three services arrive on one line — and the menu lookup
     matched whichever of them came first, so a member's included service
     covered one of three and the desk asked for the rest at full price. The
     allowance is spent in order, the same way the booking page spends it. */
  const parts = String(appt.service || '').split(/\s\+\s/).map(x => x.trim()).filter(Boolean);
  let left = freeLeft;
  let calc = null;
  for (const name of (parts.length ? parts : [appt.service])) {
    const c = pay.computeDeposit({
      service_name: name,
      addon_names: [],
      member_tier: tier,
      free_service: left > 0,
      design_tier: null,
      percent_off: ownRate,
    });
    if (!c) continue;
    if (c.used_included) left--;
    calc = calc
      ? {
          total_cents: calc.total_cents + c.total_cents,
          covered_cents: (calc.covered_cents || 0) + (c.covered_cents || 0),
          service_list_cents: (calc.service_list_cents || 0) + (c.service_list_cents || 0),
          used_included: calc.used_included || c.used_included,
        }
      : c;
  }

  /* A price agreed when they booked outranks today's menu. Greenley agreed
     $90 and paid half; the menu moved to $95 afterwards and would
     otherwise have asked her for the difference weeks later. */
  const agreed = money(appt.total_cents);

  // A service that is not on the menu any more still has to check out. The
  // row's own price is the fallback, and zero is better than inventing one.
  const listCents = agreed || (calc ? money(calc.service_list_cents) : money(appt.total_cents));

  let dueCents;
  if (agreed) {
    // Whatever the membership covers still comes off the agreed price.
    const covered = calc ? money(calc.covered_cents) : 0;
    dueCents = Math.max(0, agreed - covered);
  } else {
    dueCents = calc ? money(calc.total_cents) : Math.max(0, money(appt.total_cents));
  }

  // Only a deposit that was actually taken comes off.
  const depositTaken = Number(appt.deposit_paid) ? money(appt.deposit_cents) : 0;
  const remainder = Math.max(0, dueCents - depositTaken);

  return {
    service: appt.service,
    time: appt.time,
    artist: appt.artist || '',
    name: appt.name,
    is_member: !!tier,
    tier: tier || '',
    tier_label: tier ? (() => { try { const p = require('./_plans').byKey(tier); return p ? p.name : tier; } catch (_) { return tier; } })() : '',
    covered_by_membership: calc ? money(calc.covered_cents) : 0,
    list_cents: listCents,
    due_cents: dueCents,
    deposit_taken_cents: depositTaken,
    remainder_cents: remainder,
    member_id: member ? member.member_id : null,
    stripe_customer_id: member ? (member.stripe_customer_id || '') : '',
  };
}

/* A card we can charge without them getting it out again. Only a real Stripe
   payment method counts — the "card on file" flag imported from the old
   booking system is a note, not a card, and cannot be charged. */
/* Their Stripe customer, however they came to have one. A member has the
   id on their membership; anybody else who has paid a deposit by card has
   one findable by the email they paid with. */
async function customerIdFor(sk, stored, email, phone) {
  if (stored) return stored;
  if (!sk) return null;
  /* Nothing is created here. This is the read side — drawing the checkout
     screen must not make a Stripe customer for everybody who walks past. */
  try {
    const who = await require('./_customer').resolve({ sk, email, phone, create: false });
    return who.id || null;
  } catch (_) { return null; }
}

async function cardOnFile(sk, customerId) {
  if (!sk || !customerId) return null;
  try {
    const C = require('./_customer');
    const stripe = require('stripe')(sk);
    /* Everything saved, not only type=card. A deposit paid through Link
       saves a 'link' method; it charges off_session exactly like a card,
       and asking for cards alone is why the iPad offered no "one tap" to
       clients who had in fact left a card with us. */
    const list = await stripe.paymentMethods.list({ customer: customerId, limit: 20 });
    let def = '';
    try {
      const cust = await stripe.customers.retrieve(customerId);
      def = (cust && cust.invoice_settings && cust.invoice_settings.default_payment_method) || '';
      if (def && typeof def !== 'string') def = def.id || '';
    } catch (_) {}
    const pm = C.bestPM((list && list.data) || [], def);
    if (!pm) return null;
    const d = C.describePM(pm);
    return { id: pm.id, kind: pm.type, brand: d.brand, last4: d.last4, exp: d.exp, label: d.label || '' };
  } catch (_) { return null; }
}

module.exports = {
  billFor, memberFor, memberTierOf, cardOnFile, freeLeftFor, customerIdFor,
  NOT_A_MEMBER, tenDigits, nameKey, partnerMatch, ensurePartnerColumns, PCOLS,
};
