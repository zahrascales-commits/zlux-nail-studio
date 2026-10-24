// What has actually been taken towards an appointment, one row per Stripe
// payment, keyed by the payment's own id.
//
// Deposits used to be a number written onto the appointment. Two things
// record a payment — the page the client paid on, and the Stripe webhook
// that arrives a moment later — and once a top-up was allowed to ADD to
// that number rather than set it, the same $80 went on twice. Beiriz was
// credited $255 against $175 of real charges, and the site then offered her
// a "rest" that was wrong too.
//
// A payment id can only be in here once, so it can only be counted once,
// and the appointment's deposit is always the sum of real payments. It also
// means the record can be reconciled against Stripe line by line.
const { query, queryOne, execute } = require('./_team-db');

let ready = null;
async function ensure() {
  if (ready) return ready;
  ready = (async () => {
    await execute(`CREATE TABLE IF NOT EXISTS deposit_payments (
      payment_id TEXT PRIMARY KEY,
      chat_token TEXT NOT NULL,
      cents INTEGER NOT NULL,
      kind TEXT DEFAULT 'deposit',
      ts INTEGER
    )`);
    try { await execute('CREATE INDEX IF NOT EXISTS deposit_payments_token ON deposit_payments (chat_token)'); } catch (_) {}
  })().catch(e => { ready = null; throw e; });
  return ready;
}

/* Deposits taken before this ledger existed live only as a number on the
   appointment. The first time anything is recorded against such a booking,
   that number is written in as its own row — otherwise summing the ledger
   would wipe a payment somebody really made. */
async function seedLegacy(token) {
  const had = await queryOne('SELECT COUNT(*) AS n FROM deposit_payments WHERE chat_token = ?', [token]);
  if (Number(had && had.n) > 0) return;
  const row = await queryOne(
    'SELECT COALESCE(deposit_cents,0) AS cents, COALESCE(deposit_paid,0) AS paid FROM team_appointments WHERE chat_token = ?',
    [token]);
  if (!row || !Number(row.paid) || !(Number(row.cents) > 0)) return;
  await execute(
    'INSERT OR IGNORE INTO deposit_payments (payment_id, chat_token, cents, kind, ts) VALUES (?,?,?,?,?)',
    ['legacy:' + token, token, Math.round(Number(row.cents)), 'legacy', Date.now()]);
}

/* Record one payment. Returns what the appointment now has against it. */
async function record({ payment_id, chat_token, cents, kind }) {
  await ensure();
  const token = String(chat_token || '').trim();
  const amount = Math.round(Number(cents) || 0);
  if (!token || !(amount > 0)) return { ok: false, total: 0 };

  // Without an id there is nothing to be idempotent about, so make one that
  // is still stable for this appointment and amount.
  const id = String(payment_id || '').trim() || ('noid:' + token + ':' + amount);

  await seedLegacy(token);
  await execute(
    'INSERT OR IGNORE INTO deposit_payments (payment_id, chat_token, cents, kind, ts) VALUES (?,?,?,?,?)',
    [id, token, amount, String(kind || 'deposit'), Date.now()]);

  return { ok: true, total: await applyTotal(token) };
}

// The appointment's deposit is whatever the ledger adds up to. Never more.
async function applyTotal(token) {
  const sum = await queryOne('SELECT COALESCE(SUM(cents),0) AS c FROM deposit_payments WHERE chat_token = ?', [token]);
  const total = Math.round(Number(sum && sum.c) || 0);
  await execute('UPDATE team_appointments SET deposit_paid = ?, deposit_cents = ? WHERE chat_token = ?',
    [total > 0 ? 1 : 0, total, token]);
  return total;
}

async function paymentsFor(token) {
  await ensure();
  return query('SELECT payment_id, cents, kind, ts FROM deposit_payments WHERE chat_token = ? ORDER BY ts', [token]);
}

module.exports = { ensure, record, applyTotal, paymentsFor };
