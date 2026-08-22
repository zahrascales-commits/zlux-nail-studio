// Real phone notifications — the kind that light up a locked screen.
//
// Web Push, so there is no app store and nothing to install beyond adding
// the portal to the home screen. Two things are worth knowing:
//
//   1. iPhones only allow this once the site is on the Home Screen (iOS 16.4+).
//      Safari in a normal tab refuses permission outright. The portal says so
//      rather than letting an artist tap "turn on" and quietly get nothing.
//   2. The VAPID keypair identifies this studio to Apple/Google's push
//      services. It is generated once and kept in site_settings, so nobody has
//      to paste keys into Vercel — but it must never change, or every phone
//      already signed up goes silent.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const SITE = process.env.PUBLIC_SITE_URL || 'https://zolanailstudio.com';

// Lazily required: if the dependency ever fails to install, the studio keeps
// running and simply falls back to text messages instead of the site breaking.
function lib() {
  try { return require('web-push'); } catch (_) { return null; }
}

let _tablesReady = false;
async function ensurePushTables() {
  if (_tablesReady) return;
  await ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    role TEXT,
    member_id INTEGER,
    p256dh TEXT,
    auth TEXT,
    label TEXT,
    created_ts INTEGER,
    last_ok_ts INTEGER,
    fails INTEGER DEFAULT 0
  )`);
  _tablesReady = true;
}

// The keypair, minted on first use and never rotated afterwards.
let _vapid = null;
async function vapid() {
  if (_vapid) return _vapid;
  await ensurePushTables();
  const rows = await query("SELECT key, value FROM site_settings WHERE key IN ('vapid_public','vapid_private')");
  const got = {};
  for (const r of rows) got[r.key] = String(r.value || '').trim();
  if (got.vapid_public && got.vapid_private) {
    _vapid = { publicKey: got.vapid_public, privateKey: got.vapid_private };
    return _vapid;
  }
  const wp = lib();
  if (!wp) return null;
  const keys = wp.generateVAPIDKeys();
  await execute("INSERT INTO site_settings (key,value) VALUES ('vapid_public',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [keys.publicKey]);
  await execute("INSERT INTO site_settings (key,value) VALUES ('vapid_private',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [keys.privateKey]);
  _vapid = keys;
  return _vapid;
}

async function publicKey() {
  const v = await vapid();
  return v ? v.publicKey : '';
}

async function saveSub(sub, role, memberId, label) {
  if (!sub || !sub.endpoint || !sub.keys) return { ok: false, why: 'incomplete subscription' };
  await ensurePushTables();
  await execute(
    `INSERT INTO push_subs (endpoint, role, member_id, p256dh, auth, label, created_ts, last_ok_ts, fails)
     VALUES (?,?,?,?,?,?,?,?,0)
     ON CONFLICT(endpoint) DO UPDATE SET
       role=excluded.role, member_id=excluded.member_id,
       p256dh=excluded.p256dh, auth=excluded.auth, label=excluded.label, fails=0`,
    [String(sub.endpoint), role === 'owner' ? 'owner' : 'member',
     memberId ? Number(memberId) : null, String(sub.keys.p256dh || ''), String(sub.keys.auth || ''),
     String(label || '').slice(0, 80), Date.now(), Date.now()]
  );
  return { ok: true };
}

async function removeSub(endpoint) {
  await ensurePushTables();
  await execute('DELETE FROM push_subs WHERE endpoint=?', [String(endpoint)]);
  return { ok: true };
}

async function subsForMember(memberId) {
  await ensurePushTables();
  return query('SELECT * FROM push_subs WHERE role=? AND member_id=?', ['member', Number(memberId)]);
}
async function subsForOwner() {
  await ensurePushTables();
  return query('SELECT * FROM push_subs WHERE role=?', ['owner']);
}

// How many phones a given person has signed up, so the portal can say
// "on for this phone" honestly instead of guessing from browser state.
async function statusFor(role, memberId) {
  await ensurePushTables();
  const rows = role === 'owner' ? await subsForOwner() : await subsForMember(memberId);
  return { devices: rows.length, key: await publicKey() };
}

async function sendTo(rows, payload) {
  const wp = lib();
  const v = await vapid();
  if (!wp || !v || !rows.length) {
    return { sent: 0, why: !wp ? 'push library unavailable' : (!v ? 'no keys' : 'no devices') };
  }
  wp.setVapidDetails(SITE, v.publicKey, v.privateKey);
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(rows.map(async (r) => {
    const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    try {
      await wp.sendNotification(sub, body, { TTL: 3600, urgency: 'high' });
      sent++;
      await execute('UPDATE push_subs SET last_ok_ts=?, fails=0 WHERE endpoint=?', [Date.now(), r.endpoint]);
    } catch (err) {
      const code = err && err.statusCode;
      // 404/410 mean the phone unsubscribed or the app was deleted. Keeping a
      // dead endpoint only slows every future send down.
      if (code === 404 || code === 410) {
        await execute('DELETE FROM push_subs WHERE endpoint=?', [r.endpoint]).catch(() => {});
      } else {
        await execute('UPDATE push_subs SET fails=fails+1 WHERE endpoint=?', [r.endpoint]).catch(() => {});
        await execute('DELETE FROM push_subs WHERE endpoint=? AND fails>=6', [r.endpoint]).catch(() => {});
      }
    }
  }));
  return { sent };
}

async function pushToMember(memberId, payload) {
  try { return await sendTo(await subsForMember(memberId), payload); }
  catch (err) { return { sent: 0, why: String(err.message || err) }; }
}
async function pushToOwner(payload) {
  try { return await sendTo(await subsForOwner(), payload); }
  catch (err) { return { sent: 0, why: String(err.message || err) }; }
}
async function pushToMembers(ids, payload) {
  const out = await Promise.all((ids || []).map(id => pushToMember(id, payload)));
  return { sent: out.reduce((s, o) => s + (o.sent || 0), 0) };
}

/* ── HTTP ──────────────────────────────────────────────────────────────
   One endpoint for both the owner and the artists. Identity is proved the
   same way the rest of their portal proves it (member_id + PIN, or the
   magic-link token), so a subscription can never be filed under someone
   else's name.                                                          */
async function authMember(req) {
  const q = { ...(req.query || {}), ...(req.body || {}) };
  if (q.token) {
    try {
      const id = await require('./_worker-link').memberForToken(q.token);
      if (id) return id;
    } catch (_) {}
  }
  const id = Number(q.member_id);
  const pin = String(q.pin || '');
  if (!id || !pin) return null;
  const row = await queryOne('SELECT id FROM team_members WHERE id=? AND pin=? AND active=1', [id, pin]);
  return row ? Number(row.id) : null;
}

function authOwner(req) {
  const q = { ...(req.query || {}), ...(req.body || {}) };
  const given = req.headers['x-ceo-password'] || q.pass || q.password || '';
  return String(given) === (process.env.CEO_PASSWORD || 'ZOLA2026');
}

async function handler(req, res) {
  const q = { ...(req.query || {}), ...(req.body || {}) };
  const action = q.action || '';
  try {
    // The public key is not a secret — the browser needs it to subscribe at all.
    if (action === 'key') return res.json({ key: await publicKey() });

    const owner = authOwner(req);
    const memberId = owner ? null : await authMember(req);
    if (!owner && !memberId) return res.status(401).json({ error: 'Not signed in' });
    const role = owner ? 'owner' : 'member';

    if (action === 'status') return res.json(await statusFor(role, memberId));

    if (action === 'subscribe') {
      const r = await saveSub(q.subscription, role, memberId, q.label);
      if (!r.ok) return res.status(400).json(r);
      return res.json({ ...r, ...(await statusFor(role, memberId)) });
    }

    if (action === 'unsubscribe') {
      await removeSub(q.endpoint);
      return res.json({ ok: true, ...(await statusFor(role, memberId)) });
    }

    // Lets someone prove it works on their own phone before trusting it with a
    // real booking — the difference between "set up" and "relied on".
    if (action === 'test') {
      const payload = {
        title: 'ZOLA · notifications are on',
        body: 'This is exactly how a new booking will reach you.',
        url: owner ? '/manager.html' : '/team.html',
        tag: 'zola-test',
      };
      const r = owner ? await pushToOwner(payload) : await pushToMember(memberId, payload);
      return res.json(r);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = {
  handler, publicKey, saveSub, removeSub, statusFor,
  pushToMember, pushToMembers, pushToOwner, ensurePushTables,
};
