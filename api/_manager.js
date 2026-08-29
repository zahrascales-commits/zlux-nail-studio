// Owner-side (Zahra) API for the Studio Manager page.
// Auth: X-CEO-Password header (same password as the CEO dashboard).
const { query, queryOne, execute, ensureTables, token, uniquePin } = require('./_team-db');
const { notifyNewAppointment, sendEmail, sendSMS, providerStatus, clearKeyCache } = require('./_notify');
const { upsertClient } = require('./_clients');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

async function membersWithSkills() {
  const members = await query('SELECT id, name, role, pin, color, active, phone, email, restricted, bio, show_on_site, title, photo, trainee FROM team_members ORDER BY id');
  const skillRows = await query('SELECT team_member_id, service_name FROM worker_skills');
  const skillsByMember = {};
  for (const row of skillRows) {
    (skillsByMember[row.team_member_id] = skillsByMember[row.team_member_id] || []).push(row.service_name);
  }
  for (const m of members) m.skills = skillsByMember[m.id] || [];
  return members;
}

module.exports = async function (req, res) {
  const method = req.method.toUpperCase();
  const action = req.query.action || (req.body && req.body.action);

  // ── Auth ──
  const pass = req.headers['x-ceo-password'];
  if (pass !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  try {
    await ensureTables();

    // ── BOOTSTRAP: everything the dashboard needs on load ──
    if (method === 'GET' && action === 'bootstrap') {
      const members = await membersWithSkills();
      const appts = await query(`SELECT a.*, m.name AS member_name, m.color AS member_color
        FROM team_appointments a LEFT JOIN team_members m ON m.id = a.team_member_id
        ORDER BY a.date, a.time`);
      const providers = await providerStatus();
      return res.json({ members, appointments: appts, providers });
    }

    // ── CONNECT PROVIDERS (paste keys in Settings tab; stored write-only) ──
    if (method === 'POST' && action === 'save_keys') {
      const { twilio_sid, twilio_token, twilio_from, resend_key, stripe_secret, stripe_publishable, notify_from_email } = req.body || {};
      // The address clients see mail come from. Until this is set, sends fall
      // back to Resend's onboarding@resend.dev sandbox, which only ever
      // reaches the account owner — so client mail silently goes nowhere.
      const pairs = { twilio_sid, twilio_token, twilio_from, resend_key, stripe_secret, stripe_publishable, notify_from_email };
      for (const [k, v] of Object.entries(pairs)) {
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          await execute(
            'INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            [k, String(v).trim()]);
        }
      }
      clearKeyCache();
      try { require('./_pay').clearStripeKeyCache(); } catch (_) {}
      const providers = await providerStatus();
      return res.json({ ok: true, providers });
    }

    // Is Stripe connected? (pasted keys first, then env) — for the Settings card
    if (method === 'GET' && action === 'stripe_status') {
      const rows = await query("SELECT key, value FROM site_settings WHERE key IN ('stripe_secret','stripe_publishable')");
      const db = {}; for (const r of rows) db[r.key] = r.value;
      const secret = db.stripe_secret || process.env.STRIPE_SECRET_KEY || '';
      const pub = db.stripe_publishable || process.env.STRIPE_PUBLISHABLE_KEY || '';
      const enabled = !!(secret && pub);
      const live = /_live_/.test(pub) || /_live_/.test(secret);
      return res.json({ enabled, mode: enabled ? (live ? 'live' : 'test') : 'off' });
    }

    // ── STRIPE HEALTH: can money actually reach her bank? ──
    // Asks Stripe directly rather than guessing from whether keys exist. The
    // secret never leaves the server; only status flags and a masked last4
    // come back. "Charges enabled" and "payouts enabled" are separate switches
    // — an account can take cards for weeks while the money silently piles up
    // undeposited because identity or bank details were never finished.
    if (method === 'GET' && action === 'stripe_health') {
      const rows = await query("SELECT key, value FROM site_settings WHERE key IN ('stripe_secret','stripe_publishable')");
      const db = {}; for (const r of rows) db[r.key] = r.value;
      const secret = db.stripe_secret || process.env.STRIPE_SECRET_KEY || '';
      if (!secret) return res.json({ ok: false, reason: 'no_key' });

      const sget = async (p) => {
        const r = await fetch('https://api.stripe.com/v1/' + p, {
          headers: { Authorization: 'Bearer ' + secret },
        });
        return { status: r.status, body: await r.json() };
      };

      const acct = await sget('account');
      if (acct.status !== 200) {
        return res.json({ ok: false, reason: 'bad_key', detail: (acct.body.error || {}).message || '' });
      }
      const A = acct.body;
      const reqs = A.requirements || {};

      // Track whether we could actually read the bank list. An empty array
      // because the call failed means something very different from an empty
      // array because no bank is attached, and confusing the two would tell
      // her payouts are broken when they aren't (or worse, the reverse).
      let bank = [], bank_checked = false, bank_error = '';
      try {
        const ext = await sget('accounts/' + A.id + '/external_accounts?object=bank_account&limit=5');
        if (ext.status === 200) {
          bank_checked = true;
          bank = (ext.body.data || []).map(b => ({
            type: b.object, name: b.bank_name || b.brand || '', last4: b.last4 || '',
            status: b.status || '', default: !!b.default_for_currency,
          }));
        } else {
          bank_error = (ext.body.error || {}).message || ('HTTP ' + ext.status);
        }
      } catch (e) { bank_error = e.message; }

      let balance = null, payouts = [];
      try {
        const b = await sget('balance');
        if (b.status === 200) {
          const sum = a => (a || []).reduce((s, x) => s + x.amount, 0) / 100;
          balance = { available: sum(b.body.available), pending: sum(b.body.pending) };
        }
      } catch (_) {}
      try {
        const p = await sget('payouts?limit=5');
        if (p.status === 200) {
          payouts = (p.body.data || []).map(x => ({
            date: new Date(x.created * 1000).toISOString().slice(0, 10),
            amount: x.amount / 100, status: x.status, failure: x.failure_message || '',
          }));
        }
      } catch (_) {}

      return res.json({
        ok: true,
        livemode: !!A.charges_enabled && /_live_/.test(secret),
        mode: /_live_/.test(secret) ? 'live' : 'test',
        account_id: A.id,
        country: A.country,
        currency: A.default_currency,
        business_name: (A.business_profile || {}).name || '',
        charges_enabled: !!A.charges_enabled,
        payouts_enabled: !!A.payouts_enabled,
        details_submitted: !!A.details_submitted,
        disabled_reason: reqs.disabled_reason || null,
        currently_due: reqs.currently_due || [],
        past_due: reqs.past_due || [],
        eventually_due: reqs.eventually_due || [],
        payout_schedule: ((A.settings || {}).payouts || {}).schedule || null,
        statement_descriptor: ((A.settings || {}).payments || {}).statement_descriptor || '',
        bank, bank_checked, bank_error, balance, payouts,
      });
    }

    // ── EMAIL SELF-REPAIR: register the sender with SendGrid so 403s stop ──
    // SendGrid rejects mail from unverified senders (the silent bug that ate
    // every email). This asks SendGrid to email a verification link to the
    // chosen address; after Zahra clicks it, that address can send.
    if (method === 'POST' && action === 'verify_sender') {
      const from = String((req.body || {}).from_email || '').trim().toLowerCase();
      if (!/@/.test(from)) return res.status(400).json({ error: 'Valid email required' });
      const sgKey = process.env.SENDGRID_API_KEY;
      if (!sgKey) return res.status(400).json({ error: 'SendGrid key not configured' });
      const r = await fetch('https://api.sendgrid.com/v3/verified_senders', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sgKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname: 'ZOLA Studio', from_email: from, from_name: 'ZOLA Nail Studio',
          reply_to: from, reply_to_name: 'ZOLA Nail Studio',
          address: 'Porterville', city: 'Porterville', state: 'CA', zip: '93257', country: 'USA',
        }),
      });
      const data = await r.json().catch(() => ({}));
      // remember the sender either way — sends work as soon as she clicks the link
      await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        ['notify_from_email', from]);
      clearKeyCache();
      if (r.ok || r.status === 201) return res.json({ ok: true, status: 'verification_email_sent', to: from });
      // already verified or pending is fine too
      const msg = JSON.stringify(data).slice(0, 300);
      if (/already/i.test(msg)) return res.json({ ok: true, status: 'already_requested', detail: msg });
      return res.status(400).json({ error: msg });
    }

    // ── SET UP $1.58 TEST MEMBERSHIP PRICE IN STRIPE (one-time) ──
    if (method === 'POST' && action === 'setup_test_tier') {
      const sk = await require('./_pay').getStripeSecret();
      if (!sk) return res.status(400).json({ error: 'Stripe not configured' });
      const existing = await queryOne("SELECT value FROM site_settings WHERE key='stripe_price_test'");
      if (existing && existing.value) return res.json({ ok: true, price_id: existing.value, existed: true });
      const call = async (path, params) => {
        const r = await fetch('https://api.stripe.com/v1/' + path, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error && d.error.message || ('stripe ' + r.status));
        return d;
      };
      const product = await call('products', { name: 'ZOLA Test Membership (owner testing)' });
      const price = await call('prices', {
        product: product.id, currency: 'usd', unit_amount: '158', 'recurring[interval]': 'month',
      });
      await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        ['stripe_price_test', price.id]);
      return res.json({ ok: true, price_id: price.id });
    }

    // ── SET UP THE THREE MEMBERSHIP PRICES ON THE CONNECTED STRIPE ACCOUNT ──
    // Idempotent: creates a monthly recurring Price per tier only if one isn't
    // already stored. Run once after connecting a Stripe account so membership
    // subscriptions charge correctly ($99 / $199 / $299 a month).
    if (method === 'POST' && action === 'setup_membership_prices') {
      const sk = await require('./_pay').getStripeSecret();
      if (!sk) return res.status(400).json({ error: 'Stripe not configured — connect your keys first.' });
      const call = async (path, params) => {
        const r = await fetch('https://api.stripe.com/v1/' + path, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error && d.error.message || ('stripe ' + r.status));
        return d;
      };
      const tiers = [
        { tier: 'SIGNATURE', key: 'stripe_price_signature', name: 'ZOLA Signature Club', cents: 9900 },
        { tier: 'LUXE', key: 'stripe_price_luxe', name: 'ZOLA Luxe Club', cents: 19900 },
        { tier: 'BLACK_CARD', key: 'stripe_price_black_card', name: 'ZOLA Black Card', cents: 29900 },
      ];
      const out = {};
      for (const t of tiers) {
        const existing = await queryOne('SELECT value FROM site_settings WHERE key=?', [t.key]);
        // Verify the stored price still exists on the CURRENT account; if not, recreate
        let valid = false;
        if (existing && existing.value) {
          try {
            const chk = await fetch('https://api.stripe.com/v1/prices/' + existing.value, { headers: { Authorization: 'Bearer ' + sk } });
            valid = chk.ok;
          } catch (_) {}
        }
        if (valid) { out[t.tier] = { price_id: existing.value, existed: true }; continue; }
        const product = await call('products', { name: t.name });
        const price = await call('prices', { product: product.id, currency: 'usd', unit_amount: String(t.cents), 'recurring[interval]': 'month' });
        await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [t.key, price.id]);
        out[t.tier] = { price_id: price.id, created: true };
      }
      return res.json({ ok: true, prices: out });
    }

    // ── TEST DELIVERY (send a real test to Zahra) ──
    if (method === 'POST' && action === 'test_notify') {
      const { phone, email } = req.body || {};
      clearKeyCache();
      const out = {};
      if (phone) out.sms = await sendSMS(phone, 'ZOLA test ✦ Your texting is connected and working! — sent from your Studio Manager');
      if (email) out.email = await sendEmail(email, 'ZOLA test ✦ Email is connected',
        '<p>Your email delivery is connected and working ✦</p><p>— sent from your Studio Manager</p>');
      return res.json({ ok: true, ...out });
    }

    // ── MEMBERS ──
    if (method === 'GET' && action === 'members') {
      return res.json({ members: await membersWithSkills() });
    }

    // ── WORKER SKILLS (which services this artist is allowed to book) ──
    if (method === 'PUT' && action === 'worker_skills') {
      const { id, restricted, services } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await execute('UPDATE team_members SET restricted=? WHERE id=?', [restricted ? 1 : 0, Number(id)]);
      await execute('DELETE FROM worker_skills WHERE team_member_id=?', [Number(id)]);
      for (const name of (Array.isArray(services) ? services : [])) {
        await execute('INSERT OR IGNORE INTO worker_skills (team_member_id, service_name) VALUES (?,?)', [Number(id), name]);
      }
      return res.json({ ok: true });
    }

    // ── STRIPE WEBHOOKS ──
    // Stripe retries a failing endpoint for nine days then gives up, and a
    // dead subscription webhook means renewals stop being recorded. The two
    // things that break it are an endpoint still pointing at an old domain,
    // and a missing signing secret (every event then fails verification and
    // returns 400, which Stripe counts as a failure).
    async function stripeKey() {
      const rows = await query("SELECT key, value FROM site_settings WHERE key='stripe_secret'");
      return (rows[0] && rows[0].value) || process.env.STRIPE_SECRET_KEY || '';
    }
    async function sapi(path, opts = {}) {
      const secret = await stripeKey();
      const r = await fetch('https://api.stripe.com/v1/' + path, {
        method: opts.method || 'GET',
        headers: {
          Authorization: 'Bearer ' + secret,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: opts.body,
      });
      return { status: r.status, body: await r.json() };
    }

    if (method === 'GET' && action === 'webhook_status') {
      const secretRow = await queryOne("SELECT value FROM site_settings WHERE key='stripe_webhook_secret'").catch(() => null);
      const haveSigningSecret = !!((secretRow && secretRow.value) || process.env.STRIPE_WEBHOOK_SECRET);
      const r = await sapi('webhook_endpoints?limit=20');
      if (r.status !== 200) {
        return res.json({ ok: false, error: (r.body.error || {}).message || 'Could not read webhooks', haveSigningSecret });
      }
      const want = (process.env.PUBLIC_SITE_URL || 'https://zolanailstudio.com') + '/api/stripe-webhook';
      return res.json({
        ok: true, want, haveSigningSecret,
        endpoints: (r.body.data || []).map(e => ({
          id: e.id, url: e.url, status: e.status, livemode: e.livemode,
          events: (e.enabled_events || []).length,
          correct: e.url === want,
        })),
      });
    }

    // Point Stripe at the live domain and store the signing secret, so events
    // verify instead of 400-ing. Old endpoints are disabled rather than
    // deleted — if one turns out to matter it can be switched back on.
    if (method === 'POST' && action === 'webhook_fix') {
      const want = (process.env.PUBLIC_SITE_URL || 'https://zolanailstudio.com') + '/api/stripe-webhook';
      const EVENTS = [
        'invoice.payment_succeeded', 'invoice.payment_failed',
        'customer.subscription.created', 'customer.subscription.updated',
        'customer.subscription.deleted', 'checkout.session.completed',
        'payment_intent.succeeded', 'payment_intent.payment_failed',
      ];

      const list = await sapi('webhook_endpoints?limit=20');
      if (list.status !== 200) {
        return res.status(400).json({ error: (list.body.error || {}).message || 'Could not read webhooks' });
      }
      const existing = (list.body.data || []);
      const already = existing.find(e => e.url === want);

      const disabled = [];
      for (const e of existing) {
        if (e.url === want) continue;
        const d = await sapi('webhook_endpoints/' + e.id, {
          method: 'POST', body: new URLSearchParams({ disabled: 'true' }).toString(),
        });
        disabled.push({ url: e.url, ok: d.status === 200 });
      }

      let created = null, secret = null;
      if (already) {
        // make sure it is enabled and listening for what we need
        const p = new URLSearchParams({ disabled: 'false' });
        EVENTS.forEach(ev => p.append('enabled_events[]', ev));
        await sapi('webhook_endpoints/' + already.id, { method: 'POST', body: p.toString() });
        created = { id: already.id, url: already.url, reused: true };
      } else {
        const p = new URLSearchParams({ url: want, description: 'ZOLA site' });
        EVENTS.forEach(ev => p.append('enabled_events[]', ev));
        const c = await sapi('webhook_endpoints', { method: 'POST', body: p.toString() });
        if (c.status !== 200) {
          return res.status(400).json({ error: (c.body.error || {}).message || 'Could not create webhook' });
        }
        created = { id: c.body.id, url: c.body.url, reused: false };
        secret = c.body.secret || null; // only returned at creation
      }

      if (secret) {
        await execute(
          "INSERT INTO site_settings (key, value) VALUES ('stripe_webhook_secret', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [secret]);
      }
      const secretRow = await queryOne("SELECT value FROM site_settings WHERE key='stripe_webhook_secret'").catch(() => null);
      return res.json({
        ok: true, created, disabled,
        haveSigningSecret: !!((secretRow && secretRow.value) || process.env.STRIPE_WEBHOOK_SECRET),
        note: secret ? 'signing secret stored' : (already ? 'reused existing endpoint — its secret was set when it was created' : ''),
      });
    }

    // ── COVERAGE CHECK: which services can actually be booked this month? ──
    // The commonest confusion is "why is the calendar blocked?" when the real
    // answer is that the only artist rostered that month is not ticked for
    // that service. This answers it per service instead of making her guess.
    if (method === 'GET' && action === 'coverage_check') {
      const from = req.query.from, to = req.query.to;
      if (!from || !to) return res.status(400).json({ error: 'from and to required' });

      const store = require('./_store');
      const services = (store.services || []).filter(s => !s.hidden).map(s => s.name);
      const { shiftCoverage } = require('./_shifts');

      const out = [];
      for (const name of services) {
        const { configured, byDate } = await shiftCoverage(from, to, [name]);
        const dates = Object.keys(byDate);
        const who = new Set();
        for (const d of dates) for (const a of byDate[d]) who.add(a.name);
        out.push({ service: name, configured, days: dates.length, artists: Array.from(who) });
      }

      // who COULD do each service, whether or not they are rostered — so the
      // fix is obvious: tick the service, or give that artist some days.
      const members = await query('SELECT id, name, restricted FROM team_members WHERE active=1');
      const skillRows = await query('SELECT team_member_id, service_name FROM worker_skills');
      const skills = {};
      for (const r of skillRows) (skills[r.team_member_id] = skills[r.team_member_id] || []).push(r.service_name);
      const capable = {};
      for (const name of services) {
        capable[name] = members
          .filter(mm => !Number(mm.restricted) || (skills[mm.id] || []).includes(name))
          .map(mm => mm.name);
      }
      return res.json({ coverage: out, capable });
    }

    // ── SHOWCASE SETTINGS (the Preview numbers on the Sales screen) ──
    // Stored server-side so the figures are the same on her phone and laptop
    // and survive a reload. Defaults to a single Signature member — a brand
    // new studio showing hundreds of members is the fastest way to look fake.
    if (method === 'GET' && action === 'showcase') {
      const row = await queryOne("SELECT value FROM site_settings WHERE key='showcase_cfg'").catch(() => null);
      let cfg = { SIGNATURE: 1, LUXE: 0, BLACK_CARD: 0, growth: 1 };
      if (row && row.value) { try { cfg = Object.assign(cfg, JSON.parse(row.value)); } catch (_) {} }
      return res.json({ cfg });
    }
    if (method === 'PUT' && action === 'showcase') {
      const b = req.body || {};
      const n = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
      const cfg = {
        SIGNATURE: n(b.SIGNATURE, 400),
        LUXE: n(b.LUXE, 400),
        BLACK_CARD: n(b.BLACK_CARD, 200),
        growth: n(b.growth, 3),
      };
      await execute(
        "INSERT INTO site_settings (key, value) VALUES ('showcase_cfg', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [JSON.stringify(cfg)]
      );
      return res.json({ ok: true, cfg });
    }

    // ── TECH SHIFTS (which dates + hours each artist actually works) ──
    // Read a whole month at once so the scheduling calendar paints in one call.
    /* ── DISPATCH: who a booking went out to, and who took it ──────────
       Her view of the race. Anything still open she can hand to whoever
       she wants without waiting for the timer.                          */
    /* ── A membership to walk through, without paying for one ──────
       Real row, real member ID, real perks — the only difference is
       demo=1, which keeps it out of every revenue figure. Fixed ID so
       running this twice refreshes the same account instead of
       littering the members list. */
    if (method === 'POST' && action === 'demo_member') {
      const tier = String((req.body || {}).tier || 'BLACK_CARD').toUpperCase();
      if (!['SIGNATURE', 'LUXE', 'BLACK_CARD'].includes(tier)) {
        return res.status(400).json({ error: 'Unknown tier' });
      }
      const db = require('./_db');
      try { await db.execute('ALTER TABLE members ADD COLUMN demo INTEGER DEFAULT 0'); } catch (_) {}

      const memberId = 'ZOLA-DEMO';
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
      const iso = d => d.toISOString().slice(0, 10);
      const crypto = require('crypto');

      const existing = await db.queryOne('SELECT member_id FROM members WHERE member_id = ?', [memberId]);
      if (existing) {
        await db.execute(
          "UPDATE members SET tier=?, demo=1, flagged=0, membership_started_at=?, next_billing_at=? WHERE member_id=?",
          [tier, iso(now), iso(next), memberId]);
      } else {
        const bcrypt = require('bcryptjs');
        await db.execute(
          `INSERT INTO members (full_name, email, phone, date_of_birth, heard_about, tier, member_id,
             password_hash, qr_secret, referral_code, membership_started_at, next_billing_at, demo)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
          ['Zahra (preview)', 'preview@zolanailstudio.com', '', '1990-01-01', 'preview', tier, memberId,
           bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 8),
           crypto.randomBytes(16).toString('hex'), 'PREVIEW',
           iso(now), iso(next)]);
      }
      // A fresh month every time she opens it, so the free services are
      // always there to look at rather than spent by an earlier test.
      try {
        await db.execute('DELETE FROM service_usage WHERE member_id = ?', [memberId]);
      } catch (_) {}
      // And show the walkthrough again rather than remembering it was seen.
      try {
        await db.execute('DELETE FROM perk_reveal WHERE member_id = ?', [memberId]);
      } catch (_) {}

      return res.json({
        ok: true, member_id: memberId, tier,
        welcome: '/welcome.html?m=' + memberId,
        portal: '/client-portal.html',
      });
    }

    /* ── IMPORT THE OLD BOOKING SYSTEM ────────────────────────────
       Runs here rather than from a laptop: the database credentials
       live in Vercel, and pasting them onto a command line to run a
       script once is how credentials end up in shell history.
       Safe to repeat — clients match on name, visits on the old
       system's appointment id. */
    if (method === 'GET' && action === 'import_preview') {
      return res.json(await require('./_import-clients').run({ dryRun: true }));
    }
    if (method === 'POST' && action === 'import_clients') {
      return res.json(await require('./_import-clients').run({ dryRun: false }));
    }

    /* ── APPLE PAY / GOOGLE PAY ───────────────────────────────────
       The wallet button only appears once the domain is registered
       with Stripe. Everything else can be wired perfectly and the
       button still will not show, which looks like a broken feature
       rather than a missing setting. */
    if (method === 'GET' && action === 'wallet_status') {
      const rows = await query("SELECT key, value FROM site_settings WHERE key='stripe_secret'");
      const secret = (rows[0] && rows[0].value) || process.env.STRIPE_SECRET_KEY || '';
      if (!secret) return res.json({ ok: false, reason: 'no_key' });
      const r = await fetch('https://api.stripe.com/v1/apple_pay/domains?limit=20', {
        headers: { Authorization: 'Bearer ' + secret },
      });
      const body = await r.json();
      if (!r.ok) return res.json({ ok: false, reason: 'stripe', detail: (body.error || {}).message || '' });
      const domains = (body.data || []).map(d => ({ domain: d.domain_name, live: !!d.livemode }));
      return res.json({ ok: true, domains });
    }

    if (method === 'POST' && action === 'wallet_register') {
      const rows = await query("SELECT key, value FROM site_settings WHERE key='stripe_secret'");
      const secret = (rows[0] && rows[0].value) || process.env.STRIPE_SECRET_KEY || '';
      if (!secret) return res.status(400).json({ error: 'Stripe is not connected yet.' });
      // Stripe wants a bare hostname, so strip any scheme or path somebody
      // pasted along with it.
      const domain = String((req.body || {}).domain || 'zolanailstudio.com')
        .replace(/^https?:\/\//, '')
        .split('/')[0]
        .trim();
      const r = await fetch('https://api.stripe.com/v1/apple_pay/domains', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ domain_name: domain }).toString(),
      });
      const body = await r.json();
      if (!r.ok) return res.status(400).json({ error: (body.error || {}).message || 'Stripe refused' });
      return res.json({ ok: true, domain: body.domain_name, live: !!body.livemode });
    }

    if (method === 'GET' && action === 'claims') {
      return res.json(await require('./_claims').claimsOverview());
    }

    if (method === 'POST' && action === 'claim_assign') {
      const { confirmation, member_id } = req.body || {};
      if (!confirmation || !member_id) return res.status(400).json({ error: 'Which appointment, and to whom?' });
      return res.json(await require('./_claims').assignManually(String(confirmation), Number(member_id)));
    }

    // How long a booking waits for someone to confirm before the studio
    // assigns it. A client should never sit unconfirmed for long, so this
    // is capped rather than free-form.
    if (method === 'PUT' && action === 'claim_hold') {
      const n = Number((req.body || {}).minutes);
      if (!Number.isFinite(n) || n < 1 || n > 240) {
        return res.status(400).json({ error: 'Pick between 1 and 240 minutes.' });
      }
      await execute("INSERT INTO site_settings (key,value) VALUES ('claim_hold_minutes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(Math.round(n))]);
      return res.json({ ok: true, minutes: Math.round(n) });
    }

    // Who deals with a booking nobody confirmed. Default is 'owner' — she
    // asked to make that call herself rather than have a timer put a client
    // in front of an artist who never accepted them.
    if (method === 'PUT' && action === 'claim_mode') {
      const mode = String((req.body || {}).mode || '') === 'auto' ? 'auto' : 'owner';
      await execute("INSERT INTO site_settings (key,value) VALUES ('claim_unclaimed_action',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [mode]);
      return res.json({ ok: true, mode });
    }

    // Her own number, so a booking left hanging can reach her by text too.
    if (method === 'PUT' && action === 'owner_phone') {
      const phone = String((req.body || {}).phone || '').trim();
      await execute("INSERT INTO site_settings (key,value) VALUES ('owner_phone',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [phone]);
      return res.json({ ok: true, phone });
    }

    if (method === 'GET' && action === 'shifts') {
      const from = req.query.from || '0000-00-00';
      const to = req.query.to || '9999-12-31';
      const mid = req.query.member_id;
      const rows = mid
        ? await query('SELECT * FROM tech_shifts WHERE member_id=? AND date>=? AND date<=? ORDER BY date', [Number(mid), from, to])
        : await query('SELECT * FROM tech_shifts WHERE date>=? AND date<=? ORDER BY date', [from, to]);
      // How far ahead each artist is scheduled, so the UI can warn her before a
      // calendar quietly runs dry and clients start seeing "Fully Booked".
      const today = new Date().toISOString().slice(0, 10);
      const last = await query(
        'SELECT member_id, MAX(date) AS last_date, COUNT(*) AS upcoming FROM tech_shifts WHERE date>=? GROUP BY member_id',
        [today]
      );
      const coverage = {};
      for (const r of last) coverage[r.member_id] = { last_date: r.last_date, upcoming: Number(r.upcoming) };
      return res.json({ shifts: rows, coverage });
    }

    // Apply a set of dates in one shot — the calendar sends every date that
    // should be ON for this artist in the given range, and we make the table
    // match exactly. One call covers ticking, unticking and bulk fills alike.
    if (method === 'PUT' && action === 'shifts') {
      const { member_id, from, to, dates, start_time, end_time, lunch_start, lunch_end } = req.body || {};
      if (!member_id) return res.status(400).json({ error: 'member_id required' });
      if (!from || !to) return res.status(400).json({ error: 'from and to required' });
      const st = start_time || '09:00';
      const et = end_time || '18:00';
      if (et <= st) return res.status(400).json({ error: 'End time must be after start time' });
      // Lunch is optional and any length — the only rules are that it has a
      // real span and sits inside the shift, otherwise it would silently
      // remove nothing or block hours she never worked.
      const ls = lunch_start || null, le = lunch_end || null;
      if ((ls && !le) || (le && !ls)) return res.status(400).json({ error: 'Lunch needs both a start and an end time' });
      if (ls && le) {
        if (le <= ls) return res.status(400).json({ error: 'Lunch end must be after lunch start' });
        if (ls < st || le > et) return res.status(400).json({ error: 'Lunch has to fall inside the working hours' });
      }
      const want = Array.isArray(dates) ? dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
      const mid = Number(member_id);
      // Replace the window rather than diff it — the payload is one month of
      // dates at most, and this can't drift out of sync with what she sees.
      await execute('DELETE FROM tech_shifts WHERE member_id=? AND date>=? AND date<=?', [mid, from, to]);
      for (const d of want) {
        await execute(
          'INSERT OR REPLACE INTO tech_shifts (member_id, date, start_time, end_time, lunch_start, lunch_end, created_ts) VALUES (?,?,?,?,?,?,?)',
          [mid, d, st, et, ls, le, Date.now()]
        );
      }
      return res.json({ ok: true, saved: want.length });
    }

    // Per-date hours, for when one day runs different from the rest
    if (method === 'PUT' && action === 'shift_hours') {
      const { member_id, date, start_time, end_time, lunch_start, lunch_end } = req.body || {};
      if (!member_id || !date) return res.status(400).json({ error: 'member_id and date required' });
      if (!start_time || !end_time) return res.status(400).json({ error: 'start_time and end_time required' });
      if (end_time <= start_time) return res.status(400).json({ error: 'End time must be after start time' });
      await execute(
        'INSERT OR REPLACE INTO tech_shifts (member_id, date, start_time, end_time, lunch_start, lunch_end, created_ts) VALUES (?,?,?,?,?,?,?)',
        [Number(member_id), date, start_time, end_time, lunch_start || null, lunch_end || null, Date.now()]
      );
      return res.json({ ok: true });
    }

    // ── SCHEDULE COVERAGE OVERRIDES (e.g. "only Maria working July 21–Aug 2") ──
    if (method === 'GET' && action === 'overrides') {
      const overrides = await query('SELECT * FROM schedule_overrides ORDER BY start_date DESC');
      return res.json({ overrides: overrides.map(o => ({ ...o, team_member_ids: JSON.parse(o.team_member_ids || '[]') })) });
    }

    if (method === 'POST' && action === 'overrides') {
      const { start_date, end_date, team_member_ids, note } = req.body || {};
      if (!start_date || !end_date || !Array.isArray(team_member_ids) || !team_member_ids.length) {
        return res.status(400).json({ error: 'start_date, end_date, and at least one team member are required' });
      }
      const r = await execute(
        'INSERT INTO schedule_overrides (start_date, end_date, team_member_ids, note, created_ts) VALUES (?,?,?,?,?)',
        [start_date, end_date, JSON.stringify(team_member_ids.map(Number)), note || '', Date.now()]
      );
      return res.json({ ok: true, id: r.lastInsertRowid });
    }

    if (method === 'DELETE' && action === 'overrides') {
      const { id } = req.body || {};
      await execute('DELETE FROM schedule_overrides WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    // ── DEPOSITS: who has paid vs not, mark-paid, and 24-hour notice ──
    async function depositRows() {
      const { query: mainQuery, execute: mainExec } = require('./_db');
      try { await mainExec('ALTER TABLE appointments ADD COLUMN deposit_paid INTEGER DEFAULT 0'); } catch (_) {}
      const today = new Date().toISOString().slice(0, 10);
      const rows = await mainQuery(
        `SELECT a.id, a.appointment_date AS date, a.appointment_time AS time, a.service,
                a.total_cents, a.deposit_cents, a.deposit_paid,
                m.full_name, m.phone AS mphone, m.email AS memail, a.guest_name, a.guest_email
         FROM appointments a LEFT JOIN members m ON a.member_id = m.member_id
         WHERE a.status = 'SCHEDULED' AND a.appointment_date >= ?
         ORDER BY a.appointment_date, a.appointment_time`, [today]).catch(() => []);
      const clients = await query('SELECT email, phone FROM clients').catch(() => []);
      const pmap = {}; for (const c of clients) if (c.email) pmap[String(c.email).toLowerCase()] = c.phone;
      return rows.map(r => ({
        id: r.id, date: r.date, time: r.time, service: r.service,
        total_cents: Number(r.total_cents) || 0, deposit_cents: Number(r.deposit_cents) || 0,
        deposit_paid: Number(r.deposit_paid) ? 1 : 0,
        name: r.full_name || r.guest_name || 'Client',
        phone: r.mphone || pmap[String(r.guest_email || '').toLowerCase()] || '',
        email: r.memail || r.guest_email || '',
      }));
    }

    if (method === 'GET' && action === 'deposits') {
      return res.json({ appointments: await depositRows() });
    }

    if (method === 'POST' && action === 'deposit_mark') {
      const { id, paid } = req.body || {};
      const { execute: mainExec } = require('./_db');
      try { await mainExec('ALTER TABLE appointments ADD COLUMN deposit_paid INTEGER DEFAULT 0'); } catch (_) {}
      await mainExec('UPDATE appointments SET deposit_paid=? WHERE id=?', [paid ? 1 : 0, Number(id)]);
      return res.json({ ok: true });
    }

    if (method === 'POST' && action === 'request_deposit') {
      const { id } = req.body || {};
      const row = (await depositRows()).find(r => String(r.id) === String(id));
      if (!row) return res.status(404).json({ error: 'Appointment not found' });
      const first = row.name.split(' ')[0];
      const dep = '$' + Math.round(row.deposit_cents / 100);
      const when = row.date + ' at ' + row.time;
      const sms = `ZOLA Nail Studio: Hi ${first} — your ${dep} deposit for ${row.service} on ${when} is still due. Please send it within 24 hours or your appointment will be cancelled. Questions? Just reply here. ✦`;
      const html = `<p>Hi ${first},</p><p>Your <strong>${dep} deposit</strong> for <strong>${row.service}</strong> on ${when} is still due. Please send it within <strong>24 hours</strong> or your appointment will be cancelled.</p><p>Questions? Reply to this email or DM @zola_officials_.</p><p>— ZOLA Nail Studio ✦</p>`;
      const out = {};
      if (row.phone) out.sms = await sendSMS(row.phone, sms);
      if (row.email) out.email = await sendEmail(row.email, 'Deposit needed within 24 hours — ZOLA', html);
      try { await require('./_notify').notifyInApp('owner', null, 'Deposit notice sent', `24-hour deposit notice sent to ${row.name} (${row.service}, ${when}).`); } catch (_) {}
      return res.json({ ok: true, ...out });
    }

    // ── NOTIFICATION SETTINGS (worker + client + inventory reminders) ──
    if (method === 'GET' && action === 'notif_settings') {
      const rows = await query("SELECT key, value FROM site_settings WHERE key LIKE 'notif_%' OR key='owner_phone'");
      const s = {}; for (const r of rows) s[r.key] = r.value;
      const on = (k, d) => s[k] === undefined ? d : String(s[k]) === '1';
      const num = (k, d) => s[k] === undefined ? d : (Number(s[k]) || d);
      return res.json({
        worker_pre_on: on('notif_worker_pre_on', true), worker_pre_min: num('notif_worker_pre_min', 10),
        worker_checkin_on: on('notif_worker_checkin_on', true), worker_checkin_min: num('notif_worker_checkin_min', 120),
        worker_overrun_on: on('notif_worker_overrun_on', true),
        client_24h_on: on('notif_client_24h_on', true), client_1h_on: on('notif_client_1h_on', true), client_post_on: on('notif_client_post_on', true),
        inv_daily_on: on('notif_inv_daily_on', true), inv_daily_time: s['notif_inv_daily_time'] || '18:00',
        inv_lowstock_on: on('notif_inv_lowstock_on', true),
        owner_phone: s['owner_phone'] || '',
      });
    }
    if (method === 'POST' && action === 'notif_settings') {
      const b = req.body || {};
      const map = {
        notif_worker_pre_on: b.worker_pre_on ? '1' : '0', notif_worker_pre_min: String(Number(b.worker_pre_min) || 10),
        notif_worker_checkin_on: b.worker_checkin_on ? '1' : '0', notif_worker_checkin_min: String(Number(b.worker_checkin_min) || 120),
        notif_worker_overrun_on: b.worker_overrun_on ? '1' : '0',
        notif_client_24h_on: b.client_24h_on ? '1' : '0', notif_client_1h_on: b.client_1h_on ? '1' : '0', notif_client_post_on: b.client_post_on ? '1' : '0',
        notif_inv_daily_on: b.inv_daily_on ? '1' : '0', notif_inv_daily_time: String(b.inv_daily_time || '18:00'),
        notif_inv_lowstock_on: b.inv_lowstock_on ? '1' : '0',
        owner_phone: String(b.owner_phone || ''),
      };
      for (const [k, v] of Object.entries(map)) {
        await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, v]);
      }
      return res.json({ ok: true });
    }

    // ── MEMBERS: list + remove (cancels their Stripe subscription first) ──
    if (method === 'GET' && action === 'members_list') {
      const { query: mainQuery } = require('./_db');
      const rows = await mainQuery(
        'SELECT member_id, full_name, email, tier, membership_started_at, stripe_subscription_id FROM members ORDER BY membership_started_at DESC'
      ).catch(() => []);
      return res.json({ members: rows });
    }

    if (method === 'DELETE' && action === 'member_record') {
      const memberId = String((req.body || {}).member_id || '').trim();
      if (!memberId) return res.status(400).json({ error: 'member_id required' });
      const { queryOne: mainOne, execute: mainExec } = require('./_db');
      const m = await mainOne('SELECT member_id, full_name, stripe_subscription_id FROM members WHERE member_id=?', [memberId]);
      if (!m) return res.status(404).json({ error: 'Member not found' });
      // Cancel their subscription so they're never billed again
      let cancelled = null;
      if (m.stripe_subscription_id) {
        try {
          const sk = await require('./_pay').getStripeSecret();
          if (sk) {
            const r = await fetch('https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(m.stripe_subscription_id), {
              method: 'DELETE', headers: { Authorization: 'Bearer ' + sk },
            });
            cancelled = r.ok;
          }
        } catch (_) { cancelled = false; }
      }
      await mainExec('DELETE FROM members WHERE member_id=?', [memberId]);
      return res.json({ ok: true, removed: m.full_name || memberId, subscription_cancelled: cancelled });
    }

    /* Everybody with a future appointment who never got the confirmation.
       These are the people who booked before any of this existed — they have
       no deposit link and no way to send a reference photo, and they are the
       whole reason this exists. */
    if (method === 'GET' && action === 'pending_confirms') {
      const rows = await require('./_confirm-mail').pending();
      return res.json({
        pending: rows.map(r => ({
          id: r.id, client: r.client_name, email: r.client_email,
          service: r.service, date: r.date, time: r.time,
          artist: r.artist_name || '', deposit_paid: !!Number(r.deposit_paid),
        })),
      });
    }

    if (method === 'POST' && action === 'send_confirms') {
      const mail = require('./_confirm-mail');
      const only = (req.body || {}).id ? Number((req.body || {}).id) : null;
      const force = !!(req.body || {}).force;
      let rows = await mail.pending();
      if (only) {
        const one = await queryOne(
          `SELECT a.*, m.name AS artist_name FROM team_appointments a
             LEFT JOIN team_members m ON m.id = a.team_member_id
            WHERE a.id = ?`, [only]);
        rows = one ? [one] : [];
      }
      let sent = 0, skipped = 0;
      const why = [];
      for (const r of rows) {
        const out = await mail.sendFor(r, { force: force || !!only });
        if (out.sent) sent++;
        else { skipped++; if (out.why && why.length < 5) why.push((r.client_name || r.id) + ': ' + out.why); }
      }
      return res.json({ ok: true, sent, skipped, why });
    }

    // ── MEMBERSHIP SALES STATS (real counts + revenue by tier) ──
    if (method === 'GET' && action === 'membership_stats') {
      // Revenue by tier has to be what those members pay, not what the tier
      // is advertised at, or every discount she gives is invisible here.
      const mp = require('./_member-price');
      const PRICE = { SIGNATURE: 9900, LUXE: 19900, BLACK_CARD: 29900 };
      const realByTier = { SIGNATURE: 0, LUXE: 0, BLACK_CARD: 0 };
      try {
        const paid = await query(
          "SELECT tier, paid_cents, billing_period FROM members WHERE COALESCE(demo,0)=0 AND tier IN ('SIGNATURE','LUXE','BLACK_CARD')");
        for (const p of paid) {
          if (realByTier[p.tier] !== undefined) realByTier[p.tier] += mp.monthlyValue(p).cents;
        }
      } catch (_) {}
      const counts = { SIGNATURE: 0, LUXE: 0, BLACK_CARD: 0 };
      try {
        const rows = await query("SELECT tier, COUNT(*) AS n FROM members WHERE tier IN ('SIGNATURE','LUXE','BLACK_CARD') GROUP BY tier");
        for (const r of rows) if (counts[r.tier] !== undefined) counts[r.tier] = Number(r.n);
      } catch (_) {}
      const total = counts.SIGNATURE + counts.LUXE + counts.BLACK_CARD;
      // Sum what those members are really charged. Multiplying head-count by
      // list price ignored every discount given and reported income that was
      // never collected.
      const realTotal = realByTier.SIGNATURE + realByTier.LUXE + realByTier.BLACK_CARD;
      const mrr = realTotal > 0
        ? realTotal
        : (counts.SIGNATURE * PRICE.SIGNATURE + counts.LUXE * PRICE.LUXE + counts.BLACK_CARD * PRICE.BLACK_CARD);
      let newThisMonth = 0;
      try {
        const monthPrefix = new Date().toISOString().slice(0, 7);
        const nr = await query("SELECT COUNT(*) AS n FROM members WHERE substr(membership_started_at,1,7)=? AND tier IN ('SIGNATURE','LUXE','BLACK_CARD')", [monthPrefix]);
        newThisMonth = nr[0] ? Number(nr[0].n) : 0;
      } catch (_) {}
      return res.json({ counts, total, mrr_cents: mrr, arr_cents: mrr * 12, new_this_month: newThisMonth, prices: PRICE, revenue_by_tier: realByTier });
    }

    // ── WHERE PEOPLE HEARD ABOUT US (from membership signups) ──
    if (method === 'GET' && action === 'heard_about') {
      const LABELS = { instagram: 'Instagram', friend: 'Friend or family', google: 'Google', tiktok: 'TikTok', celebrity: 'Saw a celebrity client', other: 'Other', '': 'Not specified' };
      let rows = [];
      try { rows = await query('SELECT heard_about, COUNT(*) AS n FROM members GROUP BY heard_about'); } catch (_) {}
      const counts = {};
      let total = 0;
      for (const r of rows) {
        const key = (r.heard_about || '').toLowerCase();
        const label = LABELS[key] || (r.heard_about || 'Not specified');
        counts[label] = (counts[label] || 0) + Number(r.n);
        total += Number(r.n);
      }
      const sources = Object.entries(counts).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
      return res.json({ sources, total });
    }

    // ── PERSONAL BLOCKS (GlossGenius-style: block time for a person) ──
    if (method === 'GET' && action === 'blocks') {
      const from = req.query.from || new Date().toISOString().slice(0, 10);
      const rows = await query('SELECT * FROM personal_blocks WHERE date >= ? ORDER BY date, start_time', [from]);
      return res.json({ blocks: rows });
    }

    if (method === 'POST' && action === 'block') {
      const { member_id, member_name, dates, all_day, start_time, end_time, note } = req.body || {};
      const dateList = Array.isArray(dates) ? dates : (dates ? [dates] : []);
      if (!dateList.length) return res.status(400).json({ error: 'At least one date is required' });
      if (!all_day && (!start_time || !end_time)) return res.status(400).json({ error: 'Start and end time required (or choose all day)' });
      for (const date of dateList) {
        await execute(
          'INSERT INTO personal_blocks (member_id, member_name, date, all_day, start_time, end_time, note, created_ts) VALUES (?,?,?,?,?,?,?,?)',
          [member_id ? Number(member_id) : null, member_name || '', date, all_day ? 1 : 0, all_day ? null : start_time, all_day ? null : end_time, note || '', Date.now()]
        );
      }
      return res.json({ ok: true, count: dateList.length });
    }

    if (method === 'DELETE' && action === 'block') {
      const { id } = req.body || {};
      await execute('DELETE FROM personal_blocks WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    // ── PER-DAY HOURS OVERRIDE (open later / close earlier / closed one day) ──
    if (method === 'GET' && action === 'day_hours') {
      const from = req.query.from || new Date().toISOString().slice(0, 10);
      const rows = await query('SELECT * FROM day_hours WHERE date >= ? ORDER BY date', [from]);
      return res.json({ day_hours: rows });
    }

    if (method === 'POST' && action === 'day_hours') {
      const { date, open_time, close_time, closed } = req.body || {};
      if (!date) return res.status(400).json({ error: 'date required' });
      await execute(
        'INSERT INTO day_hours (date, open_time, close_time, closed) VALUES (?,?,?,?) ON CONFLICT(date) DO UPDATE SET open_time=excluded.open_time, close_time=excluded.close_time, closed=excluded.closed',
        [date, open_time || null, close_time || null, closed ? 1 : 0]
      );
      return res.json({ ok: true });
    }

    if (method === 'DELETE' && action === 'day_hours') {
      const { date } = req.body || {};
      await execute('DELETE FROM day_hours WHERE date=?', [date]);
      return res.json({ ok: true });
    }

    // ── DEFAULT BOOKING-AVAILABILITY HOURS + MINIMUM ADVANCE NOTICE ──
    if (method === 'GET' && action === 'booking_hours') {
      const o = await queryOne("SELECT value FROM site_settings WHERE key='book_open_time'");
      const c = await queryOne("SELECT value FROM site_settings WHERE key='book_close_time'");
      const adv = await queryOne("SELECT value FROM site_settings WHERE key='min_advance_hours'");
      return res.json({
        open_time: (o && o.value) || '08:00',
        close_time: (c && c.value) || '22:00',
        min_advance_hours: adv ? Number(adv.value) : 0,
      });
    }

    if (method === 'POST' && action === 'booking_hours') {
      const { open_time, close_time, min_advance_hours } = req.body || {};
      const pairs = [['book_open_time', open_time], ['book_close_time', close_time]];
      if (min_advance_hours !== undefined) pairs.push(['min_advance_hours', String(Number(min_advance_hours) || 0)]);
      for (const [k, v] of pairs) {
        if (v !== undefined && v !== null && v !== '') await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, String(v)]);
      }
      return res.json({ ok: true });
    }

    if (method === 'POST' && action === 'add_member') {
      const { name, role, color, phone, email, bio, title, show_on_site, photo, trainee } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name required' });
      const pin = await uniquePin();
      const r = await execute(
        'INSERT INTO team_members (name, role, pin, color, active, phone, email, bio, title, show_on_site, photo, trainee) VALUES (?,?,?,?,1,?,?,?,?,?,?,?)',
        [name, role || 'Nail Artist', pin, color || '#C4A882', phone || '', email || '', bio || '', title || '', show_on_site ? 1 : 0, photo || '', trainee ? 1 : 0]
      );
      return res.json({ ok: true, member: { id: r.lastInsertRowid, name, role: role || 'Nail Artist', pin, color: color || '#C4A882', active: 1, phone: phone || '', email: email || '', bio: bio || '', title: title || '', show_on_site: show_on_site ? 1 : 0 } });
    }

    if (method === 'PUT' && action === 'update_member') {
      const { id, name, role, color, active, phone, email, bio, title, show_on_site, photo, trainee } = req.body || {};
      await execute('UPDATE team_members SET name=?, role=?, color=?, active=?, phone=?, email=?, bio=?, title=?, show_on_site=? WHERE id=?',
        [name, role, color || '#C4A882', active ? 1 : 0, phone || '', email || '', bio || '', title || '', show_on_site ? 1 : 0, Number(id)]);
      // Photo is written separately so leaving it untouched in the form never
      // wipes an existing headshot.
      if (photo !== undefined) await execute('UPDATE team_members SET photo=? WHERE id=?', [photo || '', Number(id)]);
      if (trainee !== undefined) await execute('UPDATE team_members SET trainee=? WHERE id=?', [trainee ? 1 : 0, Number(id)]);
      return res.json({ ok: true });
    }

    if (method === 'POST' && action === 'regen_pin') {
      const { id } = req.body || {};
      const pin = await uniquePin();
      await execute('UPDATE team_members SET pin=? WHERE id=?', [pin, Number(id)]);
      return res.json({ ok: true, pin });
    }

    if (method === 'DELETE' && action === 'member') {
      const { id } = req.body || {};
      await execute('DELETE FROM team_members WHERE id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    // ── APPOINTMENTS ──
    if (method === 'GET' && action === 'appointments') {
      const rows = await query(`SELECT a.*, m.name AS member_name, m.color AS member_color
        FROM team_appointments a LEFT JOIN team_members m ON m.id = a.team_member_id
        ORDER BY a.date, a.time`);
      return res.json({ appointments: rows });
    }

    if (method === 'POST' && action === 'add_appt') {
      const { team_member_id, client_name, client_phone, client_email, service, date, time, notes } = req.body || {};
      if (!date || !time) return res.status(400).json({ error: 'Date and time required' });
      // The email lives on the appointment now — it is what the confirmation
      // with the deposit and inspiration links is sent to.
      try { await require('./_visit').ensureColumns(); } catch (_) {}
      const tok = token();
      const r = await execute(
        `INSERT INTO team_appointments (team_member_id, client_name, client_phone, client_email, service, date, time, notes, status, chat_token)
         VALUES (?,?,?,?,?,?,?,?, 'scheduled', ?)`,
        [team_member_id ? Number(team_member_id) : null, client_name || '', client_phone || '',
         String(client_email || '').trim().toLowerCase(), service || '', date, time, notes || '', tok]
      );
      /* The confirmation with both links — pay the deposit, send your
         inspiration. Sent here so an appointment Zahra takes by hand
         arrives exactly like one booked online, rather than with no money
         down and nothing to work from. */
      let confirmMail = null;
      try {
        const apptRow = await queryOne(
          `SELECT a.*, m.name AS artist_name FROM team_appointments a
             LEFT JOIN team_members m ON m.id = a.team_member_id
            WHERE a.chat_token = ?`, [tok]);
        if (apptRow) confirmMail = await require('./_confirm-mail').sendFor(apptRow);
      } catch (_) {}

      // instant notifications (client confirmation + booked-artist alert) + client memory
      let notify = null;
      try {
        const m = team_member_id ? await queryOne('SELECT id, name, phone, email FROM team_members WHERE id=?', [Number(team_member_id)]) : null;
        notify = await notifyNewAppointment({
          clientName: client_name, clientPhone: client_phone, clientEmail: client_email,
          service, date, time,
          memberId: m ? m.id : null, memberName: m ? m.name : null,
          memberPhone: m ? m.phone : null, memberEmail: m ? m.email : null,
        });
        await upsertClient({ name: client_name, email: client_email, phone: client_phone, service, date });
      } catch (_) {}
      return res.json({ ok: true, id: r.lastInsertRowid, chat_token: tok, notify });
    }

    if (method === 'PUT' && action === 'update_appt') {
      const { id, team_member_id, client_name, client_phone, service, date, time, notes, status } = req.body || {};
      await execute(
        `UPDATE team_appointments SET team_member_id=?, client_name=?, client_phone=?, service=?, date=?, time=?, notes=?, status=? WHERE id=?`,
        [team_member_id ? Number(team_member_id) : null, client_name || '', client_phone || '', service || '', date, time, notes || '', status || 'scheduled', Number(id)]
      );
      return res.json({ ok: true });
    }

    if (method === 'PUT' && action === 'reassign') {
      const { id, team_member_id } = req.body || {};
      await execute('UPDATE team_appointments SET team_member_id=? WHERE id=?',
        [team_member_id ? Number(team_member_id) : null, Number(id)]);

      // Somebody who has just been given an artist should hear about it, and
      // that is the moment the deposit and inspiration links are worth
      // sending. Only once — the row remembers.
      try {
        const row = await queryOne(
          `SELECT a.*, m.name AS artist_name FROM team_appointments a
             LEFT JOIN team_members m ON m.id = a.team_member_id
            WHERE a.id = ?`, [Number(id)]);
        if (row) await require('./_confirm-mail').sendFor(row);
      } catch (_) {}
      // alert the newly assigned artist instantly
      try {
        if (team_member_id) {
          const a = await queryOne('SELECT * FROM team_appointments WHERE id=?', [Number(id)]);
          const m = await queryOne('SELECT id, name, phone, email FROM team_members WHERE id=?', [Number(team_member_id)]);
          if (a && m) await notifyNewAppointment({
            clientName: a.client_name, service: a.service, date: a.date, time: a.time,
            memberId: m.id, memberName: m.name, memberPhone: m.phone, memberEmail: m.email,
          });
        }
      } catch (_) {}
      return res.json({ ok: true });
    }

    if (method === 'DELETE' && action === 'appt') {
      const { id } = req.body || {};
      await execute('DELETE FROM team_appointments WHERE id=?', [Number(id)]);
      await execute('DELETE FROM team_chat WHERE appointment_id=?', [Number(id)]);
      return res.json({ ok: true });
    }

    // ── CHAT (owner oversight — read any thread, post as owner) ──
    if (method === 'GET' && action === 'threads') {
      const rows = await query(`SELECT a.id, a.client_name, a.service, a.date, a.time, a.chat_token,
          m.name AS member_name,
          (SELECT body FROM team_chat c WHERE c.appointment_id = a.id ORDER BY c.ts DESC LIMIT 1) AS last_msg,
          (SELECT ts FROM team_chat c WHERE c.appointment_id = a.id ORDER BY c.ts DESC LIMIT 1) AS last_ts,
          (SELECT COUNT(*) FROM team_chat c WHERE c.appointment_id = a.id) AS msg_count
        FROM team_appointments a LEFT JOIN team_members m ON m.id = a.team_member_id
        ORDER BY COALESCE(last_ts, 0) DESC, a.date DESC`);
      return res.json({ threads: rows });
    }

    if (method === 'GET' && action === 'chat') {
      const appointment_id = Number(req.query.appointment_id);
      const msgs = await query('SELECT * FROM team_chat WHERE appointment_id=? ORDER BY ts', [appointment_id]);
      return res.json({ messages: msgs });
    }

    if (method === 'POST' && action === 'chat') {
      const { appointment_id, body } = req.body || {};
      if (!body) return res.status(400).json({ error: 'Message required' });
      await execute('INSERT INTO team_chat (appointment_id, sender, sender_name, body, ts) VALUES (?, "owner", "Zahra", ?, ?)',
        [Number(appointment_id), body, Date.now()]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
