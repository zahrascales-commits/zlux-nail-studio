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

const PLANS = [
  {
    key: 'ESSENTIAL',
    name: 'Essential',
    cycle_cents: 8000,
    annual_cents: 80000,
    capacity: 100,
    // Short, and in the order somebody skimming would want them.
    includes: [
      'One full service of your choice — structured manicure, GelX, or acrylic, any length',
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
    annual_cents: 110000,
    capacity: 50,
    includes: [
      'Everything in Essential',
      'Russian manicure every visit',
      'Free removal',
      'Organic product every visit',
      'A personal nail record that tracks your growth and health',
    ],
    line: 'Watch your nails get healthier every visit.',
  },
];

// Sold at any visit, on either tier.
const ADDON = { name: 'Russian pedicure', cents: 7500 };

const byKey = k => PLANS.find(p => p.key === String(k || '').toUpperCase()) || null;

// Three cycles' worth — the only way this saving is ever described. A
// percentage would make somebody do arithmetic to find out whether it is a
// good idea.
function annualSaving(plan) {
  const full = plan.cycle_cents * CYCLES_PER_YEAR;
  return { saved_cents: full - plan.annual_cents, free_visits: Math.round((full - plan.annual_cents) / plan.cycle_cents) };
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
  for (const p of PLANS) out[p.key] = 0;

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

async function publicShape() {
  const taken = await counts();
  return {
    cycles_per_year: CYCLES_PER_YEAR,
    addon: ADDON,
    plans: PLANS.map(p => {
      const joined = Math.min(taken[p.key] || 0, p.capacity);
      const s = annualSaving(p);
      return {
        key: p.key,
        name: p.name,
        line: p.line,
        includes: p.includes,
        cycle_cents: p.cycle_cents,
        annual_cents: p.annual_cents,
        annual_saved_cents: s.saved_cents,
        annual_free_visits: s.free_visits,
        capacity: p.capacity,
        joined,
        spots_open: Math.max(0, p.capacity - joined),
        full: joined >= p.capacity,
      };
    }),
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

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.PLANS = PLANS;
module.exports.ADDON = ADDON;
module.exports.CYCLES_PER_YEAR = CYCLES_PER_YEAR;
module.exports.byKey = byKey;
module.exports.annualSaving = annualSaving;
module.exports.counts = counts;
module.exports.publicShape = publicShape;
