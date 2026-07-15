// Owner-side (Zahra) API for the Studio Manager page.
// Auth: X-CEO-Password header (same password as the CEO dashboard).
const { query, queryOne, execute, ensureTables, token, uniquePin } = require('./_team-db');
const { notifyNewAppointment, sendEmail, sendSMS, providerStatus, clearKeyCache } = require('./_notify');
const { upsertClient } = require('./_clients');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

module.exports = async function (req, res) {
  const method = req.method.toUpperCase();
  const action = req.query.action || (req.body && req.body.action);

  // ── Auth ──
  const pass = req.headers['x-ceo-password'];
  if (pass !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  try {
    await ensureTables();

    // ── BOOTSTRAP: everything the dashboard needs on load ──
    if (method === 'GET' && action === 'bootstrap') {
      const members = await query('SELECT id, name, role, pin, color, active, phone, email FROM team_members ORDER BY id');
      const appts = await query(`SELECT a.*, m.name AS member_name, m.color AS member_color
        FROM team_appointments a LEFT JOIN team_members m ON m.id = a.team_member_id
        ORDER BY a.date, a.time`);
      const providers = await providerStatus();
      return res.json({ members, appointments: appts, providers });
    }

    // ── CONNECT PROVIDERS (paste keys in Settings tab; stored write-only) ──
    if (method === 'POST' && action === 'save_keys') {
      const { twilio_sid, twilio_token, twilio_from, resend_key } = req.body || {};
      const pairs = { twilio_sid, twilio_token, twilio_from, resend_key };
      for (const [k, v] of Object.entries(pairs)) {
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          await execute(
            'INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            [k, String(v).trim()]);
        }
      }
      clearKeyCache();
      const providers = await providerStatus();
      return res.json({ ok: true, providers });
    }

    // ── TEST DELIVERY (send a real test to Zahra) ──
    if (method === 'POST' && action === 'test_notify') {
      const { phone, email } = req.body || {};
      clearKeyCache();
      const out = {};
      if (phone) out.sms = await sendSMS(phone, 'ZOLA test ✦ Your texting is connected and working! — sent from your Studio Manager');
      if (email) out.email = await sendEmail(email, 'ZOLA test ✦ Email is connected',
        '<p>Your email delivery is connected and working ✦</p><p>— sent from your Studio Manager</p>');
      return res.json({ ok: true, ...out });
    }

    // ── MEMBERS ──
    if (method === 'GET' && action === 'members') {
      const members = await query('SELECT id, name, role, pin, color, active, phone, email FROM team_members ORDER BY id');
      return res.json({ members });
    }

    if (method === 'POST' && action === 'add_member') {
      const { name, role, color, phone, email } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name required' });
      const pin = await uniquePin();
      const r = await execute(
        'INSERT INTO team_members (name, role, pin, color, active, phone, email) VALUES (?,?,?,?,1,?,?)',
        [name, role || 'Nail Artist', pin, color || '#C4A882', phone || '', email || '']
      );
      return res.json({ ok: true, member: { id: r.lastInsertRowid, name, role: role || 'Nail Artist', pin, color: color || '#C4A882', active: 1, phone: phone || '', email: email || '' } });
    }

    if (method === 'PUT' && action === 'update_member') {
      const { id, name, role, color, active, phone, email } = req.body || {};
      await execute('UPDATE team_members SET name=?, role=?, color=?, active=?, phone=?, email=? WHERE id=?',
        [name, role, color || '#C4A882', active ? 1 : 0, phone || '', email || '', Number(id)]);
      return res.json({ ok: true });
    }

    if (method === 'POST' && action === 'regen_pin') {
      const { id } = req.body || {};
      const pin = await uniquePin();
      await execute('UPDATE team_members SET pin=? WHERE id=?', [pin, Number(id)]);
      return res.json({ ok: true, pin });
    }

    if (method === 'DELETE' && action === 'member') {
      const { id } = req.body || {};
      await execute('DELETE FROM team_members WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    // ── APPOINTMENTS ──
    if (method === 'GET' && action === 'appointments') {
      const rows = await query(`SELECT a.*, m.name AS member_name, m.color AS member_color
        FROM team_appointments a LEFT JOIN team_members m ON m.id = a.team_member_id
        ORDER BY a.date, a.time`);
      return res.json({ appointments: rows });
    }

    if (method === 'POST' && action === 'add_appt') {
      const { team_member_id, client_name, client_phone, client_email, service, date, time, notes } = req.body || {};
      if (!date || !time) return res.status(400).json({ error: 'Date and time required' });
      const tok = token();
      const r = await execute(
        `INSERT INTO team_appointments (team_member_id, client_name, client_phone, service, date, time, notes, status, chat_token)
         VALUES (?,?,?,?,?,?,?, 'scheduled', ?)`,
        [team_member_id ? Number(team_member_id) : null, client_name || '', client_phone || '', service || '', date, time, notes || '', tok]
      );
      // instant notifications (client confirmation + booked-artist alert) + client memory
      let notify = null;
      try {
        const m = team_member_id ? await queryOne('SELECT id, name, phone, email FROM team_members WHERE id=?', [Number(team_member_id)]) : null;
        notify = await notifyNewAppointment({
          clientName: client_name, clientPhone: client_phone, clientEmail: client_email,
          service, date, time,
          memberId: m ? m.id : null, memberName: m ? m.name : null,
          memberPhone: m ? m.phone : null, memberEmail: m ? m.email : null,
        });
        await upsertClient({ name: client_name, email: client_email, phone: client_phone, service, date });
      } catch (_) {}
      return res.json({ ok: true, id: r.lastInsertRowid, chat_token: tok, notify });
    }

    if (method === 'PUT' && action === 'update_appt') {
      const { id, team_member_id, client_name, client_phone, service, date, time, notes, status } = req.body || {};
      await execute(
        `UPDATE team_appointments SET team_member_id=?, client_name=?, client_phone=?, service=?, date=?, time=?, notes=?, status=? WHERE id=?`,
        [team_member_id ? Number(team_member_id) : null, client_name || '', client_phone || '', service || '', date, time, notes || '', status || 'scheduled', Number(id)]
      );
      return res.json({ ok: true });
    }

    if (method === 'PUT' && action === 'reassign') {
      const { id, team_member_id } = req.body || {};
      await execute('UPDATE team_appointments SET team_member_id=? WHERE id=?',
        [team_member_id ? Number(team_member_id) : null, Number(id)]);
      // alert the newly assigned artist instantly
      try {
        if (team_member_id) {
          const a = await queryOne('SELECT * FROM team_appointments WHERE id=?', [Number(id)]);
          const m = await queryOne('SELECT id, name, phone, email FROM team_members WHERE id=?', [Number(team_member_id)]);
          if (a && m) await notifyNewAppointment({
            clientName: a.client_name, service: a.service, date: a.date, time: a.time,
            memberId: m.id, memberName: m.name, memberPhone: m.phone, memberEmail: m.email,
          });
        }
      } catch (_) {}
      return res.json({ ok: true });
    }

    if (method === 'DELETE' && action === 'appt') {
      const { id } = req.body || {};
      await execute('DELETE FROM team_appointments WHERE id=?', [Number(id)]);
      await execute('DELETE FROM team_chat WHERE appointment_id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    // ── CHAT (owner oversight — read any thread, post as owner) ──
    if (method === 'GET' && action === 'threads') {
      const rows = await query(`SELECT a.id, a.client_name, a.service, a.date, a.time, a.chat_token,
          m.name AS member_name,
          (SELECT body FROM team_chat c WHERE c.appointment_id = a.id ORDER BY c.ts DESC LIMIT 1) AS last_msg,
          (SELECT ts FROM team_chat c WHERE c.appointment_id = a.id ORDER BY c.ts DESC LIMIT 1) AS last_ts,
          (SELECT COUNT(*) FROM team_chat c WHERE c.appointment_id = a.id) AS msg_count
        FROM team_appointments a LEFT JOIN team_members m ON m.id = a.team_member_id
        ORDER BY COALESCE(last_ts, 0) DESC, a.date DESC`);
      return res.json({ threads: rows });
    }

    if (method === 'GET' && action === 'chat') {
      const appointment_id = Number(req.query.appointment_id);
      const msgs = await query('SELECT * FROM team_chat WHERE appointment_id=? ORDER BY ts', [appointment_id]);
      return res.json({ messages: msgs });
    }

    if (method === 'POST' && action === 'chat') {
      const { appointment_id, body } = req.body || {};
      if (!body) return res.status(400).json({ error: 'Message required' });
      await execute('INSERT INTO team_chat (appointment_id, sender, sender_name, body, ts) VALUES (?, "owner", "Zahra", ?, ?)',
        [Number(appointment_id), body, Date.now()]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
