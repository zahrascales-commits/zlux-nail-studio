// The nail health programme.
//
// A client says what state their nails are actually in and what they want,
// and gets back two lists: what they can do themselves this week, and what
// the studio will do in the chair. Whoever ends up with that client sees the
// same answers — an artist who knows somebody bites their nails and works
// with bleach every day makes different choices than one who doesn't.
//
// Kept deterministic on purpose. This is advice attached to somebody's body,
// so it has to be the same answer twice and Zahra has to be able to read
// every rule and disagree with it. Nothing here is generated on the fly.
//
// It is nail care, not medicine. Anything that looks like infection or
// injury is handed to a doctor rather than answered.
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

/* ── THE QUESTIONS ──────────────────────────────────────────────────
   Grouped, because eighteen questions in one column is a wall nobody
   finishes. Scale questions are 0–3; choice questions offer options.  */
const SECTIONS = [
  {
    key: 'condition',
    title: 'The state of them now',
    hint: 'Be honest — the plan is only as good as this bit.',
    factors: [
      { key: 'thin',      label: 'Thin or bendy',          hint: 'They flex when you press them',       weight: 16 },
      { key: 'peeling',   label: 'Peeling in layers',      hint: 'The tip splits into sheets',          weight: 14 },
      { key: 'breaking',  label: 'Breaking or splitting',  hint: 'They snap before you want them to',   weight: 16 },
      { key: 'ridges',    label: 'Ridges or dents',        hint: 'Lines running up the nail',           weight: 8 },
      { key: 'dry',       label: 'Dry skin and cuticles',  hint: 'Tight, flaky, or hangnails',          weight: 10 },
      { key: 'soreness',  label: 'Tender around the nail', hint: 'Sensitive when pressed',              weight: 10 },
      { key: 'stained',   label: 'Yellow or stained',      hint: 'Colour left behind after a set',      weight: 5 },
    ],
  },
  {
    key: 'wear',
    title: 'How they hold up',
    hint: 'This tells us whether it is the prep, the product, or the week you have.',
    factors: [
      { key: 'lifting',   label: 'Product lifts early',    hint: 'Gel or acrylic pops off too soon',    weight: 12 },
      { key: 'chipping',  label: 'Chipping at the tips',   hint: 'The free edge wears before the rest', weight: 8 },
      { key: 'popoff',    label: 'Whole nails come off',   hint: 'A full set piece lost in one go',     weight: 12 },
    ],
  },
  {
    key: 'habits',
    title: 'Your week',
    hint: 'None of this is a telling-off. It just changes what we recommend.',
    factors: [
      { key: 'biting',    label: 'Biting or picking',      hint: 'Including picking product off',       weight: 14 },
      { key: 'water',     label: 'Hands in water a lot',   hint: 'Dishes, cleaning, hair, healthcare',  weight: 8 },
      { key: 'chemicals', label: 'Cleaning products or bleach', hint: 'Without gloves',                 weight: 8 },
      { key: 'tools',     label: 'Using nails as tools',   hint: 'Opening, scraping, peeling labels',   weight: 8 },
      { key: 'gaps',      label: 'Long gaps between fills', hint: 'Going three weeks or more',          weight: 6 },
    ],
  },
];

// Flattened, because everything downstream wants one list.
const FACTORS = SECTIONS.reduce((all, s) => all.concat(s.factors.map(f => ({ ...f, section: s.key }))), []);

const GOALS = [
  { key: 'length',   label: 'Grow them long' },
  { key: 'strength', label: 'Make them strong' },
  { key: 'repair',   label: 'Repair the damage first' },
  { key: 'natural',  label: 'Take a break from product' },
  { key: 'lowmaint', label: 'Something low-maintenance' },
];

