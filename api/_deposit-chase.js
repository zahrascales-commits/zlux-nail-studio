// Chasing a deposit that has not been paid.
//
// One confirmation email and then silence is how a spot sits held for a
// week and then goes empty. So it asks again, and each time it asks it says
// something different: a nudge, then a firmer one, then a plain statement
// that the time is going to be released.
//
// Deliberately truthful about that last part. It is easy to write "three
// people are waiting for your slot" and it makes people pay — but if nobody
// is waiting it is a lie told to a client, and the one time somebody finds
// out is the time it costs more than the deposit was worth. What it says
// instead is the thing that is actually true: the appointment will be given
// up. If a real waiting list ever exists, the number goes in here and it
// will be a real number.
//
// Stops the moment the deposit is paid, the appointment is cancelled, or
// the day arrives.
const { query, queryOne, execute } = require('./_team-db');
const notify = require('./_notify');

const SITE = process.env.PUBLIC_BASE_URL || 'https://zolanailstudio.com';

// How many times it asks before the wording becomes final. After this it
// repeats the final notice rather than escalating further — there is
// nothing past "we are giving it away" that is still true.
const FINAL_AT = 3;

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = c => '$' + (Number(c || 0) / 100).toFixed(2).replace(/\.00$/, '');

/* What she has said about giving spots away, in her own words if she has
   written any. A studio that says "we will release it" and never does is
   training people to ignore the email, so this is worth her being able to
   soften or sharpen. */
async function settings() {
  const out = { on: true, perDay: 2, stopHoursBefore: 24, waiting: 0 };
  try {
    const rows = await query(
      "SELECT key, value FROM site_settings WHERE key IN ('dep_chase_on','dep_chase_per_day','dep_chase_stop_hours','dep_chase_waiting')");
    for (const r of rows) {
      if (r.key === 'dep_chase_on') out.on = String(r.value) !== '0';
      if (r.key === 'dep_chase_per_day') out.perDay = Math.max(1, Math.min(4, Number(r.value) || 2));
      if (r.key === 'dep_chase_stop_hours') out.stopHoursBefore = Math.max(0, Number(r.value) || 24);
      /* How many people are genuinely waiting for a spot. Zero unless she
         sets it, and zero means the email does not mention a queue at all
         rather than inventing one. */
      if (r.key === 'dep_chase_waiting') out.waiting = Math.max(0, Number(r.value) || 0);
    }
  } catch (_) {}
  return out;
}

function subjectFor(n, dateStr) {
  if (n === 1) return 'Your deposit is still to pay — ' + dateStr;
  if (n === 2) return 'Second reminder: your deposit for ' + dateStr;
  return 'Last chance to keep your ' + dateStr + ' appointment';
}

/* Three tones, and the third one means it. The escalation is the whole
   point: an email that says the same thing five times is one email people
   stop opening after the first. */
/* Three tones, and the third one means it. The escalation is the whole
   point: an email that says the same thing five times is one email people
   stop opening after the first.

   `also` is the other appointments they have outstanding. One person with
   two unpaid visits gets one email naming both, rather than two emails a
   second apart that make each other look automated. */
function wordsFor(n, { first, service, dateStr, timeStr, owed, waiting, also }) {
  const pay = money(owed);
  const many = Array.isArray(also) && also.length > 0;
  const what = many
    ? (also.length + 1) + ' appointments'
    : service + ' on ' + dateStr + ' at ' + timeStr;
  const extra = many
    ? ['That covers ' + [service + ' on ' + dateStr]
        .concat(also.map(a => a.service + ' on ' + a.dateStr)).join(', and ') + '.']
    : [];

  if (n === 1) {
    return [
      'Hi ' + first + ',',
      many
        ? 'You have ' + what + ' booked in with me, and the deposits have not come through yet.'
        : 'Your ' + what + ' is booked in, but the deposit has not come through yet.',
    ].concat(extra).concat([
      (many ? 'They come to ' + pay + ', which comes off' : 'It is ' + pay + ', it comes off')
        + ' what you pay on the day, and it is what holds the time for you.',
    ]);
  }

  if (n === 2) {
    return [
      'Hi ' + first + ',',
      'A second reminder — the ' + pay + ' still outstanding on your ' + what + '.',
    ].concat(extra).concat([
      'Your time is being held for now. If the deposit is not paid I will have to open the slot back up, and I would much rather keep it for you.',
    ]);
  }

  // Final. Says what will actually happen, and nothing that is not true.
  return [
    'Hi ' + first + ',',
    'This is the last reminder about the ' + pay + ' owed on your ' + what + '.',
  ].concat(extra).concat([
    waiting > 0
      ? 'There ' + (waiting === 1 ? 'is 1 person' : 'are ' + waiting + ' people')
        + ' waiting for a spot, so if the deposit is not paid I will be releasing '
        + (many ? 'these' : 'this one') + ' to them.'
      : 'If the deposit is not paid I will be releasing ' + (many ? 'these times' : 'this time')
        + ' and offering ' + (many ? 'them' : 'it') + ' to someone else.',
    'If you still want ' + (many ? 'them' : 'it') + ', the deposit takes a minute.',
  ]);
}

