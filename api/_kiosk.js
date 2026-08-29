// In-salon iPad kiosk: fast spa-style check-in, checkout with card-or-cash
// for any remaining balance, and a quick review. Public by design (it runs
// on the studio iPad) — it only ever exposes today's first-name matches and
// balances, never contact info.
const { query, queryOne, execute, ensureTables } = require('./_team-db');
const notify = require('./_notify');

let _ready = false;
async function ensure() {
  await ensureTables();
  if (_ready) return;
  await execute(`CREATE TABLE IF NOT EXISTS kiosk_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,               -- checkin | checkout | review
    name TEXT,
    detail TEXT DEFAULT '',
    stars INTEGER,
    amount_cents INTEGER,
    method TEXT,             -- card | cash
    ts INTEGER
  )`);
  // The appointment itself has to carry this, not just the log. A report
  // reading appointments must be able to tell who actually turned up.
  const main = require('./_db');
  for (const sql of [
    'ALTER TABLE appointments ADD COLUMN checked_in_ts INTEGER DEFAULT 0',
    'ALTER TABLE appointments ADD COLUMN checked_out_ts INTEGER DEFAULT 0',
    'ALTER TABLE appointments ADD COLUMN paid_cents INTEGER DEFAULT 0',
    'ALTER TABLE appointments ADD COLUMN pay_method TEXT DEFAULT \'\'',
  ]) { try { await main.execute(sql); } catch (_) {} }
  for (const sql of [
    'ALTER TABLE team_appointments ADD COLUMN checked_in_ts INTEGER DEFAULT 0',
    'ALTER TABLE team_appointments ADD COLUMN checked_out_ts INTEGER DEFAULT 0',
    'ALTER TABLE team_appointments ADD COLUMN tip_cents INTEGER DEFAULT 0',
    'ALTER TABLE team_appointments ADD COLUMN paid_cents INTEGER DEFAULT 0',
    'ALTER TABLE team_appointments ADD COLUMN pay_method TEXT DEFAULT \'\'',
  ]) { try { await execute(sql); } catch (_) {} }

  _ready = true;
}

// Stamps the appointment the kiosk just matched. Silent on failure by
// design: a column that has not landed yet must never cost somebody their
// check-in at the door.
async function stampAppointment(appt, fields) {
  if (!appt || !appt.id) return;
  const keys = Object.keys(fields || {});
  if (!keys.length) return;

  const table = appt.src === 't' ? 'team_appointments' : 'appointments';
  const run = appt.src === 't' ? execute : require('./_db').execute;
  const id = Number(appt.id);

  // One statement if every column exists. The two tables do not carry the
  // same ones — deposit_paid lives only on public bookings — and a single
  // unknown column takes the whole UPDATE down with it. So if the combined
  // write fails, each field is written on its own and the ones that fit
  // still land. Losing a tip because a neighbouring column is missing is
  // not a trade worth making.
  const sql = 'UPDATE ' + table + ' SET ' + keys.map(k => k + '=?').join(', ') + ' WHERE id=?';
  try {
    await run(sql, keys.map(k => fields[k]).concat([id]));
    return;
  } catch (_) {}

  for (const k of keys) {
    try { await run('UPDATE ' + table + ' SET ' + k + '=? WHERE id=?', [fields[k], id]); } catch (_) {}
  }
}

// Find today's appointment for a typed name (case-insensitive, first-name ok)
async function findToday(name) {
  const today = new Date().toISOString().slice(0, 10);
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  // Owner-scheduled appointments
  const t = await query('SELECT id, client_name AS name, service, time FROM team_appointments WHERE date=?', [today]).catch(() => []);
  for (const r of t) if (String(r.name || '').toLowerCase().includes(n) || n.includes(String(r.name || '').toLowerCase().split(' ')[0])) {
    return { src: 't', id: r.id, name: r.name, service: r.service, time: r.time, total_cents: 0, deposit_cents: 0, deposit_paid: 1 };
  }
  // Public bookings (guests + members)
  const { query: mainQuery } = require('./_db');
  const m = await mainQuery(
    `SELECT a.id, a.service, a.appointment_time AS time, a.total_cents, a.deposit_cents, a.deposit_paid,
            m.full_name, a.guest_name
     FROM appointments a LEFT JOIN members m ON a.member_id = m.member_id
     WHERE a.appointment_date=? AND a.status='SCHEDULED'`, [today]).catch(() => []);
  for (const r of m) {
    const nm = String(r.full_name || r.guest_name || '').toLowerCase();
    if (nm && (nm.includes(n) || n.includes(nm.split(' ')[0]))) {
      return { src: 'm', id: r.id, name: r.full_name || r.guest_name, service: r.service, time: r.time,
        total_cents: Number(r.total_cents) || 0, deposit_cents: Number(r.deposit_cents) || 0, deposit_paid: Number(r.deposit_paid) ? 1 : 0 };
    }
  }
  return null;
}

