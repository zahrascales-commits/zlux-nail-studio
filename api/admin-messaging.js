const { getDb } = require('../server/db/init');

function authAdmin(db, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")').get(token, 'ADMIN') || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  try {
    const session = authAdmin(db, req);
    if (!session) return res.status(401).json({ error: 'Admin login required.' });

    if (req.method === 'GET') {
      const messages = db.prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT 100`).all();
      const announcements = db.prepare(`SELECT * FROM announcements ORDER BY sent_at DESC LIMIT 30`).all();
      const unread = db.prepare(`SELECT COUNT(*) as n FROM messages WHERE to_role='ADMIN' AND read=0`).get().n;
      return res.status(200).json({ messages, announcements, unread });
    }

    if (req.method === 'POST') {
      const { type, toRole, toId, subject, body, tierTarget } = req.body;

      if (type === 'announcement') {
        // Broadcast to all members of a tier (or ALL)
        db.prepare('INSERT INTO announcements (tier_target, subject, body) VALUES (?,?,?)').run(tierTarget || 'ALL', subject || '', body);

        // Send email to matching members
        if (process.env.SENDGRID_API_KEY) {
          const members = tierTarget === 'ALL'
            ? db.prepare('SELECT email, full_name FROM members').all()
            : db.prepare('SELECT email, full_name FROM members WHERE tier = ?').all(tierTarget);

          const sgMail = require('@sendgrid/mail');
          sgMail.setApiKey(process.env.SENDGRID_API_KEY);
          for (const m of members) {
            try {
              await sgMail.send({
                to: m.email,
                from: 'studio@zluxnails.com',
                subject: subject || 'A message from Z Lux',
                html: `<div style="font-family:Georgia,serif;color:#2C1A0E;max-width:520px;margin:0 auto;padding:2rem;"><div style="background:#2C1A0E;padding:1.5rem;text-align:center;"><span style="color:#C9A55A;font-size:1.5rem;font-family:Georgia,serif;">ZLUX</span></div><div style="padding:2rem;"><p>Hello ${m.full_name.split(' ')[0]},</p><p>${body.replace(/\n/g,'<br>')}</p><p style="color:#A67C52;font-size:0.85rem;margin-top:2rem;">— The Z Lux Studio Team</p></div></div>`,
              });
            } catch (_) {}
          }
        }

        return res.status(201).json({ success: true });
      }

      if (type === 'direct') {
        db.prepare('INSERT INTO messages (from_role, from_id, to_role, to_id, subject, body) VALUES (?,?,?,?,?,?)').run('ADMIN', 'admin', toRole || 'CLIENT', toId, subject || '', body);
        return res.status(201).json({ success: true });
      }

      if (type === 'read') {
        const { messageId } = req.body;
        db.prepare('UPDATE messages SET read=1 WHERE id=?').run(messageId);
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'Unknown message type.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } finally {
    db.close();
  }
};
