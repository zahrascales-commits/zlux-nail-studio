const { queryOne, execute } = require('./_db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  try {
    const staff = await queryOne('SELECT * FROM staff WHERE email = ? AND active = 1', [email.toLowerCase().trim()]);
    if (!staff || !bcrypt.compareSync(password, staff.password_hash)) {
      await execute('INSERT INTO security_log (event, details) VALUES (?,?)', ['FAILED_STAFF_LOGIN', JSON.stringify({ email })]);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    await execute('INSERT INTO sessions (token, role, user_id, expires_at) VALUES (?,?,?,?)', [token, 'STAFF', String(staff.id), expires]);

    return res.status(200).json({
      token,
      staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role }
    });
  } catch (err) {
    console.error('Staff auth error:', err);
    return res.status(500).json({ error: 'Login failed.' });
  }
};
