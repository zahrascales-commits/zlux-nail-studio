// The numbers Zahra actually looks at, built from this studio's own data.
//
// Modelled on the analytics screen she already reads every day, so nothing
// has to be relearned: net revenue and what it is made of, where the month is
// heading, retention, how full the book is, average ticket, and how each
// figure compares with the period before.
//
// Every one is computed from real bookings under the same rule the rest of
// the dashboard uses — a deposit was taken and the appointment happened.
// A metric that counts unpaid requests is a metric that flatters you, and
// this screen exists to be trusted rather than enjoyed.
const { query, queryOne } = require('./_db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const pad = n => String(n).padStart(2, '0');
const localDay = d => {
  const x = d || new Date();
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
};

// Ranges are inclusive at both ends and never run past today for anything
// claiming to be earned.
function rangeFor(period, when) {
  const now = when || new Date();
  if (period === 'week') {
    const start = new Date(now); start.setDate(start.getDate() - 6);
    const prevEnd = new Date(start); prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 6);
    return { from: localDay(start), to: localDay(now), pFrom: localDay(prevStart), pTo: localDay(prevEnd) };
  }
  if (period === 'year') {
    const y = now.getFullYear();
    return { from: y + '-01-01', to: localDay(now), pFrom: (y - 1) + '-01-01', pTo: (y - 1) + '-12-31' };
  }
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const pFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const pLast = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: localDay(first), to: localDay(now), pFrom: localDay(pFirst), pTo: localDay(pLast),
           monthStart: localDay(first), monthEnd: localDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
}

// Everything that happened, from both the old booking system and this one.
async function loadVisits() {
  const rows = [];

  try {
    for (const a of await query(
      `SELECT guest_name, guest_email, service, appointment_date, appointment_time,
              status, total_cents, deposit_cents, deposit_paid, tip_cents
         FROM appointments`)) {
      rows.push({
        client: a.guest_name || '',
        date: a.appointment_date,
        service: a.service || '',
        status: String(a.status || '').toLowerCase(),
        total_cents: Number(a.total_cents) || 0,
        tip_cents: Number(a.tip_cents) || 0,
        paid: Number(a.deposit_paid) === 1,
        source: 'site',
      });
    }
  } catch (_) {
    // tip_cents may not exist yet; fall back to the columns that always do.
    try {
      for (const a of await query(
        `SELECT guest_name, service, appointment_date, status, total_cents, deposit_paid
           FROM appointments`)) {
        rows.push({
          client: a.guest_name || '', date: a.appointment_date, service: a.service || '',
          status: String(a.status || '').toLowerCase(),
          total_cents: Number(a.total_cents) || 0, tip_cents: 0,
          paid: Number(a.deposit_paid) === 1, source: 'site',
        });
      }
    } catch (_) {}
  }

  // The imported history. It has no ticket total — the old export only
  // carried deposits — so it counts towards bookings and retention but not
  // revenue. Inventing a price for it would be inventing income.
  try {
    for (const v of await query(
      'SELECT client_name, date, service, status, deposit_cents, deposit_paid FROM client_visits')) {
      rows.push({
        client: v.client_name || '', date: v.date, service: v.service || '',
        status: String(v.status || '').toLowerCase(),
        total_cents: 0, tip_cents: 0,
        deposit_cents: Number(v.deposit_cents) || 0,
        paid: Number(v.deposit_paid) === 1,
        source: 'imported',
      });
    }
  } catch (_) {}

  return rows;
}

const cancelled = v => /cancel/.test(v.status);
const noShow = v => /no.?show/.test(v.status);
const counts = v => !cancelled(v) && !noShow(v);
// Revenue only from what was really paid for through this site.
const earns = (v, today) => counts(v) && v.paid && v.source === 'site' && String(v.date) <= today;
const inRange = (v, a, b) => String(v.date) >= a && String(v.date) <= b;
const sum = (list, f) => list.reduce((t, x) => t + (f(x) || 0), 0);

function change(now, before) {
  if (!before) return null;              // no baseline is not a 100% rise
  return Math.round(((now - before) / before) * 100);
}

// How many hours the team was actually available, so "how full is the book"
// means something. Without a roster there is no denominator and the honest
// answer is that we cannot say.
async function rosterHours(from, to) {
  try {
    const { query: tq } = require('./_team-db');
    const rows = await tq(
      'SELECT start_time, end_time, lunch_start, lunch_end FROM tech_shifts WHERE date>=? AND date<=?',
      [from, to]);
    const mins = t => { const p = String(t || '').split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); };
    let total = 0;
    for (const r of rows) {
      let m = mins(r.end_time) - mins(r.start_time);
      if (r.lunch_start && r.lunch_end) m -= Math.max(0, mins(r.lunch_end) - mins(r.lunch_start));
      if (m > 0) total += m;
    }
    return { minutes: total, shifts: rows.length };
  } catch (_) { return { minutes: 0, shifts: 0 }; }
}

const APPT_MINUTES = 105; // the base appointment, before any design tier

