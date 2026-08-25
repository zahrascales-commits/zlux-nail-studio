// Importing the studio's real history from the old booking system.
//
// Runs on the server rather than from a laptop, because the database
// credentials live in Vercel and pasting them onto a command line to run a
// script once is how credentials end up in shell history.
//
// Safe to run more than once. Clients match on name and visits match on the
// old system's appointment id, so a second run updates rather than
// duplicates — an import that doubles somebody's history on a re-run is
// worse than one that refuses to run at all.
const fs = require('fs');
const path = require('path');
const { query, queryOne, execute } = require('./_db');

/* ── CSV ──────────────────────────────────────────────────────────────
   A real parser, not split(','). Half these rows carry commas inside
   quoted fields — "10-27-25,  8:00 AM", and service names that list two
   services — and splitting on commas shifts every column after it.   */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map(h => h.trim());
  return rows
    .filter(r => r.some(v => String(v).trim()))
    .map(r => {
      const o = {};
      head.forEach((h, i) => { o[h] = (r[i] == null ? '' : String(r[i]).trim()); });
      return o;
    });
}

// "10-27-25,  8:00 AM" → { date: '2025-10-27', time: '08:00' }
//
// The export space-pads single-digit days — "11- 1-25" rather than
// "11-01-25". Not allowing for that silently dropped 65 of 225
// appointments, which was most of last November.
function splitWhen(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{2,4})\s*,\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return { date: '', time: '' };
  let yr = m[3].length === 2 ? '20' + m[3] : m[3];
  let h = Number(m[4]);
  const ap = (m[6] || '').toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  const pad = n => String(n).padStart(2, '0');
  return { date: yr + '-' + pad(m[1]) + '-' + pad(m[2]), time: pad(h) + ':' + m[5] };
}

function usDate(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const pad = n => String(n).padStart(2, '0');
  return m[3] + '-' + pad(m[1]) + '-' + pad(m[2]);
}

