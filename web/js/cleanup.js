// THERMITE — cleanup.
//
// Manual counterpart to the scheduled sweep, running from the browser with the
// same safety rule and the same failure mode:
//
//   "I could not check whether the run finished" is NEVER read as
//   "the run must have finished". Every uncertainty keeps the pour.
//
// Nothing here touches workflows, scripts, encryption keys or repository
// configuration. Decommissioning — deleting the crucible outright — is a
// separate, explicitly named operation further down.

import { APP } from './config.js';
import { gh, ApiError } from './github.js';
import { sleep, backoff, ULID_RE } from './util.js';

const NAME = APP.repoName;

export class CleanupRefused extends Error {}

/** What a cleanup will and will not remove. Shown verbatim in the confirmation. */
export const REMOVES = [
  'The pour\u2019s source (or sealed charge) under jobs/',
  'Its live build log and state file',
  'Its GitHub Release and the release tag',
];
export const KEEPS = [
  'Your Thermite workflows and scripts',
  'Your encryption public keys and configuration',
  'Every other pour',
  'The crucible repository itself',
];
export const GITHUB_RETAINS = [
  'The Actions run and its own job log — GitHub keeps these for 90 days and Thermite cannot delete them with read-only Actions access',
  'The Actions artifact, until its own expiry date',
  'Git history: the commit that added the pour stays in the repository\u2019s history even after the files are removed',
];

// ------------------------------------------------------------- discovery ----

/** Every pour currently present in the crucible, classified by liveness. */
export async function survey(login, { onProgress } = {}) {
  let entries;
  try {
    entries = await gh.get(`/repos/${login}/${NAME}/contents/jobs?ref=main`);
  } catch (e) {
    if (e.status === 404) return { pours: [], eligible: [], active: [], unknown: [] };
    throw e;
  }

  const ids = (Array.isArray(entries) ? entries : [])
    .filter((e) => e.type === 'dir' && ULID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();

  const pours = [];
  for (let i = 0; i < ids.length; i++) {
    onProgress?.(i + 1, ids.length);
    pours.push(await classify(login, ids[i]));
  }

  return {
    pours,
    eligible: pours.filter((p) => p.state === 'spent'),
    active: pours.filter((p) => p.state === 'active'),
    unknown: pours.filter((p) => p.state === 'unknown'),
  };
}

/**
 * Resolve a pour's triggering commit and decide whether it is safe to remove.
 * @returns {{id, sha, state:'spent'|'active'|'unknown', reason, conclusion, sealed}}
 */
export async function classify(login, id, { sha } = {}) {
  const out = { id, sha: sha || null, state: 'unknown', reason: '', conclusion: null, sealed: false };

  if (!ULID_RE.test(id)) { out.reason = 'not a Thermite pour id'; return out; }

  try {
    const m = await gh.rawFile(login, NAME, `jobs/${id}/manifest.json`, 'main');
    if (m?.text) {
      const parsed = JSON.parse(m.text);
      out.sealed = !!(parsed.encryption?.source || parsed.encryption?.artifact);
      out.toolchain = parsed.toolchain;
      out.target = parsed.target;
      out.submittedAt = parsed.submittedAt;
    }
  } catch { /* metadata only; not a reason to refuse */ }

  if (!out.sha) {
    try {
      // The commit that ADDED the manifest is the commit that triggered the run.
      const commits = await gh.get(
        `/repos/${login}/${NAME}/commits?path=jobs/${id}/manifest.json&per_page=5`);
      out.sha = commits?.[commits.length - 1]?.sha || commits?.[0]?.sha || null;
    } catch (e) {
      out.reason = `could not resolve its commit (${e.status || 'network'})`;
      return out;   // fail closed
    }
  }
  if (!out.sha) { out.reason = 'no commit found for this pour'; return out; }

  let runs;
  try {
    runs = await gh.runsForCommit(login, NAME, out.sha);
  } catch (e) {
    out.reason = `could not read run status (${e.status || 'network'})`;
    return out;     // fail closed
  }

  if (!runs.length) {
    // No run at all. Only treat as spent once it is clearly too old to be
    // waiting on the scheduler.
    const age = out.submittedAt ? Date.now() - Date.parse(out.submittedAt) : 0;
    if (age > 30 * 60_000) { out.state = 'spent'; out.reason = 'no run was ever created'; }
    else { out.reason = 'the run has not appeared yet'; }
    return out;
  }

  const live = runs.find((r) => r.status !== 'completed');
  if (live) {
    out.state = 'active';
    out.reason = `run ${live.id} is ${live.status}`;
    return out;
  }

  out.state = 'spent';
  out.conclusion = runs[0].conclusion;
  out.reason = `run finished: ${runs[0].conclusion}`;
  return out;
}

// -------------------------------------------------------------- removal -----

/**
 * Remove one or more pours. Every pour is re-classified immediately before
 * deletion, so a build that started while the confirmation dialog was open is
 * still protected.
 *
 * @param {string} login
 * @param {string[]} ids
 * @param {(msg:string)=>void} onStep
 */
export async function removePours(login, ids, onStep = () => {}) {
  const removed = [];
  const refused = [];

  for (const id of ids) {
    onStep(`checking ${id}`);
    const check = await classify(login, id);
    if (check.state !== 'spent') { refused.push({ id, reason: check.reason }); continue; }
    removed.push(id);
  }

  if (!removed.length) return { removed, refused };

  // --- releases and tags ---------------------------------------------------
  for (const id of removed) {
    onStep(`removing the release for ${id}`);
    const tag = `pour-${id}`;
    try {
      const rel = await gh.releaseByTag(login, NAME, tag);
      if (rel) {
        await gh.del(`/repos/${login}/${NAME}/releases/${rel.id}`);
        await gh.del(`/repos/${login}/${NAME}/git/refs/tags/${tag}`).catch(() => {});
      }
    } catch (e) {
      if (e.status !== 404) throw new CleanupRefused(
        `Could not remove the release for ${id}: ${e.message}. Nothing further was deleted.`);
    }
  }

  // --- log branch ----------------------------------------------------------
  for (const id of removed) {
    onStep(`removing logs for ${id}`);
    for (const path of [`logs/${id}.log`, `logs/${id}.log.tenc`, `logs/${id}.state.json`]) {
      try {
        const head = await gh.get(
          `/repos/${login}/${NAME}/contents/${path}?ref=${APP.logBranch}`);
        await gh.call(`/repos/${login}/${NAME}/contents/${path}`, {
          method: 'DELETE',
          body: {
            message: `thermite: clean up ${id} logs [skip ci]`,
            sha: head.sha,
            branch: APP.logBranch,
          },
        });
      } catch (e) { if (e.status !== 404) throw e; }
    }
  }

  // --- one deletion commit on main ----------------------------------------
  onStep('writing the deletion commit');
  await deleteTrees(login, removed.map((id) => `jobs/${id}`),
    `thermite: clean up ${removed.length} pour${removed.length > 1 ? 's' : ''} [skip ci]`);

  return { removed, refused };
}

/**
 * Delete directories with a single commit built through the Git Data API.
 *
 * The commit only ever contains deletions, which is one of the three
 * independent reasons it cannot start a build: the message carries [skip ci],
 * every changed path has status D, and detect.mjs accepts only added manifests.
 */
async function deleteTrees(login, prefixes, message) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = await gh.get(`/repos/${login}/${NAME}/git/ref/heads/main`);
    const parent = ref.object.sha;
    const commit = await gh.get(`/repos/${login}/${NAME}/git/commits/${parent}`);
    const full = await gh.get(
      `/repos/${login}/${NAME}/git/trees/${commit.tree.sha}?recursive=1`);

    if (full.truncated) {
      throw new CleanupRefused(
        'This crucible has grown too large to rewrite safely in one request. ' +
        'Clean up a few pours at a time, or let the scheduled sweep handle it.');
    }

    const doomed = full.tree.filter((n) =>
      n.type === 'blob' && prefixes.some((p) => n.path === p || n.path.startsWith(p + '/')));

    if (!doomed.length) return null;   // already gone

    const tree = await gh.post(`/repos/${login}/${NAME}/git/trees`, {
      base_tree: commit.tree.sha,
      tree: doomed.map((n) => ({ path: n.path, mode: n.mode, type: 'blob', sha: null })),
    });

    const made = await gh.post(`/repos/${login}/${NAME}/git/commits`, {
      message, tree: tree.sha, parents: [parent],
    });

    try {
      await gh.patch(`/repos/${login}/${NAME}/git/refs/heads/main`,
        { sha: made.sha, force: false });
      return made.sha;
    } catch (e) {
      if (e.status === 422 || e.status === 409) { await sleep(backoff(attempt, 300, 4000)); continue; }
      throw e;
    }
  }
  throw new CleanupRefused('A pour kept landing while cleanup was running. Try again.');
}

