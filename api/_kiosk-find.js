// Finding the right person at the front desk.
//
// The old lookup matched loosely in both directions: it would accept an
// appointment whose first name appeared anywhere inside what was typed, so
// "Katelynn Boydstun" matched an appointment for "Kate", and a single letter
// matched everybody. At a till that decides what somebody owes, guessing is
// worse than asking.
//
// So: an email or a phone number is an exact match and settles it. A name
// only settles it when exactly one person matches — otherwise the screen
// asks which of them it is. Nothing is ever picked for the client.
const { query } = require('./_team-db');

const digits = s => String(s || '').replace(/[^0-9]/g, '');
const lower = s => String(s || '').trim().toLowerCase();
const looksEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());

// Names are compared on their words, so "boydstun katelynn" and
// "Katelynn  Boydstun" are the same person and "Kate" is not.
const words = s => lower(s).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);

function nameMatches(typed, actual) {
  const a = words(typed), b = words(actual);
  if (!a.length || !b.length) return false;
  // Every word typed has to be the start of a word in the real name. Typing
  // a full name matches it; typing one first name matches everyone who has
  // it, which is exactly when the screen should ask.
  return a.every(t => b.some(w => w === t || (t.length >= 3 && w.startsWith(t))));
}

function studioDay() {
  // The studio's day, not the server's. A kiosk in California must not roll
  // over to tomorrow at 5pm because the server is on UTC.
  const now = new Date();
  const la = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const pad = n => String(n).padStart(2, '0');
  return la.getFullYear() + '-' + pad(la.getMonth() + 1) + '-' + pad(la.getDate());
}

/* Everybody booked in today, from both places appointments live, in one
   shape. The studio's own book and the public booking table disagree about
   column names and about what they know, so this is where that ends. */
async function todaysAppointments(day) {
  const date = day || studioDay();
  const out = [];

  // The studio's own book.
  try {
    const rows = await query(
      `SELECT a.id, a.client_name, a.client_email, a.client_phone, a.service, a.time,
              a.deposit_cents, a.deposit_paid, a.status, a.team_member_id, m.name AS artist
         FROM team_appointments a
         LEFT JOIN team_members m ON m.id = a.team_member_id
        WHERE a.date = ?`, [date]);
    for (const r of rows) {
      if (/cancel/i.test(String(r.status || ''))) continue;
      out.push({
        src: 't', id: Number(r.id),
        name: r.client_name || '', email: lower(r.client_email), phone: digits(r.client_phone),
        service: r.service || '', time: r.time || '', artist: r.artist || '',
        deposit_cents: Number(r.deposit_cents) || 0,
        deposit_paid: Number(r.deposit_paid) ? 1 : 0,
        // The studio's book stores no price — it is worked out from the menu.
        total_cents: null,
        member_id: null,
      });
    }
  } catch (_) {}

  // Bookings made on the website, by guests and by members.
  try {
    const main = require('./_db');
    const rows = await main.query(
      `SELECT a.id, a.service, a.appointment_time AS time, a.total_cents, a.deposit_cents,
              a.deposit_paid, a.guest_name, a.guest_email, a.guest_phone,
              a.member_id, m.full_name, m.email AS member_email, m.phone AS member_phone, m.tier
         FROM appointments a
         LEFT JOIN members m ON a.member_id = m.member_id
        WHERE a.appointment_date = ? AND a.status <> 'CANCELLED'`, [date]);
    for (const r of rows) {
      out.push({
        src: 'm', id: Number(r.id),
        name: r.full_name || r.guest_name || '',
        email: lower(r.member_email || r.guest_email),
        phone: digits(r.member_phone || r.guest_phone),
        service: r.service || '', time: r.time || '', artist: '',
        deposit_cents: Number(r.deposit_cents) || 0,
        deposit_paid: Number(r.deposit_paid) ? 1 : 0,
        total_cents: Number(r.total_cents) || 0,
        member_id: r.member_id || null,
        tier: r.tier || '',
      });
    }
  } catch (_) {}

  /* The same appointment can sit in both tables — booking online mirrors
     into the studio's book. Shown twice it would be checked out twice, so
     the row that knows the money wins. */
  const seen = new Map();
  for (const a of out) {
    const key = lower(a.name) + '|' + String(a.time).slice(0, 5);
    const had = seen.get(key);
    if (!had) { seen.set(key, a); continue; }
    if (had.total_cents === null && a.total_cents !== null) seen.set(key, a);
  }
  return [...seen.values()];
}

/* Who this is. Returns either one appointment, or the shortlist to choose
   from — never a guess. */
async function findFor(qRaw, day) {
  const q = String(qRaw || '').trim();
  if (!q) return { matches: [], how: 'nothing typed' };

  const all = await todaysAppointments(day);

  if (looksEmail(q)) {
    const hit = all.filter(a => a.email && a.email === lower(q));
    return { matches: hit, how: 'email' };
  }

  const d = digits(q);
  if (d.length >= 7) {
    // Compared on the last ten digits so a leading 1 or a +1 does not matter.
    const tail = s => s.slice(-10);
    const hit = all.filter(a => a.phone && tail(a.phone) === tail(d));
    return { matches: hit, how: 'phone' };
  }

  return { matches: all.filter(a => nameMatches(q, a.name)), how: 'name' };
}

module.exports = { findFor, todaysAppointments, studioDay, nameMatches, looksEmail, digits, lower };
