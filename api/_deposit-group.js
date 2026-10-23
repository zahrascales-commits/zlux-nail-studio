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
const { query, queryOne, execute } = require('./_team-db');

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

  /* A deposit that came up short still owes the difference. Appointments
     booked by hand carry every service on one line, and until this was
     fixed the link asked for half of whichever service the menu matched
     first — half of a $95 manicure against $255 of work. Those clients
     have paid something, so they are not "unpaid"; they owe the rest of
     the deposit, and this is where that is noticed.

     Only ahead of the appointment, and only for a difference worth asking
     about: anything already in the chair settles at the desk, and nobody
     gets a payment link for sixty cents. */
  const TOPUP_FLOOR = 500;
  const todayLA = new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10);

  const paid = [], owing = [];
  for (const r of rows) {
    if (Number(r.deposit_paid)) {
      const taken = Math.round(Number(r.deposit_cents) || 0);
      paid.push({ row: r, cents: taken });
      let should = 0;
      try { should = Math.round(Number(await visit.correctDepositFor(r)) || 0); } catch (_) { should = 0; }
      const short = should - taken;
      if (short >= TOPUP_FLOOR && r.chat_token && String(r.date || '') >= todayLA) {
        owing.push({ row: r, owed: short, topup: true, already: taken });
      }
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
      /* Topping up a deposit that was short adds to what was already taken;
         a first payment sets it. Written as two statements rather than one
         sum, so a row that was never paid cannot double-count a figure that
         was only ever an estimate of what was owed. */
      const row = await queryOne(
        'SELECT COALESCE(deposit_paid,0) AS paid FROM team_appointments WHERE chat_token = ?', [s.token]);
      if (row && Number(row.paid)) {
        await execute(
          'UPDATE team_appointments SET deposit_cents = COALESCE(deposit_cents,0) + ? WHERE chat_token = ?',
          [s.cents, s.token]);
      } else {
        await execute(
          'UPDATE team_appointments SET deposit_paid = 1, deposit_cents = ? ' +
          'WHERE chat_token = ? AND COALESCE(deposit_paid,0) = 0',
          [s.cents, s.token]);
      }
      recorded++;
    } catch (_) {}
  }
  return { matched: true, recorded, sum, received };
}

module.exports = { groupFor, samePerson, parseShares, recordShares };
