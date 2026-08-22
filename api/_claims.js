// First-to-confirm dispatch.
//
// A booking with no artist chosen by the client goes out to everyone who
// could actually take it, and the first one to tap Confirm gets it. "Could
// actually take it" is three tests, all of which have to pass:
//
//   · she is trained on that service
//   · she is rostered in for every hour the appointment spans, lunch excluded
//   · she has nothing else booked across that window
//
// Offering it to someone who fails any of those means the race can be won by
// a person who cannot do the job, so the filter runs before a single phone
// buzzes — not after.
//
// The client is told their artist is being assigned, and only gets the full
// confirmation naming their provider once somebody has actually taken it.
const teamDb = require('./_team-db');
const { query, queryOne, execute } = teamDb;
const shifts = require('./_shifts');
const push = require('./_push');
const notify = require('./_notify');

const SITE = process.env.PUBLIC_SITE_URL || 'https://zolanailstudio.com';

// How long a booking stays up for grabs before the studio assigns it itself.
// A client waiting on a confirmation is the thing being protected here, so
// this is deliberately short and Zahra can change it in Settings.
const DEFAULT_HOLD_MINUTES = 15;

let _ready = false;
async function ensureClaimTables() {
  if (_ready) return;
  await teamDb.ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS booking_claims (
    confirmation TEXT PRIMARY KEY,
    team_appointment_id INTEGER,
    service TEXT,
    date TEXT,
    time TEXT,
    date_label TEXT,
    time_label TEXT,
    client_name TEXT,
    client_phone TEXT,
    client_email TEXT,
    offered TEXT,
    claimed_by INTEGER,
    claimed_ts INTEGER,
    status TEXT DEFAULT 'open',
    how TEXT,
    created_ts INTEGER,
    expires_ts INTEGER
  )`);
  _ready = true;
}

async function holdMinutes() {
  try {
    const row = await queryOne("SELECT value FROM site_settings WHERE key='claim_hold_minutes'");
    const n = Number(row && row.value);
    if (Number.isFinite(n) && n >= 1 && n <= 240) return n;
  } catch (_) {}
  return DEFAULT_HOLD_MINUTES;
}

// Every hour a 2-hour appointment starting at `time` will occupy.
function spanOf(time) {
  const out = [];
  for (let k = 0; k * 60 < shifts.APPT_MINUTES; k++) {
    out.push(shifts.minToH(shifts.hToMin(time) + k * 60));
  }
  return out;
}

function overlaps(aStart, bStart) {
  return Math.abs(shifts.hToMin(aStart) - shifts.hToMin(bStart)) < shifts.APPT_MINUTES;
}

// Who can genuinely take this appointment.
async function eligibleFor(date, time, service, traineeOnly) {
  const svc = service ? [service] : [];
  const cov = await shifts.shiftCoverage(date, date, svc, !!traineeOnly);

  let candidates;
  if (!cov.configured) {
    // No roster has ever been set. An empty shift table means "not set up
    // yet", never "nobody works here" — so fall back to everyone qualified
    // rather than dispatching a booking to nobody at all.
    const team = await shifts.loadTeam();
    candidates = team
      .filter(m => shifts.covers(m, svc))
      .filter(m => !traineeOnly || m.trainee)
      .map(m => ({ id: m.id, name: m.name }));
  } else {
    const need = spanOf(time);
    candidates = (cov.byDate[date] || [])
      .filter(sh => need.every(h =>
        h >= sh.start && h < sh.end &&
        !(sh.lunchStart && sh.lunchEnd && h >= sh.lunchStart && h < sh.lunchEnd)))
      .map(sh => ({ id: sh.id, name: sh.name }));
  }

  // Drop anyone whose day already collides with this window.
  let booked = [];
  try {
    booked = await query(
      "SELECT team_member_id, time FROM team_appointments WHERE date=? AND LOWER(COALESCE(status,'scheduled'))<>'cancelled'",
      [date]);
  } catch (_) {}
  const busy = new Set();
  for (const b of booked) {
    if (!b.team_member_id || !b.time) continue;
    if (overlaps(String(b.time), String(time))) busy.add(Number(b.team_member_id));
  }

  const seen = new Set();
  return candidates.filter(c => {
    if (busy.has(Number(c.id)) || seen.has(Number(c.id))) return false;
    seen.add(Number(c.id));
    return true;
  });
}

async function contactFor(ids) {
  if (!ids.length) return [];
  const rows = await query('SELECT id, name, phone, email FROM team_members WHERE active=1');
  const want = new Set(ids.map(Number));
  return rows.filter(r => want.has(Number(r.id)));
}

/* ── OPENING A BOOKING FOR CLAIM ───────────────────────────────────── */

// `a` is the same shape notifyNewAppointment takes, plus teamApptId.
async function openClaim(a) {
  await ensureClaimTables();
  const eligible = await eligibleFor(a.date, a.time, a.service, a.traineeOnly);
  const ids = eligible.map(e => Number(e.id));
  const mins = await holdMinutes();
  const now = Date.now();

  await execute(
    `INSERT INTO booking_claims
       (confirmation, team_appointment_id, service, date, time, date_label, time_label,
        client_name, client_phone, client_email, offered, status, created_ts, expires_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(confirmation) DO NOTHING`,
    [a.confirmation, a.teamApptId ? Number(a.teamApptId) : null, a.service || '', a.date, a.time,
     a.dateLabel || a.date, a.timeLabel || a.time,
     a.clientName || '', a.clientPhone || '', a.clientEmail || '',
     JSON.stringify(ids), ids.length ? 'open' : 'none', now, now + mins * 60000]);

  const when = `${a.dateLabel || a.date} at ${a.timeLabel || a.time}`;

  // Nobody qualified is free. The client still gets confirmed — the studio
  // owes them that — but Zahra is told plainly that it needs a person.
  if (!ids.length) {
    await notify.notifyInApp('owner', null,
      `Needs an artist ✦ ${a.clientName || 'Client'}`,
      `${a.service || 'Service'} — ${when}. Nobody rostered is free for this. Assign someone.`);
    await push.pushToOwner({
      title: 'Booking needs an artist',
      body: `${a.clientName || 'Client'} · ${a.service || ''} · ${when}`,
      url: '/manager.html', tag: 'zola-unassigned',
    });
    await notify.notifyClientPending(a);
    return { offered: 0, status: 'none' };
  }

  // Everyone eligible, all at once. Push first (it lands on a locked screen),
  // then text as the backstop for a phone that never set push up.
  const people = await contactFor(ids);
  const link = `${SITE}/team.html`;
  await push.pushToMembers(ids, {
    title: `Open appointment · ${a.service || 'Service'}`,
    body: `${when} · ${a.clientName || 'Client'} — first to confirm takes it`,
    url: '/team.html?jobs=1',
    tag: 'zola-job-' + a.confirmation,
    data: { confirmation: a.confirmation },
    requireInteraction: true,
  });

  await Promise.all(people.map(async (p) => {
    await notify.notifyInApp('member', p.id,
      `Open appointment ✦ ${a.service || 'Service'}`,
      `${when} · ${a.clientName || 'Client'} — first to confirm takes it.`);
    if (p.phone) {
      let mine = link;
      try { mine = await require('./_worker-link').linkFor(p.id); } catch (_) {}
      await notify.sendSMS(p.phone,
        `ZOLA: open appointment. ${a.service || 'Service'}, ${when}. ` +
        `First to confirm takes it: ${mine}`);
    }
  }));

  await notify.notifyInApp('owner', null,
    `Offered to ${ids.length} ✦ ${a.clientName || 'Client'}`,
    `${a.service || 'Service'} — ${when}. Waiting on whoever confirms first.`);
  await push.pushToOwner({
    title: `Sent to ${ids.length} artist${ids.length === 1 ? '' : 's'}`,
    body: `${a.clientName || 'Client'} · ${a.service || ''} · ${when}`,
    url: '/manager.html', tag: 'zola-offered',
  });

  await notify.notifyClientPending(a);
  return { offered: ids.length, status: 'open', names: eligible.map(e => e.name) };
}

/* ── WINNING IT ────────────────────────────────────────────────────── */

// Hands the appointment to one artist and tells everyone who needs to know.
async function assign(row, memberId, how) {
  const member = await queryOne('SELECT id, name, phone, email FROM team_members WHERE id=?', [Number(memberId)]);
  const when = `${row.date_label || row.date} at ${row.time_label || row.time}`;

  if (row.team_appointment_id) {
    await execute('UPDATE team_appointments SET team_member_id=? WHERE id=?',
      [Number(memberId), Number(row.team_appointment_id)]).catch(() => {});
  }
  // The main appointments table keys off the separate `staff` table, so this
  // only lands if that artist also exists there. Missing is not an error.
  try {
    const { execute: dbExec, queryOne: dbOne } = require('./_db');
    const staff = member && await dbOne('SELECT id FROM staff WHERE name=?', [member.name]);
    if (staff) {
      await dbExec('UPDATE appointments SET staff_id=? WHERE appointment_date=? AND appointment_time=? AND staff_id IS NULL',
        [staff.id, row.date, row.time]);
    }
  } catch (_) {}

  // The client's real confirmation — now it can name their provider.
  await notify.notifyClientConfirmed({
    clientName: row.client_name,
    clientEmail: row.client_email,
    clientPhone: row.client_phone,
    service: row.service,
    date: row.date, time: row.time,
    dateLabel: row.date_label, timeLabel: row.time_label,
    memberName: member ? member.name : null,
    confirmation: row.confirmation,
  });

  // The winner
  if (member) {
    let mine = `${SITE}/team.html`;
    try { mine = await require('./_worker-link').linkFor(member.id); } catch (_) {}
    await notify.notifyInApp('member', member.id,
      `It's yours ✦ ${row.client_name || 'Client'}`,
      `${row.service || 'Service'} — ${when}.`);
    await push.pushToMember(member.id, {
      title: how === 'auto' ? 'Assigned to you' : "It's yours",
      body: `${row.client_name || 'Client'} · ${row.service || ''} · ${when}`,
      url: '/team.html', tag: 'zola-job-' + row.confirmation,
    });
    if (member.phone) {
      await notify.sendSMS(member.phone,
        (how === 'auto'
          ? `ZOLA: this one is yours — nobody claimed it in time. `
          : `ZOLA: confirmed, this one is yours. `) +
        `${row.client_name || 'Client'}, ${row.service || ''}, ${when}. ${mine}`);
    }
  }

  // Everyone else who was in the running, so nobody drives in for a booking
  // they no longer have.
  const others = JSON.parse(row.offered || '[]').map(Number).filter(id => id !== Number(memberId));
  if (others.length) {
    await push.pushToMembers(others, {
      title: 'Appointment taken',
      body: `${row.service || 'Service'} · ${when} — ${member ? member.name : 'someone'} got it`,
      url: '/team.html', tag: 'zola-job-' + row.confirmation,
    });
    await Promise.all(others.map(id => notify.notifyInApp('member', id,
      'Appointment taken',
      `${row.service || 'Service'} — ${when}. ${member ? member.name : 'Someone'} confirmed it first.`)));
  }

  await notify.notifyInApp('owner', null,
    `${member ? member.name : 'Artist'} took ${row.client_name || 'a booking'}`,
    `${row.service || 'Service'} — ${when}${how === 'auto' ? ' (auto-assigned, nobody claimed it)' : ''}.`);
  await push.pushToOwner({
    title: `${member ? member.name : 'Artist'} ${how === 'auto' ? 'was assigned' : 'took it'}`,
    body: `${row.client_name || 'Client'} · ${row.service || ''} · ${when}`,
    url: '/manager.html', tag: 'zola-assigned',
  });
}

