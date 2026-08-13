// Shoppable Instagram grid.
//
// Zahra uploads a photo she posted, then tags what's in it — services, or
// press-on sets. Clients tap the photo, see exactly those products, and go
// straight to booking (services) or checkout (press-ons). The point is that
// a nail photo stops being decoration and becomes the shortest path to a
// booking, so tags are stored with everything needed to render and link a
// product without a second lookup.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const MAX_DATA_URL = 900000; // client-side resized well under this

async function ensure() {
  await ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS ig_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data_url TEXT NOT NULL,
    caption TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_ts INTEGER
  )`);
}

// Tags arrive from the manager UI. Keep only what the storefront renders, and
// cap the list so one post can't bloat a row.
function cleanTags(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.slice(0, 8).map(t => ({
    type: t.type === 'presson' ? 'presson' : 'service',
    name: String(t.name || '').slice(0, 120),
    price: String(t.price || '').slice(0, 20),
    id: t.id != null ? Number(t.id) : null,
  })).filter(t => t.name);
}

function auth(req) {
  return req.headers['x-ceo-password'] === CEO_PASSWORD;
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CEO-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensure();

    // ── PUBLIC: the shoppable grid ──
    if (req.method === 'GET' && (!action || action === 'feed')) {
      const rows = await query(
        'SELECT id, data_url, caption, tags FROM ig_posts WHERE active=1 ORDER BY sort_order, id DESC LIMIT 60'
      );
      return res.json({
        posts: rows.map(r => {
          let tags = [];
          try { tags = JSON.parse(r.tags || '[]'); } catch (_) {}
          return { id: r.id, photo: r.data_url, caption: r.caption || '', tags };
        }),
      });
    }

    if (!auth(req)) return res.status(401).json({ error: 'Unauthorized' });

    // ── OWNER: everything, including hidden posts ──
    if (req.method === 'GET' && action === 'admin') {
      const rows = await query('SELECT * FROM ig_posts ORDER BY sort_order, id DESC');
      // The tag pickers need the live product lists to choose from
      let pressons = [];
      try {
        pressons = await query('SELECT id, name, price_cents FROM presson_products WHERE active=1 ORDER BY name');
      } catch (_) {}
      return res.json({
        posts: rows.map(r => {
          let tags = [];
          try { tags = JSON.parse(r.tags || '[]'); } catch (_) {}
          return { ...r, tags };
        }),
        pressons,
      });
    }

    if (req.method === 'POST' && action === 'add') {
      const { data_url, caption, tags } = req.body || {};
      if (!data_url || !String(data_url).startsWith('data:image/')) {
        return res.status(400).json({ error: 'A photo is required' });
      }
      if (String(data_url).length > MAX_DATA_URL) {
        return res.status(413).json({ error: 'Photo too large — try a smaller one.' });
      }
      // New posts go to the front, matching how a feed reads
      const min = await queryOne('SELECT MIN(sort_order) AS m FROM ig_posts');
      const order = Math.min(0, Number((min && min.m) || 0)) - 1;
      await execute(
        'INSERT INTO ig_posts (data_url, caption, tags, sort_order, active, created_ts) VALUES (?,?,?,?,1,?)',
        [data_url, String(caption || '').slice(0, 300), JSON.stringify(cleanTags(tags)), order, Date.now()]
      );
      return res.json({ ok: true });
    }

    if (req.method === 'PUT' && action === 'update') {
      const { id, caption, tags, active } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const cur = await queryOne('SELECT id FROM ig_posts WHERE id=?', [Number(id)]);
      if (!cur) return res.status(404).json({ error: 'Post not found' });
      if (caption !== undefined) {
        await execute('UPDATE ig_posts SET caption=? WHERE id=?', [String(caption).slice(0, 300), Number(id)]);
      }
      if (tags !== undefined) {
        await execute('UPDATE ig_posts SET tags=? WHERE id=?', [JSON.stringify(cleanTags(tags)), Number(id)]);
      }
      if (active !== undefined) {
        await execute('UPDATE ig_posts SET active=? WHERE id=?', [active ? 1 : 0, Number(id)]);
      }
      return res.json({ ok: true });
    }

    // Move a post one place earlier or later by swapping order with its
    // neighbour, so she can put her best work first without renumbering.
    if (req.method === 'PUT' && action === 'reorder') {
      const { id, dir } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const rows = await query('SELECT id, sort_order FROM ig_posts ORDER BY sort_order, id DESC');
      const i = rows.findIndex(r => Number(r.id) === Number(id));
      const j = i + (dir === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= rows.length) return res.json({ ok: true, moved: false });
      // Positions can start out tied at 0, so write explicit ranks first
      for (let k = 0; k < rows.length; k++) {
        await execute('UPDATE ig_posts SET sort_order=? WHERE id=?', [k, rows[k].id]);
      }
      await execute('UPDATE ig_posts SET sort_order=? WHERE id=?', [j, rows[i].id]);
      await execute('UPDATE ig_posts SET sort_order=? WHERE id=?', [i, rows[j].id]);
      return res.json({ ok: true, moved: true });
    }

    if (req.method === 'DELETE' && action === 'post') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await execute('DELETE FROM ig_posts WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
