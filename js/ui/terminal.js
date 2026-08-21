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
    this._lastNode = null;
    this._lastText = null;
    this.view.replaceChildren();
  }

  /**
   * How many lines are worth having a node for. A trailing empty string is the
   * newline at the end of the log, not a line — rendering it would leave a
   * blank row under the output and push the caret onto its own line.
   */
  static renderable(lines) {
    return lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  }

  /** @param {string[]} lines full log split by newline */
  write(lines, { live } = {}) {
    if (this.dot) this.dot.dataset.live = String(!!live);

    const count = Terminal.renderable(lines);
    if (count < this.rendered) this.clear();          // the log was reset

    // The last line often grows without a newline — cargo spends most of a
    // build extending one. Appending only whole lines meant that output sat
    // invisible until the newline arrived, which is precisely the moment it
    // stops being interesting. So the boundary line is re-rendered in place.
    if (this.rendered > 0 && this._lastNode) {
      const current = lines[this.rendered - 1] ?? '';
      if (current !== this._lastText) {
        const fresh = renderLine(current);
        this._lastNode.replaceWith(fresh);
        this._lastNode = fresh;
        this._lastText = current;
      }
    }

    if (count > this.rendered) {
      const frag = document.createDocumentFragment();
      let last = null;
      for (let i = this.rendered; i < count; i++) {
        last = renderLine(lines[i]);
        frag.append(last);
      }

      const first = this.view.firstElementChild;
      if (first && first.classList?.contains('term__empty')) this.view.replaceChildren();

      const caret = this.view.querySelector('.caret');
      if (caret) caret.remove();
      this.view.append(frag);

      this._lastNode = last;
      this._lastText = lines[count - 1];
      this.rendered = count;

      // Bound the DOM. A long build can produce tens of thousands of lines and
      // the browser should not be holding all of them.
      while (this.view.childElementCount > WINDOW) {
        const gone = this.view.firstElementChild;
        if (gone === this._lastNode) break;
        gone.remove();
      }
    }

    this.lines = lines;
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
