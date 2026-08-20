#!/usr/bin/env node
// THERMITE — unseal.mjs
//
// Decrypt a sealed charge into jobs/<id>/source/.
//
// Two things matter here.
//
// 1. detect.mjs could not inspect this pour's file paths, because they were
//    ciphertext. So every check detect.mjs would have made is made HERE, after
//    decryption and before anything touches the disk. An encrypted pour is not
//    a less-validated pour.
//
// 2. This script runs in its own workflow step, and that step is the only place
//    THERMITE_SOURCE_KEY exists. The step finishes before the compiler starts,
//    so by the time any build.rs or proc macro executes, the process that held
//    the source private key is gone.

import { readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { unseal, TencError } from './tenc.mjs';

const LIMITS = {
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  fileCount: 1200,
  pathLength: 200,
  pathDepth: 24,
};

const JOB = process.env.THERMITE_JOB;
const KIND = process.env.THERMITE_PROJECT_TYPE;
const KEY = process.env.THERMITE_SOURCE_KEY;

if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(JOB || '')) fail('invalid job id');

const jobDir = `jobs/${JOB}`;
const outDir = join(jobDir, 'source');
const sealedPath = join(jobDir, 'source.tenc');

function fail(message, code = 92) {
  const text = `\nThermite could not unseal this pour: ${message}\n`;
  process.stdout.write(text);
  try { appendFileSync('pour.log', text); } catch {}
  try { appendFileSync('pour.done', ''); } catch {}
  process.exit(code);
}

if (!KEY || !KEY.includes('PRIVATE KEY')) {
  fail(
    'the repository secret THERMITE_SOURCE_KEY is missing or is not a PEM private key.\n' +
    'Add it under Settings → Secrets and variables → Actions, using the private key\n' +
    'Thermite showed you during encryption setup. Thermite never sees this value.');
}

let container;
try { container = readFileSync(sealedPath); }
catch { fail(`${sealedPath} is missing. This pour claims to be encrypted but carries no sealed charge.`); }

let result;
try { result = unseal(container, KEY); }
catch (e) {
  fail(e instanceof TencError ? e.message : `decryption failed (${e.code || e.message})`);
}

if (result.header.purpose !== 'source') fail(`this container is a "${result.header.purpose}" container, not a source charge`);
if (result.header.jobId && result.header.jobId !== JOB) {
  fail(`this charge was sealed for pour ${result.header.jobId}, not ${JOB}`);
}

let charge;
try { charge = JSON.parse(result.bytes.toString('utf8')); }
catch { fail('the decrypted charge is not readable'); }
if (charge.kind !== 'thermite-charge' || charge.version !== 1) fail('unrecognised charge format');
if (!Array.isArray(charge.files) || !charge.files.length) fail('the charge contains no files');
if (charge.files.length > LIMITS.fileCount) fail(`the charge holds ${charge.files.length} files, over the ${LIMITS.fileCount} ceiling`);

// ---------------------------------------------------- validate, then write --

const root = resolve(outDir);
let total = 0;
const written = [];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const f of charge.files) {
  const p = String(f.path || '');
  if (p.length > LIMITS.pathLength) fail(`"${p.slice(0, 60)}…": path too long`);
  if (p.split('/').length > LIMITS.pathDepth) fail(`"${p}": nested too deeply`);
  if (!/^[A-Za-z0-9._\/-]+$/.test(p)) fail(`"${p}": path contains characters the build refuses`);
  if (p.startsWith('/') || p.includes('//')) fail(`"${p}": malformed path`);
  if (p.split('/').some((s) => s === '..' || s === '.' || s === '')) fail(`"${p}": relative segment in path`);
  if (p === '.github' || p.startsWith('.github/') || p.includes('/.github/')) {
    fail(`"${p}": a pour may not carry .github/ paths`);
  }

  const target = resolve(root, p);
  // Belt and braces: even after the checks above, refuse anything that does not
  // resolve inside the job's source directory.
  if (target !== root && !target.startsWith(root + sep)) fail(`"${p}": escapes the pour directory`);

  const bytes = Buffer.from(String(f.data || ''), 'base64');
  if (bytes.length > LIMITS.fileBytes) fail(`"${p}": larger than the 8 MiB per-file ceiling`);
  total += bytes.length;
  if (total > LIMITS.totalBytes) fail('the charge expands past the 64 MiB ceiling');

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  written.push(p);
}

// ------------------------------------------------------------- entrypoint --

let entry;
if (KIND === 'cargo') {
  if (!written.includes('Cargo.toml')) {
    fail('no Cargo.toml at the root of the sealed project');
  }
  entry = 'source/Cargo.toml';
} else {
  const rs = written.filter((f) => f.endsWith('.rs'));
  if (rs.length !== 1) fail(`single-file pours need exactly one .rs file, the charge has ${rs.length}`);
  entry = `source/${rs[0]}`;
}

// The sealed container is left in the repository; only the plaintext is
// ephemeral, and the workflow removes it after the ingot is cast.
// A distinct name on purpose: job-level `env:` wins over anything written to
// GITHUB_ENV, so reusing THERMITE_ENTRY here would be silently overridden by
// the empty value detect.mjs emits for sealed pours.
appendFileSync(process.env.GITHUB_ENV, `THERMITE_ENTRY_UNSEALED=${entry}\n`);

// Actions logs on a public repository are publicly readable, so nothing about
// the decrypted contents — not even file names — is printed anywhere.
const summary =
  `Unsealed ${written.length} file(s), ${(total / 1024).toFixed(1)} KiB, ` +
  `sealed for key ${result.header.kem.keyId}.\n`;
process.stdout.write(summary);
appendFileSync('pour.log', `##thermite:unsealed ${written.length}\n${summary}`);
