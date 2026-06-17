const { query, execute } = require('./_db');
const store = require('./_store');

function auth(req) {
  const pwd = req.headers['x-ceo-password'] || req.query.pwd;
  return pwd === (process.env.CEO_PASSWORD || 'ZOLA2026');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CEO-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Public tracking (no auth) — funnel + chat questions
  if (req.method === 'POST' && req.body?.event) {
    const { event, question, step, sessionId } = req.body;
    if (event === 'chat_question' && question) {
      store.chatQuestions.push({ q: question.slice(0, 120), ts: Date.now() });
      if (store.chatQuestions.length > 1000) store.chatQuestions.shift();
    }
    if (event === 'funnel_step' || event === 'funnel_drop') {
      store.funnelEvents.push({ step: Number(step), sessionId, ts: Date.now(), dropped: event === 'funnel_drop' });
      if (store.funnelEvents.length > 2000) store.funnelEvents.shift();
    }
    return res.status(200).json({ ok: true });
  }

  if (!auth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const section = req.query.section;

  // ── GET ────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (section === 'overview') {
      let members = [];
      try { members = await query('SELECT tier FROM members'); } catch (_) {}
      const PRICE = { SIGNATURE: 9900, LUXE: 19900, BLACK_CARD: 29900 };
      const mrr = members.reduce((s, m) => s + (PRICE[m.tier] || 0), 0);
      const byTier = { SIGNATURE: 0, LUXE: 0, BLACK_CARD: 0 };
      members.forEach(m => { if (byTier[m.tier] !== undefined) byTier[m.tier]++; });
      const today = new Date().toISOString().slice(0, 10);
      const todayBookings = store.bookings.filter(b => b.date === today);
      return res.json({
        mrr, totalMembers: members.length, byTier,
        todayBookings: todayBookings.length,
        todayRevenue: todayBookings.reduce((s, b) => s + b.total_cents, 0),
        totalBookings: store.bookings.length,
        upcomingBookings: store.bookings.filter(b => b.date >= today).sort((a,b) => a.date.localeCompare(b.date) || a.time_slot.localeCompare(b.time_slot)).slice(0, 8),
        recentBookings: store.bookings.slice(-6).reverse(),
        lowInventory: store.inventory.filter(i => i.qty <= i.low_at),
        topQuestions: topQuestions(5),
        funnelSummary: funnelSummary(),
      });
    }

    if (section === 'clients') {
      let members = [];
      try {
        members = await query('SELECT member_id, full_name, email, phone, tier, membership_started_at, next_billing_at, referral_code, flagged FROM members ORDER BY membership_started_at DESC');
      } catch (_) {}
      return res.json({ members });
    }

    if (section === 'bookings') {
      const dateFilter = req.query.date;
      let result = store.bookings.slice().reverse();
      if (dateFilter) result = result.filter(b => b.date === dateFilter);
      return res.json({ bookings: result });
    }

    if (section === 'reports') {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const weeklyBookings = store.bookings.filter(b => b.date >= weekAgo);
      const monthlyBookings = store.bookings.filter(b => b.date >= monthAgo);
      const svcCount = {};
      store.bookings.forEach(b => { svcCount[b.service_name] = (svcCount[b.service_name] || 0) + 1; });
      return res.json({
        weeklyBookings: weeklyBookings.length,
        weeklyRevenue: weeklyBookings.reduce((s,b) => s + b.total_cents, 0),
        monthlyBookings: monthlyBookings.length,
        monthlyRevenue: monthlyBookings.reduce((s,b) => s + b.total_cents, 0),
        totalBookings: store.bookings.length,
        funnelByStep: funnelSummary(),
        topQuestions: topQuestions(20),
        servicePopularity: Object.entries(svcCount).sort((a,b) => b[1]-a[1]).slice(0, 8),
      });
    }

    if (section === 'services') return res.json({ services: store.services, addons: store.addons });
    if (section === 'inventory') return res.json({ inventory: store.inventory });
    if (section === 'giftcards') return res.json({ giftCards: store.giftCards });
    if (section === 'goals') {
      let members = [];
      try { members = await query('SELECT tier FROM members'); } catch (_) {}
      const byTier = { SIGNATURE: 0, LUXE: 0, BLACK_CARD: 0 };
      members.forEach(m => { if (byTier[m.tier] !== undefined) byTier[m.tier]++; });
      const PRICE = { SIGNATURE: 9900, LUXE: 19900, BLACK_CARD: 29900 };
      const mrr = members.reduce((s, m) => s + (PRICE[m.tier] || 0), 0);
      const live = store.goals.map(g => {
        if (g.title.includes('Signature')) return { ...g, current: byTier.SIGNATURE };
        if (g.title.includes('Luxe'))      return { ...g, current: byTier.LUXE };
        if (g.title.includes('Black Card'))return { ...g, current: byTier.BLACK_CARD };
        if (g.title.includes('revenue'))   return { ...g, current: mrr };
        return g;
      });
      return res.json({ goals: live });
    }
  }

  // ── PUT ────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const { section: s, data } = req.body;
    if (s === 'service' && data) {
      const idx = store.services.findIndex(x => x.id === data.id);
      if (idx >= 0) Object.assign(store.services[idx], data);
      return res.json({ ok: true });
    }
    if (s === 'addon' && data) {
      const idx = store.addons.findIndex(x => x.id === data.id);
      if (idx >= 0) Object.assign(store.addons[idx], data);
      return res.json({ ok: true });
    }
    if (s === 'inventory' && data) {
      const idx = store.inventory.findIndex(x => x.id === data.id);
      if (idx >= 0) Object.assign(store.inventory[idx], data);
      return res.json({ ok: true });
    }
    if (s === 'goal' && data) {
      const idx = store.goals.findIndex(x => x.id === data.id);
      if (idx >= 0) Object.assign(store.goals[idx], data);
      return res.json({ ok: true });
    }
    if (s === 'flag_member' && data?.memberId) {
      try {
        await execute('UPDATE members SET flagged = ? WHERE member_id = ?', [data.flagged ? 1 : 0, data.memberId]);
        return res.json({ ok: true });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    }
    if (s === 'redeem_giftcard' && data?.id) {
      const card = store.giftCards.find(g => g.id === Number(data.id));
      if (card) { card.redeemed = true; card.balance_cents = 0; }
      return res.json({ ok: true });
    }
  }

  // ── POST (authenticated) ────────────────────────────────────────────
  if (req.method === 'POST') {
    const { section: s, data } = req.body || {};
    if (s === 'service' && data) {
      const newSvc = { ...data, id: (store.services[store.services.length-1]?.id || 0) + 1 };
      store.services.push(newSvc);
      return res.json({ ok: true, service: newSvc });
    }
    if (s === 'giftcard' && data) {
      const card = {
        id: store.incGiftId(),
        code: 'ZOLA-' + Math.random().toString(36).slice(2,8).toUpperCase(),
        amount_cents: Number(data.amount_cents),
        recipient_name: data.recipient_name,
        recipient_email: data.recipient_email || '',
        balance_cents: Number(data.amount_cents),
        issued_at: new Date().toISOString(),
        redeemed: false,
      };
      store.giftCards.push(card);
      return res.json({ ok: true, card });
    }
    if (s === 'goal' && data) {
      const g = { ...data, id: store.incGoalId(), current: 0 };
      store.goals.push(g);
      return res.json({ ok: true, goal: g });
    }
    if (s === 'inventory' && data) {
      const item = { ...data, id: store.incInventoryId() };
      store.inventory.push(item);
      return res.json({ ok: true, item });
    }
    if (s === 'mass_sms' && data?.message) {
      let members = [];
      try { members = await query('SELECT full_name, phone, tier FROM members WHERE phone IS NOT NULL'); } catch (_) {}
      if (data.tier_filter) members = members.filter(m => m.tier === data.tier_filter);
      let sent = 0;
      if (process.env.TWILIO_ACCOUNT_SID) {
        const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        for (const m of members) {
          const digits = (m.phone || '').replace(/\D/g, '');
          const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : null;
          if (!e164) continue;
          try {
            await twilio.messages.create({ body: data.message.replace('{name}', m.full_name.split(' ')[0]), from: process.env.TWILIO_PHONE_NUMBER, to: e164 });
            sent++;
          } catch (_) {}
        }
      }
      return res.json({ ok: true, sent, total: members.length });
    }
  }

  // ── DELETE ─────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (req.query.section === 'service') {
      const id = Number(req.query.id);
      const idx = store.services.findIndex(s => s.id === id);
      if (idx >= 0) store.services.splice(idx, 1);
      return res.json({ ok: true });
    }
    if (req.query.section === 'inventory') {
      const id = Number(req.query.id);
      const idx = store.inventory.findIndex(i => i.id === id);
      if (idx >= 0) store.inventory.splice(idx, 1);
      return res.json({ ok: true });
    }
  }

  res.status(400).json({ error: 'Bad request' });
};

function topQuestions(n = 10) {
  const counts = {};
  store.chatQuestions.forEach(({ q }) => {
    const key = q.toLowerCase().trim().slice(0, 80);
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, n).map(([q, count]) => ({ q, count }));
}

function funnelSummary() {
  const res = {};
  for (let i = 1; i <= 4; i++) {
    res[i] = {
      reached: store.funnelEvents.filter(e => e.step === i && !e.dropped).length,
      dropped: store.funnelEvents.filter(e => e.step === i && e.dropped).length,
    };
  }
  return res;
}
