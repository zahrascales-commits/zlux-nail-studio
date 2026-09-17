// The Home screen, the "needs attention" list, and the system check.
//
// Home answers "how is the studio doing today compared with yesterday" in
// the numbers a business owner actually looks at: visitors, bookings, money
// in. Every figure has the figure before it next to it, because a number on
// its own cannot say whether things are going up or down.
//
// Alerts answer "is anything broken or about to cost me money". Each check
// runs on its own with a time limit, so one slow provider can never stop the
// rest of the list from arriving, and a check that cannot run says so
// instead of quietly reporting everything fine.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const SITE = process.env.PUBLIC_BASE_URL || 'https://zolanailstudio.com';
const DOMAIN = SITE.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const TZ = 'America/Los_Angeles';
const DAY = 86400000;

/* ── dates, in Porterville ── */
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = ms => dayFmt.format(new Date(Number(ms)));
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}
// SQLite datetime('now') is UTC without a zone marker.
const utcTextToMs = s => {
  const t = Date.parse(String(s || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s || '')) ? '' : 'Z'));
  return isNaN(t) ? 0 : t;
};

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(e => (typeof fallback === 'function' ? fallback(e) : fallback)),
    new Promise(r => setTimeout(() => r(typeof fallback === 'function' ? fallback(new Error('timed out')) : fallback), ms)),
  ]);
}

async function setting(key) {
  try { const r = await queryOne('SELECT value FROM site_settings WHERE key = ?', [key]); return r ? r.value : null; }
  catch (_) { return null; }
}
async function saveSetting(key, value) {
  await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, String(value)]);
}

/* Runs another endpoint's handler in-process, as the owner, so the checks
   here use exactly the logic those screens use rather than a second copy of
   it that could drift. */
function invoke(handler, { method = 'GET', query: q = {}, body = null } = {}) {
  return new Promise(resolve => {
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(o) { resolve({ status: code, body: o }); return res; },
      send(o) { resolve({ status: code, body: o }); return res; },
      setHeader() { return res; },
      end() { resolve({ status: code, body: null }); return res; },
    };
    const req = { method, query: q, body, headers: { 'x-ceo-password': CEO_PASSWORD } };
    Promise.resolve().then(() => handler(req, res))
      .catch(e => resolve({ status: 500, body: { error: String(e.message || e) } }));
  });
}

async function stripeKey() {
  try { return await require('./_pay').getStripeSecret(); } catch (_) {}
  return (await setting('stripe_secret')) || process.env.STRIPE_SECRET_KEY || '';
}

/* ═══════════════════════ HOME ═══════════════════════ */

function sourceOf(ref) {
  const r = String(ref || '').toLowerCase();
  if (!r) return 'Direct / typed in';
  let host = r;
  try { host = new URL(r).hostname; } catch (_) {}
  if (host.endsWith(DOMAIN)) return null; // moving around her own site
  if (/instagram/.test(host)) return 'Instagram';
  if (/facebook|fb\.com|fbclid/.test(host)) return 'Facebook';
  if (/tiktok/.test(host)) return 'TikTok';
  if (/google/.test(host)) return 'Google';
  if (/bing|duckduckgo|yahoo/.test(host)) return 'Other search';
  if (/chatgpt|openai|perplexity|claude|gemini|copilot/.test(host)) return 'AI assistants';
  if (/yelp/.test(host)) return 'Yelp';
  return host.replace(/^www\./, '');
}

