// How ZOLA shows up to AI assistants — ChatGPT, Claude, Perplexity, Gemini.
//
// Three different questions, answered three different ways:
//
//   Are AI bots reading the site?   Counted as they arrive. Bots do not run
//                                   JavaScript, so the page-view counter never
//                                   sees them; middleware.js spots them at the
//                                   door and reports them here.
//   Can they understand it?         Checked by fetching the site the way a bot
//                                   does — raw HTML, no scripts — and looking
//                                   for what an assistant needs to recommend a
//                                   business: where it is, what it does, prices.
//   Do they recommend it?           Asked. The questions a client would type,
//                                   put to an AI with live web search, and the
//                                   answer read for ZOLA. Needs an AI key; the
//                                   same questions can be checked by hand in
//                                   ChatGPT and friends without one.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const CRAWL_KEY = process.env.CRAWL_KEY || 'ZOLA-CRAWL-2026';
const SITE = process.env.PUBLIC_BASE_URL || 'https://zolanailstudio.com';
const DAY = 86400000;
const MODEL = process.env.AI_VISIBILITY_MODEL || 'claude-sonnet-5';

/* Most specific first: Applebot-Extended is AI training, plain Applebot is
   Siri and Spotlight search. */
const AI_BOTS = [
  ['ChatGPT', /GPTBot|OAI-SearchBot|ChatGPT-User/i],
  ['Claude', /ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai/i],
  ['Perplexity', /PerplexityBot|Perplexity-User/i],
  ['Google Gemini', /Google-Extended|GoogleOther|Google-CloudVertexBot/i],
  ['Meta AI', /meta-externalagent|meta-externalfetcher|FacebookBot/i],
  ['Apple Intelligence', /Applebot-Extended/i],
  ['Amazon Alexa', /Amazonbot/i],
  ['Microsoft Copilot', /Copilot/i],
  ['TikTok / ByteDance', /Bytespider|TikTokSpider/i],
  ['DuckDuckGo AI', /DuckAssistBot/i],
  ['Mistral', /MistralAI-User/i],
  ['You.com', /YouBot/i],
  ['Cohere', /cohere-ai|cohere-training-data-crawler/i],
  ['Common Crawl', /CCBot/i],
  ['Other AI', /AI2Bot|Diffbot|Timpibot|ImagesiftBot|omgili|Kangaroo Bot|img2dataset|PetalBot/i],
];
const SEARCH_BOTS = [
  ['Google Search', /Googlebot|AdsBot-Google|Google-InspectionTool|Storebot-Google/i],
  ['Bing', /bingbot|BingPreview|msnbot/i],
  ['Apple (Siri & Spotlight)', /Applebot/i],
  ['DuckDuckGo', /DuckDuckBot/i],
  ['Yahoo', /Slurp/i],
  ['Yandex', /YandexBot/i],
  ['Baidu', /Baiduspider/i],
];

// Our own checks, and the test visits made while building this. Not bots.
const OURS = /ZOLA-readiness-check|ZOLA-test/i;
const TEST_UAS = [
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
];

function classify(ua) {
  const s = String(ua || '');
  if (OURS.test(s) || TEST_UAS.includes(s)) return null;
  for (const [name, re] of AI_BOTS) if (re.test(s)) return { kind: 'ai', bot: name };
  for (const [name, re] of SEARCH_BOTS) if (re.test(s)) return { kind: 'search', bot: name };
  return null;
}

let _ready = false;
async function ensure() {
  if (_ready) return;
  await ensureTables();
  await execute(`CREATE TABLE IF NOT EXISTS ai_crawls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT, bot TEXT, path TEXT, ua TEXT, ts INTEGER
  )`);
  try { await execute('CREATE INDEX IF NOT EXISTS ai_crawls_ts ON ai_crawls (ts)'); } catch (_) {}
  await execute(`CREATE TABLE IF NOT EXISTS ai_visibility (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT, engine TEXT, mentioned INTEGER DEFAULT 0, position INTEGER DEFAULT 0,
    answer TEXT DEFAULT '', sources TEXT DEFAULT '[]', competitors TEXT DEFAULT '[]',
    manual INTEGER DEFAULT 0, live_search INTEGER DEFAULT 0, ts INTEGER
  )`);
  _ready = true;
}

