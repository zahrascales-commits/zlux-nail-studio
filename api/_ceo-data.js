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
    // Every booking figure below comes from the durable appointments table.
    // It used to read store.bookings, an in-memory array that empties on every
    // cold start — which is how a paid booking could reach Stripe and the bank
    // while this dashboard still said zero.
    async function allBookings() {
      try {
        const rows = await query(
          `SELECT id, guest_name, guest_email, service, addons, appointment_date, appointment_time,
                  status, total_cents, deposit_cents, deposit_paid, staff_id, member_id, created_at
             FROM appointments ORDER BY appointment_date DESC, appointment_time DESC`);
        return rows.map(r => ({
          id: r.id,
          guest_name: r.guest_name,
          guest_email: r.guest_email,
          service_name: r.service,
          service: r.service,
          addons: r.addons,
          date: r.appointment_date,
          appointment_date: r.appointment_date,
          time_slot: r.appointment_time,
          appointment_time: r.appointment_time,
          status: r.status,
          total_cents: Number(r.total_cents) || 0,
          deposit_cents: Number(r.deposit_cents) || 0,
          deposit_paid: Number(r.deposit_paid) || 0,
          staff_id: r.staff_id,
          member_id: r.member_id,
          created_at: r.created_at,
        }));
      } catch (_) { return []; }
    }
    // Cancelled bookings still belong in the history, but never in revenue.
    const isLive = b => String(b.status || '').toUpperCase() !== 'CANCELLED';
    const sumRevenue = list => list.filter(isLive).reduce((s, b) => s + (b.total_cents || 0), 0);

    if (section === 'overview') {
      let members = [];
      try { members = await query('SELECT tier FROM members WHERE COALESCE(demo,0)=0'); } catch (_) {}
      const PRICE = { SIGNATURE: 9900, LUXE: 19900, BLACK_CARD: 29900 };
      const mrr = members.reduce((s, m) => s + (PRICE[m.tier] || 0), 0);
      const byTier = { SIGNATURE: 0, LUXE: 0, BLACK_CARD: 0 };
      members.forEach(m => { if (byTier[m.tier] !== undefined) byTier[m.tier]++; });

      const all = await allBookings();
      const today = new Date().toISOString().slice(0, 10);
      const todayBookings = all.filter(b => b.date === today);
      return res.json({
        mrr, totalMembers: members.length, byTier,
        todayBookings: todayBookings.length,
        todayRevenue: sumRevenue(todayBookings),
        totalBookings: all.length,
        upcomingBookings: all.filter(b => b.date >= today && isLive(b))
          .sort((a, b) => String(a.date).localeCompare(String(b.date))
            || String(a.time_slot).localeCompare(String(b.time_slot))).slice(0, 8),
        recentBookings: all.slice(0, 6),
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
      const all = await allBookings();
      const dateFilter = req.query.date;
      return res.json({ bookings: dateFilter ? all.filter(b => b.date === dateFilter) : all });
    }

    if (section === 'reports') {
      const all = await allBookings();
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const weekly = all.filter(b => b.date >= weekAgo);
      const monthly = all.filter(b => b.date >= monthAgo);
      const svcCount = {};
      all.filter(isLive).forEach(b => { svcCount[b.service_name] = (svcCount[b.service_name] || 0) + 1; });
      return res.json({
        weeklyBookings: weekly.length,
        weeklyRevenue: sumRevenue(weekly),
        monthlyBookings: monthly.length,
        monthlyRevenue: sumRevenue(monthly),
        totalBookings: all.length,
        funnelByStep: funnelSummary(),
        topQuestions: topQuestions(20),
        servicePopularity: Object.entries(svcCount).sort((a, b) => b[1] - a[1]).slice(0, 8),
      });
    }

    // ── RECORDS: the permanent books, month by month and year by year ──
    // Kept as a separate section so the dashboard stays fast: this walks
    // everything ever booked, which the day-to-day screens do not need.
    if (section === 'records') {
      const all = await allBookings();

      let members = [];
      try {
        members = await query('SELECT member_id, full_name, tier, membership_started_at FROM members WHERE COALESCE(demo,0)=0');
      } catch (_) {}

      let team = [], teamAppts = [];
      try {
        const tdb = require('./_team-db');
        await tdb.ensureTables();
        team = await tdb.query('SELECT id, name FROM team_members');
        teamAppts = await tdb.query('SELECT team_member_id, client_name, service, date, status FROM team_appointments');
      } catch (_) {}

      let inventory = [];
      try {
        const tdb = require('./_team-db');
        inventory = await tdb.query('SELECT name, qty, unit, created_ts FROM studio_inventory');
      } catch (_) {}

      const bucket = {};
      const touch = k => (bucket[k] = bucket[k] || {
        key: k, bookings: 0, cancelled: 0, revenue: 0, deposits: 0, clients: {},
      });
      for (const b of all) {
        if (!b.date) continue;
        const mo = String(b.date).slice(0, 7);
        const yr = String(b.date).slice(0, 4);
        for (const k of [mo, yr]) {
          const t = touch(k);
          t.bookings++;
          if (!isLive(b)) { t.cancelled++; continue; }
          t.revenue += b.total_cents || 0;
          if (Number(b.deposit_paid)) t.deposits += b.deposit_cents || 0;
          if (b.guest_name) t.clients[b.guest_name] = (t.clients[b.guest_name] || 0) + 1;
        }
      }

      // memberships counted by when they started, so a month shows what it won
      const memberBucket = {};
      for (const m of members) {
        const d = String(m.membership_started_at || '').slice(0, 10);
        if (!d) continue;
        for (const k of [d.slice(0, 7), d.slice(0, 4)]) {
          memberBucket[k] = memberBucket[k] || { joined: 0, byTier: {} };
          memberBucket[k].joined++;
          memberBucket[k].byTier[m.tier] = (memberBucket[k].byTier[m.tier] || 0) + 1;
        }
      }

      // who served whom, from the team calendar
      const nameById = {};
      for (const t of team) nameById[t.id] = t.name;
      const byArtist = {};
      for (const a of teamAppts) {
        if (String(a.status || '').toLowerCase() === 'cancelled') continue;
        const who = nameById[a.team_member_id] || 'Unassigned';
        byArtist[who] = byArtist[who] || { artist: who, appointments: 0, clients: {} };
        byArtist[who].appointments++;
        if (a.client_name) byArtist[who].clients[a.client_name] = true;
      }

      const rows = Object.values(bucket).map(t => ({
        key: t.key,
        kind: t.key.length === 4 ? 'year' : 'month',
        bookings: t.bookings,
        cancelled: t.cancelled,
        revenue_cents: t.revenue,
        deposits_cents: t.deposits,
        unique_clients: Object.keys(t.clients).length,
        repeat_clients: Object.values(t.clients).filter(n => n > 1).length,
        members_joined: (memberBucket[t.key] || {}).joined || 0,
        members_by_tier: (memberBucket[t.key] || {}).byTier || {},
      })).sort((a, b) => String(b.key).localeCompare(String(a.key)));

      return res.json({
        rows,
        artists: Object.values(byArtist)
          .map(a => ({ artist: a.artist, appointments: a.appointments, clients: Object.keys(a.clients).length }))
          .sort((a, b) => b.appointments - a.appointments),
        inventory_items: inventory.length,
        inventory_units: inventory.reduce((s, i) => s + (Number(i.qty) || 0), 0),
        total_members: members.length,
      });
    }

    if (section === 'services') return res.json({ services: store.services, addons: store.addons });
    if (section === 'inventory') return res.json({ inventory: store.inventory });
    if (section === 'giftcards') return res.json({ giftCards: store.giftCards });
    if (section === 'goals') {
      let members = [];
      try { members = await query('SELECT tier FROM members WHERE COALESCE(demo,0)=0'); } catch (_) {}
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
