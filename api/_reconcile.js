// Money Stripe took that the studio never recorded.
//
// A deposit was only written down if the client's browser came back and said
// so after paying. Close the tab, lose signal, get a phone call — the charge
// goes through and the appointment still says nothing was paid. Then the till
// asks for the full amount and somebody pays twice.
//
// That is exactly what happened to Nataly: $57.50 taken by Stripe on the 2nd,
// a booking that said $0, and $95 asked for at the desk on top.
//
// This compares what Stripe actually charged against what each appointment
// believes, and reports every gap. It can also close them. Stripe is the
// authority here — it is the only one of the two that holds real money.
const { query, queryOne, execute } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const money = c => Math.round(Number(c) || 0);

/* Every deposit Stripe has taken, with the appointment it belongs to.
   The token is on the payment because the deposit page puts it there, which
   makes this an exact match rather than a guess by name and amount. */
async function depositCharges(sk, sinceSec) {
  const out = [];
  let starting_after = null;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ limit: '100', 'created[gte]': String(sinceSec) });
    if (starting_after) params.set('starting_after', starting_after);
    const r = await fetch('https://api.stripe.com/v1/payment_intents?' + params.toString(), {
      headers: { Authorization: 'Bearer ' + sk },
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe would not answer');

    for (const pi of (j.data || [])) {
      if (pi.status !== 'succeeded') continue;
      const md = pi.metadata || {};
      const looksLikeDeposit = md.appt_token || md.client || md.service || md.services;
      if (!looksLikeDeposit) continue;
      if (!/deposit/i.test(String(pi.description || ''))) continue;

      out.push({
        id: pi.id,
        // The appointment link puts this on; the booking flow does not.
        token: md.appt_token || '',
        // What the booking flow leaves instead.
        client: md.client || '',
        service: md.service || md.services || '',
        amount: money(pi.amount_received || pi.amount),
        created: pi.created,
        desc: pi.description || '',
      });
    }

    if (!j.has_more) break;
    const last = (j.data || [])[(j.data || []).length - 1];
    if (!last) break;
    starting_after = last.id;
  }
  return out;
}

/* Where the two disagree. Only ever in one direction: Stripe holds money the
   appointment does not know about. The reverse — an appointment claiming a
   deposit Stripe never took — is reported separately, because that is a
   different and much worse problem. */
async function findGaps(sk, sinceSec) {
  const charges = await depositCharges(sk, sinceSec);
  const gaps = [], ghosts = [], unplaced = [];
  /* Appointments tied to a real Stripe payment, however it was matched.
     Without this the ghost check below only recognised token-matched ones
     and reported two clients whose deposits Stripe genuinely holds. */
  const accountedFor = new Set();

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const firstName = s => String(s || '').trim().toLowerCase().split(/\s+/)[0] || '';

  for (const c of charges) {
    let appt = null;

    if (c.token) {
      appt = await queryOne(
        `SELECT id, client_name, client_email, service, date, time,
                deposit_cents, deposit_paid, checked_out_ts
           FROM team_appointments WHERE chat_token = ?`, [c.token]);
    }

    /* No token, so this came through the booking flow. Matched on the name it
       does carry — but only when one appointment fits and there is nothing
       recorded on it, because a wrong match writes a deposit against the
       wrong person and that is worse than not finding it. */
    if (!appt && c.client) {
      const paidOn = new Date(Number(c.created) * 1000).toISOString().slice(0, 10);
      let rows = [];
      try {
        rows = await query(
          /* Every appointment from that date, not only the ones with nothing
             recorded. Filtering to unpaid ones meant a charge became
             unmatchable the moment its deposit was written down — and the
             client then looked like they were claiming a payment that never
             happened. */
          `SELECT id, client_name, client_email, service, date, time,
                  deposit_cents, deposit_paid, checked_out_ts
             FROM team_appointments
            WHERE date >= ?`, [paidOn]);
      } catch (_) {}

      const fits = rows.filter(r =>
        firstName(r.client_name) && firstName(r.client_name) === firstName(c.client)
        && (!c.service || norm(r.service) === norm(c.service)));

      if (fits.length === 1) {
        appt = fits[0];
      } else if (fits.length > 1) {
        // Real, but not safe to place. Better said out loud than guessed.
        unplaced.push({
          name: c.client, amount_cents: c.amount, paid_on: paidOn,
          service: c.service, candidates: fits.length, payment_intent: c.id,
        });
        continue;
      }
    }

    if (!appt) continue;
    accountedFor.add(Number(appt.id));

    const recorded = Number(appt.deposit_paid) ? money(appt.deposit_cents) : 0;
    if (recorded >= c.amount) continue;

    gaps.push({
      appointment_id: Number(appt.id),
      token: c.token,
      name: appt.client_name || '',
      email: appt.client_email || '',
      service: appt.service || '',
      date: appt.date, time: appt.time,
      stripe_took_cents: c.amount,
      recorded_cents: recorded,
      // Already been in and paid at the desk, so they were charged twice.
      already_checked_out: !!Number(appt.checked_out_ts),
      payment_intent: c.id,
    });
  }

  /* The other direction: a booking that says a deposit was paid with nothing
     in Stripe to match it. Rare, and worth knowing about — it would mean the
     till is under-charging. */
  try {
    const claimed = await query(
      `SELECT id, client_name, chat_token, deposit_cents, date
         FROM team_appointments
        WHERE deposit_paid = 1 AND COALESCE(deposit_cents,0) > 0`);
    for (const a of claimed) {
      // Tied to a real payment above, by token or by name. Not a ghost.
      if (accountedFor.has(Number(a.id))) continue;
      {
        ghosts.push({
          appointment_id: Number(a.id),
          name: a.client_name || '',
          date: a.date,
          claims_cents: money(a.deposit_cents),
        });
      }
    }
  } catch (_) {}

  return { gaps, ghosts, unplaced, checked: charges.length,
    detail: charges.map(c => ({ amount: c.amount, token: c.token || '(none)', client: c.client || '(none)', service: c.service || '(none)', desc: c.desc })) };
}

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const sk = await require('./_pay').getStripeSecret();
    if (!sk) return res.status(400).json({ error: 'No Stripe key saved.' });

    // Ninety days back by default — far enough to catch anything still
    // upcoming, short enough to stay quick.
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
    const since = Math.floor(Date.now() / 1000) - days * 86400;

    const found = await findGaps(sk, since);

    // ── writing the missing ones down ──
    if (req.method === 'POST' && (req.body || {}).fix === true) {
      const fixed = [];
      for (const g of found.gaps) {
        try {
          await execute(
            'UPDATE team_appointments SET deposit_paid = 1, deposit_cents = ? WHERE id = ?',
            [g.stripe_took_cents, g.appointment_id]);
          fixed.push({ name: g.name, cents: g.stripe_took_cents });
        } catch (_) {}
      }
      return res.json({ ok: true, fixed: fixed.length, rows: fixed, ghosts: found.ghosts });
    }

    return res.json({
      ok: true,
      checked: found.checked,
      gaps: found.gaps,
      ghosts: found.ghosts,
      unplaced: found.unplaced,
      // What each payment actually carries, for working out why one did not match.
      detail: String(req.query.detail||'')==='1' ? found.detail : undefined,
      overcharged: found.gaps.filter(g => g.already_checked_out),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
