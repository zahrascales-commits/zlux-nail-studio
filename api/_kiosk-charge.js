// Charging a card that is already on file, with something to show for it.
//
// A card on file is the one payment nobody watches happen. The client does
// not tap anything, does not enter a code, and may not look up from their
// phone. If they later tell their bank they never agreed to it, the studio
// has nothing — and with card-on-file charges the bank sides with the
// cardholder by default.
//
// So nothing here charges a saved card without a signature, and every
// signature is stored with exactly what it authorised: the amount, what it
// was made of, who took it and when. That record is the whole point.
const { query, execute } = require('./_team-db');

const money = c => Math.max(0, Math.round(Number(c) || 0));

async function ensureTable() {
  await execute(`CREATE TABLE IF NOT EXISTS checkout_authorizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT,
    client_name TEXT,
    client_email TEXT,
    amount_cents INTEGER DEFAULT 0,
    remainder_cents INTEGER DEFAULT 0,
    tip_cents INTEGER DEFAULT 0,
    method TEXT DEFAULT '',
    card_brand TEXT DEFAULT '',
    card_last4 TEXT DEFAULT '',
    signature TEXT DEFAULT '',
    payment_intent TEXT DEFAULT '',
    outcome TEXT DEFAULT '',
    ts INTEGER
  )`);
}

// A finger-drawn signature on an iPad. Big enough to be a real mark, small
// enough that nobody is storing a photograph by mistake.
const MIN_SIGNATURE = 400;          // characters — anything less is a stray tap
const MAX_SIGNATURE = 400 * 1024;   // 400KB

function signatureProblem(sig) {
  const s = String(sig || '');
  if (!s) return 'Please sign to authorise the charge.';
  if (!s.startsWith('data:image/')) return 'That signature did not come through — try again.';
  if (s.length < MIN_SIGNATURE) return 'That looks like a stray tap rather than a signature.';
  if (s.length > MAX_SIGNATURE) return 'That signature is too large to store.';
  return null;
}

/* What to say when a card does not go through.
 *
 * There are two completely different things behind a failed charge and the
 * desk was being shown both in the same breath:
 *
 *   a decline  — their bank said no. Ask for another card. Normal.
 *   our fault  — the request was wrong. Nothing to do with their card, and
 *                telling a client "declined" for this is a lie that loses
 *                a sale and embarrasses them at the counter.
 *
 * So declines are named plainly, and anything else says it is on us. */
const DECLINES = {
  insufficient_funds:     'Declined — not enough available on the card. Ask for another card.',
  expired_card:           'That card has expired. Ask for a different one.',
  incorrect_cvc:          'The security code on that card is wrong. Ask them to tap or insert a card instead.',
  incorrect_number:       'That card number is not right. Ask them to tap or insert a card instead.',
  invalid_cvc:            'The security code on that card is wrong. Ask them to tap or insert a card instead.',
  card_velocity_exceeded: 'Their bank has blocked this one for now. Ask for another card.',
  withdrawal_count_limit_exceeded: 'Their bank has hit a daily limit. Ask for another card.',
  lost_card:              'Declined. Ask for another card.',
  stolen_card:            'Declined. Ask for another card.',
  pickup_card:            'Declined. Ask for another card.',
  do_not_honor:           'Declined by their bank. Nothing wrong at our end — ask for another card.',
  generic_decline:        'Declined by their bank. Ask for another card, or another way to pay.',
  transaction_not_allowed:'Their bank will not allow this kind of charge. Ask for another card.',
  processing_error:       'Their bank hiccuped. Try once more, then ask for another card.',
  authentication_required:'Their bank wants them to approve it. Ask them to tap or insert the card instead.',
};

