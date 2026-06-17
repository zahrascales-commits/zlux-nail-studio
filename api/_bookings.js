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
        subject: `Your Zola appointment is confirmed — ${formattedDate}`,
        html: `
          <div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;color:#0D0D0D;background:#FAFAF8;">
            <div style="background:#0D0D0D;padding:2.5rem 2rem;text-align:center;">
              <h1 style="color:#C4A882;font-size:2.25rem;margin:0;letter-spacing:0.08em;font-weight:400;">ZOLA</h1>
              <p style="color:#8B6A3E;font-size:0.75rem;letter-spacing:0.2em;text-transform:uppercase;margin:0.5rem 0 0;">Nail Studio · Porterville, CA</p>
            </div>
            <div style="padding:2.5rem 2rem;">
              <p style="font-size:1.15rem;font-style:italic;color:#8B6A3E;margin:0 0 0.5rem;">${greeting}</p>
              <p>Hi ${firstName}, you're all set. Here are your appointment details:</p>

              <div style="background:#F5EEE8;border-left:3px solid #C4A882;padding:1.5rem;margin:1.5rem 0;">
                <table style="width:100%;border-collapse:collapse;font-size:0.92rem;">
                  <tr><td style="padding:0.4rem 0;color:#8B6A3E;width:40%;">Confirmation</td><td style="font-weight:bold;">${confirmation}</td></tr>
                  <tr><td style="padding:0.4rem 0;color:#8B6A3E;">Service</td><td>${serviceName}${addonsLine ? `<br><span style="color:#8B6A3E;font-size:0.85rem;">+ ${addonsLine}</span>` : ''}</td></tr>
                  <tr><td style="padding:0.4rem 0;color:#8B6A3E;">Date</td><td>${formattedDate}</td></tr>
                  <tr><td style="padding:0.4rem 0;color:#8B6A3E;">Time</td><td>${formattedTime}</td></tr>
                  <tr><td style="padding:0.4rem 0;color:#8B6A3E;">Total</td><td>${total}</td></tr>
                  <tr><td style="padding:0.4rem 0;color:#8B6A3E;">Deposit Due</td><td style="color:#0D0D0D;font-weight:bold;">${deposit}</td></tr>
                </table>
              </div>

              <div style="margin:2rem 0;padding:1.25rem 1.5rem;border:1px solid rgba(196,168,130,0.25);">
                <p style="font-size:0.7rem;letter-spacing:0.2em;text-transform:uppercase;color:#8B6A3E;margin:0 0 0.75rem;">Before You Come In</p>
                <p style="margin:0;line-height:1.7;font-size:0.9rem;">💅 ${fact}</p>
              </div>

              <p style="font-size:0.88rem;line-height:1.7;color:#3a2a1a;">Need to reschedule or have questions? Reply to this email or call us directly. We're flexible — just give us at least 24 hours' notice so we can fill your spot.</p>

              <p style="color:#8B6A3E;font-size:0.82rem;border-top:1px solid rgba(196,168,130,0.2);padding-top:1.25rem;margin-top:2rem;">
                Zola Nail Studio &middot; Porterville, CA<br>
                <a href="https://zlux-github.vercel.app" style="color:#C4A882;">zlux-github.vercel.app</a>
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
        body: `Zola confirmed! ✨ Hi ${firstName}, your ${serviceName} is booked for ${formattedDate} at ${formattedTime}. Confirmation: ${confirmation}. Deposit: ${deposit}. See you soon! — Zola Studio`,
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
    const {
      customer_name, customer_email, customer_phone,
      service_name, service_price,
      addon_names = [], addon_charged = [],
      member_id, member_tier,
      date, time_slot, worker,
    } = req.body;

    if (!customer_name || !customer_email || !customer_phone || !service_name || !date || !time_slot)
      return res.status(400).json({ error: 'All fields are required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    // Apply server-side addon discount validation based on tier
    const ADDON_DISCOUNT = { SIGNATURE: 0.10, LUXE: 0.30, BLACK_CARD: 0.75 };
    const discountPct = member_tier ? (ADDON_DISCOUNT[member_tier] || 0) : 0;

    const addonTotal = addon_charged.reduce((sum, cents) => sum + Number(cents), 0);
    const service_cents = Number(service_price) || 0;

    // Validate discounts aren't being inflated (client can't give themselves bigger discounts)
    const addonBasePrices = addon_names.map(name => {
      const a = addons.find(x => x.name === name);
      return a ? a.price_cents : 0;
    });
    const maxAllowedAddonTotal = addonBasePrices.reduce((sum, base) => {
      return sum + Math.round(base * (1 - discountPct));
    }, 0);
    const validatedAddonTotal = Math.min(addonTotal, maxAllowedAddonTotal);

    const total_cents = service_cents + validatedAddonTotal;
    const deposit_cents = Math.ceil(total_cents * 0.5);

    const id = incId();
    const confirmation = `ZOLA-${String(id).padStart(5, '0')}`;

    bookings.push({
      id, customer_name, customer_email, customer_phone,
      service_name, addon_names, member_id, member_tier,
      date, time_slot, worker,
      total_cents, deposit_cents,
      created_at: new Date().toISOString(),
    });

    sendBookingConfirmation({
      customerName: customer_name,
      customerEmail: customer_email,
      customerPhone: customer_phone,
      serviceName: service_name,
      addonNames: addon_names,
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
