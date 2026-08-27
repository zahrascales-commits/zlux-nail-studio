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
      const { name, phone, email, source } = req.body || {};
      if (!phone && !email) return res.status(400).json({ error: 'phone or email required' });
      await upsertClient({ name, email, phone, optIn: true });
      // Which list they joined from. Everyone lands in the same book, but a
      // drop list is not the same audience as everyone who has ever sat in
      // the chair, and she needs to be able to write to one without the other.
      try { await execute("ALTER TABLE clients ADD COLUMN source TEXT DEFAULT ''"); } catch (_) {}
      if (source) {
        const key = email ? 'lower(email)=?' : "replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')','')=?";
        const val = email ? String(email).toLowerCase().trim() : String(phone || '').replace(/\D/g, '');
        // One statement, and the match is the only condition. An earlier
        // draft read "WHERE source IS NULL OR source='' AND lower(email)=?",
        // which SQL reads as "(source IS NULL) OR (source='' AND email=?)" —
        // that would have retagged every client in the book who had no
        // source yet, every time one person joined a waitlist.
        try { await execute('UPDATE clients SET source=? WHERE ' + key, [String(source).slice(0, 40), val]); } catch (_) {}
      }
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

    /* ── ONE CLIENT, FROM ANYWHERE ────────────────────────────────────
       Any screen that names a client can open this — Studio Manager, and
       the artists' own portal. Artists see the same history Zahra sees,
       because somebody about to do a set needs to know what happened last
       time. They can add notes; they cannot edit the record.            */
    async function whoIsAsking() {
      if (req.headers['x-ceo-password'] === CEO_PASSWORD) return { owner: true, name: 'Zahra' };
      const tid = Number(req.headers['x-team-id'] || req.query.member_id || (req.body || {}).member_id);
      const pin = String(req.headers['x-team-pin'] || req.query.pin || (req.body || {}).pin || '');
      if (!tid || !pin) return null;
      const a = await queryOne('SELECT id, name FROM team_members WHERE id=? AND pin=? AND active=1', [tid, pin]);
      return a ? { owner: false, name: a.name, member_id: a.id } : null;
    }

    // Found by whatever the calling screen happens to know about them.
    async function findClient(q) {
      const id = Number(q.id) || 0;
      const nm = String(q.name || '').trim();
      const em = String(q.email || '').trim().toLowerCase();
      const ph = String(q.phone || '').replace(/\D/g, '');
      let c = null;
      if (id) c = await queryOne('SELECT * FROM clients WHERE id=?', [id]);
      if (!c && em) c = await queryOne('SELECT * FROM clients WHERE lower(email)=?', [em]);
      if (!c && ph) c = await queryOne(
        "SELECT * FROM clients WHERE replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')','')=?", [ph]);
      if (!c && nm) c = await queryOne('SELECT * FROM clients WHERE lower(name)=lower(?)', [nm]);
      return c;
    }

    async function ensureNotes() {
      await execute(`CREATE TABLE IF NOT EXISTS client_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER, client_name TEXT, note TEXT, author TEXT,
        pinned INTEGER DEFAULT 0, ts INTEGER
      )`).catch(() => {});
    }

    /* Every visit a client has ever had: when, who did it, what they had,
       and what they paid. Assembled from two tables because that is where
       the truth lives — the money sits on the booking, the artist sits on
       the studio calendar, and neither alone can answer "who did her nails
       in March and what did she spend". Written once so the owner's view
       and the artist's view can never drift apart. */
    async function buildHistory(client) {
      const em = String(client.email || '').trim().toLowerCase();
      const nm = String(client.name || '').trim();
      const ph = String(client.phone || '').replace(/\D/g, '');

      let teamRows = [];
      try {
        teamRows = await query(
          `SELECT a.id, a.client_name, a.client_phone, a.service, a.date, a.time, a.notes, a.status,
                  m.name AS provider
             FROM team_appointments a
             LEFT JOIN team_members m ON m.id = a.team_member_id
            WHERE (? <> '' AND lower(a.client_name) = lower(?))
               OR (? <> '' AND replace(replace(replace(replace(a.client_phone,'-',''),' ',''),'(',''),')','') = ?)
            ORDER BY a.date DESC, a.time DESC`,
          [nm, nm, ph, ph]);
      } catch (_) {}

      let payRows = [];
      try {
        const main = require('./_db');
        payRows = await main.query(
          `SELECT guest_name, guest_email, service, addons, appointment_date, appointment_time,
                  status, total_cents, deposit_cents, deposit_paid
             FROM appointments
            WHERE (? <> '' AND lower(COALESCE(guest_email,'')) = ?)
               OR (? <> '' AND lower(COALESCE(guest_name,'')) = lower(?))
            ORDER BY appointment_date DESC, appointment_time DESC`,
          [em, em, nm, nm]);
      } catch (_) {}

      // Their history from the old booking system. Most of these clients
      // have years of visits that never touched this site, and a profile
      // that starts the day we switched over is not their history.
      let legacy = [];
      try {
        legacy = await query(
          `SELECT date, time, service, artist, status, deposit_cents, deposit_paid
             FROM client_visits
            WHERE (client_id > 0 AND client_id = ?) OR (? <> '' AND lower(client_name) = lower(?))
            ORDER BY date DESC, time DESC`,
          [Number(client.id) || 0, nm, nm]);
      } catch (_) {}

      const money = {};
      for (const p of payRows) money[p.appointment_date + ' ' + p.appointment_time] = p;

      const seen = new Set();
      const visits = [];
      const add = (v) => {
        const k = v.date + ' ' + v.time;
        if (seen.has(k)) return;
        seen.add(k);
        visits.push(v);
      };

      for (const t of teamRows) {
        const p = money[t.date + ' ' + t.time];
        const conf = (String(t.notes || '').match(/ZOLA-\d+/) || [''])[0];
        let addons = [];
        try { addons = JSON.parse((p && p.addons) || '[]'); } catch (_) {}
        add({
          date: t.date, time: t.time,
          service: t.service || (p && p.service) || '',
          addons, provider: t.provider || '',
          total_cents: p ? Number(p.total_cents) || 0 : null,
          deposit_cents: p ? Number(p.deposit_cents) || 0 : 0,
          deposit_paid: p ? !!Number(p.deposit_paid) : false,
          status: t.status || (p && p.status) || 'scheduled',
          confirmation: conf,
        });
      }
      for (const p of payRows) {
        let addons = [];
        try { addons = JSON.parse(p.addons || '[]'); } catch (_) {}
        add({
          date: p.appointment_date, time: p.appointment_time,
          service: p.service || '', addons, provider: '',
          total_cents: Number(p.total_cents) || 0,
          deposit_cents: Number(p.deposit_cents) || 0,
          deposit_paid: !!Number(p.deposit_paid),
          status: p.status || 'scheduled', confirmation: '',
        });
      }

      for (const l of legacy) {
        add({
          date: l.date, time: l.time, service: l.service || '', addons: [],
          provider: l.artist || '',
          total_cents: null,
          deposit_cents: Number(l.deposit_cents) || 0,
          deposit_paid: !!Number(l.deposit_paid),
          status: l.status || 'completed', confirmation: '', legacy: true,
        });
      }

      visits.sort((a, b) => String(b.date + b.time).localeCompare(String(a.date + a.time)));
      const counted = visits.filter(v => String(v.status || '').toLowerCase() !== 'cancelled');
      // Only deposit-paid visits count as money spent, the same rule the
      // dashboard uses. A client's lifetime value and the studio's revenue
      // disagreeing would make both of them useless.
      const paid = counted.filter(v => v.deposit_paid);
      return {
        visits,
        totals: {
          visits: counted.length,
          cancelled: visits.length - counted.length,
          paid_visits: paid.length,
          spent_cents: paid.reduce((s2, v) => s2 + (v.total_cents || 0), 0),
          first_visit: counted.length ? counted[counted.length - 1].date : '',
          last_visit: counted.length ? counted[0].date : '',
        },
      };
    }

    if (req.method === 'GET' && action === 'profile') {
      const who = await whoIsAsking();
      if (!who) return res.status(401).json({ error: 'Unauthorized' });
      await ensureNotes();

      let client = await findClient(req.query);
      // Somebody who has booked but was never filed. Show what we know
      // rather than a dead end — a missing row is not a missing person.
      if (!client) {
        client = {
          id: 0, name: String(req.query.name || '').trim(),
          email: String(req.query.email || ''), phone: String(req.query.phone || ''),
          likes: '', dislikes: '', notes: '', visits: 0, unfiled: true,
        };
      }

      let notes = [];
      try {
        notes = await query(
          `SELECT id, note, author, pinned, ts FROM client_notes
            WHERE (client_id > 0 AND client_id = ?) OR (? <> '' AND lower(client_name) = lower(?))
            ORDER BY pinned DESC, ts DESC LIMIT 60`,
          [Number(client.id) || 0, client.name || '', client.name || '']);
      } catch (_) {}

      let visits = [], totals = {};
      try {
        const built = await buildHistory(client);
        visits = built.visits; totals = built.totals;
      } catch (_) {}

      // Membership, if any. An artist should know before someone sits down
      // whether this visit is already covered.
      let membership = null;
      try {
        const main = require('./_db');
        const mem = await main.queryOne(
          'SELECT member_id, tier, date_of_birth, membership_started_at FROM members WHERE lower(email)=? OR lower(full_name)=lower(?)',
          [String(client.email || '').toLowerCase(), client.name || '']);
        if (mem) {
          let age = null;
          const dob = String(mem.date_of_birth || '').slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
            const d = new Date(dob + 'T12:00:00'), n = new Date();
            age = n.getFullYear() - d.getFullYear() -
              ((n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) ? 1 : 0);
          }
          membership = { member_id: mem.member_id, tier: mem.tier, since: mem.membership_started_at, age };
        }
      } catch (_) {}

      // What this person said about their own nails, so whoever is doing
      // them knows about the allergy and the peeling before they open a
      // bottle — not after. Everyone who works on a client sees this; it is
      // the whole reason a client is asked to fill it in.
      let nails = null;
      try {
        const main = require('./_db');
        const { nailProfile } = require('./_roster-people');
        let row = null;
        if (membership && membership.member_id) {
          row = await main.queryOne(
            'SELECT member_id, answers, score, band, goal, created_ts FROM nail_assessments WHERE member_id=? ORDER BY created_ts DESC LIMIT 1',
            [membership.member_id]);
        }
        if (row) nails = nailProfile(row);
      } catch (_) {}

      // The older Black Card questionnaire, filed against an email address.
      let intake = null;
      try {
        if (client.email) {
          const p = await queryOne('SELECT answers, note, updated_ts FROM client_profiles WHERE lower(email)=?',
            [String(client.email).toLowerCase()]);
          if (p) intake = { answers: JSON.parse(p.answers || '{}'), note: p.note || '', updated_ts: p.updated_ts };
        }
      } catch (_) {}

      return res.json({ client, notes, visits, totals, membership, nails, intake,
                        can_edit: who.owner, viewer: who.name });
    }

    // Notes are append-only and signed. A note that decides how somebody's
    // nails get done should say who wrote it and never be quietly rewritten.
    if (req.method === 'POST' && action === 'note') {
      const who = await whoIsAsking();
      if (!who) return res.status(401).json({ error: 'Unauthorized' });
      const body = req.body || {};
      const text = String(body.note || '').trim();
      if (!text) return res.status(400).json({ error: 'Write something first.' });
      await ensureNotes();
      const client = await findClient(body);
      await execute(
        'INSERT INTO client_notes (client_id, client_name, note, author, pinned, ts) VALUES (?,?,?,?,?,?)',
        [Number(client && client.id) || 0, String((client && client.name) || body.name || ''),
         text.slice(0, 800), who.name, body.pinned ? 1 : 0, Date.now()]);
      return res.json({ ok: true });
    }

    if (req.method === 'PUT' && action === 'pin_note') {
      const who = await whoIsAsking();
      if (!who || !who.owner) return res.status(401).json({ error: 'Unauthorized' });
      const b = req.body || {};
      await execute('UPDATE client_notes SET pinned=? WHERE id=?', [b.pinned ? 1 : 0, Number(b.id)]);
      return res.json({ ok: true });
    }

    // Kept for the owner's Clients tab, now built on the shared assembly.
    if (req.method === 'GET' && action === 'history') {
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const client = await queryOne('SELECT * FROM clients WHERE id=?', [Number(req.query.id)]);
      if (!client) return res.status(404).json({ error: 'No such client' });
      const built = await buildHistory(client);
      return res.json({
        client: { id: client.id, name: client.name, email: client.email, phone: client.phone },
        visits: built.visits, totals: built.totals,
      });
    }

    // ── OWNER ONLY ──
    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

    // The bare GET is the client list. It has to stay last among GETs, or it
    // answers for every named action before that action is ever reached.
    if (req.method === 'GET' && !action) {
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
      const { id, name, email, phone, likes, dislikes, notes, marketing_opt_in, sizes } = req.body || {};
      try { await execute("ALTER TABLE clients ADD COLUMN sizes TEXT DEFAULT ''"); } catch (_) {}
      await execute('UPDATE clients SET name=?,email=?,phone=?,likes=?,dislikes=?,notes=?,marketing_opt_in=? WHERE id=?',
        [name || '', email || '', phone || '', likes || '', dislikes || '', notes || '', marketing_opt_in ? 1 : 0, Number(id)]);
      if (sizes !== undefined) await execute('UPDATE clients SET sizes=? WHERE id=?', [String(sizes || ''), Number(id)]);
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await execute('DELETE FROM clients WHERE id=?', [Number((req.body || {}).id)]);
      return res.json({ ok: true });
    }

    // ── OWNER: list every client for the mass-message picker ──
    if (req.method === 'GET' && action === 'list') {
      const rows = await query('SELECT id, name, email, phone, last_service, marketing_opt_in FROM clients ORDER BY name');
      return res.json({ clients: rows });
    }

    // ── OWNER: mass message ──
    if (req.method === 'POST' && action === 'mass') {
      const { message, channel, audience, ids } = req.body || {};
      if (!message) return res.status(400).json({ error: 'message required' });

      // Build the target list from whichever audience was chosen. Tier
      // audiences pull from the membership roster; everything else pulls from
      // the general client list (opt-in, all, or a hand-picked selection).
      let targets = [];
      if (audience === 'BLACK_CARD' || audience === 'LUXE' || audience === 'SIGNATURE') {
        targets = await query('SELECT full_name AS name, email, phone FROM members WHERE tier = ?', [audience]).catch(() => []);
      } else if (audience === 'selected') {
        const idList = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
        if (!idList.length) return res.status(400).json({ error: 'No clients selected' });
        const all = await query('SELECT * FROM clients ORDER BY created_ts DESC LIMIT 1000');
        targets = all.filter(c => idList.includes(Number(c.id)));
      } else {
        const all = await query('SELECT * FROM clients ORDER BY created_ts DESC LIMIT 500');
        targets = all.filter(c => audience === 'all' ? true : Number(c.marketing_opt_in) === 1);
      }
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
