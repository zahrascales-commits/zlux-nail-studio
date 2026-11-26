// Putting a card on file without taking any money.
//
// The cards on file so far are a side effect of somebody paying. A client
// who paid their deposit before this existed — or who always pays cash — has
// nothing saved and has to hand their card over every visit.
//
// This is a link the studio can send them. They enter the card once, nothing
// is charged, and it is there for the till from then on. Stripe calls it a
// SetupIntent: the card is authorised for later use rather than billed now,
// which is also what makes the later charge legitimate.
//
// Reached with the same appointment token as everything else the client
// touches, so there is nothing to remember and nothing to log in to.
const { queryOne } = require('./_team-db');

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = String((req.query && req.query.t) || (req.body && req.body.t) || '').trim();
    if (!token) return res.status(400).json({ error: 'That link is missing its code.' });

    const appt = await queryOne(
      `SELECT id, client_name, client_email, client_phone, service, date, time
         FROM team_appointments WHERE chat_token = ?`, [token]);
    if (!appt) return res.status(404).json({ error: 'We could not find that. Check the link, or message the studio.' });

    const pay = require('./_pay');
    const sk = await pay.getStripeSecret();
    if (!sk) return res.status(400).json({ error: 'Card payments are not set up yet.' });

    // ── who they are, telling them nothing about anyone else ──
    if (req.method === 'GET') {
      const bill = require('./_kiosk-bill');
      let card = null;
      try {
        const id = await bill.customerIdFor(sk, null, appt.client_email || '', appt.client_phone || '');
        card = await bill.cardOnFile(sk, id);
      } catch (_) {}
      return res.json({
        name: appt.client_name || '',
        first: String(appt.client_name || '').trim().split(/\s+/)[0] || '',
        // So somebody who has already done this is told, rather than
        // adding a second copy of the same card.
        existing: card ? { brand: card.brand, last4: card.last4 } : null,
      });
    }

    /* Stripe needs a customer to attach the card to, and one per person —
       a customer per visit puts the card on a row nobody looks at. */
    if (req.method === 'POST') {
      /* An email OR a number. This used to refuse outright without an
         address, which made the link useless to exactly the people who
         needed it most — the ones booked by hand, by phone, with no email
         on the row. */
      const who = await require('./_customer').resolve({
        sk,
        email: appt.client_email || '',
        phone: appt.client_phone || '',
        name: appt.client_name || '',
      });
      if (!who.id) {
        return res.status(400).json({
          error: who.how === 'nothing_to_go_on'
            ? 'We need an email or a phone number on your booking before we can save a card. '
              + 'Message the studio and we will add it.'
            : 'We could not start that — message the studio and we will take the card for you.',
        });
      }
      const customerId = who.id;

      /* off_session, because the charge happens later at the desk rather
         than while they are looking at the screen. This is the record that
         makes that charge authorised rather than a surprise. */
      const si = await fetch('https://api.stripe.com/v1/setup_intents', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          customer: customerId,
          usage: 'off_session',
          'automatic_payment_methods[enabled]': 'true',
          'metadata[appt_token]': token,
        }).toString(),
      });
      const intent = await si.json();
      if (!si.ok) {
        return res.status(400).json({ error: (intent.error && intent.error.message) || 'Stripe would not start that.' });
      }

      const pub = await pay.getStripePublishable();
      return res.json({ client_secret: intent.client_secret, publishable_key: pub || null });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
