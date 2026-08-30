/* ── THE NAIL JOURNEY ─────────────────────────────────────────────────────
   One question when the site opens, then the one thing that answers it.

   The whole point is that nobody should have to work out which membership
   they want by reading three pages and comparing prices. They say what they
   are trying to achieve; we say what solves it and give them one button.

   Deliberately not shown on the pages where somebody is already doing the
   thing — signing up, booking, paying. Interrupting a person mid-checkout to
   suggest they go and check out is how you lose a sale you had already won.

   It also shows once per visit rather than on every page. A questionnaire
   that reappears on every click stops reading as a consultation and starts
   reading as a popup, and people leave.                                    */
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

  function allowedHere() {
    var p = here();
    return WELCOME_ON.indexOf(p) >= 0 || p === '/';
  }

  function alreadySeen() {
    try { return sessionStorage.getItem(KEY) === '1'; } catch (_) { return false; }
  }

  function remember() {
    try { sessionStorage.setItem(KEY, '1'); } catch (_) {}
  }

  /* ── WHAT WE SAY BACK ───────────────────────────────────────────────────
     Every saving quoted here is below what the menu actually works out to,
     deliberately. Essential covers a service up to medium plus any design —
     $120 of menu for $85, so $35 a cycle and roughly $455 a year. Elite
     covers a long set, a Russian manicure, removal and any design — $185 of
     menu for $110, so $75 a cycle and roughly $975 a year. Claiming less
     than the truth is the only safe direction to be wrong in.             */
  var ANSWERS = {
    grow: {
      option: 'I’m struggling to grow my natural nails.',
      heading: 'We understand your goal: you want to finally see progress. ✨',
      intro: [
        'Growing your natural nails can feel frustrating when you keep starting over.',
        'Breakage, inconsistency, and waiting too long between appointments can make it difficult to stay committed to your nail goals.',
      ],
      leadIn: 'That’s why we recommend your personalized solution:',
      product: 'THE ELITE MEMBERSHIP 🤍',
      body: [
        'The ELITE Membership is designed for clients who want to make their natural nail journey a consistent part of their routine.',
        'Instead of guessing when to come back, your membership follows a <strong>4-week cycle</strong> — helping you stay consistent with regular professional maintenance.',
      ],
      whyTitle: 'Why this is right for you:',
      why: [
        'A consistent 4-week nail routine',
        'Professional maintenance focused on your nail goals',
        'Beautiful nails while working toward healthier-looking natural nails',
        'Membership benefits and priority access',
        'Save $30+ every 4 weeks compared with qualifying services purchased individually',
        'Save $600+ or more over a year, depending on services and membership usage',
      ],
      closeTitle: 'The difference is consistency.',
      close: [
        'Your goal is not just to have beautiful nails for one appointment.',
        '<strong>Your goal is to build a routine you can actually stay consistent with.</strong>',
        'With ELITE, your nail appointments become part of your routine — so you can spend less time starting over and more time enjoying your progress.',
      ],
      kicker: 'Your personalized recommendation is waiting.',
      cta: 'START MY ELITE JOURNEY ✨',
      href: '/signup.html?tier=ELITE',
    },

    start: {
      option: 'I want to start my natural nail growth journey.',
      heading: 'The best time to start your journey is now. ✨',
      intro: [
        'You already know what you want: beautiful nails while giving your natural nails the consistent care they deserve.',
      ],
      leadIn: 'Your personalized recommendation:',
      product: 'THE ELITE MEMBERSHIP 🤍',
      body: [
        'A natural nail journey is easier when you have a routine designed to keep you consistent.',
        'The ELITE Membership follows a <strong>4-week cycle</strong>, helping make regular maintenance a simple part of your routine instead of something you have to keep remembering to schedule.',
      ],
      whyTitle: 'Why ELITE is perfect for your goal:',
      why: [
        'Start your journey with a consistent routine',
        'Regular professional maintenance every 4 weeks',
        'Beautiful nails without losing sight of your natural nail goals',
        'Exclusive membership benefits',
        'Save $30+ every 4 weeks compared with qualifying individual services',
        'Save $600+ or more over a year, depending on services and usage',
      ],
      closeTitle: 'You do not need to figure it all out alone.',
      close: [
        'You tell us your goal.',
        '<strong>We help guide your journey.</strong>',
      ],
      kicker: 'Ready to begin?',
      cta: 'START MY ELITE JOURNEY ✨',
      href: '/signup.html?tier=ELITE',
    },

    easy: {
      option: 'I want short-to-medium, stylish nails that are easy to maintain.',
      heading: 'You want beautiful nails that fit your real life. ✨',
      intro: [
        'You want to look polished and put together — without committing to extra-long nails or a complicated routine.',
      ],
      leadIn: 'Your personalized recommendation:',
      product: 'THE ESSENTIAL MEMBERSHIP 🤍',
      body: [
        'ESSENTIAL is designed for clients who love stylish, short-to-medium nails with the perfect balance of beauty, convenience, and value.',
        'Whether your style is clean and minimal or you love a little nail art, this membership gives you a personalized nail routine that is easier to maintain.',
      ],
      whyTitle: 'Why ESSENTIAL is right for you:',
      why: [
        'Ideal for short-to-medium lengths',
        'Stylish, personalized nail looks',
        'A practical routine for your lifestyle',
        'Early schedule access and additional membership benefits',
        'Save $35+ every 4 weeks compared with qualifying services purchased individually',
        'Save $450+ or more over a year, depending on qualifying services and usage',
      ],
      closeTitle: 'Pretty should be easy.',
      close: [
        'You do not need extra-long nails to feel polished.',
        'You just need the right routine and a look designed around <strong>you.</strong>',
      ],
      kicker: 'Your personalized recommendation is ready.',
      cta: 'JOIN ESSENTIAL ✨',
      href: '/signup.html?tier=ESSENTIAL',
    },

    bold: {
      option: 'I want long, bold, creative nails that make a statement.',
      heading: 'You want nails that turn heads. ✨',
      intro: [
        'You love the details.',
        'The length. The creativity. The art. The full transformation.',
      ],
      leadIn: 'Your personalized recommendation:',
      product: 'THE ZOLA SIGNATURE NAIL EXPERIENCE 🤍',
      body: [
        'At ZOLA, you do not have to choose between <strong>creative nails and thoughtful nail care.</strong>',
        'We specialize in both.',
        'Your appointment is designed around your personal style, your nail goals, and the look you want to create.',
      ],
      whyTitle: 'Why ZOLA is right for you:',
      why: [
        'Long, customized nail sets',
        'Creative and detailed nail art',
        'A personalized look designed around your style',
        'Precision and thoughtful application',
        'Attention to your comfort and aftercare',
      ],
      closeTitle: 'Beauty is pain? Not here.',
      close: [
        'Your nail appointment should be an experience you look forward to.',
        'At ZOLA, we believe beautiful nails should come with thoughtful care, attention to detail, and a focus on your overall experience.',
        '<strong>You bring the vision. We bring it to life.</strong>',
      ],
      kicker: 'Ready for your transformation?',
      cta: 'EXPLORE MY PERFECT SERVICES ✨',
      href: '/services.html',
    },
  };

  var ORDER = ['grow', 'start', 'easy', 'bold'];

  function styles() {
    return [
      '#nj-wrap{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;',
      'justify-content:center;padding:clamp(14px,3.5vw,40px);opacity:0;transition:opacity .32s ease}',
      '#nj-wrap.nj-on{opacity:1}',
      /* The site stays visible around the edges, softened rather than hidden. */
      '#nj-veil{position:absolute;inset:0;background:rgba(13,13,13,0.55);',
      '-webkit-backdrop-filter:blur(9px);backdrop-filter:blur(9px)}',
      '#nj-box{position:relative;background:#F7F4EE;color:#0D0D0D;width:min(680px,100%);',
      'max-height:calc(100dvh - clamp(28px,7vw,80px));overflow-y:auto;overscroll-behavior:contain;',
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
      '.nj-pad{padding:clamp(26px,5vw,46px) clamp(22px,5vw,46px) clamp(28px,5vw,44px)}',
      '.nj-eyebrow{font-family:\'Josefin Sans\',sans-serif;font-size:0.62rem;letter-spacing:0.3em;',
      'text-transform:uppercase;color:#8C7A5E;margin-bottom:1rem}',
      '.nj-h1{font-family:\'Cinzel\',serif;font-size:clamp(1.5rem,4.2vw,2.05rem);line-height:1.25;',
      'color:#0D0D0D;margin:0 0 0.7rem;font-weight:400}',
      '.nj-lead{font-family:\'Josefin Sans\',sans-serif;font-size:clamp(0.92rem,2.4vw,1rem);',
      'line-height:1.75;color:#5a4f3f;margin:0 0 0.6rem}',
      '.nj-q{font-family:\'Cinzel\',serif;font-size:1.02rem;color:#0D0D0D;margin:1.7rem 0 0.9rem}',
      '.nj-opt{display:block;width:100%;text-align:left;background:#fff;color:#0D0D0D;',
      'border:1px solid rgba(140,122,94,0.35);padding:1.05rem 1.15rem;margin-bottom:0.65rem;',
      'font-family:\'Josefin Sans\',sans-serif;font-size:clamp(0.92rem,2.5vw,1rem);line-height:1.5;',
      'cursor:pointer;transition:all .16s ease;border-radius:2px}',
      '.nj-opt:hover{border-color:#0D0D0D;background:#0D0D0D;color:#F2ECE1;transform:translateY(-1px)}',
      '.nj-opt:focus-visible{outline:2px solid #0D0D0D;outline-offset:2px}',
      '.nj-opt b{display:block;font-weight:600}',
      /* the recommendation */
      '.nj-goal{background:#0D0D0D;color:#F2ECE1;padding:0.85rem 1.05rem;margin-bottom:1.3rem;',
      'font-family:\'Josefin Sans\',sans-serif;font-size:0.86rem;line-height:1.6}',
      '.nj-goal span{display:block;font-size:0.6rem;letter-spacing:0.26em;text-transform:uppercase;',
      'color:#B6A588;margin-bottom:0.3rem}',
      '.nj-leadin{font-family:\'Josefin Sans\',sans-serif;font-size:0.88rem;color:#8C7A5E;',
      'margin:1.4rem 0 0.5rem}',
      '.nj-product{font-family:\'Cinzel\',serif;font-size:clamp(1.25rem,3.6vw,1.6rem);color:#0D0D0D;',
      'margin:0 0 0.9rem;letter-spacing:0.02em}',
      '.nj-why{list-style:none;padding:0;margin:0.7rem 0 0}',
      '.nj-why li{font-family:\'Josefin Sans\',sans-serif;font-size:clamp(0.88rem,2.4vw,0.95rem);',
      'line-height:1.7;color:#3a3027;padding:0.3rem 0 0.3rem 1.6rem;position:relative}',
      '.nj-why li:before{content:\'✨\';position:absolute;left:0;top:0.3rem;font-size:0.8rem}',
      '.nj-sub{font-family:\'Cinzel\',serif;font-size:1.05rem;color:#0D0D0D;margin:1.6rem 0 0.6rem}',
      '.nj-kicker{font-family:\'Josefin Sans\',sans-serif;font-size:0.95rem;color:#0D0D0D;',
      'margin:1.6rem 0 0.8rem;font-weight:600}',
      /* one button, impossible to miss, and reachable on a phone */
      '.nj-cta{display:block;width:100%;background:#0D0D0D;color:#B6A588;border:none;',
      'padding:1.15rem 1.2rem;font-family:\'Josefin Sans\',sans-serif;font-size:clamp(0.78rem,2.2vw,0.85rem);',
      'font-weight:600;letter-spacing:0.16em;text-transform:uppercase;text-align:center;',
      'text-decoration:none;cursor:pointer;transition:all .18s ease;border-radius:2px}',
      '.nj-cta:hover{background:#B6A588;color:#0D0D0D}',
      '.nj-cta:focus-visible{outline:2px solid #0D0D0D;outline-offset:3px}',
      '.nj-back{display:block;width:100%;margin-top:0.75rem;background:none;border:none;',
      'font-family:\'Josefin Sans\',sans-serif;font-size:0.78rem;color:#8C7A5E;cursor:pointer;',
      'text-decoration:underline;text-underline-offset:3px;padding:0.5rem}',
      '@media (max-width:520px){#nj-box{width:100%}}',
      '@media (prefers-reduced-motion:reduce){#nj-wrap,#nj-box{transition:none}}',
    ].join('');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // The copy carries a little <strong> on purpose, so it is inserted as
  // written rather than escaped. Nothing here comes from a visitor.
  function paras(list, cls) {
    return (list || []).map(function (p) {
      return '<p class="' + cls + '">' + p + '</p>';
    }).join('');
  }

  var wrap, box;

  function close() {
    remember();
    if (!wrap) return;
    wrap.classList.remove('nj-on');
    document.documentElement.style.overflow = '';
    setTimeout(function () { if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); wrap = null; }, 340);
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
          return '<button class="nj-opt" data-nj="' + k + '"><b>' + (i + 1) + '. '
            + esc(ANSWERS[k].option) + '</b></button>';
        }).join('')
      + '</div>';

    box.querySelector('#nj-x').addEventListener('click', close);
    Array.prototype.forEach.call(box.querySelectorAll('[data-nj]'), function (b) {
      b.addEventListener('click', function () { showAnswer(b.getAttribute('data-nj')); });
    });
  }

  function showAnswer(key) {
    var a = ANSWERS[key];
    if (!a) return;

    box.innerHTML =
      '<button id="nj-x" aria-label="Close">×</button>'
      + '<div class="nj-pad">'
      + '<div class="nj-goal"><span>Your goal</span>' + esc(a.option) + '</div>'
      + '<h2 class="nj-h1">' + a.heading + '</h2>'
      + paras(a.intro, 'nj-lead')
      + '<div class="nj-leadin">' + a.leadIn + '</div>'
      + '<div class="nj-product">' + a.product + '</div>'
      + paras(a.body, 'nj-lead')
      + '<div class="nj-sub">' + a.whyTitle + '</div>'
      + '<ul class="nj-why">' + a.why.map(function (w) { return '<li>' + w + '</li>'; }).join('') + '</ul>'
      + '<div class="nj-sub">' + a.closeTitle + '</div>'
      + paras(a.close, 'nj-lead')
      + '<div class="nj-kicker">' + a.kicker + '</div>'
      + '<a class="nj-cta" href="' + a.href + '">' + a.cta + '</a>'
      + '<button class="nj-back" type="button">Actually, that’s not quite me</button>'
      + '</div>';

    box.querySelector('#nj-x').addEventListener('click', close);
    box.querySelector('.nj-back').addEventListener('click', showQuestion);
    // Taking them somewhere is an answer; it should not reopen next page.
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

    // The page behind should not scroll under the panel.
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
    // A beat, so the page paints first. Arriving on a blank screen behind a
    // panel feels like an ad; arriving on ZOLA that then offers to help does
    // not.
    setTimeout(open, 900);
  }

  // Available deliberately, so a link or a button anywhere can reopen it.
  window.ZolaJourney = { open: open, close: close };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
