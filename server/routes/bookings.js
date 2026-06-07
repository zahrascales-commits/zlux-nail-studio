const express = require('express');
const { getDb } = require('../db/init');

const router = express.Router();

const ALL_SLOTS = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];

router.get('/services', (req, res) => {
  const db = getDb();
  const services = db.prepare('SELECT * FROM services ORDER BY id').all();
  db.close();
  res.json(services);
});

router.get('/availability', (req, res) => {
  const { date, service_id } = req.query;
  if (!date || !service_id) {
    return res.status(400).json({ error: 'date and service_id are required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const db = getDb();
  const booked = db
    .prepare('SELECT time_slot FROM bookings WHERE date = ? AND service_id = ?')
    .all(date, service_id)
    .map((r) => r.time_slot);
  db.close();

  const available = ALL_SLOTS.filter((s) => !booked.includes(s));
  res.json({ date, service_id, slots: available });
});

router.post('/bookings', (req, res) => {
  const { service_id, customer_name, customer_email, customer_phone, date, time_slot } = req.body;

  if (!service_id || !customer_name || !customer_email || !customer_phone || !date || !time_slot) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  if (!ALL_SLOTS.includes(time_slot)) {
    return res.status(400).json({ error: 'Invalid time slot' });
  }

  const db = getDb();

  const service = db.prepare('SELECT id FROM services WHERE id = ?').get(service_id);
  if (!service) {
    db.close();
    return res.status(400).json({ error: 'Invalid service_id' });
  }

  const conflict = db
    .prepare('SELECT id FROM bookings WHERE service_id = ? AND date = ? AND time_slot = ?')
    .get(service_id, date, time_slot);
  if (conflict) {
    db.close();
    return res.status(409).json({ error: 'That slot is already booked' });
  }

  const result = db
    .prepare(
      'INSERT INTO bookings (service_id, customer_name, customer_email, customer_phone, date, time_slot) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(service_id, customer_name, customer_email, customer_phone, date, time_slot);

  db.close();
  res.status(201).json({ id: result.lastInsertRowid, confirmation: `ZLX-${result.lastInsertRowid.toString().padStart(5, '0')}` });
});

router.get('/bookings', (req, res) => {
  const db = getDb();
  const bookings = db
    .prepare(
      `SELECT b.*, s.name as service_name FROM bookings b
       JOIN services s ON s.id = b.service_id
       ORDER BY b.date, b.time_slot`
    )
    .all();
  db.close();
  res.json(bookings);
});

module.exports = router;
