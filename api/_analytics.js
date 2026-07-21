// Site traffic analytics: how many people visit, which page they were on
// when they left the site, and how far down each page people tend to
// scroll before stopping. All tracked first-party (no external service).
const { query, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const MAX_PATH = 200;

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensureTables();

    // ── PUBLIC: fired once per page load ──
    if (req.method === 'POST' && action === 'pageview') {
      const { session_id, path, referrer } = req.body || {};
      if (!session_id || !path) return res.status(400).json({ error: 'session_id and path required' });
      await execute('INSERT INTO analytics_pageviews (session_id, path, referrer, ts) VALUES (?,?,?,?)',
        [String(session_id).slice(0, 64), String(path).slice(0, MAX_PATH), String(referrer || '').slice(0, 300), Date.now()]);
      return res.json({ ok: true });
    }

    // ── PUBLIC: fired when a page is hidden/closed (navigator.sendBeacon) ──
    if (req.method === 'POST' && action === 'exit') {
      const { session_id, path, max_scroll_pct, time_on_page_ms } = req.body || {};
      if (!session_id || !path) return res.status(400).json({ error: 'session_id and path required' });
      await execute('INSERT INTO analytics_exits (session_id, path, max_scroll_pct, time_on_page_ms, ts) VALUES (?,?,?,?,?)',
        [String(session_id).slice(0, 64), String(path).slice(0, MAX_PATH),
         Math.max(0, Math.min(100, Number(max_scroll_pct) || 0)), Math.max(0, Number(time_on_page_ms) || 0), Date.now()]);
      return res.json({ ok: true });
    }

    // ── OWNER: the dashboard summary ──
    if (req.method === 'GET' && action === 'summary') {
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
      const since = Date.now() - days * 86400000;

      const views = await query('SELECT session_id, path, ts FROM analytics_pageviews WHERE ts >= ? ORDER BY ts', [since]);
      const exits = await query('SELECT session_id, path, max_scroll_pct, time_on_page_ms FROM analytics_exits WHERE ts >= ?', [since]);

      const uniqueSessions = new Set(views.map(v => v.session_id));

      // Views per page (popularity)
      const viewsByPage = {};
      for (const v of views) viewsByPage[v.path] = (viewsByPage[v.path] || 0) + 1;

      // Last page viewed per session = where they left the SITE
      const lastPageBySession = {};
      for (const v of views) {
        const cur = lastPageBySession[v.session_id];
        if (!cur || v.ts > cur.ts) lastPageBySession[v.session_id] = { path: v.path, ts: v.ts };
      }
      const exitCountByPage = {};
      for (const s of Object.values(lastPageBySession)) exitCountByPage[s.path] = (exitCountByPage[s.path] || 0) + 1;

      // Average max-scroll-depth per page (where people stop scrolling)
      const scrollAgg = {};
      for (const e of exits) {
        const a = scrollAgg[e.path] || { total: 0, count: 0 };
        a.total += Number(e.max_scroll_pct) || 0;
        a.count += 1;
        scrollAgg[e.path] = a;
      }
      const scrollByPage = Object.entries(scrollAgg)
        .map(([path, a]) => ({ path, avg_scroll_pct: Math.round(a.total / a.count), samples: a.count }))
        .sort((a, b) => a.avg_scroll_pct - b.avg_scroll_pct);

      const topPages = Object.entries(viewsByPage).map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count);
      const topExitPages = Object.entries(exitCountByPage).map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count);

      return res.json({
        days,
        total_pageviews: views.length,
        unique_visits: uniqueSessions.size,
        top_pages: topPages,
        top_exit_pages: topExitPages,
        scroll_by_page: scrollByPage,
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
