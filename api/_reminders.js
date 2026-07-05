const { query, execute } = require('./_db');

function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h > 12 ? h - 12 : (h || 12)}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDate(d) {
  const [y, mo, day] = d.split('-');
  return new Date(+y, +mo - 1, +day).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatPhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

module.exports = async (req, res) => {
  // Must supply a secret so this isn't publicly callable
  const key = req.headers['x-reminder-key'] || req.query.key;
  if (key !== (process.env.REMINDER_KEY || 'ZOLA-REMIND-2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const nowTs = now.getTime();

  // Get all scheduled appointments that haven't had their reminders sent
  let appts = [];
  try {
    appts = await query(`
      SELECT a.id, a.appointment_date, a.appointment_time, a.service, a.notes,
             a.reminder_24h_sent, a.reminder_2h_sent,
             m.full_name, m.email, m.phone,
             a.guest_name, a.guest_email
      FROM appointments a
      LEFT JOIN members m ON a.member_id = m.member_id
      WHERE a.status = 'SCHEDULED'
        AND (a.reminder_24h_sent = 0 OR a.reminder_2h_sent = 0)
      ORDER BY a.appointment_date, a.appointment_time
    `, []);
  } catch (_) {
    // Table may not have reminder columns yet — add them
    try {
      await execute("ALTER TABLE appointments ADD COLUMN reminder_24h_sent INTEGER DEFAULT 0", []);
      await execute("ALTER TABLE appointments ADD COLUMN reminder_2h_sent INTEGER DEFAULT 0", []);
    } catch (_) {}
    return res.json({ sent: 0, note: 'Reminder columns added — run again' });
  }

  let sent = 0;
  const sgMail = process.env.SENDGRID_API_KEY ? require('@sendgrid/mail') : null;
  if (sgMail) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const twilioClient = process.env.TWILIO_ACCOUNT_SID
    ? require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

  for (const appt of appts) {
    const apptTs = new Date(`${appt.appointment_date}T${appt.appointment_time}:00`).getTime();
    const diffMs = apptTs - nowTs;
    const diffH = diffMs / 3600000;

    const name = appt.full_name || appt.guest_name || 'there';
    const firstName = name.split(' ')[0];
    const email = appt.email || appt.guest_email;
    const phone = appt.phone;
    const dateStr = fmtDate(appt.appointment_date);
    const timeStr = fmtTime(appt.appointment_time);

    // 24h reminder: send if appointment is 20–28h away and not yet sent
    if (!Number(appt.reminder_24h_sent) && diffH >= 20 && diffH <= 28) {
      const subject = `Reminder: Your Zola appointment is tomorrow`;
      const body = `Hi ${firstName}, just a reminder that your ${appt.service} appointment at Zola is tomorrow, ${dateStr} at ${timeStr}. Need to reschedule? Reply to this email at least 24 hours before your appointment. See you soon! — Zola`;

      if (email && sgMail) {
        try {
          await sgMail.send({ to: email, from: 'studio@zluxnails.com', subject, text: body });
        } catch (_) {}
      }
      if (phone && twilioClient) {
        const e164 = formatPhone(phone);
        if (e164) {
          try {
            await twilioClient.messages.create({
              body: `Zola reminder: Your ${appt.service} is tomorrow at ${timeStr}. Reply CANCEL to begin cancellation. — Zola Studio`,
              from: process.env.TWILIO_PHONE_NUMBER,
              to: e164,
            });
          } catch (_) {}
        }
      }
      await execute('UPDATE appointments SET reminder_24h_sent=1 WHERE id=?', [appt.id]).catch(() => {});
      sent++;
    }

    // 2h reminder: send if appointment is 1.5–3h away and not yet sent
    if (!Number(appt.reminder_2h_sent) && diffH >= 1.5 && diffH <= 3) {
      const body = `Hi ${firstName}, your Zola ${appt.service} appointment is in about 2 hours (${timeStr}). We're ready for you! — Zola Studio`;

      if (email && sgMail) {
        try {
          await sgMail.send({ to: email, from: 'studio@zluxnails.com', subject: `See you soon — Zola appointment in 2 hours`, text: body });
        } catch (_) {}
      }
      if (phone && twilioClient) {
        const e164 = formatPhone(phone);
        if (e164) {
          try {
            await twilioClient.messages.create({
              body,
              from: process.env.TWILIO_PHONE_NUMBER,
              to: e164,
            });
          } catch (_) {}
        }
      }
      await execute('UPDATE appointments SET reminder_2h_sent=1 WHERE id=?', [appt.id]).catch(() => {});
      sent++;
    }
  }

  return res.json({ ok: true, sent, checked: appts.length });
};
