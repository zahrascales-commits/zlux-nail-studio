const { queryOne, execute } = require('./_db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/* Wrong attempts, per source, in memory. A serverless process forgets these
   when it recycles, which is fine: this is a speed bump for a machine
   grinding through IDs, not an account lockout. */
const WRONG = new Map();

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
      const member = await queryOne('SELECT tier, full_name, date_of_birth FROM members WHERE member_id = ?', [id]);
      if (!member) return res.status(404).json({ error: 'Member not found.' });
      // Birthday month is derived from the date-of-birth set once at signup —
      // never re-entered or editable, so members can't shift it around.
      let birthMonth = null;
      if (member.date_of_birth) {
        const m = String(member.date_of_birth).match(/^(\d{4})-(\d{2})/);
        if (m) birthMonth = parseInt(m[2], 10);
      }
      return res.status(200).json({ valid: true, tier: member.tier, name: member.full_name, birthMonth });
    } catch (err) {
      return res.status(500).json({ error: 'Lookup failed.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: 'Member ID required.' });

  /* A run of wrong IDs from one place. Legitimate clients type theirs once,
     so this is only ever reached by something working through the space. */
  const from = String(
    req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown'
  ).split(',')[0].trim();
  const now = Date.now();
  const recent = (WRONG.get(from) || []).filter(t => now - t < 10 * 60000);
  if (recent.length >= 8) {
    WRONG.set(from, recent);
    return res.status(429).json({
      error: 'Too many tries. Wait a few minutes, or message the studio and we will look you up.',
    });
  }

  try {
    const member = await queryOne('SELECT * FROM members WHERE member_id = ?', [memberId.toUpperCase().trim()]);

    if (!member) {
      recent.push(now);
      WRONG.set(from, recent);
      await execute('INSERT INTO security_log (event, details) VALUES (?,?)', ['FAILED_MEMBER_LOGIN', JSON.stringify({ memberId })]);
      return res.status(401).json({ error: 'Member ID not found. Check your welcome email and try again.' });
    }

    if (Number(member.flagged) === 1) {
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
