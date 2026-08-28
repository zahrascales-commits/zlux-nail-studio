// Everything waiting on Zahra, in one place.
//
// Built because Rosalinda Ruiz sat unassigned for days and there was nowhere
// to find her. The dispatch panel only ever showed appointments that went
// through the first-to-confirm flow; anything booked another way — by her, by
// a member, imported — had no artist and no screen that said so.
//
// The rule for what belongs here: it is something only she can resolve, and
// leaving it costs her money or costs a client their appointment. Everything
// else belongs on its own screen.
const { query, queryOne } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const pad = n => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = today();
    const out = { unassigned: [], new_members: [], new_bookings: [], counts: {} };

    // ── Nobody is doing this appointment ──
    //
    // Only ones still to come. An unassigned appointment last month is a
    // record-keeping problem; an unassigned one next week is a client who
    // turns up to nobody.
    try {
      const rows = await query(
        `SELECT a.id, a.client_name, a.client_phone, a.service, a.date, a.time, a.notes, a.status
           FROM team_appointments a
          WHERE (a.team_member_id IS NULL OR a.team_member_id = '')
            AND a.date >= ?
            AND LOWER(COALESCE(a.status,'scheduled')) <> 'cancelled'
          ORDER BY a.date, a.time`, [now]);
      out.unassigned = rows.map(r => ({
        id: Number(r.id),
        client: r.client_name || 'Guest',
        phone: r.client_phone || '',
        service: r.service || '',
        date: r.date, time: r.time,
        notes: r.notes || '',
        // How soon somebody has to decide.
        days_away: Math.round((new Date(r.date + 'T12:00:00') - new Date(now + 'T12:00:00')) / 86400000),
      }));
    } catch (_) {}

    // ── Who can take each one ──
    //
    // Sent with the list so the dropdown is populated in the same request —
    // a second round trip is a second thing that can fail while she is
    // trying to give somebody an appointment.
    try {
      out.team = await query(
        'SELECT id, name, color, trainee FROM team_members WHERE active=1 ORDER BY name');
    } catch (_) { out.team = []; }

    // ── Somebody just joined ──
    try {
      const main = require('./_db');
      const since = Date.now() - 7 * 86400000;
      let rows = [];
      try {
        rows = await main.query(
          `SELECT member_id, full_name, email, tier, membership_started_at, demo
             FROM members ORDER BY membership_started_at DESC LIMIT 10`);
      } catch (_) {}
      out.new_members = rows
        .filter(m => !Number(m.demo))
        .filter(m => {
          const t = new Date(String(m.membership_started_at || '').slice(0, 10) + 'T12:00:00');
          return !isNaN(t) && t.getTime() >= since;
        })
        .map(m => ({
          member_id: m.member_id, name: m.full_name, email: m.email,
          tier: m.tier, started: String(m.membership_started_at || '').slice(0, 10),
        }));
    } catch (_) {}

    // ── Booked in the last two days ──
    try {
      const main = require('./_db');
      const rows = await main.query(
        `SELECT a.id, COALESCE(m.full_name, a.guest_name) AS client, a.service,
                a.appointment_date, a.appointment_time, a.total_cents, a.deposit_paid
           FROM appointments a
           LEFT JOIN members m ON a.member_id = m.member_id
          WHERE a.status <> 'CANCELLED' AND a.appointment_date >= ?
          ORDER BY a.id DESC LIMIT 8`, [now]);
      out.new_bookings = rows.map(r => ({
        id: Number(r.id), client: r.client || 'Guest', service: r.service || '',
        date: r.appointment_date, time: r.appointment_time,
        total_cents: Number(r.total_cents) || 0,
        deposit_paid: !!Number(r.deposit_paid),
      }));
    } catch (_) {}

    // ── Anything the notification feed is holding ──
    try {
      const main = require('./_db');
      const r = await main.queryOne(
        "SELECT COUNT(*) AS n FROM notifications WHERE recipient='owner' AND read=0");
      out.counts.unread = Number((r || {}).n) || 0;
    } catch (_) { out.counts.unread = 0; }

    out.counts.unassigned = out.unassigned.length;
    out.counts.new_members = out.new_members.length;
    out.counts.new_bookings = out.new_bookings.length;
    // One number for the tab badge: the things that genuinely cannot wait.
    out.counts.needs_you = out.counts.unassigned;

    return res.json(out);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
