// What a member actually pays — one answer, used by every screen.
//
// Every revenue figure on this site was derived from a hardcoded list price:
// Signature 99, Luxe 199, Black Card 299. Nothing recorded what anybody was
// really charged, so a member on the founding rate paying $100 counted as
// $299, somebody on an annual plan counted at the monthly price, and every
// discount the studio gave was invisible in its own accounts.
//
// The number now lives on the member record, written when they sign up and
// again when they change tier. The list price survives only as the answer
// for rows that predate this, and those are flagged as estimates rather
// than quietly passed off as fact.
const { execute, queryOne } = require('./_db');

const LIST_MONTHLY = { SIGNATURE: 9900, LUXE: 19900, BLACK_CARD: 29900, TEST: 158 };
const LIST_YEARLY = { SIGNATURE: 99900, LUXE: 199900, BLACK_CARD: 299900, TEST: 1580 };

async function ensureColumns() {
  for (const sql of [
    // What they are charged each period, after any discount.
    "ALTER TABLE members ADD COLUMN paid_cents INTEGER DEFAULT 0",
    // 'monthly' or 'yearly' — a yearly member pays twelve times less often.
    "ALTER TABLE members ADD COLUMN billing_period TEXT DEFAULT 'monthly'",
    // Which code they used, so a figure can be explained rather than just shown.
    "ALTER TABLE members ADD COLUMN promo_code TEXT DEFAULT ''",
  ]) { try { await execute(sql); } catch (_) {} }
}

// Record what somebody is actually charged. Called at signup and on upgrade.
async function record(memberId, { paid_cents, billing_period, promo_code }) {
  if (!memberId) return;
  await ensureColumns();
  try {
    await execute(
      'UPDATE members SET paid_cents=?, billing_period=?, promo_code=? WHERE member_id=?',
      [Math.max(0, Math.round(Number(paid_cents) || 0)),
       billing_period === 'yearly' ? 'yearly' : 'monthly',
       String(promo_code || '').slice(0, 32),
       memberId]);
  } catch (_) {}
}

// What this member contributes to a month, whatever they pay and however
// often. A yearly member is worth a twelfth of their payment each month —
// counting the whole year in the month they joined would show a spike that
// never repeats and a drop that never recovers.
//
// Returns { cents, estimated } so a caller can say which figures it is sure
// about. A number nobody can vouch for should not look like one that is
// counted.
function monthlyValue(member) {
  const tier = String((member || {}).tier || '').toUpperCase();
  const yearly = String((member || {}).billing_period || '') === 'yearly';
  const paid = Number((member || {}).paid_cents) || 0;

  if (paid > 0) {
    return { cents: yearly ? Math.round(paid / 12) : paid, estimated: false, yearly };
  }
  // Nothing recorded: this member predates the column. The list price is the
  // best guess available and is marked as one.
  const list = (yearly ? LIST_YEARLY : LIST_MONTHLY)[tier] || 0;
  return { cents: yearly ? Math.round(list / 12) : list, estimated: true, yearly };
}

// What they have paid across their whole membership, for a lifetime figure.
function paidToDate(member, months) {
  const v = monthlyValue(member);
  return { cents: v.cents * Math.max(0, months), estimated: v.estimated };
}

// Fill in members who signed up before any of this existed, by asking Stripe
// what their subscription actually costs. Cheap to run, safe to repeat, and
// it only ever writes a figure it got from Stripe.
async function backfillFromStripe(members) {
  await ensureColumns();
  let stripe = null;
  try {
    const sk = await require('./_pay').getStripeSecret();
    if (sk) stripe = require('stripe')(sk);
  } catch (_) {}
  if (!stripe) return { filled: 0, why: 'no stripe key' };

  let filled = 0;
  for (const m of members || []) {
    if (Number(m.paid_cents) > 0) continue;
    if (!m.stripe_subscription_id) continue;
    try {
      const sub = await stripe.subscriptions.retrieve(m.stripe_subscription_id, { expand: ['discount'] });
      const item = sub.items && sub.items.data && sub.items.data[0];
      if (!item || !item.price) continue;

      const interval = item.price.recurring && item.price.recurring.interval;
      let cents = Number(item.price.unit_amount) || 0;

      // A coupon on the subscription is the difference between the list price
      // and what leaves their bank. That difference is the whole point of
      // this file.
      const d = sub.discount && sub.discount.coupon;
      if (d) {
        if (d.amount_off) cents = Math.max(0, cents - Number(d.amount_off));
        else if (d.percent_off) cents = Math.round(cents * (1 - Number(d.percent_off) / 100));
      }

      await record(m.member_id, {
        paid_cents: cents,
        billing_period: interval === 'year' ? 'yearly' : 'monthly',
        promo_code: (sub.metadata && sub.metadata.promo_code) || '',
      });
      filled++;
    } catch (_) {}
  }
  return { filled };
}

module.exports = {
  LIST_MONTHLY, LIST_YEARLY,
  ensureColumns, record, monthlyValue, paidToDate, backfillFromStripe,
};
