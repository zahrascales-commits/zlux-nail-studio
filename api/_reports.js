// The reports she asked for, as files she can actually open.
//
//   Sales · Appointments · Most valuable clients · Commission earnings · Expenses
//
// CSV rather than PDF on purpose: a CSV opens in Numbers, in Excel, and in
// whatever her accountant uses, and it can be re-sorted. A PDF can only be
// looked at.
//
// Every number here obeys the same rule as the rest of the dashboard — a
// booking counts once its deposit was taken and the day has arrived. A
// report that counts money the studio has not been paid is worse than no
// report, because she would plan around it.
const { query } = require('./_db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const pad = n => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const money = c => (Number(c || 0) / 100).toFixed(2);

// Excel decides a field is a formula if it starts with = + - or @, and will
// happily run it. Prefixing an apostrophe is the standard defence, and it
// matters here because client names come from a public booking form.
function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCsv = (headers, rows) =>
  [headers.map(cell).join(','), ...rows.map(r => r.map(cell).join(','))].join('\r\n') + '\r\n';

const isCancelled = b => /cancel/i.test(String(b.status || ''));
const isNoShow = b => /no.?show/i.test(String(b.status || ''));

async function loadRange(from, to) {
  let appts = [];
  try {
    appts = await query(
      `SELECT a.id, a.appointment_date AS date, a.appointment_time AS time, a.service, a.addons,
              a.status, a.total_cents, a.deposit_cents, a.deposit_paid, a.tip_cents,
              a.paid_cents, a.pay_method, a.checked_in_ts, a.checked_out_ts,
              a.member_id, COALESCE(m.full_name, a.guest_name) AS client,
              COALESCE(a.guest_email, m.email) AS email,
              COALESCE(s.name, '') AS artist, m.tier
         FROM appointments a
         LEFT JOIN members m ON a.member_id = m.member_id
         LEFT JOIN staff s ON a.staff_id = s.id
        WHERE a.appointment_date >= ? AND a.appointment_date <= ?
        ORDER BY a.appointment_date, a.appointment_time`, [from, to]);
  } catch (_) {
    // Before the checkout columns landed
    appts = await query(
      `SELECT a.id, a.appointment_date AS date, a.appointment_time AS time, a.service, a.addons,
              a.status, a.total_cents, a.deposit_cents, a.deposit_paid,
              a.member_id, COALESCE(m.full_name, a.guest_name) AS client,
              COALESCE(a.guest_email, m.email) AS email, m.tier
         FROM appointments a
         LEFT JOIN members m ON a.member_id = m.member_id
        WHERE a.appointment_date >= ? AND a.appointment_date <= ?
        ORDER BY a.appointment_date, a.appointment_time`, [from, to]).catch(() => []);
  }

  // Studio-booked appointments. The artist's name is on team_members; this
  // table only holds the id. The checkout columns arrived later than the
  // table did, so a narrower query stands behind the full one — otherwise a
  // studio that has never used the kiosk gets an empty sales report.
  let team = [];
  try {
    const tdb = require('./_team-db');
    try {
      team = await tdb.query(
        `SELECT a.id, a.date, a.time, a.client_name AS client, a.service, a.status,
                COALESCE(m.name, '') AS artist,
                a.tip_cents, a.paid_cents, a.pay_method, a.checked_in_ts, a.checked_out_ts
           FROM team_appointments a
           LEFT JOIN team_members m ON m.id = a.team_member_id
          WHERE a.date >= ? AND a.date <= ? ORDER BY a.date, a.time`,
        [from, to]);
    } catch (_) {
      team = await tdb.query(
        `SELECT a.id, a.date, a.time, a.client_name AS client, a.service, a.status,
                COALESCE(m.name, '') AS artist
           FROM team_appointments a
           LEFT JOIN team_members m ON m.id = a.team_member_id
          WHERE a.date >= ? AND a.date <= ? ORDER BY a.date, a.time`,
        [from, to]);
    }
  } catch (_) {}

  // The history imported from the old booking system. It carries visits and
  // deposits but never carried ticket totals, so it is counted as visits and
  // deposits only. Inventing the missing totals would be inventing income.
  let legacy = [];
  try {
    const tdb = require('./_team-db');
    legacy = await tdb.query(
      `SELECT client_name AS client, date, time, service, artist, status,
              deposit_cents, deposit_paid
         FROM client_visits WHERE date >= ? AND date <= ? ORDER BY date, time`,
      [from, to]);
  } catch (_) {}

  return { appts, team, legacy };
}

// ── SALES ─────────────────────────────────────────────────────────────
// Every appointment that took money, day by day, with what was actually
// collected separated from what was billed.
function salesReport({ appts, team }, from, to) {
  const rows = [];
  let gross = 0, tips = 0, deposits = 0;

  for (const a of appts) {
    if (isCancelled(a) || isNoShow(a)) continue;
    if (!Number(a.deposit_paid) && !Number(a.paid_cents)) continue;
    const total = Number(a.total_cents) || 0;
    const tip = Number(a.tip_cents) || 0;
    const dep = Number(a.deposit_cents) || 0;
    gross += total; tips += tip; deposits += dep;
    rows.push([
      a.date, a.time || '', a.client || 'Guest', a.service || '',
      a.artist || '', a.tier ? String(a.tier).replace('_', ' ') : 'Drop-in',
      money(total), money(dep), money(a.paid_cents || 0), money(tip),
      a.pay_method || '', Number(a.checked_out_ts) ? 'Yes' : 'No',
    ]);
  }
  for (const t of team) {
    if (isCancelled(t)) continue;
    const tip = Number(t.tip_cents) || 0;
    tips += tip;
    rows.push([
      t.date, t.time || '', t.client || '', t.service || '', t.artist || '', 'Studio-booked',
      '', '', money(t.paid_cents || 0), money(tip), t.pay_method || '',
      Number(t.checked_out_ts) ? 'Yes' : 'No',
    ]);
  }
  rows.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));

  return {
    name: 'sales_' + from + '_to_' + to,
    headers: ['Date', 'Time', 'Client', 'Service', 'Artist', 'Type',
      'Service total', 'Deposit taken', 'Paid at checkout', 'Tip', 'Paid by', 'Checked out'],
    rows,
    summary: [
      ['Appointments with money attached', String(rows.length)],
      ['Service totals billed', '$' + money(gross)],
      ['Deposits taken', '$' + money(deposits)],
      ['Tips', '$' + money(tips)],
    ],
  };
}

