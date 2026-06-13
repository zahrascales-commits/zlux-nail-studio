const { getDb } = require('../server/db/init');

function authAdmin(db, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")').get(token, 'ADMIN') || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  try {
    const session = authAdmin(db, req);
    if (!session) return res.status(401).json({ error: 'Admin login required.' });

    if (req.method === 'GET') {
      const recent = db.prepare(`
        SELECT ns.*, m.full_name, m.email, m.tier
        FROM no_shows ns
        LEFT JOIN members m ON ns.member_id = m.member_id
        ORDER BY ns.created_at DESC LIMIT 50
      `).all();
      return res.status(200).json({ noShows: recent });
    }

    if (req.method === 'POST') {
      const { memberId, appointmentId, waive, waiveReason } = req.body;
      if (!memberId) return res.status(400).json({ error: 'memberId required.' });

      const date = new Date().toISOString().slice(0, 10);
      db.prepare('INSERT INTO no_shows (member_id, appointment_id, date, waived, waive_reason) VALUES (?,?,?,?,?)')
        .run(memberId, appointmentId||null, date, waive?1:0, waiveReason||null);

      if (!waive) {
        db.prepare('UPDATE members SET no_show_count = no_show_count + 1 WHERE member_id=?').run(memberId);
        // Check if this member has hit 2 no-shows in 6 months
        const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const count = db.prepare('SELECT COUNT(*) as n FROM no_shows WHERE member_id=? AND date >= ? AND waived=0').get(memberId, sixMonthsAgo);
        if (count.n >= 2) {
          db.prepare('UPDATE members SET flagged=1, flag_reason=? WHERE member_id=?').run('2+ no-shows in 6 months — review required', memberId);
          // Notify Zahra
          if (process.env.SENDGRID_API_KEY) {
            const member = db.prepare('SELECT full_name, email FROM members WHERE member_id=?').get(memberId);
            const sgMail = require('@sendgrid/mail');
            sgMail.setApiKey(process.env.SENDGRID_API_KEY);
            try {
              await sgMail.send({
                to: 'zahrascales@gmail.com',
                from: 'studio@zluxnails.com',
                subject: `FLAGGED: ${member?.full_name} — 2+ no-shows`,
                text: `Member ${memberId} (${member?.full_name || 'unknown'}) has been flagged for 2 or more no-shows in the last 6 months. Review in admin dashboard.`,
              });
            } catch (_) {}
          }
        }
      }

      return res.status(201).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } finally {
    db.close();
  }
};
