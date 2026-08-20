// THERMITE — ZIP reader.
//
// No library. The archive is read in memory and each entry is turned into a
// git tree path, never a filesystem path, so directory traversal has nowhere
// to land. Every entry is still checked, because "it cannot happen" is not a
// security control.

import { LIMITS } from './config.js';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CD = 0x02014b50;

export class ZipError extends Error {}

const SKIP = [
  /^__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/,
  /(^|\/)\.git\//, /(^|\/)target\//, /(^|\/)node_modules\//,
  /(^|\/)\.idea\//, /(^|\/)\.vscode\//,
];

export function pathProblem(p) {
  if (!p) return 'empty path';
  if (p.length > LIMITS.pathLength) return 'path is too long';
  if (p.split('/').length > LIMITS.pathDepth) return 'path is nested too deeply';
  if (p.includes('\\')) return 'backslash in path';
  if (/[\x00-\x1f\x7f]/.test(p)) return 'control character in path';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute path';
  if (p.includes('//')) return 'malformed path';
  if (p.split('/').some((s) => s === '..' || s === '.')) return 'path escapes the project';
  if (!/^[A-Za-z0-9._\/-]+$/.test(p)) return 'path contains characters the build refuses';
  if (p === '.github' || p.startsWith('.github/') || p.includes('/.github/')) {
    return 'a project may not carry .github/ — workflows are Thermite\u2019s, not the project\u2019s';
  }
  return null;
}

/**
 * @returns {Promise<{files: {path:string, bytes:Uint8Array}[], skipped:string[], stripped:string|null}>}
 */
export async function readZip(buffer) {
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  if (buffer.byteLength > LIMITS.zipBytes) {
    throw new ZipError(`That archive is ${(buffer.byteLength / 1048576).toFixed(1)} MiB. The ceiling is ${LIMITS.zipBytes / 1048576} MiB.`);
  }
  if (buffer.byteLength < 22) throw new ZipError('That file is too small to be a zip archive.');

  // --- End of central directory -------------------------------------------
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('This is not a zip archive, or it is truncated.');

  let count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && view.getUint32(loc, true) === SIG_EOCD64_LOC) {
      const z64 = Number(view.getBigUint64(loc + 8, true));
      count = Number(view.getBigUint64(z64 + 32, true));
      cdOffset = Number(view.getBigUint64(z64 + 48, true));
    } else {
      throw new ZipError('This archive uses Zip64 in a form Thermite cannot read. Re-zip it with standard settings.');
    }
  }

  if (count > LIMITS.fileCount * 2) {
    throw new ZipError(`The archive declares ${count} entries. The ceiling is ${LIMITS.fileCount}.`);
  }

  // --- Central directory ---------------------------------------------------
  const entries = [];
  let p = cdOffset;
  const td = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.byteLength || view.getUint32(p, true) !== SIG_CD) {
      throw new ZipError('The archive\u2019s directory is damaged.');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const rawSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const externalAttr = view.getUint32(p + 38, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new ZipError('The archive is encrypted. Thermite cannot read it.');
    if (rawSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('Zip64 entry sizes are not supported. Re-zip with standard settings.');
    }
    // High 4 bits of the unix mode: 0xA000 is a symlink, 0x8000 a regular file.
    const unixMode = externalAttr >>> 16;
    const isSymlink = (unixMode & 0xf000) === 0xa000;
    entries.push({ name, method, compSize, rawSize, localOffset, isSymlink, isDir: name.endsWith('/') });
  }

  // --- Strip a single wrapping directory ----------------------------------
  const real = entries.filter((e) => !e.isDir && !SKIP.some((r) => r.test(e.name)));
  let stripped = null;
  const tops = new Set(real.map((e) => e.name.split('/')[0]));
  if (tops.size === 1 && real.every((e) => e.name.includes('/'))) {
    stripped = [...tops][0];
  }

  // --- Inflate -------------------------------------------------------------
  const files = [];
  const skipped = [];
  let total = 0;

  for (const e of entries) {
    if (e.isDir) continue;
    if (SKIP.some((r) => r.test(e.name))) { skipped.push(e.name); continue; }
    if (e.isSymlink) throw new ZipError(`"${e.name}" is a symbolic link. Thermite does not accept links in a project.`);

    const path = stripped ? e.name.slice(stripped.length + 1) : e.name;
    const bad = pathProblem(path);
    if (bad) throw new ZipError(`"${e.name}": ${bad}.`);

    if (e.rawSize > LIMITS.perFileBytes) {
      throw new ZipError(`"${path}" is ${(e.rawSize / 1048576).toFixed(1)} MiB, over the ${LIMITS.perFileBytes / 1048576} MiB per-file ceiling.`);
    }
    total += e.rawSize;
    if (total > LIMITS.inflatedBytes) {
      throw new ZipError(`The project expands past ${LIMITS.inflatedBytes / 1048576} MiB. Trim it, or remove build output before zipping.`);
    }
    if (files.length >= LIMITS.fileCount) {
      throw new ZipError(`More than ${LIMITS.fileCount} files. Remove target/ and any vendored dependencies.`);
    }

    // Local header: the name and extra lengths here can differ from the
    // central directory's, so they must be read again.
    const lo = e.localOffset;
    if (view.getUint32(lo, true) !== 0x04034b50) throw new ZipError(`"${path}" is not where the archive says it is.`);
    const lNameLen = view.getUint16(lo + 26, true);
    const lExtraLen = view.getUint16(lo + 28, true);
    const start = lo + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(start, start + e.compSize);

    let bytes;
    if (e.method === 0) bytes = raw.slice();
    else if (e.method === 8) bytes = await inflateRaw(raw, path);
    else throw new ZipError(`"${path}" uses compression method ${e.method}, which Thermite cannot read. Re-zip with Deflate.`);

    if (bytes.length !== e.rawSize) {
      throw new ZipError(`"${path}" does not match its declared size. The archive is corrupt.`);
    }
    files.push({ path, bytes });
  }

  if (!files.length) throw new ZipError('The archive contains no usable files.');
  return { files, skipped, stripped };
}

async function inflateRaw(raw, path) {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('This browser cannot decompress zip archives. Try a current Chrome, Edge, Firefox or Safari.');
  }
  try {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new ZipError(`"${path}" could not be decompressed. The archive is likely corrupt.`);
  }
}

/** Sanity: does this look like a cargo project? */
export function inspectProject(files) {
  const names = files.map((f) => f.path);
  const root = names.includes('Cargo.toml');
  const nested = names.filter((n) => n.endsWith('Cargo.toml'));
  const rs = names.filter((n) => n.endsWith('.rs'));
  let pkgName = null;
  if (root) {
    const toml = new TextDecoder().decode(files.find((f) => f.path === 'Cargo.toml').bytes);
    const m = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(toml);
    if (m) pkgName = m[1];
    if (/^\s*\[workspace\]/m.test(toml) && !/^\s*\[package\]/m.test(toml)) {
      pkgName = pkgName || 'workspace';
    }
  }
  return {
    hasCargoToml: root,
    nestedCargoToml: !root && nested.length ? nested[0] : null,
    hasLock: names.includes('Cargo.lock'),
    rustFiles: rs.length,
    packageName: pkgName,
  };
}
