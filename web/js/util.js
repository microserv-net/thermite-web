// THERMITE — primitives.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

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
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable hash over a set of {path, bytes}, matching detect.mjs exactly. */
export async function treeHash(files) {
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
