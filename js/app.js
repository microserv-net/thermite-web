// THERMITE — application.

import { APP, LIMITS, TARGETS, CHANNELS, derivedVersions } from './config.js';
import { gh, budget, onBudget, ApiError } from './github.js';
import * as auth from './auth.js';
import { readZip, inspectProject, ZipError, pathProblem } from './unzip.js';
import { provision, findCrucible, inspect, reline, wakeSweep, TEMPLATE_REVISION } from './provision.js';
import { submit, throttleCheck } from './submit.js';
import { PourWatcher, STATUS, STAGES, savePour, loadPours, forgetPours, diagnosticsFrom } from './watch.js';
import {
  $, $$, el, esc, bytes, duration, ago, reducedMotion, enc,
  cryptoAvailable, warnIfInsecureContext,
} from './util.js';
import { Deck } from './ui/fx.js';
import { Descent } from './ui/scroll.js';
import { Crucible } from './ui/crucible.js';
import { Terminal } from './ui/terminal.js';
import { Ledger } from './ui/history.js';
import { confirmDialog, closeDialog, scopeBlock, tally } from './ui/dialog.js';
import * as keys from './keys.js';
import * as consent from './consent.js';
import * as cleanup from './cleanup.js';
import * as retrieve from './retrieve.js';
import { renderDocs, renderTerms, DOCS } from './docs.js';
import { CryptoError } from './crypto.js';

// ---------------------------------------------------------------- state -----

const S = {
  login: null,
  crucible: null,
  crucibleState: null,
  toolchain: null,
  target: null,
  projectType: 'single',
  files: null,          // [{path, bytes}]
  projectName: null,
  watcher: null,
  releaseFeedTried: false,
  // encryption
  sealOn: false,
  keyState: null,
  keysBusy: false,
  // cleanup policy for the next pour
  policy: 'expire',
  onFailure: 'keep',
};

const deck = new Deck($('#deck'));
const crucible = new Crucible($('#crucible'));
const terminal = new Terminal($('#term-view'), { dot: $('#term-dot') });
const ledger = new Ledger($('#ledger'), { onOpen: (p) => openPour(p) });

const descent = new Descent([
  { key: 'intro', label: 'Ignition' },
  { key: 'connect', label: 'GitHub' },
  { key: 'toolchain', label: 'Rust' },
  { key: 'target', label: 'Target' },
  { key: 'source', label: 'Source' },
  { key: 'seal', label: 'Seal' },
  { key: 'confirm', label: 'Pour' },
], {
  onEnter(key) {
    const heat = { intro: .3, connect: .3, toolchain: .4, target: .5, source: .6, confirm: .8, how: .25 };
    deck.set({ intensity: heat[key] ?? .3, tone: key === 'confirm' ? 'hot' : 'warm' });
  },
});

deck.start();
crucible.start();

// ---------------------------------------------------------------- toast -----

function toast(title, message, kind = 'info', ms = 6500) {
  const t = el('div', { class: 'toast', 'data-kind': kind, role: 'status' },
    el('b', { text: title }), message);
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 350); }, ms);
  return t;
}

function problem(container, title, message) {
  const node = $(container);
  if (!message) { node.replaceChildren(); return; }
  node.replaceChildren(el('div', { class: 'problem' }, el('b', { text: title }), message));
}

function describeError(e) {
  if (e instanceof ApiError) return e.advice ? `${e.message} ${e.advice}` : e.message;
  return e?.message || 'Something went wrong and Thermite could not say what.';
}

// ------------------------------------------------------------- rate meter ---

onBudget((b) => {
  if (b.remaining == null) return;
  const m = $('#meter');
  m.hidden = false;
  $('#meter-n').textContent = String(b.remaining);
  m.dataset.thin = String(b.remaining < 1000);
  m.title = `Resets ${new Date(b.resetAt).toLocaleTimeString()}`;
});

// ================================================================ connect ====

