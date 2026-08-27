// The first N people to join get a bit extra off.
//
// She sets how many and how much, can raise the cap when the first run sells
// out, and can switch it off. The count is kept server-side and claimed as
// part of the signup, because a limit the browser enforces is not a limit —
// two people signing up in the same minute would both be told they were
// number ten.
//
// Everything here answers one question honestly: is there a place left, and
// if so, what is it worth. A discount that has run out has to say so before
// somebody has been promised it, not after they have paid.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

async function ensure() {
  await ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS earlybird (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active INTEGER DEFAULT 0,
    seats INTEGER DEFAULT 10,        -- how many people can get it
    amount_cents INTEGER DEFAULT 1000,
    label TEXT DEFAULT 'Founding Ten',
    updated_ts INTEGER
  )`);
  // Who has taken one. A row per claim, so the count cannot drift from
  // reality and she can see exactly who got what.
  await execute(`CREATE TABLE IF NOT EXISTS earlybird_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT,
    name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    tier TEXT DEFAULT '',
    billing TEXT DEFAULT '',
    amount_cents INTEGER DEFAULT 0,
    seat_number INTEGER DEFAULT 0,
    ts INTEGER
  )`);
  const row = await queryOne('SELECT id FROM earlybird WHERE id=1').catch(() => null);
  if (!row) {
    await execute(
      'INSERT OR IGNORE INTO earlybird (id, active, seats, amount_cents, label, updated_ts) VALUES (1,0,10,1000,?,?)',
      ['Founding Ten', Date.now()]);
  }
}

async function state() {
  await ensure();
  const cfg = await queryOne('SELECT * FROM earlybird WHERE id=1');
  const c = await queryOne('SELECT COUNT(*) AS n FROM earlybird_claims');
  const claimed = Number((c || {}).n) || 0;
  const seats = Number((cfg || {}).seats) || 0;
  const amount = Number((cfg || {}).amount_cents) || 0;
  const active = !!Number((cfg || {}).active);
  return {
    active,
    seats,
    claimed,
    remaining: Math.max(0, seats - claimed),
    amount_cents: amount,
    label: (cfg && cfg.label) || 'Founding Ten',
    // The only thing callers should branch on. Off, full, or nothing set —
    // all three mean the same thing at checkout, and collapsing them here
    // stops three screens each deciding it differently.
    available: active && amount > 0 && claimed < seats,
  };
}

// Take a seat, if there is one. Returns what was actually given, which is
// what the confirmation should say — never what was hoped for.
async function claim({ member_id, name, email, tier, billing }) {
  await ensure();
  const s = await state();
  if (!s.available) return { claimed: false, amount_cents: 0, seat_number: 0 };

  // Somebody who already has one does not get a second.
  if (member_id) {
    const dupe = await queryOne('SELECT id FROM earlybird_claims WHERE member_id=?', [String(member_id)]).catch(() => null);
    if (dupe) return { claimed: false, amount_cents: 0, seat_number: 0, why: 'already claimed' };
  }

  await execute(
    `INSERT INTO earlybird_claims (member_id, name, email, tier, billing, amount_cents, seat_number, ts)
     VALUES (?,?,?,?,?,?,?,?)`,
    [String(member_id || ''), String(name || '').slice(0, 120), String(email || '').slice(0, 160),
     String(tier || ''), String(billing || ''), s.amount_cents, s.claimed + 1, Date.now()]);

  // Re-read rather than trust the number we started with. Two signups in the
  // same second both pass the check above; the count afterwards is the truth,
  // and if it went past the cap the later one is refunded on her side rather
  // than silently over-selling.
  const after = await queryOne('SELECT COUNT(*) AS n FROM earlybird_claims');
  const seat = Number((after || {}).n) || (s.claimed + 1);

  return { claimed: true, amount_cents: s.amount_cents, seat_number: seat, label: s.label, over: seat > s.seats };
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensure();

    // ── PUBLIC: is there a seat left, and what is it worth ──
    if (req.method === 'GET' && (!action || action === 'state')) {
      const s = await state();
      return res.json({
        available: s.available,
        remaining: s.remaining,
        amount_cents: s.available ? s.amount_cents : 0,
        label: s.label,
      });
    }

    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // ── OWNER: the whole picture ──
    if (req.method === 'GET' && action === 'admin') {
      const s = await state();
      const claims = await query(
        'SELECT * FROM earlybird_claims ORDER BY id DESC LIMIT 200').catch(() => []);
      return res.json({ ...s, claims, given_cents: claims.reduce((t, c) => t + (Number(c.amount_cents) || 0), 0) });
    }

    // ── OWNER: change it ──
    //
    // Raising the cap is how she runs a second round: the claims already
    // taken stay counted, so ten more seats means ten more people, not ten
    // from the start again.
    if (req.method === 'POST' && action === 'save') {
      const b = req.body || {};
      const seats = Math.max(0, Math.round(Number(b.seats) || 0));
      const amount = Math.max(0, Math.round(Number(b.amount_cents) || 0));
      await execute(
        'UPDATE earlybird SET active=?, seats=?, amount_cents=?, label=?, updated_ts=? WHERE id=1',
        [b.active ? 1 : 0, seats, amount, String(b.label || 'Founding Ten').slice(0, 60), Date.now()]);
      return res.json(await state());
    }

    // ── OWNER: give somebody their seat back ──
    if (req.method === 'DELETE' && action === 'claim') {
      await execute('DELETE FROM earlybird_claims WHERE id=?', [Number((req.body || {}).id)]);
      return res.json(await state());
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.state = state;
module.exports.claim = claim;
module.exports.ensure = ensure;