async function homeData() {
  await ensureTables();
  const now = Date.now();
  const today = dayOf(now);
  const yesterday = addDays(today, -1);
  const days30 = [];
  for (let i = 29; i >= 0; i--) days30.push(addDays(today, -i));
  const last7 = new Set(days30.slice(-7));
  const prev7 = new Set(days30.slice(-14, -7));
  const since = now - 32 * DAY;

  const blank = () => ({ today: 0, yesterday: 0, last7: 0, prev7: 0 });
  const tally = (obj, key, n = 1) => {
    if (key === today) obj.today += n;
    if (key === yesterday) obj.yesterday += n;
    if (last7.has(key)) obj.last7 += n;
    if (prev7.has(key)) obj.prev7 += n;
  };

  const perDay = {};
  for (const d of days30) perDay[d] = { day: d, visitors: 0, pageviews: 0, bookings: 0, cents: 0, _s: new Set() };

  /* visitors and page views */
  const visitors = blank(), pageviews = blank();
  const sessionsByBucket = { today: new Set(), yesterday: new Set(), last7: new Set(), prev7: new Set() };
  const sources = {};
  const pages = {};
  let lastViewTs = 0;
  try {
    const rows = await query(
      "SELECT session_id, path, referrer, ts FROM analytics_pageviews WHERE ts >= ? AND session_id NOT LIKE 'zz-%' ORDER BY ts",
      [since]);
    const firstSeen = {};
    for (const r of rows) {
      const ts = Number(r.ts);
      if (ts > lastViewTs) lastViewTs = ts;
      const k = dayOf(ts);
      tally(pageviews, k);
      if (perDay[k]) { perDay[k].pageviews++; perDay[k]._s.add(r.session_id); }
      if (k === today) sessionsByBucket.today.add(r.session_id);
      if (k === yesterday) sessionsByBucket.yesterday.add(r.session_id);
      if (last7.has(k)) {
        sessionsByBucket.last7.add(r.session_id);
        pages[r.path] = (pages[r.path] || 0) + 1;
        if (!firstSeen[r.session_id]) {
          firstSeen[r.session_id] = true;
          const s = sourceOf(r.referrer);
          if (s) sources[s] = (sources[s] || 0) + 1;
        }
      }
      if (prev7.has(k)) sessionsByBucket.prev7.add(r.session_id);
    }
    if (!lastViewTs) {
      const last = await queryOne("SELECT MAX(ts) AS t FROM analytics_pageviews WHERE session_id NOT LIKE 'zz-%'");
      lastViewTs = Number(last && last.t) || 0;
    }
  } catch (_) {}
  for (const b of Object.keys(sessionsByBucket)) visitors[b] = sessionsByBucket[b].size;
  for (const d of days30) { perDay[d].visitors = perDay[d]._s.size; delete perDay[d]._s; }

  /* bookings made (when they were booked, not when the appointment is) */
  const bookings = blank();
  try {
    const cutoff = new Date(since).toISOString().replace('T', ' ').slice(0, 19);
    const rows = await query('SELECT created_at FROM team_appointments WHERE created_at >= ?', [cutoff]);
    for (const r of rows) {
      const ms = utcTextToMs(r.created_at);
      if (!ms) continue;
      const k = dayOf(ms);
      tally(bookings, k);
      if (perDay[k]) perDay[k].bookings++;
    }
  } catch (_) {}

  /* money that actually arrived: card (Stripe, net of refunds) + desk cash */
  const collected = blank();
  let moneyError = '';
  const sk = await stripeKey();
  const from14 = Math.floor((now - 15 * DAY) / 1000);
  if (sk) {
    try {
      let after = null;
      for (let page = 0; page < 10; page++) {
        const p = new URLSearchParams({ limit: '100', 'created[gte]': String(from14) });
        if (after) p.set('starting_after', after);
        const r = await withTimeout(fetch('https://api.stripe.com/v1/charges?' + p, {
          headers: { Authorization: 'Bearer ' + sk } }), 8000, null);
        if (!r) { moneyError = 'Stripe was slow to answer'; break; }
        const j = await r.json();
        if (!r.ok) { moneyError = (j.error && j.error.message) || 'Stripe refused'; break; }
        for (const ch of j.data || []) {
          if (ch.status !== 'succeeded') continue;
          const net = Math.round(Number(ch.amount) || 0) - Math.round(Number(ch.amount_refunded) || 0);
          if (net <= 0) continue;
          const k = dayOf(Number(ch.created) * 1000);
          tally(collected, k, net);
          if (perDay[k]) perDay[k].cents += net;
        }
        if (!j.has_more || !(j.data || []).length) break;
        after = j.data[j.data.length - 1].id;
      }
    } catch (e) { moneyError = String(e.message || e); }
  } else moneyError = 'No Stripe key saved';
  try {
    const rows = await query("SELECT amount_cents, ts FROM kiosk_log WHERE type='checkout' AND method='cash' AND ts >= ?",
      [now - 15 * DAY]);
    for (const r of rows) {
      const c = Math.round(Number(r.amount_cents) || 0);
      if (c <= 0) continue;
      const k = dayOf(Number(r.ts));
      tally(collected, k, c);
      if (perDay[k]) perDay[k].cents += c;
    }
  } catch (_) {}

  /* AI assistants reading the site */
  const ai = { last7: 0, prev7: 0, last30: 0 };
  try {
    const rows = await query("SELECT ts FROM ai_crawls WHERE ts >= ? AND kind = 'ai'", [now - 30 * DAY]);
    for (const r of rows) {
      const k = dayOf(Number(r.ts));
      ai.last30++;
      if (last7.has(k)) ai.last7++;
      if (prev7.has(k)) ai.prev7++;
    }
  } catch (_) {}

  /* deposits still to come in, on appointments that have not happened yet */
  const deposits = { count: 0, cents: 0 };
  try {
    const rows = await query(
      `SELECT deposit_cents, price_cents, deposit_paid, status FROM team_appointments
        WHERE date >= ? AND COALESCE(deposit_paid, 0) <> 1`, [today]);
    for (const r of rows) {
      if (/cancel|complete|no_show|noshow/i.test(String(r.status || ''))) continue;
      const dep = Math.round(Number(r.deposit_cents) || 0);
      const price = Math.round(Number(r.price_cents) || 0);
      if (dep <= 0 && price <= 0) continue;
      deposits.count++;
      deposits.cents += dep > 0 ? dep : Math.round(price / 2);
    }
  } catch (_) {}

  const top = (obj, n) => Object.entries(obj).map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count).slice(0, n);

  return {
    today, yesterday,
    visitors, pageviews, bookings, collected, money_error: moneyError,
    ai_crawls: ai,
    deposits_waiting: deposits,
    series: days30.map(d => perDay[d]),
    sources: top(sources, 6),
    top_pages: top(pages, 6),
    last_view_ts: lastViewTs,
  };
}

