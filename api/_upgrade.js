// Moving up a tier, without starting again.
//
// Before this, "upgrade your tier" was a link to the join page — which would
// have taken a second payment method, created a second Stripe subscription
// and left somebody paying for two memberships at once. This changes the
// subscription they already have.
//
// Stripe prorates: they are credited for the part of the month they have not
// used on the old tier and charged the difference for the rest. That credit
// is real money, so it is shown before they agree rather than after.
const { queryOne, execute } = require('./_db');

const TIER_ORDER = ['SIGNATURE', 'LUXE', 'BLACK_CARD'];
const TIER_LABEL = { SIGNATURE: 'Signature', LUXE: 'Luxe', BLACK_CARD: 'Black Card' };
const TIER_CENTS = { SIGNATURE: 9900, LUXE: 19900, BLACK_CARD: 29900 };
const TIER_YEARLY_CENTS = { SIGNATURE: 99900, LUXE: 199900, BLACK_CARD: 299900 };

// What you get by moving up, in the words a member would use. Kept here
// rather than read from the marketing page: this has to be true, and a
// sales page changes for reasons that have nothing to do with what is
// actually included.
const GAINS = {
  LUXE: [
    'Two included services a month instead of one',
    'Booking opens earlier for you than for Signature',
    'Bigger discount on every add-on',
  ],
  BLACK_CARD: [
    'Choose your own artist, every visit',
    'The earliest booking window of anyone',
    'Your preferences, allergies and history on file for every artist',
    'The largest add-on discount and the most included services',
  ],
};

async function authMember(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne(
    "SELECT * FROM sessions WHERE token = ? AND role = 'CLIENT' AND expires_at > CURRENT_TIMESTAMP",
    [token]);
}

async function stripeClient() {
  const pay = require('./_pay');
  const sk = await pay.getStripeSecret();
  if (!sk) return null;
  return require('stripe')(sk);
}

