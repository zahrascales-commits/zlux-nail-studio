// The emails she writes, and when they go.
//
// Until now every automatic message was written in code. Changing a word
// meant changing a file, so in practice the words never changed and she had
// no say in what her own studio said to her clients. This moves all of it
// into rules she owns: what it says, who gets it, and how long after.
//
// A rule is attached to something that happens — somebody joins, somebody
// books, somebody is billed, somebody leaves. That matters more than it
// sounds: a rule keyed to an event applies to everybody who does that thing
// from now on, including people who are not in the system yet. Picking names
// off a list would only ever reach the people already there.
const { query, queryOne, execute } = require('./_team-db');

/* Everything that can set an email off. The key is stored on the rule, so
   these names are permanent once used. */
const TRIGGERS = [
  /* The one everybody gets. It carries the deposit link and the photo link,
     and it goes out however the appointment was made — booked online, or
     written in by hand at the studio. Leaving it out of here meant the most
     important email the studio sends was the only one she could not
     change. */
  { key: 'booking_confirmation', label: 'Someone books — their confirmation', who: 'any',
    note: 'The deposit link and the photo link. Goes to everyone who books, however they booked. Leave this off and the built-in one is sent.' },
  { key: 'membership_bought', label: 'Someone buys a membership', who: 'member',
    note: 'Goes to the new member. Their welcome.' },
  { key: 'member_booked', label: 'A member books an appointment', who: 'member',
    note: 'Goes to the member, every time they book.' },
  { key: 'member_billed', label: 'A member is billed', who: 'member',
    note: 'Goes when their card is charged for the membership.' },
  { key: 'dropin_booked', label: 'A drop-in books an appointment', who: 'dropin',
    note: 'Goes to anyone booking who is not a member.' },
  { key: 'visit_finished', label: 'Someone checks out', who: 'any',
    note: 'Goes after they leave the studio.' },
  { key: 'artist_assigned', label: 'An artist is given an appointment', who: 'worker',
    note: 'Goes to the artist, not the client.' },
  { key: 'worker_reminder', label: 'A reminder for the team', who: 'worker',
    note: 'Tasks and goals. Sent when you send it, or on a delay.' },
];

// Who a rule is allowed to reach, on top of what the trigger already implies.
const AUDIENCES = [
  { key: 'everyone', label: 'Everyone this applies to' },
  { key: 'members', label: 'Members only' },
  { key: 'dropins', label: 'Drop-ins only' },
  { key: 'ESSENTIAL', label: 'Essential members' },
  { key: 'ELITE', label: 'Elite members' },
  { key: 'SIGNATURE', label: 'Signature members' },
  { key: 'LUXE', label: 'Luxe members' },
  { key: 'BLACK_CARD', label: 'Black Card members' },
];

/* What she can drop into the words. Kept small and obvious — a merge field
   nobody understands is a merge field that ships empty. */
const FIELDS = [
  { tag: '{{first_name}}', note: 'Just their first name' },
  { tag: '{{name}}', note: 'Their full name' },
  { tag: '{{service}}', note: 'What they booked' },
  { tag: '{{date}}', note: 'The day, written out' },
  { tag: '{{time}}', note: 'The time, in 12-hour' },
  { tag: '{{artist}}', note: 'Who is doing them' },
  { tag: '{{tier}}', note: 'Their membership name' },
  { tag: '{{amount}}', note: 'The amount, where there is one' },
  { tag: '{{link}}', note: 'Their appointment link — deposit and photos' },
  { tag: '{{studio}}', note: 'ZOLA Nail Studio' },
];

