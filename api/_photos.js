// Site photos + client inspo uploads.
//
// Site photos: Zahra uploads an image into any named slot from the Studio
// Manager (hero, princess party, Instagram grid, etc.); public pages load
// them via GET. Stored as data-URLs in Turso — images are client-side
// resized before upload so rows stay small.
//
// Client inspo: after booking, a client can attach an inspiration photo.
// It lands in a feed visible to Zahra AND every team member, tagged with
// who it came from — so supplies can be ordered before the appointment.
const { query, queryOne, execute, ensureTables } = require('./_team-db');
const { notifyInApp } = require('./_notify');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const MAX_DATA_URL = 900000; // ~900KB — client resizes to well under this

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensureTables();

    // ── PUBLIC: all site photo slots (pages render these) ──
    if (req.method === 'GET' && (!action || action === 'slots')) {
      const rows = await query('SELECT slot, data_url FROM site_photos');
      const out = {};
      for (const r of rows) out[r.slot] = r.data_url;
      return res.json({ photos: out });
    }

    // ── PUBLIC: client attaches an inspo photo after booking ──
    if (req.method === 'POST' && action === 'inspo') {
      const { confirmation, client_name, client_email, service, appt_date, data_url } = req.body || {};
      if (!data_url || !String(data_url).startsWith('data:image/')) return res.status(400).json({ error: 'image required' });
      if (String(data_url).length > MAX_DATA_URL) return res.status(413).json({ error: 'Image too large — try again, it will be compressed automatically.' });
      await execute(
        'INSERT INTO client_inspo (confirmation, client_name, client_email, service, appt_date, data_url, ts) VALUES (?,?,?,?,?,?,?)',
        [String(confirmation || '').slice(0, 40), String(client_name || 'Client').slice(0, 120),
         String(client_email || '').slice(0, 160), String(service || '').slice(0, 120),
         String(appt_date || '').slice(0, 12), data_url, Date.now()]);
      // Alert Zahra + every active team member, tagged with who sent it
      try {
        const title = `Inspo photo 💅 from ${String(client_name || 'a client').split(' ')[0]}`;
        const body = `${service || 'Appointment'}${appt_date ? ' · ' + appt_date : ''} — open the Inspo feed to view & order supplies`;
        await notifyInApp('owner', null, title, body);
        const members = await query('SELECT id FROM team_members WHERE active=1');
        for (const m of members) await notifyInApp('member', m.id, title, body);
      } catch (_) {}
      return res.json({ ok: true });
    }

    // ── OWNER: upload/replace a site photo slot ──
    if (req.method === 'PUT' && action === 'slot') {
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const { slot, data_url } = req.body || {};
      if (!slot) return res.status(400).json({ error: 'slot required' });
      if (data_url === null || data_url === '') {
        await execute('DELETE FROM site_photos WHERE slot=?', [String(slot)]);
        return res.json({ ok: true, cleared: true });
      }
      if (!String(data_url).startsWith('data:image/')) return res.status(400).json({ error: 'image required' });
      if (String(data_url).length > MAX_DATA_URL) return res.status(413).json({ error: 'Image too large' });
      await execute(
        'INSERT INTO site_photos (slot, data_url, updated_ts) VALUES (?,?,?) ON CONFLICT(slot) DO UPDATE SET data_url=excluded.data_url, updated_ts=excluded.updated_ts',
        [String(slot).slice(0, 60), data_url, Date.now()]);
      return res.json({ ok: true });
    }

    // ── OWNER or TEAM MEMBER: the client-inspo feed (who sent what) ──
    if (req.method === 'GET' && action === 'inspo_feed') {
      const isOwner = req.headers['x-ceo-password'] === CEO_PASSWORD;
      let allowed = isOwner;
      if (!allowed) {
        const id = Number(req.headers['x-team-id'] || req.query.member_id);
        const pin = String(req.headers['x-team-pin'] || req.query.pin || '');
        if (id && pin) allowed = !!(await queryOne('SELECT id FROM team_members WHERE id=? AND pin=? AND active=1', [id, pin]));
      }
      if (!allowed) return res.status(401).json({ error: 'Unauthorized' });
      const rows = await query('SELECT * FROM client_inspo ORDER BY ts DESC LIMIT 60');
      return res.json({ inspo: rows });
    }

    // ── OWNER: delete an inspo photo ──
    if (req.method === 'DELETE' && action === 'inspo') {
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      await execute('DELETE FROM client_inspo WHERE id=?', [Number((req.body || {}).id)]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
