const { queryOne, execute } = require('./_db');
const crypto = require('crypto');

function verifyToken(secret, memberId, tier, token) {
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

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  try {
    const session = await queryOne('SELECT * FROM sessions WHERE token = ? AND (role = ? OR role = ?) AND expires_at > CURRENT_TIMESTAMP', [token, 'STAFF', 'ADMIN']);
    if (!session) return res.status(401).json({ error: 'Only staff or admin can verify QR codes.' });

    const { qrPayload } = req.body;
    if (!qrPayload) return res.status(400).json({ error: 'QR payload required.' });

    let parsed;
    try { parsed = JSON.parse(qrPayload); }
    catch { return res.status(400).json({ error: 'Invalid QR payload.' }); }

    const { m: memberId, t: tier, k: qrToken } = parsed;
    const member = await queryOne('SELECT * FROM members WHERE member_id = ?', [memberId]);
    if (!member) return res.status(404).json({ error: 'Member not found.' });

    // Same schema-drift/backfill guard as qr-generate — a client's QR is
    // only ever valid if their secret was already generated for them.
    if (!member.qr_secret) {
      return res.status(409).json({ error: 'Their QR hasn\'t been generated yet — have them open "My QR" in their portal once, then rescan.' });
    }

    const valid = verifyToken(member.qr_secret, memberId, tier, qrToken);
    if (!valid) {
      await execute('INSERT INTO security_log (event, details) VALUES (?,?)', ['QR_VERIFY_FAILED', JSON.stringify({ memberId })]);
      return res.status(401).json({ valid: false, error: 'QR code expired or invalid. Ask member to refresh.' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const appointment = await queryOne(`SELECT * FROM appointments WHERE member_id = ? AND appointment_date = ? AND status = 'SCHEDULED' ORDER BY appointment_time ASC LIMIT 1`, [memberId, today]);
    const prefs = await queryOne('SELECT * FROM member_preferences WHERE member_id = ?', [memberId]);

    return res.status(200).json({
      valid: true,
      member: {
        memberId:   member.member_id,
        fullName:   member.full_name,
        tier:       member.tier,
        noShowCount: member.no_show_count,
        flagged:    !!member.flagged,
      },
      appointment: appointment || null,
      preferences: prefs || {},
    });
  } catch (err) {
    console.error('QR verify error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
