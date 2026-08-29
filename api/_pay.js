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

/* What comes off an add-on for a member. The retired tiers discounted
   everything by a flat rate; Essential and Elite do not — Elite includes two
   named add-ons outright and charges normally for the rest, which is what
   the memberships page says. A tier missing from here charged every member
   the guest price. */
const ADDON_DISCOUNT = { ESSENTIAL: 0, ELITE: 0, SIGNATURE: 0.50, LUXE: 1.00, BLACK_CARD: 1.00 };

/* Hands or feet. The menu has no category on it, but every pedicure says
   so in its name, and the difference decides both what a member pays and
   what their included service is allowed to cover. */
function serviceCategory(name) {
  return /pedicure|pedi\b|toes?\b/i.test(String(name || '')) ? 'pedicure' : 'manicure';
}

/* Whether a membership's included service can be spent on this. Essential
   and Elite include a manicure, so a pedicure is never free on them — it is
   charged at the members' price instead. */
function includesCategory(tier, category) {
  const perks = perksFor(tier).filter(p => p.kind === 'free_service');
  if (!perks.length) return false;
  return perks.some(p => !p.of || p.of === 'any' || p.of === category);
}

function perksFor(tier) {
  try { return require('./_perks').tierPerks(tier) || []; } catch (_) { return []; }
}

// Add-ons a tier includes by name rather than by percentage.
function addonsIncludedFor(tier) {
  try {
    const t = require('./_perks').tierPerks(tier);
    // Matched through the same normaliser the menu uses, so 'Soak Off
    // Removal' on the membership finds the add-on actually called 'Removal'.
    return (t || []).filter(p => p.kind === 'addon_free' && p.of).map(p => norm(p.of));
  } catch (_) { return []; }
}

// The booking page says "Short Acrylic Set", the menu says "Short Acrylic",
// add-ons vary too — normalize so every spelling finds its price.
function norm(s) { return String(s || '').toLowerCase().replace(/\bset\b|\btechnique\b|\bsoak off\b/g, '').replace(/[^a-z]/g, ''); }
// An empty or missing name must NOT match. The loose fallback uses includes(),
// and every string contains the empty string — so a malformed request used to
// price silently as the first item on the menu instead of being rejected.
function findService(name) {
  const n = norm(name);
  if (!n) return null;
  return services.find(s => norm(s.name) === n)
    || services.find(s => n.includes(norm(s.name)) || norm(s.name).includes(n));
}
function findAddon(name) {
  const n = norm(name);
  if (!n) return null;
  return addons.find(a => norm(a.name) === n)
    || addons.find(a => n.includes(norm(a.name)) || norm(a.name).includes(n));
}

// `free_service` means this member still has an included service left this
// month. The booking page has always tagged those "Included" and the
// memberships page sells them as free, but the full price was still being
// charged — the membership covered the service everywhere except on the bill.
// The caller decides entitlement, because only it has read the usage counter.
// The design tier is priced here with everything else. A tier that costs
// $10 in the browser and $0 on the server is a discount nobody authorised.
function computeDeposit({ service_name, addon_names = [], member_tier, free_service, design_tier }) {
  const svc = findService(service_name);
  if (!svc) return null;

  const category = serviceCategory(svc.name || service_name);

  /* An allowance only covers what the membership actually includes. Without
     this, a member booking a pedicure first had it taken off their included
     service — free to them, and the studio never sees the money. */
  if (free_service && member_tier && !includesCategory(member_tier, category)) {
    free_service = false;
  }

  /* Some things a membership does not include but does price differently —
     the Russian pedicure is $75 to a member and $95 to anyone else. */
  let memberCents = null;
  try { memberCents = require('./_plans').memberPriceFor(member_tier, svc.name || service_name); } catch (_) {}
  const listCents = svc.price_cents;
  const chargeCents = (memberCents !== null && memberCents !== undefined) ? memberCents : listCents;
  const pct = member_tier ? (ADDON_DISCOUNT[member_tier] || 0) : 0;
  const tiers = require('./_tiers');

  // What this membership includes by name rather than by percentage.
  const freeAddons = member_tier ? addonsIncludedFor(member_tier) : [];
  const perks = member_tier ? perksFor(member_tier) : [];
  const designFree = perks.some(p => p.kind === 'discount' && p.on === 'design' && Number(p.value) >= 100);

  /* Charged even when the service itself is covered by a membership: the
     included service is the service, not the extra design work on top. The
     exception is a membership that says designs cost nothing, which is the
     whole promise on Essential and Elite. */
  const tierListCents = design_tier ? tiers.priceFor(design_tier) : 0;
  const tierCents = designFree ? 0 : tierListCents;

  let total = (free_service ? 0 : chargeCents) + tierCents;
  // What the membership took off: the whole service if it is included, or
  // the difference down to the members' price if it is not.
  let covered = (free_service ? listCents : (listCents - chargeCents))
    + (designFree ? tierListCents : 0);

  for (const name of addon_names) {
    const a = findAddon(name);
    if (!a) continue;
    // Included outright beats any percentage.
    if (freeAddons.includes(norm(a.name))) {
      covered += a.price_cents;
      continue;
    }
    total += Math.round(a.price_cents * (1 - pct));
    covered += Math.round(a.price_cents * pct);
  }
  return {
    total_cents: total,
    // Nothing to pay means nothing to deposit. The 50c floor exists because
    // Stripe will not take a smaller charge — applying it to a visit the
    // membership already covers would bill someone 50c for something they
    // were just told was free.
    deposit_cents: total <= 0 ? 0 : Math.max(50, Math.ceil(total * 0.5)),
    // What the membership just took off — shown to the member and recorded,
    // rather than silently disappearing into a smaller number.
    service_list_cents: listCents,
    service_charged_cents: chargeCents,
    category,
    tier_cents: tierCents,
    tier_list_cents: tierListCents,
    covered_cents: covered,
  };
}