/* Who is being paid for, and what is genuinely left to pay.

   The old lookup priced from the appointment row, which for anything the
   studio booked by hand carries no price at all — so the balance was
   zero and a card payment took only the tip. This prices it the same way
   the booking page does, membership and all. */
async function resolveVisit(body) {
  const find = require('./_kiosk-find');
  const bill = require('./_kiosk-bill');
  const q = body.q || body.name || '';
  let appt = null;
  try {
    const { matches } = await find.findFor(q);
    appt = matches.length === 1
      ? matches[0]
      : (matches.find(a => (a.src + a.id) === String(body.ref || '')) || null);
  } catch (_) {}
  if (!appt) return { appt: null, remainder: 0 };
  try {
    const b = await bill.billFor(appt);
    return { appt, remainder: Math.max(0, Number(b.remainder_cents) || 0), bill: b };
  } catch (_) { return { appt, remainder: 0 }; }
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensure();

    /* ── WHO IS THIS ──
       Email or phone settles it outright. A name settles it only when one
       person matches; otherwise the screen shows the shortlist and they
       pick. Nothing is guessed, because a guess here charges somebody
       else's card. */
    if (req.method === 'GET' && action === 'find') {
      const find = require('./_kiosk-find');
      const { matches, how } = await find.findFor(req.query.q);
      const bill = require('./_kiosk-bill');

      const pay = require('./_pay');
      const sk = await pay.getStripeSecret();

      const out = [];
      for (const a of matches.slice(0, 8)) {
        const b = await bill.billFor(a);
        const card = await bill.cardOnFile(sk, b.stripe_customer_id);
        out.push({
          ref: a.src + a.id,
          name: b.name, service: b.service, time: b.time, artist: b.artist,
          is_member: b.is_member, tier_label: b.tier_label,
          list_cents: b.list_cents,
          covered_by_membership: b.covered_by_membership,
          deposit_taken_cents: b.deposit_taken_cents,
          remainder_cents: b.remainder_cents,
          card_on_file: card ? { brand: card.brand, last4: card.last4 } : null,
        });
      }
      return res.json({ how, count: matches.length, matches: out });
    }

    if (req.method === 'POST' && action === 'checkin') {
      const { name } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
      // One person or none. Stamping somebody else as arrived turns a real
      // client into a no-show in every report that follows.
      const appt = (await resolveVisit({ q: name, ref: (req.body || {}).ref })).appt;
      // Arrival is the thing that separates a no-show from a client. It has
      // to land on the appointment, not only in the log.
      await stampAppointment(appt, { checked_in_ts: Date.now() });
      await execute('INSERT INTO kiosk_log (type, name, detail, ts) VALUES (?,?,?,?)',
        ['checkin', String(name).trim().slice(0, 80), appt ? (appt.service + ' at ' + appt.time) : 'no appointment matched', Date.now()]);
      try { await notify.notifyInApp('owner', null, '✦ ' + String(name).trim() + ' just checked in', appt ? (appt.service + ' at ' + appt.time) : 'Walk-in / no matched appointment'); } catch (_) {}
      return res.json({ ok: true, matched: !!appt, service: appt ? appt.service : null, time: appt ? appt.time : null, first: String(name).trim().split(' ')[0] });
    }

    if (req.method === 'GET' && action === 'balance') {
      const resolvedBal = await resolveVisit({ q: req.query.q || req.query.name, ref: req.query.ref });
      const appt = resolvedBal.appt;
      if (!appt) return res.json({ found: false });
      const balance = resolvedBal.remainder;
      return res.json({ found: true, service: appt.service, time: appt.time, balance_cents: balance, ref: appt.src + appt.id, name: appt.name });
    }

    // Card: PaymentIntent for the remaining balance + optional tip. Members
    // with a $0 balance can still leave a tip-only payment.
    /* ── PAY WITH THE CARD ALREADY ON FILE ──
       The one payment nobody watches happen: the client taps nothing and
       enters nothing. So it does not happen without a signature, and the
       signature is stored with exactly what it authorised. Without that, a
       chargeback months later is simply lost. */
    if (req.method === 'POST' && action === 'pay_on_file') {
      const body = req.body || {};
      const charge = require('./_kiosk-charge');

      const sigProblem = charge.signatureProblem(body.signature);
      if (sigProblem) return res.status(400).json({ error: sigProblem });

      const find = require('./_kiosk-find');
      const bill = require('./_kiosk-bill');
      const { matches } = await find.findFor(body.q);
      // The desk has already chosen who this is; anything ambiguous here
      // means the wrong person is about to be charged.
      const appt = matches.length === 1
        ? matches[0]
        : matches.find(a => (a.src + a.id) === String(body.ref || ''));
      if (!appt) return res.status(404).json({ error: 'Could not match that to one appointment — search again.' });

      const b = await bill.billFor(appt);
      const tip = Math.max(0, Math.round(Number(body.tip_cents) || 0));
      // The amount is recomputed here. What the iPad believes is a display.
      const amount = b.remainder_cents + tip;
      if (amount < 50) return res.status(400).json({ error: 'There is nothing to charge.' });

      const pay = require('./_pay');
      const sk = await pay.getStripeSecret();
      if (!sk) return res.status(400).json({ error: 'Card payments are not set up.' });
      if (!b.stripe_customer_id) return res.status(400).json({ error: 'No card on file for this client.' });

      const card = await bill.cardOnFile(sk, b.stripe_customer_id);
      if (!card) return res.status(400).json({ error: 'No usable card on file — take payment another way.' });

      const out = await charge.chargeOnFile({
        sk,
        customerId: b.stripe_customer_id,
        paymentMethodId: card.id,
        amountCents: amount,
        description: 'ZOLA checkout — ' + (b.name || 'client') + ' (' + (b.service || '') + ')',
        metadata: {
          ref: appt.src + appt.id,
          remainder_cents: String(b.remainder_cents),
          tip_cents: String(tip),
        },
      });

      // Recorded either way. A refused charge that somebody signed for is
      // still something worth being able to look up.
      await charge.recordAuthorization({
        ref: appt.src + appt.id,
        client_name: b.name,
        client_email: appt.email || '',
        amount_cents: amount,
        remainder_cents: b.remainder_cents,
        tip_cents: tip,
        method: 'card_on_file',
        card_brand: card.brand,
        card_last4: card.last4,
        signature: body.signature,
        payment_intent: out.id || '',
        outcome: out.ok ? 'paid' : ('failed: ' + (out.why || '')).slice(0, 200),
      });

      if (!out.ok) return res.status(402).json({ error: out.why || 'The card was declined.' });

      await stampAppointment(appt, {
        checked_out_ts: Date.now(),
        paid_cents: amount,
        tip_cents: tip,
        pay_method: 'card_on_file',
        status: 'COMPLETED',
        deposit_paid: 1,
      });
      await execute('INSERT INTO kiosk_log (type, name, method, amount_cents, detail, ts) VALUES (?,?,?,?,?,?)',
        ['checkout', String(b.name || '').slice(0, 80), 'card_on_file', amount,
         'card on file · signed' + (tip ? ' · tip $' + (tip / 100).toFixed(2) : ''), Date.now()]);
      try {
        await notify.notifyInApp('owner', null,
          '💳 ' + b.name + ' paid $' + (amount / 100).toFixed(2) + ' on file',
          card.brand + ' ····' + card.last4 + (tip ? ' · includes a $' + (tip / 100).toFixed(2) + ' tip 💛' : ''));
      } catch (_) {}

      return res.json({
        ok: true, amount_cents: amount, tip_cents: tip,
        card: card.brand + ' ····' + card.last4,
      });
    }

    /* Every card-on-file charge with the signature behind it, so a dispute
       can be answered rather than argued. */
    if (req.method === 'GET' && action === 'authorizations') {
      if (req.headers['x-ceo-password'] !== (process.env.CEO_PASSWORD || 'ZOLA2026')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const charge = require('./_kiosk-charge');
      const to = Number(req.query.to) || Date.now();
      const from = Number(req.query.from) || (to - 90 * 86400000);
      return res.json({ authorizations: await charge.listAuthorizations({ from, to, limit: req.query.limit }) });
    }

    if (req.method === 'GET' && action === 'signature') {
      if (req.headers['x-ceo-password'] !== (process.env.CEO_PASSWORD || 'ZOLA2026')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const charge = require('./_kiosk-charge');
      return res.json({ signature: await charge.signatureFor(req.query.id) });
    }

    if (req.method === 'POST' && action === 'pay_intent') {
      const body = req.body || {};
      const resolved = await resolveVisit(body);
      const appt = resolved.appt;
      const tip = Math.max(0, Math.round(Number(body.tip_cents) || 0));
      const balance = resolved.remainder;
      const amount = balance + tip;
      if (amount < 50) return res.status(400).json({ error: 'Nothing to charge ✦' });
      const pay = require('./_pay');
      const sk = await pay.getStripeSecret();
      if (!sk) return res.status(400).json({ error: 'Card payments not configured' });
      const who = appt ? appt.name : (body.name || 'Guest');
      const what = balance > 0 ? ('balance' + (tip ? ' + tip' : '')) : 'tip';
      const resp = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          amount: String(amount), currency: 'usd', 'automatic_payment_methods[enabled]': 'true',
          description: ('ZOLA checkout ' + what + ' — ' + who + (appt ? ' (' + appt.service + ')' : '')).slice(0, 300),
          'metadata[tip_cents]': String(tip),
        }).toString(),
      });
      const pi = await resp.json();
      if (!resp.ok) return res.status(400).json({ error: pi.error && pi.error.message || 'Stripe error' });
      return res.json({ client_secret: pi.client_secret, payment_intent_id: pi.id, balance_cents: balance, tip_cents: tip, amount_cents: amount });
    }

    if (req.method === 'POST' && action === 'checkout') {
      const { name, method: payMethod, payment_intent_id, tip_cents } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name required' });
      // Cash is the one the browser could otherwise decide the size of.
      const resolvedOut = await resolveVisit(req.body || {});
      let amount = resolvedOut.remainder + Math.max(0, Math.round(Number(tip_cents) || 0));
      const tip = Math.max(0, Math.round(Number(tip_cents) || 0));
      if (payMethod === 'card' && payment_intent_id) {
        const v = await require('./_pay').verifyPaymentIntent(payment_intent_id);
        if (!v.paid) return res.status(402).json({ error: 'Card payment did not go through — please try again.' });
        amount = v.amount || amount;
      }
      // Everything the reports need lands on the appointment now: that they
      // finished, what they paid, how, and what they tipped. A tip that
      // lives only in the kiosk log is a tip nobody can ever total up.
      const appt = resolvedOut.appt;
      if (appt) {
        await stampAppointment(appt, {
          checked_out_ts: Date.now(),
          paid_cents: amount,
          tip_cents: tip,
          pay_method: payMethod === 'card' ? 'card' : 'cash',
          status: 'COMPLETED',
          deposit_paid: 1,
        });
      }
      await execute('INSERT INTO kiosk_log (type, name, method, amount_cents, detail, ts) VALUES (?,?,?,?,?,?)',
        ['checkout', String(name).trim().slice(0, 80), payMethod === 'card' ? 'card' : 'cash', amount,
         tip ? ('tip $' + (tip / 100).toFixed(2)) : '', Date.now()]);
      const amt = '$' + (amount / 100).toFixed(2);
      const tipNote = tip ? (' · includes a $' + (tip / 100).toFixed(2) + ' tip 💛') : '';
      try {
        await notify.notifyInApp('owner', null,
          payMethod === 'card' ? ('💳 ' + name + ' paid ' + amt + ' by card') : ('💵 Collect ' + amt + ' cash from ' + name),
          'Checked out at the kiosk.' + tipNote);
      } catch (_) {}
      return res.json({ ok: true });
    }

    // Today, as it actually stands: who is expected, who has walked in, who
    // is finished. Read by Studio Manager so the floor and the office are
    // never looking at two different days.
    if (req.method === 'GET' && action === 'today') {
      const today = new Date().toISOString().slice(0, 10);
      const rows = [];
      // The artist's name comes from team_members — this table stores the id.
      // The checkout columns are added by ensure() above, but a cold start
      // that failed halfway would leave them missing, so the query falls back
      // rather than dropping the whole day's floor.
      try {
        let t = [];
        try {
          t = await query(
            `SELECT a.id, a.client_name AS name, a.service, a.time, a.status,
                    COALESCE(m.name, '') AS artist,
                    a.checked_in_ts, a.checked_out_ts, a.tip_cents, a.paid_cents, a.pay_method
               FROM team_appointments a
               LEFT JOIN team_members m ON m.id = a.team_member_id
              WHERE a.date=?`, [today]);
        } catch (_) {
          t = await query(
            `SELECT a.id, a.client_name AS name, a.service, a.time, a.status,
                    COALESCE(m.name, '') AS artist
               FROM team_appointments a
               LEFT JOIN team_members m ON m.id = a.team_member_id
              WHERE a.date=?`, [today]);
        }
        for (const r of t) {
          if (/cancel/i.test(String(r.status || ''))) continue;
          rows.push({ ...r, src: 't', total_cents: 0, deposit_paid: 1 });
        }
      } catch (_) {}
      try {
        const main = require('./_db');
        const m = await main.query(
          `SELECT a.id, COALESCE(mm.full_name, a.guest_name) AS name, a.service,
                  a.appointment_time AS time, COALESCE(st.name, '') AS artist, a.status,
                  a.total_cents, a.deposit_cents, a.deposit_paid,
                  a.checked_in_ts, a.checked_out_ts, a.tip_cents, a.paid_cents, a.pay_method
             FROM appointments a LEFT JOIN members mm ON a.member_id = mm.member_id
                  LEFT JOIN staff st ON a.staff_id = st.id
            WHERE a.appointment_date=? AND a.status <> 'CANCELLED'`, [today]);
        for (const r of m) rows.push({ ...r, src: 'm' });
      } catch (_) {}

      // An online booking is written into both tables on purpose. Showing
      // both would put the same client on the floor twice — once payable,
      // once not — and she would check somebody in against the wrong one.
      const key = r => String(r.name || '').trim().toLowerCase().replace(/\s+/g, ' ')
        + '|' + String(r.time || '').slice(0, 5);
      const fromMoney = new Set(rows.filter(r => r.src === 'm').map(key));
      const deduped = rows.filter(r => r.src === 'm' || !fromMoney.has(key(r)));

      const num = v => Number(v) || 0;
      deduped.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
      const board = deduped.map(r => ({
        ref: r.src + r.id, name: r.name || 'Guest', service: r.service || 'Appointment',
        time: r.time || '', artist: r.artist || '',
        state: num(r.checked_out_ts) ? 'done' : (num(r.checked_in_ts) ? 'in' : 'due'),
        checked_in_ts: num(r.checked_in_ts), checked_out_ts: num(r.checked_out_ts),
        total_cents: num(r.total_cents), paid_cents: num(r.paid_cents), tip_cents: num(r.tip_cents),
        pay_method: r.pay_method || '',
        balance_cents: Math.max(0, num(r.total_cents) - (num(r.deposit_paid) ? num(r.deposit_cents) : 0)),
      }));

      return res.json({
        date: today, board,
        counts: {
          expected: board.length,
          arrived: board.filter(b => b.state !== 'due').length,
          in_chair: board.filter(b => b.state === 'in').length,
          done: board.filter(b => b.state === 'done').length,
          not_arrived: board.filter(b => b.state === 'due').length,
        },
        money: {
          taken_cents: board.reduce((s, b) => s + b.paid_cents, 0),
          tips_cents: board.reduce((s, b) => s + b.tip_cents, 0),
          outstanding_cents: board.filter(b => b.state !== 'done').reduce((s, b) => s + b.balance_cents, 0),
        },
      });
    }

    // Marking somebody in or out from the manager screen, for when the
    // client never touched the iPad. Same effect, so the two never disagree.
    if (req.method === 'POST' && action === 'mark') {
      const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const { ref, state } = req.body || {};
      const src = String(ref || '').charAt(0);
      const id = Number(String(ref || '').slice(1));
      if (!id || (src !== 't' && src !== 'm')) return res.status(400).json({ error: 'Bad reference' });
      const appt = { src, id };
      if (state === 'in')       await stampAppointment(appt, { checked_in_ts: Date.now(), checked_out_ts: 0 });
      else if (state === 'done') await stampAppointment(appt, { checked_out_ts: Date.now(), status: 'COMPLETED' });
      else if (state === 'due')  await stampAppointment(appt, { checked_in_ts: 0, checked_out_ts: 0 });
      else return res.status(400).json({ error: 'Unknown state' });
      return res.json({ ok: true });
    }

    if (req.method === 'POST' && action === 'review') {
      const { name, stars, text } = req.body || {};
      const s = Math.max(1, Math.min(5, Number(stars) || 0));
      if (!s) return res.status(400).json({ error: 'Pick a star rating' });
      await execute('INSERT INTO kiosk_log (type, name, stars, detail, ts) VALUES (?,?,?,?,?)',
        ['review', String(name || 'Guest').trim().slice(0, 80), s, String(text || '').slice(0, 600), Date.now()]);
      try { await notify.notifyInApp('owner', null, '⭐ ' + s + '-star review from ' + (name || 'a guest'), String(text || '(no comment)').slice(0, 200)); } catch (_) {}
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