/* ═══════════════════════ CHECKS ═══════════════════════ */

async function stripeAccount() {
  const sk = await stripeKey();
  if (!sk) return { ok: false, why: 'no key' };
  const r = await fetch('https://api.stripe.com/v1/account', { headers: { Authorization: 'Bearer ' + sk } });
  const j = await r.json();
  if (!r.ok) return { ok: false, why: (j.error && j.error.message) || ('Stripe ' + r.status), status: r.status };
  const req = j.requirements || {};
  return {
    ok: true,
    live: /^(sk|rk)_live_/.test(sk),
    restricted: /^rk_/.test(sk),
    charges_enabled: !!j.charges_enabled,
    payouts_enabled: !!j.payouts_enabled,
    currently_due: (req.currently_due || []).length,
    past_due: (req.past_due || []).length,
    disabled_reason: req.disabled_reason || '',
    account_id: j.id,
  };
}

async function resendDomains() {
  const key = process.env.RESEND_API_KEY || (await setting('resend_key')) || '';
  if (!key) return { ok: false, why: 'no key' };
  const r = await fetch('https://api.resend.com/domains', { headers: { Authorization: 'Bearer ' + key } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // A sending-only key cannot list domains. That is a permissions answer,
    // not a broken connection.
    if (r.status === 401 || r.status === 403) return { ok: true, restricted: true };
    return { ok: false, why: (j && j.message) || ('Resend ' + r.status) };
  }
  const list = (j.data || []).map(d => ({ name: d.name, status: d.status }));
  const mine = list.find(d => DOMAIN.endsWith(d.name));
  return { ok: true, domains: list, verified: !!(mine && mine.status === 'verified'), status: mine ? mine.status : 'not added' };
}

async function twilioAccount() {
  const sid = process.env.TWILIO_ACCOUNT_SID || (await setting('twilio_sid')) || '';
  const token = process.env.TWILIO_AUTH_TOKEN || (await setting('twilio_token')) || '';
  if (!sid || !token) return { ok: false, why: 'not connected' };
  const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '.json', {
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64') } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, why: j.message || ('Twilio ' + r.status) };
  return { ok: j.status === 'active', status: j.status, why: j.status === 'active' ? '' : 'account ' + j.status };
}

/* When the domain has to be renewed. Looked up from the public registry at
   most once a day — it changes once a year. */
async function domainExpiry() {
  try {
    const cached = JSON.parse((await setting('domain_expiry_cache')) || 'null');
    if (cached && Date.now() - cached.at < DAY && cached.date) return cached;
  } catch (_) {}
  const tld = DOMAIN.split('.').pop();
  const url = tld === 'com' || tld === 'net'
    ? 'https://rdap.verisign.com/' + tld + '/v1/domain/' + DOMAIN
    : 'https://rdap.org/domain/' + DOMAIN;
  const r = await fetch(url, { headers: { Accept: 'application/rdap+json' } });
  if (!r.ok) throw new Error('registry ' + r.status);
  const j = await r.json();
  const ev = (j.events || []).find(e => /expir/i.test(e.eventAction));
  if (!ev) throw new Error('no expiry date published');
  const out = { at: Date.now(), date: ev.eventDate };
  try { await saveSetting('domain_expiry_cache', JSON.stringify(out)); } catch (_) {}
  return out;
}

async function siteUp() {
  const started = Date.now();
  const r = await fetch(SITE + '/?uptime=' + started, { redirect: 'follow' });
  return { ok: r.ok, status: r.status, ms: Date.now() - started };
}

async function dbPing() {
  const started = Date.now();
  await query('SELECT 1 AS one');
  return { ok: true, ms: Date.now() - started };
}

async function alertsList({ deep = true } = {}) {
  await ensureTables();
  const out = [];
  const add = (level, id, title, detail, tab, cta) => out.push({ level, id, title, detail, tab: tab || '', cta: cta || '' });
  const today = dayOf(Date.now());

  const [stripe, providers, resend, domain, up, attention, reconcile] = await Promise.all([
    withTimeout(stripeAccount(), 7000, e => ({ ok: false, why: String(e.message || e), unreachable: true })),
    withTimeout(require('./_notify').providerStatus(), 5000, null),
    withTimeout(resendDomains(), 6000, e => ({ ok: false, why: String(e.message || e), unreachable: true })),
    withTimeout(domainExpiry(), 6000, e => ({ error: String(e.message || e) })),
    withTimeout(siteUp(), 8000, e => ({ ok: false, why: String(e.message || e) })),
    withTimeout(invoke(require('./_attention')), 8000, null),
    deep ? withTimeout(invoke(require('./_reconcile'), { query: { days: '21' } }), 12000, null) : null,
  ]);

  /* ── money ── */
  if (await setting('stripe_secret_exposed')) {
    add('critical', 'stripe-key-exposed', 'Replace your Stripe secret key',
      'Until today your Stripe secret key could be read from a public page on your website. That is fixed, but anyone who saw it could still use it. In Stripe, go to Developers → API keys → Roll key, then paste the new key into Settings → Connect payments. This alert clears itself when the new key is saved.',
      'settings', 'Open Settings');
  }
  if (stripe && !stripe.ok) {
    if (stripe.why === 'no key') add('critical', 'stripe-none', 'Card payments are not connected', 'No Stripe key is saved, so the website cannot take deposits.', 'settings', 'Connect Stripe');
    else if (stripe.unreachable) add('info', 'stripe-slow', 'Could not reach Stripe just now', 'The check timed out. This is usually Stripe being slow, not a problem with your account. It is checked again next time.', '', '');
    else add('critical', 'stripe-key', 'Stripe is refusing your key', 'Stripe said: ' + stripe.why + '. Deposits cannot be taken until a working key is saved in Settings.', 'settings', 'Open Settings');
  } else if (stripe) {
    if (!stripe.charges_enabled) add('critical', 'stripe-charges', 'Stripe has paused card payments', 'Clients cannot pay deposits right now.' + (stripe.disabled_reason ? ' Stripe gives the reason as: ' + stripe.disabled_reason + '.' : '') + ' Log in to Stripe to see what it needs.', 'payouts', 'Open Payouts');
    if (!stripe.payouts_enabled) add('critical', 'stripe-payouts', 'Stripe has paused payouts to your bank', 'Money is being taken but not sent to your bank. Log in to Stripe to see what it needs.', 'payouts', 'Open Payouts');
    if (stripe.past_due) add('critical', 'stripe-past-due', 'Stripe needs information from you — overdue', stripe.past_due + ' item' + (stripe.past_due === 1 ? '' : 's') + ' Stripe asked for are overdue. Payments or payouts can be paused if this is left.', 'payouts', 'Open Payouts');
    else if (stripe.currently_due) add('warning', 'stripe-due', 'Stripe is asking for information', stripe.currently_due + ' item' + (stripe.currently_due === 1 ? '' : 's') + ' to fill in on your Stripe account.', 'payouts', 'Open Payouts');
    if (!stripe.live) add('warning', 'stripe-test', 'Stripe is in test mode', 'Payments on the website are not real money.', 'settings', 'Open Settings');
  }

  /* ── messages to clients ── */
  if (providers) {
    if (!providers.email) add('critical', 'email-off', 'Emails to clients are switched off', 'No email provider is connected, so confirmations and deposit reminders are not being sent.', 'settings', 'Connect email');
    else if (providers.from_is_sandbox) add('critical', 'email-sandbox', 'Client emails are going nowhere', 'Emails are sending from a test address that only reaches you. Set the from-address in Settings.', 'settings', 'Open Settings');
    if (!providers.sms) add('info', 'sms-off', 'Texting is not connected', 'Clients get emails only. Connect Twilio in Settings to text them too.', 'settings', 'Open Settings');
  }
  if (resend && resend.ok && resend.domains && !resend.verified) {
    add('warning', 'email-domain', 'Your email domain is not verified', DOMAIN + ' shows as "' + resend.status + '" in Resend, so emails may land in spam or bounce.', 'devtools', 'See details');
  }
  try {
    const failed = await query('SELECT subject, detail, ts FROM mail_log WHERE sent = 0 AND ts >= ? ORDER BY ts DESC', [Date.now() - 3 * DAY]);
    if (failed.length) {
      add('warning', 'email-failed', failed.length + ' email' + (failed.length === 1 ? '' : 's') + ' did not send in the last 3 days',
        'Most recent: "' + String(failed[0].subject || '').slice(0, 70) + '"' + (failed[0].detail ? ' — ' + String(failed[0].detail).slice(0, 90) : '') + '.',
        'maillog', 'See emails');
    }
  } catch (_) {}

  /* ── the diary ── */
  try {
    const soon = addDays(today, 2);
    const rows = await query(
      `SELECT client_name, date, time, deposit_cents, price_cents, status FROM team_appointments
        WHERE date >= ? AND date <= ? AND COALESCE(deposit_paid,0) <> 1 ORDER BY date, time`, [today, soon]);
    const due = rows.filter(r => !/cancel|complete|no_show|noshow/i.test(String(r.status || ''))
      && (Number(r.deposit_cents) > 0 || Number(r.price_cents) > 0));
    if (due.length) {
      const names = due.slice(0, 3).map(r => (String(r.client_name || 'Guest').split(' ')[0])).join(', ');
      add('warning', 'deposits-soon', due.length + ' appointment' + (due.length === 1 ? '' : 's') + ' in the next 2 days with no deposit',
        names + (due.length > 3 ? ' and ' + (due.length - 3) + ' more' : '') + '. Automatic reminders are already going out.', 'deposits', 'See deposits');
    }
  } catch (_) {}
  const need = attention && attention.body && !attention.body.error ? attention.body : null;
  if (need) {
    const un = (need.unassigned || []).filter(u => u.days_away <= 3);
    if (un.length) add('warning', 'unassigned', un.length + ' upcoming appointment' + (un.length === 1 ? ' has' : 's have') + ' no artist',
      un.slice(0, 3).map(u => u.client + ' (' + u.date + ')').join(', ') + '. Somebody needs to be given ' + (un.length === 1 ? 'it' : 'them') + '.', 'overview', 'Assign now');
    const cal = need.calendar;
    if (cal && cal.short) {
      add(cal.days_left < 0 || !cal.studio_last ? 'critical' : 'warning', 'calendar-short',
        cal.days_left < 0 || !cal.studio_last ? 'Nobody can book — no working days are scheduled' : 'Bookable days run out in ' + cal.days_left + ' days',
        'Clients looking further ahead see an empty calendar. Add working days in Artist schedules.', 'scheduling', 'Add days');
    }
  }
  if (reconcile && reconcile.body && reconcile.body.ok) {
    const R = reconcile.body;
    if ((R.gaps || []).length) add('warning', 'paid-not-marked', R.gaps.length + ' deposit' + (R.gaps.length === 1 ? ' was' : 's were') + ' paid but not marked paid',
      'Stripe took the money but the booking still says unpaid, so the client may keep getting reminders.', 'devtools', 'Review');
    if (R.till_sees_website_bookings && R.till_sees_website_bookings.ok === false) add('warning', 'till-blind', 'The front desk cannot see website bookings', String(R.till_sees_website_bookings.why || '').slice(0, 140), 'devtools', 'Review');
  }

  /* ── inbox ── */
  try {
    const r = await queryOne("SELECT COUNT(*) AS n FROM inquiries WHERE status = 'new' AND ts < ?", [Date.now() - DAY]);
    const n = Number(r && r.n) || 0;
    if (n) add('warning', 'inquiries-waiting', n + ' website message' + (n === 1 ? '' : 's') + ' waiting more than a day', 'Someone asked a question through the website and has not had an answer.', 'inbox', 'Open Inbox');
  } catch (_) {}

  /* ── stock ── */
  try {
    const low = await query('SELECT name FROM studio_inventory WHERE qty <= low_threshold');
    if (low.length) add('info', 'low-stock', low.length + ' item' + (low.length === 1 ? ' is' : 's are') + ' running low', low.slice(0, 4).map(x => x.name).join(', ') + '.', 'inventory', 'See inventory');
  } catch (_) {}

  /* ── the machinery ── */
  const cronLast = Number(await setting('cron_reminders_last')) || 0;
  if (cronLast && Date.now() - cronLast > 16 * 3600000) {
    add('critical', 'cron-stale', 'Automatic reminders have stopped running',
      'They last ran ' + Math.round((Date.now() - cronLast) / 3600000) + ' hours ago. Deposit and appointment reminders are not going out.', 'devtools', 'See details');
  }
  try {
    const last = await queryOne("SELECT MAX(ts) AS t FROM analytics_pageviews WHERE session_id NOT LIKE 'zz-%'");
    const t = Number(last && last.t) || 0;
    if (!t || Date.now() - t > 2 * DAY) {
      add('warning', 'tracking-quiet', 'No website visits recorded in 2 days',
        t ? 'Either nobody has visited, or visitor tracking has stopped. Worth opening your site once to check it counts.' : 'Visitor counting has no history yet. It starts filling in from the next visit.', 'traffic', 'Open Traffic');
    }
  } catch (_) {}
  if (up && !up.ok) add('critical', 'site-down', 'Your website is not loading', 'The homepage answered ' + (up.status || up.why || 'nothing') + '.', 'devtools', 'See details');
  if (domain && domain.date) {
    const daysLeft = Math.floor((Date.parse(domain.date) - Date.now()) / DAY);
    if (daysLeft <= 30) add('critical', 'domain-expiry', DOMAIN + ' expires in ' + daysLeft + ' days', 'If it lapses the whole website and your email go down. Renew it at Namecheap and turn on auto-renew.', 'devtools', 'See details');
    else if (daysLeft <= 60) add('warning', 'domain-expiry', DOMAIN + ' expires in ' + daysLeft + ' days', 'Renew it at Namecheap, or check auto-renew is on.', 'devtools', 'See details');
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level]);
  return {
    alerts: out,
    counts: {
      critical: out.filter(a => a.level === 'critical').length,
      warning: out.filter(a => a.level === 'warning').length,
      info: out.filter(a => a.level === 'info').length,
    },
    checked_at: Date.now(),
  };
}

/* ═══════════════════════ SYSTEM CHECK ═══════════════════════ */

async function healthData() {
  await ensureTables();
  const [db, stripe, resend, twilio, domain, up, providers] = await Promise.all([
    withTimeout(dbPing(), 5000, e => ({ ok: false, why: String(e.message || e) })),
    withTimeout(stripeAccount(), 7000, e => ({ ok: false, why: String(e.message || e) })),
    withTimeout(resendDomains(), 6000, e => ({ ok: false, why: String(e.message || e) })),
    withTimeout(twilioAccount(), 6000, e => ({ ok: false, why: String(e.message || e) })),
    withTimeout(domainExpiry(), 6000, e => ({ error: String(e.message || e) })),
    withTimeout(siteUp(), 8000, e => ({ ok: false, why: String(e.message || e) })),
    withTimeout(require('./_notify').providerStatus(), 5000, null),
  ]);

  let applePay = null;
  try {
    const r = await invoke(require('./_manager'), { query: { action: 'apple_pay_status' } });
    applePay = r.body;
  } catch (_) {}

  let lastView = 0, lastCrawl = 0;
  try { lastView = Number((await queryOne("SELECT MAX(ts) AS t FROM analytics_pageviews WHERE session_id NOT LIKE 'zz-%'")).t) || 0; } catch (_) {}
  try { lastCrawl = Number((await queryOne('SELECT MAX(ts) AS t FROM ai_crawls')).t) || 0; } catch (_) {}

  return {
    checked_at: Date.now(),
    database: db,
    website: up,
    stripe,
    webhook_secret_saved: !!((await setting('stripe_webhook_secret')) || process.env.STRIPE_WEBHOOK_SECRET),
    apple_pay: applePay,
    email: { provider: providers, domain: resend },
    sms: { provider: providers ? { connected: providers.sms, from: providers.from_phone } : null, account: twilio },
    domain: domain && domain.date
      ? { name: DOMAIN, expires: domain.date, days_left: Math.floor((Date.parse(domain.date) - Date.now()) / DAY) }
      : { name: DOMAIN, error: (domain && domain.error) || 'unknown' },
    crons: {
      schedule: ['Every day at 1:00 AM and 10:00 AM Pacific (08:00 and 17:00 UTC)'],
      reminders_last_run: Number(await setting('cron_reminders_last')) || 0,
    },
    tracking: { last_visit_ts: lastView, last_ai_crawl_ts: lastCrawl },
    ai_key_saved: !!(process.env.ANTHROPIC_API_KEY || (await setting('anthropic_key'))),
    deploy: {
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7),
      message: String(process.env.VERCEL_GIT_COMMIT_MESSAGE || '').split('\n')[0].slice(0, 120),
      branch: process.env.VERCEL_GIT_COMMIT_REF || '',
      env: process.env.VERCEL_ENV || 'local',
      region: process.env.VERCEL_REGION || '',
      node: process.version,
    },
  };
}

