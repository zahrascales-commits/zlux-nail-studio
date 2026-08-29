// The email a client gets once their appointment has an artist on it.
//
// One message, two jobs: pay the deposit, and show us what you want. Both
// live on the same page behind the same link, because two links in one email
// is how one of them goes unclicked.
//
// Sent when Zahra books somebody herself and when she assigns an appointment
// to an artist. Recorded on the row so nobody is ever sent it twice and the
// backfill can find everybody who never got one.
const { query, queryOne, execute } = require('./_team-db');
const { sendEmail } = require('./_notify');

const SITE = process.env.PUBLIC_BASE_URL || 'https://zolanailstudio.com';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function html({ client, service, artist, datePretty, timePretty, link, depositCents, depositPaid }) {
  const first = String(client || '').trim().split(/\s+/)[0] || 'there';
  const money = '$' + (Number(depositCents || 0) / 100).toFixed(2).replace(/\.00$/, '');

  return `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px 14px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #eee5d8">

    <div style="background:#0D0D0D;padding:26px 24px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:6px;color:#F5EEE8">ZOLA</div>
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8B6A3E;margin-top:6px">Nail Studio · Porterville</div>
    </div>

    <div style="padding:28px 24px">
      <p style="font-size:16px;line-height:1.7;color:#3a3027;margin:0 0 6px">Hi ${esc(first)},</p>
      <p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 20px">
        You're booked in${artist ? ' with <strong>' + esc(artist) + '</strong>' : ''}. Here are the details.
      </p>

      <div style="background:#faf7f4;border:1px solid #eee5d8;padding:16px 18px;margin-bottom:22px">
        <div style="font-family:Georgia,serif;font-size:18px;color:#0D0D0D;margin-bottom:4px">${esc(datePretty)}</div>
        <div style="font-size:15px;color:#8B6A3E;margin-bottom:10px">at ${esc(timePretty)}</div>
        <div style="font-size:14px;color:#3a3027">${esc(service)}</div>
        ${artist ? `<div style="font-size:14px;color:#8C7A5E;margin-top:4px">with ${esc(artist)}</div>` : ''}
      </div>

      ${depositPaid || !depositCents ? '' : `
      <p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 6px">
        <strong>Two things before you come in.</strong>
      </p>
      <p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 4px">
        <strong>1.</strong> Your deposit is <strong>${money}</strong>. It holds your spot and comes off the price of your service.
      </p>
      <p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 20px">
        <strong>2.</strong> Send a picture of the nails you want${artist ? ' — it goes straight to ' + esc(artist) : ''}. A screenshot is perfect.
      </p>`}

      ${depositPaid && depositCents ? `
      <p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 20px">
        Your deposit is paid. All that's left is showing us what you want${artist ? ' — it goes straight to ' + esc(artist) : ''}. A screenshot is perfect.
      </p>` : ''}

      <a href="${link}" style="display:block;background:#0D0D0D;color:#C4A882;text-decoration:none;
        text-align:center;padding:16px 18px;font-size:13px;font-weight:bold;letter-spacing:2px;
        text-transform:uppercase">
        ${depositPaid || !depositCents ? 'Send your photos' : 'Pay deposit &amp; send photos'}
      </a>

      <p style="font-size:12px;line-height:1.7;color:#8C7A5E;margin:14px 0 0;text-align:center">
        ${depositPaid || !depositCents ? 'It works on your phone — no password.' : 'One link, both things. It works on your phone — no password.'}
      </p>

      <div style="border-top:1px solid #eee5d8;margin-top:24px;padding-top:18px">
        <p style="font-size:13px;line-height:1.8;color:#8C7A5E;margin:0 0 10px">
          <strong style="color:#3a3027">Where:</strong> 2037 W Linda Vista Ave #D, Porterville, CA
        </p>
        <p style="font-size:13px;line-height:1.8;color:#8C7A5E;margin:0 0 10px">
          <strong style="color:#3a3027">Before you come:</strong> no lotion or oils for 24 hours, and please arrive with clean hands.
        </p>
        <p style="font-size:13px;line-height:1.8;color:#8C7A5E;margin:0">
          <strong style="color:#3a3027">Afterwards:</strong> no lotion or oils for 24 hours, and keep your hands out of water as much as you can while the set cures.
        </p>
      </div>
    </div>

    <div style="background:#faf7f4;padding:16px 24px;text-align:center;border-top:1px solid #eee5d8">
      <p style="font-size:12px;color:#8C7A5E;margin:0;line-height:1.7">
        ZOLA Nail Studio · Porterville, California<br>
        Need to change something? Just reply to this email.
      </p>
    </div>
  </div>
</div>`;
}

const looksLikeEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim());

