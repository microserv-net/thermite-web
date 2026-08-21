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
  // The repository root is `/contents`, with NO trailing slash. Building it as
  // `/contents/${path}` and letting path be empty produces `/contents/?ref=…`,
  // which is not the same request — and it is what made a root Cargo.toml
  // invisible. Each segment is encoded individually, because encodeURI leaves
  // `?` and `#` intact and a branch or folder containing either would escape
  // the path.
  const clean = String(path || '').replace(/^\/+|\/+$/g, '');
  const url = clean
    ? `/repos/${owner}/${name}/contents/${clean.split('/').map(encodeURIComponent).join('/')}` +
      `?ref=${encodeURIComponent(ref)}`
    : `/repos/${owner}/${name}/contents?ref=${encodeURIComponent(ref)}`;

  let entries;
  try {
    entries = await gh.get(url, { etag: true });
  } catch (e) {
    if (e.status === 404) throw new RepoError(`There is no "${clean || 'repository root'}" in ${owner}/${name} at ${ref}.`);
    throw e;
  }
  if (!Array.isArray(entries)) throw new RepoError(`"${clean}" is a file, not a folder.`);

  const dirs = entries.filter((e) => e.type === 'dir')
    .map((e) => ({ name: e.name, path: e.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => e.type === 'file').map((e) => e.name);

  return {
    dirs,
    files,
    entries: entries.length,
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

/**
 * What will actually be built from a chosen folder.
 *
 * Two independent sources agree or they do not: the directory listing, and the
 * recursive tree that found every Cargo.toml in the repository. Either alone can
 * come back thin — the tree truncates on large repositories, and a listing can
 * fail in ways that look like an empty folder — so a crate the tree knows about
 * is trusted even if the listing did not show it.
 *
 * @param {string[]|null} knownCrates  paths from findCrates(), if it ran
 */
export async function inspectFolder(owner, name, ref, path, knownCrates = null) {
  const level = await browse(owner, name, ref, path);
  const here = String(path || '').replace(/^\/+|\/+$/g, '');
  const treeSaysCrate = Array.isArray(knownCrates) && knownCrates.includes(here);

  const where = here || 'the repository root';
  const counted = `${level.entries} item${level.entries === 1 ? '' : 's'} listed` +
    ` (${level.dirs.length} folder${level.dirs.length === 1 ? '' : 's'}, ${level.files.length} file${level.files.length === 1 ? '' : 's'})`;

  if (level.hasCargo || treeSaysCrate) {
    return {
      ok: true, projectType: 'cargo', level,
      why: level.hasCargo
        ? 'Cargo.toml found — `cargo build --release`.'
        : 'Cargo.toml found in the repository tree — `cargo build --release`.',
    };
  }

  if (level.rustFiles.length === 1) {
    return {
      ok: true, projectType: 'single', level,
      why: `No Cargo.toml, but one .rs file (${level.rustFiles[0]}) — compiled with rustc.`,
    };
  }

  // An empty listing is a different problem from a folder with the wrong
  // contents, and saying so is the difference between a fixable report and a
  // confusing one.
  if (!level.entries) {
    return {
      ok: false, projectType: null, level,
      why: `GitHub returned an empty listing for ${where} at "${ref}". If the folder is not empty, the ref may be wrong.`,
    };
  }

  return {
    ok: false, projectType: null, level,
    why: level.rustFiles.length
      ? `No Cargo.toml in ${where}, and ${level.rustFiles.length} .rs files — Thermite cannot tell which one is the program. Pick a folder with a Cargo.toml. ${counted}.`
      : `No Cargo.toml and no .rs files in ${where}. Pick the folder that holds the crate you want built. ${counted}.`,
  };
}

/**
 * Read the Cargo.toml of a chosen folder, so the interface can say what will
 * actually be built rather than only that something will be.
 *
 * Deliberately shallow parsing: enough to name the package, spot a workspace,
 * and count explicit binary targets. A real TOML parser is not worth shipping
 * for four fields, and getting one of them wrong costs a label, not a build.
 */
export async function readManifest(owner, name, ref, dir = '') {
  const clean = String(dir || '').replace(/^\/+|\/+$/g, '');
  const path = clean ? `${clean}/Cargo.toml` : 'Cargo.toml';

  let text;
  try {
    const res = await gh.rawFile(owner, name, path, ref);
    text = res?.text;
  } catch { return null; }
  if (!text) return null;

  return parseManifest(text);
}

/**
 * Walk the file a line at a time rather than trying to carve sections out with
 * one regex. A lookahead for "the next section header or the end" is a trap
 * under the multiline flag, where `$` matches the end of every LINE — so the
 * first attempt captured nothing and every package name came back null.
 */
export function parseManifest(text) {
  const sections = new Map();
  const arrays = new Map();
  let current = null;
  let bins = 0;

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s*#.*$/, '').trim();
    if (!line) continue;

    const double = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (double) { current = null; if (double[1].trim() === 'bin') bins++; continue; }

    const single = /^\[([^\]]+)\]$/.exec(line);
    if (single) {
      current = single[1].trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }

  const body = (head) => (sections.get(head) || []).join('\n');
  const field = (head, key) =>
    new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(body(head))?.[1] || null;

  const workspace = sections.has('workspace');
  const hasPackage = (sections.get('package') || []).length > 0;

  // members may run over several lines, so it is read from the raw text.
  const members = workspace
    ? (/^\s*members\s*=\s*\[([\s\S]*?)\]/m.exec(text)?.[1] || '')
        .split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    : [];

  return {
    name: field('package', 'name'),
    version: field('package', 'version'),
    edition: field('package', 'edition'),
    isWorkspace: workspace,
    isVirtualWorkspace: workspace && !hasPackage,
    members,
    bins,
    hasLib: sections.has('lib'),
    deps: (sections.get('dependencies') || []).filter((l) => /^[A-Za-z0-9_-]+\s*=/.test(l)).length,
  };
}