/* Checks every public page and the endpoints they depend on answer. GET
   only — nothing here can create, change or send anything. */
async function siteCheck() {
  const pages = ['/', '/services.html', '/booking.html', '/memberships.html', '/pressons.html', '/classes.html',
    '/about.html', '/contact.html', '/signup.html', '/account.html', '/client-portal.html', '/visit.html',
    '/manager.html', '/team.html', '/checkin.html', '/robots.txt', '/sitemap.xml', '/llms.txt'];
  const apis = ['/api/services', '/api/deals', '/api/site-settings', '/api/pay?action=config', '/api/photos'];
  const one = async path => {
    const started = Date.now();
    try {
      const r = await withTimeout(fetch(SITE + path, { redirect: 'follow' }), 10000, null);
      if (!r) return { path, ok: false, status: 0, why: 'timed out', ms: Date.now() - started };
      let why = '';
      if (path.startsWith('/api/')) {
        const t = await r.text();
        try { JSON.parse(t); } catch (_) { why = 'did not return data'; }
      }
      return { path, ok: r.ok && !why, status: r.status, why, ms: Date.now() - started };
    } catch (e) { return { path, ok: false, status: 0, why: String(e.message || e), ms: Date.now() - started }; }
  };
  const results = await Promise.all(pages.concat(apis).map(one));
  return { results, ok: results.every(r => r.ok), checked_at: Date.now() };
}

