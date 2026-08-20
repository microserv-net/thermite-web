// THERMITE — the descent engine.
//
// Stations light up as they enter the channel and dim behind you, the rail's
// molten column tracks real scroll position, and locked stations stay legible
// while making it obvious they are not ready yet. Scroll is never hijacked:
// you can always read ahead.

import { $, $$, el, reducedMotion } from '../util.js';

export class Descent {
  /** @param {{key:string,label:string}[]} stations */
  constructor(stations, { onEnter } = {}) {
    this.stations = stations;
    this.onEnter = onEnter || (() => {});
    this.unlocked = new Set(['intro', 'connect', 'how']);
    this.current = 'intro';
    this._buildRail();
    this._observe();
    this._trackScroll();
  }

  _buildRail() {
    const stops = $('#stops');
    stops.replaceChildren(...this.stations.map((s) => {
      const b = el('button', {
        class: 'stop', type: 'button',
        'data-key': s.key, 'data-state': 'locked',
        title: s.label,
        onclick: () => this.goto(s.key),
      }, el('span', { text: s.label }));
      return b;
    }));
    this.stops = new Map($$('.stop').map((b) => [b.dataset.key, b]));
    this._paintRail();
  }

  _observe() {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const sec = e.target;
        if (e.isIntersecting && e.intersectionRatio > 0.28) {
          sec.dataset.visible = 'true';
          if (this.current !== sec.dataset.key) {
            this.current = sec.dataset.key;
            this._paintRail();
            this.onEnter(sec.dataset.key);
          }
        } else if (!e.isIntersecting && e.boundingClientRect.top < 0) {
          sec.dataset.visible = 'past';
        } else if (!e.isIntersecting) {
          sec.dataset.visible = 'false';
        }
      }
    }, { threshold: [0, 0.28, 0.6] });

    $$('.station').forEach((s) => io.observe(s));
  }

  _trackScroll() {
    const molten = $('#molten');
    let queued = false;
    const paint = () => {
      queued = false;
      const max = document.documentElement.scrollHeight - innerHeight;
      const p = max > 0 ? Math.min(1, scrollY / max) : 0;
      molten.style.height = `${(p * 100).toFixed(2)}%`;
    };
    addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(paint);
    }, { passive: true });
    paint();
  }

  _paintRail() {
    const order = this.stations.map((s) => s.key);
    const idx = order.indexOf(this.current);
    for (const [key, btn] of this.stops) {
      const i = order.indexOf(key);
      if (!this.unlocked.has(key)) btn.dataset.state = 'locked';
      else if (i < idx) btn.dataset.state = 'done';
      else if (i === idx) btn.dataset.state = 'active';
      else btn.dataset.state = 'ready';
    }
  }

  unlock(key) {
    this.unlocked.add(key);
    const sec = document.querySelector(`.station[data-key="${key}"]`);
    if (sec) sec.dataset.locked = 'false';
    this._paintRail();
  }

  lock(key) {
    this.unlocked.delete(key);
    const sec = document.querySelector(`.station[data-key="${key}"]`);
    if (sec) sec.dataset.locked = 'true';
    this._paintRail();
  }

  goto(key) {
    const sec = document.querySelector(`.station[data-key="${key}"]`);
    if (!sec) return;
    sec.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    const focusable = sec.querySelector('button:not([disabled]), input, a');
    if (focusable) setTimeout(() => focusable.focus({ preventScroll: true }), reducedMotion() ? 0 : 600);
  }
}
