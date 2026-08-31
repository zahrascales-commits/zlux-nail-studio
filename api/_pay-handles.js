// Where a client can send money that is not a card.
//
// Public on purpose — the front-desk screen is not signed in, and a Venmo
// handle is something the studio wants on a poster anyway. Only the three
// handles are ever returned; nothing else in site_settings is exposed.
const { query } = require('./_team-db');

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const rows = await query(
      "SELECT key, value FROM site_settings WHERE key IN ('venmo_handle','cashapp_tag','applepay_phone')");
    const out = {};
    for (const r of rows) out[r.key] = r.value || '';
    return res.json({
      venmo_handle: out.venmo_handle || '',
      cashapp_tag: out.cashapp_tag || '',
      applepay_phone: out.applepay_phone || '',
    });
  } catch (_) {
    // A till that cannot read these should still take cards and cash.
    return res.json({ venmo_handle: '', cashapp_tag: '', applepay_phone: '' });
  }
};