$('#key-submit').addEventListener('click', connectWithKey);
$('#key-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectWithKey(); });

async function connectWithKey() {
  const btn = $('#key-submit');
  const value = $('#key-input').value;
  btn.disabled = true;
  btn.textContent = 'Checking';
  problem('#connect-problem', null, null);
  try {
    await auth.adopt(value);
    $('#key-input').value = '';
    await afterSignIn();
  } catch (e) {
    problem('#connect-problem', 'Cannot use that key', describeError(e));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

if (auth.deviceFlowAvailable()) {
  $('#device-alt').classList.remove('hidden');
  $('#device-start').addEventListener('click', async () => {
    const panel = $('#device-panel');
    panel.classList.remove('hidden');
    panel.replaceChildren(el('div', { class: 'readout__t', text: 'Asking GitHub for a code…' }));
    try {
      const d = await auth.deviceStart();
      panel.replaceChildren(
        el('div', { class: 'readout__t' }, 'Enter this code at ',
          el('a', { href: d.verification_uri, target: '_blank', rel: 'noopener noreferrer', text: d.verification_uri })),
        el('div', { class: 'display', style: 'font-size:38px;letter-spacing:.14em;margin:12px 0', text: d.user_code }),
        el('div', { class: 'readout__d', text: 'Waiting for you to authorise…' }),
      );
      await auth.devicePoll(d.device_code, d.interval);
      panel.classList.add('hidden');
      await afterSignIn();
    } catch (e) {
      panel.replaceChildren(el('div', { class: 'readout__d readout__warn', text: describeError(e) }));
    }
  });
}

$('#sign-out').addEventListener('click', async () => {
  await auth.signOut();
  location.reload();
});

async function afterSignIn() {
  const u = auth.session.user;
  S.login = u.login;

  $('#who').hidden = false;
  $('#who-avatar').src = u.avatar_url;
  $('#who-name').textContent = u.login;
  $('#open-ledger').hidden = false;

  $('#identity').classList.remove('hidden');
  $('#identity').replaceChildren(
    el('div', { class: 'identity' },
      el('img', { src: u.avatar_url, alt: '' }),
      el('div', {},
        el('div', { class: 'identity__n', text: u.login }),
        el('div', { class: 'identity__s', text: u.name ? `${u.name} · connected` : 'connected' })),
    ));

  await ensureCrucible();
  descent.unlock('toolchain');
  $('#connect-next').classList.remove('hidden');
  buildToolchains();
  ledger.login = S.login;
  ledger.refresh(S.login);
  refreshSeal(true).catch(() => {});
}

// ============================================================== crucible =====

async function ensureCrucible() {
  const box = $('#crucible-state');
  const line = (text, cls = 'readout__d') => el('div', { class: cls, text });

  box.replaceChildren(el('div', { class: 'readout' },
    el('div', { class: 'readout__t' }, el('span', { class: 'spinner' }), ' Looking for your crucible…')));

  try {
    let repo = await findCrucible(S.login);

    if (!repo) {
      const holder = el('div', { class: 'readout' });
      box.replaceChildren(holder);
      const steps = el('div', { class: 'readout__d' });
      holder.replaceChildren(
        el('div', { class: 'readout__t', text: `Creating ${S.login}/${APP.repoName}` }), steps);

      const done = [];
      const res = await provision(S.login, (step) => {
        done.push(step);
        steps.textContent = `${done.length}/8 · ${{
          check: 'checking', create: 'creating the repository', settle: 'waiting for GitHub',
          policy: 'restricting Actions to GitHub-owned actions', blobs: 'uploading the workflow',
          commit: 'writing the seed commit', logs: 'opening the log branch', verify: 'verifying',
        }[step] || step}`;
      });
      repo = res.repo;
      toast('Crucible ready', `${S.login}/${APP.repoName} is lined and waiting.`, 'good');
    }

    S.crucible = repo;
    S.crucibleState = await inspect(S.login);
    renderCrucibleState(box);
  } catch (e) {
    box.replaceChildren(el('div', { class: 'problem' },
      el('b', { text: 'Crucible unavailable' }), describeError(e)));
  }
}

function renderCrucibleState(box) {
  const st = S.crucibleState;
  const bits = [
    el('div', { class: 'readout__t' },
      el('a', {
        href: S.crucible.html_url, target: '_blank', rel: 'noopener noreferrer',
        text: `${S.login}/${APP.repoName}`,
      }),
      ' · ready'),
    el('div', {
      class: 'readout__d',
      text: st.actionsRestricted === false
        ? 'Actions are not restricted to GitHub-owned actions on this repository. Thermite could not set that policy — your key may lack Administration access.'
        : 'Public, Actions restricted to GitHub-owned actions, workflow permissions floored to read.',
    }),
  ];

  if (st.outdated) {
    bits.push(el('div', { class: 'readout__d readout__warn' },
      'This crucible was lined by an older version of Thermite. ',
      el('button', {
        class: 'btn btn--ghost btn--small', style: 'margin-left:8px',
        onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Re-lining';
          try { await reline(S.login); S.crucibleState = await inspect(S.login); renderCrucibleState(box);
            toast('Re-lined', `Updated to ${TEMPLATE_REVISION}.`, 'good'); }
          catch (err) { toast('Could not re-line', describeError(err), 'error'); }
        },
        text: 'Re-line it',
      })));
  }

  if (st.sweepDisabled) {
    bits.push(el('div', { class: 'readout__d readout__warn' },
      'GitHub disabled the scheduled cleanup after 60 days without activity. ',
      el('button', {
        class: 'btn btn--ghost btn--small', style: 'margin-left:8px',
        onclick: async (e) => {
          e.target.disabled = true;
          try { await wakeSweep(S.login, st.sweepId); toast('Cleanup re-enabled', 'It will resume on schedule.', 'good'); }
          catch (err) { toast('Could not re-enable it', describeError(err) + ' It needs Actions: write.', 'error'); }
        },
        text: 'Re-enable',
      })));
  }

  box.replaceChildren(el('div', { class: 'readout' }, ...bits));
}

// ============================================================= toolchain =====

function buildToolchains() {
  const cg = $('#channel-grid');
  cg.replaceChildren(...CHANNELS.map((c) => choice({
    name: c.name, note: c.blurb, value: c.name, onPick: pickToolchain,
  })));

  const vg = $('#version-grid');
  vg.replaceChildren(...derivedVersions().map((v) => choice({
    name: v, note: null, value: v, onPick: pickToolchain,
  })));

  // Reconcile the derived list against what Rust has actually released, so a
  // version that does not exist is never offered.
  refreshVersions().catch(() => {});
}

async function refreshVersions() {
  if (S.releaseFeedTried) return;
  S.releaseFeedTried = true;
  // rust-lang/rust tags are the source of truth and api.github.com is already
  // an allowed origin, so this needs no extra permission or third party.
  const tags = await gh.get('/repos/rust-lang/rust/releases?per_page=30').catch(() => null);
  if (!tags) return;
  const real = tags.map((t) => t.tag_name).filter((t) => /^\d+\.\d+\.\d+$/.test(t)).slice(0, 14);
  if (!real.length) return;
  $('#version-grid').replaceChildren(...real.map((v) => choice({
    name: v, note: null, value: v, onPick: pickToolchain,
  })));
  if (S.toolchain && real.includes(S.toolchain)) markPicked('#version-grid', S.toolchain);
}

function pickToolchain(value) {
  S.toolchain = value;
  markPicked('#channel-grid', value);
  markPicked('#version-grid', value);
  $('#toolchain-next').disabled = false;
  descent.unlock('target');
  buildTargets();
  invalidateFrom();
}

// ================================================================ target =====

let targetFilter = 'all';

function buildTargets() {
  const families = ['all', 'linux', 'windows', 'macos', 'wasm'];
  $('#target-filters').replaceChildren(...families.map((f) =>
    el('button', {
      class: 'filter', type: 'button', 'aria-pressed': String(f === targetFilter),
      text: f === 'all' ? 'everything' : f,
      onclick: () => { targetFilter = f; buildTargets(); },
    })));

  const list = TARGETS.filter((t) => targetFilter === 'all' || t.family === targetFilter);
  $('#target-grid').replaceChildren(...list.map((t) => {
    const blocked = unsupportedReason(t);
    return choice({
      name: t.label,
      flag: t.mode,
      note: blocked || t.triple,
      value: t.triple,
      disabled: !!blocked,
      onPick: pickTarget,
    });
  }));
  if (S.target) markPicked('#target-grid', S.target);
}

function unsupportedReason(t) {
  if (!S.toolchain) return null;
  if (t.minVersion && /^\d/.test(S.toolchain)) {
    const cmp = (a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
      return 0;
    };
    if (cmp(S.toolchain, t.minVersion) < 0) return `Needs Rust ${t.minVersion} or newer`;
  }
  if (t.cargoOnly && S.projectType === 'single') return 'Needs a cargo project, not a single file';
  return null;
}

function pickTarget(triple) {
  S.target = triple;
  markPicked('#target-grid', triple);
  $('#target-next').disabled = false;
  descent.unlock('source');
  renderTargetReadout();
  invalidateFrom();
}

function renderTargetReadout() {
  const t = TARGETS.find((x) => x.triple === S.target);
  if (!t) return;
  const notes = [];
  if (t.mode === 'cross') notes.push('Cross-compiled: built here, never executed here. Test it on real hardware.');
  else notes.push('Built natively on a runner of the same architecture.');
  if (!t.sandbox) notes.push('This runner cannot isolate the compile from the log relay\u2019s token — see the note in your crucible\u2019s README.');
  if (t.family === 'macos') notes.push('Unsigned and unnotarised: macOS will need an explicit override.');
  if (t.family === 'wasm') notes.push('Needs a cargo project; rustc alone cannot produce a usable wasm binary.');

  $('#target-readout').replaceChildren(el('div', { class: 'readout' },
    el('div', { class: 'readout__t' }, `${t.label} · `, el('span', { class: 'mono', text: t.triple })),
    el('div', { class: 'readout__d', text: t.blurb }),
    ...notes.map((n) => el('div', { class: 'readout__d readout__warn', text: n })),
    el('div', { class: 'readout__d', text: `Runner ${t.runner} · packaged as .${t.pack}` }),
  ));
}

// ================================================================ source =====

$('#mode-single').addEventListener('click', () => setMode('single'));
$('#mode-cargo').addEventListener('click', () => setMode('cargo'));

function setMode(mode) {
  S.projectType = mode;
  $('#mode-single').setAttribute('aria-pressed', String(mode === 'single'));
  $('#mode-cargo').setAttribute('aria-pressed', String(mode === 'cargo'));
  $('#file-input').accept = mode === 'single' ? '.rs' : '.zip';
  $('#drop-title').textContent = mode === 'single' ? 'Drop a .rs file' : 'Drop a project .zip';
  $('#drop-hint').textContent = mode === 'single'
    ? `or click to browse · up to ${bytes(LIMITS.singleFileBytes)}`
    : `or click to browse · up to ${bytes(LIMITS.zipBytes)} · Cargo.toml at the root`;
  S.files = null;
  $('#source-card').replaceChildren();
  problem('#source-problem', null, null);
  $('#source-next').disabled = true;
  buildTargets();
  invalidateFrom();
}

const drop = $('#drop');
const input = $('#file-input');
drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.dataset.over = 'true';
}));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.dataset.over = 'false';
}));
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) takeFile(f);
});
input.addEventListener('change', () => { if (input.files[0]) takeFile(input.files[0]); });

async function takeFile(file) {
  problem('#source-problem', null, null);
  $('#source-card').replaceChildren(el('div', { class: 'filecard' },
    el('div', { class: 'filecard__head' },
      el('div', { class: 'filecard__name' }, el('span', { class: 'spinner' }), ' reading ' + file.name))));

  try {
    if (S.projectType === 'single') await takeSingle(file);
    else await takeZip(file);

    $('#source-next').disabled = false;
    descent.unlock('seal');
    descent.unlock('confirm');
    refreshSeal();
    renderConfirm();
  } catch (e) {
    S.files = null;
    $('#source-card').replaceChildren();
    $('#source-next').disabled = true;
    problem('#source-problem',
      e instanceof ZipError ? 'That archive will not do' : 'Cannot use that file',
      describeError(e));
  }
}

