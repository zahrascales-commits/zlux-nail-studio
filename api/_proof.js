// What the website is allowed to say about other people: only what happened.
//
// The homepage used to rotate six notifications typed into the page —
// "Signature Club now 92% full", "4 founding spots remaining" — none of them
// counted, all of them about memberships that are no longer sold. This is
// the replacement: bookings that were actually made (the service and how long
// ago, never who), and reviews a client left at the kiosk and ticked "you can
// share this" on. If there is nothing real to show, the page shows nothing.
const { query, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const DAY = 86400000;

let _ready = false;
async function ensure() {
  await ensureTables();
  if (_ready) return;
  // The kiosk makes this table; these two columns may not be there yet.
  for (const sql of [
    'ALTER TABLE kiosk_log ADD COLUMN share INTEGER DEFAULT 0',
    'ALTER TABLE kiosk_log ADD COLUMN hidden INTEGER DEFAULT 0',
  ]) { try { await execute(sql); } catch (_) {} }
  _ready = true;
}

// team_appointments.created_at is SQLite's UTC "YYYY-MM-DD HH:MM:SS".
const utcMs = t => { const ms = Date.parse(String(t || '').replace(' ', 'T') + 'Z'); return isNaN(ms) ? 0 : ms; };

function ago(ms, now) {
  const h = Math.floor((now - ms) / 3600000);
  if (h < 1) return 'within the hour';
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
}

// "Joanna Martinez" → "Joanna M." — enough to be a person, not enough to find.
function shortName(n) {
  const parts = String(n || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A ZOLA client';
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
  return parts[1] ? first + ' ' + parts[1].charAt(0).toUpperCase() + '.' : first;
}

// The first service of a booking, as the menu names it.
function serviceLabel(s) {
  return String(s || '').split(/\s\+\s|,\s*/)[0].trim().slice(0, 48);
}

// Her own test bookings. (Not a bare "zz" — that would catch Izzy.)
const TEST = /\btest\b|^zz|diagnostic/i;

async function recentBookings(now) {
  const since = new Date(now - 7 * DAY).toISOString().replace('T', ' ').slice(0, 19);
  const rows = await query(
    "SELECT service, client_name, status, created_at FROM team_appointments WHERE created_at >= ? ORDER BY created_at DESC LIMIT 60",
    [since]);
  const real = rows.filter(r =>
    !/^cancel|^no.?show|^delet/i.test(String(r.status || '')) &&
    serviceLabel(r.service) && !TEST.test(String(r.service || '')) && !TEST.test(String(r.client_name || '')));
  return {
    week: real.length,
    recent: real.slice(0, 8).map(r => {
      const ms = utcMs(r.created_at);
      return { service: serviceLabel(r.service), ago: ago(ms, now) };
    }),
  };
}

async function sharedReviews() {
  const rows = await query(
    "SELECT id, name, stars, detail, ts FROM kiosk_log WHERE type='review' AND share=1 AND COALESCE(hidden,0)=0 AND stars >= 4 AND length(trim(detail)) >= 12 ORDER BY ts DESC LIMIT 12");
  return rows.map(r => ({ name: shortName(r.name), stars: Number(r.stars), text: String(r.detail).trim(), ts: Number(r.ts) }));
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const action = req.query.action || (req.body && req.body.action) || '';
  try {
    await ensure();
    const now = Date.now();

    // ── PUBLIC: the homepage's live line and toasts ──
    if (!action) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
      const [b, reviews] = await Promise.all([
        recentBookings(now).catch(() => ({ week: 0, recent: [] })),
        sharedReviews().catch(() => []),
      ]);
      return res.json({ week_bookings: b.week, recent: b.recent, reviews });
    }

    // ── OWNER: every review, and whether it shows on the website ──
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

    if (action === 'reviews') {
      const rows = await query(
        "SELECT id, name, stars, detail, ts, COALESCE(share,0) AS share, COALESCE(hidden,0) AS hidden FROM kiosk_log WHERE type='review' ORDER BY ts DESC LIMIT 80");
      return res.json({
        reviews: rows.map(r => {
          const share = Number(r.share) === 1, hidden = Number(r.hidden) === 1;
          const eligible = share && Number(r.stars) >= 4 && String(r.detail || '').trim().length >= 12;
          return {
            id: Number(r.id), name: r.name, public_name: shortName(r.name), stars: Number(r.stars),
            text: r.detail || '', ts: Number(r.ts), share, hidden,
            on_site: eligible && !hidden,
          };
        }),
      });
    }

    if (action === 'review_hide' && req.method === 'POST') {
      const { id, hidden } = req.body || {};
      await execute("UPDATE kiosk_log SET hidden=? WHERE id=? AND type='review'", [hidden ? 1 : 0, Number(id) || 0]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    if (!action) return res.json({ week_bookings: 0, recent: [], reviews: [] });
    return res.status(500).json({ error: String(err.message || err) });
  }
};
module.exports._test = { ago, shortName, serviceLabel };
