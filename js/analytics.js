// First-party site analytics — page views, scroll depth, and where people
// tend to leave the site. No external service, no cookies banner needed.
//
// Also loads the advertising tags she connects in Studio Manager → Marketing
// (Meta Pixel, Google Ads, Google Analytics), and only those. With none
// connected, nothing from Facebook or Google is loaded at all.
(function () {
  // Some in-app browsers (Instagram's, private tabs) refuse storage and
  // throw. Counting a visit must not depend on it.
  function store(kind) {
    try { var s = window[kind]; var k = '__zola_t'; s.setItem(k, '1'); s.removeItem(k); return s; }
    catch (_) { return null; }
  }
  var ss = store('sessionStorage');

  function sessionId() {
    var key = 'zlux_analytics_sid';
    var sid = null;
    try { sid = ss && ss.getItem(key); } catch (_) {}
    if (!sid) {
      sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { if (ss) ss.setItem(key, sid); } catch (_) {}
      if (!ss) { window.__zolaSid = window.__zolaSid || sid; sid = window.__zolaSid; }
    }
    return sid;
  }

  var sid = sessionId();
  var path = (location.pathname.split('/').pop() || 'index.html');
  var startTime = Date.now();
  var maxScrollPct = 0;
  var exitSent = false;

  function scrollPct() {
    var doc = document.documentElement;
    var scrollable = doc.scrollHeight - doc.clientHeight;
    if (scrollable <= 0) return 100;
    var pct = ((window.scrollY || doc.scrollTop) / scrollable) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  window.addEventListener('scroll', function () {
    var pct = scrollPct();
    if (pct > maxScrollPct) maxScrollPct = pct;
  }, { passive: true });

  try {
    fetch('/api/analytics?action=pageview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sid, path: path, referrer: document.referrer || '' }),
      keepalive: true,
    }).catch(function () {});
  } catch (_) {}

  function sendExit() {
    if (exitSent) return;
    exitSent = true;
    var payload = JSON.stringify({
      session_id: sid, path: path,
      max_scroll_pct: maxScrollPct,
      time_on_page_ms: Date.now() - startTime,
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/analytics?action=exit', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/analytics?action=exit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(function () {});
      }
    } catch (_) {}
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendExit();
  });
  window.addEventListener('pagehide', sendExit);

  /* ── ADVERTISING TAGS ──────────────────────────────────────────────────
     Remembered for the visit, so browsing between pages asks once. */
  var queued = [];
  window.zolaTrack = function (event, data) {
    queued.push([event, data || {}]);
    flush();
  };
  var tags = null;
  function flush() {
    if (!tags) return;
    while (queued.length) {
      var e = queued.shift();
      try {
        if (window.fbq && tags.meta_pixel_id) window.fbq('track', e[0], e[1]);
        if (window.gtag) {
          var g = e[0] === 'Schedule' ? 'book_appointment' : e[0] === 'Purchase' ? 'purchase' : e[0];
          window.gtag('event', g, e[1]);
          if (tags.google_ads_id && (e[0] === 'Schedule' || e[0] === 'Purchase')) {
            window.gtag('event', 'conversion', { send_to: tags.google_ads_id, value: e[1].value, currency: e[1].currency || 'USD' });
          }
        }
      } catch (_) {}
    }
  }
  function install(t) {
    tags = t || {};
    try {
      if (tags.meta_pixel_id && /^\d{10,20}$/.test(tags.meta_pixel_id) && !window.fbq) {
        /* Meta's standard pixel loader. */
        !function (f, b, e, v, n, t, s) {
          if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
          if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
          t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
        }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
        window.fbq('init', tags.meta_pixel_id);
        window.fbq('track', 'PageView');
      }
      var gids = [tags.google_tag_id, tags.google_ads_id].filter(function (x) { return x && /^(G|GT|AW)-[A-Z0-9]+$/i.test(x); });
      if (gids.length && !window.gtag) {
        var s = document.createElement('script');
        s.async = true;
        s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(gids[0]);
        document.head.appendChild(s);
        window.dataLayer = window.dataLayer || [];
        window.gtag = function () { window.dataLayer.push(arguments); };
        window.gtag('js', new Date());
        gids.forEach(function (id) { window.gtag('config', id); });
      }
    } catch (_) {}
    flush();
  }
  var cached = null;
  try { cached = ss && JSON.parse(ss.getItem('zola_tags') || 'null'); } catch (_) {}
  if (cached) install(cached);
  else {
    try {
      fetch('/api/growth?action=tags').then(function (r) { return r.json(); }).then(function (t) {
        try { if (ss) ss.setItem('zola_tags', JSON.stringify(t || {})); } catch (_) {}
        install(t);
      }).catch(function () { install({}); });
    } catch (_) { install({}); }
  }
})();