async function takeSingle(file) {
  if (!file.name.endsWith('.rs')) {
    throw new Error('Single-file mode wants a .rs file. Switch to project mode for an archive.');
  }
  if (file.size > LIMITS.singleFileBytes) {
    throw new Error(`That file is ${bytes(file.size)}. The ceiling for a single file is ${bytes(LIMITS.singleFileBytes)}; use project mode instead.`);
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  const name = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
  S.files = [{ path: name, bytes: buf }];
  S.projectName = name.replace(/\.rs$/, '');

  const text = new TextDecoder().decode(buf.subarray(0, 4000));
  const hasMain = /fn\s+main\s*\(/.test(new TextDecoder().decode(buf));

  $('#source-card').replaceChildren(el('div', { class: 'filecard' },
    el('div', { class: 'filecard__head' },
      el('div', { class: 'filecard__name', text: name }),
      el('div', { class: 'filecard__stats', text: `${bytes(buf.length)} · ${text.split('\n').length}+ lines` })),
    hasMain ? null : el('div', { class: 'readout__d readout__warn', style: 'margin-top:10px',
      text: 'No fn main() found. rustc will refuse to link this as an executable.' }),
  ));
}

async function takeZip(file) {
  if (!/\.zip$/i.test(file.name)) throw new Error('Project mode wants a .zip archive.');
  const buf = await file.arrayBuffer();
  const { files, skipped, stripped } = await readZip(buf);
  const info = inspectProject(files);

  if (!info.hasCargoToml) {
    throw new ZipError(info.nestedCargoToml
      ? `Cargo.toml is at "${info.nestedCargoToml}" but Thermite needs it at the archive root. Zip the contents of the project folder, not the folder itself.`
      : 'No Cargo.toml at the root of the archive. Thermite needs a real cargo project here.');
  }

  S.files = files;
  S.projectName = info.packageName || file.name.replace(/\.zip$/i, '');

  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  const shown = files.slice(0, 60);

  $('#source-card').replaceChildren(el('div', { class: 'filecard' },
    el('div', { class: 'filecard__head' },
      el('div', { class: 'filecard__name', text: S.projectName }),
      el('div', { class: 'filecard__stats',
        text: `${files.length} files · ${bytes(total)} · ${info.rustFiles} .rs${info.hasLock ? ' · Cargo.lock' : ''}` })),
    stripped ? el('div', { class: 'readout__d', style: 'margin-top:8px',
      text: `Unwrapped the "${stripped}/" folder so Cargo.toml sits at the root.` }) : null,
    skipped.length ? el('div', { class: 'readout__d', style: 'margin-top:6px',
      text: `Left out ${skipped.length} file${skipped.length > 1 ? 's' : ''} (build output, VCS and editor cruft).` }) : null,
    el('div', { class: 'filecard__tree' },
      ...shown.map((f) => el('div', { text: f.path })),
      files.length > shown.length ? el('i', { text: `+ ${files.length - shown.length} more` }) : null),
  ));
}

// =============================================================== confirm =====

function renderConfirm() {
  if (!S.files) return;
  const t = TARGETS.find((x) => x.triple === S.target);
  const total = S.files.reduce((n, f) => n + f.bytes.length, 0);

  const rows = [
    ['Crucible', `${S.login}/${APP.repoName}`],
    ['Toolchain', S.toolchain],
    ['Target', `${t.label} — ${t.triple}`],
    ['Build', S.projectType === 'cargo' ? 'cargo build --release' : 'rustc -O'],
    ['Runner', `${t.runner} · ${t.mode}`],
    ['Source', `${S.files.length} file${S.files.length > 1 ? 's' : ''} · ${bytes(total)}`],
    ['Artifact', S.sealOn
      ? `Sealed .tenc container holding the .${t.pack}`
      : `.${t.pack} with the binary, SHA256SUMS and a build record`],
    ['Encryption', S.sealOn
      ? `Source, ingot and log sealed — THERMITE-ENC v1, keys ${S.keyState?.sourceKeyId || '?'} / ${S.keyState?.artifactKeyId || '?'}`
      : 'Off — your source is committed to a public repository as plaintext'],
    ['Cleanup', {
      expire: 'Swept about 24 hours after the pour',
      onReturn: 'Removed once you have retrieved and verified the ingot',
      onSuccess: 'Removed as soon as the build succeeds',
    }[S.policy] + (S.onFailure === 'clean' ? ' · failed builds cleaned too' : ' · failed builds kept')],
  ];

  const dl = el('dl');
  for (const [k, v] of rows) { dl.append(el('dt', { text: k }), el('dd', { text: v })); }
  $('#confirm-sheet').replaceChildren(dl);
}

$('#pour-btn').addEventListener('click', startPour);

/** The pour button is disabled until the acknowledgements are made. */
function gatePour() {
  const acked = consent.state().accepted;
  const btn = $('#pour-btn');
  const sealBlocked = S.sealOn && !(keys.readiness(S.keyState || {}, { source: true, artifact: true }).ok);

  // Web Crypto is required for a SEALED pour only. A plain one drops its tamper
  // hash and builds normally — see util.treeHash.
  if (!cryptoAvailable() && S.sealOn) {
    btn.disabled = true;
    $('#pour-note').textContent =
      'Encrypted pours need Web Crypto, which this page has no access to. See the banner at the top.';
    return;
  }

  btn.disabled = !acked || sealBlocked;
  $('#pour-note').textContent = !acked
    ? 'Acknowledge both statements above to enable the pour.'
    : sealBlocked
      ? 'Encryption is switched on but not ready. Finish the setup on the seal station, or switch it off.'
      : 'Uses your GitHub Actions minutes. Public repositories are unmetered.';
}

async function startPour() {
  const btn = $('#pour-btn');
  btn.disabled = true;
  btn.textContent = 'Pouring';
  problem('#pour-problem', null, null);

  try {
    const throttle = await throttleCheck(S.login);
    if (!throttle.ok) throw new Error(throttle.message);

    // A sealed pour is only submitted when sealing is verifiably ready. It is
    // never silently downgraded to plaintext.
    if (S.sealOn) {
      const verdict = keys.readiness(S.keyState || {}, { source: true, artifact: true });
      if (!verdict.ok) throw new Error(`Encryption is not ready: ${verdict.problems[0]}`);
    }

    const { id, commitSha, manifest } = await submit({
      login: S.login,
      toolchain: S.toolchain,
      target: S.target,
      projectType: S.projectType,
      name: S.projectName,
      files: S.files,
      encrypt: S.sealOn
        ? { sourcePem: S.keyState.sourcePem, artifactKeyId: S.keyState.artifactKeyId }
        : null,
      cleanup: { policy: S.policy, onFailure: S.onFailure },
      onStage(stage, d) {
        if (stage === 'sealing') btn.textContent = 'Sealing';
        if (stage === 'blobs') btn.textContent = `Uploading ${d.done}/${d.total}`;
        if (stage === 'commit') btn.textContent = 'Committing';
        if (stage === 'contended') btn.textContent = `Retrying (${d.attempt})`;
      },
    });

    const pour = {
      id, commitSha, login: S.login,
      toolchain: S.toolchain, target: S.target,
      projectType: S.projectType, name: S.projectName,
      submittedAt: manifest.submittedAt,
      sealed: !!manifest.encryption,
      policy: S.policy, onFailure: S.onFailure,
    };
    savePour(pour);
    openPour(pour);
  } catch (e) {
    problem('#pour-problem', 'Pour refused', describeError(e));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Pour';
  }
}

// =============================================================== furnace =====

$('#f-back').addEventListener('click', closeFurnace);
$('#term-follow').addEventListener('click', (e) => {
  terminal.setFollow(e.currentTarget.getAttribute('aria-pressed') !== 'true');
});
$('#term-motion').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  crucible.setMotion(on);
  on ? deck.start() : deck.pause();
});
$('#term-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(terminal.text());
    toast('Copied', 'The full log is on your clipboard.', 'good', 3000);
  } catch {
    toast('Could not copy', 'Your browser blocked clipboard access. Select the log and copy manually.', 'error');
  }
});

