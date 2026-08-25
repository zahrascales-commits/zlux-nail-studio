// Design tiers — how detailed the set is, what it adds to the price, and how
// much longer it takes.
//
// One definition, used by the booking page, the pricing, and the calendar.
// A tier that costs $10 on the checkout and takes zero extra minutes on the
// schedule is how a day silently runs an hour behind.
const TIERS = [
  {
    key: 'tier1',
    name: 'Tier 1',
    tagline: 'Solid colour',
    detail: 'One colour, or glitter. Clean and simple, no design work.',
    minutes: 10,
    price_cents: 500,
  },
  {
    key: 'tier2',
    name: 'Tier 2',
    tagline: 'Simple design',
    detail: 'French tips, polka dots, lines, an accent nail or two.',
    minutes: 15,
    price_cents: 1000,
  },
  {
    key: 'tier3',
    name: 'Tier 3',
    tagline: 'Full design',
    detail: '3D beads, gems, chrome, hand-painted — anything beyond simple.',
    minutes: 30,
    price_cents: 2000,
  },
];

// Every appointment before any design work.
const BASE_MINUTES = 105;

// Breathing room between clients: cleaning down, seeing one person out and
// the next in. Without it a day that looks full on paper runs late by
// mid-morning, and the person waiting is the one who pays for it.
const GRACE_MINUTES = 10;

function tierFor(key) {
  if (!key) return null;
  const k = String(key).toLowerCase().trim();
  return TIERS.find(t => t.key === k) || null;
}

// Somebody who skipped the question gets the shortest tier, because that is
// the only one their booking has time for. Deciding this here rather than at
// each call site means the calendar and the bill always agree about it.
function effectiveTier(key) {
  return tierFor(key) || TIERS[0];
}

// How long the chair is actually occupied.
function minutesFor(key) {
  return BASE_MINUTES + effectiveTier(key).minutes;
}

// And how long before the next client can start.
function blockMinutes(key) {
  return minutesFor(key) + GRACE_MINUTES;
}

function priceFor(key) {
  return effectiveTier(key).price_cents;
}

// The booking grid still starts appointments on the hour, so this is how
// many hour slots one consumes. Rounded up: a set that runs 2h05 has to hold
// three slots, because releasing the third would let somebody book into the
// last five minutes of it.
function slotsFor(key) {
  return Math.ceil(blockMinutes(key) / 60);
}

function label(key) {
  const t = effectiveTier(key);
  return t.name + ' · ' + t.tagline;
}

module.exports = {
  TIERS, BASE_MINUTES, GRACE_MINUTES,
  tierFor, effectiveTier, minutesFor, blockMinutes, priceFor, slotsFor, label,
};
