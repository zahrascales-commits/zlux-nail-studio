const { queryOne, query, execute } = require('./_db');

async function authAdmin(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")', [token, 'ADMIN']);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const session = await authAdmin(req);
    if (!session) return res.status(401).json({ error: 'Admin login required.' });

    if (req.method === 'GET') {
      const messages      = await query('SELECT * FROM messages ORDER BY created_at DESC LIMIT 100', []);
      const announcements = await query('SELECT * FROM announcements ORDER BY sent_at DESC LIMIT 30', []);
      const unreadRow     = await queryOne(`SELECT COUNT(*) as n FROM messages WHERE to_role='ADMIN' AND read=0`, []);
      return res.status(200).json({ messages, announcements, unread: unreadRow.n });
    }

    if (req.method === 'POST') {
      const { type, toRole, toId, subject, body, tierTarget } = req.body;

      if (type === 'announcement') {
        await execute('INSERT INTO announcements (tier_target, subject, body) VALUES (?,?,?)', [tierTarget || 'ALL', subject || '', body]);

        if (process.env.SENDGRID_API_KEY) {
          const members = tierTarget === 'ALL'
            ? await query('SELECT email, full_name FROM members', [])
            : await query('SELECT email, full_name FROM members WHERE tier = ?', [tierTarget]);

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
        await execute('INSERT INTO messages (from_role, from_id, to_role, to_id, subject, body) VALUES (?,?,?,?,?,?)',
          ['ADMIN', 'admin', toRole || 'CLIENT', toId, subject || '', body]);
        return res.status(201).json({ success: true });
      }

      if (type === 'read') {
        const { messageId } = req.body;
        await execute('UPDATE messages SET read=1 WHERE id=?', [messageId]);
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'Unknown message type.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Admin messaging error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