function html({ lines, link, n, owed }) {
  const paras = lines.map(p =>
    '<p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 16px">' + esc(p) + '</p>').join('');

  // The final one is visibly different, because an email that looks
  // identical to the last two reads as the same email.
  const accent = n >= FINAL_AT ? '#8a2f2f' : '#0D0D0D';

  return `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px 14px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #eee5d8">
    <div style="background:${accent};padding:26px 24px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:6px;color:#F5EEE8">ZOLA</div>
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#d8c39a;margin-top:6px">Nail Studio · Porterville</div>
    </div>
    <div style="padding:28px 24px">
      ${paras}
      <div style="text-align:center;margin:6px 0 22px">
        <a href="${esc(link)}" style="display:inline-block;background:${accent};color:#F5EEE8;
          text-decoration:none;padding:15px 28px;font-size:14px;letter-spacing:2px;text-transform:uppercase">
          Pay my ${esc(money(owed))} deposit
        </a>
      </div>
      <p style="font-size:13px;line-height:1.7;color:#8C7A5E;margin:0">
        Already paid it? Then nothing needs doing and you can ignore this.
      </p>
    </div>
    <div style="background:#faf7f4;padding:16px 24px;text-align:center;border-top:1px solid #eee5d8">
      <p style="font-size:12px;color:#8C7A5E;margin:0;line-height:1.7">
        ZOLA Nail Studio · Porterville, California<br>Just reply to this email to reach us.
      </p>
    </div>
  </div>
</div>`;
}

/* Everybody with a future appointment and an unpaid deposit. The
   confirmation must have gone first — chasing somebody for a deposit they
   were never told about is the studio's mistake, not theirs. */
async function owing() {
  const visit = require('./_visit');
  await visit.ensureColumns();
  const today = new Date().toISOString().slice(0, 10);

  let rows = [];
  try {
    rows = await query(
      `SELECT a.*, m.name AS artist_name
         FROM team_appointments a
         LEFT JOIN team_members m ON m.id = a.team_member_id
        WHERE a.date >= ?
          AND COALESCE(a.deposit_paid,0) = 0
          AND COALESCE(a.checked_out_ts,0) = 0
          AND LOWER(COALESCE(a.status,'scheduled')) <> 'cancelled'
        ORDER BY a.date, a.time`, [today]);
  } catch (_) { return []; }

  const out = [];
  for (const r of rows) {
    // Never chased before being told. The confirmation carries the link.
    if (!Number(r.confirm_sent_ts)) continue;

    let owed = 0;
    try { owed = await visit.depositFor(r); } catch (_) { owed = 0; }
    if (!(owed > 0)) continue;          // members and covered visits owe nothing

    let email = '';
    try { email = await require('./_confirm-mail').resolveEmail(r); } catch (_) {}
    if (!email) continue;

    out.push({ row: r, owed, email });
  }
  return out;
}

/* One pass. Called by the cron, twice a day, and sends at most one email
   per appointment per pass. Returns what it did rather than throwing —
   this runs unattended and a thrown error is an error nobody reads. */
/* One pass. Called by the cron, twice a day, and sends at most one email
   per person per pass — not one per appointment. Returns what it did rather
   than throwing: this runs unattended, and a thrown error is an error
   nobody reads. */
