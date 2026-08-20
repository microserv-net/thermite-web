// THERMITE — authentication.
//
// Two ways in, one outcome: a bearer token for api.github.com.
//
//  A. Forge key  — a fine-grained token the user creates on their own account.
//                  Works from a static page with zero infrastructure, because
//                  api.github.com sends CORS headers and github.com/login does
//                  not.
//  B. Device flow — GitHub App sign-in, relayed through a stateless function
//                  that holds only the client secret. Optional; hidden unless
//                  OAUTH.RELAY_URL is configured.
//
// The token lives in sessionStorage by default: it dies with the tab. Opting
// into "remember on this device" stores it in IndexedDB encrypted with AES-GCM
// under a key derived from a passphrase. The raw token never touches durable
// storage in either case.

import { OAUTH } from './config.js';
import { gh, ApiError, onAuthFailure } from './github.js';
import { sleep, el } from './util.js';

const SESSION_KEY = 'thermite.key';
const LOGIN_KEY = 'thermite.login';
const DB = 'thermite';
const STORE = 'vault';

export const deviceFlowAvailable = () => !!(OAUTH.RELAY_URL && OAUTH.CLIENT_ID);

// ------------------------------------------------- credential expiry -------
// A fine-grained token expires on a date the user chose, and can be revoked at
// any moment. When that happens mid-session every call starts returning 401.
// Announcing it once, plainly, beats a stream of identical failures — and the
// in-flight state is dropped so nothing keeps polling with a dead key.

onAuthFailure(() => {
  if (!session.token) return;
  const who = session.user?.login;
  gh.setToken(null);
  session.user = null; session.token = null; session.mode = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  watchers.forEach((f) => { try { f(session); } catch {} });

  if (document.getElementById('auth-lapsed')) return;
  document.body.prepend(el('div', {
    id: 'auth-lapsed', role: 'alert',
    style: [
      'position:fixed', 'inset:0 0 auto 0', 'z-index:400',
      'background:#1a0d0b', 'border-bottom:2px solid var(--fault)',
      'color:var(--steel)', 'padding:14px clamp(16px,3vw,28px)',
      'font-family:var(--body)', 'font-size:13.5px',
      'display:flex', 'gap:14px', 'align-items:center', 'flex-wrap:wrap',
    ].join(';'),
  },
    el('b', {
      style: 'font-family:var(--mono);font-size:11px;letter-spacing:.16em;' +
             'text-transform:uppercase;color:var(--fault)',
      text: 'Forge key no longer valid',
    }),
    el('span', {
      text: `GitHub rejected the key${who ? ` for ${who}` : ''} — it has expired or been revoked. ` +
            'Builds already running on GitHub are unaffected and will finish; sign in again to watch them.',
    }),
    el('button', {
      class: 'btn btn--ghost btn--small', type: 'button', text: 'Sign in again',
      onclick: () => location.reload(),
    }),
  ));
});

// --------------------------------------------------------------- vault ------

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbPut(key, value) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const q = tx.objectStore(STORE).get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

async function idbClear() {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => res();
  });
}

async function derive(passphrase, salt) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function remember(token, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(token));
  await idbPut('key', { salt, iv, ct, at: Date.now() });
}

export async function hasRemembered() { return !!(await idbGet('key').catch(() => null)); }

export async function recall(passphrase) {
  const rec = await idbGet('key');
  if (!rec) throw new Error('Nothing is stored on this device.');
  const key = await derive(passphrase, rec.salt);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct);
  } catch {
    throw new Error('That passphrase does not unlock the stored key.');
  }
  return new TextDecoder().decode(plain);
}

export async function forget() {
  sessionStorage.removeItem(SESSION_KEY);
  await idbClear().catch(() => {});
}

// -------------------------------------------------------------- session -----

export const session = {
  user: null,
  token: null,
  mode: null,          // 'key' | 'device'
  scopedRepoOnly: false,
};

const watchers = new Set();
export const onSession = (fn) => { watchers.add(fn); fn(session); return () => watchers.delete(fn); };
const announce = () => watchers.forEach((f) => f(session));

