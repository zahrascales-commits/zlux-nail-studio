const { queryOne, execute } = require('./_db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Public tier lookup — used by booking page to validate member ID
  if (req.method === 'GET') {
    const id = (req.query.id || '').toUpperCase().trim();
    if (!id) return res.status(400).json({ error: 'Member ID required.' });
    try {
      const member = await queryOne('SELECT tier, full_name FROM members WHERE member_id = ?', [id]);
      if (!member) return res.status(404).json({ error: 'Member not found.' });
      return res.status(200).json({ valid: true, tier: member.tier, name: member.full_name });
    } catch (err) {
      return res.status(500).json({ error: 'Lookup failed.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { memberId, password } = req.body;
  if (!memberId || !password) return res.status(400).json({ error: 'Member ID and password required.' });

  try {
    const member = await queryOne('SELECT * FROM members WHERE member_id = ?', [memberId.toUpperCase().trim()]);

    if (!member || !bcrypt.compareSync(password, member.password_hash)) {
      await execute('INSERT INTO security_log (event, details) VALUES (?,?)', ['FAILED_MEMBER_LOGIN', JSON.stringify({ memberId })]);
      return res.status(401).json({ error: 'Invalid Member ID or password.' });
    }

    if (member.flagged) {
      return res.status(403).json({ error: 'Your account has been flagged. Contact the studio directly.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await execute('INSERT INTO sessions (token, role, user_id, expires_at) VALUES (?,?,?,?)', [token, 'CLIENT', member.member_id, expires]);
    await execute('INSERT INTO security_log (event, details) VALUES (?,?)', ['MEMBER_LOGIN', JSON.stringify({ memberId: member.member_id })]);

    return res.status(200).json({
      token,
      member: {
        memberId:    member.member_id,
        fullName:    member.full_name,
        email:       member.email,
        tier:        member.tier,
        memberSince: member.membership_started_at,
        nextBilling: member.next_billing_at,
        referralCode: member.referral_code,
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login failed.' });
  }
};
