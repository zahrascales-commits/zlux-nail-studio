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

    // Effective slots for the day start as the full studio range; booking-hours
    // settings + a per-day override can narrow it. Personal blocks and Studio
    // Manager appointments then mark specific slots unavailable. All Turso work
    // is wrapped so a DB hiccup never breaks the public booking page.
    let allSlots = store.ALL_SLOTS.slice();
    if (date) {
      try {
        const { query, queryOne, ensureTables } = require('./_team-db');
        await ensureTables();

        // 1) Owner-booked appointments count as taken
        const appts = await query('SELECT time FROM team_appointments WHERE date=?', [date]);
        for (const r of appts) if (r.time && !booked.includes(r.time)) booked.push(r.time);

        // 2) Booking-availability hours: default from settings, overridden per-day
        const openRow  = await queryOne("SELECT value FROM site_settings WHERE key='book_open_time'").catch(() => null);
        const closeRow = await queryOne("SELECT value FROM site_settings WHERE key='book_close_time'").catch(() => null);
        let openT  = (openRow && openRow.value)  || '08:00';
        let closeT = (closeRow && closeRow.value) || '22:00';
        const dayRow = await queryOne('SELECT open_time, close_time, closed FROM day_hours WHERE date=?', [date]).catch(() => null);
        if (dayRow) {
          if (Number(dayRow.closed)) { allSlots = []; blocks.push({ date, slot: 'ALL', note: 'Closed' }); }
          else {
            if (dayRow.open_time)  openT  = dayRow.open_time;
            if (dayRow.close_time) closeT = dayRow.close_time;
          }
        }
        allSlots = allSlots.filter(s => s >= openT && s < closeT);

        // 3) Personal blocks (durable): all-day blocks the whole date, timed
        //    blocks remove each hour inside [start, end)
        const pblocks = await query('SELECT member_name, all_day, start_time, end_time, note FROM personal_blocks WHERE date=?', [date]);
        for (const pb of pblocks) {
          const who = pb.member_name ? (' — ' + pb.member_name) : '';
          if (Number(pb.all_day)) {
            blocks.push({ date, slot: 'ALL', note: 'Personal block' + who });
          } else if (pb.start_time && pb.end_time) {
            for (const s of store.ALL_SLOTS) {
              if (s >= pb.start_time && s < pb.end_time) blocks.push({ date, slot: s, note: 'Blocked' + who });
            }
          }
        }
      } catch (_) { /* ignore — fall back to in-memory blocks + full slots */ }
    }
    return res.json({ blocks, booked, all_slots: allSlots });
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
