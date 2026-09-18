// Face ID (and Touch ID, and Windows Hello) sign-in for Studio Manager.
//
// This is a passkey — the same thing banking apps use. The phone makes a key
// pair; the private half never leaves the phone's secure chip and can only be
// used after Face ID recognises her. Studio Manager keeps the public half.
// Signing in, the phone signs a one-time challenge and this checks the
// signature. Nothing about her face ever reaches the website.
//
// Setting one up needs the password once (she is already signed in). After
// that, a tap and a glance.
const crypto = require('crypto');
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const SITE = process.env.PUBLIC_BASE_URL || 'https://zolanailstudio.com';
const RP_ID = SITE.replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
const ORIGINS = new Set([SITE, 'https://' + RP_ID]);
const CHALLENGE_MS = 5 * 60000;

/* ── small helpers ── */
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest();

/* A CBOR reader — just the parts WebAuthn uses: numbers, byte and text
   strings, arrays and maps. */
function cbor(buf) {
  let i = 0;
  function readLen(info) {
    if (info < 24) return info;
    if (info === 24) return buf[i++];
    if (info === 25) { const v = buf.readUInt16BE(i); i += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(i); i += 4; return v; }
    if (info === 27) { const hi = buf.readUInt32BE(i), lo = buf.readUInt32BE(i + 4); i += 8; return hi * 4294967296 + lo; }
    throw new Error('Unsupported CBOR length');
  }
  function item() {
    const b = buf[i++];
    const major = b >> 5, info = b & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); const v = buf.slice(i, i + n); i += n; return v; }
      case 3: { const n = readLen(info); const v = buf.slice(i, i + n).toString('utf8'); i += n; return v; }
      case 4: { const n = readLen(info); const a = []; for (let k = 0; k < n; k++) a.push(item()); return a; }
      case 5: { const n = readLen(info); const m = new Map(); for (let k = 0; k < n; k++) { const key = item(); m.set(key, item()); } return m; }
      case 7: if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; throw new Error('Unsupported CBOR value');
      default: throw new Error('Unsupported CBOR type ' + major);
    }
  }
  const value = item();
  return { value, used: i };
}

/* The public key the phone made, from its COSE form into one Node can use. */
function coseToJwk(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2) { // EC2 — what iPhones make (ES256)
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) } };
  }
  if (kty === 3) { // RSA — some Windows machines (RS256)
    return { alg, jwk: { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) } };
  }
  throw new Error('That kind of key is not supported');
}

function parseAuthData(ad) {
  const rpIdHash = ad.slice(0, 32);
  const flags = ad[32];
  const signCount = ad.readUInt32BE(33);
  const out = { rpIdHash, flags, signCount, up: !!(flags & 1), uv: !!(flags & 4), at: !!(flags & 64) };
  if (out.at) {
    let p = 37;
    p += 16; // aaguid
    const idLen = ad.readUInt16BE(p); p += 2;
    out.credId = ad.slice(p, p + idLen); p += idLen;
    const { value } = cbor(ad.slice(p));
    out.cose = value;
  }
  return out;
}

function checkClient(clientDataB64, type, challenge) {
  const raw = unb64u(clientDataB64);
  const c = JSON.parse(raw.toString('utf8'));
  if (c.type !== type) throw new Error('Wrong kind of response');
  if (c.challenge !== challenge) throw new Error('That sign-in has expired — try again');
  if (!ORIGINS.has(c.origin)) throw new Error('Face ID only works on ' + RP_ID);
  return raw;
}

