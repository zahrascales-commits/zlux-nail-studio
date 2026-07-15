// Stripe deposit payments for bookings.
// - action=config   (public): is Stripe on + publishable key
// - action=deposit_intent (public): creates a PaymentIntent for the deposit,
//   amount recomputed SERVER-side from the service menu so it can't be tampered.
// Card is charged automatically when the client confirms on the booking page.
const { services, addons } = require('./_store');

function stripeKey() { return process.env.STRIPE_SECRET_KEY || ''; }

async function stripeApi(path, params) {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + stripeKey(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error && data.error.message || ('stripe ' + r.status));
  return data;
}

const ADDON_DISCOUNT = { SIGNATURE: 0.10, LUXE: 0.30, BLACK_CARD: 0.75 };

function computeDeposit({ service_name, addon_names = [], member_tier }) {
  const svc = services.find(s => s.name === service_name);
  if (!svc) return null;
  const pct = member_tier ? (ADDON_DISCOUNT[member_tier] || 0) : 0;
  let total = svc.price_cents;
  for (const name of addon_names) {
    const a = addons.find(x => x.name === name);
    if (a) total += Math.round(a.price_cents * (1 - pct));
  }
  return { total_cents: total, deposit_cents: Math.ceil(total * 0.5) };
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    if (req.method === 'GET' && action === 'config') {
      return res.json({
        enabled: !!(stripeKey() && process.env.STRIPE_PUBLISHABLE_KEY),
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
      });
    }

    if (req.method === 'POST' && action === 'deposit_intent') {
      if (!stripeKey()) return res.status(400).json({ error: 'Payments not configured' });
      const { service_name, addon_names, member_tier, customer_name, customer_email } = req.body || {};
      const calc = computeDeposit({ service_name, addon_names, member_tier });
      if (!calc) return res.status(400).json({ error: 'Unknown service' });
      const params = {
        amount: String(calc.deposit_cents),
        currency: 'usd',
        'automatic_payment_methods[enabled]': 'true',
        description: `ZOLA deposit — ${service_name} (${customer_name || 'client'})`,
        'metadata[service]': service_name || '',
        'metadata[client]': customer_name || '',
      };
      if (customer_email && /@/.test(customer_email)) params.receipt_email = customer_email;
      const pi = await stripeApi('payment_intents', params);
      return res.json({ client_secret: pi.client_secret, payment_intent_id: pi.id, deposit_cents: calc.deposit_cents, total_cents: calc.total_cents });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.verifyPaymentIntent = async function (payment_intent_id) {
  if (!stripeKey() || !payment_intent_id) return { paid: false, why: 'not configured' };
  try {
    const r = await fetch('https://api.stripe.com/v1/payment_intents/' + encodeURIComponent(payment_intent_id), {
      headers: { Authorization: 'Bearer ' + stripeKey() },
    });
    const pi = await r.json();
    if (!r.ok) return { paid: false, why: pi.error && pi.error.message || 'stripe error' };
    return { paid: pi.status === 'succeeded' || pi.status === 'processing', status: pi.status, amount: pi.amount };
  } catch (e) { return { paid: false, why: String(e.message || e) }; }
};
