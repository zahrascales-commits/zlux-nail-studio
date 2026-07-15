// Central notification layer — email, SMS, and in-app notifications.
// Dependency-free (raw HTTP APIs) so it works in any serverless runtime.
//
// Delivery goes live the moment these env vars exist in Vercel:
//   Email: RESEND_API_KEY  (or SENDGRID_API_KEY)  [+ NOTIFY_FROM_EMAIL]
//   SMS:   TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER
// Without keys, sends are skipped silently but in-app notifications
// (the bell in the Manager and Team Portal) always work.

const { execute, ensureTables } = require('./_team-db');

const FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || 'studio@zluxnails.com';

function e164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}

async function sendEmail(to, subject, html) {
  if (!to || !/@/.test(to)) return { sent: false, why: 'no email' };
  try {
    if (process.env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `ZOLA Nail Studio <${FROM_EMAIL}>`, to: [to], subject, html }),
      });
      return { sent: r.ok, why: r.ok ? 'resend' : 'resend ' + r.status };
    }
    if (process.env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: FROM_EMAIL, name: 'ZOLA Nail Studio' },
          subject,
          content: [{ type: 'text/html', value: html }],
        }),
      });
      return { sent: r.ok || r.status === 202, why: 'sendgrid ' + r.status };
    }
    return { sent: false, why: 'no email provider key configured' };
  } catch (err) { return { sent: false, why: String(err.message || err) }; }
}

async function sendSMS(to, body) {
  const phone = e164(to);
  if (!phone) return { sent: false, why: 'no valid phone' };
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !tok || !from) return { sent: false, why: 'no SMS provider key configured' };
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: from, Body: body }).toString(),
    });
    return { sent: r.ok || r.status === 201, why: 'twilio ' + r.status };
  } catch (err) { return { sent: false, why: String(err.message || err) }; }
}

// In-app notification (always works, no keys needed)
async function notifyInApp(recipient, memberId, title, body) {
  try {
    await ensureTables();
    await execute(
      'INSERT INTO notifications (recipient, member_id, title, body, read, ts) VALUES (?,?,?,?,0,?)',
      [recipient, memberId ? Number(memberId) : null, String(title).slice(0, 160), String(body).slice(0, 500), Date.now()]
    );
  } catch (_) {}
}

// Fire everything for a new appointment: instant client confirmation
// (email + SMS) and instant alert to whoever was booked (owner or artist).
async function notifyNewAppointment(a) {
  const results = { client_email: null, client_sms: null, artist: null };
  const when = `${a.dateLabel || a.date} at ${a.timeLabel || a.time}`;

  // client confirmation — instant
  if (a.clientEmail) {
    results.client_email = await sendEmail(a.clientEmail,
      `Your ZOLA appointment is confirmed — ${a.dateLabel || a.date}`,
      `<div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;background:#FAFAF8;color:#0D0D0D">
        <div style="background:#0D0D0D;padding:2.2rem;text-align:center">
          <h1 style="color:#C4A882;margin:0;letter-spacing:0.1em;font-weight:400">ZOLA</h1>
          <p style="color:#8B6A3E;font-size:0.72rem;letter-spacing:0.2em;text-transform:uppercase;margin:0.4rem 0 0">Nail Studio · Porterville, CA</p>
        </div>
        <div style="padding:2rem">
          <p>Hi ${(a.clientName || 'love').split(' ')[0]}, you're all set ✦</p>
          <div style="background:#F5EEE8;border-left:3px solid #C4A882;padding:1.2rem;margin:1.2rem 0">
            <p style="margin:0.2rem 0"><b>Service:</b> ${a.service || 'Appointment'}</p>
            <p style="margin:0.2rem 0"><b>When:</b> ${when}</p>
            ${a.memberName ? `<p style="margin:0.2rem 0"><b>Your artist:</b> ${a.memberName}</p>` : ''}
          </div>
          <p style="font-size:0.85rem;color:#8B6A3E">Need to change it? Give us 24 hours' notice and we'll take care of you.</p>
        </div>
      </div>`);
    results.client_sms = await sendSMS(a.clientPhone,
      `ZOLA confirmed ✦ Hi ${(a.clientName || '').split(' ')[0] || 'love'}! Your ${a.service || 'appointment'} is booked for ${when}${a.memberName ? ' with ' + a.memberName : ''}. Reply here with any questions — ZOLA Nail Studio`);
  } else if (a.clientPhone) {
    results.client_sms = await sendSMS(a.clientPhone,
      `ZOLA confirmed ✦ Your ${a.service || 'appointment'} is booked for ${when}${a.memberName ? ' with ' + a.memberName : ''}. — ZOLA Nail Studio`);
  }

  // whoever got booked — instant in-app + SMS/email
  const title = `New appointment ✦ ${a.clientName || 'Client'}`;
  const body = `${a.service || 'Service'} — ${when}${a.clientPhone ? ' · ' + a.clientPhone : ''}`;
  if (a.memberId) {
    await notifyInApp('member', a.memberId, title, body);
    if (a.memberPhone) await sendSMS(a.memberPhone, `ZOLA: you have a new appointment — ${a.clientName || 'Client'}, ${a.service || ''}, ${when}. Check your Team Portal.`);
    if (a.memberEmail) await sendEmail(a.memberEmail, title, `<p>${body}</p><p>Open your Team Portal to see details.</p>`);
    results.artist = 'member ' + a.memberId;
  }
  // owner always gets an in-app copy of every booking
  await notifyInApp('owner', null, a.memberId ? title + ` → ${a.memberName || 'artist'}` : title + ' → you', body);
  return results;
}

module.exports = { sendEmail, sendSMS, notifyInApp, notifyNewAppointment, e164 };
