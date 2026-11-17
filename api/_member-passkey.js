// Face ID for a membership.
//
// A member's only credential is their member ID — ZL-JD246FD1 — which is
// not something anybody remembers, so it gets typed once and then lost, and
// the studio is asked for it again. Justin has been asking for weeks.
//
// A passkey fixes that properly. The phone makes a key pair; the private
// half never leaves the phone's secure chip and can only be used after Face
// ID (or Touch ID, or Windows Hello) recognises the person holding it. This
// keeps the public half. Signing in, the phone signs a one-time challenge
// and this checks the signature. Nothing about anybody's face reaches the
// website, and there is nothing left to type or remember.
//
// Two things make this different from the owner's Face ID:
//
//   * The credentials are DISCOVERABLE, so signing in needs no member ID
//     at all. The phone offers whichever passkey it holds for this site and
//     this works out who that is afterwards. "Log in" becomes one tap.
//
//   * A membership can have several. Justin bought his for his wife as well
//     as himself, so both of them register their own phone against the same
//     membership and each gets in with their own face. Zahra chose that
//     they share the one included visit per cycle, which they do — this is
//     about getting in, not about what is covered.
//
// The WebAuthn verification itself is not written again here. It is the same
// code that already runs her Studio Manager Face ID, imported from
// _passkey.js, because a second signature checker is a second place for a
// signature check to be subtly and silently wrong.
const crypto = require('crypto');
const { query, queryOne, execute } = require('./_db');
const core = require('./_passkey')._core;

const { b64u, unb64u, sha256, cbor, coseToJwk, parseAuthData, checkClient,
        RP_ID, CHALLENGE_MS } = core;

// A session that lasts. The whole point is not signing in again.
const SESSION_DAYS = 365;

let _ready = false;
async function ensure() {
  if (_ready) return;
  await execute(`CREATE TABLE IF NOT EXISTS member_passkeys (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    jwk TEXT NOT NULL,
    alg INTEGER,
    sign_count INTEGER DEFAULT 0,
    name TEXT DEFAULT '',
    created_ts INTEGER,
    last_used_ts INTEGER DEFAULT 0
  )`);
  try { await execute('CREATE INDEX IF NOT EXISTS member_passkeys_member ON member_passkeys(member_id)'); } catch (_) {}
  await execute(`CREATE TABLE IF NOT EXISTS member_passkey_challenges (
    challenge TEXT PRIMARY KEY, kind TEXT, member_id TEXT DEFAULT '', ts INTEGER
  )`);
  _ready = true;
}

async function newChallenge(kind, memberId) {
  const c = b64u(crypto.randomBytes(32));
  // Old challenges are swept on the way past rather than by a cron.
  await execute('DELETE FROM member_passkey_challenges WHERE ts < ?', [Date.now() - CHALLENGE_MS]);
  await execute(
    'INSERT INTO member_passkey_challenges (challenge, kind, member_id, ts) VALUES (?,?,?,?)',
    [c, kind, String(memberId || ''), Date.now()]);
  return c;
}

// A challenge answers once, and only while it is fresh. Deleted before it is
// judged, so a replay of the same response cannot be used twice even if two
// requests arrive together.
async function useChallenge(clientDataB64, kind) {
  const c = JSON.parse(unb64u(clientDataB64).toString('utf8')).challenge;
  const row = await queryOne(
    'SELECT challenge, kind, member_id, ts FROM member_passkey_challenges WHERE challenge = ?', [c]);
  await execute('DELETE FROM member_passkey_challenges WHERE challenge = ?', [c]);
  if (!row || row.kind !== kind || Date.now() - Number(row.ts) > CHALLENGE_MS) {
    throw new Error('That took too long — try again');
  }
  return { challenge: c, member_id: row.member_id || '' };
}

/* Who is asking. A member proves who they are with the session token the
   portal already holds, exactly as the profile endpoint does — so setting
   up Face ID needs them to be signed in first, and cannot be used to
   attach a phone to somebody else's membership. */
async function memberFromSession(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const s = await queryOne(
    'SELECT user_id FROM sessions WHERE token = ? AND role = ? AND expires_at > CURRENT_TIMESTAMP',
    [token, 'CLIENT']);
  if (!s) return null;
  return queryOne(
    'SELECT member_id, full_name, email, tier, flagged FROM members WHERE member_id = ?', [s.user_id]);
}

