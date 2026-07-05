// Module-level singleton — persists across warm invocations on the same instance
const services = [
  { id: 1,  name: 'Organic Structured Manicure', description: 'A healthy nail enhancement using organic product for a clean, structured look.', duration_min: 60, price_cents: 9000, starting_at: true },
  { id: 2,  name: 'Medium Gel X',                description: 'Medium-length Gel X extensions for a sleek, polished finish.',                  duration_min: 75, price_cents: 10000 },
  { id: 3,  name: 'Short Gel X',                 description: 'Short Gel X extensions — low-maintenance, high-impact.',                         duration_min: 60, price_cents: 9500  },
  { id: 4,  name: 'Long Gel X',                  description: 'Long Gel X extensions for a dramatic, statement look.',                           duration_min: 90, price_cents: 11000 },
  { id: 5,  name: 'Long Acrylic',                description: 'Long acrylic nails sculpted to perfection.',                                     duration_min: 90, price_cents: 11000 },
  { id: 6,  name: 'Medium Acrylic',              description: 'Classic medium acrylic nails with a flawless finish.',                           duration_min: 75, price_cents: 10000 },
  { id: 7,  name: 'Short Acrylic',               description: 'Short acrylic nails — clean, precise, and polished.',                            duration_min: 60, price_cents: 9500  },
  { id: 8,  name: 'Hydro Free Pedicure',         description: 'A waterless pedicure using advanced dry techniques for a hygienic treatment.',   duration_min: 60, price_cents: 8500  },
  { id: 9,  name: 'Classic Spa Pedicure',        description: 'A luxurious spa pedicure with soak, scrub, mask, and polish.',                   duration_min: 75, price_cents: 9500  },
  { id: 10, name: 'Royal Citrus Pedicure',       description: 'Our signature pedicure featuring citrus-infused treatments and extended massage.', duration_min: 90, price_cents: 10500 },
];

const addons = [
  { id: 1, name: 'Removal',           price_cents: 3500 },
  { id: 2, name: 'Russian Manicure',  price_cents: 3000 },
  { id: 3, name: 'Nail Art',          price_cents: 2500 },
  { id: 4, name: 'Scrub Treatment',   price_cents: 2000 },
  { id: 5, name: 'Lotion Massage',    price_cents: 1500 },
];

const bookings = [];
let nextId = 1;

// All possible slots: 8 AM to 10 PM (shown as "Fully Booked" if blocked, not hidden)
const ALL_SLOTS = [
  '08:00','09:00','10:00','11:00','12:00',
  '13:00','14:00','15:00','16:00','17:00',
  '18:00','19:00','20:00','21:00','22:00'
];

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
  services, addons, bookings, ALL_SLOTS,
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
