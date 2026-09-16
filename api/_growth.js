// The Marketing home: what is working, and the accounts it connects to.
//
// Two jobs. First, one screen that says how much marketing actually went out
// — emails, texts, codes used, friends referred — so it can be judged rather
// than guessed at. Second, the handful of IDs that connect the website to
// Facebook, Instagram and Google ads, so ad money can be measured against
// the bookings it brings in.
//
// The IDs are public by nature: a Meta Pixel or Google tag ID is printed in
// the source of every page that uses one. Nothing secret is stored here.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';
const DAY = 86400000;

/* Every field, what it must look like, and what to say when it does not. */
const FIELDS = {
  mkt_meta_pixel_id:  { re: /^\d{10,20}$/, why: 'A Meta Pixel ID is a long number, like 1234567890123456.' },
  mkt_google_tag_id:  { re: /^(G|GT)-[A-Z0-9]{4,15}$/i, why: 'A Google Analytics tag ID starts with G-, like G-AB12CD34EF.' },
  mkt_google_ads_id:  { re: /^AW-\d{6,15}$/i, why: 'A Google Ads ID starts with AW-, like AW-123456789.' },
  mkt_gbp_url:        { re: /^https:\/\/\S+$/i, why: 'Paste the full link, starting https://' },
  mkt_review_url:     { re: /^https:\/\/\S+$/i, why: 'Paste the full review link, starting https://' },
  mkt_instagram:      { re: /^https:\/\/(www\.)?instagram\.com\/\S+$/i, why: 'Paste your Instagram profile link, like https://www.instagram.com/zola_officials_' },
  mkt_tiktok:         { re: /^https:\/\/(www\.)?tiktok\.com\/@\S+$/i, why: 'Paste your TikTok profile link, like https://www.tiktok.com/@zolaofficial' },
  mkt_facebook:       { re: /^https:\/\/(www\.|m\.)?facebook\.com\/\S+$/i, why: 'Paste your Facebook page link, starting https://www.facebook.com/' },
  mkt_referral_reward:{ re: /^.{0,160}$/, why: 'Keep the reward description under 160 characters.' },
};
const DEFAULTS = {
  mkt_instagram: 'https://www.instagram.com/zola_officials_',
  mkt_tiktok: 'https://www.tiktok.com/@zolaofficial',
};

async function settings() {
  const out = Object.assign({}, DEFAULTS);
  try {
    const rows = await query("SELECT key, value FROM site_settings WHERE key LIKE 'mkt_%'");
    for (const r of rows) if (r.value !== null && r.value !== '') out[r.key] = r.value;
  } catch (_) {}
  return out;
}

async function overview() {
  await ensureTables();
  const now = Date.now();
  const out = { email: {}, sms: {}, campaigns: [], coupons: {}, referrals: {}, audience: {}, settings: await settings() };

  // Every lookup starts at once; each is a separate trip to the database,
  // and one after another they took the screen two seconds to fill.
  const safe = p => p.catch(() => null);
  const [mail, campaignRows, promoRows, referrals, members, clients] = await Promise.all([
    safe(queryOne('SELECT SUM(CASE WHEN sent = 1 THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN sent = 0 THEN 1 ELSE 0 END) AS bad FROM mail_log WHERE ts >= ?', [now - 30 * DAY])),
    safe(query(`SELECT id, subject, body, channel, sent_ts, sent_count, failed_count, total_count, status
      FROM campaigns WHERE sent_ts IS NOT NULL ORDER BY sent_ts DESC LIMIT 50`)),
    safe(query('SELECT code, active, used_count FROM promo_codes')),
    referralStats(),
    safe(queryOne("SELECT COUNT(*) AS n FROM members WHERE email IS NOT NULL AND email <> ''")),
    safe(queryOne("SELECT COUNT(DISTINCT LOWER(client_email)) AS n FROM team_appointments WHERE client_email IS NOT NULL AND client_email <> ''")),
  ]);

  out.email = { sent_30d: Number(mail && mail.ok) || 0, failed_30d: Number(mail && mail.bad) || 0 };

  try {
    const rows = campaignRows || [];
    let emailSent = 0, smsSent = 0, emailCampaigns = 0, smsCampaigns = 0;
    for (const c of rows) {
      if (Number(c.sent_ts) < now - 90 * DAY) continue;
      if (String(c.channel || 'email') === 'sms') { smsSent += Number(c.sent_count) || 0; smsCampaigns++; }
      else { emailSent += Number(c.sent_count) || 0; emailCampaigns++; }
    }
    out.email.campaign_recipients_90d = emailSent;
    out.email.campaigns_90d = emailCampaigns;
    out.sms = { sent_90d: smsSent, campaigns_90d: smsCampaigns };
    out.campaigns = rows.slice(0, 5).map(c => ({
      id: Number(c.id), channel: c.channel || 'email',
      title: String(c.subject || c.body || '').replace(/\s+/g, ' ').slice(0, 80),
      sent_ts: Number(c.sent_ts) || 0, sent: Number(c.sent_count) || 0, failed: Number(c.failed_count) || 0,
    }));
  } catch (_) {}

  try {
    if (!promoRows) throw new Error('no promo table');
    const rows = promoRows;
    out.coupons = {
      active: rows.filter(r => Number(r.active)).length,
      total: rows.length,
      uses: rows.reduce((s, r) => s + (Number(r.used_count) || 0), 0),
      top: rows.filter(r => Number(r.used_count) > 0).sort((a, b) => Number(b.used_count) - Number(a.used_count))
        .slice(0, 3).map(r => ({ code: r.code, uses: Number(r.used_count) })),
    };
  } catch (_) { out.coupons = { active: 0, total: 0, uses: 0, top: [] }; }

  out.referrals = referrals;
  out.audience.members_with_email = Number(members && members.n) || 0;
  out.audience.clients_with_email = Number(clients && clients.n) || 0;

  return out;
}

