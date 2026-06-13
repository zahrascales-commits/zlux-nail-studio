const { getDb } = require('../server/db/init');
const bcrypt = require('bcryptjs');

function authAdmin(db, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")').get(token, 'ADMIN') || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  try {
    const session = authAdmin(db, req);
    if (!session) return res.status(401).json({ error: 'Admin login required.' });

    if (req.method === 'GET') {
      const { search, tier, flagged, limit = 50, offset = 0 } = req.query;
      let query = 'SELECT m.*, mp.allergies, mp.sensitivities, mp.preferred_shape FROM members m LEFT JOIN member_preferences mp ON m.member_id = mp.member_id WHERE 1=1';
      const params = [];
      if (search) { query += ' AND (m.full_name LIKE ? OR m.email LIKE ? OR m.member_id LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }
      if (tier) { query += ' AND m.tier = ?'; params.push(tier); }
      if (flagged === 'true') { query += ' AND m.flagged = 1'; }
      query += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));

      const members = db.prepare(query).all(...params);
      const total = db.prepare('SELECT COUNT(*) as n FROM members').get();

      return res.status(200).json({ members, total: total.n });
    }

    if (req.method === 'PUT') {
      const { memberId, action, data } = req.body;
      if (!memberId) return res.status(400).json({ error: 'memberId required.' });

      if (action === 'flag') {
        db.prepare('UPDATE members SET flagged=1, flag_reason=? WHERE member_id=?').run(data?.reason || 'Flagged by admin', memberId);
      } else if (action === 'unflag') {
        db.prepare('UPDATE members SET flagged=0, flag_reason=NULL WHERE member_id=?').run(memberId);
      } else if (action === 'change_tier') {
        db.prepare('UPDATE members SET tier=? WHERE member_id=?').run(data.tier, memberId);
      } else if (action === 'reset_password') {
        const hash = bcrypt.hashSync(data.newPassword, 10);
        db.prepare('UPDATE members SET password_hash=? WHERE member_id=?').run(hash, memberId);
      } else if (action === 'waive_noshow') {
        db.prepare('UPDATE members SET no_show_count = MAX(0, no_show_count - 1) WHERE member_id=?').run(memberId);
      } else if (action === 'update_profile') {
        const fields = [];
        const vals = [];
        if (data.phone) { fields.push('phone=?'); vals.push(data.phone); }
        if (data.tier)  { fields.push('tier=?');  vals.push(data.tier); }
        if (fields.length) { vals.push(memberId); db.prepare(`UPDATE members SET ${fields.join(',')} WHERE member_id=?`).run(...vals); }
        if (data.preferences) {
          const pExists = db.prepare('SELECT id FROM member_preferences WHERE member_id=?').get(memberId);
          if (pExists) {
            db.prepare('UPDATE member_preferences SET allergies=?,sensitivities=?,preferred_shape=?,preferred_length=?,notes=? WHERE member_id=?')
              .run(data.preferences.allergies||null, data.preferences.sensitivities||null, data.preferences.shape||null, data.preferences.length||null, data.preferences.notes||null, memberId);
          } else {
            db.prepare('INSERT INTO member_preferences (member_id,allergies,sensitivities,preferred_shape,preferred_length,notes) VALUES (?,?,?,?,?,?)')
              .run(memberId, data.preferences.allergies||null, data.preferences.sensitivities||null, data.preferences.shape||null, data.preferences.length||null, data.preferences.notes||null);
          }
        }
      } else {
        return res.status(400).json({ error: 'Unknown action.' });
      }

      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const { memberId } = req.query;
      if (!memberId) return res.status(400).json({ error: 'memberId required.' });
      db.prepare('DELETE FROM members WHERE member_id=?').run(memberId);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } finally {
    db.close();
  }
};
