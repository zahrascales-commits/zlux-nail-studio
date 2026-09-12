// One search box for the whole of Studio Manager.
//
// There are thirty-one tabs. Knowing which one holds discount codes, or
// where a photo gets uploaded, is something you either remember or you do
// not — and when you do not, the thing may as well not exist. She has four
// discount codes saved and eight photos live, and could not find either.
//
// So: type anything and get back everything that matches, from the real
// data — a client, a booking, a code, an artist, a service, a press-on, a
// stock item — each one saying which screen it lives on.
//
// The places themselves are searchable too, and that is the half that
// actually solves the problem: typing "discount" finds the Site screen even
// though nothing is called "discount" anywhere in the data.
const { query } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const LIMIT_PER_KIND = 6;

const money = c => '$' + (Math.round(Number(c) || 0) / 100).toFixed(2);

/* SQLite has no case-insensitive LIKE for anything but ASCII, which is all
   these fields are. Wrapped here so a search is one call and the wildcards
   cannot be forgotten at a call site. */
function like(q) { return '%' + String(q).toLowerCase() + '%'; }

async function safe(fn) {
  try { return await fn(); } catch (_) { return []; }
}

/* ── THE PLACES ──────────────────────────────────────────────────────────
   Every screen, and the things on it, in the words somebody would actually
   type. "Discount", "coupon" and "promo code" are all the same screen, and
   none of them is what the tab is called.

   Kept on the server with everything else so there is one search to
   maintain rather than two that answer differently. */
const PLACES = [
  { tab: 'site', title: 'Discount codes', sub: 'Site → the codes you hand out',
    words: 'discount code codes promo coupon voucher percent off dollars off early bird trainee special' },
  { tab: 'site', title: 'Site photos', sub: 'Site → tap a slot to upload from your phone',
    words: 'photo photos picture pictures image images upload hero header banner what pictures go where change photo homepage image' },
  { tab: 'site', title: 'Homepage words', sub: 'Site → headline, sub-heading, announcement bar',
    words: 'headline hero text wording announcement banner ticker edit website copy words change text address' },
  { tab: 'site', title: 'Shop my IG', sub: 'Site → the Instagram row on the homepage',
    words: 'instagram ig shop my ig social posts' },
  { tab: 'site', title: 'Press-ons', sub: 'Site → products, orders and what they earn',
    words: 'press on press-ons pressons sets nails to go product products shop orders' },
  { tab: 'site', title: 'Classes', sub: 'Site → classes and who has paid',
    words: 'class classes course teaching workshop students purchases' },

  { tab: 'schedule', title: 'Calendar', sub: 'Day, week and month, plus blocking time off',
    words: 'calendar diary schedule day week month book appointment block time off closed hours' },
  { tab: 'bookings', title: 'All bookings', sub: 'Every booking made on the website',
    words: 'bookings online website booked list' },
  { tab: 'clients', title: 'Clients', sub: 'Everybody in your book',
    words: 'client clients customer people contacts phone numbers emails address book' },
  { tab: 'people', title: 'Members', sub: 'Who is on which membership, and what they pay',
    words: 'member members membership essential elite signature luxe black card subscription tiers spots' },
  { tab: 'marketing', title: 'Email and text campaigns', sub: 'Write it, choose who, send it',
    words: 'email emails text texts sms campaign blast newsletter message everyone marketing send out' },
  { tab: 'autoemail', title: 'Automatic emails', sub: 'The ones that send themselves',
    words: 'automatic auto email trigger reminder confirmation follow up rules setup' },
  { tab: 'maillog', title: 'Emails sent', sub: 'Everything that has gone out',
    words: 'sent log history delivered emails sent proof' },
  { tab: 'messages', title: 'Messages', sub: 'Chats with clients',
    words: 'chat chats message messages thread reply talk' },
  { tab: 'inbox', title: 'Inbox', sub: 'Enquiries from the contact form',
    words: 'inbox enquiry enquiries inquiry contact form questions' },
  { tab: 'deposits', title: 'Deposits', sub: 'Who has paid and who has not',
    words: 'deposit deposits paid unpaid owing refund money taken' },
  { tab: 'payouts2', title: 'Payouts', sub: 'Money out of Stripe into your bank',
    words: 'payout payouts bank stripe transfer money out paid out' },
  { tab: 'paymath', title: 'Pay math', sub: 'What each artist earned and is owed',
    words: 'pay math commission wages owed artist earnings split' },
  { tab: 'reports', title: 'Reports', sub: 'Takings, and files to download',
    words: 'report reports revenue takings income download csv export accounting tax month' },
  { tab: 'insights', title: 'Insights', sub: 'What the numbers say',
    words: 'insights stats analytics trends busiest' },
  { tab: 'traffic', title: 'Traffic', sub: 'Who is visiting the website',
    words: 'traffic visitors views hits analytics website visits' },
  { tab: 'team', title: 'Team', sub: 'Artists, their PINs and their skills',
    words: 'team artist artists staff worker workers employee pin skills who does what trainee' },
  { tab: 'scheduling', title: 'Scheduling', sub: 'Who works which days',
    words: 'shifts rota roster availability who is working schedule staff hours coverage' },
  { tab: 'services', title: 'Services', sub: 'The menu, prices and add-ons',
    words: 'service services menu price prices add-on addons cost change price gel x acrylic pedicure' },
  { tab: 'inventory', title: 'Inventory', sub: 'Stock, and what is running low',
    words: 'inventory stock supplies low running out order more tips acetone' },
  { tab: 'giftcards', title: 'Gift cards', sub: 'Issued cards and balances',
    words: 'gift card cards voucher balance' },
  { tab: 'cards', title: 'Cards on file', sub: 'Who you can charge without asking',
    words: 'card on file saved card stripe charge later tap to pay' },
  { tab: 'earlybird', title: 'Early bird', sub: 'The automatic discount for the first few',
    words: 'early bird first few automatic discount launch offer' },
  { tab: 'goals', title: 'Goals', sub: 'What you are aiming at',
    words: 'goal goals target aim monthly' },
  { tab: 'journeys', title: 'Journeys', sub: 'Before and after photo stories',
    words: 'journey journeys before after transformation progress story' },
  { tab: 'records', title: 'Records', sub: 'Signed forms and consents',
    words: 'records consent signature waiver forms signed' },
  { tab: 'sales', title: 'Sales', sub: 'The showcase and what sold',
    words: 'sales sold showcase shop' },
  { tab: 'faq', title: 'Ask Zola', sub: 'The answers the site gives clients',
    words: 'faq questions answers ask zola help chatbot' },
  { tab: 'settings', title: 'Settings', sub: 'Passwords, keys and everything else',
    words: 'settings password stripe key api notifications preferences colour setup config' },
  { tab: 'overview', title: 'Overview', sub: 'Today, and what needs you',
    words: 'overview home today dashboard needs you floor takings now' },
];

