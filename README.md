# Thermite Web

**Fe₂O₃ + 2Al → Al₂O₃ + 2Fe + heat.** The reaction that consumes rust and pours
molten iron.

A browser-based Rust build service. It compiles your code on GitHub's own hosted
runners — in your account, on your quota, under GitHub's limits — and hands you a
binary for any of eleven targets, optionally encrypted end to end with a key only
you hold.

**Thermite has no application server.** No backend, no database, no queue you are
sharing. The website is a static page on GitHub Pages. (One optional exception,
which you may simply not deploy: a stateless relay for *Sign in with GitHub*,
because GitHub's OAuth endpoints send no CORS headers and require a client
secret. The default sign-in needs nothing.)

Read **[ARCHITECTURE.md](ARCHITECTURE.md)** first. It explains the whole design,
including the places where a purely static site provably cannot do something and
what Thermite does instead.

## Layout

The site is served **from the repository root**, so Pages can deploy it with no
build step.

```
index.html  404.html  .nojekyll     the site
js/  styles/                        the site
.github/workflows/pages.yml         deploys the site, and only the site
build-repo-template/                what gets written into each user's crucible
tools/embed-workflows.mjs           regenerates js/workflows.js from that template
relay/                              optional stateless OAuth relay — you may skip it
ARCHITECTURE.md                     the design
```

`build-repo-template/.github/` is **not** this repository's `.github/`. The build
and cleanup workflows inside it are inert here; they only become live once
committed into a user's crucible. This repository has no workflow that watches
`jobs/**`, which is why deploying the site can never start a compilation.

## Deploying

1. Create a **new, separate** repository. It must not be anyone's build
   repository — that separation is structural, not conventional.
2. Copy these files into its root.
3. Settings → Pages → Source: **GitHub Actions**. Push.

That is the whole deployment. Users sign in with a fine-grained token they create
themselves, and Thermite provisions their `thermite-crucible` repository on first
use.

Optionally, deploy `relay/worker.js` to Cloudflare Workers and set
`OAUTH.RELAY_URL` and `OAUTH.CLIENT_ID` in `js/config.js` to enable *Sign in with
GitHub* via the device flow. Leave them blank and that option never appears.

## Running it locally

Serve it. Do not open `index.html` from disk:

```
python3 -m http.server 8000        # then visit http://localhost:8000
```

`http://localhost` is a **secure context**; `file://` and a plain `http://` LAN
address are not, and browsers withhold Web Crypto outside one. Without it, plain
pours still work — they lose only the manifest's tamper hash — but every
encrypted pour is refused. On Pages this never comes up, because Pages is https.

## Changing the build workflow

Edit the real files under `build-repo-template/`, then:

```
node tools/embed-workflows.mjs
```

This regenerates `js/workflows.js` and bumps `TEMPLATE_REVISION`. That bump is
what makes existing crucibles offer a one-click **re-line**, which pushes the
updated scripts into the user's repository. Skip it and users keep running the
old scripts on the runner regardless of what the site says.

## What it does

- **One pour = one commit = one workflow run = one artifact.** A run always
  builds the exact commit that triggered it, so pours submitted seconds apart
  never contaminate each other.
- **Three ways to give it source**: a single `.rs` file, a cargo project as a
  `.zip`, or the name of a **public GitHub repository** — picked from your own
  repositories or typed as `owner/repository`, with a branch/tag/commit and a
  folder navigator for choosing the build root. A named repository is cloned by
  the runner at build time, so there is no upload and no size ceiling.
- **Live logs**, streamed by the runner into a branch, because GitHub's own log
  endpoint cannot be read from a browser.
- **Eleven targets** across Linux, Windows, macOS and WebAssembly, native and
  cross, with the difference stated rather than glossed.
- **Optional encryption** — THERMITE-ENC v1, two separate keypairs, source
  sealed in the public repo and the ingot decrypted only in your browser.
- **Cleanup you control**: automatic after 24 hours, or on success, or once
  you have verifiably retrieved the ingot — plus per-pour and bulk manual
  cleanup, and **Decommission crucible** to delete the whole thing.

## What it costs

Every build runs on **your** GitHub account, against your Actions usage and
GitHub's own limits. Public repositories are not billed per minute today, which
is why the crucible is public — but that is a billing difference, not a promise
of unlimited compute. Concurrency caps, job timeouts and fair-use policies still
apply, and they are GitHub's to change. Thermite adds its own cap of 12 pours an
hour so a stuck loop cannot run away with your quota.

## What it does not claim

Thermite compiles code, and compiling Rust executes `build.rs`, procedural macros
and dependency build scripts with the runner's privileges. Thermite provides no
sandbox and no containment of its own.

Optional encryption protects **confidentiality**: your source is ciphertext at
rest in a public repository, and your binary is ciphertext until it reaches your
browser. It does **not** make untrusted code safe to run — compilation requires
plaintext on the runner, and that is unavoidable rather than a shortcoming of the
implementation. Source encryption is refused for a pour that names a public
repository, because sealing something already public would protect nothing.

Repository sources are **public only**. The clone on the runner is anonymous, and
giving a build a credential that could reach your private repositories — while it
executes arbitrary `build.rs` code — is a worse trade than the convenience is
worth.

Cleanup removes what Thermite controls. GitHub independently keeps Actions run
records and job logs for about 90 days, artifacts until their own expiry, and Git
history for the life of the repository. The interface labels those separately
rather than claiming everything disappears.

The in-product terms page says all of this in more detail, and says it before the
first build rather than after.
