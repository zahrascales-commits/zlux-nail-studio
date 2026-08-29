// Every appointment an artist has done, and what it brought in.
//
// Deliberately not a commission calculator. The percentage she pays is hers
// to decide and change, and a number this file worked out would be one more
// thing that could quietly disagree with what she actually pays. So this
// lays out the raw facts — who, when, what, how much — and totals them.
// The arithmetic on top is hers.
//
// "How much it cost" means what was actually collected: the deposit if that
// is all that has been taken, plus the remainder once it is paid. A booking
// nobody has paid for is listed with what it will be worth, in its own
// column, and never added to the total.
const { query } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const money = c => Math.round(Number(c) || 0);
const pad = n => String(n).padStart(2, '0');

function studioToday() {
  const la = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return la.getFullYear() + '-' + pad(la.getMonth() + 1) + '-' + pad(la.getDate());
}

// What a service goes for, when the row itself does not say.
function menuPrice(serviceName) {
  try {
    const { services } = require('./_store');
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const n = norm(serviceName);
    if (!n) return 0;
    const hit = services.find(s => norm(s.name) === n)
      || services.find(s => n.includes(norm(s.name)) || norm(s.name).includes(n));
    return hit ? money(hit.price_cents) : 0;
  } catch (_) { return 0; }
}

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const to = String(req.query.to || studioToday()).slice(0, 10);
    // A month back by default — long enough to pay somebody on, short
    // enough to read.
    const from = String(req.query.from || (() => {
      const d = new Date(to + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - 30);
      return d.toISOString().slice(0, 10);
    })()).slice(0, 10);

    const team = await query('SELECT id, name FROM team_members WHERE active=1 ORDER BY name');
    const byId = {};
    for (const t of team) byId[String(t.id)] = { id: Number(t.id), name: t.name, rows: [] };
    // Work done by somebody no longer on the roster still happened.
    const unassigned = { id: null, name: 'Nobody assigned', rows: [] };

    /* The studio's own book. These rows carry no price, so what was
       collected at the till is the truth and the menu is the fallback. */
    try {
      const rows = await query(
        `SELECT a.id, a.client_name, a.service, a.date, a.time, a.status,
                a.team_member_id, a.deposit_cents, a.deposit_paid,
                a.paid_cents, a.tip_cents, a.checked_out_ts
           FROM team_appointments a
          WHERE a.date >= ? AND a.date <= ?
          ORDER BY a.date DESC, a.time DESC`, [from, to]);
      for (const r of rows) {
        if (/cancel/i.test(String(r.status || ''))) continue;
        const collected = money(r.paid_cents) + (Number(r.deposit_paid) ? money(r.deposit_cents) : 0);
        const bucket = byId[String(r.team_member_id)] || unassigned;
        bucket.rows.push({
          date: r.date, time: r.time,
          client: r.client_name || 'Guest',
          service: r.service || '',
          worth_cents: menuPrice(r.service),
          collected_cents: collected,
          tip_cents: money(r.tip_cents),
          finished: !!Number(r.checked_out_ts),
          source: 'studio',
        });
      }
    } catch (_) {}

    /* Bookings made on the website. These know their own price. */
    try {
      const main = require('./_db');
      const rows = await main.query(
        `SELECT a.id, a.service, a.appointment_date AS date, a.appointment_time AS time,
                a.total_cents, a.deposit_cents, a.deposit_paid, a.paid_cents, a.tip_cents,
                a.status, a.guest_name, m.full_name
           FROM appointments a
           LEFT JOIN members m ON a.member_id = m.member_id
          WHERE a.appointment_date >= ? AND a.appointment_date <= ?
            AND a.status <> 'CANCELLED'
          ORDER BY a.appointment_date DESC`, [from, to]);
      for (const r of rows) {
        const collected = money(r.paid_cents) + (Number(r.deposit_paid) ? money(r.deposit_cents) : 0);
        unassigned.rows.push({
          date: r.date, time: r.time,
          client: r.full_name || r.guest_name || 'Guest',
          service: r.service || '',
          worth_cents: money(r.total_cents) || menuPrice(r.service),
          collected_cents: collected,
          tip_cents: money(r.tip_cents),
          finished: /complete/i.test(String(r.status || '')),
          source: 'online',
        });
      }
    } catch (_) {}

    /* An online booking is mirrored into the studio's book, so the same
       visit can appear twice. Counted twice it would pay somebody twice. */
    const seen = new Set();
    const dedupe = list => list.filter(r => {
      const k = String(r.client).trim().toLowerCase() + '|' + r.date + '|' + String(r.time).slice(0, 5);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const artists = [];
    for (const t of team.map(x => byId[String(x.id)]).concat([unassigned])) {
      const rows = dedupe(t.rows);
      if (!rows.length && t.id === null) continue;
      artists.push({
        id: t.id,
        name: t.name,
        appointments: rows.length,
        collected_cents: rows.reduce((s, r) => s + r.collected_cents, 0),
        tips_cents: rows.reduce((s, r) => s + r.tip_cents, 0),
        // Booked and worth something, but nothing has been taken yet.
        unpaid_cents: rows.reduce((s, r) => s + (r.collected_cents ? 0 : r.worth_cents), 0),
        rows,
      });
    }

    return res.json({
      ok: true,
      from, to,
      artists,
      totals: {
        appointments: artists.reduce((s, a) => s + a.appointments, 0),
        collected_cents: artists.reduce((s, a) => s + a.collected_cents, 0),
        tips_cents: artists.reduce((s, a) => s + a.tips_cents, 0),
      },
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
