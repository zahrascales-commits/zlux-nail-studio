// Money actually collected.
//
// Every other figure on this site is built from what the database believes
// was arranged: an appointment with a price on it, a membership with a tier.
// Arrangements are not takings. Somebody who booked and never paid, a
// deposit that was never taken, a subscription that failed — all of them
// look like income in a table and are worth nothing in a bank.
//
// So this counts one thing: money that moved. Card payments come from
// Stripe, which is the only thing that actually knows, and are counted net
// of refunds — the $1,210 refunded this morning has to come back out of the
// total or the month is overstated by $1,210. Cash is counted from what was
// rung up at the front desk.
//
// The rule for a booking, in her words: a deposit counts when it is paid,
// and only the deposit. The remainder counts when the remainder is paid.
// Nothing counts before that.
const { query } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const pad = n => String(n).padStart(2, '0');

// The studio's calendar, so a month turns over in Porterville rather than
// wherever the server happens to be.
function studioNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0); }
function yearStart(d) { return new Date(d.getFullYear(), 0, 1, 0, 0, 0); }

const money = c => Math.round(Number(c) || 0);

/* Every card payment Stripe took in a window, net of anything given back.
   Paged, because a busy month is more than one page and a silently
   truncated list reads as a quiet month. */
async function stripeCollected(sk, sinceSec, LIST) {
  let starting_after = null;
  let gross = 0, refunded = 0, count = 0;
  const byMonth = {};
  const bySource = { memberships: 0, appointments: 0, other: 0 };

  for (let page = 0; page < 40; page++) {
    const params = new URLSearchParams({ limit: '100', 'created[gte]': String(sinceSec) });
    if (starting_after) params.set('starting_after', starting_after);
    const r = await fetch('https://api.stripe.com/v1/charges?' + params.toString(), {
      headers: { Authorization: 'Bearer ' + sk },
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe would not answer');

    for (const ch of (j.data || [])) {
      if (ch.status !== 'succeeded') continue;
      const net = money(ch.amount) - money(ch.amount_refunded);
      if (net <= 0 && !ch.amount_refunded) continue;

      gross += money(ch.amount);
      refunded += money(ch.amount_refunded);
      count++;

      const when = new Date(Number(ch.created) * 1000);
      const key = when.getFullYear() + '-' + pad(when.getMonth() + 1);
      byMonth[key] = (byMonth[key] || 0) + net;

      /* Membership money versus appointment money. An invoice id would be
         the tidy signal, but Stripe leaves it unset on these charges — the
         first payment of a subscription is billed directly. The description
         is what actually distinguishes them here. */
      const desc = String(ch.description || '').toLowerCase();
      const isMembership = !!ch.invoice || /subscription|membership/.test(desc);
      if (LIST) LIST.push({ id: ch.id, amount: ch.amount, refunded: ch.amount_refunded, invoice: ch.invoice || null, desc: ch.description || "", created: ch.created });
      if (isMembership) bySource.memberships += net;
      else if (/deposit|checkout|balance|tip|appointment/.test(desc)) bySource.appointments += net;
      else bySource.other += net;
    }

    if (!j.has_more) break;
    const last = (j.data || [])[(j.data || []).length - 1];
    if (!last) break;
    starting_after = last.id;
  }

  return { gross, refunded, net: gross - refunded, count, byMonth, bySource };
}

/* Cash rung up at the front desk. Never in Stripe, so it would otherwise be
   invisible — and it is real money she is holding. */
async function cashCollected(sinceMs) {
  try {
    const rows = await query(
      "SELECT amount_cents, ts FROM kiosk_log WHERE type='checkout' AND method='cash' AND ts >= ?",
      [sinceMs]);
    const byMonth = {};
    let total = 0;
    for (const r of rows) {
      const c = money(r.amount_cents);
      if (c <= 0) continue;
      total += c;
      const when = new Date(Number(r.ts));
      const key = when.getFullYear() + '-' + pad(when.getMonth() + 1);
      byMonth[key] = (byMonth[key] || 0) + c;
    }
    return { total, byMonth, count: rows.length };
  } catch (_) { return { total: 0, byMonth: {}, count: 0 }; }
}

/* Booked but not paid for. Deliberately reported on its own and never added
   to anything — it is the number that makes a total untrustworthy. */
async function outstanding() {
  const today = studioNow();
  const ds = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
  let owed = 0, n = 0;
  try {
    const main = require('./_db');
    const rows = await main.query(
      `SELECT total_cents, deposit_cents, deposit_paid, paid_cents
         FROM appointments
        WHERE status <> 'CANCELLED' AND appointment_date >= ?`, [ds]);
    for (const r of rows) {
      const total = money(r.total_cents);
      const taken = (Number(r.deposit_paid) ? money(r.deposit_cents) : 0) + money(r.paid_cents);
      const left = Math.max(0, total - taken);
      if (left > 0) { owed += left; n++; }
    }
  } catch (_) {}
  return { cents: owed, appointments: n };
}

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = studioNow();
    const mStart = monthStart(now);
    const yStart = yearStart(now);

    const srows = await query("SELECT key, value FROM site_settings WHERE key = 'stripe_secret'");
    const sk = (srows[0] && srows[0].value) || process.env.STRIPE_SECRET_KEY || '';

    const listing = String(req.query.detail || "") === "1" ? [] : null;
    let card = { gross: 0, refunded: 0, net: 0, count: 0, byMonth: {}, bySource: {} };
    let cardError = '';
    if (sk) {
      try { card = await stripeCollected(sk, Math.floor(yStart.getTime() / 1000), listing); }
      catch (e) { cardError = String(e.message || e); }
    } else {
      cardError = 'no Stripe key saved';
    }

    const cash = await cashCollected(yStart.getTime());
    const thisMonthKey = now.getFullYear() + '-' + pad(now.getMonth() + 1);

    const monthCard = money(card.byMonth[thisMonthKey]);
    const monthCash = money(cash.byMonth[thisMonthKey]);
    const yearCard = card.net;
    const yearCash = cash.total;

    // Every month so far this year, newest first, so she can see the shape
    // rather than one number with no context.
    const months = [];
    for (let i = 0; i <= now.getMonth(); i++) {
      const key = now.getFullYear() + '-' + pad(i + 1);
      const c = money(card.byMonth[key]) + money(cash.byMonth[key]);
      months.push({
        month: key,
        label: new Date(now.getFullYear(), i, 1).toLocaleString('en-US', { month: 'long' }),
        cents: c,
      });
    }
    months.reverse();

    const owed = await outstanding();

    return res.json({
      ok: true,
      as_of: now.toISOString(),
      month: {
        label: now.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        cents: monthCard + monthCash,
        card_cents: monthCard,
        cash_cents: monthCash,
      },
      year: {
        label: String(now.getFullYear()),
        cents: yearCard + yearCash,
        card_cents: yearCard,
        cash_cents: yearCash,
      },
      months,
      // Where the card money came from, across the year.
      from: card.bySource,
      refunded_cents: card.refunded,
      // Never added in. Shown so the gap between booked and banked is visible.
      outstanding: owed,
      card_error: cardError,
      charges: listing || undefined,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
