const { getDb } = require('../server/db/init');

function authMember(db, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token=? AND role=? AND expires_at > datetime("now")').get(token, 'CLIENT') || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  try {
    if (req.method === 'GET') {
      const session = authMember(db, req);
      if (!session) return res.status(401).json({ error: 'Login required.' });
      const member = db.prepare('SELECT referral_code FROM members WHERE member_id=?').get(session.user_id);
      const referrals = db.prepare('SELECT * FROM referrals WHERE referrer_member_id=? ORDER BY created_at DESC').all(session.user_id);
      const completed = referrals.filter(r => r.status === 'COMPLETED').length;
      return res.status(200).json({
        referralCode: member?.referral_code,
        referralLink: `https://zluxnailstudio.vercel.app/signup.html?ref=${member?.referral_code}`,
        referrals,
        completed,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } finally {
    db.close();
  }
};
