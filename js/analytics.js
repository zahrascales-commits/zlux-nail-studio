// First-party site analytics — page views, scroll depth, and where people
// tend to leave the site. No external service, no cookies banner needed.
(function () {
  function sessionId() {
    var key = 'zlux_analytics_sid';
    var sid = sessionStorage.getItem(key);
    if (!sid) {
      sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(key, sid);
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

  fetch('/api/analytics?action=pageview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sid, path: path, referrer: document.referrer || '' }),
    keepalive: true,
  }).catch(function () {});

  function sendExit() {
    if (exitSent) return;
    exitSent = true;
    var payload = JSON.stringify({
      session_id: sid, path: path,
      max_scroll_pct: maxScrollPct,
      time_on_page_ms: Date.now() - startTime,
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/analytics?action=exit', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch('/api/analytics?action=exit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(function () {});
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendExit();
  });
  window.addEventListener('pagehide', sendExit);
})();
