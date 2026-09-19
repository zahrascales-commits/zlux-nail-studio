// AI layer for ZOLA — powers Ask Zola (public chat) and the owner's
// AI reply-draft agent in the Studio Manager.
//
// Uses the Claude API when ANTHROPIC_API_KEY is set in Vercel env vars.
// Without a key, /api/chat returns {reply:null} so the widget falls back
// to its built-in scripted answers, and draft mode returns a smart template
// so the button always works.

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

/* Everything the AI should know about the business.

   The prices, memberships, deal days and team are read from the same
   endpoints the website renders, so Ask Zola quotes exactly what the pages
   show. It used to carry its own typed copy — three memberships that had
   been retired, prices nobody charged any more, and a team that had moved
   on — and told visitors all of it with confidence. */
const SITE = (process.env.PUBLIC_BASE_URL || 'https://zolanailstudio.com').replace(/\/+$/, '');
const $ = c => '$' + (Math.round(Number(c) || 0) / 100).toFixed(2).replace(/\.00$/, '');

async function getJson(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2500);
  try { const r = await fetch(SITE + path, { signal: ctl.signal }); return r.ok ? await r.json() : null; }
  catch (_) { return null; }
  finally { clearTimeout(t); }
}

// Only what the booking page itself offers as an add-on, at what it charges.
function addonLine() {
  try {
    const { addons } = require('./_store');
    const by = n => (addons.find(a => a.name === n) || {}).price_cents;
    return [
      ['Soak Off Removal', by('Removal')],
      ['Russian Manicure Technique', by('Russian Manicure')],
      ['Lotion Massage', by('Lotion Massage')],
      ['Kids Manicure (ages 3–8, done alongside your appointment)', by('Kids Manicure')],
    ].filter(x => x[1]).map(x => x[0] + ' +' + $(x[1])).join(' · ');
  } catch (_) { return ''; }
}

let _kAt = 0, _k = '';
async function knowledge() {
  if (_k && Date.now() - _kAt < 5 * 60000) return _k;
  const [plans, deals, services, roster, settings] = await Promise.all([
    getJson('/api/plans'), getJson('/api/deals'), getJson('/api/services'), getJson('/api/roster'), getJson('/api/site-settings'),
  ]);

  const L = [];
  L.push('ZOLA Nail Studio — Porterville, California. Private nail membership studio, by appointment only.');
  L.push('Founder & CEO: Zahra — 6+ years in the industry.');
  const team = ((roster && roster.team) || []).map(m => m.name + ' (' + m.title + ')');
  if (team.length) L.push('TEAM: ' + team.join(', ') + '. Clients are matched with an artist when they book.');
  L.push('Brand voice: warm, confident, quiet luxury ("Quiet Luxury. Loud Results."). Never pushy. "Love" is on-brand, sparingly.');

  const ps = (plans && plans.plans) || [];
  const older = (plans && plans.legacy) || [];
  const rhythmLine = p => (p.rhythms || []).map(r => 'every ' + r.weeks + ' weeks ' + $(r.cents)
    + (r.pct_off ? ' (save ' + r.pct_off + '%)' : r.add_cents ? '' : ' (regular price)')).join(', ');
  if (ps.length) {
    L.push('');
    L.push('HOW OFTEN: every membership lets the client choose how often she comes — every 2 weeks (10% off every visit), every 3 weeks (5% off), every 4 weeks (the regular price) or every 5 weeks ($10 more). She is billed on the same rhythm, so there is nothing to pay at the appointment. Paying for the year is offered at every 4 weeks only.');
    L.push('MEMBERSHIPS (all open to join at memberships.html):');
    for (const p of ps.concat(older)) {
      L.push('- ' + p.name + ' — ' + ((p.services || 1) > 1 ? p.services + ' services each cycle. ' : '')
        + rhythmLine(p) + '. Or ' + $(p.annual_cents) + ' for the year'
        + (p.annual_free_visits ? ' (' + p.annual_free_visits + ' visits free)' : '') + '. "' + p.line + '" Includes: '
        + (p.includes || []).join('; ') + '. ' + p.joined + ' joined, ' + p.spots_open + ' spots open.');
    }
    if (plans.addon && plans.addon.cents) {
      L.push('Essential and Elite members can add a ' + plans.addon.name + ' for ' + $(plans.addon.cents)
        + (plans.addon.correction_cents ? ' (' + $(plans.addon.correction_cents) + ' with full correction)' : '') + ' a visit.');
    }
    L.push('Every membership runs a minimum of three months; after that, cancel any time from your own account in two clicks. Members book ahead of walk-ins. Included services do not roll over from one cycle to the next. You leave owing nothing.');
  }

  const ds = (deals && deals.deals) || [];
  if (ds.length) {
    L.push('');
    L.push('DEAL DAYS:');
    for (const d of ds) {
      L.push('- ' + d.name + ' — ' + d.blurb + ' ' + d.duration_label + ', hands or toes, every ' + d.weekday_name
        + '. Book at booking.html?deal=' + d.key);
    }
    if (deals.instead_note) L.push(deals.instead_note);
  }

  const sv = ((services && services.services) || (Array.isArray(services) ? services : []))
    .filter(s => !s.deal && Number(s.price_cents) >= 500 && !/test/i.test(s.name));
  if (sv.length) {
    L.push('');
    L.push('SERVICES (single-visit prices): ' + sv.map(s => s.name + ' ' + $(s.price_cents)).join(' · ') + '.');
  }
  const ad = addonLine();
  if (ad) L.push('ADD-ONS at booking: ' + ad + '.');
  L.push('Russian Dry Pedicure: water-free Russian technique that grows out natural toenails. Full Correction adds exfoliation, buffing and callus correction each visit.');
  L.push('The studio works with hard gel and gel acrylic for structure and nail health. Clients come to ZOLA because their nails actually grow here.');

  L.push('');
  L.push('OFFERS: 10% off your first visit — join the ZOLA list on the homepage and the code arrives by email. Sit with a trainee (Zahra right beside them) and code TRAIN20 takes $20 off.');
  L.push('POLICIES: By appointment only, no walk-ins. A 50% non-refundable deposit is taken at booking (Essential and Elite members pay no deposit). Cancel more than 24 hours ahead and it can be rescheduled at no cost; for members, a late cancellation or no-show forfeits the service for that billing period.');
  const hours = settings && settings.settings && settings.settings.biz_hours;
  if (hours) L.push('HOURS: ' + hours + ' (by appointment).');
  L.push('PRINCESS PARTIES: kids\' nail parties, $20 a child (regularly $35), 6-child minimum, mini manicure and custom age-appropriate art, safe non-toxic products. We travel to you. Enquire at contact.html.');
  L.push('CONTACT: Instagram @zola_officials_ · TikTok @zolaofficial · email zolastudioempire@gmail.com.');

  // Only keep what was read properly; a failed read leaves the last good copy.
  if (ps.length && ds.length && sv.length) { _k = L.join('\n'); _kAt = Date.now(); }
  return L.join('\n');
}

