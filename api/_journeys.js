// Nail journeys — the same hands, months apart, side by side.
//
// A before-and-after nobody can argue with does more for this studio than
// any claim on a services page, because the client in the photo started
// where the person reading it is standing right now.
//
// Photos are data-URLs in Turso, the same way site photos already work:
// resized on the client before upload so rows stay small, and no second
// storage service to keep alive.
//
// Consent is a column, not a convention. A journey is invisible on the
// public page until it is explicitly published, and any client can have
// theirs taken down by asking — so the switch has to exist in one place.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const MAX_DATA_URL = 900000; // ~900KB, matching site photos

let _ready = false;
async function ensure() {
  await ensureTables();
  if (_ready) return;
  await execute(`CREATE TABLE IF NOT EXISTS journeys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,                    -- what to call it publicly
    client_name TEXT DEFAULT '',   -- internal; never sent to the public route
    story TEXT DEFAULT '',         -- a line or two in her words
    published INTEGER DEFAULT 0,   -- consent, explicit
    sort_order INTEGER DEFAULT 0,
    created_ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS journey_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    journey_id INTEGER,
    caption TEXT DEFAULT '',
    taken_on TEXT DEFAULT '',      -- YYYY-MM-DD, so the gap is real
    data_url TEXT,
    sort_order INTEGER DEFAULT 0,
    ts INTEGER
  )`);
  _ready = true;
}

const owner = req => req.headers['x-ceo-password'] === CEO_PASSWORD;

// How far apart the first and last photo are. The whole point of a journey
// is the elapsed time, so it is computed once here rather than left to
// three different pages to work out differently.
function span(steps) {
  const dates = steps.map(s => String(s.taken_on || '')).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (dates.length < 2) return '';
  const a = new Date(dates[0] + 'T12:00:00'), b = new Date(dates[dates.length - 1] + 'T12:00:00');
  if (isNaN(a) || isNaN(b)) return '';
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) months -= 1;
  if (months >= 12) {
    const y = Math.floor(months / 12), rem = months % 12;
    return y + (y === 1 ? ' year' : ' years') + (rem ? ' ' + rem + ' month' + (rem === 1 ? '' : 's') : '');
  }
  if (months >= 1) return months + (months === 1 ? ' month' : ' months');
  const days = Math.round((b - a) / 86400000);
  return days > 0 ? days + (days === 1 ? ' day' : ' days') : '';
}

async function load(publishedOnly) {
  const rows = await query(
    'SELECT * FROM journeys' + (publishedOnly ? ' WHERE published=1' : '') + ' ORDER BY sort_order, id DESC');
  if (!rows.length) return [];
  const steps = await query('SELECT * FROM journey_steps ORDER BY sort_order, taken_on, id');
  const byJourney = {};
  for (const s of steps) (byJourney[Number(s.journey_id)] = byJourney[Number(s.journey_id)] || []).push(s);

  return rows.map(j => {
    const mine = byJourney[Number(j.id)] || [];
    return {
      id: Number(j.id),
      title: j.title || 'A ZOLA journey',
      story: j.story || '',
      published: !!Number(j.published),
      span: span(mine),
      // The client's name stays on the owner's side of the wall. A journey
      // is published with a title she chose, not with somebody's full name
      // attached to photographs of their hands.
      ...(publishedOnly ? {} : { client_name: j.client_name || '' }),
      steps: mine.map(s => ({
        id: Number(s.id),
        caption: s.caption || '',
        taken_on: s.taken_on || '',
        data_url: s.data_url,
      })),
    };
  }).filter(j => !publishedOnly || j.steps.length >= 2);
  // A "journey" with one photo is a photo. It stays private until there is
  // something to compare it to.
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensure();

    // ── PUBLIC: what the website shows ──
    if (req.method === 'GET' && !owner(req)) {
      return res.json({ journeys: await load(true) });
    }

    if (req.method === 'GET') {
      return res.json({ journeys: await load(false) });
    }

    if (!owner(req)) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'POST' && action === 'create') {
      const { title, client_name, story } = req.body || {};
      const r = await execute(
        'INSERT INTO journeys (title, client_name, story, published, sort_order, created_ts) VALUES (?,?,?,0,0,?)',
        [String(title || '').slice(0, 120) || 'A ZOLA journey',
         String(client_name || '').slice(0, 120),
         String(story || '').slice(0, 800), Date.now()]);
      return res.json({ ok: true, id: Number(r.lastInsertRowid) || null });
    }

    if (req.method === 'POST' && action === 'update') {
      const { id, title, client_name, story, published, sort_order } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Which journey?' });
      await execute(
        'UPDATE journeys SET title=?, client_name=?, story=?, published=?, sort_order=? WHERE id=?',
        [String(title || '').slice(0, 120) || 'A ZOLA journey',
         String(client_name || '').slice(0, 120),
         String(story || '').slice(0, 800),
         published ? 1 : 0, Number(sort_order) || 0, Number(id)]);
      return res.json({ ok: true });
    }

    if (req.method === 'POST' && action === 'add_step') {
      const { journey_id, caption, taken_on, data_url } = req.body || {};
      if (!journey_id) return res.status(400).json({ error: 'Which journey?' });
      if (!data_url || !String(data_url).startsWith('data:image/')) {
        return res.status(400).json({ error: 'A photo is required.' });
      }
      if (String(data_url).length > MAX_DATA_URL) {
        return res.status(413).json({ error: 'That photo is too large — try again, it compresses automatically.' });
      }
      // Ordered by the date the photo was taken, so a photo added out of
      // order still lands in the right place in the story.
      await execute(
        'INSERT INTO journey_steps (journey_id, caption, taken_on, data_url, sort_order, ts) VALUES (?,?,?,?,?,?)',
        [Number(journey_id), String(caption || '').slice(0, 200),
         String(taken_on || '').slice(0, 10), data_url, 0, Date.now()]);
      return res.json({ ok: true });
    }

    if (req.method === 'POST' && action === 'delete_step') {
      const { id } = req.body || {};
      await execute('DELETE FROM journey_steps WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Which journey?' });
      await execute('DELETE FROM journey_steps WHERE journey_id=?', [Number(id)]);
      await execute('DELETE FROM journeys WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
