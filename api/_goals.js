// Commission goals — the jars.
//
// Each goal is a jar an artist fills. Every unit she puts in is worth a
// fraction of a percentage point, and when the jar is full that whole amount
// unlocks into her commission. Half a jar unlocks nothing: seeing what is
// sitting there unclaimed is the thing that makes anyone finish it, and a
// goal that pays out continuously is just a slower commission rate.
//
// Progress counts itself wherever the studio already knows the answer —
// appointments she has done, money she has brought in, memberships credited
// to her. Everything else (posts, restocking, training) she logs herself, and
// every log is kept with who added it, because a number that decides pay
// should never be something nobody can check.
const teamDb = require('./_team-db');
const { query, queryOne, execute } = teamDb;

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

// Which metrics the studio can count on its own.
const AUTO = ['appointments', 'revenue', 'memberships'];

let _ready = false;
async function ensureGoalTables() {
  if (_ready) return;
  await teamDb.ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS worker_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    title TEXT,
    metric TEXT,
    metric_filter TEXT,
    target REAL,
    pct_per_unit REAL,
    level INTEGER DEFAULT 1,
    period TEXT DEFAULT 'month',
    active INTEGER DEFAULT 1,
    created_ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS goal_progress (
    goal_id INTEGER,
    period_key TEXT,
    manual_count REAL DEFAULT 0,
    PRIMARY KEY (goal_id, period_key)
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS goal_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER,
    member_id INTEGER,
    delta REAL,
    note TEXT,
    added_by TEXT,
    ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS worker_commission (
    member_id INTEGER PRIMARY KEY,
    base_pct REAL DEFAULT 0
  )`);
  // Which artist a membership should be credited to. Null until somebody
  // says — a membership nobody sold is not secretly everyone's.
  try { await execute('ALTER TABLE members ADD COLUMN sold_by INTEGER'); } catch (_) {}
  _ready = true;
}

/* ── PERIODS ────────────────────────────────────────────────────────
   Dates are local. Using UTC here would roll a Californian's month over
   at 5pm on the last day and wipe a jar she had nearly filled.        */
function localParts(d) {
  d = d || new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}
function periodKey(period, when) {
  const p = localParts(when);
  const pad = n => String(n).padStart(2, '0');
  if (period === 'all') return 'all';
  if (period === 'week') {
    const d = when || new Date();
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    // ISO-ish week: Monday start, keyed by the Monday's date.
    const back = (t.getDay() + 6) % 7;
    t.setDate(t.getDate() - back);
    return t.getFullYear() + '-W' + pad(t.getMonth() + 1) + pad(t.getDate());
  }
  return p.y + '-' + pad(p.m);
}
// The date range a period covers, for the automatic counts.
function periodRange(period, when) {
  const pad = n => String(n).padStart(2, '0');
  const d = when || new Date();
  if (period === 'all') return { from: '0000-01-01', to: '9999-12-31' };
  if (period === 'week') {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    const e = new Date(t); e.setDate(e.getDate() + 6);
    const f = x => x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
    return { from: f(t), to: f(e) };
  }
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const f = x => x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
  return { from: f(first), to: f(last) };
}

/* ── COUNTING ───────────────────────────────────────────────────── */

// Everything the studio can work out for itself, in one pass per member.
async function autoCounts(memberId, period) {
  const { from, to } = periodRange(period);
  const out = { appointments: 0, revenue: 0, memberships: 0 };

  let appts = [];
  try {
    appts = await query(
      `SELECT date, time, service FROM team_appointments
        WHERE team_member_id=? AND date>=? AND date<=?
          AND LOWER(COALESCE(status,'scheduled')) NOT IN ('cancelled','no_show')`,
      [Number(memberId), from, to]);
  } catch (_) {}
  out.appointments = appts.length;

  // Money she brought in. The totals live on the booking, not the studio
  // calendar, so they are matched back by date and time.
  if (appts.length) {
    try {
      const main = require('./_db');
      const rows = await main.query(
        `SELECT appointment_date, appointment_time, total_cents, status
           FROM appointments WHERE appointment_date>=? AND appointment_date<=?`, [from, to]);
      const paid = {};
      for (const r of rows) {
        if (String(r.status || '').toUpperCase() === 'CANCELLED') continue;
        paid[r.appointment_date + ' ' + r.appointment_time] = Number(r.total_cents) || 0;
      }
      out.revenue = appts.reduce((s, a) => s + (paid[a.date + ' ' + a.time] || 0), 0);
    } catch (_) {}
  }

  try {
    const rows = await query(
      'SELECT tier, membership_started_at FROM members WHERE sold_by=?', [Number(memberId)]);
    out.memberships = rows.filter(r => {
      const d = String(r.membership_started_at || '').slice(0, 10);
      return d >= from && d <= to;
    }).length;
  } catch (_) {}

  return out;
}

// Memberships can be filtered to one tier — "sell 7 Signature spots" is a
// different goal from "sell 7 memberships".
async function tieredMemberships(memberId, period, tier) {
  if (!tier) return null;
  const { from, to } = periodRange(period);
  try {
    const rows = await query(
      'SELECT tier, membership_started_at FROM members WHERE sold_by=?', [Number(memberId)]);
    return rows.filter(r => {
      const d = String(r.membership_started_at || '').slice(0, 10);
      return d >= from && d <= to && String(r.tier || '').toUpperCase() === String(tier).toUpperCase();
    }).length;
  } catch (_) { return 0; }
}

/* ── THE BOARD ──────────────────────────────────────────────────── */

// Everything one artist sees: her jars, what is unlocked, what is still
// sitting there, and which level she has reached.
async function boardFor(memberId) {
  await ensureGoalTables();
  const goals = await query(
    'SELECT * FROM worker_goals WHERE member_id=? AND active=1 ORDER BY level, id',
    [Number(memberId)]);

  const base = await queryOne('SELECT base_pct FROM worker_commission WHERE member_id=?', [Number(memberId)]);
  const basePct = Number((base && base.base_pct) || 0);

  // Auto counts are per period, so only fetch each period once.
  const autoByPeriod = {};
  const rows = [];

  for (const g of goals) {
    const period = g.period || 'month';
    if (!autoByPeriod[period]) autoByPeriod[period] = await autoCounts(memberId, period);
    const auto = autoByPeriod[period];

    const pk = periodKey(period);
    const prog = await queryOne(
      'SELECT manual_count FROM goal_progress WHERE goal_id=? AND period_key=?', [g.id, pk]);
    const manual = Number((prog && prog.manual_count) || 0);

    let count = manual;
    let counted = 'manual';
    if (g.metric === 'appointments') { count = auto.appointments; counted = 'auto'; }
    else if (g.metric === 'revenue') { count = auto.revenue / 100; counted = 'auto'; }
    else if (g.metric === 'memberships') {
      const t = await tieredMemberships(memberId, period, g.metric_filter);
      count = t === null ? auto.memberships : t;
      counted = 'auto';
    }

    // A jar is always worth exactly one percent. Zahra sets how much each
    // unit contributes; the target is simply how many it takes to fill it,
    // and the jar pays 1% when full — never more, never a fraction more.
    // Letting the jar be worth target x rate meant a typo in either field
    // could quietly hand somebody a nine percent raise.
    const JAR_WORTH = 1;
    const target = Number(g.target) || 0;
    const pct = Number(g.pct_per_unit) || 0;
    const done = target > 0 && count >= target;
    // How full it is, not how much it is worth — the worth is fixed at 1%.
    const fill = target > 0 ? Math.min(1, count / target) : 0;
    const worth = fill * JAR_WORTH;

    rows.push({
      id: g.id,
      title: g.title,
      metric: g.metric,
      metric_filter: g.metric_filter || '',
      counted,
      period,
      period_key: pk,
      level: Number(g.level) || 1,
      target,
      count: Math.round(count * 100) / 100,
      pct_per_unit: pct,
      full_value: JAR_WORTH,
      // What one of these is worth towards filling the jar, as she set it.
      per_unit_pct: pct,
      // What is banked so far, and what actually counts towards her pay.
      accrued_pct: Math.round(worth * 100) / 100,
      unlocked_pct: done ? Math.round(worth * 100) / 100 : 0,
      complete: done,
      progress: fill,
    });
  }

  // A level opens once every jar on the level below is full. Nothing is more
  // motivating than a locked door you can already see through.
  const levels = [...new Set(rows.map(r => r.level))].sort((a, b) => a - b);
  const levelState = {};
  let unlockedSoFar = true;
  for (const lv of levels) {
    const inLevel = rows.filter(r => r.level === lv);
    const allDone = inLevel.every(r => r.complete);
    levelState[lv] = {
      level: lv,
      open: unlockedSoFar,
      goals: inLevel.length,
      done: inLevel.filter(r => r.complete).length,
      value: inLevel.length * JAR_WORTH,
    };
    unlockedSoFar = unlockedSoFar && allDone;
  }
  for (const r of rows) r.locked = !levelState[r.level].open;

  // A locked level's jars cannot pay out, even if somebody filled one early.
  const earned = rows.filter(r => !r.locked).reduce((s, r) => s + r.unlocked_pct, 0);
  const waiting = rows.filter(r => !r.locked && !r.complete).reduce((s, r) => s + r.accrued_pct, 0);

  return {
    base_pct: basePct,
    earned_pct: Math.round(earned * 100) / 100,
    waiting_pct: Math.round(waiting * 100) / 100,
    total_pct: Math.round((basePct + earned) * 100) / 100,
    levels: Object.values(levelState),
    goals: rows,
  };
}

/* ── LOGGING ────────────────────────────────────────────────────── */

async function logProgress(goalId, memberId, delta, note, by) {
  await ensureGoalTables();
  const g = await queryOne('SELECT * FROM worker_goals WHERE id=?', [Number(goalId)]);
  if (!g) return { ok: false, why: 'No such goal' };
  if (Number(g.member_id) !== Number(memberId)) return { ok: false, why: 'Not your goal' };
  if (AUTO.includes(g.metric)) return { ok: false, why: 'This one counts itself.' };

  const pk = periodKey(g.period || 'month');
  await execute(
    `INSERT INTO goal_progress (goal_id, period_key, manual_count) VALUES (?,?,?)
     ON CONFLICT(goal_id, period_key) DO UPDATE SET manual_count = MAX(0, manual_count + ?)`,
    [g.id, pk, Math.max(0, Number(delta) || 0), Number(delta) || 0]);
  await execute(
    'INSERT INTO goal_log (goal_id, member_id, delta, note, added_by, ts) VALUES (?,?,?,?,?,?)',
    [g.id, Number(memberId), Number(delta) || 0, String(note || '').slice(0, 200), String(by || ''), Date.now()]);

  const row = await queryOne('SELECT manual_count FROM goal_progress WHERE goal_id=? AND period_key=?', [g.id, pk]);
  const count = Number((row && row.manual_count) || 0);
  return {
    ok: true,
    count,
    complete: count >= (Number(g.target) || 0),
    why: count >= (Number(g.target) || 0) ? 'Jar full — that percentage is yours.' : 'Logged.',
  };
}

/* ── HTTP ───────────────────────────────────────────────────────── */

function isOwner(req) {
  return req.headers['x-ceo-password'] === CEO_PASSWORD;
}
async function authMember(req) {
  const id = Number(req.headers['x-team-id'] || req.query.member_id || (req.body || {}).member_id);
  const pin = String(req.headers['x-team-pin'] || req.query.pin || (req.body || {}).pin || '');
  if (!id || !pin) return null;
  const row = await queryOne('SELECT id, name FROM team_members WHERE id=? AND pin=? AND active=1', [id, pin]);
  return row || null;
}

module.exports = async function (req, res) {
  const method = req.method.toUpperCase();
  const action = req.query.action || (req.body && req.body.action);
  try {
    await ensureGoalTables();
    const owner = isOwner(req);

    // ── An artist's own board ──
    if (method === 'GET' && action === 'board') {
      const me = owner ? null : await authMember(req);
      const target = owner ? Number(req.query.member_id) : (me && me.id);
      if (!target) return res.status(401).json({ error: 'Not signed in' });
      return res.json(await boardFor(target));
    }

    // ── She logs one herself ──
    if (method === 'POST' && action === 'log') {
      const me = await authMember(req);
      const b = req.body || {};
      if (owner) {
        const r = await logProgress(b.goal_id, b.member_id, b.delta, b.note, 'Zahra');
        return res.json(r);
      }
      if (!me) return res.status(401).json({ error: 'Not signed in' });
      return res.json(await logProgress(b.goal_id, me.id, b.delta, b.note, me.name));
    }

    /* ── Everything below is hers alone: these numbers decide pay. ── */
    if (!owner) return res.status(401).json({ error: 'Unauthorized' });

    if (method === 'GET' && action === 'all') {
      const members = await query('SELECT id, name, color FROM team_members WHERE active=1 ORDER BY name');
      const out = [];
      for (const m of members) out.push({ ...m, board: await boardFor(m.id) });
      return res.json({ members: out });
    }

    if (method === 'POST' && action === 'save') {
      const b = req.body || {};
      const vals = [
        Number(b.member_id), String(b.title || '').slice(0, 120), String(b.metric || 'manual'),
        String(b.metric_filter || ''), Number(b.target) || 0, Number(b.pct_per_unit) || 0,
        Number(b.level) || 1, String(b.period || 'month'),
      ];
      if (b.id) {
        await execute(
          `UPDATE worker_goals SET member_id=?, title=?, metric=?, metric_filter=?, target=?,
             pct_per_unit=?, level=?, period=? WHERE id=?`, [...vals, Number(b.id)]);
        return res.json({ ok: true, id: Number(b.id) });
      }
      const r = await execute(
        `INSERT INTO worker_goals (member_id,title,metric,metric_filter,target,pct_per_unit,level,period,active,created_ts)
         VALUES (?,?,?,?,?,?,?,?,1,?)`, [...vals, Date.now()]);
      return res.json({ ok: true, id: r.lastInsertRowid });
    }

    if (method === 'DELETE' && action === 'goal') {
      await execute('UPDATE worker_goals SET active=0 WHERE id=?', [Number((req.body || {}).id)]);
      return res.json({ ok: true });
    }

    if (method === 'PUT' && action === 'base') {
      const { member_id, base_pct } = req.body || {};
      const pct = Math.max(0, Math.min(100, Number(base_pct) || 0));
      await execute(
        `INSERT INTO worker_commission (member_id, base_pct) VALUES (?,?)
         ON CONFLICT(member_id) DO UPDATE SET base_pct=excluded.base_pct`,
        [Number(member_id), pct]);
      // Same rate, same artist — the payout report reads it from her record.
      try { await execute('ALTER TABLE team_members ADD COLUMN commission_pct REAL DEFAULT 0'); } catch (_) {}
      try { await execute('UPDATE team_members SET commission_pct=? WHERE id=?', [pct, Number(member_id)]); } catch (_) {}
      return res.json({ ok: true });
    }

    // Credit a membership to whoever actually sold it, so the automatic
    // count has something true to count.
    if (method === 'PUT' && action === 'credit_membership') {
      const { member_id, sold_by } = req.body || {};
      await execute('UPDATE members SET sold_by=? WHERE member_id=?',
        [sold_by ? Number(sold_by) : null, String(member_id)]);
      return res.json({ ok: true });
    }

    if (method === 'GET' && action === 'log') {
      const rows = await query(
        `SELECT l.*, g.title FROM goal_log l LEFT JOIN worker_goals g ON g.id=l.goal_id
          WHERE l.member_id=? ORDER BY l.ts DESC LIMIT 60`, [Number(req.query.member_id)]);
      return res.json({ log: rows });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.boardFor = boardFor;
module.exports.ensureGoalTables = ensureGoalTables;
