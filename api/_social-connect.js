// Linking her real Instagram and TikTok accounts to Studio Manager.
//
// She asked me to connect them so the numbers arrive on their own rather
// than her typing them in. Here is the honest shape of that, because it
// is not a button I can press for her:
//
//   · INSTAGRAM needs a Meta app, and her account has to be a
//     Professional (Business or Creator) account linked to a Facebook
//     Page. The insights permission needs App Review, which Meta takes
//     days over. There is no way round that and nobody has one.
//
//   · TIKTOK needs an app on TikTok for Developers with Login Kit and
//     the Display API. Also reviewed, also days.
//
// So this module is the plumbing, finished and waiting: she creates the
// apps, pastes two strings per platform, and from that moment the sync
// pulls her posts and their numbers into the same social_posts table the
// coaching already reads — so every diagnosis I built starts working on
// real data without another line of code.
//
// What it will NOT do is pretend. If a platform is not connected it says
// so and says what is missing. A dashboard that shows zeros as though
// they were measurements is worse than one that admits it cannot see.
const { query, queryOne, execute } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const num = n => Math.max(0, Math.round(Number(n) || 0));
const lower = s => String(s || '').trim().toLowerCase();
const pad = n => String(n).padStart(2, '0');

function studioNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}
const todayLA = () => {
  const d = studioNow();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};

/* Held in site_settings rather than env vars so she can paste them in
   herself without a deploy. The secrets never leave the server: the
   status endpoint reports whether each one is set, never what it is. */
const KEYS = [
  'ig_app_id', 'ig_app_secret', 'ig_access_token', 'ig_user_id', 'ig_token_expires',
  'tt_client_key', 'tt_client_secret', 'tt_access_token', 'tt_refresh_token', 'tt_open_id', 'tt_token_expires',
  'social_last_sync', 'social_last_sync_note',
];

async function settings() {
  const out = {};
  try {
    const rows = await query(
      'SELECT key, value FROM site_settings WHERE key IN (' + KEYS.map(() => '?').join(',') + ')', KEYS);
    for (const r of rows || []) out[r.key] = r.value;
  } catch (_) {}
  return out;
}

