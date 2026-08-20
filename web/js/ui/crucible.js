// THERMITE — the crucible.
//
// The one place the design spends its boldness. A pool of molten metal whose
// surface agitation is driven by the *observed arrival rate of log lines* and
// whose colour is the pour's real state. It cools and solidifies into an ingot
// on success, and goes black with a fracture on failure.
//
// It never runs ahead of the data. When nothing is happening, the surface is
// still — which is itself information.

import { reducedMotion } from '../util.js';

const PALETTE = {
  QUEUED:    { deep: [40, 46, 54],   mid: [70, 78, 88],    hot: [120, 130, 142] },
  STARTING:  { deep: [86, 34, 14],   mid: [160, 60, 20],   hot: [220, 110, 40] },
  BUILDING:  { deep: [140, 44, 12],  mid: [230, 96, 26],   hot: [255, 208, 130] },
  SUCCESS:   { deep: [16, 78, 70],   mid: [30, 160, 140],  hot: [140, 245, 225] },
  FAILED:    { deep: [30, 12, 16],   mid: [70, 20, 28],    hot: [150, 40, 52] },
  CANCELLED: { deep: [30, 34, 40],   mid: [56, 62, 70],    hot: [90, 98, 108] },
  EXPIRED:   { deep: [30, 34, 40],   mid: [56, 62, 70],    hot: [90, 98, 108] },
  UNKNOWN:   { deep: [30, 34, 40],   mid: [56, 62, 70],    hot: [90, 98, 108] },
};

