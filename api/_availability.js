const { bookings, ALL_SLOTS } = require('./_store');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { date, service_id } = req.query;
  if (!date || !service_id) return res.status(400).json({ error: 'date and service_id are required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  const booked = bookings
    .filter((b) => b.date === date && String(b.service_id) === String(service_id))
    .map((b) => b.time_slot);

  res.json({ date, service_id, slots: ALL_SLOTS.filter((s) => !booked.includes(s)) });
};