// First one in wins. The UPDATE is the race: only one caller can move
// claimed_by off NULL, so two artists tapping at the same moment cannot both
// be told they got it.
async function claim(confirmation, memberId) {
  await ensureClaimTables();
  const row = await queryOne('SELECT * FROM booking_claims WHERE confirmation=?', [String(confirmation)]);
  if (!row) return { ok: false, why: 'That appointment is no longer listed.' };

  const offered = JSON.parse(row.offered || '[]').map(Number);
  if (!offered.includes(Number(memberId))) {
    return { ok: false, why: 'This one was not offered to you — check your hours and services.' };
  }

  const r = await execute(
    "UPDATE booking_claims SET claimed_by=?, claimed_ts=?, status='claimed', how='claimed' WHERE confirmation=? AND claimed_by IS NULL",
    [Number(memberId), Date.now(), String(confirmation)]);

  if (!r.rowsAffected) {
    const now = await queryOne('SELECT claimed_by FROM booking_claims WHERE confirmation=?', [String(confirmation)]);
    const who = now && now.claimed_by
      ? await queryOne('SELECT name FROM team_members WHERE id=?', [Number(now.claimed_by)])
      : null;
    return { ok: false, taken: true, why: who ? `${who.name} confirmed it first.` : 'Someone confirmed it first.' };
  }

  await assign(row, memberId, 'claimed');
  return { ok: true, why: 'Confirmed — the client has been told you are their artist.' };
}

