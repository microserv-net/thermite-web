#!/usr/bin/env node
// THERMITE — package.mjs
//
// Turn whatever the compiler produced into an ingot: one archive, a checksum,
// and a record of exactly how it was made. Then publish it twice — as an
// Actions artifact (done by the workflow) and as a release asset, because a
// public repo's release assets have plain unauthenticated download URLs and
// are therefore the only artifact a static page can actually hand to a user.

import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync,
  statSync, readdirSync, unlinkSync, rmSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { seal, keyIdOfPublicPem } from './tenc.mjs';

const env = process.env;
const JOB = env.THERMITE_JOB;
const TARGET = env.THERMITE_TARGET;
const TOOLCHAIN = env.THERMITE_TOOLCHAIN;
const KIND = env.THERMITE_PROJECT_TYPE;
const EXT = env.THERMITE_EXT || '';
const PACK = env.THERMITE_PACK || 'targz';
const NAME = (env.THERMITE_NAME || JOB).replace(/[^A-Za-z0-9._-]/g, '_');
const API = env.GITHUB_API_URL || 'https://api.github.com';
const REPO = env.GITHUB_REPOSITORY;
const TOKEN = env.GITHUB_TOKEN;

const OUT = 'ingot';
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------- locate binaries ----

function fromCargoMessages(file) {
  if (!existsSync(file)) return [];
  const found = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.reason === 'compiler-artifact' && m.executable) found.push(m.executable);
    if (m.reason === 'compiler-artifact' && !m.executable && m.filenames) {
      for (const f of m.filenames) if (f.endsWith('.wasm')) found.push(f);
    }
  }
  return [...new Set(found)];
}

function diagnostics(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.reason !== 'compiler-message' || !m.message) continue;
    const d = m.message;
    if (d.level !== 'error' && d.level !== 'warning') continue;
    const span = (d.spans || []).find((s) => s.is_primary) || (d.spans || [])[0];
    out.push({
      level: d.level,
      code: d.code?.code || null,
      message: d.message,
      file: span?.file_name || null,
      line: span?.line_start ?? null,
      column: span?.column_start ?? null,
      rendered: (d.rendered || '').slice(0, 4000),
    });
  }
  return out.slice(0, 200);
}

let binaries = [];
if (KIND === 'cargo') {
  binaries = fromCargoMessages('cargo-messages.json');
  if (!binaries.length) {
    // Fallback: scan the target directory for anything executable-looking.
    const dir = join('source', 'target', TARGET, 'release');
    if (existsSync(dir)) {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const p = join(dir, f.name);
        if (EXT ? f.name.endsWith(EXT) : !/\.(d|rlib|rmeta|so|dylib|pdb)$/.test(f.name)) {
          try { if (statSync(p).mode & 0o111 || EXT) binaries.push(p); } catch {}
        }
      }
    }
  }
} else {
  const single = join('out', NAME + EXT);
  if (existsSync(single)) binaries.push(single);
}

binaries = binaries.filter((b) => existsSync(b));
if (!binaries.length) {
  console.error('##thermite:no-artifact');
  writeFileSync('pour-result.json', JSON.stringify({ ok: false, reason: 'no executable produced' }));
  process.exit(1);
}

// ----------------------------------------------------------- assemble -------

const sums = [];
for (const b of binaries) {
  const dest = join(OUT, basename(b));
  copyFileSync(b, dest);
  const hash = createHash('sha256').update(readFileSync(dest)).digest('hex');
  sums.push({ file: basename(b), sha256: hash, bytes: statSync(dest).size });
}
writeFileSync(join(OUT, 'SHA256SUMS'), sums.map((s) => `${s.sha256}  ${s.file}`).join('\n') + '\n');

const record = {
  job: JOB,
  name: NAME,
  toolchain: TOOLCHAIN,
  requestedTarget: TARGET,
  projectType: KIND,
  rustc: env.THERMITE_RUSTC || null,
  cargo: env.THERMITE_CARGO || null,
  runner: { os: env.RUNNER_OS, arch: env.RUNNER_ARCH, image: env.ImageOS || null },
  commit: env.GITHUB_SHA,
  runId: env.GITHUB_RUN_ID,
  startedAt: env.THERMITE_STARTED_AT || null,
  finishedAt: new Date().toISOString(),
  durationSeconds: env.THERMITE_STARTED_AT
    ? Math.round((Date.now() - Date.parse(env.THERMITE_STARTED_AT)) / 1000) : null,
  binaries: sums,
  warnings: diagnostics('cargo-messages.json').filter((d) => d.level === 'warning').length,
};
writeFileSync(join(OUT, 'pour.json'), JSON.stringify(record, null, 2) + '\n');
if (existsSync('pour.log')) copyFileSync('pour.log', join(OUT, 'pour.log'));

