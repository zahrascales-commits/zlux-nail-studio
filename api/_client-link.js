// A client's private link to their own visit history.
//
// None of these 66 clients has an email or phone on file yet, so there is
// nothing to send a login code to and nothing to verify a name against.
// Letting someone type "Katelynn Boydstun" and read her appointments would
// not be a login, it would be a directory.
//
// So the studio hands out the link instead: Zahra copies a client's private
// link and texts it to her. Long random token, one per client, revocable.
// Same pattern the artists' magic links already use.
//
// What the client sees is deliberately narrow: the date, the time, and the
// service. No prices, no deposits, no totals, no lifetime value. Zahra keeps
// the money side; a client opening this sees the nails, not the bill.
const crypto = require('crypto');
const { query, queryOne, execute } = require('./_db');

const SITE = process.env.PUBLIC_SITE_URL || 'https://zolanailstudio.com';

let _ready = false;
async function ensureLinks() {
  if (_ready) return;
  await execute(`CREATE TABLE IF NOT EXISTS client_links (
    token TEXT PRIMARY KEY,
    client_id INTEGER NOT NULL,
    created_ts INTEGER,
    last_used_ts INTEGER,
    uses INTEGER DEFAULT 0
  )`);
  _ready = true;
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Minted on first use and reused after that, so a link she texted last month
// still works.
async function tokenFor(clientId) {
  await ensureLinks();
  const row = await queryOne('SELECT token FROM client_links WHERE client_id=?', [Number(clientId)]);
  if (row && row.token) return row.token;
  const token = newToken();
  await execute('INSERT INTO client_links (token, client_id, created_ts, uses) VALUES (?,?,?,0)',
    [token, Number(clientId), Date.now()]);
  return token;
}

async function linkFor(clientId) {
  try { return `${SITE}/my-visits.html?k=${await tokenFor(clientId)}`; }
  catch (_) { return ''; }
}

async function rotate(clientId) {
  await ensureLinks();
  await execute('DELETE FROM client_links WHERE client_id=?', [Number(clientId)]);
  return tokenFor(clientId);
}

async function clientForToken(token) {
  if (!token || String(token).length < 20) return null;
  await ensureLinks();
  const row = await queryOne('SELECT client_id FROM client_links WHERE token=?', [String(token)]);
  if (!row) return null;
  await execute('UPDATE client_links SET last_used_ts=?, uses=uses+1 WHERE token=?', [Date.now(), String(token)]);
  return Number(row.client_id);
}

/* ── What a client is allowed to see about herself ──────────────────
   Built here rather than filtered in the page, so a money figure can
   never reach the browser in the first place. A number the page has to
   remember not to render is a number that eventually gets rendered.  */
async function visitsFor(clientId) {
  const c = await queryOne('SELECT id, name, first_appointment, most_common_service FROM clients WHERE id=?', [Number(clientId)]);
  if (!c) return null;

  const out = [];
  try {
    const rows = await query(
      `SELECT date, time, service, artist, status FROM client_visits
        WHERE client_id=? OR lower(client_name)=lower(?)
        ORDER BY date DESC, time DESC`, [Number(clientId), c.name || '']);
    for (const r of rows) {
      out.push({
        date: r.date, time: r.time, service: r.service || '',
        artist: r.artist || '',
        cancelled: /cancel/i.test(String(r.status || '')),
      });
    }
  } catch (_) {}

  // Anything booked through this site since the switchover belongs here too.
  try {
    const rows = await query(
      `SELECT service, appointment_date, appointment_time, status
         FROM appointments
        WHERE lower(COALESCE(guest_name,'')) = lower(?)
        ORDER BY appointment_date DESC`, [c.name || '']);
    const seen = new Set(out.map(v => v.date + ' ' + v.time));
    for (const r of rows) {
      const k = r.appointment_date + ' ' + r.appointment_time;
      if (seen.has(k)) continue;
      out.push({
        date: r.appointment_date, time: r.appointment_time,
        service: r.service || '', artist: '',
        cancelled: /cancel/i.test(String(r.status || '')),
      });
    }
  } catch (_) {}

  out.sort((a, b) => String(b.date + b.time).localeCompare(String(a.date + a.time)));

  return {
    name: c.name,
    since: c.first_appointment || '',
    usual: c.most_common_service || '',
    // A count of visits is not a money figure and is the one number that
    // makes the page feel like hers rather than a list.
    total: out.filter(v => !v.cancelled).length,
    visits: out,
  };
}

module.exports = { ensureLinks, tokenFor, linkFor, rotate, clientForToken, visitsFor, SITE };
