const { getDb } = require('../server/db/init');

function authStaff(db, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")').get(token, 'STAFF') || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const db = getDb();
  try {
    const session = authStaff(db, req);
    if (!session) return res.status(401).json({ error: 'Staff login required.' });

    const staffId = parseInt(session.user_id);
    const staff = db.prepare('SELECT id, name, email, role FROM staff WHERE id = ?').get(staffId);

    // Only their own schedule — can NOT see other staff schedules
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);

    const schedule = db.prepare(`
      SELECT a.id, a.appointment_date, a.appointment_time, a.service, a.status, a.notes,
             m.full_name as client_name, m.tier, mp.allergies, mp.sensitivities
      FROM appointments a
      LEFT JOIN members m ON a.member_id = m.member_id
      LEFT JOIN member_preferences mp ON a.member_id = mp.member_id
      WHERE a.staff_id = ? AND a.appointment_date = ?
      ORDER BY a.appointment_time ASC
    `).all(staffId, targetDate);

    // Upcoming week
    const week = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const count = db.prepare('SELECT COUNT(*) as n FROM appointments WHERE staff_id = ? AND appointment_date = ? AND status = "SCHEDULED"').get(staffId, ds);
      week.push({ date: ds, count: count.n });
    }

    // Messages to/from this staff
    const messages = db.prepare(`
      SELECT * FROM messages
      WHERE (to_role='STAFF' AND to_id=?) OR (from_role='STAFF' AND from_id=?)
      ORDER BY created_at DESC LIMIT 30
    `).all(String(staffId), String(staffId));

    return res.status(200).json({
      staff,
      schedule,
      week,
      messages,
      date: targetDate,
    });
  } finally {
    db.close();
  }
};