// Things worth knowing before somebody sits down, that are not problems.
const CONTEXT = [
  {
    key: 'shape', label: 'Shape you like best', type: 'choice',
    options: ['No preference', 'Square', 'Squoval', 'Almond', 'Coffin', 'Round', 'Stiletto'],
  },
  {
    key: 'length_pref', label: 'Length you like best', type: 'choice',
    options: ['No preference', 'Short', 'Medium', 'Long', 'Extra long'],
  },
  {
    key: 'job', label: 'Do your hands take a beating at work?', type: 'choice',
    options: ['Not really', 'Some', 'Constantly — hands-on job'],
  },
  {
    key: 'allergy', label: 'Any reactions or sensitivities we should know about?', type: 'text',
    placeholder: 'Itching, redness, a product that stung — anything at all',
  },
  {
    key: 'dislikes', label: 'Anything you never want done again?', type: 'text',
    placeholder: 'A shape, a length, a technique, drills, cuticle nippers…',
  },
  {
    key: 'wants', label: 'What would your dream set look like?', type: 'text',
    placeholder: 'Tell us in your own words — colours, vibe, an occasion coming up',
  },
];

/* ── THE RULES ──────────────────────────────────────────────────────
   Every flagged factor contributes to both lists. Written out rather
   than generated so anyone can read the whole logic in one sitting.  */
const RULES = {
  thin: {
    home: ['Cuticle oil twice a day — morning and before bed. Thin nails are usually dehydrated nails.'],
    studio: ['A structured base to carry the load instead of your natural nail carrying it.',
             'Shorter length while we rebuild — length is what makes a thin nail break.'],
  },
  peeling: {
    home: ['Wear gloves for washing up. Water moving in and out of the nail plate is what separates the layers.',
           'File in one direction only — back and forth frays the layers you are trying to keep.'],
    studio: ['We seal the free edge properly so water stops getting between the layers.',
             'A gentle buff rather than an aggressive one, so we are not thinning what we are trying to save.'],
  },
  breaking: {
    home: ['Keep them shorter than you want them for a few weeks. Short and intact beats long and broken.',
           'Hand cream every time you wash your hands — dry nails are brittle nails.'],
    studio: ['An apex built over the stress point, which is where a nail actually snaps.',
             'A square-oval shape rather than a sharp square — corners are where breaks start.'],
  },
  ridges: {
    home: ['Do not buff ridges flat. That thins the nail and the ridge comes back anyway.'],
    studio: ['A ridge-filling base so the surface is smooth without us sanding the nail down.'],
  },
  dry: {
    home: ['Oil the cuticle, not the nail. That is where it gets absorbed.',
           'Never bite a hangnail off — clip it clean and oil it.'],
    studio: ['Proper cuticle work every visit, and the Russian technique so nothing is torn.'],
  },
  soreness: {
    home: ['Give it a week without product if you can. Tenderness means it needs a rest, not another set.'],
    studio: ['We go lighter on prep and skip anything that puts pressure on the nail bed.'],
  },
  stained: {
    home: ['A base coat under anything bright. Staining is pigment sitting straight on the keratin.'],
    studio: ['We always base first, and we can buff staining back gently over a couple of visits.'],
  },
  lifting: {
    home: ['No oil on the nail plate in the 24 hours before your appointment — it stops product bonding.',
           'Come with hands washed and dry, no lotion.'],
    studio: ['Deeper prep and a proper dehydrator before product goes near the nail.',
             'We cap the free edge, which is where lifting almost always starts.'],
  },
  chipping: {
    home: ['Reapply a top coat at home between visits if you can — it is the tip that wears first.'],
    studio: ['A thicker cap on the free edge, and a shape that does not leave a thin fragile tip.'],
  },
  popoff: {
    home: ['Tell us the moment one goes rather than waiting — a repair is quick, a rebuild is not.'],
    studio: ['We look at your prep and your apex together: a whole nail leaving usually means one of the two.'],
  },
  biting: {
    home: ['Keep them polished. A finished nail is much harder to pick at than a bare one.',
           'Oil is the habit-breaker here — busy hands doing something kind instead.'],
    studio: ['A set you would not want to ruin. That is the honest intervention for picking.',
             'Shorter, tougher shapes so there is nothing to catch on.'],
  },
  water: {
    home: ['Gloves for dishes and cleaning. This one habit changes more than any product will.'],
    studio: ['We seal edges properly and pick systems that cope with hands that are wet all day.'],
  },
  chemicals: {
    home: ['Gloves for anything with bleach or solvent. It strips the nail as fast as it strips the sink.'],
    studio: ['A tougher system and a shorter length, so there is less surface for anything to get under.'],
  },
  tools: {
    home: ['Stop opening things with them. Every time you do, you set the plan back about a week.'],
    studio: ['We build a stronger apex, but nothing survives being used as a screwdriver.'],
  },
  gaps: {
    home: ['Book your next fill before you leave. Past about three weeks the regrowth starts to lever the set off.'],
    studio: ['We can set a rhythm that suits you — and shape it so growing out looks deliberate.'],
  },
};

