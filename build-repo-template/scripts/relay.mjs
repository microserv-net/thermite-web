#!/usr/bin/env node
// THERMITE — relay.mjs
//
// GitHub's Actions log endpoint redirects to a blob host with no CORS headers,
// so a browser can never read a running job's logs. This process solves that by
// pushing the log into the repository itself, where the Contents API — which is
// CORS-clean — can serve it to the page every couple of seconds.
//
// Runs detached, beside the compiler, holding the only copy of the token.
// The compiler itself is started with an empty GITHUB_TOKEN.
//
//   node scripts/relay.mjs --job <ULID> --log pour.log --done pour.done

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { seal } from './tenc.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);

const JOB = args.job;
const LOG = args.log || 'pour.log';
const DONE = args.done || 'pour.done';
const BRANCH = 'crucible-logs';
const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
// The runner half of the latency budget.
//
// A fixed 2.5s flush meant the browser could never see a line sooner than 2.5s
// after the compiler wrote it, however fast the page polled. So the file is
// checked often and written adaptively: close behind the output while it is
// flowing, backing off when it is not, and immediately when a marker appears —
// those are the moments someone is actually waiting for.
//
// Every write is a commit on the log branch, so the floor is a real cost and
// there is a ceiling on how many can happen per minute.
const TICK = 350;
const MIN_HOT = 900;
const MIN_COOL = 4500;
const MAX_PER_MINUTE = 48;
const MAX_BYTES = 640 * 1024; // keep the tail; the release carries the full log

// On a sealed pour the log is encrypted with the ARTIFACT public key before it
// is published, because compiler diagnostics quote source and this branch is
// public. The state file stays plaintext: it carries only metadata.
const ARTIFACT_KEY_PATH = '.thermite/keys/artifact-public.pem';
const artifactKey = existsSync(ARTIFACT_KEY_PATH) && process.env.THERMITE_SEALED === '1'
  ? readFileSync(ARTIFACT_KEY_PATH, 'utf8')
  : null;

if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(JOB || '')) { console.error('relay: bad job id'); process.exit(1); }
if (!TOKEN || !REPO) { console.error('relay: missing environment'); process.exit(1); }

const shas = new Map();

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'thermite-relay',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  return res;
}

