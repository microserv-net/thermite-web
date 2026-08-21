// THERMITE — configuration.
//
// Nothing secret lives here and nothing secret ever will. The only identifier
// is a public OAuth client id, and it is optional.

export const APP = {
  name: 'Thermite',
  version: '1.0.0',
  repoName: 'thermite-crucible',
  logBranch: 'crucible-logs',
  userAgent: 'thermite-web/1.0.0',
};

// Leave RELAY_URL empty and Thermite runs with zero infrastructure: the only
// sign-in offered is a fine-grained token you create yourself.
// Set it to a deployed relay (see relay/worker.js) to enable "Sign in with
// GitHub" via the device flow. CLIENT_ID is public by design.
export const OAUTH = {
  RELAY_URL: '',
  CLIENT_ID: '',
};

export const LIMITS = {
  singleFileBytes: 512 * 1024,
  zipBytes: 12 * 1024 * 1024,
  inflatedBytes: 64 * 1024 * 1024,
  fileCount: 1200,
  perFileBytes: 8 * 1024 * 1024,
  pathLength: 200,
  pathDepth: 24,
  poursPerHour: 12,
  inFlight: 3,
  duplicateWindowMs: 60_000,
};

// Poll cadences, in ms. Two separate clocks, because the log changes constantly
// and the run's status barely changes at all — fetching both together meant the
// log could only ever be as fresh as the slowest thing it was bundled with.
//
// Fast log polling is affordable because every request carries an ETag, and a
// 304 does not count against the REST rate limit. An unchanged log is free to
// ask about; only a log that actually grew costs anything.
export const POLL = {
  logHot: 800,      // the log grew on the last look — stay close to it
  logWarm: 1_800,   // building, but quiet for a moment
  logIdle: 4_000,   // queued, or nothing has moved in a while
  logHidden: 15_000, // tab is in the background: nobody is reading it

  runQueued: 2_500, // waiting to start is when run state actually changes
  runBuilding: 6_000,
  runSettling: 1_200, // just finished: the artifact and release land shortly after

  tick: 200,        // scheduler granularity
  hotFor: 4_000,    // how long growth keeps the log in its hot cadence

  slowFactor: 2,    // applied when the rate-limit budget gets thin
  budgetWarn: 1000,
  budgetStop: 300,
};

// Advisory copy of the workflow's authoritative table. If these ever disagree,
// the workflow wins and the pour is refused with a clear reason.
export const TARGETS = [
  { triple: 'x86_64-unknown-linux-gnu', label: 'Linux · x86-64', family: 'linux',
    mode: 'native', runner: 'ubuntu-latest', sandbox: true, pack: 'tar.gz',
    blurb: 'Glibc Linux on 64-bit Intel/AMD. Built natively. The default pour, and the fastest.' },
  { triple: 'x86_64-unknown-linux-musl', label: 'Linux · x86-64 · static', family: 'linux',
    mode: 'cross', runner: 'ubuntu-latest', sandbox: true, pack: 'tar.gz',
    blurb: 'Statically linked against musl. One file, no glibc, runs on any distro including Alpine.' },
  { triple: 'aarch64-unknown-linux-gnu', label: 'Linux · ARM64', family: 'linux',
    mode: 'cross', runner: 'ubuntu-latest', sandbox: true, pack: 'tar.gz',
    blurb: 'ARM64 servers, Graviton, Raspberry Pi 4 and 5. Cross-compiled with the GNU toolchain.' },
  { triple: 'aarch64-unknown-linux-musl', label: 'Linux · ARM64 · static', family: 'linux',
    mode: 'cross', runner: 'ubuntu-latest', sandbox: true, pack: 'tar.gz',
    blurb: 'Static ARM64. Ideal for scratch containers and embedded Linux.' },
  { triple: 'armv7-unknown-linux-gnueabihf', label: 'Linux · ARMv7', family: 'linux',
    mode: 'cross', runner: 'ubuntu-latest', sandbox: true, pack: 'tar.gz',
    blurb: 'Hard-float 32-bit ARM. Raspberry Pi 2 and 3, and a lot of industrial hardware.' },
  { triple: 'x86_64-pc-windows-msvc', label: 'Windows · x86-64', family: 'windows',
    mode: 'native', runner: 'windows-latest', sandbox: false, pack: 'zip',
    blurb: 'Native Windows with the MSVC toolchain — what most Windows users actually want.' },
  { triple: 'aarch64-pc-windows-msvc', label: 'Windows · ARM64', family: 'windows',
    mode: 'cross', runner: 'windows-latest', sandbox: false, pack: 'zip', minVersion: '1.61.0',
    blurb: 'Windows on ARM. Cross-compiled from an x64 runner, so it is built but not run.' },
  { triple: 'x86_64-pc-windows-gnu', label: 'Windows · x86-64 · MinGW', family: 'windows',
    mode: 'cross', runner: 'ubuntu-latest', sandbox: true, pack: 'zip',
    blurb: 'A Windows executable built on Linux via MinGW. No MSVC runtime required.' },
  { triple: 'aarch64-apple-darwin', label: 'macOS · Apple silicon', family: 'macos',
    mode: 'native', runner: 'macos-latest', sandbox: false, pack: 'tar.gz', minVersion: '1.49.0',
    blurb: 'Native on an M-series runner. Unsigned and unnotarised — Gatekeeper will ask.' },
  { triple: 'x86_64-apple-darwin', label: 'macOS · Intel', family: 'macos',
    mode: 'cross', runner: 'macos-latest', sandbox: false, pack: 'tar.gz',
    blurb: 'Intel Macs, cross-compiled from Apple silicon. Unsigned.' },
  { triple: 'wasm32-unknown-unknown', label: 'WebAssembly · bare', family: 'wasm',
    mode: 'native', runner: 'ubuntu-latest', sandbox: true, pack: 'tar.gz', cargoOnly: true,
    blurb: 'No std, no syscalls, no host. For the browser and for embedders. Needs a cargo project.' },
  { triple: 'wasm32-wasip1', label: 'WebAssembly · WASI', family: 'wasm',
    mode: 'native', runner: 'ubuntu-latest', sandbox: true, pack: 'tar.gz',
    cargoOnly: true, minVersion: '1.78.0',
    blurb: 'WASI preview 1 — WebAssembly that can see files, args and stdio. Wasmtime, Wasmer, wasmCloud.' },
];

export const CHANNELS = [
  { name: 'stable',  blurb: 'The current release. Whatever is stable on the day you pour.' },
  { name: 'beta',    blurb: 'Next release, six weeks early. Useful for catching breakage before it lands.' },
  { name: 'nightly', blurb: 'Today\u2019s nightly. Unstable features, and occasionally an unstable compiler.' },
];

// Rust ships every six weeks from 1.0 on 2015-05-15. Deriving the list means it
// never goes stale, and it is reconciled against the live release feed on load.
export function derivedVersions(now = new Date()) {
  const EPOCH = Date.UTC(2015, 4, 15);
  const SIX_WEEKS = 42 * 86400_000;
  const n = Math.floor((now.getTime() - EPOCH) / SIX_WEEKS);
  const out = [];
  for (let i = n; i > n - 14 && i >= 0; i--) out.push(`1.${i}.0`);
  return out;
}
