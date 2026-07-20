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
    const admin = await queryOne('SELECT * FROM admin WHERE email = ?', [email.toLowerCase().trim()]);
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      await execute('INSERT INTO security_log (event, details) VALUES (?,?)', ['FAILED_ADMIN_LOGIN', JSON.stringify({ email, ip: req.headers['x-forwarded-for'] })]);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    await execute('INSERT INTO sessions (token, role, user_id, expires_at) VALUES (?,?,?,?)', [token, 'ADMIN', String(admin.id), expires]);
    await execute('UPDATE admin SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [admin.id]);

    return res.status(200).json({ token, email: admin.email });
  } catch (err) {
    console.error('Admin auth error:', err);
    return res.status(500).json({ error: 'Login failed.' });
  }
};
