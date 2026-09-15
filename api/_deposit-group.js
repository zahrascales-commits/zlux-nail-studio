// Everything one person has booked on one day, as a single deposit.
//
// Each service is its own row with its own link, so a client with two
// services had two deposits and two pages to pay them on. Pay one link and
// the other stayed open — which is exactly how Lorena paid $27.50 and still
// owed $47.50. The chase email made it worse: it named the combined total and
// then linked to a page that charged only the first service.
//
// So a deposit is worked out for the day, not the row. Every page, email and
// reminder that asks for money asks for this number, and paying it marks
// every one of those services paid, each with its own share.
const { query, execute } = require('./_team-db');

const digits = s => String(s || '').replace(/[^0-9]/g, '');
const lower = s => String(s || '').trim().toLowerCase();

/* Whether two bookings belong to the same person. Deliberately cautious:
   putting two people's deposits on one payment is far worse than leaving one
   person with two.

   Two different emails are two different people, even on a shared family
   phone. Otherwise a matching phone number settles it. A name alone only
   counts when neither booking has an email or a phone to go on, because two
   different Marias on the same day must never share a deposit. */
function samePerson(a, b) {
  const ea = lower(a.client_email), eb = lower(b.client_email);
  if (ea && eb) return ea === eb;

  const pa = digits(a.client_phone).slice(-10), pb = digits(b.client_phone).slice(-10);
  if (pa.length >= 7 && pb.length >= 7) return pa === pb;

  if (!ea && !eb && pa.length < 7 && pb.length < 7) {
    const na = lower(a.client_name), nb = lower(b.client_name);
    return !!na && na === nb;
  }
  return false;
}

/* The day's deposit for whoever `appt` belongs to.
 *
 *   rows       every live service they have that day, in time order
 *   paid       services whose deposit is already in, with what was taken
 *   owing      services still owing, with what each one owes
 *   dueCents   the one number to charge now
 *   paidCents  what has already come in for the day
 *   tokenShares  "token:cents,token:cents" — written on the Stripe payment so
 *                each service is marked paid with its own share when it clears
 */
async function groupFor(appt) {
  const visit = require('./_visit');
  let rows = [appt];

  if (appt && appt.date) {
    try {
      const sameDay = await query(
        'SELECT a.*, m.name AS artist_name FROM team_appointments a ' +
        'LEFT JOIN team_members m ON m.id = a.team_member_id ' +
        'WHERE a.date = ? ORDER BY a.time', [appt.date]);
      rows = sameDay.filter(r =>
        samePerson(r, appt)
        && !/cancel/i.test(String(r.status || ''))
        && !Number(r.checked_out_ts));
      // The booking somebody is looking at always belongs to its own group.
      if (!rows.some(r => Number(r.id) === Number(appt.id))) rows.unshift(appt);
    } catch (_) {
      rows = [appt];
    }
  }

  const paid = [], owing = [];
  for (const r of rows) {
    if (Number(r.deposit_paid)) {
      paid.push({ row: r, cents: Math.round(Number(r.deposit_cents) || 0) });
      continue;
    }
    let owed = 0;
    try { owed = await visit.depositFor(r); } catch (_) { owed = 0; }
    owed = Math.max(0, Math.round(Number(owed) || 0));
    /* Only a service with a link can be paid online, so only those are
       charged for. A deposit that is charged but cannot be recorded against
       anything is money nobody can account for. */
    if (owed > 0 && r.chat_token) owing.push({ row: r, owed });
  }

  const dueCents = owing.reduce((s, x) => s + x.owed, 0);
  const paidCents = paid.reduce((s, x) => s + x.cents, 0);

  return {
    rows, paid, owing, dueCents, paidCents,
    tokenShares: owing.map(x => x.row.chat_token + ':' + x.owed).join(','),
  };
}

// Read "token:cents,token:cents" back off a payment.
function parseShares(s) {
  return String(s || '').split(',').map(p => {
    const i = p.lastIndexOf(':');
    if (i < 1) return null;
    const token = p.slice(0, i).trim();
    const cents = Math.round(Number(p.slice(i + 1)) || 0);
    return token && cents > 0 ? { token, cents } : null;
  }).filter(Boolean);
}

/* Record a cleared payment against every service it covered, each with its
   own share. Only rows still unpaid are touched, so a payment reported twice
   — once by the page, once by Stripe itself — cannot overwrite anything.

   Refuses when the shares do not add up to what was actually received:
   marking three services paid off a payment that covered two is how a
   deposit quietly goes missing. */
async function recordShares(shares, receivedCents) {
  const received = Math.round(Number(receivedCents) || 0);
  const sum = shares.reduce((s, x) => s + x.cents, 0);
  if (!shares.length || sum !== received) return { matched: false, recorded: 0, sum, received };

  let recorded = 0;
  for (const s of shares) {
    try {
      await execute(
        'UPDATE team_appointments SET deposit_paid = 1, deposit_cents = ? ' +
        'WHERE chat_token = ? AND COALESCE(deposit_paid,0) = 0',
        [s.cents, s.token]);
      recorded++;
    } catch (_) {}
  }
  return { matched: true, recorded, sum, received };
}

module.exports = { groupFor, samePerson, parseShares, recordShares };
