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
  _ready = true;
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

    // Card: create a PaymentIntent for the remaining balance (server-priced)
    if (req.method === 'POST' && action === 'pay_intent') {
      const appt = await findToday((req.body || {}).name);
      if (!appt) return res.status(404).json({ error: 'No appointment found for today' });
      const balance = Math.max(0, appt.total_cents - (appt.deposit_paid ? appt.deposit_cents : 0));
      if (balance < 50) return res.status(400).json({ error: 'Nothing left to pay ✦' });
      const pay = require('./_pay');
      const sk = await pay.getStripeSecret();
      if (!sk) return res.status(400).json({ error: 'Card payments not configured' });
      const resp = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          amount: String(balance), currency: 'usd', 'automatic_payment_methods[enabled]': 'true',
          description: ('ZOLA checkout balance — ' + appt.name + ' (' + appt.service + ')').slice(0, 300),
        }).toString(),
      });
      const pi = await resp.json();
      if (!resp.ok) return res.status(400).json({ error: pi.error && pi.error.message || 'Stripe error' });
      return res.json({ client_secret: pi.client_secret, payment_intent_id: pi.id, balance_cents: balance });
    }

    if (req.method === 'POST' && action === 'checkout') {
      const { name, method: payMethod, payment_intent_id, amount_cents } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name required' });
      let amount = Number(amount_cents) || 0;
      if (payMethod === 'card' && payment_intent_id) {
        const v = await require('./_pay').verifyPaymentIntent(payment_intent_id);
        if (!v.paid) return res.status(402).json({ error: 'Card payment did not go through — please try again.' });
        amount = v.amount || amount;
      }
      await execute('INSERT INTO kiosk_log (type, name, method, amount_cents, ts) VALUES (?,?,?,?,?)',
        ['checkout', String(name).trim().slice(0, 80), payMethod === 'card' ? 'card' : 'cash', amount, Date.now()]);
      const amt = '$' + (amount / 100).toFixed(2);
      try {
        await notify.notifyInApp('owner', null,
          payMethod === 'card' ? ('💳 ' + name + ' paid ' + amt + ' by card') : ('💵 Collect ' + amt + ' cash from ' + name),
          'Checked out at the kiosk.');
      } catch (_) {}
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
