// Keeping Stripe's payment list honest.
//
// "Incomplete" in Stripe means a payment was started and never finished —
// somebody reached the pay step and left, or the page set one up and then
// set up another when they changed their tip. No money moves on those, but
// a list full of them makes it impossible to see at a glance what really
// came in, and a real problem hides among them.
//
// Three things here:
//   report()  — every payment in a window, grouped by what state it is in
//   sweep()   — cancels the site's own abandoned ones once they are old
//               enough that nobody can still be paying on them
//   orphans() — money that arrived with no booking attached, so it is never
//               silently lost
//   wallets() — switches on the double-tap wallets in Stripe's settings
const { query, queryOne, execute } = require('./_team-db');

const HOUR = 3600000;

async function secret() {
  return require('./_pay').getStripeSecret();
}

async function stripeGet(sk, path) {
  const r = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + sk } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Stripe ' + r.status));
  return j;
}
async function stripePost(sk, path, params) {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params || {}).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Stripe ' + r.status));
  return j;
}

async function listIntents(sk, days) {
  const since = Math.floor((Date.now() - days * 24 * HOUR) / 1000);
  const out = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const p = new URLSearchParams({ limit: '100', 'created[gte]': String(since) });
    if (after) p.set('starting_after', after);
    const j = await stripeGet(sk, 'payment_intents?' + p);
    out.push(...(j.data || []));
    if (!j.has_more || !(j.data || []).length) break;
    after = j.data[j.data.length - 1].id;
  }
  return out;
}

// Started by this website — not a membership invoice, which Stripe owns and
// finishes or cancels by itself.
const ours = pi => !pi.invoice && /^ZOLA\b/.test(String(pi.description || ''));
const OPEN = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);

function shape(pi) {
  const md = pi.metadata || {};
  const err = pi.last_payment_error || null;
  return {
    id: pi.id, created: pi.created * 1000, status: pi.status, amount: pi.amount,
    received: pi.amount_received || 0, description: pi.description || '',
    client: md.client || '', token: md.appt_token || '', kind: md.kind || '',
    last_error: err ? [err.code, err.decline_code, err.message].filter(Boolean).join(' · ').slice(0, 200) : '',
    ours: ours(pi),
  };
}

async function report(days) {
  const sk = await secret();
  if (!sk) return { error: 'No Stripe key saved' };
  const all = (await listIntents(sk, days)).map(shape);
  const by = s => all.filter(x => x.status === s);
  return {
    days,
    succeeded: by('succeeded').length,
    succeeded_cents: by('succeeded').reduce((s, x) => s + x.received, 0),
    incomplete: all.filter(x => OPEN.has(x.status)),
    canceled: by('canceled').length,
    processing: by('processing'),
    with_errors: all.filter(x => x.last_error && x.status !== 'succeeded'),
  };
}

/* Cancel the website's own abandoned payments. Old enough is an hour for one
   that never had a card put in, and a day for one waiting on a bank's
   security check — anybody still paying on it has long since been given a
   fresh one. Never touches a payment that has moved money or is moving it. */
async function sweep({ dryRun = true, minAgeMin = 60, days = 30 } = {}) {
  const sk = await secret();
  if (!sk) return { error: 'No Stripe key saved' };
  const now = Date.now();
  const all = await listIntents(sk, days);
  const due = all.filter(pi => {
    if (!ours(pi) || !OPEN.has(pi.status)) return false;
    const ageMin = (now - pi.created * 1000) / 60000;
    const minAge = pi.status === 'requires_action' ? Math.max(minAgeMin, 24 * 60) : minAgeMin;
    return ageMin >= minAge;
  });
  const cancelled = [], failed = [];
  if (!dryRun) {
    for (const pi of due) {
      try {
        await stripePost(sk, 'payment_intents/' + pi.id + '/cancel', { cancellation_reason: 'abandoned' });
        cancelled.push(pi.id);
      } catch (e) { failed.push({ id: pi.id, why: String(e.message || e) }); }
    }
  }
  return { dry_run: dryRun, found: due.map(shape), cancelled: cancelled.length, failed };
}

/* Cancel particular payments by id, for this website's own only. */
async function cancelIds(ids) {
  const sk = await secret();
  const done = [], skipped = [];
  for (const id of (ids || []).slice(0, 50)) {
    try {
      const pi = await stripeGet(sk, 'payment_intents/' + encodeURIComponent(id));
      if (!ours(pi) || !OPEN.has(pi.status)) { skipped.push({ id, status: pi.status }); continue; }
      await stripePost(sk, 'payment_intents/' + pi.id + '/cancel', { cancellation_reason: 'abandoned' });
      done.push(id);
    } catch (e) { skipped.push({ id, why: String(e.message || e) }); }
  }
  return { cancelled: done, skipped };
}

/* Money in with nowhere to go: a finished payment from the booking page or
   a deposit link that no appointment knows about. Should never happen; if it
   does, she hears about it the same day instead of finding it in a month. */
/* Only payments made after bookings began storing their payment id can be
   checked this way; older ones have no id to match and would all look lost. */
// Bookings began storing their payment id at 17:05 UTC on 17 September 2026.
const LINKED_SINCE = Number(process.env.ORPHAN_CHECK_SINCE || 0) || Date.parse('2026-09-17T17:15:00Z');

