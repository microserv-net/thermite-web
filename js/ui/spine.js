// THERMITE — the spine.
//
// The pour line is the page's spine, not a gutter ornament. It runs top to
// bottom through the middle of the content, wandering left and right, and the
// stations ride ON it — each card centred on wherever the line happens to be at
// that depth. Scrolling reads as travelling along the thread while the steps
// come to meet you.
//
// How it works:
//
//   * One path, drawn in DOCUMENT coordinates, inside a fixed full-viewport
//     SVG whose <g> is translated by -scrollY. So it is a single unbroken
//     object that scrolls with the page, not a per-section decoration.
//
//   * The curve is three sine harmonics summed, not one. A single sine is a
//     metronome — you can see the next bend coming. Three incommensurate
//     wavelengths give irregular, organic curvature that never repeats over
//     the height of a page, while staying completely deterministic: it looks
//     the same on every reload.
//
//   * Two fainter strands run alongside at a small phase offset, so the line
//     braids and separates as it descends rather than reading as a single wire.
//
//   * TWO svg layers straddle the content in z-order. The solid spine sits
//     BELOW the cards (z 5) so it disappears behind a panel and re-emerges;
//     a ghost copy sits ABOVE (z 11) at low opacity and screen blend, so the
//     thread is faintly visible passing *through* the card. That pairing is
//     what sells the depth — without the ghost, the line just vanishes.
//
//   * Reveal is scroll-linked via stroke-dashoffset and the molten head rides
//     the real geometry via getPointAtLength(). Nothing runs on a timer.

import { $, reducedMotion } from '../util.js';

const NS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;
const SAMPLE = 14;          // px of vertical travel per sample point
const HEAD_AT = 0.58;       // where down the viewport the pour head sits
const BRAID = 0.34;         // phase offset of the outer strands

