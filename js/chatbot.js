function toggleChat() {
  const box = document.getElementById('chat-box');
  box.classList.toggle('open');
  if (box.classList.contains('open')) {
    setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
  }
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input?.value.trim();
  if (!msg) return;
  input.value = '';

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

  let reply;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    reply = data.reply || askZFallback(msg);
  } catch {
    reply = askZFallback(msg);
  }

  document.getElementById('chat-thinking')?.remove();
  const botMsg = document.createElement('div');
  botMsg.className = 'chat-msg zlux';
  botMsg.textContent = reply;
  messages.appendChild(botMsg);
  messages.scrollTop = messages.scrollHeight;
}

function askZFallback(msg) {
  const m = msg.toLowerCase();

  if (m.match(/\b(hi|hey|hello|hola|good morning|good afternoon)\b/))
    return "Hi — I'm Ask Z, the Z Lux concierge. Ask me anything about services, memberships, or booking. I know this studio inside and out.";

  if (m.includes('structure') || (m.includes('what') && m.includes('manicure')))
    return "A structure manicure is hard gel applied directly to your natural nail. It protects and strengthens the nail while it grows — without damaging it. Clients come to Z Lux because their nails actually grow here. This is not a standard nail service.";

  if (m.includes('hard gel') || m.includes('gel polish') || m.includes('acrylic') || (m.includes('difference') && m.includes('gel')))
    return "We work exclusively with hard gel and gel acrylic. Soft gel and regular gel polish are not offered — those systems are more limiting and less supportive for nail health. Hard gel gives real structure without the damage that liquid-powder acrylic can cause when applied carelessly.";

  if (m.includes('grow') || m.includes('growth') || m.includes('natural nail'))
    return "Clients come to Z Lux specifically because their nails grow here. The structure manicure supports your natural nail rather than replacing it. Most members see real growth within their first two to three months.";

  if (m.includes('russian'))
    return "The Russian manicure technique is a precision method focused on the cuticle and surrounding skin. The result is cleaner, more polished, and longer-lasting. It's included for Luxe and Black Card members, and available as a $30 add-on for any service.";

  if ((m.includes('which') && m.includes('member')) || m.includes('right for me') || (m.includes('choose') && m.includes('tier')))
    return "How often do you typically get your nails done? Once a month — Signature ($99) is built for that. Twice or more — Luxe ($199) gives you two services plus extras. If you want the most access and a direct relationship with Zahra — Black Card ($349) is in a different category entirely.";

  if (m.includes('signature'))
    return "Signature Club is $99/month. One service per month — your choice of manicure or pedicure. 10% off all add-ons, birthday month upgrade, and members-only access. It's the entry point — clean, consistent, no frills.";

  if (m.includes('luxe'))
    return "Luxe Club is $199/month. Up to 2 services per month, a complimentary Russian manicure, 30% off all add-ons, one free scrub or lotion massage monthly, all organic products, Russian technique at every visit, and second priority booking. Nail health is prioritized at every appointment.";

  if (m.includes('black card') || m.includes('blackcard'))
    return "Black Card is $299/month founding rate — locked forever. Up to 3 services, choose your specific nail artist for every appointment, all add-ons complimentary, monthly nail art, quarterly nail assessments, personal client profile, and first access to everything. Most exclusive tier available.";

  if (m.includes('member') || m.includes('membership') || m.includes('join') || m.includes('tier'))
    return "Three tiers: Signature ($99/mo, 1 service, 10% off add-ons), Luxe ($199/mo, 2 services + Russian manicure + 30% off add-ons + organic products + nail health focus), Black Card ($299/mo founding rate, 3 services + free add-ons + choose your artist + quarterly assessments). Spots are limited.";

  if (m.includes('roll') || m.includes('unused') || (m.includes('miss') && m.includes('month')))
    return "Signature and Luxe services do not roll over — if you don't book before the month ends, the service drops. Black Card members can carry over one service. The membership renews regardless.";

  if (m.includes('upgrade'))
    return "Upgrades are available based on spot availability in the higher tier. Request through your Client Portal. Downgrades are only available after the 6-month minimum commitment.";

  if (m.includes('founding') || m.includes('locked') || m.includes('price increase'))
    return "The founding rate on Black Card is locked in forever for original members. Your price will never increase as long as your membership is active. That guarantee does not apply to members who join later at a higher rate.";

  if (m.includes('quarterly') || m.includes('assessment') || m.includes('nail health check'))
    return "Black Card members receive a quarterly nail assessment — a Z Lux artist personally reviews your nail growth, health, and length progress and builds a custom plan. No other studio in this area offers this.";

  if (m.includes('princess') || m.includes('kids') || m.includes('children') || m.includes('party') || m.includes('daughter'))
    return "Z Lux offers princess parties for kids — mini manicures and custom nail art in a safe, elevated studio experience. $35 per child, minimum 6 children. Use the contact form to inquire about dates and availability.";

  if (m.includes('choose') && m.includes('artist') || m.includes('pick') && m.includes('artist') || m.includes('specific artist') || m.includes('my artist'))
    return "Choosing your specific nail artist for every appointment is exclusive to Black Card members. Signature and Luxe members are assigned based on availability. Black Card is the only tier where your artist is guaranteed every visit.";

  if (m.includes('profile') || m.includes('history') || m.includes('allerg') || m.includes('sensitiv'))
    return "Every Black Card member has a personal client profile — a full record of services, sensitivities, shape preferences, allergies, and nail progress. Every appointment is informed by what came before. Nothing starts from scratch.";

  if (m.includes('organic') || (m.includes('product') && !m.includes('how much')))
    return "Every product used at Z Lux is personally vetted by Zahra. Organic products are standard for Luxe and Black Card members. She will always choose the healthier option, regardless of cost. Most studios cannot say that.";

  if (m.includes('price') || m.includes('cost') || m.includes('how much'))
    return "Services start at $85 for pedicures and $90 for manicures. Memberships start at $99/month and save you up to 45% compared to drop-in pricing. Full menu is on the Services page.";

  if (m.includes('soak') || m.includes('removal') || m.includes('another salon'))
    return "If you're coming from another salon, add a soak off removal (+$35) to your booking. It's on the booking page — select it and we take care of the rest.";

  if (m.includes('book') || m.includes('appointment') || m.includes('schedule') || m.includes('reserve'))
    return "Booking is by appointment only — no walk-ins. Go to the Book page, follow the steps. A 50% deposit secures your spot. Members book before the public calendar opens.";

  if (m.includes('cancel') || m.includes('refund') || m.includes('deposit'))
    return "The 50% deposit is non-refundable. With 48+ hours notice, it applies toward your rescheduled appointment. No-shows forfeit it. This protects the artist's time — it stands across all bookings.";

  if (m.includes('birthday'))
    return "Every tier includes a birthday month upgrade — your choice of a free scrub, free massage, or free removal. You set your birthday month in your Client Portal or at booking. It unlocks automatically that month.";

  if (m.includes('walk') || m.includes('same day') || m.includes('drop in'))
    return "Z Lux does not take walk-ins. Every appointment is reserved in advance. That's part of what makes the experience what it is — your time is protected, and so is ours.";

  if (m.includes('nail art') || m.includes('design') || (m.includes('art') && !m.includes('artist')))
    return "Nail art is available for any service. Black Card members have monthly nail art included. Style and design are discussed at your appointment. Clean, editorial work is what this studio is known for.";

  if (m.includes('how long') || m.includes('last') || m.includes('durable'))
    return "Structure manicures typically last three to five weeks depending on your natural growth and lifestyle. Because they work with your nail rather than against it, they grow out cleanly rather than lifting or breaking.";

  if (m.includes('location') || m.includes('where') || m.includes('address') || m.includes('porterville'))
    return "Z Lux is located in Porterville, California. Appointment-only — book online through the Book page.";

  if (m.includes('hours') || m.includes('open') || (m.includes('when') && !m.includes('member')))
    return "The studio is available Monday through Sunday, 6 AM to 10 PM. All appointments are by booking — no walk-ins.";

  if (m.includes('instagram') || m.includes('social') || m.includes('@zlux'))
    return "Follow the work at @zluxnails on Instagram. For the fastest direct response, that's the place.";

  if (m.includes('different') || m.includes('other salon') || m.includes('why z lux'))
    return "Most salons prioritize speed and volume. Z Lux prioritizes health, precision, and privacy. Organic products, Russian technique expertise, personal client tracking, quarterly assessments — none of that exists at a standard salon. Every visit here has context.";

  return "That's a great one for the Z Lux team directly — reach out through the contact form and someone will get back to you. Or DM @zluxnails on Instagram for the fastest response.";
}
