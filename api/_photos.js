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
// Roughly 3MB of base64, which is about a 2.2MB image. Comfortably under
// the request size a serverless function will accept, and far above
// anything the browser will actually send after resizing — the point is
// that a photo is never refused for being large.
const MAX_DATA_URL = 3000000;

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensureTables();

    // ── PUBLIC: which slots have a photo, and what version ──
    //
    // This is what public pages ask for. It is a few hundred bytes, so it
    // arrives immediately, and each slot resolves to /api/photo?slot=…&v=…
    // which the browser caches like any other image.
    if (req.method === 'GET' && action === 'manifest') {
      const rows = await query('SELECT slot, updated_ts FROM site_photos');
      const out = {};
      for (const r of rows) out[r.slot] = Number(r.updated_ts) || 1;
      res.setHeader('Cache-Control', 'public, max-age=30');
      return res.json({ versions: out });
    }

    // ── PUBLIC: every slot, inlined ──
    //
    // Kept for Studio Manager, which genuinely wants the thumbnails in one
    // request. Public pages must not use this: it hands over every photo on
    // the site as base64 whether the page shows them or not.
    if (req.method === 'GET' && (!action || action === 'slots')) {
      const rows = await query('SELECT slot, data_url FROM site_photos');
      const out = {};
      for (const r of rows) out[r.slot] = r.data_url;
      return res.json({ photos: out });
    }

    // ── PUBLIC: who does this confirmation code belong to? ──
    // The link in a confirmation text carries only the booking code, so the
    // upload page can fill in the client's own name, service and date itself.
    // That's what makes the photo land on the artist's feed tagged with who
    // sent it, without asking the client to type a thing.
    if (req.method === 'GET' && action === 'inspo_context') {
      const code = String(req.query.c || '').trim().slice(0, 40);
      if (!code) return res.status(400).json({ error: 'Missing booking code' });
      const appt = await queryOne(
        `SELECT a.client_name, a.service, a.date, m.name AS member_name
           FROM team_appointments a
           LEFT JOIN team_members m ON m.id = a.team_member_id
          WHERE a.notes LIKE ?
          ORDER BY a.id DESC LIMIT 1`,
        ['%' + code + '%']
      ).catch(() => null);
      if (!appt) return res.status(404).json({ error: 'We could not find that booking.' });
      return res.json({
        confirmation: code,
        client_name: appt.client_name || '',
        service: appt.service || '',
        appt_date: appt.date || '',
        member_name: appt.member_name || '',
      });
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
      const rows = await query('SELECT * FROM client_inspo ORDER BY ts DESC LIMIT 120');
      if (isOwner) return res.json({ inspo: rows });

      // An artist sees a client's inspiration photo in exactly two cases: the
      // appointment is hers, or it is still open to her and she is deciding
      // whether she can do that design. Anything else is somebody else's
      // client, and their photo is not the whole team's to browse.
      const memberId = Number(req.headers['x-team-id'] || req.query.member_id);
      const mine = new Set();     // hers now — the client belongs to her
      const deciding = new Set(); // still up for grabs, shown so she can judge it

      try {
        const claims = await query('SELECT confirmation, claimed_by, offered, status FROM booking_claims');
        for (const c of claims) {
          if (!c.confirmation) continue;
          if (Number(c.claimed_by) === memberId) { mine.add(c.confirmation); continue; }
          if (c.claimed_by) continue;                      // somebody else took it
          if (String(c.status) !== 'open') continue;
          let offered = [];
          try { offered = JSON.parse(c.offered || '[]').map(Number); } catch (_) {}
          if (offered.includes(memberId)) deciding.add(c.confirmation);
        }
      } catch (_) { /* no dispatch table yet */ }

      // Bookings that never went out for claim — the client picked her, or
      // Zahra assigned it — carry the confirmation in the appointment note.
      try {
        const appts = await query('SELECT notes FROM team_appointments WHERE team_member_id=?', [memberId]);
        for (const a of appts) {
          const hit = String(a.notes || '').match(/ZOLA-\d+/);
          if (hit) mine.add(hit[0]);
        }
      } catch (_) {}

      const visible = rows
        .filter(r => mine.has(r.confirmation) || deciding.has(r.confirmation))
        .map(r => ({ ...r, mine: mine.has(r.confirmation) }));
      return res.json({ inspo: visible });
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
