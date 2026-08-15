// Email marketing: the 10%-off list, and the drop campaigns sent to it.
//
// A drop has four moments worth emailing about — the idea, the tease, the
// launch, and the follow-up — so those exist as starting templates she edits
// rather than blank pages she has to fill every time.
//
// Every send personalises {{name}} per recipient from the list itself, which
// is the whole point: she writes one email, each person reads their own name.
// Mail goes one message per recipient so nobody ever sees another client's
// address in a To: line.
const { query, queryOne, execute, ensureTables } = require('./_team-db');
const { sendEmail } = require('./_notify');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

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
}

const STAGES = {
  idea: {
    label: 'An idea is forming',
    subject: 'something is coming ✦',
    body: `Hi {{name}},

I've been sketching something new. Nothing is finished yet — but I wanted you to hear it here first, before anyone else.

More soon.

— Zahra
ZOLA Nail Studio`,
  },
  coming: {
    label: "It's coming",
    subject: "it's almost here ✦",
    body: `Hi {{name}},

It's nearly ready. Sets are made in small batches, so when this drops it will not last long.

You're on the list, which means you'll get the link before it goes public.

— Zahra
ZOLA Nail Studio`,
  },
  dropped: {
    label: 'It just dropped',
    subject: "it's live ✦",
    body: `Hi {{name}},

It's live right now.

Small batch, first come first served. Shop it here: https://zlux-github.vercel.app/pressons.html

— Zahra
ZOLA Nail Studio`,
  },
  after: {
    label: 'After the drop',
    subject: 'thank you ✦',
    body: `Hi {{name}},

Thank you for being part of this drop. Every set was made by hand, and it means everything that you wear them.

If you missed out, stay close — the next one is already in the works.

— Zahra
ZOLA Nail Studio`,
  },
};

