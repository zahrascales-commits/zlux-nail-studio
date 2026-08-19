// Shared availability math for service-first booking.
//
// The client picks a service, then a date. To answer "can this be booked on
// the 14th?" we need three things at once: who can do that service, who is
// actually in that day, and whether their hours still have room. Both the
// month calendar and the time grid ask that question, so the logic lives here
// once — if they answered differently the calendar would offer a day with no
// times on it, which is exactly the dead end this is meant to prevent.
const { query } = require('./_team-db');

const APPT_MINUTES = 120; // every appointment is a 2-hour block

function hToMin(h) {
  const [a, b] = String(h).split(':').map(Number);
  return (a || 0) * 60 + (b || 0);
}

// An artist can take a service if she isn't restricted to a subset, or if the
// service is on her list. A restricted artist with an empty list can't take
// anything — that's a half-finished setup, not "she does everything", and
// silently treating it as everything would put clients in front of someone who
// hasn't been trained on the service.
function covers(member, services) {
  if (!member.restricted) return true;
  if (!services.length) return member.skills.length > 0;
  return services.every(s => member.skills.includes(s));
}

async function loadTeam() {
  const members = await query('SELECT id, name, active, restricted, trainee FROM team_members');
  const skillRows = await query('SELECT team_member_id, service_name FROM worker_skills');
  const byId = {};
  for (const m of members) {
    byId[m.id] = {
      id: Number(m.id),
      name: m.name,
      active: Number(m.active) !== 0,
      restricted: !!Number(m.restricted),
      trainee: !!Number(m.trainee),
      skills: [],
    };
  }
  for (const r of skillRows) {
    if (byId[r.team_member_id]) byId[r.team_member_id].skills.push(r.service_name);
  }
  return Object.values(byId).filter(m => m.active);
}

// Which qualified artists are in on each date in [from, to], and for what hours.
//
// `configured` reports whether any shifts exist at all. Until she has scheduled
// a single day, every caller falls back to the old always-open behaviour — an
// empty table means "not set up yet", never "the studio is closed forever".
// traineeOnly narrows coverage to artists still in training. A client who
// applied the trainee discount is only offered times a trainee can actually
// work — offering them anyone else's slot would mean either honouring the
// discount for a senior artist or taking it away after they had booked.
async function shiftCoverage(from, to, services, traineeOnly) {
  const svc = (services || []).filter(Boolean);
  const [team, rows, countRow] = await Promise.all([
    loadTeam(),
    query('SELECT member_id, date, start_time, end_time, lunch_start, lunch_end FROM tech_shifts WHERE date>=? AND date<=?', [from, to]),
    query('SELECT COUNT(*) AS n FROM tech_shifts'),
  ]);
  const configured = Number((countRow[0] || {}).n || 0) > 0;

  const teamById = {};
  for (const m of team) teamById[m.id] = m;

  const byDate = {};
  for (const r of rows) {
    const m = teamById[Number(r.member_id)];
    if (!m || !covers(m, svc)) continue;
    if (traineeOnly && !m.trainee) continue;
    (byDate[r.date] = byDate[r.date] || []).push({
      id: m.id,
      name: m.name,
      start: r.start_time,
      end: r.end_time,
      lunchStart: r.lunch_start || null,
      lunchEnd: r.lunch_end || null,
    });
  }
  return { configured, byDate };
}

function minToH(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

// How many qualified artists are on the floor during each hour.
//
// This counts *hours worked*, not *appointment start times*. The booking page
// walks the hours a 2-hour block would consume and needs every one of them
// present, so an artist working 9–13 must contribute 9, 10, 11 and 12. Filtering
// to "hours a 2-hour appointment could start" instead would drop 12:00 and take
// the perfectly valid 11:00 start down with it.
function hourCapacity(shifts, slots) {
  const cap = {};
  for (const s of slots) {
    let n = 0;
    for (const sh of shifts || []) {
      if (s < sh.start || s >= sh.end) continue;
      // Lunch removes those hours from her availability. Any length works —
      // a 30-minute break and a three-hour one are the same rule.
      if (sh.lunchStart && sh.lunchEnd && s >= sh.lunchStart && s < sh.lunchEnd) continue;
      n++;
    }
    cap[s] = n;
  }
  return cap;
}

// Existing bookings consume every hour they span, not just their start hour.
function usageByHour(bookedStarts) {
  const use = {};
  for (const t of bookedStarts || []) {
    const s = hToMin(t);
    for (let k = 0; k * 60 < APPT_MINUTES; k++) {
      const h = minToH(s + k * 60);
      use[h] = (use[h] || 0) + 1;
    }
  }
  return use;
}

// Hours with at least one qualified artist still free.
function openHours(slots, cap, use) {
  return slots.filter(s => (cap[s] || 0) > (use[s] || 0));
}

// Of those, the ones where a whole 2-hour appointment actually fits.
function validStarts(hours) {
  const set = new Set(hours);
  return hours.filter(s => {
    for (let k = 0; k * 60 < APPT_MINUTES; k++) {
      if (!set.has(minToH(hToMin(s) + k * 60))) return false;
    }
    return true;
  });
}

module.exports = {
  APPT_MINUTES, hToMin, minToH, covers, loadTeam, shiftCoverage,
  hourCapacity, usageByHour, openHours, validStarts,
};
