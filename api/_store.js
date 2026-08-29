// Module-level singleton — persists across warm invocations on the same instance
const services = [
  { id: 1,  name: 'Organic Structured Manicure', description: 'A healthy nail enhancement using organic product for a clean, structured look. As we learn you, we tailor every visit precisely to you.', duration_min: 60, price_cents: 9500, starting_at: true },
  { id: 12, name: 'Regular Gel Manicure',        description: 'A clean, classic gel manicure — shaped, cuticles tidied, gel colour of your choice.', duration_min: 60, price_cents: 5500  },
  { id: 2,  name: 'Medium Gel X',                description: 'Medium-length Gel X extensions for a sleek, polished finish.',                  duration_min: 75, price_cents: 10000 },
  { id: 3,  name: 'Short Gel X',                 description: 'Short Gel X extensions — low-maintenance, high-impact.',                         duration_min: 60, price_cents: 9500  },
  { id: 4,  name: 'Long Gel X',                  description: 'Long Gel X extensions for a dramatic, statement look.',                           duration_min: 90, price_cents: 11000 },
  { id: 5,  name: 'Long Acrylic Set',                description: 'Long acrylic nails sculpted to perfection.',                                     duration_min: 90, price_cents: 11000 },
  { id: 6,  name: 'Medium Acrylic Set',              description: 'Classic medium acrylic nails with a flawless finish.',                           duration_min: 75, price_cents: 10000 },
  { id: 7,  name: 'Short Acrylic Set',               description: 'Short acrylic nails — clean, precise, and polished.',                            duration_min: 60, price_cents: 9500  },
  { id: 8,  name: 'Russian Dry Pedicure',        description: 'An exacting, water-free technique rooted in the Russian method — precision gel applied directly to the natural toenail to support real growth with every visit. No soaking, no shortcuts, just the healthiest pedicure available — refined toward flawless, camera-ready feet and immaculate cuticle work. As we learn you, we tailor every visit precisely to you.', duration_min: 60, price_cents: 9500 },
  { id: 9,  name: 'Russian Dry Pedicure — Full Correction', description: 'Everything in the Russian Dry Pedicure, elevated into a complete foot renewal. Each visit is built around targeted exfoliation, buffing, and callus removal — the only method that truly resolves them, appointment by appointment, until your feet are fully restored. Precision cuticle work and picture-perfect polish complete the transformation. As we learn you, we tailor every visit precisely to you.', duration_min: 90, price_cents: 12500 },
  { id: 11, name: 'Test Run',                    description: 'Owner testing only — $1 end-to-end checkout test.', duration_min: 15, price_cents: 100, hidden: true },
];

const addons = [
  { id: 1, name: 'Removal',           price_cents: 3500 },
  { id: 2, name: 'Russian Manicure',  price_cents: 2000 },
  { id: 3, name: 'Nail Art',          price_cents: 2500 },
  { id: 4, name: 'Scrub Treatment',   price_cents: 2000 },
  { id: 5, name: 'Lotion Massage',    price_cents: 1500 },
];

const bookings = [];
let nextId = 1;

// All possible slots: 8 AM to 10 PM (shown as "Fully Booked" if blocked, not hidden)
// The studio day, in quarter hours.
//
// Quarter hours rather than whole ones because appointments are not whole
// hours: a plain set runs 1h30 and a full-design set 2h15, so a grid of
// whole hours rounds every single one up and quietly bins the remainder.
const SLOT_STEP_MINUTES = 15;
const DAY_OPEN_MINUTES = 8 * 60;    // 08:00
const DAY_CLOSE_MINUTES = 22 * 60;  // 22:00

const ALL_SLOTS = (() => {
  const out = [];
  for (let m = DAY_OPEN_MINUTES; m <= DAY_CLOSE_MINUTES; m += SLOT_STEP_MINUTES) {
    out.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
  }
  return out;
})();

// Calendar blocks set by CEO — { date: 'YYYY-MM-DD', slot: 'HH:MM' | 'ALL', note: '' }
const calendarBlocks = [];

// Funnel drop-off tracking
const funnelEvents = [];

// Chat question log for CEO analytics
const chatQuestions = [];

// Inventory items
const inventory = [
  { id: 1, name: 'Hard Gel (clear)', unit: 'pot', qty: 4, low_at: 2 },
  { id: 2, name: 'Gel Polish (assorted)', unit: 'bottle', qty: 24, low_at: 8 },
  { id: 3, name: 'Nail Forms', unit: 'pack', qty: 6, low_at: 2 },
  { id: 4, name: 'Acrylic Powder', unit: 'oz', qty: 16, low_at: 4 },
  { id: 5, name: 'Cuticle Oil', unit: 'bottle', qty: 8, low_at: 3 },
  { id: 6, name: 'Top Coat', unit: 'bottle', qty: 10, low_at: 4 },
  { id: 7, name: 'Primer', unit: 'bottle', qty: 6, low_at: 2 },
  { id: 8, name: 'Nail Files (180/240)', unit: 'pack', qty: 5, low_at: 2 },
  { id: 9, name: 'Scrub Exfoliant', unit: 'jar', qty: 3, low_at: 1 },
  { id: 10, name: 'Lotion (organic)', unit: 'bottle', qty: 5, low_at: 2 },
];
let nextInventoryId = 11;

// Gift cards
const giftCards = [];
let nextGiftId = 1;

// Goals
const goals = [
  { id: 1, title: 'Fill all Signature spots', target: 20, current: 0, unit: 'members', deadline: '2026-09-01' },
  { id: 2, title: 'Fill all Luxe spots', target: 10, current: 0, unit: 'members', deadline: '2026-09-01' },
  { id: 3, title: 'Fill all Black Card spots', target: 5, current: 0, unit: 'members', deadline: '2026-08-01' },
  { id: 4, title: 'Monthly revenue', target: 800000, current: 0, unit: 'cents', deadline: '2026-08-31' },
];
let nextGoalId = 5;

// Workers
const workers = [
  { id: 1, name: 'Emma Magana',  pin: '1234', active: true, color: '#C4A882' },
  { id: 2, name: 'Lily Byers',   pin: '5678', active: true, color: '#8B6A3E' },
];

// Inspo photos sent by CEO to workers
const inspoPhotos = []; // { id, url, caption, ts, added_by }
let nextInspoId = 1;

// Worker messages to clients
const workerMessages = []; // { id, worker_id, booking_id, client_name, message, ts }
let nextMsgId = 1;

module.exports = {
  services, addons, bookings, ALL_SLOTS, SLOT_STEP_MINUTES,
  calendarBlocks, funnelEvents, chatQuestions,
  inventory, giftCards, goals,
  workers, inspoPhotos, workerMessages,
  get nextId() { return nextId; }, incId() { return nextId++; },
  get nextInventoryId() { return nextInventoryId; }, incInventoryId() { return nextInventoryId++; },
  get nextGiftId() { return nextGiftId; }, incGiftId() { return nextGiftId++; },
  get nextGoalId() { return nextGoalId; }, incGoalId() { return nextGoalId++; },
  get nextInspoId() { return nextInspoId; }, incInspoId() { return nextInspoId++; },
  get nextMsgId() { return nextMsgId; }, incMsgId() { return nextMsgId++; },
};
