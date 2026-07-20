const { queryOne, query, execute } = require('./_db');
const bcrypt = require('bcryptjs');

async function authAdmin(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > CURRENT_TIMESTAMP', [token, 'ADMIN']);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const session = await authAdmin(req);
    if (!session) return res.status(401).json({ error: 'Admin login required.' });

    if (req.method === 'GET') {
      const { search, tier, flagged, limit = 50, offset = 0 } = req.query;
      let sql = 'SELECT m.*, mp.allergies, mp.sensitivities, mp.preferred_shape FROM members m LEFT JOIN member_preferences mp ON m.member_id = mp.member_id WHERE 1=1';
      const params = [];
      if (search) {
        sql += ' AND (m.full_name LIKE ? OR m.email LIKE ? OR m.member_id LIKE ?)';
        const s = `%${search}%`;
        params.push(s, s, s);
      }
      if (tier)  { sql += ' AND m.tier = ?'; params.push(tier); }
      if (flagged === 'true') { sql += ' AND m.flagged = 1'; }
      sql += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));

      const members = await query(sql, params);
      const total   = await queryOne('SELECT COUNT(*) as n FROM members', []);
      return res.status(200).json({ members, total: total.n });
    }

    if (req.method === 'PUT') {
      const { memberId, action, data } = req.body;
      if (!memberId) return res.status(400).json({ error: 'memberId required.' });

      if (action === 'flag') {
        await execute('UPDATE members SET flagged=1, flag_reason=? WHERE member_id=?', [data?.reason || 'Flagged by admin', memberId]);
      } else if (action === 'unflag') {
        await execute('UPDATE members SET flagged=0, flag_reason=NULL WHERE member_id=?', [memberId]);
      } else if (action === 'change_tier') {
        await execute('UPDATE members SET tier=? WHERE member_id=?', [data.tier, memberId]);
      } else if (action === 'reset_password') {
        const hash = bcrypt.hashSync(data.newPassword, 10);
        await execute('UPDATE members SET password_hash=? WHERE member_id=?', [hash, memberId]);
      } else if (action === 'waive_noshow') {
        await execute('UPDATE members SET no_show_count = MAX(0, no_show_count - 1) WHERE member_id=?', [memberId]);
      } else if (action === 'update_profile') {
        const fields = [];
        const vals = [];
        if (data.phone) { fields.push('phone=?'); vals.push(data.phone); }
        if (data.tier)  { fields.push('tier=?');  vals.push(data.tier); }
        if (fields.length) {
          vals.push(memberId);
          await execute(`UPDATE members SET ${fields.join(',')} WHERE member_id=?`, vals);
        }
        if (data.preferences) {
          const pExists = await queryOne('SELECT id FROM member_preferences WHERE member_id=?', [memberId]);
          if (pExists) {
            await execute('UPDATE member_preferences SET allergies=?,sensitivities=?,preferred_shape=?,preferred_length=?,notes=? WHERE member_id=?',
              [data.preferences.allergies||null, data.preferences.sensitivities||null, data.preferences.shape||null, data.preferences.length||null, data.preferences.notes||null, memberId]);
          } else {
            await execute('INSERT INTO member_preferences (member_id,allergies,sensitivities,preferred_shape,preferred_length,notes) VALUES (?,?,?,?,?,?)',
              [memberId, data.preferences.allergies||null, data.preferences.sensitivities||null, data.preferences.shape||null, data.preferences.length||null, data.preferences.notes||null]);
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
      await execute('DELETE FROM members WHERE member_id=?', [memberId]);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Admin members error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
