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

  // Where it came from, for the wrong-guess count further down.
  const from = String(
    req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown'
  ).split(',')[0].trim().slice(0, 60);

  try {
    const member = await queryOne('SELECT * FROM members WHERE member_id = ?', [memberId.toUpperCase().trim()]);

    if (!member) {
      await execute('INSERT INTO security_log (event, details) VALUES (?,?)',
        ['FAILED_MEMBER_LOGIN', JSON.stringify({ memberId, ip: from })]);

      /* Only a wrong ID is ever made to wait. Checking this before looking
         the ID up meant a real member could be turned away because somebody
         on the same wifi had been guessing — and on a phone network that is
         thousands of strangers sharing one address.

         Counted from security_log because on serverless an in-memory tally
         is empty on nearly every request and stops nothing. */
      try {
        const row = await queryOne(
          `SELECT COUNT(*) AS n FROM security_log
            WHERE event = 'FAILED_MEMBER_LOGIN'
              AND details LIKE ?
              AND created_at > datetime('now', '-10 minutes')`,
          ['%"ip":"' + from + '"%']);
        if (Number((row || {}).n) >= 8) {
          return res.status(429).json({
            error: 'That is a lot of tries. Give it a few minutes, or message the studio and we will look you up.',
          });
        }
      } catch (_) { /* unreadable count must not become a lockout */ }

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
