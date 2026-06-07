// Module-level singleton — persists across warm invocations on the same instance
const services = [
  { id: 1, name: 'Classic Manicure', description: 'Shape, buff, cuticle care, and a polish of your choice.', duration_min: 30, price_cents: 3500 },
  { id: 2, name: 'Gel Manicure', description: 'Long-lasting gel colour with a mirror-finish top coat.', duration_min: 45, price_cents: 5500 },
  { id: 3, name: 'Luxury Nail Art', description: 'Bespoke hand-painted designs — intricate patterns, florals, and fine detail work.', duration_min: 75, price_cents: 8500 },
  { id: 4, name: 'Classic Pedicure', description: 'Soak, scrub, shape, and polish for perfectly groomed feet.', duration_min: 45, price_cents: 4500 },
  { id: 5, name: 'Deluxe Pedicure', description: 'Everything in Classic plus a hydrating mask, hot-stone massage, and paraffin wax.', duration_min: 75, price_cents: 7000 },
  { id: 6, name: 'Full Set Acrylic', description: 'Custom-length sculpted acrylic nails with your choice of finish.', duration_min: 90, price_cents: 9500 },
];

const bookings = [];
let nextId = 1;

const ALL_SLOTS = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];

module.exports = { services, bookings, ALL_SLOTS, get nextId() { return nextId; }, incId() { return nextId++; } };
