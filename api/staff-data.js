const { queryOne, query } = require('./db');

async function authStaff(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")', [token, 'STAFF']);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await authStaff(req);
    if (!session) return res.status(401).json({ error: 'Staff login required.' });

    const staffId = parseInt(session.user_id);
    const staff = await queryOne('SELECT id, name, email, role FROM staff WHERE id = ?', [staffId]);

    const { date } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);

    const schedule = await query(`
      SELECT a.id, a.appointment_date, a.appointment_time, a.service, a.status, a.notes,
             m.full_name as client_name, m.tier, mp.allergies, mp.sensitivities
      FROM appointments a
      LEFT JOIN members m ON a.member_id = m.member_id
      LEFT JOIN member_preferences mp ON a.member_id = mp.member_id
      WHERE a.staff_id = ? AND a.appointment_date = ?
      ORDER BY a.appointment_time ASC
    `, [staffId, targetDate]);

    const week = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const row = await queryOne('SELECT COUNT(*) as n FROM appointments WHERE staff_id = ? AND appointment_date = ? AND status = "SCHEDULED"', [staffId, ds]);
      week.push({ date: ds, count: row ? row.n : 0 });
    }

    const messages = await query(`
      SELECT * FROM messages
      WHERE (to_role='STAFF' AND to_id=?) OR (from_role='STAFF' AND from_id=?)
      ORDER BY created_at DESC LIMIT 30
    `, [String(staffId), String(staffId)]);

    return res.status(200).json({ staff, schedule, week, messages, date: targetDate });
  } catch (err) {
    console.error('Staff data error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
