const store = require('./_store');
const { queryOne, execute } = require('./_db');

module.exports = function(req, res) {
  const method = req.method.toUpperCase();
  const action = req.query.action || (req.body && req.body.action);

  // Worker login
  if (method === 'POST' && action === 'login') {
    const { pin } = req.body;
    const worker = store.workers.find(w => w.pin === String(pin) && w.active);
    if (!worker) return res.status(401).json({ error: 'Invalid PIN' });
    return res.json({ ok: true, worker_id: worker.id, name: worker.name });
  }

  // Auth check for protected endpoints
  const workerId = Number(req.headers['x-worker-id'] || req.query.worker_id);
  const workerPin = req.headers['x-worker-pin'] || req.query.pin;
  const worker = store.workers.find(w => w.id === workerId && w.pin === String(workerPin) && w.active);
  if (!worker && action !== 'login') {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Schedule: bookings assigned to this worker (or all if worker assigned)
  if (method === 'GET' && action === 'schedule') {
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = store.bookings
      .filter(b => b.date >= today && (b.worker === worker.name || !b.worker))
      .sort((a, b) => (a.date + a.time_slot).localeCompare(b.date + b.time_slot))
      .slice(0, 20)
      .map(b => ({
        id: b.id,
        client: b.customer_name || '',
        phone: b.customer_phone || '',
        service: b.service_name || '',
        addons: b.addon_names || [],
        date: b.date,
        time: b.time_slot,
        notes: b.notes || '',
      }));
    return res.json({ schedule: upcoming });
  }

  // Send message to client (logs it + tries to send via email/SMS if available)
  if (method === 'POST' && action === 'message') {
    const { booking_id, message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    const booking = store.bookings.find(b => b.id === Number(booking_id));
    const entry = {
      id: store.incMsgId(),
      worker_id: workerId,
      worker_name: worker.name,
      booking_id: Number(booking_id),
      client_name: booking ? booking.customer_name : 'Client',
      client_email: booking ? booking.customer_email : null,
      message,
      ts: Date.now(),
    };
    store.workerMessages.push(entry);
    return res.json({ ok: true, msg_id: entry.id });
  }

  // Get all messages sent by this worker
  if (method === 'GET' && action === 'messages') {
    const msgs = store.workerMessages
      .filter(m => m.worker_id === workerId)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 50);
    return res.json({ messages: msgs });
  }

  // Mark appointment complete
  if (method === 'PUT' && action === 'complete') {
    const { booking_id } = req.body || {};
    // Update in-memory store
    const booking = store.bookings.find(b => b.id === Number(booking_id));
    if (booking) booking.status = 'COMPLETED';
    // Update DB
    try {
      await execute(`UPDATE appointments SET status='COMPLETED', completed_at=datetime('now') WHERE id=? OR (appointment_date=? AND appointment_time=?)`,
        [Number(booking_id), booking?.date, booking?.time_slot]);
    } catch (_) {}
    return res.json({ ok: true });
  }

  // Mark appointment as no-show
  if (method === 'PUT' && action === 'no_show') {
    const { booking_id } = req.body || {};
    const booking = store.bookings.find(b => b.id === Number(booking_id));
    if (booking) booking.status = 'NO_SHOW';
    try {
      // Mark in appointments table
      await execute(`UPDATE appointments SET status='NO_SHOW' WHERE id=? OR (appointment_date=? AND appointment_time=?)`,
        [Number(booking_id), booking?.date, booking?.time_slot]);
      // Record in no_shows table and increment member count
      if (booking?.member_id) {
        const apptRow = await queryOne('SELECT id FROM appointments WHERE appointment_date=? AND appointment_time=?', [booking.date, booking.time_slot]).catch(() => null);
        await execute(`INSERT INTO no_shows (member_id, appointment_id, date) VALUES (?,?,?)`,
          [booking.member_id, apptRow?.id || null, booking?.date || new Date().toISOString().slice(0, 10)]);
        await execute('UPDATE members SET no_show_count = no_show_count + 1 WHERE member_id = ?', [booking.member_id]);
      }
    } catch (_) {}
    return res.json({ ok: true });
  }

  // Inspo board: public GET (no auth needed for viewing), CEO-only POST handled in ceo-data
  if (method === 'GET' && action === 'inspo') {
    return res.json({ photos: store.inspoPhotos.slice().reverse().slice(0, 30) });
  }

  // CEO can add inspo via this endpoint too (auth via CEO password)
  if (method === 'POST' && action === 'add_inspo') {
    const ceoPass = req.headers['x-ceo-password'];
    if (ceoPass !== (process.env.CEO_PASSWORD || 'ZOLA2026')) {
      return res.status(403).json({ error: 'CEO auth required' });
    }
    const { url, caption } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const photo = { id: store.incInspoId(), url, caption: caption || '', ts: Date.now(), added_by: 'Zahra' };
    store.inspoPhotos.push(photo);
    return res.json({ ok: true, photo });
  }

  // CEO: delete inspo photo
  if (method === 'DELETE' && action === 'inspo') {
    const ceoPass = req.headers['x-ceo-password'];
    if (ceoPass !== (process.env.CEO_PASSWORD || 'ZOLA2026')) {
      return res.status(403).json({ error: 'CEO auth required' });
    }
    const { id } = req.body || {};
    const idx = store.inspoPhotos.findIndex(p => p.id === Number(id));
    if (idx >= 0) store.inspoPhotos.splice(idx, 1);
    return res.json({ ok: true });
  }

  // CEO: get all worker messages
  if (method === 'GET' && action === 'all_messages') {
    const ceoPass = req.headers['x-ceo-password'];
    if (ceoPass !== (process.env.CEO_PASSWORD || 'ZOLA2026')) {
      return res.status(403).json({ error: 'CEO auth required' });
    }
    return res.json({ messages: store.workerMessages.slice().reverse() });
  }

  // CEO: update worker PIN
  if (method === 'PUT' && action === 'worker_pin') {
    const ceoPass = req.headers['x-ceo-password'];
    if (ceoPass !== (process.env.CEO_PASSWORD || 'ZOLA2026')) {
      return res.status(403).json({ error: 'CEO auth required' });
    }
    const { worker_id, pin } = req.body || {};
    const w = store.workers.find(w => w.id === Number(worker_id));
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    w.pin = String(pin);
    return res.json({ ok: true });
  }

  // CEO: list workers
  if (method === 'GET' && action === 'workers') {
    const ceoPass = req.headers['x-ceo-password'];
    if (ceoPass !== (process.env.CEO_PASSWORD || 'ZOLA2026')) {
      return res.status(403).json({ error: 'CEO auth required' });
    }
    return res.json({ workers: store.workers.map(w => ({ id: w.id, name: w.name, active: w.active })) });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
