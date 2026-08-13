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

    // ── TECH SHIFTS (which dates + hours each artist actually works) ──
    // Read a whole month at once so the scheduling calendar paints in one call.
    if (method === 'GET' && action === 'shifts') {
      const from = req.query.from || '0000-00-00';
      const to = req.query.to || '9999-12-31';
      const mid = req.query.member_id;
      const rows = mid
        ? await query('SELECT * FROM tech_shifts WHERE member_id=? AND date>=? AND date<=? ORDER BY date', [Number(mid), from, to])
        : await query('SELECT * FROM tech_shifts WHERE date>=? AND date<=? ORDER BY date', [from, to]);
      // How far ahead each artist is scheduled, so the UI can warn her before a
      // calendar quietly runs dry and clients start seeing "Fully Booked".
      const today = new Date().toISOString().slice(0, 10);
      const last = await query(
        'SELECT member_id, MAX(date) AS last_date, COUNT(*) AS upcoming FROM tech_shifts WHERE date>=? GROUP BY member_id',
        [today]
      );
      const coverage = {};
      for (const r of last) coverage[r.member_id] = { last_date: r.last_date, upcoming: Number(r.upcoming) };
      return res.json({ shifts: rows, coverage });
    }

    // Apply a set of dates in one shot — the calendar sends every date that
    // should be ON for this artist in the given range, and we make the table
    // match exactly. One call covers ticking, unticking and bulk fills alike.
    if (method === 'PUT' && action === 'shifts') {
      const { member_id, from, to, dates, start_time, end_time } = req.body || {};
      if (!member_id) return res.status(400).json({ error: 'member_id required' });
      if (!from || !to) return res.status(400).json({ error: 'from and to required' });
      const st = start_time || '09:00';
      const et = end_time || '18:00';
      if (et <= st) return res.status(400).json({ error: 'End time must be after start time' });
      const want = Array.isArray(dates) ? dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
      const mid = Number(member_id);
      // Replace the window rather than diff it — the payload is one month of
      // dates at most, and this can't drift out of sync with what she sees.
      await execute('DELETE FROM tech_shifts WHERE member_id=? AND date>=? AND date<=?', [mid, from, to]);
      for (const d of want) {
        await execute(
          'INSERT OR REPLACE INTO tech_shifts (member_id, date, start_time, end_time, created_ts) VALUES (?,?,?,?,?)',
          [mid, d, st, et, Date.now()]
        );
      }
      return res.json({ ok: true, saved: want.length });
    }

    // Per-date hours, for when one day runs different from the rest
    if (method === 'PUT' && action === 'shift_hours') {
      const { member_id, date, start_time, end_time } = req.body || {};
      if (!member_id || !date) return res.status(400).json({ error: 'member_id and date required' });
      if (!start_time || !end_time) return res.status(400).json({ error: 'start_time and end_time required' });
      if (end_time <= start_time) return res.status(400).json({ error: 'End time must be after start time' });
      await execute(
        'INSERT OR REPLACE INTO tech_shifts (member_id, date, start_time, end_time, created_ts) VALUES (?,?,?,?,?)',
        [Number(member_id), date, start_time, end_time, Date.now()]
      );
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

    // ── DEPOSITS: who has paid vs not, mark-paid, and 24-hour notice ──
    async function depositRows() {
      const { query: mainQuery, execute: mainExec } = require('./_db');
      try { await mainExec('ALTER TABLE appointments ADD COLUMN deposit_paid INTEGER DEFAULT 0'); } catch (_) {}
      const today = new Date().toISOString().slice(0, 10);
      const rows = await mainQuery(
        `SELECT a.id, a.appointment_date AS date, a.appointment_time AS time, a.service,
                a.total_cents, a.deposit_cents, a.deposit_paid,
                m.full_name, m.phone AS mphone, m.email AS memail, a.guest_name, a.guest_email
         FROM appointments a LEFT JOIN members m ON a.member_id = m.member_id
         WHERE a.status = 'SCHEDULED' AND a.appointment_date >= ?
         ORDER BY a.appointment_date, a.appointment_time`, [today]).catch(() => []);
      const clients = await query('SELECT email, phone FROM clients').catch(() => []);
      const pmap = {}; for (const c of clients) if (c.email) pmap[String(c.email).toLowerCase()] = c.phone;
      return rows.map(r => ({
        id: r.id, date: r.date, time: r.time, service: r.service,
        total_cents: Number(r.total_cents) || 0, deposit_cents: Number(r.deposit_cents) || 0,
        deposit_paid: Number(r.deposit_paid) ? 1 : 0,
        name: r.full_name || r.guest_name || 'Client',
        phone: r.mphone || pmap[String(r.guest_email || '').toLowerCase()] || '',
        email: r.memail || r.guest_email || '',
      }));
    }

    if (method === 'GET' && action === 'deposits') {
      return res.json({ appointments: await depositRows() });
    }

    if (method === 'POST' && action === 'deposit_mark') {
      const { id, paid } = req.body || {};
      const { execute: mainExec } = require('./_db');
      try { await mainExec('ALTER TABLE appointments ADD COLUMN deposit_paid INTEGER DEFAULT 0'); } catch (_) {}
      await mainExec('UPDATE appointments SET deposit_paid=? WHERE id=?', [paid ? 1 : 0, Number(id)]);
      return res.json({ ok: true });
    }

    if (method === 'POST' && action === 'request_deposit') {
      const { id } = req.body || {};
      const row = (await depositRows()).find(r => String(r.id) === String(id));
      if (!row) return res.status(404).json({ error: 'Appointment not found' });
      const first = row.name.split(' ')[0];
      const dep = '$' + Math.round(row.deposit_cents / 100);
      const when = row.date + ' at ' + row.time;
      const sms = `ZOLA Nail Studio: Hi ${first} — your ${dep} deposit for ${row.service} on ${when} is still due. Please send it within 24 hours or your appointment will be cancelled. Questions? Just reply here. ✦`;
      const html = `<p>Hi ${first},</p><p>Your <strong>${dep} deposit</strong> for <strong>${row.service}</strong> on ${when} is still due. Please send it within <strong>24 hours</strong> or your appointment will be cancelled.</p><p>Questions? Reply to this email or DM @zola_officials_.</p><p>— ZOLA Nail Studio ✦</p>`;
      const out = {};
      if (row.phone) out.sms = await sendSMS(row.phone, sms);
      if (row.email) out.email = await sendEmail(row.email, 'Deposit needed within 24 hours — ZOLA', html);
      try { await require('./_notify').notifyInApp('owner', null, 'Deposit notice sent', `24-hour deposit notice sent to ${row.name} (${row.service}, ${when}).`); } catch (_) {}
      return res.json({ ok: true, ...out });
    }

    // ── NOTIFICATION SETTINGS (worker + client + inventory reminders) ──
    if (method === 'GET' && action === 'notif_settings') {
      const rows = await query("SELECT key, value FROM site_settings WHERE key LIKE 'notif_%' OR key='owner_phone'");
      const s = {}; for (const r of rows) s[r.key] = r.value;
      const on = (k, d) => s[k] === undefined ? d : String(s[k]) === '1';
      const num = (k, d) => s[k] === undefined ? d : (Number(s[k]) || d);
      return res.json({
        worker_pre_on: on('notif_worker_pre_on', true), worker_pre_min: num('notif_worker_pre_min', 10),
        worker_checkin_on: on('notif_worker_checkin_on', true), worker_checkin_min: num('notif_worker_checkin_min', 120),
        worker_overrun_on: on('notif_worker_overrun_on', true),
        client_24h_on: on('notif_client_24h_on', true), client_1h_on: on('notif_client_1h_on', true), client_post_on: on('notif_client_post_on', true),
        inv_daily_on: on('notif_inv_daily_on', true), inv_daily_time: s['notif_inv_daily_time'] || '18:00',
        inv_lowstock_on: on('notif_inv_lowstock_on', true),
        owner_phone: s['owner_phone'] || '',
      });
    }
    if (method === 'POST' && action === 'notif_settings') {
      const b = req.body || {};
      const map = {
        notif_worker_pre_on: b.worker_pre_on ? '1' : '0', notif_worker_pre_min: String(Number(b.worker_pre_min) || 10),
        notif_worker_checkin_on: b.worker_checkin_on ? '1' : '0', notif_worker_checkin_min: String(Number(b.worker_checkin_min) || 120),
        notif_worker_overrun_on: b.worker_overrun_on ? '1' : '0',
        notif_client_24h_on: b.client_24h_on ? '1' : '0', notif_client_1h_on: b.client_1h_on ? '1' : '0', notif_client_post_on: b.client_post_on ? '1' : '0',
        notif_inv_daily_on: b.inv_daily_on ? '1' : '0', notif_inv_daily_time: String(b.inv_daily_time || '18:00'),
        notif_inv_lowstock_on: b.inv_lowstock_on ? '1' : '0',
        owner_phone: String(b.owner_phone || ''),
      };
      for (const [k, v] of Object.entries(map)) {
        await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, v]);
      }
      return res.json({ ok: true });
    }

    // ── MEMBERS: list + remove (cancels their Stripe subscription first) ──
    if (method === 'GET' && action === 'members_list') {
      const { query: mainQuery } = require('./_db');
      const rows = await mainQuery(
        'SELECT member_id, full_name, email, tier, membership_started_at, stripe_subscription_id FROM members ORDER BY membership_started_at DESC'
      ).catch(() => []);
      return res.json({ members: rows });
    }

    if (method === 'DELETE' && action === 'member_record') {
      const memberId = String((req.body || {}).member_id || '').trim();
      if (!memberId) return res.status(400).json({ error: 'member_id required' });
      const { queryOne: mainOne, execute: mainExec } = require('./_db');
      const m = await mainOne('SELECT member_id, full_name, stripe_subscription_id FROM members WHERE member_id=?', [memberId]);
      if (!m) return res.status(404).json({ error: 'Member not found' });
      // Cancel their subscription so they're never billed again
      let cancelled = null;
      if (m.stripe_subscription_id) {
        try {
          const sk = await require('./_pay').getStripeSecret();
          if (sk) {
            const r = await fetch('https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(m.stripe_subscription_id), {
              method: 'DELETE', headers: { Authorization: 'Bearer ' + sk },
            });
            cancelled = r.ok;
          }
        } catch (_) { cancelled = false; }
      }
      await mainExec('DELETE FROM members WHERE member_id=?', [memberId]);
      return res.json({ ok: true, removed: m.full_name || memberId, subscription_cancelled: cancelled });
    }

    // ── MEMBERSHIP SALES STATS (real counts + revenue by tier) ──
    if (method === 'GET' && action === 'membership_stats') {
      const PRICE = { SIGNATURE: 9900, LUXE: 19900, BLACK_CARD: 29900 };
      const counts = { SIGNATURE: 0, LUXE: 0, BLACK_CARD: 0 };
      try {
        const rows = await query("SELECT tier, COUNT(*) AS n FROM members WHERE tier IN ('SIGNATURE','LUXE','BLACK_CARD') GROUP BY tier");
        for (const r of rows) if (counts[r.tier] !== undefined) counts[r.tier] = Number(r.n);
      } catch (_) {}
      const total = counts.SIGNATURE + counts.LUXE + counts.BLACK_CARD;
      const mrr = counts.SIGNATURE * PRICE.SIGNATURE + counts.LUXE * PRICE.LUXE + counts.BLACK_CARD * PRICE.BLACK_CARD;
      let newThisMonth = 0;
      try {
        const monthPrefix = new Date().toISOString().slice(0, 7);
        const nr = await query("SELECT COUNT(*) AS n FROM members WHERE substr(membership_started_at,1,7)=? AND tier IN ('SIGNATURE','LUXE','BLACK_CARD')", [monthPrefix]);
        newThisMonth = nr[0] ? Number(nr[0].n) : 0;
      } catch (_) {}
      return res.json({ counts, total, mrr_cents: mrr, arr_cents: mrr * 12, new_this_month: newThisMonth, prices: PRICE });
    }

    // ── WHERE PEOPLE HEARD ABOUT US (from membership signups) ──
    if (method === 'GET' && action === 'heard_about') {
      const LABELS = { instagram: 'Instagram', friend: 'Friend or family', google: 'Google', tiktok: 'TikTok', celebrity: 'Saw a celebrity client', other: 'Other', '': 'Not specified' };
      let rows = [];
      try { rows = await query('SELECT heard_about, COUNT(*) AS n FROM members GROUP BY heard_about'); } catch (_) {}
      const counts = {};
      let total = 0;
      for (const r of rows) {
        const key = (r.heard_about || '').toLowerCase();
        const label = LABELS[key] || (r.heard_about || 'Not specified');
        counts[label] = (counts[label] || 0) + Number(r.n);
        total += Number(r.n);
      }
      const sources = Object.entries(counts).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
      return res.json({ sources, total });
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

    // ── DEFAULT BOOKING-AVAILABILITY HOURS + MINIMUM ADVANCE NOTICE ──
    if (method === 'GET' && action === 'booking_hours') {
      const o = await queryOne("SELECT value FROM site_settings WHERE key='book_open_time'");
      const c = await queryOne("SELECT value FROM site_settings WHERE key='book_close_time'");
      const adv = await queryOne("SELECT value FROM site_settings WHERE key='min_advance_hours'");
      return res.json({
        open_time: (o && o.value) || '08:00',
        close_time: (c && c.value) || '22:00',
        min_advance_hours: adv ? Number(adv.value) : 0,
      });
    }

    if (method === 'POST' && action === 'booking_hours') {
      const { open_time, close_time, min_advance_hours } = req.body || {};
      const pairs = [['book_open_time', open_time], ['book_close_time', close_time]];
      if (min_advance_hours !== undefined) pairs.push(['min_advance_hours', String(Number(min_advance_hours) || 0)]);
      for (const [k, v] of pairs) {
        if (v !== undefined && v !== null && v !== '') await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, String(v)]);
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