function cents(raw) {
  const n = Number(String(raw || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const key = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function readCsvs() {
  const dir = path.join(__dirname, '..', 'data');
  return {
    clients: parseCsv(fs.readFileSync(path.join(dir, 'zola-clients-2026-08-25.csv'), 'utf8')),
    appts: parseCsv(fs.readFileSync(path.join(dir, 'zola-appointments-2026-08-25.csv'), 'utf8')),
  };
}

function shape() {
  const { clients: clientsCsv, appts: apptsCsv } = readCsvs();

  const visits = apptsCsv.map(a => {
    const when = splitWhen(a['Date of Appointment']);
    return {
      appt_id: a['Appointment ID'] || '',
      client_name: (a['Client Name'] || '').trim(),
      date: when.date,
      time: when.time,
      service: (a['Services'] || '').trim(),
      artist: (a['Service Provided By'] || '').trim(),
      status: (a['Status'] || '').trim().toLowerCase(),
      deposit_cents: cents(a['Deposit Amount']),
      deposit_paid: /^yes$/i.test(a['Deposit Collected'] || '') ? 1 : 0,
    };
  }).filter(v => v.client_name && v.date && v.appt_id);

  const clients = clientsCsv.map(c => ({
    name: (c.client_name || '').trim(),
    total_appointments: Number(c.total_appointments) || 0,
    completed: Number(c.completed) || 0,
    checkout: Number(c.checkout) || 0,
    cancelled: Number(c.cancelled) || 0,
    first_appointment: usDate(c.first_appointment),
    last_appointment: usDate(c.last_appointment),
    most_common_service: (c.most_common_service || '').trim(),
    card_on_file: /^yes$/i.test(c.card_on_file || '') ? 1 : 0,
    card_expiration: (c.card_expiration || '').trim(),
    deposits_cents: cents(c.total_deposits_collected),
  })).filter(c => c.name);

  // Anyone with appointments but no summary row still belongs in the book.
  const known = new Set(clients.map(c => key(c.name)));
  const byName = {};
  for (const v of visits) (byName[key(v.client_name)] = byName[key(v.client_name)] || []).push(v);
  for (const k of Object.keys(byName)) {
    if (known.has(k)) continue;
    const list = byName[k];
    const dates = list.map(v => v.date).sort();
    clients.push({
      name: list[0].client_name,
      total_appointments: list.length, completed: 0, checkout: 0, cancelled: 0,
      first_appointment: dates[0], last_appointment: dates[dates.length - 1],
      most_common_service: list[0].service, card_on_file: 0, card_expiration: '',
      deposits_cents: list.reduce((s, v) => s + (v.deposit_paid ? v.deposit_cents : 0), 0),
    });
  }

  return { clients, visits, csvClients: clientsCsv.length, csvAppts: apptsCsv.length };
}

async function ensureShape() {
  const cols = [
    "ALTER TABLE clients ADD COLUMN total_appointments INTEGER DEFAULT 0",
    "ALTER TABLE clients ADD COLUMN completed_count INTEGER DEFAULT 0",
    "ALTER TABLE clients ADD COLUMN checkout_count INTEGER DEFAULT 0",
    "ALTER TABLE clients ADD COLUMN cancelled_count INTEGER DEFAULT 0",
    "ALTER TABLE clients ADD COLUMN first_appointment TEXT DEFAULT ''",
    "ALTER TABLE clients ADD COLUMN last_appointment TEXT DEFAULT ''",
    "ALTER TABLE clients ADD COLUMN most_common_service TEXT DEFAULT ''",
    "ALTER TABLE clients ADD COLUMN card_on_file INTEGER DEFAULT 0",
    "ALTER TABLE clients ADD COLUMN card_expiration TEXT DEFAULT ''",
    "ALTER TABLE clients ADD COLUMN deposits_cents INTEGER DEFAULT 0",
    "ALTER TABLE clients ADD COLUMN imported_from TEXT DEFAULT ''",
  ];
  for (const sql of cols) { try { await execute(sql); } catch (_) {} }

  // Their history from the old system, kept in its own table so an import can
  // never be mistaken for a booking that went through this site.
  await execute(`CREATE TABLE IF NOT EXISTS client_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appt_id TEXT UNIQUE,
    client_id INTEGER,
    client_name TEXT,
    date TEXT,
    time TEXT,
    service TEXT,
    artist TEXT,
    status TEXT,
    deposit_cents INTEGER DEFAULT 0,
    deposit_paid INTEGER DEFAULT 0,
    source TEXT,
    created_ts INTEGER
  )`);
  try { await execute('CREATE INDEX IF NOT EXISTS idx_cv_name ON client_visits (client_name)'); } catch (_) {}
}

async function run({ dryRun }) {
  const data = shape();
  const report = {
    csv_clients: data.csvClients,
    csv_appointments: data.csvAppts,
    clients_parsed: data.clients.length,
    visits_parsed: data.visits.length,
    dropped_appointments: data.csvAppts - data.visits.length,
  };
  if (dryRun) return { ...report, dry_run: true };

  await ensureShape();

  let added = 0, updated = 0;
  const idByName = {};
  for (const c of data.clients) {
    const existing = await queryOne('SELECT id FROM clients WHERE lower(name)=lower(?)', [c.name]);
    if (existing) {
      await execute(
        `UPDATE clients SET total_appointments=?, completed_count=?, checkout_count=?, cancelled_count=?,
           first_appointment=?, last_appointment=?, most_common_service=?, card_on_file=?,
           card_expiration=?, deposits_cents=?, imported_from=?, visits=?, last_service=?, last_visit=?
         WHERE id=?`,
        [c.total_appointments, c.completed, c.checkout, c.cancelled, c.first_appointment,
         c.last_appointment, c.most_common_service, c.card_on_file, c.card_expiration,
         c.deposits_cents, 'zola-2026-08-25', c.total_appointments, c.most_common_service,
         c.last_appointment, existing.id]);
      idByName[key(c.name)] = existing.id;
      updated++;
    } else {
      const r = await execute(
        `INSERT INTO clients (name, email, phone, visits, last_service, last_visit, marketing_opt_in, created_ts,
           total_appointments, completed_count, checkout_count, cancelled_count, first_appointment,
           last_appointment, most_common_service, card_on_file, card_expiration, deposits_cents, imported_from)
         VALUES (?,'','',?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [c.name, c.total_appointments, c.most_common_service, c.last_appointment, Date.now(),
         c.total_appointments, c.completed, c.checkout, c.cancelled, c.first_appointment,
         c.last_appointment, c.most_common_service, c.card_on_file, c.card_expiration,
         c.deposits_cents, 'zola-2026-08-25']);
      idByName[key(c.name)] = r.lastInsertRowid;
      added++;
    }
  }

  let vWritten = 0, vFailed = 0;
  for (const v of data.visits) {
    try {
      await execute(
        `INSERT INTO client_visits (appt_id, client_id, client_name, date, time, service, artist,
           status, deposit_cents, deposit_paid, source, created_ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(appt_id) DO UPDATE SET
           client_id=excluded.client_id, date=excluded.date, time=excluded.time,
           service=excluded.service, artist=excluded.artist, status=excluded.status`,
        [v.appt_id, idByName[key(v.client_name)] || 0, v.client_name, v.date, v.time, v.service,
         v.artist, v.status, v.deposit_cents, v.deposit_paid, 'zola-2026-08-25', Date.now()]);
      vWritten++;
    } catch (_) { vFailed++; }
  }

  const tc = await queryOne('SELECT COUNT(*) AS n FROM clients');
  const tv = await queryOne('SELECT COUNT(*) AS n FROM client_visits');

  return {
    ...report,
    clients_added: added,
    clients_updated: updated,
    visits_written: vWritten,
    visits_failed: vFailed,
    clients_table_total: Number(tc.n),
    visits_table_total: Number(tv.n),
  };
}

module.exports = { run, shape, parseCsv, splitWhen, ensureShape };
