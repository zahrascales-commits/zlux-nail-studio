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

/* Website bookings carrying a status nothing recognises — usually none at
   all. Reported with what they are worth, because an invisible booking is
   both a slot that can be double-booked and money the takings never see. */
async function statuslessBookings() {
  try {
    const main = require('./_db');
    const rows = await main.query(
      `SELECT id, guest_name, guest_email, service, appointment_date, appointment_time,
              status, total_cents, deposit_cents, deposit_paid
         FROM appointments
        WHERE status IS NULL OR TRIM(COALESCE(status,'')) = ''
        ORDER BY appointment_date DESC`);
    return rows.map(r => ({
      id: Number(r.id),
      name: r.guest_name || '(no name)',
      email: r.guest_email || '',
      service: r.service || '',
      date: r.appointment_date, time: r.appointment_time,
      status: r.status === null ? '(null)' : JSON.stringify(r.status),
      worth_cents: money(r.total_cents),
      deposit_cents: money(r.deposit_cents),
      deposit_paid: !!Number(r.deposit_paid),
    }));
  } catch (_) { return []; }
}

/* The same visit, in both books, priced differently. Matched on first name
   with the date and the time, which is how the rest of the site pairs them.
   A cancelled row on either side is reported too, with its status, because
   that is usually the explanation and it should be seen rather than
   assumed. */
async function bookDisagreements(sinceDate) {
  const out = [];
  try {
    const main = require('./_db');
    const site = await main.query(
      `SELECT id, guest_name, guest_email, service, appointment_date AS date,
              appointment_time AS time, status, total_cents, deposit_cents, deposit_paid
         FROM appointments WHERE appointment_date >= ?`, [sinceDate]);
    const studio = await query(
      `SELECT id, client_name, client_email, service, date, time, status,
              price_cents, deposit_cents, deposit_paid
         FROM team_appointments WHERE date >= ?`, [sinceDate]);

    const first = s => String(s || '').trim().toLowerCase().split(/\s+/)[0] || '';
    const key = (nm, d, t) => first(nm) + '|' + String(d || '') + '|' + String(t || '').slice(0, 5);

    const byKey = new Map();
    for (const s of site) {
      const k = key(s.guest_name, s.date, s.time);
      if (!k.startsWith('|')) byKey.set(k, s);
    }

    for (const t of studio) {
      const s = byKey.get(key(t.client_name, t.date, t.time));
      if (!s) continue;

      const siteTotal = money(s.total_cents);
      const studioTotal = money(t.price_cents);
      // Nothing recorded on the studio side is normal, not a disagreement.
      if (!siteTotal || !studioTotal || siteTotal === studioTotal) {
        // Still worth saying when only one side holds a price and the two
        // statuses differ, because that is what decides who gets believed.
        if (!siteTotal || String(s.status || '').toUpperCase() === String(t.status || '').toUpperCase()) continue;
      }

      out.push({
        who: t.client_name || s.guest_name || '',
        date: t.date, time: t.time,
        studio: { id: Number(t.id), service: t.service, price_cents: studioTotal,
                  deposit_cents: money(t.deposit_cents), deposit_paid: !!Number(t.deposit_paid),
                  status: t.status === null ? '(null)' : String(t.status) },
        website: { id: Number(s.id), service: s.service, total_cents: siteTotal,
                   deposit_cents: money(s.deposit_cents), deposit_paid: !!Number(s.deposit_paid),
                   status: s.status === null ? '(null)' : String(s.status) },
      });
    }
  } catch (err) {
    out.push({ error: String(err.message || err) });
  }
  return out;
}

/* Website bookings nothing can pair to a person. Reported with whatever
   they do carry, because the money on them is real even when the name is
   missing. */
async function namelessBookings(sinceDate) {
  try {
    const main = require('./_db');
    const rows = await main.query(
      `SELECT a.id, a.member_id, a.guest_name, a.guest_email, a.guest_phone,
              a.service, a.appointment_date AS date, a.appointment_time AS time,
              a.status, a.total_cents, a.deposit_cents, a.deposit_paid,
              m.full_name, m.email AS member_email
         FROM appointments a
         LEFT JOIN members m ON a.member_id = m.member_id
        WHERE a.appointment_date >= ?
        ORDER BY a.appointment_date DESC`, [sinceDate]);

    return rows
      .filter(r => !String(r.full_name || r.guest_name || '').trim())
      .map(r => ({
        id: Number(r.id),
        member_id: r.member_id || null,
        // Says whether the membership link is the thing that broke.
        membership_found: !!r.full_name,
        email: r.member_email || r.guest_email || '(none)',
        phone: r.guest_phone || '(none)',
        service: r.service || '', date: r.date, time: r.time,
        status: r.status === null ? '(null)' : String(r.status),
        worth_cents: money(r.total_cents),
        deposit_cents: money(r.deposit_cents),
        deposit_paid: !!Number(r.deposit_paid),
      }));
  } catch (err) { return [{ error: String(err.message || err) }]; }
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

    const statusless = await statuslessBookings();
    const sinceDay = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const nameless = await namelessBookings(sinceDay);
    const disagreements = await bookDisagreements(
      new Date(Date.now() - days * 86400000).toISOString().slice(0, 10));

    return res.json({
      ok: true,
      checked: found.checked,
      // Bookings nothing else can see. Empty is the healthy answer.
      statusless,
      // The same visit priced differently in the two books. Also empty when healthy.
      disagreements,
      // Bookings with no name on them, which nothing can pair to a visit.
      nameless,
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
