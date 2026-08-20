#!/usr/bin/env node
// THERMITE — sweep.mjs
//
// Remove spent pours about 24 hours after they were submitted.
//
// The one rule that matters: never touch a pour whose run has not finished.
// Age alone is not sufficient evidence — a 25-minute build submitted 23h50m
// ago will still be running when the sweep starts. Liveness is checked against
// the Actions API at sweep time, per pour, and anything not clearly completed
// is left exactly where it is.

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const BRANCH_LOGS = 'crucible-logs';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SETTLE_MS = 30 * 60 * 1000;   // grace before assuming "no run will appear"
const STALE_STREAM_MS = 10 * 60 * 1000;
const DRY = process.env.THERMITE_DRY_RUN === 'true';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const log = (...a) => console.log('[sweep]', ...a);

async function api(path, init = {}) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'thermite-sweep',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (res.status === 403 || res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status >= 500) { await new Promise((r) => setTimeout(r, 1000 * (i + 1))); continue; }
    return res;
  }
  return { ok: false, status: 599, json: async () => ({}) };
}

// --------------------------------------------------------------------------

if (!existsSync('jobs')) { log('no jobs directory; nothing to sweep'); process.exit(0); }

const ids = readdirSync('jobs', { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(e.name))
  .map((e) => e.name);

if (!ids.length) { log('no pours on disk'); process.exit(0); }
log(`${ids.length} pour(s) present`);

const now = Date.now();
const removable = [];
const kept = [];

for (const id of ids) {
  // The commit that ADDED the manifest is exactly the commit that triggered
  // the run. Same key on both sides of the join, so it cannot drift.
  let sha = '', when = '';
  try {
    const line = git('log', '--diff-filter=A', '--format=%H %cI', '-1', '--', `jobs/${id}/manifest.json`);
    [sha, when] = line.split(' ');
  } catch { /* ignore */ }

  if (!sha) { kept.push([id, 'cannot resolve the commit that created it']); continue; }

  const age = now - Date.parse(when);

  // Per-pour cleanup policy, declared at submission time.
  //   expire    (default) — 24 hours, whatever happened
  //   onSuccess           — eligible as soon as a successful run has completed
  //   onReturn            — the browser deletes it once the ingot has been
  //                         retrieved and, if sealed, decrypted; the sweep only
  //                         acts as the 24-hour backstop
  // onFailure: 'clean' lets a failed pour go early. The default keeps it,
  // because a failed build's log is usually the only thing worth having.
  let policy = 'expire';
  let onFailure = 'keep';
  try {
    const m = JSON.parse(readFileSync(`jobs/${id}/manifest.json`, 'utf8'));
    if (m.cleanup?.policy) policy = m.cleanup.policy;
    if (m.cleanup?.onFailure) onFailure = m.cleanup.onFailure;
  } catch { /* unreadable manifest falls back to the safest policy */ }

  const early = policy === 'onSuccess' || onFailure === 'clean';
  if (age < MAX_AGE_MS && !early) {
    kept.push([id, `only ${(age / 3600000).toFixed(1)}h old`]);
    continue;
  }

  // --- liveness, the part that must not be wrong -------------------------
  const res = await api(`/repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`);
  if (!res.ok) { kept.push([id, `run status unavailable (HTTP ${res.status})`]); continue; }
  const runs = (await res.json()).workflow_runs || [];

  if (runs.length === 0) {
    if (age < MAX_AGE_MS + SETTLE_MS) { kept.push([id, 'no run yet; still inside the grace window']); continue; }
    log(`${id}: no run was ever created; treating as abandoned`);
  } else {
    const live = runs.filter((r) => r.status !== 'completed');
    if (live.length) {
      kept.push([id, `run ${live[0].id} is ${live[0].status}`]);
      continue;
    }

    // Early policies only apply to the outcome they name.
    if (age < MAX_AGE_MS) {
      const succeeded = runs.some((r) => r.conclusion === 'success');
      const failed = runs.some((r) => ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion));
      const eligible = (policy === 'onSuccess' && succeeded) || (onFailure === 'clean' && failed);
      if (!eligible) {
        kept.push([id, `policy ${policy}/${onFailure} does not release it yet`]);
        continue;
      }
    }
  }

  // --- second opinion: is the log stream still being written? ------------
  const st = await api(`/repos/${REPO}/contents/logs/${id}.state.json?ref=${BRANCH_LOGS}`);
  if (st.ok) {
    try {
      const meta = await st.json();
      const state = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));
      if (state.live && now - Date.parse(state.updatedAt) < STALE_STREAM_MS) {
        kept.push([id, 'log stream is still live']);
        continue;
      }
    } catch { /* unreadable state is not a reason to keep it forever */ }
  }

  removable.push({ id, sha });
}

