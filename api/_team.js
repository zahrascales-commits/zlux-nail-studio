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

    // ── MAGIC LINK LOGIN: team.html?t=<token> ──
    // Tapping a booking notification should land on the schedule, not a PIN
    // pad. The token is scoped to one artist and returns the same shape as a
    // PIN login, so the portal behaves identically from there on.
    if (method === 'POST' && action === 'token_login') {
      const tok = String((req.body && req.body.token) || '').trim();
      const { memberForToken } = require('./_worker-link');
      const memberId = await memberForToken(tok);
      if (!memberId) return res.status(401).json({ error: 'That link is no longer valid — please use your PIN.' });
      const member = await queryOne(
        'SELECT id, name, role, color, pin FROM team_members WHERE id=? AND active=1', [memberId]
      );
      if (!member) return res.status(401).json({ error: 'That account is no longer active.' });
      return res.json({ ok: true, member_id: member.id, name: member.name, role: member.role, color: member.color, pin: member.pin });
    }

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
      await execute('INSERT INTO team_chat (appointment_id, sender, sender_name, body, ts) VALUES (?, ?, ?, ?, ?)',
        [appt.id, 'client', appt.client_name || 'Client', body, Date.now()]);

      // And the artist hears about it without watching the portal.
      let notified = null;
      try {
        notified = await require('./_chat-notify').notifyArtist(appt.id, appt.client_name || 'A client', body);
      } catch (_) {}

      return res.json({ ok: true, notified });
    }

    // ── AUTHENTICATED TEAM-MEMBER ENDPOINTS ──
    const member = await authMember(req);
    if (!member) return res.status(401).json({ error: 'Not authenticated' });

    // ── ALL CLIENTS (intentionally studio-wide, not per-artist: supports
    //    last-minute swaps — any artist gets full context on any client) ──
    if (method === 'GET' && action === 'all_clients') {
      const clients = await query('SELECT id, name, email, phone, visits, last_service, last_visit, likes, dislikes, notes FROM clients ORDER BY last_visit DESC, name LIMIT 300');
      const appts = await query(`SELECT a.client_name, a.client_phone, a.service, a.date, a.time, a.status, m.name AS artist
        FROM team_appointments a LEFT JOIN team_members m ON m.id=a.team_member_id
        ORDER BY a.date DESC, a.time DESC LIMIT 500`);
      const profiles = await query('SELECT email, answers, note, updated_ts FROM client_profiles');
      const profMap = {};
      for (const p of profiles) profMap[String(p.email).toLowerCase()] = { answers: JSON.parse(p.answers || '{}'), note: p.note || '', updated_ts: p.updated_ts };
      return res.json({ clients, appointments: appts, bc_profiles: profMap });
    }

    // ── HER OWN ROSTERED HOURS ──
    // Separate from appointments on purpose: she needs to know when she is
    // expected in even on a day with nobody booked yet.
    if (method === 'GET' && action === 'my_shifts') {
      const today = new Date();
      const pad = n => String(n).padStart(2, '0');
      const from = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
      const rows = await query(
        'SELECT date, start_time, end_time, lunch_start, lunch_end FROM tech_shifts WHERE member_id=? AND date>=? ORDER BY date LIMIT 60',
        [member.id, from]
      ).catch(() => []);
      return res.json({ shifts: rows });
    }

    // ── OPEN APPOINTMENTS: first to confirm takes it ──
    // Only ever lists what this artist could genuinely take — the filtering
    // happened when the booking was dispatched, so anything here is hers to
    // win.
    if (method === 'GET' && action === 'open_jobs') {
      const jobs = await require('./_claims').openJobsFor(member.id);
      return res.json({ jobs });
    }

    if (method === 'POST' && action === 'claim') {
      const conf = String((req.body && req.body.confirmation) || '').trim();
      if (!conf) return res.status(400).json({ error: 'Which appointment?' });
      // Losing the race is not an error — she needs to see who got it, not a
      // red failure screen.
      return res.json(await require('./_claims').claim(conf, member.id));
    }

    if (method === 'GET' && action === 'schedule') {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await query(
        `SELECT id, client_name, client_phone, service, date, time, notes, status, chat_token
         FROM team_appointments WHERE team_member_id=? AND date >= ? ORDER BY date, time`,
        [member.id, today]);
      return res.json({ schedule: rows });
    }

    // ── Post-appointment check-ins ("how did it go?" + notes) for this worker ──
    if (method === 'GET' && action === 'checkins') {
      const rows = await query(
        `SELECT id, client_name, service, date, time, status, note FROM visit_checkins
         WHERE team_member_id=? AND status='pending' ORDER BY created_ts DESC LIMIT 30`, [member.id]);
      return res.json({ checkins: rows });
    }
    if (method === 'POST' && action === 'checkin_respond') {
      const { id, note } = req.body || {};
      const row = await queryOne('SELECT id FROM visit_checkins WHERE id=? AND team_member_id=?', [Number(id), member.id]);
      if (!row) return res.status(404).json({ error: 'Not found' });
      await execute('UPDATE visit_checkins SET status=?, note=?, responded_ts=? WHERE id=?',
        ['done', String(note || '').slice(0, 800), Date.now(), Number(id)]);
      // Let the owner see the note too
      try { await require('./_notify').notifyInApp('owner', null, 'Visit note from ' + member.name, String(note || '').slice(0, 200)); } catch (_) {}
      return res.json({ ok: true });
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
      await execute('INSERT INTO team_chat (appointment_id, sender, sender_name, body, ts) VALUES (?, ?, ?, ?, ?)',
        [Number(appointment_id), 'team', member.name, body, Date.now()]);

      /* Tell the client, with a link straight back into this thread. A
         message nobody is told about is not a message. */
      let notified = null;
      try {
        notified = await require('./_chat-notify').notifyClient(Number(appointment_id), member.name, body);
      } catch (_) {}

      return res.json({ ok: true, notified });
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
