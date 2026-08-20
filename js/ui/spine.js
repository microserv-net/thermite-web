// THERMITE — the spine.
//
// The pour line runs top to bottom through the middle of the content, wandering
// left and right, and the stations ride ON it — each card centred on wherever
// the thread happens to be at that depth. Scrolling reads as travelling along
// the thread while the steps come to meet you.
//
//   * The thread is STRUCK below the hero's buttons, not at the top of the
//     page. The hero is the strike; everything below it is the pour.
//
//   * The curve is sampled coarsely (every ~80px) and joined with a
//     Catmull-Rom spline. The earlier version sampled every 14px and joined
//     with vertical-handle cubics, which put a tiny S-bend at every sample and
//     read as a wobble. Few points plus a real spline is smoother than many
//     points plus an approximation.
//
//   * Three sine harmonics at incommensurate wavelengths, fixed phases:
//     irregular to the eye, identical on every reload.
//
//   * TWO svg layers straddle the content. The solid thread sits BELOW the
//     cards (z 5) so it disappears behind a panel and re-emerges; a ghost copy
//     sits ABOVE (z 11) at low opacity, so the thread stays faintly visible
//     passing through. That pairing is what sells the depth.
//
//   * Reveal is scroll-linked. The drawn length for a given y is found by
//     binary search on the real path rather than from a sample table, so it
//     stays exact however coarsely the curve is sampled.

import { $, reducedMotion } from '../util.js';

const NS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;
const SAMPLE = 80;          // px of vertical travel between spline knots
const HEAD_AT = 0.58;       // where down the viewport the pour head sits
const BRAID = 0.34;         // phase offset of the outer strands
const ORIGIN_GAP = 56;      // clearance below the hero's buttons
const TAIL_GAP = 52;        // how far the thread runs past the last card

const svgEl = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
};

/** Catmull-Rom through the points, emitted as cubic Béziers. */
function spline(pts) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)},` +
         ` ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

export class Spine {
  /**
   * @param {HTMLElement[]} stations  in document order
   * @param {{onNode:(key:string)=>void}} hooks
   */
  constructor(stations, { onNode } = {}) {
    this.stations = stations;
    this.onNode = onNode || (() => {});
    this.reduced = reducedMotion();
    this.nodes = new Map();
    this.startY = 0;

    this._build();

    this._onScroll = () => this._requestPaint();
    this._onResize = () => { this.measure(); this._requestPaint(); };
    addEventListener('scroll', this._onScroll, { passive: true });
    addEventListener('resize', this._onResize, { passive: true });

    // Font loading changes the height of every card and the width of the
    // wordmark, so the geometry has to be re-derived once it settles.
    if (document.fonts?.ready) document.fonts.ready.then(() => this._onResize());

    this._ro = new ResizeObserver(() => this._settle());
    for (const s of stations) this._ro.observe(s);

    this.measure();
    this._requestPaint();
  }

  // ------------------------------------------------------------- build -----