function chargeProblem(err) {
  const code = String((err && (err.decline_code || (err.raw && err.raw.decline_code))) || '');
  const kind = String((err && (err.code || (err.raw && err.raw.code))) || '');
  if (DECLINES[code]) return { why: DECLINES[code], declined: true };
  if (DECLINES[kind]) return { why: DECLINES[kind], declined: true };
  if (String((err && err.type) || '') === 'StripeCardError') {
    return { why: 'Card declined. Ask for another card, or another way to pay.', declined: true };
  }
  /* Not a decline. An invalid request, a key problem, Stripe being down —
     all of it is the studio's to fix, and none of it is the client's card.
     Said as plainly as possible so whoever is at the desk knows to take the
     money another way rather than arguing with somebody's bank. */
  return {
    why: 'The card reader could not complete that — it is a problem at our end, not their card. '
       + 'Take payment another way and tell Zahra.',
    declined: false,
    detail: String((err && (err.raw && err.raw.message || err.message)) || 'unknown'),
  };
}

/* Take the money from a card already on file. Returns what happened rather
   than throwing, because a failed charge at a busy front desk needs to be
   readable by whoever is standing there. */
async function chargeOnFile({ sk, customerId, paymentMethodId, amountCents, description, metadata }) {
  /* Never send Stripe an empty customer. This is the bug that was failing
     real checkouts: billFor only knows a customer id for members, so for a
     drop-in it was '' — and Stripe rejects an empty string outright with
     "you passed an empty string for 'customer'", which the desk read as a
     decline. The caller now resolves the customer properly; this is the
     backstop so it can never happen again from anywhere else. */
  if (!sk) return { ok: false, why: 'Card payments are not switched on.', declined: false };
  if (!String(customerId || '').trim() || !String(paymentMethodId || '').trim()) {
    return {
      ok: false, declined: false,
      why: 'No card on file we can charge — take payment another way.',
    };
  }

  const stripe = require('stripe')(sk);
  try {
    const pi = await stripe.paymentIntents.create({
      amount: money(amountCents),
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
      // Nobody is present to complete a bank challenge — the client has
      // already left the counter in every sense that matters.
      off_session: true,
      confirm: true,
      description: String(description || '').slice(0, 300),
      metadata: metadata || {},
    });
    if (pi.status === 'succeeded') return { ok: true, id: pi.id, amount: pi.amount };
    return {
      ok: false, id: pi.id, declined: true,
      why: 'That card did not complete the payment. Ask them to tap or insert a card instead.',
    };
  } catch (err) {
    // The card wants the cardholder to approve it in their banking app.
    // Telling the desk "declined" would be wrong and would lose the sale.
    if (err && (err.code === 'authentication_required'
      || (err.raw && err.raw.code === 'authentication_required'))) {
      return {
        ok: false, declined: false, needsCard: true,
        why: 'Their bank wants them to approve this one. Ask them to tap or insert the card — it goes straight through that way.',
      };
    }
    const p = chargeProblem(err);
    return { ok: false, why: p.why, declined: p.declined, detail: p.detail };
  }
}

// Kept so a dispute months later can be answered with the actual signature.
async function recordAuthorization(row) {
  await ensureTable();
  await execute(
    `INSERT INTO checkout_authorizations
       (ref, client_name, client_email, amount_cents, remainder_cents, tip_cents,
        method, card_brand, card_last4, signature, payment_intent, outcome, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.ref || '', row.client_name || '', row.client_email || '',
     money(row.amount_cents), money(row.remainder_cents), money(row.tip_cents),
     row.method || '', row.card_brand || '', row.card_last4 || '',
     row.signature || '', row.payment_intent || '', row.outcome || '', Date.now()]);
}

async function listAuthorizations({ from, to, limit }) {
  await ensureTable();
  const rows = await query(
    `SELECT id, ref, client_name, client_email, amount_cents, remainder_cents, tip_cents,
            method, card_brand, card_last4, payment_intent, outcome, ts
       FROM checkout_authorizations
      WHERE ts >= ? AND ts <= ?
      ORDER BY ts DESC LIMIT ?`,
    [Number(from) || 0, Number(to) || Date.now(), Math.min(500, Number(limit) || 200)]);
  return rows;
}

async function signatureFor(id) {
  await ensureTable();
  const rows = await query('SELECT signature FROM checkout_authorizations WHERE id = ?', [Number(id)]);
  return rows && rows[0] ? rows[0].signature : '';
}

module.exports = { chargeProblem, DECLINES,
  ensureTable, signatureProblem, chargeOnFile,
  recordAuthorization, listAuthorizations, signatureFor,
};
