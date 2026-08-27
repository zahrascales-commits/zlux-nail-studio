// ZOLA Press-Ons shop.
// Public: browse the catalog, buy a set (server-priced Stripe), claim ONE
// free sizing kit ever (strictly enforced per email in the clients table —
// once claimed it can never be claimed again, even across orders/devices).
// Sizes are saved on the client's record forever, so after their first
// sizing they never size again — every future order auto-attaches them.
// Owner: full CRUD for categories/products (photo, price, flags) + orders.
const { query, queryOne, execute, ensureTables } = require('./_team-db');
const notify = require('./_notify');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const MAX_PHOTO = 900000;

let _ready = false;
async function ensure() {
  await ensureTables();
  if (_ready) return;
  await execute(`CREATE TABLE IF NOT EXISTS presson_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS presson_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL DEFAULT 0,
    category TEXT DEFAULT '',
    photo TEXT DEFAULT '',
    new_drop INTEGER DEFAULT 0,
    best_seller INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS presson_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    product_name TEXT,
    price_cents INTEGER,
    buyer_name TEXT,
    buyer_email TEXT,
    buyer_phone TEXT,
    sizes TEXT DEFAULT '',
    kit INTEGER DEFAULT 0,
    payment_intent_id TEXT,
    ts INTEGER
  )`);
  // Sizes live on the client record — remembered forever, one kit per person
  for (const sql of [
    "ALTER TABLE clients ADD COLUMN sizes TEXT DEFAULT ''",
    "ALTER TABLE clients ADD COLUMN sizing_kit_claimed INTEGER DEFAULT 0",
  ]) { try { await execute(sql); } catch (_) {} }
  _ready = true;
}

