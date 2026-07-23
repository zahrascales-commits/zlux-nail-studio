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

  /* ── REVEAL ON SCROLL (includes legacy .fade-in) ── */
  const revealEls = document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .fade-in');
  if (revealEls.length) {
    const ro = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          const delay = e.target.dataset.delay || '0s';
          e.target.style.transitionDelay = delay;
          e.target.classList.add('revealed');
          e.target.classList.add('visible');
          ro.unobserve(e.target);
        }
      });
    }, { threshold: 0.1 });
    revealEls.forEach(el => ro.observe(el));
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
     Timing tuned to published FOMO-notification research (Fomo.com /
     ProveSource field data): first toast ~8-12s in (visitor has absorbed
     the hero but hasn't decided to leave), each visible ~5s, then repeat
     on a RANDOMIZED 25-45s gap (a fixed interval reads as robotic once
     a visitor notices the rhythm). Capped at 6 appearances per session
     so a long visit never turns into spam — quiet luxury, not a flash sale. */
  const toast = document.getElementById('sp-toast');
  if (toast) {
    const msgs = [
      ['Appointment booked', 'Organic Manicure — this week'],
      ['Spot claimed', 'Signature Club now 92% full'],
      ['New member', 'Joined Luxe Club today'],
      ['Just viewed', 'Black Card — 4 founding spots remaining'],
      ['Appointment booked', 'Russian Dry Pedicure — this week'],
      ['Spot claimed', 'Luxe Club — 2 spots left'],
    ];
    const order = [...msgs.keys()].sort(() => Math.random() - 0.5); // shuffled, no immediate repeats
    let shown = 0;
    const MAX_SHOWS = 6;
    const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

    const show = () => {
      const [title, body] = msgs[order[shown % order.length]];
      toast.querySelector('.sp-toast-title').textContent = title;
      toast.querySelector('.sp-toast-body').textContent  = body;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 5000);
      shown++;
      if (shown < MAX_SHOWS) setTimeout(show, rand(25000, 45000));
    };
    setTimeout(show, rand(8000, 12000));
  }

  /* ── OWNER-UPLOADED SITE PHOTOS ──
     Any element with data-photo-slot="name" gets the photo Zahra uploaded
     in Studio Manager → Site → Site Photos. IMG tags get src; anything
     else becomes a covered background with a dark overlay for text. */
  const slotEls = document.querySelectorAll('[data-photo-slot]');
  if (slotEls.length) {
    fetch('/api/photos').then(r => r.json()).then(d => {
      const photos = (d && d.photos) || {};
      slotEls.forEach(el => {
        const url = photos[el.dataset.photoSlot];
        if (!url) return;
        if (el.tagName === 'IMG') { el.src = url; el.style.display = 'block'; }
        else {
          const overlay = el.dataset.photoOverlay !== 'none'
            ? 'linear-gradient(rgba(13,13,13,0.55), rgba(13,13,13,0.65)), ' : '';
          el.style.backgroundImage = overlay + 'url(' + url + ')';
          el.style.backgroundSize = 'cover';
          el.style.backgroundPosition = 'center';
        }
        el.classList.add('has-photo');
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
     Artists the owner flagged "Show on website" in Studio Manager appear
     on the homepage (#home-team-grid) and About page (#about-team-grid),
     each in that page's own card style, with the owner-written bio. */
  const homeGrid  = document.getElementById('home-team-grid');
  const aboutGrid = document.getElementById('about-team-grid');
  if (homeGrid || aboutGrid) {
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    fetch('/api/roster').then(r => r.json()).then(d => {
      const team = (d && d.team) || [];
      team.forEach(m => {
        const first = esc((m.name || '').split(' ')[0]);
        if (homeGrid) {
          const card = document.createElement('div');
          card.className = 'team-card';
          card.style.cssText = 'text-align:center;max-width:280px;';
          card.innerHTML =
            '<div class="team-avatar" style="margin:0 auto 1rem;background:' + esc(m.color) + '">' + esc(m.initial) + '</div>' +
            '<h3 style="font-size:1.3rem;margin-bottom:0.2rem;">' + esc(m.name) + '</h3>' +
            '<div class="section-label" style="font-size:0.58rem;margin-bottom:0.5rem;">' + esc(m.title) + '</div>' +
            '<span class="availability-badge available">Accepting Members</span>' +
            (m.bio ? '<p style="font-family:\'Josefin Sans\',sans-serif;font-size:0.82rem;color:var(--latte);margin:0.75rem 0 1rem;line-height:1.7;">' + esc(m.bio) + '</p>' : '<div style="height:0.75rem;"></div>') +
            '<a href="memberships.html" class="btn-outline-dark" style="font-size:0.68rem;">Book a Membership</a>';
          homeGrid.appendChild(card);
        }
        if (aboutGrid) {
          const card = document.createElement('div');
          card.style.cssText = 'max-width:220px;';
          card.innerHTML =
            '<div style="width:140px;height:140px;border-radius:50%;background:var(--blush);border:2px solid rgba(182,165,136,0.3);margin:0 auto 1.25rem;display:flex;align-items:center;justify-content:center;overflow:hidden;">' +
            '<span style="font-family:\'Cinzel\',serif;font-size:3rem;color:var(--latte);">' + esc(m.initial) + '</span></div>' +
            '<h3 style="font-size:1.35rem;margin-bottom:0.2rem;">' + esc(m.name) + '</h3>' +
            '<div class="section-label" style="font-size:0.58rem;margin-bottom:0.75rem;">' + esc(m.title) + '</div>' +
            '<span class="availability-badge available">Accepting Members</span>' +
            (m.bio ? '<p style="font-family:\'Josefin Sans\',sans-serif;font-size:0.82rem;color:var(--latte);margin:0.75rem 0 0;line-height:1.7;">' + esc(m.bio) + '</p>' : '') +
            '<div style="margin-top:1.25rem;"><a href="memberships.html" class="btn-outline-dark" style="font-size:0.68rem;display:inline-block;">Book with ' + first + '</a></div>';
          aboutGrid.appendChild(card);
        }
      });
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
    (function draw() {
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
    })();
  }

});