  _build() {
    const under = svgEl('svg', { id: 'spine', 'aria-hidden': 'true', xmlns: NS, preserveAspectRatio: 'none' });

    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: 'spine-heat', x1: '0', y1: '0', x2: '0', y2: '1' });
    for (const [o, c] of [['0%', '#b8390d'], ['40%', '#ff5f1f'], ['100%', '#ffa317']]) {
      grad.append(svgEl('stop', { offset: o, 'stop-color': c }));
    }
    const glow = svgEl('filter', { id: 'spine-glow', x: '-70%', y: '-70%', width: '240%', height: '240%' });
    glow.append(svgEl('feGaussianBlur', { stdDeviation: '6', result: 'b' }));
    const merge = svgEl('feMerge');
    merge.append(svgEl('feMergeNode', { in: 'b' }), svgEl('feMergeNode', { in: 'SourceGraphic' }));
    glow.append(merge);
    defs.append(grad, glow);

    this.gUnder = svgEl('g');
    this.strandA = svgEl('path', { class: 'spine__strand' });
    this.strandB = svgEl('path', { class: 'spine__strand' });
    this.channel = svgEl('path', { class: 'spine__channel' });
    this.molten = svgEl('path', { class: 'spine__molten', stroke: 'url(#spine-heat)' });
    this.crest = svgEl('path', { class: 'spine__crest' });
    this.nodeLayer = svgEl('g', { class: 'spine__nodes' });
    this.headGroup = svgEl('g', { class: 'spine__head' });
    this.headGroup.append(
      svgEl('circle', { r: 15, class: 'spine__halo', filter: 'url(#spine-glow)' }),
      svgEl('circle', { r: 5, class: 'spine__core' }),
    );

    this.gUnder.append(this.strandA, this.strandB, this.channel, this.molten,
      this.crest, this.nodeLayer, this.headGroup);
    under.append(defs, this.gUnder);

    const over = svgEl('svg', { id: 'spine-ghost', 'aria-hidden': 'true', xmlns: NS, preserveAspectRatio: 'none' });
    this.gOver = svgEl('g');
    this.ghost = svgEl('path', { class: 'spine__ghost' });
    this.ghostHot = svgEl('path', { class: 'spine__ghost-hot' });
    this.gOver.append(this.ghost, this.ghostHot);
    over.append(this.gOver);

    this.under = under;
    this.over = over;

    const descent = $('#descent');
    document.body.insertBefore(under, descent);
    document.body.insertBefore(over, descent.nextSibling);
  }

  /** @param {{key:string,label:string}[]} list */
  setNodes(list) {
    this.nodeLayer.replaceChildren();
    this.nodes.clear();
    for (const { key, label } of list) {
      const group = svgEl('g', {
        class: 'spine__node', 'data-key': key, 'data-state': 'locked',
        tabindex: '0', role: 'button',
      });
      const title = svgEl('title');
      title.textContent = `Go to ${label}`;
      const ring = svgEl('circle', { r: 11, class: 'node__ring' });
      const pip = svgEl('circle', { r: 4, class: 'node__pip' });
      const text = svgEl('text', { class: 'node__label', x: 20, y: 4 });
      text.textContent = label;
      group.append(title, ring, pip, text);

      const go = () => this.onNode(key);
      group.addEventListener('click', go);
      group.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });

      this.nodeLayer.append(group);
      this.nodes.set(key, group);
    }
    this.measure();
    this._requestPaint();
  }

  markNode(key, state) {
    this.nodes.get(key)?.setAttribute('data-state', state);
  }

  // ----------------------------------------------------------- geometry ----

  /**
   * Where the thread is struck: just under the hero's buttons. The hero is the
   * strike, everything below it is the pour — so nothing is drawn above this.
   */
  originY() {
    const intro = this.stations.find((s) => s.dataset.key === 'intro');
    if (!intro) return 0;

    const cta = intro.querySelector('.hero__cta');
    if (cta) {
      const r = cta.getBoundingClientRect();
      if (r.height > 0) return Math.round(r.bottom + window.scrollY + ORIGIN_GAP);
    }
    // Fallback if the hero has no button row: the bottom of the station, minus
    // its own bottom padding.
    return Math.round(intro.offsetTop + intro.offsetHeight * 0.86);
  }

  /**
   * Where the thread runs out: just past the last station's card. Beyond that
   * there is nothing to thread through, and a line trailing into the footer
   * reads as an unfinished pour.
   */
  endY() {
    for (let i = this.stations.length - 1; i >= 0; i--) {
      const card = this.stations[i].querySelector('.station__inner');
      if (!card) continue;
      const r = card.getBoundingClientRect();
      if (r.height > 0) return Math.round(r.bottom + window.scrollY + TAIL_GAP);
    }
    return this.docH;
  }

  /**
   * x of the thread at a given document y.
   * Three harmonics, fixed phases: irregular to the eye, identical every load.
   */
  xAt(y, shift = 0) {
    const w = this.wave;
    const t = Math.min(Math.max(y, this.startY), this.stopY ?? Infinity);
    return w.cx
      + w.a1 * Math.sin((t / w.l1) * TAU + w.p1 + shift)
      + w.a2 * Math.sin((t / w.l2) * TAU + w.p2 + shift * 1.6)
      + w.a3 * Math.sin((t / w.l3) * TAU + w.p3 - shift * 0.8);
  }

  measure() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const docH = Math.max(document.documentElement.scrollHeight, vh);

    this.vw = vw; this.vh = vh; this.docH = docH;
    this.narrow = vw < 820;

    this.cardW = this.narrow
      ? vw - 32
      : Math.round(Math.min(600, Math.max(340, vw * 0.44), vw - 96));
    document.documentElement.style.setProperty('--card-w', `${this.cardW}px`);

    this._fitWordmark();

    const amp = this.narrow
      ? Math.min(vw * 0.16, 60)
      : Math.min(vw * 0.23, 330);

    this.wave = {
      cx: vw / 2,
      a1: amp * 0.58, l1: vh * 1.90, p1: -0.55,
      a2: amp * 0.27, l2: vh * 0.83, p2: 2.20,
      a3: amp * 0.15, l3: vh * 3.40, p3: 4.10,
    };

    for (const svg of [this.under, this.over]) {
      svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
      svg.setAttribute('width', vw);
      svg.setAttribute('height', vh);
    }

    this.startY = Math.max(0, Math.min(this.originY(), docH - 1));
    this.stopY = null;                       // xAt must not clamp while measuring
    this.stopY = Math.max(this.startY + SAMPLE, Math.min(this.endY(), docH));

    const build = (shift) => {
      const pts = [];
      for (let y = this.startY; y <= this.stopY; y += SAMPLE) pts.push([this.xAt(y, shift), y]);
      const lastY = pts.length ? pts[pts.length - 1][1] : this.startY;
      if (lastY < this.stopY) pts.push([this.xAt(this.stopY, shift), this.stopY]);
      return spline(pts);
    };

    for (const p of [this.channel, this.molten, this.crest, this.ghost, this.ghostHot]) {
      p.setAttribute('d', build(0));
    }
    this.strandA.setAttribute('d', build(BRAID));
    this.strandB.setAttribute('d', build(-BRAID));

    this.total = this.molten.getTotalLength ? this.molten.getTotalLength() : docH;
    for (const p of [this.molten, this.crest, this.ghostHot]) {
      p.style.strokeDasharray = `${this.total}`;
    }

    this._placeStations();
    this._placeNodes();
  }

  /**
   * The path is monotonic in y, so a binary search on the real geometry gives
   * the drawn length exactly — no sample table to keep in step with the curve.
   */
  lengthAtY(y) {
    if (!this.molten.getPointAtLength || y <= this.startY) return 0;
    if (y >= this.stopY) return this.total;
    let lo = 0, hi = this.total;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (this.molten.getPointAtLength(mid).y < y) lo = mid; else hi = mid;
    }
    return lo;
  }

  // ------------------------------------------------------- the wordmark ----

  /**
   * THERMITE has to fit its container at every width, whatever face is
   * actually loaded. CSS alone cannot promise that: sizing it in viewport units
   * guesses at font metrics, and SVG textLength is honoured inconsistently —
   * Safari ignores lengthAdjust here, which is why the word used to render
   * wider than the page and lose its first and last letters.
   *
   * Measuring is the only thing that always works.
   */
  _fitWordmark() {
    const name = document.querySelector('.hero__name');
    if (!name || !name.parentElement) return;

    name.style.fontSize = '';                       // back to the CSS value
    const avail = name.parentElement.clientWidth;
    const natural = name.scrollWidth;
    if (!avail || !natural) return;

    if (natural > avail) {
      const base = parseFloat(getComputedStyle(name).fontSize) || 100;
      name.style.fontSize = `${Math.max(26, Math.floor(base * (avail / natural) * 0.99))}px`;
    }
  }

  // ---------------------------------------------------- station placement --

  _placeStations() {
    const gutter = this.narrow ? 16 : 24;
    for (const station of this.stations) {
      const card = station.querySelector('.station__inner');
      if (!card) continue;

      // The hero is not a bead on the thread — it is where the thread starts.
      // CSS centres it; the engine keeps its hands off.
      if (station.dataset.key === 'intro') {
        station.style.removeProperty('--card-x');
        station.style.setProperty('--drift', '0');
        continue;
      }

      const rect = card.getBoundingClientRect();
      // Measure the card rather than assuming --card-w: a station that
      // overrides its own width would otherwise be positioned as though it
      // were the default size, and hang off the right-hand edge.
      const cardW = rect.width || this.cardW;
      const cardMidY = rect.top + window.scrollY + rect.height / 2;
      const x = this.xAt(cardMidY);

      const left = Math.max(gutter, Math.min(x - cardW / 2, this.vw - cardW - gutter));

      station.style.setProperty('--card-x', `${Math.round(left)}px`);
      const drift = (x - (left + cardW / 2)) / (cardW / 2);
      station.style.setProperty('--drift', drift.toFixed(3));
    }
  }

  _placeNodes() {
    for (const [key, group] of this.nodes) {
      const station = this.stations.find((s) => s.dataset.key === key);
      if (!station) { group.style.display = 'none'; continue; }

      let y;
      if (key === 'intro') {
        y = this.startY;                       // the strike point itself
      } else {
        const card = station.querySelector('.station__inner');
        const rect = card ? card.getBoundingClientRect() : station.getBoundingClientRect();
        y = Math.max(this.startY, rect.top + window.scrollY - 34);
      }

      const x = this.xAt(y);
      group.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      const flip = x > this.vw * 0.6;
      const label = group.querySelector('.node__label');
      label.setAttribute('x', flip ? -20 : 20);
      label.setAttribute('text-anchor', flip ? 'end' : 'start');
    }
  }

  // -------------------------------------------------------------- paint ----

  _settle() {
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => { this.measure(); this._requestPaint(); }, 90);
  }

  _requestPaint() {
    if (this._queued) return;
    this._queued = true;
    requestAnimationFrame(() => { this._queued = false; this._paint(); });
  }

  _paint() {
    const y = window.scrollY || window.pageYOffset || 0;
    const t = `translate(0 ${-y})`;
    this.gUnder.setAttribute('transform', t);
    this.gOver.setAttribute('transform', t);

    const headY = Math.min(this.docH, y + this.vh * HEAD_AT);
    const drawn = this.lengthAtY(headY);

    this.molten.style.strokeDashoffset = `${this.total - drawn}`;
    this.ghostHot.style.strokeDashoffset = `${this.total - drawn}`;

    const crest = Math.min(drawn, this.vh * 0.5);
    this.crest.style.strokeDasharray = `${crest} ${this.total}`;
    this.crest.style.strokeDashoffset = `${this.total - drawn}`;

    if (drawn > 2 && this.molten.getPointAtLength) {
      const p = this.molten.getPointAtLength(Math.min(drawn, this.total - 0.5));
      this.headGroup.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
      // The head disappears once the pour has reached the last station.
      this.headGroup.style.opacity = headY >= this.stopY - 4 ? '0' : '1';
    } else {
      this.headGroup.style.opacity = '0';
    }

    document.documentElement.style.setProperty('--pour-x', `${this.xAt(headY).toFixed(1)}px`);
  }

  destroy() {
    removeEventListener('scroll', this._onScroll);
    removeEventListener('resize', this._onResize);
    this._ro.disconnect();
    this.under.remove();
    this.over.remove();
  }
}
