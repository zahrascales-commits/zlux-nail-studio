// Taking a deposit off a card already on file, in one tap.
//
// Clients book and then forget the deposit. Chasing them costs Zahra the
// evening and costs the client the embarrassment, so when the card is
// already there she presses Charge and it is done.
//
// Three rules this is built around:
//
//   · The amount is never typed. It comes from the same code the deposit
//     email and the payment page use, for the whole day at once, so one
//     charge settles everything that client has booked that afternoon.
//     Typed amounts are how somebody gets charged twice for one visit.
//
//   · The money is written as the payment, keyed by Stripe's own id, and
//     the record is the sum of those payments. Never an increment. That is
//     the lesson from a client who was credited $255 against $175 of real
//     charges.
//
//   · Nothing happens without her pressing it, and the dialog shows what
//     the client was actually told when their card was saved. Some of them
//     were promised "nothing is ever charged without your signature at the
//     desk", and she should be able to see that before she decides.
const { queryOne, execute } = require('./_team-db');

const money = c => Math.max(0, Math.round(Number(c) || 0));
const lower = s => String(s || '').trim().toLowerCase();
const dollars = c => '$' + (money(c) / 100).toFixed(2).replace(/\.00$/, '');

async function sk() {
  return require('./_pay').getStripeSecret();
}

async function api(key, path, params, extra) {
  const opts = {
    method: params ? 'POST' : 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + key }, extra || {}),
  };
  if (params) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(params).toString();
  }
  const r = await fetch('https://api.stripe.com/v1/' + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (j && j.error) || {};
    const err = new Error(e.message || ('Stripe returned ' + r.status));
    err.code = e.code || '';
    err.decline = e.decline_code || '';
    throw err;
  }
  return j;
}

/* ── WHOSE CARD, AND WHAT THEY AGREED TO ───────────────────────────── */

/* Every Stripe customer for this email, not just the first one. A client
   who paid once as a guest and later saved a card has two customer
   records, and the card is on whichever one nobody looked at. */
async function customersFor(key, email) {
  if (!email) return [];
  try {
    const j = await api(key, 'customers?limit=10&email=' + encodeURIComponent(email));
    return (j.data || []).map(c => c.id);
  } catch (_) { return []; }
}

/* What the client was told when this card was saved.
 *
 * A card that arrived with a payment was saved as they paid a deposit, and
 * the page said it would be kept for future visits. A card that arrived on
 * its own came through the "save my card" link, whose email promised in
 * bold that nothing would be charged without a signature at the desk. The
 * two are not the same permission and she should see which she has.
 */
async function mandateFor(key, customer) {
  try {
    const pays = await api(key,
      'payment_intents?limit=20&customer=' + encodeURIComponent(customer));
    if ((pays.data || []).some(p => p.status === 'succeeded' && p.setup_future_usage)) {
      return { kind: 'paid_online', note: 'They saved this card while paying a deposit on the site.' };
    }
  } catch (_) {}
  try {
    const setups = await api(key,
      'setup_intents?limit=20&customer=' + encodeURIComponent(customer));
    if ((setups.data || []).some(s => s.status === 'succeeded')) {
      return {
        kind: 'saved_by_link',
        note: 'They added this card through the "save my card" link. That email promised '
          + 'nothing would be charged without a signature at the desk — so a deposit taken '
          + 'now is worth a word to them first.',
      };
    }
  } catch (_) {}
  return { kind: 'unknown', note: 'No record of how this card was saved.' };
}

/* The card to charge, and the permission behind it. Members carry their
   customer id on the membership, so they are found even when the email on
   the two records differs. */
async function cardFor({ email, memberId }) {
  const key = await sk();
  if (!key) return { ok: false, why: 'Payments are not configured.' };

  const ids = [];
  if (memberId) {
    try {
      const m = await require('./_db').queryOne(
        'SELECT stripe_customer_id FROM members WHERE member_id = ?', [memberId]);
      if (m && m.stripe_customer_id) ids.push(m.stripe_customer_id);
    } catch (_) {}
  }
  for (const id of await customersFor(key, lower(email))) {
    if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return { ok: false, why: 'no_customer' };

  for (const customer of ids) {
    let pms = [];
    try {
      const j = await api(key, 'payment_methods?type=card&limit=10&customer=' + encodeURIComponent(customer));
      pms = j.data || [];
    } catch (_) { continue; }
    if (!pms.length) continue;

    /* Their default first, where there is one — that is the card they have
       chosen to be charged on. */
    let pm = pms[0];
    try {
      const c = await api(key, 'customers/' + encodeURIComponent(customer));
      const def = c.invoice_settings && c.invoice_settings.default_payment_method;
      const hit = def && pms.find(p => p.id === def);
      if (hit) pm = hit;
    } catch (_) {}

    return {
      ok: true, key, customer, payment_method: pm.id,
      card: {
        brand: (pm.card && pm.card.brand) || 'card',
        last4: (pm.card && pm.card.last4) || '',
        exp: pm.card ? pm.card.exp_month + '/' + String(pm.card.exp_year).slice(-2) : '',
      },
      mandate: await mandateFor(key, customer),
    };
  }
  return { ok: false, why: 'no_card' };
}

/* ── WHAT IS OWED, AND WHETHER IT CAN BE TAKEN ─────────────────────── */

const todayLA = () => new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10);