// The Stripe price for a tier, the same way signup resolves it: her own
// settings first, then env, so switching Stripe accounts does not silently
// upgrade somebody onto a price from the old one.
async function priceFor(stripe, tier, yearly) {
  if (yearly) {
    const amount = TIER_YEARLY_CENTS[tier];
    const lookupKey = ('zola_' + tier + '_yearly_' + amount).toLowerCase();
    try {
      const found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
      if (found && found.data && found.data[0]) return found.data[0].id;
    } catch (_) {}
    const created = await stripe.prices.create({
      unit_amount: amount, currency: 'usd', recurring: { interval: 'year' },
      lookup_key: lookupKey,
      product_data: { name: 'ZOLA ' + tier.replace('_', ' ') + ' — yearly' },
    });
    return created.id;
  }
  try {
    const row = await require('./_team-db').queryOne(
      'SELECT value FROM site_settings WHERE key=?', ['stripe_price_' + tier.toLowerCase()]);
    if (row && row.value) return row.value;
  } catch (_) {}
  return process.env['STRIPE_PRICE_' + tier] || null;
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const session = await authMember(req);
    if (!session) return res.status(401).json({ error: 'Please sign in again.' });
    const member = await queryOne('SELECT * FROM members WHERE member_id = ?', [session.user_id]);
    if (!member) return res.status(404).json({ error: 'Membership not found.' });

    const current = String(member.tier || '').toUpperCase();
    const idx = TIER_ORDER.indexOf(current);
    const higher = idx >= 0 ? TIER_ORDER.slice(idx + 1) : [];
    // Whether they pay monthly or yearly comes from the subscription itself,
    // not from a column. There is no billing_period on members, so reading
    // one would have quoted every yearly member a monthly price — and then
    // moved them onto a monthly plan when they accepted it.
    let yearly = false;
    if (member.stripe_subscription_id) {
      try {
        const s = await stripeClient();
        if (s) {
          const sub = await s.subscriptions.retrieve(member.stripe_subscription_id);
          const it = sub.items && sub.items.data && sub.items.data[0];
          yearly = !!(it && it.price && it.price.recurring && it.price.recurring.interval === 'year');
        }
      } catch (_) { /* a monthly quote is the safe wrong answer, not the dangerous one */ }
    }

    // ── What could they move to, and what would it cost ──
    if (req.method === 'GET') {
      const prices = yearly ? TIER_YEARLY_CENTS : TIER_CENTS;
      return res.json({
        current_tier: current,
        current_label: TIER_LABEL[current] || current,
        current_cents: prices[current] || 0,
        billing: yearly ? 'yearly' : 'monthly',
        at_top: higher.length === 0,
        options: higher.map(t => ({
          tier: t,
          label: TIER_LABEL[t],
          cents: prices[t] || 0,
          // The number that actually matters: what more it costs, not what
          // it costs. Somebody already paying $99 is deciding about $100,
          // not about $199.
          difference_cents: Math.max(0, (prices[t] || 0) - (prices[current] || 0)),
          gains: GAINS[t] || [],
        })),
      });
    }

    // ── Do it ──
    if (req.method === 'POST') {
      const to = String((req.body || {}).tier || '').toUpperCase();
      if (!TIER_ORDER.includes(to)) return res.status(400).json({ error: 'Unknown tier.' });
      if (TIER_ORDER.indexOf(to) <= idx) {
        // Downgrades are a different conversation with different terms, and
        // doing one silently through the upgrade route would break the
        // three-month minimum.
        return res.status(400).json({ error: 'That is not an upgrade. To change down, email us.' });
      }
      if (!member.stripe_subscription_id) {
        return res.status(400).json({ error: 'No active subscription to change — email us and we will sort it.' });
      }

      const stripe = await stripeClient();
      if (!stripe) return res.status(400).json({ error: 'Payments are not configured.' });

      const priceId = await priceFor(stripe, to, yearly);
      if (!priceId) return res.status(400).json({ error: 'That tier is not set up for payment yet.' });

      let sub;
      try {
        sub = await stripe.subscriptions.retrieve(member.stripe_subscription_id);
      } catch (e) {
        return res.status(400).json({ error: 'Could not find your subscription. Email us and we will sort it.' });
      }
      const item = sub.items && sub.items.data && sub.items.data[0];
      if (!item) return res.status(400).json({ error: 'Your subscription looks unusual — email us and we will sort it.' });

      let updated;
      try {
        updated = await stripe.subscriptions.update(member.stripe_subscription_id, {
          items: [{ id: item.id, price: priceId }],
          // Credit the unused part of the tier they are leaving and bill the
          // difference now, rather than charging a full extra month.
          proration_behavior: 'always_invoice',
          metadata: { ...(sub.metadata || {}), tier: to, upgraded_from: current, upgraded_at: new Date().toISOString() },
        });
      } catch (e) {
        return res.status(400).json({ error: (e && e.message) || 'Stripe would not make that change.' });
      }

      // Only now is it true. Writing the tier before Stripe agreed would
      // give somebody Black Card benefits on a Signature payment.
      await execute('UPDATE members SET tier = ? WHERE member_id = ?', [to, member.member_id]);
      try {
        await execute("ALTER TABLE members ADD COLUMN upgraded_at TEXT DEFAULT ''");
      } catch (_) {}
      try {
        await execute('UPDATE members SET upgraded_at = ? WHERE member_id = ?',
          [new Date().toISOString(), member.member_id]);
      } catch (_) {}

      const nextBilling = updated.current_period_end
        ? new Date(updated.current_period_end * 1000).toISOString()
        : null;
      if (nextBilling) {
        try { await execute('UPDATE members SET next_billing_at = ? WHERE member_id = ?', [nextBilling, member.member_id]); } catch (_) {}
      }

      // Tell her, because an upgrade is the best news she gets in a day.
      try {
        await require('./_notify').notifyInApp('owner', null,
          '⬆ ' + (member.full_name || member.member_id) + ' upgraded to ' + (TIER_LABEL[to] || to),
          'From ' + (TIER_LABEL[current] || current) + '. Stripe has billed the difference.');
      } catch (_) {}

      const prices = yearly ? TIER_YEARLY_CENTS : TIER_CENTS;
      return res.json({
        ok: true,
        tier: to,
        label: TIER_LABEL[to],
        from_label: TIER_LABEL[current] || current,
        cents: prices[to] || 0,
        billing: yearly ? 'yearly' : 'monthly',
        next_billing_at: nextBilling,
        gains: GAINS[to] || [],
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.TIER_ORDER = TIER_ORDER;
module.exports.TIER_LABEL = TIER_LABEL;