/** Adopt a token: validate it, learn who it belongs to, and hold it. */
export async function adopt(token, mode = 'key') {
  const clean = String(token || '').trim();
  if (!clean) throw new Error('Paste a token first.');
  if (!/^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(clean)) {
    throw new Error(
      'That does not look like a GitHub token. Fine-grained tokens start with ' +
      '"github_pat_"; classic ones start with "ghp_".');
  }

  gh.setToken(clean);
  let user;
  try {
    user = await gh.me();
  } catch (e) {
    gh.setToken(null);
    if (e instanceof ApiError && e.status === 401) {
      throw new Error('GitHub rejected this token. It may be expired or revoked.');
    }
    throw e;
  }

  // Switching accounts without signing out first would leave the previous
  // account's crucible, key state and cached repository in memory. The token is
  // stored first, so the reload comes back signed in as the new account with
  // nothing of the old one carried over.
  let previous = null;
  try { previous = sessionStorage.getItem(LOGIN_KEY); } catch {}

  session.user = user;
  session.token = clean;
  session.mode = mode;
  try {
    sessionStorage.setItem(SESSION_KEY, clean);
    sessionStorage.setItem(LOGIN_KEY, user.login);
  } catch { /* private mode */ }

  if (previous && previous !== user.login) {
    location.reload();
    return user;
  }

  announce();
  return user;
}

export async function restore() {
  const t = sessionStorage.getItem(SESSION_KEY);
  if (!t) return null;
  try { return await adopt(t, 'key'); }
  catch { sessionStorage.removeItem(SESSION_KEY); return null; }
}

export async function signOut() {
  gh.setToken(null);
  session.user = null; session.token = null; session.mode = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(LOGIN_KEY);
  } catch {}
  // The pour cache is keyed by account and deliberately left alone: signing out
  // is not the same as forgetting what you built. Decommissioning clears it.
  announce();
}

/**
 * Probe what the key can actually do, so the UI can name the missing
 * permission instead of failing later with a bare 403.
 */
export async function capabilities(login) {
  const caps = { repoExists: false, canCreateRepo: null, canReadActions: null, repo: null };
  try {
    caps.repo = await gh.repo(login, 'thermite-crucible');
    caps.repoExists = true;
  } catch (e) { if (e.status !== 404) throw e; }

  if (caps.repoExists) {
    caps.canCreateRepo = true;
    try {
      await gh.get(`/repos/${login}/thermite-crucible/actions/runs?per_page=1`);
      caps.canReadActions = true;
    } catch { caps.canReadActions = false; }
  }
  return caps;
}

// ---------------------------------------------------------- device flow -----

export async function deviceStart() {
  if (!deviceFlowAvailable()) throw new Error('Device sign-in is not configured for this deployment.');
  const res = await fetch(`${OAUTH.RELAY_URL.replace(/\/$/, '')}/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: OAUTH.CLIENT_ID, scope: '' }),
  });
  if (!res.ok) throw new Error(`The sign-in relay returned ${res.status}.`);
  return res.json();
}

export async function devicePoll(deviceCode, intervalSeconds, { signal } = {}) {
  let interval = Math.max(5, intervalSeconds || 5);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Sign-in cancelled.');
    await sleep(interval * 1000);
    const res = await fetch(`${OAUTH.RELAY_URL.replace(/\/$/, '')}/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: OAUTH.CLIENT_ID, device_code: deviceCode }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.access_token) return adopt(data.access_token, 'device');
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval += 5; continue; }
    if (data.error === 'expired_token') throw new Error('The code expired. Start again.');
    if (data.error === 'access_denied') throw new Error('You declined the authorization.');
    if (data.error) throw new Error(data.error_description || data.error);
  }
  throw new Error('Sign-in timed out.');
}

/** Deep link that pre-fills GitHub's token screen with what Thermite needs. */
export function forgeKeyUrl() {
  return 'https://github.com/settings/personal-access-tokens/new';
}