function buildPipeline() {
  $('#pipeline').replaceChildren(...STAGES.map((s) =>
    el('div', { class: 'pstage', 'data-stage': s, 'data-state': 'idle', text: s })));
}
buildPipeline();

function openPour(pour) {
  if (S.watcher) S.watcher.stop();

  document.body.dataset.mode = 'furnace';
  ledger.close();
  location.hash = `p=${pour.id}`;

  $('#f-id').textContent = pour.id;
  $('#f-sha').textContent = pour.commitSha ? pour.commitSha.slice(0, 10) : '—';
  terminal.clear();
  terminal.empty('Waiting for the runner to pick this up…');
  buildPipeline();
  crucible.update({ status: 'QUEUED', lineRate: 0 });
  requestAnimationFrame(() => crucible.resize());

  const w = new PourWatcher({ ...pour, login: pour.login || S.login });
  S.watcher = w;
  w.addEventListener('update', () => paintFurnace(pour, w));
  w.start();

  clearInterval(S.clock);
  S.clock = setInterval(() => {
    if (!S.watcher) return;
    $('#f-clock').textContent = duration(S.watcher.elapsed);
  }, 500);
}

function closeFurnace() {
  if (S.watcher) S.watcher.stop();
  S.watcher = null;
  clearInterval(S.clock);
  document.body.dataset.mode = 'descent';
  history.replaceState(null, '', location.pathname + location.search);
  ledger.refresh(S.login);
}

function paintFurnace(pour, w) {
  const st = w.state;
  const meta = STATUS[st.status] || STATUS.UNKNOWN;

  $('#f-status').textContent = meta.label;
  $('#f-status').dataset.tone = meta.tone;
  $('#f-sha').textContent = st.commitSha.slice(0, 10);

  deck.set({ tone: meta.tone === 'hot' ? 'hot' : meta.tone, intensity: st.status === 'BUILDING' ? .9 : .4 });
  crucible.update({ status: st.status, lineRate: st.lineRate });

  // pipeline — advanced only by evidence
  const idx = STAGES.indexOf(st.stage);
  $$('.pstage').forEach((n, i) => {
    if (st.status === 'FAILED' && i === idx) n.dataset.state = 'fault';
    else if (i < idx || st.status === 'SUCCESS') n.dataset.state = 'done';
    else if (i === idx) n.dataset.state = w.isTerminal() ? 'done' : 'live';
    else n.dataset.state = 'idle';
  });

  // terminal
  if (st.logLocked && !st.log) {
    terminal.empty(
      'This pour’s log is sealed, because compiler diagnostics quote your source and the log ' +
      'branch is public. Load your artifact private key to read it.');
  } else if (st.log) {
    terminal.write(st.logLines, { live: !w.isTerminal() });
  } else if (st.logStreamLost) {
    terminal.empty('The runner has not published any log yet. Status below is still live and correct.');
  } else if (st.status === 'QUEUED') {
    terminal.empty('Queued on GitHub. Runners usually pick a job up within a few seconds.');
  }
  $('#term-title').textContent =
    (st.logSealed ? 'the crucible · sealed' : 'the crucible') +
    (st.job?.runnerName ? ` · ${st.job.runnerName}` : '');

  // metadata
  const t = TARGETS.find((x) => x.triple === pour.target);
  const rows = [
    ['Status', meta.label],
    ['Rust', pour.toolchain],
    ['Target', pour.target],
    ['Kind', pour.projectType === 'cargo' ? 'cargo project' : 'single file'],
    ['Submitted', ago(pour.submittedAt)],
    ['Elapsed', duration(w.elapsed)],
    ['Commit', st.commitSha.slice(0, 10)],
    ['Run', st.run ? String(st.run.id) : 'not created yet'],
    ['Runner', st.meta?.runner || (st.job?.labels || []).join(', ') || t?.runner || '—'],
    ['rustc', st.meta?.rustc || '—'],
    ['cargo', st.meta?.cargo || '—'],
    ['Sealed', st.logSealed || st.download?.sealed ? 'source, ingot and log' : 'no'],
    ['Cleanup', {
      expire: 'after ~24 h',
      onReturn: 'once retrieved',
      onSuccess: 'on success',
    }[pour.policy] || 'after ~24 h'],
    ['Artifact', st.artifact
      ? (st.artifact.expired ? 'expired' : `${bytes(st.artifact.bytes)} · expires ${new Date(st.artifact.expiresAt).toLocaleDateString()}`)
      : (st.status === 'SUCCESS' ? 'resolving…' : '—')],
  ];
  const dl = $('#f-meta');
  dl.replaceChildren();
  for (const [k, v] of rows) { dl.append(el('dt', { text: k }), el('dd', { text: v })); }
  if (st.run) {
    dl.append(el('dt', { text: 'On GitHub' }),
      el('dd', {}, el('a', { href: st.run.url, target: '_blank', rel: 'noopener noreferrer', text: 'open the run' })));
  }

  // foot
  const foot = $('#f-foot');
  foot.replaceChildren();

  if (st.error) {
    foot.append(el('div', { class: 'problem', style: 'width:100%' },
      el('b', { text: 'Trouble talking to GitHub' }), st.error));
  }

  if (st.status === 'SUCCESS') {
    foot.append(el('div', { class: 'ingot', style: st.ingotMissing ? 'border-left-color:var(--scale)' : null },
      el('div', {},
        el('div', { class: 'ingot__t', text: st.download ? st.download.name : `thermite-${st.id}` }),
        el('div', { class: 'ingot__s', text: st.download
          ? `${bytes(st.download.bytes)} · release asset · no sign-in needed to download`
          : st.ingotMissing
            ? 'This build succeeded, but its ingot is no longer in the crucible — cleanup removes releases about 24 hours after a pour. GitHub keeps the run record longer than the artifacts. Pour it again to get a fresh binary.'
            : 'packaging the ingot…' })),
      el('div', { class: 'ingot__sp' }),
      st.fullLogUrl ? el('a', {
        class: 'btn btn--ghost btn--small', href: st.fullLogUrl,
        text: st.fullLogUrl.endsWith('.tenc') ? 'Sealed log' : 'Full log',
      }) : null,
      st.download ? el('button', {
        class: 'btn btn--quench', type: 'button', id: 'retrieve-btn',
        text: st.retrieved ? 'Retrieve again' : 'Retrieve ingot',
        onclick: () => retrieveIngot(pour, st),
      }) : st.ingotMissing
        ? el('a', {
            class: 'btn btn--ghost btn--small', target: '_blank', rel: 'noopener noreferrer',
            href: st.run?.url || `https://github.com/${pour.login || S.login}/${APP.repoName}`,
            text: 'Open the run',
          })
        : el('span', { class: 'muted' }, el('span', { class: 'spinner' }), ' resolving'),
      st.download ? el('a', {
        class: 'btn btn--ghost btn--small', href: st.download.url, download: '',
        text: 'Plain download',
        title: st.download.sealed
          ? 'Downloads the sealed container without opening it. Does not count as retrieved.'
          : 'Downloads without verifying. Does not count as retrieved.',
      }) : null,
    ));

    if (st.retrieved) {
      foot.append(el('div', { class: 'ingot', style: 'border-left-color:var(--quench)' },
        el('div', {},
          el('div', { class: 'ingot__t', text: `Returned · ${st.retrieved.name}` }),
          el('div', { class: 'ingot__s', text:
            `${bytes(st.retrieved.size)} · sha256 ${st.retrieved.sha256.slice(0, 24)}…` +
            (st.retrieved.sealed ? ` · opened and integrity-verified with key ${st.retrieved.keyId}` : ' · integrity by checksum') })),
      ));
    }

    if (st.download?.sealed && !keys.held.artifact) {
      foot.append(el('div', { class: 'problem', style: 'width:100%' },
        el('b', { text: 'Ingot is sealed' }),
        'Load your artifact private key to open it. Thermite has no copy of it, and neither does GitHub.',
        el('div', { style: 'margin-top:10px' },
          el('button', { class: 'btn btn--ghost btn--small', type: 'button',
            text: 'Load private key', onclick: () => loadArtifactKey() }))));
    }
  }

  if (st.status === 'FAILED') {
    const diags = diagnosticsFrom(st.log);
    if (diags.length) {
      foot.append(el('div', { class: 'faults' },
        ...diags.slice(0, 20).map((d) => el('div', { class: 'fault' },
          el('div', { class: 'fault__code', text: d.code || d.level }),
          el('div', {},
            el('div', { class: 'fault__msg', text: d.message }),
            d.file ? el('div', { class: 'fault__at', text: `${d.file}:${d.line}:${d.column}` }) : null)))));
    } else {
      foot.append(el('div', { class: 'problem', style: 'width:100%' },
        el('b', { text: 'Build failed' }),
        'No compiler diagnostics were captured. The failure is likely in toolchain or target setup — the log above has the detail.'));
    }
  }

  if (st.status === 'EXPIRED') {
    foot.append(el('div', { class: 'problem', style: 'width:100%' },
      el('b', { text: 'Artifact expired' }),
      'GitHub deleted this build\u2019s artifact. Pour it again to get a fresh one.'));
  }
}


