// THERMITE — provisioning the crucible.
//
// Creates the user's build repository and lines it with workflows.
//
// Two things this must get right, learned the hard way:
//
//   1. The repository must never be left empty. GitHub's Git Data write
//      endpoints behave inconsistently against a repository that has no
//      commits and no default branch, so the repo is created WITH an initial
//      commit and the template is committed on top of it. That initial commit
//      contains only a README, touches no jobs/ path, and predates build.yml
//      entirely — so there is nothing it could possibly trigger.
//
//   2. Provisioning must be idempotent and self-repairing. If anything fails
//      halfway, the next call has to finish the job rather than see "the repo
//      exists" and walk away, which is how a crucible ends up created but
//      empty forever.

import { APP } from './config.js';
import { gh, ApiError } from './github.js';
import { TEMPLATE, TEMPLATE_PATHS, TEMPLATE_REVISION } from './workflows.js';
import { sleep, pool, toBase64, enc } from './util.js';

const NAME = APP.repoName;
const BUILD_WORKFLOW = '.github/workflows/build.yml';
const SWEEP_WORKFLOW = '.github/workflows/cleanup.yml';

export const STEPS = [
  ['check',  'Looking for an existing crucible'],
  ['create', 'Creating the repository'],
  ['settle', 'Waiting for GitHub to finish creating it'],
  ['branch', 'Making sure the default branch is main'],
  ['policy', 'Restricting Actions to GitHub-owned actions'],
  ['blobs',  'Uploading the workflow and scripts'],
  ['commit', 'Writing the seed commit'],
  ['logs',   'Opening the live-log branch'],
  ['verify', 'Verifying'],
];