/* ═══════════════════════ TELLING HER ═══════════════════════
   Called by the twice-daily cron. Only the things worth interrupting her
   for, and each one at most once every three days, so a problem she already
   knows about does not become a text she learns to ignore. */
const NOTIFY_IDS = new Set(['stripe-key-exposed', 'stripe-none', 'stripe-key', 'stripe-charges', 'stripe-payouts',
  'stripe-past-due', 'email-off', 'email-sandbox', 'site-down', 'domain-expiry', 'calendar-short', 'unassigned',
  'paid-not-marked', 'email-failed', 'inquiries-waiting']);

async function notifyOwner(sendToOwner, fresh) {
  const { alerts } = await alertsList({ deep: true });
  const bucket = Math.floor(Date.now() / (3 * DAY));
  const sent = [];
  for (const a of alerts) {
    if (a.level === 'info' || !NOTIFY_IDS.has(a.id)) continue;
    if (!(await fresh('alert:' + a.id + ':' + bucket))) continue;
    await sendToOwner((a.level === 'critical' ? '⚠️ ' : '') + a.title, a.detail);
    sent.push(a.id);
  }
  return sent;
}

/* ═══════════════════════ WHO PAID WHAT ═══════════════════════
   Every card payment in a window with the person Stripe has on it — the
   name and email typed at the card, the receipt address, and whatever the
   site attached — beside every booking in both books. A deposit paid on the
   booking page can carry no name at all (the intent is made before the name
   is typed), so the card holder is often the only way to say whose it is. */
