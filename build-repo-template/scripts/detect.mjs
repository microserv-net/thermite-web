#!/usr/bin/env node
// THERMITE — detect.mjs
//
// Decide whether the commit that triggered this run introduced exactly one
// valid pour, and if so emit its validated parameters.
//
// Contract:
//   * Look at the DIFF of the triggering commit, never at the repository state.
//   * Accept only ADDED manifests. A modified manifest is not a new pour.
//   * Emit nothing unvalidated. Everything here ends up in a shell somewhere.
//   * Exit 0 when there is no pour. A cleanup commit is not a failure.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { TARGETS, TARGET_MIN_VERSION, TOOLCHAIN_RE, JOB_ID_RE, cmpVersion } from './targets.mjs';

const LIMITS = {
  manifestBytes: 8 * 1024,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  fileCount: 1200,
  pathLength: 200,
  pathDepth: 24,
};

const SHA = process.env.GITHUB_SHA;
const BEFORE = process.env.THERMITE_BEFORE || '';
const OUT = process.env.GITHUB_OUTPUT;
const SUMMARY = process.env.GITHUB_STEP_SUMMARY;

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function emit(obj) {
  // GITHUB_OUTPUT is line-oriented: a stray newline in a value would let one
  // output bleed into the next. Flatten every value.
  const lines = Object.entries(obj).map(([k, v]) =>
    `${k}=${String(v).replace(/[\r\n]+/g, ' ').slice(0, 900)}`);
  appendFileSync(OUT, lines.join('\n') + '\n');
}

function note(md) {
  if (SUMMARY) appendFileSync(SUMMARY, md + '\n');
  console.log(md.replace(/[#*`]/g, ''));
}

function stand_down(reason) {
  emit({ found: 'false', reason });
  note(`### Thermite\n\nNo pour in this commit — ${reason}. Nothing to compile.`);
  process.exit(0);
}

function refuse(reason) {
  // A commit that looks like a pour but is not valid. Report it loudly in the
  // summary but still exit 0: the user's Actions history should not be a wall
  // of red because they hand-pushed something odd.
  emit({ found: 'false', reason });
  note(`### Thermite — pour refused\n\n${reason}`);
  process.exit(0);
}

// ---------------------------------------------------------------- diff ------

function changedPaths() {
  const zeros = /^0{40}$/;
  if (BEFORE && !zeros.test(BEFORE) && BEFORE !== SHA) {
    try {
      git('cat-file', '-e', `${BEFORE}^{commit}`);
      return parseNameStatus(git('diff', '--name-status', '-z', `${BEFORE}..${SHA}`));
    } catch { /* fall through: shallow or force-pushed history */ }
  }
  // Single-commit view. Our client only ever pushes one commit per pour, so
  // this is the correct fallback and not a degradation.
  return parseNameStatus(
    git('diff-tree', '--no-commit-id', '--name-status', '-z', '-r', '-m', SHA)
  );
}

function parseNameStatus(raw) {
  const parts = raw.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (/^[RC]/.test(status)) { i++; out.push({ status: 'A', path: parts[i++] }); }
    else out.push({ status: status[0], path: parts[i++] });
  }
  return out;
}

// ------------------------------------------------------------ validation ----

function safePath(p) {
  if (p.length > LIMITS.pathLength) return 'path too long';
  if (p.split('/').length > LIMITS.pathDepth) return 'path nested too deeply';
  if (!/^[A-Za-z0-9._\/-]+$/.test(p)) return 'path contains disallowed characters';
  if (p.startsWith('/') || p.includes('//')) return 'malformed path';
  if (p.split('/').some((s) => s === '..' || s === '.' || s === '')) return 'relative segment in path';
  return null;
}

function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`symlink in job tree: ${abs}`);
    if (e.isDirectory()) walk(abs, base, acc);
    else if (e.isFile()) acc.push(abs.slice(base.length + 1).split(sep).join('/'));
    else throw new Error(`irregular file in job tree: ${abs}`);
  }
  return acc;
}

// ------------------------------------------------------------------ main ----

const changed = changedPaths();
if (!changed.length) stand_down('the commit changed nothing under jobs/');