function auth(req) {
  return req.headers['x-ceo-password'] === CEO_PASSWORD;
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// "Maria Lopez" -> "Maria". Falls back to something warm rather than an empty
// greeting, because "Hi ," reads worse than no name at all.
function firstName(name) {
  const n = String(name || '').trim().split(/\s+/)[0];
  if (!n || /^(client|guest|press-on)$/i.test(n)) return 'love';
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function personalise(text, name) {
  return String(text || '').replace(/\{\{\s*name\s*\}\}/gi, firstName(name));
}

// Plain text she typed -> a simple branded email, links kept clickable.
function toHtml(text) {
  const body = esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#B6A588">$1</a>')
    .replace(/\n/g, '<br>');
  return `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:28px">
  <div style="max-width:520px;margin:0 auto;background:#fff;padding:32px 28px;border:1px solid #eee5d8">
    <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:3px;color:#0D0D0D;margin-bottom:22px">ZOLA</div>
    <div style="font-size:15px;line-height:1.75;color:#3a3027">${body}</div>
    <div style="margin-top:26px;padding-top:16px;border-top:1px solid #eee5d8;font-size:11px;color:#8C7A5E">
      You're getting this because you joined the ZOLA list. Reply to this email to be taken off it.
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

    // ── PUBLIC: join the list for 10% off ──
    if (req.method === 'POST' && action === 'subscribe') {
      const name = String((req.body || {}).name || '').trim().slice(0, 120);
      const email = String((req.body || {}).email || '').trim().toLowerCase().slice(0, 160);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email.' });
      }
      const codeRow = await queryOne("SELECT value FROM site_settings WHERE key='welcome_code'").catch(() => null);
      const code = (codeRow && codeRow.value) || 'ZOLA10';

      const existing = await queryOne('SELECT id, marketing_opt_in FROM clients WHERE email=?', [email]);
      if (existing) {
        // Already known — opt them in, keep the name we have if they left it blank
        await execute('UPDATE clients SET marketing_opt_in=1' + (name ? ', name=?' : '') + ' WHERE id=?',
          name ? [name, existing.id] : [existing.id]);
      } else {
        await execute(
          'INSERT INTO clients (name, email, marketing_opt_in, created_ts) VALUES (?,?,1,?)',
          [name || '', email, Date.now()]
        );
      }

      // Send the code straight away — a discount promised and not delivered is
      // worse than never offering one.
      let emailed = false;
      try {
        const text = `Hi {{name}},\n\nWelcome to ZOLA ✦\n\nHere's 10% off your first booking or press-on order:\n\n${code}\n\nJust mention it when you book, or use it at checkout.\n\n— Zahra\nZOLA Nail Studio`;
        const r = await sendEmail(email, 'Your 10% off ✦', toHtml(personalise(text, name)));
        emailed = !!(r && r.sent);
      } catch (_) {}

      return res.json({ ok: true, code, emailed });
    }

    if (!auth(req)) return res.status(401).json({ error: 'Unauthorized' });

    // ── OWNER: the list + past campaigns + the starting templates ──
    if (req.method === 'GET' && (action === 'overview' || !action)) {
      const subs = await query(
        "SELECT id, name, email, created_ts FROM clients WHERE marketing_opt_in=1 AND email IS NOT NULL AND email!='' ORDER BY created_ts DESC"
      );
      const campaigns = await query('SELECT * FROM campaigns ORDER BY id DESC LIMIT 25');
      const codeRow = await queryOne("SELECT value FROM site_settings WHERE key='welcome_code'").catch(() => null);
      return res.json({
        subscribers: subs,
        count: subs.length,
        campaigns,
        stages: Object.entries(STAGES).map(([k, v]) => ({ stage: k, ...v })),
        welcome_code: (codeRow && codeRow.value) || 'ZOLA10',
      });
    }

    // ── OWNER: preview exactly what one person will receive ──
    if (req.method === 'POST' && action === 'preview') {
      const { subject, body, name } = req.body || {};
      return res.json({
        subject: personalise(subject, name || 'Maria'),
        text: personalise(body, name || 'Maria'),
        html: toHtml(personalise(body, name || 'Maria')),
      });
    }

    // ── OWNER: send to the whole list, one personalised message each ──
    if (req.method === 'POST' && action === 'send') {
      const stage = String((req.body || {}).stage || 'idea');
      const subject = String((req.body || {}).subject || '').trim();
      const body = String((req.body || {}).body || '').trim();
      const testTo = String((req.body || {}).test_to || '').trim().toLowerCase();
      if (!subject || !body) return res.status(400).json({ error: 'Subject and message are both required' });

      // Test send goes to one address and is never recorded as a campaign.
      // sendEmail returns { sent, why } — read .sent, never the object itself,
      // or a failed send reports as success and she is left wondering where
      // the mail went. Pass `why` straight through so the real provider error
      // is visible instead of a generic "failed".
      if (testTo) {
        const r = await sendEmail(testTo, personalise(subject, 'Maria'), toHtml(personalise(body, 'Maria')));
        const sent = !!(r && r.sent);
        return res.json({ ok: sent, test: true, sent: sent ? 1 : 0, why: (r && r.why) || 'unknown' });
      }

      const subs = await query(
        "SELECT name, email FROM clients WHERE marketing_opt_in=1 AND email IS NOT NULL AND email!=''"
      );
      if (!subs.length) return res.status(400).json({ error: 'Nobody has joined the list yet.' });

      let sent = 0, failed = 0;
      const failures = [];
      let lastWhy = '';
      for (const s of subs) {
        try {
          const r = await sendEmail(s.email, personalise(subject, s.name), toHtml(personalise(body, s.name)));
          if (r && r.sent) sent++;
          else { failed++; failures.push(s.email); lastWhy = (r && r.why) || 'unknown'; }
        } catch (e) { failed++; failures.push(s.email); lastWhy = String(e.message || e); }
      }
      await execute(
        'INSERT INTO campaigns (stage, subject, body, sent_ts, sent_count, failed_count, created_ts) VALUES (?,?,?,?,?,?,?)',
        [stage, subject, body, Date.now(), sent, failed, Date.now()]
      );
      return res.json({ ok: true, sent, failed, total: subs.length, failures: failures.slice(0, 10), why: lastWhy });
    }

    // ── OWNER: remove somebody from the list ──
    if (req.method === 'DELETE' && action === 'subscriber') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await execute('UPDATE clients SET marketing_opt_in=0 WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
