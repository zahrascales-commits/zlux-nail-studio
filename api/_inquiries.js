// Inquiries: public POST from the contact form / chatbot lead capture,
// owner-only list + status management. Turso-backed so nothing is lost.
const { query, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureTables();

    // Public: submit an inquiry
    if (req.method === 'POST') {
      const { name, contact, message, source } = req.body || {};
      if (!message || !String(message).trim()) return res.status(400).json({ error: 'message required' });
      await execute(
        'INSERT INTO inquiries (name, contact, message, source, status, ts) VALUES (?,?,?,?,?,?)',
        [String(name || '').slice(0, 120), String(contact || '').slice(0, 160),
         String(message).slice(0, 2000), String(source || 'contact').slice(0, 40), 'new', Date.now()]
      );
      return res.json({ ok: true });
    }

    // Owner-only below
    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'GET') {
      const rows = await query('SELECT * FROM inquiries ORDER BY ts DESC LIMIT 200');
      return res.json({ inquiries: rows });
    }

    if (req.method === 'PUT') {
      const { id, status } = req.body || {};
      await execute('UPDATE inquiries SET status=? WHERE id=?', [String(status || 'new'), Number(id)]);
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      await execute('DELETE FROM inquiries WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
