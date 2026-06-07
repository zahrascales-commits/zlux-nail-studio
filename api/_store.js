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
];

const bookings = [];
let nextId = 1;

const ALL_SLOTS = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];

module.exports = { services, addons, bookings, ALL_SLOTS, get nextId() { return nextId; }, incId() { return nextId++; } };