/* ── NOBODY CLAIMED IT ─────────────────────────────────────────────── */

// Serverless has no background timer, so the sweep runs off the back of
// ordinary traffic: opening the portal or the manager is enough to trigger
// it. Cheap enough (one indexed read) to sit on any request.
async function sweep() {
  try {
    await ensureClaimTables();
    const due = await query(
      "SELECT * FROM booking_claims WHERE status='open' AND claimed_by IS NULL AND expires_ts<=?",
      [Date.now()]);
    for (const row of due) {
      const offered = JSON.parse(row.offered || '[]').map(Number);
      if (!offered.length) {
        await execute("UPDATE booking_claims SET status='none' WHERE confirmation=?", [row.confirmation]);
        continue;
      }
      // Whoever has the lightest day, so auto-assigning does not always land
      // on the same person.
      let counts = [];
      try {
        counts = await query(
          "SELECT team_member_id, COUNT(*) AS n FROM team_appointments WHERE date=? AND LOWER(COALESCE(status,'scheduled'))<>'cancelled' GROUP BY team_member_id",
          [row.date]);
      } catch (_) {}
      const load = {};
      for (const c of counts) load[Number(c.team_member_id)] = Number(c.n) || 0;
      const pick = offered.slice().sort((a, b) => (load[a] || 0) - (load[b] || 0))[0];

      const r = await execute(
        "UPDATE booking_claims SET claimed_by=?, claimed_ts=?, status='claimed', how='auto' WHERE confirmation=? AND claimed_by IS NULL",
        [pick, Date.now(), row.confirmation]);
      if (r.rowsAffected) await assign(row, pick, 'auto');
    }
    return due.length;
  } catch (_) { return 0; }
}

