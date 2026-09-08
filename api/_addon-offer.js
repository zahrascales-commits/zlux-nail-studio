// One add-on, offered well, on a deadline that is real.
//
// A list of five extras gets skipped. One suggestion, chosen because it goes
// with what they are actually booking, gets read — and a small discount with
// a date on it gets taken.
//
// The deadline is genuine. An offer that says "today only" and is still
// there next week teaches people that nothing here means anything, and the
// next real deadline gets ignored too. So the featured add-on is decided by
// the date, changes when the date changes, and the discount is applied by
// the checkout rather than only shown on a page.
//
// Rotation also stops it becoming furniture. The same banner every visit
// stops being seen at all after the second time.
const { queryOne, execute } = require('./_team-db');

/* What each one can come down by, and never below. Her rule: ten dollars off
   at most, and removal never under twenty-five — it is the one that takes
   real time regardless of what it costs. */
const RULES = [
  { match: /removal/i,   name: 'Removal',          off_cents: 1000, floor_cents: 2500 },
  { match: /russian/i,   name: 'Russian Manicure', off_cents: 500,  floor_cents: 1500 },
  { match: /lotion/i,    name: 'Lotion Massage',   off_cents: 500,  floor_cents: 1000 },
  { match: /kids/i,      name: 'Kids Manicure',    off_cents: 1000, floor_cents: 2000 },
];

/* What goes with what. Somebody booking extensions almost certainly has
   something on their nails already; somebody having their feet done is
   there to be looked after. Suggesting the thing that actually fits is the
   whole difference between a suggestion and an advert. */
const GOES_WITH = [
  { when: /acrylic|gel ?x/i,  prefer: ['Removal', 'Kids Manicure'] },
  { when: /pedicure/i,        prefer: ['Lotion Massage', 'Kids Manicure'] },
  { when: /manicure/i,        prefer: ['Russian Manicure', 'Kids Manicure'] },
];

function ruleFor(name) {
  return RULES.find(r => r.match.test(String(name || ''))) || null;
}

// The studio's day, so an offer ends when her day ends.
function studioToday() {
  const la = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const pad = n => String(n).padStart(2, '0');
  return la.getFullYear() + '-' + pad(la.getMonth() + 1) + '-' + pad(la.getDate());
}

/* Which one is on offer, for this service, today.
   Deterministic: the same person asking twice in a day is told the same
   thing, and a page reload cannot shop for a better offer. */
function pickFor(serviceName, dateStr) {
  const day = dateStr || studioToday();
  const fit = GOES_WITH.find(g => g.when.test(String(serviceName || '')));
  const candidates = fit ? fit.prefer : ['Removal', 'Russian Manicure'];

  // Rotated by the date, so it is not the same suggestion every visit.
  const n = Number(String(day).replace(/[^0-9]/g, '').slice(-3)) || 0;
  const chosen = candidates[n % candidates.length];
  const rule = ruleFor(chosen);
  if (!rule) return null;

  return { name: rule.name, off_cents: rule.off_cents, floor_cents: rule.floor_cents, day };
}

/* What it costs today with the offer applied. Worked out from the rule
   rather than from anything a page sent, so the price on screen and the
   price charged come from the same place. */
function pricedWith(addonName, listCents, serviceName, dateStr) {
  const offer = pickFor(serviceName, dateStr);
  if (!offer) return { cents: listCents, discounted: false };

  const rule = ruleFor(addonName);
  if (!rule || rule.name !== offer.name) return { cents: listCents, discounted: false };

  const cents = Math.max(rule.floor_cents, listCents - rule.off_cents);
  if (cents >= listCents) return { cents: listCents, discounted: false };

  return {
    cents,
    discounted: true,
    off_cents: listCents - cents,
    was_cents: listCents,
  };
}

/* Whether she wants this running at all, and how it is described. Kept as a
   setting so turning it off never needs a deploy. */
async function settings() {
  try {
    const row = await queryOne(
      "SELECT value FROM site_settings WHERE key = 'addon_offer_on'");
    const on = !row || String(row.value) !== '0';
    return { on };
  } catch (_) { return { on: true }; }
}

async function setOn(on) {
  await execute(
    'INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ['addon_offer_on', on ? '1' : '0']);
}

module.exports = { pickFor, pricedWith, ruleFor, settings, setOn, studioToday, RULES };
