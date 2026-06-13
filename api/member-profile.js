const { getDb } = require('../server/db/init');

function authMember(db, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")').get(token, 'CLIENT');
  return session || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  try {
    const session = authMember(db, req);
    if (!session) return res.status(401).json({ error: 'Unauthorized.' });

    const memberId = session.user_id;

    if (req.method === 'GET') {
      const member = db.prepare('SELECT * FROM members WHERE member_id = ?').get(memberId);
      const prefs  = db.prepare('SELECT * FROM member_preferences WHERE member_id = ?').get(memberId);
      const history = db.prepare('SELECT * FROM nail_history WHERE member_id = ? ORDER BY created_at DESC LIMIT 20').all(memberId);
      const upcoming = db.prepare(`SELECT * FROM appointments WHERE member_id = ? AND status = 'SCHEDULED' AND appointment_date >= date('now') ORDER BY appointment_date ASC LIMIT 5`).all(memberId);
      const announcements = db.prepare(`SELECT * FROM announcements WHERE tier_target = 'ALL' OR tier_target = ? ORDER BY sent_at DESC LIMIT 10`).all(member.tier);
      const messages = db.prepare(`SELECT * FROM messages WHERE (to_role='CLIENT' AND to_id=?) OR (from_role='CLIENT' AND from_id=?) ORDER BY created_at DESC LIMIT 20`).all(memberId, memberId);

      const now = new Date();
      const monthYear = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
      const usage = db.prepare('SELECT * FROM service_usage WHERE member_id = ? AND month_year = ?').get(memberId, monthYear);

      return res.status(200).json({
        member: {
          memberId:   member.member_id,
          fullName:   member.full_name,
          email:      member.email,
          phone:      member.phone,
          tier:       member.tier,
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
        db.prepare('UPDATE members SET phone = ? WHERE member_id = ?').run(phone, memberId);
      }
      if (preferences) {
        const existing = db.prepare('SELECT id FROM member_preferences WHERE member_id = ?').get(memberId);
        if (existing) {
          db.prepare(`UPDATE member_preferences SET preferred_shape=?, preferred_length=?, allergies=?, sensitivities=?, notes=?, updated_at=datetime('now') WHERE member_id=?`)
            .run(preferences.shape||null, preferences.length||null, preferences.allergies||null, preferences.sensitivities||null, preferences.notes||null, memberId);
        } else {
          db.prepare('INSERT INTO member_preferences (member_id, preferred_shape, preferred_length, allergies, sensitivities, notes) VALUES (?,?,?,?,?,?)')
            .run(memberId, preferences.shape||null, preferences.length||null, preferences.allergies||null, preferences.sensitivities||null, preferences.notes||null);
        }
      }
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } finally {
    db.close();
  }
};
