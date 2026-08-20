#!/usr/bin/env bash
# THERMITE — compile.sh
#
# Runs the actual compiler. Everything it needs arrives through THERMITE_* env
# vars that detect.mjs already validated; nothing is interpolated from the
# commit into a shell.
#
# GITHUB_TOKEN is deliberately absent from this script's environment. On Linux
# the compile additionally runs as a separate unprivileged user, so untrusted
# build.rs / proc-macro code cannot read the relay process's environment via
# /proc. On Windows and macOS runners that boundary does not exist — see
# README.md, "What a pour can and cannot do".

set -uo pipefail

JOB_DIR="jobs/${THERMITE_JOB}"
SRC="${JOB_DIR}/source"
# On a sealed pour the entrypoint is not known until unseal.mjs has decrypted
# and validated the charge, so it arrives under a separate name.
ENTRY="${THERMITE_ENTRY_UNSEALED:-${THERMITE_ENTRY:-}}"
LOG="pour.log"
TRIPLE_ENV=""

# On a sealed pour the log is encrypted before it is published, but the Actions
# job log is PUBLIC on a public repository. So when a pour is sealed, compiler
# output goes only into pour.log — never to stdout. Markers carry no source and
# are always shown, so the run is still legible on GitHub.
if [ "${THERMITE_SEALED:-0}" = "1" ]; then
  pipe() { tee -a "$LOG" >/dev/null; }
else
  pipe() { tee -a "$LOG"; }
fi
say()  { printf '%s\n' "$*" | pipe; }
mark() { printf '##thermite:%s\n' "$*" | pipe; printf '##thermite:%s\n' "$*"; }

# --------------------------------------------------------------- toolchain --

say "\$ rustup toolchain install ${THERMITE_TOOLCHAIN} --profile minimal"
if ! rustup toolchain install "${THERMITE_TOOLCHAIN}" --profile minimal --no-self-update 2>&1 | pipe; then
  say ""
  say "Rust ${THERMITE_TOOLCHAIN} could not be installed. Check that this version exists."
  exit 90
fi

say ""
say "\$ rustup target add ${THERMITE_TARGET} --toolchain ${THERMITE_TOOLCHAIN}"
if ! rustup target add "${THERMITE_TARGET}" --toolchain "${THERMITE_TOOLCHAIN}" 2>&1 | pipe; then
  say ""
  say "Rust ${THERMITE_TOOLCHAIN} has no standard library for ${THERMITE_TARGET}."
  say "Choose a newer toolchain, or a target this toolchain supports."
  exit 91
fi

THERMITE_RUSTC="$(rustc "+${THERMITE_TOOLCHAIN}" -V 2>/dev/null || echo unknown)"
THERMITE_CARGO="$(cargo "+${THERMITE_TOOLCHAIN}" -V 2>/dev/null || echo unknown)"
export THERMITE_RUSTC THERMITE_CARGO
{
  printf 'THERMITE_RUSTC=%s\n' "$THERMITE_RUSTC"
  printf 'THERMITE_CARGO=%s\n' "$THERMITE_CARGO"
} >> "$GITHUB_ENV"

say ""
say "  ${THERMITE_RUSTC}"
say "  ${THERMITE_CARGO}"
say "  runner ${RUNNER_OS}/${RUNNER_ARCH}"
mark "toolchain-ready"

# ------------------------------------------------------------ cross linker --

if [ -n "${THERMITE_LINKER:-}" ]; then
  TRIPLE_ENV="CARGO_TARGET_$(printf '%s' "$THERMITE_TARGET" | tr 'a-z-' 'A-Z_')_LINKER"
  export "${TRIPLE_ENV}=${THERMITE_LINKER}"
  printf '%s=%s\n' "$TRIPLE_ENV" "$THERMITE_LINKER" >> "$GITHUB_ENV"
  say "  cross linker ${THERMITE_LINKER}"
  case "$THERMITE_TARGET" in
    x86_64-unknown-linux-musl) export CC_x86_64_unknown_linux_musl=musl-gcc ;;
    aarch64-unknown-linux-*)   export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc ;;
    armv7-unknown-linux-*)     export CC_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-gcc ;;
  esac