for (const [id, why] of kept) log(`keep   ${id} — ${why}`);
for (const { id } of removable) log(`sweep  ${id}`);

if (!removable.length) { log('nothing to remove'); process.exit(0); }
if (DRY) { log('dry run; stopping here'); process.exit(0); }

// ------------------------------------------------- releases, tags, logs -----

for (const { id } of removable) {
  const tag = `pour-${id}`;
  const rel = await api(`/repos/${REPO}/releases/tags/${tag}`);
  if (rel.ok) {
    const { id: releaseId } = await rel.json();
    await api(`/repos/${REPO}/releases/${releaseId}`, { method: 'DELETE' });
    await api(`/repos/${REPO}/git/refs/tags/${tag}`, { method: 'DELETE' });
    log(`removed release ${tag}`);
  }
  for (const path of [`logs/${id}.log`, `logs/${id}.log.tenc`, `logs/${id}.state.json`]) {
    const head = await api(`/repos/${REPO}/contents/${path}?ref=${BRANCH_LOGS}`);
    if (!head.ok) continue;
    const { sha } = await head.json();
    await api(`/repos/${REPO}/contents/${path}`, {
      method: 'DELETE',
      body: JSON.stringify({ message: `thermite: sweep ${id} logs [skip ci]`, sha, branch: BRANCH_LOGS }),
    });
  }
}

// --------------------------------------------------- one deletion commit ----

execFileSync('git', ['config', 'user.name', 'thermite[bot]']);
execFileSync('git', ['config', 'user.email', 'thermite[bot]@users.noreply.github.com']);
for (const { id } of removable) execFileSync('git', ['rm', '-r', '-q', '--', `jobs/${id}`]);

const message = `thermite: sweep ${removable.length} spent pour${removable.length > 1 ? 's' : ''} [skip ci]`;
execFileSync('git', ['commit', '-q', '-m', message]);

for (let i = 0; i < 4; i++) {
  try { execFileSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'inherit' }); break; }
  catch {
    // A pour landed while we were sweeping. Rebase onto it and try again;
    // the deletions are independent of whatever was just added.
    execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'inherit' });
    execFileSync('git', ['rebase', 'origin/main'], { stdio: 'inherit' });
  }
}

log(`removed ${removable.length} pour(s)`);

// If the crucible is completely empty, reset the log branch to a fresh orphan
// commit so its history can never grow without bound.
if (removable.length === ids.length) {
  const empty = await api(`/repos/${REPO}/git/trees`, { method: 'POST', body: JSON.stringify({ tree: [] }) });
  if (empty.ok) {
    const tree = (await empty.json()).sha;
    const c = await api(`/repos/${REPO}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message: 'thermite: cold crucible [skip ci]', tree, parents: [] }),
    });
    if (c.ok) {
      await api(`/repos/${REPO}/git/refs/heads/${BRANCH_LOGS}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: (await c.json()).sha, force: true }),
      });
      log('log branch reset to an empty orphan commit');
    }
  }
}