const GOAL_NOTES = {
  length:   { home: ['Length comes from not breaking, not from growing faster. Protect what you have.'],
              studio: ['We build strength first, then let you grow into the length you want.'] },
  strength: { home: ['Oil daily does more for nail strength than any supplement.'],
              studio: ['Structured overlays so the nail is supported while it strengthens underneath.'] },
  repair:   { home: ['Give it a few weeks of short and simple. Repair is boring and it works.'],
              studio: ['Minimal product, maximum prep. We stop taking anything off that does not need to come off.'] },
  natural:  { home: ['A break is a real option. Oil, short length and a clear strengthener is a plan, not a gap.'],
              studio: ['We can keep you on a natural-nail routine and check in without putting product back on.'] },
  lowmaint: { home: ['Shorter and rounder lasts longer between visits than long and square.'],
              studio: ['A shape and colour that grows out gracefully, so a late fill never looks late.'] },
};

const RED_FLAGS = [
  'green or black discolouration under the nail',
  'pain, throbbing, swelling or pus around the nail',
  'a nail lifting away from the bed on its own',
  'a nail that changed shape or colour without an injury',
];

function bandFor(score) {
  if (score >= 85) return { band: 'Strong', line: 'Your nails are in good shape. This is a maintenance plan, not a rescue.' };
  if (score >= 68) return { band: 'Steady', line: 'Mostly healthy, with a couple of things worth tightening up.' };
  if (score >= 45) return { band: 'Recovering', line: 'There is real damage here, and it is very fixable. Give it a few weeks.' };
  return { band: 'Fragile', line: 'Your nails need looking after before they need decorating. Let us rebuild first.' };
}

function buildPlan(answers, goal) {
  const a = answers || {};
  let lost = 0;
  const flagged = [];

  for (const f of FACTORS) {
    const v = Math.max(0, Math.min(3, Number(a[f.key]) || 0));
    if (!v) continue;
    lost += (f.weight * v) / 3;
    flagged.push({ key: f.key, label: f.label, severity: v, section: f.section });
  }

  const score = Math.max(5, Math.round(100 - lost));
  const b = bandFor(score);
  flagged.sort((x, y) => y.severity - x.severity);

  const home = [], studio = [];
  const seen = new Set();
  const push = (arr, line) => { if (!seen.has(line)) { seen.add(line); arr.push(line); } };

  for (const f of flagged) {
    const r = RULES[f.key];
    if (!r) continue;
    (r.home || []).forEach(l => push(home, l));
    (r.studio || []).forEach(l => push(studio, l));
  }

  const g = GOAL_NOTES[goal];
  if (g) { g.home.forEach(l => push(home, l)); g.studio.forEach(l => push(studio, l)); }

  // The baseline goes to everyone. Somebody whose nails are fine still came
  // here wanting something to do, and "nothing to report" is a worse answer
  // than the two habits that keep them that way.
  push(home, 'Cuticle oil once a day. That alone keeps a healthy nail healthy.');
  push(home, 'Gloves for cleaning and washing up — most damage starts with water and detergent.');
  push(studio, 'We check your shape, length and balance every visit and adjust before anything becomes a problem.');

  return {
    score,
    band: b.band,
    band_line: b.line,
    flagged,
    home: home.slice(0, 9),
    studio: studio.slice(0, 8),
    red_flags: RED_FLAGS,
    see_someone: (Number(a.soreness) || 0) >= 2,
  };
}

module.exports = {
  SECTIONS, FACTORS, GOALS, CONTEXT, buildPlan, ensurePlanTables, bandFor, RED_FLAGS,
};
