// One Stripe customer per person, found by anything we actually know.
//
// Every card in this studio arrived as a side effect of a payment, and every
// payment looked the payer up by email address. So a client with no email on
// file could never have a card on file — not because she would not give one,
// but because there was nowhere to put it. Donna Shimer has six visits, a
// phone number and no address: the till could not charge her at all, and the
// "card declined" she was told was not a decline. There was no card.
//
// This is the one place that answers "which Stripe customer is this person",
// from an email, a phone number, or both — and then writes the answer onto
// their client row, so the next payment does not have to go looking and one
// person can never end up with two customers holding one card each.
//
// Deliberately strict about identity. A customer id is the key to somebody's
// card, so a phone number shared by two client records answers nothing: the
// rule here is the same as everywhere else in this codebase — exactly one
// match, or no answer.
const { query, execute } = require('./_team-db');

const lower = s => String(s || '').trim().toLowerCase();
const digits = s => String(s || '').replace(/[^0-9]/g, '');
const ten = s => digits(s).slice(-10);
const looksEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());

/* US numbers, in the one format Stripe can be searched on. Everything in
   this book is a Porterville number; anything that is not ten digits is left
   exactly as it was typed rather than guessed at. */
function e164(phone) {
  const d = digits(phone);
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return '';
}

/* The column that makes this work at all. Added the way every other column
   in this codebase is, once per cold start; a failure is the column already
   being there. */
let _ready = false;
async function ensureColumn() {
  if (_ready) return;
  try { await execute("ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT DEFAULT ''"); } catch (_) {}
  _ready = true;
}


/* Payment methods that can be charged with nobody standing there, best
   first. 'link' is here because Stripe pre-selects Link for anybody who has
   used it before, and a Link account saved off_session charges exactly like
   a card — asking only for type=card made every one of those invisible and
   the till told the client she had no card on file. */
const REUSABLE = ['card', 'link'];

/* How a saved method reads at the desk. A card has a brand and last four;
   a Link account has neither, and saying so plainly is better than printing
   "card ····" with nothing after it. */
function describePM(pm) {
  if (!pm) return { brand: 'card', last4: '', exp: '' };
  if (pm.card) {
    return {
      brand: pm.card.brand || 'card',
      last4: pm.card.last4 || '',
      exp: pm.card.exp_month + '/' + String(pm.card.exp_year).slice(-2),
    };
  }
  if (pm.type === 'link') {
    return {
      brand: 'Link',
      last4: '',
      exp: '',
      label: 'Link' + (pm.link && pm.link.email ? ' (' + pm.link.email + ')' : ''),
    };
  }
  return { brand: pm.type || 'card', last4: '', exp: '' };
}

/* The best of what is saved: their chosen default if it is chargeable, then
   a real card, then anything else that can be charged off-session. */
function bestPM(pms, defaultId) {
  const usable = (pms || []).filter(p => REUSABLE.indexOf(String(p.type)) >= 0);
  if (!usable.length) return null;
  const chosen = defaultId && usable.find(p => p.id === defaultId);
  if (chosen) return chosen;
  return usable.find(p => p.type === 'card') || usable[0];
}

async function api(sk, path, params) {
  const opts = { headers: { Authorization: 'Bearer ' + sk } };
  if (params) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(params).toString();
  }
  const r = await fetch('https://api.stripe.com/v1/' + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Stripe ' + r.status));
  return j;
}

/* ── WHAT WE HAVE ALREADY WRITTEN DOWN ──────────────────────────────────
   Checked before Stripe, because it costs nothing and because it is the only
   thing that knows a phone-only client's customer. */
async function remembered({ email, phone }) {
  await ensureColumn();
  const e = lower(email), p = ten(phone);

  if (e) {
    try {
      const rows = await query(
        "SELECT stripe_customer_id FROM clients "
        + "WHERE lower(COALESCE(email,'')) = ? AND COALESCE(stripe_customer_id,'') <> ''", [e]);
      const ids = [...new Set((rows || []).map(r => r.stripe_customer_id).filter(Boolean))];
      if (ids.length === 1) return { id: ids[0], how: 'remembered_email' };
    } catch (_) {}
  }
  if (p.length === 10) {
    try {
      /* Matched in here rather than in SQL: the column holds every format
         anybody has ever typed, and only the last ten digits are reliably
         the same number. */
      const rows = await query(
        "SELECT phone, stripe_customer_id FROM clients "
        + "WHERE COALESCE(stripe_customer_id,'') <> ''");
      const ids = [...new Set((rows || [])
        .filter(r => ten(r.phone) === p)
        .map(r => r.stripe_customer_id))];
      if (ids.length === 1) return { id: ids[0], how: 'remembered_phone' };
    } catch (_) {}
  }
  return null;
}

/* Written back so it is never searched for twice — and so Studio Manager's
   list can show a phone-only client's card at all. Only ever onto a row that
   is unambiguously this person, and never over an id already there. */
async function remember({ email, phone, customerId }) {
  if (!customerId) return;
  await ensureColumn();
  const e = lower(email), p = ten(phone);
  try {
    if (e) {
      await execute(
        "UPDATE clients SET stripe_customer_id = ? "
        + "WHERE lower(COALESCE(email,'')) = ? AND COALESCE(stripe_customer_id,'') = ''",
        [customerId, e]);
    }
    if (p.length === 10) {
      const rows = await query(
        "SELECT id, phone FROM clients WHERE COALESCE(stripe_customer_id,'') = ''");
      const hits = (rows || []).filter(r => ten(r.phone) === p);
      // Exactly one, or it is not this person.
      if (hits.length === 1) {
        await execute('UPDATE clients SET stripe_customer_id = ? WHERE id = ?',
          [customerId, Number(hits[0].id)]);
      }
    }
  } catch (_) { /* a payment must never fail because a note could not be kept */ }
}

