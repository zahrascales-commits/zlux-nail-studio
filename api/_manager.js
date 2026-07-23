// Owner-side (Zahra) API for the Studio Manager page.
// Auth: X-CEO-Password header (same password as the CEO dashboard).
const { query, queryOne, execute, ensureTables, token, uniquePin } = require('./_team-db');
const { notifyNewAppointment, sendEmail, sendSMS, providerStatus, clearKeyCache } = require('./_notify');
const { upsertClient } = require('./_clients');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

async function membersWithSkills() {
  const members = await query('SELECT id, name, role, pin, color, active, phone, email, restricted, bio, show_on_site, title FROM team_members ORDER BY id');
  const skillRows = await query('SELECT team_member_id, service_name FROM worker_skills');
  const skillsByMember = {};
  for (const row of skillRows) {
    (skillsByMember[row.team_member_id] = skillsByMember[row.team_member_id] || []).push(row.service_name);
  }
  for (const m of members) m.skills = skillsByMember[m.id] || [];
  return members;
}

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
      const members = await membersWithSkills();
      const appts = await query(`SELECT a.*, m.name AS member_name, m.color AS member_color
        FROM team_appointments a LEFT JOIN team_members m ON m.id = a.team_member_id
        ORDER BY a.date, a.time`);
      const providers = await providerStatus();
      return res.json({ members, appointments: appts, providers });
    }

    // ── CONNECT PROVIDERS (paste keys in Settings tab; stored write-only) ──
    if (method === 'POST' && action === 'save_keys') {
      const { twilio_sid, twilio_token, twilio_from, resend_key, stripe_secret, stripe_publishable } = req.body || {};
      const pairs = { twilio_sid, twilio_token, twilio_from, resend_key, stripe_secret, stripe_publishable };
      for (const [k, v] of Object.entries(pairs)) {
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          await execute(
            'INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            [k, String(v).trim()]);
        }
      }
      clearKeyCache();
      try { require('./_pay').clearStripeKeyCache(); } catch (_) {}
      const providers = await providerStatus();
      return res.json({ ok: true, providers });
    }

    // Is Stripe connected? (pasted keys first, then env) — for the Settings card
    if (method === 'GET' && action === 'stripe_status') {
      const rows = await query("SELECT key, value FROM site_settings WHERE key IN ('stripe_secret','stripe_publishable')");
      const db = {}; for (const r of rows) db[r.key] = r.value;
      const secret = db.stripe_secret || process.env.STRIPE_SECRET_KEY || '';
      const pub = db.stripe_publishable || process.env.STRIPE_PUBLISHABLE_KEY || '';
      const enabled = !!(secret && pub);
      const live = /_live_/.test(pub) || /_live_/.test(secret);
      return res.json({ enabled, mode: enabled ? (live ? 'live' : 'test') : 'off' });
    }

    // ── EMAIL SELF-REPAIR: register the sender with SendGrid so 403s stop ──
    // SendGrid rejects mail from unverified senders (the silent bug that ate
    // every email). This asks SendGrid to email a verification link to the
    // chosen address; after Zahra clicks it, that address can send.
    if (method === 'POST' && action === 'verify_sender') {
      const from = String((req.body || {}).from_email || '').trim().toLowerCase();
      if (!/@/.test(from)) return res.status(400).json({ error: 'Valid email required' });
      const sgKey = process.env.SENDGRID_API_KEY;
      if (!sgKey) return res.status(400).json({ error: 'SendGrid key not configured' });
      const r = await fetch('https://api.sendgrid.com/v3/verified_senders', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sgKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname: 'ZOLA Studio', from_email: from, from_name: 'ZOLA Nail Studio',
          reply_to: from, reply_to_name: 'ZOLA Nail Studio',
          address: 'Porterville', city: 'Porterville', state: 'CA', zip: '93257', country: 'USA',
        }),
      });
      const data = await r.json().catch(() => ({}));
      // remember the sender either way — sends work as soon as she clicks the link
      await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        ['notify_from_email', from]);
      clearKeyCache();
      if (r.ok || r.status === 201) return res.json({ ok: true, status: 'verification_email_sent', to: from });
      // already verified or pending is fine too
      const msg = JSON.stringify(data).slice(0, 300);
      if (/already/i.test(msg)) return res.json({ ok: true, status: 'already_requested', detail: msg });
      return res.status(400).json({ error: msg });
    }

    // ── SET UP $1.58 TEST MEMBERSHIP PRICE IN STRIPE (one-time) ──
    if (method === 'POST' && action === 'setup_test_tier') {
      const sk = await require('./_pay').getStripeSecret();
      if (!sk) return res.status(400).json({ error: 'Stripe not configured' });
      const existing = await queryOne("SELECT value FROM site_settings WHERE key='stripe_price_test'");
      if (existing && existing.value) return res.json({ ok: true, price_id: existing.value, existed: true });
      const call = async (path, params) => {
        const r = await fetch('https://api.stripe.com/v1/' + path, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error && d.error.message || ('stripe ' + r.status));
        return d;
      };
      const product = await call('products', { name: 'ZOLA Test Membership (owner testing)' });
      const price = await call('prices', {
        product: product.id, currency: 'usd', unit_amount: '158', 'recurring[interval]': 'month',
      });
      await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        ['stripe_price_test', price.id]);
      return res.json({ ok: true, price_id: price.id });
    }

    // ── SET UP THE THREE MEMBERSHIP PRICES ON THE CONNECTED STRIPE ACCOUNT ──
    // Idempotent: creates a monthly recurring Price per tier only if one isn't
    // already stored. Run once after connecting a Stripe account so membership
    // subscriptions charge correctly ($99 / $199 / $299 a month).
    if (method === 'POST' && action === 'setup_membership_prices') {
      const sk = await require('./_pay').getStripeSecret();
      if (!sk) return res.status(400).json({ error: 'Stripe not configured — connect your keys first.' });
      const call = async (path, params) => {
        const r = await fetch('https://api.stripe.com/v1/' + path, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error && d.error.message || ('stripe ' + r.status));
        return d;
      };
      const tiers = [
        { tier: 'SIGNATURE', key: 'stripe_price_signature', name: 'ZOLA Signature Club', cents: 9900 },
        { tier: 'LUXE', key: 'stripe_price_luxe', name: 'ZOLA Luxe Club', cents: 19900 },
        { tier: 'BLACK_CARD', key: 'stripe_price_black_card', name: 'ZOLA Black Card', cents: 29900 },
      ];
      const out = {};
      for (const t of tiers) {
        const existing = await queryOne('SELECT value FROM site_settings WHERE key=?', [t.key]);
        // Verify the stored price still exists on the CURRENT account; if not, recreate
        let valid = false;
        if (existing && existing.value) {
          try {
            const chk = await fetch('https://api.stripe.com/v1/prices/' + existing.value, { headers: { Authorization: 'Bearer ' + sk } });
            valid = chk.ok;
          } catch (_) {}
        }
        if (valid) { out[t.tier] = { price_id: existing.value, existed: true }; continue; }
        const product = await call('products', { name: t.name });
        const price = await call('prices', { product: product.id, currency: 'usd', unit_amount: String(t.cents), 'recurring[interval]': 'month' });
        await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [t.key, price.id]);
        out[t.tier] = { price_id: price.id, created: true };
      }
      return res.json({ ok: true, prices: out });
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
      return res.json({ members: await membersWithSkills() });
    }

    // ── WORKER SKILLS (which services this artist is allowed to book) ──
    if (method === 'PUT' && action === 'worker_skills') {
      const { id, restricted, services } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await execute('UPDATE team_members SET restricted=? WHERE id=?', [restricted ? 1 : 0, Number(id)]);
      await execute('DELETE FROM worker_skills WHERE team_member_id=?', [Number(id)]);
      for (const name of (Array.isArray(services) ? services : [])) {
        await execute('INSERT OR IGNORE INTO worker_skills (team_member_id, service_name) VALUES (?,?)', [Number(id), name]);
      }
      return res.json({ ok: true });
    }

    // ── SCHEDULE COVERAGE OVERRIDES (e.g. "only Maria working July 21–Aug 2") ──
    if (method === 'GET' && action === 'overrides') {
      const overrides = await query('SELECT * FROM schedule_overrides ORDER BY start_date DESC');
      return res.json({ overrides: overrides.map(o => ({ ...o, team_member_ids: JSON.parse(o.team_member_ids || '[]') })) });
    }

    if (method === 'POST' && action === 'overrides') {
      const { start_date, end_date, team_member_ids, note } = req.body || {};
      if (!start_date || !end_date || !Array.isArray(team_member_ids) || !team_member_ids.length) {
        return res.status(400).json({ error: 'start_date, end_date, and at least one team member are required' });
      }
      const r = await execute(
        'INSERT INTO schedule_overrides (start_date, end_date, team_member_ids, note, created_ts) VALUES (?,?,?,?,?)',
        [start_date, end_date, JSON.stringify(team_member_ids.map(Number)), note || '', Date.now()]
      );
      return res.json({ ok: true, id: r.lastInsertRowid });
    }

    if (method === 'DELETE' && action === 'overrides') {
      const { id } = req.body || {};
      await execute('DELETE FROM schedule_overrides WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    // ── PERSONAL BLOCKS (GlossGenius-style: block time for a person) ──
    if (method === 'GET' && action === 'blocks') {
      const from = req.query.from || new Date().toISOString().slice(0, 10);
      const rows = await query('SELECT * FROM personal_blocks WHERE date >= ? ORDER BY date, start_time', [from]);
      return res.json({ blocks: rows });
    }

    if (method === 'POST' && action === 'block') {
      const { member_id, member_name, dates, all_day, start_time, end_time, note } = req.body || {};
      const dateList = Array.isArray(dates) ? dates : (dates ? [dates] : []);
      if (!dateList.length) return res.status(400).json({ error: 'At least one date is required' });
      if (!all_day && (!start_time || !end_time)) return res.status(400).json({ error: 'Start and end time required (or choose all day)' });
      for (const date of dateList) {
        await execute(
          'INSERT INTO personal_blocks (member_id, member_name, date, all_day, start_time, end_time, note, created_ts) VALUES (?,?,?,?,?,?,?,?)',
          [member_id ? Number(member_id) : null, member_name || '', date, all_day ? 1 : 0, all_day ? null : start_time, all_day ? null : end_time, note || '', Date.now()]
        );
      }
      return res.json({ ok: true, count: dateList.length });
    }

    if (method === 'DELETE' && action === 'block') {
      const { id } = req.body || {};
      await execute('DELETE FROM personal_blocks WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    // ── PER-DAY HOURS OVERRIDE (open later / close earlier / closed one day) ──
    if (method === 'GET' && action === 'day_hours') {
      const from = req.query.from || new Date().toISOString().slice(0, 10);
      const rows = await query('SELECT * FROM day_hours WHERE date >= ? ORDER BY date', [from]);
      return res.json({ day_hours: rows });
    }

    if (method === 'POST' && action === 'day_hours') {
      const { date, open_time, close_time, closed } = req.body || {};
      if (!date) return res.status(400).json({ error: 'date required' });
      await execute(
        'INSERT INTO day_hours (date, open_time, close_time, closed) VALUES (?,?,?,?) ON CONFLICT(date) DO UPDATE SET open_time=excluded.open_time, close_time=excluded.close_time, closed=excluded.closed',
        [date, open_time || null, close_time || null, closed ? 1 : 0]
      );
      return res.json({ ok: true });
    }

    if (method === 'DELETE' && action === 'day_hours') {
      const { date } = req.body || {};
      await execute('DELETE FROM day_hours WHERE date=?', [date]);
      return res.json({ ok: true });
    }

    // ── DEFAULT BOOKING-AVAILABILITY HOURS (which slots the calendar offers) ──
    if (method === 'GET' && action === 'booking_hours') {
      const o = await queryOne("SELECT value FROM site_settings WHERE key='book_open_time'");
      const c = await queryOne("SELECT value FROM site_settings WHERE key='book_close_time'");
      return res.json({ open_time: (o && o.value) || '08:00', close_time: (c && c.value) || '22:00' });
    }

    if (method === 'POST' && action === 'booking_hours') {
      const { open_time, close_time } = req.body || {};
      for (const [k, v] of [['book_open_time', open_time], ['book_close_time', close_time]]) {
        if (v) await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, String(v)]);
      }
      return res.json({ ok: true });
    }

    if (method === 'POST' && action === 'add_member') {
      const { name, role, color, phone, email, bio, title, show_on_site } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name required' });
      const pin = await uniquePin();
      const r = await execute(
        'INSERT INTO team_members (name, role, pin, color, active, phone, email, bio, title, show_on_site) VALUES (?,?,?,?,1,?,?,?,?,?)',
        [name, role || 'Nail Artist', pin, color || '#C4A882', phone || '', email || '', bio || '', title || '', show_on_site ? 1 : 0]
      );
      return res.json({ ok: true, member: { id: r.lastInsertRowid, name, role: role || 'Nail Artist', pin, color: color || '#C4A882', active: 1, phone: phone || '', email: email || '', bio: bio || '', title: title || '', show_on_site: show_on_site ? 1 : 0 } });
    }

    if (method === 'PUT' && action === 'update_member') {
      const { id, name, role, color, active, phone, email, bio, title, show_on_site } = req.body || {};
      await execute('UPDATE team_members SET name=?, role=?, color=?, active=?, phone=?, email=?, bio=?, title=?, show_on_site=? WHERE id=?',
        [name, role, color || '#C4A882', active ? 1 : 0, phone || '', email || '', bio || '', title || '', show_on_site ? 1 : 0, Number(id)]);
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
