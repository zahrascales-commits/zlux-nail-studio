const { queryOne, query } = require('./_db');

async function authMember(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne('SELECT * FROM sessions WHERE token=? AND role=? AND expires_at > CURRENT_TIMESTAMP', [token, 'CLIENT']);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const session = await authMember(req);
      if (!session) return res.status(401).json({ error: 'Login required.' });
      const member   = await queryOne('SELECT referral_code FROM members WHERE member_id=?', [session.user_id]);
      const referrals = await query('SELECT * FROM referrals WHERE referrer_member_id=? ORDER BY created_at DESC', [session.user_id]);
      const completed = referrals.filter(r => r.status === 'COMPLETED').length;
      return res.status(200).json({
        referralCode: member?.referral_code,
        referralLink: `https://zola-nail-studio.vercel.app/signup.html?ref=${member?.referral_code}`,
        referrals,
        completed,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Referral error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