/* Everything the dialog needs, and nothing is charged by asking.
 *
 * The amount is the whole day's outstanding deposit, worked out by the same
 * grouping the deposit email uses — so what she is about to take is exactly
 * the figure the client was asked for. */
async function quoteFor(apptId) {
  const appt = await queryOne(
    'SELECT a.*, m.name AS artist_name FROM team_appointments a '
    + 'LEFT JOIN team_members m ON m.id = a.team_member_id WHERE a.id = ?', [Number(apptId)]);
  if (!appt) return { ok: false, why: 'No appointment with that id.' };

  const out = {
    ok: true,
    appointment: {
      id: Number(appt.id), client: appt.client_name || '', email: appt.client_email || '',
      phone: appt.client_phone || '', date: appt.date, time: appt.time,
      service: appt.service || '', artist: appt.artist_name || '',
      deposit_paid: Number(appt.deposit_paid) || 0,
      deposit_waived: Number(appt.deposit_waived) || 0,
    },
    can_charge: false,
  };

  if (/cancel/i.test(String(appt.status || ''))) return Object.assign(out, { why: 'That appointment is cancelled.' });
  if (Number(appt.deposit_waived) === 1) return Object.assign(out, { why: 'This one is marked as no deposit due.' });
  if (String(appt.date || '') < todayLA()) return Object.assign(out, { why: 'That appointment has already happened.' });

  const grp = await require('./_deposit-group').groupFor(appt);
  out.owed_cents = money(grp.dueCents);
  out.already_paid_cents = money(grp.paidCents);
  out.covers = grp.owing.map(x => ({
    id: Number(x.row.id), service: x.row.service || '', time: x.row.time || '', cents: money(x.owed),
  }));
  out.token_shares = grp.tokenShares;

  if (!out.owed_cents) return Object.assign(out, { why: 'Nothing is owed on this one.' });

  const email = lower(appt.client_email);
  if (!email) {
    return Object.assign(out, {
      why: 'no_email',
      message: 'There is no email on this appointment, so there is no card to look for. '
        + 'Add their email and send them the deposit link, or take it at the desk.',
    });
  }

  let memberId = '';
  try {
    const info = await require('./_visit').memberInfoFor(appt);
    memberId = (info && info.member && info.member.member_id) || '';
  } catch (_) {}

  const found = await cardFor({ email, memberId });
  if (!found.ok) {
    out.why = found.why;
    out.message = found.why === 'no_card' || found.why === 'no_customer'
      ? 'No card saved for ' + (appt.client_name || 'this client') + '. Send them the deposit link instead — '
        + 'one tap, and it saves the card for next time.'
      : found.why;
    return out;
  }

  out.can_charge = true;
  out.card = found.card;
  out.mandate = found.mandate;
  out.summary = 'Charge ' + dollars(out.owed_cents) + ' to ' + found.card.brand
    + ' ····' + found.card.last4 + ' for ' + (appt.client_name || 'this client') + '.';
  return out;
}

/* ── TAKING IT ─────────────────────────────────────────────────────── */

/* Charge the deposit. Nothing moves without confirm: true.
 *
 * The figure charged is re-read here rather than taken from the caller, so
 * a dialog left open while the client paid online cannot charge them again
 * for something already settled.
 */
