// Discount codes Zahra hands out.
//
// Built for the trainee special first: she gives a code to a client who is
// happy to sit with an artist in training, and $20 comes off. Codes are
// validated and applied SERVER-side only — a browser can ask what a code is
// worth, but it can never tell the server what to charge.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

async function ensure() {
  await ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS promo_codes (
    code TEXT PRIMARY KEY,
    label TEXT DEFAULT '',
    amount_off_cents INTEGER NOT NULL DEFAULT 0,
    active INTEGER DEFAULT 1,
    max_uses INTEGER DEFAULT 0,
    used_count INTEGER DEFAULT 0,
    created_ts INTEGER
  )`);
  // The trainee code exists from the start so she has something to hand out
  // immediately rather than having to build it first.
  const seeded = await queryOne("SELECT code FROM promo_codes WHERE code='TRAIN20'").catch(() => null);
  if (!seeded) {
    await execute(
      'INSERT OR IGNORE INTO promo_codes (code, label, amount_off_cents, active, max_uses, used_count, created_ts) VALUES (?,?,?,?,?,?,?)',
      ['TRAIN20', 'Trainee special — thank you for helping us train', 2000, 1, 0, 0, Date.now()]
    );
  }
}

const norm = c => String(c || '').trim().toUpperCase().slice(0, 32);

// Returns the discount in cents, or null with a reason. Never throws at a
// caller mid-booking — a broken promo lookup must not lose the booking.
async function lookup(code) {
  const c = norm(code);
  if (!c) return { ok: false, why: 'no code' };
  const row = await queryOne('SELECT * FROM promo_codes WHERE code=?', [c]).catch(() => null);
  if (!row) return { ok: false, why: "That code isn't recognised." };
  if (!Number(row.active)) return { ok: false, why: 'That code is no longer active.' };
  const max = Number(row.max_uses) || 0;
  if (max > 0 && Number(row.used_count) >= max) return { ok: false, why: 'That code has been fully used.' };
  return { ok: true, code: c, amount_off_cents: Number(row.amount_off_cents) || 0, label: row.label || '' };
}

async function redeem(code) {
  const c = norm(code);
  if (!c) return;
  await execute('UPDATE promo_codes SET used_count = used_count + 1 WHERE code=?', [c]).catch(() => {});
}

module.exports.ensure = ensure;
module.exports.lookup = lookup;
module.exports.redeem = redeem;

module.exports.handler = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CEO-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensure();

    // ── PUBLIC: what is this code worth? ──
    // Only ever reports the discount; applying it still happens server-side
    // at booking, so a tampered response cannot change what is charged.
    if (req.method === 'POST' && action === 'check') {
      const r = await lookup((req.body || {}).code);
      if (!r.ok) return res.status(404).json({ ok: false, error: r.why });
      return res.json({ ok: true, code: r.code, amount_off_cents: r.amount_off_cents, label: r.label });
    }

    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'GET') {
      return res.json({ codes: await query('SELECT * FROM promo_codes ORDER BY created_ts DESC') });
    }

    if (req.method === 'POST' && action === 'save') {
      const { code, label, amount_off, active, max_uses } = req.body || {};
      const c = norm(code);
      if (!c) return res.status(400).json({ error: 'A code is required' });
      const cents = Math.round(Number(amount_off || 0) * 100);
      if (!(cents > 0)) return res.status(400).json({ error: 'The discount has to be more than $0' });
      await execute(
        `INSERT INTO promo_codes (code, label, amount_off_cents, active, max_uses, used_count, created_ts)
         VALUES (?,?,?,?,?,0,?)
         ON CONFLICT(code) DO UPDATE SET label=excluded.label, amount_off_cents=excluded.amount_off_cents,
           active=excluded.active, max_uses=excluded.max_uses`,
        [c, String(label || '').slice(0, 160), cents, active === false ? 0 : 1, Number(max_uses) || 0, Date.now()]
      );
      return res.json({ ok: true, code: c });
    }

    if (req.method === 'DELETE') {
      const c = norm((req.body || {}).code);
      if (!c) return res.status(400).json({ error: 'code required' });
      await execute('DELETE FROM promo_codes WHERE code=?', [c]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
