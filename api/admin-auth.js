const { getDb } = require('../server/db/init');
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

  const db = getDb();
  try {
    const admin = db.prepare('SELECT * FROM admin WHERE email = ?').get(email.toLowerCase().trim());
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      db.prepare('INSERT INTO security_log (event, details) VALUES (?,?)').run('FAILED_ADMIN_LOGIN', JSON.stringify({ email, ip: req.headers['x-forwarded-for'] }));
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(); // 8 hours
    db.prepare('INSERT INTO sessions (token, role, user_id, expires_at) VALUES (?,?,?,?)').run(token, 'ADMIN', String(admin.id), expires);
    db.prepare('UPDATE admin SET last_login = datetime("now") WHERE id = ?').run(admin.id);

    return res.status(200).json({ token, email: admin.email });
  } finally {
    db.close();
  }
};
