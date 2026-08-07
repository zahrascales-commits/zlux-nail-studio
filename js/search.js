/* ZOLA site search — self-injecting.
 *
 * Drop <script src="js/search.js"></script> on any page and it adds a search
 * button to the nav, a full-screen search overlay, and instant results.
 *
 * Built to be forgiving: "small gel x", "gelx", "short gelex", "how much",
 * "mani", "kids party" all land on the right thing, because every entry
 * carries synonyms and the matcher tolerates typos. Service results link
 * STRAIGHT into the booking flow with that service already selected.
 */
(function () {
  'use strict';

  // ── The index ───────────────────────────────────────────────────────────
  // t=title  s=subtitle  u=url  c=category  k=extra search words
  const bookUrl = n => 'booking.html?rebook=' + encodeURIComponent(n);
  const focusUrl = g => 'booking.html?focus=' + encodeURIComponent(g);

  const INDEX = [
    // ── Services (deep-link into booking, service pre-selected) ──
    { t: 'Organic Structured Manicure', s: '$90 · Healthiest option — built for nail growth', u: bookUrl('Organic Structured Manicure'), c: 'Service',
      k: 'organic structure structured manicure mani natural overlay healthy growth recommended basic regular' },
    { t: 'Short Gel X', s: '$95 · Gel-X extensions, short length', u: bookUrl('Short Gel X'), c: 'Service',
      k: 'gelx gel-x gel x extension extensions small short tiny petite mini' },
    { t: 'Medium Gel X', s: '$100 · Gel-X extensions, medium length', u: bookUrl('Medium Gel X'), c: 'Service',
      k: 'gelx gel-x gel x extension extensions medium mid regular normal' },
    { t: 'Long Gel X', s: '$110 · Gel-X extensions, long length', u: bookUrl('Long Gel X'), c: 'Service',
      k: 'gelx gel-x gel x extension extensions long big large xl stiletto' },
    { t: 'Short Acrylic Set', s: '$95 · Acrylic set, short length', u: bookUrl('Short Acrylic Set'), c: 'Service',
      k: 'acrylic acrylics set small short tiny petite mini' },
    { t: 'Medium Acrylic Set', s: '$100 · Acrylic set, medium length', u: bookUrl('Medium Acrylic Set'), c: 'Service',
      k: 'acrylic acrylics set medium mid regular normal' },
    { t: 'Long Acrylic Set', s: '$110 · Acrylic set, long length', u: bookUrl('Long Acrylic Set'), c: 'Service',
      k: 'acrylic acrylics set long big large xl stiletto coffin' },
    { t: 'Russian Dry Pedicure', s: '$95 · Water-free, grows your natural toenails out', u: bookUrl('Russian Dry Pedicure'), c: 'Service',
      k: 'pedicure pedi toes feet foot russian dry waterless water free toenails' },
    { t: 'Russian Dry Pedicure — Full Correction', s: '$125 · Complete foot renewal + callus correction', u: bookUrl('Russian Dry Pedicure — Full Correction'), c: 'Service',
      k: 'pedicure pedi toes feet foot russian dry full correction callus calluses exfoliation buffing repair' },

    // ── Groups (land on the length picker) ──
    { t: 'Gel X Extensions', s: 'Short $95 · Medium $100 · Long $110 — pick your length', u: focusUrl('Gel X'), c: 'Service',
      k: 'gelx gel-x gel x extension extensions lengths all sizes' },
    { t: 'Acrylic Sets', s: 'Short $95 · Medium $100 · Long $110 — pick your length', u: focusUrl('Acrylic'), c: 'Service',
      k: 'acrylic acrylics set sets lengths all sizes' },

    // ── Add-ons ──
    { t: 'Soak Off Removal', s: '+$35 add-on · Coming in with nails from another salon', u: bookUrl('Organic Structured Manicure'), c: 'Add-On',
      k: 'removal remove soak off take off old nails existing acrylics gel' },
    { t: 'Russian Manicure', s: '+$30 add-on · Precise cuticle work, editorial finish', u: bookUrl('Organic Structured Manicure'), c: 'Add-On',
      k: 'russian manicure technique cuticle dry mani clean precise' },
    { t: 'Nail Art', s: '+$25 add-on · Custom design', u: bookUrl('Organic Structured Manicure'), c: 'Add-On',
      k: 'nail art design designs chrome french tips glitter custom drawing' },
    { t: 'Scrub Treatment', s: '+$20 add-on', u: bookUrl('Organic Structured Manicure'), c: 'Add-On', k: 'scrub exfoliate treatment hands' },
    { t: 'Lotion Massage', s: '+$15 add-on', u: bookUrl('Organic Structured Manicure'), c: 'Add-On', k: 'lotion massage hand relax' },

    // ── Memberships ──
    { t: 'Signature Club — $99/mo', s: '1 service a month · 50% off add-ons', u: 'memberships.html#signature', c: 'Membership',
      k: 'signature membership member plan subscribe subscription monthly tier cheapest basic entry 99' },
    { t: 'Luxe Club — $199/mo', s: '2 services a month · add-ons free · most popular', u: 'memberships.html#luxe', c: 'Membership',
      k: 'luxe deluxe membership member plan subscribe subscription monthly tier popular middle 199' },
    { t: 'Black Card — $299/mo', s: '2 services · pick your artist · everything free', u: 'memberships.html#black-card', c: 'Membership',
      k: 'black card blackcard vip membership member plan subscribe premium best top exclusive founding 299' },
    { t: 'Compare all memberships', s: 'See every tier side by side', u: 'memberships.html#compare', c: 'Membership',
      k: 'membership memberships compare tiers plans pricing options which best difference' },
    { t: 'Join a membership', s: 'Pick your tier and reserve your spot', u: 'signup.html', c: 'Membership',
      k: 'join signup sign up become member register enroll start subscribe' },

    // ── Key actions ──
    { t: 'Book an appointment', s: 'Reserve online in under two minutes', u: 'booking.html', c: 'Book',
      k: 'book booking appointment appt schedule reserve reservation make set up availability calendar times slot' },
    { t: 'My Member Portal', s: 'Your QR code, history, and appointments', u: 'client-portal.html', c: 'Account',
      k: 'portal login log in member id account sign in qr code my nails history' },
    { t: 'My Account', s: 'See your bookings and rebook in one tap', u: 'account.html', c: 'Account',
      k: 'account login log in my bookings rebook profile sign in' },
    { t: 'Team Login', s: 'For ZOLA artists', u: 'team.html', c: 'Account', k: 'team staff worker artist employee login pin portal' },

    // ── Pages ──
    { t: 'Full Service Menu', s: 'Every service and price', u: 'services.html', c: 'Page',
      k: 'services menu list prices pricing cost how much rates what do you offer treatments' },
    { t: 'Press-Ons', s: 'Hand-crafted sets — first drop coming soon', u: 'pressons.html', c: 'Page',
      k: 'press on presson press-ons pressons fake false stick on glue nails sets shop store buy purchase order drop' },
    { t: 'Classes', s: 'Learn Russian manicure, hard gel, and acrylic', u: 'classes.html', c: 'Page',
      k: 'class classes course training teach learn lesson workshop certification student education' },
    { t: 'About ZOLA', s: 'The studio and the standard', u: 'about.html', c: 'Page',
      k: 'about story who zahra owner founder studio team artists meet history' },
    { t: 'Contact & Hours', s: 'Porterville, CA · hours · Instagram', u: 'contact.html', c: 'Page',
      k: 'contact hours open close location address where directions map phone email message reach dm instagram tiktok social' },

    // ── Questions people actually type ──
    { t: 'Princess Parties', s: '$20 per child · we travel to you · 6 child minimum', u: 'services.html#princess', c: 'Info',
      k: 'princess party parties kid kids child children birthday daughter girls event group travel mobile' },
    { t: 'Do I pay a deposit?', s: 'Members pay $0 · guests pay 50% at booking', u: 'memberships.html#faq', c: 'Info',
      k: 'deposit deposits pay payment upfront hold 50% cost charge card' },
    { t: 'Cancellation policy', s: 'Free to change with 24+ hours notice', u: 'memberships.html#faq', c: 'Info',
      k: 'cancel cancellation reschedule change move refund no show noshow late policy 24 hours' },
    { t: 'Birthday Month Upgrade', s: 'A free gift during your birthday month', u: 'memberships.html#faq', c: 'Info',
      k: 'birthday bday gift free upgrade month present celebrate' },
    { t: 'Free sizing kit', s: 'Free with your first press-on order — sizes saved forever', u: 'pressons.html', c: 'Info',
      k: 'sizing size kit sizes fit measure press on free first order' },
    { t: 'Gift cards', s: 'Available — reach out and we\'ll send one', u: 'contact.html', c: 'Info',
      k: 'gift card cards certificate voucher present buy for someone' },
    { t: 'Prices & pricing', s: 'Services from $90 · memberships from $99/mo', u: 'services.html', c: 'Info',
      k: 'price prices pricing cost costs how much expensive cheap rate rates fee fees money dollars' },
    { t: 'Tipping', s: 'Add a tip at checkout — members too, always optional', u: 'booking.html', c: 'Info',
      k: 'tip tips tipping gratuity leave a tip percent percentage cash extra thank you optional' },
    { t: 'Ways to pay', s: 'Card, Apple Pay, Google Pay, or cash in studio', u: 'booking.html', c: 'Info',
      k: 'pay payment methods card credit debit apple pay applepay google pay cash venmo checkout accept take' },
    { t: 'How long does it take?', s: 'Every appointment is booked as a 2-hour block', u: 'booking.html', c: 'Info',
      k: 'how long time duration hours long take appointment length block 2 two wait' },
    { t: 'First time here?', s: 'Book any service — no membership required', u: 'booking.html', c: 'Info',
      k: 'first time new client customer never been beginner start begin walk in walkin guest nonmember non member' },
    { t: 'Where are you located?', s: 'Porterville, California · by appointment only', u: 'contact.html', c: 'Info',
      k: 'where location located address directions map parking porterville california ca city studio salon find' },
    { t: 'Who does my nails?', s: 'Pick your artist with Black Card — otherwise we match you', u: 'memberships.html#black-card', c: 'Info',
      k: 'who artist tech technician nail tech preference pick choose request zahra maria worker staff team' },
  ];

  // ── Query understanding ─────────────────────────────────────────────────
  // Words people type -> words the index actually uses.
  const SYNONYMS = {
    small: 'short', tiny: 'short', petite: 'short', mini: 'short', xs: 'short',
    big: 'long', large: 'long', xl: 'long', longest: 'long', extra: 'long',
    mid: 'medium', regular: 'medium', normal: 'medium', average: 'medium',
    mani: 'manicure', manicures: 'manicure', manicure: 'manicure',
    pedi: 'pedicure', pedis: 'pedicure', pedicures: 'pedicure', toes: 'pedicure', feet: 'pedicure', foot: 'pedicure',
    gelx: 'gel x', 'gel-x': 'gel x', gelex: 'gel x', gels: 'gel',
    acrylics: 'acrylic', acryllic: 'acrylic', acrilic: 'acrylic',
    nails: 'nail', nail: 'nail',
    appt: 'appointment', appointments: 'appointment', booking: 'book', bookings: 'book',
    schedule: 'book', reserve: 'book', 'sign-up': 'signup',
    cost: 'price', costs: 'price', prices: 'price', pricing: 'price', 'how much': 'price',
    membership: 'membership', memberships: 'membership', member: 'membership',
    subscription: 'membership', subscribe: 'membership', plan: 'membership', plans: 'membership',
    blackcard: 'black card', vip: 'black card',
    presson: 'press on', pressons: 'press on', 'press-on': 'press on', 'press-ons': 'press on',
    fake: 'press on', false: 'press on', glue: 'press on',
    classes: 'class', course: 'class', courses: 'class', lesson: 'class', training: 'class',
    hours: 'hours', open: 'hours', closed: 'hours', close: 'hours',
    where: 'location', address: 'location', located: 'location', directions: 'location',
    kid: 'kids', child: 'kids', children: 'kids', party: 'kids',
    remove: 'removal', 'soak off': 'removal', soakoff: 'removal',
    art: 'nail art', design: 'nail art', designs: 'nail art',
  };

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();

  function expand(q) {
    let s = ' ' + norm(q) + ' ';
    // multi-word synonyms first
    for (const key of Object.keys(SYNONYMS)) {
      if (key.includes(' ') || key.includes('-')) {
        s = s.split(' ' + key + ' ').join(' ' + SYNONYMS[key] + ' ');
      }
    }
    const out = [];
    for (const w of s.trim().split(' ')) {
      if (!w) continue;
      out.push(w);
      const syn = SYNONYMS[w];
      if (syn && syn !== w) out.push.apply(out, syn.split(' '));
    }
    return out;
  }

  // Cheap typo tolerance: allow 1 edit on words of 4+ chars.
  function closeEnough(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    if (a.length < 4) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (a.length < b.length) j++;
      else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  function score(entry, tokens, rawQuery) {
    const title = norm(entry.t);
    const hay = title + ' ' + norm(entry.s) + ' ' + norm(entry.k) + ' ' + norm(entry.c);
    const words = hay.split(' ');
    const raw = norm(rawQuery);
    let sc = 0;

    if (title === raw) sc += 220;                       // exact title
    else if (title.indexOf(raw) === 0) sc += 130;       // title starts with query
    else if (title.indexOf(raw) > -1) sc += 95;         // title contains query
    else if (hay.indexOf(raw) > -1) sc += 55;           // anywhere

    let matched = 0;
    for (const tk of tokens) {
      if (!tk) continue;
      let best = 0;
      for (const w of words) {
        if (w === tk) { best = Math.max(best, 26); continue; }
        if (w.indexOf(tk) === 0) { best = Math.max(best, 18); continue; }
        if (tk.length > 3 && w.indexOf(tk) > -1) { best = Math.max(best, 12); continue; }
        if (closeEnough(tk, w)) best = Math.max(best, 10);   // typo
      }
      if (best) { sc += best; matched++; }
      // a token matching the TITLE specifically is a strong signal
      if (title.split(' ').some(w => w === tk || closeEnough(tk, w))) sc += 14;
    }
    if (!matched) return 0;
    // reward covering more of what they typed
    sc += Math.round((matched / tokens.length) * 40);
    if (entry.c === 'Service') sc += 6;   // services are what people usually want
    return sc;
  }

  function search(q) {
    const raw = norm(q);
    if (!raw) return [];
    const tokens = expand(q);
    return INDEX
      .map(e => ({ e: e, s: score(e, tokens, raw) }))
      .filter(r => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map(r => r.e);
  }

  // ── UI ──────────────────────────────────────────────────────────────────
  const CSS = `
  .zs-trigger{background:none;border:1px solid rgba(182,165,136,0.35);color:var(--latte,#8C7A5E);
    font-family:'Josefin Sans',sans-serif;font-size:0.7rem;letter-spacing:0.12em;text-transform:uppercase;
    padding:0.5rem 0.9rem;cursor:pointer;display:inline-flex;align-items:center;gap:0.45rem;transition:all 0.2s;white-space:nowrap;border-radius:999px}
  .zs-trigger:hover{border-color:var(--champagne,#B6A588);color:var(--champagne,#B6A588)}
  .zs-nav-icon{display:none;background:none;border:none;color:var(--espresso,#0D0D0D);cursor:pointer;
    font-size:1.15rem;padding:0.35rem 0.5rem;line-height:1;margin-left:auto;margin-right:0.25rem}
  @media(max-width:900px){.zs-trigger{display:none}.zs-nav-icon{display:inline-block}}
  .zs-overlay{position:fixed;inset:0;z-index:9998;display:none;background:rgba(13,9,6,0.72);backdrop-filter:blur(7px);
    padding:8vh 1rem 2rem;overflow-y:auto}
  .zs-overlay.open{display:block;animation:zsFade 0.2s ease}
  @keyframes zsFade{from{opacity:0}to{opacity:1}}
  .zs-box{max-width:620px;margin:0 auto;animation:zsUp 0.28s cubic-bezier(.2,.8,.2,1)}
  @keyframes zsUp{from{opacity:0;transform:translateY(-14px)}to{opacity:1;transform:translateY(0)}}
  .zs-field{position:relative;display:flex;align-items:center;background:#fff;border-radius:16px;
    box-shadow:0 26px 70px rgba(0,0,0,0.42);overflow:hidden}
  .zs-field span{padding:0 0.35rem 0 1.15rem;font-size:1.1rem;color:#B6A588;flex-shrink:0}
  .zs-input{flex:1;border:none;outline:none;background:none;font-family:'Josefin Sans',sans-serif;
    font-size:1.12rem;color:#0D0D0D;padding:1.25rem 0.6rem}
  .zs-input::placeholder{color:#B6A588}
  .zs-close{background:none;border:none;color:#8C7A5E;font-size:1.5rem;cursor:pointer;padding:0 1.1rem;line-height:1;flex-shrink:0}
  .zs-results{background:#fff;border-radius:16px;margin-top:0.7rem;overflow:hidden;box-shadow:0 26px 70px rgba(0,0,0,0.35)}
  .zs-item{display:flex;align-items:center;gap:0.9rem;padding:0.9rem 1.15rem;cursor:pointer;
    border-bottom:1px solid rgba(182,165,136,0.14);text-decoration:none;transition:background 0.12s}
  .zs-item:last-child{border-bottom:none}
  .zs-item:hover,.zs-item.on{background:rgba(182,165,136,0.13)}
  .zs-tag{font-family:'Josefin Sans',sans-serif;font-size:0.52rem;font-weight:700;letter-spacing:0.14em;
    text-transform:uppercase;padding:0.28rem 0.55rem;border-radius:5px;flex-shrink:0;min-width:74px;text-align:center}
  .zs-tag.Service{background:#B6A588;color:#17100a}
  .zs-tag.Membership{background:#0D0D0D;color:#DDD0B8}
  .zs-tag.Book{background:#6ab07a;color:#0b2410}
  .zs-tag--other{background:rgba(182,165,136,0.2);color:#8C7A5E}
  .zs-txt{min-width:0;flex:1}
  .zs-t{display:block;font-family:'Cinzel',serif;font-size:0.98rem;color:#0D0D0D;line-height:1.25}
  .zs-s{display:block;font-family:'Josefin Sans',sans-serif;font-size:0.78rem;color:#8C7A5E;margin-top:0.15rem;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .zs-go{color:#B6A588;font-size:1rem;flex-shrink:0}
  .zs-none{padding:2rem 1.25rem;text-align:center;font-family:'Josefin Sans',sans-serif;color:#8C7A5E;font-size:0.9rem;line-height:1.8}
  .zs-none b{color:#0D0D0D}
  .zs-hint{text-align:center;font-family:'Josefin Sans',sans-serif;font-size:0.72rem;
    color:rgba(221,208,184,0.6);margin-top:1rem;letter-spacing:0.06em}
  .zs-quick{display:flex;gap:0.4rem;flex-wrap:wrap;justify-content:center;margin-top:0.9rem}
  .zs-quick button{background:rgba(245,238,232,0.1);border:1px solid rgba(182,165,136,0.3);color:#DDD0B8;
    font-family:'Josefin Sans',sans-serif;font-size:0.72rem;padding:0.42rem 0.85rem;border-radius:999px;cursor:pointer;transition:all 0.18s}
  .zs-quick button:hover{background:rgba(182,165,136,0.25);color:#fff}
  `;

  let overlay, input, results, idx = -1, current = [];

  const PANEL_HTML =
    '<div class="zs-box">' +
      '<div class="zs-field">' +
        '<span>⌕</span>' +
        '<input class="zs-input" id="zs-input" placeholder="Search — try “small gel x” or “pedicure”" autocomplete="off" />' +
        '<button class="zs-close" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="zs-results" id="zs-results" style="display:none"></div>' +
      '<div class="zs-quick">' +
        '<button data-q="gel x">Gel X</button>' +
        '<button data-q="acrylic">Acrylic</button>' +
        '<button data-q="pedicure">Pedicure</button>' +
        '<button data-q="membership">Memberships</button>' +
        '<button data-q="price">Prices</button>' +
        '<button data-q="book">Book</button>' +
      '</div>' +
      '<div class="zs-hint">Press Esc to close</div>' +
    '</div>';

  function build() {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    overlay = document.createElement('div');
    overlay.className = 'zs-overlay';
    overlay.innerHTML = PANEL_HTML;
    document.body.appendChild(overlay);
  }

  function init() {
    build();
    input = overlay.querySelector('#zs-input');
    results = overlay.querySelector('#zs-results');

    overlay.querySelector('.zs-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    input.addEventListener('input', () => render(input.value));
    input.addEventListener('keydown', onKey);
    overlay.querySelectorAll('.zs-quick button').forEach(b => {
      b.addEventListener('click', () => { input.value = b.dataset.q; render(b.dataset.q); input.focus(); });
    });

    injectTriggers();

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) close();
      // "/" opens search when not already typing somewhere
      const tag = (e.target.tagName || '').toLowerCase();
      if (e.key === '/' && tag !== 'input' && tag !== 'textarea' && !overlay.classList.contains('open')) {
        e.preventDefault(); open();
      }
    });
  }

  function injectTriggers() {
    const links = document.querySelector('.nav-links');
    if (links) {
      const b = document.createElement('button');
      b.className = 'zs-trigger';
      b.type = 'button';
      b.innerHTML = '⌕ Search';
      b.addEventListener('click', open);
      const cta = links.querySelector('.btn-gold');
      links.insertBefore(b, cta || null);
    }
    const nav = document.querySelector('.nav');
    const burger = document.getElementById('hamburger');
    if (nav && burger) {
      const ic = document.createElement('button');
      ic.className = 'zs-nav-icon';
      ic.type = 'button';
      ic.setAttribute('aria-label', 'Search');
      ic.innerHTML = '⌕';
      ic.addEventListener('click', open);
      nav.insertBefore(ic, burger);
    }
    // Also inside the mobile drawer
    const mob = document.getElementById('nav-mobile');
    if (mob) {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = '⌕  Search';
      a.addEventListener('click', e => {
        e.preventDefault();
        mob.classList.remove('open');
        document.body.style.overflow = '';
        open();
      });
      mob.insertBefore(a, mob.firstChild);
    }
  }

  function open() {
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => input.focus(), 60);
  }
  function close() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    input.value = '';
    results.style.display = 'none';
    idx = -1;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function render(q) {
    current = search(q);
    idx = -1;
    if (!norm(q)) { results.style.display = 'none'; return; }
    results.style.display = 'block';
    if (!current.length) {
      results.innerHTML =
        '<div class="zs-none">Nothing matched <b>' + esc(q) + '</b>.<br>' +
        'Try “gel x”, “pedicure”, “membership”, or <a href="contact.html" style="color:#B6A588">message us</a>.</div>';
      return;
    }
    results.innerHTML = current.map((e, i) =>
      '<a class="zs-item" href="' + e.u + '" data-i="' + i + '">' +
        '<span class="zs-tag ' + (['Service','Membership','Book'].indexOf(e.c) > -1 ? e.c : 'zs-tag--other') + '">' + esc(e.c) + '</span>' +
        '<span class="zs-txt"><span class="zs-t">' + esc(e.t) + '</span>' +
        '<span class="zs-s">' + esc(e.s) + '</span></span>' +
        '<span class="zs-go">→</span>' +
      '</a>').join('');
  }

  function onKey(e) {
    if (!current.length) return;
    const items = results.querySelectorAll('.zs-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, current.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); }
    else if (e.key === 'Enter') { e.preventDefault(); window.location.href = current[idx < 0 ? 0 : idx].u; return; }
    else return;
    items.forEach((el, i) => el.classList.toggle('on', i === idx));
    if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  }

  // expose for testing / programmatic use
  window.zolaSearch = { open: open, close: close, query: search };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
