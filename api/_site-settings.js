// Site settings: owner-editable content the public pages read at load —
// ticker facts, spots remaining, announcement banner. Lets Zahra change
// day-to-day site content from her Studio Manager without a code deploy.
const { query, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureTables();

    // Public: read all settings (homepage applies them)
    if (req.method === 'GET') {
      const rows = await query('SELECT key, value FROM site_settings');
      const out = {};
      for (const r of rows) out[r.key] = r.value;
      return res.json({ settings: out });
    }

    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

    // Owner: upsert settings { settings: { key: value, ... } }
    if (req.method === 'PUT') {
      const { settings } = req.body || {};
      if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings object required' });
      for (const [k, v] of Object.entries(settings)) {
        await execute(
          'INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          [String(k).slice(0, 60), String(v == null ? '' : v).slice(0, 4000)]
        );
      }
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
