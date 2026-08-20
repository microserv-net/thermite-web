// THERMITE — primitives.
//
// Note on Web Crypto: `crypto.subtle` is only exposed in a SECURE CONTEXT.
// `crypto.getRandomValues` is not restricted that way, which is exactly why a
// pour used to get as far as generating a ULID and then die on the first hash
// with "undefined is not an object". Everything that needs SubtleCrypto goes
// through subtle() below, so the failure is named instead of thrown raw.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** True only where SubtleCrypto is actually available. */
export const cryptoAvailable = () =>
  typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';

export class InsecureContextError extends Error {
  constructor() {
    super(
      'This page is not running in a secure context, so the browser is withholding Web Crypto. ' +
      'Thermite needs it to hash your source tree and to encrypt anything at all. ' +
      'Serve the site over https://, or from http://localhost — a file:// path or a plain ' +
      'http:// address on your network will not work, and that is the browser\u2019s rule, not ' +
      'Thermite\u2019s.');
    this.name = 'InsecureContextError';
  }
}

export function subtle() {
  if (!cryptoAvailable()) throw new InsecureContextError();
  return crypto.subtle;
}

/** ULID: 48-bit ms timestamp + 80 bits of CSPRNG, Crockford base32, sortable. */
export function ulid(now = Date.now()) {
  let time = '';
  let t = now;
  for (let i = 9; i >= 0; i--) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let tail = '';
  for (let i = 0; i < 16; i++) tail += CROCKFORD[rand[i] % 32];
  return time + tail;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Base64 for arbitrary bytes, chunked so large files do not blow the stack. */
export function toBase64(bytes) {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export const enc = new TextEncoder();
export const dec = new TextDecoder('utf-8', { fatal: false });

export async function sha256Hex(bytes) {
  const d = await subtle().digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * FNV-1a over the same canonical bytes. Not a cryptographic hash and never used
 * as one — it exists so that duplicate-submission detection keeps working in a
 * context where SubtleCrypto is withheld. Getting a dedupe check wrong costs a
 * duplicate build; there is nothing to attack here.
 */
export function quickHash(files) {
  let h = 0xcbf29ce484222325n;
  const P = 0x100000001b3n;
  const mix = (b) => { h ^= BigInt(b); h = (h * P) & 0xffffffffffffffffn; };
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    for (const c of enc.encode(f.path)) mix(c);
    mix(0);
    // Sample large files rather than walking every byte: this only needs to
    // distinguish one submission from another, not resist collisions.
    const step = Math.max(1, Math.floor(f.bytes.length / 4096));
    for (let i = 0; i < f.bytes.length; i += step) mix(f.bytes[i]);
    mix(f.bytes.length & 0xff);
    mix(0);
  }
  return 'fnv1a:' + h.toString(16).padStart(16, '0');
}

/**
 * Stable SHA-256 over a set of {path, bytes}, matching detect.mjs exactly.
 *
 * Returns null — rather than throwing — when SubtleCrypto is unavailable. The
 * tree hash is a tamper check the workflow applies only `if (manifest.treeHash)`,
 * so a plaintext pour is complete without it. Encryption is a different matter
 * and is refused outright.
 */
export async function treeHash(files) {
  if (!cryptoAvailable()) return null;
  const parts = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    parts.push(enc.encode(f.path), new Uint8Array([0]), f.bytes, new Uint8Array([0]));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return 'sha256:' + await sha256Hex(buf);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Full-jitter exponential backoff. */
export function backoff(attempt, base = 400, cap = 8000) {
  return Math.random() * Math.min(cap, base * 2 ** attempt);
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

export function duration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function ago(iso) {
  if (!iso) return '—';
  const d = Date.now() - Date.parse(iso);
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return `${Math.floor(d / 86_400_000)} d ago`;
}

/** Escape for insertion as text. Used everywhere; nothing is ever innerHTML'd raw. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k.startsWith('data-') || k === 'role' || k.startsWith('aria-')) n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * If Web Crypto is missing, say so once, at the top of the page, before the
 * person spends time picking a toolchain and uploading a project only to be
 * told at the very last step. Returns true when the environment is usable.
 */
export function warnIfInsecureContext() {
  if (cryptoAvailable()) return true;
  if (document.getElementById('insecure-banner')) return false;
  // Plaintext pours still work — only the sealed ones are off the table.

  const host = location.hostname;
  const advice = location.protocol === 'file:'
    ? 'You have opened index.html directly from disk. Serve the folder instead — from the repository root, run: python3 -m http.server 8000 — then visit http://localhost:8000.'
    : `You are on ${location.protocol}//${host}. Use http://localhost instead of the IP address, or put the site behind https. Deployed on GitHub Pages this is never an issue, because Pages is https.`;

  const bar = el('div', {
    id: 'insecure-banner', role: 'alert',
    style: [
      'position:fixed', 'inset:0 0 auto 0', 'z-index:400',
      'background:#1a0d0b', 'border-bottom:2px solid var(--fault)',
      'color:var(--steel)', 'padding:16px clamp(16px,3vw,28px)',
      'font-family:var(--body)', 'font-size:13.5px', 'line-height:1.55',
      'box-shadow:0 18px 60px rgba(0,0,0,.6)',
    ].join(';'),
  },
    el('b', {
      style: 'display:block;font-family:var(--mono);font-size:11px;letter-spacing:.16em;' +
             'text-transform:uppercase;color:var(--fault);margin-bottom:6px',
      text: 'Web Crypto unavailable — encrypted pours are disabled',
    }),
    el('span', {}, 'Plain pours still work. Encrypted pours, key generation and ' +
      'opening a sealed ingot all need SubtleCrypto, which the browser only exposes ' +
      'in a secure context. ' + advice),
  );

  document.body.prepend(bar);
  document.body.style.paddingTop = `${bar.offsetHeight}px`;
  return false;
}

/** Small async pool: keeps N requests in flight without flooding the API. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

/** ANSI SGR → spans. Enough of it for cargo and rustc output. */
const ANSI_COLORS = {
  30: 'k', 31: 'r', 32: 'g', 33: 'y', 34: 'b', 35: 'm', 36: 'c', 37: 'w',
  90: 'K', 91: 'R', 92: 'G', 93: 'Y', 94: 'B', 95: 'M', 96: 'C', 97: 'W',
};
export function ansiToHtml(line) {
  let out = '';
  let open = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    last = re.lastIndex;
    const codes = (m[1] || '0').split(';').map(Number);
    for (const c of codes) {
      if (c === 0) { out += '</span>'.repeat(open); open = 0; }
      else if (c === 1) { out += '<span class="a-bold">'; open++; }
      else if (ANSI_COLORS[c]) { out += `<span class="a-${ANSI_COLORS[c]}">`; open++; }
    }
  }
  out += esc(line.slice(last));
  out += '</span>'.repeat(open);
  return out;
}

export function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }
