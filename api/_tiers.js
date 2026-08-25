// How long an appointment actually takes, and what the extras cost.
//
// One definition, read by the booking page, the pricing and the calendar.
// An extra that costs money on the checkout and takes no time on the
// schedule is how a day silently runs an hour behind.
//
//   base                     1h30
//   + Russian manicure       +15 min
//   + design tier            +10 / +15 / +30 min
//   + grace between clients  +10 min
//
// Nothing chosen is a real answer, not a missing one: a plain appointment
// with no art is 1h30 and costs nothing extra. It just means nude colour.

// Every appointment before any extras.
const BASE_MINUTES = 90;

// Breathing room between clients — cleaning down, seeing one out and the
// next in. Without it a day that looks full on paper runs late by
// mid-morning, and the person waiting is the one who pays for it.
const GRACE_MINUTES = 10;

// Add-ons that take real time in the chair. Anything not listed adds none.
// Named by the loose spelling used across the menu and the booking page, so
// "Russian Manicure" and "Russian Manicure Technique" both match.
const ADDON_MINUTES = [
  { match: /russian/i, minutes: 15 },
];

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

function tierFor(key) {
  if (!key) return null;
  const k = String(key).toLowerCase().trim();
  return TIERS.find(t => t.key === k) || null;
}

// Minutes the chosen add-ons add. Deliberately additive: booking a removal
// and a Russian manicure takes longer than either alone.
function addonMinutes(addonNames) {
  const names = Array.isArray(addonNames) ? addonNames : [];
  let mins = 0;
  for (const n of names) {
    for (const rule of ADDON_MINUTES) {
      if (rule.match.test(String(n || ''))) { mins += rule.minutes; break; }
    }
  }
  return mins;
}

// How long the chair is occupied. No tier adds nothing — that is somebody
// having a plain set, not somebody who forgot to answer.
function minutesFor(tierKey, addonNames) {
  const t = tierFor(tierKey);
  return BASE_MINUTES + (t ? t.minutes : 0) + addonMinutes(addonNames);
}

// And how long before the next client can start.
function blockMinutes(tierKey, addonNames) {
  return minutesFor(tierKey, addonNames) + GRACE_MINUTES;
}

// What the design tier adds to the bill. No tier costs nothing.
function priceFor(tierKey) {
  const t = tierFor(tierKey);
  return t ? t.price_cents : 0;
}

// Hour slots one appointment consumes on the current booking grid. Rounded
// up, because releasing a partly-used slot would let somebody book into the
// last few minutes of an appointment already running.
function slotsFor(tierKey, addonNames) {
  return Math.ceil(blockMinutes(tierKey, addonNames) / 60);
}

function label(tierKey) {
  const t = tierFor(tierKey);
  return t ? (t.name + ' · ' + t.tagline) : 'No art — nude colour';
}

module.exports = {
  TIERS, BASE_MINUTES, GRACE_MINUTES, ADDON_MINUTES,
  tierFor, addonMinutes, minutesFor, blockMinutes, priceFor, slotsFor, label,
};