async function paymentsLedger(days) {
  await ensureTables();
  const sk = await stripeKey();
  const since = Math.floor((Date.now() - days * DAY) / 1000);
  const charges = [];
  if (sk) {
    let after = null;
    for (let page = 0; page < 10; page++) {
      const p = new URLSearchParams({ limit: '100', 'created[gte]': String(since) });
      p.append('expand[]', 'data.payment_intent');
      if (after) p.set('starting_after', after);
      const r = await fetch('https://api.stripe.com/v1/charges?' + p, { headers: { Authorization: 'Bearer ' + sk } });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe refused');
      for (const ch of j.data || []) {
        const pi = ch.payment_intent && typeof ch.payment_intent === 'object' ? ch.payment_intent : null;
        const bd = ch.billing_details || {};
        charges.push({
          id: ch.id, created: ch.created * 1000, status: ch.status, amount: ch.amount, refunded: ch.amount_refunded,
          description: ch.description || '',
          card_name: bd.name || '', card_email: bd.email || '', card_phone: bd.phone || '',
          receipt_email: ch.receipt_email || '',
          wallet: ((ch.payment_method_details || {}).card || {}).wallet ? ((ch.payment_method_details.card.wallet || {}).type || '') : '',
          payment_intent: pi ? pi.id : (ch.payment_intent || ''),
          meta: Object.assign({}, pi ? pi.metadata : {}, ch.metadata || {}),
        });
      }
      if (!j.has_more || !(j.data || []).length) break;
      after = j.data[j.data.length - 1].id;
    }
  }
  const sinceDay = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  let team = [], site = [];
  try {
    team = await query(`SELECT id, client_name, client_email, client_phone, service, date, time, status, price_cents,
      deposit_cents, deposit_paid, paid_cents, checked_out_ts, chat_token, created_at, team_member_id
      FROM team_appointments WHERE date >= ? ORDER BY date, time`, [sinceDay]);
  } catch (_) {}
  try {
    site = await require('./_db').query(`SELECT * FROM appointments WHERE appointment_date >= ? ORDER BY appointment_date, appointment_time`, [sinceDay]);
  } catch (e) { site = [{ error: String(e.message || e) }]; }
  return { charges, team, site };
}

