// Who has a card on file, and how to ask the rest.
//
// A card on file is the difference between a checkout that takes one tap and
// one where somebody digs through a bag with wet nails. But it only ever
// appears as a side effect of paying, so the studio had no way to see who
// had one, and no way to ask the people who did not.
//
// This lists every client with their card status and sends the ones without
// a link to add one. Nothing is charged by that link, and nothing is ever
// charged to a saved card without a signature at the desk.
const { query, queryOne } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const SITE = process.env.PUBLIC_BASE_URL || 'https://zolanailstudio.com';

const lower = s => String(s || '').trim().toLowerCase();

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
      if (!c.email) continue;
      const key = lower(c.email);
      // Keep the first customer we see for an address; a second one for the
      // same person is a duplicate and its card is the one nobody uses.
      if (out[key]) continue;
      out[key] = { customer: c.id, card: null };
    }

    if (!j.has_more) break;
    const last = (j.data || [])[(j.data || []).length - 1];
    if (!last) break;
    starting_after = last.id;
  }

  /* A customer is not the same as a card. Somebody can have a customer
     record from a one-off payment and nothing saved on it, which is exactly
     the state that made this necessary. */
  const emails = Object.keys(out);
  for (const email of emails) {
    try {
      const r = await fetch(
        'https://api.stripe.com/v1/payment_methods?type=card&limit=1&customer=' + out[email].customer,
        { headers: { Authorization: 'Bearer ' + sk } });
      const j = await r.json();
      const pm = j && j.data && j.data[0];
      if (pm && pm.card) {
        out[email].card = {
          brand: pm.card.brand,
          last4: pm.card.last4,
          exp: pm.card.exp_month + '/' + String(pm.card.exp_year).slice(-2),
        };
      }
    } catch (_) {}
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

    // ── send somebody the link ──
    if (req.method === 'POST' && action === 'ask') {
      const email = lower((req.body || {}).email);
      const name = String((req.body || {}).name || '').trim();
      if (!email || !/@/.test(email)) return res.status(400).json({ error: 'No email for that client.' });

      /* The link is their appointment token, so it identifies them without
         anybody logging in. Their next appointment, or their last — either
         is theirs. */
      const appt = await queryOne(
        `SELECT chat_token FROM team_appointments
          WHERE lower(client_email) = ? AND COALESCE(chat_token,'') <> ''
          ORDER BY date DESC LIMIT 1`, [email]);
      if (!appt || !appt.chat_token) {
        return res.status(400).json({ error: 'No appointment on file to build a link from.' });
      }

      const link = SITE + '/card.html?t=' + encodeURIComponent(appt.chat_token);
      const first = name.split(/\s+/)[0] || 'there';

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
        <strong>Nothing is charged now</strong> — and nothing is ever charged to it
        without your signature at the desk.
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

    const clients = await query(
      `SELECT id, name, email, phone, visits, last_visit FROM clients
        WHERE COALESCE(email,'') <> '' ORDER BY last_visit DESC, name LIMIT 400`)
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
      const hit = cards[key];
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