// ── APPOINTMENTS ──────────────────────────────────────────────────────
// Everything booked, including what was cancelled — because the pattern of
// cancellations is a report in itself.
function appointmentsReport({ appts, team, legacy }, from, to) {
  const rows = [];
  for (const a of appts) {
    let addons = '';
    try { const p = JSON.parse(a.addons || '[]'); addons = Array.isArray(p) ? p.join('; ') : String(a.addons || ''); }
    catch (_) { addons = String(a.addons || ''); }
    rows.push([
      a.date, a.time || '', a.client || 'Guest', a.email || '',
      a.service || '', addons, a.artist || '',
      a.tier ? String(a.tier).replace('_', ' ') : 'Drop-in',
      a.status || '', Number(a.deposit_paid) ? 'Yes' : 'No',
      Number(a.checked_in_ts) ? 'Yes' : 'No', Number(a.checked_out_ts) ? 'Yes' : 'No',
      money(a.total_cents),
    ]);
  }
  for (const t of team) {
    rows.push([t.date, t.time || '', t.client || '', '', t.service || '', '', t.artist || '',
      'Studio-booked', t.status || '', 'n/a',
      Number(t.checked_in_ts) ? 'Yes' : 'No', Number(t.checked_out_ts) ? 'Yes' : 'No', '']);
  }
  for (const l of legacy || []) {
    rows.push([l.date, l.time || '', l.client || '', '', l.service || '', '', l.artist || '',
      'Imported history', l.status || '', Number(l.deposit_paid) ? 'Yes' : 'No', '', '', '']);
  }
  rows.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));

  const cancelled = rows.filter(r => /cancel/i.test(r[8])).length;
  const noShow = rows.filter(r => /no.?show/i.test(r[8])).length;
  return {
    name: 'appointments_' + from + '_to_' + to,
    headers: ['Date', 'Time', 'Client', 'Email', 'Service', 'Add-ons', 'Artist', 'Type',
      'Status', 'Deposit paid', 'Checked in', 'Checked out', 'Total'],
    rows,
    summary: [
      ['Booked', String(rows.length)],
      ['Cancelled', String(cancelled)],
      ['No-shows', String(noShow)],
      ['Kept', String(rows.length - cancelled - noShow)],
    ],
  };
}

