// THERMITE — authoritative target table.
//
// The website ships an advisory copy of this list. THIS file is the one that
// decides. Anything not present here is refused before a compiler is installed.
//
//   runner   : the GitHub-hosted runner label
//   mode     : 'native' | 'cross'
//   sandbox  : 'uid'   -> compile runs as a separate unprivileged local user
//              'none'  -> compile runs as the runner user (residual risk, see README)
//   apt      : extra Debian packages required for the cross linker
//   linker   : value written to CARGO_TARGET_<TRIPLE>_LINKER
//   ext      : produced binary extension
//   pack     : 'targz' | 'zip'
//   runnable : whether the produced binary can be executed on the runner

export const TARGETS = {
  'x86_64-unknown-linux-gnu': {
    runner: 'ubuntu-latest', mode: 'native', sandbox: 'uid',
    ext: '', pack: 'targz', runnable: true,
    blurb: 'Native Linux, glibc. The default pour.',
  },
  'x86_64-unknown-linux-musl': {
    runner: 'ubuntu-latest', mode: 'cross', sandbox: 'uid',
    apt: ['musl-tools'], linker: 'musl-gcc',
    ext: '', pack: 'targz', runnable: true,
    blurb: 'Static Linux binary. Runs on any distro, no glibc dependency.',
  },
  'aarch64-unknown-linux-gnu': {
    runner: 'ubuntu-latest', mode: 'cross', sandbox: 'uid',
    apt: ['gcc-aarch64-linux-gnu', 'libc6-dev-arm64-cross'],
    linker: 'aarch64-linux-gnu-gcc',
    ext: '', pack: 'targz', runnable: false,
    blurb: 'ARM64 Linux — servers, Raspberry Pi 4/5, Graviton. Cross-compiled.',
  },
  'aarch64-unknown-linux-musl': {
    runner: 'ubuntu-latest', mode: 'cross', sandbox: 'uid',
    apt: ['gcc-aarch64-linux-gnu', 'musl-tools'],
    linker: 'aarch64-linux-gnu-gcc',
    ext: '', pack: 'targz', runnable: false,
    blurb: 'Static ARM64 Linux. Cross-compiled, no runtime glibc.',
  },
  'armv7-unknown-linux-gnueabihf': {
    runner: 'ubuntu-latest', mode: 'cross', sandbox: 'uid',
    apt: ['gcc-arm-linux-gnueabihf', 'libc6-dev-armhf-cross'],
    linker: 'arm-linux-gnueabihf-gcc',
    ext: '', pack: 'targz', runnable: false,
    blurb: 'ARMv7 hard-float — Raspberry Pi 2/3, older SBCs.',
  },
  'x86_64-pc-windows-msvc': {
    runner: 'windows-latest', mode: 'native', sandbox: 'none',
    ext: '.exe', pack: 'zip', runnable: true,
    blurb: 'Native Windows with the MSVC toolchain. The one most Windows users want.',
  },
  'aarch64-pc-windows-msvc': {
    runner: 'windows-latest', mode: 'cross', sandbox: 'none',
    ext: '.exe', pack: 'zip', runnable: false,
    blurb: 'Windows on ARM. Cross-compiled from an x64 runner.',
  },
  'x86_64-pc-windows-gnu': {
    runner: 'ubuntu-latest', mode: 'cross', sandbox: 'uid',
    apt: ['gcc-mingw-w64-x86-64'], linker: 'x86_64-w64-mingw32-gcc',
    ext: '.exe', pack: 'zip', runnable: false,
    blurb: 'Windows binary built on Linux via MinGW. No MSVC runtime needed.',
  },
  'aarch64-apple-darwin': {
    runner: 'macos-latest', mode: 'native', sandbox: 'none',
    ext: '', pack: 'targz', runnable: true,
    blurb: 'Apple silicon. Native on an M-series runner. Unsigned — expect Gatekeeper.',
  },
  'x86_64-apple-darwin': {
    runner: 'macos-latest', mode: 'cross', sandbox: 'none',
    ext: '', pack: 'targz', runnable: false,
    blurb: 'Intel Mac. Cross-compiled from Apple silicon. Unsigned.',
  },
  'wasm32-unknown-unknown': {
    runner: 'ubuntu-latest', mode: 'native', sandbox: 'uid',
    ext: '.wasm', pack: 'targz', runnable: false, wasm: true,
    blurb: 'Bare WebAssembly. No std, no syscalls — for the browser and embedders.',
  },
  'wasm32-wasip1': {
    runner: 'ubuntu-latest', mode: 'native', sandbox: 'uid',
    ext: '.wasm', pack: 'targz', runnable: false, wasm: true,
    blurb: 'WASI preview 1. WebAssembly with files, args and stdio.',
  },
};

// Toolchains older than this do not know the target at all.
export const TARGET_MIN_VERSION = {
  'wasm32-wasip1': '1.78.0',
  'aarch64-apple-darwin': '1.49.0',
  'aarch64-pc-windows-msvc': '1.61.0',
};

export const TOOLCHAIN_RE =
  /^(stable|beta|nightly|nightly-\d{4}-\d{2}-\d{2}|\d+\.\d+(?:\.\d+)?)$/;

export const JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function cmpVersion(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