const COPY_RULES = 'Copy rules: never invent scarcity, urgency, numbers or reviews; only quote what is written here. Never use the word "expensive". '
  + 'Never call Essential cheap, affordable, budget, a discount, a deal or value — it is the easy choice: in and out, exactly what you need. '
  + 'Elite is about nail health over time. Say what people get, never list what is excluded. '
  + 'When someone is ready, give the page to go to: booking.html to book (booking.html?deal=tuesday for $75 Tuesdays), memberships.html to join.';

/* The key can live in Vercel or be pasted into Studio Manager. Looked up
   once a minute, not on every message. */
let _keyAt = 0, _key = '';
async function aiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (Date.now() - _keyAt < 60000) return _key;
  try {
    const { queryOne } = require('./_team-db');
    const r = await queryOne("SELECT value FROM site_settings WHERE key = 'anthropic_key'");
    _key = (r && r.value) || '';
  } catch (_) {}
  _keyAt = Date.now();
  return _key;
}

async function callClaude(system, messages, maxTokens) {
  const key = await aiKey();
  if (!key) return null;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens || 400, system, messages }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return text || null;
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const action = req.query.action || (req.body && req.body.action) || 'chat';

  try {
    // ── PUBLIC: Ask Zola website chat ──
    if (action === 'chat') {
      const { message, history } = req.body || {};
      if (!message) return res.status(400).json({ error: 'message required' });
      const msgs = [];
      if (Array.isArray(history)) {
        for (const h of history.slice(-8)) {
          if (h && h.role && h.text) msgs.push({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.text).slice(0, 600) });
        }
      }
      msgs.push({ role: 'user', content: String(message).slice(0, 600) });
      const system = `You are "Ask Zola", the AI concierge on the ZOLA Nail Studio website. Answer client questions using ONLY the business facts below. Be warm, concise (2-4 sentences), on-brand luxury but friendly. Gently guide people toward booking or a membership when it fits naturally. If asked something you don't know (like exact open slots), point them to booking.html or Instagram @zola_officials_. Never invent prices or policies. Plain text only, no markdown.\n${COPY_RULES}\n\n${await knowledge()}`;
      const reply = await callClaude(system, msgs, 300);
      return res.json({ reply }); // reply:null → widget falls back to scripted answers
    }

    // ── OWNER: draft an email/text reply to an inquiry ──
    if (action === 'draft') {
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const { name, contact, message, tone, instructions } = req.body || {};
      const system = `You draft replies for Zahra, founder of ZOLA Nail Studio, to client inquiries. Write in her brand voice: warm, confident, quiet luxury, personal but professional. Keep it short (under 130 words), answer their actual question using the business facts, include ONE clear next step (book, join a membership, or reply). Sign off as "Zahra ✦ ZOLA Nail Studio". Output ONLY the reply body — no subject line, no preamble.\n${COPY_RULES}\n\n${await knowledge()}`;
      const user = `Client inquiry from ${name || 'a client'} (${contact || 'no contact given'}):\n"${message}"\n${tone ? 'Tone: ' + tone : ''}${instructions ? '\nExtra instructions from Zahra: ' + instructions : ''}`;
      let draft = await callClaude(system, [{ role: 'user', content: user }], 350);
      if (!draft) {
        // No API key — smart template fallback so the button still works
        const first = (name || 'there').split(' ')[0];
        draft = `Hi ${first},\n\nThank you so much for reaching out to ZOLA — I saw your message and I'd love to take care of you.\n\n${message && /party|kid|princess/i.test(message) ? 'Our Princess Parties are $20 per child with a 6-child minimum — mini manicures, custom nail art, and safe products for little hands. I’d love to hold a date for you.' : message && /price|cost|much/i.test(message) ? 'You can see our full menu at our services page — and if you come in regularly, a membership means you leave owing nothing.' : 'The fastest way to get on my calendar is the booking page, and if you want priority access every month, take a look at our memberships.'}\n\nReply here or book anytime — I can't wait to meet you.\n\nZahra ✦ ZOLA Nail Studio`;
      }
      return res.json({ draft, ai: !!(await aiKey()) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(200).json({ reply: null, error: String(err.message || err) });
  }
};
module.exports._test = { knowledge };
