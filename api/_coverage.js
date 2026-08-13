// Public, unauthenticated: tells the booking page which upcoming date ranges
// have limited team coverage, and which services are still bookable during
// them (e.g. only one artist in, and she can't do every service yet).
const { query, ensureTables } = require('./_team-db');

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const action = req.query.action || 'windows';

  try {
    await ensureTables();

    if (action === 'windows') {
      const today = new Date().toISOString().slice(0, 10);
      const overrides = await query('SELECT * FROM schedule_overrides WHERE end_date >= ? ORDER BY start_date', [today]);
      if (!overrides.length) return res.json({ windows: [] });

      const members = await query('SELECT id, restricted FROM team_members');
      const restrictedById = {};
      for (const m of members) restrictedById[m.id] = !!Number(m.restricted);

      const skillRows = await query('SELECT team_member_id, service_name FROM worker_skills');
      const skillsById = {};
      for (const row of skillRows) {
        (skillsById[row.team_member_id] = skillsById[row.team_member_id] || []).push(row.service_name);
      }

      const windows = overrides.map(o => {
        const ids = JSON.parse(o.team_member_ids || '[]');
        let allServices = false;
        const allowed = new Set();
        for (const id of ids) {
          if (!restrictedById[id]) { allServices = true; break; }
          for (const s of (skillsById[id] || [])) allowed.add(s);
        }
        return {
          start_date: o.start_date,
          end_date: o.end_date,
          note: o.note || '',
          all_services: allServices,
          allowed_services: allServices ? [] : Array.from(allowed),
        };
      });

      return res.json({ windows });
    }

    // Service-first month view: for each date in the range, can the selected
    // services actually be booked? Drives which days the calendar grays out.
    if (action === 'service_days') {
      const { shiftCoverage, hourCapacity, usageByHour, openHours, validStarts } = require('./_shifts');
      const store = require('./_store');
      const from = req.query.from || new Date().toISOString().slice(0, 10);
      const to = req.query.to || from;
      const services = String(req.query.services || '')
        .split('|').map(s => s.trim()).filter(Boolean);

      const { configured, byDate } = await shiftCoverage(from, to, services);
      // Nothing scheduled yet anywhere — leave the calendar wide open rather
      // than blanking out every date on a live booking page.
      if (!configured) return res.json({ configured: false, days: {} });

      // Studio-level closures and per-day hours still win over a shift.
      const dayRows = await query(
        'SELECT date, open_time, close_time, closed FROM day_hours WHERE date>=? AND date<=?',
        [from, to]
      ).catch(() => []);
      const dayByDate = {};
      for (const d of dayRows) dayByDate[d.date] = d;

      // Everything already on the books for the range, so a day whose
      // qualified artists are all full reads as unavailable too.
      const takenByDate = {};
      const bump = (d, t) => { if (d && t) (takenByDate[d] = takenByDate[d] || []).push(t); };
      const teamAppts = await query(
        'SELECT date, time FROM team_appointments WHERE date>=? AND date<=?', [from, to]
      ).catch(() => []);
      for (const a of teamAppts) bump(a.date, a.time);
      try {
        const { query: mainQuery } = require('./_db');
        const pub = await mainQuery(
          "SELECT appointment_date AS d, appointment_time AS t FROM appointments WHERE appointment_date>=? AND appointment_date<=? AND status != 'CANCELLED'",
          [from, to]
        );
        for (const a of pub) bump(a.d, a.t);
      } catch (_) { /* durable table optional */ }

      const days = {};
      for (const date of Object.keys(byDate)) {
        const dayRow = dayByDate[date];
        if (dayRow && Number(dayRow.closed)) { days[date] = { open: false, slots: [] }; continue; }
        let slots = store.ALL_SLOTS.slice();
        if (dayRow) {
          if (dayRow.open_time) slots = slots.filter(s => s >= dayRow.open_time);
          if (dayRow.close_time) slots = slots.filter(s => s < dayRow.close_time);
        }
        // A day is bookable only if a whole 2-hour appointment still fits
        // somewhere in it — not merely if one hour happens to be free.
        const free = openHours(slots, hourCapacity(byDate[date], slots), usageByHour(takenByDate[date]));
        const starts = validStarts(free);
        days[date] = { open: starts.length > 0, slots: starts };
      }
      return res.json({ configured: true, days });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
