const FAQ_CHIPS = [
  { label: 'How does membership work?',    q: 'how does membership work' },
  { label: 'How do I book?',               q: 'how do I book an appointment' },
  { label: 'Which membership is for me?',  q: 'which membership is right for me' },
  { label: 'How much does it cost?',       q: 'how much does it cost' },
  { label: 'What are the deal days?',      q: 'tell me about the tuesday and wednesday deals' },
  { label: 'First-visit discount?',        q: 'is there a first visit discount' },
  { label: 'What is a structure mani?',    q: 'what is a structure manicure' },
  { label: 'Do services roll over?',       q: 'do unused services roll over' },
  { label: 'Cancellation & deposits',      q: 'what is your cancellation and deposit policy' },
  { label: 'Kids / princess parties',      q: 'do you offer princess parties for kids' },
];

/* The prices, memberships and deal days come from the same endpoints the
   pages render, so the chat can never quote something the site does not
   charge. The scripted answers below used to carry their own copy of all
   of it — three retired memberships and prices from months ago. */
let _zolaFacts = null;
function zolaFacts() {
  if (_zolaFacts) return _zolaFacts;
  const get = p => fetch(p).then(r => r.json()).catch(() => null);
  _zolaFacts = Promise.all([get('/api/plans'), get('/api/deals'), get('/api/services'), get('/api/addons'), get('/api/site-settings')])
    .then(([p, d, s, a, st]) => ({
      plans: (p && p.plans) || [],
      deals: (d && d.deals) || [],
      services: ((s && (s.services || s)) || []).filter(x => x && !x.deal && Number(x.price_cents) >= 500 && !/test/i.test(x.name)),
      addons: Array.isArray(a) ? a : [],
      hours: st && st.settings && st.settings.biz_hours,
    }));
  return _zolaFacts;
}

function renderFaqChips() {
  const existing = document.getElementById('chat-faq-chips');
  if (existing) return;
  const messages = document.getElementById('chat-messages');
  const wrap = document.createElement('div');
  wrap.id = 'chat-faq-chips';
  wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.4rem;padding:0.75rem 0.75rem 0;';
  FAQ_CHIPS.forEach(chip => {
    const btn = document.createElement('button');
    btn.textContent = chip.label;
    btn.style.cssText = `
      background:transparent;border:1px solid rgba(196,168,130,0.4);color:#8B6A3E;
      font-family:'Josefin Sans',sans-serif;font-size:0.68rem;letter-spacing:0.06em;
      padding:0.3rem 0.65rem;cursor:pointer;border-radius:2px;transition:all 0.2s;
    `;
    btn.onmouseover = () => { btn.style.borderColor='#C4A882'; btn.style.color='#C4A882'; };
    btn.onmouseout  = () => { btn.style.borderColor='rgba(196,168,130,0.4)'; btn.style.color='#8B6A3E'; };
    btn.onclick = () => {
      wrap.remove();
      const input = document.getElementById('chat-input');
      if (input) { input.value = chip.q; sendChat(); }
    };
    wrap.appendChild(btn);
  });
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
}

function toggleChat() {
  const box = document.getElementById('chat-box');
  box.classList.toggle('open');
  if (box.classList.contains('open')) {
    zolaFacts();
    renderFaqChips();
    setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
  }
}

/* A page named in a reply becomes a button to it — "booking.html" in a
   sentence is a dead end on a phone; "Book now →" is one tap. */
