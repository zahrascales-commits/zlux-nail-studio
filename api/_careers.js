// Applications from people who want to train and work at ZOLA.
//
// Interviews are in person only — deliberately. Zahra is hiring on how
// someone works with their hands, which a video call cannot show. So the form
// collects a preferred day and time to come in, not a booking: she confirms
// it herself rather than letting a stranger take a slot off her calendar.
const { query, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const MAX_RESUME = 2200000; // ~2.2MB of base64, plenty for a PDF or photo

async function ensure() {
  await ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS applicants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    experience TEXT DEFAULT '',
    about TEXT DEFAULT '',
    pref_date TEXT DEFAULT '',
    pref_time TEXT DEFAULT '',
    resume_name TEXT DEFAULT '',
    resume_data TEXT DEFAULT '',
    status TEXT DEFAULT 'new',
    created_ts INTEGER
  )`);
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CEO-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensure();

    // ── PUBLIC: apply ──
    if (req.method === 'POST' && action === 'apply') {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 120);
      const email = String(b.email || '').trim().slice(0, 160);
      const phone = String(b.phone || '').trim().slice(0, 40);
      if (!name) return res.status(400).json({ error: 'Please add your name.' });
      if (!email && !phone) return res.status(400).json({ error: 'Please add an email or a phone number so we can reach you.' });

      const resume = String(b.resume_data || '');
      if (resume && resume.length > MAX_RESUME) {
        return res.status(413).json({ error: 'That file is too large — please keep it under about 1.5MB.' });
      }

      await execute(
        `INSERT INTO applicants (name, email, phone, experience, about, pref_date, pref_time, resume_name, resume_data, status, created_ts)
         VALUES (?,?,?,?,?,?,?,?,?, 'new', ?)`,
        [name, email, phone,
         String(b.experience || '').slice(0, 60),
         String(b.about || '').slice(0, 1500),
         String(b.pref_date || '').slice(0, 12),
         String(b.pref_time || '').slice(0, 12),
         String(b.resume_name || '').slice(0, 160),
         resume, Date.now()]
      );

      // Tell Zahra straight away — a good applicant goes elsewhere if nobody
      // replies for a week.
      try {
        const { notifyInApp, sendEmail } = require('./_notify');
        const when = b.pref_date ? (b.pref_date + (b.pref_time ? ' at ' + b.pref_time : '')) : 'no preference given';
        await notifyInApp('owner', null, 'New application ✦ ' + name,
          (b.experience || 'Experience not stated') + ' · wants to come in ' + when);
        const to = process.env.OWNER_EMAIL || 'zolastudioempire@gmail.com';
        await sendEmail(to, 'New ZOLA application — ' + name,
          `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px">
            <div style="max-width:520px;margin:0 auto;background:#fff;padding:28px 26px;border:1px solid #eee5d8">
              <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:3px;margin-bottom:18px">ZOLA</div>
              <p style="font-size:15px;color:#3a3027;line-height:1.8;margin:0">
                <b>${name}</b> would like to train and work with you.<br>
                ${email ? 'Email: ' + email + '<br>' : ''}${phone ? 'Phone: ' + phone + '<br>' : ''}
                Experience: ${b.experience || '—'}<br>
                Wants to come in: ${when}<br>
                ${b.resume_name ? 'Attached a resume: ' + b.resume_name : 'No resume attached'}
              </p>
              ${b.about ? `<p style="font-size:14px;color:#3a3027;line-height:1.8;border-top:1px solid #eee5d8;padding-top:14px;margin-top:16px">${String(b.about).slice(0, 800)}</p>` : ''}
              <p style="font-size:12px;color:#8C7A5E;margin-top:18px">Open Studio Manager → Applications to see the full application and their resume.</p>
            </div></div>`);
      } catch (_) { /* a notification failure must never lose the application */ }

      return res.json({ ok: true });
    }

    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

    // ── OWNER ──
    // The resume itself is left out of the list so one screen doesn't pull
    // several megabytes; it is fetched per applicant when she opens one.
    if (req.method === 'GET' && !action) {
      const rows = await query(
        `SELECT id, name, email, phone, experience, about, pref_date, pref_time, resume_name,
                (CASE WHEN resume_data IS NULL OR resume_data = '' THEN 0 ELSE 1 END) AS has_resume,
                status, created_ts
           FROM applicants ORDER BY created_ts DESC LIMIT 200`);
      return res.json({ applicants: rows });
    }

    if (req.method === 'GET' && action === 'resume') {
      const id = Number(req.query.id);
      const rows = await query('SELECT resume_name, resume_data FROM applicants WHERE id=?', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json({ name: rows[0].resume_name, data: rows[0].resume_data });
    }

    if (req.method === 'PUT' && action === 'status') {
      const { id, status } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await execute('UPDATE applicants SET status=? WHERE id=?', [String(status || 'new').slice(0, 24), Number(id)]);
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await execute('DELETE FROM applicants WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
