const { getDb } = require('../server/db/init');
const crypto = require('crypto');

function verifyToken(secret, memberId, tier, token) {
  // Accept current window and previous window (10 min grace)
  for (let offset = 0; offset <= 1; offset++) {
    const window = Math.floor(Date.now() / (5 * 60 * 1000)) - offset;
    const payload = `${memberId}:${tier}:${window}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 24).toUpperCase();
    if (expected === token) return true;
  }
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Only staff and admin can verify QR codes
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const db = getDb();
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE token = ? AND (role = ? OR role = ?) AND expires_at > datetime("now")').get(token, 'STAFF', 'ADMIN');
    if (!session) return res.status(401).json({ error: 'Only staff or admin can verify QR codes.' });

    const { qrPayload } = req.body;
    if (!qrPayload) return res.status(400).json({ error: 'QR payload required.' });

    let parsed;
    try { parsed = JSON.parse(qrPayload); }
    catch { return res.status(400).json({ error: 'Invalid QR payload.' }); }

    const { m: memberId, t: tier, k: qrToken, n: name } = parsed;
    const member = db.prepare('SELECT * FROM members WHERE member_id = ?').get(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found.' });

    const valid = verifyToken(member.qr_secret, memberId, tier, qrToken);
    if (!valid) {
      db.prepare('INSERT INTO security_log (event, details) VALUES (?,?)').run('QR_VERIFY_FAILED', JSON.stringify({ memberId }));
      return res.status(401).json({ valid: false, error: 'QR code expired or invalid. Ask member to refresh.' });
    }

    // Fetch today's appointment for this member
    const today = new Date().toISOString().slice(0, 10);
    const appointment = db.prepare(`SELECT * FROM appointments WHERE member_id = ? AND appointment_date = ? AND status = 'SCHEDULED' ORDER BY appointment_time ASC LIMIT 1`).get(memberId, today);
    const prefs = db.prepare('SELECT * FROM member_preferences WHERE member_id = ?').get(memberId);

    return res.status(200).json({
      valid: true,
      member: {
        memberId:  member.member_id,
        fullName:  member.full_name,
        tier:      member.tier,
        noShowCount: member.no_show_count,
        flagged:   !!member.flagged,
      },
      appointment: appointment || null,
      preferences: prefs || {},
    });
  } finally {
    db.close();
  }
};
