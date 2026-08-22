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
  // Report the address mail actually goes out as, and whether it's still the
  // sandbox. A key alone isn't enough — sending from onboarding@resend.dev
  // reaches nobody but the account owner, which looks identical to working.
  const sandbox = /@resend\.dev$/i.test(k.fromEmail || '');
  return {
    email: !!(k.resendKey || k.sendgridKey),
    sms: !!(k.twilioSid && k.twilioToken && k.twilioFrom),
    from_email: k.fromEmail || '',
    from_is_sandbox: sandbox,
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
// One confirmation text carrying everything they need before they arrive:
// where to go, who they're seeing, and the one-tap way to send their inspo.
// What a client needs before they arrive and after they leave. Kept as one
// list so the text and the email can never say different things.
const PREP_LINES = [
  'No lotion or oils on your hands for 24 hours before.',
  'Arrive with hands freshly washed and clean.',
];
const AFTERCARE_LINES = [
  'No lotion or oils for 24 hours afterwards.',
  'Keep hands out of water as much as you can while the set cures.',
];

function clientSms(a, when, address, inspoLink) {
  const first = (a.clientName || '').split(' ')[0] || 'there';
  const lines = [];
  lines.push('ZOLA NAIL STUDIO');
  lines.push('');
  lines.push('Confirmed, ' + first + '.');
  lines.push((a.service || 'Your appointment') + (a.memberName ? ' with ' + a.memberName : ''));
  lines.push(when);
  if (address) lines.push(address);
  lines.push('');
  lines.push('BEFORE YOUR VISIT');
  PREP_LINES.forEach(l => lines.push('- ' + l));
  lines.push('');
  lines.push('AFTERCARE');
  AFTERCARE_LINES.forEach(l => lines.push('- ' + l));
  if (inspoLink) {
    lines.push('');
    lines.push('Send your inspiration photo: ' + inspoLink);
  }
  lines.push('');
  lines.push('Arrive as you are. You will leave immaculate.');
  lines.push('Reply STOP to opt out.');
  return lines.join('\n');
}

// Where the studio is and the one-tap way to send an inspo photo. Both are
// owner-editable, so a move or a rename never means editing code.
async function bookingContext(a) {
  const SITE = process.env.PUBLIC_SITE_URL || 'https://zolanailstudio.com';
  let studioAddress = '';
  try {
    const { queryOne } = require('./_team-db');
    const row = await queryOne("SELECT value FROM site_settings WHERE key='studio_address'");
    studioAddress = (row && row.value) || '';
  } catch (_) {}
  return {
    when: `${a.dateLabel || a.date} at ${a.timeLabel || a.time}`,
    studioAddress,
    inspoLink: a.confirmation ? `${SITE}/inspo.html?c=${encodeURIComponent(a.confirmation)}` : '',
  };
}

// Sent the moment they book, when the artist is still being decided. Short on
// purpose: its whole job is to stop the silence between paying and knowing who
// they are seeing. The real confirmation follows.
function pendingSms(a, when) {
  const first = (a.clientName || '').split(' ')[0] || 'there';
  const lines = [];
  lines.push('ZOLA NAIL STUDIO');
  lines.push('');
  lines.push('Received, ' + first + '.');
  lines.push((a.service || 'Your appointment'));
  lines.push(when);
  lines.push('');
  lines.push('We are assigning your artist now. Your full confirmation lands shortly.');
  lines.push('');
  lines.push('Reply STOP to opt out.');
  return lines.join('\n');
}

async function notifyClientPending(a) {
  const { when } = await bookingContext(a);
  const out = { email: null, sms: null };
  if (a.clientPhone) out.sms = await sendSMS(a.clientPhone, pendingSms(a, when));
  if (a.clientEmail) {
    out.email = await sendEmail(a.clientEmail, `We have your booking — ${a.dateLabel || a.date}`,
      `<div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;background:#FAFAF8;color:#0D0D0D">
        <div style="background:#0D0D0D;padding:2.2rem;text-align:center">
          <h1 style="color:#C4A882;margin:0;letter-spacing:0.1em;font-weight:400">ZOLA</h1>
          <p style="color:#8B6A3E;font-size:0.72rem;letter-spacing:0.2em;text-transform:uppercase;margin:0.4rem 0 0">Nail Studio · Porterville, CA</p>
        </div>
        <div style="padding:2rem">
          <p>Hi ${(a.clientName || 'love').split(' ')[0]}, we have you ✦</p>
          <div style="background:#F5EEE8;border-left:3px solid #C4A882;padding:1.2rem;margin:1.2rem 0">
            <p style="margin:0.2rem 0"><b>Service:</b> ${a.service || 'Appointment'}</p>
            <p style="margin:0.2rem 0"><b>When:</b> ${when}</p>
          </div>
          <p style="font-size:0.95rem;line-height:1.7">We are assigning your artist now. Your full confirmation — with her name, the address, and how to prepare — is on its way.</p>
        </div>
      </div>`);
  }
  return out;
}

// The real one. Everything they need: their name, the service, their artist,
// the time, the address, how to prepare, and how to care for the set.
async function notifyClientConfirmed(a) {
  const { when, studioAddress, inspoLink } = await bookingContext(a);
  const out = { email: null, sms: null };
  if (a.clientEmail) {
    out.email = await sendEmail(a.clientEmail,
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
            ${studioAddress ? `<p style="margin:0.2rem 0"><b>Where:</b> ${studioAddress}</p>` : ''}
          </div>
          ${inspoLink ? `<div style="background:#fff;border:1px solid #E5D9C6;padding:1.2rem;margin:1.2rem 0;text-align:center">
            <p style="margin:0 0 0.9rem;font-size:0.92rem">Send us your inspo photo so we can prep before you arrive ✦</p>
            <a href="${inspoLink}" style="display:inline-block;background:#C4A882;color:#0D0D0D;text-decoration:none;padding:13px 26px;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;font-weight:bold">Add My Inspo Photo</a>
          </div>` : ''}
          <div style="display:flex;gap:1rem;flex-wrap:wrap;margin:1.4rem 0">
            <div style="flex:1;min-width:200px;background:#fff;border:1px solid #E5D9C6;padding:1rem 1.1rem">
              <p style="margin:0 0 0.6rem;font-size:0.68rem;letter-spacing:0.16em;text-transform:uppercase;color:#8B6A3E">Before your visit</p>
              <p style="margin:0 0 0.4rem;font-size:0.86rem;line-height:1.6">No lotion or oils on your hands for 24 hours before.</p><p style="margin:0 0 0.4rem;font-size:0.86rem;line-height:1.6">Arrive with hands freshly washed and clean.</p>
            </div>
            <div style="flex:1;min-width:200px;background:#fff;border:1px solid #E5D9C6;padding:1rem 1.1rem">
              <p style="margin:0 0 0.6rem;font-size:0.68rem;letter-spacing:0.16em;text-transform:uppercase;color:#8B6A3E">Aftercare</p>
              <p style="margin:0 0 0.4rem;font-size:0.86rem;line-height:1.6">No lotion or oils for 24 hours afterwards.</p><p style="margin:0 0 0.4rem;font-size:0.86rem;line-height:1.6">Keep hands out of water as much as you can while the set cures.</p>
            </div>
          </div>
          <p style="font-size:0.95rem;color:#0D0D0D;font-style:italic;margin:1.2rem 0">Arrive as you are. You will leave immaculate.</p>
          <p style="font-size:0.85rem;color:#8B6A3E">Need to change it? Give us 24 hours' notice and we'll take care of you.</p>
        </div>
      </div>`);
  }
  if (a.clientPhone) out.sms = await sendSMS(a.clientPhone, clientSms(a, when, studioAddress, inspoLink));
  return out;
}

async function notifyNewAppointment(a) {
  const results = { client_email: null, client_sms: null, artist: null };
  const { when } = await bookingContext(a);

  // A booking with an artist already on it is confirmed outright. One still
  // out for claim gets the holding message instead — _claims sends the real
  // confirmation the moment somebody takes it, so sending it here too would
  // promise the client an artist nobody has agreed to be.
  if (!a.pendingClaim) {
    const c = await notifyClientConfirmed(a);
    results.client_email = c.email;
    results.client_sms = c.sms;
  }

  // whoever got booked — instant in-app + SMS/email
  const title = `New appointment ✦ ${a.clientName || 'Client'}`;
  const body = `${a.service || 'Service'} — ${when}${a.clientPhone ? ' · ' + a.clientPhone : ''}`;
  if (a.memberId) {
    await notifyInApp('member', a.memberId, title, body);
    // Carry a one-tap link into her own schedule. Being asked for a PIN right
    // after tapping a notification is what stops people checking at all.
    let link = '';
    try { link = await require('./_worker-link').linkFor(a.memberId); } catch (_) {}
    if (a.memberPhone) {
      await sendSMS(a.memberPhone,
        `ZOLA: new appointment — ${a.clientName || 'Client'}, ${a.service || ''}, ${when}.` +
        (link ? ` Your full schedule: ${link}` : ' Check your Team Portal.'));
    }
    if (a.memberEmail) {
      await sendEmail(a.memberEmail, title,
        `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px">
          <div style="max-width:500px;margin:0 auto;background:#fff;padding:28px 26px;border:1px solid #eee5d8">
            <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:3px;margin-bottom:18px">ZOLA</div>
            <p style="font-size:15px;color:#3a3027;margin:0 0 12px"><b>${title}</b></p>
            <p style="font-size:15px;color:#3a3027;line-height:1.7;margin:0 0 20px">${body}</p>
            ${link ? `<a href="${link}" style="display:inline-block;background:#B6A588;color:#0D0D0D;text-decoration:none;padding:13px 26px;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;font-weight:bold">Open My Schedule</a>
            <p style="font-size:11px;color:#8C7A5E;margin-top:18px">This link signs you in automatically — keep it private.</p>` : ''}
          </div></div>`);
    }
    // The one that lands on a locked phone. Text is the backstop for anyone
    // who never set this up.
    try {
      await require('./_push').pushToMember(a.memberId, {
        title: `New appointment · ${a.service || 'Service'}`,
        body: `${a.clientName || 'Client'} · ${when}`,
        url: '/team.html', tag: 'zola-appt-' + (a.confirmation || when),
      });
    } catch (_) {}
    results.artist = 'member ' + a.memberId;
  }
  // Owner gets an in-app copy of every booking — except one still out for
  // claim, where _claims posts a better one naming who it went to.
  if (!a.pendingClaim) {
    await notifyInApp('owner', null, a.memberId ? title + ` → ${a.memberName || 'artist'}` : title + ' → you', body);
    try {
      await require('./_push').pushToOwner({
        title: a.memberId ? `New booking → ${a.memberName || 'artist'}` : 'New booking',
        body: `${a.clientName || 'Client'} · ${a.service || ''} · ${when}`,
        url: '/manager.html', tag: 'zola-booking',
      });
    } catch (_) {}
  }
  return results;
}

module.exports = {
  sendEmail, sendSMS, notifyInApp, notifyNewAppointment,
  notifyClientPending, notifyClientConfirmed, bookingContext,
  e164, providerStatus, clearKeyCache,
};
