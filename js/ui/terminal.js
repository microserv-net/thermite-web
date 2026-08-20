// THERMITE — the terminal.
//
// Renders only the lines it has not rendered yet, keeps a bounded window so a
// long build cannot choke the DOM, and follows the tail only while the reader
// is already at the bottom.

import { ansiToHtml, esc, stripAnsi } from '../util.js';

const WINDOW = 4000;

export class Terminal {
  constructor(view, { dot, title } = {}) {
    this.view = view;
    this.dot = dot;
    this.title = title;
    this.follow = true;
    this.rendered = 0;
    this.lines = [];
    this.frag = null;

    view.addEventListener('scroll', () => {
      const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
      if (!atBottom && this.follow) this.setFollow(false, true);
      if (atBottom && !this.follow) this.setFollow(true, true);
    }, { passive: true });
  }

  setFollow(on, quiet) {
    this.follow = on;
    const btn = document.getElementById('term-follow');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    if (on && !quiet) this.view.scrollTop = this.view.scrollHeight;
  }

  clear() {
    this.rendered = 0;
    this.lines = [];
    this.view.replaceChildren();
  }

  /** @param {string[]} lines full log split by newline */
  write(lines, { live } = {}) {
    if (this.dot) this.dot.dataset.live = String(!!live);

    if (lines.length < this.rendered) { this.clear(); }   // log was reset
    if (lines.length === this.rendered) { this._caret(live); return; }

    const frag = document.createDocumentFragment();
    for (let i = this.rendered; i < lines.length; i++) {
      const raw = lines[i];
      if (i === lines.length - 1 && raw === '') continue;
      frag.append(renderLine(raw));
    }
    this.rendered = lines.length;
    this.lines = lines;

    const first = this.view.firstElementChild;
    if (first && first.classList?.contains('term__empty')) this.view.replaceChildren();
    this.view.append(frag);

    // Bound the DOM.
    while (this.view.childElementCount > WINDOW) this.view.firstElementChild.remove();

    this._caret(live);
    if (this.follow) this.view.scrollTop = this.view.scrollHeight;
  }

  _caret(live) {
    const old = this.view.querySelector('.caret');
    if (old) old.remove();
    if (live) {
      const c = document.createElement('span');
      c.className = 'caret';
      this.view.append(c);
    }
  }

  empty(message) {
    const s = document.createElement('span');
    s.className = 'term__empty';
    s.textContent = message;
    this.view.replaceChildren(s);
    this.rendered = 0;
  }

  text() { return stripAnsi(this.lines.join('\n')); }
}

function renderLine(raw) {
  const div = document.createElement('div');
  const plain = stripAnsi(raw);

  if (plain.startsWith('##thermite:')) {
    div.className = 'l-mark';
    div.textContent = '· ' + plain.replace('##thermite:', '').replace(/:/g, ' ');
    return div;
  }
  if (plain.startsWith('$ ')) {
    div.className = 'l-cmd';
    div.textContent = plain;
    return div;
  }
  if (/^\s*(Compiling|Downloaded|Updating|Adding|Installing)\b/.test(plain)) {
    div.className = 'l-compiling';
    div.innerHTML = plain.replace(/^(\s*)(\w+)/, (_, s, w) => `${s}<em>${esc(w)}</em>`);
    return div;
  }
  if (/^\s*(Finished|BUILD SUCCESS)\b/.test(plain)) {
    div.className = 'l-ok';
    div.textContent = plain;
    return div;
  }
  if (/^(error|BUILD FAILED)/.test(plain)) {
    div.className = 'l-err';
    div.innerHTML = ansiToHtml(raw);
    return div;
  }
  if (/^warning/.test(plain)) {
    div.className = 'l-warn';
    div.innerHTML = ansiToHtml(raw);
    return div;
  }
  div.innerHTML = ansiToHtml(raw) || '&nbsp;';
  return div;
}
