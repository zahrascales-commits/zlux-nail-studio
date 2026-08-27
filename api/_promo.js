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
    created_ts INTEGER,
    trainee_only INTEGER DEFAULT 0
  )`);
  // Added after launch; each is ignored once the column exists.
  const later = [
    // 'amount_off' takes money off. 'fixed_total' sets the price outright.
    "ALTER TABLE promo_codes ADD COLUMN kind TEXT DEFAULT 'amount_off'",
    "ALTER TABLE promo_codes ADD COLUMN fixed_total_cents INTEGER DEFAULT 0",
    // 'service', 'membership', or 'both'.
    "ALTER TABLE promo_codes ADD COLUMN applies_to TEXT DEFAULT 'service'",
    // On a membership, a discount either repeats every month or applies to
    // the first month only. Everything seeded before this column existed
    // repeated forever, so that stays the default — changing it would
    // silently reprice memberships already sold.
    "ALTER TABLE promo_codes ADD COLUMN duration TEXT DEFAULT 'forever'",
    // JSON list of tiers a membership code is valid for. Empty means any.
    "ALTER TABLE promo_codes ADD COLUMN tiers TEXT DEFAULT ''",
    // Codes are private by default — she hands them out, they are never listed.
    "ALTER TABLE promo_codes ADD COLUMN note TEXT DEFAULT ''",
  ];
  for (const sql of later) { try { await execute(sql); } catch (_) {} }
  // added after launch — ignored once present
  try { await execute('ALTER TABLE promo_codes ADD COLUMN trainee_only INTEGER DEFAULT 0'); } catch (_) {}
  // The trainee code exists from the start so she has something to hand out
  // immediately rather than having to build it first.
  const seeded = await queryOne("SELECT code FROM promo_codes WHERE code='TRAIN20'").catch(() => null);
  if (!seeded) {
    await execute(
      'INSERT OR IGNORE INTO promo_codes (code, label, amount_off_cents, active, max_uses, used_count, created_ts) VALUES (?,?,?,?,?,?,?)',
      ['TRAIN20', 'Trainee special — thank you for helping us train', 2000, 1, 0, 0, Date.now()]
    );

  }
  // TRAIN20 is the trainee special by definition. Set unconditionally: the
  // row is usually already there, so doing this only on first insert left the
  // flag off and the calendar unfiltered.
  await execute("UPDATE promo_codes SET trainee_only=1 WHERE code='TRAIN20'").catch(() => {});

  // MASYNX2 — Zahra testing her own live checkout without spending $299.
  // Makes any total zero, on services and memberships alike.
  //
  // Capped at 25 uses on purpose. A code that makes anything free is the
  // single most damaging string on this site if it ever leaks — a screenshot,
  // somebody reading over her shoulder — and on a membership it would hand
  // out a Black Card that stays free every month, not just the first. The cap
  // means a leak costs a bounded number of memberships rather than unlimited
  // ones, and she can raise it whenever she needs more test runs.
  const mine = await queryOne("SELECT code FROM promo_codes WHERE code='MASYNX2'").catch(() => null);
  if (!mine) {
    await execute(
      `INSERT OR IGNORE INTO promo_codes
         (code, label, amount_off_cents, active, max_uses, used_count, created_ts,
          kind, fixed_total_cents, applies_to, tiers, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['MASYNX2', 'Owner test — makes the whole total zero', 0, 1, 25, 0, Date.now(),
       'fixed_total', 0, 'both', JSON.stringify([]),
       'PRIVATE — Zahra only. Makes any transaction free. Never put this on the site.']);
  }

  // THEOG — the founding rate. Whatever Black Card costs, an OG pays $100 a
  // month, for as long as they stay. Seeded rather than left to be typed
  // because getting a fixed-price code wrong costs real money every month.
  const og = await queryOne("SELECT code FROM promo_codes WHERE code='THEOG'").catch(() => null);
  if (!og) {
    await execute(
      `INSERT OR IGNORE INTO promo_codes
         (code, label, amount_off_cents, active, max_uses, used_count, created_ts,
          kind, fixed_total_cents, applies_to, tiers, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['THEOG', 'Founding rate — $100 a month, for as long as you stay', 0, 1, 0, 0, Date.now(),
       'fixed_total', 10000, 'membership', JSON.stringify(['BLACK_CARD']),
       'Private. Given out by hand — never listed on the site.']);
  }

  // ZOLA26 — the code she can actually post. Fifty dollars off the first
  // month of any tier, capped at fifty people.
  //
  // First month only, deliberately. Every other code here repeats every
  // month for as long as somebody stays, which is right for a founding rate
  // handed to one person and wrong for a code that goes on Instagram: fifty
  // dollars a month forever, fifty times over, is six hundred dollars of
  // recurring income gone every year for a code that did its job in week one.
  const launch = await queryOne("SELECT code FROM promo_codes WHERE code='ZOLA26'").catch(() => null);
  if (!launch) {
    await execute(
      `INSERT OR IGNORE INTO promo_codes
         (code, label, amount_off_cents, active, max_uses, used_count, created_ts,
          kind, fixed_total_cents, applies_to, tiers, note, duration)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['ZOLA26', '$10 off anything', 1000, 1, 50, 0, Date.now(),
       'amount_off', 0, 'both', JSON.stringify([]),
       'Shareable, site-wide. Ten dollars off a booking, press-ons or a first month.', 'once']);
  } else {
    // If it predates the duration column, make sure it is not repeating.
    // Corrected after the fact: it was seeded at $50 and membership-only,
    // which is not what it is meant to be. Ten dollars, off anything.
    await execute("UPDATE promo_codes SET duration='once', amount_off_cents=1000, applies_to='both',"
      + " label='$10 off anything' WHERE code='ZOLA26'").catch(() => {});
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
  return {
    ok: true, code: c,
    amount_off_cents: Number(row.amount_off_cents) || 0,
    label: row.label || '',
    trainee_only: !!Number(row.trainee_only),
    kind: row.kind || 'amount_off',
    duration: row.duration === 'once' ? 'once' : 'forever',
    fixed_total_cents: Number(row.fixed_total_cents) || 0,
    applies_to: row.applies_to || 'service',
    tiers: (() => { try { return JSON.parse(row.tiers || '[]'); } catch (_) { return []; } })(),
  };
}