const archive = PACK === 'zip' ? `thermite-${JOB}.zip` : `thermite-${JOB}.tar.gz`;
if (PACK === 'zip') {
  if (process.platform === 'win32') execFileSync('tar', ['-a', '-c', '-f', archive, '-C', OUT, '.'], { stdio: 'inherit' });
  else execFileSync('zip', ['-r', '-q', '-j', archive, OUT], { stdio: 'inherit' });
} else {
  execFileSync('tar', ['-czf', archive, '-C', OUT, '.'], { stdio: 'inherit' });
}
const archiveHash = createHash('sha256').update(readFileSync(archive)).digest('hex');

// ------------------------------------------------------------ seal ---------
// If the pour registered an artifact public key, the ingot is sealed here and
// ONLY the sealed container leaves this runner. The plaintext archive is
// removed, and nothing plaintext is uploaded to a release or an Actions
// artifact. The matching private key exists only in the user's browser.
const ARTIFACT_KEY_PATH = '.thermite/keys/artifact-public.pem';
let upload = archive;
let sealedKeyId = null;

if (env.THERMITE_SEALED === '1') {
  if (!existsSync(ARTIFACT_KEY_PATH)) {
    console.error('##thermite:seal-failed no artifact public key in the crucible');
    writeFileSync('pour-result.json', JSON.stringify({ ok: false, reason: 'artifact public key missing' }));
    process.exit(1);
  }
  const pem = readFileSync(ARTIFACT_KEY_PATH, 'utf8');
  sealedKeyId = keyIdOfPublicPem(pem);
  const container = seal(readFileSync(archive), pem,
    { purpose: 'artifact', jobId: JOB, compression: 'none', note: `thermite ingot ${archive}` });
  upload = `thermite-${JOB}.tenc`;
  writeFileSync(upload, container);
  unlinkSync(archive);
  // The plaintext ingot directory would otherwise be picked up by the Actions
  // artifact upload step.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  copyFileSync(upload, join(OUT, upload));
  console.log(`##thermite:sealed ${upload} for key ${sealedKeyId}`);
}

console.log(`##thermite:packaged ${upload} sha256=${archiveHash}`);

// ------------------------------------------------------------ release -------

async function api(path, init = {}, base = API) {
  return fetch(path.startsWith('http') ? path : `${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'thermite-package',
      ...(init.headers || {}),
    },
  });
}

const tag = `pour-${JOB}`;
let release;
const existing = await api(`/repos/${REPO}/releases/tags/${tag}`);
if (existing.ok) {
  release = await existing.json();
} else {
  const res = await api(`/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: env.GITHUB_SHA,
      name: `${NAME} · ${TARGET}`,
      body: [
        `Pour \`${JOB}\``, '',
        `- toolchain \`${TOOLCHAIN}\` (${record.rustc || 'unknown'})`,
        `- target \`${TARGET}\``,
        `- runner \`${record.runner.os}/${record.runner.arch}\``,
        `- sha256 of the plaintext archive \`${archiveHash}\``,
        ...(sealedKeyId ? ['', `Sealed with THERMITE-ENC v1 for artifact key \`${sealedKeyId}\`.`,
          'Only the holder of the matching private key can open it. Thermite does not have a copy.'] : []),
        '',
        'Cleaned up automatically about 24 hours after the pour.',
      ].join('\n'),
      draft: false,
      prerelease: false,
      make_latest: 'false',
    }),
  });
  if (!res.ok) {
    console.error(`##thermite:release-failed ${res.status} ${await res.text()}`);
    writeFileSync('pour-result.json', JSON.stringify({ ok: true, archive: upload, archiveHash, release: null, record }));
    process.exit(0); // the Actions artifact still exists; do not fail the pour
  }
  release = await res.json();
}

async function uploadAsset(file) {
  const url = release.upload_url.replace(/\{.*$/, `?name=${encodeURIComponent(basename(file))}`);
  const res = await api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: readFileSync(file),
  });
  if (!res.ok) { console.error(`##thermite:asset-failed ${basename(file)} ${res.status}`); return null; }
  return (await res.json()).browser_download_url;
}

const assetUrl = await uploadAsset(upload);

// The build log quotes source in its diagnostics, so on a sealed pour it is
// sealed with the same artifact key rather than published in the clear.
if (existsSync('pour.log')) {
  if (sealedKeyId) {
    const pem = readFileSync(ARTIFACT_KEY_PATH, 'utf8');
    writeFileSync('pour.log.tenc', seal(readFileSync('pour.log'), pem,
      { purpose: 'log', jobId: JOB, note: 'thermite build log' }));
    await uploadAsset('pour.log.tenc');
  } else {
    await uploadAsset('pour.log');
  }
}

writeFileSync('pour-result.json', JSON.stringify({
  ok: true, archive: upload, archiveHash, tag, sealedFor: sealedKeyId,
  downloadUrl: assetUrl, releaseUrl: release.html_url, record,
}, null, 2));

console.log(`##thermite:ingot ${assetUrl || '(release asset unavailable)'}`);