const added = changed.filter((c) => c.status === 'A');
const manifests = added
  .map((c) => /^jobs\/([^\/]+)\/manifest\.json$/.exec(c.path))
  .filter(Boolean)
  .map((m) => m[1]);

if (manifests.length === 0) {
  const onlyDeletes = changed.every((c) => c.status === 'D');
  stand_down(onlyDeletes ? 'it only removes spent pours' : 'it adds no manifest');
}

if (manifests.length > 1) {
  refuse(
    `This commit adds ${manifests.length} manifests. Thermite builds exactly one pour ` +
    `per commit so that every run maps to one submission. Push them separately.`
  );
}

const id = manifests[0];
if (!JOB_ID_RE.test(id)) refuse(`\`${id.slice(0, 40)}\` is not a valid pour id (ULID expected).`);

// Every path this commit touched must live inside this one job directory.
const prefix = `jobs/${id}/`;
const stray = changed.find((c) => !c.path.startsWith(prefix));
if (stray) {
  refuse(
    `This commit also touches \`${stray.path}\`. A pour commit may only add files ` +
    `under \`${prefix}\` — workflow, script and metadata changes must be pushed on their own.`
  );
}

// ---- manifest ----
const manifestPath = `jobs/${id}/manifest.json`;
if (statSync(manifestPath).size > LIMITS.manifestBytes) refuse('manifest.json is implausibly large.');

let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
catch (e) { refuse(`manifest.json is not valid JSON: ${e.message}`); }

const ALLOWED_KEYS = new Set([
  'schema', 'id', 'toolchain', 'target', 'projectType', 'name',
  'entry', 'submittedAt', 'client', 'files', 'bytes', 'treeHash',
  'encryption', 'cleanup', 'source',
]);
const unknown = Object.keys(manifest).filter((k) => !ALLOWED_KEYS.has(k));
if (unknown.length) refuse(`manifest.json has unrecognised keys: ${unknown.join(', ')}`);

if (manifest.id !== id) refuse('manifest id does not match its directory name.');
if (manifest.schema !== 1) refuse(`unsupported manifest schema ${manifest.schema}.`);

const toolchain = String(manifest.toolchain || '');
if (!TOOLCHAIN_RE.test(toolchain)) refuse(`\`${toolchain.slice(0, 40)}\` is not a toolchain Thermite accepts.`);

const target = String(manifest.target || '');
const spec = TARGETS[target];
if (!spec) {
  refuse(
    `\`${target.slice(0, 60)}\` is not a supported target. Supported: ` +
    Object.keys(TARGETS).join(', ')
  );
}

if (/^\d/.test(toolchain)) {
  const min = TARGET_MIN_VERSION[target];
  if (min && cmpVersion(toolchain, min) < 0) {
    refuse(`Rust ${toolchain} predates the \`${target}\` target, which needs ${min} or newer.`);
  }
}

const projectType = manifest.projectType;
if (projectType !== 'single' && projectType !== 'cargo') refuse('projectType must be "single" or "cargo".');

// --- where the source comes from -------------------------------------------
// A pour either CARRIES its source (uploaded, plaintext or sealed) or NAMES a
// public repository for the runner to fetch. A named repository is not
// committed here, so this job directory holds a manifest and nothing else.
const source = manifest.source || null;
let repoSource = null;
if (source !== null) {
  if (typeof source !== 'object') refuse('manifest.source must be an object.');
  if (source.kind !== 'repo') refuse(`manifest.source.kind must be "repo", not "${String(source.kind).slice(0, 40)}".`);
  const bad = Object.keys(source).filter((k) => !['kind', 'owner', 'repo', 'ref', 'subdir', 'sha'].includes(k));
  if (bad.length) refuse(`manifest.source has unrecognised keys: ${bad.join(', ')}`);

  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(String(source.owner || ''))) {
    refuse(`"${String(source.owner).slice(0, 60)}" is not a valid GitHub owner name.`);
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(String(source.repo || ''))) {
    refuse(`"${String(source.repo).slice(0, 60)}" is not a valid repository name.`);
  }
  const ref = String(source.ref || '');
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(ref) || ref.split('/').some((p) => p === '..' || p === '')) {
    refuse(`"${ref.slice(0, 60)}" is not a ref Thermite will pass to git.`);
  }
  const sub = String(source.subdir || '');
  if (sub) {
    if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(sub)) refuse(`"${sub.slice(0, 80)}" is not a path Thermite accepts.`);
    if (sub.startsWith('/') || sub.split('/').some((p) => p === '..' || p === '.' || p === '')) {
      refuse(`"${sub}" escapes the repository.`);
    }
  }
  repoSource = { owner: source.owner, repo: source.repo, ref, subdir: sub };
}

