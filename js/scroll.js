// THERMITE — the descent engine.
//
// Same public surface as before — unlock, lock, goto — but the progress
// indicator is no longer a rail. Stations are positioned by the spine, light up
// as they enter the pour, and dim behind you. Scroll is never hijacked: you can
// always read ahead.

import { $, $$, reducedMotion } from '../util.js';
import { Spine } from './spine.js';

export class Descent {
  /** @param {{key:string,label:string}[]} stations */
  constructor(stations, { onEnter } = {}) {
    this.stations = stations;
    this.onEnter = onEnter || (() => {});
    this.unlocked = new Set(['intro', 'connect', 'how']);
    this.current = 'intro';

    // The rail is gone. If an older index.html still has it, remove it rather
    // than leaving a dead column on the left.
    document.querySelector('.rail')?.remove();

    this.elements = $$('.station');
    this.spine = new Spine(this.elements, { onNode: (key) => this.goto(key) });
    this.spine.setNodes(stations);

    this._observe();
    this._paintNodes();
  }

  _observe() {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const sec = e.target;
        if (e.isIntersecting && e.intersectionRatio > 0.22) {
          sec.dataset.visible = 'true';
          if (this.current !== sec.dataset.key) {
            this.current = sec.dataset.key;
            this._paintNodes();
            this.onEnter(sec.dataset.key);
          }
        } else if (!e.isIntersecting && e.boundingClientRect.top < 0) {
          sec.dataset.visible = 'past';
        } else if (!e.isIntersecting) {
          sec.dataset.visible = 'false';
        }
      }
    }, { threshold: [0, 0.22, 0.6] });

    this.elements.forEach((s) => io.observe(s));
  }

  _paintNodes() {
    const order = this.stations.map((s) => s.key);
    const idx = order.indexOf(this.current);
    for (const { key } of this.stations) {
      const i = order.indexOf(key);
      const state = !this.unlocked.has(key) ? 'locked'
        : i < idx ? 'done'
        : i === idx ? 'active'
        : 'ready';
      this.spine.markNode(key, state);
    }
  }

  unlock(key) {
    this.unlocked.add(key);
    const sec = document.querySelector(`.station[data-key="${key}"]`);
    if (sec) sec.dataset.locked = 'false';
    this._paintNodes();
    this.remeasure();
  }

  lock(key) {
    this.unlocked.delete(key);
    const sec = document.querySelector(`.station[data-key="${key}"]`);
    if (sec) sec.dataset.locked = 'true';
    this._paintNodes();
    this.remeasure();
  }

  /** Content grew or shrank — the curve and the card offsets both depend on it. */
  remeasure() {
    clearTimeout(this._settle);
    this._settle = setTimeout(() => this.spine.measure(), 120);
  }

  goto(key) {
    const sec = document.querySelector(`.station[data-key="${key}"]`);
    if (!sec) return;
    sec.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    const focusable = sec.querySelector('button:not([disabled]), input, a');
    if (focusable) setTimeout(() => focusable.focus({ preventScroll: true }), reducedMotion() ? 0 : 620);
  }
}