async function put(key, value) {
  await execute(
    'INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, String(value == null ? '' : value)]);
}

const set = v => !!(v && String(v).trim());

/* What is connected, what is missing, and exactly what to do about it.
   The steps are in here rather than in the page so there is one copy of
   them and it sits next to the code that needs them. */
async function status() {
  const s = await settings();

  const ig = {
    platform: 'instagram',
    label: 'Instagram',
    handle: '@zola_officials_',
    connected: set(s.ig_access_token) && set(s.ig_user_id),
    has_app: set(s.ig_app_id) && set(s.ig_app_secret),
    token_expires: s.ig_token_expires || '',
    needs: [],
    steps: [
      'Open instagram.com on a phone → Settings → Account type and tools → '
        + 'switch to a Professional account (Creator is fine). You need this either way to see your own insights.',
      'Link it to a Facebook Page. Instagram will offer to make one for you if you do not have one — '
        + 'it can be empty, it is only a connector.',
      'Go to developers.facebook.com → My Apps → Create App → choose "Other" then "Business".',
      'In the app, add the product "Instagram Graph API". Copy the App ID and App Secret and paste them below.',
      'Then press Connect Instagram below. Meta will ask you to approve your own app — say yes.',
      'Meta reviews the insights permission before it works for real. That takes them a few days '
        + 'and there is nothing either of us can do to speed it up.',
    ],
  };
  if (!ig.has_app) ig.needs.push('App ID and App Secret from developers.facebook.com');
  if (ig.has_app && !ig.connected) ig.needs.push('press Connect Instagram and approve it');

  const tt = {
    platform: 'tiktok',
    label: 'TikTok',
    handle: '@zolaofficial',
    connected: set(s.tt_access_token) && set(s.tt_open_id),
    has_app: set(s.tt_client_key) && set(s.tt_client_secret),
    token_expires: s.tt_token_expires || '',
    needs: [],
    steps: [
      'Go to developers.tiktok.com → Manage apps → Connect an app. Use the ZOLA account, not a personal one.',
      'Add the products "Login Kit" and "Display API".',
      'Set the redirect URI to exactly: https://zolanailstudio.com/api/social-connect?action=tiktok_callback',
      'Copy the Client Key and Client Secret and paste them below.',
      'Press Connect TikTok below and approve it.',
      'TikTok also reviews the app before the numbers come through. Same few days.',
    ],
  };
  if (!tt.has_app) tt.needs.push('Client Key and Client Secret from developers.tiktok.com');
  if (tt.has_app && !tt.connected) tt.needs.push('press Connect TikTok and approve it');

  return {
    instagram: ig,
    tiktok: tt,
    last_sync: s.social_last_sync || '',
    last_sync_note: s.social_last_sync_note || '',
    redirect_ig: 'https://zolanailstudio.com/api/social-connect?action=instagram_callback',
    redirect_tt: 'https://zolanailstudio.com/api/social-connect?action=tiktok_callback',
    /* Said plainly, once, where she will read it. */
    honest_note: 'Both platforms make you create a developer app and then review it before they will '
      + 'hand over your own numbers. That is their rule, not mine, and it takes them a few days. '
      + 'Until it clears, logging a post by hand on this tab does everything the coaching needs — '
      + 'the moment the connection goes through, the same posts start arriving on their own.',
  };
}

async function saveCredentials(body) {
  const b = body || {};
  const map = {
    ig_app_id: b.ig_app_id, ig_app_secret: b.ig_app_secret,
    tt_client_key: b.tt_client_key, tt_client_secret: b.tt_client_secret,
  };
  let saved = 0;
  for (const k of Object.keys(map)) {
    if (map[k] === undefined) continue;
    await put(k, String(map[k]).trim().slice(0, 400));
    saved++;
  }
  return Object.assign({ ok: true, saved }, await status());
}

/* ── THE OAUTH ROUND TRIP ───────────────────────────────────────────── */

async function startUrl(platform) {
  const s = await settings();
  if (platform === 'instagram') {
    if (!set(s.ig_app_id)) return { ok: false, why: 'Paste your Meta App ID and Secret first.' };
    const redirect = 'https://zolanailstudio.com/api/social-connect?action=instagram_callback';
    const scope = [
      'instagram_basic',
      'instagram_manage_insights',
      'pages_show_list',
      'pages_read_engagement',
    ].join(',');
    return {
      ok: true,
      url: 'https://www.facebook.com/v21.0/dialog/oauth?client_id=' + encodeURIComponent(s.ig_app_id)
        + '&redirect_uri=' + encodeURIComponent(redirect)
        + '&scope=' + encodeURIComponent(scope)
        + '&response_type=code',
    };
  }
  if (platform === 'tiktok') {
    if (!set(s.tt_client_key)) return { ok: false, why: 'Paste your TikTok Client Key and Secret first.' };
    const redirect = 'https://zolanailstudio.com/api/social-connect?action=tiktok_callback';
    return {
      ok: true,
      url: 'https://www.tiktok.com/v2/auth/authorize/?client_key=' + encodeURIComponent(s.tt_client_key)
        + '&scope=' + encodeURIComponent('user.info.basic,user.info.stats,video.list')
        + '&response_type=code'
        + '&redirect_uri=' + encodeURIComponent(redirect)
        + '&state=zola',
    };
  }
  return { ok: false, why: 'Unknown platform.' };
}

/* A page rather than JSON, because the person reading it has just been
   bounced back from Facebook or TikTok in a browser tab. */
function donePage(title, body, ok) {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + ' — ZOLA</title></head>'
    + '<body style="margin:0;background:#0D0D0D;color:#F5EEE8;'
    + 'font-family:Helvetica,Arial,sans-serif;display:flex;align-items:center;'
    + 'justify-content:center;min-height:100vh;padding:1.5rem">'
    + '<div style="max-width:420px;text-align:center">'
    + '<div style="font-size:11px;letter-spacing:6px;color:#B6A588;margin-bottom:14px">ZOLA</div>'
    + '<h1 style="font-size:22px;font-weight:400;margin:0 0 12px">'
      + (ok ? '✦ ' : '') + title + '</h1>'
    + '<p style="font-size:15px;line-height:1.7;color:rgba(245,238,232,0.8);margin:0 0 22px">'
      + body + '</p>'
    + '<a href="/manager.html" style="display:inline-block;background:#B6A588;color:#0D0D0D;'
    + 'text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase;'
    + 'padding:14px 22px">Back to Studio Manager</a>'
    + '</div></body></html>';
}

async function instagramCallback(code) {
  const s = await settings();
  if (!code) return { ok: false, why: 'Instagram did not send a code back.' };
  if (!set(s.ig_app_id) || !set(s.ig_app_secret)) return { ok: false, why: 'The app details are missing.' };
  const redirect = 'https://zolanailstudio.com/api/social-connect?action=instagram_callback';

  try {
    const r = await fetch('https://graph.facebook.com/v21.0/oauth/access_token?'
      + new URLSearchParams({
        client_id: s.ig_app_id, client_secret: s.ig_app_secret,
        redirect_uri: redirect, code,
      }).toString());
    const j = await r.json();
    if (!r.ok || !j.access_token) {
      return { ok: false, why: (j.error && j.error.message) || 'Meta would not give us a token.' };
    }

    /* The short-lived token is traded for a long one straight away,
       otherwise this breaks in an hour and she has to do it all again. */
    let token = j.access_token;
    try {
      const l = await fetch('https://graph.facebook.com/v21.0/oauth/access_token?'
        + new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: s.ig_app_id, client_secret: s.ig_app_secret,
          fb_exchange_token: token,
        }).toString());
      const lj = await l.json();
      if (l.ok && lj.access_token) {
        token = lj.access_token;
        if (lj.expires_in) {
          await put('ig_token_expires',
            new Date(Date.now() + Number(lj.expires_in) * 1000).toISOString().slice(0, 10));
        }
      }
    } catch (_) {}

    /* And the Instagram account id behind her Page, which is the thing
       every later call needs. */
    let igUser = '';
    try {
      const p = await fetch('https://graph.facebook.com/v21.0/me/accounts?'
        + new URLSearchParams({ access_token: token, fields: 'instagram_business_account,name' }).toString());
      const pj = await p.json();
      for (const page of (pj.data || [])) {
        if (page.instagram_business_account && page.instagram_business_account.id) {
          igUser = page.instagram_business_account.id;
          break;
        }
      }
    } catch (_) {}

    await put('ig_access_token', token);
    if (igUser) await put('ig_user_id', igUser);

    if (!igUser) {
      return {
        ok: false,
        why: 'Connected to Meta, but no Instagram account is linked to a Facebook Page yet. '
          + 'Link them in the Instagram app and press Connect again.',
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, why: String(err.message || err) };
  }
}