async function setting(key) {
  try { const r = await queryOne('SELECT value FROM site_settings WHERE key = ?', [key]); return r ? r.value : null; }
  catch (_) { return null; }
}
async function saveSetting(key, value) {
  await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, String(value)]);
}
async function aiKey() {
  return process.env.ANTHROPIC_API_KEY || (await setting('anthropic_key')) || '';
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = ms => dayFmt.format(new Date(Number(ms)));
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

/* ═══════════════ WHO IS READING ═══════════════ */

async function crawlSummary() {
  await ensure();
  const since = Date.now() - 30 * DAY;
  const rows = await query('SELECT kind, bot, path, ts FROM ai_crawls WHERE ts >= ? ORDER BY ts', [since]);
  const today = dayOf(Date.now());
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(addDays(today, -i));
  const series = {}; for (const d of days) series[d] = { day: d, ai: 0, search: 0 };
  const last7 = new Set(days.slice(-7)), prev7 = new Set(days.slice(-14, -7));
  const byBot = {}, pages = {};
  const totals = { ai: 0, search: 0, ai_last7: 0, ai_prev7: 0 };
  for (const r of rows) {
    const k = dayOf(r.ts);
    const kind = r.kind === 'search' ? 'search' : 'ai';
    totals[kind]++;
    if (series[k]) series[k][kind]++;
    if (kind === 'ai') {
      if (last7.has(k)) totals.ai_last7++;
      if (prev7.has(k)) totals.ai_prev7++;
      pages[r.path] = (pages[r.path] || 0) + 1;
    }
    const key = kind + '|' + r.bot;
    const b = byBot[key] || (byBot[key] = { kind, bot: r.bot, count: 0, last_ts: 0 });
    b.count++; b.last_ts = Math.max(b.last_ts, Number(r.ts));
  }
  let first = 0;
  try { first = Number((await queryOne('SELECT MIN(ts) AS t FROM ai_crawls')).t) || 0; } catch (_) {}
  return {
    totals,
    bots: Object.values(byBot).sort((a, b) => b.count - a.count),
    series: days.map(d => series[d]),
    top_pages: Object.entries(pages).map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    counting_since: first,
  };
}

/* ═══════════════ CAN THEY UNDERSTAND IT ═══════════════ */

async function fetchText(path, ua) {
  const started = Date.now();
  const r = await fetch(SITE + path, { headers: { 'User-Agent': ua || 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot) ZOLA-readiness-check' }, redirect: 'follow' });
  const text = r.ok ? await r.text() : '';
  return { ok: r.ok, status: r.status, text, ms: Date.now() - started };
}

function robotsBlocks(robots, agent) {
  // Groups are separated by user-agent lines; a bot obeys its own group if
  // it has one, otherwise the * group.
  const groups = [];
  let cur = null;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase(), val = m[2].trim();
    if (field === 'user-agent') {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
    } else if (cur && (field === 'disallow' || field === 'allow')) cur.rules.push({ field, val });
  }
  const mine = groups.find(g => g.agents.includes(agent.toLowerCase())) || groups.find(g => g.agents.includes('*'));
  if (!mine) return false;
  return mine.rules.some(r => r.field === 'disallow' && (r.val === '/' || r.val === '/*'));
}

async function readiness() {
  const [home, robots, sitemap, llms, services] = await Promise.all([
    fetchText('/').catch(e => ({ ok: false, why: String(e.message || e), text: '' })),
    fetchText('/robots.txt').catch(() => ({ ok: false, text: '' })),
    fetchText('/sitemap.xml').catch(() => ({ ok: false, text: '' })),
    fetchText('/llms.txt').catch(() => ({ ok: false, text: '' })),
    fetchText('/services.html').catch(() => ({ ok: false, text: '' })),
  ]);
  const checks = [];
  const add = (id, ok, title, good, bad, weight) => checks.push({ id, ok: !!ok, title, detail: ok ? good : bad, weight: weight || 1 });
  const h = home.text || '';
  const visibleText = h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  add('site', home.ok, 'Your site opens for AI bots',
    'The homepage answered in ' + home.ms + ' ms to a request made the way ChatGPT\'s bot makes it.',
    'The homepage did not load for a bot (' + (home.status || home.why || 'no answer') + ').', 3);

  const blocked = ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended']
    .filter(a => robots.ok && robotsBlocks(robots.text, a));
  add('robots', robots.ok && !blocked.length, 'AI bots are allowed in',
    'robots.txt lets ChatGPT, Claude, Perplexity, Gemini and Apple read the site.',
    robots.ok ? 'robots.txt blocks: ' + blocked.join(', ') + '. They cannot recommend what they are not allowed to read.' : 'There is no robots.txt.', 2);

  const urls = (sitemap.text.match(/<loc>/g) || []).length;
  add('sitemap', sitemap.ok && urls > 0, 'There is a map of your pages',
    'sitemap.xml lists ' + urls + ' pages for bots to find.', 'sitemap.xml is missing or empty.');

  add('llms', llms.ok && llms.text.length > 200, 'There is a summary written for AI (llms.txt)',
    'llms.txt tells assistants who you are, where you are, what you offer and what it costs — kept up to date from your live menu.',
    'No llms.txt. This is a plain-text summary AI assistants look for.', 2);

  const title = (h.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  add('title', title.length >= 10, 'Your homepage has a clear title', '"' + title.trim() + '"', 'The homepage has no title.');

  // Quoted either way, and an apostrophe inside (Porterville's) is part of it.
  const desc = (h.match(/<meta[^>]+name=["']description["'][^>]+content=(["'])(.*?)\1/i) || [])[2] || '';
  add('description', desc.length >= 50, 'Your homepage describes the business', '"' + desc.slice(0, 160) + '"', 'No meta description — the one-sentence summary search engines and AI quote.');

  const ld = [...h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join(' ');
  const hasBiz = /"@type"\s*:\s*"(NailSalon|BeautySalon|LocalBusiness|HealthAndBeautyBusiness)"/i.test(ld);
  add('schema', hasBiz, 'Business details are machine-readable',
    'The homepage carries structured business data (name, address, links) that Google and AI read directly.',
    'No structured business data. Assistants have to guess your address and what kind of business you are.', 2);

  add('location', /porterville/i.test(visibleText), 'Your town is written on the page',
    'Porterville appears in the page text, so "near me" questions can match you.',
    'Your town is not in the readable text of the homepage.', 2);

  const og = /<meta[^>]+property=["']og:image["']/i.test(h);
  add('og', og, 'Links show a preview image', 'Shared links and AI answers can show your photo.', 'No preview image (og:image) — links to your site show up blank.');

  const svcText = (services.text || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const pricesInHtml = (svcText.match(/\$\s?\d{2,3}/g) || []).length;
  add('prices', pricesInHtml >= 3 || (llms.ok && /\$\d/.test(llms.text)), 'AI can read your prices',
    pricesInHtml >= 3 ? 'Prices are in the services page itself.' : 'Your services page builds its prices with JavaScript, which AI bots do not run — but llms.txt lists every price, so they still get them.',
    'Prices only appear after JavaScript runs, and AI bots do not run it. They see a menu with no prices.', 2);

  const gbp = await setting('mkt_gbp_url');
  add('gbp', !!gbp, 'Google Business Profile is linked',
    'Your Google Business Profile is saved in Marketing.',
    'Add your Google Business Profile link in Marketing. Google\'s AI answers lean heavily on it, reviews especially.', 2);

  const total = checks.reduce((s, c) => s + c.weight, 0);
  const got = checks.reduce((s, c) => s + (c.ok ? c.weight : 0), 0);
  return { score: Math.round(got / total * 100), checks, checked_at: Date.now() };
}

/* ═══════════════ DO THEY RECOMMEND IT ═══════════════ */

async function city() {
  return (await setting('ai_city')) || 'Porterville, CA';
}

async function questions() {
  const c = await city();
  const base = [
    'What is the best nail salon in ' + c + '?',
    'Where can I get Gel X nails in ' + c + '?',
    'Who does Russian manicures near ' + c + '?',
    'Best place for acrylic nails in ' + c + '?',
    'Is there a nail membership or monthly nail subscription in ' + c + '?',
    'Where can I get a Russian dry pedicure near ' + c + '?',
    'Which nail salon in ' + c + ' is best for healthy natural nails?',
    'Where can I buy custom press-on nails in ' + c + '?',
    'Where can I book a kids nail party in ' + c + '?',
    'What do people say about ZOLA Nail Studio in ' + c + '?',
  ];
  let custom = [];
  try { custom = JSON.parse((await setting('ai_questions_custom')) || '[]'); } catch (_) {}
  let hidden = [];
  try { hidden = JSON.parse((await setting('ai_questions_hidden')) || '[]'); } catch (_) {}
  return base.filter(q => !hidden.includes(q)).map(q => ({ q, custom: false }))
    .concat(custom.map(q => ({ q, custom: true })));
}

const MENTION = /zola\s*nail|zolanailstudio|zola_officials|zolaofficial|\bZOLA\b[^.\n]{0,60}(nail|porterville|studio)/i;

function readAnswer(text, sources) {
  const all = text + ' ' + sources.map(s => s.url + ' ' + (s.title || '')).join(' ');
  const mentioned = MENTION.test(all);
  // Where in a list ZOLA came, if the answer is a list.
  const items = text.split(/\n+/).filter(l => /^\s*(\d+[.)]|[-*•]|#{1,4}\s|\*\*)/.test(l));
  let position = 0;
  if (mentioned && items.length) {
    const i = items.findIndex(l => MENTION.test(l) || /\bZOLA\b/.test(l));
    position = i >= 0 ? i + 1 : 0;
  }
  const competitors = [];
  for (const l of items) {
    if (/\bZOLA\b/i.test(l)) continue;
    const m = l.match(/\*\*([^*]{3,60})\*\*/) || l.match(/^\s*(?:\d+[.)]|[-*•])\s*([A-Z][^:–—\-(\n]{2,50})/);
    if (m) {
      const name = m[1].trim().replace(/[:.]+$/, '');
      if (!competitors.includes(name) && !/^(price|pricing|location|hours|address|services|why|note|tip|summary)/i.test(name)) competitors.push(name);
    }
    if (competitors.length >= 6) break;
  }
  return { mentioned, position, competitors };
}

async function askClaude(question) {
  const key = await aiKey();
  if (!key) return { needs_key: true };
  const c = await city();
  const cityName = c.split(',')[0].trim();
  const body = {
    model: MODEL,
    max_tokens: 900,
    messages: [{ role: 'user', content: question }],
    tools: [{
      type: 'web_search_20250305', name: 'web_search', max_uses: 3,
      user_location: { type: 'approximate', city: cityName, region: 'California', country: 'US', timezone: 'America/Los_Angeles' },
    }],
  };
  const call = async payload => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  };
  let live = true;
  let { r, j } = await call(body);
  // Web search has to be switched on for the account. Without it the test
  // still runs on what the model already knows, and says so.
  if (!r.ok && /web.?search|tool/i.test(JSON.stringify(j.error || {}))) {
    live = false;
    const plain = Object.assign({}, body); delete plain.tools;
    ({ r, j } = await call(plain));
  }
  if (!r.ok) return { error: (j.error && j.error.message) || ('AI service answered ' + r.status) };

  let text = '';
  const sources = [];
  const seen = new Set();
  for (const b of j.content || []) {
    if (b.type === 'text') {
      text += b.text;
      for (const cit of b.citations || []) {
        if (cit.url && !seen.has(cit.url)) { seen.add(cit.url); sources.push({ url: cit.url, title: cit.title || '' }); }
      }
    }
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const s of b.content) {
        if (s.url && !seen.has(s.url)) { seen.add(s.url); sources.push({ url: s.url, title: s.title || '' }); }
      }
    }
  }
  return { text: text.trim(), sources: sources.slice(0, 12), live };
}

async function visibilitySummary() {
  await ensure();
  const rows = await query('SELECT id, question, engine, mentioned, position, competitors, manual, live_search, ts FROM ai_visibility ORDER BY ts DESC LIMIT 400');
  const latest = {};
  for (const r of rows) {
    const k = r.question + '|' + r.engine;
    if (!latest[k]) latest[k] = r;
  }
  const list = Object.values(latest);
  const mentioned = list.filter(r => Number(r.mentioned)).length;
  const competitors = {};
  for (const r of list) {
    let c = []; try { c = JSON.parse(r.competitors || '[]'); } catch (_) {}
    for (const n of c) competitors[n] = (competitors[n] || 0) + 1;
  }
  return {
    tested: list.length,
    mentioned,
    score: list.length ? Math.round(mentioned / list.length * 100) : null,
    latest: list.map(r => ({
      id: Number(r.id), question: r.question, engine: r.engine, mentioned: !!Number(r.mentioned),
      position: Number(r.position) || 0, manual: !!Number(r.manual), live_search: !!Number(r.live_search), ts: Number(r.ts),
    })),
    competitors: Object.entries(competitors).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    history: rows.slice(0, 60).map(r => ({ question: r.question, engine: r.engine, mentioned: !!Number(r.mentioned), ts: Number(r.ts) })),
  };
}

/* ═══════════════ llms.txt ═══════════════
   Built from the live menu every time, so it can never quote an old price. */
async function llmsTxt(req, res) {
  let S = {};
  try {
    await ensureTables();
    const rows = await query('SELECT key, value FROM site_settings');
    for (const r of rows) S[r.key] = r.value;
  } catch (_) {}
  let services = [];
  try { services = require('./_store').services || []; } catch (_) {}
  const money = c => '$' + (Math.round(Number(c) || 0) / 100).toFixed(0);
  const mins = m => { m = Number(m) || 0; const h = Math.floor(m / 60), r = m % 60; return h ? h + ' hr' + (r ? ' ' + r + ' min' : '') : r + ' min'; };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const real = services.filter(s => !/test/i.test(s.name) && Number(s.price_cents) > 100);
  const deals = real.filter(s => s.deal);
  const regular = real.filter(s => !s.deal);
  // Typed in lower case in settings; written properly for anyone reading it.
  const address = clean(S.studio_address).replace(/\b([a-z])/g, c => c.toUpperCase());
  const lines = [
    '# ZOLA Nail Studio',
    '',
    '> A private nail membership studio in Porterville, California. Structured gel manicures, Gel X and acrylic extensions, and Russian dry pedicures, done with a focus on keeping natural nails healthy. By appointment only.',
    '',
    '## Essentials',
    '- Location: ' + (address ? address + ', ' : '') + 'Porterville, CA, United States',
    '- Booking: ' + SITE + '/booking.html (online booking, 50% deposit at booking)',
    S.biz_hours ? '- Hours: ' + clean(S.biz_hours) + ', by appointment only' : '- Hours: by appointment only',
    S.cancel_hours ? '- Cancellations: free up to ' + clean(S.cancel_hours) + ' hours before the appointment' : '',
    '- Instagram: https://www.instagram.com/zola_officials_',
    '- TikTok: https://www.tiktok.com/@zolaofficial',
    '- Email: zolastudioempire@gmail.com',
    '- Website: ' + SITE,
    '',
  ];
  if (deals.length) {
    lines.push('## Weekly specials');
    for (const d of deals) lines.push('- ' + d.name + ': ' + money(d.price_cents) + ', ' + mins(d.duration_min) + '. ' + clean(d.description));
    lines.push('');
  }
  lines.push('## Services and prices');
  for (const s of regular) lines.push('- ' + s.name + ': ' + money(s.price_cents) + ', ' + mins(s.duration_min) + '. ' + clean(s.description));
  lines.push('',
    '## Memberships',
    '- Monthly nail memberships with included services and member pricing: ' + SITE + '/memberships.html',
    '',
    '## Also offered',
    '- Custom press-on nail sets, sold online: ' + SITE + '/pressons.html',
    '- Nail classes and training: ' + SITE + '/classes.html',
    '- Kids manicures and kids nail parties',
    '',
    '## Pages',
    '- [Services](' + SITE + '/services.html)',
    '- [Book an appointment](' + SITE + '/booking.html)',
    '- [Memberships](' + SITE + '/memberships.html)',
    '- [About](' + SITE + '/about.html)',
    '- [Contact](' + SITE + '/contact.html)',
    '');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600');
  return res.send(lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'));
}

/* ═══════════════ ROUTES ═══════════════ */

module.exports = async function (req, res) {
  const action = req.query.action || (req.body && req.body.action) || '';
  try {
    // Reported by middleware.js. Keyed so nobody can pad the numbers, and
    // the bot is worked out again here rather than taken on trust.
    if (action === 'crawl' && req.method === 'POST') {
      if ((req.headers['x-crawl-key'] || '') !== CRAWL_KEY) return res.status(401).json({ error: 'Unauthorized' });
      const { ua, path } = req.body || {};
      const who = classify(ua);
      if (!who) return res.json({ ok: true, counted: false });
      await ensure();
      await execute('INSERT INTO ai_crawls (kind, bot, path, ua, ts) VALUES (?,?,?,?,?)',
        [who.kind, who.bot, String(path || '/').slice(0, 200), String(ua || '').slice(0, 300), Date.now()]);
      return res.json({ ok: true, counted: true, bot: who.bot });
    }

    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    await ensure();

    if (action === 'summary') {
      const [crawls, vis, key, qs] = await Promise.all([crawlSummary(), visibilitySummary(), aiKey(), questions()]);
      return res.json({ crawls, visibility: vis, ai_key_saved: !!key, questions: qs, city: await city(), model: MODEL });
    }
    if (action === 'readiness') return res.json(await readiness());

    // Clears visits that were our own checks or tests, never a real bot's.
    if (action === 'purge_tests' && req.method === 'POST') {
      const r = await execute(
        "DELETE FROM ai_crawls WHERE ua LIKE '%ZOLA-readiness-check%' OR ua LIKE '%ZOLA-test%' OR ua IN (" + TEST_UAS.map(() => '?').join(',') + ')',
        TEST_UAS);
      return res.json({ ok: true, removed: r.rowsAffected });
    }

    if (action === 'run_test' && req.method === 'POST') {
      const q = String((req.body || {}).question || '').trim().slice(0, 300);
      if (!q) return res.status(400).json({ error: 'Which question?' });
      const a = await askClaude(q);
      if (a.needs_key) return res.json({ needs_key: true });
      if (a.error) return res.status(502).json({ error: a.error });
      const read = readAnswer(a.text, a.sources);
      await execute(
        'INSERT INTO ai_visibility (question, engine, mentioned, position, answer, sources, competitors, manual, live_search, ts) VALUES (?,?,?,?,?,?,?,0,?,?)',
        [q, 'claude', read.mentioned ? 1 : 0, read.position, a.text.slice(0, 6000), JSON.stringify(a.sources),
          JSON.stringify(read.competitors), a.live ? 1 : 0, Date.now()]);
      return res.json({ ok: true, question: q, answer: a.text, sources: a.sources, live_search: a.live, ...read });
    }

    if (action === 'record' && req.method === 'POST') {
      const { question, engine, mentioned } = req.body || {};
      const eng = String(engine || '').toLowerCase();
      if (!['chatgpt', 'perplexity', 'google', 'gemini', 'copilot', 'claude'].includes(eng)) return res.status(400).json({ error: 'Unknown assistant' });
      const q = String(question || '').trim().slice(0, 300);
      if (!q) return res.status(400).json({ error: 'Which question?' });
      await execute('INSERT INTO ai_visibility (question, engine, mentioned, manual, ts) VALUES (?,?,?,1,?)',
        [q, eng, mentioned ? 1 : 0, Date.now()]);
      return res.json({ ok: true });
    }

    if (action === 'answer') {
      const row = await queryOne('SELECT * FROM ai_visibility WHERE id = ?', [Number(req.query.id) || 0]);
      if (!row) return res.status(404).json({ error: 'Not found' });
      let sources = [], competitors = [];
      try { sources = JSON.parse(row.sources || '[]'); competitors = JSON.parse(row.competitors || '[]'); } catch (_) {}
      return res.json({ question: row.question, engine: row.engine, answer: row.answer, sources, competitors,
        mentioned: !!Number(row.mentioned), live_search: !!Number(row.live_search), ts: Number(row.ts) });
    }

    if (action === 'questions' && req.method === 'POST') {
      const { add, remove, city: newCity } = req.body || {};
      let custom = []; try { custom = JSON.parse((await setting('ai_questions_custom')) || '[]'); } catch (_) {}
      let hidden = []; try { hidden = JSON.parse((await setting('ai_questions_hidden')) || '[]'); } catch (_) {}
      if (add) { const q = String(add).trim().slice(0, 300); if (q && !custom.includes(q)) custom.push(q); }
      if (remove) {
        const q = String(remove);
        if (custom.includes(q)) custom = custom.filter(x => x !== q);
        else if (!hidden.includes(q)) hidden.push(q);
      }
      if (newCity && String(newCity).trim()) await saveSetting('ai_city', String(newCity).trim().slice(0, 80));
      await saveSetting('ai_questions_custom', JSON.stringify(custom.slice(0, 40)));
      await saveSetting('ai_questions_hidden', JSON.stringify(hidden));
      return res.json({ ok: true, questions: await questions() });
    }

    // Write-only, like the Stripe key: it can be replaced, never read back.
    if (action === 'save_key' && req.method === 'POST') {
      const key = String((req.body || {}).key || '').trim();
      if (!/^sk-ant-/.test(key)) return res.status(400).json({ error: 'That does not look like an Anthropic key — they start with sk-ant-' });
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
      if (!r.ok) return res.status(400).json({ error: 'Anthropic did not accept that key (' + r.status + '). Check it was copied in full.' });
      await saveSetting('anthropic_key', key);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
module.exports.llmsTxt = llmsTxt;
module.exports.classify = classify;
