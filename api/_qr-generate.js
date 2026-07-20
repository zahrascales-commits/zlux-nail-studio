const { queryOne, execute } = require('./_db');
const crypto = require('crypto');

async function getSession(token) {
  if (!token) return null;
  return queryOne('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > CURRENT_TIMESTAMP', [token, 'CLIENT']);
}

// Self-heal a production DB where the `members` table predates the
// qr_secret column (CREATE TABLE IF NOT EXISTS never re-applies new
// columns to an already-existing table). Idempotent — safe to call
// every request; the ALTER is a silent no-op once the column exists.
async function ensureQrSecretColumn() {
  try { await execute("ALTER TABLE members ADD COLUMN qr_secret TEXT"); } catch (_) {}
}

function generateToken(secret, memberId, tier) {
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
  try {
    const session = await getSession(token);
    if (!session) return res.status(401).json({ error: 'Unauthorized.' });

    let member;
    try {
      member = await queryOne('SELECT member_id, full_name, tier, qr_secret FROM members WHERE member_id = ?', [session.user_id]);
    } catch (colErr) {
      // "no such column: qr_secret" on a table that predates it — add it and retry once
      await ensureQrSecretColumn();
      member = await queryOne('SELECT member_id, full_name, tier, qr_secret FROM members WHERE member_id = ?', [session.user_id]);
    }
    if (!member) return res.status(404).json({ error: 'Member not found.' });

    // Backfill a secret for members created before this column existed,
    // or whose secret is otherwise missing.
    if (!member.qr_secret) {
      member.qr_secret = crypto.randomBytes(20).toString('hex');
      await execute('UPDATE members SET qr_secret = ? WHERE member_id = ?', [member.qr_secret, member.member_id]);
    }

    const qrToken = generateToken(member.qr_secret, member.member_id, member.tier);
    const expiresAt = new Date((Math.floor(Date.now() / (5 * 60 * 1000)) + 1) * 5 * 60 * 1000).toISOString();

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
  } catch (err) {
    console.error('QR generate error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
