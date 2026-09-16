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

    // Public: read all settings (homepage applies them).
    // SECURITY: provider credentials (twilio_*, resend_*) are never
    // returned here — they are write-only via the owner's Settings tab.
    //
    // Matched anywhere in the name, not just at the start. The old rule only
    // caught three prefixes, and stripe_secret, stripe_webhook_secret and
    // vapid_private walked straight past it onto a public page.
    if (req.method === 'GET') {
      const NEVER_SENT = /(secret|private|token|password|passcode|webhook|api_?key|_key$|_sid$|^twilio_|^resend_|^anthropic|^openai)/i;
      const OWNER_ONLY = /(phone|email)/i;
      const isOwner = req.headers['x-ceo-password'] === CEO_PASSWORD;
      const rows = await query('SELECT key, value FROM site_settings');
      const out = {};
      for (const r of rows) {
        if (NEVER_SENT.test(r.key)) continue;
        if (!isOwner && OWNER_ONLY.test(r.key)) continue;
        out[r.key] = r.value;
      }
      res.setHeader('Cache-Control', 'no-store');
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