/* Where each appointment's deposit stands, for the calendar. The same
   answer the deposit page and the checkout work from: a deposit recorded
   as taken is a fact; one not taken is worked out by the code that charges
   it, which knows about memberships and personal rates. */
async function depositStates(from, to) {
  await ensureTables();
  const rows = await query(
    `SELECT id, client_name, client_email, client_phone, service, date, time, status, price_cents,
            deposit_cents, deposit_paid, paid_cents, checked_out_ts, team_member_id
       FROM team_appointments WHERE date >= ? AND date <= ?`, [from, to]);
  const visit = require('./_visit');
  const out = {};
  const live = rows.filter(a => !/cancel/i.test(String(a.status || '')));
  const todayKey = dayOf(Date.now());
  for (let i = 0; i < live.length; i += 16) {
    await Promise.all(live.slice(i, i + 16).map(async a => {
      const id = String(a.id);
      if (Number(a.checked_out_ts) > 0 || /complete/i.test(String(a.status || ''))) {
        out[id] = { state: 'done', deposit_cents: Math.round(Number(a.deposit_cents) || 0), paid_cents: Math.round(Number(a.paid_cents) || 0), deposit_paid: Number(a.deposit_paid) === 1 };
        return;
      }
      if (Number(a.deposit_paid) === 1) {
        out[id] = { state: 'paid', deposit_cents: Math.round(Number(a.deposit_cents) || 0) };
        return;
      }
      // A day already gone needs no working out — nobody is paying a deposit for it now.
      if (String(a.date) < todayKey) { out[id] = { state: 'past' }; return; }
      let due = null;
      try { due = Math.round(Number(await visit.depositFor(a)) || 0); } catch (_) {}
      out[id] = due === null ? { state: 'unknown' } : due > 0 ? { state: 'unpaid', due_cents: due } : { state: 'none_due' };
    }));
  }
  return out;
}

