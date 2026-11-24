// The Black Friday switch, and what the sale actually did.
//
// Everything else about the sale is decided in code: which cells are
// discounted, by how much, and how the charge is built. That is correct —
// those are pricing decisions with money riding on them and they belong
// under test.
//
// But three things must be HERS, without asking me and without a deploy:
//
//   · when it runs. A sale she cannot extend on the Saturday night it is
//     going well is a sale that ends early for no reason.
//   · whether it runs at all, overriding the dates either way.
//   · how deep the press-on discount is, which she never named.
//
// And one thing she needs that has nothing to do with control: what it
// sold. A sale with no scoreboard is a sale nobody learns anything from,
// so this also counts what went through while it was on — memberships by
// tier and rhythm, press-ons, and the total discount given away, read
// from Stripe and from the members table rather than from a counter
// somebody has to remember to increment.
const { query, queryOne, execute } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const money = c => Math.max(0, Math.round(Number(c) || 0));
const dollars = c => '$' + (money(c) / 100).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = n => String(n).padStart(2, '0');

function studioNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}
const todayLA = () => {
  const d = studioNow();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};

const SETTINGS = ['bf_from', 'bf_to', 'bf_force', 'bf_presson_pct'];

async function put(key, value) {
  await execute(
    'INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, String(value)]);
}

/* ── WHAT IS ON SALE, AND WHEN ──────────────────────────────────────── */

async function state() {
  const plans = require('./_plans');
  const win = await plans.blackFridayWindow();

  let pressonPct = 25;
  try {
    const r = await queryOne("SELECT value FROM site_settings WHERE key='bf_presson_pct'");
    if (r && String(r.value || '') !== '') pressonPct = Math.max(0, Math.min(80, Math.round(Number(r.value) || 0)));
  } catch (_) {}

  /* The whole grid, so the page can show her exactly what a client sees
     without her opening the shop in another tab. Built from the same
     functions that price the real thing. */
  const grid = [];
  for (const key of ['ESSENTIAL', 'ELITE']) {
    const p = plans.byKey(key);
    if (!p) continue;
    for (const weeks of [2, 3, 4, 5]) {
      for (const mode of ['cycle', 'annual']) {
        /* saleFor knows the price table but not the calendar, on purpose:
           the window gates the page and the checkout. This screen claims
           to show what a CLIENT sees, so it has to apply the window too —
           otherwise it would display sale prices in July. */
        const s = win.live ? plans.saleFor(p, weeks, mode) : null;
        grid.push({
          tier: p.name, tier_key: key, weeks, mode,
          regular_cents: mode === 'annual' ? plans.annualCentsAt(p, weeks) : plans.rhythmCents(p, weeks),
          as_you_go_cents: mode === 'annual' ? plans.payAsYouGoYear(p, weeks) : 0,
          on_sale: !!s,
          sale_cents: s ? s.now_cents : 0,
          pct_off: s ? s.pct_off : 0,
          pct_off_vs_monthly: s && s.pct_off_monthly ? s.pct_off_monthly : 0,
          saved_cents: s ? (mode === 'annual' ? s.saved_vs_monthly_cents : s.saved_cents) : 0,
          lasts: s ? (mode === 'cycle' ? 'first ' + s.intro_weeks + ' weeks' : 'the first year') : '',
          visits: mode === 'annual' ? plans.cyclesAt(weeks) : 0,
        });
      }
    }
  }

  const days = (() => {
    try {
      const a = Date.parse(win.from + 'T12:00:00Z'), b = Date.parse(win.to + 'T12:00:00Z');
      const t = Date.parse(todayLA() + 'T12:00:00Z');
      return {
        length: Math.round((b - a) / 86400000) + 1,
        starts_in: Math.round((a - t) / 86400000),
        ends_in: Math.round((b - t) / 86400000),
      };
    } catch (_) { return { length: 0, starts_in: 0, ends_in: 0 }; }
  })();

  return {
    live: win.live,
    from: win.from,
    to: win.to,
    forced: win.forced || '',
    today: win.today,
    days,
    presson_pct: pressonPct,
    /* Why it is or is not live, in words, because "the dates say no but
       the override says yes" is exactly the sort of thing that is obvious
       in code and baffling on a screen. */
    why: win.forced === 'on'
      ? 'Forced on, whatever the dates say.'
      : win.forced === 'off'
        ? 'Forced off, whatever the dates say.'
        : win.live
          ? 'Running, because today is inside the dates.'
          : (win.today < win.from
              ? 'Not started — it opens on ' + win.from + '.'
              : 'Finished — it closed after ' + win.to + '.'),
    grid,
  };
}

async function save(body) {
  const b = body || {};
  const out = {};
  const ymd = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);

  if (b.from !== undefined) {
    const v = ymd(b.from);
    if (!v) return { ok: false, why: 'The start date needs to look like 2026-11-25.' };
    out.from = v;
  }
  if (b.to !== undefined) {
    const v = ymd(b.to);
    if (!v) return { ok: false, why: 'The end date needs to look like 2026-12-01.' };
    out.to = v;
  }
  /* A window that ends before it starts would read as "finished" forever
     and quietly disable the sale. Caught here rather than discovered on
     Friday morning. */
  const from = out.from || (await state()).from;
  const to = out.to || (await state()).to;
  if (from > to) return { ok: false, why: 'The sale would end before it started. Check the two dates.' };

  if (out.from) await put('bf_from', out.from);
  if (out.to) await put('bf_to', out.to);

  if (b.force !== undefined) {
    const v = String(b.force || '').toLowerCase();
    if (['on', 'off', ''].indexOf(v) < 0) return { ok: false, why: 'Force must be on, off, or left alone.' };
    await put('bf_force', v);
  }
  if (b.presson_pct !== undefined) {
    const n = Math.max(0, Math.min(80, Math.round(Number(b.presson_pct) || 0)));
    await put('bf_presson_pct', String(n));
  }

  return Object.assign({ ok: true }, await state());
}

