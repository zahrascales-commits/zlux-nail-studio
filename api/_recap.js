// The monthly recap: what the month was worth, who came, and what to do
// about it next month.
//
// Two numbers she asked for, and both of them are harder than they look.
//
// REVENUE. The obvious source is the appointments table, and it is wrong:
// of 64 visits, 33 had a deposit recorded and 4 had a balance, because the
// balance is taken at the desk and nothing wrote it down. An appointment
// table also knows nothing about her six live memberships, which bill
// through Stripe and are the most reliable money in the business. So
// revenue here means ONE thing: money that actually moved. Card money
// comes from Stripe net of refunds, because Stripe is the only thing that
// really knows. Cash, Zelle and the rest come from what was written down
// at the desk. Nothing that was merely arranged is counted as income.
//
// CLIENTS. Counted from both booking books with the mirrors removed, so a
// visit that exists in the website book and the studio book is one visit
// and not two. "New" means the first visit that person ever had, measured
// against every month on record rather than the window being shown.
//
// Both come with the month before them, the difference in money and in
// people, and the percentage either way — including down, because a month
// that fell 60% is the one worth knowing about. November 2026 did.
//
// And then the part that is not a number: a list of things to do, each with
// how often to do it, which she ticks off. The advice is seeded from what
// this studio's own data says is leaking, not from a generic list.
const { query, queryOne, execute } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const money = c => Math.round(Number(c) || 0);
const dollars = c => '$' + (money(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = n => String(n).padStart(2, '0');
const lower = s => String(s || '').trim().toLowerCase();
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* The studio's calendar. A month has to turn over in Porterville, not
   wherever the server is, or the recap for the 1st arrives on the 31st. */
function studioNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}
const thisMonth = () => { const d = studioNow(); return d.getFullYear() + '-' + pad(d.getMonth() + 1); };
const todayLA = () => { const d = studioNow(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

function monthBounds(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: ym + '-01', to: ym + '-' + pad(last), days: last, year: y, month: m };
}
function prevMonth(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return m === 1 ? (y - 1) + '-12' : y + '-' + pad(m - 1);
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return (MONTH_NAMES[m - 1] || ym) + ' ' + y;
}

/* How a change is said. The percentage is only meaningful if there was
   something to compare against — 0 to 500 is not "up infinity percent",
   it is "up $500 from nothing", and saying it the second way is the only
   honest option. */
function delta(now, before) {
  const diff = money(now) - money(before);
  const pct = money(before) > 0 ? (diff / money(before)) * 100 : null;
  return {
    now: money(now),
    before: money(before),
    diff,
    diff_abs: Math.abs(diff),
    direction: diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat'),
    pct: pct === null ? null : Math.round(pct * 10) / 10,
    pct_abs: pct === null ? null : Math.abs(Math.round(pct * 10) / 10),
    from_nothing: money(before) === 0 && diff !== 0,
  };
}
function sayMoneyDelta(d) {
  if (d.diff === 0) return 'exactly level with the month before';
  const dir = d.direction === 'up' ? 'up' : 'down';
  if (d.from_nothing) return dir + ' ' + dollars(d.diff_abs) + ' from nothing';
  return dir + ' ' + dollars(d.diff_abs) + ' (' + d.pct_abs + '%)';
}
/* "down 1 people" is the kind of thing that makes a report feel like a
   machine wrote it, and stripping a trailing s does not fix it, because
   the word is "people". So the irregular ones are named. */
const SINGULAR = {
  people: 'person', visits: 'visit', clients: 'client',
  'new clients': 'new client', memberships: 'membership', posts: 'post',
};
function sayCountDelta(d, noun) {
  const n = noun || 'people';
  if (d.diff === 0) return 'the same as the month before';
  const dir = d.direction === 'up' ? 'up' : 'down';
  const word = d.diff_abs === 1 ? (SINGULAR[n] || n.replace(/s$/, '')) : n;
  const bit = dir + ' ' + d.diff_abs + ' ' + word;
  if (d.from_nothing || d.pct_abs === null) return bit;
  return bit + ' (' + d.pct_abs + '%)';
}

/* ── THE BOOK OF ACTIONS ────────────────────────────────────────────── */

let _ready = null;
async function ensure() {
  if (_ready) return _ready;
  _ready = (async () => {
    await execute(`CREATE TABLE IF NOT EXISTS recap_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT DEFAULT 'revenue',
      title TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      why TEXT DEFAULT '',
      frequency TEXT DEFAULT 'weekly',
      target INTEGER DEFAULT 1,
      worth_cents INTEGER DEFAULT 0,
      seeded TEXT DEFAULT '',
      sort INTEGER DEFAULT 0,
      archived_ts INTEGER DEFAULT 0,
      created_ts INTEGER
    )`);
    await execute(`CREATE TABLE IF NOT EXISTS recap_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id INTEGER DEFAULT 0,
      day TEXT DEFAULT '',
      note TEXT DEFAULT '',
      ts INTEGER
    )`);
    try { await execute('CREATE UNIQUE INDEX IF NOT EXISTS recap_ticks_once ON recap_ticks (action_id, day)'); } catch (_) {}
    try { await execute('CREATE INDEX IF NOT EXISTS recap_actions_scope ON recap_actions (scope)'); } catch (_) {}
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

/* How often a thing needs doing, and what a period is, so "once a day for
   a week" can be measured rather than remembered. */
const FREQUENCIES = {
  daily:      { label: 'Every day',            per: 'day',   days: 1,  target: 1 },
  each_visit: { label: 'Every client, every visit', per: 'day', days: 1, target: 1 },
  weekdays:   { label: 'Every working day',    per: 'day',   days: 1,  target: 1 },
  three_week: { label: '3 times a week',       per: 'week',  days: 7,  target: 3 },
  weekly:     { label: 'Once a week',          per: 'week',  days: 7,  target: 1 },
  biweekly:   { label: 'Every 2 weeks',        per: 'week',  days: 14, target: 1 },
  monthly:    { label: 'Once a month',         per: 'month', days: 30, target: 1 },
  once:       { label: 'Once — then it is done', per: 'ever', days: 0, target: 1 },
};
const freqOf = k => FREQUENCIES[String(k)] || FREQUENCIES.weekly;

/* ── WHAT THIS STUDIO'S OWN DATA SAYS IS LEAKING ────────────────────────
   Seeded once. Every line below was measured, and the measurement is in
   the `why`, because advice she cannot check is advice she cannot trust.
   She can edit, add and archive them afterwards — these are a starting
   position, not a decree. */
const SEED = [
  // ── REVENUE ──
  { scope: 'revenue', frequency: 'daily', target: 1, worth_cents: 150000,
    title: 'Write down every payment the same day',
    detail: 'Charge a card tab, or the Paid button on the visit. Cash, Zelle, card reader — '
      + 'whatever it was, 2 seconds, same day.',
    why: 'Of 64 visits on record, 33 had a deposit written down and 4 had a balance. '
      + 'Your revenue report showed November at $639 against roughly $2,000 of work. '
      + 'Until this is a habit, every other number on this page is guessing — '
      + 'and Brianna’s commission is short by every balance you ever took in person.' },

  { scope: 'revenue', frequency: 'each_visit', target: 1, worth_cents: 38000,
    title: 'Rebook them before they get out of the chair',
    detail: 'Phone out, next date in, deposit taken. Not "text me" — booked.',
    why: '18 of your 41 clients came once and never came back. That is 44%. '
      + 'At $95 a visit, turning just four of those a month into a second visit is $380 a month, '
      + 'and it costs you nothing to ask.' },

  { scope: 'revenue', frequency: 'monthly', target: 2, worth_cents: 22000,
    title: 'Sell 2 memberships this month',
    detail: 'Say it at the end of every visit where they are already coming back: '
      + '"you are paying $95 anyway — on Elite it is $110 a month and your next visit is free."',
    why: 'You have 6 live memberships billing $603 a month, guaranteed, whether or not anyone books. '
      + 'That is already more than some months of card takings. Each new Elite adds $110 a month '
      + 'for as long as they stay — two a month is $2,640 a year of money that arrives without you.' },

  { scope: 'revenue', frequency: 'once', target: 1, worth_cents: 132000,
    title: 'Call Katelynn Boydstun back',
    detail: 'One call, not a text. Ask what made her stop, and offer her the month back.',
    why: 'Katelynn was Elite at $110 a month and cancelled on October 27. '
      + 'That is $1,320 a year that walked out, and she is the only cancellation you have had. '
      + 'A win-back is the cheapest membership you will ever sell.' },

  { scope: 'revenue', frequency: 'weekly', target: 1, worth_cents: 114000,
    title: 'Open Saturday and fill it',
    detail: 'Three Saturday slots, posted Monday, deposit to hold. Start with one Saturday a week.',
    why: 'In five months you have done 3 Saturday visits and 1 Sunday — against 27 Wednesdays. '
      + 'Saturday is the day most people can actually come, and yours is empty. '
      + 'Three Saturday visits a week is about $1,140 a month you are not currently able to earn.' },

  { scope: 'revenue', frequency: 'once', target: 1, worth_cents: 18000,
    title: 'Move the $65 deal off Wednesday',
    detail: 'Wednesday goes back to full price. Put the deal on the quiet days instead — '
      + 'Saturday or Sunday — where it fills an empty chair.',
    why: 'Wednesday is already your busiest day: 27 visits, 6 of them discounted to $65. '
      + 'You are giving $30 away on the one day that does not need help. '
      + 'Three of the nine deal bookings were even taken on the wrong day of the week. '
      + 'Same discount on a dead Saturday brings in new money instead of shrinking money you already had.' },

  { scope: 'revenue', frequency: 'each_visit', target: 1, worth_cents: 40000,
    title: 'Offer the add-on at the start, not the end',
    detail: 'While you are looking at their hands: "do you want art on two, or a full set?" '
      + 'Decided at the start, it gets done. Offered at the end, it is next time.',
    why: 'Your top service is $95 and almost no ticket on record goes above it. '
      + 'One $20 add-on on half your visits is about $200 a month, on work you are already set up for.' },

  { scope: 'revenue', frequency: 'each_visit', target: 1, worth_cents: 20000,
    title: 'Let them tip on the screen',
    detail: 'Hand them the tip screen at checkout instead of saying the total out loud.',
    why: 'In five months, $20 of tips is recorded. Nobody carries cash. '
      + 'A tip line that is shown rather than mentioned typically runs 10–15% of a ticket — '
      + 'on 22 visits that is $200+ a month, and it goes to whoever did the nails.' },

  // ── CLIENTS ──
  { scope: 'clients', frequency: 'daily', target: 1, worth_cents: 0,
    title: 'Post the booking link once a day',
    detail: 'Story, caption or bio — but the link, every single day, with "book now" in words. '
      + 'Not just a pretty set with no way to act on it.',
    why: '41 clients in five months, and every one of them had to reach the booking page to '
      + 'become one. A post without the link is a compliment; a post with it is the only thing '
      + 'that turns someone watching into $95. There is no step in between.' },

  { scope: 'clients', frequency: 'daily', target: 5, worth_cents: 0,
    title: 'DM 5 people who engaged with you',
    detail: 'Anyone who liked, saved or watched twice. Not a pitch — "thank you, want the link?"',
    why: 'Local clients come from conversations, not reach. Five a day is 150 a month; '
      + 'if 3% book, that is 4 or 5 new clients a month from work you do with your thumb.' },

  { scope: 'clients', frequency: 'weekly', target: 5, worth_cents: 47500,
    title: 'Text 5 clients who have not been back',
    detail: 'One at a time, by name, nothing that reads like a blast. '
      + '"Hi X, it is Zahra — your nails are about due, want your usual slot?"',
    why: '18 people came once and never returned. Five personal texts a week works through '
      + 'that list in a month. Even one booking a week from it is $380 a month.' },

  { scope: 'clients', frequency: 'each_visit', target: 1, worth_cents: 0,
    title: 'Ask every happy client for one referral',
    detail: 'At the end, while they are looking at their hands: '
      + '"if you know one person who would love these, send them my link."',
    why: '18 of your 41 clients came once and never came back, and a person a client brings '
      + 'behaves like the client who brought them. You already have a referral program on the '
      + 'site; it has no way to work unless somebody is asked. 22 visits a month is 22 asks.' },

  { scope: 'clients', frequency: 'once', target: 1, worth_cents: 0,
    title: 'Set up your Google Business Profile',
    detail: 'Name, address, hours, 10 photos, the booking link, and the Porterville service area.',
    why: '"Nail salon near me" is a Google search, not an Instagram one, and right now you are '
      + 'not in it at all. 30 minutes, costs nothing, and then it works every day without you '
      + 'touching it — the only item on this list that is true of. I am not going to pretend '
      + 'I can predict how many clients it brings; I can tell you that being absent brings none.' },

  { scope: 'clients', frequency: 'each_visit', target: 1, worth_cents: 0,
    title: 'Ask for a Google review before they leave',
    detail: 'Show them the QR or send the link while they are still happy and still there.',
    why: 'Once the Google profile above is live, reviews are what decides between you and '
      + 'whoever else appears. You have 22 visits a month, so 22 chances — and asked in the '
      + 'chair while they are still looking at their hands it works, while asked by text the '
      + 'next day it mostly does not.' },

  // ── SOCIAL ──
  /* Her goal is 10,000 followers in three months and 10,000 views a video.
     None of these promise that, because nobody can. What they do is the
     arithmetic and the mechanics, which are the parts she controls. */
  { scope: 'social', frequency: 'daily', target: 2, worth_cents: 0,
    title: 'Post twice a day',
    detail: 'Two posts, not one. A re-cut of the same set counts — different first frame, '
      + 'different hook. You do not need twice the nails, you need twice the videos.',
    why: '10,000 followers needs roughly 500,000 to 1,000,000 views, because a strong account turns '
      + '1–2% of viewers into followers. Over 90 days that is 5,500–11,000 views a day. '
      + 'At one post a day every post has to average 10,000 — brutal. At two a day it is 5,000. '
      + 'At three, 3,300. Volume is the only part of this arithmetic you fully control, and it is the '
      + 'part the answer is most sensitive to.' },

  { scope: 'social', frequency: 'daily', target: 1, worth_cents: 0,
    title: 'Finished nails in the very first frame',
    detail: 'Open on the result. Then the process. Never the other way round.',
    why: 'Nobody waits to find out whether a video is worth watching, and what the algorithm actually '
      + 'measures is whether people finish and re-watch. This is the most common single reason a '
      + 'beautiful set gets 300 views. The Social media tab measures the lift on your own posts — '
      + 'so you will not have to take my word for it.' },

  { scope: 'social', frequency: 'daily', target: 1, worth_cents: 0,
    title: 'Keep it under 10 seconds',
    detail: 'If it runs long, cut it. Two short videos beat one long one, and you get two posts out of it.',
    why: 'A 7-second clip watched twice scores better than a 40-second one people leave at 3 seconds, '
      + 'because completion and re-watch are what get measured. Nail content is the easiest thing in '
      + 'the world to cut short.' },

  { scope: 'social', frequency: 'daily', target: 1, worth_cents: 0,
    title: 'Log yesterday’s post numbers',
    detail: 'Social media tab → Log a post. Views, likes, comments, shares, saves, follows. '
      + 'About fifteen seconds.',
    why: 'Nothing on the Social media tab can diagnose a post it cannot see, and after 8 logged posts '
      + 'the follower plan stops using a conservative guess and starts using your real conversion rate. '
      + 'Right now every piece of advice you get is generic because there is no data to make it specific.' },

  { scope: 'social', frequency: 'daily', target: 1, worth_cents: 0,
    title: 'Answer every comment in the first hour',
    detail: 'And reply to the best one with a video — that reply is a new post that inherits '
      + 'the attention of the first.',
    why: 'Comments are a distribution signal, not just manners. The first hour is when a video is '
      + 'being tested on strangers, and replies are the cheapest way to keep that test running.' },

  { scope: 'social', frequency: 'weekly', target: 1, worth_cents: 0,
    title: 'Follow up anything that beat your normal — within 24 hours',
    detail: 'Part 2, same shape, same hook pattern, different nails. Today, not next week.',
    why: 'When a video is travelling, the next one goes out to the audience it just found. '
      + 'This is the single biggest thing people get wrong with a video that nearly took off: '
      + 'they celebrate, wait a week, and post something unrelated.' },

  { scope: 'social', frequency: 'weekly', target: 1, worth_cents: 0,
    title: 'One celebrity-angle post a week',
    detail: 'No name needed. "What she asked for", "what I packed", "what it is like backstage".',
    why: 'You do celebrity nails. Almost nobody posting nail content can say that, and it is the one '
      + 'thing on your account that cannot be copied. A set on a known person is a different category '
      + 'of reach from a set on an anonymous hand.' },

  { scope: 'social', frequency: 'daily', target: 1, worth_cents: 0,
    title: 'Ask for the save and the share out loud',
    detail: '"Save this for your next appointment." "Send it to whoever does your nails."',
    why: 'Likes do almost nothing. Saves tell the algorithm it has lasting value and shares reach '
      + 'people who do not follow you at all — which is where new followers actually come from. '
      + 'A post that is not asked to be shared mostly is not.' },

  { scope: 'clients', frequency: 'weekly', target: 1, worth_cents: 0,
    title: 'Check Brianna actually posted every day',
    detail: 'Her streak is on the Monthly recap tab. If she missed days, say so the same week.',
    why: 'She gets a text every morning with the link and the words to use. '
      + 'A daily habit only stays daily if somebody looks — and two people posting daily '
      + 'is twice the reach for no extra money.' },
];

async function seedIfEmpty() {
  await ensure();
  const n = await queryOne('SELECT COUNT(*) AS n FROM recap_actions').catch(() => null);
  if (n && Number(n.n) > 0) return false;
  let i = 0;
  for (const a of SEED) {
    await execute(
      `INSERT INTO recap_actions (scope, title, detail, why, frequency, target, worth_cents, seeded, sort, archived_ts, created_ts)
       VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
      [a.scope, a.title, a.detail, a.why, a.frequency, a.target, a.worth_cents || 0,
       'from your own numbers, ' + todayLA(), i++, Date.now()]);
  }
  return true;
}

/* ── MONEY ──────────────────────────────────────────────────────────────
   Collected, not arranged. Card from Stripe, everything else from what was
   written down at the desk, and the two never counted twice: a card-reader
   payment entered by hand is excluded from the cash side because Stripe
   already has it.

   Stripe's charge list is paged and slow, so it is fetched once for the
   whole window and held briefly — a recap screen that re-sweeps Stripe for
   every month on it takes half a minute to draw. */
let _moneyCache = null;
async function collectedByMonth(months) {
  const want = Math.min(26, Math.max(2, Number(months) || 14));
  const now = studioNow();
  const start = new Date(now.getFullYear(), now.getMonth() - (want - 1), 1, 0, 0, 0);

  if (_moneyCache && _moneyCache.want === want && Date.now() - _moneyCache.at < 5 * 60 * 1000) {
    return _moneyCache.data;
  }

  const m = require('./_money');
  let stripe = { byMonth: {}, bySource: {}, net: 0, refunded: 0, count: 0 };
  let stripeOk = false, stripeWhy = '';
  try {
    const sk = await require('./_pay').getStripeSecret();
    if (sk) {
      stripe = await m.stripeCollected(sk, Math.floor(start.getTime() / 1000));
      stripeOk = true;
    } else {
      stripeWhy = 'Card payments are not switched on, so card takings cannot be counted.';
    }
  } catch (err) {
    stripeWhy = 'Stripe would not answer just now (' + String(err.message || err) + '), '
      + 'so this shows the money written down at the desk only.';
  }

  let cash = { byMonth: {}, byMethod: {}, total: 0, count: 0 };
  try { cash = await m.cashCollected(start.getTime()); } catch (_) {}

  /* Per-month membership money, so "guaranteed money" can be told apart
     from "money somebody had to book for". Only available when Stripe
     answered, because an invoice is the only thing that proves it. */
  const data = {
    stripe_ok: stripeOk, stripe_why: stripeWhy,
    by_month: {}, by_month_source: stripe.byMonthSource || {},
    refunded_cents: money(stripe.refunded),
    cash_by_method: cash.byMethod || {},
  };
  for (let i = 0; i < want; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.getFullYear() + '-' + pad(d.getMonth() + 1);
    data.by_month[key] = {
      card_cents: money((stripe.byMonth || {})[key]),
      cash_cents: money((cash.byMonth || {})[key]),
      total_cents: money((stripe.byMonth || {})[key]) + money((cash.byMonth || {})[key]),
    };
  }

  _moneyCache = { want, at: Date.now(), data };
  return data;
}

/* ── PEOPLE ─────────────────────────────────────────────────────────────
   Visits and people, from both booking books with the mirrors removed.
   "New" is measured against every visit on record, not against the window
   on screen — somebody who came in July is not a new client in November. */
const nameKey = s => lower(s).replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

async function peopleByMonth() {
  const reports = require('./_reports');
  let all;
  try {
    all = await reports.loadRange('2000-01-01', '2099-12-31');
  } catch (_) {
    return { by_month: {}, ok: false };
  }

  const team = reports.withoutMirrors(all.appts, all.team);
  const rows = []
    .concat((all.appts || []).map(a => ({ who: a.client, date: a.date, status: a.status })))
    .concat((team || []).map(a => ({ who: a.client, date: a.date, status: a.status })))
    .concat((all.legacy || []).map(a => ({ who: a.client, date: a.date, status: a.status })))
    .filter(r => r.who && r.date);

  /* The first visit anybody ever had, so "new this month" means new to the
     studio rather than new to the page. */
  const firstEver = {};
  for (const r of rows) {
    if (/cancel/i.test(String(r.status || ''))) continue;
    const k = nameKey(r.who);
    if (!k) continue;
    const d = String(r.date).slice(0, 10);
    if (!firstEver[k] || d < firstEver[k]) firstEver[k] = d;
  }

  const by = {};
  for (const r of rows) {
    const ym = String(r.date).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    by[ym] = by[ym] || { visits: 0, cancelled: 0, people: new Set(), new_people: new Set(), names: {} };
    if (/cancel/i.test(String(r.status || ''))) { by[ym].cancelled++; continue; }
    const k = nameKey(r.who);
    by[ym].visits++;
    if (!k) continue;
    by[ym].people.add(k);
    by[ym].names[k] = r.who;
    if (String(firstEver[k] || '').slice(0, 7) === ym) by[ym].new_people.add(k);
  }

  const out = {};
  for (const ym of Object.keys(by)) {
    const b = by[ym];
    out[ym] = {
      visits: b.visits,
      cancelled: b.cancelled,
      people: b.people.size,
      new_people: b.new_people.size,
      returning_people: Math.max(0, b.people.size - b.new_people.size),
      visits_per_person: b.people.size ? Math.round((b.visits / b.people.size) * 100) / 100 : 0,
      new_names: Array.from(b.new_people).map(k => b.names[k]).filter(Boolean).slice(0, 40),
    };
  }
  return { by_month: out, ok: true, first_ever: firstEver };
}

/* How much of a month is actually written down. This is the number that
   says whether the revenue figure can be trusted yet, and it is shown
   rather than hidden because a total nobody can check is worse than a
   total with a caveat on it. */
async function recordedness(ym) {
  const b = monthBounds(ym);
  let kept = 0, withMoney = 0;
  try {
    const rows = await query(
      'SELECT paid_cents, deposit_paid, status FROM team_appointments WHERE date >= ? AND date <= ?',
      [b.from, b.to]);
    for (const r of rows || []) {
      if (/cancel/i.test(String(r.status || ''))) continue;
      kept++;
      if (money(r.paid_cents) > 0) withMoney++;
    }
  } catch (_) {}
  return {
    kept_visits: kept,
    with_payment: withMoney,
    missing: Math.max(0, kept - withMoney),
    pct: kept ? Math.round((withMoney / kept) * 100) : 0,
  };
}

/* Memberships, as of now. Not per-month, because what matters is what is
   billing today and what it adds up to. Her own test records carry no
   subscription and are left out — counting them would inflate the one
   number in the business that is supposed to be certain. */
async function memberships() {
  const out = { live: [], cancelled: [], mrr_cents: 0, live_count: 0 };
  let rows = [];
  const COLS = 'member_id, full_name, email, tier, status, cancelled_at, '
    + 'membership_started_at, next_billing_at, stripe_subscription_id';
  try {
    rows = await require('./_db').query(
      'SELECT ' + COLS + ', demo FROM members ORDER BY membership_started_at');
  } catch (_) {
    // An older database without the demo flag still has members.
    try {
      rows = await require('./_db').query(
        'SELECT ' + COLS + ' FROM members ORDER BY membership_started_at');
    } catch (_) { return out; }
  }

  /* A plan's monthly price is cycle_cents. */
  const plans = {};
  try {
    const P = require('./_plans');
    for (const p of (P.ALL ? P.ALL() : [])) plans[p.key] = p;
  } catch (_) {}

  for (const m of rows || []) {
    /* Her own test records are on the roster and must never reach the MRR
       figure. Two of them sit there at Luxe and Black Card, which between
       them would overstate guaranteed monthly money by $498 — and the
       whole point of that number is that it is the one she can count on. */
    if (Number(m.demo)) { out.demo = (out.demo || 0) + 1; continue; }

    const cancelled = !!m.cancelled_at || /cancel/i.test(String(m.status || ''));
    const plan = plans[String(m.tier || '').toUpperCase()] || null;
    const price = plan ? money(plan.cycle_cents) : 0;
    const row = {
      member_id: m.member_id, name: m.full_name || '', email: m.email || '',
      tier: m.tier || '', tier_label: plan ? plan.name : (m.tier || ''),
      price_cents: price,
      subscription: m.stripe_subscription_id || '',
      joined: String(m.membership_started_at || '').slice(0, 10),
      next_billing: String(m.next_billing_at || '').slice(0, 10),
      cancelled_at: String(m.cancelled_at || '').slice(0, 10),
    };
    if (cancelled) { out.cancelled.push(row); continue; }
    /* A membership with no Stripe subscription behind it is not billing.
       Said plainly rather than counted, because guaranteed money that is
       not actually arriving is the worst kind of number to have. */
    if (!row.subscription) { out.live.push(Object.assign({ billing: false }, row)); continue; }
    out.live.push(Object.assign({ billing: true }, row));
    out.mrr_cents += price;
    out.live_count++;
  }
  return out;
}

/* ── THE RECAP ──────────────────────────────────────────────────────── */

async function recapFor(ym) {
  const month = /^\d{4}-\d{2}$/.test(String(ym)) ? String(ym) : prevMonth(thisMonth());
  const before = prevMonth(month);

  const [cash, ppl, rec, mem] = await Promise.all([
    collectedByMonth(14), peopleByMonth(), recordedness(month), memberships(),
  ]);

  const m0 = cash.by_month[month] || { card_cents: 0, cash_cents: 0, total_cents: 0 };
  const m1 = cash.by_month[before] || { card_cents: 0, cash_cents: 0, total_cents: 0 };
  const p0 = ppl.by_month[month] || { visits: 0, people: 0, new_people: 0, returning_people: 0, cancelled: 0, visits_per_person: 0, new_names: [] };
  const p1 = ppl.by_month[before] || { visits: 0, people: 0, new_people: 0, returning_people: 0, cancelled: 0 };

  const partial = month === thisMonth();
  const b = monthBounds(month);

  return {
    month, label: monthLabel(month),
    previous: before, previous_label: monthLabel(before),
    partial,
    through: partial ? todayLA() : b.to,

    revenue: {
      total_cents: m0.total_cents,
      card_cents: m0.card_cents,
      cash_cents: m0.cash_cents,
      change: delta(m0.total_cents, m1.total_cents),
      said: sayMoneyDelta(delta(m0.total_cents, m1.total_cents)),
      per_visit_cents: p0.visits ? Math.round(m0.total_cents / p0.visits) : 0,
      stripe_ok: cash.stripe_ok,
      stripe_why: cash.stripe_why,
      refunded_cents: cash.refunded_cents,
      /* This month's split, not the sweep's. Memberships are the money
         that arrives whether anybody books; appointments are the money
         somebody had to be in the chair for. Knowing which is which is
         the difference between a quiet month and a broken one. */
      by_source: (cash.by_month_source || {})[month] || { memberships: 0, appointments: 0, other: 0 },
      cash_by_method: cash.cash_by_method,
      recorded: rec,
    },

    clients: {
      people: p0.people,
      visits: p0.visits,
      cancelled: p0.cancelled,
      new_people: p0.new_people,
      returning_people: p0.returning_people,
      visits_per_person: p0.visits_per_person,
      new_names: p0.new_names,
      change: delta(p0.people, p1.people),
      said: sayCountDelta(delta(p0.people, p1.people), 'people'),
      visits_change: delta(p0.visits, p1.visits),
      visits_said: sayCountDelta(delta(p0.visits, p1.visits), 'visits'),
      new_change: delta(p0.new_people, p1.new_people),
      new_said: sayCountDelta(delta(p0.new_people, p1.new_people), 'new clients'),
    },

    memberships: {
      live: mem.live_count,
      mrr_cents: mem.mrr_cents,
      not_billing: mem.live.filter(x => !x.billing).length,
      cancelled_count: mem.cancelled.length,
      cancelled: mem.cancelled.slice(0, 6),
      rows: mem.live,
    },

    history: Object.keys(cash.by_month).sort().map(k => ({
      month: k, label: monthLabel(k),
      total_cents: cash.by_month[k].total_cents,
      people: (ppl.by_month[k] || {}).people || 0,
      visits: (ppl.by_month[k] || {}).visits || 0,
      new_people: (ppl.by_month[k] || {}).new_people || 0,
    })),
  };
}

/* ── THE LIST OF THINGS TO DO ───────────────────────────────────────── */

/* A tick is one day's worth of doing a thing. For something daily that is
   7 ticks a week; for something weekly, one. Progress is counted inside
   the current period only, so Monday does not keep crediting her for last
   Tuesday — and the streak is counted backwards from today, because the
   point of a daily habit is the run, not the total. */
async function actions({ scope, month } = {}) {
  await ensure();
  await seedIfEmpty();

  const want = String(scope || '').trim();
  let rows = [];
  try {
    rows = await query(
      'SELECT * FROM recap_actions WHERE COALESCE(archived_ts,0) = 0 '
      + (want ? 'AND scope = ? ' : '')
      + 'ORDER BY scope, sort, id', want ? [want] : []);
  } catch (_) {}

  const ids = (rows || []).map(r => Number(r.id));
  let ticks = [];
  if (ids.length) {
    try {
      ticks = await query(
        'SELECT action_id, day FROM recap_ticks WHERE action_id IN ('
        + ids.map(() => '?').join(',') + ') ORDER BY day DESC', ids);
    } catch (_) {}
  }
  const byAction = {};
  for (const t of ticks || []) {
    const k = String(t.action_id);
    (byAction[k] = byAction[k] || []).push(String(t.day));
  }

  const today = todayLA();
  const ymNow = String(month || '').match(/^\d{4}-\d{2}$/) ? String(month) : thisMonth();

  const out = (rows || []).map(r => {
    const f = freqOf(r.frequency);
    const days = (byAction[String(r.id)] || []).slice().sort().reverse();
    const target = Math.max(1, Number(r.target) || f.target || 1);

    /* The window the target applies to. */
    let periodFrom = today;
    if (f.per === 'week') periodFrom = shift(today, -(f.days - 1));
    else if (f.per === 'month') periodFrom = ymNow + '-01';
    else if (f.per === 'ever') periodFrom = '0000-00-00';

    const inPeriod = days.filter(d => d >= periodFrom && d <= today).length;

    /* The run of consecutive days, for anything meant to happen daily.
       Today not being ticked yet does not break a streak — the day is not
       over. */
    let streak = 0;
    if (f.per === 'day') {
      const have = new Set(days);
      let cursor = have.has(today) ? today : shift(today, -1);
      while (have.has(cursor)) { streak++; cursor = shift(cursor, -1); }
    }

    const thisMonthTicks = days.filter(d => d.slice(0, 7) === ymNow).length;

    return {
      id: Number(r.id), scope: r.scope || 'revenue',
      title: r.title || '', detail: r.detail || '', why: r.why || '',
      frequency: r.frequency || 'weekly',
      frequency_label: f.label,
      target, done_this_period: inPeriod,
      complete: f.per === 'ever' ? days.length > 0 : inPeriod >= target,
      done_today: days.indexOf(today) >= 0,
      streak,
      ticks_this_month: thisMonthTicks,
      total_ticks: days.length,
      last_done: days[0] || '',
      worth_cents: money(r.worth_cents),
      seeded: r.seeded || '',
    };
  });

  return {
    actions: out,
    month: ymNow,
    frequencies: Object.keys(FREQUENCIES).map(k => ({ key: k, label: FREQUENCIES[k].label })),
    /* What the whole list is worth if she does it, so the page can say why
       it is worth the bother. Only the ones carrying a measured figure. */
    worth_cents: out.reduce((s, a) => s + a.worth_cents, 0),
  };
}

function shift(ymd, n) {
  return new Date(Date.parse(String(ymd) + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

async function tick(actionId, day, on) {
  await ensure();
  const id = Number(actionId) || 0;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : todayLA();
  if (!id) return { ok: false, why: 'Which one?' };

  if (on === false) {
    await execute('DELETE FROM recap_ticks WHERE action_id = ? AND day = ?', [id, d]);
    return { ok: true, day: d, done: false };
  }
  try {
    await execute('INSERT INTO recap_ticks (action_id, day, note, ts) VALUES (?,?,?,?)',
      [id, d, '', Date.now()]);
  } catch (_) {
    // The unique index already holds it. Ticking twice is ticking once.
  }
  return { ok: true, day: d, done: true };
}

async function saveAction(a) {
  await ensure();
  const id = Number(a.id) || 0;
  const scope = ['revenue', 'clients', 'social'].indexOf(lower(a.scope)) >= 0 ? lower(a.scope) : 'revenue';
  const freq = FREQUENCIES[String(a.frequency)] ? String(a.frequency) : 'weekly';
  const title = String(a.title || '').trim().slice(0, 160);
  if (!title) return { ok: false, why: 'It needs a name.' };

  if (id) {
    await execute(
      'UPDATE recap_actions SET scope=?, title=?, detail=?, why=?, frequency=?, target=?, worth_cents=? WHERE id=?',
      [scope, title, String(a.detail || '').slice(0, 600), String(a.why || '').slice(0, 900),
       freq, Math.max(1, Number(a.target) || 1), money(a.worth_cents), id]);
    return { ok: true, id };
  }
  const n = await queryOne('SELECT COALESCE(MAX(sort),0) AS s FROM recap_actions WHERE scope=?', [scope])
    .catch(() => ({ s: 0 }));
  await execute(
    `INSERT INTO recap_actions (scope, title, detail, why, frequency, target, worth_cents, seeded, sort, archived_ts, created_ts)
     VALUES (?,?,?,?,?,?,?,'',?,0,?)`,
    [scope, title, String(a.detail || '').slice(0, 600), String(a.why || '').slice(0, 900),
     freq, Math.max(1, Number(a.target) || 1), money(a.worth_cents),
     Number((n && n.s) || 0) + 1, Date.now()]);
  const made = await queryOne('SELECT id FROM recap_actions ORDER BY id DESC LIMIT 1');
  return { ok: true, id: Number(made && made.id) || 0 };
}

async function archiveAction(id) {
  await ensure();
  await execute('UPDATE recap_actions SET archived_ts=? WHERE id=?', [Date.now(), Number(id) || 0]);
  return { ok: true };
}

async function resetSeed() {
  await ensure();
  await execute('UPDATE recap_actions SET archived_ts=? WHERE COALESCE(seeded,?) <> ?', [Date.now(), '', '']);
  await execute('DELETE FROM recap_actions');
  await execute('DELETE FROM recap_ticks');
  await seedIfEmpty();
  return { ok: true };
}

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';
  const body = req.body || {};

  try {
    if (req.method === 'GET' && (action === 'month' || !action)) {
      return res.json(await recapFor(req.query.month));
    }
    if (req.method === 'GET' && action === 'actions') {
      return res.json(await actions({ scope: req.query.scope, month: req.query.month }));
    }
    if (req.method === 'POST' && action === 'tick') {
      return res.json(await tick(body.action_id, body.day, body.on !== false));
    }
    if (req.method === 'POST' && action === 'save_action') {
      const out = await saveAction(body);
      return res.status(out.ok ? 200 : 400).json(out);
    }
    if (req.method === 'POST' && action === 'archive_action') {
      return res.json(await archiveAction(body.id));
    }
    if (req.method === 'POST' && action === 'reset_seed') {
      return res.json(await resetSeed());
    }
    if (req.method === 'POST' && action === 'email') {
      const out = await emailRecap({ month: body.month, to: body.to, dry: body.dry !== false });
      return res.status(out.ok === false ? 400 : 200).json(out);
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};

/* ── THE EMAIL ON THE 1st ───────────────────────────────────────────── */

const SHELL = inner => `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px 14px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eee5d8">
    <div style="background:#0D0D0D;padding:26px 24px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:6px;color:#F5EEE8">ZOLA</div>
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8B6A3E;margin-top:6px">Monthly recap</div>
    </div>
    <div style="padding:28px 24px">${inner}</div>
  </div>
</div>`;

const BIG = (label, value, note, good) =>
  '<div style="border:1px solid #eee5d8;background:#faf7f4;padding:16px 18px;margin:0 0 12px">'
  + '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8C7A5E">' + label + '</div>'
  + '<div style="font-size:26px;color:#1a1a1a;margin:4px 0 2px">' + value + '</div>'
  + (note ? '<div style="font-size:13px;color:' + (good === false ? '#B42318' : (good === true ? '#067647' : '#8C7A5E')) + '">' + note + '</div>' : '')
  + '</div>';

async function recapEmailHtml(month) {
  const r = await recapFor(month);
  const a = await actions({});
  const rev = r.revenue, cl = r.clients;

  const todo = a.actions.filter(x => !x.complete).slice(0, 6);

  const body =
    '<p style="font-size:15px;line-height:1.7;color:#3a3027;margin:0 0 18px">'
    + 'Here is <b>' + esc(r.label) + '</b>, next to ' + esc(r.previous_label) + '.</p>'

    + BIG('Money collected', dollars(rev.total_cents),
        esc(rev.said) + ' — ' + esc(r.previous_label) + ' was ' + dollars(rev.change.before),
        rev.change.direction === 'up' ? true : (rev.change.direction === 'down' ? false : null))

    + BIG('Clients', cl.people + (cl.people === 1 ? ' person' : ' people'),
        esc(cl.said) + ' · ' + cl.visits + ' visits · ' + cl.new_people + ' new',
        cl.change.direction === 'up' ? true : (cl.change.direction === 'down' ? false : null))

    + (r.memberships.mrr_cents
        ? BIG('Guaranteed every month', dollars(r.memberships.mrr_cents),
            r.memberships.live + ' memberships billing, whether anybody books or not', true)
        : '')

    + (rev.recorded.missing
        ? '<div style="border:1px solid #FEDF89;background:#FFFAEB;padding:14px 18px;margin:0 0 18px">'
          + '<div style="font-size:13px;color:#93370D;line-height:1.6">'
          + '<b>' + rev.recorded.missing + ' of ' + rev.recorded.kept_visits + ' visits</b> have no payment '
          + 'written down, so the figure above is lower than what you actually took. '
          + 'Studio Manager → Charge a card → the Paid button.</div></div>'
        : '')

    + (todo.length
        ? '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8C7A5E;margin:22px 0 10px">'
          + 'This month</div>'
          + todo.map(x =>
              '<div style="border-bottom:1px solid #f0ebe3;padding:10px 0">'
              + '<div style="font-size:14px;color:#1a1a1a">' + esc(x.title) + '</div>'
              + '<div style="font-size:12px;color:#8C7A5E;margin-top:2px">' + esc(x.frequency_label)
              + (x.worth_cents ? ' · worth about ' + dollars(x.worth_cents) + ' a year' : '')
              + '</div></div>').join('')
        : '')

    + '<p style="font-size:13px;line-height:1.7;color:#8C7A5E;margin:22px 0 0">'
    + 'The full recap, with the reason behind every line and the boxes to tick, is in '
    + 'Studio Manager under <b>Monthly recap</b>.</p>';

  const dir = rev.change.direction === 'down' ? '↓' : (rev.change.direction === 'up' ? '↑' : '→');
  return {
    subject: 'ZOLA ✦ ' + r.label + ': ' + dollars(rev.total_cents) + ' ' + dir + ' · '
      + cl.people + ' clients',
    html: SHELL(body),
    recap: r,
  };
}

async function emailRecap({ month, to, dry } = {}) {
  const built = await recapEmailHtml(month);
  const addr = String(to || process.env.OWNER_EMAIL || 'zolastudioempire@gmail.com').trim();
  if (dry) return { ok: true, dry: true, to: addr, subject: built.subject, html: built.html };
  const sent = await require('./_notify').sendEmail(addr, built.subject, built.html, { kind: 'monthly_recap' });
  return { ok: true, to: addr, subject: built.subject, sent };
}

module.exports.recapFor = recapFor;
module.exports.actions = actions;
module.exports.tick = tick;
module.exports.saveAction = saveAction;
module.exports.memberships = memberships;
module.exports.peopleByMonth = peopleByMonth;
module.exports.collectedByMonth = collectedByMonth;
module.exports.recordedness = recordedness;
module.exports.recapEmailHtml = recapEmailHtml;
module.exports.emailRecap = emailRecap;
module.exports.delta = delta;
module.exports.sayMoneyDelta = sayMoneyDelta;
module.exports.sayCountDelta = sayCountDelta;
module.exports.monthLabel = monthLabel;
module.exports.prevMonth = prevMonth;
module.exports.FREQUENCIES = FREQUENCIES;
module.exports.SEED = SEED;
