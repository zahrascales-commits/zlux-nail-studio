// Stripe deposit payments for bookings.
// - action=config   (public): is Stripe on + publishable key
// - action=deposit_intent (public): creates a PaymentIntent for the deposit,
//   amount recomputed SERVER-side from the service menu so it can't be tampered.
// Card is charged automatically when the client confirms on the booking page.
const { services, addons } = require('./_store');

// Stripe keys: the owner's keys pasted into Studio Manager → Settings →
// Connect Payments (stored write-only in site_settings) are the source of
// truth and take precedence, so connecting your own account "just works" and
// swapping test→live needs no redeploy. Vercel env vars are the fallback.
// Cached briefly to avoid hitting the DB on every request.
let _sk = '', _pk = '', _keyAt = 0;
async function loadStripeKeys() {
  if (Date.now() - _keyAt < 60000 && (_sk || _pk)) return;
  let dbSecret = '', dbPub = '';
  try {
    const { query, ensureTables } = require('./_team-db');
    await ensureTables();
    const rows = await query("SELECT key, value FROM site_settings WHERE key IN ('stripe_secret','stripe_publishable')");
    for (const r of rows) { if (r.key === 'stripe_secret') dbSecret = r.value; if (r.key === 'stripe_publishable') dbPub = r.value; }
  } catch (_) {}
  _sk = dbSecret || process.env.STRIPE_SECRET_KEY || '';
  _pk = dbPub || process.env.STRIPE_PUBLISHABLE_KEY || '';
  _keyAt = Date.now();
}
function clearStripeKeyCache() { _keyAt = 0; }
function stripeKey() { return _sk; }
function publishableKey() { return _pk; }

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

const ADDON_DISCOUNT = { SIGNATURE: 0.50, LUXE: 1.00, BLACK_CARD: 1.00 };

// The booking page says "Short Acrylic Set", the menu says "Short Acrylic",
// add-ons vary too — normalize so every spelling finds its price.
function norm(s) { return String(s || '').toLowerCase().replace(/\bset\b|\btechnique\b|\bsoak off\b/g, '').replace(/[^a-z]/g, ''); }
function findService(name) {
  const n = norm(name);
  return services.find(s => norm(s.name) === n)
    || services.find(s => n.includes(norm(s.name)) || norm(s.name).includes(n));
}
function findAddon(name) {
  const n = norm(name);
  return addons.find(a => norm(a.name) === n)
    || addons.find(a => n.includes(norm(a.name)) || norm(a.name).includes(n));
}

function computeDeposit({ service_name, addon_names = [], member_tier }) {
  const svc = findService(service_name);
  if (!svc) return null;
  const pct = member_tier ? (ADDON_DISCOUNT[member_tier] || 0) : 0;
  let total = svc.price_cents;
  for (const name of addon_names) {
    const a = findAddon(name);
    if (a) total += Math.round(a.price_cents * (1 - pct));
  }
  return { total_cents: total, deposit_cents: Math.max(50, Math.ceil(total * 0.5)) };
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await loadStripeKeys();
    if (req.method === 'GET' && action === 'config') {
      return res.json({
        enabled: !!(stripeKey() && publishableKey()),
        publishable_key: publishableKey() || null,
      });
    }

    // Multiple services / multiple people in ONE checkout: one PaymentIntent
    // covering the summed deposits, each recomputed server-side.
    if (req.method === 'POST' && action === 'multi_deposit_intent') {
      if (!stripeKey()) return res.status(400).json({ error: 'Payments not configured' });
      const { items, customer_name, customer_email, member_tier } = req.body || {};
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items required' });
      let total = 0, deposit = 0;
      const lines = [];
      for (const it of items.slice(0, 10)) {
        const calc = computeDeposit({ service_name: it.service_name, addon_names: it.addon_names || [], member_tier: member_tier || null });
        if (!calc) return res.status(400).json({ error: 'Unknown service: ' + it.service_name });
        total += calc.total_cents;
        deposit += calc.deposit_cents;
        lines.push((it.for_name ? it.for_name + ': ' : '') + it.service_name);
      }
      const params = {
        amount: String(deposit),
        currency: 'usd',
        'automatic_payment_methods[enabled]': 'true',
        description: `ZOLA deposit — ${lines.join(' + ')}`.slice(0, 300),
        'metadata[services]': lines.join(' | ').slice(0, 480),
        'metadata[client]': customer_name || '',
      };
      if (customer_email && /@/.test(customer_email)) params.receipt_email = customer_email;
      const pi = await stripeApi('payment_intents', params);
      return res.json({ client_secret: pi.client_secret, payment_intent_id: pi.id, deposit_cents: deposit, total_cents: total });
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

module.exports.computeDeposit = computeDeposit;
module.exports.clearStripeKeyCache = clearStripeKeyCache;
// Shared key accessors so every Stripe caller (classes, membership signup,
// owner utilities) uses the SAME account as the booking flow + publishable key.
module.exports.getStripeSecret = async function () { await loadStripeKeys(); return stripeKey(); };
module.exports.getStripePublishable = async function () { await loadStripeKeys(); return publishableKey(); };
module.exports.verifyPaymentIntent = async function (payment_intent_id) {
  await loadStripeKeys();
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