/* ── ASKING STRIPE ──────────────────────────────────────────────────── */

async function byEmail(sk, email) {
  if (!looksEmail(email)) return [];
  try {
    const j = await api(sk, 'customers?limit=10&email=' + encodeURIComponent(lower(email)));
    return (j.data || []).map(c => c.id);
  } catch (_) { return []; }
}

/* By phone, which needs Stripe's search rather than its list.
 *
 * Two caveats, both real: search matches the phone string exactly, so a
 * customer stored as "559-288-9921" is not found by "+15592889921" — which
 * is why both spellings are tried, and why everything created here is
 * created in one format. And search is eventually consistent, so a customer
 * made a moment ago may not be findable yet. Neither matters once the id is
 * remembered on the client row, which is the point of doing this once. */
async function byPhone(sk, phone) {
  const forms = [...new Set([e164(phone), digits(phone), String(phone || '').trim()])]
    .filter(f => f && digits(f).length >= 10);
  for (const form of forms) {
    try {
      const q = 'phone:' + JSON.stringify(form);
      const j = await api(sk, 'customers/search?limit=10&query=' + encodeURIComponent(q));
      const ids = (j.data || []).map(c => c.id);
      if (ids.length) return ids;
    } catch (_) { /* search not enabled, or nothing indexed yet */ }
  }
  return [];
}

/* ── THE ANSWER ─────────────────────────────────────────────────────────
 *
 * resolve() never throws and never half-answers: either there is a customer
 * id for this person or there is not, and the caller is told how it was
 * decided so Studio Manager can show her rather than ask her to trust it.
 *
 * create defaults to true because the whole purpose is that somebody who
 * pays gets their card kept, every time. Pass create:false to look without
 * making anything — which is what every read-only screen wants.
 */
async function resolve({ sk, email, phone, name, create = true, prefer }) {
  if (!sk) return { id: '', how: 'no_stripe' };

  /* An id we were handed — a member's, off their membership. It outranks
     everything, because she chose it. */
  if (prefer) {
    await remember({ email, phone, customerId: prefer });
    return { id: prefer, how: 'given', created: false };
  }

  const known = await remembered({ email, phone });
  if (known) return { id: known.id, how: known.how, created: false };

  const found = await byEmail(sk, email);
  if (found.length) {
    await remember({ email, phone, customerId: found[0] });
    return { id: found[0], how: 'stripe_email', created: false };
  }

  if (ten(phone).length === 10) {
    const byP = await byPhone(sk, phone);
    /* Exactly one. Two customers on one number are a household, and the
       wrong card charged is worse than no card found. */
    if (byP.length === 1) {
      await remember({ email, phone, customerId: byP[0] });
      return { id: byP[0], how: 'stripe_phone', created: false };
    }
  }

  if (!create) return { id: '', how: 'not_found', created: false };

  /* Nothing to identify them by at all. A customer with neither an address
     nor a number is a row nobody can ever find again. */
  const e = looksEmail(email) ? lower(email) : '';
  const p = e164(phone);
  if (!e && !p) return { id: '', how: 'nothing_to_go_on', created: false };

  try {
    const made = await api(sk, 'customers', {
      ...(e ? { email: e } : {}),
      // One format, always, so search can find it next time.
      ...(p ? { phone: p } : {}),
      ...(name ? { name: String(name).slice(0, 120) } : {}),
    });
    if (made && made.id) {
      await remember({ email, phone, customerId: made.id });
      return { id: made.id, how: 'created', created: true };
    }
  } catch (_) {}
  return { id: '', how: 'create_failed', created: false };
}

/* A card we can charge on this person, whoever they are and however we came
   to know them. The one function the till, the deposit charge and Studio
   Manager should all be asking. */
async function cardFor({ sk, email, phone, name, prefer }) {
  const who = await resolve({ sk, email, phone, name, prefer, create: false });
  if (!who.id) {
    return { ok: false, why: who.how === 'no_stripe' ? 'no_stripe' : 'no_customer' };
  }
  try {
    /* Everything saved, not only type=card. See REUSABLE above: a deposit
       paid through Link saves a 'link' method, which is chargeable and was
       being reported as no card at all. */
    const j = await api(sk, 'payment_methods?limit=20&customer=' + encodeURIComponent(who.id));
    const pms = j.data || [];
    let def = '';
    try {
      const c = await api(sk, 'customers/' + encodeURIComponent(who.id));
      def = (c.invoice_settings && c.invoice_settings.default_payment_method) || '';
    } catch (_) {}
    const pm = bestPM(pms, def);
    if (!pm) return { ok: false, why: 'no_card', customer: who.id };
    return {
      ok: true, customer: who.id, payment_method: pm.id, how: who.how,
      kind: pm.type, card: describePM(pm),
    };
  } catch (_) {
    return { ok: false, why: 'stripe_unreachable', customer: who.id };
  }
}

module.exports = {
  resolve, cardFor, remembered, remember, ensureColumn,
  e164, ten, digits, lower, looksEmail,
  REUSABLE, bestPM, describePM,
};
