// The endpoint behind a client's private link.
//
// Public by necessity — the client is not logged in and has no account —
// so the token is the whole of the authorisation. It returns exactly one
// client's visits and nothing that could be used to enumerate others: no
// ids, no email, no phone, and no money at any point.
const link = require('./_client-link');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // A private page should never be cached by a shared proxy.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action) || '';
  try {
    // ── The client's own view ──
    if (req.method === 'GET' && action === 'visits') {
      const clientId = await link.clientForToken(req.query.k);
      if (!clientId) return res.status(404).json({ error: 'Unknown link' });
      const data = await link.visitsFor(clientId);
      if (!data) return res.status(404).json({ error: 'Unknown link' });
      return res.json(data);
    }

    /* ── Owner only ── */
    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // The link to text somebody.
    if (req.method === 'GET' && action === 'link') {
      const id = Number(req.query.id);
      if (!id) return res.status(400).json({ error: 'Which client?' });
      return res.json({ link: await link.linkFor(id) });
    }

    // Issues a new one and kills the old — for a phone that was lost, or a
    // link that ended up somewhere it should not have.
    if (req.method === 'POST' && action === 'rotate') {
      const id = Number((req.body || {}).id);
      if (!id) return res.status(400).json({ error: 'Which client?' });
      await link.rotate(id);
      return res.json({ ok: true, link: await link.linkFor(id) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
