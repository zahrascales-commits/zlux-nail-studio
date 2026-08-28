const { queryOne, execute } = require('./_db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Stripe = require('stripe');

const TIER_PRICES = {
  SIGNATURE:  'price_signature_monthly',
  LUXE:       'price_luxe_monthly',
  BLACK_CARD: 'price_black_card_monthly',
};

// What each tier costs per month, in cents. The Stripe price is the real
// source of truth; this is the fallback used to work out a discount when the
// price object cannot be read.
const TIER_CENTS = {
  // The two tiers now sold. These bill every four weeks, not monthly.
  ESSENTIAL: 8000, ELITE: 11000,
  // Retired. Kept so existing members keep working; nobody new can buy one.
  SIGNATURE: 9900, LUXE: 19900, BLACK_CARD: 29900, TEST: 158,
};

// Paying for the year. Roughly two months free on every tier — the saving is
// the difference between these and twelve monthly payments, not a made-up
// percentage.
const TIER_YEARLY_CENTS = {
  // Ten cycles' money for thirteen cycles of membership — the saving is
  // exactly three visits, which is the only way it is ever described.
  ESSENTIAL: 80000, ELITE: 110000,
  SIGNATURE: 99900, LUXE: 199900, BLACK_CARD: 299900, TEST: 1580,
};

// The yearly Stripe price, created the first time somebody buys one so she
// never has to set anything up by hand. Looked up by lookup_key so a second
// signup reuses it instead of creating a duplicate price every time.
// The four-week price. Stripe has no "every 4 weeks" interval, so it is a
// weekly interval counted in fours — thirteen charges a year. Created on
// first use and found by lookup key afterwards, so a second signup reuses
// it rather than minting a duplicate price every time.
async function cyclePriceFor(stripe, tier) {
  const amount = TIER_CENTS[tier];
  if (!amount) return null;
  const lookupKey = ('zola_' + tier + '_4week_' + amount).toLowerCase();
  try {
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
    if (found && found.data && found.data[0]) return found.data[0].id;
  } catch (_) {}
  const created = await stripe.prices.create({
    unit_amount: amount,
    currency: 'usd',
    recurring: { interval: 'week', interval_count: 4 },
    lookup_key: lookupKey,
    product_data: { name: 'ZOLA ' + tier.charAt(0) + tier.slice(1).toLowerCase() + ' — every 4 weeks' },
  });
  return created.id;
}

async function yearlyPriceFor(stripe, tier) {
  const amount = TIER_YEARLY_CENTS[tier];
  if (!amount) return null;
  const lookupKey = ('zola_' + tier + '_yearly_' + amount).toLowerCase();
  try {
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
    if (found && found.data && found.data[0]) return found.data[0].id;
  } catch (_) {}
  const created = await stripe.prices.create({
    unit_amount: amount,
    currency: 'usd',
    recurring: { interval: 'year' },
    lookup_key: lookupKey,
    product_data: { name: 'ZOLA ' + tier.replace('_', ' ') + ' — yearly' },
  });
  return created.id;
}

// Turns a code into a Stripe coupon that repeats every month.
//
// Built per code AND per amount, because "make it $100" is a different
// discount on Luxe than on Black Card. Reused once created — Stripe keeps
// coupons forever, and minting a new one per signup would litter the account.
async function couponFor(stripe, promo, tier, monthlyCents) {
  const { valueAgainst } = require('./_promo');
  const off = valueAgainst(promo, monthlyCents);
  if (off <= 0) return null;

  // Duration is part of the id: the same code at the same price repeating
  // monthly and applying once are two different coupons, and reusing one id
  // for both would hand the wrong one to whoever signed up second.
  const dur = promo.duration === 'once' ? 'once' : 'forever';
  const id = ('zola_' + promo.code + '_' + tier + '_' + off + '_' + dur).toLowerCase().replace(/[^a-z0-9_]/g, '');
  try {
    const found = await stripe.coupons.retrieve(id);
    if (found && !found.deleted) return found.id;
  } catch (_) { /* not created yet */ }

  const created = await stripe.coupons.create({
    id,
    amount_off: off,
    currency: 'usd',
    // Forever, not once. A founding rate that lapses after one month is not
    // a founding rate, and nobody would notice until the second invoice.
    duration: dur,
    name: promo.code + ' — ' + tier.replace('_', ' '),
    metadata: { code: promo.code, tier, kind: promo.kind || 'amount_off' },
  });
  return created.id;
}

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

  const { fullName, email, phone, dateOfBirth, heardAbout, tier, password, referralCode, promoCode, billing, stripePaymentMethodId, action } = req.body;

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

  // Only the two live tiers can be bought. The retired three are refused
  // here rather than on the page, so a stale tab or a saved link cannot sell
  // somebody a membership that no longer exists.
  const validTiers = ['ESSENTIAL', 'ELITE', 'TEST'];
  if (!validTiers.includes(tier)) {
    return res.status(400).json({
      error: ['SIGNATURE', 'LUXE', 'BLACK_CARD'].includes(tier)
        ? 'That membership is no longer available — please choose Essential or Elite.'
        : 'Invalid tier.',
    });
  }

  try {
    const stripe = Stripe(await require('./_pay').getStripeSecret());

    const existing = await queryOne('SELECT id, stripe_subscription_id FROM members WHERE email = ?', [email.toLowerCase().trim()]);
    if (existing) {
      // Cancel old Stripe subscription if still active, then remove old record so they can re-subscribe
      if (existing.stripe_subscription_id) {
        try { await stripe.subscriptions.cancel(existing.stripe_subscription_id); } catch (_) {}
      }
      await execute('DELETE FROM members WHERE email = ?', [email.toLowerCase().trim()]);
    }
    const customer = await stripe.customers.create({
      name: fullName,
      email: email.toLowerCase().trim(),
      phone: phone || undefined,
      metadata: { tier },
    });

    await stripe.paymentMethods.attach(stripePaymentMethodId, { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: stripePaymentMethodId } });

    // Resolve the Stripe price: owner-created prices in Settings first (these
    // live on the owner's connected Stripe account), then env var, then a
    // last-resort placeholder. Settings-first means switching Stripe accounts
    // just works once the prices are set up for that account.
    let priceId = null;
    try {
      const key = tier === 'TEST' ? 'stripe_price_test' : 'stripe_price_' + tier.toLowerCase();
      const row = await require('./_team-db').queryOne('SELECT value FROM site_settings WHERE key=?', [key]);
      priceId = row && row.value;
    } catch (_) {}
    if (!priceId) priceId = process.env[`STRIPE_PRICE_${tier}`] || null;
    if (!priceId) priceId = TIER_PRICES[tier];
    // Essential and Elite have no legacy price to fall back on and bill on a
    // four-week cycle, so their price is made here the first time one sells.
    if (['ESSENTIAL', 'ELITE'].includes(tier)) {
      try { priceId = await cyclePriceFor(stripe, tier); } catch (_) {}
    }

    // Paying for the year swaps the price entirely. Done after the monthly
    // lookup so a studio that has set its own monthly prices keeps them.
    const yearly = String(billing || 'monthly') === 'yearly';
    if (yearly) {
      try {
        const yid = await yearlyPriceFor(stripe, tier);
        if (yid) priceId = yid;
      } catch (_) { /* fall back to monthly rather than lose the signup */ }
    }

    /* ── Discount code ─────────────────────────────────────────────────
       Validated server-side against the tier being bought. The browser
       only ever says WHICH code — never what it is worth — so a tampered
       request cannot talk its way to a cheaper membership. A bad code
       stops the signup rather than quietly charging full price to
       somebody who thinks they are on a founding rate.               */
    let couponId = null, appliedPromo = null;
    if (promoCode && String(promoCode).trim()) {
      const promoLib = require('./_promo');
      await promoLib.ensure();
      const p = await promoLib.lookup(promoCode);
      if (!p.ok) return res.status(400).json({ error: p.why || 'That code is not recognised.' });
      const allowed = promoLib.allows(p, { forMembership: true, tier });
      if (!allowed.ok) return res.status(400).json({ error: allowed.why });

      // Ask Stripe what this actually costs rather than trusting a table.
      let monthly = (yearly ? TIER_YEARLY_CENTS[tier] : TIER_CENTS[tier]) || 0;
      try {
        const price = await stripe.prices.retrieve(priceId);
        if (price && price.unit_amount) monthly = price.unit_amount;
      } catch (_) {}

      couponId = await couponFor(stripe, p, tier, monthly);
      if (couponId) {
        appliedPromo = { code: p.code, label: p.label, monthly_cents: Math.max(0, monthly - promoLib.valueAgainst(p, monthly)) };
        try { await promoLib.redeem(p.code); } catch (_) {}
      }
    }

    /* ── The early-bird seat ───────────────────────────────────────────
       Taken here, on the server, in the same request that creates the
       subscription — never on the browser's word. It stacks on top of any
       promo code rather than replacing it: one is a code she handed out,
       the other is a place in a queue.

       Stripe allows a subscription only one coupon, so when both apply the
       two are combined into a single coupon worth the pair. Doing it any
       other way means silently dropping one of the two discounts a client
       was just promised on screen.                                      */
    const eb = require('./_earlybird');
    let ebResult = null, ebCents = 0;
    try {
      const s = await eb.state();
      if (s.available) ebCents = s.amount_cents;
    } catch (_) {}

    if (ebCents > 0) {
      let listPrice = (yearly ? TIER_YEARLY_CENTS[tier] : TIER_CENTS[tier]) || 0;
      try {
        const price = await stripe.prices.retrieve(priceId);
        if (price && price.unit_amount) listPrice = price.unit_amount;
      } catch (_) {}

      const promoOff = appliedPromo ? Math.max(0, listPrice - appliedPromo.monthly_cents) : 0;
      const totalOff = Math.min(listPrice, promoOff + ebCents);
      const id = ('zola_eb_' + tier + '_' + (yearly ? 'y' : 'm') + '_' + totalOff).toLowerCase().replace(/[^a-z0-9_]/g, '');
      try {
        let coupon = null;
        try { coupon = await stripe.coupons.retrieve(id); } catch (_) {}
        if (!coupon) {
          coupon = await stripe.coupons.create({
            id, amount_off: totalOff, currency: 'usd', duration: 'once',
            name: 'ZOLA early bird' + (appliedPromo ? ' + ' + appliedPromo.code : ''),
          });
        }
        couponId = coupon.id;
      } catch (_) { /* if the coupon cannot be made, the signup still goes through at full price */ }
    }

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      ...(couponId ? { coupon: couponId } : {}),
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        tier, memberEmail: email, billing: yearly ? 'yearly' : 'monthly',
        ...(appliedPromo ? { promo_code: appliedPromo.code } : {}),
      },
    });

    const memberId = generateMemberId(fullName);
    if (ebCents > 0) {
      try {
        ebResult = await eb.claim({
          member_id: memberId, name: fullName, email,
          tier, billing: yearly ? 'yearly' : 'monthly',
        });
      } catch (_) {}
    }
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

    /* What they are actually being charged, written down at the moment it is
       decided. Every revenue figure on this site used to be derived from a
       hardcoded list price, so a founding-rate member paying $100 counted as
       $299 and every discount the studio gave was invisible in its own
       accounts. */
    try {
      const listNow = (yearly ? TIER_YEARLY_CENTS[tier] : TIER_CENTS[tier]) || 0;
      let actually = listNow;
      if (appliedPromo && appliedPromo.monthly_cents != null) actually = appliedPromo.monthly_cents;
      // The early bird comes off the first payment only, so it is not what
      // they pay every period and must not be recorded as if it were.
      await require('./_member-price').record(memberId, {
        paid_cents: actually,
        // Essential and Elite bill every four weeks, which is thirteen
        // payments a year rather than twelve. Recording that as monthly
        // would undercount every one of them by a payment a year.
        billing_period: yearly ? 'yearly'
          : (['ESSENTIAL', 'ELITE'].includes(tier) ? 'cycle' : 'monthly'),
        promo_code: appliedPromo ? appliedPromo.code : '',
      });
    } catch (_) {}

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
      promo: appliedPromo,
      // What the confirmation should say — what was actually given, never
      // what was hoped for.
      early_bird: (ebResult && ebResult.claimed)
        ? { amount_cents: ebResult.amount_cents, seat_number: ebResult.seat_number, label: ebResult.label }
        : null,
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
      subject: `Welcome to Zola — Your Member ID is ${memberId}`,
      html: `
        <div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;color:#0D0D0D;background:#FAFAF8;">
          <div style="background:#0D0D0D;padding:2.5rem 2rem;text-align:center;">
            <h1 style="color:#C4A882;font-size:2.25rem;margin:0;letter-spacing:0.08em;font-weight:400;">ZOLA</h1>
            <p style="color:#8B6A3E;font-size:0.75rem;letter-spacing:0.2em;text-transform:uppercase;margin:0.5rem 0 0;">Nail Studio · Porterville, CA</p>
          </div>
          <div style="padding:2.5rem 2rem;">
            <p style="font-size:1.05rem;">Hello ${firstName},</p>
            <p>You're officially in. Welcome to <strong>${tierLabel}</strong> — we're so glad you're here.</p>
            <div style="background:#F5EEE8;border-left:3px solid #C4A882;padding:1.25rem 1.5rem;margin:1.5rem 0;text-align:center;">
              <p style="font-size:0.7rem;letter-spacing:0.2em;text-transform:uppercase;color:#8B6A3E;margin:0 0 0.5rem;">Your Member ID</p>
              <p style="font-size:1.6rem;letter-spacing:0.15em;font-weight:bold;color:#0D0D0D;margin:0;">${memberId}</p>
            </div>
            <p>Keep this ID somewhere safe — copy it and put it somewhere you won't lose it. You'll use it every time you book, check in at the studio, and access your member portal.</p>
            <div style="text-align:center;margin:2rem 0;">
              <a href="https://zola-nail-studio.vercel.app/client-portal.html" style="background:#C4A882;color:#0D0D0D;padding:0.875rem 2rem;text-decoration:none;font-size:0.78rem;letter-spacing:0.15em;text-transform:uppercase;font-weight:700;font-family:Georgia,serif;">Go to My Portal</a>
            </div>
            <p style="color:#8B6A3E;font-size:0.82rem;border-top:1px solid rgba(196,168,130,0.2);padding-top:1.25rem;margin-top:2rem;">Zola Nail Studio &middot; Porterville, CA &middot; <a href="https://zola-nail-studio.vercel.app" style="color:#C4A882;">zola-nail-studio.vercel.app</a></p>
          </div>
        </div>
      `,
    });
  }

  const e164 = formatPhone(phone);
  if (e164 && process.env.TWILIO_ACCOUNT_SID) {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilio.messages.create({
      body: `Welcome to Zola, ${firstName}! 🌟 You're in. Your Member ID is ${memberId} — save it, you'll need it to book. See you soon. — Zola Studio`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: e164,
    });
  }
}
