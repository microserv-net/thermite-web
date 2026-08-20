// THERMITE — choosing a repository as the source.
//
// A pour can carry its source or name it. This module handles naming it: which
// repositories are available, where in one the build root is, and whether that
// folder actually contains something Rust.
//
// Nothing is downloaded here. A named repository is fetched by the runner at
// build time, so a 400 MB monorepo costs the browser one tree listing rather
// than an upload. The pour commit holds a manifest and nothing else.

import { gh } from './github.js';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export class RepoError extends Error {}

/**
 * The signed-in account's repositories, newest activity first.
 *
 * GitHub reports a repository's dominant `language`, so filtering to Rust is a
 * real filter rather than a guess — the same one the repository list on
 * github.com shows. It is only a dominant language, though, so a Rust crate
 * inside a mostly-TypeScript repository will not appear; hence the toggle.
 */
export async function listMine({ rustOnly = true } = {}) {
  const repos = await gh.paginate('/user/repos?per_page=100&sort=pushed&affiliation=owner', { max: 300 });

  return repos
    .filter((r) => !r.archived && !r.disabled)
    .map((r) => ({
      full: r.full_name,
      owner: r.owner?.login,
      name: r.name,
      description: r.description || '',
      language: r.language || null,
      isRust: r.language === 'Rust',
      private: !!r.private,
      fork: !!r.fork,
      defaultBranch: r.default_branch || 'main',
      pushedAt: r.pushed_at,
      size: r.size,
    }))
    .filter((r) => (rustOnly ? r.isRust : true));
}

/** Resolve `owner/name` typed by hand. Public only — see whyPublicOnly(). */
export async function resolve(input) {
  const text = String(input || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  const parts = text.split('/');
  if (parts.length !== 2 || !OWNER_RE.test(parts[0]) || !REPO_RE.test(parts[1])) {
    throw new RepoError('Give it as owner/repository — for example `rust-lang/rustlings`.');
  }

  let repo;
  try {
    repo = await gh.repo(parts[0], parts[1]);
  } catch (e) {
    if (e.status === 404) {
      throw new RepoError(
        `${parts[0]}/${parts[1]} does not exist, or is private. Thermite builds public ` +
        'repositories only — the runner carries no credential that could reach a private one.');
    }
    throw e;
  }

  if (repo.private) throw new RepoError(whyPublicOnly(repo.full_name));

  return {
    full: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    description: repo.description || '',
    language: repo.language || null,
    isRust: repo.language === 'Rust',
    private: false,
    defaultBranch: repo.default_branch || 'main',
    pushedAt: repo.pushed_at,
    size: repo.size,
  };
}

export function whyPublicOnly(full) {
  return `${full} is private. Thermite builds public repositories only: the fetch on the runner ` +
    'is anonymous, and the only token there is scoped to your crucible. Giving a build wider ' +
    'access to make this work would widen what any submitted code can touch. Upload the project ' +
    'instead, and use an encrypted pour if it must not sit in the open.';
}

/** Branches and tags, for pinning a pour to something other than the default. */
export async function refsOf(owner, name) {
  const [branches, tags] = await Promise.all([
    gh.paginate(`/repos/${owner}/${name}/branches?per_page=100`, { max: 100 }).catch(() => []),
    gh.paginate(`/repos/${owner}/${name}/tags?per_page=100`, { max: 100 }).catch(() => []),
  ]);
  return {
    branches: branches.map((b) => b.name),
    tags: tags.map((t) => t.name),
  };
}

/**
 * One directory level, for the navigator.
 * @returns {{dirs:{name,path}[], files:string[], hasCargo:boolean, rustFiles:string[]}}
 */
export async function browse(owner, name, ref, path = '') {
  let entries;
  try {
    entries = await gh.get(
      `/repos/${owner}/${name}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
      { etag: true });
  } catch (e) {
    if (e.status === 404) throw new RepoError(`There is no "${path || '/'}" in ${owner}/${name} at ${ref}.`);
    throw e;
  }
  if (!Array.isArray(entries)) throw new RepoError(`"${path}" is a file, not a folder.`);

  const dirs = entries.filter((e) => e.type === 'dir')
    .map((e) => ({ name: e.name, path: e.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => e.type === 'file').map((e) => e.name);

  return {
    dirs,
    files,
    hasCargo: files.includes('Cargo.toml'),
    hasLock: files.includes('Cargo.lock'),
    rustFiles: files.filter((f) => f.endsWith('.rs')),
  };
}

/**
 * Every Cargo.toml in the repository, so the common case is one click rather
 * than a walk down the tree.
 *
 * The recursive tree endpoint is one request but truncates on very large
 * repositories. When it does, the navigator is the answer and this returns
 * `truncated: true` so the interface can say so instead of implying the repo
 * has no crates.
 */
export async function findCrates(owner, name, ref) {
  let tree;
  try {
    tree = await gh.get(
      `/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { etag: true });
  } catch (e) {
    if (e.status === 404 || e.status === 409) return { crates: [], truncated: false };
    throw e;
  }

  const paths = (tree.tree || [])
    .filter((n) => n.type === 'blob' && (n.path === 'Cargo.toml' || n.path.endsWith('/Cargo.toml')))
    .map((n) => (n.path === 'Cargo.toml' ? '' : n.path.slice(0, -'/Cargo.toml'.length)))
    // Skip vendored and example trees: they are Cargo.tomls, but nobody means them.
    .filter((p) => !/(^|\/)(target|vendor|node_modules|\.cargo)(\/|$)/.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  return { crates: paths.slice(0, 60), truncated: !!tree.truncated };
}

/** What will actually be built from a chosen folder. */
export async function inspectFolder(owner, name, ref, path) {
  const level = await browse(owner, name, ref, path);
  if (level.hasCargo) {
    return { ok: true, projectType: 'cargo', why: 'Cargo.toml found — `cargo build --release`.', level };
  }
  if (level.rustFiles.length === 1) {
    return {
      ok: true, projectType: 'single',
      why: `No Cargo.toml, but one .rs file (${level.rustFiles[0]}) — compiled with rustc.`,
      level,
    };
  }
  return {
    ok: false,
    projectType: null,
    why: level.rustFiles.length
      ? `No Cargo.toml here, and ${level.rustFiles.length} .rs files — Thermite cannot tell which one is the program. Pick a folder with a Cargo.toml.`
      : 'No Cargo.toml and no .rs files here. Pick the folder that holds the crate you want built.',
    level,
  };
}