/* Setting a deposit to what Stripe shows. Written to the studio book and,
   when given, the website book, and logged — a changed money figure with no
   trail is how the next disagreement starts. */
async function correctDeposit(body) {
  await ensureTables();
  const dep = Math.round(Number(body.deposit_cents));
  if (!(dep >= 0)) throw new Error('deposit_cents required');
  const total = body.total_cents === undefined || body.total_cents === null ? null : Math.round(Number(body.total_cents));
  const done = [];
  if (body.team_id) {
    const r = await execute('UPDATE team_appointments SET deposit_cents = ?, deposit_paid = ?' + (total !== null ? ', price_cents = ?' : '') + ' WHERE id = ?',
      total !== null ? [dep, dep > 0 ? 1 : 0, total, Number(body.team_id)] : [dep, dep > 0 ? 1 : 0, Number(body.team_id)]);
    done.push('studio #' + body.team_id + ': ' + r.rowsAffected);
  }
  if (body.site_id) {
    const main = require('./_db');
    const r = await main.execute('UPDATE appointments SET deposit_cents = ?, deposit_paid = ?' + (total !== null ? ', total_cents = ?' : '') + ' WHERE id = ?',
      total !== null ? [dep, dep > 0 ? 1 : 0, total, Number(body.site_id)] : [dep, dep > 0 ? 1 : 0, Number(body.site_id)]);
    done.push('website #' + body.site_id + ': ' + r.rowsAffected);
  }
  try {
    await execute('INSERT INTO kiosk_log (type, name, detail, ts) VALUES (?,?,?,?)',
      ['deposit_correction', String(body.name || '').slice(0, 80),
       ('Deposit set to $' + (dep / 100).toFixed(2) + (total !== null ? ', total $' + (total / 100).toFixed(2) : '') + ' — ' + String(body.reason || '')).slice(0, 300), Date.now()]);
  } catch (_) {}
  return done;
}

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  if ((req.query.action || '') === 'deposit_states') {
    const from = String(req.query.from || '').slice(0, 10), to = String(req.query.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'from and to required' });
    try { return res.json({ states: await depositStates(from, to) }); }
    catch (err) { return res.status(500).json({ error: String(err.message || err) }); }
  }
  if ((req.query.action || (req.body || {}).action) === 'correct_deposit' && req.method === 'POST') {
    try { return res.json({ ok: true, updated: await correctDeposit(req.body || {}) }); }
    catch (err) { return res.status(400).json({ error: String(err.message || err) }); }
  }
  if ((req.query.action || '') === 'payments') {
    try { return res.json(await paymentsLedger(Math.min(120, Math.max(1, Number(req.query.days) || 45)))); }
    catch (err) { return res.status(500).json({ error: String(err.message || err) }); }
  }
  const action = req.query.action || (req.body && req.body.action) || '';
  try {
    if (action === 'home') return res.json(await homeData());
    if (action === 'alerts') return res.json(await alertsList({ deep: String(req.query.deep || '1') !== '0' }));
    if (action === 'health') return res.json(await healthData());
    if (action === 'site_check') return res.json(await siteCheck());
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
module.exports.alertsList = alertsList;
module.exports.notifyOwner = notifyOwner;
module.exports.homeData = homeData;