// --- encryption declaration -------------------------------------------------
// A sealed pour carries ciphertext, so its file paths cannot be checked here.
// unseal.mjs repeats every one of the checks below against the decrypted
// contents before writing a single byte to disk.
const encryption = manifest.encryption || null;
if (encryption !== null) {
  if (typeof encryption !== 'object') refuse('manifest.encryption must be an object.');
  const keys = Object.keys(encryption).filter((k) => !['source', 'artifact'].includes(k));
  if (keys.length) refuse(`manifest.encryption has unrecognised keys: ${keys.join(', ')}`);
  for (const side of ['source', 'artifact']) {
    const v = encryption[side];
    if (v == null) continue;
    if (typeof v !== 'object' || !/^[0-9a-f]{16}$/.test(String(v.keyId || ''))) {
      refuse(`manifest.encryption.${side}.keyId is not a Thermite key id.`);
    }
  }
}
const sealedSource = !!encryption?.source;
const sealedArtifact = !!encryption?.artifact;

// Sealing a source that is already a public repository protects nothing, and
// pretending otherwise would be worse than refusing.
if (repoSource && sealedSource) {
  refuse('this pour names a public repository and also asks for source encryption. The source is already public; sealing it would protect nothing.');
}

// Fail early and legibly rather than after a 20-minute build: the public key
// the runner needs to seal the ingot must exist at THIS commit.
if (sealedArtifact) {
  const keyPath = '.thermite/keys/artifact-public.pem';
  if (!existsSync(keyPath)) {
    refuse(
      `This pour asks for a sealed ingot, but \`${keyPath}\` is not present at this commit. ` +
      'Register the artifact public key from the website before pouring.');
  }
}

// --- cleanup policy ---------------------------------------------------------
const cleanup = manifest.cleanup || null;
if (cleanup !== null) {
  if (typeof cleanup !== 'object') refuse('manifest.cleanup must be an object.');
  const POLICIES = ['expire', 'onSuccess', 'onReturn'];
  if (cleanup.policy != null && !POLICIES.includes(cleanup.policy)) {
    refuse(`manifest.cleanup.policy must be one of ${POLICIES.join(', ')}.`);
  }
  if (cleanup.onFailure != null && !['keep', 'clean'].includes(cleanup.onFailure)) {
    refuse('manifest.cleanup.onFailure must be "keep" or "clean".');
  }
}

// ---- sources ----
let files;
try { files = walk(`jobs/${id}`); }
catch (e) { refuse(e.message); }

if (files.length > LIMITS.fileCount) refuse(`${files.length} files exceeds the ${LIMITS.fileCount}-file ceiling.`);

let total = 0;
for (const rel of files) {
  const bad = safePath(rel);
  if (bad) refuse(`\`${rel.slice(0, 80)}\`: ${bad}`);
  if (rel.startsWith('.github/') || rel.includes('/.github/')) refuse('a pour may not contain .github/ paths.');
  const size = statSync(`jobs/${id}/${rel}`).size;
  if (size > LIMITS.fileBytes) refuse(`\`${rel}\` is larger than the 8 MiB per-file ceiling.`);
  total += size;
  if (total > LIMITS.totalBytes) refuse('the pour exceeds the 64 MiB total ceiling.');
}

const sources = files.filter((f) => f !== 'manifest.json');
if (repoSource) {
  if (sources.length) {
    refuse(`a pour that names a repository carries no files, but this one also has: ${sources.slice(0, 5).join(', ')}`);
  }
} else if (!sources.length) {
  refuse('the pour contains no source files.');
}