export class Crucible {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.status = 'QUEUED';
    this.agitation = 0;       // 0..1, smoothed from real line rate
    this.targetAgitation = 0;
    this.solidify = 0;        // 0..1, only ever driven by a terminal state
    this.t = 0;
    this.motion = !reducedMotion();
    this.sparks = [];
    this._frame = this._frame.bind(this);
    this._resize();
    addEventListener('resize', () => this._resize(), { passive: true });
  }

  _resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = this.c.getBoundingClientRect();
    this.w = Math.max(120, r.width);
    this.h = Math.max(90, r.height || r.width * 0.78);
    this.c.width = this.w * dpr;
    this.c.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** @param {{status:string, lineRate:number}} s */
  update(s) {
    this.status = s.status in PALETTE ? s.status : 'UNKNOWN';
    // Real signal: how many new log lines arrived since the last poll.
    this.targetAgitation = Math.min(1, (s.lineRate || 0) / 26);
    if (this.status === 'QUEUED') this.targetAgitation = 0.04;
    if (this.status === 'STARTING') this.targetAgitation = Math.max(0.18, this.targetAgitation);
  }

  setMotion(on) {
    this.motion = on && !reducedMotion();
    if (this.motion) this.start(); else { this.stop(); this._draw(); }
  }

  /** Called when the furnace opens: the canvas has no size while hidden. */
  resize() { this._resize(); this._draw(); }

  start() {
    if (!this.motion) { this._draw(); return; }
    if (!this.raf) this.raf = requestAnimationFrame(this._frame);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }

  _frame() {
    this.raf = requestAnimationFrame(this._frame);
    this.t += 0.016;
    this.agitation += (this.targetAgitation - this.agitation) * 0.05;
    const terminal = ['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(this.status);
    this.solidify += ((terminal ? 1 : 0) - this.solidify) * 0.02;
    this._draw();
  }

  _draw() {
    const { ctx, w, h } = this;
    const p = PALETTE[this.status] || PALETTE.UNKNOWN;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const rimY = h * 0.30;
    const rx = w * 0.36;
    const ry = h * 0.135;
    const bowlBottom = h * 0.86;

    // --- vessel ----------------------------------------------------------
    ctx.beginPath();
    ctx.moveTo(cx - rx, rimY);
    ctx.bezierCurveTo(cx - rx * 0.98, bowlBottom, cx + rx * 0.98, bowlBottom, cx + rx, rimY);
    ctx.closePath();
    const vessel = ctx.createLinearGradient(0, rimY, 0, bowlBottom);
    vessel.addColorStop(0, '#20242b');
    vessel.addColorStop(1, '#0e1013');
    ctx.fillStyle = vessel;
    ctx.fill();
    ctx.strokeStyle = '#333a45';
    ctx.lineWidth = 1;
    ctx.stroke();

    // --- melt surface ----------------------------------------------------
    const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
    const solid = this.solidify;
    const heat = this.agitation;

    const deep = mix(p.deep, [24, 26, 30], solid * 0.55);
    const mid = mix(p.mid, [52, 58, 66], solid * 0.6);
    const hot = mix(p.hot, [180, 190, 200], solid * 0.45);

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, rimY, rx * 0.97, ry * 0.97, 0, 0, 6.2832);
    ctx.clip();

    const pool = ctx.createRadialGradient(cx, rimY, 1, cx, rimY, rx);
    pool.addColorStop(0, `rgb(${hot.join(',')})`);
    pool.addColorStop(0.45, `rgb(${mid.join(',')})`);
    pool.addColorStop(1, `rgb(${deep.join(',')})`);
    ctx.fillStyle = pool;
    ctx.fillRect(cx - rx, rimY - ry, rx * 2, ry * 2);

    // Convection cells. Amplitude is agitation; when nothing arrives, the
    // surface is genuinely still.
    const cells = 7;
    for (let i = 0; i < cells; i++) {
      const ph = this.t * (0.5 + i * 0.13) + i * 1.7;
      const a = (0.12 + heat * 0.55) * (1 - solid * 0.9);
      const ox = Math.cos(ph) * rx * 0.42;
      const oy = Math.sin(ph * 0.8) * ry * 0.55;
      const rr = rx * (0.14 + 0.1 * Math.sin(ph * 1.3));
      const g = ctx.createRadialGradient(cx + ox, rimY + oy, 0, cx + ox, rimY + oy, rr);
      g.addColorStop(0, `rgba(${hot.join(',')},${a})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - rx, rimY - ry, rx * 2, ry * 2);
    }

    // Slag crust as it cools.
    if (solid > 0.05) {
      ctx.globalAlpha = solid * 0.75;
      for (let i = 0; i < 10; i++) {
        const ph = i * 2.1;
        ctx.fillStyle = 'rgba(18,20,24,.85)';
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(ph) * rx * 0.5, rimY + Math.sin(ph) * ry * 0.6,
          rx * 0.16, ry * 0.34, ph, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Fracture on failure.
    if (this.status === 'FAILED' && solid > 0.25) {
      ctx.strokeStyle = `rgba(255,63,82,${0.25 + solid * 0.4})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx - rx * 0.7, rimY - ry * 0.2);
      ctx.lineTo(cx - rx * 0.15, rimY + ry * 0.25);
      ctx.lineTo(cx + rx * 0.25, rimY - ry * 0.35);
      ctx.lineTo(cx + rx * 0.75, rimY + ry * 0.1);
      ctx.stroke();
    }
    ctx.restore();

    // Rim highlight
    ctx.beginPath();
    ctx.ellipse(cx, rimY, rx, ry, 0, 0, 6.2832);
    ctx.strokeStyle = `rgba(${hot.join(',')},${0.5 - solid * 0.35})`;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // --- sparks ----------------------------------------------------------
    if (this.motion && heat > 0.06 && solid < 0.6) {
      if (Math.random() < heat * 0.8) {
        this.sparks.push({
          x: cx + (Math.random() - 0.5) * rx * 1.5,
          y: rimY + (Math.random() - 0.5) * ry,
          vy: -(0.5 + Math.random() * 1.6) * (0.5 + heat),
          vx: (Math.random() - 0.5) * 0.5,
          life: 1, r: 0.6 + Math.random() * 1.1,
        });
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx; s.y += s.vy; s.vy += 0.008; s.life -= 0.016;
      if (s.life <= 0) { this.sparks.splice(i, 1); continue; }
      ctx.fillStyle = `rgba(${hot[0]},${hot[1]},${hot[2]},${s.life * 0.8})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * s.life, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // --- ingot -----------------------------------------------------------
    if (this.status === 'SUCCESS' && solid > 0.3) {
      const a = Math.min(1, (solid - 0.3) / 0.5);
      const iw = w * 0.30, ih = h * 0.10;
      const ix = cx - iw / 2, iy = h * 0.60;
      ctx.globalAlpha = a;
      const gi = ctx.createLinearGradient(ix, iy, ix, iy + ih);
      gi.addColorStop(0, '#9beadd');
      gi.addColorStop(1, '#1a8c78');
      ctx.fillStyle = gi;
      ctx.beginPath();
      ctx.moveTo(ix + iw * 0.09, iy);
      ctx.lineTo(ix + iw * 0.91, iy);
      ctx.lineTo(ix + iw, iy + ih);
      ctx.lineTo(ix, iy + ih);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}