let _ready = false;
async function ensure() {
  if (_ready) return;
  await ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS owner_passkeys (
    id TEXT PRIMARY KEY, jwk TEXT NOT NULL, alg INTEGER, sign_count INTEGER DEFAULT 0,
    name TEXT DEFAULT '', created_ts INTEGER, last_used_ts INTEGER DEFAULT 0
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS passkey_challenges (
    challenge TEXT PRIMARY KEY, kind TEXT, ts INTEGER
  )`);
  _ready = true;
}

async function newChallenge(kind) {
  const c = b64u(crypto.randomBytes(32));
  await execute('DELETE FROM passkey_challenges WHERE ts < ?', [Date.now() - CHALLENGE_MS]);
  await execute('INSERT INTO passkey_challenges (challenge, kind, ts) VALUES (?,?,?)', [c, kind, Date.now()]);
  return c;
}
// A challenge answers once, and only while fresh.
async function useChallenge(clientDataB64, kind) {
  const c = JSON.parse(unb64u(clientDataB64).toString('utf8')).challenge;
  const row = await queryOne('SELECT challenge, kind, ts FROM passkey_challenges WHERE challenge = ?', [c]);
  await execute('DELETE FROM passkey_challenges WHERE challenge = ?', [c]);
  if (!row || row.kind !== kind || Date.now() - Number(row.ts) > CHALLENGE_MS) throw new Error('That sign-in has expired — try again');
  return c;
}

const isOwner = req => req.headers['x-ceo-password'] === CEO_PASSWORD;

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = req.query.action || (req.body && req.body.action) || '';
  try {
    await ensure();

    /* ── Setting it up on this phone (already signed in with the password) ── */
    if (action === 'register_options') {
      if (!isOwner(req)) return res.status(401).json({ error: 'Sign in with your password first' });
      const existing = await query('SELECT id FROM owner_passkeys');
      return res.json({
        challenge: await newChallenge('reg'),
        rp: { id: RP_ID, name: 'ZOLA Studio Manager' },
        user: { id: b64u(Buffer.from('zola-owner')), name: 'Zahra', displayName: 'Zahra · ZOLA Studio Manager' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        excludeCredentials: existing.map(r => ({ type: 'public-key', id: r.id })),
        attestation: 'none',
        timeout: 60000,
      });
    }

    if (action === 'register_verify' && req.method === 'POST') {
      if (!isOwner(req)) return res.status(401).json({ error: 'Sign in with your password first' });
      const b = req.body || {};
      const r = b.response || {};
      const challenge = await useChallenge(r.clientDataJSON, 'reg');
      checkClient(r.clientDataJSON, 'webauthn.create', challenge);
      const att = cbor(unb64u(r.attestationObject)).value;
      const ad = parseAuthData(att.get('authData'));
      if (!ad.rpIdHash.equals(sha256(Buffer.from(RP_ID)))) throw new Error('Face ID only works on ' + RP_ID);
      if (!ad.up || !ad.uv) throw new Error('Face ID was not confirmed — try again');
      if (!ad.credId || !ad.cose) throw new Error('The phone did not send a key');
      const { alg, jwk } = coseToJwk(ad.cose);
      const id = b64u(ad.credId);
      const name = String(b.name || 'This phone').slice(0, 60);
      await execute(
        'INSERT INTO owner_passkeys (id, jwk, alg, sign_count, name, created_ts) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET jwk=excluded.jwk, alg=excluded.alg, name=excluded.name',
        [id, JSON.stringify(jwk), alg, ad.signCount, name, Date.now()]);
      return res.json({ ok: true, id, name });
    }

    /* ── Signing in ── */
    // Is Face ID set up anywhere? (The sign-in screen asks before showing
    // the button; no challenge is made just for looking.)
    if (action === 'status') {
      const keys = await query('SELECT id FROM owner_passkeys');
      return res.json({ available: keys.length > 0 });
    }

    if (action === 'login_options') {
      const keys = await query('SELECT id FROM owner_passkeys');
      if (!keys.length) return res.json({ available: false });
      return res.json({
        available: true,
        challenge: await newChallenge('auth'),
        rpId: RP_ID,
        allowCredentials: keys.map(k => ({ type: 'public-key', id: k.id })),
        userVerification: 'required',
        timeout: 60000,
      });
    }

    if (action === 'login_verify' && req.method === 'POST') {
      const b = req.body || {};
      const r = b.response || {};
      const key = await queryOne('SELECT * FROM owner_passkeys WHERE id = ?', [String(b.id || '')]);
      if (!key) return res.status(401).json({ error: 'This phone is not set up for Face ID any more — sign in with your password and set it up again.' });
      const challenge = await useChallenge(r.clientDataJSON, 'auth');
      const clientRaw = checkClient(r.clientDataJSON, 'webauthn.get', challenge);
      const adBuf = unb64u(r.authenticatorData);
      const ad = parseAuthData(adBuf);
      if (!ad.rpIdHash.equals(sha256(Buffer.from(RP_ID)))) throw new Error('Face ID only works on ' + RP_ID);
      if (!ad.up || !ad.uv) return res.status(401).json({ error: 'Face ID was not confirmed — try again' });

      const signed = Buffer.concat([adBuf, sha256(clientRaw)]);
      const jwk = JSON.parse(key.jwk);
      const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const ok = Number(key.alg) === -257
        ? crypto.verify('sha256', signed, { key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, unb64u(r.signature))
        : crypto.verify('sha256', signed, { key: pub, dsaEncoding: 'der' }, unb64u(r.signature));
      if (!ok) return res.status(401).json({ error: 'Face ID could not be checked — sign in with your password.' });

      // A counter that goes backwards means a copied key. iPhones always send
      // 0, which is allowed.
      const prev = Number(key.sign_count) || 0;
      if (ad.signCount > 0 && ad.signCount <= prev) return res.status(401).json({ error: 'Face ID could not be checked — sign in with your password.' });
      await execute('UPDATE owner_passkeys SET sign_count = ?, last_used_ts = ? WHERE id = ?', [ad.signCount, Date.now(), key.id]);

      // Signed in exactly as if the password had been typed.
      return res.json({ ok: true, password: CEO_PASSWORD, name: key.name });
    }

    /* ── Which phones are set up, and taking one off ── */
    if (action === 'list') {
      if (!isOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
      const keys = await query('SELECT id, name, created_ts, last_used_ts FROM owner_passkeys ORDER BY created_ts');
      return res.json({ keys: keys.map(k => ({ id: k.id, name: k.name, created_ts: Number(k.created_ts), last_used_ts: Number(k.last_used_ts) || 0 })) });
    }
    if (action === 'remove' && req.method === 'POST') {
      if (!isOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
      await execute('DELETE FROM owner_passkeys WHERE id = ?', [String((req.body || {}).id || '')]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(400).json({ error: String(err.message || err) });
  }
};
module.exports._test = { cbor, parseAuthData, coseToJwk, b64u, unb64u, RP_ID };
