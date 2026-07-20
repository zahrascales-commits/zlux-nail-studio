const FAQ_CHIPS = [
  { label: 'How does membership work?',    q: 'how does membership work' },
  { label: 'How do I book?',               q: 'how do I book an appointment' },
  { label: 'What tier is right for me?',   q: 'which membership is right for me' },
  { label: 'How much does it cost?',       q: 'how much does it cost' },
  { label: 'Do services roll over?',       q: 'do unused services roll over' },
  { label: 'Can I pick my artist?',        q: 'can I choose my nail artist' },
  { label: 'What is a structure mani?',    q: 'what is a structure manicure' },
  { label: 'What is the Black Card?',      q: 'tell me about black card membership' },
  { label: 'Cancellation & deposits',      q: 'what is your cancellation and deposit policy' },
  { label: 'Kids / princess parties',      q: 'do you offer princess parties for kids' },
];

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
    renderFaqChips();
    setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
  }
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
    reply = data.reply || askZolaFallback(msg);
  } catch {
    reply = askZolaFallback(msg);
  }
  // Keep a short rolling history so the AI remembers the conversation
  window._zolaChatHistory = (window._zolaChatHistory || []).concat(
    [{ role: 'user', text: msg }, { role: 'assistant', text: reply }]
  ).slice(-10);

  document.getElementById('chat-thinking')?.remove();
  const botMsg = document.createElement('div');
  botMsg.className = 'chat-msg zlux';
  botMsg.textContent = reply;
  messages.appendChild(botMsg);
  messages.scrollTop = messages.scrollHeight;
}