let entry;
if (repoSource) {
  entry = '';   // resolved by fetch.mjs, once the repository is on the runner
} else if (sealedSource) {
  if (!sources.includes('source.tenc')) {
    refuse('this pour declares an encrypted source but carries no source.tenc container.');
  }
  const strays = sources.filter((f) => f !== 'source.tenc');
  if (strays.length) {
    refuse(`an encrypted pour may carry only source.tenc, but it also has: ${strays.slice(0, 5).join(', ')}`);
  }
  entry = '';   // resolved by unseal.mjs, after decryption and validation
} else if (projectType === 'cargo') {
  const manifests_ = sources.filter((f) => f === 'source/Cargo.toml');
  if (!manifests_.length) {
    const anywhere = sources.filter((f) => f.endsWith('Cargo.toml'));
    refuse(
      anywhere.length
        ? `Cargo.toml is at \`${anywhere[0]}\` but must be at \`source/Cargo.toml\`. ` +
          `Zip the project's contents, not the folder that contains it.`
        : 'no Cargo.toml found. Submit as a single file instead, or include a Cargo.toml.'
    );
  }
  entry = 'source/Cargo.toml';
} else {
  const rs = sources.filter((f) => f.startsWith('source/') && f.endsWith('.rs'));
  if (rs.length !== 1) refuse(`single-file pours need exactly one .rs file, found ${rs.length}.`);
  entry = rs[0];
}
if (!sealedSource && !repoSource && projectType === 'single' && spec.wasm) {
  refuse(`\`${target}\` needs a cargo project — rustc alone cannot link a bare wasm binary usefully.`);
}

// ---- tamper check ----
if (manifest.treeHash && !repoSource) {
  const h = createHash('sha256');
  for (const rel of sources.slice().sort()) {
    h.update(rel, 'utf8'); h.update('\0');
    h.update(readFileSync(`jobs/${id}/${rel}`));
    h.update('\0');
  }
  const actual = 'sha256:' + h.digest('hex');
  if (actual !== manifest.treeHash) {
    refuse('the source tree does not match the hash recorded at submission time.');
  }
}

const name = /^[A-Za-z0-9._ -]{1,64}$/.test(String(manifest.name || '')) ? manifest.name : id;

emit({
  found: 'true',
  id,
  toolchain,
  target,
  project_type: projectType,
  entry,
  source_kind: repoSource ? 'repo' : 'upload',
  src_owner: repoSource ? repoSource.owner : '',
  src_repo: repoSource ? repoSource.repo : '',
  src_ref: repoSource ? repoSource.ref : '',
  src_subdir: repoSource ? repoSource.subdir : '',
  sealed: String(sealedSource || sealedArtifact),
  sealed_source: String(sealedSource),
  sealed_artifact: String(sealedArtifact),
  name,
  runner: spec.runner,
  mode: spec.mode,
  sandbox: spec.sandbox,
  apt: (spec.apt || []).join(' '),
  linker: spec.linker || '',
  ext: spec.ext,
  pack: spec.pack,
  files: String(sources.length),
  bytes: String(total),
  submitted_at: /^\d{4}-\d{2}-\d{2}T/.test(String(manifest.submittedAt || ''))
    ? manifest.submittedAt : new Date().toISOString(),
});

note(
  `### Thermite — pour \`${id}\`\n\n` +
  `| | |\n|---|---|\n` +
  `| Toolchain | \`${toolchain}\` |\n| Target | \`${target}\` |\n` +
  `| Kind | ${projectType === 'cargo' ? 'cargo project' : 'single file'} |\n` +
  `| Source | ${repoSource ? `${repoSource.owner}/${repoSource.repo} @ ${repoSource.ref}${repoSource.subdir ? ` · ${repoSource.subdir}` : ''}` : 'uploaded'} |\n` +
  `| Sealed | ${sealedSource ? 'source' : '—'}${sealedArtifact ? (sealedSource ? ' + ingot' : 'ingot') : ''} |\n` +
  `| Size | ${(total / 1024).toFixed(1)} KiB |\n` +
  `| Runner | \`${spec.runner}\` (${spec.mode}) |\n`
);