const svgEl = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
};

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

    this._build();

    this._onScroll = () => this._requestPaint();
    this._onResize = () => { this.measure(); this._requestPaint(); };
    addEventListener('scroll', this._onScroll, { passive: true });
    addEventListener('resize', this._onResize, { passive: true });
    if (document.fonts?.ready) document.fonts.ready.then(() => this._onResize());

    // Cards change height as stations unlock and content appears, which moves
    // every station below them. The geometry has to be re-derived, not
    // measured once at load.
    this._ro = new ResizeObserver(() => this._settle());
    for (const s of stations) this._ro.observe(s);

    this.measure();
    this._requestPaint();
  }

  // ------------------------------------------------------------- build -----

  _build() {
    // --- layer below the content -----------------------------------------
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

    // --- layer above the content -----------------------------------------
    // The same thread, ghosted, so it can be seen running under the panels.
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
   * x of the thread at a given document y.
   * Three harmonics, fixed phases: irregular to the eye, identical every load.
   */
  xAt(y, shift = 0) {
    const w = this.wave;
    return w.cx
      + w.a1 * Math.sin((y / w.l1) * TAU + w.p1 + shift)
      + w.a2 * Math.sin((y / w.l2) * TAU + w.p2 + shift * 1.6)
      + w.a3 * Math.sin((y / w.l3) * TAU + w.p3 - shift * 0.8);
  }

  measure() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const docH = Math.max(document.documentElement.scrollHeight, vh);

    this.vw = vw; this.vh = vh; this.docH = docH;
    this.narrow = vw < 820;

    // The card has to fit inside the swing of the curve without being clamped
    // against the edges, so its width is derived from the viewport rather than
    // fixed — and written back to CSS so the two never disagree.
    this.cardW = this.narrow
      ? vw - 32
      : Math.round(Math.min(600, Math.max(340, vw * 0.44), vw - 96));
    document.documentElement.style.setProperty('--card-w', `${this.cardW}px`);

    const amp = this.narrow
      ? Math.min(vw * 0.16, 60)
      : Math.min(vw * 0.23, 330);

    this.wave = {
      cx: vw / 2,
      // Incommensurate wavelengths: the sum never repeats over a page height.
      a1: amp * 0.58, l1: vh * 1.90, p1: -0.55,
      a2: amp * 0.27, l2: vh * 0.83, p2: 2.20,
      a3: amp * 0.15, l3: vh * 3.40, p3: 4.10,
    };

    for (const svg of [this.under, this.over]) {
      svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
      svg.setAttribute('width', vw);
      svg.setAttribute('height', vh);
    }

    // --- sample the curve, keeping a cumulative length table so the reveal is
    //     driven from a y position instead of being guessed at.
    const build = (shift) => {
      const pts = [];
      for (let y = 0; y <= docH; y += SAMPLE) pts.push([this.xAt(y, shift), y]);
      if (pts[pts.length - 1][1] < docH) pts.push([this.xAt(docH, shift), docH]);

      let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
      const lens = [0];
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        // The curve is a function of y, so the tangent at every sample point is
        // closer to vertical than horizontal — control handles go on the
        // midpoint's y, which keeps the joins invisible.
        const my = (y0 + y1) / 2;
        d += ` C ${x0.toFixed(2)} ${my.toFixed(2)}, ${x1.toFixed(2)} ${my.toFixed(2)}, ${x1.toFixed(2)} ${y1.toFixed(2)}`;
        total += Math.hypot(x1 - x0, y1 - y0);
        lens.push(total);
      }
      return { d, lens, total };
    };

    const main = build(0);
    const a = build(BRAID);
    const b = build(-BRAID);

    this.lens = main.lens;

    for (const p of [this.channel, this.molten, this.crest, this.ghost, this.ghostHot]) {
      p.setAttribute('d', main.d);
    }
    this.strandA.setAttribute('d', a.d);
    this.strandB.setAttribute('d', b.d);

    this.total = this.molten.getTotalLength?.() || main.total;
    this.scale = this.total / (main.total || 1);

    for (const p of [this.molten, this.crest, this.ghostHot]) {
      p.style.strokeDasharray = `${this.total}`;
    }

    this._placeStations();
    this._placeNodes();
  }

  lengthAtY(y) {
    const i = Math.min(this.lens.length - 1, Math.max(0, Math.round(y / SAMPLE)));
    return this.lens[i] * this.scale;
  }

  // ---------------------------------------------------- station placement --

  _placeStations() {
    const gutter = this.narrow ? 16 : 24;
    for (const station of this.stations) {
      const card = station.querySelector('.station__inner');
      if (!card) continue;

      // Centre of the card, not its edge: the station rides ON the thread.
      const rect = card.getBoundingClientRect();
      const cardMidY = rect.top + window.scrollY + rect.height / 2;
      const x = this.xAt(cardMidY);

      const left = Math.max(gutter, Math.min(x - this.cardW / 2, this.vw - this.cardW - gutter));

      station.style.setProperty('--card-x', `${Math.round(left)}px`);
      // How far the thread is from the card's centre, so the panel can lean
      // very slightly into the curve.
      const drift = (x - (left + this.cardW / 2)) / (this.cardW / 2);
      station.style.setProperty('--drift', drift.toFixed(3));
    }
  }

  _placeNodes() {
    for (const [key, group] of this.nodes) {
      const station = this.stations.find((s) => s.dataset.key === key);
      if (!station) { group.style.display = 'none'; continue; }
      const card = station.querySelector('.station__inner');
      const rect = card ? card.getBoundingClientRect() : station.getBoundingClientRect();
      // Just above the card, on the exposed run of thread between stations.
      const y = Math.max(0, rect.top + window.scrollY - 34);
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

    // A brighter crest just behind the head: the metal still moving, as
    // distinct from the channel it has already filled.
    const crest = Math.min(drawn, this.vh * 0.5);
    this.crest.style.strokeDasharray = `${crest} ${this.total}`;
    this.crest.style.strokeDashoffset = `${this.total - drawn}`;

    if (drawn > 2 && this.molten.getPointAtLength) {
      const p = this.molten.getPointAtLength(Math.min(drawn, this.total - 0.5));
      this.headGroup.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
      this.headGroup.style.opacity = headY >= this.docH - 4 ? '0' : '1';
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
