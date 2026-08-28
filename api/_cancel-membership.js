// Cancelling a membership, from the member's own account.
//
// The Terms already say "cancel from your member account on this Site". They
// have said it since the day they went up, and until now it was not true —
// the portal told people to message the studio instead. A term you do not
// honour is worse than one you never wrote.
//
// Two rules, both from the Terms, both enforced here rather than trusted to
// the page:
//
//   * Three-month minimum. Somebody inside it does not get refused — the
//     cancellation is scheduled for the end of the term they committed to.
//     Refusing outright makes them come back and ask a person, which is the
//     same outcome with more resentment.
//   * It takes effect at the end of the period already paid for. Nobody
//     loses time they have bought, and there are no refunds to work out.
const { queryOne, execute } = require('./_db');

const TIER_LABEL = { SIGNATURE: 'Signature', LUXE: 'Luxe', BLACK_CARD: 'Black Card' };
const MINIMUM_MONTHS = 3;

async function authMember(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne(
    "SELECT * FROM sessions WHERE token = ? AND role = 'CLIENT' AND expires_at > CURRENT_TIMESTAMP",
    [token]);
}

async function stripeClient() {
  const sk = await require('./_pay').getStripeSecret();
  return sk ? require('stripe')(sk) : null;
}

const iso = d => (d instanceof Date && !isNaN(d)) ? d.toISOString().slice(0, 10) : '';
const pretty = s => {
  const d = new Date(String(s || '').slice(0, 10) + 'T12:00:00');
  return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};

// The day their commitment is served. Counted from the day they joined, in
// whole months, so a member who joined on the 31st is not held an extra day
// because a month is short.
function minimumEndsOn(startedAt) {
  const d = new Date(String(startedAt || '').slice(0, 10) + 'T12:00:00');
  if (isNaN(d)) return null;
  const out = new Date(d);
  out.setMonth(out.getMonth() + MINIMUM_MONTHS);
  return out;
}

async function ensureColumns() {
  for (const sql of [
    "ALTER TABLE members ADD COLUMN cancelled_at TEXT DEFAULT ''",
    "ALTER TABLE members ADD COLUMN cancel_effective TEXT DEFAULT ''",
    "ALTER TABLE members ADD COLUMN cancel_reason TEXT DEFAULT ''",
    "ALTER TABLE members ADD COLUMN status TEXT DEFAULT 'active'",
  ]) { try { await execute(sql); } catch (_) {} }
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureColumns();
    const session = await authMember(req);
    if (!session) return res.status(401).json({ error: 'Please sign in again.' });
    const member = await queryOne('SELECT * FROM members WHERE member_id = ?', [session.user_id]);
    if (!member) return res.status(404).json({ error: 'Membership not found.' });

    const action = req.query.action || (req.body && req.body.action) || '';
    const started = String(member.membership_started_at || '').slice(0, 10);
    const minEnd = minimumEndsOn(started);
    const today = new Date();
    const servedMinimum = !minEnd || today >= minEnd;

    // What Stripe currently believes, which is the only thing that decides
    // whether money moves next month.
    let sub = null, periodEnd = null, alreadyEnding = false;
    if (member.stripe_subscription_id) {
      try {
        const stripe = await stripeClient();
        if (stripe) {
          sub = await stripe.subscriptions.retrieve(member.stripe_subscription_id);
          periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
          alreadyEnding = !!(sub.cancel_at_period_end || sub.cancel_at);
          if (sub.cancel_at) periodEnd = new Date(sub.cancel_at * 1000);
        }
      } catch (_) {}
    }

    // ── What would happen if they did it ──
    if (req.method === 'GET') {
      // The date it would actually stop: the end of a period they have paid
      // for, and never before the minimum term is served.
      let effective = periodEnd;
      if (minEnd && effective && effective < minEnd) {
        effective = new Date(periodEnd);
        while (effective < minEnd) effective.setMonth(effective.getMonth() + 1);
      }
      return res.json({
        tier: member.tier,
        label: TIER_LABEL[member.tier] || member.tier,
        started, started_pretty: pretty(started),
        minimum_months: MINIMUM_MONTHS,
        served_minimum: servedMinimum,
        minimum_ends_on: iso(minEnd),
        minimum_ends_pretty: pretty(iso(minEnd)),
        already_ending: alreadyEnding,
        effective_on: iso(effective),
        effective_pretty: pretty(iso(effective)),
        // Said plainly before they decide, not after.
        keeps_access_until: iso(effective),
        no_refund_note: 'Months already paid for are not refunded — you keep everything until the date above.',
      });
    }

    if (req.method === 'POST' && action === 'resume') {
      if (!member.stripe_subscription_id) return res.status(400).json({ error: 'No subscription to resume.' });
      const stripe = await stripeClient();
      if (!stripe) return res.status(400).json({ error: 'Payments are not configured.' });
      try {
        await stripe.subscriptions.update(member.stripe_subscription_id,
          { cancel_at_period_end: false, cancel_at: null });
      } catch (e) {
        return res.status(400).json({ error: (e && e.message) || 'Stripe would not undo that.' });
      }
      await execute(
        "UPDATE members SET cancelled_at='', cancel_effective='', status='active' WHERE member_id=?",
        [member.member_id]);
      try {
        await require('./_notify').notifyInApp('owner', null,
          '↩ ' + (member.full_name || member.member_id) + ' is staying',
          'They undid their cancellation. Membership continues as normal.');
      } catch (_) {}
      return res.json({ ok: true, resumed: true });
    }

    if (req.method === 'POST') {
      if (!member.stripe_subscription_id) {
        return res.status(400).json({ error: 'No active subscription — email us and we will sort it.' });
      }
      const stripe = await stripeClient();
      if (!stripe) return res.status(400).json({ error: 'Payments are not configured.' });

      let effective = periodEnd;
      if (minEnd && effective && effective < minEnd) {
        effective = new Date(periodEnd);
        while (effective < minEnd) effective.setMonth(effective.getMonth() + 1);
      }

      try {
        if (effective && periodEnd && effective.getTime() !== periodEnd.getTime()) {
          // Inside the minimum term: end it on a specific future date rather
          // than at the next renewal, so they serve what they committed to
          // and not a day more.
          await stripe.subscriptions.update(member.stripe_subscription_id,
            { cancel_at: Math.floor(effective.getTime() / 1000) });
        } else {
          await stripe.subscriptions.update(member.stripe_subscription_id,
            { cancel_at_period_end: true });
        }
      } catch (e) {
        return res.status(400).json({ error: (e && e.message) || 'Stripe would not make that change.' });
      }

      // Recorded only after Stripe agreed. Marking somebody cancelled while
      // their card is still being charged is the worst of both.
      const reason = String((req.body || {}).reason || '').slice(0, 400);
      await execute(
        "UPDATE members SET cancelled_at=?, cancel_effective=?, cancel_reason=?, status='cancelling' WHERE member_id=?",
        [new Date().toISOString().slice(0, 10), iso(effective), reason, member.member_id]);

      try {
        await require('./_notify').notifyInApp('owner', null,
          '✕ ' + (member.full_name || member.member_id) + ' cancelled ' + (TIER_LABEL[member.tier] || member.tier),
          'Ends ' + (pretty(iso(effective)) || 'at the end of their period')
          + (reason ? ' · Reason: ' + reason : ' · No reason given'));
      } catch (_) {}

      return res.json({
        ok: true,
        effective_on: iso(effective),
        effective_pretty: pretty(iso(effective)),
        label: TIER_LABEL[member.tier] || member.tier,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
