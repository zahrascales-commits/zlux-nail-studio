// Registers the service worker (makes ZOLA installable) and, on iPhone —
// which has no automatic install prompt — shows a one-time hint telling the
// owner/team how to add it to their Home Screen so it behaves like an app.
(function () {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
  try {
    var isiOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    var standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    if (isiOS && !standalone && !localStorage.getItem('zola_a2hs_dismissed')) {
      var bar = document.createElement('div');
      // Sits above a page's own bottom bar when it has one (--a2hs-bottom), and
      // clear of the iPhone home bar.
      bar.style.cssText = 'position:fixed;left:0.6rem;right:0.6rem;bottom:calc(var(--a2hs-bottom,0px) + env(safe-area-inset-bottom,0px) + 0.6rem);z-index:99999;background:#fff;color:#101828;border:1px solid #EAECF0;border-radius:14px;padding:0.85rem 0.9rem;font-family:Inter,system-ui,-apple-system,sans-serif;font-size:0.9rem;display:flex;align-items:center;gap:0.7rem;box-shadow:0 10px 30px rgba(16,24,40,0.16);';
      bar.innerHTML = '<span style="flex:1;line-height:1.4;">Add ZOLA to your Home Screen — tap the <strong>Share</strong> icon, then <strong>Add to Home Screen</strong>.</span>' +
        '<button style="background:#101828;color:#fff;border:none;padding:0.55rem 0.95rem;min-height:40px;font-size:0.9rem;font-weight:600;cursor:pointer;border-radius:10px;flex-shrink:0;">Got it</button>';
      bar.querySelector('button').onclick = function () { try { localStorage.setItem('zola_a2hs_dismissed', '1'); } catch (e) {} bar.remove(); };
      document.body.appendChild(bar);
    }
  } catch (e) {}
})();
