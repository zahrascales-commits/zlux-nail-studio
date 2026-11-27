// Who has a card on file, and how to ask the rest.
//
// A card on file is the difference between a checkout that takes one tap and
// one where somebody digs through a bag with wet nails. But it only ever
// appears as a side effect of paying, so the studio had no way to see who
// had one, and no way to ask the people who did not.
//
// This lists every client with their card status and sends the ones without
// a link to add one. Nothing is charged by that link. A saved card covers
// the deposit on appointments they book; everything else at the desk needs
// a signature.
const { query, queryOne } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const SITE = process.env.PUBLIC_BASE_URL || 'https://zolanailstudio.com';

const lower = s => String(s || '').trim().toLowerCase();
/* The last ten digits, which is what matches a number typed any of the six
   ways people type one. Spelled the same way as in _kiosk-bill. */
const tenDigits = p => String(p || '').replace(/[^0-9]/g, '').slice(-10);

/* Every Stripe customer that actually has a usable card, keyed by email.
   Fetched in one pass rather than a call per client — a studio with three
   hundred clients would otherwise take three hundred round trips. */
async function cardsByEmail(sk) {
  const out = {};
  if (!sk) return out;
  let starting_after = null;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ limit: '100' });
    if (starting_after) params.set('starting_after', starting_after);
    const r = await fetch('https://api.stripe.com/v1/customers?' + params.toString(), {
      headers: { Authorization: 'Bearer ' + sk },
    });
    const j = await r.json();
    if (!r.ok) break;

    for (const c of (j.data || [])) {
      /* Under their address, and under their number. A customer with
         neither is a row nobody can match to a client, and is skipped;
         a customer with both is reachable either way. */
      const keys = [];
      if (c.email) keys.push(lower(c.email));
      const p = tenDigits(c.phone);
      if (p.length === 10) keys.push('p:' + p);
      for (const key of keys) {
        // Keep the first customer we see for a key; a second one for the
        // same person is a duplicate and its card is the one nobody uses.
        if (out[key]) continue;
        out[key] = { customer: c.id, card: null };
      }
    }

    if (!j.has_more) break;
    const last = (j.data || [])[(j.data || []).length - 1];
    if (!last) break;
    starting_after = last.id;
  }

  /* A customer is not the same as a card. Somebody can have a customer
     record from a one-off payment and nothing saved on it, which is exactly
     the state that made this necessary. */
  /* Ten at a time rather than one after another. Serially, four hundred
     clients meant four hundred round trips to Stripe in a row, which is
     most of the "this takes a few seconds" — and two screens now wait on
     it. Stripe's own rate limit is comfortably above this. */
  /* One ask per CUSTOMER, not per key. Somebody listed under both their
     address and their number is one customer, and asking Stripe twice about
     the same card is the sort of thing that turns four hundred round trips
     into eight hundred. */
  const byCustomer = {};
  for (const key of Object.keys(out)) {
    (byCustomer[out[key].customer] = byCustomer[out[key].customer] || []).push(key);
  }
  const customers = Object.keys(byCustomer);
  const lookup = async (customer) => {
    let card = null;
    try {
      const r = await fetch(
        'https://api.stripe.com/v1/payment_methods?type=card&limit=1&customer=' + customer,
        { headers: { Authorization: 'Bearer ' + sk } });
      const j = await r.json();
      const pm = j && j.data && j.data[0];
      if (pm && pm.card) {
        card = {
          brand: pm.card.brand,
          last4: pm.card.last4,
          exp: pm.card.exp_month + '/' + String(pm.card.exp_year).slice(-2),
        };
      }
    } catch (_) {}
    if (card) for (const key of byCustomer[customer]) out[key].card = card;
  };
  for (let i = 0; i < customers.length; i += 10) {
    await Promise.all(customers.slice(i, i + 10).map(lookup));
  }

  return out;
}

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const pay = require('./_pay');
    const sk = await pay.getStripeSecret();
    const action = req.query.action || (req.body && req.body.action) || '';

    /* ── IS THERE A CARD FOR THIS PERSON ANYWHERE ──────────────────────
       By name, by email, by number — whatever is given. Read-only: nothing
       is created and nothing is charged. This exists so "she has no card"
       is a thing we have checked rather than a thing we assumed. */
    if (req.method === 'GET' && action === 'lookup') {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'Who?' });
      if (!sk) return res.json({ error: 'Payments are not configured.' });

      const digitsOf = s => String(s || '').replace(/[^0-9]/g, '');
      const found = [];
      const seen = new Set();

      const add = async (c, how) => {
        if (!c || !c.id || seen.has(c.id)) return;
        seen.add(c.id);
        let card = null, kinds = [];
        try {
          const r = await fetch(
            'https://api.stripe.com/v1/payment_methods?limit=20&customer=' + encodeURIComponent(c.id),
            { headers: { Authorization: 'Bearer ' + sk } });
          const j = await r.json();
          kinds = (j.data || []).map(p => p.type);
          const C = require('./_customer');
          const pm = C.bestPM(j.data || [], (c.invoice_settings || {}).default_payment_method || '');
          if (pm) card = Object.assign({ id: pm.id, type: pm.type }, C.describePM(pm));
        } catch (_) {}
        found.push({
          customer: c.id, found_by: how,
          name: c.name || '', email: c.email || '', phone: c.phone || '',
          created: c.created ? new Date(c.created * 1000).toISOString().slice(0, 10) : '',
          saved_methods: kinds, card,
        });
      };

      /* Stripe's search, which is the only way to ask by name or number.
         Quoted through JSON.stringify so a name with an apostrophe in it
         cannot break the query. */
      for (const [field, value] of [
        ['email', /@/.test(q) ? lower(q) : ''],
        ['name', /[a-z]/i.test(q) ? q : ''],
        ['phone', digitsOf(q).length >= 10 ? '+1' + digitsOf(q).slice(-10) : ''],
        ['phone', digitsOf(q).length >= 10 ? digitsOf(q).slice(-10) : ''],
      ]) {
        if (!value) continue;
        try {
          const r = await fetch('https://api.stripe.com/v1/customers/search?limit=10&query='
            + encodeURIComponent(field + ':' + JSON.stringify(String(value))),
            { headers: { Authorization: 'Bearer ' + sk } });
          const j = await r.json();
          for (const c of (j.data || [])) await add(c, 'stripe_' + field);
        } catch (_) { /* search not enabled, or nothing indexed */ }
      }

      /* And the plain list by email, which works without search being on. */
      if (/@/.test(q)) {
        try {
          const r = await fetch('https://api.stripe.com/v1/customers?limit=10&email=' + encodeURIComponent(lower(q)),
            { headers: { Authorization: 'Bearer ' + sk } });
          const j = await r.json();
          for (const c of (j.data || [])) await add(c, 'email_list');
        } catch (_) {}
      }

      return res.json({
        q,
        customers: found,
        chargeable: found.some(x => x.card),
      });
    }

    // ── send somebody the link ──
    if (req.method === 'POST' && action === 'ask') {
      const email = lower((req.body || {}).email);
      const phone = String((req.body || {}).phone || '');
      const name = String((req.body || {}).name || '').trim();
      /* Nothing leaves until somebody has read it. */
      const preview = (req.body || {}).preview === true;

      if ((!email || !/@/.test(email)) && tenDigits(phone).length !== 10) {
        return res.status(400).json({
          error: 'No email address and no phone number for that client, so there is nowhere to send it. '
            + 'Add one to their client record first.',
        });
      }

      /* The link is their appointment token, so it identifies them without
         anybody logging in. Their next appointment, or their last — either
         is theirs. Found by address where there is one, and otherwise by
         number, which is the whole point of this. */
      let appt = null;
      if (email && /@/.test(email)) {
        appt = await queryOne(
          `SELECT chat_token FROM team_appointments
            WHERE lower(client_email) = ? AND COALESCE(chat_token,'') <> ''
            ORDER BY date DESC LIMIT 1`, [email]);
      }
      if (!appt && tenDigits(phone).length === 10) {
        /* Matched in here rather than in SQL: the column holds every format
           anybody has ever typed, and only the last ten digits are reliably
           the same number. */
        const rows = await query(
          `SELECT chat_token, client_phone FROM team_appointments
            WHERE COALESCE(chat_token,'') <> '' AND COALESCE(client_phone,'') <> ''
            ORDER BY date DESC LIMIT 400`).catch(() => []);
        const hit = (rows || []).find(r => tenDigits(r.client_phone) === tenDigits(phone));
        if (hit) appt = { chat_token: hit.chat_token };
      }
      if (!appt || !appt.chat_token) {
        return res.status(400).json({ error: 'No appointment on file to build a link from.' });
      }

      const link = SITE + '/card.html?t=' + encodeURIComponent(appt.chat_token);
      const first = name.split(/\s+/)[0] || 'there';

      /* By text, when there is no address to send it to. Short, because a
         text that needs scrolling gets ignored, and it says plainly that
         nothing is being charged — this arrives unannounced on somebody's
         phone and "add your card" is otherwise exactly what a scam says. */
      if (!email || !/@/.test(email)) {
        const sms = 'ZOLA Nail Studio: hi ' + first + ' — you can save your card for next time so '
          + 'checking out is one tap. Nothing is charged now, and nothing is ever charged '
          + 'without your signature at the desk. ' + link;
        if (preview) {
          return res.json({ preview: true, channel: 'sms', to: phone, body: sms, link });
        }
        const out = await require('./_notify').sendSMS(phone, sms);
        /* Same shape as the email branch below — the button reads d.ok, so
           two different answers means one of them always reads as a
           failure after succeeding. */
        return res.json({ ok: !!(out && out.sent), channel: 'sms', why: (out && out.why) || '', link });
      }

      if (preview) {
        return res.json({
          preview: true, channel: 'email', to: email,
          subject: 'Save your card for next time ✦ ZOLA', link,
        });
      }

      const out = await require('./_notify').sendEmail(
        email,
        'Save your card for next time ✦ ZOLA',
        `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px 14px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #eee5d8">
    <div style="background:#0D0D0D;padding:24px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:6px;color:#F5EEE8">ZOLA</div>
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8B6A3E;margin-top:6px">Nail Studio · Porterville</div>
    </div>
    <div style="padding:26px 24px">
      <p style="font-size:15px;line-height:1.7;color:#3a3027;margin:0 0 16px">Hi ${first},</p>
      <p style="font-size:15px;line-height:1.7;color:#3a3027;margin:0 0 16px">
        Checking out can take one tap instead of digging your card out with wet nails.
        Add it once below and it is there for next time.
      </p>
      <p style="font-size:15px;line-height:1.7;color:#3a3027;margin:0 0 22px">
        <strong>Nothing is charged now.</strong> From then on it covers the deposit when you
        book, and the balance of your visit if we settle it after you have left — so you never
        have to remember it. We email you a receipt every single time, naming exactly what it
        was for. Anything you pay at the desk you still sign for, and you can ask us to take
        your card off at any time.
      </p>
      <a href="${link}" style="display:block;background:#0D0D0D;color:#B6A588;text-align:center;
        padding:16px 18px;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:2px;
        text-transform:uppercase">Save my card</a>
      <p style="font-size:13px;line-height:1.7;color:#8C7A5E;margin:18px 0 0">
        Takes about thirty seconds. No password, no account.
      </p>
    </div>
  </div>
</div>`,
        { kind: 'card-on-file-ask' });

      return res.json({ ok: !!(out && out.sent), why: (out && out.why) || '', link });
    }

    // ── who has one ──
    const cards = await cardsByEmail(sk);

    /* An address OR a number. Selecting on an address alone kept the
       phone-only clients off the one screen built to find people with no
       card — which is most of the people with no card. */
    const clients = await query(
      `SELECT id, name, email, phone, visits, last_visit FROM clients
        WHERE COALESCE(email,'') <> '' OR COALESCE(phone,'') <> ''
        ORDER BY last_visit DESC, name LIMIT 400`)
      .catch(() => []);

    // Members hold their customer id on the membership, so they are known
    // even when the email on the two records differs.
    const memberCards = {};
    try {
      const main = require('./_db');
      const rows = await main.query(
        "SELECT full_name, email, stripe_customer_id FROM members WHERE COALESCE(stripe_customer_id,'') <> ''");
      for (const r of rows) if (r.email) memberCards[lower(r.email)] = true;
    } catch (_) {}

    const rows = clients.map(c => {
      const key = lower(c.email);
      /* Their card, under their address or under their number. The index
         holds both now, so a client whose card was saved while she had no
         email on file still reads as having one — otherwise this screen
         offers to ask her for a card she has already given us. */
      const pkey = 'p:' + tenDigits(c.phone);
      const hit = (cards[key] && cards[key].card) ? cards[key]
        : ((cards[pkey] && cards[pkey].card) ? cards[pkey] : cards[key]);
      return {
        id: Number(c.id),
        name: c.name || '',
        email: c.email || '',
        phone: c.phone || '',
        visits: Number(c.visits) || 0,
        last_visit: c.last_visit || '',
        has_card: !!(hit && hit.card),
        card: hit && hit.card ? (hit.card.brand + ' ····' + hit.card.last4) : '',
        is_member: !!memberCards[key],
      };
    });

    const withCard = rows.filter(r => r.has_card);
    return res.json({
      clients: rows,
      with_card: withCard.length,
      without_card: rows.length - withCard.length,
      stripe_ok: !!sk,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

/* The charge screen needs the same answer to "who has a card we can take
   money from" as this one does, and asking Stripe twice in two different
   ways is how two screens come to disagree about somebody's card. */
module.exports.cardsByEmail = cardsByEmail;
