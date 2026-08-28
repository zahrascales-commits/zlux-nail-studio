const { queryOne, query, execute } = require('./_db');

async function authMember(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > CURRENT_TIMESTAMP', [token, 'CLIENT']);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const session = await authMember(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized.' });

    const memberId = session.user_id;

    if (req.method === 'GET') {
      const member      = await queryOne('SELECT * FROM members WHERE member_id = ?', [memberId]);
      const prefs       = await queryOne('SELECT * FROM member_preferences WHERE member_id = ?', [memberId]);
      const history     = await query('SELECT * FROM nail_history WHERE member_id = ? ORDER BY created_at DESC LIMIT 20', [memberId]);
      const upcoming    = await query(`SELECT * FROM appointments WHERE member_id = ? AND status = 'SCHEDULED' AND appointment_date >= date('now') ORDER BY appointment_date ASC LIMIT 5`, [memberId]);
      const announcements = await query(`SELECT * FROM announcements WHERE tier_target = 'ALL' OR tier_target = ? ORDER BY sent_at DESC LIMIT 10`, [member.tier]);
      const messages    = await query(`SELECT * FROM messages WHERE (to_role='CLIENT' AND to_id=?) OR (from_role='CLIENT' AND from_id=?) ORDER BY created_at DESC LIMIT 20`, [memberId, memberId]);

      const monthYear = new Date().toISOString().slice(0, 7);
      const usage = await queryOne('SELECT * FROM service_usage WHERE member_id = ? AND month_year = ?', [memberId, monthYear]);

      return res.status(200).json({
        member: {
          memberId:    member.member_id,
          fullName:    member.full_name,
          email:       member.email,
          phone:       member.phone,
          tier:        member.tier,
          memberSince: member.membership_started_at,
          nextBilling: member.next_billing_at,
          noShowCount: member.no_show_count,
          referralCode: member.referral_code,
        },
        preferences: prefs || {},
        history,
        upcoming,
        announcements,
        messages,
        usage: usage || { services_used: 0, russian_mani_used: 0, scrub_used: 0, birthday_used: 0 },
      });
    }

    if (req.method === 'PUT') {
      const { phone, preferences, full_name, email, date_of_birth } = req.body;

      if (full_name && String(full_name).trim()) {
        await execute('UPDATE members SET full_name = ? WHERE member_id = ?',
          [String(full_name).trim().slice(0, 120), memberId]);
      }

      if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) {
        const clean = String(email).trim().toLowerCase();
        // Somebody else's address would let them take over that account, so
        // the change is refused rather than applied to the wrong person.
        const taken = await queryOne(
          'SELECT member_id FROM members WHERE lower(email)=? AND member_id<>?', [clean, memberId]);
        if (taken) return res.status(400).json({ error: 'That email is already on another membership.' });
        await execute('UPDATE members SET email = ? WHERE member_id = ?', [clean, memberId]);
      }

      // Set once, then fixed. The birthday-month gift is claimed against
      // this date; a field that can be rewritten is a gift that can be
      // claimed as often as somebody edits it.
      if (date_of_birth && /^\d{4}-\d{2}-\d{2}$/.test(String(date_of_birth))) {
        const cur = await queryOne('SELECT date_of_birth FROM members WHERE member_id = ?', [memberId]);
        const already = cur && String(cur.date_of_birth || '').slice(0, 10);
        if (already && /^\d{4}-\d{2}-\d{2}$/.test(already)) {
          return res.status(400).json({ error: 'Your birthday is already saved and cannot be changed. Message the studio if it is wrong.' });
        }
        await execute('UPDATE members SET date_of_birth = ? WHERE member_id = ?',
          [String(date_of_birth), memberId]);
      }

      if (phone) {
        await execute('UPDATE members SET phone = ? WHERE member_id = ?', [phone, memberId]);
      }
      if (preferences) {
        const existing = await queryOne('SELECT id FROM member_preferences WHERE member_id = ?', [memberId]);
        if (existing) {
          await execute(`UPDATE member_preferences SET preferred_shape=?, preferred_length=?, allergies=?, sensitivities=?, notes=?, updated_at=datetime('now') WHERE member_id=?`,
            [preferences.shape||null, preferences.length||null, preferences.allergies||null, preferences.sensitivities||null, preferences.notes||null, memberId]);
        } else {
          await execute('INSERT INTO member_preferences (member_id, preferred_shape, preferred_length, allergies, sensitivities, notes) VALUES (?,?,?,?,?,?)',
            [memberId, preferences.shape||null, preferences.length||null, preferences.allergies||null, preferences.sensitivities||null, preferences.notes||null]);
        }
      }
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Profile error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