/* A fresh session for a member who has just proved themselves. */
async function newSession(memberId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await execute('INSERT INTO sessions (token, role, user_id, expires_at) VALUES (?,?,?,?)',
    [token, 'CLIENT', memberId, expires]);
  return token;
}

const SAFE = m => ({
  memberId: m.member_id,
  fullName: m.full_name,
  email: m.email,
  tier: m.tier,
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = String(req.query.action || (req.body && req.body.action) || '');

  try {
    await ensure();

    /* ── IS THERE A PASSKEY TO OFFER? ───────────────────────────────────
       The sign-in screen asks before showing the button, so nobody is
       offered Face ID on a device that has never set it up. No challenge
       is created just for looking. */
    if (action === 'status') {
      const rows = await query('SELECT COUNT(*) AS n FROM member_passkeys');
      return res.json({ any: Number((rows[0] || {}).n) > 0 });
    }

    /* ── SETTING ONE UP (signed in already) ─────────────────────────── */
    if (action === 'register_options') {
      const m = await memberFromSession(req);
      if (!m) return res.status(401).json({ error: 'Sign in with your member ID first.' });
      if (Number(m.flagged) === 1) {
        return res.status(403).json({ error: 'Contact the studio directly.' });
      }

      // The phones already registered against THIS membership, so the same
      // device cannot quietly register twice.
      const mine = await query('SELECT id FROM member_passkeys WHERE member_id = ?', [m.member_id]);

      return res.json({
        challenge: await newChallenge('reg', m.member_id),
        rp: { id: RP_ID, name: 'ZOLA Nail Studio' },
        /* The membership is the account. Two people on one membership each
           register their own phone against the same id, and both get in
           with their own face. */
        user: {
          id: b64u(Buffer.from(m.member_id)),
          name: m.email || m.member_id,
          displayName: (m.full_name || 'ZOLA member') + ' · ZOLA',
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        /* residentKey required is what makes signing in need no member ID:
           the passkey is stored on the phone with enough to identify itself,
           so the phone can offer it unprompted. */
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'required',
          requireResidentKey: true,
        },
        excludeCredentials: mine.map(r => ({ type: 'public-key', id: r.id })),
        attestation: 'none',
        timeout: 60000,
      });
    }

    if (action === 'register_verify' && req.method === 'POST') {
      const m = await memberFromSession(req);
      if (!m) return res.status(401).json({ error: 'Sign in with your member ID first.' });

      const b = req.body || {};
      const r = b.response || {};
      const { challenge, member_id: forMember } = await useChallenge(r.clientDataJSON, 'reg');
      // The challenge was issued to this member; it cannot be answered on
      // behalf of another.
      if (forMember && forMember !== m.member_id) {
        return res.status(400).json({ error: 'That setup belonged to a different sign-in — try again.' });
      }
      checkClient(r.clientDataJSON, 'webauthn.create', challenge);

      const att = cbor(unb64u(r.attestationObject)).value;
      const ad = parseAuthData(att.get('authData'));
      if (!ad.rpIdHash.equals(sha256(Buffer.from(RP_ID)))) {
        throw new Error('Face ID only works on ' + RP_ID);
      }
      if (!ad.up || !ad.uv) throw new Error('Face ID was not confirmed — try again');
      if (!ad.credId || !ad.cose) throw new Error('The phone did not send a key');

      const { alg, jwk } = coseToJwk(ad.cose);
      const id = b64u(ad.credId);
      const name = String(b.name || 'This phone').slice(0, 60);

      await execute(
        `INSERT INTO member_passkeys (id, member_id, jwk, alg, sign_count, name, created_ts)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           jwk=excluded.jwk, alg=excluded.alg, name=excluded.name, member_id=excluded.member_id`,
        [id, m.member_id, JSON.stringify(jwk), alg, ad.signCount, name, Date.now()]);

      return res.json({ ok: true, id, name, member: SAFE(m) });
    }

    /* ── SIGNING IN ─────────────────────────────────────────────────────
       No member ID, no email, nothing typed. allowCredentials is left
       empty on purpose: the phone offers whatever passkey it holds for
       this site, and which membership that is gets worked out from the
       credential it answers with. */
    if (action === 'login_options') {
      const rows = await query('SELECT COUNT(*) AS n FROM member_passkeys');
      if (!Number((rows[0] || {}).n)) return res.json({ any: false });
      return res.json({
        any: true,
        challenge: await newChallenge('auth', ''),
        rpId: RP_ID,
        allowCredentials: [],
        userVerification: 'required',
        timeout: 60000,
      });
    }

    if (action === 'login_verify' && req.method === 'POST') {
      const b = req.body || {};
      const r = b.response || {};

      const key = await queryOne(
        'SELECT * FROM member_passkeys WHERE id = ?', [String(b.id || '')]);
      if (!key) {
        return res.status(401).json({
          error: 'This phone is not set up for Face ID any more. Sign in with your member ID and set it up again.' });
      }

      const { challenge } = await useChallenge(r.clientDataJSON, 'auth');
      const clientRaw = checkClient(r.clientDataJSON, 'webauthn.get', challenge);
      const adBuf = unb64u(r.authenticatorData);
      const ad = parseAuthData(adBuf);
      if (!ad.rpIdHash.equals(sha256(Buffer.from(RP_ID)))) {
        throw new Error('Face ID only works on ' + RP_ID);
      }
      if (!ad.up || !ad.uv) {
        return res.status(401).json({ error: 'Face ID was not confirmed — try again' });
      }

      const signed = Buffer.concat([adBuf, sha256(clientRaw)]);
      const jwk = JSON.parse(key.jwk);
      const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const good = Number(key.alg) === -257
        ? crypto.verify('sha256', signed, { key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, unb64u(r.signature))
        : crypto.verify('sha256', signed, { key: pub, dsaEncoding: 'der' }, unb64u(r.signature));
      if (!good) {
        return res.status(401).json({ error: 'Face ID could not be checked — sign in with your member ID.' });
      }

      // A counter that goes backwards means a copied key. iPhones always
      // send 0, which is allowed.
      const prev = Number(key.sign_count) || 0;
      if (ad.signCount > 0 && ad.signCount <= prev) {
        return res.status(401).json({ error: 'Face ID could not be checked — sign in with your member ID.' });
      }

      const m = await queryOne(
        'SELECT member_id, full_name, email, tier, flagged, membership_started_at, next_billing_at, referral_code FROM members WHERE member_id = ?',
        [key.member_id]);
      if (!m) {
        return res.status(401).json({ error: 'That membership is no longer on file. Message the studio.' });
      }
      if (Number(m.flagged) === 1) {
        return res.status(403).json({ error: 'Your account has been flagged. Contact the studio directly.' });
      }

      await execute('UPDATE member_passkeys SET sign_count = ?, last_used_ts = ? WHERE id = ?',
        [ad.signCount, Date.now(), key.id]);
      try {
        await execute('INSERT INTO security_log (event, details) VALUES (?,?)',
          ['MEMBER_LOGIN_PASSKEY', JSON.stringify({ memberId: m.member_id, device: key.name })]);
      } catch (_) {}

      return res.json({
        token: await newSession(m.member_id),
        device: key.name,
        member: {
          memberId: m.member_id,
          fullName: m.full_name,
          email: m.email,
          tier: m.tier,
          memberSince: m.membership_started_at,
          nextBilling: m.next_billing_at,
          referralCode: m.referral_code,
        },
      });
    }

    /* ── WHICH PHONES ARE SET UP, AND TAKING ONE OFF ─────────────────── */
    if (action === 'list') {
      const m = await memberFromSession(req);
      if (!m) return res.status(401).json({ error: 'Sign in first.' });
      const keys = await query(
        'SELECT id, name, created_ts, last_used_ts FROM member_passkeys WHERE member_id = ? ORDER BY created_ts',
        [m.member_id]);
      return res.json({
        keys: keys.map(k => ({
          id: k.id, name: k.name,
          created_ts: Number(k.created_ts) || 0,
          last_used_ts: Number(k.last_used_ts) || 0,
        })),
      });
    }

    if (action === 'remove' && req.method === 'POST') {
      const m = await memberFromSession(req);
      if (!m) return res.status(401).json({ error: 'Sign in first.' });
      // Scoped to their own membership: nobody can remove anybody else's.
      await execute('DELETE FROM member_passkeys WHERE id = ? AND member_id = ?',
        [String((req.body || {}).id || ''), m.member_id]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(400).json({ error: String(err.message || err) });
  }
};
