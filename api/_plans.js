// The two memberships ZOLA actually sells, and how many have joined.
//
// Replaces Signature / Luxe / Black Card, which assumed a client who came
// twice a month and wanted a pedicure. Her own booking data said otherwise:
// the median client comes every four weeks, 85% of appointments are hands
// only, and 9% of clients have ever had a pedicure at all. So the cycle is
// four weeks, the pedicure is an add-on, and there are two tiers instead of
// three.
//
// One file holds the prices, the inclusions and the capacities, because the
// page, the checkout and the account all have to agree — and because a
// price that lives in three places eventually disagrees with itself.
const { query, queryOne, execute } = require('./_db');

// Thirteen four-week cycles in a year. That is the whole reason annual can
// honestly be called three visits free: 13 payments' worth for the price of
// 10, and the difference is exactly three cycles.
const CYCLES_PER_YEAR = 13;

// Annual is priced at eleven cycles for thirteen, so the saving is exactly
// two visits. Three was too much to give away on a membership this size.
const FREE_VISITS_ANNUAL = 2;

const PLANS = [
  {
    key: 'ESSENTIAL',
    name: 'Essential',
    cycle_cents: 8500,
    annual_cents: 8500 * (CYCLES_PER_YEAR - FREE_VISITS_ANNUAL),
    capacity: 100,
    services: 1,
    // Short, and in the order somebody skimming would want them.
    includes: [
      'One full service of your choice — structured manicure, GelX, or acrylic, any size up to medium',
      'Any design, no extra charge',
      'No deposit, ever',
      'Priority booking ahead of walk-ins',
    ],
    line: 'In and out, exactly what you need.',
  },
  {
    key: 'ELITE',
    name: 'Elite',
    cycle_cents: 11000,
    annual_cents: 11000 * (CYCLES_PER_YEAR - FREE_VISITS_ANNUAL),
    capacity: 50,
    services: 1,
    includes: [
      'Everything in Essential, at any length'+String.fromCharCode(44)+' short to long',
      'Russian manicure every visit',
      'Free removal',
      'Organic product every visit',
      'A personal nail record that tracks your growth and health',
    ],
    line: 'Watch your nails get healthier every visit.',
  },
];

// Sold at any visit, on either tier.
/* The pedicure is the one thing a member buys at a members' price rather
   than gets included. Full price for anyone else. */
const MEMBER_SERVICE_CENTS = {
  'Russian Dry Pedicure': 7500,
  'Russian Dry Pedicure — Full Correction': 8500,
};

// Only the memberships now sold. The retired three already include
// pedicures outright, so a members' price would be a downgrade.
function memberPriceFor(tier, serviceName) {
  if (!PLANS.some(p => p.key === String(tier || '').toUpperCase())) return null;
  const want = String(serviceName || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const name of Object.keys(MEMBER_SERVICE_CENTS)) {
    if (name.toLowerCase().replace(/[^a-z]/g, '') === want) return MEMBER_SERVICE_CENTS[name];
  }
  return null;
}

const ADDON = { name: 'Russian pedicure', cents: 7500, correction_cents: 8500 };

// The original three, still buyable. They sit below Essential and Elite and
// are described the same short way — the long comparison pages they used to
// have are gone for good. A handful of spots each, because that is what
// reopening a closed tier honestly is.
const LEGACY = [
  // Each payment covers the services listed — on whichever rhythm she picks.
  {
    key: 'SIGNATURE', name: 'Signature', cycle_cents: 9900, annual_cents: 99900, capacity: 28, services: 1,
    includes: ['One service every cycle — a manicure or a pedicure, your choice', 'Half off every add-on', 'Books 3 days before the public'],
    line: 'Hands or feet, on your schedule.',
  },
  {
    key: 'LUXE', name: 'Luxe', cycle_cents: 19900, annual_cents: 199900, capacity: 18, services: 2,
    includes: ['Two services every cycle — two manicures, two pedicures, or one of each', 'Every add-on free', 'Books 13 days before the public'],
    line: 'More of everything, nothing extra to pay.',
  },
  {
    key: 'BLACK_CARD', name: 'Black Card', cycle_cents: 29900, annual_cents: 299900, capacity: 13, services: 2,
    includes: ['Two services every cycle', 'Every add-on free', 'Choose your own artist, every visit', 'Books 20 days before the public'],
    line: 'The one where you pick who does your nails.',
  },
];

