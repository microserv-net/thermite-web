// THERMITE — keys.
//
// Two keypairs, deliberately never the same one:
//
//   SOURCE keypair
//     public   → committed to the crucible at .thermite/keys/source-public.pem
//     private  → pasted by the user into the repository secret
//                THERMITE_SOURCE_KEY, so the runner can decrypt to compile.
//                Thermite writes it nowhere and never reads it back.
//
//   ARTIFACT keypair
//     public   → committed to the crucible at .thermite/keys/artifact-public.pem
//     private  → stays with the user. Shown and downloadable exactly once.
//                Thermite has no copy and no recovery path.
//
// Mixing them would mean the key GitHub needs to compile is also the key that
// opens the finished binary. They stay separate.

import { APP } from './config.js';
import { gh } from './github.js';
import { toBase64, enc, pool } from './util.js';
import { generateKeypair, importPublicPem, importPrivatePem, CryptoError } from './crypto.js';

const NAME = APP.repoName;
export const SECRET_NAME = 'THERMITE_SOURCE_KEY';
export const SOURCE_PUB = '.thermite/keys/source-public.pem';
export const ARTIFACT_PUB = '.thermite/keys/artifact-public.pem';

const DB = 'thermite';
const STORE = 'ingotkeys';

// The artifact private key, if the user has loaded one this session. Memory
// only unless they explicitly opt into the encrypted vault below.
export const held = {
  artifact: null,       // {key: CryptoKey, keyId: string}
  fromVault: false,
};

// ------------------------------------------------------------- discovery ----

export async function readKeys(login) {
  const state = {
    sourcePem: null, sourceKeyId: null,
    artifactPem: null, artifactKeyId: null,
    secret: 'unknown',        // 'present' | 'absent' | 'unknown'
    secretUpdatedAt: null,
  };

  const [src, art] = await Promise.all([
    gh.rawFile(login, NAME, SOURCE_PUB, 'main').catch(() => null),
    gh.rawFile(login, NAME, ARTIFACT_PUB, 'main').catch(() => null),
  ]);

  if (src?.text) {
    state.sourcePem = src.text;
    try { state.sourceKeyId = (await importPublicPem(src.text)).keyId; }
    catch { state.sourcePem = null; }
  }
  if (art?.text) {
    state.artifactPem = art.text;
    try { state.artifactKeyId = (await importPublicPem(art.text)).keyId; }
    catch { state.artifactPem = null; }
  }

  // Existence only. GitHub's API never returns a secret's value to anyone, and
  // Thermite would not ask for it if it did.
  try {
    const meta = await gh.get(`/repos/${login}/${NAME}/actions/secrets/${SECRET_NAME}`);
    state.secret = 'present';
    state.secretUpdatedAt = meta.updated_at || meta.created_at || null;
  } catch (e) {
    if (e.status === 404) state.secret = 'absent';
    else state.secret = 'unknown';        // usually: the key lacks Secrets: read
  }

  return state;
}

/**
 * Encryption is ready only when everything it depends on is verifiably in
 * place. A partial setup is reported as NOT READY — never silently downgraded
 * to a plaintext pour.
 */
export function readiness(state, want) {
  const problems = [];
  const notes = [];

  if (want.source) {
    if (!state.sourcePem) problems.push('The source public key is not in your crucible.');
    if (state.secret === 'absent') {
      problems.push(`The repository secret ${SECRET_NAME} is not set. Without it the runner cannot decrypt your source and the build will fail.`);
    }
    if (state.secret === 'unknown') {
      notes.push(`Thermite cannot verify ${SECRET_NAME} — your forge key has no "Secrets: read" permission. Add it to get a green check here, or continue if you know the secret is set.`);
    }
  }

  if (want.artifact) {
    if (!state.artifactPem) problems.push('The artifact public key is not in your crucible.');
    if (!held.artifact) {
      notes.push('Your artifact private key is not loaded in this tab. You can pour without it, but you will need it to open the ingot and to read the sealed log.');
    } else if (state.artifactKeyId && held.artifact.keyId !== state.artifactKeyId) {
      problems.push(`The private key you loaded (${held.artifact.keyId}) does not match the public key registered in your crucible (${state.artifactKeyId}).`);
    }
  }

  return { ok: problems.length === 0, problems, notes };
}

