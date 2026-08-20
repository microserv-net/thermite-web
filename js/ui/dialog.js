// THERMITE — confirmation.
//
// Destructive actions get a dialog that says exactly what will go, exactly what
// will stay, and exactly what GitHub keeps regardless. No action here is
// reversible, so none of it is guessed at.

import { el, $ } from '../util.js';

let lastFocus = null;

export function closeDialog() {
  const host = $('#dialog-host');
  host.dataset.open = 'false';
  host.replaceChildren();
  document.removeEventListener('keydown', onKey, true);
  lastFocus?.focus?.();
  lastFocus = null;
}

function onKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeDialog(); }
  if (e.key !== 'Tab') return;
  const focusables = [...$('#dialog-host').querySelectorAll(
    'button:not([disabled]), input, select, textarea, a[href]')];
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/**
 * @param {object} o
 * @param {string} o.title
 * @param {Node[]} o.body
 * @param {string} o.confirmLabel
 * @param {'danger'|'normal'} [o.kind]
 * @param {boolean} [o.disabled]  start with the confirm button disabled
 * @param {(setEnabled:(b:boolean)=>void)=>void} [o.onReady]
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title, body, confirmLabel, cancelLabel = 'Cancel',
  kind = 'normal', disabled = false, onReady,
}) {
  const host = $('#dialog-host');
  lastFocus = document.activeElement;

  return new Promise((resolve) => {
    const finish = (v) => { closeDialog(); resolve(v); };

    const confirm = el('button', {
      class: kind === 'danger' ? 'btn btn--danger' : 'btn',
      type: 'button', text: confirmLabel, disabled,
      onclick: () => finish(true),
    });

    const dialog = el('div', { class: 'dialog', 'data-kind': kind },
      el('div', { class: 'dialog__hd' }, el('h2', { class: 'display', text: title })),
      el('div', { class: 'dialog__bd' }, ...body),
      el('div', { class: 'dialog__ft' },
        el('button', { class: 'btn btn--ghost', type: 'button', text: cancelLabel, onclick: () => finish(false) }),
        confirm),
    );

    host.replaceChildren(dialog);
    host.dataset.open = 'true';
    host.onclick = (e) => { if (e.target === host) finish(false); };
    document.addEventListener('keydown', onKey, true);

    onReady?.((b) => { confirm.disabled = !b; });
    setTimeout(() => (disabled ? dialog.querySelector('input, select')?.focus() : confirm.focus()), 60);
  });
}

/** The three-column truth about what a cleanup does. */
export function scopeBlock({ removes, keeps, retained }) {
  return el('div', {},
    el('div', { class: 'willwont' },
      el('div', {},
        el('h4', { text: 'Deleted by Thermite' }),
        el('ul', {}, ...removes.map((t) => el('li', { text: t })))),
      el('div', {},
        el('h4', { text: 'Left untouched' }),
        el('ul', {}, ...keeps.map((t) => el('li', { text: t })))),
    ),
    retained?.length ? el('div', { class: 'retained' },
      el('h4', { text: 'Retained by GitHub regardless' }),
      el('ul', { style: 'list-style:none;margin:0;padding:0' },
        ...retained.map((t) => el('li', { text: t })))) : null,
  );
}

export function tally(rows) {
  return el('div', { class: 'tally' }, ...rows.map(([n, label, note, tone]) =>
    el('div', { class: 'tally__row', 'data-tone': tone || 'plain' },
      el('b', { text: String(n) }),
      el('span', { text: label }),
      note ? el('small', { text: note }) : null)));
}