const isOwner = req => req.headers['x-ceo-password'] === CEO_PASSWORD;

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensure();

    // ── PUBLIC: catalog ──
    if (req.method === 'GET' && (action === 'catalog' || !action)) {
      const cats = await query('SELECT * FROM presson_categories ORDER BY name');
      const products = await query('SELECT * FROM presson_products WHERE active=1 ORDER BY created_ts DESC');
      return res.json({ categories: cats, products });
    }

    // ── PUBLIC: does this buyer have sizes on file / kit already claimed? ──
    if (req.method === 'GET' && action === 'me') {
      const email = String(req.query.email || '').trim().toLowerCase();
      if (!email) return res.json({ has_sizes: false, kit_claimed: false });
      const c = await queryOne('SELECT sizes, sizing_kit_claimed FROM clients WHERE lower(email)=?', [email]);
      return res.json({ has_sizes: !!(c && c.sizes && String(c.sizes).trim()), kit_claimed: !!(c && Number(c.sizing_kit_claimed)) });
    }

    // ── PUBLIC: start a purchase (price always recomputed server-side) ──
    if (req.method === 'POST' && action === 'purchase_intent') {
      const p = await queryOne('SELECT * FROM presson_products WHERE id=? AND active=1', [Number((req.body || {}).product_id)]);
      if (!p) return res.status(404).json({ error: 'Set not found' });
      if (!Number(p.price_cents)) return res.status(400).json({ error: 'This set isn\'t priced yet.' });
      const sk = await require('./_pay').getStripeSecret();
      if (!sk) return res.status(400).json({ error: 'Payments not configured' });

      // Ten dollars off the first ten people applies here too. Worked out
      // server-side in the same request that creates the charge, so what is
      // taken and what was promised on screen cannot disagree.
      let ebOff = 0, ebLabel = '';
      try {
        const s = await require('./_earlybird').state();
        if (s.available) { ebOff = Math.min(s.amount_cents, Math.max(0, p.price_cents - 50)); ebLabel = s.label; }
      } catch (_) {}
      const charge = Math.max(50, p.price_cents - ebOff);

      const r = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          amount: String(charge), currency: 'usd', 'automatic_payment_methods[enabled]': 'true',
          description: ('ZOLA Press-Ons — ' + p.name + (ebOff ? ' (early bird)' : '')).slice(0, 300),
          'metadata[product_id]': String(p.id),
          'metadata[early_bird_cents]': String(ebOff),
        }).toString(),
      });
      const pi = await r.json();
      if (!r.ok) return res.status(400).json({ error: pi.error && pi.error.message || 'Stripe error' });
      return res.json({
        client_secret: pi.client_secret, payment_intent_id: pi.id,
        price_cents: p.price_cents,
        early_bird_cents: ebOff, early_bird_label: ebLabel,
        charge_cents: charge,
      });
    }

    // ── PUBLIC: confirm after Stripe charges — sizing-kit rule enforced HERE ──
    if (req.method === 'POST' && action === 'confirm') {
      const { product_id, payment_intent_id, buyer_name, buyer_email, buyer_phone, want_kit, sizes: providedSizes } = req.body || {};
      const p = await queryOne('SELECT * FROM presson_products WHERE id=?', [Number(product_id)]);
      if (!p) return res.status(404).json({ error: 'Set not found' });
      const v = await require('./_pay').verifyPaymentIntent(payment_intent_id);
      if (!v.paid) return res.status(402).json({ error: 'Payment did not go through — you have not been charged.' });

      const email = String(buyer_email || '').trim().toLowerCase();
      // Look up (or create) the client so sizes + kit history stick forever
      let client = email ? await queryOne('SELECT * FROM clients WHERE lower(email)=?', [email]) : null;
      // The place is taken only now, once the payment has cleared — never
      // when the intent was created. An abandoned checkout must not burn one
      // of the ten.
      try {
        const pay = await require('./_pay').verifyPaymentIntent(payment_intent_id);
        const off = Number((pay && pay.metadata && pay.metadata.early_bird_cents) || 0);
        if (off > 0) {
          await require('./_earlybird').claim({
            member_id: '', name: buyer_name, email, tier: '', billing: 'one-off', what: 'press-ons',
          });
        }
      } catch (_) {}

      try { await execute("ALTER TABLE clients ADD COLUMN source TEXT DEFAULT ''"); } catch (_) {}
      if (!client && email) {
        await execute('INSERT INTO clients (name,email,phone,source,created_ts) VALUES (?,?,?,?,?)',
          [String(buyer_name || '').slice(0, 120), email, String(buyer_phone || '').slice(0, 40),
           'presson_buyer', Date.now()]);
        client = await queryOne('SELECT * FROM clients WHERE lower(email)=?', [email]);
      } else if (client) {
        // Somebody already in the book who has now bought press-ons belongs
        // on that list too, without losing however they first arrived.
        try {
          await execute("UPDATE clients SET source='presson_buyer' WHERE id=? AND (source IS NULL OR source='')", [client.id]);
        } catch (_) {}
      }

      // ONE sizing kit per person, ever. If they already claimed one — no
      // matter when — the request is refused server-side. No loopholes.
      let kitGranted = false, kitNote = '';
      if (want_kit) {
        if (client && Number(client.sizing_kit_claimed)) {
          kitNote = 'kit_already_claimed';
        } else if (client) {
          await execute('UPDATE clients SET sizing_kit_claimed=1 WHERE id=?', [client.id]);
          kitGranted = true;
        }
      }

      // Sizes: if the buyer typed sizes at checkout, save them to their file
      // FOREVER (client record) — from then on every order auto-attaches them.
      const typedSizes = String(providedSizes || '').trim().slice(0, 300);
      if (typedSizes && client) {
        await execute('UPDATE clients SET sizes=? WHERE id=?', [typedSizes, client.id]);
      }
      const sizes = typedSizes || (client && client.sizes ? String(client.sizes) : '');
      await execute(
        'INSERT INTO presson_orders (product_id, product_name, price_cents, buyer_name, buyer_email, buyer_phone, sizes, kit, payment_intent_id, ts) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [p.id, p.name, p.price_cents, String(buyer_name || '').slice(0, 120), email, String(buyer_phone || '').slice(0, 40), sizes, kitGranted ? 1 : 0, payment_intent_id || null, Date.now()]);

      try {
        await notify.notifyInApp('owner', null, '💅 Press-on order: ' + p.name,
          (buyer_name || 'A client') + ' — $' + (p.price_cents / 100).toFixed(2)
          + (kitGranted ? ' + FREE sizing kit (first order)' : '')
          + (sizes ? ' · sizes: ' + sizes.slice(0, 60) : ' · ⚠ NO SIZES YET — collect their sizes before making this set'));
        if (email) await notify.sendEmail(email, 'Your ZOLA press-ons are on the way ✦',
          '<p>Thank you for your order — <strong>' + p.name + '</strong>!</p>'
          + (typedSizes ? '<p>Your sizes are saved with us <strong>forever</strong> — you\'ll never need to enter them again. ✦</p>' : '')
          + (kitGranted ? '<p>Your <strong>free sizing kit</strong> is included. Message us your sizes when it arrives and we\'ll keep them on file forever — you\'ll never need to size again.</p>' : '')
          + (!typedSizes && sizes ? '<p>We have your sizes on file and they\'re applied to this order automatically. ✦</p>' : '')
          + '<p>— ZOLA ✦</p>');
      } catch (_) {}
      return res.json({ ok: true, kit: kitGranted, kit_note: kitNote, had_sizes: !!sizes, sizes_saved: !!typedSizes });
    }

    // ── OWNER: everything below ──
    if (!isOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'GET' && action === 'admin') {
      const cats = await query('SELECT * FROM presson_categories ORDER BY name');
      const products = await query('SELECT * FROM presson_products ORDER BY created_ts DESC');
      const orders = await query('SELECT * FROM presson_orders ORDER BY ts DESC LIMIT 100');
      return res.json({ categories: cats, products, orders });
    }
    if (req.method === 'POST' && action === 'category_add') {
      const name = String((req.body || {}).name || '').trim();
      if (!name) return res.status(400).json({ error: 'Name required' });
      try { await execute('INSERT INTO presson_categories (name) VALUES (?)', [name]); } catch (_) {}
      return res.json({ ok: true });
    }
    if (req.method === 'DELETE' && action === 'category') {
      await execute('DELETE FROM presson_categories WHERE id=?', [Number((req.body || {}).id)]);
      return res.json({ ok: true });
    }
    if (req.method === 'POST' && action === 'product_add') {
      const { name, price_cents, category, photo, new_drop, best_seller } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name required' });
      if (photo && String(photo).length > MAX_PHOTO) return res.status(413).json({ error: 'Photo too large' });
      const r = await execute(
        'INSERT INTO presson_products (name, price_cents, category, photo, new_drop, best_seller, active, created_ts) VALUES (?,?,?,?,?,?,1,?)',
        [name, Math.max(0, Number(price_cents) || 0), category || '', photo || '', new_drop ? 1 : 0, best_seller ? 1 : 0, Date.now()]);
      return res.json({ ok: true, id: r.lastInsertRowid });
    }
    if (req.method === 'PUT' && action === 'product_update') {
      const b = req.body || {};
      const cur = await queryOne('SELECT * FROM presson_products WHERE id=?', [Number(b.id)]);
      if (!cur) return res.status(404).json({ error: 'Not found' });
      if (b.photo && String(b.photo).length > MAX_PHOTO) return res.status(413).json({ error: 'Photo too large' });
      await execute('UPDATE presson_products SET name=?, price_cents=?, category=?, photo=?, new_drop=?, best_seller=?, active=? WHERE id=?',
        [b.name !== undefined ? b.name : cur.name,
         b.price_cents !== undefined ? Math.max(0, Number(b.price_cents) || 0) : cur.price_cents,
         b.category !== undefined ? b.category : cur.category,
         b.photo !== undefined ? b.photo : cur.photo,
         b.new_drop !== undefined ? (b.new_drop ? 1 : 0) : cur.new_drop,
         b.best_seller !== undefined ? (b.best_seller ? 1 : 0) : cur.best_seller,
         b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
         Number(b.id)]);
      return res.json({ ok: true });
    }
    if (req.method === 'DELETE' && action === 'product') {
      await execute('DELETE FROM presson_products WHERE id=?', [Number((req.body || {}).id)]);
      return res.json({ ok: true });
    }
    if (req.method === 'DELETE' && action === 'order') {
      await execute('DELETE FROM presson_orders WHERE id=?', [Number((req.body || {}).id)]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
