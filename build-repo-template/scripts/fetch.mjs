#!/usr/bin/env node
// THERMITE — fetch.mjs
//
// Bring a public GitHub repository into jobs/<id>/source/ so the compiler can
// see it. Used when a pour names a repository instead of carrying an upload.
//
// Three things this must get right.
//
// 1. Nothing fetched here is ever committed back to the crucible. The clone is
//    ephemeral, lives on the runner, and dies with it. That is why the pour
//    commit for a repo source contains a manifest and nothing else.
//
// 2. No credential. The clone is an anonymous HTTPS fetch of a public
//    repository. A private repository fails here, deliberately and legibly:
//    the only token on the runner is scoped to the crucible, and handing a
//    build broader access to make this work would be a bad trade.
//
// 3. Everything from the manifest is re-validated before it reaches git.
//    detect.mjs has already checked it; this checks it again, because the
//    values end up in a URL and a filesystem path.

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, rmSync, renameSync, appendFileSync,
  readdirSync, statSync, lstatSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

const LIMITS = {
  fileBytes: 16 * 1024 * 1024,     // a repo may legitimately carry test fixtures
  totalBytes: 256 * 1024 * 1024,
  fileCount: 20000,
};

const JOB = process.env.THERMITE_JOB;
const KIND = process.env.THERMITE_PROJECT_TYPE;
const OWNER = process.env.THERMITE_SRC_OWNER || '';
const REPO = process.env.THERMITE_SRC_REPO || '';
const REF = process.env.THERMITE_SRC_REF || '';
const SUBDIR = process.env.THERMITE_SRC_SUBDIR || '';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function fail(message, code = 94) {
  const text = `\nThermite could not fetch the source repository: ${message}\n`;
  process.stdout.write(text);
  try { appendFileSync('pour.log', text); } catch {}
  process.exit(code);
}

if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(JOB || '')) fail('invalid job id');
if (!OWNER_RE.test(OWNER)) fail(`"${OWNER.slice(0, 60)}" is not a valid GitHub owner name`);
if (!REPO_RE.test(REPO)) fail(`"${REPO.slice(0, 60)}" is not a valid repository name`);
if (!REF_RE.test(REF) || REF.split('/').some((p) => p === '..' || p === '')) {
  fail(`"${REF.slice(0, 60)}" is not a ref Thermite will pass to git`);
}
if (SUBDIR) {
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(SUBDIR)) fail(`"${SUBDIR.slice(0, 80)}" is not a path Thermite accepts`);
  if (SUBDIR.startsWith('/') || SUBDIR.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    fail(`"${SUBDIR}" escapes the repository`);
  }
}

const jobDir = `jobs/${JOB}`;
const dest = join(jobDir, 'source');
const work = '.thermite-fetch';
const url = `https://github.com/${OWNER}/${REPO}.git`;

const say = (m) => { process.stdout.write(m + '\n'); try { appendFileSync('pour.log', m + '\n'); } catch {} };

rmSync(work, { recursive: true, force: true });
rmSync(dest, { recursive: true, force: true });

say(`$ git clone --depth 1 ${url} (ref ${REF})`);

const git = (args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

try {
  if (SHA_RE.test(REF)) {
    // --branch does not take a commit sha, so a pinned commit is fetched
    // explicitly. Still a shallow fetch: one commit, no history.
    mkdirSync(work, { recursive: true });
    git(['-C', work, 'init', '-q']);
    git(['-C', work, 'remote', 'add', 'origin', url]);
    git(['-C', work, 'fetch', '-q', '--depth', '1', '--no-tags', 'origin', REF]);
    git(['-C', work, 'checkout', '-q', 'FETCH_HEAD']);
  } else {
    git(['clone', '-q', '--depth', '1', '--no-tags', '--single-branch',
      '--branch', REF, url, work]);
  }
} catch (e) {
  const err = String(e.stderr || e.message || '');
  if (/Authentication failed|could not read Username|not found/i.test(err)) {
    fail(
      `${OWNER}/${REPO} could not be read anonymously. Thermite builds public repositories ` +
      'only — the runner carries no credential that could reach a private one, and giving it ' +
      'one would widen what a build can touch. Make the repository public, or upload the ' +
      'project instead.');
  }
  if (/Remote branch .* not found|couldn't find remote ref/i.test(err)) {
    fail(`${OWNER}/${REPO} has no ref called "${REF}".`);
  }
  fail(err.split('\n').slice(0, 3).join(' ').trim() || 'git failed');
}

// ------------------------------------------------------------- the subdir --

const root = resolve(work);
const picked = SUBDIR ? resolve(work, SUBDIR) : root;
if (picked !== root && !picked.startsWith(root + sep)) fail(`"${SUBDIR}" escapes the repository`);
if (!existsSync(picked) || !statSync(picked).isDirectory()) {
  fail(`"${SUBDIR || '.'}" is not a directory in ${OWNER}/${REPO} at ${REF}.`);
}

// The clone's history is not the pour's business, and .git would otherwise be
// copied into the build tree.
rmSync(join(work, '.git'), { recursive: true, force: true });

mkdirSync(jobDir, { recursive: true });
renameSync(picked, dest);
rmSync(work, { recursive: true, force: true });

// ------------------------------------------------------------- inspection --

let files = 0;
let total = 0;
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.isFile()) continue;                       // links and specials are left alone
    files++;
    if (files > LIMITS.fileCount) fail(`that directory holds more than ${LIMITS.fileCount} files`);
    let size = 0;
    try { size = lstatSync(p).size; } catch { continue; }
    if (size > LIMITS.fileBytes) fail(`"${p.slice(dest.length + 1)}" is larger than the ${LIMITS.fileBytes / 1048576} MiB per-file ceiling`);
    total += size;
    if (total > LIMITS.totalBytes) fail(`that directory expands past the ${LIMITS.totalBytes / 1048576} MiB ceiling`);
  }
})(dest);

// ------------------------------------------------------------- entrypoint --

let entry;
if (KIND === 'cargo') {
  if (!existsSync(join(dest, 'Cargo.toml'))) {
    fail(
      `there is no Cargo.toml at "${SUBDIR || 'the repository root'}" of ${OWNER}/${REPO}. ` +
      'Pick the folder that contains the Cargo.toml you want built.');
  }
  entry = 'source/Cargo.toml';
} else {
  const rs = readdirSync(dest, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.rs'))
    .map((e) => e.name);
  if (rs.length !== 1) {
    fail(`single-file pours need exactly one .rs file in that folder; it has ${rs.length}.`);
  }
  entry = `source/${rs[0]}`;
}

appendFileSync(process.env.GITHUB_ENV, `THERMITE_ENTRY_UNSEALED=${entry}\n`);

const head = process.env.THERMITE_SRC_SHA || REF;
say(`  fetched ${OWNER}/${REPO} @ ${head}${SUBDIR ? ` · ${SUBDIR}` : ''}`);
say(`  ${files} files, ${(total / 1048576).toFixed(1)} MiB`);
say('##thermite:fetched');