// ================================================================= manual ====

let manualBuilt = false;

function openManual(which, anchor) {
  if (!manualBuilt) {
    renderDocs($('#docs-pages'), $('#docs-index'), (id) => scrollDoc(id));
    renderTerms($('#terms-pages'));
    $('#docs-pages').addEventListener('scroll', spyDocs, { passive: true });
    manualBuilt = true;
  }
  document.body.dataset.mode = which === 'terms' ? 'terms' : 'manual';
  $('#manual-docs').dataset.active = String(which !== 'terms');
  $('#manual-terms').dataset.active = String(which === 'terms');
  const pane = which === 'terms' ? $('#terms-pages') : $('#docs-pages');
  if (anchor) scrollDoc(anchor); else pane.scrollTop = 0;
  pane.focus?.();
  deck.set({ intensity: .18, tone: 'cold' });
}

function closeManual() {
  $('#manual-docs').dataset.active = 'false';
  $('#manual-terms').dataset.active = 'false';
  document.body.dataset.mode = S.watcher ? 'furnace' : 'descent';
  deck.set({ intensity: .4, tone: 'warm' });
}

function scrollDoc(id) {
  const target = document.getElementById(`doc-${id}`) || document.getElementById(`terms-${id}`);
  target?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  spyDocs();
}

function spyDocs() {
  const pane = $('#docs-pages');
  const top = pane.getBoundingClientRect().top;
  let current = DOCS[0]?.id;
  for (const c of DOCS) {
    const n = document.getElementById(`doc-${c.id}`);
    if (n && n.getBoundingClientRect().top - top < 140) current = c.id;
  }
  $$('.docnav').forEach((b) => b.setAttribute('aria-current', String(b.dataset.doc === current)));
}

$('#open-docs').addEventListener('click', () => openManual('docs'));
$('#open-terms').addEventListener('click', () => openManual('terms'));
$('#hero-docs').addEventListener('click', () => openManual('docs'));
$('#manual-close').addEventListener('click', closeManual);
$('#terms-close').addEventListener('click', closeManual);
$('#docs-to-terms').addEventListener('click', () => openManual('terms'));
$('#terms-manual').addEventListener('click', () => openManual('docs'));
$$('[data-open-doc]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  openManual('docs', a.dataset.openDoc);
}));

// ================================================================ consent ====

function renderConsent() {
  const st = consent.state();
  const host = $('#consent');
  host.hidden = false;

  if (st.accepted) {
    $('#consent-acks').replaceChildren(el('p', { class: 'muted', style: 'margin:0',
      text: `Acknowledged ${new Date(st.at).toLocaleString()} (${st.scope === 'device' ? 'remembered on this device' : 'this session'}). Terms version ${consent.TERMS_VERSION}.` }));
    $('#consent-remember').closest('.ack').hidden = true;
    $('#consent-state').replaceChildren(
      el('button', {
        class: 'btn btn--ghost btn--small', type: 'button', text: 'Withdraw',
        onclick: () => { consent.withdraw(); renderConsent(); gatePour(); },
      }));
    gatePour();
    return;
  }

  const boxes = new Map();
  const check = () => {
    if ([...boxes.values()].every((b) => b.checked)) {
      consent.accept({ remember: $('#consent-remember').checked });
      renderConsent();
    }
    gatePour();
  };

  $('#consent-acks').replaceChildren(...consent.ACKS.map((a) => {
    const input = el('input', { type: 'checkbox', id: `ack-${a.id}`, onchange: check });
    boxes.set(a.id, input);
    return el('label', { class: 'ack', for: `ack-${a.id}` }, input, el('span', { text: a.text }));
  }));
  $('#consent-remember').closest('.ack').hidden = false;
  $('#consent-state').replaceChildren(el('span', { class: 'muted',
    text: 'Stored in your browser only \u2014 a static site cannot hold a server-side record.' }));
  gatePour();
}

$('#consent-read').addEventListener('click', (e) => { e.preventDefault(); openManual('terms'); });

// ------------------------------------------------------- cleanup policy -----

function bindPolicy() {
  const note = () => {
    $('#cleanup-note').textContent = {
      expire: 'The scheduled sweep in your crucible removes this pour about 24 hours from now, once its run has finished.',
      onReturn: 'Nothing is deleted until the ingot is in this browser and \u2014 if sealed \u2014 decrypted and integrity-checked. If retrieval fails, the pour stays.',
      onSuccess: 'Removed as soon as a successful run completes. The ingot is still downloadable until then, so retrieve it first.',
    }[S.policy] + (S.onFailure === 'clean'
      ? ' Failed builds are cleaned up too \u2014 you will lose their logs.'
      : ' Failed builds are kept, because their logs are usually the point.');
  };
  $('#cleanup-policy').addEventListener('change', (e) => { S.policy = e.target.value; note(); renderConfirm(); });
  $('#cleanup-failure').addEventListener('change', (e) => { S.onFailure = e.target.value; note(); renderConfirm(); });
  note();
}

// =================================================================== seal ====

$('#seal-toggle').addEventListener('click', async () => {
  S.sealOn = !S.sealOn;
  $('#seal-toggle').setAttribute('aria-checked', String(S.sealOn));
  $('#seal-body').hidden = !S.sealOn;
  $('#seal-hint').textContent = S.sealOn ? 'Source, ingot and log will be sealed' : 'Default: plaintext';
  if (S.sealOn && !S.keyState) await refreshSeal(true);
  else paintSeal();
  renderConfirm();
  gatePour();
});

async function refreshSeal(force) {
  if (!S.login) return;
  if (S.keysBusy) return;
  if (S.keyState && !force) { paintSeal(); return; }
  S.keysBusy = true;
  paintSeal({ loading: true });
  try {
    S.keyState = await keys.readKeys(S.login);
    const stashed = await keys.stashedArtifactKeyId().catch(() => null);
    S.stashedKeyId = stashed;
  } catch (e) {
    toast('Could not read your keys', describeError(e), 'error');
  } finally {
    S.keysBusy = false;
    paintSeal();
    gatePour();
  }
}

function checkRow(ok, label, detail) {
  return el('div', { class: 'check', 'data-ok': ok },
    el('span', {}, label, detail ? el('small', { text: detail }) : null));
}

