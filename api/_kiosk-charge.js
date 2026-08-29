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

/* Take the money from a card already on file. Returns what happened rather
   than throwing, because a failed charge at a busy front desk needs to be
   readable by whoever is standing there. */
async function chargeOnFile({ sk, customerId, paymentMethodId, amountCents, description, metadata }) {
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
    return { ok: false, id: pi.id, why: 'The card did not complete the payment (' + pi.status + ').' };
  } catch (err) {
    // The card wants the cardholder to approve it in their banking app.
    // Telling the desk "declined" would be wrong and would lose the sale.
    if (err && err.code === 'authentication_required') {
      return { ok: false, why: 'Their bank wants them to approve this one — ask them to pay by card or phone instead.' };
    }
    const msg = (err && (err.raw && err.raw.message || err.message)) || 'The card was declined.';
    return { ok: false, why: msg };
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

module.exports = {
  ensureTable, signatureProblem, chargeOnFile,
  recordAuthorization, listAuthorizations, signatureFor,
};
