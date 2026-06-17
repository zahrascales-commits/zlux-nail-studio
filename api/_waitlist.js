const { queryOne, query, execute } = require('./_db');

async function authAdmin(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")', [token, 'ADMIN']);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const adminSession = await authAdmin(req);

    if (req.method === 'POST' && !adminSession) {
      // Public: join waitlist
      const { name, email, phone, tier } = req.body;
      if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
      const validTiers = ['SIGNATURE', 'LUXE', 'BLACK_CARD'];
      const t = validTiers.includes(tier) ? tier : 'BLACK_CARD';

      const existing = await queryOne('SELECT id FROM waitlist WHERE email = ? AND tier = ?', [email.toLowerCase().trim(), t]);
      if (existing) return res.status(409).json({ error: 'Already on the waitlist for this tier.' });

      await execute('INSERT INTO waitlist (name, email, phone, tier) VALUES (?,?,?,?)', [name, email.toLowerCase().trim(), phone||null, t]);

      if (process.env.SENDGRID_API_KEY) {
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        try {
          await sgMail.send({
            to: 'zahrascales@gmail.com',
            from: 'studio@zluxnails.com',
            subject: `New waitlist — ${t} — ${name}`,
            text: `New waitlist signup:\nName: ${name}\nEmail: ${email}\nPhone: ${phone||'none'}\nTier: ${t}`,
          });
        } catch (_) {}
      }

      return res.status(201).json({ success: true, message: `You're on the waitlist. We'll reach out when a ${t.replace('_',' ')} spot opens.` });
    }

    if (!adminSession) return res.status(401).json({ error: 'Unauthorized.' });

    if (req.method === 'GET') {
      const { tier } = req.query;
      const list = tier
        ? await query('SELECT * FROM waitlist WHERE tier=? ORDER BY created_at ASC', [tier])
        : await query('SELECT * FROM waitlist ORDER BY created_at ASC', []);
      return res.status(200).json({ waitlist: list });
    }

    if (req.method === 'PUT') {
      const { id } = req.body;
      const entry = await queryOne('SELECT * FROM waitlist WHERE id=?', [id]);
      if (!entry) return res.status(404).json({ error: 'Not found.' });
      await execute(`UPDATE waitlist SET invited=1, invited_at=datetime('now') WHERE id=?`, [id]);

      if (process.env.SENDGRID_API_KEY) {
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        try {
          await sgMail.send({
            to: entry.email,
            from: 'studio@zluxnails.com',
            subject: `Your Zola spot is ready — ${entry.tier.replace('_',' ')}`,
            html: `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#0D0D0D;"><div style="background:#0D0D0D;padding:1.5rem;text-align:center;"><span style="color:#C4A882;font-size:1.5rem;">ZOLA</span></div><div style="padding:2rem;"><p>Hello ${entry.name},</p><p>A <strong>${entry.tier.replace('_',' ')}</strong> spot is now available. You have 48 hours to claim it.</p><p><a href="https://zolanailstudio.vercel.app/signup.html" style="background:#C4A882;color:#0D0D0D;padding:0.75rem 1.5rem;display:inline-block;font-family:sans-serif;font-weight:600;text-decoration:none;">Claim Your Spot</a></p><p style="color:#8B6A3E;font-size:0.85rem;">If you no longer wish to join, simply ignore this email. — Zola</p></div></div>`,
          });
        } catch (_) {}
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Waitlist error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
