// Every email this site has sent, kept.
//
// Written after a client received a confirmation for an appointment that did
// not exist. There was no way to answer the only question that mattered —
// what exactly went out, to whom, and when — because nothing was recorded
// anywhere. A studio cannot stand behind messages it cannot read back.
//
// The whole body is stored, not a summary. A summary would have said
// "confirmation sent" and hidden the part that was wrong.
const { query, execute } = require('./_team-db');

let ready = false;

async function ensureTable() {
  if (ready) return;
  await execute(`CREATE TABLE IF NOT EXISTS mail_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT,
    subject TEXT,
    kind TEXT DEFAULT '',
    body TEXT DEFAULT '',
    sent INTEGER DEFAULT 0,
    detail TEXT DEFAULT '',
    ts INTEGER
  )`);
  try { await execute('CREATE INDEX IF NOT EXISTS mail_log_ts ON mail_log (ts)'); } catch (_) {}
  ready = true;
}

/* Recorded whether it went or not. A message that failed to send is often
   the more important one to be able to look up. */
async function record({ recipient, subject, kind, body, sent, detail }) {
  try {
    await ensureTable();
    await execute(
      'INSERT INTO mail_log (recipient, subject, kind, body, sent, detail, ts) VALUES (?,?,?,?,?,?,?)',
      [String(recipient || '').slice(0, 200),
       String(subject || '').slice(0, 300),
       String(kind || '').slice(0, 60),
       // Generous, because the point is being able to read the real thing.
       String(body || '').slice(0, 200000),
       sent ? 1 : 0,
       String(detail || '').slice(0, 300),
       Date.now()]);
  } catch (_) { /* logging must never take a send down with it */ }
}

async function list({ from, to, q, limit }) {
  await ensureTable();
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const rows = await query(
    `SELECT id, recipient, subject, kind, sent, detail, ts
       FROM mail_log
      WHERE ts >= ? AND ts <= ?
      ORDER BY ts DESC LIMIT ?`,
    [Number(from) || 0, Number(to) || Date.now(), lim]);

  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(r =>
    String(r.recipient || '').toLowerCase().includes(needle) ||
    String(r.subject || '').toLowerCase().includes(needle) ||
    String(r.kind || '').toLowerCase().includes(needle));
}

async function item(id) {
  await ensureTable();
  const rows = await query(
    'SELECT id, recipient, subject, kind, body, sent, detail, ts FROM mail_log WHERE id = ?',
    [Number(id)]);
  return rows && rows[0] ? rows[0] : null;
}

module.exports = { ensureTable, record, list, item };