export async function findCrucible(login) {
  try {
    return await gh.repo(login, NAME);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * Create and/or repair the crucible. Safe to call on every page load.
 *
 * @param {string} login
 * @param {(step:string, detail?:string)=>void} onStep
 * @returns {Promise<{repo:object, state:object, created:boolean, repaired:boolean}>}
 */
export async function provision(login, onStep = () => {}) {
  onStep('check');
  let repo = await findCrucible(login);
  let created = false;

  // ---------------------------------------------------------- create ------
  if (!repo) {
    onStep('create');
    try {
      repo = await gh.post('/user/repos', {
        name: NAME,
        description: 'Thermite build crucible — Rust compilation jobs. Created automatically; safe to delete.',
        homepage: location.origin + location.pathname.replace(/\/[^/]*$/, '/'),
        private: false,
        // An initial commit, deliberately. See the note at the top of this file.
        auto_init: true,
        has_issues: false,
        has_wiki: false,
        has_projects: false,
        has_downloads: true,
      });
      created = true;
    } catch (e) {
      if (e.status === 422 && /already exists/i.test(e.message || '')) {
        repo = await findCrucible(login);
      } else if (e.status === 403 || e.status === 404) {
        throw new ApiError(e.status,
          'This forge key cannot create repositories. Open it on GitHub and add the ' +
          '"Administration: Read and write" permission, then reconnect. Alternatively, create ' +
          `a public repository named "${NAME}" yourself and reload — Thermite will line it.`);
      } else throw e;
    }

    // A brand-new repository is not immediately consistent. Wait for it to
    // resolve, and for its initial commit to exist, before writing to it.
    onStep('settle');
    for (let i = 0; i < 20; i++) {
      repo = await findCrucible(login);
      if (repo && await headOf(login, repo.default_branch || 'main')) break;
      await sleep(400 + i * 200);
    }
    if (!repo) {
      throw new Error(
        'GitHub accepted the repository but has not made it visible yet. Wait a few seconds and reload.');
    }
  }

  // ------------------------------------------------- default branch = main --
  // The workflow triggers on `branches: [main]`. An account whose default
  // branch name is set to something else would silently never build.
  if (repo.default_branch && repo.default_branch !== 'main') {
    onStep('branch');
    try {
      await gh.post(`/repos/${login}/${NAME}/branches/${encodeURIComponent(repo.default_branch)}/rename`,
        { new_name: 'main' });
      await sleep(800);
      repo = await findCrucible(login);
    } catch (e) {
      throw new ApiError(e.status,
        `Your crucible's default branch is "${repo.default_branch}" and Thermite could not rename it ` +
        'to "main", which is the branch the build workflow watches. Rename it on GitHub ' +
        '(Settings → Branches), or grant "Administration: Read and write" and reload.');
    }
  }

  // ------------------------------------------------------------ policy -----
  onStep('policy');
  await applyPolicy(login);

  // ------------------------------------------------ seed, or repair -------
  // The decision is "are the workflows actually present?", not "did I just
  // create this repo?". That is what makes a half-finished provision
  // recoverable instead of permanent.
  let repaired = false;
  if (!(await hasWorkflows(login))) {
    const head = await headOf(login, 'main');
    await writeTemplate(login, head,
      head ? `thermite: line the crucible → ${TEMPLATE_REVISION} [skip ci]`
           : 'thermite: line the crucible [skip ci]',
      onStep);
    repaired = !created;
  }

  // ------------------------------------------------------------- logs -----
  onStep('logs');
  await ensureLogBranch(login);

  // ----------------------------------------------------------- verify -----
  onStep('verify');
  if (!(await hasWorkflows(login))) {
    throw new Error(
      'The workflow files did not land in your crucible. This almost always means the forge key ' +
      'is missing the "Workflows: Read and write" permission — GitHub refuses to let a token ' +
      'write to .github/workflows without it. Add it to your key and reload.');
  }

  const state = await inspect(login);
  return { repo: await findCrucible(login), state, created, repaired };
}

// --------------------------------------------------------------- helpers ----

async function headOf(login, branch) {
  try {
    const ref = await gh.get(`/repos/${login}/${NAME}/git/ref/heads/${branch}`, { retries: 1 });
    return ref.object.sha;
  } catch (e) {
    // 409 is GitHub's "Git Repository is empty."
    if (e.status === 404 || e.status === 409) return null;
    throw e;
  }
}

/** Authoritative and immediate, unlike /actions/workflows which lags behind a push. */
async function hasWorkflows(login) {
  for (const path of [BUILD_WORKFLOW, SWEEP_WORKFLOW]) {
    try {
      await gh.get(`/repos/${login}/${NAME}/contents/${path}?ref=main`, { retries: 1 });
    } catch (e) {
      if (e.status === 404 || e.status === 409) return false;
      throw e;
    }
  }
  return true;
}

async function applyPolicy(login) {
  const base = `/repos/${login}/${NAME}/actions/permissions`;
  const attempts = [
    () => gh.put(base, { enabled: true, allowed_actions: 'selected' }),
    () => gh.put(`${base}/selected-actions`, {
      github_owned_allowed: true, verified_allowed: false, patterns: [],
    }),
    () => gh.put(`${base}/workflow`, {
      default_workflow_permissions: 'read', can_approve_pull_request_reviews: false,
    }),
  ];
  for (const a of attempts) {
    // A key without Administration:write can still pour; it just cannot tighten
    // these. Not fatal, and the connect station says so.
    try { await a(); } catch (e) { if (e.status !== 403 && e.status !== 404) throw e; }
  }
}

/**
 * Write every template file as one commit.
 *
 * @param {string|null} parentSha  null only if the repository has no commits at all
 */
export async function writeTemplate(login, parentSha, message, onStep = () => {}) {
  onStep('blobs');

  let blobs;
  try {
    blobs = await pool(TEMPLATE_PATHS, 4, async (path) => {
      const blob = await gh.post(`/repos/${login}/${NAME}/git/blobs`, {
        content: toBase64(enc.encode(TEMPLATE[path])),
        encoding: 'base64',
      });
      return { path, mode: path.endsWith('.sh') ? '100755' : '100644', type: 'blob', sha: blob.sha };
    });
  } catch (e) {
    throw new ApiError(e.status,
      `Uploading the workflow failed (${e.status || 'network'}${e.message ? ': ' + e.message : ''}). ` +
      'Check that your forge key has "Contents: Read and write" on this repository.');
  }

  onStep('commit');

  const tree = await gh.post(`/repos/${login}/${NAME}/git/trees`, {
    ...(parentSha ? { base_tree: await treeOf(login, parentSha) } : {}),
    tree: [...blobs, {
      path: '.thermite-revision',
      mode: '100644', type: 'blob',
      content: TEMPLATE_REVISION + '\n',
    }],
  });

  const commit = await gh.post(`/repos/${login}/${NAME}/git/commits`, {
    message,
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
  });

  try {
    if (parentSha) {
      await gh.patch(`/repos/${login}/${NAME}/git/refs/heads/main`, { sha: commit.sha, force: false });
    } else {
      try {
        await gh.post(`/repos/${login}/${NAME}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha });
      } catch (e) {
        // The ref appeared underneath us — finish with an update instead.
        if (e.status !== 422) throw e;
        await gh.patch(`/repos/${login}/${NAME}/git/refs/heads/main`, { sha: commit.sha, force: false });
      }
    }
  } catch (e) {
    if (e.status === 403 && /workflow/i.test(e.message || '')) {
      throw new ApiError(403,
        'GitHub refused to write .github/workflows to your crucible. Your forge key needs the ' +
        '"Workflows: Read and write" permission — it is separate from Contents and is the one ' +
        'people usually miss. Add it, then reload.');
    }
    throw e;
  }

  return commit.sha;
}

async function treeOf(login, commitSha) {
  const c = await gh.get(`/repos/${login}/${NAME}/git/commits/${commitSha}`);
  return c.tree.sha;
}

async function ensureLogBranch(login) {
  try {
    await gh.get(`/repos/${login}/${NAME}/git/ref/heads/${APP.logBranch}`, { retries: 1 });
    return;
  } catch (e) { if (e.status !== 404 && e.status !== 409) throw e; }

  const tree = await gh.post(`/repos/${login}/${NAME}/git/trees`, {
    tree: [{ path: '.keep', mode: '100644', type: 'blob', content: 'thermite live logs\n' }],
  });
  const commit = await gh.post(`/repos/${login}/${NAME}/git/commits`, {
    message: 'thermite: cold crucible [skip ci]',
    tree: tree.sha,
    parents: [],
  });
  try {
    await gh.post(`/repos/${login}/${NAME}/git/refs`, {
      ref: `refs/heads/${APP.logBranch}`, sha: commit.sha,
    });
  } catch (e) {
    if (e.status !== 422) throw e;   // already created by another tab
  }
}

/** Is this crucible current, and is its scheduled sweep still alive? */
export async function inspect(login) {
  const out = {
    workflowsPresent: false,
    revision: null,
    outdated: false,
    sweepDisabled: false,
    sweepId: null,
    actionsRestricted: null,
  };

  try {
    out.workflowsPresent = await hasWorkflows(login);
  } catch { /* transient; treated as unknown below */ }

  try {
    const rev = await gh.rawFile(login, NAME, '.thermite-revision', 'main');
    out.revision = rev?.text?.trim() || null;
  } catch { /* pre-revision crucible */ }

  // Advisory only: this endpoint lags behind a push, so it must never be the
  // thing that decides whether provisioning succeeded.
  try {
    const wf = await gh.get(`/repos/${login}/${NAME}/actions/workflows`);
    const sweep = (wf.workflows || []).find((w) => w.path.endsWith('cleanup.yml'));
    out.sweepDisabled = sweep?.state === 'disabled_inactivity';
    out.sweepId = sweep?.id || null;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  out.outdated = out.workflowsPresent && out.revision !== TEMPLATE_REVISION;

  try {
    const perms = await gh.get(`/repos/${login}/${NAME}/actions/permissions`);
    out.actionsRestricted = perms.allowed_actions === 'selected';
  } catch { /* needs admin read; not essential */ }

  return out;
}

export async function reline(login) {
  const head = await headOf(login, 'main');
  return writeTemplate(login, head, `thermite: re-line the crucible → ${TEMPLATE_REVISION} [skip ci]`);
}

export async function wakeSweep(login, workflowId) {
  await gh.put(`/repos/${login}/${NAME}/actions/workflows/${workflowId}/enable`, {});
}

export { TEMPLATE_REVISION };
