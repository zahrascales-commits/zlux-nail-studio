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

    /* ── BLACK CARD: who is free, and when ────────────────────────────
       Choosing your artist is the benefit Black Card is sold on, so this
       is gated on the server rather than by hiding a section in the page.
       Anyone may call it; only a Black Card member gets an answer, because
       a hidden div is not access control.                                */
    if (action === 'artists') {
      const memberId = String(req.query.member_id || '').trim().toUpperCase();
      if (!memberId) return res.status(401).json({ error: 'Members only' });

      let tier = '';
      try {
        const row = await require('./_db').queryOne('SELECT tier FROM members WHERE member_id = ?', [memberId]);
        tier = row ? String(row.tier || '').toUpperCase() : '';
      } catch (_) {}
      if (tier !== 'BLACK_CARD') {
        return res.status(403).json({ error: 'Choosing your artist is a Black Card benefit.' });
      }

      const date = String(req.query.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Which date?' });
      const services = String(req.query.services || '').split(',').map(s => s.trim()).filter(Boolean);

      const shifts = require('./_shifts');
      const cov = await shifts.shiftCoverage(date, date, services, false);
      const onToday = cov.byDate[date] || [];

      let booked = [];
      try {
        booked = await query(
          "SELECT team_member_id, time FROM team_appointments WHERE date=? AND LOWER(COALESCE(status,'scheduled'))<>'cancelled'",
          [date]);
      } catch (_) {}

      const team = await query('SELECT id, name, color, photo, title, role FROM team_members WHERE active=1 ORDER BY id');
      const byId = {};
      for (const t of team) byId[Number(t.id)] = t;

      // Every start a whole appointment actually fits into, minus what is
      // already on her day. Offering a time she cannot finish is worse than
      // showing her as busy.
      // How long the appointment being booked will run, so the times offered
      // are ones it actually finishes inside.
      let need = shifts.APPT_MINUTES;
      try {
        const tiers = require('./_tiers');
        const addons = String(req.query.addons || '').split('|').map(s => s.trim()).filter(Boolean);
        need = tiers.blockMinutes(String(req.query.design_tier || ''), addons);
      } catch (_) {}

      const out = onToday.map(sh => {
        const busy = new Set();
        for (const b of booked) {
          if (Number(b.team_member_id) !== Number(sh.id) || !b.time) continue;
          for (let k = 0; k < shifts.stepsFor(shifts.APPT_MINUTES); k++) {
            busy.add(shifts.minToH(shifts.hToMin(String(b.time)) + k * shifts.STEP_MINUTES));
          }
        }
        const starts = [];
        const endMin = shifts.hToMin(sh.end);
        for (let mins = shifts.hToMin(sh.start); mins < endMin; mins += shifts.STEP_MINUTES) {
          // The whole appointment has to finish inside the shift, not merely
          // start inside it. Checking only that each hour begins before the
          // end lets the last slot run over — a 7:30 start on a shift ending
          // at 9:00 would have her working until 9:30.
          if (mins + need > endMin) break;
          let fits = true;
          for (let k = 0; k < shifts.stepsFor(need); k++) {
            const step = shifts.minToH(mins + k * shifts.STEP_MINUTES);
            if (busy.has(step)) { fits = false; break; }
            if (sh.lunchStart && sh.lunchEnd && step >= sh.lunchStart && step < sh.lunchEnd) { fits = false; break; }
          }
          if (fits) starts.push(shifts.minToH(mins));
        }
        const info = byId[Number(sh.id)] || {};
        return {
          id: sh.id, name: sh.name,
          title: (info.title && String(info.title).trim()) || info.role || 'Nail Artist',
          color: info.color || '#B6A588', photo: info.photo || '',
          shift_start: sh.start, shift_end: sh.end,
          times: starts,
          booked_count: booked.filter(b => Number(b.team_member_id) === Number(sh.id)).length,
        };
      });

      // Anyone qualified but not rostered that day still belongs on the list,
      // greyed. "She is not in on Tuesday" is a useful answer; leaving her out
      // entirely reads as though she left the studio.
      const shown = new Set(out.map(a => Number(a.id)));
      for (const m of await shifts.loadTeam()) {
        if (shown.has(Number(m.id)) || !shifts.covers(m, services)) continue;
        const info = byId[Number(m.id)] || {};
        out.push({
          id: m.id, name: m.name,
          title: (info.title && String(info.title).trim()) || info.role || 'Nail Artist',
          color: info.color || '#B6A588', photo: info.photo || '',
          shift_start: null, shift_end: null, times: [], booked_count: 0,
        });
      }

      return res.json({ date, configured: cov.configured, artists: out });
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

      const traineeOnly = String(req.query.trainee_only || '') === '1';
      const { configured, byDate } = await shiftCoverage(from, to, services, traineeOnly);
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
      const bump = (d, t, mins) => { if (d && t) (takenByDate[d] = takenByDate[d] || []).push({ time: t, minutes: mins || null }); };
      const teamAppts = await query(
        'SELECT date, time FROM team_appointments WHERE date>=? AND date<=?', [from, to]
      ).catch(() => []);
      for (const a of teamAppts) bump(a.date, a.time, null);
      try {
        const { query: mainQuery } = require('./_db');
        let pub = [];
        try {
          pub = await mainQuery(
            "SELECT appointment_date AS d, appointment_time AS t, block_minutes AS mins FROM appointments WHERE appointment_date>=? AND appointment_date<=? AND status != 'CANCELLED'",
            [from, to]);
        } catch (_) {
          pub = await mainQuery(
            "SELECT appointment_date AS d, appointment_time AS t FROM appointments WHERE appointment_date>=? AND appointment_date<=? AND status != 'CANCELLED'",
            [from, to]);
        }
        for (const a of pub) bump(a.d, a.t, Number(a.mins) || null);
      } catch (_) { /* durable table optional */ }

      // How long the appointment the client is actually trying to book will
      // run. A day with only a 90-minute gap left is open for a plain set and
      // closed for a full design, and the calendar should say so.
      let needMinutes = null;
      try {
        const tiers = require('./_tiers');
        const addons = String(req.query.addons || '').split('|').map(s => s.trim()).filter(Boolean);
        needMinutes = tiers.blockMinutes(String(req.query.design_tier || ''), addons);
      } catch (_) {}

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
        const starts = validStarts(free, needMinutes);
        days[date] = { open: starts.length > 0, slots: starts };
      }
      return res.json({ configured: true, days });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
