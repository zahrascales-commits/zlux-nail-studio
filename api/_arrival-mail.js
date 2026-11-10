// Where we are, and how to get in — the email that goes out once the
// deposit has landed.
//
// It is deliberately a second email. The studio is behind a house, down a
// side road, with no sign on the street, and the way in only works if
// somebody lets you in. That is not information a booking form should hand
// to anybody who fills it in; it goes to clients who have actually paid.
// Zahra asked for exactly that, and the street address has been taken out
// of the booking confirmation while a deposit is still owed.
//
// Everything that names a person — who they are seeing and the number to
// text — comes off the appointment, so a client is only ever given their
// own artist's number.
//
// Sent once per client per day, like the deposit email: somebody with two
// services booked on one afternoon is arriving once.
const { query, queryOne, execute } = require('./_team-db');
const { sendEmail } = require('./_notify');

const ADDRESS_LINE1 = '2037 W Linda Vista Ave, #D';
const ADDRESS_LINE2 = 'Porterville, CA 93257';
const MAPS = 'https://www.google.com/maps/search/?api=1&query='
  + encodeURIComponent('2037 W Linda Vista Ave #D, Porterville, CA 93257');

// Her words, kept as a list so a landmark can be changed in one place.
const STEPS = [
  'On Linda Vista Avenue, look for the biggest house on the street, with red mailboxes right next to it.',
  'Turn onto the street next to the red mailboxes and continue all the way down.',
  "You'll see a greenhouse on your right, followed by a row of bushes with a light post.",
  'Turn right between the greenhouse and the bushes.',
  'Look for a large white building with RAYANI on the black entrance.',
];

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// (559) 555-0000 for reading; the bare digits for the sms: and tel: links.
const digits = p => String(p || '').replace(/\D/g, '');
function prettyPhone(p) {
  const d = digits(p);
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  if (ten.length !== 10) return String(p || '').trim();
  return '(' + ten.slice(0, 3) + ') ' + ten.slice(3, 6) + '-' + ten.slice(6);
}
const dialable = p => {
  const d = digits(p);
  return d.length === 10 ? '+1' + d : (d.length === 11 ? '+' + d : d);
};

/* Has this person been here before?
 *
 * It changes what they are asked to do at the door, so it is worth knowing
 * rather than guessing: a returning client told to photograph the building
 * reads as a form letter, and a first-timer told to "just say you're here"
 * is left standing outside a house with no sign on it.
 *
 * Matched on email or phone only. A name is not enough to tell two Marias
 * apart, and "you know where we are" sent to the wrong one is the version
 * that leaves somebody lost.
 */
async function beenBeforeFor(appt) {
  const email = String(appt.client_email || '').trim().toLowerCase();
  const ph = digits(appt.client_phone).slice(-10);
  if (!email && ph.length < 10) return false;
  try {
    const rows = await query(
      'SELECT client_email, client_phone FROM team_appointments '
      + 'WHERE COALESCE(checked_out_ts,0) > 0 AND id <> ? LIMIT 400', [Number(appt.id) || 0]);
    return (rows || []).some(r => {
      const re = String(r.client_email || '').trim().toLowerCase();
      if (email && re && re === email) return true;
      const rp = digits(r.client_phone).slice(-10);
      return ph.length === 10 && rp === ph;
    });
  } catch (_) { return false; }
}