function matchPlaces(q) {
  const n = String(q).toLowerCase().trim();
  if (!n) return [];
  const terms = n.split(/\s+/).filter(Boolean);

  return PLACES
    .map(p => {
      const hay = (p.title + ' ' + p.sub + ' ' + p.words).toLowerCase();
      /* Every word has to appear somewhere, so "site photos" does not match
         every screen with the word "site" in it. */
      if (!terms.every(t => hay.indexOf(t) >= 0)) return null;
      // A hit in the name beats a hit buried in the synonyms.
      const score = p.title.toLowerCase().indexOf(n) === 0 ? 3
        : (p.title.toLowerCase().indexOf(n) >= 0 ? 2 : 1);
      return { kind: 'place', title: p.title, sub: p.sub, tab: p.tab, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ q, groups: [] });

  const L = like(q);
  const digits = q.replace(/[^0-9]/g, '');
  const groups = [];
  const add = (label, items) => { if (items && items.length) groups.push({ label, items }); };

  // ── the screens themselves ──
  add('Where to go', matchPlaces(q));

  // ── people in the book ──
  add('Clients', (await safe(() => query(
    `SELECT id, name, email, phone, visits, last_visit FROM clients
      WHERE lower(COALESCE(name,'')) LIKE ?
         OR lower(COALESCE(email,'')) LIKE ?
         OR (? <> '' AND replace(replace(replace(replace(COALESCE(phone,''),'-',''),' ',''),'(',''),')','') LIKE ?)
      ORDER BY COALESCE(visits,0) DESC LIMIT ?`,
    [L, L, digits, '%' + digits + '%', LIMIT_PER_KIND]))).map(c => ({
      kind: 'client', title: c.name || 'Unnamed',
      sub: [c.phone, c.email].filter(Boolean).join(' · ')
        + (c.visits ? '  ·  ' + c.visits + ' visit' + (Number(c.visits) === 1 ? '' : 's') : ''),
      tab: 'clients',
      // Opens the profile sheet rather than just landing on a list.
      open_client: { id: c.id, name: c.name || '', email: c.email || '', phone: c.phone || '' },
    })));

  // ── appointments, soonest first ──
  add('Appointments', (await safe(() => query(
    `SELECT a.id, a.client_name, a.service, a.date, a.time, a.status, m.name AS artist
       FROM team_appointments a
       LEFT JOIN team_members m ON m.id = a.team_member_id
      WHERE lower(COALESCE(a.client_name,'')) LIKE ?
         OR lower(COALESCE(a.service,'')) LIKE ?
         OR a.date LIKE ?
      ORDER BY a.date DESC LIMIT ?`,
    [L, L, L, LIMIT_PER_KIND]))).map(a => ({
      kind: 'appointment', title: (a.client_name || 'Open') + ' · ' + (a.service || 'Appointment'),
      sub: a.date + (a.time ? ' at ' + a.time : '') + (a.artist ? '  ·  with ' + a.artist : '')
        + (a.status && a.status !== 'scheduled' ? '  ·  ' + a.status : ''),
      tab: 'schedule', go_date: a.date,
      open_client: a.client_name ? { name: a.client_name } : null,
    })));

  // ── memberships ──
  add('Members', (await safe(async () => {
    const main = require('./_db');
    return main.query(
      `SELECT member_id, full_name, email, tier FROM members
        WHERE lower(COALESCE(full_name,'')) LIKE ?
           OR lower(COALESCE(email,'')) LIKE ?
           OR lower(COALESCE(member_id,'')) LIKE ?
           OR lower(COALESCE(tier,'')) LIKE ?
        LIMIT ?`, [L, L, L, L, LIMIT_PER_KIND]);
  })).map(m => ({
    kind: 'member', title: m.full_name || m.member_id,
    sub: String(m.tier || '').replace('_', ' ') + '  ·  ' + m.member_id + (m.email ? '  ·  ' + m.email : ''),
    tab: 'people',
    open_client: { name: m.full_name || '', email: m.email || '' },
  })));

  // ── discount codes ──
  add('Discount codes', (await safe(() => query(
    `SELECT code, label, amount_off_cents, fixed_total_cents, kind, applies_to, active, used_count
       FROM promo_codes
      WHERE lower(code) LIKE ? OR lower(COALESCE(label,'')) LIKE ? LIMIT ?`,
    [L, L, LIMIT_PER_KIND]))).map(p => ({
      kind: 'promo', title: p.code,
      sub: (String(p.kind) === 'fixed_total'
              ? 'sets the price to ' + money(p.fixed_total_cents)
              : money(p.amount_off_cents) + ' off')
        + '  ·  on ' + ({ service: 'bookings', membership: 'memberships', both: 'anything' }[String(p.applies_to || 'service')] || 'bookings')
        + '  ·  used ' + (Number(p.used_count) || 0) + 'x'
        + (Number(p.active) ? '' : '  ·  switched off'),
      tab: 'site',
    })));

  // ── the team ──
  add('Team', (await safe(() => query(
    `SELECT id, name, role, active FROM team_members
      WHERE lower(COALESCE(name,'')) LIKE ? OR lower(COALESCE(role,'')) LIKE ? LIMIT ?`,
    [L, L, LIMIT_PER_KIND]))).map(t => ({
      kind: 'team', title: t.name,
      sub: (t.role || 'Nail Artist') + (Number(t.active) ? '' : '  ·  not active'),
      tab: 'team',
    })));

  // ── the menu ──
  add('Services', (await safe(async () => {
    const { services } = require('./_store');
    const n = q.toLowerCase();
    return (services || []).filter(s => String(s.name || '').toLowerCase().indexOf(n) >= 0).slice(0, LIMIT_PER_KIND);
  })).map(s => ({
    kind: 'service', title: s.name,
    sub: money(s.price_cents) + (s.duration_min ? '  ·  ' + s.duration_min + ' min' : '')
      + (s.deal ? '  ·  a deal day' : ''),
    tab: s.deal ? 'site' : 'services',
  })));

  // ── press-ons ──
  add('Press-ons', (await safe(() => query(
    `SELECT id, name, price_cents, category, active FROM presson_products
      WHERE lower(COALESCE(name,'')) LIKE ? OR lower(COALESCE(category,'')) LIKE ? LIMIT ?`,
    [L, L, LIMIT_PER_KIND]))).map(p => ({
      kind: 'presson', title: p.name,
      sub: money(p.price_cents) + (p.category ? '  ·  ' + p.category : '')
        + (Number(p.active) ? '' : '  ·  hidden'),
      tab: 'site',
    })));

  // ── stock ──
  add('Inventory', (await safe(() => query(
    `SELECT id, name, qty, unit, low_threshold FROM studio_inventory
      WHERE lower(COALESCE(name,'')) LIKE ? LIMIT ?`,
    [L, LIMIT_PER_KIND]))).map(i => ({
      kind: 'stock', title: i.name,
      sub: i.qty + (i.unit ? ' ' + i.unit : '') + ' on hand'
        + (Number(i.qty) <= Number(i.low_threshold) ? '  ·  running low' : ''),
      tab: 'inventory',
    })));

  return res.json({ q, groups, total: groups.reduce((s, g) => s + g.items.length, 0) });
};
