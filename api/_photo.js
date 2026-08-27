// One photo, as an actual image file.
//
// Site photos were being shipped to every visitor as base64 inside a JSON
// blob containing every other photo too. That is three problems at once: a
// page pulls down every image whether it shows them or not, base64 is a
// third bigger than the bytes it encodes, and a JSON response the browser
// cannot cache as an image is re-downloaded on every single page.
//
// Worst of it was visible: the page painted with no photo, then the fetch
// finished and the photo appeared. That flash is the whole reason this file
// exists.
//
// Now each slot is its own URL returning real image bytes, marked immutable
// and cached for a year. The URL carries the version, so changing a photo
// changes the URL and the new one appears immediately — no cache to clear,
// and no stale picture either.
const { queryOne } = require('./_team-db');

module.exports = async function (req, res) {
  const slot = String(req.query.slot || '').trim().slice(0, 64);
  if (!slot) return res.status(400).json({ error: 'Which slot?' });

  let row = null;
  try {
    row = await queryOne('SELECT data_url, updated_ts FROM site_photos WHERE slot=?', [slot]);
  } catch (_) {}

  if (!row || !row.data_url) {
    // A slot with nothing in it is not an error — a page asks for photos
    // that may never have been uploaded. Say "no content" quietly and let
    // the page keep its own styling.
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(204).end();
  }

  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(row.data_url));
  if (!match) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(204).end();
  }

  const mime = match[1];
  const buf = Buffer.from(match[2], 'base64');
  const tag = '"' + slot + '-' + (Number(row.updated_ts) || 0) + '"';

  // Whoever already has this exact version does not need the bytes again.
  if (req.headers['if-none-match'] === tag) {
    res.setHeader('ETag', tag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(304).end();
  }

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('ETag', tag);
  // Safe to keep for a year because the version is in the URL: a different
  // photo is a different address, so nothing has to expire for it to change.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).end(buf);
};