function paintSeal({ loading } = {}) {
  if (!S.sealOn) { $('#seal-verdict').replaceChildren(); return; }
  const st = S.keyState;

  if (loading || !st) {
    $('#seal-source-checks').replaceChildren(
      el('div', { class: 'check' }, el('span', {}, el('span', { class: 'spinner' }), ' reading your crucible')));
    $('#seal-artifact-checks').replaceChildren();
    return;
  }

  // ---- source side ----
  $('#seal-source-checks').replaceChildren(
    checkRow(st.sourcePem ? 'true' : 'false',
      st.sourcePem ? `Public key registered · ${st.sourceKeyId}` : 'No source public key in your crucible',
      st.sourcePem ? '.thermite/keys/source-public.pem' : null),
    checkRow(
      st.secret === 'present' ? 'true' : st.secret === 'absent' ? 'false' : 'warn',
      st.secret === 'present' ? `Secret ${keys.SECRET_NAME} is set`
        : st.secret === 'absent' ? `Secret ${keys.SECRET_NAME} is missing`
        : `Cannot verify ${keys.SECRET_NAME}`,
      st.secret === 'present' ? `updated ${ago(st.secretUpdatedAt)} · Thermite reads existence only, never the value`
        : st.secret === 'absent' ? 'The runner cannot decrypt your source without it'
        : 'Add "Secrets: read" to your forge key for a definitive answer'),
  );

  const srcActions = [
    el('button', {
      class: 'btn btn--ghost btn--small', type: 'button',
      text: st.sourcePem ? 'Regenerate source keypair' : 'Generate source keypair',
      onclick: () => mintSource(),
    }),
  ];
  if (st.sourcePem) {
    srcActions.push(el('a', {
      class: 'btn btn--ghost btn--small', target: '_blank', rel: 'noopener noreferrer',
      href: keys.secretsUrl(S.login), text: 'Open repository secrets',
    }));
  }
  $('#seal-source-actions').replaceChildren(...srcActions);

  // ---- artifact side ----
  const held = keys.held.artifact;
  $('#seal-artifact-checks').replaceChildren(
    checkRow(st.artifactPem ? 'true' : 'false',
      st.artifactPem ? `Public key registered · ${st.artifactKeyId}` : 'No artifact public key in your crucible',
      st.artifactPem ? '.thermite/keys/artifact-public.pem' : null),
    checkRow(held ? 'true' : 'warn',
      held ? `Private key loaded · ${held.keyId}${keys.held.fromVault ? ' (from this device)' : ''}`
        : 'Private key not loaded in this tab',
      held ? 'Held in memory only. Thermite has no copy.'
        : 'You can pour without it, but you will need it to open the ingot and read the sealed log.'),
  );

  const artActions = [
    el('button', {
      class: 'btn btn--ghost btn--small', type: 'button',
      text: st.artifactPem ? 'Replace artifact keypair' : 'Generate artifact keypair',
      onclick: () => mintArtifact(),
    }),
    el('button', {
      class: 'btn btn--ghost btn--small', type: 'button', text: 'Load a private key',
      onclick: () => loadArtifactKey(),
    }),
  ];
  if (S.stashedKeyId && !held) {
    artActions.push(el('button', {
      class: 'btn btn--ghost btn--small', type: 'button', text: 'Unlock stored key',
      onclick: () => unlockStashed(),
    }));
  }
  if (held) {
    artActions.push(el('button', {
      class: 'btn btn--ghost btn--small', type: 'button', text: 'Unload',
      onclick: () => { keys.unloadArtifactPrivate(); paintSeal(); gatePour(); },
    }));
  }
  $('#seal-artifact-actions').replaceChildren(...artActions);

  // ---- verdict ----
  const verdict = keys.readiness(st, { source: true, artifact: true });
  const box = $('#seal-verdict');
  box.dataset.ok = String(verdict.ok);
  box.replaceChildren(
    el('span', { text: verdict.ok ? 'Encryption ready' : 'Encryption not ready' }),
    el('small', {
      text: verdict.ok
        ? (verdict.notes[0] || 'Your source, ingot and build log will all be sealed.')
        : verdict.problems[0],
    }),
  );
  if (verdict.ok && verdict.notes.length) {
    box.append(el('small', { style: 'flex-basis:100%', text: verdict.notes.slice(1).join(' ') }));
  }
}

async function mintSource() {
  const go = await confirmDialog({
    title: 'Generate the source keypair',
    confirmLabel: 'Generate',
    body: [
      el('p', {}, 'Thermite generates an RSA-4096 keypair in this browser. The public half is committed to your crucible. The private half is shown to you once, and you paste it into your repository secrets so the runner can decrypt your source.'),
      el('p', {}, el('b', { text: 'Thermite never sees the private half again. ' }),
        'It is not stored, not uploaded, and not readable through the GitHub API by anyone, including you.'),
      S.keyState?.sourcePem ? el('p', {}, el('b', { text: 'Replacing an existing key: ' }),
        'pours already sealed for the old key will fail to build until you also update the secret.') : null,
    ].filter(Boolean),
  });
  if (!go) return;

  const toastNode = toast('Generating', 'RSA-4096 keypair \u2014 this takes a moment.', 'info', 20000);
  try {
    const kp = await keys.mintSourceKeypair();
    await keys.registerPublicKey(S.login, keys.SOURCE_PUB, kp.publicPem, 'source');
    toastNode.remove();
    showKeyOnce({
      kind: 'source', keyId: kp.keyId, pem: kp.privatePem,
      filename: `thermite-source-private-${kp.keyId}.pem`,
    });
    await refreshSeal(true);
  } catch (e) {
    toastNode.remove();
    toast('Could not generate the key', describeError(e), 'error');
  }
}

async function mintArtifact() {
  const go = await confirmDialog({
    title: 'Generate the artifact keypair',
    confirmLabel: 'Generate',
    kind: S.keyState?.artifactPem ? 'danger' : 'normal',
    body: [
      el('p', {}, 'A completely separate RSA-4096 keypair, generated in this browser. The public half is registered in your crucible so the runner can seal your ingot. The private half stays with you.'),
      el('p', {}, el('b', { text: 'It is shown once. ' }),
        'Thermite keeps no copy and has no recovery mechanism \u2014 deliberately, because a recovery mechanism would be a way for someone other than you to open your data.'),
      S.keyState?.artifactPem ? el('p', {}, el('b', { text: 'Replacing an existing key: ' }),
        'ingots already sealed for the old key can only ever be opened with the old key. Keep it if you still need them.') : null,
    ].filter(Boolean),
  });
  if (!go) return;

  const toastNode = toast('Generating', 'RSA-4096 keypair \u2014 this takes a moment.', 'info', 20000);
  try {
    const kp = await keys.mintArtifactKeypair();
    await keys.registerPublicKey(S.login, keys.ARTIFACT_PUB, kp.publicPem, 'artifact');
    toastNode.remove();
    showKeyOnce({
      kind: 'artifact', keyId: kp.keyId, pem: kp.privatePem,
      filename: `thermite-artifact-private-${kp.keyId}.pem`,
    });
    await refreshSeal(true);
  } catch (e) {
    toastNode.remove();
    toast('Could not generate the key', describeError(e), 'error');
  }
}

/** The one and only time a private key is displayed. */
function showKeyOnce({ kind, keyId, pem, filename }) {
  const isSource = kind === 'source';
  const area = el('textarea', { readOnly: true, spellcheck: false, value: pem,
    'aria-label': `${kind} private key` });

  const box = el('div', { class: 'keyout' },
    el('div', { class: 'keyout__hd', text: `${kind} private key · ${keyId} · shown once` }),
    area,
    el('div', { class: 'keyout__ft' },
      el('span', { class: 'keyout__warn', text: isSource
        ? `Paste this into your repository secret named ${keys.SECRET_NAME}. Do not commit it, do not store it in the repository, do not send it anywhere else.`
        : 'Save this now. If you lose it, Thermite cannot recover it and your sealed ingots cannot be opened \u2014 by anyone.' }),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Copy',
        onclick: async () => {
          try { await navigator.clipboard.writeText(pem); toast('Copied', 'The private key is on your clipboard.', 'good', 3000); }
          catch { area.select(); toast('Select and copy', 'Your browser blocked clipboard access.', 'error'); }
        } }),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Download',
        onclick: () => retrieve.save(enc.encode(pem), filename) }),
      isSource
        ? el('a', { class: 'btn', href: keys.secretsUrl(S.login), target: '_blank', rel: 'noopener noreferrer',
            text: 'Add the secret' })
        : el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Keep on this device',
            onclick: () => stashArtifact(pem, keyId) }),
      el('button', { class: 'btn btn--quench btn--small', type: 'button', text: 'I have saved it',
        onclick: () => { box.remove(); paintSeal(); } }),
    ));

  $('#seal-keyout').replaceChildren(box);
  box.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
}