function chatLinkify(text) {
  const esc = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const LABEL = {
    booking: 'Book now', memberships: 'See the memberships', services: 'See the menu',
    contact: 'Contact us', signup: 'Join now', pressons: 'Press-ons', classes: 'Classes',
  };
  return esc
    .replace(/(?:https?:\/\/)?(?:www\.)?(?:zolanailstudio\.com)?\/?\b(booking|memberships|services|contact|signup|pressons|classes)\.html(\?[\w=%.-]+)?/g,
      (m, page, q) => '<a class="chat-link" href="/' + page + '.html' + (q || '') + '">' + LABEL[page] + ' →</a>')
    .replace(/@zola_officials_/g,
      '<a class="chat-link" href="https://instagram.com/zola_officials_" target="_blank" rel="noopener">@zola_officials_</a>');
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input?.value.trim();
  if (!msg) return;
  input.value = '';

  document.getElementById('chat-faq-chips')?.remove();

  const messages = document.getElementById('chat-messages');
  const userMsg = document.createElement('div');
  userMsg.className = 'chat-msg user';
  userMsg.textContent = msg;
  messages.appendChild(userMsg);
  messages.scrollTop = messages.scrollHeight;

  const thinking = document.createElement('div');
  thinking.className = 'chat-msg zlux';
  thinking.textContent = '…';
  thinking.id = 'chat-thinking';
  messages.appendChild(thinking);
  messages.scrollTop = messages.scrollHeight;

  // Track the question for CEO analytics
  try {
    fetch('/api/ceo-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'chat_question', question: msg })
    }).catch(() => {});
  } catch (_) {}

  let reply;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, history: window._zolaChatHistory || [] })
    });
    const data = await res.json();
    reply = data.reply || await askZolaFallback(msg);
  } catch {
    reply = await askZolaFallback(msg);
  }
  // Keep a short rolling history so the AI remembers the conversation
  window._zolaChatHistory = (window._zolaChatHistory || []).concat(
    [{ role: 'user', text: msg }, { role: 'assistant', text: reply }]
  ).slice(-10);

  document.getElementById('chat-thinking')?.remove();
  const botMsg = document.createElement('div');
  botMsg.className = 'chat-msg zlux';
  botMsg.innerHTML = chatLinkify(reply);
  messages.appendChild(botMsg);
  messages.scrollTop = messages.scrollHeight;
}

