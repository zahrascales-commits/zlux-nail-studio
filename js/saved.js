/* "YOU JUST SAVED THIS MUCH."
 *
 * Zahra wanted the moment after somebody buys to show them what they
 * saved, with an animation, so it lands. One component rather than three:
 * the membership checkout, the press-on cart and the gift card redemption
 * all have the same moment and should all feel the same.
 *
 * Two rules it follows, both of them about not lying to somebody who has
 * just handed over a card:
 *
 *   · the figure is passed in, in cents, by whatever already knows it
 *     from the server. This file does no arithmetic on money beyond
 *     formatting, so it cannot invent a saving.
 *
 *   · the number it counts up to is the number it stops on. A count-up
 *     that overshoots and settles back looks like a slot machine, and a
 *     saving is not a game.
 *
 * Usage:  window.zolaSaved(el, 43001, { label: 'You saved', note: '...' })
 */
(function () {
  'use strict';

  function money(c, withCents) {
    var v = (Number(c) || 0) / 100;
    if (withCents === false) return '$' + Math.round(v).toLocaleString('en-US');
    return '$' + (v % 1 === 0
      ? v.toLocaleString('en-US')
      : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }

  function style() {
    if (document.getElementById('zsaved-style')) return;
    var s = document.createElement('style');
    s.id = 'zsaved-style';
    s.textContent = [
      '.zsaved{position:relative;overflow:hidden;background:#0D0D0D;color:#F5EEE8;',
      '  border:1px solid rgba(182,165,136,0.45);padding:1.6rem 1.3rem;text-align:center;',
      '  opacity:0;transform:translateY(10px);transition:opacity .5s ease,transform .5s ease}',
      '.zsaved.in{opacity:1;transform:none}',
      '.zsaved::before{content:"";position:absolute;top:0;left:-60%;width:60%;height:100%;',
      '  background:linear-gradient(100deg,transparent,rgba(182,165,136,0.18),transparent);',
      '  animation:zsweep 1.8s ease-out .4s both}',
      '@keyframes zsweep{to{left:120%}}',
      '.zsaved>*{position:relative;z-index:1}',
      '.zsaved-k{font-family:"Josefin Sans",system-ui,sans-serif;font-size:.6rem;letter-spacing:.4em;',
      '  text-transform:uppercase;color:#B6A588;margin-bottom:.55rem}',
      '.zsaved-n{font-family:"Cinzel",Georgia,serif;font-size:clamp(2rem,9vw,2.9rem);line-height:1;',
      '  letter-spacing:.01em;font-variant-numeric:tabular-nums}',
      '.zsaved-s{font-family:"Josefin Sans",system-ui,sans-serif;font-size:.86rem;line-height:1.7;',
      '  color:rgba(245,238,232,.82);margin-top:.7rem}',
      '.zsaved-s b{color:#F5EEE8}',
      '@media(prefers-reduced-motion:reduce){',
      '  .zsaved{transition:none}.zsaved::before{animation:none}',
      '}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* Counts from zero to the figure, easing out so it slows into place
     rather than stopping dead. Reduced-motion gets the final number
     straight away — the information matters, the animation does not. */
  function countTo(el, cents, ms) {
    var still = false;
    try {
      still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {}
    if (still || !window.requestAnimationFrame) { el.textContent = money(cents); return; }

    var start = null;
    var dur = ms || 1100;
    function frame(t) {
      if (start === null) start = t;
      var p = Math.min(1, (t - start) / dur);
      /* easeOutCubic: fast, then settles. Never above 1, so the number
         cannot overshoot the real saving on its way there. */
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = money(Math.round(cents * e));
      if (p < 1) window.requestAnimationFrame(frame);
      else el.textContent = money(cents);      // land exactly on the truth
    }
    window.requestAnimationFrame(frame);
  }

  /* el     — where to put it
     cents  — the saving, from the server
     opts   — { label, note, confetti } */
  window.zolaSaved = function (el, cents, opts) {
    if (!el) return null;
    var o = opts || {};
    var amount = Math.max(0, Math.round(Number(cents) || 0));
    if (!amount) { el.innerHTML = ''; return null; }

    style();
    var box = document.createElement('div');
    box.className = 'zsaved';
    box.innerHTML =
      '<div class="zsaved-k">' + (o.label || 'You saved') + '</div>'
      + '<div class="zsaved-n" aria-live="polite">$0</div>'
      + (o.note ? '<div class="zsaved-s">' + o.note + '</div>' : '');
    el.innerHTML = '';
    el.appendChild(box);

    var num = box.querySelector('.zsaved-n');
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () {
        box.classList.add('in');
        countTo(num, amount);
      });
    } else {
      box.classList.add('in');
      num.textContent = money(amount);
    }

    if (o.confetti !== false && window.zolaConfetti) {
      setTimeout(function () { try { window.zolaConfetti(); } catch (_) {} }, 700);
    }
    return box;
  };

  window.zolaSaved.money = money;
})();