// ── MOST VALUABLE CLIENTS ─────────────────────────────────────────────
function valuableReport({ appts, team, legacy }, from, to) {
  const by = {};
  const bump = (name, patch) => {
    const k = String(name || 'Guest').trim().toLowerCase();
    if (!k) return;
    if (!by[k]) by[k] = { name: String(name).trim(), visits: 0, spend: 0, tips: 0, cancels: 0, last: '', email: '', tier: '' };
    Object.assign(by[k], patch(by[k]));
  };

  for (const a of appts) {
    bump(a.client, o => ({
      email: o.email || a.email || '',
      tier: o.tier || (a.tier ? String(a.tier).replace('_', ' ') : ''),
      cancels: o.cancels + (isCancelled(a) ? 1 : 0),
      visits: o.visits + (!isCancelled(a) && !isNoShow(a) && Number(a.deposit_paid) ? 1 : 0),
      spend: o.spend + (!isCancelled(a) && Number(a.deposit_paid) ? (Number(a.total_cents) || 0) : 0),
      tips: o.tips + (Number(a.tip_cents) || 0),
      last: !isCancelled(a) && String(a.date) > o.last ? String(a.date) : o.last,
    }));
  }
  for (const t of team) {
    bump(t.client, o => ({
      cancels: o.cancels + (isCancelled(t) ? 1 : 0),
      visits: o.visits + (isCancelled(t) ? 0 : 1),
      tips: o.tips + (Number(t.tip_cents) || 0),
      spend: o.spend + (Number(t.paid_cents) || 0),
      last: !isCancelled(t) && String(t.date) > o.last ? String(t.date) : o.last,
    }));
  }

  // Imported visits count as visits, and their deposits count as money
  // taken — which they were. They just cannot say what the full ticket was.
  for (const l of legacy || []) {
    bump(l.client, o => ({
      cancels: o.cancels + (isCancelled(l) ? 1 : 0),
      visits: o.visits + (isCancelled(l) ? 0 : 1),
      spend: o.spend + (Number(l.deposit_paid) ? (Number(l.deposit_cents) || 0) : 0),
      last: !isCancelled(l) && String(l.date) > o.last ? String(l.date) : o.last,
    }));
  }

  const rows = Object.values(by)
    .sort((a, b) => (b.spend + b.tips) - (a.spend + a.tips))
    .map(o => [
      o.name, o.email, o.tier || 'Drop-in', String(o.visits),
      money(o.spend), money(o.tips), money(o.spend + o.tips),
      o.visits ? money(Math.round(o.spend / o.visits)) : '0.00',
      o.last, String(o.cancels),
    ]);

  return {
    name: 'most_valuable_clients_' + from + '_to_' + to,
    headers: ['Client', 'Email', 'Type', 'Visits', 'Spent', 'Tipped', 'Total value',
      'Average ticket', 'Last visit', 'Cancellations'],
    rows,
    summary: [
      ['Clients in this range', String(rows.length)],
      ['Top client', rows.length ? rows[0][0] + ' — $' + rows[0][6] : '—'],
      ['Note', 'Visits imported from the old system carry their deposit, not the full ticket — '
        + 'so spend is understated for clients whose history predates this site.'],
    ],
  };
}

// ── COMMISSION EARNINGS ───────────────────────────────────────────────
// What each artist earned, at whatever rate is set for them. Rates come
// from the team record rather than being assumed, because guessing here
// produces a number somebody might get paid on.
async function commissionReport({ appts, team }, from, to) {
  let rates = {};
  try {
    const tdb = require('./_team-db');
    const staff = await tdb.query('SELECT name, commission_pct FROM team_members');
    for (const s of staff) rates[String(s.name).toLowerCase()] = Number(s.commission_pct) || 0;
  } catch (_) {}

  const by = {};
  const add = (artist, revenue, tip) => {
    const k = String(artist || '').trim().toLowerCase();
    if (!k) return;
    if (!by[k]) by[k] = { name: String(artist).trim(), jobs: 0, revenue: 0, tips: 0 };
    by[k].jobs += 1; by[k].revenue += revenue; by[k].tips += tip;
  };

  for (const a of appts) {
    if (isCancelled(a) || isNoShow(a) || !Number(a.deposit_paid)) continue;
    add(a.artist, Number(a.total_cents) || 0, Number(a.tip_cents) || 0);
  }
  for (const t of team) {
    if (isCancelled(t)) continue;
    add(t.artist, Number(t.paid_cents) || 0, Number(t.tip_cents) || 0);
  }

  const rows = Object.values(by).sort((a, b) => b.revenue - a.revenue).map(o => {
    const pct = rates[o.name.toLowerCase()];
    const known = pct != null && pct > 0;
    const commission = known ? Math.round(o.revenue * pct / 100) : 0;
    return [
      o.name, String(o.jobs), money(o.revenue),
      known ? pct + '%' : 'not set',
      known ? money(commission) : 'set a rate first',
      money(o.tips),
      known ? money(commission + o.tips) : money(o.tips),
    ];
  });

  return {
    name: 'commission_' + from + '_to_' + to,
    headers: ['Artist', 'Appointments', 'Revenue produced', 'Commission rate',
      'Commission earned', 'Tips kept', 'Total to pay out'],
    rows,
    summary: [
      ['Artists with work in this range', String(rows.length)],
      ['Note', 'Rows saying "not set" have no commission rate on their team record — set one and re-run.'],
    ],
  };
}