const ALL = () => PLANS.concat(LEGACY);
const byKey = k => ALL().find(p => p.key === String(k || '').toUpperCase()) || null;

/* ── HOW OFTEN THEY COME ─────────────────────────────────────────────────
   Every membership lets the client choose her rhythm: a visit every 2, 3,
   4 or 5 weeks, billed on that same rhythm. Four weeks is the regular
   price. Coming more often is rewarded — 10% off every two weeks, 5% off
   every three — and five weeks is $10 more, because a longer gap means
   more growth and more work at each visit. Set by Zahra, 2026-09-19.

   Each payment covers what the membership includes (one service for
   Essential, Elite and Signature; two for Luxe and Black Card), so the
   allowance resets on the same rhythm she is billed on.

   Exact cents, never rounded: 10% off $85 is $76.50, and the page, the
   authorisation she ticks and the Stripe price are all that same number.
   Paying for the year is only offered at the four-week rhythm. */
const RHYTHMS = [
  { weeks: 2, pct_off: 10, add_cents: 0 },
  { weeks: 3, pct_off: 5,  add_cents: 0 },
  { weeks: 4, pct_off: 0,  add_cents: 0 },
  { weeks: 5, pct_off: 0,  add_cents: 1000 },
];
const rhythmFor = w => RHYTHMS.find(r => r.weeks === Number(w)) || null;

// What one payment costs for this plan at this rhythm, in cents.
function rhythmCents(plan, weeks) {
  const p = typeof plan === 'string' ? byKey(plan) : plan;
  const r = rhythmFor(weeks);
  if (!p || !r) return 0;
  return Math.round(p.cycle_cents * (100 - r.pct_off) / 100) + r.add_cents;
}

function rhythmsFor(p) {
  return RHYTHMS.map(r => ({
    weeks: r.weeks,
    cents: rhythmCents(p, r.weeks),
    pct_off: r.pct_off,
    add_cents: r.add_cents,
    saved_cents: r.pct_off ? p.cycle_cents - rhythmCents(p, r.weeks) : 0,
  }));
}

// Three cycles' worth — the only way this saving is ever described. A
// percentage would make somebody do arithmetic to find out whether it is a
// good idea.
function annualSaving(plan) {
  const full = plan.cycle_cents * CYCLES_PER_YEAR;
  const saved = full - plan.annual_cents;
  // Floored, never rounded. Rounding 3.6 up to 4 would promise a visit that
  // was not paid for, and the whole point of this framing is that it is
  // literally true.
  return { saved_cents: saved, free_visits: Math.max(0, Math.floor(saved / plan.cycle_cents)) };
}

async function ensureColumns() {
  for (const sql of [
    // A count she can seed if members already exist on a tier outside the
    // system. It is added to the real signups, never shown instead of them.
    "CREATE TABLE IF NOT EXISTS plan_seed (plan TEXT PRIMARY KEY, seed INTEGER DEFAULT 0)",
  ]) { try { await execute(sql); } catch (_) {} }
}

// How many have actually joined each tier. Counted from the members table
// every time it is asked, never written into the page — a number that never
// moves is the one that gets noticed as fake.
async function counts() {
  await ensureColumns();
  const out = {};
  for (const p of ALL()) out[p.key] = 0;

  try {
    const rows = await query(
      "SELECT tier, COUNT(*) AS n FROM members WHERE COALESCE(demo,0)=0 AND COALESCE(status,'active') <> 'cancelled' GROUP BY tier");
    for (const r of rows) {
      const k = String(r.tier || '').toUpperCase();
      if (out[k] !== undefined) out[k] = Number(r.n) || 0;
    }
  } catch (_) {}

  // Anything she has seeded because those members predate the new system.
  try {
    const seeds = await query('SELECT plan, seed FROM plan_seed');
    for (const s of seeds) {
      const k = String(s.plan || '').toUpperCase();
      if (out[k] !== undefined) out[k] += Number(s.seed) || 0;
    }
  } catch (_) {}

  return out;
}