async function stashArtifact(pem, keyId) {
  let input;
  const go = await confirmDialog({
    title: 'Keep the key on this device',
    confirmLabel: 'Encrypt and store',
    body: [
      el('p', {}, 'The key is encrypted with a passphrase you choose and stored in this browser. The passphrase is the only thing protecting it \u2014 Thermite cannot reset it and cannot recover the key without it.'),
      el('p', {}, el('b', { text: 'This is a convenience, not a backup. ' }),
        'Clearing site data destroys it. Keep your own copy as well.'),
      (input = el('input', { class: 'field', type: 'password', autocomplete: 'new-password',
        placeholder: 'passphrase, at least 10 characters', 'aria-label': 'Passphrase' })),
    ],
  });
  if (!go) return;
  try {
    await keys.stashArtifactPrivate(pem, keyId, input.value);
    S.stashedKeyId = keyId;
    toast('Stored', 'Encrypted and kept in this browser.', 'good');
    paintSeal();
  } catch (e) { toast('Not stored', describeError(e), 'error'); }
}

async function unlockStashed() {
  let input;
  const go = await confirmDialog({
    title: 'Unlock the stored key',
    confirmLabel: 'Unlock',
    body: [
      el('p', {}, `An artifact private key (${S.stashedKeyId}) is stored encrypted in this browser.`),
      (input = el('input', { class: 'field', type: 'password', autocomplete: 'current-password',
        placeholder: 'passphrase', 'aria-label': 'Passphrase' })),
    ],
  });
  if (!go) return;
  try {
    await keys.recallArtifactPrivate(input.value, S.keyState?.artifactKeyId);
    toast('Unlocked', 'The artifact private key is loaded for this tab.', 'good');
    paintSeal(); gatePour();
  } catch (e) { toast('Not unlocked', describeError(e), 'error'); }
}

async function loadArtifactKey() {
  let area;
  const go = await confirmDialog({
    title: 'Load your artifact private key',
    confirmLabel: 'Load',
    body: [
      el('p', {}, 'Paste the PEM block, or choose the file you downloaded. It is held in memory for this tab only and is never sent anywhere.'),
      (area = el('textarea', { class: 'field', style: 'height:130px;font-size:11px',
        placeholder: '-----BEGIN PRIVATE KEY-----', 'aria-label': 'Private key PEM' })),
      el('div', { style: 'margin-top:10px' },
        el('input', { type: 'file', accept: '.pem,.txt', class: 'muted',
          onchange: async (e) => { const f = e.target.files[0]; if (f) area.value = await f.text(); } })),
    ],
  });
  if (!go) return;
  try {
    const k = await keys.loadArtifactPrivate(area.value, S.keyState?.artifactKeyId);
    toast('Key loaded', `Artifact private key ${k.keyId} is available in this tab.`, 'good');
    paintSeal(); gatePour();
    if (S.watcher) S.watcher.state.logLocked = false;
  } catch (e) { toast('Key not loaded', describeError(e), 'error'); }
}

// =============================================================== retrieve ====

async function retrieveIngot(pour, st) {
  const btn = $('#retrieve-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Retrieving'; }
  try {
    const raw = await retrieve.fetchIngot(st.download.url);
    if (btn) btn.textContent = st.download.sealed ? 'Decrypting' : 'Verifying';
    const opened = await retrieve.openIngot(raw, st.download.name);
    retrieve.save(opened.bytes, opened.name);

    S.watcher.state.retrieved = { at: Date.now(), ...opened, bytes: undefined,
      size: opened.bytes.length, sha256: opened.sha256 };
    toast('Ingot returned', retrieve.describe(opened), 'good', 9000);
    paintFurnace(pour, S.watcher);

    if (pour.policy === 'onReturn') await cleanupAfterReturn(pour);
  } catch (e) {
    // Retrieval failed, so nothing is cleaned up and the pour stays put.
    toast(e instanceof retrieve.RetrievalBlocked ? 'Could not fetch it here' : 'Could not open it',
      describeError(e), 'error', 12000);
    if (btn) { btn.disabled = false; btn.textContent = 'Retrieve ingot'; }
  }
}

async function cleanupAfterReturn(pour) {
  const go = await confirmDialog({
    title: 'Clean up this pour now?',
    confirmLabel: 'Clean up',
    body: [
      el('p', {}, `You asked for pour ${pour.id} to be removed once the ingot was back with you. It is: downloaded, ${S.watcher.state.retrieved?.sealed ? 'decrypted, ' : ''}integrity-checked, and saved.`),
      scopeBlock({ removes: cleanup.REMOVES, keeps: cleanup.KEEPS, retained: cleanup.GITHUB_RETAINS }),
    ],
  });
  if (!go) return;
  await runCleanup([pour.id]);
}

// ================================================================ cleanup ====

async function runCleanup(ids) {
  const t = toast('Cleaning up', `${ids.length} pour${ids.length > 1 ? 's' : ''}…`, 'info', 60000);
  try {
    const { removed, refused } = await cleanup.removePours(S.login, ids, (msg) => {
      t.lastChild.textContent = msg;
    });
    t.remove();
    if (removed.length) {
      toast('Cleaned up', `${removed.length} pour${removed.length > 1 ? 's' : ''} removed. GitHub keeps the run record and any unexpired artifact.`, 'good', 9000);
    }
    for (const r of refused) toast('Kept', `${r.id}: ${r.reason}`, 'info', 9000);
    ledger.refresh(S.login);
    if (S.watcher && removed.includes(S.watcher.state.id)) closeFurnace();
  } catch (e) {
    t.remove();
    toast('Cleanup stopped', describeError(e), 'error', 12000);
  }
}

async function cleanupOne(pour) {
  const info = await cleanup.classify(S.login, pour.id);
  if (info.state !== 'spent') {
    await confirmDialog({
      title: 'Not while it is running',
      confirmLabel: 'Understood', cancelLabel: 'Close',
      body: [el('p', {}, `Pour ${pour.id} cannot be cleaned up: ${info.reason}. Thermite never deletes a pour whose run has not completed, and never treats "could not check" as "finished".`)],
    });
    return;
  }
  const failed = info.conclusion && info.conclusion !== 'success';
  const go = await confirmDialog({
    title: 'Clean up pour',
    kind: failed ? 'danger' : 'normal',
    confirmLabel: failed ? 'Delete this failed pour' : 'Clean up',
    body: [
      el('p', {}, el('span', { class: 'mono', text: pour.id }), ` — ${info.reason}.`),
      failed ? el('p', {}, el('b', { text: 'This build failed. ' }),
        'Cleaning it up removes its source, its log and its release, which may make debugging impossible. Its compiler output is usually the only thing worth keeping.') : null,
      scopeBlock({ removes: cleanup.REMOVES, keeps: cleanup.KEEPS, retained: cleanup.GITHUB_RETAINS }),
    ].filter(Boolean),
  });
  if (go) await runCleanup([pour.id]);
}

