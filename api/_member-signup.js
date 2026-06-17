const { queryOne, execute } = require('./_db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Stripe = require('stripe');

const TIER_PRICES = {
  SIGNATURE:  'price_signature_monthly',
  LUXE:       'price_luxe_monthly',
  BLACK_CARD: 'price_black_card_monthly',
};

function generateMemberId(fullName) {
  const parts = fullName.trim().split(/\s+/);
  const initials = parts.map(p => p[0].toUpperCase()).join('').slice(0, 3);
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  return `ZL-${initials}${rand}`;
}

function generateReferralCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function generateQrSecret() {
  return crypto.randomBytes(20).toString('hex');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { fullName, email, phone, dateOfBirth, heardAbout, tier, password, referralCode, stripePaymentMethodId, action } = req.body;

  // Re-send member ID via SMS
  if (action === 'resend_sms') {
    const { memberId, phone: smsPhone } = req.body;
    try {
      const member = await queryOne('SELECT full_name, tier FROM members WHERE member_id = ?', [(memberId || '').toUpperCase()]);
      if (member && smsPhone) {
        await sendWelcome({ fullName: member.full_name, email: '', phone: smsPhone, memberId, tier: member.tier });
      }
    } catch (_) {}
    return res.status(200).json({ success: true });
  }

  // Re-send welcome email
  if (action === 'resend_email') {
    const { memberId, email: resendEmail } = req.body;
    try {
      const member = await queryOne('SELECT full_name, tier, email FROM members WHERE member_id = ?', [(memberId || '').toUpperCase()]);
      if (member) {
        await sendWelcome({ fullName: member.full_name, email: resendEmail || member.email, phone: '', memberId, tier: member.tier });
      }
    } catch (_) {}
    return res.status(200).json({ success: true });
  }

  if (!fullName || !email || !tier || !password) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const validTiers = ['SIGNATURE', 'LUXE', 'BLACK_CARD'];
  if (!validTiers.includes(tier)) {
    return res.status(400).json({ error: 'Invalid tier.' });
  }

  try {
    const existing = await queryOne('SELECT id, stripe_subscription_id FROM members WHERE email = ?', [email.toLowerCase().trim()]);
    if (existing) {
      // Cancel old Stripe subscription if still active, then remove old record so they can re-subscribe
      if (existing.stripe_subscription_id) {
        try { await stripe.subscriptions.cancel(existing.stripe_subscription_id); } catch (_) {}
      }
      await execute('DELETE FROM members WHERE email = ?', [email.toLowerCase().trim()]);
    }

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const customer = await stripe.customers.create({
      name: fullName,
      email: email.toLowerCase().trim(),
      phone: phone || undefined,
      metadata: { tier },
    });

    await stripe.paymentMethods.attach(stripePaymentMethodId, { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: stripePaymentMethodId } });

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env[`STRIPE_PRICE_${tier}`] || TIER_PRICES[tier] }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: { tier, memberEmail: email },
    });

    const memberId = generateMemberId(fullName);
    const passwordHash = bcrypt.hashSync(password, 10);
    const referral = generateReferralCode();
    const qrSecret = generateQrSecret();

    const now = new Date().toISOString();
    const nextBilling = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const referredByCode = referralCode || null;

    await execute(`
      INSERT INTO members
        (full_name, email, phone, date_of_birth, heard_about, tier, member_id, password_hash, qr_secret,
         stripe_customer_id, stripe_subscription_id, referral_code, referred_by_code,
         membership_started_at, next_billing_at, services_reset_month)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      fullName, email.toLowerCase().trim(), phone || null, dateOfBirth || null,
      heardAbout || null, tier, memberId, passwordHash, qrSecret,
      customer.id, subscription.id, referral, referredByCode,
      now, nextBilling, new Date().toISOString().slice(0, 7)
    ]);

    if (referredByCode) {
      const referrer = await queryOne('SELECT member_id FROM members WHERE referral_code = ?', [referredByCode]);
      if (referrer) {
        await execute('INSERT INTO referrals (referrer_member_id, referee_email, referee_member_id, status) VALUES (?,?,?,?)',
          [referrer.member_id, email.toLowerCase().trim(), memberId, 'COMPLETED']);
      }
    }

    try { await sendWelcome({ fullName, email, phone, memberId, tier }); } catch (_) {}

    return res.status(201).json({
      success: true,
      memberId,
      tier,
      referralCode: referral,
      nextBillingDate: nextBilling,
      clientSecret: subscription.latest_invoice?.payment_intent?.client_secret || null,
    });

  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: err.message || 'Signup failed.' });
  }
};

function formatPhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

async function sendWelcome({ fullName, email, phone, memberId, tier }) {
  const tierLabel = { SIGNATURE: 'Signature Club', LUXE: 'Luxe Club', BLACK_CARD: 'Black Card' }[tier];
  const firstName = fullName.split(' ')[0];

  if (email) {
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    await sgMail.send({
      to: email,
      from: 'studio@zluxnails.com',
      subject: `Welcome to Z Lux — Your Member ID is ${memberId}`,
      html: `
        <div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;color:#2C1A0E;background:#FDFAF7;">
          <div style="background:#2C1A0E;padding:2.5rem 2rem;text-align:center;">
            <h1 style="color:#C9A55A;font-size:2.25rem;margin:0;letter-spacing:0.12em;font-weight:400;">ZLUX</h1>
            <p style="color:#A67C52;font-size:0.75rem;letter-spacing:0.2em;text-transform:uppercase;margin:0.5rem 0 0;">Nail Studio · Porterville, CA</p>
          </div>
          <div style="padding:2.5rem 2rem;">
            <p style="font-size:1.05rem;">Hello ${firstName},</p>
            <p>You're officially in. Welcome to <strong>${tierLabel}</strong> — we're so glad you're here.</p>
            <div style="background:#F5EFE6;border-left:3px solid #C9A55A;padding:1.25rem 1.5rem;margin:1.5rem 0;text-align:center;">
              <p style="font-size:0.7rem;letter-spacing:0.2em;text-transform:uppercase;color:#A67C52;margin:0 0 0.5rem;">Your Member ID</p>
              <p style="font-size:1.6rem;letter-spacing:0.15em;font-weight:bold;color:#2C1A0E;margin:0;">${memberId}</p>
            </div>
            <p>Keep this ID somewhere safe. You'll use it every time you book, check in at the studio, and access your member portal.</p>
            <div style="text-align:center;margin:2rem 0;">
              <a href="https://zlux-github.vercel.app/client-portal.html" style="background:#C9A55A;color:#2C1A0E;padding:0.875rem 2rem;text-decoration:none;font-size:0.78rem;letter-spacing:0.15em;text-transform:uppercase;font-weight:700;font-family:Georgia,serif;">Go to My Portal</a>
            </div>
            <p style="color:#A67C52;font-size:0.82rem;border-top:1px solid rgba(201,165,90,0.2);padding-top:1.25rem;margin-top:2rem;">Z Lux Nail Studio &middot; Porterville, CA &middot; <a href="https://zlux-github.vercel.app" style="color:#C9A55A;">zlux-github.vercel.app</a></p>
          </div>
        </div>
      `,
    });
  }

  const e164 = formatPhone(phone);
  if (e164 && process.env.TWILIO_ACCOUNT_SID) {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilio.messages.create({
      body: `Welcome to Z Lux, ${firstName}! 🌟 You're in. Your Member ID is ${memberId} — save it, you'll need it to book. See you soon. — Z Lux Studio`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: e164,
    });
  }
}
