// AI layer for ZOLA — powers Ask Zola (public chat) and the owner's
// AI reply-draft agent in the Studio Manager.
//
// Uses the Claude API when ANTHROPIC_API_KEY is set in Vercel env vars.
// Without a key, /api/chat returns {reply:null} so the widget falls back
// to its built-in scripted answers, and draft mode returns a smart template
// so the button always works.

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

// Everything the AI should know about the business.
const BUSINESS_KNOWLEDGE = `
ZOLA Nail Studio — Porterville, California. Luxury private nail membership studio.
Founder & CEO: Zahra — 6+ years in the industry, celebrity clients and wedding work.
Team: Emma Magana (Nail Artist — clean structured sets, detail-forward nail art),
Lily Byers (Nail Artist — organic structure manicures, gel extensions, health-first).
Brand voice: warm, confident, quiet luxury ("Quiet Luxury. Loud Results."). Never pushy, never desperate. Terms of endearment like "love" are on-brand, sparingly.

MEMBERSHIPS (6-month minimum, then month-to-month, 30 days notice):
- Signature Club $99/mo — 1 service/month (mani OR pedi), 10% off add-ons, third-priority booking, birthday month upgrade. 25 spots.
- Luxe Club $199/mo — up to 2 services/month, complimentary Russian manicure monthly, 30% off add-ons + 1 free scrub or lotion massage/mo, all organic products, second-priority booking. 15 spots. Most popular.
- Black Card $299/mo FOUNDING RATE locked forever — up to 3 services/month, choose your specific artist, ALL add-ons complimentary, monthly nail art, quarterly nail assessments, first-priority "Atelier Access". 10 spots.
Members always book before guests. Unused services do NOT roll over.

SERVICES (drop-in prices):
Manicure: Organic Structured Manicure from $90 · Short Gel X $95 · Medium Gel X $100 · Long Gel X $110 · Short Acrylic $95 · Medium Acrylic $100 · Long Acrylic $110.
Pedicure: Russian Dry Pedicure $95 (water-free Russian technique, grows out natural toenails, the healthiest pedicure offered) · Russian Dry Pedicure — Full Correction $125 (adds full-foot exfoliation, buffing, and callus correction each visit — the only way calluses truly resolve). Both are tailored to the client as ZOLA learns their preferences.
Add-ons: Soak Off Removal +$35 · Russian Manicure Technique +$30 · Scrub Massage +$25 · Nail Art +$25 · Lotion Massage +$15.
The studio works exclusively with hard gel and gel acrylic (no soft gel / regular polish) — better structure, healthier nails. Clients come to ZOLA because their nails actually GROW here.

POLICIES: By appointment only, no walk-ins. 50% non-refundable deposit at booking. Cancel/reschedule free more than 24h ahead; late cancel or no-show forfeits the service for that period.
PRINCESS PARTIES: kids' nail parties, $35/child, 6-child minimum, mini manicure + custom age-appropriate nail art, safe non-toxic products.
CONTACT: Instagram @zluxnails · email zahrascales@gmail.com · book at booking.html · join at memberships.html.
`;

async function callClaude(system, messages, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
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
      const system = `You are "Ask Zola", the AI concierge on the ZOLA Nail Studio website. Answer client questions using ONLY the business facts below. Be warm, concise (2-4 sentences), on-brand luxury but friendly. Gently guide people toward booking or a membership when it fits naturally. If asked something you don't know (like exact open slots), point them to booking.html or Instagram @zluxnails. Never invent prices or policies.\n${BUSINESS_KNOWLEDGE}`;
      const reply = await callClaude(system, msgs, 300);
      return res.json({ reply }); // reply:null → widget falls back to scripted answers
    }

    // ── OWNER: draft an email/text reply to an inquiry ──
    if (action === 'draft') {
      if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const { name, contact, message, tone, instructions } = req.body || {};
      const system = `You draft replies for Zahra, founder of ZOLA Nail Studio, to client inquiries. Write in her brand voice: warm, confident, quiet luxury, personal but professional. Keep it short (under 130 words), answer their actual question using the business facts, include ONE clear next step (book, join a membership, or reply). Sign off as "Zahra ✦ ZOLA Nail Studio". Output ONLY the reply body — no subject line, no preamble.\n${BUSINESS_KNOWLEDGE}`;
      const user = `Client inquiry from ${name || 'a client'} (${contact || 'no contact given'}):\n"${message}"\n${tone ? 'Tone: ' + tone : ''}${instructions ? '\nExtra instructions from Zahra: ' + instructions : ''}`;
      let draft = await callClaude(system, [{ role: 'user', content: user }], 350);
      if (!draft) {
        // No API key — smart template fallback so the button still works
        const first = (name || 'there').split(' ')[0];
        draft = `Hi ${first},\n\nThank you so much for reaching out to ZOLA — I saw your message and I'd love to take care of you.\n\n${message && /party|kid|princess/i.test(message) ? 'Our Princess Parties are $35 per child with a 6-child minimum — mini manicures, custom nail art, and safe products for little hands. I’d love to hold a date for you.' : message && /price|cost|much/i.test(message) ? 'You can see our full menu at our services page — and if you visit regularly, a membership saves you up to 45% every month.' : 'The fastest way to get on my calendar is the booking page, and if you want priority access every month, take a look at our memberships — spots are limited.'}\n\nReply here or book anytime — I can't wait to meet you.\n\nZahra ✦ ZOLA Nail Studio`;
      }
      return res.json({ draft, ai: !!process.env.ANTHROPIC_API_KEY });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(200).json({ reply: null, error: String(err.message || err) });
  }
};