let ready = null;
async function ensureTables() {
  if (ready) return ready;
  ready = (async function () {
    await execute(`CREATE TABLE IF NOT EXISTS email_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_key TEXT NOT NULL,
      name TEXT DEFAULT '',
      subject TEXT DEFAULT '',
      body TEXT DEFAULT '',
      audience TEXT DEFAULT 'everyone',
      delay_minutes INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_ts INTEGER,
      updated_ts INTEGER
    )`);
    await execute(`CREATE TABLE IF NOT EXISTS email_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER,
      trigger_key TEXT DEFAULT '',
      recipient TEXT,
      subject TEXT DEFAULT '',
      body TEXT DEFAULT '',
      send_after_ts INTEGER,
      sent_ts INTEGER DEFAULT 0,
      status TEXT DEFAULT 'waiting',
      detail TEXT DEFAULT '',
      created_ts INTEGER
    )`);
    try { await execute('CREATE INDEX IF NOT EXISTS email_queue_due ON email_queue (sent_ts, send_after_ts)'); } catch (_) {}
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Her words, with the details filled in. Anything she did not supply a value
   for is removed rather than left showing {{like_this}} to a client. */
function fill(text, data) {
  let out = String(text || '');
  for (const f of FIELDS) {
    const key = f.tag.replace(/[{}]/g, '');
    const val = data && data[key] != null ? String(data[key]) : '';
    out = out.split(f.tag).join(val);
  }
  // Anything she invented that we do not know about.
  return out.replace(/\{\{[a-z_]+\}\}/gi, '');
}

/* Her words are typed as plain text, so line breaks are what she meant.
   Wrapped in the studio's frame so every automatic email still looks like
   it came from the same place. */
/* The appointment link is the point of the email it appears in, so it gets
   a button rather than a bare URL sitting in the middle of a sentence. The
   tag is swapped for a marker before her words are escaped, then the marker
   becomes real markup afterwards — escaping it as text would print the
   markup at the client instead of rendering it. */
const LINK_SLOT = '@@ZOLA_APPOINTMENT_LINK@@';

function linkButton(href, label) {
  return '<div style="text-align:center;margin:4px 0 22px">'
    + '<a href="' + esc(href) + '" style="display:inline-block;background:#0D0D0D;color:#F5EEE8;'
    + 'text-decoration:none;padding:14px 26px;font-size:14px;letter-spacing:2px;'
    + 'text-transform:uppercase">' + esc(label || 'Open my appointment') + '</a></div>';
}

function toHtml(bodyText, data) {
  const href = (data && data.link) || '';
  const wantsButton = String(bodyText || '').indexOf('{{link}}') >= 0 && !!href;
  const staged = wantsButton ? String(bodyText).split('{{link}}').join(LINK_SLOT) : bodyText;

  const filled = fill(staged, data);
  const paras = esc(filled)
    .split(/\n{2,}/)
    .map(p => '<p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 16px">'
      + p.replace(/\n/g, '<br>') + '</p>')
    .join('');

  // A link she typed out in full is worth making tappable.
  const withLink = paras.replace(/(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#8B6A3E">$1</a>');

  const bodyHtml = wantsButton
    ? withLink.split(LINK_SLOT).join(linkButton(href, (data && data.link_label) || ''))
    : withLink;

  return `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px 14px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #eee5d8">
    <div style="background:#0D0D0D;padding:26px 24px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:6px;color:#F5EEE8">ZOLA</div>
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8B6A3E;margin-top:6px">Nail Studio · Porterville</div>
    </div>
    <div style="padding:28px 24px">${bodyHtml}</div>
    <div style="background:#faf7f4;padding:16px 24px;text-align:center;border-top:1px solid #eee5d8">
      <p style="font-size:12px;color:#8C7A5E;margin:0;line-height:1.7">
        ZOLA Nail Studio · Porterville, California<br>Just reply to this email to reach us.
      </p>
    </div>
  </div>
</div>`;
}

/* The wording of the built-in confirmation, as editable text. Offered as
   the starting point when she chooses to take this email over, so she is
   changing what already goes out rather than facing an empty box. */
const BUILT_IN = {
  booking_confirmation: {
    name: 'Booking confirmation',
    subject: "You're booked in — {{date}}",
    body: [
      'Hi {{first_name}},',
      '',
      "You're booked in with {{artist}} for {{service}} on {{date}} at {{time}}.",
      '',
      'Everything for this visit lives on one page — pay your deposit, and send me a photo of the nails you want. It takes a minute and it means we start on the right thing.',
      '',
      '{{link}}',
      '',
      'See you soon,',
      'Zahra ✦ ZOLA Nail Studio',
    ].join('\n'),
  },
};

function builtIn(triggerKey) { return BUILT_IN[String(triggerKey)] || null; }

/* Her own version of an email, if she has written and switched one on.
   Returns null when she has not, which is the signal to send the built-in
   one — so nothing changes until she decides it should. */
async function renderFor(triggerKey, data) {
  try {
    await ensureTables();
    const rows = await query(
      'SELECT * FROM email_rules WHERE trigger_key=? AND active=1 ORDER BY id LIMIT 1',
      [String(triggerKey)]);
    const rule = rows && rows[0];
    if (!rule) return null;
    if (!audienceAllows(rule, data)) return null;

    /* Her wording, with a hole in it, is worse than the built-in email it
       would replace. Falls back rather than sending a broken one. */
    try {
      const gaps = require('./_email-fields').missingFor(rule.body, rule.subject, data);
      if (gaps.length) return null;
    } catch (_) {}
    return {
      rule_id: rule.id,
      subject: fill(rule.subject || '', data).trim() || 'A note from ZOLA',
      html: toHtml(rule.body || '', data),
    };
  } catch (_) { return null; }
}

// ── the rules themselves ──────────────────────────────────────────────────

async function listRules() {
  await ensureTables();
  return query('SELECT * FROM email_rules ORDER BY trigger_key, id');
}

async function saveRule(r) {
  await ensureTables();
  const now = Date.now();
  const trigger = String(r.trigger_key || '');
  if (!TRIGGERS.some(t => t.key === trigger)) throw new Error('That is not something that can set an email off.');
  const delay = Math.max(0, Math.min(60 * 24 * 30, Math.round(Number(r.delay_minutes) || 0)));

  if (r.id) {
    await execute(
      `UPDATE email_rules SET trigger_key=?, name=?, subject=?, body=?, audience=?,
         delay_minutes=?, active=?, updated_ts=? WHERE id=?`,
      [trigger, r.name || '', r.subject || '', r.body || '', r.audience || 'everyone',
       delay, r.active ? 1 : 0, now, Number(r.id)]);
    return Number(r.id);
  }
  const out = await execute(
    `INSERT INTO email_rules (trigger_key, name, subject, body, audience, delay_minutes, active, created_ts, updated_ts)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [trigger, r.name || '', r.subject || '', r.body || '', r.audience || 'everyone',
     delay, r.active ? 1 : 0, now, now]);
  return out.lastInsertRowid;
}

async function deleteRule(id) {
  await ensureTables();
  await execute('DELETE FROM email_rules WHERE id=?', [Number(id)]);
}

/* Does this rule apply to this person? The trigger has already decided what
   happened; this only narrows it further. */
function audienceAllows(rule, data) {
  const a = String(rule.audience || 'everyone');
  if (a === 'everyone') return true;
  const tier = String((data && data.tier_key) || '').toUpperCase();
  if (a === 'members') return !!tier;
  if (a === 'dropins') return !tier;
  return tier === a.toUpperCase();
}

// ── firing ────────────────────────────────────────────────────────────────

/* Something happened. Any rule watching for it, and allowed to reach this
   person, is either sent now or put in the queue for later.

   Never throws: an email rule must not be able to take a booking down. */
async function fire(triggerKey, data) {
  try {
    await ensureTables();
    const rules = await query(
      'SELECT * FROM email_rules WHERE trigger_key=? AND active=1', [String(triggerKey)]);
    if (!rules.length) return { fired: 0 };

    const to = String((data && data.email) || '').trim();
    if (!to || !/@/.test(to)) return { fired: 0, why: 'no email address' };

    let fired = 0, held = 0;
    const holdReasons = [];
    for (const rule of rules) {
      if (!audienceAllows(rule, data)) continue;

      /* Nothing goes out with a hole in it. A rule that says "Hi
         {{first_name}}" when there is no name resolves to "Hi ,", and one
         that offers {{link}} with no token sends somebody to a page that
         cannot know who they are. Both look fine leaving here and land
         broken. */
      try {
        const gaps = require('./_email-fields').missingFor(rule.body, rule.subject, data);
        if (gaps.length) {
          held++;
          holdReasons.push({ rule: rule.name || rule.subject || rule.id, missing: gaps });
          await execute(
            `INSERT INTO email_queue (rule_id, trigger_key, recipient, subject, body, send_after_ts, sent_ts, status, detail, created_ts)
             VALUES (?,?,?,?,?,?,0,'held',?,?)`,
            [rule.id, triggerKey, to, fill(rule.subject || '', data), '',
             Date.now(), 'nothing to put in: ' + gaps.join(', '), Date.now()]);
          continue;
        }
      } catch (_) { /* the check failing must not stop a good email */ }

      const subject = fill(rule.subject || '', data).trim() || 'A note from ZOLA';
      const html = toHtml(rule.body || '', data);
      const delay = Math.max(0, Number(rule.delay_minutes) || 0);

      if (delay === 0) {
        // "Instantly" has to mean instantly, not "next time the site is busy".
        const notify = require('./_notify');
        const out = await notify.sendEmail(to, subject, html, { kind: 'rule:' + triggerKey });
        await execute(
          `INSERT INTO email_queue (rule_id, trigger_key, recipient, subject, body, send_after_ts, sent_ts, status, detail, created_ts)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [rule.id, triggerKey, to, subject, html, Date.now(),
           out && out.sent ? Date.now() : 0, out && out.sent ? 'sent' : 'failed',
           (out && out.why) || '', Date.now()]);
      } else {
        await execute(
          `INSERT INTO email_queue (rule_id, trigger_key, recipient, subject, body, send_after_ts, sent_ts, status, detail, created_ts)
           VALUES (?,?,?,?,?,?,0,'waiting','',?)`,
          [rule.id, triggerKey, to, subject, html, Date.now() + delay * 60000, Date.now()]);
      }
      fired++;
    }
    return { fired, held, held_because: holdReasons };
  } catch (err) {
    return { fired: 0, error: String(err.message || err) };
  }
}

/* Send whatever is due. Called opportunistically as the site is used and by
   the daily cron, so a delayed email does not wait on a quiet afternoon. */
let lastFlush = 0;
async function flush({ force } = {}) {
  try {
    // Not on literally every request — once a minute is plenty.
    if (!force && Date.now() - lastFlush < 60000) return { sent: 0, skipped: true };
    lastFlush = Date.now();
    await ensureTables();

    const due = await query(
      "SELECT * FROM email_queue WHERE sent_ts = 0 AND status = 'waiting' AND send_after_ts <= ? ORDER BY send_after_ts LIMIT 25",
      [Date.now()]);
    if (!due.length) return { sent: 0 };

    const notify = require('./_notify');
    let sent = 0;
    for (const q of due) {
      const out = await notify.sendEmail(q.recipient, q.subject, q.body, { kind: 'rule:' + q.trigger_key });
      await execute('UPDATE email_queue SET sent_ts=?, status=?, detail=? WHERE id=?',
        [out && out.sent ? Date.now() : 0, out && out.sent ? 'sent' : 'failed',
         (out && out.why) || '', q.id]);
      if (out && out.sent) sent++;
    }
    return { sent, considered: due.length };
  } catch (err) {
    return { sent: 0, error: String(err.message || err) };
  }
}

async function recent(limit) {
  await ensureTables();
  return query(
    `SELECT q.id, q.trigger_key, q.recipient, q.subject, q.status, q.detail,
            q.send_after_ts, q.sent_ts, q.created_ts, r.name AS rule_name
       FROM email_queue q LEFT JOIN email_rules r ON r.id = q.rule_id
      ORDER BY q.created_ts DESC LIMIT ?`, [Math.min(200, Number(limit) || 60)]);
}

module.exports = {
  renderFor, builtIn, BUILT_IN,
  TRIGGERS, AUDIENCES, FIELDS,
  ensureTables, listRules, saveRule, deleteRule,
  fire, flush, recent, fill, toHtml,
};