// How many included services this member has left this month. The count
// itself comes from _perks so the bill, the wallet and the welcome reveal
// all read the same definition; the counter is the one the booking flow
// increments, so what is charged and what is spent cannot disagree.
async function freeServicesLeft(member_id, member_tier) {
  if (!member_id || !member_tier) return 0;
  const limit = require('./_perks').includedCount(member_tier);
  if (!limit) return 0;
  try {
    const { queryOne } = require('./_db');
    const monthYear = new Date().toISOString().slice(0, 7);
    const row = await queryOne('SELECT services_used FROM service_usage WHERE member_id = ? AND month_year = ?', [member_id, monthYear]);
    return Math.max(0, limit - Number((row && row.services_used) || 0));
  } catch (_) { return 0; }
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
      const { items, customer_name, customer_email, member_tier, member_id, pay_full, tip_cents } = req.body || {};
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items required' });
      let total = 0, deposit = 0, covered = 0;
      // The allowance is spent one service at a time across the cart — a
      // member with one left booking three does not get all three free.
      let freeLeft = await freeServicesLeft(member_id, member_tier);
      const lines = [];
      for (const it of items.slice(0, 10)) {
        const useFree = freeLeft > 0;
        if (useFree) freeLeft--;
        const calc = computeDeposit({ service_name: it.service_name, addon_names: it.addon_names || [], member_tier: member_tier || null, free_service: useFree, design_tier: req.body.design_tier });
        if (!calc) return res.status(400).json({ error: 'Unknown service: ' + it.service_name });
        total += calc.total_cents;
        deposit += calc.deposit_cents;
        covered += calc.covered_cents || 0;
        lines.push((it.for_name ? it.for_name + ': ' : '') + it.service_name);
      }
      /* Paying in full, and the tip.
         The browser says which option was picked and how much tip — never
         what anything costs. The service total is still the one worked out
         here from the menu, so the only figure a tampered request can move
         is a tip somebody is volunteering. Even that is capped: a runaway
         value would be a charge nobody agreed to. */
      const wantsFull = !!pay_full;
      const tip = Math.max(0, Math.min(Math.round(Number(tip_cents) || 0), total * 2));

      /* The early bird comes off a booking too — ten dollars off the first
         ten people means whatever they are buying, not memberships alone.
         Taken off what is actually being collected today, and never below
         the fifty cents Stripe will accept, so it cannot turn a real charge
         into a failed one. A tip is somebody's own money and is left alone. */
      let ebOff = 0, ebLabel = '';
      try {
        const s = await require('./_earlybird').state();
        if (s.available) {
          const base = wantsFull ? total : deposit;
          ebOff = Math.min(s.amount_cents, Math.max(0, base - 50));
          ebLabel = s.label;
        }
      } catch (_) {}

      const charge = Math.max(0, (wantsFull ? total : deposit) - ebOff) + tip;

      // Nothing to collect — the membership covered it and no tip was added.
      // Asking Stripe for a zero charge is an error, not a free visit.
      if (charge <= 0) {
        return res.json({
          client_secret: null, payment_intent_id: null,
          deposit_cents: 0, total_cents: total, covered_cents: covered,
          tip_cents: 0, charged_cents: 0, paid_in_full: wantsFull, fully_covered: true,
          early_bird_cents: 0, early_bird_label: '',
        });
      }
      const params = {
        amount: String(charge),
        currency: 'usd',
        'automatic_payment_methods[enabled]': 'true',
        description: ((wantsFull ? 'ZOLA — ' : 'ZOLA deposit — ') + lines.join(' + ')
          + (tip ? ' (incl. tip)' : '')).slice(0, 300),
        'metadata[services]': lines.join(' | ').slice(0, 480),
        'metadata[client]': customer_name || '',
        'metadata[paid_in_full]': wantsFull ? 'yes' : 'no',
        'metadata[tip_cents]': String(tip),
        'metadata[early_bird_cents]': String(ebOff),
      };
      if (customer_email && /@/.test(customer_email)) params.receipt_email = customer_email;
      const pi = await stripeApi('payment_intents', params);
      return res.json({
        client_secret: pi.client_secret, payment_intent_id: pi.id,
        deposit_cents: deposit, total_cents: total, covered_cents: covered,
        tip_cents: tip, charged_cents: charge, paid_in_full: wantsFull,
        early_bird_cents: ebOff, early_bird_label: ebLabel,
      });
    }

    if (req.method === 'POST' && action === 'deposit_intent') {
      if (!stripeKey()) return res.status(400).json({ error: 'Payments not configured' });
      const { service_name, addon_names, member_tier, member_id, customer_name, customer_email } = req.body || {};
      const calc = computeDeposit({ service_name, addon_names, member_tier,
        free_service: (await freeServicesLeft(member_id, member_tier)) > 0 });
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
    // Metadata rides back too. Callers put things on the intent at creation
    // — an early-bird amount, a tip — and need them again once the money has
    // actually cleared, without trusting the browser to say so a second time.
    return {
      paid: pi.status === 'succeeded' || pi.status === 'processing',
      status: pi.status, amount: pi.amount, metadata: pi.metadata || {},
    };
  } catch (e) { return { paid: false, why: String(e.message || e) }; }
};

// The till prices a service the same way the booking page does.
module.exports.serviceCategory = serviceCategory;