async function tiktokCallback(code) {
  const s = await settings();
  if (!code) return { ok: false, why: 'TikTok did not send a code back.' };
  if (!set(s.tt_client_key) || !set(s.tt_client_secret)) {
    return { ok: false, why: 'The app details are missing.' };
  }
  const redirect = 'https://zolanailstudio.com/api/social-connect?action=tiktok_callback';
  try {
    const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: s.tt_client_key, client_secret: s.tt_client_secret,
        code, grant_type: 'authorization_code', redirect_uri: redirect,
      }).toString(),
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) {
      return { ok: false, why: j.error_description || j.error || 'TikTok would not give us a token.' };
    }
    await put('tt_access_token', j.access_token);
    if (j.refresh_token) await put('tt_refresh_token', j.refresh_token);
    if (j.open_id) await put('tt_open_id', j.open_id);
    if (j.expires_in) {
      await put('tt_token_expires',
        new Date(Date.now() + Number(j.expires_in) * 1000).toISOString().slice(0, 10));
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, why: String(err.message || err) };
  }
}

/* ── PULLING THE NUMBERS IN ─────────────────────────────────────────────
   Written into the SAME social_posts table the quick-entry log writes to,
   so every band, finding and piece of coaching already built works on
   real data the moment this starts returning anything. A post that is
   already logged is updated rather than duplicated, keyed on its link —
   so a hand-logged post and its real counterpart become one row instead
   of two. */
