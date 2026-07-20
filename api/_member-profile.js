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
      const { phone, preferences } = req.body;
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
