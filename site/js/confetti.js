// A short, light confetti burst on a full-screen canvas. Skipped with prefers-reduced-motion.

import { prefersReducedMotion } from './dom.js';

const COLORS = ['#ffd43b', '#4dabf7', '#9775fa', '#51cf66', '#ff6b6b', '#ffa94d', '#f783ac'];

/**
 * Fire confetti from the top/centre of the screen.
 * @returns {Promise<void>} resolves when the animation ends (immediately when motion is reduced)
 */
export function confetti({ count = 160, durationMs = 2800 } = {}) {
  if (prefersReducedMotion()) return Promise.resolve();
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return Promise.resolve(); }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  };
  resize();
  window.addEventListener('resize', resize);

  const W = () => canvas.width / dpr;
  const H = () => canvas.height / dpr;
  const parts = [];
  for (let i = 0; i < count; i++) {
    // Two cannons from the lower corners plus a gentle shower from the top.
    const fromLeft = i % 3 === 0;
    const fromRight = i % 3 === 1;
    const shower = !fromLeft && !fromRight;
    const angle = fromLeft ? -Math.PI / 3 - Math.random() * 0.5 : fromRight ? -Math.PI * 2 / 3 + Math.random() * 0.5 : Math.PI / 2;
    const speed = shower ? 1 + Math.random() * 2 : 9 + Math.random() * 7;
    parts.push({
      x: fromLeft ? 0 : fromRight ? W() : Math.random() * W(),
      y: shower ? -20 - Math.random() * H() * 0.4 : H() * 0.85,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: COLORS[i % COLORS.length],
      wobble: Math.random() * Math.PI * 2,
    });
  }

  return new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    const frame = (t) => {
      const dt = Math.min(2, (t - last) / 16.67);
      last = t;
      const elapsed = t - start;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W(), H());
      const fade = elapsed > durationMs - 600 ? Math.max(0, (durationMs - elapsed) / 600) : 1;
      ctx.globalAlpha = fade;
      for (const p of parts) {
        p.vy += 0.28 * dt; // gravity
        p.vx *= 0.985;
        p.vy = Math.min(p.vy, 6);
        p.wobble += 0.12 * dt;
        p.x += (p.vx + Math.sin(p.wobble) * 0.6) * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, Math.cos(p.wobble)); // flutter
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (elapsed < durationMs) requestAnimationFrame(frame);
      else {
        window.removeEventListener('resize', resize);
        canvas.remove();
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}