function html({ client, artist, artistPhone, service, datePretty, timePretty, beenBefore }) {
  const first = String(client || '').trim().split(/\s+/)[0] || 'there';
  const who = esc(artist);
  const shown = esc(prettyPhone(artistPhone));
  const dial = esc(dialable(artistPhone));

  const head = t => '<p style="font-size:11px;letter-spacing:2.5px;text-transform:uppercase;'
    + 'color:#8B6A3E;margin:0 0 10px">' + t + '</p>';
  const p = t => '<p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 16px">' + t + '</p>';
  const rule = '<div style="border-top:1px solid #eee5d8;margin:26px 0 22px"></div>';

  return `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px 14px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #eee5d8">

    <div style="background:#0D0D0D;padding:26px 24px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:6px;color:#F5EEE8">ZOLA</div>
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8B6A3E;margin-top:6px">Nail Studio · Porterville</div>
    </div>

    <div style="padding:28px 24px">
      ${p('Hi ' + esc(first) + ',')}
      ${p("Your deposit has been received, and your appointment is confirmed. We can't wait to see you!")}

      <div style="background:#faf7f4;border:1px solid #eee5d8;padding:16px 18px;margin:0 0 24px">
        <div style="font-family:Georgia,serif;font-size:18px;color:#0D0D0D;margin-bottom:4px">${esc(datePretty)}</div>
        <div style="font-size:15px;color:#8B6A3E;margin-bottom:10px">at ${esc(timePretty)}</div>
        <div style="font-size:14px;color:#3a3027">${esc(service)}</div>
      </div>

      ${head('Your service provider')}
      <div style="background:#faf7f4;border:1px solid #eee5d8;padding:16px 18px;margin:0 0 14px">
        <div style="font-family:Georgia,serif;font-size:19px;color:#0D0D0D;margin-bottom:8px">${who}</div>
        <div style="font-size:15px;color:#3a3027">Text:
          <a href="sms:${dial}" style="color:#8B6A3E;text-decoration:none;font-weight:bold">${shown}</a>
        </div>
      </div>
      ${p("Please save this number. You'll need it when you arrive.")}

      ${rule}
      ${head('Address')}
      ${p(esc(ADDRESS_LINE1) + '<br>' + esc(ADDRESS_LINE2))}
      <div style="margin:0 0 16px">
        <a href="${MAPS}" style="display:inline-block;border:1px solid #0D0D0D;color:#0D0D0D;text-decoration:none;
          padding:11px 16px;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase">
          Open in Google Maps
        </a>
      </div>
      ${p('We recommend using Google Maps because some map apps can take you to the wrong house.')}

      ${rule}
      ${head('How to find us')}
      <ol style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 16px;padding-left:22px">
        ${STEPS.map(s => '<li style="margin-bottom:10px">' + esc(s) + '</li>').join('')}
      </ol>

      ${rule}
      ${head('When you arrive')}
      ${beenBefore
        ? p('You have been here before, so there is nothing to work out. Text ' + who + ' at '
            + '<a href="sms:' + dial + '" style="color:#8B6A3E;text-decoration:none;font-weight:bold">' + shown + '</a> '
            + 'to say you have arrived, and ' + who + ' will come and let you in.')
        : p('Before entering the property, text ' + who + ' a photo of the building at '
            + '<a href="sms:' + dial + '" style="color:#8B6A3E;text-decoration:none;font-weight:bold">' + shown + '</a>. '
            + 'Once ' + who + ' confirms you are in the right place, they will help you enter and walk you in. '
            + 'Next time you come, a text to say you have arrived is all it takes.')}

      ${head('Where to park')}
      ${p("Once you're inside, park all the way on the right, closest to the smaller second building.")}

      ${head('Need help finding us?')}
      ${p('Text or FaceTime ' + who + ' at '
        + '<a href="tel:' + dial + '" style="color:#8B6A3E;text-decoration:none;font-weight:bold">' + shown + '</a>, '
        + 'and they will guide you to the right place.')}

      ${p('We look forward to seeing you 🤍')}
      <p style="font-size:15px;line-height:1.75;color:#8B6A3E;margin:0">ZOLA</p>
    </div>

    <div style="background:#faf7f4;padding:16px 24px;text-align:center;border-top:1px solid #eee5d8">
      <p style="font-size:12px;color:#8C7A5E;margin:0;line-height:1.7">
        ZOLA Nail Studio · ${esc(ADDRESS_LINE1)}, ${esc(ADDRESS_LINE2)}<br>
        Just reply to this email if you need anything before your visit.
      </p>
    </div>
  </div>
</div>`;
}


