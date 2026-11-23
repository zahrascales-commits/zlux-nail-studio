// Instagram and TikTok, inside Studio Manager.
//
// Her goal, in her words: 10,000 views on every video, 100,000 as the
// normal number, and 10,000 followers inside three months.
//
// One thing has to be said plainly, once, and then this module gets on
// with the job. Nobody can guarantee a view count. Not me, not an agency,
// not anyone selling a course — distribution is decided by a system none
// of us controls, and anyone promising a number is selling something. So
// this is not a promise generator. It is the next best thing, which is
// also the only thing that has ever actually worked:
//
//   · measure every post, so "it flopped" becomes a number with a cause
//   · diagnose each one against HER OWN median, not an industry average,
//     because a 3,000-view video is a disaster for one account and a
//     triumph for another
//   · say what to do next, specifically, on that video
//   · do the arithmetic on the follower goal out loud, so she can see
//     exactly what volume it requires instead of hoping
//
// That last one matters more than any tip. 10,000 new followers needs
// roughly 500,000 to a million views, because a strong account converts
// 1-2% of viewers into followers. Over 90 days that is 5,500-11,000 views
// a day. One post a day means every post has to average 10,000 — which is
// exactly the bar she set, and it is a brutal bar. Two posts a day halves
// it to 5,000 each. Three halves it again. The volume is the lever she
// fully controls, and it is the one the maths is most sensitive to. That
// is a real answer, and it is in planFor() below rather than in a pep talk.
const { query, queryOne, execute } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const num = n => Math.max(0, Math.round(Number(n) || 0));
const lower = s => String(s || '').trim().toLowerCase();
const pad = n => String(n).padStart(2, '0');
const pct1 = x => Math.round(x * 10) / 10;
const commas = n => Number(n || 0).toLocaleString('en-US');

function studioNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}
const todayLA = () => { const d = studioNow(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const shift = (ymd, n) =>
  new Date(Date.parse(String(ymd) + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const PLATFORMS = { tiktok: 'TikTok', instagram: 'Instagram' };
const KINDS = {
  reel: 'Reel / short video', carousel: 'Carousel', photo: 'Single photo',
  story: 'Story', live: 'Live',
};

/* The handles already live in Studio Manager's marketing settings, so they
   are read from there rather than kept twice and allowed to drift. */
const SETTING_KEYS = [
  'mkt_instagram', 'mkt_tiktok',
  'social_ig_followers', 'social_tt_followers', 'social_followers_asof',
  'social_goal_followers', 'social_goal_by', 'social_posts_per_day',
];
const DEFAULT_IG = 'https://www.instagram.com/zola_officials_';
const DEFAULT_TT = 'https://www.tiktok.com/@zolaofficial';

let _ready = null;
async function ensure() {
  if (_ready) return _ready;
  _ready = (async () => {
    await execute(`CREATE TABLE IF NOT EXISTS social_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT DEFAULT 'tiktok',
      kind TEXT DEFAULT 'reel',
      day TEXT DEFAULT '',
      posted_at TEXT DEFAULT '',
      hook TEXT DEFAULT '',
      topic TEXT DEFAULT '',
      sound TEXT DEFAULT '',
      trending_sound INTEGER DEFAULT 0,
      length_sec INTEGER DEFAULT 0,
      showed_result_first INTEGER DEFAULT 0,
      had_link INTEGER DEFAULT 0,
      face_or_voice INTEGER DEFAULT 0,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0,
      saves INTEGER DEFAULT 0,
      follows INTEGER DEFAULT 0,
      link TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      posted_by TEXT DEFAULT '',
      ts INTEGER
    )`);
    try { await execute('CREATE INDEX IF NOT EXISTS social_posts_day ON social_posts (day)'); } catch (_) {}
    try { await execute('CREATE INDEX IF NOT EXISTS social_posts_plat ON social_posts (platform)'); } catch (_) {}

    /* Who posted the booking link on which day. Separate from the post log
       on purpose: Brianna ticking "posted" is a promise kept, and does not
       require her to know the view count yet. */
    await execute(`CREATE TABLE IF NOT EXISTS posting_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      who TEXT DEFAULT '',
      member_id INTEGER DEFAULT 0,
      day TEXT DEFAULT '',
      platform TEXT DEFAULT '',
      link TEXT DEFAULT '',
      nudged_ts INTEGER DEFAULT 0,
      done_ts INTEGER DEFAULT 0,
      ts INTEGER
    )`);
    try { await execute('CREATE UNIQUE INDEX IF NOT EXISTS posting_log_once ON posting_log (member_id, day)'); } catch (_) {}
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

async function settings() {
  const out = {};
  try {
    const rows = await query(
      'SELECT key, value FROM site_settings WHERE key IN (' + SETTING_KEYS.map(() => '?').join(',') + ')',
      SETTING_KEYS);
    for (const r of rows || []) out[r.key] = r.value;
  } catch (_) {}

  const igUrl = out.mkt_instagram || DEFAULT_IG;
  const ttUrl = out.mkt_tiktok || DEFAULT_TT;
  const handleOf = (url, at) => {
    const m = String(url).replace(/\/+$/, '').split('/').pop() || '';
    return (at ? '@' : '@') + m.replace(/^@/, '');
  };

  return {
    instagram: { url: igUrl, handle: handleOf(igUrl), followers: num(out.social_ig_followers) },
    tiktok: { url: ttUrl, handle: handleOf(ttUrl), followers: num(out.social_tt_followers) },
    followers_asof: out.social_followers_asof || '',
    goal_followers: num(out.social_goal_followers) || 10000,
    goal_by: out.social_goal_by || shift(todayLA(), 90),
    posts_per_day: Math.max(1, num(out.social_posts_per_day) || 1),
    /* Said in the data, not only in a comment, because the screen repeats
       it where she will actually read it. */
    honest_note: 'Nobody can guarantee a view count — distribution is not '
      + 'something you or I control. What this can do is tell you exactly why each post did what '
      + 'it did, what to change on the next one, and what volume your follower goal actually '
      + 'requires. That is the whole of what honest help looks like here.',
  };
}

async function saveSettings(body) {
  await ensure();
  const put = async (k, v) => {
    try {
      await execute(
        'INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        [k, String(v)]);
    } catch (_) {}
  };
  if (body.instagram_url) await put('mkt_instagram', String(body.instagram_url).trim().slice(0, 300));
  if (body.tiktok_url) await put('mkt_tiktok', String(body.tiktok_url).trim().slice(0, 300));
  if (body.ig_followers !== undefined) await put('social_ig_followers', num(body.ig_followers));
  if (body.tt_followers !== undefined) await put('social_tt_followers', num(body.tt_followers));
  if (body.ig_followers !== undefined || body.tt_followers !== undefined) {
    await put('social_followers_asof', todayLA());
  }
  if (body.goal_followers !== undefined) await put('social_goal_followers', num(body.goal_followers));
  if (body.goal_by) await put('social_goal_by', String(body.goal_by).slice(0, 10));
  if (body.posts_per_day !== undefined) await put('social_posts_per_day', Math.max(1, num(body.posts_per_day)));
  return { ok: true, settings: await settings() };
}

/* ── THE POST LOG ───────────────────────────────────────────────────── */

function postShape(r) {
  const views = num(r.views);
  const eng = num(r.likes) + num(r.comments) + num(r.shares) + num(r.saves);
  return {
    id: Number(r.id),
    platform: lower(r.platform) || 'tiktok',
    platform_label: PLATFORMS[lower(r.platform)] || 'TikTok',
    kind: r.kind || 'reel',
    kind_label: KINDS[r.kind] || 'Reel / short video',
    day: r.day || '',
    posted_at: r.posted_at || '',
    hook: r.hook || '',
    topic: r.topic || '',
    sound: r.sound || '',
    trending_sound: !!Number(r.trending_sound),
    length_sec: num(r.length_sec),
    showed_result_first: !!Number(r.showed_result_first),
    had_link: !!Number(r.had_link),
    face_or_voice: !!Number(r.face_or_voice),
    views,
    likes: num(r.likes), comments: num(r.comments),
    shares: num(r.shares), saves: num(r.saves), follows: num(r.follows),
    link: r.link || '', notes: r.notes || '',
    posted_by: r.posted_by || '',
    ts: Number(r.ts) || 0,
    // The rates that actually decide distribution, per thousand views so a
    // small post and a big one can be compared at all.
    engagement_pct: views ? pct1((eng / views) * 100) : 0,
    save_rate_pct: views ? pct1((num(r.saves) / views) * 100) : 0,
    share_rate_pct: views ? pct1((num(r.shares) / views) * 100) : 0,
    comment_rate_pct: views ? pct1((num(r.comments) / views) * 100) : 0,
    follows_per_1k: views ? pct1((num(r.follows) / views) * 1000) : 0,
  };
}

const FIELDS = ['platform', 'kind', 'day', 'posted_at', 'hook', 'topic', 'sound',
  'trending_sound', 'length_sec', 'showed_result_first', 'had_link', 'face_or_voice',
  'views', 'likes', 'comments', 'shares', 'saves', 'follows', 'link', 'notes', 'posted_by'];

async function savePost(body) {
  await ensure();
  const b = body || {};
  const vals = {
    platform: PLATFORMS[lower(b.platform)] ? lower(b.platform) : 'tiktok',
    kind: KINDS[b.kind] ? b.kind : 'reel',
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(b.day)) ? String(b.day) : todayLA(),
    posted_at: String(b.posted_at || '').slice(0, 5),
    hook: String(b.hook || '').trim().slice(0, 200),
    topic: String(b.topic || '').trim().slice(0, 120),
    sound: String(b.sound || '').trim().slice(0, 160),
    trending_sound: b.trending_sound ? 1 : 0,
    length_sec: Math.min(3600, num(b.length_sec)),
    showed_result_first: b.showed_result_first ? 1 : 0,
    had_link: b.had_link ? 1 : 0,
    face_or_voice: b.face_or_voice ? 1 : 0,
    views: num(b.views), likes: num(b.likes), comments: num(b.comments),
    shares: num(b.shares), saves: num(b.saves), follows: num(b.follows),
    link: String(b.link || '').trim().slice(0, 400),
    notes: String(b.notes || '').trim().slice(0, 600),
    posted_by: String(b.posted_by || '').trim().slice(0, 60),
  };

  const id = Number(b.id) || 0;
  if (id) {
    await execute('UPDATE social_posts SET ' + FIELDS.map(k => k + '=?').join(', ') + ' WHERE id=?',
      FIELDS.map(k => vals[k]).concat([id]));
    const row = await queryOne('SELECT * FROM social_posts WHERE id=?', [id]);
    return { ok: true, post: row ? await withCoaching(postShape(row)) : null };
  }

  await execute(
    'INSERT INTO social_posts (' + FIELDS.join(', ') + ', ts) VALUES ('
    + FIELDS.map(() => '?').join(',') + ',?)',
    FIELDS.map(k => vals[k]).concat([Date.now()]));
  const row = await queryOne('SELECT * FROM social_posts ORDER BY id DESC LIMIT 1');
  return { ok: true, post: row ? await withCoaching(postShape(row)) : null };
}

async function deletePost(id) {
  await ensure();
  await execute('DELETE FROM social_posts WHERE id=?', [Number(id) || 0]);
  return { ok: true };
}

async function allPosts({ days, platform, limit } = {}) {
  await ensure();
  const back = Math.min(400, Math.max(1, num(days) || 120));
  const args = [shift(todayLA(), -back)];
  let sql = 'SELECT * FROM social_posts WHERE day >= ?';
  if (PLATFORMS[lower(platform)]) { sql += ' AND platform = ?'; args.push(lower(platform)); }
  sql += ' ORDER BY day DESC, id DESC LIMIT ?';
  args.push(Math.min(500, Math.max(1, num(limit) || 200)));
  let rows = [];
  try { rows = await query(sql, args); } catch (_) {}
  return (rows || []).map(postShape);
}

/* ── HER OWN BASELINE ───────────────────────────────────────────────────
   Everything below is judged against her median, not an industry figure.
   The median rather than the average on purpose: one 90,000-view video
   would drag an average up until every other post looked like a failure,
   which is both wrong and demoralising. */
function baselineOf(posts) {
  const withViews = posts.filter(p => p.views > 0);
  const sorted = withViews.map(p => p.views).sort((a, b) => a - b);
  const median = sorted.length
    ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
      : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2))
    : 0;
  const best = withViews.reduce((m, p) => (p.views > (m ? m.views : -1) ? p : m), null);
  const sum = k => withViews.reduce((s, p) => s + p[k], 0);
  const totalViews = sum('views');
  return {
    posts: posts.length,
    measured: withViews.length,
    median_views: median,
    mean_views: withViews.length ? Math.round(totalViews / withViews.length) : 0,
    best_views: best ? best.views : 0,
    best_id: best ? best.id : 0,
    total_views: totalViews,
    total_follows: sum('follows'),
    engagement_pct: totalViews ? pct1((
      (sum('likes') + sum('comments') + sum('shares') + sum('saves')) / totalViews) * 100) : 0,
    save_rate_pct: totalViews ? pct1((sum('saves') / totalViews) * 100) : 0,
    share_rate_pct: totalViews ? pct1((sum('shares') / totalViews) * 100) : 0,
    follows_per_1k: totalViews ? pct1((sum('follows') / totalViews) * 1000) : 0,
  };
}

/* ── THE DIAGNOSIS ──────────────────────────────────────────────────────
   Six bands, each with its own cause and its own fix. The bands are set
   against her median so they move as she grows: a tool that still calls
   4,000 views a hit once her normal is 40,000 is a tool that stops being
   useful at exactly the point she starts winning. */
const BANDS = [
  { key: 'flop',       label: 'Flopped',              min: 0,    max: 0.4 },
  { key: 'under',      label: 'Under your normal',    min: 0.4,  max: 0.9 },
  { key: 'normal',     label: 'About your normal',    min: 0.9,  max: 2 },
  { key: 'climbing',   label: 'Pushed past your normal', min: 2, max: 5 },
  { key: 'nearly',     label: 'Nearly took off',      min: 5,    max: 15 },
  { key: 'hit',        label: 'Took off',             min: 15,   max: Infinity },
];

function bandFor(views, median) {
  if (!median) return views >= 10000 ? BANDS[5] : (views >= 2000 ? BANDS[2] : BANDS[0]);
  const r = views / median;
  return BANDS.find(b => r >= b.min && r < b.max) || BANDS[0];
}

/* What to actually do, decided from the numbers on THIS post rather than a
   list of general tips. Each item says the reason, because a fix she does
   not believe is a fix she does not do. */
function coachFor(p, base, cfg) {
  const median = base.median_views || 0;
  const band = bandFor(p.views, median);
  const ratio = median ? Math.round((p.views / median) * 100) / 100 : null;
  const fixes = [];
  const add = (what, why, size) => fixes.push({ what, why, size: size || 'medium' });

  const goalViews = 10000;

  /* ── the mechanical faults, checked on every post ── */
  if (p.length_sec && p.length_sec > 15 && p.views < goalViews) {
    add('Cut it to under 10 seconds',
      'It ran ' + p.length_sec + 's. The thing the algorithm actually measures is whether people '
      + 'finish and re-watch, and a short clip that loops twice beats a long one people leave at '
      + 'three seconds. Nail content is the easiest thing in the world to cut short.', 'big');
  }
  if (!p.showed_result_first) {
    add('Put the finished nails in the very first frame',
      'This post did not open on the result. Nobody waits to find out whether it is worth '
      + 'watching — show the payoff, then the process. This is the single most common reason '
      + 'a good set gets no views.', 'big');
  }
  if (!p.hook) {
    add('Put 3 to 7 words of text on screen',
      'There was no hook logged. The caption is not the hook — most people never read it. '
      + 'Text on the video, readable in half a second, is what stops the scroll.', 'big');
  } else if (p.hook.split(/\s+/).length > 9) {
    add('Shorten the hook to under 7 words',
      '"' + p.hook + '" is ' + p.hook.split(/\s+/).length + ' words. Nobody reads a sentence '
      + 'while scrolling. Say the promise, not the explanation.', 'medium');
  }
  if (!p.trending_sound && p.platform === 'tiktok') {
    add('Use a trending sound, quiet, under your own audio',
      'No trending sound on this one. It is not magic, but it is free reach — the sound page is '
      + 'a second place the video can be found.', 'small');
  }
  if (!p.had_link) {
    add('Put the booking link where it can be acted on',
      'This post had no route to booking. Views that cannot become an appointment are a '
      + 'compliment, not income — and for you the whole point of the views is the chair.', 'medium');
  }
  if (!p.face_or_voice) {
    add('Show your face or use your own voice',
      'Hands-only content is interchangeable; there are thousands of accounts posting hands. '
      + 'You are the thing nobody else has. An account that never shows a person is much harder '
      + 'to follow, which is why saves can be high and follows low.', 'big');
  }

  /* ── and then the band-specific advice ── */
  if (band.key === 'flop') {
    add('Re-cut this exact footage and post it again in 48 hours',
      'A flop is almost never a bad set — it is a bad first second. You already have the '
      + 'footage, so this costs you nothing: new first frame, new hook, under 10 seconds. '
      + 'Reposting a re-edit is normal and expected, not cheating.', 'big');
    if (base.measured >= 5) {
      add('Post it at ' + bestHourText(base) + ' instead',
        'Your own logged posts do better at that time. It is the cheapest change on this list.', 'small');
    }
    add('Send it to 10 people in DMs the hour it goes up',
      'Early watch time is what decides whether it gets shown to strangers at all. Ten people '
      + 'who will definitely watch is a real push, and it is free.', 'medium');
  }

  if (band.key === 'under') {
    add('Keep the set, change the opening',
      'It reached ' + commas(p.views) + ' against your normal of ' + commas(median)
      + '. The work was fine; fewer people got far enough in to see it. Re-cut the first '
      + 'two seconds and post the same nails as a different video.', 'big');
  }

  if (band.key === 'climbing' || band.key === 'nearly') {
    /* This is her "went viral but not totally" case. The video found new
       people; something stopped it going further. Which thing is in the
       rates, so say which. */
    add('Post part 2 within 24 hours, while this one is still being pushed',
      'This did ' + commas(p.views) + ', which is ' + ratio + '× your normal. When one '
      + 'video is travelling, the next one goes out to the audience it just found. Waiting a '
      + 'week throws that away — this is the single biggest thing most people get wrong '
      + 'with a video that nearly took off.', 'big');
    add('Answer every comment in the first hour, and reply with a video to the best one',
      'Comments are a distribution signal, not just manners. A video reply is a new post that '
      + 'inherits the attention of this one.', 'big');

    if (p.views && p.save_rate_pct < 1) {
      add('Give the next one a reason to be saved',
        'Save rate here was ' + p.save_rate_pct + '% — people watched and had no reason to '
        + 'keep it. Saves are what tell the algorithm it has lasting value. Make it something '
        + 'worth keeping: the aftercare, the 5 shapes compared, what to ask your tech for.', 'big');
    }
    if (p.views && p.share_rate_pct < 0.5) {
      add('Build in a reason to send it to someone',
        'Share rate was ' + p.share_rate_pct + '%. Shares reach people who do not follow you at '
        + 'all, and that is where new followers come from. "Send this to whoever does your '
        + 'nails" works because it gives them a person to send it to.', 'big');
    }
    if (p.views && p.follows_per_1k < 2) {
      add('Make it obvious what following you gets them',
        'This brought ' + p.follows + ' followers from ' + commas(p.views) + ' views ('
        + p.follows_per_1k + ' per thousand). A strong account runs 10 to 20 per thousand. '
        + 'People follow a series, not a nice set — so make this one episode of something '
        + 'with a name, and say the name out loud in the video.', 'big');
    }
  }

  if (band.key === 'hit') {
    add('Make the next three videos the same shape as this one',
      'This did ' + commas(p.views) + '. Do not move on to a new idea — that is the '
      + 'mistake. Same hook pattern, same length, same opening, different nails.', 'big');
    add('Pin it, and put the booking link in the first comment',
      'Everyone who arrives at your profile from this will see the pinned video first. That is '
      + 'the moment the views turn into bookings.', 'big');
  }

  if (band.key === 'normal' && p.views < goalViews) {
    add('Change one thing only on the next one',
      'You are sitting at your normal, which means nothing is broken and nothing is pushing '
      + 'either. Change ONE variable at a time — first frame, or length, or hook — or '
      + 'you will never know which one moved it.', 'medium');
  }

  /* The thing she is uniquely able to do, and the only genuinely unfair
     advantage in this account. Raised whenever a post did not reach the
     bar and was not already about it. */
  if (p.views < goalViews && !/celeb|famous|artist|singer|rapper|tour|stage|red carpet/i.test(p.topic + ' ' + p.hook)) {
    add('Use the celebrity work',
      'You do celebrity nails. Almost nobody posting nail content can say that, and it is the '
      + 'one thing on your account that cannot be copied. A set on a known person is a '
      + 'different category of reach from a set on an anonymous hand — even told as '
      + '"what I packed", "what she asked for", "what it is like backstage", with no name named.', 'big');
  }

  return {
    band: band.key,
    band_label: band.label,
    ratio,
    vs_median: median ? commas(p.views) + ' against your normal of ' + commas(median) : '',
    to_goal: Math.max(0, goalViews - p.views),
    verdict: verdictFor(band, p, median, cfg),
    fixes: fixes.slice(0, 7),
  };
}

function bestHourText(base) {
  return base.best_hour || 'your best logged time';
}

function verdictFor(band, p, median, cfg) {
  const goal = 10000;
  if (band.key === 'flop') {
    return 'This one did not travel. That is a first-second problem far more often than a nail '
      + 'problem, and the footage is still good — re-cut it and send it out again. '
      + 'Getting this from ' + commas(p.views) + ' to 4,000 or 5,000 is a realistic ask from a '
      + 'better opening and a shorter cut; getting it to 10,000 is not something anyone can '
      + 'promise you, on this video or any other.';
  }
  if (band.key === 'under') {
    return 'Slightly below where you normally land. Nothing is wrong — the opening did not '
      + 'hold people. Same set, new first two seconds.';
  }
  if (band.key === 'normal') {
    return 'Your normal. Normal is how you get to ' + commas(goal) + ' — by posting at this '
      + 'rate and changing one thing at a time until something jumps.';
  }
  if (band.key === 'climbing') {
    return 'This one pushed past your normal, which means it found people who do not follow you. '
      + 'The next 24 hours matter more than the video did: post the follow-up now.';
  }
  if (band.key === 'nearly') {
    return 'This nearly went. It reached new people and then stopped, and the numbers below say '
      + 'where it stopped. Follow it today, not next week.';
  }
  return 'This one went. Do it again, the same shape, three more times.';
}

async function withCoaching(p) {
  const posts = await allPosts({ days: 180 });
  const base = baselineOf(posts.filter(x => x.id !== p.id));
  const cfg = await settings();
  return Object.assign({}, p, { coaching: coachFor(p, base, cfg) });
}

/* ── THE ARITHMETIC OF THE GOAL ─────────────────────────────────────────
   The part that is actually useful about a big target: what it requires.
   Her own conversion rate is used once there is enough data to have one,
   and a conservative industry band before that — stated as an assumption,
   because a plan built on a number she cannot see is a plan she cannot
   check. */
function planFor(base, cfg) {
  const now = num(cfg.instagram.followers) + num(cfg.tiktok.followers);
  const goal = num(cfg.goal_followers) || 10000;
  const need = Math.max(0, goal - now);
  const today = todayLA();
  const days = Math.max(1, Math.round((Date.parse(cfg.goal_by + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000));

  /* Followers per thousand views. Hers if she has logged enough to have
     one, otherwise the conservative end of what a strong account does. */
  const ownRate = base.measured >= 8 && base.total_views >= 20000 ? base.follows_per_1k : 0;
  const rate = ownRate || 10;
  const rateSource = ownRate
    ? 'your own logged posts (' + ownRate + ' followers per 1,000 views)'
    : 'a conservative 10 followers per 1,000 views, which is what a strong account does — '
      + 'log 8 posts with their numbers and this switches to your real rate';

  const viewsNeeded = Math.round((need / rate) * 1000);
  const viewsPerDay = Math.ceil(viewsNeeded / days);
  const perDay = Math.max(1, num(cfg.posts_per_day) || 1);
  const perPost = Math.ceil(viewsPerDay / perDay);

  const options = [1, 2, 3].map(n => ({
    posts_per_day: n,
    views_per_post: Math.ceil(viewsPerDay / n),
    posts_total: n * days,
  }));

  return {
    followers_now: now,
    goal, need, days, goal_by: cfg.goal_by,
    rate_per_1k: rate, rate_source: rateSource,
    views_needed: viewsNeeded,
    views_per_day: viewsPerDay,
    posts_per_day: perDay,
    views_per_post_needed: perPost,
    options,
    /* The honest headline. It does not say she will get there; it says
       what getting there costs, which is the thing she can act on. */
    said: need === 0
      ? 'You are already there.'
      : commas(need) + ' more followers in ' + days + ' days needs roughly '
        + commas(viewsNeeded) + ' views — about ' + commas(viewsPerDay) + ' a day. '
        + 'At ' + perDay + ' post' + (perDay === 1 ? '' : 's') + ' a day that is '
        + commas(perPost) + ' views a post. At ' + (perDay + 1) + ' a day it drops to '
        + commas(Math.ceil(viewsPerDay / (perDay + 1))) + '. '
        + 'Volume is the one part of this you fully control, and it is what the maths is most '
        + 'sensitive to.',
  };
}

/* ── WHAT THE LOG ADDS UP TO ────────────────────────────────────────── */

async function analytics({ days, platform } = {}) {
  await ensure();
  const back = Math.min(400, Math.max(7, num(days) || 90));
  const posts = await allPosts({ days: back, platform });
  const cfg = await settings();
  const base = baselineOf(posts);

  /* The best hour she has actually posted at, so the advice to "post at a
     better time" names one instead of waving at the idea. */
  const byHour = {};
  for (const p of posts) {
    if (!p.posted_at || !p.views) continue;
    const h = String(p.posted_at).slice(0, 2);
    (byHour[h] = byHour[h] || []).push(p.views);
  }
  let bestHour = '', bestHourAvg = 0;
  for (const h of Object.keys(byHour)) {
    if (byHour[h].length < 2) continue;
    const avg = byHour[h].reduce((s, v) => s + v, 0) / byHour[h].length;
    if (avg > bestHourAvg) { bestHourAvg = avg; bestHour = h; }
  }
  base.best_hour = bestHour ? (Number(bestHour) % 12 || 12) + (Number(bestHour) < 12 ? 'am' : 'pm') : '';
  base.best_hour_avg = Math.round(bestHourAvg);

  /* What the log says works, rather than what anybody thinks works. Only
     reported once there are enough posts on both sides to mean anything —
     two posts proving a theory is a coincidence with a chart. */
  const compare = (name, test) => {
    const yes = posts.filter(p => p.views && test(p));
    const no = posts.filter(p => p.views && !test(p));
    if (yes.length < 3 || no.length < 3) return null;
    const avg = a => Math.round(a.reduce((s, p) => s + p.views, 0) / a.length);
    return { name, with_it: avg(yes), without_it: avg(no), n_with: yes.length, n_without: no.length,
      lift_pct: avg(no) ? pct1(((avg(yes) - avg(no)) / avg(no)) * 100) : null };
  };
  const findings = [
    compare('Result in the first frame', p => p.showed_result_first),
    compare('Under 10 seconds', p => p.length_sec > 0 && p.length_sec < 10),
    compare('Your face or voice in it', p => p.face_or_voice),
    compare('A trending sound', p => p.trending_sound),
    compare('A hook under 7 words', p => p.hook && p.hook.split(/\s+/).length < 7),
  ].filter(Boolean);

  const banded = {};
  for (const p of posts) {
    const b = bandFor(p.views, base.median_views);
    banded[b.key] = (banded[b.key] || 0) + 1;
  }

  /* Posting rhythm: how many days in the window carried a post at all.
     Consistency is the thing her goal is most sensitive to, so it gets a
     number rather than a nudge. */
  const daysWithPost = new Set(posts.map(p => p.day)).size;

  return {
    settings: cfg,
    baseline: base,
    plan: planFor(base, cfg),
    posts: posts.map(p => Object.assign({}, p, {
      band: bandFor(p.views, base.median_views).key,
      band_label: bandFor(p.views, base.median_views).label,
    })),
    bands: BANDS.map(b => ({ key: b.key, label: b.label, count: banded[b.key] || 0 })),
    findings,
    rhythm: {
      window_days: back,
      days_with_a_post: daysWithPost,
      posts: posts.length,
      posts_per_day: Math.round((posts.length / back) * 100) / 100,
      consistency_pct: Math.round((daysWithPost / back) * 100),
    },
    platforms: Object.keys(PLATFORMS).map(k => ({ key: k, label: PLATFORMS[k] })),
    kinds: Object.keys(KINDS).map(k => ({ key: k, label: KINDS[k] })),
  };
}

async function postWithCoaching(id) {
  await ensure();
  const row = await queryOne('SELECT * FROM social_posts WHERE id=?', [Number(id) || 0]);
  if (!row) return { ok: false, why: 'No post with that id.' };
  return { ok: true, post: await withCoaching(postShape(row)) };
}

/* ── WHO POSTED, AND WHO DID NOT ────────────────────────────────────── */

async function postingStreak({ days } = {}) {
  await ensure();
  const back = Math.min(120, Math.max(7, num(days) || 30));
  const from = shift(todayLA(), -(back - 1));
  let rows = [];
  try {
    rows = await query('SELECT * FROM posting_log WHERE day >= ? ORDER BY day DESC', [from]);
  } catch (_) {}

  let team = [];
  try {
    team = await query("SELECT id, name, phone, email FROM team_members WHERE active=1 ORDER BY id");
  } catch (_) {}

  const out = [];
  for (const m of team || []) {
    const mine = (rows || []).filter(r => String(r.member_id) === String(m.id) && Number(r.done_ts));
    const days2 = new Set(mine.map(r => r.day));
    let streak = 0;
    let cursor = days2.has(todayLA()) ? todayLA() : shift(todayLA(), -1);
    while (days2.has(cursor)) { streak++; cursor = shift(cursor, -1); }
    out.push({
      member_id: Number(m.id), name: m.name || '',
      posted_today: days2.has(todayLA()),
      days_posted: days2.size,
      window_days: back,
      streak,
      missed: Math.max(0, back - days2.size),
      last_posted: mine.length ? mine[0].day : '',
      recent: Array.from({ length: Math.min(14, back) }, (_, i) => {
        const d = shift(todayLA(), -i);
        return { day: d, done: days2.has(d) };
      }),
    });
  }
  return { people: out, window_days: back, today: todayLA() };
}

async function markPosted({ member_id, day, platform, link, who }) {
  await ensure();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : todayLA();
  const id = Number(member_id) || 0;
  try {
    await execute(
      'INSERT INTO posting_log (who, member_id, day, platform, link, nudged_ts, done_ts, ts) VALUES (?,?,?,?,?,0,?,?)',
      [String(who || '').slice(0, 60), id, d, lower(platform).slice(0, 20),
       String(link || '').slice(0, 400), Date.now(), Date.now()]);
  } catch (_) {
    try {
      await execute('UPDATE posting_log SET done_ts=?, platform=?, link=? WHERE member_id=? AND day=?',
        [Date.now(), lower(platform).slice(0, 20), String(link || '').slice(0, 400), id, d]);
    } catch (_) {}
  }
  return { ok: true, day: d };
}

async function unmarkPosted({ member_id, day }) {
  await ensure();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : todayLA();
  try {
    await execute('UPDATE posting_log SET done_ts=0 WHERE member_id=? AND day=?',
      [Number(member_id) || 0, d]);
  } catch (_) {}
  return { ok: true, day: d };
}

module.exports = async function (req, res) {
  if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';
  const body = req.body || {};

  try {
    if (req.method === 'GET' && (action === 'analytics' || !action)) {
      return res.json(await analytics({ days: req.query.days, platform: req.query.platform }));
    }
    if (req.method === 'GET' && action === 'post') {
      const out = await postWithCoaching(req.query.id);
      return res.status(out.ok ? 200 : 400).json(out);
    }
    if (req.method === 'GET' && action === 'settings') {
      return res.json(await settings());
    }
    if (req.method === 'GET' && action === 'streak') {
      return res.json(await postingStreak({ days: req.query.days }));
    }
    if (req.method === 'POST' && action === 'save_post') {
      return res.json(await savePost(body));
    }
    if (req.method === 'POST' && action === 'delete_post') {
      return res.json(await deletePost(body.id));
    }
    if (req.method === 'POST' && action === 'save_settings') {
      return res.json(await saveSettings(body));
    }
    if (req.method === 'POST' && action === 'posted') {
      return res.json(await markPosted(body));
    }
    if (req.method === 'POST' && action === 'not_posted') {
      return res.json(await unmarkPosted(body));
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};

module.exports.settings = settings;
module.exports.analytics = analytics;
module.exports.allPosts = allPosts;
module.exports.savePost = savePost;
module.exports.baselineOf = baselineOf;
module.exports.coachFor = coachFor;
module.exports.bandFor = bandFor;
module.exports.planFor = planFor;
module.exports.postingStreak = postingStreak;
module.exports.markPosted = markPosted;
module.exports.postShape = postShape;
module.exports.BANDS = BANDS;
module.exports.PLATFORMS = PLATFORMS;
module.exports.KINDS = KINDS;
module.exports.unmarkPosted = unmarkPosted;
module.exports.deletePost = deletePost;
module.exports.postWithCoaching = postWithCoaching;
module.exports.saveSettings = saveSettings;
