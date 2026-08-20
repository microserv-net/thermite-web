// THERMITE — ambient deck.
//
// Sparks rise off a slow convection field. Density and heat follow whatever the
// page is actually doing, so the background is a readout rather than wallpaper.
// It stops entirely for prefers-reduced-motion and when the tab is hidden.

import { reducedMotion } from '../util.js';

const HEAT = {
  cold:   [120, 132, 148],
  warm:   [255, 95, 31],
  hot:    [255, 163, 23],
  quench: [47, 217, 189],
  fault:  [255, 63, 82],
};

export class Deck {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.sparks = [];
    this.tone = 'cold';
    this.intensity = 0.25;
    this.running = false;
    this.t = 0;
    this._resize = this._resize.bind(this);
    this._frame = this._frame.bind(this);
    addEventListener('resize', this._resize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      document.hidden ? this.pause() : this.start();
    });
    this._resize();
  }

  _resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth; this.h = innerHeight;
    this.c.width = Math.floor(this.w * dpr);
    this.c.height = Math.floor(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  set({ tone, intensity }) {
    if (tone) this.tone = tone;
    if (intensity != null) this.intensity = Math.max(0, Math.min(1, intensity));
  }

  start() {
    if (this.running || reducedMotion()) return;
    this.running = true;
    this.raf = requestAnimationFrame(this._frame);
  }

  pause() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  _spawn() {
    const n = Math.round(this.intensity * 2.2);
    for (let i = 0; i < n; i++) {
      if (this.sparks.length > 260) break;
      this.sparks.push({
        x: Math.random() * this.w,
        y: this.h + 10,
        vx: (Math.random() - 0.5) * 0.22,
        vy: -(0.25 + Math.random() * 0.85) * (0.6 + this.intensity),
        life: 1,
        decay: 0.0016 + Math.random() * 0.0042,
        r: 0.5 + Math.random() * 1.5,
        drift: Math.random() * 6.28,
      });
    }
  }

  _frame() {
    if (!this.running) return;
    this.t += 0.006;
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);

    // Convection glow along the floor, brighter as the pour heats up.
    const g = ctx.createLinearGradient(0, h, 0, h * 0.45);
    const [r, gg, b] = HEAT[this.tone] || HEAT.cold;
    g.addColorStop(0, `rgba(${r},${gg},${b},${0.09 * (0.35 + this.intensity)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h * 0.45, w, h * 0.55);

    this._spawn();

    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.drift += 0.03;
      s.x += s.vx + Math.sin(s.drift + this.t) * 0.16;
      s.y += s.vy;
      s.life -= s.decay;
      if (s.life <= 0 || s.y < -20) { this.sparks.splice(i, 1); continue; }
      const a = s.life * s.life * 0.85;
      ctx.fillStyle = `rgba(${r},${Math.min(255, gg + 60 * s.life)},${b},${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * (0.4 + s.life), 0, 6.2832);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    this.raf = requestAnimationFrame(this._frame);
  }
}
