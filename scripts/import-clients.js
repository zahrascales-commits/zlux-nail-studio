// One-time import of the studio's real client history.
//
// Two exports, both from the old booking system:
//   data/zola-clients-2026-08-25.csv       — one row per client (the summary)
//   data/zola-appointments-2026-08-25.csv  — one row per appointment (the history)
//
// The summary tells us who the clients are. The appointments tell us what
// actually happened, which is what a client sees when she logs in — so both
// are needed and neither is enough on its own.
//
// Written to be safe to run twice: clients match on name, visits match on
// their booking-system appointment id. Re-running updates rather than
// duplicating, because an import that doubles a client's history on a second
// run is worse than one that fails.
//
//   node scripts/import-clients.js            (dry run — shows what it would do)
//   node scripts/import-clients.js --write    (actually writes)
const fs = require('fs');
const path = require('path');

const WRITE = process.argv.includes('--write');
const ROOT = path.join(__dirname, '..');

/* ── CSV ──────────────────────────────────────────────────────────────
   A real parser rather than split(','). Half these rows have commas
   inside quoted fields — "10-27-25,  8:00 AM" and multi-service names —
   and splitting on commas silently shifts every later column.        */
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
// appointments, which is most of last November.
function splitWhen(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{2,4})\s*,\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return { date: '', time: '' };
  let [, mo, da, yr, hh, mi, ap] = m;
  yr = yr.length === 2 ? '20' + yr : yr;
  let h = Number(hh);
  if (ap) {
    const up = ap.toUpperCase();
    if (up === 'PM' && h !== 12) h += 12;
    if (up === 'AM' && h === 12) h = 0;
  }
  const pad = n => String(n).padStart(2, '0');
  return { date: yr + '-' + pad(mo) + '-' + pad(da), time: pad(h) + ':' + mi };
}

// "08/12/2026" → "2026-08-12"
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

async function main() {
  const clientsCsv = parseCsv(fs.readFileSync(path.join(ROOT, 'data/zola-clients-2026-08-25.csv'), 'utf8'));
  const apptsCsv = parseCsv(fs.readFileSync(path.join(ROOT, 'data/zola-appointments-2026-08-25.csv'), 'utf8'));

  console.log('read ' + clientsCsv.length + ' clients and ' + apptsCsv.length + ' appointments');

  // Names in the two files are the join key, so normalise once, here.
  const key = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

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
      source: 'import-2026-08-25',
    };
  }).filter(v => v.client_name && v.date);

  const byClient = {};
  for (const v of visits) (byClient[key(v.client_name)] = byClient[key(v.client_name)] || []).push(v);

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
  const extras = Object.keys(byClient).filter(k => !known.has(k));
  for (const k of extras) {
    const list = byClient[k];
    const dates = list.map(v => v.date).sort();
    clients.push({
      name: list[0].client_name,
      total_appointments: list.length, completed: 0, checkout: 0, cancelled: 0,
      first_appointment: dates[0], last_appointment: dates[dates.length - 1],
      most_common_service: list[0].service, card_on_file: 0, card_expiration: '',
      deposits_cents: list.reduce((s, v) => s + (v.deposit_paid ? v.deposit_cents : 0), 0),
      from_appointments_only: true,
    });
  }

  console.log('');
  console.log('  clients from the summary : ' + clientsCsv.length);
  console.log('  clients seen only in the appointment export : ' + extras.length
    + (extras.length ? '  (' + extras.slice(0, 6).join(', ') + (extras.length > 6 ? '…' : '') + ')' : ''));
  console.log('  clients to write         : ' + clients.length);
  console.log('  visits to write          : ' + visits.length);
  const unmatched = visits.filter(v => !clients.some(c => key(c.name) === key(v.client_name)));
  console.log('  visits with no client    : ' + unmatched.length);

  const withTime = visits.filter(v => v.time).length;
  console.log('  visits with a usable time: ' + withTime + ' of ' + visits.length);

  if (!WRITE) {
    console.log('');
    console.log('DRY RUN — nothing written. Re-run with --write to import.');
    console.log('');
    console.log('sample visit:', JSON.stringify(visits[0], null, 2));
    return;
  }

  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.log('');
    console.log('Refusing to write: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are not set.');
    console.log('This script writes to the live studio database, so it will not guess.');
    process.exit(1);
  }

  const { query, queryOne, execute } = require(path.join(ROOT, 'api/_db.js'));

  // Columns the old system had and this one did not. Added one at a time so
  // a column that already exists does not abort the rest.
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

  // Their real history, kept separate from bookings made on this site so an
  // import can never be mistaken for a booking that went through here.
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

  let added = 0, updated = 0;
  const idByName = {};
  for (const c of clients) {
    const existing = await queryOne('SELECT id FROM clients WHERE lower(name)=lower(?)', [c.name]);
    if (existing) {
      await execute(
        `UPDATE clients SET total_appointments=?, completed_count=?, checkout_count=?, cancelled_count=?,
           first_appointment=?, last_appointment=?, most_common_service=?, card_on_file=?,
           card_expiration=?, deposits_cents=?, imported_from=?, visits=?
         WHERE id=?`,
        [c.total_appointments, c.completed, c.checkout, c.cancelled, c.first_appointment,
         c.last_appointment, c.most_common_service, c.card_on_file, c.card_expiration,
         c.deposits_cents, 'zola-2026-08-25', c.total_appointments, existing.id]);
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

  let vAdded = 0, vSkipped = 0;
  for (const v of visits) {
    const cid = idByName[key(v.client_name)] || 0;
    try {
      const r = await execute(
        `INSERT INTO client_visits (appt_id, client_id, client_name, date, time, service, artist,
           status, deposit_cents, deposit_paid, source, created_ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(appt_id) DO UPDATE SET
           client_id=excluded.client_id, date=excluded.date, time=excluded.time,
           service=excluded.service, artist=excluded.artist, status=excluded.status`,
        [v.appt_id, cid, v.client_name, v.date, v.time, v.service, v.artist,
         v.status, v.deposit_cents, v.deposit_paid, v.source, Date.now()]);
      if (r.rowsAffected) vAdded++; else vSkipped++;
    } catch (err) { vSkipped++; }
  }

  const total = await queryOne('SELECT COUNT(*) AS n FROM clients');
  const totalV = await queryOne('SELECT COUNT(*) AS n FROM client_visits');

  console.log('');
  console.log('  clients added   : ' + added);
  console.log('  clients updated : ' + updated);
  console.log('  visits written  : ' + vAdded + (vSkipped ? '  (' + vSkipped + ' skipped)' : ''));
  console.log('');
  console.log('  clients table now holds : ' + Number(total.n));
  console.log('  client_visits now holds : ' + Number(totalV.n));
}

main().catch(err => { console.error(err); process.exit(1); });
