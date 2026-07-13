const store = require('./_store');

function auth(req) {
  const pwd = req.headers['x-ceo-password'] || req.query.pwd;
  return pwd === (process.env.CEO_PASSWORD || 'ZOLA2026');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CEO-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Public GET — booking page reads this to show "Fully Booked" vs available
  if (req.method === 'GET') {
    const date = req.query.date;
    const blocks = date
      ? store.calendarBlocks.filter(b => b.date === date)
      : store.calendarBlocks;
    // Also get booked slots for the date (in-memory bookings)
    const booked = date
      ? store.bookings.filter(b => b.date === date).map(b => b.time_slot)
      : [];
    // Merge in appointments scheduled from the Studio Manager (Turso-backed),
    // so owner-booked times also show as taken on the public calendar.
    // Wrapped so a DB hiccup never breaks the public booking page.
    if (date) {
      try {
        const { query, ensureTables } = require('./_team-db');
        await ensureTables();
        const rows = await query('SELECT time FROM team_appointments WHERE date=?', [date]);
        for (const r of rows) if (r.time && !booked.includes(r.time)) booked.push(r.time);
      } catch (_) { /* ignore — fall back to in-memory bookings only */ }
    }
    return res.json({ blocks, booked, all_slots: store.ALL_SLOTS });
  }

  if (!auth(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'POST') {
    const { date, slot, note } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    // Prevent duplicate
    const dup = store.calendarBlocks.findIndex(b => b.date === date && b.slot === (slot || 'ALL'));
    if (dup >= 0) store.calendarBlocks.splice(dup, 1);
    store.calendarBlocks.push({ date, slot: slot || 'ALL', note: note || '' });
    return res.json({ ok: true, blocks: store.calendarBlocks });
  }

  if (req.method === 'DELETE') {
    const { date, slot } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    const before = store.calendarBlocks.length;
    for (let i = store.calendarBlocks.length - 1; i >= 0; i--) {
      const b = store.calendarBlocks[i];
      if (b.date === date && (!slot || b.slot === slot)) {
        store.calendarBlocks.splice(i, 1);
      }
    }
    return res.json({ ok: true, removed: before - store.calendarBlocks.length });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