function askZolaFallback(msg) {
  const m = msg.toLowerCase();

  if (m.match(/\b(hi|hey|hello|hola|good morning|good afternoon)\b/))
    return "Hi love — I'm Ask Zola. Ask me anything about services, memberships, or booking. I know this studio inside and out.";

  if (m.includes('structure') || (m.includes('what') && m.includes('manicure')))
    return "A structure manicure is hard gel applied directly to your natural nail. It protects and strengthens the nail while it grows — without damaging it. Clients come to Zola because their nails actually grow here. This is not a standard nail service.";

  if (m.includes('hard gel') || m.includes('gel polish') || m.includes('acrylic') || (m.includes('difference') && m.includes('gel')))
    return "We work exclusively with hard gel and gel acrylic. Soft gel and regular gel polish are not offered — those systems are more limiting and less supportive for nail health. Hard gel gives real structure without the damage that liquid-powder acrylic can cause when applied carelessly.";

  if (m.includes('grow') || m.includes('growth') || m.includes('natural nail'))
    return "Clients come to Zola specifically because their nails grow here. The structure manicure supports your natural nail rather than replacing it. Most members see real growth within their first two to three months.";

  if (m.includes('russian'))
    return "The Russian manicure technique is a precision method focused on the cuticle and surrounding skin. The result is cleaner, more polished, and longer-lasting. It's included for Luxe and Black Card members, and available as a $30 add-on for any service.";

  if ((m.includes('which') && m.includes('member')) || m.includes('right for me') || (m.includes('choose') && m.includes('tier')))
    return "How often do you get your nails done? Once a month — Signature ($99) is perfect. Twice or more — Luxe ($199) gives 2 services plus extras. If you want the most access and a direct relationship with Zahra — Black Card ($299) is in a different category entirely.";

  if (m.includes('how does membership') || (m.includes('membership') && m.includes('work')))
    return "You choose a tier, pay monthly, and get a set number of services included each month. Members book before the public calendar opens — priority access is one of the biggest perks. Your member ID gets you in, unlocks your discounts, and tracks your nail history.";

  if (m.includes('signature'))
    return "Signature Club is $99/month. One service per month — your choice of manicure or pedicure. 10% off all add-ons, birthday month upgrade, and members-only booking access. It's the entry point — clean, consistent, no frills.";

  if (m.includes('luxe'))
    return "Luxe Club is $199/month. Up to 2 services per month, a complimentary Russian manicure, 30% off all add-ons, one free scrub or lotion massage monthly, all organic products, and second-priority booking. Nail health is a priority at every appointment.";

  if (m.includes('black card') || m.includes('blackcard'))
    return "Black Card is $299/month founding rate — locked forever. 2 services a month, choose your specific nail artist every time, all add-ons complimentary, monthly nail art, quarterly nail assessments, personal client profile, and first access to every open slot. Most exclusive tier available.";

  if (m.includes('member') || m.includes('membership') || m.includes('join') || m.includes('tier'))
    return "Three tiers: Signature ($99/mo, 1 service, 10% off add-ons), Luxe ($199/mo, 2 services + Russian manicure + 30% off add-ons + organic products), Black Card ($299/mo founding rate, 2 services + free add-ons + choose your artist + quarterly assessments). Spots are limited.";

  if (m.includes('roll') || m.includes('unused') || (m.includes('miss') && m.includes('month')))
    return "Signature and Luxe services do not roll over — if you don't book before the month ends, the service drops. Black Card members can carry over one service. The membership renews regardless.";

  if (m.includes('upgrade'))
    return "Upgrades are available based on spot availability in the higher tier. Request through your Client Portal. Downgrades are only available after the 6-month minimum commitment.";

  if (m.includes('founding') || m.includes('locked') || m.includes('price increase'))
    return "The founding rate on Black Card is locked in forever for original members. Your price will never increase as long as your membership stays active. That guarantee does not apply to members who join later at a higher rate.";

  if (m.includes('quarterly') || m.includes('assessment') || m.includes('nail health check'))
    return "Black Card members receive a quarterly nail assessment — a Zola artist personally reviews your nail growth, health, and length progress and builds a custom plan. No other studio in this area offers this.";

  if (m.includes('princess') || m.includes('kids') || m.includes('children') || m.includes('party') || m.includes('daughter'))
    return "Zola offers princess parties for kids — mini manicures and custom nail art in a safe, elevated studio experience. $20 per child, minimum 6 children. Use the contact form to inquire about dates and availability.";

  if ((m.includes('choose') && m.includes('artist')) || (m.includes('pick') && m.includes('artist')) || m.includes('specific artist') || m.includes('my artist'))
    return "Choosing your specific nail artist every appointment is exclusive to Black Card members. Signature and Luxe members are assigned based on availability. Black Card is the only tier where your artist is guaranteed every visit.";

  if (m.includes('profile') || m.includes('history') || m.includes('allerg') || m.includes('sensitiv'))
    return "Every Black Card member has a personal client profile — a full record of services, sensitivities, shape preferences, allergies, and nail progress. Every appointment is informed by what came before. Nothing starts from scratch.";

  if (m.includes('organic') || (m.includes('product') && !m.includes('how much')))
    return "Every product used at Zola is personally vetted by Zahra. Organic products are standard for Luxe and Black Card members. She will always choose the healthier option, regardless of cost. Most studios cannot say that.";

  if (m.includes('price') || m.includes('cost') || m.includes('how much'))
    return "Services start at $90 for manicures and $95 for the Russian Dry Pedicure. Memberships start at $99/month and save you significantly compared to drop-in pricing. Full pricing is on the Services page.";

  if (m.includes('soak') || m.includes('removal') || m.includes('another salon'))
    return "If you're coming from another salon, add a soak off removal (+$35) to your booking. It's on the booking page — select it as an add-on and we take care of the rest.";

  if (m.includes('book') || m.includes('appointment') || m.includes('schedule') || m.includes('reserve') || m.includes('how do i book'))
    return "Booking is appointment-only — no walk-ins. Go to the Book page, select your service and date, enter your info, and pay a 50% deposit to lock in your spot. Members get priority access to slots before guests see them.";

  if (m.includes('cancel') || m.includes('refund') || m.includes('deposit') || m.includes('cancellation'))
    return "The 50% deposit is non-refundable. With 48+ hours notice, it applies toward your rescheduled appointment. No-shows forfeit it entirely. This protects the artist's time — it applies across all bookings without exception.";

  if (m.includes('birthday'))
    return "Every tier includes a birthday month upgrade — your choice of a free scrub, free massage, or free removal. Set your birthday month in your Client Portal or at booking. It unlocks automatically that month.";

  if (m.includes('walk') || m.includes('same day') || m.includes('drop in'))
    return "Zola does not take walk-ins. Every appointment is reserved in advance. That's part of what makes the experience what it is — your time is protected, and so is ours.";

  if (m.includes('nail art') || m.includes('design') || (m.includes('art') && !m.includes('artist')))
    return "Nail art is available for any service. Black Card members have monthly nail art included. Style and design are discussed at your appointment. Clean, editorial work is what this studio is known for.";

  if (m.includes('how long') || m.includes('last') || m.includes('durable'))
    return "Structure manicures typically last three to five weeks depending on your natural growth and lifestyle. Because they work with your nail rather than against it, they grow out cleanly rather than lifting or breaking.";

  if (m.includes('location') || m.includes('where') || m.includes('address') || m.includes('porterville'))
    return "Zola is located in Porterville, California. Appointment-only — book online through the Book page.";

  if (m.includes('hours') || m.includes('open') || (m.includes('when') && !m.includes('member')))
    return "The studio is available Monday through Sunday, 8 AM to 10 PM. All appointments are by booking — no walk-ins.";

  if (m.includes('instagram') || m.includes('social') || m.includes('@zlux'))
    return "Follow the work at @zluxnails on Instagram. For the fastest direct response, that's the place.";

  if (m.includes('different') || m.includes('other salon') || m.includes('why zola'))
    return "Most salons prioritize speed and volume. Zola prioritizes health, precision, and privacy. Organic products, Russian technique expertise, personal client tracking, quarterly assessments — none of that exists at a standard salon. Every visit here has context.";

  if (m.includes('gift') || m.includes('gift card'))
    return "Gift cards are available! They make perfect presents. Purchase through the contact form and we'll send a digital gift card directly to you or the recipient.";

  if (m.includes('pedicure') || m.includes('feet') || m.includes('toes') || m.includes('callus'))
    return "Zola offers the Russian Dry Pedicure ($95) — a water-free, Russian-technique treatment that grows out your natural toenails flawlessly, no soaking required. For calluses and complete foot renewal, the Russian Dry Pedicure — Full Correction ($125) adds targeted exfoliation and buffing each visit — the only way calluses truly resolve.";

  if (m.includes('worker') || m.includes('who does') || m.includes('zahra') || m.includes('who will do'))
    return "Zola services are performed by Zahra and her trained team of nail technicians. Black Card members have the exclusive option to request Zahra for every appointment.";

  return "That's a great one for the Zola team — reach out through the contact form or DM @zluxnails on Instagram for the fastest response.";
}
