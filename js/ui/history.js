// THERMITE — the ledger.
//
// History with no database behind it. The browser remembers only the pour id
// and its commit; everything shown — status, target, artifact — is read back
// from GitHub each time the drawer opens.

import { el, ago, esc } from '../util.js';
import { allPours, STATUS, rehydrate } from '../watch.js';

export class Ledger {
  constructor(root, { onOpen }) {
    this.root = root;
    this.list = root.querySelector('#ledger-list');
    this.onOpen = onOpen;
    this.onCleanup = null;
    this.login = null;
    this.busy = false;
  }

  open() {
    this.root.dataset.open = 'true';
    this.root.setAttribute('aria-hidden', 'false');
    this.root.querySelector('#ledger-close')?.focus();
    this.refresh();
  }

  close() {
    this.root.dataset.open = 'false';
    this.root.setAttribute('aria-hidden', 'true');
  }

  get isOpen() { return this.root.dataset.open === 'true'; }

  async refresh(login = this.login) {
    if (login) this.login = login;
    if (this.busy) return;
    this.busy = true;

    this.list.replaceChildren(el('div', { class: 'empty' },
      el('b', {}, el('span', { class: 'spinner' }), ' Reading your crucible')));

    // The crucible is the record; this browser is only a cache. A pour
    // submitted from another machine, or lost when site data was cleared, still
    // shows up here — and still shows its live status.
    let pours = [];
    try {
      pours = await allPours(this.login);
    } catch (e) {
      this.list.replaceChildren(el('div', { class: 'empty' },
        el('b', { text: 'Could not read your crucible' }),
        e.message || 'GitHub did not answer. Your pours are still there; try again.'));
      this.busy = false;
      return;
    }

    if (!pours.length) {
      this.list.replaceChildren(el('div', { class: 'empty' },
        el('b', { text: 'Nothing poured yet' }),
        'Every pour you submit shows up here with its live status, for as long as it exists in your crucible.'));
      this.busy = false;
      return;
    }

    this.list.replaceChildren(...pours.map((p) => this._row(p, null)));

    if (this.login) {
      for (const p of pours.slice(0, 10)) {
        try {
          const state = await rehydrate(this.login, p);
          const fresh = this._row(p, state);
          const old = this.list.querySelector(`[data-pour="${p.id}"]`);
          if (old) old.replaceWith(fresh);
        } catch { /* a single unreadable pour must not break the list */ }
      }
    }
    this.busy = false;
  }

  _row(p, state) {
    const status = state?.status || 'UNKNOWN';
    const s = STATUS[status] || STATUS.UNKNOWN;
    const terminal = ['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status);

    return el('div', { class: 'row', 'data-pour': p.id },
      el('button', {
        class: 'row__id', type: 'button', style: 'all:unset;cursor:pointer',
        onclick: () => this.onOpen(p),
      }, el('span', { class: 'row__id', text: p.id })),
      el('span', { class: 'tag row__st', 'data-tone': s.tone, text: state ? s.label : '…' }),
      el('div', { class: 'row__meta' },
        [p.toolchain, p.target, ago(p.submittedAt)].filter(Boolean).join(' · '),
        p.sealed ? ' · sealed' : '',
        p.recovered ? ' · recovered from your crucible' : ''),
      el('div', { class: 'rowacts' },
        el('button', {
          class: 'btn btn--ghost btn--small', type: 'button', text: 'Open',
          onclick: () => this.onOpen(p),
        }),
        terminal && this.onCleanup ? el('button', {
          class: 'btn btn--ghost btn--small', type: 'button', text: 'Clean up pour',
          onclick: (e) => { e.stopPropagation(); this.onCleanup(p); },
        }) : el('span', {
          class: 'muted mono', style: 'font-size:10px;align-self:center',
          text: state ? 'still building — cleanup disabled' : 'checking…',
        }),
      ),
    );
  }
}