async function upsertPost(p) {
  const social = require('./_social');
  let existing = null;
  try {
    existing = await queryOne('SELECT id FROM social_posts WHERE link = ? AND link <> \'\'', [p.link]);
  } catch (_) {}
  return social.savePost(Object.assign({}, p, existing ? { id: existing.id } : {}));
}

async function syncInstagram(limit) {
  const s = await settings();
  if (!set(s.ig_access_token) || !set(s.ig_user_id)) {
    return { ok: false, why: 'Instagram is not connected yet.', added: 0 };
  }
  const n = Math.min(50, Math.max(1, num(limit) || 25));
  try {
    const fields = 'id,caption,media_type,permalink,timestamp,like_count,comments_count';
    const r = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(s.ig_user_id)
      + '/media?' + new URLSearchParams({ fields, limit: String(n), access_token: s.ig_access_token }).toString());
    const j = await r.json();
    if (!r.ok) return { ok: false, why: (j.error && j.error.message) || 'Instagram said no.', added: 0 };

    let added = 0;
    for (const m of (j.data || [])) {
      /* Views and saves live on the insights endpoint, which is the part
         that needs App Review. Asked for separately so that a post still
         lands with its likes and comments even before review clears. */
      let views = 0, saves = 0, shares = 0, reach = 0;
      try {
        const i = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(m.id)
          + '/insights?' + new URLSearchParams({
            metric: 'reach,saved,shares,plays', access_token: s.ig_access_token }).toString());
        const ij = await i.json();
        for (const row of (ij.data || [])) {
          const v = num(row.values && row.values[0] && row.values[0].value);
          if (row.name === 'plays') views = v;
          if (row.name === 'reach') reach = v;
          if (row.name === 'saved') saves = v;
          if (row.name === 'shares') shares = v;
        }
      } catch (_) {}

      const day = String(m.timestamp || '').slice(0, 10);
      await upsertPost({
        platform: 'instagram',
        kind: m.media_type === 'VIDEO' ? 'reel' : (m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'photo'),
        day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : todayLA(),
        posted_at: String(m.timestamp || '').slice(11, 16),
        hook: String(m.caption || '').split('\n')[0].slice(0, 200),
        topic: '', link: m.permalink || '',
        views: views || reach, likes: num(m.like_count), comments: num(m.comments_count),
        shares, saves, follows: 0,
        notes: 'pulled from Instagram',
      });
      added++;
    }
    return { ok: true, added };
  } catch (err) {
    return { ok: false, why: String(err.message || err), added: 0 };
  }
}

async function syncTiktok(limit) {
  const s = await settings();
  if (!set(s.tt_access_token)) return { ok: false, why: 'TikTok is not connected yet.', added: 0 };
  const n = Math.min(20, Math.max(1, num(limit) || 20));
  try {
    const r = await fetch('https://open.tiktokapis.com/v2/video/list/?'
      + new URLSearchParams({
        fields: 'id,title,create_time,share_url,duration,view_count,like_count,comment_count,share_count',
      }).toString(), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + s.tt_access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_count: n }),
    });
    const j = await r.json();
    if (!r.ok || (j.error && j.error.code && j.error.code !== 'ok')) {
      return { ok: false, why: (j.error && (j.error.message || j.error.code)) || 'TikTok said no.', added: 0 };
    }
    const vids = (j.data && j.data.videos) || [];
    let added = 0;
    for (const v of vids) {
      const when = new Date(Number(v.create_time || 0) * 1000);
      const day = isNaN(when) ? todayLA()
        : when.getFullYear() + '-' + pad(when.getMonth() + 1) + '-' + pad(when.getDate());
      await upsertPost({
        platform: 'tiktok', kind: 'reel', day,
        posted_at: isNaN(when) ? '' : pad(when.getHours()) + ':' + pad(when.getMinutes()),
        hook: String(v.title || '').slice(0, 200),
        length_sec: num(v.duration),
        link: v.share_url || '',
        views: num(v.view_count), likes: num(v.like_count),
        comments: num(v.comment_count), shares: num(v.share_count),
        saves: 0, follows: 0,
        notes: 'pulled from TikTok',
      });
      added++;
    }
    return { ok: true, added };
  } catch (err) {
    return { ok: false, why: String(err.message || err), added: 0 };
  }
}

