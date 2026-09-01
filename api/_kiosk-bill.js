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

/* Whether this person is a member, and on what. Matched on email first
   because that is the thing they type at the desk, then on name. */
async function memberFor(appt) {
  const main = require('./_db');
  if (appt.member_id) {
    try {
      const m = await main.queryOne(
        'SELECT member_id, full_name, email, tier, stripe_customer_id, status, cancelled_at FROM members WHERE member_id = ?',
        [appt.member_id]);
      if (m) return m;
    } catch (_) {}
  }
  if (appt.email) {
    try {
      const m = await main.queryOne(
        'SELECT member_id, full_name, email, tier, stripe_customer_id, status, cancelled_at FROM members WHERE lower(email) = ?',
        [String(appt.email).toLowerCase()]);
      if (m) return m;
    } catch (_) {}
  }
  if (appt.name) {
    try {
      const m = await main.queryOne(
        'SELECT member_id, full_name, email, tier, stripe_customer_id, status, cancelled_at FROM members WHERE lower(full_name) = lower(?)',
        [String(appt.name).trim()]);
      if (m) return m;
    } catch (_) {}
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

  const calc = pay.computeDeposit({
    service_name: appt.service,
    addon_names: [],
    member_tier: tier,
    free_service: freeLeft > 0,
    design_tier: null,
  });

  // A service that is not on the menu any more still has to check out. The
  // row's own price is the fallback, and zero is better than inventing one.
  const listCents = calc ? money(calc.service_list_cents) : money(appt.total_cents);
  const dueCents = calc
    ? money(calc.total_cents)
    : Math.max(0, money(appt.total_cents));

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
async function customerIdFor(sk, stored, email) {
  if (stored) return stored;
  if (!sk || !email || !/@/.test(email)) return null;
  try {
    const r = await fetch(
      'https://api.stripe.com/v1/customers?limit=1&email=' + encodeURIComponent(String(email).toLowerCase()),
      { headers: { Authorization: 'Bearer ' + sk } });
    const j = await r.json();
    return (j && j.data && j.data[0]) ? j.data[0].id : null;
  } catch (_) { return null; }
}

async function cardOnFile(sk, customerId) {
  if (!sk || !customerId) return null;
  try {
    const stripe = require('stripe')(sk);
    const cust = await stripe.customers.retrieve(customerId);
    let pmId = cust && cust.invoice_settings && cust.invoice_settings.default_payment_method;
    if (!pmId) {
      const list = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
      pmId = list && list.data && list.data[0] ? list.data[0].id : null;
    }
    if (!pmId) return null;
    const pm = typeof pmId === 'string' ? await stripe.paymentMethods.retrieve(pmId) : pmId;
    if (!pm || !pm.card) return null;
    return { id: pm.id, brand: pm.card.brand, last4: pm.card.last4, exp: pm.card.exp_month + '/' + String(pm.card.exp_year).slice(-2) };
  } catch (_) { return null; }
}

module.exports = { billFor, memberFor, memberTierOf, cardOnFile, freeLeftFor, customerIdFor };
