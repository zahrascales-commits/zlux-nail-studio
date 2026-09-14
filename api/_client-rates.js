// A rate that belongs to one person.
//
// Katelynn books at 25% off. That is not a promo code somebody could pass
// on, not a membership perk, and not something the menu should say — it is
// an arrangement with one client, and it should follow her whether she
// books online, at the desk, or Zahra writes her in.
//
// Built as a table rather than her name in an if-statement, because the
// next one of these is coming and it should not need me.
//
// It comes off the service. Not off a deal day, which is already a flat
// price below every membership rate, and not off something a membership is
// already covering in full — there is nothing to take a quarter off of.
const { query, queryOne, execute } = require('./_team-db');

let ready = null;
async function ensureTable() {
  if (ready) return ready;
  ready = (async function () {
    await execute(`CREATE TABLE IF NOT EXISTS client_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT DEFAULT '',
      member_id TEXT DEFAULT '',
      percent_off INTEGER DEFAULT 0,
      label TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_ts INTEGER,
      updated_ts INTEGER
    )`);
    try { await execute('CREATE INDEX IF NOT EXISTS client_rates_email ON client_rates (email)'); } catch (_) {}
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const norm = s => String(s || '').trim().toLowerCase();

/* What this person pays, as a percentage off. Zero for almost everybody,
   which is the point — a rate is the exception, and the exception has to be
   written down somewhere she can see and change it.

   Matched on either the email or the member id, because the same person
   arrives with different amounts known about them depending on the screen:
   the booking page has an email, the till often has only a member id. */
async function percentFor({ email, member_id } = {}) {
  const em = norm(email);
  const mid = String(member_id || '').trim().toUpperCase();
  if (!em && !mid) return 0;

  try {
    await ensureTable();
    const row = await queryOne(
      `SELECT percent_off FROM client_rates
        WHERE active = 1
          AND ((? <> '' AND lower(email) = ?) OR (? <> '' AND upper(member_id) = ?))
        ORDER BY percent_off DESC LIMIT 1`,
      [em, em, mid, mid]);
    const pct = Math.max(0, Math.min(100, Number(row && row.percent_off) || 0));
    return pct;
  } catch (_) { return 0; }
}

async function list() {
  try {
    await ensureTable();
    return await query('SELECT * FROM client_rates ORDER BY active DESC, percent_off DESC, id');
  } catch (_) { return []; }
}

async function save({ id, email, member_id, percent_off, label, active }) {
  await ensureTable();
  const now = Date.now();
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent_off) || 0)));
  const em = norm(email);
  const mid = String(member_id || '').trim().toUpperCase();
  if (!em && !mid) throw new Error('Give an email or a member ID, so the rate knows who it belongs to.');

  if (id) {
    await execute(
      `UPDATE client_rates SET email=?, member_id=?, percent_off=?, label=?, active=?, updated_ts=? WHERE id=?`,
      [em, mid, pct, label || '', active ? 1 : 0, now, Number(id)]);
    return Number(id);
  }

  // One rate per person, so saving the same address twice edits rather than
  // quietly creating a second one that may or may not be the one that wins.
  const existing = await queryOne(
    `SELECT id FROM client_rates WHERE (? <> '' AND lower(email)=?) OR (? <> '' AND upper(member_id)=?)`,
    [em, em, mid, mid]);
  if (existing) {
    await execute(
      `UPDATE client_rates SET email=?, member_id=?, percent_off=?, label=?, active=?, updated_ts=? WHERE id=?`,
      [em, mid, pct, label || '', active ? 1 : 0, now, Number(existing.id)]);
    return Number(existing.id);
  }

  const r = await execute(
    `INSERT INTO client_rates (email, member_id, percent_off, label, active, created_ts, updated_ts)
     VALUES (?,?,?,?,?,?,?)`,
    [em, mid, pct, label || '', active ? 1 : 0, now, now]);
  return r.lastInsertRowid;
}

async function remove(id) {
  await ensureTable();
  await execute('DELETE FROM client_rates WHERE id=?', [Number(id)]);
}

module.exports = { percentFor, list, save, remove, ensureTable };
