const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bookings.db');

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      duration_min INTEGER NOT NULL,
      price_cents INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      date TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (service_id) REFERENCES services(id)
    );
  `);

  const count = db.prepare('SELECT COUNT(*) as n FROM services').get();
  if (count.n === 0) {
    const insert = db.prepare(
      'INSERT INTO services (name, description, duration_min, price_cents) VALUES (?, ?, ?, ?)'
    );
    const seedMany = db.transaction((services) => {
      for (const s of services) insert.run(s.name, s.description, s.duration_min, s.price_cents);
    });
    seedMany([
      { name: 'Classic Manicure', description: 'Shape, buff, cuticle care, and a polish of your choice.', duration_min: 30, price_cents: 3500 },
      { name: 'Gel Manicure', description: 'Long-lasting gel colour with a mirror-finish top coat.', duration_min: 45, price_cents: 5500 },
      { name: 'Luxury Nail Art', description: 'Bespoke hand-painted designs — intricate patterns, florals, and fine detail work.', duration_min: 75, price_cents: 8500 },
      { name: 'Classic Pedicure', description: 'Soak, scrub, shape, and polish for perfectly groomed feet.', duration_min: 45, price_cents: 4500 },
      { name: 'Deluxe Pedicure', description: 'Everything in Classic plus a hydrating mask, hot-stone massage, and paraffin wax.', duration_min: 75, price_cents: 7000 },
      { name: 'Full Set Acrylic', description: 'Custom-length sculpted acrylic nails with your choice of finish.', duration_min: 90, price_cents: 9500 },
    ]);
  }

  db.close();
}

module.exports = { getDb, initDb };