$('#ledger-cleanall').addEventListener('click', async () => {
  if (!S.login) return;
  const t = toast('Surveying', 'Checking every pour against the Actions API…', 'info', 60000);
  let survey;
  try { survey = await cleanup.survey(S.login, { onProgress: (i, n) => { t.lastChild.textContent = `${i} of ${n}`; } }); }
  catch (e) { t.remove(); toast('Could not survey the crucible', describeError(e), 'error'); return; }
  t.remove();

  if (!survey.pours.length) {
    await confirmDialog({ title: 'Nothing to clean up', confirmLabel: 'Close', cancelLabel: 'Close',
      body: [el('p', {}, 'Your crucible holds no pours.')] });
    return;
  }

  const failed = survey.eligible.filter((p) => p.conclusion && p.conclusion !== 'success');
  const succeeded = survey.eligible.filter((p) => p.conclusion === 'success');

  const go = await confirmDialog({
    title: 'Clean up all',
    confirmLabel: survey.eligible.length
      ? `Clean up ${survey.eligible.length} eligible pour${survey.eligible.length > 1 ? 's' : ''}`
      : 'Nothing eligible',
    disabled: !survey.eligible.length,
    body: [
      tally([
        [succeeded.length, 'completed pours', 'will be removed'],
        [failed.length, 'failed pours', 'will be removed — their logs go too', failed.length ? 'unknown' : 'plain'],
        [survey.active.length, 'active pours', 'still building — untouched', 'active'],
        [survey.unknown.length, 'unverifiable pours', 'state could not be confirmed — untouched', 'unknown'],
      ]),
      survey.active.length ? el('p', {}, ...survey.active.map((p) =>
        el('div', { class: 'mono muted', text: `${p.id} — ${p.reason}` }))) : null,
      survey.unknown.length ? el('p', {}, ...survey.unknown.map((p) =>
        el('div', { class: 'mono muted', text: `${p.id} — ${p.reason}` }))) : null,
      scopeBlock({ removes: cleanup.REMOVES, keeps: cleanup.KEEPS, retained: cleanup.GITHUB_RETAINS }),
    ].filter(Boolean),
  });
  if (go && survey.eligible.length) await runCleanup(survey.eligible.map((p) => p.id));
});

// -------------------------------------------------------- decommission -----

$('#ledger-decommission').addEventListener('click', async () => {
  if (!S.login) return;
  const full = `${S.login}/${APP.repoName}`;
  let input;
  const go = await confirmDialog({
    title: 'Decommission crucible',
    kind: 'danger',
    confirmLabel: 'Decommission',
    disabled: true,
    body: [
      el('p', {}, 'This is the uninstall. It deletes the repository ', el('span', { class: 'mono', text: full }),
        ' from your GitHub account entirely.'),
      scopeBlock({
        removes: [
          'Every pour, past and present',
          'Every build log, plaintext or sealed',
          'Every release and release tag',
          'The Thermite workflows and scripts',
          'Your registered encryption public keys',
          'The repository itself, and all of its Git history',
        ],
        keeps: [
          'Your GitHub account and every other repository',
          'Your forge key (revoke it separately if you want to)',
          'Your artifact private key, wherever you put it',
          'Anything you have already downloaded',
        ],
        retained: [
          'Actions run records disappear with the repository, but anything already downloaded by others does not',
          'Git objects may persist in GitHub\u2019s caches for a period after deletion',
        ],
      }),
      el('p', {}, el('b', { text: 'This cannot be undone. ' }),
        'Thermite will offer to build a fresh crucible next time you pour.'),
      el('p', { class: 'muted', text: `Type ${full} to confirm.` }),
      (input = el('input', {
        class: 'field mono', placeholder: full, autocomplete: 'off', spellcheck: false,
        'aria-label': 'Repository name',
      })),
    ],
    onReady(setEnabled) {
      input.addEventListener('input', () => setEnabled(input.value.trim() === full));
    },
  });
  if (!go) return;

  const t = toast('Decommissioning', 'Checking that nothing is still building…', 'info', 60000);
  try {
    await cleanup.decommission(S.login, input.value.trim());
    t.remove();
    forgetPours(S.login);
    S.crucible = null; S.crucibleState = null; S.keyState = null; S.sealOn = false;
    keys.unloadArtifactPrivate();
    toast('Decommissioned', `${full} has been deleted. Reloading.`, 'good', 4000);
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    t.remove();
    if (e instanceof cleanup.CleanupRefused) {
      const force = await confirmDialog({
        title: 'Decommission anyway?',
        kind: 'danger', confirmLabel: 'Delete the repository',
        body: [
          el('p', {}, e.message),
          el('p', {}, 'Deleting the repository while a build is running cancels that build and destroys its output.'),
        ],
      });
      if (force) {
        try {
          await cleanup.decommission(S.login, `${S.login}/${APP.repoName}`, { force: true });
          forgetPours(S.login);
          toast('Decommissioned', 'The crucible has been deleted. Reloading.', 'good', 4000);
          setTimeout(() => location.reload(), 1500);
        } catch (err) { toast('Could not delete it', describeError(err), 'error', 12000); }
      }
      return;
    }
    toast('Could not delete it', describeError(e), 'error', 12000);
  }
}); 

// ================================================================ ledger =====

ledger.onCleanup = (pour) => cleanupOne(pour);
$('#open-ledger').addEventListener('click', () => ledger.open());
$('#ledger-close').addEventListener('click', () => ledger.close());
$('#ledger-refresh').addEventListener('click', () => ledger.refresh(S.login));

// ============================================================== plumbing =====

function choice({ name, note, value, flag, disabled, onPick }) {
  return el('button', {
    class: 'choice', type: 'button', 'data-value': value,
    'aria-pressed': 'false', disabled: !!disabled,
    onclick: () => onPick(value),
  },
    el('div', { class: 'choice__name' },
      el('span', { text: name }),
      flag ? el('span', { class: 'choice__flag', 'data-kind': flag, text: flag }) : null),
    note ? el('div', { class: 'choice__note', text: note }) : null,
  );
}

function markPicked(selector, value) {
  $$(`${selector} .choice`).forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.value === value)));
}

/**
 * Re-check the choices made so far without throwing away work. Changing the
 * toolchain can invalidate a target, and changing either can invalidate the
 * submission — but an uploaded file survives all of it.
 */
function invalidateFrom() {
  if (S.target) {
    const t = TARGETS.find((x) => x.triple === S.target);
    const blocked = t ? unsupportedReason(t) : 'no longer available';
    if (blocked) {
      S.target = null;
      $('#target-next').disabled = true;
      $('#target-readout').replaceChildren();
      toast('Target reset', `${t ? t.label : 'That target'} does not work with this choice: ${blocked.toLowerCase()}.`, 'info');
    }
  }
  const ready = S.files && S.target && S.toolchain;
  $('#source-next').disabled = !S.files;
  if (ready) { descent.unlock('seal'); descent.unlock('confirm'); renderConfirm(); }
  else { descent.lock('seal'); descent.lock('confirm'); $('#confirm-sheet').replaceChildren(); }
}

$$('[data-goto]').forEach((b) => b.addEventListener('click', () => descent.goto(b.dataset.goto)));
$$('[data-scrollto]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById(a.dataset.scrollto)?.scrollIntoView({
    behavior: reducedMotion() ? 'auto' : 'smooth',
  });
}));

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#dialog-host').dataset.open === 'true') return;   // the dialog handles its own
  if (document.body.dataset.mode === 'manual' || document.body.dataset.mode === 'terms') closeManual();
  else if (ledger.isOpen) ledger.close();
  else if (document.body.dataset.mode === 'furnace') closeFurnace();
});

addEventListener('error', (e) => {
  console.error(e.error || e.message);
});
addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  if (e.reason instanceof ApiError) toast('GitHub', describeError(e.reason), 'error');
});

// ---------------------------------------------------------------- boot ------

(async function boot() {
  setMode('single');
  bindPolicy();
  renderConsent();
  $('#reaction').classList.add('reaction--lit');

  if (!warnIfInsecureContext()) {
    $('#seal-toggle').disabled = true;
    $('#seal-hint').textContent = 'Unavailable without a secure context';
  }

  const restored = await auth.restore();
  if (restored) {
    try { await afterSignIn(); } catch (e) { toast('Reconnect needed', describeError(e), 'error'); }
  }

  // Deep link: #p=<ULID> reopens a pour, from history alone.
  const m = /p=([0-9A-HJKMNP-TV-Z]{26})/.exec(location.hash);
  if (m) {
    const pour = loadPours(S.login).find((p) => p.id === m[1]);
    if (pour && (S.login || pour.login)) openPour(pour);
    else if (!S.login) toast('Sign in first', 'Connect GitHub and Thermite will reopen that pour.', 'info');
    else toast('Unknown pour', 'This browser has no record of that pour id.', 'error');
  }
})();