async function askZolaFallback(msg) {
  const m = msg.toLowerCase();
  let F = { plans: [], deals: [], services: [], addons: [] };
  try { F = await zolaFacts(); } catch (_) {}
  const $ = c => '$' + Math.round((Number(c) || 0) / 100).toLocaleString();
  const plan = k => F.plans.find(p => p.key === k);
  const ess = plan('ESSENTIAL'), eli = plan('ELITE');
  const tiers = ess && eli
    ? 'Essential (' + $(ess.cycle_cents) + ' every four weeks) and Elite (' + $(eli.cycle_cents) + ')'
    : 'Essential and Elite';
  const deals = F.deals.map(d => d.name + ' — ' + d.blurb).join(' ');
  const addon = n => { const a = F.addons.find(x => x.name === n); return a ? ' (+' + $(a.price_cents) + ' at booking)' : ''; };

  if (m.match(/\b(hi|hey|hello|hola|good morning|good afternoon)\b/))
    return "Hi love — I'm Ask Zola. Ask me anything about services, memberships, or booking. I know this studio inside and out.";

  if (m.includes('structure') || (m.includes('what') && m.includes('manicure')))
    return "A structure manicure is hard gel applied directly to your natural nail. It protects and strengthens the nail while it grows — without damaging it. Clients come to Zola because their nails actually grow here.";

  if (m.includes('hard gel') || m.includes('gel polish') || m.includes('acrylic') || (m.includes('difference') && m.includes('gel')))
    return "We build with hard gel and gel acrylic for structure — it supports your natural nail instead of replacing it. If you just want colour, the Regular Gel Manicure is on the menu too. services.html";

  if (m.includes('grow') || m.includes('growth') || m.includes('natural nail'))
    return "Clients come to Zola specifically because their nails grow here. The structure manicure supports your natural nail rather than replacing it, and Elite members get a personal nail record that tracks the growth visit to visit.";

  if (m.includes('russian') && !m.includes('pedi'))
    return "The Russian manicure technique is a precision method focused on the cuticle and surrounding skin — cleaner, more polished, longer-lasting. It's included on every Elite visit, and you can add it to any service" + addon('Russian Manicure') + ".";

  if (m.includes('tuesday') || m.includes('wednesday') || m.includes('deal') || m.includes('special') || m.includes('promo'))
    return (deals ? deals + ' Hands or toes. ' : '') + "Pick your day on the booking page and it's yours. booking.html?deal=tuesday";

  if (m.includes('discount') || m.includes('first visit') || m.includes('coupon') || m.includes('code'))
    return "Join the ZOLA list at the bottom of the homepage and 10% off your first visit lands in your inbox. Happy to sit with a trainee (with Zahra right beside them)? Code TRAIN20 takes $20 off." + (deals ? ' And every week: ' + deals : '');

  if ((m.includes('which') && m.includes('member')) || m.includes('right for me') || (m.includes('choose') && m.includes('tier')))
    return "Want it simple — in and out, exactly what you need? Essential" + (ess ? ' (' + $(ess.cycle_cents) + ' every four weeks)' : '') + ". Want your nails healthier every visit — any length, Russian manicure, free removal, organic product? Elite" + (eli ? ' (' + $(eli.cycle_cents) + ')' : '') + ". Either way, you leave owing nothing. memberships.html";

  if (m.includes('black card') || m.includes('blackcard') || m.includes('signature') || m.includes('luxe') || m.includes('founding') || m.includes('quarterly') || m.includes('atelier'))
    return "Signature, Luxe and Black Card are closed to new members now. The two memberships open today are " + tiers + " — one full service every four weeks, any design, no deposit, and you leave owing nothing. memberships.html";

  if (m.includes('essential'))
    return ess ? "Essential is " + $(ess.cycle_cents) + " every four weeks. " + ess.line + " " + ess.includes.join('. ') + ". You leave owing nothing. memberships.html"
               : "Essential is one full service every four weeks, any design, no deposit — in and out, exactly what you need. memberships.html";

  if (m.includes('elite'))
    return eli ? "Elite is " + $(eli.cycle_cents) + " every four weeks. " + eli.line + " " + eli.includes.join('. ') + ". memberships.html"
               : "Elite is about nail health over time — Russian manicure, free removal and organic product every visit, at any length. memberships.html";

  if (m.includes('how does membership') || (m.includes('membership') && m.includes('work')) || m.includes('member') || m.includes('join') || m.includes('tier'))
    return "Pick " + tiers + ". Each includes one full service every four weeks, any design at no extra charge, and no deposit — you leave owing nothing. Members book ahead of walk-ins. Minimum three months, then cancel any time from your account. memberships.html";

  if (m.includes('roll') || m.includes('unused') || (m.includes('miss') && m.includes('month')))
    return "Services don't roll over — each four-week cycle has its own service, so book within it. Your membership renews on the same date each cycle.";

  if (m.includes('upgrade'))
    return "You can move up to Elite from your Client Portal whenever you like.";

  if (m.includes('princess') || m.includes('kids') || m.includes('children') || m.includes('party') || m.includes('daughter'))
    return "Zola offers princess parties for kids — mini manicures and custom nail art, with safe products for little hands, and we travel to you. $20 per child, minimum 6 children. Tell us your date: contact.html";

  if ((m.includes('choose') && m.includes('artist')) || (m.includes('pick') && m.includes('artist')) || m.includes('specific artist') || m.includes('my artist'))
    return "Every artist here was trained by Zahra, hand on hand, until the work met her standard. You're matched with an artist when you book.";

  if (m.includes('profile') || m.includes('history') || m.includes('allerg') || m.includes('sensitiv'))
    return "Tell us about any allergies or sensitivities in the notes when you book and we'll plan around them. Elite members also get a personal nail record that tracks growth and health from visit to visit.";

  if (m.includes('organic') || (m.includes('product') && !m.includes('how much')))
    return "Every product used at Zola is personally vetted by Zahra. Organic product is used on every Elite visit, and the Organic Structured Manicure is on the menu for anyone. services.html";

  if (m.includes('price') || m.includes('cost') || m.includes('how much')) {
    if (!F.services.length) return "The full menu with prices is here: services.html";
    const min = Math.min.apply(null, F.services.map(s => Number(s.price_cents)));
    const set = F.services.filter(s => /gel x|acrylic/i.test(s.name)).map(s => Number(s.price_cents));
    return "Single visits start at " + $(min) + (set.length ? ", and Gel X and acrylic sets from " + $(Math.min.apply(null, set)) : '') + ". "
      + (deals ? deals + ' ' : '') + "Memberships: " + tiers + ". services.html";
  }

  if (m.includes('soak') || m.includes('removal') || m.includes('another salon'))
    return "If you're coming from another salon, add a soak off removal" + addon('Removal') + " when you book and we take care of the rest. booking.html";

  if (m.includes('cancel') || m.includes('refund') || m.includes('deposit') || m.includes('cancellation'))
    return "Cancel more than 24 hours ahead and we'll reschedule you at no cost. The 50% deposit taken at booking is non-refundable, and members pay no deposit at all.";

  if (m.includes('book') || m.includes('appointment') || m.includes('schedule') || m.includes('reserve') || m.includes('how do i book'))
    return "Pick your service, then a day and time, then your details — a 50% deposit holds your spot (members pay none). booking.html";

  if (m.includes('walk') || m.includes('same day') || m.includes('drop in'))
    return "Zola does not take walk-ins. Every appointment is reserved in advance — your time is protected, and so is ours. booking.html";

  if (m.includes('nail art') || m.includes('design') || (m.includes('art') && !m.includes('artist')))
    return "Any design is included in both memberships at no extra charge. " + (deals ? 'On deal days: ' + deals : '') + " Clean, editorial work is what this studio is known for.";

  if (m.includes('how long') || m.includes('last') || m.includes('durable'))
    return "Structure manicures typically last three to five weeks depending on your natural growth and lifestyle. Because they work with your nail rather than against it, they grow out cleanly rather than lifting or breaking.";

  if (m.includes('location') || m.includes('where') || m.includes('address') || m.includes('porterville'))
    return "Zola is in Porterville, California. Appointment only — book online. booking.html";

  if (m.includes('hours') || m.includes('open') || (m.includes('when') && !m.includes('member')))
    return (F.hours ? "Hours: " + F.hours + ". " : "") + "Everything is by appointment — pick a time that suits you. booking.html";

  if (m.includes('instagram') || m.includes('tiktok') || m.includes('social') || m.includes('@zlux') || m.includes('@zola'))
    return "Follow the work at @zola_officials_ on Instagram or @zolaofficial on TikTok. For the fastest direct response, Instagram DMs are the place.";

  if (m.includes('different') || m.includes('other salon') || m.includes('why zola'))
    return "Most salons prioritize speed and volume. Zola prioritizes nail health, precision and privacy — Russian technique, organic product, and a personal nail record for Elite members. Every artist was trained by Zahra.";

  if (m.includes('gift') || m.includes('gift card'))
    return "Gift cards are available! Ask through the contact page and we'll send a digital gift card to you or the recipient. contact.html";

  if (m.includes('pedicure') || m.includes('feet') || m.includes('toes') || m.includes('callus'))
    return "Zola offers the Russian Dry Pedicure — a water-free, Russian-technique treatment that grows out your natural toenails, no soaking required. For calluses, the Full Correction adds targeted exfoliation and buffing each visit. services.html";

  if (m.includes('worker') || m.includes('who does') || m.includes('zahra') || m.includes('who will do'))
    return "Services are performed by Zahra and her team — every artist trained by Zahra herself.";

  return "That's a great one for the Zola team — reach out through the contact page or DM @zola_officials_ on Instagram for the fastest response.";
}