// -------------------------------------------------------------- creation ----

export async function mintSourceKeypair() {
  const kp = await generateKeypair();
  return kp;   // caller registers the public half and shows the private half once
}

export async function mintArtifactKeypair() {
  const kp = await generateKeypair();
  held.artifact = { key: kp.privateKey, keyId: kp.keyId };
  held.fromVault = false;
  return kp;
}

/** Commit a public key. Touches no jobs/ path, so it cannot start a build. */
export async function registerPublicKey(login, path, pem, label) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = await gh.get(`/repos/${login}/${NAME}/git/ref/heads/main`);
    const parent = ref.object.sha;
    const base = (await gh.get(`/repos/${login}/${NAME}/git/commits/${parent}`)).tree.sha;

    const tree = await gh.post(`/repos/${login}/${NAME}/git/trees`, {
      base_tree: base,
      tree: [{ path, mode: '100644', type: 'blob', content: pem }],
    });
    const commit = await gh.post(`/repos/${login}/${NAME}/git/commits`, {
      message: `thermite: register ${label} public key [skip ci]`,
      tree: tree.sha, parents: [parent],
    });
    try {
      await gh.patch(`/repos/${login}/${NAME}/git/refs/heads/main`, { sha: commit.sha, force: false });
      return commit.sha;
    } catch (e) {
      if (e.status === 422 || e.status === 409) continue;
      throw e;
    }
  }
  throw new Error('Could not register the key — the crucible kept moving underneath. Try again.');
}

export async function revokePublicKey(login, path, label) {
  const head = await gh.get(`/repos/${login}/${NAME}/contents/${path}?ref=main`).catch(() => null);
  if (!head) return;
  await gh.call(`/repos/${login}/${NAME}/contents/${path}`, {
    method: 'DELETE',
    body: { message: `thermite: retire ${label} public key [skip ci]`, sha: head.sha, branch: 'main' },
  });
}

// ------------------------------------------------------- loading a key ------

export async function loadArtifactPrivate(pem, expectedKeyId) {
  const imported = await importPrivatePem(pem);
  if (expectedKeyId && imported.keyId !== expectedKeyId) {
    throw new CryptoError(
      `That key is ${imported.keyId}. Your crucible expects ${expectedKeyId}. ` +
      'This is the wrong key for the pours sealed with the registered public key.');
  }
  held.artifact = imported;
  held.fromVault = false;
  return imported;
}

export function unloadArtifactPrivate() {
  held.artifact = null;
  held.fromVault = false;
}

// -------------------------------------------- optional encrypted vault ------
// Explicitly opt-in, passphrase-derived, and separate from the token vault.
// The PEM never touches storage in the clear.

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('vault')) db.createObjectStore('vault');
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}

async function derive(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function stashArtifactPrivate(pem, keyId, passphrase) {
  if (!passphrase || passphrase.length < 10) {
    throw new Error('Use a passphrase of at least 10 characters. This is the only thing protecting the key on this device.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(pem));
  await tx('readwrite', (s) => s.put({ salt, iv, ct, keyId, at: Date.now() }, 'artifact'));
}

export async function stashedArtifactKeyId() {
  const rec = await tx('readonly', (s) => s.get('artifact')).catch(() => null);
  return rec?.keyId || null;
}

export async function recallArtifactPrivate(passphrase, expectedKeyId) {
  const rec = await tx('readonly', (s) => s.get('artifact'));
  if (!rec) throw new Error('No artifact key is stored on this device.');
  const key = await derive(passphrase, rec.salt);
  let pem;
  try {
    pem = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct));
  } catch {
    throw new Error('That passphrase does not unlock the stored key.');
  }
  const loaded = await loadArtifactPrivate(pem, expectedKeyId);
  held.fromVault = true;
  return loaded;
}

export async function dropStashedArtifactPrivate() {
  await tx('readwrite', (s) => s.delete('artifact')).catch(() => {});
}

export function secretsUrl(login) {
  return `https://github.com/${login}/${NAME}/settings/secrets/actions/new`;
}