async function put(path, content, message) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!shas.has(path)) {
      const probe = await api(`/repos/${REPO}/contents/${path}?ref=${BRANCH}`);
      if (probe.ok) shas.set(path, (await probe.json()).sha);
    }
    const body = {
      message,
      branch: BRANCH,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(shas.has(path) ? { sha: shas.get(path) } : {}),
    };
    const res = await api(`/repos/${REPO}/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
    if (res.ok) { shas.set(path, (await res.json()).content.sha); return true; }
    // 409/422: another pour moved the branch under us, or our sha is stale.
    if (res.status === 409 || res.status === 422 || res.status === 404) {
      shas.delete(path);
      await sleep(200 + Math.random() * 600 * (attempt + 1));
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 5);
      await sleep(wait * 1000);
      continue;
    }
    console.error(`relay: ${res.status} writing ${path}`);
    return false;
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Phase is inferred only from evidence in the real output. Nothing is guessed
// and nothing advances on a timer.
function phaseOf(text) {
  if (/^##thermite:packaged/m.test(text)) return 'CAST';
  if (/^\s*Finished\b/m.test(text) || /^##thermite:linking/m.test(text)) return 'LINK';
  if (/^\s*Compiling\b/m.test(text) || /^##thermite:compiling/m.test(text)) return 'COMPILE';
  if (/^##thermite:toolchain-ready/m.test(text)) return 'IGNITE';
  return 'INGEST';
}

function tail(path) {
  const size = statSync(path).size;
  const start = Math.max(0, size - MAX_BYTES);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return { size, text: start > 0 ? `… ${start} earlier bytes withheld; full log ships with the ingot …\n${text}` : text };
  } finally { closeSync(fd); }
}

let lastSize = -1;
let lastPhase = '';
let lastFlush = 0;
let quietSince = Date.now();
const flushes = [];
const startedAt = new Date().toISOString();
let lines = 0;

/** Ramp from hot to cool the longer the compiler has had nothing to say. */
function minGap() {
  const quiet = Date.now() - quietSince;
  if (quiet < 5_000) return MIN_HOT;
  if (quiet > 30_000) return MIN_COOL;
  return MIN_HOT + ((MIN_COOL - MIN_HOT) * (quiet - 5_000)) / 25_000;
}

function underQuota() {
  const cutoff = Date.now() - 60_000;
  while (flushes.length && flushes[0] < cutoff) flushes.shift();
  return flushes.length < MAX_PER_MINUTE;
}

async function flush(final) {
  if (!existsSync(LOG)) return;
  const { size, text } = tail(LOG);
  const phase = final ? (existsSync(DONE) ? readFileSync(DONE, 'utf8').trim() : 'UNKNOWN') : phaseOf(text);
  if (!final && size === lastSize && phase === lastPhase) return;

  const nl = (text.match(/\n/g) || []).length;
  const rate = Math.max(0, nl - lines);
  lines = nl;

  const body = text + (final ? `\n##thermite:end:${phase}\n` : '');
  if (artifactKey) {
    // Base64 of the container, so the branch holds text and the browser can
    // fetch it with the raw media type like any other log.
    const sealed = seal(Buffer.from(body, 'utf8'), artifactKey,
      { purpose: 'log', jobId: JOB, note: 'thermite live log' });
    await put(`logs/${JOB}.log.tenc`, sealed.toString('base64') + '\n',
      `thermite: pour ${JOB} ${final ? 'final' : 'stream'} [skip ci]`);
  } else {
    await put(`logs/${JOB}.log`, body,
      `thermite: pour ${JOB} ${final ? 'final' : 'stream'} [skip ci]`);
  }

  await put(`logs/${JOB}.state.json`, JSON.stringify({
    job: JOB,
    phase: final ? phase : phase,
    live: !final,
    startedAt,
    updatedAt: new Date().toISOString(),
    bytes: size,
    lines: nl,
    lineRate: rate,
    runner: `${process.env.RUNNER_OS}/${process.env.RUNNER_ARCH}`,
    sealed: !!artifactKey,
    runId: process.env.GITHUB_RUN_ID,
    sha: process.env.GITHUB_SHA,
    rustc: process.env.THERMITE_RUSTC || null,
    cargo: process.env.THERMITE_CARGO || null,
    target: process.env.THERMITE_TARGET || null,
    toolchain: process.env.THERMITE_TOOLCHAIN || null,
  }, null, 2) + '\n', `thermite: pour ${JOB} state [skip ci]`);

  lastSize = size;
  lastPhase = phase;
}

process.on('SIGTERM', async () => { await flush(true); process.exit(0); });

(async () => {
  while (!existsSync(DONE)) {
    try {
      if (existsSync(LOG)) {
        const size = statSync(LOG).size;
        const changed = size !== lastSize;
        if (changed) quietSince = Date.now();

        // A marker is a phase change — toolchain ready, compiling, linking,
        // packaged. Those jump the queue, because the pipeline in the browser
        // moves on them and waiting out an interval is exactly the lag that
        // makes the interface feel behind the build.
        const urgent = changed && lastSize >= 0 && tail(LOG).text
          .slice(Math.max(0, lastSize - size - 4096))
          .includes('##thermite:');

        const due = Date.now() - lastFlush >= (urgent ? 0 : minGap());
        if (changed && due && underQuota()) {
          await flush(false);
          lastFlush = Date.now();
          flushes.push(lastFlush);
        }
      }
    } catch (e) { console.error('relay:', e.message); }
    await sleep(TICK);
  }
  await sleep(400);           // let the last writes land on disk
  try { await flush(true); } catch (e) { console.error('relay final:', e.message); }
})();
