/* ── THE NAIL JOURNEY ─────────────────────────────────────────────────────
   One question when the site opens, then the one thing that answers it.

   The recommendation is deliberately short. The first draft ran to three
   screens and nobody finishes three screens on a phone — every extra
   paragraph is another chance to close the tab. Each answer is now about
   eight seconds long and built around one number.

   That number is arrived at rather than asserted. "$185 of work, you pay
   $110" gets believed; "save big" does not, because a round claim with no
   arithmetic behind it reads as advertising and gets discounted on sight.
   The sum is shown, so the saving lands as something they worked out
   themselves rather than something they were told.

   Not shown on signup or booking. Somebody already there is mid-checkout,
   and interrupting them to suggest they go and check out loses a sale that
   was already won. Once per visit, too: a panel that returns on every click
   stops being a consultation and becomes a popup.                          */
(function () {
  'use strict';

  var KEY = 'zola_journey_seen';

  // Pages where somebody is browsing, not transacting.
  var WELCOME_ON = [
    '', '/', '/index.html', '/services.html', '/memberships.html',
    '/pressons.html', '/about.html', '/team.html', '/classes.html',
    '/careers.html', '/contact.html',
  ];

  function here() {
    var p = window.location.pathname.replace(/\/+$/, '');
    return p === '' ? '/' : p;
  }
  /* Anything that is not the client-facing site. The allowlist above is the
     rule; this is the second lock. The tag went onto the Team Portal by
     mistake once and staff got a client questionnaire in the middle of
     their shift — a list somebody has to keep correct is not enough on its
     own. */
  var STAFF = /team|manager|portal|worker|admin|ceo|dashboard|checkin|kiosk|account|visit|staff/i;

  function allowedHere() {
    if (STAFF.test(here())) return false;
    // A staff screen that is signed in says so in the page title.
    if (/portal|manager|dashboard|admin|check-?in/i.test(document.title || '')) return false;
    return WELCOME_ON.indexOf(here()) >= 0;
  }
  function alreadySeen() {
    try { return sessionStorage.getItem(KEY) === '1'; } catch (_) { return false; }
  }
  function remember() {
    try { sessionStorage.setItem(KEY, '1'); } catch (_) {}
  }

  /* ── WHAT WE SAY BACK ───────────────────────────────────────────────────
     Every figure is the real menu arithmetic, not a marketing number.

     Elite: a long set ($110) with a Russian manicure ($20), removal ($35)
     and art ($20) is $185 of menu. The membership is $110 — $75 a visit,
     $975 across thirteen cycles.

     Essential: a medium set ($100) with any art ($20) is $120 of menu
     against $85 — $35 a visit, $455 a year.

     Shown as the sum rather than the claim, because a number somebody can
     check is worth more than a bigger one they cannot.                    */
  var ANSWERS = {
    grow: {
      option: 'I’m struggling to grow my natural nails.',
      headline: 'You keep starting over.',
      empathy: 'Breakage. Long gaps. Back to square one. It is not you — it is going too long between visits.',
      product: 'ELITE',
      productLine: 'Your nails, seen every 4 weeks.',
      math: [
        ['Long set', '$110'],
        ['Russian manicure', '$20'],
        ['Removal', '$35'],
        ['Any nail art', '$20'],
      ],
      worth: '$185',
      pay: '$110',
      save: '$75',
      savePer: 'every single visit',
      year: '$975',
      why: [
        'Every 4 weeks, booked in',
        'Russian manicure included',
        'Removal free, every time',
        'Any art you want, no extra',
      ],
      close: 'Consistency is the whole secret. This makes it automatic.',
      cta: 'START MY ELITE JOURNEY',
      href: '/signup.html?tier=ELITE',
    },

    start: {
      option: 'I want to start my natural nail growth journey.',
      headline: 'Start today, not “soon”.',
      empathy: 'The hardest part of growing your nails is coming back. Elite books that in for you.',
      product: 'ELITE',
      productLine: 'Your nails, seen every 4 weeks.',
      math: [
        ['Long set', '$110'],
        ['Russian manicure', '$20'],
        ['Removal', '$35'],
        ['Any nail art', '$20'],
      ],
      worth: '$185',
      pay: '$110',
      save: '$75',
      savePer: 'every single visit',
      year: '$975',
      why: [
        'A routine, not a reminder',
        'Russian manicure included',
        'Removal free, every time',
        'Any art you want, no extra',
      ],
      close: 'You tell us the goal. We keep you on it.',
      cta: 'START MY ELITE JOURNEY',
      href: '/signup.html?tier=ELITE',
    },

    easy: {
      option: 'I want short-to-medium, stylish nails that are easy to maintain.',
      headline: 'Polished, without the upkeep.',
      empathy: 'You want to look done. You do not want a project.',
      product: 'ESSENTIAL',
      productLine: 'Short to medium, always sorted.',
      math: [
        ['Medium set', '$100'],
        ['Any nail art', '$20'],
      ],
      worth: '$120',
      pay: '$85',
      save: '$35',
      savePer: 'every single visit',
      year: '$455',
      why: [
        'Short to medium, your choice',
        'Any design, no extra charge',
        'No deposit, ever',
        'You book before walk-ins',
      ],
      close: 'Pretty should be easy. This is easy.',
      cta: 'JOIN ESSENTIAL',
      href: '/signup.html?tier=ESSENTIAL',
    },

    /* No membership on this one, so there is nothing to compare against.
       The hero is the transformation instead of a number — inventing a
       saving here to match the other three would make this the one
       dishonest screen in four. */
    bold: {
      option: 'I want long, bold, creative nails that make a statement.',
      headline: 'You want nails people stop and look at.',
      empathy: 'Long. Detailed. Yours. We do not do small.',
      product: 'THE ZOLA SIGNATURE SET',
      productLine: 'Built around your vision.',
      showcase: [
        'Any length you want',
        'Real nail art, not stickers',
        'Designed around your style',
        'Gentle on your natural nail',
      ],
      close: 'You bring the vision. We bring it to life.',
      cta: 'SEE MY PERFECT SERVICES',
      href: '/services.html',
    },
  };

  var ORDER = ['grow', 'start', 'easy', 'bold'];

  function styles() {
    return [
      '#nj-wrap{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;',
      'justify-content:center;padding:clamp(12px,3vw,40px);opacity:0;transition:opacity .32s ease}',
      '#nj-wrap.nj-on{opacity:1}',
      '#nj-veil{position:absolute;inset:0;background:rgba(13,13,13,0.58);',
      '-webkit-backdrop-filter:blur(9px);backdrop-filter:blur(9px)}',
      '#nj-box{position:relative;background:#F7F4EE;color:#0D0D0D;width:min(560px,100%);',
      'max-height:calc(100dvh - clamp(24px,6vw,80px));overflow-y:auto;overscroll-behavior:contain;',
      'border:1px solid rgba(182,165,136,0.55);box-shadow:0 40px 120px rgba(13,13,13,0.5);',
      'transform:translateY(14px) scale(0.985);transition:transform .38s cubic-bezier(.2,.7,.3,1);',
      '-webkit-overflow-scrolling:touch}',
      '#nj-wrap.nj-on #nj-box{transform:none}',
      '#nj-x{position:sticky;top:0;float:right;margin:10px 10px 0 0;z-index:3;',
      'width:38px;height:38px;border:1px solid rgba(140,122,94,0.4);background:#F7F4EE;',
      'color:#8C7A5E;font-size:19px;line-height:1;cursor:pointer;border-radius:50%;',
      'display:flex;align-items:center;justify-content:center;transition:all .18s ease}',
      '#nj-x:hover{background:#0D0D0D;color:#B6A588;border-color:#0D0D0D}',
      '#nj-x:focus-visible{outline:2px solid #0D0D0D;outline-offset:2px}',
      '.nj-pad{padding:clamp(24px,5vw,40px) clamp(20px,5vw,38px) clamp(24px,5vw,36px)}',

      '.nj-eyebrow{font-family:"Josefin Sans",sans-serif;font-size:0.6rem;letter-spacing:0.3em;',
      'text-transform:uppercase;color:#8C7A5E;margin-bottom:0.9rem}',
      '.nj-h1{font-family:"Cinzel",serif;font-size:clamp(1.45rem,4.4vw,1.95rem);line-height:1.22;',
      'color:#0D0D0D;margin:0 0 0.6rem;font-weight:400}',
      '.nj-lead{font-family:"Josefin Sans",sans-serif;font-size:clamp(0.95rem,2.6vw,1.02rem);',
      'line-height:1.7;color:#5a4f3f;margin:0 0 0.5rem}',
      '.nj-q{font-family:"Cinzel",serif;font-size:1rem;color:#0D0D0D;margin:1.5rem 0 0.85rem}',
      '.nj-opt{display:block;width:100%;text-align:left;background:#fff;color:#0D0D0D;',
      'border:1px solid rgba(140,122,94,0.35);padding:1.05rem 1.15rem;margin-bottom:0.6rem;',
      'font-family:"Josefin Sans",sans-serif;font-size:clamp(0.95rem,2.6vw,1.02rem);line-height:1.45;',
      'cursor:pointer;transition:all .16s ease;border-radius:2px;font-weight:600}',
      '.nj-opt:hover{border-color:#0D0D0D;background:#0D0D0D;color:#F2ECE1;transform:translateY(-1px)}',
      '.nj-opt:focus-visible{outline:2px solid #0D0D0D;outline-offset:2px}',

      /* ── the recommendation: fewer words, bigger type ── */
      '.nj-said{display:inline-block;font-family:"Josefin Sans",sans-serif;font-size:0.7rem;',
      'letter-spacing:0.06em;color:#8C7A5E;border:1px solid rgba(140,122,94,0.35);',
      'padding:0.35rem 0.7rem;margin-bottom:1.1rem;line-height:1.4}',
      '.nj-big{font-family:"Cinzel",serif;font-size:clamp(1.65rem,5.6vw,2.3rem);line-height:1.15;',
      'color:#0D0D0D;margin:0 0 0.6rem;font-weight:400}',
      '.nj-emp{font-family:"Josefin Sans",sans-serif;font-size:clamp(1rem,2.8vw,1.08rem);',
      'line-height:1.65;color:#5a4f3f;margin:0 0 1.5rem}',
      '.nj-name{font-family:"Cinzel",serif;font-size:clamp(1.9rem,6.4vw,2.6rem);line-height:1;',
      'letter-spacing:0.04em;color:#0D0D0D;margin:0}',
      '.nj-nameline{font-family:"Josefin Sans",sans-serif;font-size:0.92rem;color:#8C7A5E;',
      'margin:0.35rem 0 1.3rem}',

      /* the sum, then the number it comes to */
      '.nj-money{background:#0D0D0D;color:#F2ECE1;padding:1.25rem 1.3rem;margin-bottom:1.4rem}',
      '.nj-row{display:flex;justify-content:space-between;font-family:"Josefin Sans",sans-serif;',
      'font-size:0.9rem;line-height:1.9;color:#B6A588}',
      '.nj-rule{border-top:1px solid rgba(182,165,136,0.35);margin:0.55rem 0}',
      '.nj-tot{display:flex;justify-content:space-between;font-family:"Josefin Sans",sans-serif;',
      'font-size:0.95rem;color:#F2ECE1;font-weight:600}',
      '.nj-pay{display:flex;justify-content:space-between;font-family:"Josefin Sans",sans-serif;',
      'font-size:0.95rem;color:#F2ECE1;font-weight:600;margin-top:0.2rem}',
      '.nj-save{text-align:center;margin-top:1.1rem;padding-top:1.05rem;',
      'border-top:1px solid rgba(182,165,136,0.35)}',
      '.nj-savenum{font-family:"Cinzel",serif;font-size:clamp(2.8rem,11vw,3.9rem);line-height:1;',
      'color:#B6A588;display:block}',
      '.nj-savelbl{font-family:"Josefin Sans",sans-serif;font-size:0.86rem;letter-spacing:0.08em;',
      'text-transform:uppercase;color:#F2ECE1;margin-top:0.45rem;display:block}',
      '.nj-year{font-family:"Josefin Sans",sans-serif;font-size:0.95rem;color:#B6A588;',
      'margin-top:0.75rem;display:block;line-height:1.5}',
      '.nj-year b{color:#F2ECE1;font-size:1.15rem}',

      /* the no-membership version, same weight without a price */
      '.nj-show{background:#0D0D0D;color:#F2ECE1;padding:1.35rem 1.4rem;margin-bottom:1.4rem}',
      '.nj-show ul{margin:0;padding:0}',
      '.nj-show li{font-family:"Josefin Sans",sans-serif;font-size:clamp(1rem,2.9vw,1.1rem);',
      'line-height:1.55;padding:0.42rem 0 0.42rem 1.7rem;position:relative;color:#F2ECE1;list-style:none}',
      '.nj-show li:before{content:"\\2726";position:absolute;left:0;top:0.42rem;color:#B6A588}',

      '.nj-why{list-style:none;padding:0;margin:0 0 1.35rem}',
      '.nj-why li{font-family:"Josefin Sans",sans-serif;font-size:clamp(0.98rem,2.8vw,1.05rem);',
      'line-height:1.55;color:#0D0D0D;padding:0.34rem 0 0.34rem 1.6rem;position:relative}',
      '.nj-why li:before{content:"\\2713";position:absolute;left:0;top:0.34rem;color:#8C7A5E;font-weight:700}',
      '.nj-close{font-family:"Cinzel",serif;font-size:clamp(1.02rem,3vw,1.15rem);line-height:1.5;',
      'color:#0D0D0D;margin:0 0 1.4rem}',

      /* ── the button ──
         It breathes, and a highlight passes across it. Movement is noticed
         before anything is read, so on a screen with exactly one action the
         moving thing is the one that gets pressed. Slow enough to read as
         expensive rather than as an advert. */
      '.nj-cta{display:block;position:relative;overflow:hidden;width:100%;background:#0D0D0D;',
      'color:#B6A588;border:none;padding:1.3rem 1.2rem;font-family:"Josefin Sans",sans-serif;',
      'font-size:clamp(0.84rem,2.5vw,0.95rem);font-weight:700;letter-spacing:0.16em;',
      'text-transform:uppercase;text-align:center;text-decoration:none;cursor:pointer;',
      'border-radius:2px;animation:njBreathe 2.8s ease-in-out infinite;',
      'box-shadow:0 10px 30px rgba(13,13,13,0.22)}',
      '.nj-cta:after{content:"";position:absolute;top:0;left:-60%;width:45%;height:100%;',
      'background:linear-gradient(100deg,transparent,rgba(242,236,225,0.28),transparent);',
      'animation:njShine 3.4s ease-in-out infinite}',
      '.nj-cta:hover{background:#B6A588;color:#0D0D0D;animation-play-state:paused}',
      '.nj-cta:focus-visible{outline:2px solid #0D0D0D;outline-offset:3px}',
      '@keyframes njBreathe{0%,100%{transform:scale(1)}50%{transform:scale(1.022)}}',
      '@keyframes njShine{0%{left:-60%}55%,100%{left:120%}}',

      '.nj-back{display:block;width:100%;margin-top:0.8rem;background:none;border:none;',
      'font-family:"Josefin Sans",sans-serif;font-size:0.78rem;color:#8C7A5E;cursor:pointer;',
      'text-decoration:underline;text-underline-offset:3px;padding:0.5rem}',

      '@media (max-width:520px){#nj-box{width:100%}}',
      /* Anyone who has asked their device to stop moving things gets a still
         button. The offer has to stand up without the animation. */
      '@media (prefers-reduced-motion:reduce){#nj-wrap,#nj-box{transition:none}',
      '.nj-cta{animation:none}.nj-cta:after{display:none}}',
    ].join('');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  var wrap, box;

  function close() {
    remember();
    if (!wrap) return;
    wrap.classList.remove('nj-on');
    document.documentElement.style.overflow = '';
    setTimeout(function () {
      if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
      wrap = null;
    }, 340);
  }

  function showQuestion() {
    box.innerHTML =
      '<button id="nj-x" aria-label="Close">×</button>'
      + '<div class="nj-pad">'
      + '<div class="nj-eyebrow">Your nail journey</div>'
      + '<h2 class="nj-h1">Hey beautiful 🤍</h2>'
      + '<p class="nj-lead"><strong>Let’s personalize your perfect nail journey.</strong></p>'
      + '<p class="nj-lead">Tell us what you want, and we’ll show you the ZOLA experience designed specifically for you. ✨</p>'
      + '<div class="nj-q">Which one sounds most like you?</div>'
      + ORDER.map(function (k, i) {
          return '<button class="nj-opt" data-nj="' + k + '">' + (i + 1) + '. '
            + esc(ANSWERS[k].option) + '</button>';
        }).join('')
      + '</div>';

    box.querySelector('#nj-x').addEventListener('click', close);
    Array.prototype.forEach.call(box.querySelectorAll('[data-nj]'), function (b) {
      b.addEventListener('click', function () { showAnswer(b.getAttribute('data-nj')); });
    });
    box.scrollTop = 0;
  }

  // The sum, then what it comes to. Shown rather than claimed.
  function moneyBlock(a) {
    return '<div class="nj-money">'
      + a.math.map(function (r) {
          return '<div class="nj-row"><span>' + esc(r[0]) + '</span><span>' + esc(r[1]) + '</span></div>';
        }).join('')
      + '<div class="nj-rule"></div>'
      + '<div class="nj-tot"><span>Paid separately</span><span>' + esc(a.worth) + '</span></div>'
      + '<div class="nj-pay"><span>You pay</span><span>' + esc(a.pay) + '</span></div>'
      + '<div class="nj-save">'
        + '<span class="nj-savenum">' + esc(a.save) + '</span>'
        + '<span class="nj-savelbl">saved ' + esc(a.savePer) + '</span>'
        + '<span class="nj-year">That’s <b>' + esc(a.year) + '</b> a year that stays yours.</span>'
      + '</div></div>';
  }

  function showcaseBlock(a) {
    return '<div class="nj-show"><ul>'
      + a.showcase.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('')
      + '</ul></div>';
  }

  function showAnswer(key) {
    var a = ANSWERS[key];
    if (!a) return;

    box.innerHTML =
      '<button id="nj-x" aria-label="Close">×</button>'
      + '<div class="nj-pad">'
      + '<div class="nj-said">You said: ' + esc(a.option) + '</div>'
      + '<h2 class="nj-big">' + esc(a.headline) + '</h2>'
      + '<p class="nj-emp">' + esc(a.empathy) + '</p>'
      + '<div class="nj-name">' + esc(a.product) + '</div>'
      + '<div class="nj-nameline">' + esc(a.productLine) + '</div>'
      + (a.showcase ? showcaseBlock(a) : moneyBlock(a))
      + (a.why
          ? '<ul class="nj-why">' + a.why.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>'
          : '')
      + '<p class="nj-close">' + esc(a.close) + '</p>'
      + '<a class="nj-cta" href="' + a.href + '">' + esc(a.cta) + ' ✨</a>'
      + '<button class="nj-back" type="button">That’s not quite me</button>'
      + '</div>';

    box.querySelector('#nj-x').addEventListener('click', close);
    box.querySelector('.nj-back').addEventListener('click', showQuestion);
    box.querySelector('.nj-cta').addEventListener('click', remember);
    box.scrollTop = 0;
  }

  function open() {
    if (document.getElementById('nj-wrap')) return;

    var css = document.createElement('style');
    css.textContent = styles();
    document.head.appendChild(css);

    wrap = document.createElement('div');
    wrap.id = 'nj-wrap';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Personalize your nail journey');
    wrap.innerHTML = '<div id="nj-veil"></div>';

    box = document.createElement('div');
    box.id = 'nj-box';
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    showQuestion();
    document.documentElement.style.overflow = 'hidden';

    wrap.querySelector('#nj-veil').addEventListener('click', close);
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
    });

    requestAnimationFrame(function () {
      requestAnimationFrame(function () { wrap.classList.add('nj-on'); });
    });
  }

  function boot() {
    if (!allowedHere() || alreadySeen()) return;
    // A beat, so the page paints first. Landing on a blank screen behind a
    // panel reads as an advert; ZOLA appearing and then offering to help
    // does not.
    setTimeout(open, 900);
  }

  window.ZolaJourney = { open: open, close: close };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
