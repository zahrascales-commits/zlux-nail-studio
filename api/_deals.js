// The two deal days.
//
// One definition, read by the booking page, the menu, the homepage, the
// questionnaire and the till. The names are going to change — she has said
// so — and a name that lives in nine files is a rename that goes wrong in
// three of them. Change it here and it changes everywhere.
//
//   Tuesday    $75, 1h30, any tier one design, hands or toes
//   Wednesday  $65, 1h10, solid colour, hands or toes
//
// Neither takes add-ons. Not so there is a rule to recite at people — the
// pages say what the day includes and stop — but because the price only
// works at that length, and an add-on is time the slot does not have. The
// one thing worth saying out loud is where to go instead for a removal,
// because somebody who needs one should still be able to book something.

const DEALS = [
  {
    key: 'tuesday',
    // 0 is Sunday, so Tuesday is 2. Used to decide which dates are bookable.
    weekday: 2,
    weekday_name: 'Tuesday',
    name: '$75 Tuesdays',
    short: '$75 Tuesday',
    cta: 'Book a Tuesday',
    price_cents: 7500,
    minutes: 90,
    duration_label: '1 hr 30',
    // Sits first on the homepage and first in the booking list.
    featured: true,
    badge: 'Most booked',
    blurb: 'Any tier one design — French tip, polka dots, chrome, solid colour, or stripes.',
    designs: ['French tip', 'Polka dots', 'Chrome', 'Solid colour', 'Stripes'],
    choices: [
      { key: 'hands', label: 'Hands', detail: 'Your design, on your nails.' },
      /* The Russian pedicure is in on Tuesdays; the full correction is its
         own longer appointment and is not. Written as what they get. */
      { key: 'toes', label: 'Toes', detail: 'The Russian dry pedicure, with your design.' },
    ],
  },
  {
    key: 'wednesday',
    weekday: 3,
    weekday_name: 'Wednesday',
    name: '$65 Wednesdays',
    short: '$65 Wednesday',
    cta: 'Book a Wednesday',
    price_cents: 6500,
    minutes: 70,
    duration_label: '1 hr 10',
    featured: false,
    badge: '',
    blurb: 'Solid colour — any shade you like.',
    designs: ['Solid colour'],
    choices: [
      { key: 'hands', label: 'Hands', detail: 'Solid colour, on your nails.' },
      { key: 'toes', label: 'Toes', detail: 'A pedicure, finished in solid colour.' },
    ],
  },
];

/* The only limit worth printing. Somebody who needs a removal is still a
   booking — telling them where to go keeps them, and listing everything the
   day excludes would lose them. */
const INSTEAD_NOTE = 'Need a removal? Book a regular set and we will take care of it.';

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function all() { return DEALS.slice(); }

function byKey(key) {
  const k = String(key || '').toLowerCase().trim();
  return DEALS.find(d => d.key === k) || null;
}

/* Which deal a booked service is, if any. Matched loosely because the
   stored name carries the hands-or-toes choice on the end of it — the
   artist needs to see which one it is on the calendar. */
function forService(name) {
  const n = norm(name);
  if (!n) return null;
  return DEALS.find(d => n === norm(d.name))
    || DEALS.find(d => n.indexOf(norm(d.name)) === 0)
    || null;
}

function isDeal(name) { return !!forService(name); }

/* Midday rather than midnight: a date parsed at midnight lands on the
   previous day in any timezone behind UTC, and a Tuesday that reads as
   Monday is a booking the server refuses for no reason the client can see. */
function weekdayOf(dateStr) {
  const d = new Date(String(dateStr || '').slice(0, 10) + 'T12:00:00');
  return isNaN(d) ? -1 : d.getDay();
}

function isRightDay(deal, dateStr) {
  if (!deal) return true;
  return weekdayOf(dateStr) === deal.weekday;
}

/* Menu entries, so the deals price, book, check out and report through
   exactly the same path as everything else. A separate pathway for the
   cheap days is a second set of bugs. */
function asServices() {
  return DEALS.map((d, i) => ({
    id: 900 + i,
    name: d.name,
    description: d.blurb,
    duration_min: d.minutes,
    price_cents: d.price_cents,
    // Read by the pages that lay the menu out.
    deal: d.key,
    weekday: d.weekday,
    featured: !!d.featured,
    badge: d.badge || '',
    takes_addons: false,
  }));
}

/* What the hands-or-toes choice is called on the booking. Kept on the end
   of the service name so it shows up on the calendar, at the till and in
   the client's history without any of them needing to know about deals. */
function labelFor(deal, choiceKey) {
  if (!deal) return '';
  const c = (deal.choices || []).find(x => x.key === String(choiceKey || '').toLowerCase());
  return c ? c.label : '';
}

function serviceNameFor(deal, choiceKey) {
  const label = labelFor(deal, choiceKey);
  return label ? deal.name + ' — ' + label : deal.name;
}

module.exports = {
  DEALS, INSTEAD_NOTE,
  all, byKey, forService, isDeal, weekdayOf, isRightDay,
  asServices, labelFor, serviceNameFor,
};
