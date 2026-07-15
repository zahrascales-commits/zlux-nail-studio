// Central notification layer — email, SMS, and in-app notifications.
// Dependency-free (raw HTTP APIs) so it works in any serverless runtime.
//
// Delivery goes live the moment these env vars exist in Vercel:
//   Email: RESEND_API_KEY  (or SENDGRID_API_KEY)  [+ NOTIFY_FROM_EMAIL]
//   SMS:   TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER
// Without keys, sends are skipped silently but in-app notifications
// (the bell in the Manager and Team Portal) always work.

const { query, execute, ensureTables } = require('./_team-db');

const FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || 'onboarding@resend.dev';

function e164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}

// Provider keys: Vercel env vars win; otherwise the keys Zahra pasted
// into her Settings tab (stored in site_settings, never served publicly).
let _keyCache = null, _keyCacheAt = 0;
async function getKeys() {
  const now = Date.now();
  if (_keyCache && now - _keyCacheAt < 60000) return _keyCache;
  let db = {};
  try {
    await ensureTables();
    const rows = await query("SELECT key, value FROM site_settings WHERE key IN ('twilio_sid','twilio_token','twilio_from','resend_key','notify_from_email')");
    for (const r of rows) db[r.key] = String(r.value || '').trim();
  } catch (_) {}
  _keyCache = {
    resendKey: process.env.RESEND_API_KEY || db.resend_key || '',
    sendgridKey: process.env.SENDGRID_API_KEY || '',
    twilioSid: process.env.TWILIO_ACCOUNT_SID || db.twilio_sid || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || db.twilio_token || '',
    twilioFrom: process.env.TWILIO_PHONE_NUMBER || db.twilio_from || '',
    fromEmail: process.env.NOTIFY_FROM_EMAIL || db.notify_from_email || FROM_EMAIL,
  };
  _keyCacheAt = now;
  return _keyCache;
}
function clearKeyCache() { _keyCache = null; }

async function providerStatus() {
  const k = await getKeys();
  return {
    email: !!(k.resendKey || k.sendgridKey),
    sms: !!(k.twilioSid && k.twilioToken && k.twilioFrom),
  };
}

async function sendEmail(to, subject, html) {
  if (!to || !/@/.test(to)) return { sent: false, why: 'no email' };
  try {
    const k = await getKeys();
    if (k.resendKey) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${k.resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `ZOLA Nail Studio <${k.fromEmail}>`, to: [to], subject, html }),
      });
      const detail = r.ok ? 'resend' : 'resend ' + r.status + ' ' + (await r.text()).slice(0, 200);
      return { sent: r.ok, why: detail };
    }
    if (k.sendgridKey) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${k.sendgridKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: k.fromEmail, name: 'ZOLA Nail Studio' },
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
  const k = await getKeys();
  if (!k.twilioSid || !k.twilioToken || !k.twilioFrom) return { sent: false, why: 'no SMS provider key configured' };
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${k.twilioSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(k.twilioSid + ':' + k.twilioToken).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: k.twilioFrom, Body: body }).toString(),
    });
    const detail = (r.ok || r.status === 201) ? 'twilio' : 'twilio ' + r.status + ' ' + (await r.text()).slice(0, 200);
    return { sent: r.ok || r.status === 201, why: detail };
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

module.exports = { sendEmail, sendSMS, notifyInApp, notifyNewAppointment, e164, providerStatus, clearKeyCache };
