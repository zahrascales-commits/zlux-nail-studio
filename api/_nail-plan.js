// The nail health programme.
//
// A member says what state their nails are actually in — thin, peeling,
// breaking, ridged, bitten — and gets back two lists: what they can do
// themselves this week, and what the studio will do in the chair. Kept
// deterministic on purpose. This is advice attached to somebody's body, so
// it has to be the same answer twice and Zahra has to be able to read every
// rule and disagree with it. Nothing here is generated on the fly.
//
// It is nail care, not medicine. Anything that looks like infection or
// injury is handed straight to a doctor rather than answered.
const { query, queryOne, execute } = require('./_db');

let _ready = false;
async function ensurePlanTables() {
  if (_ready) return;
  await execute(`CREATE TABLE IF NOT EXISTS nail_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT NOT NULL,
    answers TEXT,
    score INTEGER,
    band TEXT,
    goal TEXT,
    created_ts INTEGER
  )`);
  // What Zahra writes back after seeing them, so the plan is a conversation
  // rather than a machine talking to itself.
  await execute(`CREATE TABLE IF NOT EXISTS nail_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT NOT NULL,
    note TEXT,
    author TEXT,
    created_ts INTEGER
  )`);
  _ready = true;
}

/* ── WHAT WE ASK ────────────────────────────────────────────────────
   Each is 0–3: none, a little, quite a bit, a lot. Weights are how much
   each one drags the score down at its worst.                        */
const FACTORS = [
  { key: 'thin',      label: 'Thin or bendy',            hint: 'They flex when you press them',        weight: 16 },
  { key: 'peeling',   label: 'Peeling in layers',        hint: 'The tip splits into sheets',           weight: 14 },
  { key: 'breaking',  label: 'Breaking or splitting',    hint: 'They snap before you want them to',    weight: 16 },
  { key: 'ridges',    label: 'Ridges or dents',          hint: 'Lines running up the nail',            weight: 8 },
  { key: 'dry',       label: 'Dry skin and cuticles',    hint: 'Tight, flaky, or hangnails',           weight: 10 },
  { key: 'lifting',   label: 'Product lifting early',    hint: 'Gel or acrylic pops off too soon',     weight: 12 },
  { key: 'biting',    label: 'Biting or picking',        hint: 'Be honest — it changes the plan',      weight: 14 },
  { key: 'soreness',  label: 'Tender around the nail',   hint: 'Sensitive when pressed',               weight: 10 },
];

const GOALS = [
  { key: 'length',   label: 'Grow them long' },
  { key: 'strength', label: 'Make them strong' },
  { key: 'repair',   label: 'Repair the damage first' },
  { key: 'natural',  label: 'Take a break from product' },
];

/* ── THE RULES ──────────────────────────────────────────────────────
   Every flagged factor contributes to both lists. Written out rather
   than generated so anyone can read the whole logic in one sitting. */
const RULES = {
  thin: {
    home: [
      'Cuticle oil twice a day — morning and before bed. Thin nails are usually dehydrated nails.',
      'Stop using your nails as tools. Every time you open a can with them you set this back a week.',
    ],
    studio: [
      'A structured base to carry the load instead of your natural nail carrying it.',
      'Shorter length while we rebuild — length is what makes a thin nail break.',
    ],
  },
  peeling: {
    home: [
      'Wear gloves for washing up. Water in and out of the nail plate is what separates the layers.',
      'Stop filing back and forth — one direction only, or the layers keep fraying.',
    ],
    studio: [
      'We seal the free edge properly so water stops getting between the layers.',
      'A gentle buff rather than an aggressive one, so we are not thinning what we are trying to save.',
    ],
  },
  breaking: {
    home: [
      'Keep them shorter than you want them for a few weeks. Short and intact beats long and broken.',
      'A hand cream every time you wash your hands — dry nails are brittle nails.',
    ],
    studio: [
      'An apex built over the stress point, which is where a nail actually snaps.',
      'A square-oval shape rather than a sharp square — corners are where breaks start.',
    ],
  },
  ridges: {
    home: [
      'Do not buff ridges flat. That thins the nail and the ridge comes back anyway.',
      'Oil daily — ridges look deeper on a dehydrated nail than a conditioned one.',
    ],
    studio: [
      'A ridge-filling base so the surface is smooth without us sanding the nail down.',
    ],
  },
  dry: {
    home: [
      'Oil the cuticle, not the nail. That is where it gets absorbed.',
      'Never cut a hangnail with your teeth — clip it clean and oil it.',
    ],
    studio: [
      'Proper cuticle work at every visit, and the Russian technique so nothing is torn.',
      'A scrub and massage to bring the circulation back into the nail bed.',
    ],
  },
  lifting: {
    home: [
      'No oil on the nail plate in the 24 hours before your appointment — it stops product bonding.',
      'Come with hands washed and dry, no lotion.',
    ],
    studio: [
      'Deeper prep and a proper dehydrator before product goes anywhere near the nail.',
      'We cap the free edge, which is where lifting almost always starts.',
    ],
  },
  biting: {
    home: [
      'Keep them polished. A finished nail is much harder to pick at than a bare one.',
      'Oil is the habit-breaker here — busy hands doing something kind instead.',
    ],
    studio: [
      'A set you would not want to ruin. That is the honest intervention for picking.',
      'Shorter, tougher shapes so there is nothing to catch on.',
    ],
  },
  soreness: {
    home: [
      'Give it a week without product if you can. Tenderness means it needs a rest, not another set.',
    ],
    studio: [
      'We go lighter on prep and skip anything that puts pressure on the nail bed.',
      'A shorter appointment focused on recovery rather than a full new set.',
    ],
  },
};

