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
  const sets = Object.keys(fields);
  if (!sets.length) return;
  const sql = 'UPDATE ' + (appt.src === 't' ? 'team_appointments' : 'appointments')
    + ' SET ' + sets.map(k => k + '=?').join(', ') + ' WHERE id=?';
  const vals = sets.map(k => fields[k]).concat([Number(appt.id)]);
  try {
    if (appt.src === 't') await execute(sql, vals);
    else await require('./_db').execute(sql, vals);
  } catch (_) {}
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

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensure();

    if (req.method === 'POST' && action === 'checkin') {
      const { name } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
      const appt = await findToday(name);
      // Arrival is the thing that separates a no-show from a client. It has
      // to land on the appointment, not only in the log.
      await stampAppointment(appt, { checked_in_ts: Date.now() });
      await execute('INSERT INTO kiosk_log (type, name, detail, ts) VALUES (?,?,?,?)',
        ['checkin', String(name).trim().slice(0, 80), appt ? (appt.service + ' at ' + appt.time) : 'no appointment matched', Date.now()]);
      try { await notify.notifyInApp('owner', null, '✦ ' + String(name).trim() + ' just checked in', appt ? (appt.service + ' at ' + appt.time) : 'Walk-in / no matched appointment'); } catch (_) {}
      return res.json({ ok: true, matched: !!appt, service: appt ? appt.service : null, time: appt ? appt.time : null, first: String(name).trim().split(' ')[0] });
    }

    if (req.method === 'GET' && action === 'balance') {
      const appt = await findToday(req.query.name);
      if (!appt) return res.json({ found: false });
      const balance = Math.max(0, appt.total_cents - (appt.deposit_paid ? appt.deposit_cents : 0));
      return res.json({ found: true, service: appt.service, time: appt.time, balance_cents: balance, ref: appt.src + appt.id, name: appt.name });
    }

    // Card: PaymentIntent for the remaining balance + optional tip. Members
    // with a $0 balance can still leave a tip-only payment.
    if (req.method === 'POST' && action === 'pay_intent') {
      const body = req.body || {};
      const appt = await findToday(body.name);
      const tip = Math.max(0, Math.round(Number(body.tip_cents) || 0));
      const balance = appt ? Math.max(0, appt.total_cents - (appt.deposit_paid ? appt.deposit_cents : 0)) : 0;
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
      const { name, method: payMethod, payment_intent_id, amount_cents, tip_cents } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name required' });
      let amount = Number(amount_cents) || 0;
      const tip = Math.max(0, Math.round(Number(tip_cents) || 0));
      if (payMethod === 'card' && payment_intent_id) {
        const v = await require('./_pay').verifyPaymentIntent(payment_intent_id);
        if (!v.paid) return res.status(402).json({ error: 'Card payment did not go through — please try again.' });
        amount = v.amount || amount;
      }
      // Everything the reports need lands on the appointment now: that they
      // finished, what they paid, how, and what they tipped. A tip that
      // lives only in the kiosk log is a tip nobody can ever total up.
      const appt = await findToday(name);
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

      const num = v => Number(v) || 0;
      rows.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
      const board = rows.map(r => ({
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
