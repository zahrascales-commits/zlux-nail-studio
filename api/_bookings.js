const { services, addons, bookings, ALL_SLOTS, incId } = require('./_store');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.json(
      bookings.map((b) => ({
        ...b,
        service_name: (services.find((s) => s.id === b.service_id) || {}).name,
      }))
    );
  }

  if (req.method === 'POST') {
    const { service_id, addon_ids = [], customer_name, customer_email, customer_phone, date, time_slot } = req.body;

    if (!service_id || !customer_name || !customer_email || !customer_phone || !date || !time_slot)
      return res.status(400).json({ error: 'All fields are required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    if (!ALL_SLOTS.includes(time_slot)) return res.status(400).json({ error: 'Invalid time slot' });

    const service = services.find((s) => s.id === +service_id);
    if (!service) return res.status(400).json({ error: 'Invalid service_id' });

    const selectedAddons = addon_ids.map((aid) => addons.find((a) => a.id === +aid)).filter(Boolean);
    const addonTotal = selectedAddons.reduce((sum, a) => sum + a.price_cents, 0);
    const total_cents = service.price_cents + addonTotal;
    const deposit_cents = Math.ceil(total_cents / 2);

    const conflict = bookings.find(
      (b) => String(b.service_id) === String(service_id) && b.date === date && b.time_slot === time_slot
    );
    if (conflict) return res.status(409).json({ error: 'That slot is already booked' });

    const id = incId();
    bookings.push({
      id,
      service_id: +service_id,
      addon_ids: selectedAddons.map((a) => a.id),
      customer_name,
      customer_email,
      customer_phone,
      date,
      time_slot,
      total_cents,
      deposit_cents,
      created_at: new Date().toISOString(),
    });

    return res.status(201).json({
      id,
      confirmation: `ZLX-${String(id).padStart(5, '0')}`,
      total_cents,
      deposit_cents,
    });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
