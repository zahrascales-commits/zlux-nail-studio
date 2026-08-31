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
const { query, queryOne, execute } = require('./_team-db');

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

    /* ── How far the calendar actually goes ──
       A client can only book a day somebody is scheduled to work. When the
       last ticked date passes, the booking page does not explain itself — it
       just shows an empty month, and the booking is lost silently. */
    try {
      const last = await query(
        'SELECT member_id, MAX(date) AS last_date, COUNT(*) AS upcoming FROM tech_shifts WHERE date>=? GROUP BY member_id',
        [now]);
      const by = {};
      for (const r of last) by[String(r.member_id)] = { last_date: r.last_date, upcoming: Number(r.upcoming) };

      const gaps = [];
      for (const t of (out.team || [])) {
        const c = by[String(t.id)];
        gaps.push({
          id: Number(t.id), name: t.name,
          last_date: (c && c.last_date) || '',
          upcoming: (c && c.upcoming) || 0,
        });
      }
      // The studio is bookable up to the furthest day anybody works.
      const ends = gaps.map(g => g.last_date).filter(Boolean).sort();
      const studioLast = ends.length ? ends[ends.length - 1] : '';
      const daysLeft = studioLast
        ? Math.round((new Date(studioLast + 'T12:00:00') - new Date(now + 'T12:00:00')) / 86400000)
        : -1;

      /* ── LEFT WITHOUT PAYING ──
         An appointment that has happened with nothing collected. The work
         is done and the product is gone, so this is not a debt to chase
         later — it is the first thing she should see. */
      try {
        try { await execute('ALTER TABLE team_appointments ADD COLUMN paid_verified INTEGER DEFAULT 1'); } catch (_) {}
        const rows = await query(
          `SELECT id, client_name, client_phone, service, date, time,
                  deposit_cents, deposit_paid, paid_cents, pay_method,
                  checked_out_ts, paid_verified, status
             FROM team_appointments
            WHERE date <= ? AND date >= ?`,
          [now, new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)]);

        const owing = [];
        for (const r of rows) {
          if (/cancel/i.test(String(r.status || ''))) continue;

          const collected = (Number(r.deposit_paid) ? Number(r.deposit_cents) || 0 : 0)
            + (Number(r.paid_cents) || 0);
          const unverified = Number(r.paid_verified) === 0;

          // Still in the chair is not the same as gone without paying.
          const finished = Number(r.checked_out_ts) > 0 || String(r.date) < now;
          if (!finished) continue;
          if (collected > 0 && !unverified) continue;

          owing.push({
            id: Number(r.id),
            name: r.client_name || 'Client',
            phone: r.client_phone || '',
            service: r.service || '',
            date: r.date, time: r.time || '',
            collected_cents: collected,
            method: r.pay_method || '',
            // Said to have been sent by an app, not yet confirmed by her.
            unverified: unverified,
          });
        }
        owing.sort((a, b) => String(b.date + b.time).localeCompare(String(a.date + a.time)));

        out.unpaid = {
          count: owing.length,
          rows: owing.slice(0, 12),
        };
      } catch (_) { out.unpaid = { count: 0, rows: [] }; }

      out.calendar = {
        studio_last: studioLast,
        days_left: daysLeft,
        // Six weeks of runway. Below that, somebody booking their next fill
        // is already hitting the wall.
        short: daysLeft < 42,
        artists: gaps,
      };
    } catch (_) { out.calendar = null; }

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
    out.counts.needs_you = out.counts.unassigned + ((out.calendar && out.calendar.short) ? 1 : 0);

    return res.json(out);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
