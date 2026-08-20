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

import { unseal, parseHeader, CryptoError } from './crypto.js';
import { held } from './keys.js';
import { sha256Hex, bytes as fmtBytes } from './util.js';

export class RetrievalBlocked extends Error {}

/**
 * Release assets on a public repository have plain download URLs. Fetching them
 * cross-origin usually works, but GitHub's asset host is not obliged to send
 * CORS headers — so a failure here is expected, recoverable, and explained
 * rather than swallowed.
 */
export async function fetchIngot(url, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, { signal, redirect: 'follow', referrerPolicy: 'no-referrer' });
  } catch {
    throw new RetrievalBlocked(
      'Your browser could not read the ingot directly from GitHub\u2019s asset host. ' +
      'Use the download link, then drop the file back here to open and verify it.');
  }
  if (!res.ok) {
    throw new RetrievalBlocked(
      `GitHub returned ${res.status} for that asset. It may have been cleaned up already.`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * @param {Uint8Array} raw   the downloaded asset
 * @param {string} name      its filename
 * @returns {Promise<{bytes:Uint8Array, name:string, sealed:boolean, keyId:string|null, sha256:string}>}
 */
export async function openIngot(raw, name) {
  const sealed = looksSealed(raw);

  if (!sealed) {
    return {
      bytes: raw, name, sealed: false, keyId: null,
      sha256: await sha256Hex(raw),
    };
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
    sha256: await sha256Hex(bytes),
  };
}

export function looksSealed(raw) {
  return raw.length > 12 &&
    String.fromCharCode(...raw.subarray(0, 8)) === 'THRMENC1';
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
  return `${result.name} · ${fmtBytes(result.bytes.length)} · sha256 ${result.sha256.slice(0, 16)}…` +
    (result.sealed ? ` · opened with key ${result.keyId}` : '');
}
