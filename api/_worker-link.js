// One durable magic link per artist.
//
// When a booking lands, the text she gets carries a link that opens straight
// into her schedule — tapping a notification and then being asked for a PIN is
// exactly the friction that stops people checking. The token is long, random,
// scoped to that one artist's own schedule, and revocable from the manager if
// a phone is ever lost.
const { queryOne, execute, ensureTables } = require('./_team-db');
const crypto = require('crypto');

const SITE = process.env.PUBLIC_SITE_URL || 'https://zlux-github.vercel.app';

async function ensureLinkTable() {
  await ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS worker_links (
    token TEXT PRIMARY KEY,
    member_id INTEGER NOT NULL,
    created_ts INTEGER,
    last_used_ts INTEGER
  )`);
}

function newToken() {
  // 32 bytes of randomness — not guessable, and short enough for a text
  return crypto.randomBytes(24).toString('base64url');
}

// The artist's token, minted on first use and reused after that, so the link
// in an older text keeps working.
async function tokenFor(memberId) {
  await ensureLinkTable();
  const row = await queryOne('SELECT token FROM worker_links WHERE member_id=?', [Number(memberId)]);
  if (row && row.token) return row.token;
  const token = newToken();
  await execute(
    'INSERT INTO worker_links (token, member_id, created_ts) VALUES (?,?,?)',
    [token, Number(memberId), Date.now()]
  );
  return token;
}

async function linkFor(memberId) {
  try {
    return `${SITE}/team.html?t=${await tokenFor(memberId)}`;
  } catch (_) {
    return `${SITE}/team.html`; // a link without auto-login beats no link
  }
}

// Invalidates every existing link for that artist and issues a fresh one.
async function rotate(memberId) {
  await ensureLinkTable();
  await execute('DELETE FROM worker_links WHERE member_id=?', [Number(memberId)]);
  return tokenFor(memberId);
}

async function memberForToken(token) {
  if (!token || String(token).length < 20) return null;
  await ensureLinkTable();
  const row = await queryOne('SELECT member_id FROM worker_links WHERE token=?', [String(token)]);
  if (!row) return null;
  await execute('UPDATE worker_links SET last_used_ts=? WHERE token=?', [Date.now(), String(token)]);
  return Number(row.member_id);
}

module.exports = { ensureLinkTable, tokenFor, linkFor, rotate, memberForToken, SITE };
