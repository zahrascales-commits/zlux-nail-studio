const { services, addons, bookings, ALL_SLOTS, incId } = require('./_store');

const NAIL_FACTS = [
  "Cuticle oil is your best friend before a visit — apply it daily leading up to your appointment for the smoothest results.",
  "Avoid soaking your nails for 24 hours before your appointment. Wet nails expand and can affect how product adheres.",
  "Come with clean, polish-free nails if you can — it gives us more chair time for the fun part.",
  "Your nails grow about 3mm per month — faster in summer, slower in winter. Timing your appointments seasonally makes a real difference.",
  "The white crescent at the base of your nail (the lunula) is the visible part of your nail matrix — treat it gently.",
  "Nails and hair are both made of keratin. The same hydration habits that help your hair help your nails too.",
  "Avoid cutting your cuticles at home before your visit — we'll take care of them properly in the studio.",
];

const GREETINGS = [
  "Good things are coming. Starting with your nails.",
  "Consider this your reminder that you deserve this.",
  "You booked. We're ready. This is going to be good.",
  "Your nails are about to have a moment.",
  "The best version of your hands starts here.",
  "We've been waiting for you. (Your nails have too.)",
  "This appointment? It's the self-care era. You're doing it right.",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function formatPhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return new Date(+y, +m - 1, +d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatTime(slot) {
  const [h, min] = slot.split(':');
  const hour = +h;
  return `${hour > 12 ? hour - 12 : hour}:${min} ${hour >= 12 ? 'PM' : 'AM'}`;
}

async function sendBookingConfirmation({ customerName, customerEmail, customerPhone, serviceName, addonNames, date, time, confirmation, totalCents, depositCents }) {
  const firstName = customerName.split(' ')[0];
  const fact = pick(NAIL_FACTS);
  const greeting = pick(GREETINGS);
  const total = `$${(totalCents / 100).toFixed(2)}`;
  const deposit = `$${(depositCents / 100).toFixed(2)}`;
  const formattedDate = formatDate(date);
  const formattedTime = formatTime(time);
  const addonsLine = addonNames.length ? addonNames.join(', ') : null;

  if (customerEmail) {
    try {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      await sgMail.send({
        to: customerEmail,
        from: 'studio@zluxnails.com',
        subject: `Your Z Lux appointment is confirmed — ${formattedDate}`,
        html: `
          <div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;color:#2C1A0E;background:#FDFAF7;">
            <div style="background:#2C1A0E;padding:2.5rem 2rem;text-align:center;">
              <h1 style="color:#C9A55A;font-size:2.25rem;margin:0;letter-spacing:0.12em;font-weight:400;">ZLUX</h1>
              <p style="color:#A67C52;font-size:0.75rem;letter-spacing:0.2em;text-transform:uppercase;margin:0.5rem 0 0;">Nail Studio · Porterville, CA</p>
            </div>
            <div style="padding:2.5rem 2rem;">
              <p style="font-size:1.15rem;font-style:italic;color:#A67C52;margin:0 0 0.5rem;">${greeting}</p>
              <p>Hi ${firstName}, you're all set. Here are your appointment details:</p>

              <div style="background:#F5EFE6;border-left:3px solid #C9A55A;padding:1.5rem;margin:1.5rem 0;">
                <table style="width:100%;border-collapse:collapse;font-size:0.92rem;">
                  <tr><td style="padding:0.4rem 0;color:#A67C52;width:40%;">Confirmation</td><td style="font-weight:bold;">${confirmation}</td></tr>
                  <tr><td style="padding:0.4rem 0;color:#A67C52;">Service</td><td>${serviceName}${addonsLine ? `<br><span style="color:#A67C52;font-size:0.85rem;">+ ${addonsLine}</span>` : ''}</td></tr>
                  <tr><td style="padding:0.4rem 0;color:#A67C52;">Date</td><td>${formattedDate}</td></tr>
                  <tr><td style="padding:0.4rem 0;color:#A67C52;">Time</td><td>${formattedTime}</td></tr>
                  <tr><td style="padding:0.4rem 0;color:#A67C52;">Total</td><td>${total}</td></tr>
                  <tr><td style="padding:0.4rem 0;color:#A67C52;">Deposit Due</td><td style="color:#2C1A0E;font-weight:bold;">${deposit}</td></tr>
                </table>
              </div>

              <div style="margin:2rem 0;padding:1.25rem 1.5rem;border:1px solid rgba(201,165,90,0.25);">
                <p style="font-size:0.7rem;letter-spacing:0.2em;text-transform:uppercase;color:#A67C52;margin:0 0 0.75rem;">Before You Come In</p>
                <p style="margin:0;line-height:1.7;font-size:0.9rem;">💅 ${fact}</p>
              </div>

              <p style="font-size:0.88rem;line-height:1.7;color:#5a3e2b;">Need to reschedule or have questions? Reply to this email or call us directly. We're flexible — just give us at least 24 hours' notice so we can fill your spot.</p>

              <p style="color:#A67C52;font-size:0.82rem;border-top:1px solid rgba(201,165,90,0.2);padding-top:1.25rem;margin-top:2rem;">
                Z Lux Nail Studio &middot; Porterville, CA<br>
                <a href="https://zlux-github.vercel.app" style="color:#C9A55A;">zlux-github.vercel.app</a>
              </p>
            </div>
          </div>
        `,
      });
    } catch (_) {}
  }

  const e164 = formatPhone(customerPhone);
  if (e164 && process.env.TWILIO_ACCOUNT_SID) {
    try {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilio.messages.create({
        body: `Z Lux confirmed! ✨ Hi ${firstName}, your ${serviceName} is booked for ${formattedDate} at ${formattedTime}. Confirmation: ${confirmation}. Deposit: ${deposit}. See you soon! — Z Lux Studio`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: e164,
      });
    } catch (_) {}
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.json(
      bookings.map((b) => ({
        ...b,
        service_name: (services.find((s) => s.id === b.service_id) || {}).name,
      }))
    );
  }

  if (req.method === 'POST') {
    const { service_id, addon_ids = [], customer_name, customer_email, customer_phone, date, time_slot } = req.body;

    if (!service_id || !customer_name || !customer_email || !customer_phone || !date || !time_slot)
      return res.status(400).json({ error: 'All fields are required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    if (!ALL_SLOTS.includes(time_slot)) return res.status(400).json({ error: 'Invalid time slot' });

    const service = services.find((s) => s.id === +service_id);
    if (!service) return res.status(400).json({ error: 'Invalid service_id' });

    const selectedAddons = addon_ids.map((aid) => addons.find((a) => a.id === +aid)).filter(Boolean);
    const addonTotal = selectedAddons.reduce((sum, a) => sum + a.price_cents, 0);
    const total_cents = service.price_cents + addonTotal;
    const deposit_cents = Math.ceil(total_cents / 2);

    const conflict = bookings.find(
      (b) => String(b.service_id) === String(service_id) && b.date === date && b.time_slot === time_slot
    );
    if (conflict) return res.status(409).json({ error: 'That slot is already booked' });

    const id = incId();
    const confirmation = `ZLX-${String(id).padStart(5, '0')}`;

    bookings.push({
      id,
      service_id: +service_id,
      addon_ids: selectedAddons.map((a) => a.id),
      customer_name,
      customer_email,
      customer_phone,
      date,
      time_slot,
      total_cents,
      deposit_cents,
      created_at: new Date().toISOString(),
    });

    // Fire confirmation messages — don't await so booking response is instant
    sendBookingConfirmation({
      customerName: customer_name,
      customerEmail: customer_email,
      customerPhone: customer_phone,
      serviceName: service.name,
      addonNames: selectedAddons.map(a => a.name),
      date,
      time: time_slot,
      confirmation,
      totalCents: total_cents,
      depositCents: deposit_cents,
    }).catch(() => {});

    return res.status(201).json({ id, confirmation, total_cents, deposit_cents });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
