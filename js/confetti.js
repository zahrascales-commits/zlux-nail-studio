// Subtle, on-brand confetti: a small poof from each corner. No library.
// Enough to feel celebratory, gentle enough not to overwhelm someone
// mid-checkout. Call window.zolaConfetti() on a success moment.
(function () {
  const COLORS = ['#B6A588', '#DDD0B8', '#C9B896', '#F2ECE1', '#8C7A5E'];

  window.zolaConfetti = function () {
    // Respect reduced-motion preferences
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.width = innerWidth * dpr;
    const H = canvas.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);

    const w = innerWidth, h = innerHeight;
    // Four corners, each firing its particles toward the center-ish.
    const corners = [
      { x: 0, y: 0,   ax: 1,  ay: 1 },
      { x: w, y: 0,   ax: -1, ay: 1 },
      { x: 0, y: h,   ax: 1,  ay: -1 },
      { x: w, y: h,   ax: -1, ay: -1 },
    ];
    const parts = [];
    const perCorner = 14; // subtle
    corners.forEach(c => {
      for (let i = 0; i < perCorner; i++) {
        const speed = 6 + Math.random() * 6;
        const ang = Math.random() * (Math.PI / 2); // quarter fan into the screen
        parts.push({
          x: c.x, y: c.y,
          vx: c.ax * Math.cos(ang) * speed,
          vy: c.ay * Math.sin(ang) * speed - 2,
          size: 4 + Math.random() * 5,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.3,
          color: COLORS[(Math.random() * COLORS.length) | 0],
          life: 1,
        });
      }
    });

    let raf;
    const start = performance.now();
    function frame(now) {
      const elapsed = now - start;
      ctx.clearRect(0, 0, w, h);
      let alive = false;
      parts.forEach(p => {
        if (p.life <= 0) return;
        alive = true;
        p.vy += 0.16;      // gravity
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        if (elapsed > 900) p.life -= 0.02; // start fading after ~0.9s
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      });
      if (alive && elapsed < 2600) raf = requestAnimationFrame(frame);
      else { cancelAnimationFrame(raf); canvas.remove(); }
    }
    raf = requestAnimationFrame(frame);
  };
})();
