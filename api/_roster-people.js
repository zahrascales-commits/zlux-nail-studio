// Everyone who gives this studio money, in three membership columns and a
// drop-in column, and everything known about each of them behind their name.
//
// Built as one endpoint rather than four screens, because the question Zahra
// actually asks is "who is paying me and what do they need" — and answering
// it from four places is how the four places end up disagreeing.
//
// Money rules match the rest of the dashboard: a booking counts once a
// deposit was taken. A membership counts from the day it started until the
// day it was cancelled.
const { query, queryOne, execute } = require('./_db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const TIER_PRICE = { SIGNATURE: 9900, LUXE: 19900, BLACK_CARD: 29900 };
const TIER_LABEL = { SIGNATURE: 'Signature', LUXE: 'Luxe', BLACK_CARD: 'Black Card' };

const pad = n => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const key = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Whole months between joining and either cancelling or now. Used to work out
// what a member has actually paid across their whole life, which is the
// number that says whether memberships are worth running at all.
function monthsBetween(fromIso, toIso) {
  const a = new Date(String(fromIso || '').slice(0, 10) + 'T12:00:00');
  const b = new Date(String(toIso || today()).slice(0, 10) + 'T12:00:00');
  if (isNaN(a) || isNaN(b)) return 0;
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m -= 1;
  return Math.max(0, m) + 1; // the month they joined counts as one payment
}

async function loadEverything() {
  // Memberships
  let members = [];
  try {
    members = await query(
      `SELECT member_id, full_name, email, phone, tier, date_of_birth,
              membership_started_at, next_billing_at, cancelled_at, status,
              referral_code, flagged, demo
         FROM members ORDER BY membership_started_at DESC`);
  } catch (_) {
    // cancelled_at / status arrived later than this table did
    try {
      members = await query(
        `SELECT member_id, full_name, email, phone, tier, date_of_birth,
                membership_started_at, next_billing_at, referral_code, flagged
           FROM members ORDER BY membership_started_at DESC`);
    } catch (_) {}
  }

  // Everyone in the book, member or not
  let clients = [];
  try {
    const tdb = require('./_team-db');
    await tdb.ensureTables();
    clients = await tdb.query(
      `SELECT id, name, email, phone, likes, dislikes, notes, visits,
              last_service, last_visit, first_appointment, last_appointment,
              total_appointments, cancelled_count, card_on_file, deposits_cents,
              most_common_service, marketing_opt_in
         FROM clients`);
  } catch (_) {}

  // Every visit that has money attached
  let paid = [];
  try {
    paid = await query(
      `SELECT guest_name, guest_email, service, appointment_date, appointment_time,
              status, total_cents, deposit_cents, deposit_paid, tip_cents, member_id
         FROM appointments`);
  } catch (_) {
    try {
      paid = await query(
        `SELECT guest_name, guest_email, service, appointment_date, appointment_time,
                status, total_cents, deposit_cents, deposit_paid, member_id
           FROM appointments`);
    } catch (_) {}
  }

  // The imported history — visits, but no ticket totals
  let legacy = [];
  try {
    const tdb = require('./_team-db');
    legacy = await tdb.query('SELECT client_name, date, time, service, artist, status, deposit_cents, deposit_paid FROM client_visits');
  } catch (_) {}

  // What each client told us about their nails
  let assessments = [];
  try {
    assessments = await query(
      'SELECT member_id, answers, score, band, goal, created_ts FROM nail_assessments ORDER BY created_ts DESC');
  } catch (_) {}

  return { members, clients, paid, legacy, assessments };
}

const cancelled = v => /cancel/i.test(String(v.status || ''));
const earned = v => !cancelled(v) && Number(v.deposit_paid) === 1;

function summarise(name, email, paid, legacy) {
  const nm = key(name), em = String(email || '').toLowerCase();
  const mine = paid.filter(p =>
    (nm && key(p.guest_name) === nm) || (em && String(p.guest_email || '').toLowerCase() === em));
  const old = legacy.filter(l => nm && key(l.client_name) === nm);

  const paidVisits = mine.filter(earned);
  const spent = paidVisits.reduce((s, p) => s + (Number(p.total_cents) || 0), 0);
  const tips = paidVisits.reduce((s, p) => s + (Number(p.tip_cents) || 0), 0);

  const allDates = mine.filter(p => !cancelled(p)).map(p => p.appointment_date)
    .concat(old.filter(l => !cancelled(l)).map(l => l.date))
    .filter(Boolean).sort();

  const last = allDates.length ? allDates[allDates.length - 1] : '';
  let daysSince = null;
  if (last) {
    const d = new Date(last + 'T12:00:00');
    if (!isNaN(d)) daysSince = Math.round((Date.now() - d.getTime()) / 86400000);
  }

  const services = {};
  for (const p of mine.filter(p => !cancelled(p))) if (p.service) services[p.service] = (services[p.service] || 0) + 1;
  for (const l of old.filter(l => !cancelled(l))) if (l.service) services[l.service] = (services[l.service] || 0) + 1;
  const usual = Object.entries(services).sort((a, b) => b[1] - a[1])[0];

  return {
    visits: allDates.length,
    paid_visits: paidVisits.length,
    cancelled: mine.filter(cancelled).length + old.filter(cancelled).length,
    spent_cents: spent,
    tips_cents: tips,
    first_visit: allDates.length ? allDates[0] : '',
    last_visit: last,
    days_since: daysSince,
    usual_service: usual ? usual[0] : '',
    avg_ticket_cents: paidVisits.length ? Math.round(spent / paidVisits.length) : 0,
  };
}

// The free-text answers a client gave about their nails, flattened into
// something an artist can read at a glance before somebody sits down.
function nailProfile(assessment) {
  if (!assessment) return null;
  let a = {};
  try { a = JSON.parse(assessment.answers || '{}'); } catch (_) {}
  const ctx = a._context || {};
  const plan = require('./_nail-plan');

  const flagged = plan.FACTORS
    .filter(f => Number(a[f.key]) > 0)
    .sort((x, y) => (Number(a[y.key]) || 0) - (Number(a[x.key]) || 0))
    .map(f => ({ label: f.label, severity: Number(a[f.key]) }));

  return {
    score: Number(assessment.score) || 0,
    band: assessment.band || '',
    goal: assessment.goal || '',
    when: Number(assessment.created_ts) || 0,
    flagged,
    shape: ctx.shape || '',
    length: ctx.length_pref || '',
    job: ctx.job || '',
    allergy: ctx.allergy || '',
    dislikes: ctx.dislikes || '',
    wants: ctx.wants || '',
  };
}

async function build() {
  const { members, clients, paid, legacy, assessments } = await loadEverything();

  const byMemberId = {};
  for (const a of assessments) if (!byMemberId[a.member_id]) byMemberId[a.member_id] = a;

  const clientByKey = {};
  for (const c of clients) {
    if (c.name) clientByKey[key(c.name)] = c;
    if (c.email) clientByKey[String(c.email).toLowerCase()] = c;
  }

  const memberNames = new Set();
  const columns = { SIGNATURE: [], LUXE: [], BLACK_CARD: [] };
  let mrr = 0, lifetimeMembership = 0;

  for (const mm of members) {
    if (Number(mm.demo)) continue;         // the preview account is not income
    memberNames.add(key(mm.full_name));
    const price = TIER_PRICE[mm.tier] || 0;
    const isCancelled = !!mm.cancelled_at || /cancel/i.test(String(mm.status || ''));
    const months = monthsBetween(mm.membership_started_at, mm.cancelled_at || null);
    const paidToDate = price * months;
    lifetimeMembership += paidToDate;
    if (!isCancelled) mrr += price;

    const c = clientByKey[key(mm.full_name)] || clientByKey[String(mm.email || '').toLowerCase()] || {};
    const stats = summarise(mm.full_name, mm.email, paid, legacy);

    const row = {
      member_id: mm.member_id,
      name: mm.full_name,
      email: mm.email || c.email || '',
      phone: mm.phone || c.phone || '',
      tier: mm.tier,
      tier_label: TIER_LABEL[mm.tier] || mm.tier,
      monthly_cents: price,
      started: String(mm.membership_started_at || '').slice(0, 10),
      renews: String(mm.next_billing_at || '').slice(0, 10),
      cancelled_at: mm.cancelled_at ? String(mm.cancelled_at).slice(0, 10) : '',
      active: !isCancelled,
      months_paid: months,
      paid_to_date_cents: paidToDate,
      flagged: !!Number(mm.flagged),
      referral_code: mm.referral_code || '',
      dob: String(mm.date_of_birth || '').slice(0, 10),
      // Everything an artist needs before this person sits down.
      likes: c.likes || '',
      dislikes: c.dislikes || '',
      notes: c.notes || '',
      card_on_file: !!Number(c.card_on_file),
      nails: nailProfile(byMemberId[mm.member_id]),
      ...stats,
    };
    if (columns[mm.tier]) columns[mm.tier].push(row);
  }

  // Drop-ins: everybody in the book who is not a member.
  const dropins = clients
    .filter(c => c.name && !memberNames.has(key(c.name)))
    .map(c => {
      const stats = summarise(c.name, c.email, paid, legacy);
      // The imported summary knows things this studio's own tables do not.
      const importedVisits = Number(c.total_appointments) || 0;
      const importedDeposits = Number(c.deposits_cents) || 0;
      return {
        id: c.id,
        name: c.name,
        email: c.email || '',
        phone: c.phone || '',
        likes: c.likes || '',
        dislikes: c.dislikes || '',
        notes: c.notes || '',
        card_on_file: !!Number(c.card_on_file),
        marketing_opt_in: !!Number(c.marketing_opt_in),
        usual_service: stats.usual_service || c.most_common_service || '',
        visits: Math.max(stats.visits, importedVisits),
        first_visit: stats.first_visit || String(c.first_appointment || '').slice(0, 10),
        last_visit: stats.last_visit || String(c.last_appointment || '').slice(0, 10),
        cancelled: Math.max(stats.cancelled, Number(c.cancelled_count) || 0),
        // Deposits from the old system are the only money we have for these
        // visits — the export never carried ticket totals, and inventing them
        // would be inventing income.
        spent_cents: stats.spent_cents,
        deposits_cents: importedDeposits,
        tips_cents: stats.tips_cents,
        avg_ticket_cents: stats.avg_ticket_cents,
        days_since: stats.days_since,
        nails: null,
      };
    });

  // Recompute days_since for imported-only clients, whose last visit came
  // from the summary rather than from a booking here.
  for (const d of dropins) {
    if (d.days_since == null && d.last_visit) {
      const dt = new Date(d.last_visit + 'T12:00:00');
      if (!isNaN(dt)) d.days_since = Math.round((Date.now() - dt.getTime()) / 86400000);
    }
  }

  const lapsed = dropins.filter(d => d.days_since != null && d.days_since > 90);

  return {
    today: today(),
    columns: {
      SIGNATURE: columns.SIGNATURE,
      LUXE: columns.LUXE,
      BLACK_CARD: columns.BLACK_CARD,
    },
    totals: {
      mrr_cents: mrr,
      active_members: columns.SIGNATURE.filter(r => r.active).length
        + columns.LUXE.filter(r => r.active).length
        + columns.BLACK_CARD.filter(r => r.active).length,
      cancelled_members: columns.SIGNATURE.filter(r => !r.active).length
        + columns.LUXE.filter(r => !r.active).length
        + columns.BLACK_CARD.filter(r => !r.active).length,
      membership_paid_to_date_cents: lifetimeMembership,
      by_tier: {
        SIGNATURE: columns.SIGNATURE.length,
        LUXE: columns.LUXE.length,
        BLACK_CARD: columns.BLACK_CARD.length,
      },
    },
    dropins: dropins.sort((a, b) => String(b.last_visit).localeCompare(String(a.last_visit))),
    dropin_totals: {
      count: dropins.length,
      lapsed: lapsed.length,
      spent_cents: dropins.reduce((s, d) => s + d.spent_cents, 0),
      deposits_cents: dropins.reduce((s, d) => s + d.deposits_cents, 0),
      tips_cents: dropins.reduce((s, d) => s + d.tips_cents, 0),
    },
  };
}

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    return res.json(await build());
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.build = build;
module.exports.nailProfile = nailProfile;