async function build(period) {
  const today = localDay();
  const r = rangeFor(period);
  const all = await loadVisits();

  const now = all.filter(v => inRange(v, r.from, r.to));
  const prev = all.filter(v => inRange(v, r.pFrom, r.pTo));

  const nowEarned = now.filter(v => earns(v, today));
  const prevEarned = prev.filter(v => earns(v, today));

  const service_cents = sum(nowEarned, v => v.total_cents);
  const tips_cents = sum(nowEarned, v => v.tip_cents);

  // Retail: press-on and product orders, if that table exists yet.
  let retail_cents = 0;
  try {
    const rows = await query(
      "SELECT total_cents, created_at FROM presson_orders WHERE date(created_at)>=? AND date(created_at)<=?",
      [r.from, r.to]);
    retail_cents = rows.reduce((t, x) => t + (Number(x.total_cents) || 0), 0);
  } catch (_) {}

  // Memberships billed in the period — real recurring income, and the whole
  // reason the studio is building a membership base.
  let membership_cents = 0;
  try {
    let rows = [];
    try {
      rows = await query(
        "SELECT tier, paid_cents, billing_period FROM members WHERE COALESCE(demo,0)=0 AND date(membership_started_at)<=?", [r.to]);
    } catch (_) {
      rows = await query(
        "SELECT tier FROM members WHERE COALESCE(demo,0)=0 AND date(membership_started_at)<=?", [r.to]);
    }
    const mp = require('./_member-price');
    membership_cents = rows.reduce((t, m) => t + mp.monthlyValue(m).cents, 0);
  } catch (_) {}

  const other_cents = retail_cents + membership_cents;
  const net_cents = service_cents + tips_cents + other_cents;

  const prevService = sum(prevEarned, v => v.total_cents);
  const prevNet = prevService + sum(prevEarned, v => v.tip_cents);

  // Where the month lands if the rest of it goes like the part so far.
  let projected_cents = net_cents;
  if (period === 'month' && r.monthEnd) {
    const dayNow = Number(today.slice(8, 10));
    const daysInMonth = Number(r.monthEnd.slice(8, 10));
    if (dayNow > 0) projected_cents = Math.round((net_cents / dayNow) * daysInMonth);
  }

  // Retention: of the clients who had been in before this period, how many
  // came back during it. Counting first-timers as "retained" would make a
  // studio full of strangers look loyal.
  const seenBefore = new Set(
    all.filter(v => counts(v) && String(v.date) < r.from).map(v => String(v.client).toLowerCase()).filter(Boolean));
  const cameBack = new Set(
    now.filter(counts).map(v => String(v.client).toLowerCase()).filter(n => n && seenBefore.has(n)));
  const retention = seenBefore.size ? Math.round((cameBack.size / seenBefore.size) * 100) : 0;

  const bookings = now.filter(counts).length;
  const prevBookings = prev.filter(counts).length;

  const roster = await rosterHours(r.from, r.to);
  const bookedMinutes = bookings * APPT_MINUTES;
  const utilization = roster.minutes ? Math.round((bookedMinutes / roster.minutes) * 100) : null;

  const prevRoster = await rosterHours(r.pFrom, r.pTo);
  const prevUtil = prevRoster.minutes
    ? Math.round(((prevBookings * APPT_MINUTES) / prevRoster.minutes) * 100) : null;

  const ticketBase = nowEarned.length;
  const avg_ticket_cents = ticketBase ? Math.round((service_cents + tips_cents) / ticketBase) : 0;
  const prevTicket = prevEarned.length
    ? Math.round((prevService + sum(prevEarned, v => v.tip_cents)) / prevEarned.length) : 0;

  const pct = t => (net_cents ? Math.round((t / net_cents) * 1000) / 10 : 0);

  return {
    period, today, from: r.from, to: r.to,
    compared_with: { from: r.pFrom, to: r.pTo },

    net_revenue: {
      cents: net_cents,
      change: change(net_cents, prevNet),
      split: {
        service: { cents: service_cents, pct: pct(service_cents) },
        gratuities: { cents: tips_cents, pct: pct(tips_cents) },
        other: { cents: other_cents, pct: pct(other_cents) },
      },
    },
    projected_revenue: { cents: projected_cents, change: change(projected_cents, prevNet) },
    service_revenue: { cents: service_cents, change: change(service_cents, prevService) },
    retail_revenue: { cents: retail_cents },
    client_retention: { pct: retention, returning: cameBack.size, of: seenBefore.size },
    booking_utilization: {
      pct: utilization,
      change: change(utilization, prevUtil),
      booked_hours: Math.round((bookedMinutes / 60) * 10) / 10,
      available_hours: Math.round((roster.minutes / 60) * 10) / 10,
    },
    average_ticket: { cents: avg_ticket_cents, change: change(avg_ticket_cents, prevTicket) },
    total_bookings: { count: bookings, change: change(bookings, prevBookings) },

    // Said plainly rather than left for her to wonder about.
    caveats: [
      tips_cents === 0 ? 'Gratuities read $0 because tipping is not switched on yet.' : null,
      retail_cents === 0 ? 'Retail reads $0 because no press-on orders have come through.' : null,
      utilization === null ? 'Booking utilisation needs rostered hours — nobody is scheduled in this period.' : null,
      all.some(v => v.source === 'imported')
        ? 'Your imported history counts towards bookings and retention, but not revenue: that export carried deposits, not ticket totals.'
        : null,
    ].filter(Boolean),
  };
}

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const period = ['week', 'month', 'year'].includes(req.query.period) ? req.query.period : 'month';
    return res.json(await build(period));
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.build = build;