async function run({ force } = {}) {
  const S = await settings();
  if (!S.on && !force) return { sent: 0, skipped: 'switched off' };

  const visit = require('./_visit');
  const now = Date.now();
  const list = await owing();
  const done = [];

  // Everything one person owes, together.
  const byPerson = new Map();
  for (const item of list) {
    const apptTs = new Date(String(item.row.date) + 'T' + String(item.row.time || '00:00') + ':00').getTime();
    const hoursAway = (apptTs - now) / 3600000;
    // Close enough that chasing is no longer the right move — at that point
    // it is a phone call, or her decision to let it go.
    if (hoursAway < S.stopHoursBefore) continue;

    /* One person, one day. The payment page asks for everything booked on
       that day and nothing else, so the email has to ask for exactly the
       same thing. Grouping across days is what let an email name one total
       and link to a page that charged another. */
    const key = String(item.email).toLowerCase() + '|' + String(item.row.date);
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push({ ...item, apptTs });
  }

  for (const [groupKey, items] of byPerson) {
    const email = String(groupKey).split('|')[0];
    // Soonest first: that is the one at risk, and the one to name.
    items.sort((a, b) => a.apptTs - b.apptTs);
    const lead = items[0];
    const row = lead.row;
    /* The amount is the payment page's amount, from the same code, so the
       number in the email and the number on the button cannot differ. */
    const dayGroup = await require('./_deposit-group').groupFor(row);
    const owedTotal = dayGroup.dueCents;
    if (!(owedTotal > 0)) continue;

    /* Which number of reminder this is, counted from the log rather than
       stored on the row so it survives anything else touching the
       appointment. The furthest-along one sets the tone: somebody already
       on a final notice should not drop back to a gentle one. */
    let n = 0, lastTs = 0;
    for (const x of items) {
      try {
        const seen = await query('SELECT rkey, ts FROM reminder_log WHERE rkey LIKE ?', ['dep:' + x.row.id + ':%']);
        // A note sent by hand is not a step up the ladder.
        const steps = seen.filter(s => String(s.rkey).indexOf(':m:') < 0).length;
        if (steps > n) n = steps;
        for (const s of seen) if (Number(s.ts) > lastTs) lastTs = Number(s.ts);
      } catch (_) {}
    }

    /* Never within eight hours of the last one, whatever sent it. The two
       daily runs are nine hours apart, so this never skips one of them — but
       it does stop an automatic reminder landing on top of a note Zahra has
       just sent by hand. */
    if (lastTs && now - lastTs < 8 * 3600000) continue;

    const next = n + 1;
    const hour = new Date(now).toISOString().slice(0, 13);

    /* Claim the send before making it. Every appointment in the group is
       logged so each one's count stays right, but only the first claim
       decides whether the email goes — two passes in the same hour cannot
       both send. */
    let firstTime = true;
    try {
      await execute('INSERT INTO reminder_log (rkey, ts) VALUES (?,?)',
        ['dep:' + row.id + ':' + next + ':' + hour, now]);
    } catch (_) { firstTime = false; }
    if (!firstTime) continue;

    for (const x of items.slice(1)) {
      try {
        await execute('INSERT INTO reminder_log (rkey, ts) VALUES (?,?)',
          ['dep:' + x.row.id + ':' + next + ':' + hour, now]);
      } catch (_) {}
    }

    const first = String(row.client_name || 'there').trim().split(/\s+/)[0] || 'there';
    const dateStr = visit.pretty(row.date);
    const timeStr = visit.time12(row.time);
    const link = SITE + '/visit.html?t=' + encodeURIComponent(row.chat_token || '');

    const lines = wordsFor(Math.min(next, FINAL_AT), {
      first,
      service: row.service || 'your appointment',
      dateStr, timeStr,
      owed: owedTotal,
      waiting: S.waiting,
      also: dayGroup.owing
        .filter(x => Number(x.row.id) !== Number(row.id))
        .map(x => ({
          service: x.row.service || 'your appointment',
          dateStr: visit.pretty(x.row.date),
        })),
    });

    const r = await notify.sendEmail(
      email,
      subjectFor(Math.min(next, FINAL_AT), dateStr),
      html({ lines, link, n: next, owed: owedTotal }),
      { kind: 'deposit_chase:' + next }
    ).catch(() => ({ sent: false }));

    done.push({
      client: row.client_name, to: email, reminder: next,
      appointments: items.length, owed_cents: owedTotal, sent: !!(r && r.sent),
    });

    /* She should know when somebody has been told their spot is going, so
       that releasing it is not a surprise to her either. */
    if (next >= FINAL_AT) {
      try {
        await notify.notifyInApp('owner', null,
          '⚠️ ' + (row.client_name || 'A client') + ' has had their final deposit reminder',
          (row.service || 'Appointment') + ' on ' + dateStr + ' · ' + money(owedTotal)
            + ' still owed. Nothing is cancelled automatically — that is your call.');
      } catch (_) {}
    }
  }

  return { sent: done.filter(x => x.sent).length, attempted: done.length, rows: done };
}

module.exports = { run, owing, settings, wordsFor, subjectFor, FINAL_AT };