/* ── WHEN IT IS ALLOWED TO GO ──────────────────────────────────────── */

let ready = null;
async function ensureColumns() {
  if (ready) return ready;
  ready = (async () => {
    for (const sql of [
      'ALTER TABLE team_appointments ADD COLUMN arrival_sent_ts INTEGER DEFAULT 0',
      "ALTER TABLE team_appointments ADD COLUMN arrival_sent_note TEXT DEFAULT ''",
      /* The number clients are told to text, which is not always the one
         the artist gets her own booking texts on. Made here as well as in
         Studio Manager, because the cron can run first. */
      "ALTER TABLE team_members ADD COLUMN client_phone TEXT DEFAULT ''",
      // Which membership the booking belongs to — the sweep reads it.
      "ALTER TABLE team_appointments ADD COLUMN member_id TEXT DEFAULT ''",
    ]) { try { await execute(sql); } catch (_) { /* already there */ } }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// Porterville, not UTC. The same shift the deposit code uses, so the two
// never disagree about which day "today" is.
const todayLA = () => new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10);

/* Has this appointment been settled up front?
 *
 * Three ways, and she asked for all three: they paid online, she ticked it
 * off after cash or Venmo, or there was never a deposit to pay. What is NOT
 * settled is a deposit still owed — that client has the booking email and
 * the payment link, and nothing else.
 */
async function settled(appt) {
  if (Number(appt.deposit_waived) === 1) return { ok: true, how: 'no deposit due' };
  if (Number(appt.deposit_paid) === 1) return { ok: true, how: 'deposit paid' };
  try {
    const owed = Math.round(Number(await require('./_visit').depositFor(appt)) || 0);
    if (owed <= 0) return { ok: true, how: 'nothing owed' };
  } catch (_) { /* cannot tell: treat it as owing and say nothing */ }
  return { ok: false, how: 'deposit still owed' };
}

/* Everything needed before a word is sent. Returned rather than thrown, so
   a caller can log why nobody was written to. */
async function prepare(appt) {
  await ensureColumns();

  if (/cancel/i.test(String(appt.status || ''))) return { ok: false, why: 'cancelled' };
  if (Number(appt.checked_out_ts)) return { ok: false, why: 'already been and gone' };
  if (String(appt.date || '') < todayLA()) return { ok: false, why: 'in the past' };

  const st = await settled(appt);
  if (!st.ok) return { ok: false, why: st.how };

  /* Who they are seeing, and the number they will be told to text. Both or
     neither: the whole email is built around that number, and one that says
     "text" with nothing after it is worse than no email at all. */
  let artist = String(appt.artist_name || '').trim();
  let phone = '';
  if (appt.team_member_id) {
    /* The number clients are given comes first, and the artist's own number
       is the fallback. They are not always the same: an artist can want her
       booking texts on one phone and her clients on another, and sending a
       client to the wrong one means somebody standing outside a building
       nobody is answering for. */
    try {
      const m = await queryOne(
        'SELECT name, phone, client_phone FROM team_members WHERE id=?', [appt.team_member_id]);
      if (m) {
        artist = artist || String(m.name || '').trim();
        phone = String(m.client_phone || '').trim() || String(m.phone || '').trim();
      }
    } catch (_) {
      try {
        const m = await queryOne('SELECT name, phone FROM team_members WHERE id=?', [appt.team_member_id]);
        if (m) { artist = artist || String(m.name || '').trim(); phone = String(m.phone || '').trim(); }
      } catch (__) {}
    }
  }
  if (!artist) return { ok: false, why: 'no artist on it yet' };
  if (!digits(phone)) return { ok: false, why: 'no phone on file for ' + artist, needsPhone: artist };

  const to = await require('./_confirm-mail').resolveEmail(appt);
  if (!to) return { ok: false, why: 'no email anywhere for this client' };

  const visit = require('./_visit');

  /* One arrival email per client per day. Two services booked on the same
     afternoon is one journey, one building and one person letting them in,
     so it reads as one email and every row in the group is marked. */
  let group = [appt];
  try {
    const grp = await require('./_deposit-group').groupFor(appt);
    if (grp && Array.isArray(grp.rows) && grp.rows.length) group = grp.rows;
  } catch (_) {}
  const service = group.length > 1
    ? group.map(r => r.service || 'appointment').join(' + ')
    : (appt.service || 'your appointment');
  const earliest = group.slice().sort((a, b) =>
    String(a.time || '').localeCompare(String(b.time || '')))[0] || appt;

  const beenBefore = await beenBeforeFor(appt);

  return {
    ok: true, to, artist, phone, how: st.how, group, been_before: beenBefore,
    subject: "You're booked with " + artist + ' at ZOLA 🤍',
    body: html({
      client: appt.client_name, artist, artistPhone: phone, service, beenBefore,
      datePretty: visit.pretty(appt.date), timePretty: visit.time12(earliest.time),
    }),
  };
}

/* Send it for one appointment.
 *
 * `preview` builds the whole thing and sends nothing, which is how Zahra
 * sees an email before a client does. Nothing here throws: directions
 * failing must never take a payment down with it.
 */
async function sendFor(appt, { force, preview } = {}) {
  const got = await prepare(appt);
  if (!got.ok) return { sent: false, why: got.why, needsPhone: got.needsPhone };
  if (preview) return { sent: false, preview: true, to: got.to, subject: got.subject, html: got.body, why: got.how };
  if (!force && Number(appt.arrival_sent_ts) > 0) return { sent: false, why: 'already sent' };

  /* Claim it before sending, not after. Two payments can land within a
     second of each other — the page and the Stripe webhook do exactly that
     — and whoever loses this update does not send a second copy. */
  const now = Date.now();
  if (!force) {
    let claimed = 0;
    try {
      const r = await execute(
        'UPDATE team_appointments SET arrival_sent_ts=? WHERE id=? AND COALESCE(arrival_sent_ts,0)=0',
        [now, Number(appt.id)]);
      claimed = Number(r && r.rowsAffected) || 0;
    } catch (_) {}
    if (!claimed) return { sent: false, why: 'already sent' };
  }

  const out = await sendEmail(got.to, got.subject, got.body, { kind: 'arrival_directions' })
    .catch(e => ({ ok: false, error: String((e && e.message) || e) }));

  if (!out || out.ok === false) {
    // Hand the claim back, so the next payment or the cron tries again.
    try { await execute("UPDATE team_appointments SET arrival_sent_ts=0, arrival_sent_note='' WHERE id=?", [Number(appt.id)]); } catch (_) {}
    return { sent: false, why: (out && (out.error || out.why)) || 'the email would not send' };
  }

  // Mark every row in the group, so a second service on the same day does
  // not send its own copy.
  for (const r of got.group) {
    try {
      await execute('UPDATE team_appointments SET arrival_sent_ts=?, arrival_sent_note=? WHERE id=?',
        [now, got.to, Number(r.id)]);
    } catch (_) {}
  }
  return { sent: true, to: got.to, artist: got.artist, how: got.how };
}

/* The hook the payment routes call. Takes an id or a token and looks the
   appointment up fresh — the caller's copy was read before the payment
   landed — then sends if it is now allowed. */
async function maybeSendFor(ref) {
  try {
    await ensureColumns();
    const where = typeof ref === 'object'
      ? (ref.chat_token ? ['a.chat_token=?', ref.chat_token] : ['a.id=?', Number(ref.id)])
      : (/^[0-9]+$/.test(String(ref)) ? ['a.id=?', Number(ref)] : ['a.chat_token=?', String(ref)]);
    const appt = await queryOne(
      'SELECT a.*, m.name AS artist_name FROM team_appointments a '
      + 'LEFT JOIN team_members m ON m.id = a.team_member_id WHERE ' + where[0], [where[1]]);
    if (!appt) return { sent: false, why: 'no such appointment' };
    return await sendFor(appt);
  } catch (e) {
    return { sent: false, why: String((e && e.message) || e) };
  }
}

/* The safety net, run from the twice-daily cron. Catches anything settled
   by a route that does not call the hook — a correction, a card on file at
   rebooking, or something added later — so nobody turns up without
   directions because of a code path somebody forgot. */
async function sweep({ limit = 25, force } = {}) {
  await ensureColumns();

  if (!force) {
    let on = false;
    try {
      const row = await queryOne("SELECT value FROM site_settings WHERE key='arrival_sweep_on'");
      on = String((row && row.value) || '') === '1';
    } catch (_) {}
    if (!on) return { off: true, looked: 0, sent: 0, results: [] };
  }
  let rows = [];
  try {
    /* Three ways to be settled, and the third one was missing. A member
       on a tier that promises no deposit has neither flag set, so a query
       that only looked at the flags never saw them, and the email with
       their artist's number was never sent.

       Whether they are REALLY settled is still settled() to decide: a
       member whose included services are spent owes the usual deposit and
       is skipped exactly like anybody else. Membership here only buys a
       look. */
    rows = await query(
      'SELECT a.*, m.name AS artist_name FROM team_appointments a '
      + 'LEFT JOIN team_members m ON m.id = a.team_member_id '
      + 'WHERE a.date >= ? AND COALESCE(a.arrival_sent_ts,0)=0 '
      + "AND LOWER(COALESCE(a.status,'scheduled'))<>'cancelled' "
      + 'AND a.team_member_id IS NOT NULL '
      + "AND (COALESCE(a.deposit_paid,0)=1 OR COALESCE(a.deposit_waived,0)=1 "
      + "     OR (COALESCE(a.member_id,'') <> '' AND COALESCE(a.member_id,'') <> '-')) "
      + 'ORDER BY a.date LIMIT ?', [todayLA(), Math.max(1, Math.min(100, Number(limit) || 25))]);
  } catch (_) {
    // An older book with no member_id column at all: the flags on their own.
    try {
      rows = await query(
        'SELECT a.*, m.name AS artist_name FROM team_appointments a '
        + 'LEFT JOIN team_members m ON m.id = a.team_member_id '
        + 'WHERE a.date >= ? AND COALESCE(a.arrival_sent_ts,0)=0 '
        + "AND LOWER(COALESCE(a.status,'scheduled'))<>'cancelled' "
        + 'AND a.team_member_id IS NOT NULL '
        + 'AND (COALESCE(a.deposit_paid,0)=1 OR COALESCE(a.deposit_waived,0)=1) '
        + 'ORDER BY a.date LIMIT ?', [todayLA(), Math.max(1, Math.min(100, Number(limit) || 25))]);
    } catch (__) { return { looked: 0, sent: 0, results: [] }; }
  }

  const results = [];
  for (const r of rows) {
    const out = await sendFor(r);
    results.push({ id: r.id, client: r.client_name, date: r.date, ...out });
  }
  return { looked: rows.length, sent: results.filter(r => r.sent).length, results };
}

/* Everybody who had already paid before this email existed.
 *
 * Marked as sent without sending, so switching it on does not mail people
 * who booked weeks ago. Zahra decides who among them gets it, one at a
 * time, after seeing it. Only ever touches rows nothing has been sent for.
 */
async function markPredating() {
  await ensureColumns();
  const r = await execute(
    "UPDATE team_appointments SET arrival_sent_ts=?, arrival_sent_note='predates the arrival email' "
    + 'WHERE COALESCE(arrival_sent_ts,0)=0 '
    + 'AND (COALESCE(deposit_paid,0)=1 OR COALESCE(deposit_waived,0)=1)',
    [Date.now()]);
  return { marked: Number(r && r.rowsAffected) || 0 };
}

module.exports = {
  html, prettyPhone, dialable, STEPS, ADDRESS_LINE1, ADDRESS_LINE2, MAPS,
  ensureColumns, settled, prepare, sendFor, maybeSendFor, sweep, markPredating,
  beenBeforeFor,
};
