// Team Member portal API (PIN auth) + public client chat (token auth).
// Turso-backed via the shared _team-db layer so data syncs across devices.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

async function authMember(req) {
  const id = Number(req.headers['x-team-id'] || req.query.member_id);
  const pin = String(req.headers['x-team-pin'] || req.query.pin || '');
  if (!id || !pin) return null;
  return queryOne('SELECT id, name, role, color FROM team_members WHERE id=? AND pin=? AND active=1', [id, pin]);
}

module.exports = async function (req, res) {
  const method = req.method.toUpperCase();
  const action = req.query.action || (req.body && req.body.action);

  try {
    await ensureTables();

    // ── LOGIN ──
    if (method === 'POST' && action === 'login') {
      const pin = String((req.body && req.body.pin) || '').trim();
      if (!pin) return res.status(400).json({ error: 'PIN required' });
      const member = await queryOne('SELECT id, name, role, color FROM team_members WHERE pin=? AND active=1', [pin]);
      if (!member) return res.status(401).json({ error: 'Invalid PIN' });
      return res.json({ ok: true, member_id: member.id, name: member.name, role: member.role, color: member.color });
    }

    // ── PUBLIC CLIENT CHAT (token, no login) ──
    if (method === 'GET' && action === 'client_thread') {
      const tok = String(req.query.token || '');
      const appt = await queryOne(
        `SELECT a.id, a.client_name, a.service, a.date, a.time, m.name AS member_name
         FROM team_appointments a LEFT JOIN team_members m ON m.id = a.team_member_id
         WHERE a.chat_token = ?`, [tok]);
      if (!appt) return res.status(404).json({ error: 'Thread not found' });
      const msgs = await query('SELECT sender, sender_name, body, ts FROM team_chat WHERE appointment_id=? ORDER BY ts', [appt.id]);
      return res.json({ appointment: appt, messages: msgs });
    }

    if (method === 'POST' && action === 'client_msg') {
      const { token: tok, body } = req.body || {};
      if (!body) return res.status(400).json({ error: 'Message required' });
      const appt = await queryOne('SELECT id, client_name FROM team_appointments WHERE chat_token=?', [tok]);
      if (!appt) return res.status(404).json({ error: 'Thread not found' });
      await execute('INSERT INTO team_chat (appointment_id, sender, sender_name, body, ts) VALUES (?, "client", ?, ?, ?)',
        [appt.id, appt.client_name || 'Client', body, Date.now()]);
      return res.json({ ok: true });
    }

    // ── AUTHENTICATED TEAM-MEMBER ENDPOINTS ──
    const member = await authMember(req);
    if (!member) return res.status(401).json({ error: 'Not authenticated' });

    if (method === 'GET' && action === 'schedule') {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await query(
        `SELECT id, client_name, client_phone, service, date, time, notes, status, chat_token
         FROM team_appointments WHERE team_member_id=? AND date >= ? ORDER BY date, time`,
        [member.id, today]);
      return res.json({ schedule: rows });
    }

    if (method === 'GET' && action === 'chat') {
      const appointment_id = Number(req.query.appointment_id);
      const owns = await queryOne('SELECT id FROM team_appointments WHERE id=? AND team_member_id=?', [appointment_id, member.id]);
      if (!owns) return res.status(403).json({ error: 'Not your appointment' });
      const msgs = await query('SELECT sender, sender_name, body, ts FROM team_chat WHERE appointment_id=? ORDER BY ts', [appointment_id]);
      return res.json({ messages: msgs });
    }

    if (method === 'POST' && action === 'chat') {
      const { appointment_id, body } = req.body || {};
      if (!body) return res.status(400).json({ error: 'Message required' });
      const owns = await queryOne('SELECT id FROM team_appointments WHERE id=? AND team_member_id=?', [Number(appointment_id), member.id]);
      if (!owns) return res.status(403).json({ error: 'Not your appointment' });
      await execute('INSERT INTO team_chat (appointment_id, sender, sender_name, body, ts) VALUES (?, "team", ?, ?, ?)',
        [Number(appointment_id), member.name, body, Date.now()]);
      return res.json({ ok: true });
    }

    if (method === 'PUT' && action === 'status') {
      const { appointment_id, status } = req.body || {};
      const owns = await queryOne('SELECT id FROM team_appointments WHERE id=? AND team_member_id=?', [Number(appointment_id), member.id]);
      if (!owns) return res.status(403).json({ error: 'Not your appointment' });
      await execute('UPDATE team_appointments SET status=? WHERE id=?', [status, Number(appointment_id)]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
