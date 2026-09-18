document.addEventListener('DOMContentLoaded', () => {

  /* ── SCROLL PROGRESS ── */
  const prog = document.getElementById('scroll-progress');
  if (prog) {
    window.addEventListener('scroll', () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      prog.style.width = (max > 0 ? (window.scrollY / max) * 100 : 0) + '%';
    }, { passive: true });
  }

  /* ── STICKY NAV ── */
  const nav = document.getElementById('nav');
  if (nav) {
    window.addEventListener('scroll', () => {
      nav.classList.toggle('scrolled', window.scrollY > 40);
    }, { passive: true });
  }

  /* ── BACK TO TOP ── */
  const btt = document.getElementById('back-to-top');
  if (btt) {
    window.addEventListener('scroll', () => {
      btt.classList.toggle('visible', window.scrollY > 400);
    }, { passive: true });
    btt.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  /* ── MOBILE NAV (full-screen drawer) ── */
  const hamburger = document.getElementById('hamburger');
  const navMobile = document.getElementById('nav-mobile');
  if (hamburger && navMobile) {
    // Inject a close (×) button once, appended after the links so it never
    // shifts the nth-of-type stagger delays on the <a> tags.
    const closeBtn = document.createElement('button');
    closeBtn.className = 'nav-mobile-close';
    closeBtn.setAttribute('aria-label', 'Close menu');
    closeBtn.innerHTML = '&times;';
    navMobile.appendChild(closeBtn);

    const openMenu = () => {
      navMobile.classList.add('open');
      hamburger.classList.add('open');
      document.body.style.overflow = 'hidden';
    };
    const closeMenu = () => {
      navMobile.classList.remove('open');
      hamburger.classList.remove('open');
      document.body.style.overflow = '';
    };

    hamburger.addEventListener('click', () => {
      navMobile.classList.contains('open') ? closeMenu() : openMenu();
    });
    closeBtn.addEventListener('click', closeMenu);
    // Tapping the dark backdrop itself (not a link) also closes it
    navMobile.addEventListener('click', (e) => {
      if (e.target === navMobile) closeMenu();
    });
    navMobile.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', closeMenu);
    });
    // Escape key closes it (desktop/keyboard users)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
  }

  /* ── ACTIVE NAV LINK ── */
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === path || (path === '' && href === 'index.html')) {
      a.classList.add('active');
    }
  });

  /* ── REVEAL ON SCROLL (includes legacy .fade-in) ──
     Also watches for content that arrives after the page loads. The two
     membership cards on the homepage are drawn from /api/plans a moment
     later, carrying .reveal — and because they were not on the page when
     this looked, nothing ever revealed them. Every visitor saw a heading,
     a blank gap the height of two cards, and a button. */
  const REVEAL_SEL = '.reveal, .reveal-left, .reveal-right, .fade-in';
  const revealNow = el => {
    el.style.transitionDelay = el.dataset.delay || '0s';
    el.classList.add('revealed');
    el.classList.add('visible');
  };
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll(REVEAL_SEL).forEach(revealNow);
  } else {
    const ro = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { revealNow(e.target); ro.unobserve(e.target); }
      });
    }, { threshold: 0.1 });
    const watch = el => { if (!el.classList.contains('revealed')) ro.observe(el); };
    document.querySelectorAll(REVEAL_SEL).forEach(watch);
    new MutationObserver(muts => {
      muts.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.matches && n.matches(REVEAL_SEL)) watch(n);
        if (n.querySelectorAll) n.querySelectorAll(REVEAL_SEL).forEach(watch);
      }));
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ── BUTTON RIPPLE ── */
  document.querySelectorAll('.btn-gold, .btn-outline, .btn-outline-dark').forEach(btn => {
    btn.addEventListener('click', function (e) {
      const rect = this.getBoundingClientRect();
      const r = document.createElement('span');
      r.className = 'ripple';
      const size = Math.max(rect.width, rect.height);
      r.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size / 2}px;top:${e.clientY - rect.top - size / 2}px`;
      this.appendChild(r);
      r.addEventListener('animationend', () => r.remove());
    });
  });

  /* ── CUSTOM CURSOR (fine-pointer / mouse only) ── */
  if (window.matchMedia('(pointer: fine)').matches && !('ontouchstart' in window)) {
    const dot  = document.getElementById('cursor-dot');
    const ring = document.getElementById('cursor-ring');
    if (dot && ring) {
      document.body.classList.add('cursor-custom');
      let mx = 0, my = 0, rx = 0, ry = 0;
      document.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });
      (function tick() {
        dot.style.left = mx + 'px';
        dot.style.top  = my + 'px';
        rx += (mx - rx) * 0.13;
        ry += (my - ry) * 0.13;
        ring.style.left = rx + 'px';
        ring.style.top  = ry + 'px';
        requestAnimationFrame(tick);
      })();
      document.querySelectorAll('a, button, .membership-card, .team-card, .how-step, .faq-question').forEach(el => {
        el.addEventListener('mouseenter', () => document.body.classList.add('cursor-hovering'));
        el.addEventListener('mouseleave', () => document.body.classList.remove('cursor-hovering'));
      });
    }
  }

  /* ── FAQ ACCORDION ── */
  document.querySelectorAll('.faq-question').forEach(q => {
    q.addEventListener('click', () => {
      const item = q.closest('.faq-item');
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });

  /* ── SOCIAL PROOF TOASTS ──
     Only things that happened: a booking somebody actually made this week
     (the service and when — never who), or a review a client wrote at the
     kiosk and said we could share. These used to be six lines typed into
     the page — "Signature Club now 92% full", "4 founding spots remaining"
     — about memberships no longer sold, shown to every visitor as if live.
     Invented activity is the one thing this studio does not do, however
     well it converts; with nothing real to say, nothing shows.
     Three a visit at most, the first once they have settled in, and never
     on top of another panel. */
  const toast = document.getElementById('sp-toast');
  if (toast) {
    const KEY = 'zola_proof_shown';
    let seen = 0;
    try { seen = Number(sessionStorage.getItem(KEY)) || 0; } catch (_) {}
    const MAX = 3;
    const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
    const busy = () => !!document.querySelector('#nj-wrap, .nj-nudge.on, .urgency-banner.visible, .ig-sheet.open, .chat-box.open');

    if (seen < MAX) (window.zolaProof || (window.zolaProof = fetch('/api/proof').then(r => r.json()).catch(() => null))).then(d => {
      const msgs = [];
      ((d && d.recent) || []).forEach(b => msgs.push(['Booked at ZOLA', b.service + ' · ' + b.ago]));
      ((d && d.reviews) || []).slice(0, 4).forEach(r => {
        const t = r.text.length > 90 ? r.text.slice(0, 88).replace(/\s+\S*$/, '') + '…' : r.text;
        msgs.push(['★★★★★'.slice(0, r.stars) + '  ' + r.name, '“' + t + '”']);
      });
      if (!msgs.length) return;
      const order = [...msgs.keys()].sort(() => Math.random() - 0.5);
      let i = 0;
      const show = () => {
        if (seen >= MAX || i >= order.length) return;
        if (busy()) { setTimeout(show, 8000); return; }
        const [title, body] = msgs[order[i++]];
        toast.querySelector('.sp-toast-title').textContent = title;
        toast.querySelector('.sp-toast-body').textContent  = body;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 5500);
        seen++;
        try { sessionStorage.setItem(KEY, String(seen)); } catch (_) {}
        setTimeout(show, rand(35000, 55000));
      };
      setTimeout(show, rand(14000, 20000));
    }).catch(() => {});
  }

  /* ── OWNER-UPLOADED SITE PHOTOS ──
     Any element with data-photo-slot="name" gets the photo Zahra uploaded
     in Studio Manager → Site → Site Photos. IMG tags get src; anything
     else becomes a covered background with a dark overlay for text. */
  const slotEls = document.querySelectorAll('[data-photo-slot]');
  if (slotEls.length) {
    // Each slot is a real image URL with its version in it, so the browser
    // caches it like any other picture and a changed photo is a changed
    // address. What used to happen — page paints empty, a JSON blob
    // containing every photo on the site arrives, photos pop in — is what
    // the flash was.
    const urlFor = (slot, v) => '/api/photo?slot=' + encodeURIComponent(slot) + '&v=' + (v || 1);

    // A photo well down the page waits until the visitor is heading its way:
    // the princess-party picture alone was half a megabyte on every phone
    // that never scrolled that far.
    const later = 'IntersectionObserver' in window
      ? new IntersectionObserver(es => es.forEach(e => {
          if (!e.isIntersecting) return;
          later.unobserve(e.target);
          if (e.target._paint) { e.target._paint(); e.target._paint = null; }
        }), { rootMargin: '800px 0px' })
      : null;
    const farDown = el => later && el.getBoundingClientRect().top > window.innerHeight * 1.5;

    const apply = (versions) => {
      slotEls.forEach(el => {
        const slot = el.dataset.photoSlot;
        if (!(slot in versions)) return;
        const url = urlFor(slot, versions[slot]);
        if (el.dataset.photoApplied === url) return;   // already showing this one
        el.dataset.photoApplied = url;
        const paint = () => {
          if (el.tagName === 'IMG') { el.src = url; el.style.display = 'block'; }
          else {
            const overlay = el.dataset.photoOverlay !== 'none'
              ? 'linear-gradient(rgba(13,13,13,0.55), rgba(13,13,13,0.65)), ' : '';
            el.style.backgroundImage = overlay + 'url(' + url + ')';
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
          }
          el.classList.add('has-photo');
        };
        if (farDown(el)) { el._paint = paint; later.observe(el); }
        else paint();
      });
    };

    // Remembered from last time, applied before anything is fetched. The
    // image itself is already in the browser cache under the same URL, so on
    // every visit after the first the photo is simply there.
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem('zlux_photo_versions') || 'null'); } catch (_) {}
    if (cached) apply(cached);

    // Then confirm. A few hundred bytes, and it only redraws a slot whose
    // version actually moved.
    fetch('/api/photos?action=manifest').then(r => r.json()).then(d => {
      const versions = (d && d.versions) || {};
      apply(versions);
      try { localStorage.setItem('zlux_photo_versions', JSON.stringify(versions)); } catch (_) {}
    }).catch(() => {});
  }

  /* ── MOVE UP A TIER ──
     A signed-in member sees, on any page, that there is a tier above theirs.
     Only ever shown to somebody who is actually signed in and actually has
     room to move — a bar telling a Black Card member to upgrade is an
     advert for nothing, and one shown to a stranger is noise.

     Dismissing it is remembered for a fortnight rather than forever: she
     wants this in front of members, but not on every page of every visit
     for the rest of their lives. */
  (async function upgradeBar(){
    var token = null;
    try { token = localStorage.getItem('zlux_token'); } catch (_) {}
    if (!token) return;
    try { if (localStorage.getItem('zlux_upgrade_hidden') > Date.now()) return; } catch (_) {}
    if (/client-portal|signup|booking/.test(location.pathname)) return;

    var d;
    try {
      var r = await fetch('/api/upgrade', { headers: { Authorization: 'Bearer ' + token } });
      d = await r.json();
    } catch (_) { return; }
    if (!d || d.error || d.at_top || !(d.options || []).length) return;

    var next = d.options[0];
    var per = d.billing === 'yearly' ? 'a year' : 'a month';
    var bar = document.createElement('div');
    bar.setAttribute('role','region');
    bar.setAttribute('aria-label','Membership upgrade');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:900;background:#0D0D0D;'
      + 'border-top:1px solid rgba(196,168,130,0.45);padding:0.85rem 1.1rem;display:flex;'
      + 'gap:0.9rem;align-items:center;flex-wrap:wrap;font-family:"Josefin Sans",sans-serif;'
      + 'box-shadow:0 -8px 30px rgba(0,0,0,0.4)';
    bar.innerHTML =
      '<span style="font-size:0.84rem;color:#F5EEE8;flex:1;min-width:190px;line-height:1.6">'
        + 'You are on <strong style="color:#DDD0B8">' + (d.current_label || '') + '</strong>. '
        + '<strong style="color:#C4A882">' + next.label + '</strong> is only $'
        + Math.round(next.difference_cents / 100) + ' more ' + per + '.</span>'
      + '<a href="client-portal.html" style="background:#C4A882;color:#0D0D0D;padding:0.55rem 1.1rem;'
        + 'border-radius:100px;font-size:0.7rem;font-weight:700;letter-spacing:0.14em;'
        + 'text-transform:uppercase;text-decoration:none;white-space:nowrap">See what you get</a>'
      + '<button aria-label="Dismiss" style="background:none;border:none;color:#8C7A5E;'
        + 'font-size:1.3rem;cursor:pointer;line-height:1;padding:0 0.3rem">&times;</button>';
    bar.querySelector('button').onclick = function () {
      try { localStorage.setItem('zlux_upgrade_hidden', Date.now() + 14 * 24 * 3600 * 1000); } catch (_) {}
      bar.remove();
    };
    document.body.appendChild(bar);
  })();

  /* ── OWNER-EDITABLE COPY ──
     [data-site-text="key"] takes the plain text she typed in Studio Manager
     → Site; [data-site-html="key"] allows the line break and gold span the
     hero quote is built around. Whatever is already in the element is the
     default, so an empty setting never blanks the page. */
  const textEls = document.querySelectorAll('[data-site-text],[data-site-html]');
  if (textEls.length) {
    fetch('/api/site-settings').then(r => r.json()).then(d => {
      const s = (d && d.settings) || {};
      textEls.forEach(el => {
        const tk = el.dataset.siteText, hk = el.dataset.siteHtml;
        if (tk && s[tk]) el.textContent = s[tk];
        else if (hk && s[hk]) el.innerHTML = s[hk];
      });
    }).catch(() => {});
  }

  /* ── SHOP THE LOOK GRID ──
     Cards come from the same service names the booking page uses, each with
     two photo slots so hovering swaps the set on its own for the worn shot.
     Tapping a card lands on booking with that service already selected. */
  /* ── THE MENU ──
     Same grouping as the cards above: the service, then its lengths when
     you open it. Prices come from the live menu, so they can never drift
     from what the booking page actually charges. */
  const menuMani = document.getElementById('menu-mani');
  const menuPedi = document.getElementById('menu-pedi');
  if (menuMani && menuPedi && window.ZolaServices) {
    const escM = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    fetch('/api/services').then(r => r.json()).then(d => {
      const groups = window.ZolaServices.group((d && d.services) || (Array.isArray(d) ? d : []));
      if (!groups.length) return;
      const isPedi = g => /pedicure/i.test(g.name);
      const row = g => {
        if (!g.sized) {
          return '<a class="service-row" href="booking.html?rebook=' + encodeURIComponent(g.variants[0].name) + '">' +
            '<span class="service-name">' + escM(g.name) + '</span>' +
            '<span class="service-price">' + escM(g.price_label) + '</span></a>';
        }
        return '<details class="service-group">' +
          '<summary class="service-row"><span class="service-name">' + escM(g.name) +
            '<span class="service-more">Short · Medium · Long</span></span>' +
          '<span class="service-price">' + escM(g.price_label) + '</span></summary>' +
          g.variants.map(v =>
            '<a class="service-row service-sub" href="booking.html?rebook=' + encodeURIComponent(v.name) + '">' +
              '<span class="service-name">' + escM(v.size || v.name) + '</span>' +
              '<span class="service-price">' + window.ZolaServices.money(v.price_cents) + '</span></a>').join('') +
        '</details>';
      };
      const mani = groups.filter(g => !isPedi(g));
      const pedi = groups.filter(isPedi);
      if (mani.length) menuMani.innerHTML = mani.map(row).join('');
      if (pedi.length) menuPedi.innerHTML = pedi.map(row).join('');
    }).catch(() => {});
  }

  /* ── SHOP MY IG ──
     Real posts, tagged with what's in them. Tapping a photo opens a sheet
     listing those exact products — services go to booking preselected,
     press-ons go to their checkout. The whole section stays hidden until
     she has posted something, so the page never shows an empty row. */
  const igGrid = document.getElementById('ig-grid');
  if (igGrid) {
    const sheet = document.getElementById('ig-sheet');
    const esc = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const closeSheet = () => {
      sheet.classList.remove('open');
      sheet.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    };
    const openSheet = (post) => {
      document.getElementById('ig-sheet-photo').style.backgroundImage = 'url("' + post.photo + '")';
      document.getElementById('ig-sheet-cap').textContent = post.caption || '';
      const items = document.getElementById('ig-sheet-items');
      if (!post.tags.length) {
        items.innerHTML = '<a class="ig-buy" href="booking.html">Book an appointment <span>→</span></a>';
      } else {
        items.innerHTML = post.tags.map(t => {
          const href = t.type === 'presson'
            ? 'pressons.html?product=' + encodeURIComponent(t.name)
            : 'booking.html?rebook=' + encodeURIComponent(t.name);
          const cta = t.type === 'presson' ? 'Add to Cart' : 'Book This';
          return '<a class="ig-buy" href="' + href + '">' +
            '<span class="ig-buy-n">' + esc(t.name) + (t.price ? ' <em>' + esc(t.price) + '</em>' : '') + '</span>' +
            '<span class="ig-buy-b">' + cta + '</span></a>';
        }).join('');
      }
      sheet.classList.add('open');
      sheet.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
    };

    document.getElementById('ig-sheet-x').addEventListener('click', closeSheet);
    sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && sheet.classList.contains('open')) closeSheet();
    });

    fetch('/api/shopig').then(r => r.json()).then(d => {
      const posts = (d && d.posts) || [];
      if (!posts.length) return; // section stays hidden
      document.getElementById('shop-ig').style.display = '';
      // Each photo is its own cached image now; it loads as it nears the
      // screen rather than all at once with the page.
      igGrid.innerHTML = posts.map((p, i) =>
        '<button class="ig-cell" data-i="' + i + '" aria-label="Shop this photo"' +
        ' data-bg="' + esc(p.photo) + '">' +
          '<span class="ig-cell-veil"><span class="ig-cell-cta">Shop Now</span>' +
          (p.tags.length ? '<span class="ig-cell-n">' + p.tags.length + ' item' + (p.tags.length === 1 ? '' : 's') + '</span>' : '') +
          '</span></button>').join('');
      const paint = btn => { if (btn.dataset.bg) { btn.style.backgroundImage = 'url("' + btn.dataset.bg + '")'; btn.removeAttribute('data-bg'); } };
      const near = 'IntersectionObserver' in window
        ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { paint(e.target); near.unobserve(e.target); } }), { rootMargin: '400px 0px' })
        : null;
      igGrid.querySelectorAll('.ig-cell').forEach(btn => {
        if (near) near.observe(btn); else paint(btn);
        btn.addEventListener('click', () => openSheet(posts[Number(btn.dataset.i)]));
      });
    }).catch(() => {});
  }

  /* ── PUBLIC WORKING HOURS ──
     Any [data-biz-hours] element shows the hours the owner typed in
     Studio Manager → Settings → Public Working Hours (falls back to
     whatever text is already in the element). */
  const hoursEls = document.querySelectorAll('[data-biz-hours]');
  if (hoursEls.length) {
    fetch('/api/site-settings').then(r => r.json()).then(d => {
      const h = d && d.settings && d.settings.biz_hours;
      if (h) hoursEls.forEach(el => { el.textContent = h; });
    }).catch(() => {});
  }

  /* ── PUBLIC TEAM ROSTER ──
     Artists flagged "Show on website" in Studio Manager. One renderer for
     both pages: a portrait, a name, a title, and an optional bio. The card is
     a fixed shape so three of them line up as real columns instead of the
     ragged, overlapping stack this used to be. The grid is filled rather than
     appended to, so a hardcoded placeholder can never double up with a real
     artist of the same name. */
  const homeGrid  = document.getElementById('home-team-grid');
  const aboutGrid = document.getElementById('about-team-grid');
  if (homeGrid || aboutGrid) {
    const esc = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // No booking button and no service list. Choosing your artist is a
    // Black Card benefit, so a public "Book with Maria" link would hand it
    // to everyone for free. And listing who does what dates itself the
    // moment the team is cross-trained, which is where this is heading.
    const card = (m) =>
      '<article class="team-col">' +
        '<div class="team-photo' + (m.photo ? '' : ' team-photo-empty') + '">' +
          (m.photo
            ? '<img src="' + esc(m.photo) + '" alt="' + esc(m.name) + '" loading="lazy">'
            : '<span class="team-photo-initial" style="color:' + esc(m.color) + '">' + esc(m.initial) + '</span>') +
        '</div>' +
        '<h3 class="team-name">' + esc(m.name) + '</h3>' +
        '<div class="team-role">' + esc(m.title) + '</div>' +
        (m.bio ? '<p class="team-bio">' + esc(m.bio) + '</p>' : '') +
      '</article>';

    fetch('/api/roster').then(r => r.json()).then(d => {
      const team = (d && d.team) || [];
      if (!team.length) return;
      if (homeGrid)  homeGrid.innerHTML  = team.map(card).join('');
      if (aboutGrid) aboutGrid.innerHTML = team.map(card).join('');
    }).catch(() => {});
  }

  /* ── HERO PARTICLE CANVAS ── */
  const canvas = document.getElementById('hero-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0;
    const pts = [];
    const resize = () => {
      W = canvas.width  = canvas.offsetWidth;
      H = canvas.height = canvas.offsetHeight;
    };
    resize();
    window.addEventListener('resize', resize, { passive: true });
    for (let i = 0; i < 55; i++) {
      pts.push({
        x: Math.random() * W, y: Math.random() * H,
        r: Math.random() * 1.4 + 0.3,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        a: Math.random() * 0.5 + 0.15,
      });
    }
    // Only while the hero is on screen — drawing it all the way down the
    // page was a phone's battery spent on something nobody could see.
    let heroOn = true, drawing = false;
    const draw = () => {
      if (!heroOn) { drawing = false; return; }
      drawing = true;
      ctx.clearRect(0, 0, W, H);
      pts.forEach(p => {
        p.x = (p.x + p.vx + W) % W;
        p.y = (p.y + p.vy + H) % H;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, 6.283);
        ctx.fillStyle = `rgba(196,168,130,${p.a})`;
        ctx.fill();
      });
      requestAnimationFrame(draw);
    };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(es => {
        heroOn = es[0].isIntersecting;
        if (heroOn && !drawing) draw();
      }).observe(canvas);
    }
    draw();
  }

  /* ── BOOK BAR (phones) ──
     Nine in ten visitors arrive from Instagram on a phone, and once the hero
     has scrolled away there was nothing on screen that books. This keeps
     one button in reach, on the pages where people browse. Not on booking
     or checkout (they are already there), not on the memberships page (its
     own button is the one that matters), and not for a signed-in member
     who is being shown their upgrade bar in the same spot. */
  (function bookBar() {
    const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    const ON = ['index.html', 'services.html', 'about.html', 'classes.html', 'contact.html', 'pressons.html'];
    if (ON.indexOf(page) < 0) return;
    if (!window.matchMedia || !window.matchMedia('(max-width: 760px)').matches) return;

    const bar = document.createElement('div');
    bar.className = 'book-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Book an appointment');
    bar.innerHTML =
      '<div class="book-bar-txt"><span class="book-bar-t">ZOLA Nail Studio</span>' +
      '<span class="book-bar-s">Porterville · by appointment</span></div>' +
      '<a class="book-bar-go" href="booking.html">Book now</a>';
    document.body.appendChild(bar);

    // The deal days are the strongest reason to book this week; say them.
    fetch('/api/deals').then(r => r.json()).then(d => {
      const ds = (d && d.deals) || [];
      if (!ds.length) return;
      const lead = ds.find(x => x.featured) || ds[0];
      const rest = ds.filter(x => x !== lead).map(x => x.name);
      bar.querySelector('.book-bar-t').textContent = lead.name;
      bar.querySelector('.book-bar-s').textContent = rest.length ? rest.join(' · ') + ' too · hands or toes' : 'Hands or toes · every ' + lead.weekday_name;
    }).catch(() => {});

    const upgradeShowing = () => !!document.querySelector('[aria-label="Membership upgrade"]');
    const sync = () => {
      const on = window.scrollY > window.innerHeight * 0.55 && !upgradeShowing();
      bar.classList.toggle('on', on);
      document.body.classList.toggle('has-bookbar', on);
    };
    window.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync, { passive: true });
    sync();
  })();

});