/* ── What a code is worth against a specific price ──────────────────
   Priced here rather than at the call site, so "take $20 off" and "make
   it $100" cannot drift apart in two places. A fixed-total code is
   recomputed against whatever the price is today — writing it as an
   amount off would quietly break the next time a price changes.     */
function valueAgainst(promo, totalCents) {
  const total = Number(totalCents) || 0;
  if (!promo || !promo.ok) return 0;
  if (promo.kind === 'fixed_total') {
    // Never a negative discount: a code that says $100 must not raise a $60
    // total to $100.
    return Math.max(0, total - (Number(promo.fixed_total_cents) || 0));
  }
  return Math.min(Number(promo.amount_off_cents) || 0, total);
}

// Whether this code may be used on this thing at all.
function allows(promo, { forMembership, tier }) {
  if (!promo || !promo.ok) return { ok: false, why: 'That code is not recognised.' };
  const scope = promo.applies_to || 'service';
  if (forMembership && scope === 'service') {
    return { ok: false, why: 'That code is for appointments, not memberships.' };
  }
  if (!forMembership && scope === 'membership') {
    return { ok: false, why: 'That code is for memberships only.' };
  }
  if (forMembership && promo.tiers && promo.tiers.length) {
    const want = String(tier || '').toUpperCase();
    if (!promo.tiers.map(t => String(t).toUpperCase()).includes(want)) {
      const names = promo.tiers.map(t => String(t).replace('_', ' ')).join(' or ');
      return { ok: false, why: 'That code only works on ' + names + '.' };
    }
  }
  return { ok: true };
}

async function redeem(code) {
  const c = norm(code);
  if (!c) return;
  await execute('UPDATE promo_codes SET used_count = used_count + 1 WHERE code=?', [c]).catch(() => {});
}

module.exports.ensure = ensure;
module.exports.lookup = lookup;
module.exports.redeem = redeem;
module.exports.valueAgainst = valueAgainst;
module.exports.allows = allows;

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
    // Accepts GET as well, because the signup form checks a code before
    // anything has been submitted and GET is the honest verb for "what is
    // this worth".
    if (action === 'check') {
      const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      const r = await lookup(src.code);
      if (!r.ok) return res.status(404).json({ ok: false, why: r.why, error: r.why });

      const forMembership = String(src.membership || '') === '1';
      const tier = String(src.tier || '').toUpperCase();
      const allowed = allows(r, { forMembership, tier });
      if (!allowed.ok) return res.status(400).json({ ok: false, why: allowed.why, error: allowed.why });

      // For a membership, say what they will actually pay. A code that only
      // reports "$199 off" tells somebody nothing about their bill.
      const TIER_CENTS = { SIGNATURE: 9900, LUXE: 19900, BLACK_CARD: 29900, TEST: 158 };
      const base = TIER_CENTS[tier] || 0;
      const off = base ? valueAgainst(r, base) : r.amount_off_cents;

      return res.json({
        ok: true, code: r.code, label: r.label,
        kind: r.kind, applies_to: r.applies_to, tiers: r.tiers,
        amount_off_cents: off,
        trainee_only: r.trainee_only,
        monthly_cents: base ? Math.max(0, base - off) : null,
      });
    }

    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'GET') {
      return res.json({ codes: await query('SELECT * FROM promo_codes ORDER BY created_ts DESC') });
    }

    if (req.method === 'POST' && action === 'save') {
      const { code, label, amount_off, active, max_uses, trainee_only } = req.body || {};
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
      if (trainee_only !== undefined) {
        await execute('UPDATE promo_codes SET trainee_only=? WHERE code=?', [trainee_only ? 1 : 0, c]);
      }
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
