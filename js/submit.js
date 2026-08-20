// THERMITE — submitting a pour.
//
// One pour becomes exactly one commit. That is the invariant the whole build
// side depends on, so the tree is assembled first and pushed in a single
// ref update, using GitHub's own compare-and-swap to resolve races.

import { APP, LIMITS, TARGETS } from './config.js';
import { gh } from './github.js';
import { ulid, toBase64, enc, treeHash, quickHash, pool, sleep, backoff } from './util.js';
import { pathProblem } from './unzip.js';
import { seal, packCharge, importPublicPem } from './crypto.js';

const NAME = APP.repoName;
const LEDGER = 'thermite.ledger';

// ------------------------------------------------------------- throttle -----

function ledger() {
  try { return JSON.parse(localStorage.getItem(LEDGER) || '[]'); } catch { return []; }
}
function recordPour(entry) {
  const l = ledger().filter((e) => Date.now() - e.at < 3 * 3600_000);
  l.push(entry);
  try { localStorage.setItem(LEDGER, JSON.stringify(l)); } catch {}
}

/**
 * Client-side throttle, reconciled against the crucible's real commit history
 * so that clearing storage does not reset it. Advisory by nature: the only
 * quota at risk is the user's own.
 */
export async function throttleCheck(login) {
  const local = ledger().filter((e) => Date.now() - e.at < 3600_000);
  let remote = 0;
  try {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const commits = await gh.get(
      `/repos/${login}/${NAME}/commits?since=${since}&per_page=100`, { etag: true });
    remote = (commits || []).filter((c) => /^pour [0-9A-HJKMNP-TV-Z]{26}/.test(c.commit.message)).length;
  } catch { /* offline or 404: fall back to the local count */ }

  const used = Math.max(local.length, remote);
  return {
    used,
    limit: LIMITS.poursPerHour,
    ok: used < LIMITS.poursPerHour,
    message: used < LIMITS.poursPerHour ? null
      : `That is ${used} pours in the last hour. Thermite caps it at ${LIMITS.poursPerHour} so a runaway loop cannot eat your Actions quota. Try again shortly.`,
  };
}

export function duplicateCheck(hash) {
  const recent = ledger().find((e) => e.hash === hash && Date.now() - e.at < LIMITS.duplicateWindowMs);
  return recent || null;
}

// ------------------------------------------------------------- validate -----

export function validateSelection({ toolchain, target, projectType, files }) {
  const problems = [];
  const spec = TARGETS.find((t) => t.triple === target);
  if (!spec) problems.push(`"${target}" is not a target Thermite supports.`);
  if (!/^(stable|beta|nightly|nightly-\d{4}-\d{2}-\d{2}|\d+\.\d+(\.\d+)?)$/.test(toolchain || '')) {
    problems.push(`"${toolchain}" is not a toolchain Thermite recognises.`);
  }
  if (spec?.cargoOnly && projectType === 'single') {
    problems.push(`${spec.label} needs a cargo project. A lone .rs file cannot be linked for this target.`);
  }
  if (spec?.minVersion && /^\d/.test(toolchain)) {
    const cmp = (a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
      return 0;
    };
    if (cmp(toolchain, spec.minVersion) < 0) {
      problems.push(`${spec.label} needs Rust ${spec.minVersion} or newer. You picked ${toolchain}.`);
    }
  }
  if (!files?.length) problems.push('Nothing to compile yet.');
  for (const f of files || []) {
    const bad = pathProblem(f.path);
    if (bad) problems.push(`"${f.path}": ${bad}.`);
  }
  return problems;
}

// --------------------------------------------------------------- submit -----

/**
 * @param {object} p
 * @param {string} p.login
 * @param {string} p.toolchain
 * @param {string} p.target
 * @param {'single'|'cargo'} p.projectType
 * @param {string} p.name
 * @param {{path:string, bytes:Uint8Array}[]} p.files   paths relative to source/
 * @param {{sourcePem?:string, artifactKeyId?:string}} [p.encrypt]  sealed pour
 * @param {{policy?:string, onFailure?:string}} [p.cleanup]
 * @param {(stage:string, detail?:any)=>void} p.onStage
 */
