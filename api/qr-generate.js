const { getDb } = require('../server/db/init');
const crypto = require('crypto');

function getSession(db, token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")').get(token, 'CLIENT') || null;
}

function generateToken(secret, memberId, tier) {
  // Time-based token: changes every 5 minutes
  const window = Math.floor(Date.now() / (5 * 60 * 1000));
  const payload = `${memberId}:${tier}:${window}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 24).toUpperCase();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const db = getDb();
  try {
    const session = getSession(db, token);
    if (!session) return res.status(401).json({ error: 'Unauthorized.' });

    const member = db.prepare('SELECT member_id, full_name, tier, qr_secret FROM members WHERE member_id = ?').get(session.user_id);
    if (!member) return res.status(404).json({ error: 'Member not found.' });

    const qrToken = generateToken(member.qr_secret, member.member_id, member.tier);
    const expiresAt = new Date((Math.floor(Date.now() / (5 * 60 * 1000)) + 1) * 5 * 60 * 1000).toISOString();

    // QR payload: compact JSON encoded in QR
    const qrPayload = JSON.stringify({
      m: member.member_id,
      t: member.tier,
      k: qrToken,
      n: member.full_name,
    });

    return res.status(200).json({
      memberId:   member.member_id,
      fullName:   member.full_name,
      tier:       member.tier,
      qrToken,
      qrPayload,
      expiresAt,
      refreshInMs: Math.max(0, new Date(expiresAt) - Date.now()),
    });
  } finally {
    db.close();
  }
};