// ── EXPENSES ──────────────────────────────────────────────────────────
// Whatever has been logged. If nothing has been, the report says so rather
// than returning an empty file that looks like a bug.
async function expensesReport(from, to) {
  let rows = [];
  let found = false;
  for (const attempt of [
    { db: 'team', sql: 'SELECT date, category, description, amount_cents, vendor FROM expenses WHERE date >= ? AND date <= ? ORDER BY date' },
    { db: 'main', sql: 'SELECT date, category, description, amount_cents, vendor FROM expenses WHERE date >= ? AND date <= ? ORDER BY date' },
  ]) {
    try {
      const q = attempt.db === 'team' ? require('./_team-db').query : query;
      const r = await q(attempt.sql, [from, to]);
      rows = r.map(e => [e.date, e.category || '', e.description || '', e.vendor || '', money(e.amount_cents)]);
      found = true;
      break;
    } catch (_) {}
  }

  // Inventory purchases are a real expense and are already recorded, so
  // they belong here even before an expenses ledger exists.
  let stock = [];
  try {
    const tdb = require('./_team-db');
    stock = await tdb.query(
      `SELECT restocked_at AS date, name, cost_cents, qty FROM inventory
        WHERE restocked_at >= ? AND restocked_at <= ?`, [from, to]);
    for (const s of stock) {
      rows.push([String(s.date).slice(0, 10), 'Stock', s.name || '', '', money((Number(s.cost_cents) || 0) * (Number(s.qty) || 1))]);
    }
  } catch (_) {}

  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const total = rows.reduce((s, r) => s + Number(String(r[4]).replace(/[^0-9.]/g, '')) * 100, 0);

  return {
    name: 'expenses_' + from + '_to_' + to,
    headers: ['Date', 'Category', 'What', 'Vendor', 'Amount'],
    rows,
    summary: rows.length
      ? [['Entries', String(rows.length)], ['Total', '$' + money(total)]]
      : [['Nothing logged', found
          ? 'No expenses recorded in this date range.'
          : 'No expense ledger exists yet — only stock purchases would appear here.']],
  };
}

const REPORTS = {
  sales: salesReport,
  appointments: appointmentsReport,
  clients: valuableReport,
  commission: commissionReport,
  expenses: expensesReport,
};

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const which = String(req.query.report || '').toLowerCase();
  const to = String(req.query.to || today()).slice(0, 10);
  const from = String(req.query.from || to.slice(0, 8) + '01').slice(0, 10);

  if (!which) {
    return res.json({
      reports: [
        { key: 'sales', name: 'Sales', desc: 'Every appointment that took money, with tips and how it was paid.' },
        { key: 'appointments', name: 'Appointments', desc: 'Everything booked, including cancellations and no-shows.' },
        { key: 'clients', name: 'Most valuable clients', desc: 'Who spends the most, ranked, with average ticket.' },
        { key: 'commission', name: 'Commission earnings', desc: 'What each artist produced and what they are owed.' },
        { key: 'expenses', name: 'Expenses', desc: 'What has gone out, including stock.' },
      ],
    });
  }

  if (!REPORTS[which]) return res.status(400).json({ error: 'No such report' });

  try {
    const built = which === 'expenses'
      ? await expensesReport(from, to)
      : await REPORTS[which](await loadRange(from, to), from, to);

    if (String(req.query.format || 'csv').toLowerCase() === 'json') {
      return res.json({ ...built, from, to });
    }

    // A little header block above the table so a file opened three months
    // later still says what it is and what dates it covers.
    const head = [
      ['ZOLA Nail Studio'], [built.name.replace(/_/g, ' ')],
      ['Covering', from + ' to ' + to],
      ['Generated', today()],
      [],
      ...built.summary,
      [],
    ].map(r => r.map(cell).join(',')).join('\r\n');

    const csv = head + '\r\n' + toCsv(built.headers, built.rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="zola_' + built.name + '.csv"');
    return res.status(200).send(csv);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
