/* THE BLACK FRIDAY ARRIVAL.
 *
 * Zahra's ask: when somebody lands on the site, play a Black Friday
 * animation across the screen, and when it finishes have it close down
 * into a single tab that says Shop Black Friday, so the deal stays in
 * front of them.
 *
 * Three things decide whether this helps her or costs her:
 *
 *   · IT MUST NOT BLOCK THE FIRST VISIT. An overlay a client cannot get
 *     out of is an overlay they close by closing the tab. So it is
 *     dismissable from the first frame, Escape works, the backdrop works,
 *     and it never appears twice in a day — once it has been seen, the
 *     only trace is the tab.
 *
 *   · IT MUST NOT SHOW A PRICE IT DOES NOT KNOW. Every figure comes from
 *     /api/plans, the same place the membership page and the checkout
 *     read. Until that answers, the panel says nothing numeric.
 *
 *   · IT MUST NOT RUN WHEN THERE IS NO SALE. The window is the server's
 *     to decide, and outside it this file renders nothing at all.
 *
 * Nothing here is added to a page without the sale being live, so there
 * is no stale banner to take down afterwards.
 */
(function () {
  'use strict';

  var KEY = 'zola_bf_seen_v1';
  var API = '/api/plans';

  /* Somebody who has already seen it today gets the tab and no overlay.
     Stored per day rather than for ever: the sale is a few days long and
     a client who comes back on the Saturday has not seen Saturday's
     reminder. Wrapped because private windows throw on access. */
  function seenToday() {
    try {
      var v = window.localStorage.getItem(KEY);
      return v === new Date().toDateString();
    } catch (_) { return false; }
  }
  function markSeen() {
    try { window.localStorage.setItem(KEY, new Date().toDateString()); } catch (_) {}
  }

  function money(c) {
    var v = (Number(c) || 0) / 100;
    return '$' + (v % 1 === 0
      ? v.toLocaleString('en-US')
      : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }

  function style() {
    if (document.getElementById('bf-style')) return;
    var s = document.createElement('style');
    s.id = 'bf-style';
    s.textContent = [
      /* The overlay. Espresso and gold rather than retail red, so it still
         looks like her studio while reading unmistakably as a sale. */
      '.bfo{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;',
      '  padding:1.2rem;background:rgba(10,9,8,0.82);backdrop-filter:blur(5px);',
      '  opacity:0;transition:opacity .45s ease}',
      '.bfo.in{opacity:1}',
      '.bfo.out{opacity:0;pointer-events:none}',
      '.bfc{position:relative;width:100%;max-width:430px;background:#0D0D0D;color:#F5EEE8;',
      '  border:1px solid rgba(182,165,136,0.42);padding:2.5rem 1.7rem 2rem;text-align:center;',
      '  overflow:hidden;transform:translateY(16px) scale(.97);opacity:0;',
      '  transition:transform .55s cubic-bezier(.2,.8,.2,1),opacity .55s ease}',
      '.bfo.in .bfc{transform:none;opacity:1}',
      /* A slow sweep of light across the card, once. */
      '.bfc::before{content:"";position:absolute;top:0;left:-60%;width:60%;height:100%;',
      '  background:linear-gradient(100deg,transparent,rgba(182,165,136,0.16),transparent);',
      '  animation:bfsweep 2.1s ease-out .35s both}',
      '@keyframes bfsweep{to{left:120%}}',
      '.bfc::after{content:"";position:absolute;inset:0;pointer-events:none;background:',
      '  radial-gradient(circle at 18% 0%,rgba(182,165,136,0.2),transparent 55%),',
      '  radial-gradient(circle at 88% 100%,rgba(182,165,136,0.14),transparent 55%)}',
      '.bfc>*{position:relative;z-index:1}',
      '.bf-k{font-family:"Josefin Sans",system-ui,sans-serif;font-size:.6rem;letter-spacing:.46em;',
      '  text-transform:uppercase;color:#B6A588;margin-bottom:.9rem}',
      '.bf-h{font-family:"Cinzel",Georgia,serif;font-size:clamp(1.55rem,7vw,2.15rem);line-height:1.12;',
      '  margin:0 0 .8rem}',
      '.bf-l{font-family:"Josefin Sans",system-ui,sans-serif;font-size:.92rem;line-height:1.75;',
      '  color:rgba(245,238,232,.86);margin:0 0 1.5rem}',
      '.bf-l b{color:#F5EEE8}',
      '.bf-go{display:block;background:#B6A588;color:#0D0D0D;text-decoration:none;',
      '  font-family:"Josefin Sans",system-ui,sans-serif;font-size:.82rem;letter-spacing:.2em;',
      '  text-transform:uppercase;padding:1rem 1.2rem;transition:background .2s}',
      '.bf-go:hover{background:#C9BB9E}',
      '.bf-x{display:block;width:100%;margin-top:.9rem;background:none;border:0;cursor:pointer;',
      '  font-family:"Josefin Sans",system-ui,sans-serif;font-size:.72rem;letter-spacing:.14em;',
      '  text-transform:uppercase;color:rgba(245,238,232,.5);padding:.5rem}',
      '.bf-x:hover{color:rgba(245,238,232,.85)}',
      '.bf-when{font-family:"Josefin Sans",system-ui,sans-serif;font-size:.66rem;letter-spacing:.16em;',
      '  text-transform:uppercase;color:#B6A588;margin-top:1.1rem}',

      /* The tab it collapses into. Bottom-right on a desktop, a full-width
         strip on a phone, where a floating corner button covers content. */
      '.bft{position:fixed;z-index:8900;right:1rem;bottom:1rem;display:flex;align-items:center;gap:.6rem;',
      '  background:#0D0D0D;color:#F5EEE8;text-decoration:none;border:1px solid rgba(182,165,136,.45);',
      '  padding:.8rem 1.1rem;font-family:"Josefin Sans",system-ui,sans-serif;font-size:.74rem;',
      '  letter-spacing:.18em;text-transform:uppercase;box-shadow:0 10px 30px rgba(0,0,0,.3);',
      '  opacity:0;transform:translateY(14px);transition:opacity .5s ease,transform .5s ease}',
      '.bft.in{opacity:1;transform:none}',
      '.bft i{display:inline-block;width:6px;height:6px;border-radius:50%;background:#B6A588;',
      '  animation:bfpulse 2.4s ease-in-out infinite}',
      '@keyframes bfpulse{0%,100%{opacity:1}50%{opacity:.25}}',
      '.bft-x{margin-left:.2rem;color:rgba(245,238,232,.45);font-size:.9rem;line-height:1;',
      '  background:none;border:0;cursor:pointer;padding:0 .1rem}',
      '.bft-x:hover{color:#F5EEE8}',
      '@media(max-width:560px){',
      '  .bft{right:.6rem;left:.6rem;bottom:.6rem;justify-content:center}',
      '}',
      /* Anybody who has asked their device for less movement gets the
         panel and the tab with no animation at all. */
      '@media(prefers-reduced-motion:reduce){',
      '  .bfo,.bfc,.bft{transition:none}',
      '  .bfc::before{animation:none}',
      '  .bft i{animation:none}',
      '}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* The headline, built from the server's own figures. Two claims, each
     with its duration, for the same reason the membership page does it:
     the deeper discount runs eight weeks and the other runs a year, and
     collapsing them into one number would be a bait. */
  function copy(d) {
    var yearPct = 0, yearSaved = 0, cyclePct = 0, cycleWeeks = 0;
    (d.plans || []).forEach(function (p) {
      (p.rhythms || []).forEach(function (r) {
        if (r.annual_sale) {
          if (r.annual_sale.pct_off_monthly > yearPct) yearPct = r.annual_sale.pct_off_monthly;
          if (r.annual_sale.saved_vs_monthly_cents > yearSaved) yearSaved = r.annual_sale.saved_vs_monthly_cents;
        }
        if (r.sale && r.sale.pct_off > cyclePct) {
          cyclePct = r.sale.pct_off;
          cycleWeeks = r.sale.intro_weeks;
        }
      });
    });
    var head = yearPct
      ? Math.round(yearPct) + '% off a whole year'
      : (cyclePct ? Math.round(cyclePct) + '% off your first ' + cycleWeeks + ' weeks' : 'Black Friday');
    var line = '';
    if (yearSaved) line += 'The biggest saves <b>' + money(yearSaved) + '</b> on a year of nails. ';
    if (cyclePct && cycleWeeks) {
      line += 'Or <b>' + Math.round(cyclePct) + '% off</b> your first ' + cycleWeeks
        + ' weeks if you would rather pay as you go.';
    }
    /* The pop-up is the first thing anybody sees, members included, so
       the qualification travels with the claim rather than trailing it.
       Read from the server's own window object. */
    return {
      head: head,
      line: line || 'Memberships and press-ons, on sale.',
      who: (d.black_friday && d.black_friday.who) || 'New memberships only',
    };
  }

  function prettyDate(ymd) {
    try {
      var b = String(ymd).split('-');
      return new Date(+b[0], +b[1] - 1, +b[2]).toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric' });
    } catch (_) { return ''; }
  }

  /* THE BUTTON.
     Added to whatever nav this script finds, before "Book Now" so Book
     Now stays the last and loudest thing in the bar: Black Friday is
     this week, booking is the business. */
  function showNavButton() {
    var links = document.querySelector('.nav-links');
    if (links && !document.getElementById('bf-nav-btn')) {
      var a = document.createElement('a');
      a.id = 'bf-nav-btn';
      a.href = '/blackfriday.html';
      a.textContent = 'Shop Black Friday';
      /* Cream on ink. Deliberately not the gold Book Now treatment: two
         identical buttons side by side and neither reads as the main one. */
      a.style.cssText = 'background:#0D0D0D;color:#F4EFE6;padding:0.55rem 0.95rem;'
        + 'letter-spacing:0.08em;text-decoration:none;white-space:nowrap';
      var book = links.querySelector('.btn-gold');
      if (book) links.insertBefore(a, book); else links.appendChild(a);
    }

    /* The three lines. A separate list from the desktop nav, so it needs
       its own entry \u2014 and it goes first, because a menu is read from
       the top and this is the item that is only true for a week. */
    var m = document.getElementById('nav-mobile');
    if (m && !document.getElementById('bf-nav-m')) {
      var b = document.createElement('a');
      b.id = 'bf-nav-m';
      b.href = '/blackfriday.html';
      b.textContent = 'Black Friday Deals';
      b.style.cssText = 'color:#E4D9C2;font-weight:600';
      if (m.firstChild) m.insertBefore(b, m.firstChild); else m.appendChild(b);
    }
  }

  /* Where the pop-up and the tab are not welcome: the hub itself, and
     the pages where somebody is already buying one of these things. */
  function shopping() {
    var p = '';
    try { p = String((location && location.pathname) || '').toLowerCase(); } catch (_) {}
    return /blackfriday|memberships|gift|signup|checkout/.test(p);
  }

  var tabEl = null;

  function showTab(d) {
    if (tabEl) return;
    style();
    tabEl = document.createElement('div');
    tabEl.className = 'bft';
    tabEl.innerHTML =
      '<a href="/blackfriday.html" style="display:flex;align-items:center;gap:.6rem;'
      + 'color:inherit;text-decoration:none">'
      + '<i></i><span>Shop Black Friday</span></a>'
      + '<button class="bft-x" type="button" aria-label="Hide">&times;</button>';
    document.body.appendChild(tabEl);
    /* One frame later, so the transition has something to animate from. */
    requestAnimationFrame(function () { tabEl.classList.add('in'); });
    tabEl.querySelector('.bft-x').addEventListener('click', function () {
      tabEl.classList.remove('in');
      setTimeout(function () { if (tabEl && tabEl.parentNode) tabEl.parentNode.removeChild(tabEl); tabEl = null; }, 400);
    });
  }

  function showOverlay(d) {
    style();
    var c = copy(d);
    var o = document.createElement('div');
    o.className = 'bfo';
    o.setAttribute('role', 'dialog');
    o.setAttribute('aria-modal', 'true');
    o.setAttribute('aria-label', 'Black Friday at ZOLA');
    o.innerHTML =
      '<div class="bfc">'
      + '<div class="bf-k">Black Friday</div>'
      + '<h2 class="bf-h">' + c.head + '</h2>'
      + '<p class="bf-l">' + c.line + '</p>'
      + '<a class="bf-go" href="/blackfriday.html">See every deal</a>'
      + '<button class="bf-x" type="button">Maybe later</button>'
      + '<div class="bf-when">' + c.who
          + (d.black_friday && d.black_friday.to
              ? ' \u00b7 ends ' + prettyDate(d.black_friday.to) : '')
        + '</div>'
      + '</div>';
    document.body.appendChild(o);
    requestAnimationFrame(function () { o.classList.add('in'); });

    /* Closing it is what produces the tab, which is the behaviour she
       described: the animation finishes and collapses into one tab. */
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      markSeen();
      o.classList.remove('in');
      o.classList.add('out');
      setTimeout(function () {
        if (o.parentNode) o.parentNode.removeChild(o);
        showTab(d);
      }, 420);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    o.querySelector('.bf-x').addEventListener('click', close);
    /* The backdrop closes it; the card does not. */
    o.addEventListener('click', function (e) { if (e.target === o) close(); });
    document.addEventListener('keydown', onKey);
    /* Following the link counts as having seen it, so it does not reappear
       on the page she just asked for. */
    o.querySelector('.bf-go').addEventListener('click', markSeen);

    /* It also collapses on its own. Long enough to read, short enough not
       to be in the way — and it is dismissable throughout. */
    setTimeout(close, 9000);
  }

  function start() {
    fetch(API).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.black_friday || !d.black_friday.live) return;
      /* The button is navigation, not a once-a-day interruption: it
         belongs there on every page, every time.

         Guarded on its own. It runs first, and the catch below is empty,
         so anything it threw — an unfamiliar nav, a nav another script
         rebuilt after load — took the pop-up and the tab down with it and
         said nothing. The sale would be live on the server and invisible
         on the page. */
      try { showNavButton(); } catch (_) {}

      /* And the same for deciding where we are. A page is only "already
         shopping" if we can read the path; if we cannot, the sale is shown
         rather than silently suppressed. */
      var quiet = false;
      try { quiet = shopping(); } catch (_) {}
      if (quiet) return;

      if (seenToday()) { showTab(d); return; }
      showOverlay(d);
    }).catch(function () { /* no sale information, no banner */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