const GOAL_NOTES = {
  length:   { home: ['Length comes from not breaking, not from growing faster. Protect what you have.'], studio: ['We build strength first, then let you grow into the length you want.'] },
  strength: { home: ['Protein and hydration both matter — but oil daily does more for nail strength than any supplement.'], studio: ['Structured overlays so the nail is supported while it strengthens underneath.'] },
  repair:   { home: ['Give it a few weeks of short and simple. Repair is boring and it works.'], studio: ['Minimal product, maximum prep. We stop taking anything off that does not need to come off.'] },
  natural:  { home: ['A break is a real option. Oil, short length, and a clear strengthener is a plan, not a gap.'], studio: ['We can keep you on a natural-nail routine and check in without putting product back on.'] },
};

// Things that are not ours to answer.
const RED_FLAGS = [
  'green or black discolouration under the nail',
  'pain, throbbing, swelling or pus around the nail',
  'a nail lifting away from the bed on its own',
  'a nail that changed shape or colour without an injury',
];

function bandFor(score) {
  if (score >= 85) return { band: 'Strong', line: 'Your nails are in good shape. This is a maintenance plan, not a rescue.' };
  if (score >= 68) return { band: 'Steady', line: 'Mostly healthy with a couple of things worth tightening up.' };
  if (score >= 45) return { band: 'Recovering', line: 'There is real damage here, and it is very fixable. Give it a few weeks.' };
  return { band: 'Fragile', line: 'Your nails need looking after before they need decorating. Let us rebuild first.' };
}

// Score, plan, and the reasons — all from the answers, every time the same.
function buildPlan(answers, goal) {
  const a = answers || {};
  let lost = 0;
  const flagged = [];

  for (const f of FACTORS) {
    const v = Math.max(0, Math.min(3, Number(a[f.key]) || 0));
    if (!v) continue;
    lost += (f.weight * v) / 3;
    flagged.push({ key: f.key, label: f.label, severity: v });
  }

  const score = Math.max(5, Math.round(100 - lost));
  const b = bandFor(score);

  // Worst first — the biggest problem should be the first thing they read.
  flagged.sort((x, y) => y.severity - x.severity);

  const home = [], studio = [];
  const seen = new Set();
  const push = (arr, line) => { if (!seen.has(line)) { seen.add(line); arr.push(line); } };

  for (const f of flagged) {
    const r = RULES[f.key];
    if (!r) continue;
    r.home.forEach(l => push(home, l));
    r.studio.forEach(l => push(studio, l));
  }

  const g = GOAL_NOTES[goal];
  if (g) { g.home.forEach(l => push(home, l)); g.studio.forEach(l => push(studio, l)); }

  // The baseline goes to everyone, healthy or not. Someone whose nails are
  // fine still opened this wanting something to do, and "nothing to report"
  // is a worse answer than the two habits that keep them that way.
  push(home, 'Cuticle oil once a day. That alone keeps a healthy nail healthy.');
  push(home, 'Gloves for cleaning and washing up — most damage starts with water and detergent.');
  push(studio, 'We check your shape, length and balance every visit and adjust before anything becomes a problem.');

  return {
    score,
    band: b.band,
    band_line: b.line,
    flagged,
    home: home.slice(0, 7),
    studio: studio.slice(0, 6),
    red_flags: RED_FLAGS,
    // Sore nails plus visible damage is the combination worth naming out loud.
    see_someone: (Number(a.soreness) || 0) >= 2,
  };
}

module.exports = { FACTORS, GOALS, buildPlan, ensurePlanTables, bandFor, RED_FLAGS };