// What an artist should see as up for grabs right now.
async function openJobsFor(memberId) {
  await ensureClaimTables();
  await sweep();
  const rows = await query(
    "SELECT * FROM booking_claims WHERE status='open' AND claimed_by IS NULL ORDER BY date, time");
  return rows
    .filter(r => JSON.parse(r.offered || '[]').map(Number).includes(Number(memberId)))
    .map(r => ({
      confirmation: r.confirmation,
      service: r.service,
      date: r.date,
      time: r.time,
      date_label: r.date_label,
      time_label: r.time_label,
      client_name: r.client_name,
      offered_to: JSON.parse(r.offered || '[]').length,
      expires_ts: Number(r.expires_ts) || 0,
    }));
}

// The owner's view: everything still open, plus what happened to the rest.
async function claimsOverview() {
  await ensureClaimTables();
  await sweep();
  const rows = await query('SELECT * FROM booking_claims ORDER BY created_ts DESC LIMIT 60');
  const names = {};
  try {
    for (const m of await query('SELECT id, name FROM team_members')) names[Number(m.id)] = m.name;
  } catch (_) {}
  return {
    hold_minutes: await holdMinutes(),
    rows: rows.map(r => ({
      confirmation: r.confirmation,
      service: r.service,
      when: `${r.date_label || r.date} at ${r.time_label || r.time}`,
      date: r.date, time: r.time,
      client_name: r.client_name,
      status: r.status,
      how: r.how || '',
      offered_names: JSON.parse(r.offered || '[]').map(id => names[Number(id)] || ('#' + id)),
      claimed_name: r.claimed_by ? (names[Number(r.claimed_by)] || ('#' + r.claimed_by)) : '',
      expires_ts: Number(r.expires_ts) || 0,
    })),
  };
}

// Zahra overriding the race — she can hand a booking to whoever she wants.
async function assignManually(confirmation, memberId) {
  await ensureClaimTables();
  const row = await queryOne('SELECT * FROM booking_claims WHERE confirmation=?', [String(confirmation)]);
  if (!row) return { ok: false, why: 'Not found' };
  await execute(
    "UPDATE booking_claims SET claimed_by=?, claimed_ts=?, status='claimed', how='manual' WHERE confirmation=?",
    [Number(memberId), Date.now(), String(confirmation)]);
  await assign(row, memberId, 'manual');
  return { ok: true };
}

module.exports = {
  ensureClaimTables, eligibleFor, openClaim, claim, sweep,
  openJobsFor, claimsOverview, assignManually, holdMinutes,
};
