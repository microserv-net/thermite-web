// THERMITE — provisioning the crucible.
//
// Creates the user's build repository and lines it with workflows. The seed
// commit deliberately contains no jobs/ path, so it cannot start a build:
// build.yml's path filter rejects it before a run is created, its message
// carries [skip ci], and detect.mjs would find no added manifest anyway.

import { APP } from './config.js';
import { gh, ApiError } from './github.js';
import { TEMPLATE, TEMPLATE_PATHS, TEMPLATE_REVISION } from './workflows.js';
import { sleep, pool, toBase64, enc } from './util.js';

const NAME = APP.repoName;

export const STEPS = [
  ['check',    'Looking for an existing crucible'],
  ['create',   'Creating the repository'],
  ['settle',   'Waiting for GitHub to finish creating it'],
  ['policy',   'Restricting Actions to GitHub-owned actions'],
  ['blobs',    'Uploading the workflow and scripts'],
  ['commit',   'Writing the seed commit'],
  ['logs',     'Opening the live-log branch'],
  ['verify',   'Verifying'],
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
 * @param {string} login
 * @param {(step:string, detail?:string)=>void} onStep
 */
export async function provision(login, onStep = () => {}) {
  onStep('check');
  let repo = await findCrucible(login);

  if (!repo) {
    onStep('create');
    try {
      repo = await gh.post('/user/repos', {
        name: NAME,
        description: 'Thermite build crucible — Rust compilation jobs. Created automatically; safe to delete.',
        homepage: location.origin,
        private: false,
        auto_init: false,        // no initial commit: nothing to trigger
        has_issues: false,
        has_wiki: false,
        has_projects: false,
        has_downloads: true,
      });
    } catch (e) {
      if (e.status === 422 && /already exists/i.test(e.message)) {
        repo = await findCrucible(login);
      } else if (e.status === 403 || e.status === 404) {
        throw new Error(
          'This key cannot create repositories. Add the "Administration: Read and write" ' +
          'permission to it, or create a public repository named "' + NAME + '" yourself ' +
          'and reload.');
      } else throw e;
    }

    onStep('settle');
    for (let i = 0; i < 12 && !(await findCrucible(login)); i++) await sleep(500 + i * 250);
  }

  onStep('policy');
  await applyPolicy(login);

  const head = await currentHead(login);
  if (!head) {
    await writeTemplate(login, null, 'thermite: line the crucible [skip ci]', onStep);
  }

  onStep('logs');
  await ensureLogBranch(login);

  onStep('verify');
  const state = await inspect(login);
  if (!state.workflowsPresent) {
    throw new Error('The crucible was created but the workflow did not land. Try re-lining it.');
  }
  return { repo: await findCrucible(login), state };
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
    // these. Not fatal, and the user is told.
    try { await a(); } catch (e) { if (e.status !== 403 && e.status !== 404) throw e; }
  }
  try {
    await gh.patch(`/repos/${login}/${NAME}`, { delete_branch_on_merge: true });
  } catch { /* cosmetic */ }
}

async function currentHead(login) {
  try {
    const ref = await gh.get(`/repos/${login}/${NAME}/git/ref/heads/main`);
    return ref.object.sha;
  } catch (e) {
    if (e.status === 404 || e.status === 409) return null;   // 409: empty repository
    throw e;
  }
}

/** Write every template file as one commit. Used to seed and to re-line. */
export async function writeTemplate(login, parentSha, message, onStep = () => {}) {
  onStep('blobs');
  const blobs = await pool(TEMPLATE_PATHS, 5, async (path) => {
    const sha = await gh.post(`/repos/${login}/${NAME}/git/blobs`, {
      content: toBase64(enc.encode(TEMPLATE[path])),
      encoding: 'base64',
    });
    return { path, mode: path.endsWith('.sh') ? '100755' : '100644', type: 'blob', sha: sha.sha };
  });

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

  if (parentSha) {
    await gh.patch(`/repos/${login}/${NAME}/git/refs/heads/main`, { sha: commit.sha, force: false });
  } else {
    await gh.post(`/repos/${login}/${NAME}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha });
  }
  return commit.sha;
}

async function treeOf(login, commitSha) {
  const c = await gh.get(`/repos/${login}/${NAME}/git/commits/${commitSha}`);
  return c.tree.sha;
}

async function ensureLogBranch(login) {
  try {
    await gh.get(`/repos/${login}/${NAME}/git/ref/heads/${APP.logBranch}`);
    return;
  } catch (e) { if (e.status !== 404) throw e; }

  const tree = await gh.post(`/repos/${login}/${NAME}/git/trees`, {
    tree: [{ path: '.keep', mode: '100644', type: 'blob', content: 'thermite live logs\n' }],
  });
  const commit = await gh.post(`/repos/${login}/${NAME}/git/commits`, {
    message: 'thermite: cold crucible [skip ci]',
    tree: tree.sha,
    parents: [],
  });
  await gh.post(`/repos/${login}/${NAME}/git/refs`, {
    ref: `refs/heads/${APP.logBranch}`, sha: commit.sha,
  });
}

/** Is this crucible current, and is its scheduled sweep still alive? */
export async function inspect(login) {
  const out = {
    workflowsPresent: false,
    revision: null,
    outdated: false,
    sweepDisabled: false,
    actionsRestricted: null,
  };

  try {
    const rev = await gh.rawFile(login, NAME, '.thermite-revision', 'main');
    out.revision = rev?.text?.trim() || null;
  } catch { /* pre-revision crucible */ }

  try {
    const wf = await gh.get(`/repos/${login}/${NAME}/actions/workflows`);
    const files = (wf.workflows || []).map((w) => w.path);
    out.workflowsPresent =
      files.includes('.github/workflows/build.yml') &&
      files.includes('.github/workflows/cleanup.yml');
    const sweep = (wf.workflows || []).find((w) => w.path.endsWith('cleanup.yml'));
    out.sweepDisabled = sweep?.state === 'disabled_inactivity';
    out.sweepId = sweep?.id;
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
  const head = await currentHead(login);
  return writeTemplate(login, head, `thermite: re-line the crucible → ${TEMPLATE_REVISION} [skip ci]`);
}

export async function wakeSweep(login, workflowId) {
  await gh.put(`/repos/${login}/${NAME}/actions/workflows/${workflowId}/enable`, {});
}

export { TEMPLATE_REVISION };