async function referralStats() {
  const out = { members_with_code: 0, total: 0, completed: 0, pending: 0, top: [], recent: [] };
  try {
    const r = await queryOne("SELECT COUNT(*) AS n FROM members WHERE referral_code IS NOT NULL AND referral_code <> ''");
    out.members_with_code = Number(r && r.n) || 0;
  } catch (_) {}
  try {
    const rows = await query(`SELECT r.referrer_member_id, r.referee_email, r.status, r.created_at, m.full_name
        FROM referrals r LEFT JOIN members m ON m.member_id = r.referrer_member_id
       ORDER BY r.created_at DESC LIMIT 200`);
    out.total = rows.length;
    out.completed = rows.filter(r => String(r.status).toUpperCase() === 'COMPLETED').length;
    out.pending = out.total - out.completed;
    const by = {};
    for (const r of rows) {
      const k = r.referrer_member_id;
      by[k] = by[k] || { name: r.full_name || k, count: 0, completed: 0 };
      by[k].count++;
      if (String(r.status).toUpperCase() === 'COMPLETED') by[k].completed++;
    }
    out.top = Object.values(by).sort((a, b) => b.count - a.count).slice(0, 5);
    out.recent = rows.slice(0, 20).map(r => ({
      referrer: r.full_name || r.referrer_member_id, friend: r.referee_email || '', status: r.status, when: r.created_at,
    }));
  } catch (_) {}
  return out;
}

module.exports = async function (req, res) {
  const action = req.query.action || (req.body && req.body.action) || '';
  try {
    // Public: the ad tags every page loads. Cached at the edge for a few
    // minutes so it costs nothing per visit.
    if (action === 'tags') {
      const s = await settings();
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
      return res.json({
        meta_pixel_id: s.mkt_meta_pixel_id || '',
        google_tag_id: s.mkt_google_tag_id || '',
        google_ads_id: s.mkt_google_ads_id || '',
      });
    }

    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

    if (action === 'overview') return res.json(await overview());
    if (action === 'referrals') return res.json(await referralStats());

    if (action === 'save' && req.method === 'POST') {
      const body = (req.body || {}).settings || {};
      const saved = [];
      for (const [k, raw] of Object.entries(body)) {
        const f = FIELDS[k];
        if (!f) continue;
        const v = String(raw == null ? '' : raw).trim();
        if (v && !f.re.test(v)) return res.status(400).json({ error: f.why, field: k });
        await execute('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          [k, k.endsWith('_id') ? v.toUpperCase().replace(/^(\d+)$/, '$1') : v]);
        saved.push(k);
      }
      return res.json({ ok: true, saved, settings: await settings() });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