async function charge(apptId, { confirm, note } = {}) {
  const q = await quoteFor(apptId);
  if (!q.ok) return { ok: false, why: q.why };
  if (!q.can_charge) return { ok: false, why: q.why, message: q.message, quote: q };
  if (confirm !== true) return { ok: true, committed: false, dry_run: true, quote: q };

  const appt = await queryOne(
    'SELECT a.*, m.name AS artist_name FROM team_appointments a '
    + 'LEFT JOIN team_members m ON m.id = a.team_member_id WHERE a.id = ?', [Number(apptId)]);
  const found = await cardFor({ email: lower(appt.client_email) });
  if (!found.ok) return { ok: false, why: found.why };

  const cents = money(q.owed_cents);
  const label = 'Deposit · ' + (appt.service || 'appointment') + ' on ' + appt.date;

  /* Stripe's own guard against a double tap. The key is the appointment,
     the amount and the day, so pressing Charge twice is one charge — and a
     genuine second deposit tomorrow, for a different amount, is not
     blocked by it. */
  const idem = 'zola-dep-' + Number(apptId) + '-' + cents + '-' + todayLA();

  let pi;
  try {
    pi = await api(found.key, 'payment_intents', {
      amount: String(cents),
      currency: 'usd',
      customer: found.customer,
      payment_method: found.payment_method,
      off_session: 'true',
      confirm: 'true',
      description: label,
      'metadata[kind]': 'deposit_charged_by_owner',
      'metadata[appointment_id]': String(apptId),
      'metadata[token_shares]': String(q.token_shares || ''),
      'metadata[mandate]': String((found.mandate && found.mandate.kind) || ''),
    }, { 'Idempotency-Key': idem });
  } catch (err) {
    /* The card wants the cardholder to approve it in their banking app.
       That is not a decline and saying so would lose the deposit. */
    if (err.code === 'authentication_required') {
      return {
        ok: false, why: 'needs_them',
        message: 'Their bank wants ' + (appt.client_name || 'them') + ' to approve this one. '
          + 'Send them the deposit link instead — it takes one tap on their phone.',
      };
    }
    return { ok: false, why: 'declined', message: err.message || 'The card was declined.' };
  }

  if (pi.status !== 'succeeded') {
    return { ok: false, why: 'declined', message: 'The card did not complete it (' + pi.status + ').' };
  }

  /* Written against every service the charge covered, each with its own
     share, keyed by Stripe's id. Recording it twice is a no-op, and this is
     also what sets off the directions email. */
  const group = require('./_deposit-group');
  const rec = await group.recordShares(group.parseShares(q.token_shares), cents, pi.id);

  // The signature line in the authorisation book stays empty on purpose:
  // there was no signature. What there is, is a receipt.
  try {
    await require('./_kiosk-charge').recordAuthorization({
      ref: 't' + apptId, client_name: appt.client_name || '', client_email: appt.client_email || '',
      amount_cents: cents, remainder_cents: 0, tip_cents: 0,
      method: 'card_on_file', card_brand: found.card.brand, card_last4: found.card.last4,
      signature: '', payment_intent: pi.id,
      outcome: 'deposit_charged_by_owner · ' + ((found.mandate && found.mandate.kind) || '')
        + (note ? ' · ' + String(note).slice(0, 80) : ''),
    });
  } catch (_) {}

  /* A receipt, straight away. A client who sees what was taken and what it
     was for does not ring their bank — and with no signature on file this
     is the record that answers a dispute. */
  let receipt = null;
  try { receipt = await sendReceipt(appt, { cents, card: found.card, covers: q.covers }); } catch (_) {}

  return {
    ok: true, committed: true, payment_intent: pi.id,
    charged_cents: cents, card: found.card,
    mandate: found.mandate, recorded: rec, receipt,
  };
}

/* ── THE RECEIPT ───────────────────────────────────────────────────── */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function sendReceipt(appt, { cents, card, covers }) {
  const to = String(appt.client_email || '').trim();
  if (!to) return { sent: false, why: 'no email' };

  const visit = require('./_visit');
  const first = String(appt.client_name || '').trim().split(/\s+/)[0] || 'there';
  const when = visit.pretty(appt.date) + ' at ' + visit.time12(appt.time);
  const lines = (covers && covers.length ? covers : [{ service: appt.service, cents }])
    .map(c => '<div style="display:flex;justify-content:space-between;font-size:14px;color:#3a3027;padding:4px 0">'
      + '<span>' + esc(c.service || 'Appointment') + '</span><span>' + dollars(c.cents) + '</span></div>').join('');

  const body = `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px 14px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #eee5d8">
    <div style="background:#0D0D0D;padding:26px 24px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:6px;color:#F5EEE8">ZOLA</div>
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8B6A3E;margin-top:6px">Nail Studio · Porterville</div>
    </div>
    <div style="padding:28px 24px">
      <p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 16px">Hi ${esc(first)},</p>
      <p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 20px">
        Your deposit is in — taken from the card you have on file, so there is nothing for you to do.
      </p>
      <div style="background:#faf7f4;border:1px solid #eee5d8;padding:16px 18px;margin:0 0 20px">
        <div style="font-family:Georgia,serif;font-size:17px;color:#0D0D0D;margin-bottom:10px">${esc(when)}</div>
        ${lines}
        <div style="display:flex;justify-content:space-between;font-size:15px;color:#3a3027;font-weight:bold;
          border-top:1px solid #eee5d8;padding:8px 0 0;margin-top:6px">
          <span>Deposit paid</span><span>${dollars(cents)}</span>
        </div>
        <div style="font-size:13px;color:#8C7A5E;margin-top:8px">
          ${esc(card.brand)} ····${esc(card.last4)}
        </div>
      </div>
      <p style="font-size:15px;line-height:1.75;color:#3a3027;margin:0 0 16px">
        This comes off your total, so there is less to settle when you are here.
      </p>
      <p style="font-size:14px;line-height:1.75;color:#8C7A5E;margin:0">
        If this is not what you expected, just reply to this email and we will sort it out today.
      </p>
    </div>
    <div style="background:#faf7f4;padding:16px 24px;text-align:center;border-top:1px solid #eee5d8">
      <p style="font-size:12px;color:#8C7A5E;margin:0;line-height:1.7">
        ZOLA Nail Studio · 2037 W Linda Vista Ave #D, Porterville, CA
      </p>
    </div>
  </div>
</div>`;

  const out = await require('./_notify').sendEmail(
    to, 'Your deposit is in ✦ ' + dollars(cents) + ' — ZOLA', body, { kind: 'deposit_receipt' });
  return { sent: !!(out && out.ok !== false), to };
}

module.exports = { cardFor, quoteFor, charge, sendReceipt, mandateFor };