function shapeOne(p, taken) {
  const joined = Math.min(taken[p.key] || 0, p.capacity);
  const s = annualSaving(p);
  return {
    key: p.key, name: p.name, line: p.line, includes: p.includes,
    cycle_cents: p.cycle_cents, annual_cents: p.annual_cents,
    annual_saved_cents: s.saved_cents, annual_free_visits: s.free_visits,
    capacity: p.capacity, joined,
    spots_open: Math.max(0, p.capacity - joined),
    full: joined >= p.capacity,
    services: p.services || 1,
    rhythms: rhythmsFor(p),
  };
}

async function publicShape() {
  const taken = await counts();
  return {
    cycles_per_year: CYCLES_PER_YEAR,
    rhythms: RHYTHMS,
    addon: ADDON,
    legacy: LEGACY.map(p => shapeOne(p, taken)),
    plans: PLANS.map(p => shapeOne(p, taken)),
  };
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    if (req.method === 'GET') return res.json(await publicShape());

    // ── OWNER: seed a count for members who joined outside this system ──
    const CEO = process.env.CEO_PASSWORD || 'ZOLA2026';
    if (req.headers['x-ceo-password'] !== CEO) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'POST' && action === 'seed') {
      await ensureColumns();
      const plan = String((req.body || {}).plan || '').toUpperCase();
      if (!byKey(plan)) return res.status(400).json({ error: 'Unknown plan.' });
      const seed = Math.max(0, Math.round(Number((req.body || {}).seed) || 0));
      await execute(
        'INSERT INTO plan_seed (plan, seed) VALUES (?,?) ON CONFLICT(plan) DO UPDATE SET seed=excluded.seed',
        [plan, seed]);
      return res.json(await publicShape());
    }

    // ── OWNER: make sure every membership has its Stripe price at every
    // rhythm, then read each one back from Stripe — the amount and the
    // schedule Stripe will actually charge, not what this file hopes it will.
    if (req.method === 'POST' && action === 'stripe_rhythms') {
      const Stripe = require('stripe');
      const stripe = Stripe(await require('./_pay').getStripeSecret());
      const { rhythmPriceFor } = require('./_member-signup');
      const out = [];
      for (const p of ALL()) {
        for (const r of RHYTHMS) {
          const want = rhythmCents(p, r.weeks);
          try {
            const id = await rhythmPriceFor(stripe, p.key, r.weeks);
            const pr = await stripe.prices.retrieve(id);
            out.push({
              tier: p.key, weeks: r.weeks, want_cents: want, price_id: pr.id,
              unit_amount: pr.unit_amount, currency: pr.currency, active: pr.active,
              interval: pr.recurring && pr.recurring.interval,
              interval_count: pr.recurring && pr.recurring.interval_count,
              ok: pr.unit_amount === want && pr.currency === 'usd' && pr.active
                && pr.recurring && pr.recurring.interval === 'week' && pr.recurring.interval_count === r.weeks,
            });
          } catch (e) {
            out.push({ tier: p.key, weeks: r.weeks, want_cents: want, ok: false, error: String(e.message || e) });
          }
        }
      }
      return res.json({ ok: out.every(x => x.ok), prices: out });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.PLANS = PLANS;
module.exports.LEGACY = LEGACY;
module.exports.ALL = ALL;
module.exports.ADDON = ADDON;
module.exports.CYCLES_PER_YEAR = CYCLES_PER_YEAR;
module.exports.byKey = byKey;
module.exports.RHYTHMS = RHYTHMS;
module.exports.rhythmFor = rhythmFor;
module.exports.rhythmCents = rhythmCents;
module.exports.annualSaving = annualSaving;
module.exports.counts = counts;
module.exports.publicShape = publicShape;

module.exports.MEMBER_SERVICE_CENTS = MEMBER_SERVICE_CENTS;
module.exports.memberPriceFor = memberPriceFor;
