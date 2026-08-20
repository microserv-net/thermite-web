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

  // Plaintext pours still work — only the sealed ones are off the table. The
  // advice has to match the situation: telling someone on a real domain to
  // "use localhost" is useless, and the actual fix in that case is one click.
  const host = location.hostname;
  const proto = location.protocol;
  const isFile = proto === 'file:';
  const isLoopback = host === 'localhost' || host === '127.0.0.1' ||
    host === '::1' || host.endsWith('.localhost');
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[?[0-9a-f:]+\]?$/i.test(host);
  const isNamedHost = !isFile && !isLoopback && !isIpLiteral && host.includes('.');

  const httpsUrl = `https://${location.host}${location.pathname}${location.search}${location.hash}`;
  const detail = [];
  let action = null;

  if (isFile) {
    detail.push(
      'You have opened index.html directly from disk, and a file:// page is never a secure ' +
      'context. Serve the folder instead — from the repository root run ',
      el('code', { text: 'python3 -m http.server 8000' }),
      ' and visit http://localhost:8000.');
  } else if (isNamedHost) {
    // The common and easily fixed case: a real domain served over plain HTTP.
    detail.push(
      `${host} is served over plain HTTP. Browsers only grant Web Crypto to https — and to ` +
      'localhost — so the fix is TLS on this domain rather than anything about how you are ' +
      'reaching it.');
    action = el('a', {
      class: 'btn btn--small', href: httpsUrl,
      style: 'margin-left:2px',
      text: 'Try https:// instead',
    });
    detail.push(
      el('div', { style: 'margin-top:8px;color:var(--scale);font-size:12.5px' },
        'On GitHub Pages with a custom domain, turn on ',
        el('b', { text: 'Settings \u2192 Pages \u2192 Enforce HTTPS' }),
        ' — GitHub issues the certificate for you, though it can take a while to appear after ' +
        'the domain is first pointed at it. Anywhere else, terminate TLS in front of the site.'));
  } else if (isIpLiteral) {
    detail.push(
      `You are on ${proto}//${host}. Browsers treat localhost as a secure context but not an ` +
      'IP address, even on the same machine. Use http://localhost with the same port, or put ' +
      'TLS in front of it if you need to reach it from another device.');
  } else if (isLoopback) {
    detail.push(
      `This is ${proto}//${host}, which a browser should treat as secure. Something is ` +
      'withholding Web Crypto anyway — a proxy rewriting the origin, or a browser flag. ' +
      'Opening the page directly on the machine serving it usually settles it.');
  } else {
    detail.push(
      `This page is not a secure context (${proto}//${host}), so the browser is withholding ` +
      'SubtleCrypto. Serve it over https, or from http://localhost.');
  }

  const bar = el('div', {
    id: 'insecure-banner', role: 'alert',
    style: [
      'position:fixed', 'inset:0 0 auto 0', 'z-index:400',
      'background:#1a0d0b', 'border-bottom:2px solid var(--fault)',
      'color:var(--steel)', 'padding:14px clamp(16px,3vw,28px)',
      'font-family:var(--body)', 'font-size:13.5px', 'line-height:1.55',
      'box-shadow:0 18px 60px rgba(0,0,0,.6)',
    ].join(';'),
  },
    el('b', {
      style: 'display:block;font-family:var(--mono);font-size:11px;letter-spacing:.16em;' +
             'text-transform:uppercase;color:var(--fault);margin-bottom:6px',
      text: 'Not a secure context — encrypted pours are disabled',
    }),
    el('div', { style: 'display:flex;gap:12px;align-items:baseline;flex-wrap:wrap' },
      el('span', { style: 'flex:1 1 32ch;min-width:0' },
        'Plain pours still work. Encrypted pours, key generation and opening a sealed ingot ' +
        'all need SubtleCrypto, which browsers expose only in a secure context. ',
        ...detail),
      action,
      el('button', {
        class: 'btn btn--ghost btn--small', type: 'button', text: 'Dismiss',
        onclick: () => { bar.remove(); document.body.style.paddingTop = ''; },
      }),
    ),
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
