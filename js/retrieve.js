// THERMITE — retrieving the ingot.
//
// "Returned" is a claim with consequences: a pour set to clean up after return
// is deleted on the strength of it. So it means all of this, in order:
//
//   1. the bytes are in this browser
//   2. if sealed, the container decrypted with the user's private key
//   3. the GCM tag verified, so the bytes are the bytes the runner produced
//   4. the file was handed to the user's download
//
// If any step fails, nothing is cleaned up and the user can try again.
//
// Getting the bytes here is the awkward part, because GitHub's asset hosts are
// not obliged to send CORS headers to a static page. There are three routes and
// they are tried in order of how little they ask of the user.

import { unseal, parseHeader, CryptoError } from './crypto.js';
import { held } from './keys.js';
import { session } from './auth.js';
import { sha256Hex, bytes as fmtBytes, el } from './util.js';
import { confirmDialog } from './ui/dialog.js';

export class RetrievalBlocked extends Error {}

const API = 'https://api.github.com';

/** `https://github.com/{owner}/{repo}/releases/download/{tag}/{name}` */
function parseAssetUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/
    .exec(String(url || ''));
  if (!m) return null;
  return { owner: m[1], repo: m[2], tag: m[3], name: decodeURIComponent(m[4]) };
}

// ---------------------------------------------------------------- routes ----

/** 1. Straight at the public URL. Free when it works, and it sometimes does. */
async function viaPublicUrl(url, signal) {
  const res = await fetch(url, { signal, redirect: 'follow', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * 2. Through the API with the forge key.
 *
 * `api.github.com` always sends CORS headers, which `github.com` does not — so
 * this route works in browsers where the public URL is refused. It costs one
 * extra call to resolve the asset id, which is not in the download URL.
 */
async function viaApi(meta, signal) {
  if (!session.token) throw new Error('not signed in');

  const headers = {
    Authorization: `Bearer ${session.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const relRes = await fetch(
    `${API}/repos/${meta.owner}/${meta.repo}/releases/tags/${encodeURIComponent(meta.tag)}`,
    { signal, headers: { ...headers, Accept: 'application/vnd.github+json' } });
  if (!relRes.ok) throw new Error(`release lookup returned ${relRes.status}`);

  const release = await relRes.json();
  const asset = (release.assets || []).find((a) => a.name === meta.name);
  if (!asset) throw new Error('the asset is no longer on that release');

  const res = await fetch(`${API}/repos/${meta.owner}/${meta.repo}/releases/assets/${asset.id}`, {
    signal, headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'follow',
  });
  if (!res.ok) throw new Error(`asset fetch returned ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * 3. Ask for the file.
 *
 * The last two routes both depend on a CORS header Thermite does not control.
 * When neither works, the download link always does — so this opens somewhere
 * to actually put the downloaded file, which is what the old error message
 * promised and never provided.
 */
async function viaFilePicker(meta, why) {
  let picked = null;
  let setEnabled = () => {};

  const status = el('p', { class: 'muted', style: 'margin:0' },
    'Nothing has been chosen yet.');

  const input = el('input', {
    type: 'file', class: 'muted',
    onchange: (e) => take(e.target.files?.[0]),
  });

  const zone = el('div', {
    class: 'drop', style: 'margin-top:14px;padding:26px 20px',
    tabindex: '0', role: 'button',
    onclick: () => input.click(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
    ondragover: (e) => { e.preventDefault(); zone.dataset.over = 'true'; },
    ondragleave: () => { zone.dataset.over = 'false'; },
    ondrop: (e) => {
      e.preventDefault();
      zone.dataset.over = 'false';
      take(e.dataTransfer?.files?.[0]);
    },
  },
    el('div', { class: 'drop__big', text: 'Drop the downloaded file here' }),
    el('div', { class: 'drop__hint', text: meta?.name ? `expecting ${meta.name}` : 'or click to browse' }),
  );

  function take(file) {
    if (!file) return;
    picked = file;
    status.replaceChildren(el('span', { class: 'mono', text: `${file.name} · ${fmtBytes(file.size)}` }));
    if (meta?.name && file.name !== meta.name) {
      status.append(el('div', {
        class: 'readout__warn', style: 'margin-top:6px;font-size:12.5px',
        text: `That is not named ${meta.name}. Thermite will still try to open it — if it is the wrong file, verification will fail rather than produce something wrong.`,
      }));
    }
    setEnabled(true);
  }

  const ok = await confirmDialog({
    title: 'Open the ingot from a file',
    confirmLabel: 'Open and verify',
    disabled: true,
    onReady: (fn) => { setEnabled = fn; },
    body: [
      el('p', {}, 'Your browser would not read the ingot straight from GitHub\u2019s asset host — ',
        el('span', { class: 'mono', text: why }),
        '. That host is not obliged to send the CORS header a page like this needs, and Thermite cannot add one.'),
      el('p', {}, 'The download link always works, though. Save the file, then hand it back here: ' +
        'it is opened, decrypted if sealed, and integrity-checked entirely on your machine — nothing is uploaded.'),
      meta ? el('p', {},
        el('a', {
          class: 'btn btn--ghost btn--small',
          href: `https://github.com/${meta.owner}/${meta.repo}/releases/tag/${meta.tag}`,
          target: '_blank', rel: 'noopener noreferrer',
          text: 'Open the release',
        })) : null,
      zone,
      el('div', { style: 'margin-top:12px' }, input),
      el('div', { style: 'margin-top:10px' }, status),
    ].filter(Boolean),
  });

  if (!ok || !picked) throw new RetrievalBlocked('Retrieval cancelled. Nothing has been cleaned up.');
  return new Uint8Array(await picked.arrayBuffer());
}

// ---------------------------------------------------------------- public ----

/**
 * Get the ingot's bytes into this browser, by whichever route works.
 * @param {string} url  the release asset's browser_download_url
 */
export async function fetchIngot(url, { signal } = {}) {
  const meta = parseAssetUrl(url);
  const tried = [];

  try {
    return await viaPublicUrl(url, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    tried.push(`direct: ${e.message || 'blocked'}`);
  }

  if (meta) {
    try {
      return await viaApi(meta, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      tried.push(`api: ${e.message || 'blocked'}`);
    }
  }

  // Both automatic routes depend on a header Thermite does not control, so the
  // fallback is a real one rather than a suggestion.
  return viaFilePicker(meta, tried.join('; '));
}

/**
 * @param {Uint8Array} raw   the downloaded asset
 * @param {string} name      its filename
 */
export async function openIngot(raw, name) {
  const sealed = looksSealed(raw);

  if (!sealed) {
    return { bytes: raw, name, sealed: false, keyId: null, sha256: await safeSha(raw) };
  }

  const { header } = parseHeader(raw);
  if (header.purpose !== 'artifact') {
    throw new CryptoError(
      `This is a "${header.purpose}" container, not an ingot. Sealed logs and sealed charges open elsewhere.`);
  }
  if (!held.artifact) {
    throw new CryptoError(
      `This ingot is sealed for key ${header.kem.keyId}. Load that artifact private key first — ` +
      'Thermite does not have a copy of it.');
  }

  const { bytes } = await unseal(raw, held.artifact);
  return {
    bytes,
    name: name.replace(/\.tenc$/, '') || `thermite-${header.jobId}`,
    sealed: true,
    keyId: header.kem.keyId,
    sha256: await safeSha(bytes),
  };
}

/** A checksum is nice to show; its absence is not a reason to fail retrieval. */
async function safeSha(b) {
  try { return await sha256Hex(b); } catch { return null; }
}

export function looksSealed(raw) {
  return raw.length > 12 && String.fromCharCode(...raw.subarray(0, 8)) === 'THRMENC1';
}

/** Hand the plaintext to the user's downloads. Nothing is uploaded anywhere. */
export function save(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function describe(result) {
  return `${result.name} · ${fmtBytes(result.bytes.length)}` +
    (result.sha256 ? ` · sha256 ${result.sha256.slice(0, 16)}…` : '') +
    (result.sealed ? ` · opened with key ${result.keyId}` : '');
}
