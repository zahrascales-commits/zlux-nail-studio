const { getDb } = require('../server/db/init');
const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = req.body; // Vercel provides raw body when content-type is application/json
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook sig fail:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = getDb();
  try {
    switch (event.type) {
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const member = db.prepare('SELECT * FROM members WHERE stripe_customer_id = ?').get(customerId);
        if (member) {
          const next = new Date(invoice.period_end * 1000).toISOString();
          db.prepare('UPDATE members SET next_billing_at=? WHERE stripe_customer_id=?').run(next, customerId);
          // Reset monthly service usage
          const monthYear = new Date().toISOString().slice(0, 7);
          db.prepare(`INSERT INTO service_usage (member_id, month_year, services_used) VALUES (?,?,0) ON CONFLICT(member_id,month_year) DO UPDATE SET services_used=0, russian_mani_used=0, scrub_used=0`).run(member.member_id, monthYear);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const member = db.prepare('SELECT * FROM members WHERE stripe_customer_id=?').get(customerId);
        if (member && process.env.SENDGRID_API_KEY) {
          const sgMail = require('@sendgrid/mail');
          sgMail.setApiKey(process.env.SENDGRID_API_KEY);
          try {
            await sgMail.send({
              to: member.email,
              from: 'studio@zluxnails.com',
              subject: 'Z Lux — Payment failed',
              html: `<p>Hello ${member.full_name.split(' ')[0]},</p><p>Your monthly membership payment failed. Please update your payment method at <a href="https://zluxnailstudio.vercel.app/client-portal.html">your portal</a> within 3 days to avoid suspension.</p><p>— Z Lux</p>`,
            });
          } catch (_) {}
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        db.prepare('UPDATE members SET stripe_subscription_id=NULL, flagged=1, flag_reason=? WHERE stripe_subscription_id=?')
          .run('Subscription cancelled via Stripe', sub.id);
        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } finally {
    db.close();
  }
};