/* ── WHAT IT SOLD ───────────────────────────────────────────────────────
   Counted from what actually happened, never from a tally somebody has to
   remember to increment. Memberships come from the members table, joined
   against the sale window; press-ons from their own orders. */
async function results() {
  const st = await state();
  const fromMs = Date.parse(st.from + 'T00:00:00-08:00');
  const toMs = Date.parse(st.to + 'T23:59:59-08:00');

  const out = {
    from: st.from, to: st.to, live: st.live,
    memberships: [], memberships_count: 0, memberships_cents: 0, memberships_saved_cents: 0,
    pressons_count: 0, pressons_cents: 0, pressons_saved_cents: 0,
    total_cents: 0, total_saved_cents: 0,
  };

  /* Memberships. demo rows are excluded, the same as everywhere else that
     reports money — her own test records must never reach a figure she
     makes a decision on. */
  try {
    const rows = await require('./_db').query(
      'SELECT member_id, full_name, tier, membership_started_at, stripe_subscription_id, demo '
      + 'FROM members WHERE membership_started_at >= ? AND membership_started_at <= ? '
      + 'ORDER BY membership_started_at',
      [st.from, st.to]);
    for (const m of rows || []) {
      if (Number(m.demo)) continue;
      out.memberships.push({
        member_id: m.member_id, name: m.full_name || '', tier: m.tier || '',
        joined: String(m.membership_started_at || '').slice(0, 10),
        billing: m.stripe_subscription_id ? 'billing' : 'no subscription',
      });
    }
    out.memberships_count = out.memberships.length;
  } catch (_) {}

  /* Press-ons, and what the discount cost her. */
  try {
    const rows = await query(
      'SELECT * FROM presson_orders WHERE created_ts >= ? AND created_ts <= ? ORDER BY created_ts',
      [fromMs, toMs]);
    out.pressons_count = (rows || []).length;
    for (const r of rows || []) out.pressons_cents += money(r.price_cents || r.amount_cents);
  } catch (_) {}

  /* The money that actually moved in the window, from Stripe, which is
     the only thing that really knows — and split so she can see what the
     sale brought in rather than guessing from signups. */
  try {
    const sk = await require('./_pay').getStripeSecret();
    if (sk) {
      const m = require('./_money');
      const swept = await m.stripeCollected(sk, Math.floor(fromMs / 1000));
      let inWindow = 0;
      for (const key of Object.keys(swept.byMonth || {})) inWindow += money(swept.byMonth[key]);
      out.stripe_since_start_cents = inWindow;
      out.stripe_by_source = swept.bySource || {};
    }
  } catch (_) {}

  out.total_cents = out.pressons_cents;
  return out;
}

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';
  try {
    if (req.method === 'GET' && (action === 'state' || !action)) return res.json(await state());
    if (req.method === 'GET' && action === 'results') return res.json(await results());
    if (req.method === 'POST' && action === 'save') {
      const out = await save(req.body);
      return res.status(out.ok === false ? 400 : 200).json(out);
    }
    /* A preview of the two emails, so she can read the wording before a
       single client sees it. Deliberately dry: this endpoint cannot send. */
    if (req.method === 'GET' && action === 'preview_mail') {
      const plans = require('./_plans');
      const mail = require('./_bf-mail');
      const tier = String(req.query.tier || 'ELITE').toUpperCase();
      const weeks = Number(req.query.weeks) || 4;
      const mode = String(req.query.mode || 'annual') === 'cycle' ? 'cycle' : 'annual';
      const s = plans.saleFor(tier, weeks, mode);
      if (!s) return res.status(400).json({ error: 'That one is not on sale.' });
      const p = plans.byKey(tier);
      return res.json(mail.membershipHtml({
        name: 'Your Client', tier: p ? p.name : tier, memberId: 'ZL-EXAMPLE',
        bf: {
          mode: s.mode, weeks, now_cents: s.now_cents, was_cents: s.was_cents,
          then_cents: s.was_cents, saved_cents: s.saved_cents,
          saved_vs_monthly_cents: s.saved_vs_monthly_cents || 0,
          vs_monthly_cents: s.vs_monthly_cents || 0,
          lasts: mode === 'cycle' ? 'your first 2 months' : 'your first year',
        },
      }));
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};

module.exports.state = state;
module.exports.save = save;
module.exports.results = results;
module.exports.SETTINGS = SETTINGS;
module.exports.dollars = dollars;