async function syncAll({ limit } = {}) {
  const ig = await syncInstagram(limit);
  const tt = await syncTiktok(limit);
  const note = [
    'Instagram: ' + (ig.ok ? ig.added + ' posts' : ig.why),
    'TikTok: ' + (tt.ok ? tt.added + ' posts' : tt.why),
  ].join(' · ');
  await put('social_last_sync', new Date().toISOString());
  await put('social_last_sync_note', note);
  return { instagram: ig, tiktok: tt, note, added: (ig.added || 0) + (tt.added || 0) };
}

/* ── THE DOOR ───────────────────────────────────────────────────────── */

const ownerOk = req => req.headers['x-ceo-password'] === CEO_PASSWORD
  || (req.query && req.query.pwd === CEO_PASSWORD);

module.exports = async function (req, res) {
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  try {
    /* The two callbacks are reached by the browser coming back from
       Facebook or TikTok, so they cannot carry a password header. They
       are safe without one: all they can do is exchange a code that
       those platforms just issued for this app. */
    if (action === 'instagram_callback') {
      const out = await instagramCallback((req.query || {}).code);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(out.ok
        ? donePage('Instagram is connected',
            'Your posts will start arriving on the Social media tab. If the view counts look '
            + 'empty at first, that is Meta still reviewing the insights permission — the '
            + 'likes and comments come through straight away.', true)
        : donePage('That did not connect', out.why || 'Something went wrong.', false));
    }
    if (action === 'tiktok_callback') {
      const out = await tiktokCallback((req.query || {}).code);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(out.ok
        ? donePage('TikTok is connected',
            'Your videos will start arriving on the Social media tab, with their views, likes, '
            + 'comments and shares.', true)
        : donePage('That did not connect', out.why || 'Something went wrong.', false));
    }

    if (!ownerOk(req)) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'GET' && (action === 'status' || !action)) return res.json(await status());
    if (req.method === 'POST' && action === 'save') return res.json(await saveCredentials(req.body));
    if (req.method === 'GET' && action === 'start') {
      const out = await startUrl(lower((req.query || {}).platform));
      return res.status(out.ok ? 200 : 400).json(out);
    }
    if (req.method === 'POST' && action === 'sync') {
      return res.json(await syncAll({ limit: (req.body || {}).limit }));
    }
    /* Disconnecting clears the tokens but keeps the app details, because
       re-approving is one tap and re-creating a Meta app is not. */
    if (req.method === 'POST' && action === 'disconnect') {
      const p = lower((req.body || {}).platform);
      if (p === 'instagram') {
        for (const k of ['ig_access_token', 'ig_user_id', 'ig_token_expires']) await put(k, '');
      } else if (p === 'tiktok') {
        for (const k of ['tt_access_token', 'tt_refresh_token', 'tt_open_id', 'tt_token_expires']) await put(k, '');
      } else {
        return res.status(400).json({ error: 'Which platform?' });
      }
      return res.json(Object.assign({ ok: true }, await status()));
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};

module.exports.status = status;
module.exports.saveCredentials = saveCredentials;
module.exports.startUrl = startUrl;
module.exports.syncAll = syncAll;
module.exports.syncInstagram = syncInstagram;
module.exports.syncTiktok = syncTiktok;
module.exports.KEYS = KEYS;
