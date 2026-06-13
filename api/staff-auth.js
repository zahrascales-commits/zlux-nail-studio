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
    const staff = db.prepare('SELECT * FROM staff WHERE email = ? AND active = 1').get(email.toLowerCase().trim());
    if (!staff || !bcrypt.compareSync(password, staff.password_hash)) {
      db.prepare('INSERT INTO security_log (event, details) VALUES (?,?)').run('FAILED_STAFF_LOGIN', JSON.stringify({ email }));
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); // 12 hours
    db.prepare('INSERT INTO sessions (token, role, user_id, expires_at) VALUES (?,?,?,?)').run(token, 'STAFF', String(staff.id), expires);

    return res.status(200).json({
      token,
      staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role }
    });
  } finally {
    db.close();
  }
};