async function orphans(hours = 48) {
  const sk = await secret();
  if (!sk) return [];
  const all = (await listIntents(sk, Math.ceil(hours / 24) + 1))
    .filter(pi => ours(pi) && pi.status === 'succeeded' && (Date.now() - pi.created * 1000) <= hours * HOUR
      && (Date.now() - pi.created * 1000) >= 20 * 60000 && pi.created * 1000 >= LINKED_SINCE);
  const out = [];
  for (const pi of all) {
    const md = pi.metadata || {};
    // Appointment money only: deposits, bookings paid in full, and balances.
    // Press-on orders and classes are not appointments and record themselves.
    if (!/^ZOLA (deposit|balance|—)/.test(pi.description || '')) continue;
    let known = false;
    try {
      if (md.appt_token) {
        const r = await queryOne('SELECT id FROM team_appointments WHERE chat_token = ?', [md.appt_token]);
        known = !!r;
      }
      if (!known && md.appt_group) known = true; // shares are recorded against real rows
      if (!known) {
        const r = await queryOne('SELECT id FROM team_appointments WHERE payment_intent_id = ?', [pi.id]).catch(() => null);
        known = !!r;
      }
      if (!known) {
        const main = require('./_db');
        const r = await main.queryOne('SELECT id FROM appointments WHERE payment_intent_id = ? OR stripe_pi_id = ?', [pi.id, pi.id]).catch(() => null);
        known = !!r;
      }
    } catch (_) {}
    if (!known) out.push(shape(pi));
  }
  return out;
}

/* Apple Pay, Google Pay and Link switched on in Stripe's own payment
   settings, so a phone offers the double tap wherever it can. */
async function wallets() {
  const sk = await secret();
  const cfgs = await stripeGet(sk, 'payment_method_configurations?limit=10');
  const def = (cfgs.data || []).find(c => c.is_default) || (cfgs.data || [])[0];
  if (!def) return { error: 'No payment settings found in Stripe' };
  const params = {};
  for (const k of ['card', 'apple_pay', 'google_pay', 'link']) {
    const cur = def[k];
    if (cur && cur.display_preference && cur.display_preference.value !== 'on') params[k + '[display_preference][preference]'] = 'on';
  }
  if (!Object.keys(params).length) return { ok: true, changed: [] };
  const updated = await stripePost(sk, 'payment_method_configurations/' + def.id, params);
  return {
    ok: true,
    changed: Object.keys(params).map(k => k.split('[')[0]),
    now: ['card', 'apple_pay', 'google_pay', 'link'].reduce((o, k) => {
      o[k] = updated[k] && updated[k].display_preference ? updated[k].display_preference.value : null; return o;
    }, {}),
  };
}

/* ── THE BOOK AGAINST THE MONEY ───────────────────────────────────────
   Every upcoming appointment that says a deposit was paid, checked against
   what Stripe actually took for it. A record that credits MORE than was
   taken is the dangerous direction: the client is undercharged at the desk
   and nobody finds out until the month does not add up. It happened once,
   and the only reason it was caught is that Zahra read her own Stripe
   account.

   Matched on the appointment token stamped on each payment — the same
   thing the recording code uses. */
async function depositAudit(days = 90) {
  const sk = await secret();
  if (!sk) return { checked: 0, over: [], why: 'no stripe key' };

  const today = new Date(Date.now() - 7 * HOUR).toISOString().slice(0, 10);
  let rows = [];
  try {
    rows = await query(
      `SELECT id, client_name, date, chat_token, COALESCE(deposit_cents,0) AS deposit_cents
         FROM team_appointments
        WHERE date >= ? AND COALESCE(deposit_paid,0) = 1 AND COALESCE(deposit_cents,0) > 0
          AND LOWER(COALESCE(status,'scheduled')) <> 'cancelled'
          AND COALESCE(checked_out_ts,0) = 0`, [today]);
  } catch (_) { return { checked: 0, over: [] }; }
  if (!rows.length) return { checked: 0, over: [] };

  /* What Stripe took, per appointment. A payment that names one appointment
     counts in full; one split across several carries each share in its own
     metadata, and those are counted share by share. */
  const intents = (await listIntents(sk, days)).filter(pi => pi.status === 'succeeded');
  const byToken = new Map();
  const add = (t, c) => { if (t && c > 0) byToken.set(t, (byToken.get(t) || 0) + c); };

  for (const pi of intents) {
    const md = pi.metadata || {};
    const amount = Number(pi.amount_received || pi.amount) || 0;
    if (!amount) continue;

    const groupParts = String(md.appt_group || '').split(',').filter(Boolean);
    const restParts = String(md.rest_shares || '').split(',').filter(Boolean);

    if (groupParts.length) {
      for (const p of groupParts) {
        const bits = p.split(':');
        add(bits[0].trim(), Math.round(Number(bits[1]) || 0));
      }
    } else if (restParts.length) {
      for (const p of restParts) {
        const bits = p.split(':');
        if (bits.length >= 3) add(bits[0].trim(), Math.round((Number(bits[2]) || 0) - (Number(bits[1]) || 0)));
      }
    } else if (md.appt_token) {
      add(String(md.appt_token).trim(), amount);
    }
  }

  const over = [];
  for (const r of rows) {
    const charged = Math.round(byToken.get(r.chat_token) || 0);
    /* Nothing found means the payment is older than the window being read,
       not that it never happened — only a real gap is worth a message. */
    if (!charged) continue;
    const recorded = Math.round(Number(r.deposit_cents) || 0);
    if (recorded - charged >= 100) {
      over.push({ id: r.id, client: r.client_name, date: r.date, recorded, charged });
    }
  }
  return { checked: rows.length, over };
}

module.exports = { report, sweep, cancelIds, orphans, wallets, depositAudit };
