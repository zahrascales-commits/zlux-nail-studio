// Booking the next one before they leave.
//
// The best moment to book somebody's next visit is while they are still in
// the chair and happy. Once they are out of the door it becomes a task they
// have to remember, and most people do not.
//
// So the screen after payment is already filled in: same artist, same
// service, same time, on the date their own membership says they are next
// due. If that suits them there is nothing to do but press one button.
// Everything is still editable, because the whole thing is worthless if it
// guesses wrong and they cannot correct it.
//
// The interval is not a guess. A member on four-week billing is due in four
// weeks — that is what they are paying for. A member with a second included
// service still to use this cycle is due much sooner, because that service
// expires. Anybody else gets two weeks.
const { query, queryOne, execute } = require('./_team-db');

const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

function studioToday() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function plusDays(from, days) {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/* When they are next due, and why. The reason is returned with the date
   because a date nobody can explain is a date people argue with. */
async function suggestFor(appt) {
  const today = studioToday();
  const bill = require('./_kiosk-bill');

  let member = null, tier = null, freeLeft = 0;
  try {
    member = await bill.memberFor(appt);
    tier = bill.memberTierOf(member);
    if (tier) freeLeft = await bill.freeLeftFor(member);
  } catch (_) {}

  // Somebody who has just used a service has one fewer left than the till
  // reported a moment ago.
  const stillOwed = Math.max(0, Number(freeLeft) || 0);

  if (tier && stillOwed > 0) {
    /* A second service they have already paid for and have not used. It
       expires with the cycle, so the soonest sensible date wins — two weeks
       is enough for a set to grow out and still inside the cycle. */
    return {
      date: ymd(plusDays(today, 14)),
      weeks: 2,
      reason: 'You have ' + stillOwed + ' more service' + (stillOwed === 1 ? '' : 's')
        + ' included this cycle — use it before it resets.',
      tier, tier_label: tierLabel(tier), member_id: member ? member.member_id : null,
      services_left: stillOwed,
    };
  }

  if (tier) {
    // The cycle they are billed on is the cycle they should be seen on.
    return {
      date: ymd(plusDays(today, 28)),
      weeks: 4,
      reason: 'Your membership runs on 4 weeks — this is your next one.',
      tier, tier_label: tierLabel(tier), member_id: member ? member.member_id : null,
      services_left: 0,
    };
  }

  return {
    date: ymd(plusDays(today, 14)),
    weeks: 2,
    reason: 'Two weeks keeps a set looking its best.',
    tier: null, tier_label: '', member_id: null, services_left: 0,
  };
}

function tierLabel(tier) {
  try {
    const p = require('./_plans').byKey(tier);
    return p ? p.name : String(tier || '');
  } catch (_) { return String(tier || ''); }
}

/* Whether the membership that covers this visit will have been paid by the
   time it happens. Not a judgement about the client — memberships bill
   themselves, and this only says whether that has happened yet. */
async function chargeStateFor(memberId, dateStr) {
  if (!memberId) return { relevant: false };
  try {
    const main = require('./_db');
    const m = await main.queryOne(
      'SELECT next_billing_at, tier FROM members WHERE member_id = ?', [memberId]);
    if (!m || !m.next_billing_at) return { relevant: false };

    const due = String(m.next_billing_at).slice(0, 10);
    // The visit falls on or after their next payment, so that payment has to
    // land first. Until it does the appointment is booked but not yet paid
    // for.
    if (dateStr >= due) {
      return { relevant: true, charged: false, next_billing_at: due };
    }
    return { relevant: true, charged: true, next_billing_at: due };
  } catch (_) { return { relevant: false }; }
}

/* Times the studio could actually take them. Kept simple on purpose: the
   artist's real availability lives in the rota, and offering a slot that
   turns out not to exist is worse than offering a short list that does. */
async function timesFor(memberId, dateStr, preferredTime) {
  const out = [];
  const seen = new Set();
  const add = t => { if (t && !seen.has(t)) { seen.add(t); out.push(t); } };

  add(String(preferredTime || '').slice(0, 5));

  try {
    const rows = await query(
      'SELECT time FROM tech_shifts WHERE member_id = ? AND date = ?',
      [Number(memberId) || 0, dateStr]);
    for (const r of rows) add(String(r.time || '').slice(0, 5));
  } catch (_) {}

  // A sensible spread, so somebody who wants a different time has options
  // even when the rota has not been filled in that far ahead.
  ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'].forEach(add);

  // Anything already taken that day with the same artist is not on offer.
  try {
    const taken = await query(
      "SELECT time FROM team_appointments WHERE date = ? AND team_member_id = ? AND status <> 'cancelled'",
      [dateStr, Number(memberId) || 0]);
    const busy = new Set(taken.map(r => String(r.time || '').slice(0, 5)));
    return out.filter(t => !busy.has(t)).slice(0, 8);
  } catch (_) { return out.slice(0, 8); }
}

module.exports = { suggestFor, chargeStateFor, timesFor, studioToday, ymd, plusDays, tierLabel };
