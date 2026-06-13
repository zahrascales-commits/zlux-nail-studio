const { getDb } = require('../server/db/init');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { memberId, password } = req.body;
  if (!memberId || !password) return res.status(400).json({ error: 'Member ID and password required.' });

  const db = getDb();
  try {
    const member = db.prepare('SELECT * FROM members WHERE member_id = ?').get(memberId.toUpperCase().trim());

    if (!member || !bcrypt.compareSync(password, member.password_hash)) {
      db.prepare(`INSERT INTO security_log (event, details) VALUES (?,?)`).run('FAILED_MEMBER_LOGIN', JSON.stringify({ memberId }));
      return res.status(401).json({ error: 'Invalid Member ID or password.' });
    }

    if (member.flagged) {
      return res.status(403).json({ error: 'Your account has been flagged. Contact the studio directly.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions (token, role, user_id, expires_at) VALUES (?,?,?,?)').run(token, 'CLIENT', member.member_id, expires);

    db.prepare('INSERT INTO security_log (event, details) VALUES (?,?)').run('MEMBER_LOGIN', JSON.stringify({ memberId: member.member_id }));

    return res.status(200).json({
      token,
      member: {
        memberId:   member.member_id,
        fullName:   member.full_name,
        email:      member.email,
        tier:       member.tier,
        memberSince: member.membership_started_at,
        nextBilling: member.next_billing_at,
        referralCode: member.referral_code,
      }
    });
  } finally {
    db.close();
  }
};
