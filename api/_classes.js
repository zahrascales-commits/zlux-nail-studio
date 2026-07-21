// Nail classes for purchase (Russian Manicure, Hard Gel Application, Acrylic
// Application, etc.) — owner adds/prices them in the Studio Manager, clients
// buy them here. Same server-verified-payment pattern as booking deposits.
const { query, queryOne, execute, ensureTables } = require('./_team-db');
const { notifyInApp, sendEmail } = require('./_notify');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const STARTER_CLASSES = ['Russian Manicure Class', 'Hard Gel Application Class', 'Acrylic Application Class'];

async function seedStarterClasses() {
  const existing = await query('SELECT name FROM classes');
  const have = new Set(existing.map(c => c.name));
  for (const name of STARTER_CLASSES) {
    if (!have.has(name)) {
      await execute('INSERT INTO classes (name, price_cents, description, active, created_ts) VALUES (?,0,?,1,?)',
        [name, 'Set your price and description in Studio Manager.', Date.now()]);
    }
  }
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensureTables();
    await seedStarterClasses();

    // ── PUBLIC: classes open for purchase ──
    if (req.method === 'GET' && action === 'list') {
      const rows = await query('SELECT id, name, price_cents, description FROM classes WHERE active=1 ORDER BY id');
      return res.json({ classes: rows });
    }

    // ── OWNER: every class, including paused ones ──
    if (req.method === 'GET' && action === 'admin_list') {
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const rows = await query('SELECT * FROM classes ORDER BY id');
      return res.json({ classes: rows });
    }

    if (req.method === 'POST' && action === 'add') {
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const { name, price_cents, description } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name required' });
      const r = await execute('INSERT INTO classes (name, price_cents, description, active, created_ts) VALUES (?,?,?,1,?)',
        [name, Math.max(0, Number(price_cents) || 0), description || '', Date.now()]);
      return res.json({ ok: true, id: r.lastInsertRowid });
    }

    if (req.method === 'PUT' && action === 'update') {
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const { id, name, price_cents, description, active } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await execute('UPDATE classes SET name=?, price_cents=?, description=?, active=? WHERE id=?',
        [name, Math.max(0, Number(price_cents) || 0), description || '', active ? 1 : 0, Number(id)]);
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE' && action === 'delete') {
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      await execute('DELETE FROM classes WHERE id=?', [Number((req.body || {}).id)]);
      return res.json({ ok: true });
    }

    // ── OWNER: who has purchased what ──
    if (req.method === 'GET' && action === 'purchases') {
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const rows = await query('SELECT * FROM class_purchases ORDER BY ts DESC LIMIT 200');
      return res.json({ purchases: rows });
    }

    // ── PUBLIC: start a purchase — price always recomputed server-side ──
    if (req.method === 'POST' && action === 'purchase_intent') {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) return res.status(400).json({ error: 'Payments not configured' });
      const { class_id, buyer_name, buyer_email } = req.body || {};
      const cls = await queryOne('SELECT * FROM classes WHERE id=? AND active=1', [Number(class_id)]);
      if (!cls) return res.status(404).json({ error: 'Class not found' });
      if (!cls.price_cents) return res.status(400).json({ error: 'This class isn’t priced yet — check back soon.' });
      const params = {
        amount: String(cls.price_cents),
        currency: 'usd',
        'automatic_payment_methods[enabled]': 'true',
        description: `ZOLA class — ${cls.name} (${buyer_name || 'client'})`,
        'metadata[class_id]': String(cls.id),
        'metadata[class_name]': cls.name,
      };
      if (buyer_email && /@/.test(buyer_email)) params.receipt_email = buyer_email;
      const r = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + stripeKey, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
      const pi = await r.json();
      if (!r.ok) return res.status(400).json({ error: pi.error && pi.error.message || 'Stripe error' });
      return res.json({ client_secret: pi.client_secret, payment_intent_id: pi.id, price_cents: cls.price_cents, class_name: cls.name });
    }

    // ── PUBLIC: finalize after Stripe confirms payment client-side ──
    if (req.method === 'POST' && action === 'confirm_purchase') {
      const { class_id, payment_intent_id, buyer_name, buyer_email, buyer_phone } = req.body || {};
      const cls = await queryOne('SELECT * FROM classes WHERE id=?', [Number(class_id)]);
      if (!cls) return res.status(404).json({ error: 'Class not found' });
      const v = await require('./_pay').verifyPaymentIntent(payment_intent_id);
      if (!v.paid) return res.status(402).json({ error: 'Payment did not go through (' + (v.status || v.why) + '). You have not been charged.' });
      await execute(
        'INSERT INTO class_purchases (class_id, class_name, price_cents, buyer_name, buyer_email, buyer_phone, payment_intent_id, ts) VALUES (?,?,?,?,?,?,?,?)',
        [cls.id, cls.name, cls.price_cents, String(buyer_name || '').slice(0, 120), String(buyer_email || '').slice(0, 160), String(buyer_phone || '').slice(0, 40), payment_intent_id || null, Date.now()]
      );
      try {
        await notifyInApp('owner', null, `Class purchased 🎓 ${cls.name}`, `${buyer_name || 'A client'} just bought ${cls.name} — $${(cls.price_cents / 100).toFixed(2)}`);
        if (buyer_email) await sendEmail(buyer_email, `You're in — ${cls.name} ✦ ZOLA Nail Studio`,
          `<p>Thank you for purchasing <strong>${cls.name}</strong>!</p><p>Zahra will reach out directly to schedule your class time.</p>`);
      } catch (_) {}
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