fi

# ------------------------------------------------------------- uid sandbox --

RUNAS=()
SANDBOXED=no
if [ "${THERMITE_SANDBOX}" = "uid" ] && command -v sudo >/dev/null 2>&1; then
  if id pourer >/dev/null 2>&1 || sudo -n useradd -m -s /bin/bash pourer 2>/dev/null; then
    sudo -n chmod a+rx "$HOME" 2>/dev/null || true
    sudo -n chmod -R a+rX "$HOME/.rustup" "$HOME/.cargo" 2>/dev/null || true
    sudo -n mkdir -p /home/pourer/.cargo 2>/dev/null || true
    sudo -n chown -R pourer /home/pourer "$SRC" 2>/dev/null || true
    RUNAS=(sudo -n -u pourer env -i
      "HOME=/home/pourer"
      "PATH=${HOME}/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
      "RUSTUP_HOME=${HOME}/.rustup"
      "CARGO_HOME=/home/pourer/.cargo"
      "CARGO_TERM_COLOR=always"
      "CARGO_NET_RETRY=3"
      "TERM=xterm-256color")
    if [ -n "$TRIPLE_ENV" ]; then RUNAS+=("${TRIPLE_ENV}=${THERMITE_LINKER}"); fi
    if [ -n "${CC_x86_64_unknown_linux_musl:-}" ]; then RUNAS+=("CC_x86_64_unknown_linux_musl=musl-gcc"); fi
    SANDBOXED=yes
    say "  sandbox  separate unprivileged user"
  fi
fi
if [ "$SANDBOXED" = no ]; then say "  sandbox  none (native ${RUNNER_OS} runner — see repo README)"; fi
say ""

# ----------------------------------------------------------------- compile --

export CARGO_TERM_COLOR=always CARGO_NET_RETRY=3 RUST_BACKTRACE=0
mkdir -p out
mark "compiling"
STATUS=0

if [ -z "$ENTRY" ]; then
  say "No entrypoint was resolved for this pour. The charge was not unsealed."
  exit 93
fi

if [ "${THERMITE_PROJECT_TYPE}" = "cargo" ]; then
  say "\$ cargo +${THERMITE_TOOLCHAIN} build --release --target ${THERMITE_TARGET}"
  say ""
  # stderr — the human stream (Compiling…, warnings, errors) — goes to the tee.
  # stdout — the machine stream (JSON artifact records) — goes to a file.
  "${RUNAS[@]}" cargo "+${THERMITE_TOOLCHAIN}" build \
      --release \
      --target "${THERMITE_TARGET}" \
      --manifest-path "${SRC}/Cargo.toml" \
      --message-format=json-render-diagnostics \
      2>&1 1>cargo-messages.json | pipe
  STATUS=${PIPESTATUS[0]}
else
  BIN="out/${THERMITE_NAME}${THERMITE_EXT}"
  say "\$ rustc +${THERMITE_TOOLCHAIN} --edition 2021 -O --target ${THERMITE_TARGET} -o ${BIN} ${ENTRY}"
  say ""
  "${RUNAS[@]}" rustc "+${THERMITE_TOOLCHAIN}" --edition 2021 -O \
      --color always \
      --target "${THERMITE_TARGET}" \
      -o "$BIN" "${JOB_DIR}/${ENTRY}" 2>&1 | pipe
  STATUS=${PIPESTATUS[0]}
fi

say ""
if [ "$STATUS" -ne 0 ]; then
  mark "failed:${STATUS}"
  say "Compilation failed. Exit code ${STATUS}."
  exit "$STATUS"
fi

mark "linking"
say "Compiled clean. Casting the ingot."
exit 0
