// Black Card nail-health tracker: members log how their nails feel over time
// (a 1–5 rating + a note), so they can watch their nail health improve since
// joining. Same session auth as the member portal; gated to Black Card.
const { queryOne, query, execute } = require('./_db');

let _ready = false;
async function ensure() {
  if (_ready) return;
  await execute(`CREATE TABLE IF NOT EXISTS nail_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  _ready = true;
}

async function authMember(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > CURRENT_TIMESTAMP', [token, 'CLIENT']);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensure();
    const session = await authMember(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized.' });
    const memberId = session.user_id;
    const member = await queryOne('SELECT tier FROM members WHERE member_id = ?', [memberId]);
    const isBlackCard = member && member.tier === 'BLACK_CARD';

    /* ── THE ASSESSMENT ───────────────────────────────────────────
       What state are your nails actually in, and what do we each do
       about it. The plan is rules-based and lives in _nail-plan, so
       the same answers always give the same advice and Zahra can read
       every rule and disagree with any of it. */
    const plan = require('./_nail-plan');
    await plan.ensurePlanTables();

    if (req.method === 'GET' && req.query.action === 'assessment') {
      const rows = await query(
        'SELECT id, answers, score, band, goal, created_ts FROM nail_assessments WHERE member_id = ? ORDER BY created_ts DESC LIMIT 24',
        [memberId]);
      const latest = rows[0] || null;
      let notes = [];
      try {
        notes = await query('SELECT note, author, created_ts FROM nail_notes WHERE member_id = ? ORDER BY created_ts DESC LIMIT 10', [memberId]);
      } catch (_) {}
      return res.json({
        sections: plan.SECTIONS,
        factors: plan.FACTORS,
        context: plan.CONTEXT,
        goals: plan.GOALS,
        red_flags: plan.RED_FLAGS,
        // Everyone can see where they stand; the full programme and the
        // history that shows it working are what Black Card is for.
        full_access: isBlackCard,
        latest: latest ? {
          id: latest.id,
          score: Number(latest.score),
          band: latest.band,
          goal: latest.goal,
          answers: JSON.parse(latest.answers || '{}'),
          created_ts: Number(latest.created_ts),
          plan: plan.buildPlan(JSON.parse(latest.answers || '{}'), latest.goal),
        } : null,
        history: (isBlackCard ? rows : rows.slice(0, 1)).map(function (r) {
          return { id: r.id, score: Number(r.score), band: r.band, created_ts: Number(r.created_ts) };
        }),
        notes: isBlackCard ? notes : [],
      });
    }

    if (req.method === 'POST' && (req.body || {}).action === 'assessment') {
      const answers = (req.body || {}).answers || {};
      const goal = String((req.body || {}).goal || '');
      const built = plan.buildPlan(answers, goal);
      await execute(
        'INSERT INTO nail_assessments (member_id, answers, score, band, goal, created_ts) VALUES (?,?,?,?,?,?)',
        [memberId, JSON.stringify(answers), built.score, built.band, goal, Date.now()]);
      return res.json({ ok: true, score: built.score, band: built.band, plan: built });
    }

    if (req.method === 'GET') {
      const entries = await query('SELECT id, rating, note, created_at FROM nail_health WHERE member_id = ? ORDER BY created_at ASC', [memberId]);
      const first = entries[0], last = entries[entries.length - 1];
      const trend = (first && last && entries.length > 1) ? (last.rating - first.rating) : 0;
      return res.json({ entries, trend, count: entries.length });
    }

    if (req.method === 'POST') {
      if (!isBlackCard) return res.status(403).json({ error: 'Nail-health tracking is a Black Card feature.' });
      const { rating, note } = req.body || {};
      const r = Math.max(1, Math.min(5, Number(rating) || 0));
      if (!r) return res.status(400).json({ error: 'Pick a rating from 1 to 5.' });
      await execute('INSERT INTO nail_health (member_id, rating, note) VALUES (?,?,?)', [memberId, r, String(note || '').slice(0, 400)]);
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      await execute('DELETE FROM nail_health WHERE id = ? AND member_id = ?', [Number(id), memberId]);
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