/* Where to reach this client, in order of how much the source knows.
   The appointment first, then the public booking it mirrors, then the
   client's own record. Anything found is written back so the next lookup is
   free and so the roster shows it. */
async function resolveEmail(appt) {
  if (looksLikeEmail(appt.client_email)) return String(appt.client_email).trim().toLowerCase();

  const name = String(appt.client_name || '').trim();
  let found = '';

  // The online booking that created this row.
  try {
    const main = require('./_db');
    const r = await main.queryOne(
      `SELECT COALESCE(a.guest_email, mm.email) AS email
         FROM appointments a
         LEFT JOIN members mm ON a.member_id = mm.member_id
        WHERE a.appointment_date = ? AND a.appointment_time = ?
          AND lower(COALESCE(mm.full_name, a.guest_name)) = lower(?)
        LIMIT 1`, [appt.date, appt.time, name]);
    if (r && looksLikeEmail(r.email)) found = String(r.email).trim().toLowerCase();
  } catch (_) {}

  // Failing that, the client book.
  if (!found && name) {
    try {
      const r = await queryOne('SELECT email FROM clients WHERE lower(name)=lower(?) AND email <> \'\' LIMIT 1', [name]);
      if (r && looksLikeEmail(r.email)) found = String(r.email).trim().toLowerCase();
    } catch (_) {}
  }

  if (found) {
    try { await execute('UPDATE team_appointments SET client_email=? WHERE id=?', [found, appt.id]); } catch (_) {}
  }
  return found;
}

// Send it for one appointment. Returns what happened rather than throwing,
// because a confirmation that fails must never take a booking down with it.
async function sendFor(appt, { force } = {}) {
  const visit = require('./_visit');
  await visit.ensureColumns();

  const to = await resolveEmail(appt);
  if (!to) return { sent: false, why: 'no email anywhere for this client' };
  if (!appt.chat_token) return { sent: false, why: 'no link token' };
  if (!force && Number(appt.confirm_sent_ts) > 0) return { sent: false, why: 'already sent' };

  let artist = appt.artist_name || '';
  if (!artist && appt.team_member_id) {
    try {
      const m = await queryOne('SELECT name FROM team_members WHERE id=?', [appt.team_member_id]);
      artist = (m && m.name) || '';
    } catch (_) {}
  }

  const depositCents = await visit.depositFor(appt);
  const link = SITE + '/visit.html?t=' + encodeURIComponent(appt.chat_token);

  const subject = artist
    ? `You're booked in with ${artist} — ${visit.pretty(appt.date)}`
    : `You're booked in — ${visit.pretty(appt.date)}`;

  const body = html({
    client: appt.client_name,
    service: appt.service || 'your appointment',
    artist,
    datePretty: visit.pretty(appt.date),
    timePretty: visit.time12(appt.time),
    link,
    depositCents,
    depositPaid: !!Number(appt.deposit_paid),
  });

  const r = await sendEmail(to, subject, body);
  if (r && r.sent) {
    try {
      await execute('UPDATE team_appointments SET confirm_sent_ts=? WHERE id=?', [Date.now(), appt.id]);
    } catch (_) {}
    return { sent: true, to, link };
  }
  return { sent: false, why: (r && r.why) || 'send failed', to };
}

// Everybody with a future appointment who never received one. Used by the
// backfill, and deliberately limited to appointments still to come — nobody
// wants a confirmation for a visit they already had.
async function pending() {
  const visit = require('./_visit');
  await visit.ensureColumns();
  const today = new Date().toISOString().slice(0, 10);
  let rows = [];
  try {
    // No email filter here on purpose: most rows predate the column, and
    // resolveEmail finds the address elsewhere. Filtering on the empty
    // column is what made this report nobody to send to.
    rows = await query(
      `SELECT a.*, m.name AS artist_name
         FROM team_appointments a
         LEFT JOIN team_members m ON m.id = a.team_member_id
        WHERE a.date >= ?
          AND COALESCE(a.confirm_sent_ts,0) = 0
          AND LOWER(COALESCE(a.status,'scheduled')) <> 'cancelled'
        ORDER BY a.date, a.time`, [today]);
  } catch (_) { return []; }

  // Work out who is actually reachable before offering to write to them,
  // and only once each: the same person at the same time is one appointment
  // however many rows it left behind, and three identical emails is worse
  // than none.
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const key = String(r.client_name || '').trim().toLowerCase() + '|' + r.date + '|' + String(r.time || '').slice(0, 5);
    if (seen.has(key)) continue;
    const email = await resolveEmail(r);
    if (!email) continue;
    seen.add(key);
    out.push({ ...r, client_email: email });
  }
  return out;
}

module.exports = { sendFor, pending, html, resolveEmail };
