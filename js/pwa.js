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
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#140d07;color:#F2ECE1;border-top:1px solid rgba(182,165,136,0.4);padding:0.9rem 1rem;font-family:"Josefin Sans",sans-serif;font-size:0.85rem;display:flex;align-items:center;gap:0.7rem;box-shadow:0 -6px 24px rgba(0,0,0,0.4);';
      bar.innerHTML = '<span style="flex:1;line-height:1.4;">Add ZOLA to your Home Screen — tap the <strong>Share</strong> icon, then <strong>Add to Home Screen</strong>.</span>' +
        '<button style="background:#B6A588;color:#0B0B0B;border:none;padding:0.55rem 0.95rem;font-size:0.68rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;border-radius:8px;flex-shrink:0;">Got it</button>';
      bar.querySelector('button').onclick = function () { try { localStorage.setItem('zola_a2hs_dismissed', '1'); } catch (e) {} bar.remove(); };
      document.body.appendChild(bar);
    }
  } catch (e) {}
})();
