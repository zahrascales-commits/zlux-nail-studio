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
          source: 'online',
        }));
      } catch (_) { return []; }
    }

    /* The ones she writes in herself. They live in a different table with
       different column names, which is the only reason they were ever
       treated differently — a client booked at the desk is not a lesser
       booking than one made on the website. */
    async function studioBookings() {
      try {
        const rows = await query(
          `SELECT id, client_name, client_email, service, date, time, status,
                  deposit_cents, deposit_paid, paid_cents, tip_cents, team_member_id, created_at
             FROM team_appointments ORDER BY date DESC, time DESC`);
        return rows.map(r => {
          const deposit = Number(r.deposit_cents) || 0;
          const paid = Number(r.paid_cents) || 0;
          /* No price is stored against a booking made by hand, so the menu
             is what it is worth. Without this every one of them counted as
             nothing and the takings read low. */
          let total = 0;
          try {
            const { services } = require('./_store');
            const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
            const want = norm(r.service);
            const hit = services.find(s => norm(s.name) === want)
              || services.find(s => want && (want.includes(norm(s.name)) || norm(s.name).includes(want)));
            if (hit) total = Number(hit.price_cents) || 0;
          } catch (_) {}
          if (!total) total = deposit ? deposit * 2 : 0;

          return {
            id: 't' + r.id,
            guest_name: r.client_name,
            guest_email: r.client_email,
            service_name: r.service,
            service: r.service,
            addons: '',
            date: r.date,
            appointment_date: r.date,
            time_slot: r.time,
            appointment_time: r.time,
            // The two tables spell this differently; the dashboard only
            // knows the shouted version.
            status: String(r.status || 'scheduled').toUpperCase(),
            total_cents: total,
            deposit_cents: deposit,
            deposit_paid: Number(r.deposit_paid) || 0,
            paid_cents: paid,
            tip_cents: Number(r.tip_cents) || 0,
            staff_id: r.team_member_id,
            member_id: null,
            created_at: r.created_at,
            source: 'studio',
          };
        });
      } catch (_) { return []; }
    }

    /* Both books, as one. An online booking is mirrored into the studio's
       own, so the same visit can appear in each — counted twice it would
       double the day's takings. */
    async function everyBooking() {
      const [online, studio] = await Promise.all([allBookings(), studioBookings()]);
      const seen = new Set();
      const out = [];
      for (const b of online.concat(studio)) {
        const key = String(b.guest_name || '').trim().toLowerCase()
          + '|' + String(b.appointment_date || '')
          + '|' + String(b.appointment_time || '').slice(0, 5);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(b);
      }
      return out.sort((a, b) =>
        String(b.appointment_date + b.appointment_time).localeCompare(
          String(a.appointment_date + a.appointment_time)));
    }
    // Cancelled bookings still belong in the history, but never in revenue.
    /* ── WHAT COUNTS AS MONEY ────────────────────────────────────────
       One definition, used by every figure on every screen.

       A booking counts once a deposit has actually been taken. A booking
       with no deposit is a request, not income — eighteen of the nineteen
       rows in this studio's books had never been paid for, and they were
       all being reported as revenue.

       Membership-covered visits are confirmed too: the member already paid
       through their subscription, so a zero total with a member attached is
       fully paid, not unpaid.

       Earned means it also happened. Money for work not yet done belongs in
       "upcoming", never in this week's takings.                          */
    const upper = s => String(s || '').toUpperCase();
    const isCancelled = b => upper(b.status) === 'CANCELLED';
    const isNoShow = b => upper(b.status) === 'NO_SHOW' || upper(b.status) === 'NOSHOW';
    const isConfirmed = b => !isCancelled(b) &&
      (Number(b.deposit_paid) === 1 || (b.member_id && (Number(b.total_cents) || 0) === 0));
    const isUnconfirmed = b => !isCancelled(b) && !isConfirmed(b);

    // Local date, not UTC. "Today" flipping at 5pm in California would move
    // bookings between earned and upcoming a day early.
    const pad = n => String(n).padStart(2, '0');
    const localDay = (d) => {
      const x = d || new Date();
      return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
    };
    const TODAY = localDay();
    const daysAgo = n => localDay(new Date(Date.now() - n * 86400000));

    const isEarned = b => isConfirmed(b) && String(b.date) <= TODAY && !isNoShow(b);
    const isUpcoming = b => isConfirmed(b) && String(b.date) > TODAY;
    const cents = list => list.reduce((t, b) => t + (Number(b.total_cents) || 0), 0);

    // Windows are closed at both ends. Only having a lower bound is what let
    // a September appointment be counted as this week's revenue in August.
    const between = (list, from, to) => list.filter(b => String(b.date) >= from && String(b.date) <= to);

    // Everything a client-facing figure needs to be clickable: who it was,
    // how to reach them, what they had, what they paid.
    let clientBook = {};
    try {
      const tdb = require('./_team-db');
      await tdb.ensureTables();
      for (const c of await tdb.query('SELECT name, email, phone, visits, notes FROM clients')) {
        if (c.name) clientBook[String(c.name).toLowerCase()] = c;
        if (c.email) clientBook[String(c.email).toLowerCase()] = c;
      }
    } catch (_) {}

    let artistByKey = {};
    try {
      const tdb = require('./_team-db');
      const rows = await tdb.query(
        `SELECT a.date, a.time, a.client_name, a.client_phone, m.name AS artist
           FROM team_appointments a LEFT JOIN team_members m ON m.id = a.team_member_id`);
      for (const r of rows) artistByKey[r.date + ' ' + r.time] = r;
    } catch (_) {}

    const detail = (b) => {
      const link = artistByKey[b.date + ' ' + b.time_slot] || {};
      const name = b.guest_name || link.client_name || '';
      const c = clientBook[String(name).toLowerCase()] || clientBook[String(b.guest_email || '').toLowerCase()] || {};
      let addons = [];
      try { addons = JSON.parse(b.addons || '[]'); } catch (_) {}
      return {
        id: b.id,
        date: b.date,
        time: b.time_slot,
        client: name || 'Guest',
        email: b.guest_email || c.email || '',
        phone: c.phone || link.client_phone || '',
        member_id: b.member_id || '',
        service: b.service_name || '',
        addons,
        artist: link.artist || '',
        total_cents: Number(b.total_cents) || 0,
        deposit_cents: Number(b.deposit_cents) || 0,
        deposit_paid: Number(b.deposit_paid) === 1,
        status: b.status || '',
        state: isCancelled(b) ? 'cancelled'
             : (isUnconfirmed(b) ? 'unconfirmed'
             : (isNoShow(b) ? 'no_show'
             : (String(b.date) > TODAY ? 'upcoming' : 'earned'))),
      };
    };

    const bucket = (list) => ({
      count: list.length,
      cents: cents(list),
      bookings: list.map(detail),
    });

    if (section === 'overview') {
      let members = [];
      // What each member actually pays, not what their tier lists at. A
      // member on the founding rate paying $100 was counting as $299 here.
      try {
        members = await query(
          'SELECT tier, paid_cents, billing_period FROM members WHERE COALESCE(demo,0)=0');
      } catch (_) {
        try { members = await query('SELECT tier FROM members WHERE COALESCE(demo,0)=0'); } catch (_) {}
      }
      const mp = require('./_member-price');
      const mrr = members.reduce((s2, mm) => s2 + mp.monthlyValue(mm).cents, 0);
      const byTier = { SIGNATURE: 0, LUXE: 0, BLACK_CARD: 0 };
      members.forEach(mm => { if (byTier[mm.tier] !== undefined) byTier[mm.tier]++; });

      const all = await everyBooking();
      const todayList = all.filter(b => b.date === TODAY);
      const upcoming = all.filter(isUpcoming)
        .sort((a, b) => String(a.date).localeCompare(String(b.date))
          || String(a.time_slot).localeCompare(String(b.time_slot)));
      const waiting = all.filter(isUnconfirmed).filter(b => String(b.date) >= TODAY);

      return res.json({
        today: TODAY,
        mrr, totalMembers: members.length, byTier,
        todayBookings: todayList.length,
        // Only money already earned. A booking with no deposit is a request.
        todayRevenue: cents(todayList.filter(isEarned)),
        weekRevenue: cents(between(all.filter(isEarned), daysAgo(7), TODAY)),
        monthRevenue: cents(between(all.filter(isEarned), daysAgo(30), TODAY)),
        upcomingValue: cents(upcoming),
        totalBookings: all.length,
        // Carries full client detail so every row on the screen can be opened.
        upcomingBookings: upcoming.slice(0, 8).map(detail),
        recentBookings: all.filter(isEarned).slice(0, 6).map(detail),
        // Requests with no deposit — visible, never counted.
        awaitingDeposit: waiting.length,
        awaitingDepositValue: cents(waiting),
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
      const all = await everyBooking();
      const dateFilter = req.query.date;
      return res.json({ bookings: dateFilter ? all.filter(b => b.date === dateFilter) : all });
    }

    /* ── REPORTS ──────────────────────────────────────────────────────
       Every number carries the bookings behind it, so any figure on the
       screen can be opened and checked rather than trusted.            */
    if (section === 'reports') {
      const all = await everyBooking();
      const earned = all.filter(isEarned);
      const week = between(earned, daysAgo(7), TODAY);
      const month = between(earned, daysAgo(30), TODAY);
      const year = between(earned, TODAY.slice(0, 4) + '-01-01', TODAY);

      const upcoming = all.filter(isUpcoming).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const unconfirmed = all.filter(isUnconfirmed).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const cancelled = all.filter(isCancelled);

      const svcCount = {};
      for (const b of earned) svcCount[b.service_name] = (svcCount[b.service_name] || 0) + 1;

      return res.json({
        today: TODAY,
        // What the studio has actually been paid for work already done.
        week: bucket(week),
        month: bucket(month),
        year: bucket(year),
        all_time: bucket(earned),
        // Paid for, not yet delivered. Real money, but not takings.
        upcoming: bucket(upcoming),
        // No deposit ever taken. Never counted as income anywhere.
        unconfirmed: bucket(unconfirmed),
        cancelled: bucket(cancelled),
        servicePopularity: Object.entries(svcCount).sort((a, b) => b[1] - a[1]).slice(0, 8),
        funnelByStep: funnelSummary(),
        topQuestions: topQuestions(20),
        // Kept so older callers do not break, but now built on earned money.
        weeklyBookings: week.length,
        weeklyRevenue: cents(week),
        monthlyBookings: month.length,
        monthlyRevenue: cents(month),
        totalBookings: all.length,
      });
    }

    /* ── RECORDS: the permanent books, drillable ─────────────────────
       Every count on this screen carries the actual bookings and the
       actual people behind it. A figure nobody can open is a figure
       nobody can check.                                                */
    if (section === 'records') {
      const all = await everyBooking();
      const earned = all.filter(isEarned);

      let members = [];
      try {
        members = await query('SELECT member_id, full_name, tier, membership_started_at, email, phone, date_of_birth FROM members WHERE COALESCE(demo,0)=0');
      } catch (_) {}

      const memberBucket = {};
      for (const mm of members) {
        const d = String(mm.membership_started_at || '').slice(0, 10);
        if (!d) continue;
        for (const k of [d.slice(0, 7), d.slice(0, 4)]) {
          memberBucket[k] = memberBucket[k] || { joined: 0, byTier: {}, people: [] };
          memberBucket[k].joined++;
          memberBucket[k].byTier[mm.tier] = (memberBucket[k].byTier[mm.tier] || 0) + 1;
          memberBucket[k].people.push({ member_id: mm.member_id, name: mm.full_name, tier: mm.tier, email: mm.email, phone: mm.phone });
        }
      }

      // Group earned bookings by month and by year.
      const groups = {};
      const touch = k => (groups[k] = groups[k] || { key: k, rows: [], cancelled: 0 });
      for (const b of all) {
        if (!b.date) continue;
        const mo = String(b.date).slice(0, 7), yr = String(b.date).slice(0, 4);
        for (const k of [mo, yr]) {
          const t = touch(k);
          if (isCancelled(b)) { t.cancelled++; continue; }
          if (isEarned(b)) t.rows.push(b);
        }
      }

      const rows = Object.values(groups).map(g => {
        const list = g.rows.map(detail);
        const byClient = {};
        for (const d of list) {
          const key = (d.client || 'Guest').toLowerCase();
          byClient[key] = byClient[key] || { name: d.client, email: d.email, phone: d.phone, visits: 0, spent_cents: 0, services: [] };
          byClient[key].visits++;
          byClient[key].spent_cents += d.total_cents;
          if (d.service) byClient[key].services.push(d.service);
        }
        const clients = Object.values(byClient).sort((a, b) => b.visits - a.visits);
        return {
          key: g.key,
          kind: g.key.length === 4 ? 'year' : 'month',
          bookings: list.length,
          cancelled: g.cancelled,
          revenue_cents: list.reduce((s2, d) => s2 + d.total_cents, 0),
          deposits_cents: list.reduce((s2, d) => s2 + (d.deposit_paid ? d.deposit_cents : 0), 0),
          unique_clients: clients.length,
          repeat_clients: clients.filter(c => c.visits > 1).length,
          members_joined: (memberBucket[g.key] || {}).joined || 0,
          members_by_tier: (memberBucket[g.key] || {}).byTier || {},
          // Everything needed to open the number up.
          detail: {
            bookings: list,
            clients,
            repeat: clients.filter(c => c.visits > 1),
            members: (memberBucket[g.key] || {}).people || [],
          },
        };
      }).sort((a, b) => String(b.key).localeCompare(String(a.key)));

      // Who served whom — same rules, so it agrees with everything above.
      const byArtist = {};
      for (const d of earned.map(detail)) {
        const who = d.artist || 'Unassigned';
        byArtist[who] = byArtist[who] || { artist: who, appointments: 0, revenue_cents: 0, clients: {}, bookings: [] };
        byArtist[who].appointments++;
        byArtist[who].revenue_cents += d.total_cents;
        if (d.client) byArtist[who].clients[d.client] = true;
        byArtist[who].bookings.push(d);
      }

      let inventory = [];
      try {
        const tdb = require('./_team-db');
        inventory = await tdb.query('SELECT name, qty, unit, created_ts FROM studio_inventory');
      } catch (_) {}

      return res.json({
        today: TODAY,
        rows,
        artists: Object.values(byArtist)
          .map(a => ({
            artist: a.artist,
            appointments: a.appointments,
            revenue_cents: a.revenue_cents,
            clients: Object.keys(a.clients).length,
            detail: { bookings: a.bookings, clients: Object.keys(a.clients) },
          }))
          .sort((a, b) => b.appointments - a.appointments),
        unconfirmed: bucket(all.filter(isUnconfirmed)),
        inventory_items: inventory.length,
        inventory_units: inventory.reduce((s2, i) => s2 + (Number(i.qty) || 0), 0),
        total_members: members.length,
      });
    }

    if (section === 'services') return res.json({ services: store.services, addons: store.addons });
    if (section === 'inventory') return res.json({ inventory: store.inventory });
    if (section === 'giftcards') return res.json({ giftCards: store.giftCards });
    if (section === 'goals') {
      let members = [];
      try {
        members = await query(
          'SELECT tier, paid_cents, billing_period FROM members WHERE COALESCE(demo,0)=0');
      } catch (_) {
        try { members = await query('SELECT tier FROM members WHERE COALESCE(demo,0)=0'); } catch (_) {}
      }
      const byTier = { SIGNATURE: 0, LUXE: 0, BLACK_CARD: 0 };
      members.forEach(m => { if (byTier[m.tier] !== undefined) byTier[m.tier]++; });
      const mp2 = require('./_member-price');
      const mrr = members.reduce((s, m) => s + mp2.monthlyValue(m).cents, 0);
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