// -------------------------------------------------------- decommission ------

/**
 * Delete the crucible repository outright. This is the uninstall: it removes
 * every pour, every log, every release, the workflows, and the registered
 * encryption public keys, because it removes the repository that held them.
 *
 * Deliberately NOT reachable from any cleanup button. It needs the exact
 * repository name typed back, and it refuses while a build is running.
 */
export async function decommission(login, typedName, { force = false } = {}) {
  if (typedName !== `${login}/${NAME}`) {
    throw new CleanupRefused(`Type ${login}/${NAME} exactly to confirm.`);
  }

  if (!force) {
    const { active, unknown } = await survey(login);
    if (active.length) {
      throw new CleanupRefused(
        `${active.length} pour${active.length > 1 ? 's are' : ' is'} still building. ` +
        'Wait for them to finish, or decommission anyway to cancel them by deleting the repository.');
    }
    if (unknown.length) {
      throw new CleanupRefused(
        `Thermite could not confirm the state of ${unknown.length} pour(s), so it will not delete ` +
        'the repository without an explicit override.');
    }
  }

  try {
    await gh.del(`/repos/${login}/${NAME}`);
  } catch (e) {
    if (e.status === 403) {
      throw new CleanupRefused(
        'GitHub refused. Deleting a repository needs "Administration: Read and write" on your ' +
        'forge key — the same permission that created it. Add it, or delete the repository ' +
        'yourself from its Settings page.');
    }
    if (e.status !== 404) throw e;
  }

  return true;
}

export { NAME as CRUCIBLE_NAME };
