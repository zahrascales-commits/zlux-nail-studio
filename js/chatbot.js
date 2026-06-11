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
    reply = data.reply || smartFallback(msg);
  } catch {
    reply = smartFallback(msg);
  }

  document.getElementById('chat-thinking')?.remove();
  const botMsg = document.createElement('div');
  botMsg.className = 'chat-msg zlux';
  botMsg.textContent = reply;
  messages.appendChild(botMsg);
  messages.scrollTop = messages.scrollHeight;
}

function smartFallback(msg) {
  const m = msg.toLowerCase();
  if (m.includes('soak') || m.includes('removal') || m.includes('another salon'))
    return "If you're coming from another salon, you'll need a soak off removal (+$35) added to your new set. Add it right on the booking page 💅";
  if (m.includes('member') || m.includes('membership') || m.includes('join'))
    return "We have three tiers — Signature ($99), Luxe ($199), and Black Card ($299/mo founding rate). Spots are very limited! See zluxnails.com/memberships 🥂";
  if (m.includes('price') || m.includes('cost') || m.includes('how much'))
    return "Services start at $85 for pedicures and $90 for manicures. Full menu at zluxnails.com/services 💛";
  if (m.includes('book') || m.includes('appointment') || m.includes('schedule'))
    return "Ready to book? Head to zluxnails.com/book — takes under 2 minutes. Your spot is secured with a 50% deposit 💅";
  if (m.includes('cancel') || m.includes('refund') || m.includes('deposit'))
    return "The 50% deposit is non-refundable. With 48+ hours notice, it can be applied to your rescheduled appointment. No-shows forfeit the deposit.";
  if (m.includes('hello') || m.includes('hi') || m.includes('hey'))
    return "Hi love! 💅 I'm the ZLUX concierge. Ask me about services, memberships, or booking — I'm here to help!";
  if (m.includes('healthy') || m.includes('natural') || m.includes('best') || m.includes('recommend'))
    return "For the healthiest option, I'd recommend our Organic Structured Manicure — it works with your natural nail and promotes growth. Add the Russian Manicure technique for extra precision 💛";
  if (m.includes('porterville') || m.includes('location') || m.includes('where'))
    return "ZLUX is located in Porterville, California. We're appointment-only — book at zluxnails.com/book 📍";
  return "Hi love! 💅 For the quickest answer, DM us @zluxnails or visit zluxnails.com/book to reserve your spot!";
}
