// Client profiles — the system's memory of every client.
// Auto-created/updated from bookings and signups; owner can add
// likes/dislikes/notes; powers returning-client prefill and mass messages.
const { query, queryOne, execute, ensureTables } = require('./_team-db');
const { sendEmail, sendSMS } = require('./_notify');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

// Find-or-create by email/phone, update visit stats. Used by booking flows.
async function upsertClient({ name, email, phone, service, date, optIn }) {
  await ensureTables();
  const em = String(email || '').trim().toLowerCase();
  const ph = String(phone || '').replace(/\D/g, '');
  if (!em && !ph) return null;
  let row = null;
  if (em) row = await queryOne('SELECT * FROM clients WHERE lower(email)=?', [em]);
  if (!row && ph) row = await queryOne("SELECT * FROM clients WHERE replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')','')=?", [ph]);
  if (row) {
    await execute(
      `UPDATE clients SET name=COALESCE(NULLIF(?,''),name), email=COALESCE(NULLIF(?,''),email),
       phone=COALESCE(NULLIF(?,''),phone), visits=visits+?, last_service=COALESCE(NULLIF(?,''),last_service),
       last_visit=COALESCE(NULLIF(?,''),last_visit), marketing_opt_in=CASE WHEN ?=1 THEN 1 ELSE marketing_opt_in END
       WHERE id=?`,
      [name || '', email || '', phone || '', service ? 1 : 0, service || '', date || '', optIn ? 1 : 0, row.id]);
    return Number(row.id);
  }
  const r = await execute(
    'INSERT INTO clients (name,email,phone,visits,last_service,last_visit,marketing_opt_in,created_ts) VALUES (?,?,?,?,?,?,?,?)',
    [name || '', email || '', phone || '', service ? 1 : 0, service || '', date || '', optIn ? 1 : 0, Date.now()]);
  return r.lastInsertRowid;
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensureTables();

    // ── PUBLIC: join the list (signup area) ──
    if (req.method === 'POST' && action === 'signup') {
      const { name, phone, email } = req.body || {};
      if (!phone && !email) return res.status(400).json({ error: 'phone or email required' });
      await upsertClient({ name, email, phone, optIn: true });
      // instant welcome (delivers when provider keys are configured)
      if (email) sendEmail(email, 'Welcome to ZOLA ✦',
        `<p>Hi ${(name || 'love').split(' ')[0]} — you're on the ZOLA list. You'll be first to hear about open spots, drops, and studio news.</p><p>— Zahra ✦ ZOLA Nail Studio</p>`).catch(() => {});
      if (phone) sendSMS(phone, `ZOLA ✦ Hi ${(name || '').split(' ')[0] || 'love'}! You're on the list — you'll be first to know about open spots & studio news. — Zahra`).catch(() => {});
      return res.json({ ok: true });
    }

    // ── PUBLIC: returning-client lookup for booking prefill ──
    if (req.method === 'GET' && action === 'lookup') {
      const q = String(req.query.q || '').trim().toLowerCase();
      if (!q) return res.status(400).json({ error: 'q required' });
      const ph = q.replace(/\D/g, '');
      let row = await queryOne('SELECT name,email,phone FROM clients WHERE lower(email)=?', [q]);
      if (!row && ph.length >= 10) row = await queryOne("SELECT name,email,phone FROM clients WHERE replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')','')=?", [ph]);
      if (!row) return res.json({ found: false });
      return res.json({ found: true, client: row });
    }

    // ── OWNER ONLY ──
    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'GET') {
      const rows = await query('SELECT * FROM clients ORDER BY created_ts DESC LIMIT 500');
      // include Black Card questionnaire profiles so the owner sees everything
      let bc_profiles = {};
      try {
        const profiles = await query('SELECT email, answers, note, updated_ts FROM client_profiles');
        for (const p of profiles) bc_profiles[String(p.email).toLowerCase()] = { answers: JSON.parse(p.answers || '{}'), note: p.note || '', updated_ts: p.updated_ts };
      } catch (_) {}
      return res.json({ clients: rows, bc_profiles });
    }

    if (req.method === 'PUT' && action === 'update') {
      const { id, name, email, phone, likes, dislikes, notes, marketing_opt_in } = req.body || {};
      await execute('UPDATE clients SET name=?,email=?,phone=?,likes=?,dislikes=?,notes=?,marketing_opt_in=? WHERE id=?',
        [name || '', email || '', phone || '', likes || '', dislikes || '', notes || '', marketing_opt_in ? 1 : 0, Number(id)]);
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await execute('DELETE FROM clients WHERE id=?', [Number((req.body || {}).id)]);
      return res.json({ ok: true });
    }

    // ── OWNER: mass message ──
    if (req.method === 'POST' && action === 'mass') {
      const { message, channel, audience } = req.body || {};
      if (!message) return res.status(400).json({ error: 'message required' });
      const all = await query('SELECT * FROM clients ORDER BY created_ts DESC LIMIT 500');
      const targets = all.filter(c => audience === 'all' ? true : Number(c.marketing_opt_in) === 1);
      let sms = 0, emails = 0, skipped = 0;
      const failures = [];
      for (const c of targets) {
        const first = (c.name || '').split(' ')[0] || 'love';
        const text = String(message).replace(/\{name\}/g, first);
        let delivered = false;
        if ((channel === 'sms' || channel === 'both') && c.phone) {
          const r = await sendSMS(c.phone, text + ' — ZOLA');
          if (r.sent) { sms++; delivered = true; } else if (r.why.includes('provider')) failures.push(r.why);
        }
        if ((channel === 'email' || channel === 'both') && c.email) {
          const r = await sendEmail(c.email, 'A note from ZOLA ✦', `<p>${text.replace(/\n/g, '<br>')}</p><p>— Zahra ✦ ZOLA Nail Studio</p>`);
          if (r.sent) { emails++; delivered = true; } else if (r.why.includes('provider')) failures.push(r.why);
        }
        if (!delivered) skipped++;
      }
      const providerMissing = failures.find(f => f.includes('provider'));
      return res.json({ ok: true, targeted: targets.length, sms_sent: sms, emails_sent: emails, skipped, provider_missing: providerMissing || null });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.upsertClient = upsertClient;
