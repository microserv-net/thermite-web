// THERMITE — the spine.
//
// The pour line is not a progress bar bolted to the left edge. It is a single
// continuous channel of molten metal running down through the page, and the
// stations are tapped off it wherever it happens to be at that depth.
//
// How it works:
//
//   * One fixed, full-viewport SVG sits between the ambient canvas and the
//     content. The path inside it is drawn in DOCUMENT coordinates and the
//     containing <g> is translated by -scrollY, so the line scrolls with the
//     page as one unbroken object rather than being redrawn per section.
//
//   * The curve is a sine whose wavelength is a little longer than the
//     viewport, so consecutive stations sit at genuinely different horizontal
//     positions instead of alternating on a metronome.
//
//   * The stations are placed FROM the curve, not the other way round: each
//     card is offset so the line enters behind its edge. Because the content
//     sits above the SVG in the stacking order, the line visibly disappears
//     under a card and comes out the other side.
//
//   * Reveal is scroll-linked via stroke-dashoffset, with the molten head
//     riding the actual path via getPointAtLength(). Nothing is on a timer.

import { $, reducedMotion } from '../util.js';

const NS = 'http://www.w3.org/2000/svg';
const SAMPLE = 16;          // px of vertical travel per sample point
const HEAD_AT = 0.62;       // where down the viewport the pour head sits

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
    this._build();

    this._onScroll = () => this._requestPaint();
    this._onResize = () => { this.measure(); this._requestPaint(); };

    addEventListener('scroll', this._onScroll, { passive: true });
    addEventListener('resize', this._onResize, { passive: true });
    if (document.fonts?.ready) document.fonts.ready.then(() => this._onResize());

    // Cards change height as content is revealed, so the geometry has to be
    // re-derived rather than measured once at load.
    this._ro = new ResizeObserver(() => this._onResize());
    for (const s of stations) this._ro.observe(s);

    this.measure();
    this._requestPaint();
  }

  // ------------------------------------------------------------- build -----

  _build() {
    const svg = svgEl('svg', {
      id: 'spine', 'aria-hidden': 'true',
      xmlns: NS, preserveAspectRatio: 'none',
    });
    this.svg = svg;

    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', {
      id: 'spine-heat', x1: '0', y1: '0', x2: '0', y2: '1',
      gradientUnits: 'objectBoundingBox',
    });
    for (const [o, c] of [['0%', '#b8390d'], ['45%', '#ff5f1f'], ['100%', '#ffa317']]) {
      grad.append(svgEl('stop', { offset: o, 'stop-color': c }));
    }
    const glow = svgEl('filter', { id: 'spine-glow', x: '-60%', y: '-60%', width: '220%', height: '220%' });
    glow.append(svgEl('feGaussianBlur', { stdDeviation: '5', result: 'b' }));
    const merge = svgEl('feMerge');
    merge.append(svgEl('feMergeNode', { in: 'b' }), svgEl('feMergeNode', { in: 'SourceGraphic' }));
    glow.append(merge);
    defs.append(grad, glow);

    this.g = svgEl('g');
    this.channel = svgEl('path', { class: 'spine__channel' });   // the cold, unpoured line
    this.molten = svgEl('path', { class: 'spine__molten', stroke: 'url(#spine-heat)' });
    this.crest = svgEl('path', { class: 'spine__crest' });       // travelling bright segment
    this.headGroup = svgEl('g', { class: 'spine__head' });
    this.headHalo = svgEl('circle', { r: 13, class: 'spine__halo', filter: 'url(#spine-glow)' });
    this.headCore = svgEl('circle', { r: 4.5, class: 'spine__core' });
    this.headGroup.append(this.headHalo, this.headCore);
    this.nodeLayer = svgEl('g', { class: 'spine__nodes' });

    this.g.append(this.channel, this.molten, this.crest, this.nodeLayer, this.headGroup);
    svg.append(defs, this.g);
    document.body.insertBefore(svg, $('#descent'));

    this.nodes = new Map();
  }

  /** @param {{key:string,label:string}[]} list */
  setNodes(list) {
    this.nodeLayer.replaceChildren();
    this.nodes.clear();
    for (const { key, label } of list) {
      const group = svgEl('g', { class: 'spine__node', 'data-key': key, 'data-state': 'locked', tabindex: '0', role: 'button' });
      group.append(svgEl('title', {})).lastChild.textContent = `Go to ${label}`;
      const ring = svgEl('circle', { r: 11, class: 'node__ring' });
      const pip = svgEl('circle', { r: 4, class: 'node__pip' });
      const text = svgEl('text', { class: 'node__label', x: 20, y: 4 });
      text.textContent = label;
      group.append(ring, pip, text);
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

  /** x of the channel at a given document y. */
  xAt(y) {
    const { cx, amp, wave, phase } = this.wave;
    return cx + amp * Math.sin((y / wave) * Math.PI * 2 + phase);
  }

  measure() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const docH = Math.max(document.documentElement.scrollHeight, vh);

    this.vw = vw; this.vh = vh; this.docH = docH;
    this.narrow = vw < 900;

    this.wave = {
      cx: this.narrow ? vw * 0.30 : vw * 0.52,
      // Amplitude is what makes it read as a channel rather than a divider.
      amp: this.narrow ? Math.min(vw * 0.13, 54) : Math.min(vw * 0.23, 300),
      // Slightly longer than a screen, so no two stations land at the same x.
      wave: vh * 1.45,
      phase: -0.6,
    };

    this.svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    this.svg.setAttribute('width', vw);
    this.svg.setAttribute('height', vh);

    // --- sample the curve, keeping a cumulative length table so the reveal
    //     can be driven from a y position rather than guessed at.
    const pts = [];
    const lens = [0];
    for (let y = 0; y <= docH; y += SAMPLE) pts.push([this.xAt(y), y]);
    if (pts[pts.length - 1][1] < docH) pts.push([this.xAt(docH), docH]);

    let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      // Smooth the polyline with vertical control handles: the curve is a
      // function of y, so horizontal tangents at the sample points are exactly
      // wrong and vertical ones are exactly right.
      const my = (y0 + y1) / 2;
      d += ` C ${x0.toFixed(2)} ${my.toFixed(2)}, ${x1.toFixed(2)} ${my.toFixed(2)}, ${x1.toFixed(2)} ${y1.toFixed(2)}`;
      total += Math.hypot(x1 - x0, y1 - y0);
      lens.push(total);
    }

    this.samples = pts;
    this.lens = lens;

    for (const p of [this.channel, this.molten, this.crest]) p.setAttribute('d', d);

    this.total = this.molten.getTotalLength?.() || total;
    this.scale = this.total / (total || 1);

    this.molten.style.strokeDasharray = `${this.total}`;
    this.crest.style.strokeDasharray = `${this.total}`;

    this._placeStations();
    this._placeNodes();
  }

  lengthAtY(y) {
    const i = Math.min(this.lens.length - 1, Math.max(0, Math.round(y / SAMPLE)));
    return this.lens[i] * this.scale;
  }

  // ---------------------------------------------------- station placement --

  _placeStations() {
    const gutter = this.narrow ? 16 : 30;
    for (const station of this.stations) {
      const top = station.offsetTop;
      const card = station.querySelector('.station__inner');
      if (!card) continue;

      const midY = top + station.offsetHeight / 2;
      const x = this.xAt(midY);
      const cardW = card.offsetWidth || Math.min(640, this.vw - 48);

      // Put the card on whichever side has room, and let the line enter behind
      // its near edge by a fixed bite so it visibly passes underneath.
      const bite = this.narrow ? 26 : 74;
      const right = x < this.vw * 0.5;
      let left = right ? x - bite : x + bite - cardW;

      left = Math.max(gutter, Math.min(left, this.vw - cardW - gutter));

      station.style.setProperty('--card-x', `${Math.round(left)}px`);
      station.dataset.side = right ? 'right' : 'left';
    }
  }

  _placeNodes() {
    for (const [key, group] of this.nodes) {
      const station = this.stations.find((s) => s.dataset.key === key);
      if (!station) { group.style.display = 'none'; continue; }
      // Anchored near the top of each station, in the gap between cards, so a
      // node is never swallowed by the panel it belongs to.
      const y = station.offsetTop + Math.min(64, station.offsetHeight * 0.08);
      const x = this.xAt(y);
      group.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      const flip = x > this.vw * 0.62;
      group.querySelector('.node__label').setAttribute('x', flip ? -20 : 20);
      group.querySelector('.node__label').setAttribute('text-anchor', flip ? 'end' : 'start');
    }
  }

  // -------------------------------------------------------------- paint ----

  _requestPaint() {
    if (this._queued) return;
    this._queued = true;
    requestAnimationFrame(() => { this._queued = false; this._paint(); });
  }

  _paint() {
    const y = window.scrollY || window.pageYOffset || 0;
    this.g.setAttribute('transform', `translate(0 ${-y})`);

    const headY = Math.min(this.docH, y + this.vh * HEAD_AT);
    const drawn = this.lengthAtY(headY);

    this.molten.style.strokeDashoffset = `${this.total - drawn}`;

    // A brighter crest just behind the head — this is the metal that is still
    // moving, as opposed to the channel it has already filled.
    const crest = Math.min(drawn, this.vh * 0.55);
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
    this.svg.remove();
  }
}
