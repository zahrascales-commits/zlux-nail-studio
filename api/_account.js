// Client accounts — simple, forgiving login like GlossGenius:
// email + password, auto-created at booking, easy re-registration.
// If someone re-registers with the same email, the new password simply
// replaces the old one (she asked: forgetting must never lock anyone out).
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query, queryOne, execute, ensureTables } = require('./_team-db');
const { upsertClient } = require('./_clients');

let _ready = false;
async function ensureAccountTables() {
  if (_ready) return;
  await ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS client_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    pass_hash TEXT,
    name TEXT,
    phone TEXT,
    token TEXT,
    token_ts INTEGER,
    created_ts INTEGER
  )`);
  _ready = true;
}

function newToken() { return crypto.randomBytes(24).toString('hex'); }

async function authed(req) {
  const tok = String(req.headers['x-client-token'] || req.query.token || '');
  if (!tok) return null;
  const acc = await queryOne('SELECT * FROM client_accounts WHERE token=?', [tok]);
  if (!acc) return null;
  if (Date.now() - Number(acc.token_ts || 0) > 30 * 86400000) return null; // 30-day sessions
  return acc;
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensureAccountTables();

    // ── REGISTER (or friendly re-register: same email just resets password) ──
    if (req.method === 'POST' && action === 'register') {
      const { email, password, name, phone } = req.body || {};
      const em = String(email || '').trim().toLowerCase();
      if (!em || !/@/.test(em)) return res.status(400).json({ error: 'Valid email required' });
      if (!password || String(password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
      const hash = bcrypt.hashSync(String(password), 10);
      const tok = newToken();
      const existing = await queryOne('SELECT id FROM client_accounts WHERE email=?', [em]);
      if (existing) {
        await execute('UPDATE client_accounts SET pass_hash=?, name=COALESCE(NULLIF(?,\'\'),name), phone=COALESCE(NULLIF(?,\'\'),phone), token=?, token_ts=? WHERE id=?',
          [hash, name || '', phone || '', tok, Date.now(), existing.id]);
      } else {
        await execute('INSERT INTO client_accounts (email, pass_hash, name, phone, token, token_ts, created_ts) VALUES (?,?,?,?,?,?,?)',
          [em, hash, name || '', phone || '', tok, Date.now(), Date.now()]);
      }
      await upsertClient({ name, email: em, phone });
      return res.json({ ok: true, token: tok, name: name || '', email: em });
    }

    // ── LOGIN ──
    if (req.method === 'POST' && action === 'login') {
      const { email, password } = req.body || {};
      const em = String(email || '').trim().toLowerCase();
      const acc = await queryOne('SELECT * FROM client_accounts WHERE email=?', [em]);
      if (!acc || !bcrypt.compareSync(String(password || ''), acc.pass_hash)) {
        return res.status(401).json({ error: 'Wrong email or password. Forgot it? Just sign up again with the same email — your history stays.' });
      }
      const tok = newToken();
      await execute('UPDATE client_accounts SET token=?, token_ts=? WHERE id=?', [tok, Date.now(), acc.id]);
      return res.json({ ok: true, token: tok, name: acc.name || '', email: acc.email });
    }

    // ── AUTHED ──
    const acc = await authed(req);
    if (!acc) return res.status(401).json({ error: 'Please log in' });

    // ── ME: profile + my appointments (with chat links) + preferences ──
    if (req.method === 'GET' && action === 'me') {
      const em = acc.email;
      const ph = String(acc.phone || '').replace(/\D/g, '');
      const client = await queryOne('SELECT * FROM clients WHERE lower(email)=?', [em]);
      // appointments matched by name/phone against the unified team calendar
      const appts = await query(
        `SELECT a.id, a.client_name, a.service, a.date, a.time, a.status, a.chat_token, m.name AS artist, m.color AS artist_color
         FROM team_appointments a LEFT JOIN team_members m ON m.id=a.team_member_id
         WHERE (a.client_phone<>'' AND replace(replace(replace(replace(a.client_phone,'-',''),' ',''),'(',''),')','')=?)
            OR lower(a.client_name)=lower(?)
         ORDER BY a.date DESC, a.time DESC LIMIT 60`,
        [ph || '~none~', acc.name || client?.name || '~none~']);
      return res.json({
        account: { name: acc.name, email: acc.email, phone: acc.phone },
        profile: client ? { visits: client.visits, last_service: client.last_service, likes: client.likes, dislikes: client.dislikes, opt_in: Number(client.marketing_opt_in) } : null,
        appointments: appts,
      });
    }

    // ── UPDATE PROFILE / SETTINGS ──
    if (req.method === 'PUT' && action === 'profile') {
      const { name, phone, likes, dislikes, opt_in, new_password } = req.body || {};
      await execute('UPDATE client_accounts SET name=?, phone=? WHERE id=?', [name || acc.name || '', phone || acc.phone || '', acc.id]);
      if (new_password && String(new_password).length >= 4) {
        await execute('UPDATE client_accounts SET pass_hash=? WHERE id=?', [bcrypt.hashSync(String(new_password), 10), acc.id]);
      }
      const client = await queryOne('SELECT id FROM clients WHERE lower(email)=?', [acc.email]);
      if (client) {
        await execute('UPDATE clients SET name=?, phone=?, likes=?, dislikes=?, marketing_opt_in=? WHERE id=?',
          [name || '', phone || '', likes || '', dislikes || '', opt_in ? 1 : 0, client.id]);
      } else {
        await upsertClient({ name, email: acc.email, phone, optIn: !!opt_in });
      }
      return res.json({ ok: true });
    }

    if (req.method === 'POST' && action === 'logout') {
      await execute('UPDATE client_accounts SET token=NULL WHERE id=?', [acc.id]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
