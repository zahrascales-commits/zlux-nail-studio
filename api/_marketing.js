// Mass email: pick who it goes to, write it, send it.
//
// This used to be a drop-campaign tool with four pre-written templates and
// exactly one audience — whoever had ticked the marketing box. That is a
// tiny fraction of the people Zahra actually needs to reach. She has sixty
// eight clients in the book and most of them never saw a marketing checkbox
// because they were imported from the old system.
//
// So audiences are first-class now: everyone, members by tier, drop-ins,
// people who have gone quiet, or a hand-picked few. And the message is a
// blank page, because a template she has to delete before writing is worse
// than no template.
//
// Mail goes one message per recipient, so nobody ever sees another client's
// address in a To: line, and every message carries a way out.
const { query, queryOne, execute, ensureTables } = require('./_team-db');
const { sendEmail } = require('./_notify');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

// One request cannot sit there sending seventy emails — a serverless
// function is killed long before that finishes, and a send that dies
// halfway is worse than one that never started, because she cannot tell
// who got it. The page sends a batch at a time and drives the loop.
const BATCH = 12;

async function ensure() {
  await ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT DEFAULT 'idea',
    subject TEXT DEFAULT '',
    body TEXT DEFAULT '',
    sent_ts INTEGER,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_ts INTEGER
  )`);
  for (const sql of [
    "ALTER TABLE campaigns ADD COLUMN audience TEXT DEFAULT ''",
    "ALTER TABLE campaigns ADD COLUMN total_count INTEGER DEFAULT 0",
    "ALTER TABLE campaigns ADD COLUMN status TEXT DEFAULT 'sent'",
  ]) { try { await execute(sql); } catch (_) {} }

  // Drafts, so a message she is half way through is still there tomorrow.
  await execute(`CREATE TABLE IF NOT EXISTS email_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT DEFAULT '',
    subject TEXT DEFAULT '',
    body TEXT DEFAULT '',
    audience TEXT DEFAULT 'everyone',
    updated_ts INTEGER
  )`);

  // Somebody who asks to be left alone must stay left alone, whichever
  // audience they would otherwise fall into. One list, checked on every send.
  await execute(`CREATE TABLE IF NOT EXISTS email_optout (
    email TEXT PRIMARY KEY,
    ts INTEGER
  )`);
}

const auth = req => req.headers['x-ceo-password'] === CEO_PASSWORD;
const norm = e => String(e || '').trim().toLowerCase();
const valid = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm(e));

function firstName(name) {
  const n = String(name || '').trim();
  return n ? n.split(/\s+/)[0] : 'there';
}
function personalise(text, name) {
  return String(text || '').replace(/\{\{\s*name\s*\}\}/gi, firstName(name));
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── WHO IT GOES TO ───────────────────────────────────────────────────────
//
// Every audience resolves to the same shape: { name, email, why }. `why` is
// shown back to her before she sends, so "everyone" is never a black box.
const AUDIENCES = [
  { key: 'everyone',   label: 'Everyone with an email',  hint: 'Every client in the book, plus every member.' },
  { key: 'members',    label: 'All members',             hint: 'Signature, Luxe and Black Card.' },
  { key: 'black_card', label: 'Black Card only',         hint: 'Your top tier.' },
  { key: 'luxe',       label: 'Luxe only',               hint: '' },
  { key: 'signature',  label: 'Signature only',          hint: '' },
  { key: 'dropins',    label: 'Drop-ins',                hint: 'Clients who are not members.' },
  { key: 'lapsed',     label: 'Gone quiet (90+ days)',   hint: 'Clients who have not been in for three months.' },
  { key: 'optin',      label: 'Marketing list only',     hint: 'Only people who ticked the box.' },
  { key: 'custom',     label: 'Just the ones I pick',    hint: 'Choose them by hand.' },
];

async function loadPeople() {
  let clients = [];
  try {
    clients = await query(
      "SELECT id, name, email, marketing_opt_in, last_appointment, last_visit FROM clients WHERE email IS NOT NULL AND email != ''");
  } catch (_) {}

  let members = [];
  try {
    const main = require('./_db');
    try {
      members = await main.query(
        "SELECT full_name AS name, email, tier, demo FROM members WHERE email IS NOT NULL AND email != ''");
    } catch (_) {
      members = await main.query(
        "SELECT full_name AS name, email, tier FROM members WHERE email IS NOT NULL AND email != ''");
    }
  } catch (_) {}
  members = members.filter(m => !Number(m.demo));

  let optedOut = new Set();
  try {
    const rows = await query('SELECT email FROM email_optout');
    optedOut = new Set(rows.map(r => norm(r.email)));
  } catch (_) {}

  return { clients, members, optedOut };
}

function daysSince(ds) {
  const d = new Date(String(ds || '').slice(0, 10) + 'T12:00:00');
  if (isNaN(d)) return null;
  return Math.round((Date.now() - d.getTime()) / 86400000);
}

// The overview screen asks for eight audience counts at once. Loading every
// client and every member eight times over made opening the tab visibly
// slow, so one load is passed through when the caller has already done it.
async function resolveAudience(key, picked, preloaded) {
  const { clients, members, optedOut } = preloaded || await loadPeople();

  const memberByEmail = {};
  for (const m of members) if (valid(m.email)) memberByEmail[norm(m.email)] = m;

  const out = new Map();   // email -> { name, email, why }
  const add = (name, email, why) => {
    const e = norm(email);
    if (!valid(e) || optedOut.has(e)) return;
    if (!out.has(e)) out.set(e, { name: String(name || '').trim(), email: e, why });
    else if (!out.get(e).name && name) out.get(e).name = String(name).trim();
  };

  const tierOf = e => (memberByEmail[norm(e)] || {}).tier || '';

  if (key === 'custom') {
    const want = new Set((picked || []).map(norm));
    for (const m of members) if (want.has(norm(m.email))) add(m.name, m.email, 'picked');
    for (const c of clients) if (want.has(norm(c.email))) add(c.name, c.email, 'picked');
    return [...out.values()];
  }

  if (key === 'optin') {
    for (const c of clients) if (Number(c.marketing_opt_in)) add(c.name, c.email, 'on the marketing list');
    return [...out.values()];
  }

  if (key === 'members' || key === 'black_card' || key === 'luxe' || key === 'signature') {
    const want = { members: null, black_card: 'BLACK_CARD', luxe: 'LUXE', signature: 'SIGNATURE' }[key];
    for (const m of members) {
      if (want && String(m.tier) !== want) continue;
      add(m.name, m.email, String(m.tier || 'member').replace('_', ' ').toLowerCase());
    }
    return [...out.values()];
  }

  if (key === 'dropins') {
    for (const c of clients) {
      if (tierOf(c.email)) continue;
      add(c.name, c.email, 'drop-in');
    }
    return [...out.values()];
  }

  if (key === 'lapsed') {
    for (const c of clients) {
      const d = daysSince(c.last_appointment || c.last_visit);
      if (d == null || d <= 90) continue;
      add(c.name, c.email, d + ' days since their last visit');
    }
    return [...out.values()];
  }

  // everyone
  for (const m of members) add(m.name, m.email, String(m.tier || 'member').replace('_', ' ').toLowerCase());
  for (const c of clients) add(c.name, c.email, tierOf(c.email) ? 'member' : 'client');
  return [...out.values()];
}

// ── THE EMAIL ITSELF ─────────────────────────────────────────────────────
function toHtml(text, email) {
  const body = esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#B6A588">$1</a>')
    .replace(/\n/g, '<br>');

  // A one-click way out, in every message. It is the law in most places, it
  // is what keeps a sending domain out of spam folders, and a client who
  // cannot leave quietly leaves loudly.
  const site = process.env.PUBLIC_BASE_URL || 'https://zolanailstudio.com';
  const out = site + '/api/marketing?action=unsubscribe&e=' + encodeURIComponent(email || '');

  return `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:28px">
  <div style="max-width:520px;margin:0 auto;background:#fff;padding:32px 28px;border:1px solid #eee5d8">
    <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:3px;color:#0D0D0D;margin-bottom:22px">ZOLA</div>
    <div style="font-size:15px;line-height:1.75;color:#3a3027">${body}</div>
    <div style="margin-top:26px;padding-top:16px;border-top:1px solid #eee5d8;font-size:11px;color:#8C7A5E;line-height:1.7">
      ZOLA Nail Studio · Porterville, California<br>
      You're receiving this because you're a client of ZOLA Nail Studio.
      <a href="${out}" style="color:#8C7A5E">Unsubscribe</a>
    </div>
  </div></div>`;
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CEO-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensure();

    // ── PUBLIC: one click, and they stop hearing from us ──
    if (req.method === 'GET' && action === 'unsubscribe') {
      const email = norm(req.query.e);
      if (valid(email)) {
        try { await execute('INSERT OR REPLACE INTO email_optout (email, ts) VALUES (?,?)', [email, Date.now()]); } catch (_) {}
        try { await execute('UPDATE clients SET marketing_opt_in=0 WHERE lower(email)=?', [email]); } catch (_) {}
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed — ZOLA Nail Studio</title>
<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div style="max-width:440px;background:#fff;border:1px solid #eee5d8;padding:36px 32px;text-align:center">
    <div style="font-family:Georgia,serif;font-size:24px;letter-spacing:4px;margin-bottom:18px">ZOLA</div>
    <p style="font-size:15px;line-height:1.8;color:#3a3027;margin:0 0 14px">You're unsubscribed. We won't email you again.</p>
    <p style="font-size:13px;line-height:1.8;color:#8C7A5E;margin:0">
      Appointment confirmations for bookings you make will still come through — those aren't marketing.<br><br>
      Changed your mind? Just tell Zahra next time you're in.
    </p>
  </div></div>`);
    }

    // ── PUBLIC: join the 10%-off list ──
    if (req.method === 'POST' && action === 'subscribe') {
      const name = String((req.body || {}).name || '').trim().slice(0, 120);
      const email = norm((req.body || {}).email).slice(0, 160);
      if (!valid(email)) return res.status(400).json({ error: 'Please enter a valid email.' });

      const codeRow = await queryOne("SELECT value FROM site_settings WHERE key='welcome_code'").catch(() => null);
      const code = (codeRow && codeRow.value) || 'ZOLA10';

      try { await execute('DELETE FROM email_optout WHERE email=?', [email]); } catch (_) {}

      const existing = await queryOne('SELECT id FROM clients WHERE lower(email)=?', [email]);
      if (existing) {
        await execute('UPDATE clients SET marketing_opt_in=1' + (name ? ', name=?' : '') + ' WHERE id=?',
          name ? [name, existing.id] : [existing.id]);
      } else {
        await execute('INSERT INTO clients (name, email, marketing_opt_in, created_ts) VALUES (?,?,1,?)',
          [name || '', email, Date.now()]);
      }

      let emailed = false;
      try {
        const text = `Hi {{name}},\n\nWelcome to ZOLA ✦\n\nHere's 10% off your first booking or press-on order:\n\n${code}\n\nJust mention it when you book, or use it at checkout.\n\n— Zahra\nZOLA Nail Studio`;
        const r = await sendEmail(email, 'Your 10% off ✦', toHtml(personalise(text, name), email));
        emailed = !!(r && r.sent);
      } catch (_) {}

      return res.json({ ok: true, code, emailed });
    }

    if (!auth(req)) return res.status(401).json({ error: 'Unauthorized' });

    // ── OWNER: everything the screen needs ──
    if (req.method === 'GET' && (action === 'overview' || !action)) {
      const people = await loadPeople();
      const counts = {};
      for (const a of AUDIENCES) {
        if (a.key === 'custom') { counts[a.key] = 0; continue; }
        counts[a.key] = (await resolveAudience(a.key, [], people)).length;
      }
      const everyone = await resolveAudience('everyone', [], people);
      const campaigns = await query('SELECT * FROM campaigns ORDER BY id DESC LIMIT 20').catch(() => []);
      const drafts = await query('SELECT * FROM email_drafts ORDER BY updated_ts DESC LIMIT 20').catch(() => []);
      const optedOut = await query('SELECT email, ts FROM email_optout ORDER BY ts DESC LIMIT 100').catch(() => []);
      const codeRow = await queryOne("SELECT value FROM site_settings WHERE key='welcome_code'").catch(() => null);

      let from = '', replyTo = '';
      try {
        const { providerStatus } = require('./_notify');
        const p = await providerStatus();
        from = p.from_email || '';
      } catch (_) {}
      try {
        const r = await queryOne("SELECT value FROM site_settings WHERE key='notify_reply_to'");
        replyTo = (r && r.value) || 'zolastudioempire@gmail.com';
      } catch (_) { replyTo = 'zolastudioempire@gmail.com'; }

      return res.json({
        audiences: AUDIENCES.map(a => ({ ...a, count: counts[a.key] || 0 })),
        everyone,                        // for the hand-pick list
        count: everyone.length,
        campaigns, drafts,
        opted_out: optedOut,
        from_email: from,
        reply_to: replyTo,
        batch: BATCH,
        welcome_code: (codeRow && codeRow.value) || 'ZOLA10',
      });
    }

    // ── OWNER: who exactly would receive this ──
    if (req.method === 'POST' && action === 'audience') {
      const { audience, picked } = req.body || {};
      const people = await resolveAudience(String(audience || 'everyone'), picked || []);
      return res.json({ count: people.length, people: people.slice(0, 400) });
    }

    // ── OWNER: exactly what one person will see ──
    if (req.method === 'POST' && action === 'preview') {
      const { subject, body, name, email } = req.body || {};
      const who = name || 'Maria';
      return res.json({
        subject: personalise(subject, who),
        text: personalise(body, who),
        html: toHtml(personalise(body, who), email || 'someone@example.com'),
      });
    }

    // ── OWNER: drafts ──
    if (req.method === 'POST' && action === 'save_draft') {
      const { id, name, subject, body, audience } = req.body || {};
      const now = Date.now();
      if (id) {
        await execute('UPDATE email_drafts SET name=?, subject=?, body=?, audience=?, updated_ts=? WHERE id=?',
          [String(name || '').slice(0, 120), String(subject || '').slice(0, 200),
           String(body || '').slice(0, 20000), String(audience || 'everyone'), now, Number(id)]);
        return res.json({ ok: true, id: Number(id) });
      }
      const r = await execute(
        'INSERT INTO email_drafts (name, subject, body, audience, updated_ts) VALUES (?,?,?,?,?)',
        [String(name || '').slice(0, 120), String(subject || '').slice(0, 200),
         String(body || '').slice(0, 20000), String(audience || 'everyone'), now]);
      return res.json({ ok: true, id: Number(r.lastInsertRowid) || null });
    }

    if (req.method === 'DELETE' && action === 'draft') {
      await execute('DELETE FROM email_drafts WHERE id=?', [Number((req.body || {}).id)]);
      return res.json({ ok: true });
    }

    // ── OWNER: a test to one address, recorded nowhere ──
    if (req.method === 'POST' && action === 'test') {
      const { subject, body, to } = req.body || {};
      const dest = norm(to);
      if (!valid(dest)) return res.status(400).json({ error: 'Where should the test go?' });
      if (!String(subject || '').trim() || !String(body || '').trim()) {
        return res.status(400).json({ error: 'Subject and message are both needed.' });
      }
      const r = await sendEmail(dest, personalise(subject, 'Maria'), toHtml(personalise(body, 'Maria'), dest));
      return res.json({ ok: !!(r && r.sent), why: (r && r.why) || 'unknown' });
    }

    // ── OWNER: send, one batch per request ──
    //
    // The page calls this repeatedly with a rising offset. Splitting it that
    // way is what makes sending to the whole book possible at all: a single
    // request would be killed long before seventy messages were away, and
    // she would have no way of knowing who had been reached.
    if (req.method === 'POST' && action === 'send') {
      const audience = String((req.body || {}).audience || 'everyone');
      const picked = (req.body || {}).picked || [];
      const subject = String((req.body || {}).subject || '').trim();
      const body = String((req.body || {}).body || '').trim();
      const offset = Math.max(0, Number((req.body || {}).offset) || 0);
      let campaignId = Number((req.body || {}).campaign_id) || 0;

      if (!subject || !body) return res.status(400).json({ error: 'Subject and message are both needed.' });

      const people = await resolveAudience(audience, picked);
      if (!people.length) return res.status(400).json({ error: 'Nobody is in that group.' });

      if (!campaignId) {
        const r = await execute(
          `INSERT INTO campaigns (stage, subject, body, audience, total_count, sent_ts, sent_count, failed_count, status, created_ts)
           VALUES (?,?,?,?,?,?,0,0,'sending',?)`,
          ['broadcast', subject, body, audience, people.length, Date.now(), Date.now()]);
        campaignId = Number(r.lastInsertRowid) || 0;
      }

      const slice = people.slice(offset, offset + BATCH);
      let sent = 0, failed = 0, lastWhy = '';
      const failures = [];
      for (const p of slice) {
        try {
          const r = await sendEmail(p.email, personalise(subject, p.name), toHtml(personalise(body, p.name), p.email));
          if (r && r.sent) sent++;
          else { failed++; failures.push(p.email); lastWhy = (r && r.why) || 'unknown'; }
        } catch (e) { failed++; failures.push(p.email); lastWhy = String(e.message || e); }
      }

      const done = offset + slice.length >= people.length;
      if (campaignId) {
        try {
          await execute(
            'UPDATE campaigns SET sent_count = sent_count + ?, failed_count = failed_count + ?, status=? WHERE id=?',
            [sent, failed, done ? 'sent' : 'sending', campaignId]);
        } catch (_) {}
      }

      return res.json({
        ok: true, campaign_id: campaignId,
        sent, failed, failures: failures.slice(0, 10), why: lastWhy,
        next_offset: offset + slice.length,
        total: people.length,
        done,
      });
    }

    // ── OWNER: put somebody back on, or take them off by hand ──
    if (req.method === 'POST' && action === 'resubscribe') {
      const email = norm((req.body || {}).email);
      if (!valid(email)) return res.status(400).json({ error: 'Which address?' });
      await execute('DELETE FROM email_optout WHERE email=?', [email]);
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE' && action === 'subscriber') {
      const { id, email } = req.body || {};
      if (email && valid(email)) {
        await execute('INSERT OR REPLACE INTO email_optout (email, ts) VALUES (?,?)', [norm(email), Date.now()]);
      }
      if (id) await execute('UPDATE clients SET marketing_opt_in=0 WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports.AUDIENCES = AUDIENCES;
module.exports.resolveAudience = resolveAudience;