export async function submit({
  login, toolchain, target, projectType, name, files,
  encrypt = null, cleanup = null, onStage = () => {},
}) {
  const problems = validateSelection({ toolchain, target, projectType, files });
  if (problems.length) { const e = new Error(problems[0]); e.problems = problems; throw e; }

  const id = ulid();

  // Deduplication runs on the plaintext, because a sealed charge is different
  // bytes every time by design. It uses a non-cryptographic hash so that it
  // keeps working where SubtleCrypto is withheld — a dedupe check is a
  // convenience, not a security control.
  const plainHash = quickHash(files.map((f) => ({ path: `source/${f.path}`, bytes: f.bytes })));

  let scoped;
  let encryption = null;
  if (encrypt?.sourcePem) {
    onStage('sealing');
    const recipient = await importPublicPem(encrypt.sourcePem);
    const container = await seal(packCharge(files), recipient, {
      purpose: 'source', jobId: id, note: `thermite charge · ${files.length} file(s)`,
    });
    scoped = [{ path: 'source.tenc', bytes: container }];
    encryption = {
      source: { keyId: recipient.keyId },
      ...(encrypt.artifactKeyId ? { artifact: { keyId: encrypt.artifactKeyId } } : {}),
    };
  } else {
    scoped = files.map((f) => ({ path: `source/${f.path}`, bytes: f.bytes }));
    if (encrypt?.artifactKeyId) encryption = { artifact: { keyId: encrypt.artifactKeyId } };
  }

  // Null when SubtleCrypto is unavailable. The workflow only verifies the tree
  // hash `if (manifest.treeHash)`, so omitting it costs the tamper check and
  // nothing else — a plain pour still builds. Encryption, which genuinely
  // cannot proceed without Web Crypto, has already been refused above.
  const hash = await treeHash(scoped);

  const dupe = duplicateCheck(plainHash);
  if (dupe) {
    const e = new Error(`You poured exactly this ${Math.round((Date.now() - dupe.at) / 1000)}s ago as ${dupe.id}.`);
    e.duplicateOf = dupe.id;
    throw e;
  }

  const throttle = await throttleCheck(login);
  if (!throttle.ok) throw new Error(throttle.message);

  const bytes = scoped.reduce((n, f) => n + f.bytes.length, 0);
  const manifest = {
    schema: 1,
    id,
    toolchain,
    target,
    projectType,
    name: (name || 'pour').slice(0, 64).replace(/[^A-Za-z0-9._ -]/g, '_'),
    entry: encryption?.source
      ? ''    // not knowable from outside the container; unseal.mjs resolves it
      : (projectType === 'cargo' ? 'source/Cargo.toml'
        : `source/${files.find((f) => f.path.endsWith('.rs')).path}`),
    submittedAt: new Date().toISOString(),
    client: `thermite-web/${APP.version}`,
    files: scoped.length,
    bytes,
    ...(hash ? { treeHash: hash } : {}),
    ...(encryption ? { encryption } : {}),
    ...(cleanup ? { cleanup } : {}),
  };

  // --- blobs -------------------------------------------------------------
  onStage('blobs', { total: scoped.length + 1, done: 0 });
  let done = 0;
  const entries = await pool(scoped, 6, async (f) => {
    const blob = await gh.post(`/repos/${login}/${NAME}/git/blobs`, {
      content: toBase64(f.bytes), encoding: 'base64',
    });
    onStage('blobs', { total: scoped.length + 1, done: ++done });
    return { path: `jobs/${id}/${f.path}`, mode: '100644', type: 'blob', sha: blob.sha };
  });

  const manifestBlob = await gh.post(`/repos/${login}/${NAME}/git/blobs`, {
    content: toBase64(enc.encode(JSON.stringify(manifest, null, 2) + '\n')), encoding: 'base64',
  });
  onStage('blobs', { total: scoped.length + 1, done: ++done });
  entries.push({ path: `jobs/${id}/manifest.json`, mode: '100644', type: 'blob', sha: manifestBlob.sha });

  // --- tree + commit + compare-and-swap ----------------------------------
  onStage('commit');
  let commitSha = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = await gh.get(`/repos/${login}/${NAME}/git/ref/heads/main`);
    const parent = ref.object.sha;
    const base = (await gh.get(`/repos/${login}/${NAME}/git/commits/${parent}`)).tree.sha;

    const tree = await gh.post(`/repos/${login}/${NAME}/git/trees`, { base_tree: base, tree: entries });
    const commit = await gh.post(`/repos/${login}/${NAME}/git/commits`, {
      message: `pour ${id} · ${toolchain} · ${target}`,
      tree: tree.sha,
      parents: [parent],
    });

    try {
      // force:false makes this a compare-and-swap. If another tab or machine
      // landed a pour since we read the ref, this fails and we rebuild on the
      // new parent — both pours survive, as two commits and two runs.
      await gh.patch(`/repos/${login}/${NAME}/git/refs/heads/main`,
        { sha: commit.sha, force: false });
      commitSha = commit.sha;
      break;
    } catch (e) {
      if (e.status === 422 || e.status === 409) {
        onStage('contended', { attempt: attempt + 1 });
        await sleep(backoff(attempt, 250, 3000));
        continue;
      }
      throw e;
    }
  }
  if (!commitSha) throw new Error('Another pour kept landing first. Try once more.');

  recordPour({ id, hash: plainHash, at: Date.now() });
  onStage('committed', { commitSha });

  return { id, commitSha, manifest };
}
