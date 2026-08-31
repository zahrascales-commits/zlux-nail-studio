// Telling somebody a message is waiting for them.
//
// The chat already worked in both directions and nobody knew. A client
// would answer a question hours later because the only way to find out she
// had been asked one was to reopen a link from an old email; the artist
// found out the same way. A conversation nobody is told about is not a
// conversation.
//
// So every message sends the other side an email with a direct link into
// the same thread — no login, no hunting, the tap lands them where they can
// reply. The message itself goes in the email, because half of these need
// no reply at all and reading it should not cost a round trip.
//
// Deliberately quiet about who else is in the thread: an artist's email is
// never shown to a client, and a client's is never shown to the artist.
const { query, queryOne, execute } = require('./_team-db');

const SITE = process.env.PUBLIC_BASE_URL || 'https://zolanailstudio.com';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const firstName = s => String(s || '').trim().split(/\s+/)[0] || '';

/* One frame for both directions. The only differences are who it is from,
   where the button goes, and what the button says. */
function html({ toName, fromName, body, link, buttonText, note }) {
  return `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px 14px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #eee5d8">
    <div style="background:#0D0D0D;padding:24px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:6px;color:#F5EEE8">ZOLA</div>
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8B6A3E;margin-top:6px">Nail Studio · Porterville</div>
    </div>
    <div style="padding:26px 24px">
      <p style="font-size:15px;line-height:1.7;color:#3a3027;margin:0 0 18px">
        ${toName ? 'Hi ' + esc(toName) + ',' : 'Hi,'}
      </p>
      <p style="font-size:15px;line-height:1.7;color:#3a3027;margin:0 0 18px">
        <strong>${esc(fromName)}</strong> sent you a message.
      </p>

      <div style="background:#faf7f4;border-left:3px solid #C4A882;padding:14px 16px;margin:0 0 22px">
        <p style="font-size:15px;line-height:1.7;color:#3a3027;margin:0;white-space:pre-wrap">${esc(body)}</p>
      </div>

      <a href="${link}" style="display:block;background:#0D0D0D;color:#B6A588;text-align:center;
        padding:16px 18px;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:2px;
        text-transform:uppercase">${esc(buttonText)}</a>

      <p style="font-size:13px;line-height:1.7;color:#8C7A5E;margin:18px 0 0">${note}</p>
    </div>
    <div style="background:#faf7f4;padding:16px 24px;text-align:center;border-top:1px solid #eee5d8">
      <p style="font-size:12px;color:#8C7A5E;margin:0;line-height:1.7">
        ZOLA Nail Studio · Porterville, California
      </p>
    </div>
  </div>
</div>`;
}

/* Everything about the thread in one lookup: who the client is, how to
   reach them, which artist is on it, and how to reach her. */
async function threadContext(appointmentId) {
  return queryOne(
    `SELECT a.id, a.chat_token, a.client_name, a.client_email, a.service, a.date, a.time,
            m.id AS member_id, m.name AS member_name, m.email AS member_email
       FROM team_appointments a
       LEFT JOIN team_members m ON m.id = a.team_member_id
      WHERE a.id = ?`, [Number(appointmentId)]);
}

/* Not on every keystroke. Somebody typing four short lines in a row should
   produce one email, not four, or the notification becomes the thing they
   want to turn off. */
const QUIET_MINUTES = 10;

async function recentlyTold(appointmentId, who) {
  try {
    await execute(`CREATE TABLE IF NOT EXISTS chat_notified (
      appointment_id INTEGER, who TEXT, ts INTEGER,
      PRIMARY KEY (appointment_id, who)
    )`);
    const row = await queryOne(
      'SELECT ts FROM chat_notified WHERE appointment_id=? AND who=?',
      [Number(appointmentId), who]);
    if (!row) return false;
    return (Date.now() - Number(row.ts)) < QUIET_MINUTES * 60000;
  } catch (_) { return false; }
}

async function markTold(appointmentId, who) {
  try {
    await execute(
      'INSERT INTO chat_notified (appointment_id, who, ts) VALUES (?,?,?) ' +
      'ON CONFLICT(appointment_id, who) DO UPDATE SET ts=excluded.ts',
      [Number(appointmentId), who, Date.now()]);
  } catch (_) {}
}

/* An artist wrote to a client. The client gets the message and a link
   straight back into the same thread — the link is the whole point, because
   a client who has to go and find the conversation will not. */
async function notifyClient(appointmentId, fromName, body) {
  try {
    const t = await threadContext(appointmentId);
    if (!t || !t.client_email || !/@/.test(t.client_email)) {
      return { sent: false, why: 'no email on file for this client' };
    }
    if (await recentlyTold(appointmentId, 'client')) {
      return { sent: false, why: 'already told them within the last ' + QUIET_MINUTES + ' minutes' };
    }

    const who = fromName || t.member_name || 'ZOLA';
    const link = SITE + '/chat.html?t=' + encodeURIComponent(t.chat_token || '');

    const out = await require('./_notify').sendEmail(
      t.client_email,
      'You have a message from ' + who + ' ✦ ZOLA',
      html({
        toName: firstName(t.client_name),
        fromName: who,
        body,
        link,
        buttonText: 'Chat with ' + who,
        note: 'Tap above to reply. It opens straight into your conversation — no password needed.',
      }),
      { kind: 'chat:to-client' });

    if (out && out.sent) await markTold(appointmentId, 'client');
    return out;
  } catch (err) {
    return { sent: false, why: String(err.message || err) };
  }
}

/* A client wrote back. The artist gets it, so she is not relying on
   noticing a badge in the portal between clients. */
async function notifyArtist(appointmentId, fromName, body) {
  try {
    const t = await threadContext(appointmentId);
    if (!t || !t.member_email || !/@/.test(t.member_email)) {
      return { sent: false, why: 'no email on file for the artist' };
    }
    if (await recentlyTold(appointmentId, 'team')) {
      return { sent: false, why: 'already told them within the last ' + QUIET_MINUTES + ' minutes' };
    }

    const who = fromName || t.client_name || 'A client';
    const when = [t.date, t.time].filter(Boolean).join(' ');

    const out = await require('./_notify').sendEmail(
      t.member_email,
      who + ' replied ✦ ZOLA',
      html({
        toName: firstName(t.member_name),
        fromName: who,
        body,
        link: SITE + '/team.html',
        buttonText: 'Open the chat',
        note: (t.service ? esc(t.service) : 'Appointment')
          + (when ? ' · ' + esc(when) : '')
          + '. Sign in to your portal to reply.',
      }),
      { kind: 'chat:to-artist' });

    if (out && out.sent) await markTold(appointmentId, 'team');
    return out;
  } catch (err) {
    return { sent: false, why: String(err.message || err) };
  }
}

module.exports = { notifyClient, notifyArtist, threadContext };
