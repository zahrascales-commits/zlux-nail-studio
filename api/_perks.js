// What a membership actually gives you, as data rather than as page copy.
//
// The site already promised these things in three different places — the
// memberships page, the tier rules inside booking.html, and the booking
// window config. This is the one place that decides, so the welcome reveal,
// the member's wallet, the calendar and the checkout can never disagree
// about what someone is owed.
//
// Free services are derived from service_usage rather than stored as tokens.
// The booking flow already increments that table, so deriving means the
// wallet can never drift from what has really been booked — a stored token
// and a booking counter would eventually disagree, and the member would be
// the one to find out.
const { query, queryOne, execute } = require('./_db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

/* ── WHAT EACH TIER GIVES ───────────────────────────────────────────
   Order matters: this is the order the welcome reveal unlocks them in,
   so it builds from the thing they came for to the thing they did not
   know they were getting.                                            */
const TIERS = {
  SIGNATURE: {
    label: 'Signature Club',
    price: 99,
    daysAhead: 3,
    perks: [
      { key: 'free_mani',   kind: 'free_service', label: 'One manicure, on us',            detail: 'Every month, any manicure on the menu. Yours before you spend a thing.', value: 1, of: 'manicure' },
      { key: 'free_pedi',   kind: 'free_service', label: 'One pedicure, on us',            detail: 'Every month, alongside your manicure. They do not compete.',            value: 1, of: 'pedicure' },
      { key: 'addons_half', kind: 'discount',     label: 'Every add-on at half price',     detail: 'Removal, Russian manicure, nail art, scrub, massage — all 50% off, every visit.', value: 50 },
      { key: 'calendar',    kind: 'calendar',     label: 'The calendar opens early',       detail: 'You see and book 3 days further out than anyone walking in off the street.', value: 3 },
      { key: 'account',     kind: 'account',      label: 'Your own account',               detail: 'Your visits, your perks, your nail record — all in one place.' },
      { key: 'birthday',    kind: 'gift',         label: 'A birthday add-on',              detail: 'Free during your birthday month. Worth up to $35.' },
      { key: 'channel',     kind: 'access',       label: 'The members-only channel',       detail: 'Cancellations and drops go out here first. This is where the good slots come from.' },
    ],
  },
  LUXE: {
    label: 'Luxe Club',
    price: 199,
    daysAhead: 13,
    perks: [
      { key: 'free_mani',   kind: 'free_service', label: 'Two manicures, on us',           detail: 'Every month. Your nails never have a bad week.',                        value: 2, of: 'manicure' },
      { key: 'free_pedi',   kind: 'free_service', label: 'A pedicure, on us',              detail: 'Every month, on top of both manicures.',                                value: 1, of: 'pedicure' },
      { key: 'addons_free', kind: 'discount',     label: 'Every add-on free',              detail: 'Not discounted — free. Every add-on, every visit, no upsell, ever.',    value: 100 },
      { key: 'calendar',    kind: 'calendar',     label: '13 days of calendar, unlocked',  detail: 'You book almost two weeks further out than guests. The good slots are gone by the time they look.', value: 13 },
      { key: 'account',     kind: 'account',      label: 'Your own account',               detail: 'Your visits, your perks, your nail record — all in one place.' },
      { key: 'birthday',    kind: 'gift',         label: 'A birthday upgrade',             detail: 'Your birthday month gets an upgrade on the house.' },
      { key: 'channel',     kind: 'access',       label: 'First to try what is new',       detail: 'New services reach you before they go public.' },
    ],
  },
  BLACK_CARD: {
    label: 'Black Card',
    price: 299,
    daysAhead: 20,
    perks: [
      { key: 'free_service', kind: 'free_service', label: 'Two services, on us',            detail: 'Every month. Any two services on the menu — your choice, not ours.', value: 2, of: 'any' },
      { key: 'addons_free',  kind: 'discount',     label: 'Every add-on free',              detail: 'Every add-on, every visit, no exceptions and no upsell.',            value: 100 },
      { key: 'pick_artist',  kind: 'artist',       label: 'You choose your artist',         detail: 'Every single time. You are never handed to whoever happens to be free.' },
      { key: 'calendar',     kind: 'calendar',     label: '20 days of calendar, unlocked',  detail: 'You are three weeks ahead of the room. Nothing is gone by the time you look.', value: 20 },
      { key: 'nail_program', kind: 'program',      label: 'Your nail health programme',     detail: 'Tell us the state of your nails and get a plan — what you do at home, what we do in the chair.' },
      { key: 'account',      kind: 'account',      label: 'Your own account',               detail: 'Your visits, your perks, your nail record, your plan.' },
      { key: 'locked_rate',  kind: 'access',       label: 'Your rate, locked forever',      detail: 'This price never rises for you. Not when it rises for everyone else.' },
      { key: 'channel',      kind: 'access',       label: 'First access to everything',     detail: 'New techniques, new gel systems, seasonal collections — you see them first.' },
    ],
  },
};

// How far ahead a guest can book. Every tier's calendar perk is measured
// against this, so a member is genuinely ahead of the room rather than
// merely allowed to book — "you see it before drop-ins do" is only true if
// drop-ins cannot see it.
//
// Thirty days rather than a tight week, on purpose. The tighter the guest
// window the stronger the perk looks, but a studio whose roster starts three
// weeks out has no bookable dates inside a short window at all — the first
// version of this shipped at seven days and closed public booking completely.
// Better to start wide and let her tighten it in Settings once the calendar
// is filled in than to strangle bookings for a nicer-sounding benefit.
const DEFAULT_PUBLIC_DAYS = 30;
let PUBLIC_DAYS_AHEAD = DEFAULT_PUBLIC_DAYS;

// Deliberately NOT the old `public_days_ahead` key. That one already exists
// with the opposite meaning — in the old scheduling config it was a delay
// before booking opened, and its stored value is 0. Read as a horizon it
// turned "no delay for guests" into "guests may book zero days ahead", which
// is every date locked and no public bookings at all. Same name, inverted
// sense, live site: a separate key is the only safe way to hold this.
async function publicDays() {
  try {
    const row = await queryOne("SELECT value FROM site_settings WHERE key='public_booking_horizon_days'");
    const n = Number(row && row.value);
    // A horizon of zero closes the calendar to everyone who is not a member.
    // If she ever wants that it has to be typed deliberately, not inherited
    // from a setting that used to mean something else.
    if (Number.isFinite(n) && n >= 1 && n <= 365) { PUBLIC_DAYS_AHEAD = n; return n; }
  } catch (_) {}
  return DEFAULT_PUBLIC_DAYS;
}

let _ready = false;
async function ensurePerkTables() {
  if (_ready) return;
  // Discretionary claims only — anything the studio hands out on top of the
  // standing tier benefits. The standing ones are derived, never stored.
  await execute(`CREATE TABLE IF NOT EXISTS perk_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT NOT NULL,
    month_key TEXT,
    perk_key TEXT,
    label TEXT,
    kind TEXT,
    value REAL,
    status TEXT DEFAULT 'available',
    used_ts INTEGER,
    used_on TEXT,
    created_ts INTEGER
  )`);
  // Remembers that someone has already been walked through their perks, so
  // the reveal is a moment rather than a thing that happens every login.
  await execute(`CREATE TABLE IF NOT EXISTS perk_reveal (
    member_id TEXT PRIMARY KEY,
    seen_ts INTEGER
  )`);
  _ready = true;
}

function monthKey(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0');
}

// How many services a tier includes each month. Derived from the perk list
// so there is exactly one definition — it was written separately in _pay,
// _bookings and booking.html, and two of the three disagreed.
function includedCount(tier) {
  const t = TIERS[String(tier || '').toUpperCase()];
  if (!t) return 0;
  return t.perks.filter(x => x.kind === 'free_service').reduce((s, x) => s + (x.value || 0), 0);
}

function tierConfig(tier) {
  return TIERS[String(tier || '').toUpperCase()] || null;
}

// How far ahead this person may book. A tier's `daysAhead` is the bonus on
// top of the public window, not the total — so raising the public window
// moves everyone forward together and nobody's perk quietly shrinks.
async function windowFor(tier) {
  const pub = await publicDays();
  const t = tierConfig(tier);
  const extra = t ? t.daysAhead : 0;
  return { days_ahead: pub + extra, public_days_ahead: pub, extra };
}

/* ── THE WALLET ─────────────────────────────────────────────────────
   What this member can actually use right now, this month.           */
async function walletFor(memberId) {
  await ensurePerkTables();
  const member = await queryOne(
    'SELECT member_id, full_name, tier, membership_started_at, next_billing_at FROM members WHERE member_id = ?',
    [String(memberId)]);
  if (!member) return null;

  const cfg = tierConfig(member.tier);
  if (!cfg) return null;

  const mk = monthKey();
  let usage = null;
  try {
    usage = await queryOne('SELECT * FROM service_usage WHERE member_id = ? AND month_year = ?', [member.member_id, mk]);
  } catch (_) {}
  const used = Number((usage && usage.services_used) || 0);

  // Free services are one pool: the booking flow counts services used, not
  // manicures and pedicures separately, so presenting them separately here
  // would promise a split the checkout does not honour.
  const freeTotal = cfg.perks
    .filter(p => p.kind === 'free_service')
    .reduce((s, p) => s + (p.value || 0), 0);
  const freeLeft = Math.max(0, freeTotal - used);

  const items = cfg.perks.map(p => {
    const item = {
      key: p.key, kind: p.kind, label: p.label, detail: p.detail,
      value: p.value == null ? null : p.value,
      of: p.of || null,
      standing: true,           // comes with the tier, never runs out
      available: true,
      status: '',
    };
    if (p.kind === 'free_service') {
      item.standing = false;
      item.available = freeLeft > 0;
      item.status = freeLeft > 0
        ? freeLeft + ' left this month'
        : 'All used this month — back on ' + (member.next_billing_at || 'your renewal');
    }
    if (p.kind === 'discount') item.status = p.value === 100 ? 'Applied automatically' : p.value + '% off, applied automatically';
    if (p.kind === 'calendar') item.status = p.value + ' days further than guests';
    return item;
  });

  // Anything handed out on top — a make-good, a promo, a one-off gift.
  let extras = [];
  try {
    extras = await query(
      "SELECT id, perk_key, label, kind, value, status, month_key FROM perk_claims WHERE member_id = ? AND status = 'available' AND (month_key IS NULL OR month_key = ?)",
      [member.member_id, mk]);
  } catch (_) {}

  const seen = await queryOne('SELECT seen_ts FROM perk_reveal WHERE member_id = ?', [member.member_id]).catch(() => null);

  return {
    member_id: member.member_id,
    name: member.full_name,
    tier: member.tier,
    tier_label: cfg.label,
    price: cfg.price,
    month: mk,
    next_billing_at: member.next_billing_at || '',
    free_services: { total: freeTotal, used, left: freeLeft },
    addon_discount_pct: (cfg.perks.find(p => p.kind === 'discount') || {}).value || 0,
    window: await windowFor(member.tier),
    can_pick_artist: cfg.perks.some(p => p.kind === 'artist'),
    has_nail_program: cfg.perks.some(p => p.kind === 'program'),
    perks: items,
    extras: extras.map(e => ({
      id: e.id, key: e.perk_key, label: e.label, kind: e.kind,
      value: Number(e.value) || 0, status: 'Ready to use',
    })),
    revealed: !!(seen && seen.seen_ts),
  };
}

/* ── HTTP ─────────────────────────────────────────────────────────── */

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action) || '';
  try {
    await ensurePerkTables();

    // The whole shape of every tier, for the memberships page and the
    // reveal — no member needed, because nothing here is personal.
    if (req.method === 'GET' && action === 'tiers') {
      return res.json({
        public_days_ahead: await publicDays(),
        tiers: Object.keys(TIERS).map(k => ({ tier: k, ...TIERS[k] })),
      });
    }

    // One member's wallet. Identified by member ID, the same way the booking
    // page already identifies members — no session needed, and it exposes
    // nothing a member could not read off their own booking screen.
    if (req.method === 'GET' && action === 'wallet') {
      const id = String(req.query.member_id || '').trim().toUpperCase();
      if (!id) return res.status(400).json({ error: 'Which member?' });
      const w = await walletFor(id);
      if (!w) return res.status(404).json({ error: 'No membership found for that ID.' });
      return res.json(w);
    }

    // How far ahead a given tier may book — used by the booking calendar.
    if (req.method === 'GET' && action === 'window') {
      const tier = String(req.query.tier || '').toUpperCase();
      return res.json(await windowFor(tier));
    }

    // The reveal has been watched. Recorded so it stays a moment.
    if (req.method === 'POST' && action === 'revealed') {
      const id = String((req.body || {}).member_id || '').trim().toUpperCase();
      if (!id) return res.status(400).json({ error: 'Which member?' });
      await execute(
        `INSERT INTO perk_reveal (member_id, seen_ts) VALUES (?,?)
         ON CONFLICT(member_id) DO UPDATE SET seen_ts = excluded.seen_ts`,
        [id, Date.now()]);
      return res.json({ ok: true });
    }

    /* ── Owner only below ── */
    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Hand someone something extra — a make-good, a gift, a one-off offer.
    if (req.method === 'PUT' && action === 'public_window') {
      const n = Number((req.body || {}).days);
      if (!Number.isFinite(n) || n < 1 || n > 365) return res.status(400).json({ error: 'Pick between 1 and 365 days.' });
      await execute(
        "INSERT INTO site_settings (key,value) VALUES ('public_booking_horizon_days',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [String(Math.round(n))]);
      return res.json({ ok: true, days: Math.round(n) });
    }

    if (req.method === 'POST' && action === 'grant') {
      const b = req.body || {};
      await execute(
        `INSERT INTO perk_claims (member_id, month_key, perk_key, label, kind, value, status, created_ts)
         VALUES (?,?,?,?,?,?, 'available', ?)`,
        [String(b.member_id || '').toUpperCase(), b.expires_this_month ? monthKey() : null,
         String(b.perk_key || 'gift'), String(b.label || 'A gift from Zahra'),
         String(b.kind || 'discount'), Number(b.value) || 0, Date.now()]);
      return res.json({ ok: true });
    }

    if (req.method === 'PUT' && action === 'use') {
      const b = req.body || {};
      await execute(
        "UPDATE perk_claims SET status='used', used_ts=?, used_on=? WHERE id=?",
        [Date.now(), String(b.used_on || ''), Number(b.id)]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.TIERS = TIERS;
module.exports.walletFor = walletFor;
module.exports.includedCount = includedCount;
module.exports.windowFor = windowFor;
module.exports.tierConfig = tierConfig;
module.exports.publicDays = publicDays;
