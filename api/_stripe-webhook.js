const { queryOne, execute } = require('./_db');
const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook sig fail:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const member = await queryOne('SELECT * FROM members WHERE stripe_customer_id = ?', [customerId]);
        if (member) {
          const next = new Date(invoice.period_end * 1000).toISOString();
          await execute('UPDATE members SET next_billing_at=? WHERE stripe_customer_id=?', [next, customerId]);
          const monthYear = new Date().toISOString().slice(0, 7);
          await execute(`INSERT INTO service_usage (member_id, month_year, services_used) VALUES (?,?,0) ON CONFLICT(member_id,month_year) DO UPDATE SET services_used=0, russian_mani_used=0, scrub_used=0`,
            [member.member_id, monthYear]);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const member = await queryOne('SELECT * FROM members WHERE stripe_customer_id=?', [invoice.customer]);
        if (member && process.env.SENDGRID_API_KEY) {
          const sgMail = require('@sendgrid/mail');
          sgMail.setApiKey(process.env.SENDGRID_API_KEY);
          try {
            await sgMail.send({
              to: member.email,
              from: 'studio@zluxnails.com',
              subject: 'Zola — Payment failed',
              html: `<p>Hello ${member.full_name.split(' ')[0]},</p><p>Your monthly membership payment failed. Please update your payment method at <a href="https://zolanailstudio.vercel.app/client-portal.html">your portal</a> within 3 days to avoid suspension.</p><p>— Zola</p>`,
            });
          } catch (_) {}
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await execute("UPDATE members SET stripe_subscription_id=NULL, flagged=1, flag_reason=? WHERE stripe_subscription_id=?",
          ['Subscription cancelled via Stripe', sub.id]);
        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
};
