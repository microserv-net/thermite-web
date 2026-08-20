# THERMITE — Architecture

> **Fe₂O₃ + 2Al → Al₂O₃ + 2Fe + heat.**
> Thermite is the reaction that consumes rust and pours molten iron.
> The service takes Rust in and pours binaries out.

**Names used throughout**

| Thing | Name |
| --- | --- |
| Product | **Thermite** |
| Website repo (static, GitHub Pages) | `thermite-web` |
| Per-user build repo (public, auto-created) | `thermite-crucible` |
| Unit of work | **pour** (a build job), id = ULID |
| Live log surface | **the crucible** |
| Finished artifact | **ingot** |

---

## 0. The one honest constraint, stated up front

Everything in this document runs from a static GitHub Pages site with **no server owned by you**, with exactly one exception, which is unavoidable and which I isolate into ~50 stateless lines you may also simply not deploy:

**GitHub's OAuth token endpoints (`https://github.com/login/oauth/access_token`, `https://github.com/login/device/code`) do not send CORS headers and require a `client_secret` for confidential clients.** A browser physically cannot call them, and a static site cannot hold a secret. This is not a design choice I can engineer around — it is GitHub's server refusing the browser's preflight.

So Thermite ships **two authentication modes**:

- **Mode A — Forge Key (default, 100 % static, zero infrastructure).** The user creates a *fine-grained personal access token* scoped to their own account, with 5 permissions, and pastes it once. `api.github.com` **does** send `Access-Control-Allow-Origin: *` and accepts `Authorization: Bearer` from any origin, so every subsequent operation works directly from the page. Nothing of yours is in the loop.
- **Mode B — Sign in with GitHub (optional).** A GitHub App + OAuth **device flow**, relayed through a single stateless Cloudflare Worker / Deno Deploy function (`relay/worker.js`, no database, no storage, no logging, ~50 lines) whose only job is to add `client_secret` and add CORS headers. If `RELAY_URL` is left blank in `config.js`, the UI never mentions Mode B.

Mode A is the default because it is the only option that is *genuinely* zero-backend, and because a fine-grained PAT is strictly **less** privileged than an OAuth App token (it is per-repository-permission, expiring, and revocable in one click). §13 covers how the token is handled.

Everything after this section is identical in both modes: both produce a bearer token for `api.github.com`, and the entire application is written against that single interface.

---

## 1. Authentication architecture

### Mode A — Forge Key (fine-grained PAT)

The UI walks the user through GitHub's token creation screen with a deep link and a copy-paste permission checklist. Required permissions, all **account-scoped, least privilege**:

| Permission | Level | Why |
| --- | --- | --- |
| **Administration** | Read & write | Create `thermite-crucible` once (`POST /user/repos`). Nothing else uses it. |
| **Contents** | Read & write | Write job files, read logs branch, read manifests. |
| **Workflows** | Read & write | Write `.github/workflows/*.yml` during provisioning only. |
| **Actions** | Read | Read run status, job status, artifact metadata. **Read, not write** — the site never cancels or re-runs anything. |
| **Metadata** | Read | Mandatory companion permission. |

The site asks the user to scope the token to **`thermite-crucible` only** ("Only select repositories") after first provisioning, and shows a one-click reminder to do so. On first run the token must be account-wide because the repo does not exist yet; the UI explicitly surfaces this and offers a "narrow my key" step afterwards.

**Not requested:** `Administration: delete`, `Secrets`, `Environments`, `Packages`, `Users`, org scopes, `repo:status`, `gist`. Thermite can never read another repository, never touch secrets, never see private code.

Token validation on entry: `GET /user` (identity + confirms auth), then `GET /rate_limit` (confirms scopes are live). A malformed or under-scoped token produces a precise error naming the missing permission, derived from the `x-accepted-github-permissions` response header on the first failing call — not "something went wrong".

### Mode B — GitHub App + device flow

1. Page calls `POST {RELAY_URL}/device/code` → relay forwards to GitHub with `client_id` → returns `user_code`, `verification_uri`, `device_code`, `interval`.
2. UI shows the 8-character code in the crucible typeface and opens `github.com/login/device`.
3. Page polls `POST {RELAY_URL}/device/token` at the returned `interval`, honouring `slow_down`, until it gets a **user-to-server token** (`ghu_…`, 8 h lifetime) plus a refresh token.
4. GitHub App permissions requested are identical to the table above. The App is installed on the user's account; Thermite calls `GET /user/installations` to confirm.

The relay holds only `client_id` + `client_secret` as environment variables, stores nothing, logs nothing, and its response body is passed through verbatim. It is the smallest possible GitHub-native shim; the alternative is asking every user to register their own GitHub App, which the UI also supports as "bring your own app" for the paranoid.

### Why not a public CORS proxy

Because it would see every user's authorization code and token in plaintext. Rejected outright.

---

## 2. How the build repository is created

Repository name: **`thermite-crucible`** (fixed, predictable, no collision guessing, satisfies GitHub naming rules). Discovery is `GET /repos/{login}/thermite-crucible`; a 404 means "not provisioned".

Provisioning is a strict sequence with idempotency at every step, so an interrupted first run resumes cleanly:

```
GET  /repos/{login}/thermite-crucible          → 404? continue : verify & repair
POST /user/repos                                { name, private:false, auto_init:false,
                                                  has_issues:false, has_wiki:false,
                                                  has_projects:false, description, homepage }
PUT  /repos/{o}/{r}/actions/permissions         { enabled:true, allowed_actions:"selected" }
PUT  /repos/{o}/{r}/actions/permissions/selected-actions
                                                { github_owned_allowed:true,
                                                  verified_allowed:false, patterns:[] }
PUT  /repos/{o}/{r}/actions/permissions/workflow
                                                { default_workflow_permissions:"read",
                                                  can_approve_pull_request_reviews:false }
--- single atomic Git Data commit: the seed ---
POST /repos/{o}/{r}/git/blobs        × N        (workflows, scripts, README, .gitignore)
POST /repos/{o}/{r}/git/trees                   (one tree, N entries)
POST /repos/{o}/{r}/git/commits                 message: "thermite: forge lining (no pour)"
POST /repos/{o}/{r}/git/refs                    ref: refs/heads/main, sha: <commit>
--- orphan logs branch, created empty ---
POST /repos/{o}/{r}/git/commits                 empty tree, no parents
POST /repos/{o}/{r}/git/refs                    refs/heads/crucible-logs
```

`allowed_actions: "selected"` + `github_owned_allowed: true` + **empty patterns** means the build workflow may only use `actions/*` — a user cannot smuggle a third-party action into a build even if they somehow got a workflow edit through. `default_workflow_permissions: "read"` sets the floor to read-only; the build workflow raises exactly what it needs, and nothing else in the repo can raise anything.

The seed commit contains **no `jobs/` path**, which is the first of three independent reasons it cannot start a build (§12).

**Repair path:** if the repo exists, Thermite compares the SHA of each workflow file against the SHA of the template it ships and, if they differ, offers "re-line the crucible" — a single commit that restores the workflows. This is how workflow upgrades roll out, and it is also the recovery path if a user hand-edits their repo into a broken state.

---

## 3. How files are uploaded

All uploads go through the **Git Data API**, never the Contents API, because the Contents API creates one commit per file and Thermite requires exactly one commit per pour (§5, §6).

**Single file (`.rs`)**

```
POST /git/blobs   { content: <base64>, encoding: "base64" }   → source/main.rs
POST /git/blobs   { manifest.json }
```

**Project (`.zip`)**

The ZIP is decoded **in the browser**, never uploaded as an opaque blob. Thermite parses the End of Central Directory record, walks the central directory, and inflates each entry with the native `DecompressionStream('deflate-raw')`. No third-party unzip library, no server-side extraction, and — critically — **path traversal is impossible because the archive is never extracted onto a filesystem at all.** Each entry name is validated and then used as a *tree path string*:

- reject absolute paths, `..` anywhere in the path, backslashes, NUL, control characters, leading `/`
- reject any path resolving outside the entry root after normalisation
- reject symlinks (external attr high bits `0xA000`) and any non-regular entry
- reject `.github/**` — categorically, at the client and again in the workflow (§14)
- reject entries whose declared uncompressed size exceeds the per-file cap, and abort if the running inflated total exceeds the project cap (zip-bomb guard, checked *during* inflation, not after)
- strip a single common top-level directory (`myproj-1.0/…` → `…`) so `Cargo.toml` lands where the workflow expects it
- skip `target/`, `.git/`, `node_modules/`, `.DS_Store`, `__MACOSX/`

Blobs are uploaded with a concurrency of 6 and per-request retry (§ Implementation quality). Binary-safe: everything is base64.

---

## 4. How commits are created

One pour = one commit = one tree write:

```
GET  /git/ref/heads/main                     → base commit sha
GET  /git/commits/{sha}                      → base tree sha
POST /git/trees   { base_tree: <base>, tree: [ {path:"jobs/<ULID>/manifest.json", mode:"100644",
                                                type:"blob", sha:<blob>}, … ] }
POST /git/commits { message:"pour <ULID> · <toolchain> · <target>",
                    tree:<tree>, parents:[<base commit>] }
PATCH /git/refs/heads/main { sha:<commit>, force:false }
```

`force: false` makes the ref update a **compare-and-swap**. If two tabs (or two machines) of the same user submit simultaneously, the loser gets `422 Update is not a fast forward`, and the client transparently re-reads the ref and retries with fresh parents (bounded, jittered, max 5). Both pours land, as two separate commits, each triggering its own run. This is the only place concurrency needs handling on the write side, and Git's own optimistic locking handles it.

The job ID is a **ULID** generated client-side: 48-bit millisecond timestamp + 80 bits of `crypto.getRandomValues`, Crockford base32, 26 chars, lexicographically sortable, `[0-9A-HJKMNP-TV-Z]{26}` only. It is re-validated against that exact regex by the workflow before it is ever interpolated anywhere.

---

## 5. How workflow triggers work

```yaml
on:
  push:
    branches: [main]
    paths: ['jobs/**']
```

Three filters compose:

- **`branches: [main]`** — the live-log branch `crucible-logs` is written thousands of times per build and must never trigger anything. Excluded by branch, not by path.
- **`paths: ['jobs/**']`** — the seed commit, README edits, workflow upgrades and re-linings touch no `jobs/` path and are filtered out by GitHub before a run is even created.
- **the detect job** (§6) — the last line of defence, for anything that slips past path filtering (notably: cleanup commits, which *do* touch `jobs/**` because they delete from it).

There is **no `workflow_dispatch`** on the build workflow. A dispatch has no meaningful "triggering commit" and would break the invariant in §6; allowing it would be a hole. `repository_dispatch` is likewise absent — it would require `Actions: write` on the token and would decouple the run from a commit.

---

## 6. How a workflow identifies its exact job

This is the invariant the whole system rests on:

> **A run triggered by commit C builds the contents of commit C, and nothing else.**

**Checkout.** `actions/checkout@v4` with `ref: ${{ github.sha }}` and `fetch-depth: 0` (needed for the diff). For `push`, `github.sha` is the *pushed* commit, not the branch head. If commit B lands while run A is queued, run A still checks out A. Explicit `ref:` is redundant with checkout's default for push events, but it is stated anyway because the guarantee must be visible in the file, not inherited from a default that could change.

**Discovery — diff, not scan.** `scripts/detect.mjs`:

```
before = github.event.before
if before is all-zeros, unknown, or not an ancestor:
    changed = git diff-tree --no-commit-id --name-status -r <github.sha>
else:
    changed = git diff --name-status <before>..<github.sha>

added = entries with status A
jobs  = { first path segment pair of each added path matching ^jobs/<ULID>/ }
```

Then, per candidate job id:

- **exactly one** `jobs/<id>/manifest.json` must appear with status **`A` (added)**. A modified manifest is not a new pour and is ignored — this is what stops a user editing an old manifest to force a re-run against stale sources.
- every other added path must live under `jobs/<id>/`
- the manifest must parse, and must validate against the schema in §14
- the job directory must contain at least one source file and no `.github` path

**One job per commit, enforced.** If `jobs.length !== 1`, the run writes a rejection into the log stream and exits `0`. The client only ever creates single-job commits, so a multi-job commit is by definition either a hand-crafted push or an attack, and the correct response is to refuse rather than guess. Exiting `0` (not failing) keeps a user's Actions history clean and keeps their repo out of GitHub's "failing workflow" nag emails.

**Nothing derived from the commit is ever interpolated into a shell.** `detect.mjs` writes validated values to `$GITHUB_OUTPUT`; the build job reads them as `${{ needs.detect.outputs.* }}` into `env:` and every shell reference is `"$VAR"`. No `${{ }}` appears inside a `run:` block anywhere in either workflow — that is the script-injection class of vulnerability and it is closed by construction, not by escaping.

---

## 7. How concurrent builds stay independent

**Across users:** different accounts, different repositories, different Actions quotas. Nothing is shared. There is no central queue, no shared runner, no shared state — which is exactly why this architecture scales without you owning anything.

**Within one user:** each pour is its own commit, its own run, its own runner VM, its own artifact, its own log file (`logs/<ULID>.log` on `crucible-logs`, keyed by ULID, so parallel builds cannot interleave).

**Concurrency configuration — deliberately non-cancelling:**

```yaml
concurrency:
  group: thermite-pour-${{ github.sha }}
  cancel-in-progress: false
```

The group key is the **commit SHA**, so no two pours ever share a group and nothing can ever cancel anything. The block exists only to deduplicate the pathological case of the same commit being pushed twice. The obvious-looking `group: ${{ github.workflow }}-${{ github.ref }}` is precisely the bug the brief warns about and is never used.

Log writes from parallel builds target *different files on the same branch*, so they can collide on the branch ref. `relay.mjs` handles this with read-modify-write on the file SHA plus retry on 409/422 — see §8.

Limits that actually bind: 20 concurrent jobs per user account on the free plan (GitHub-enforced; excess queues, which is correct behaviour), and Thermite's own client-side limit of **3 in-flight pours per user** (§14) to keep the queue legible.

---

## 8. How live logs are retrieved

**The problem.** `GET /repos/{o}/{r}/actions/jobs/{id}/logs` responds `302` to `productionresultssa*.blob.core.windows.net`. That host does not send `Access-Control-Allow-Origin`. A browser `fetch` follows the redirect and dies on the cross-origin read. There is no browser-side workaround. Actions logs are, for practical purposes, **not readable from a static page.**

**The solution: the build streams its own logs into the repository.**

Inside the build job, the compile is run under a line-buffered tee into `pour.log`. A detached Node process, `scripts/relay.mjs`, started *before* the compiler and holding the token in its own environment, does:

- every **2.5 s**, if `pour.log` grew, `PUT /repos/{o}/{r}/contents/logs/<ULID>.log` on branch `crucible-logs` with the full current log (base64), passing the previous file SHA
- writes a sibling `logs/<ULID>.state.json` — `{phase, startedAt, runnerOs, rustc, cargo, target, toolchain, lastLine, bytes}` — which is how the UI knows the *real* pipeline stage
- on 409/422 (ref moved under a parallel pour), re-reads the SHA and retries with jitter, max 5
- flushes a final time in an `if: always()` step, appending the terminal marker `##thermite:end:<conclusion>`

The frontend polls `GET /repos/{o}/{r}/contents/logs/<ULID>.log?ref=crucible-logs` with `Accept: application/vnd.github.raw` and an **`If-None-Match` ETag**. A `304` costs **zero** rate-limit budget, so idle polling is free. It reads only the bytes past its last offset and appends.

Cost: ~2.5 s granularity, a few dozen commits on a throwaway orphan branch per build (deleted by cleanup, and the branch is force-reset to an empty orphan commit weekly so history never accumulates). Benefit: genuinely live logs, fully client-readable, no proxy, no CORS problem, and the logs survive the 90-day Actions log retention because they're in Git.

**Belt and braces:** run/job state also comes from `GET /actions/runs?head_sha=<sha>` and `GET /actions/runs/{id}/jobs` (both CORS-clean), polled at 5 s with ETags. If the relay dies, the UI still shows accurate status from the Actions API and says so — *"log stream lost; status is live"* — rather than freezing. After completion, the full log is also attached to the release (§9) so it is downloadable in one piece.

**No invented progress.** The pipeline stages advance only on evidence: `INGEST` when the run appears, `IGNITE` when the job reports `in_progress`, `COMPILE` on the first `Compiling ` line, `LINK` on the last crate compiling / `Finished` absent, `CAST` on the packaging step's marker, `READY` on `conclusion: success` **and** the release asset resolving. There is no percentage anywhere, because GitHub exposes none. The crucible animation's agitation is driven by *observed log line throughput* — real data, not a timer.

---

## 9. How artifacts are located

**The same CORS wall applies:** `GET /actions/artifacts/{id}/zip` also 302s to blob storage. So Thermite publishes the ingot **twice**:

1. **`actions/upload-artifact@v4`**, named exactly `thermite-<ULID>`. Located by `GET /actions/runs/{run_id}/artifacts` and matched on that exact name — scoped to the run, which is scoped to the commit, which is scoped to the job. It is impossible to surface another pour's artifact because the lookup starts from the pour's own commit SHA. Shown in the UI with its real `expires_at`, and marked **EXPIRED** (not "download") once `expired: true` or the date has passed.
2. **A GitHub Release** tagged `pour-<ULID>`, with the packaged ingot and the complete build log attached. Because the crucible repo is public, each asset has a `browser_download_url` that is a plain, unauthenticated, CORS-irrelevant `https://github.com/…/releases/download/…` link. **This is the download the button uses** — an ordinary `<a download>`, no token, works even if the user has logged out, shareable.

Packaging: a `.tar.gz` for Unix targets, `.zip` for Windows targets, containing the binary, a `SHA256SUMS`, and `pour.json` (manifest + resolved `rustc -Vv`, `cargo -V`, runner OS/arch, wall-clock duration). The UI shows the SHA-256 next to the download so the user can verify.

On failure: **no release, no artifact, no placeholder.** The log is still streamed and still committed to `crucible-logs`, the failing step is named, and `cargo`'s JSON diagnostics (`--message-format=json-diagnostic-rendered-ansi`) are parsed into a structured error list — file, line, column, error code, rendered snippet — shown as real compiler diagnostics rather than a wall of text. Exit code and the failing stage are surfaced explicitly.

---

## 10. How cleanup works

`.github/workflows/cleanup.yml`, `on: schedule: cron '17 */6 * * *'` (offset from the hour because the top of the hour is GitHub's most-congested and most-dropped cron slot) plus manual `workflow_dispatch`.

For each `jobs/<ULID>/manifest.json`:

1. Read `submittedAt` from the manifest, and cross-check against the commit date of the path (`git log -1 --format=%cI -- jobs/<id>`) — the commit date wins, since the manifest is client-supplied.
2. If younger than **24 h**, skip.
3. Otherwise, resolve the pour's run and check it is finished (§11).
4. Stage: delete `jobs/<id>/`, delete `logs/<id>.log` and `logs/<id>.state.json` from `crucible-logs`, and delete the `pour-<ULID>` release **and its git tag**.
5. Commit all deletions from the whole sweep as **one** commit: `thermite: sweep <n> spent pour(s) [skip ci]`.

Actions *artifacts* are left to GitHub's own retention. The repo's `retention_days` is set to 7 at provisioning to keep storage small, and the UI never promises an artifact outlives its real `expires_at`.

A weekly step force-resets `crucible-logs` to a fresh empty orphan commit when it holds no live pours, so the log branch's history can never grow without bound.

---

## 11. How cleanup avoids deleting running jobs

A job is deletable only if **all** of these hold:

- `GET /actions/runs?head_sha=<the commit that added the job>` returns at least one run, and **every** run for that SHA has `status == "completed"`. Status is read fresh at sweep time. `queued`, `in_progress`, `waiting`, `requested`, `pending` → **skip, untouched.**
- If *no* run exists for that SHA at all: the job is skipped unless it is older than 24 h **and** the commit is older than 30 min — this covers the "run was never created" edge case without racing a run that is still being scheduled.
- `logs/<id>.state.json` does not report an unterminated stream that was updated within the last 10 minutes.
- The job is older than 24 h by *commit* date.

The commit SHA for a job is found by `git log --diff-filter=A --format=%H -1 -- jobs/<id>/manifest.json` — the commit that *added* it, which is exactly the commit that triggered its run. Same key on both sides, so the join can't drift.

Cleanup runs with `permissions: {contents: write, actions: read}` — it can never cancel or delete a run.

**Cleanup does not trigger builds**, by three independent mechanisms: the commit message carries `[skip ci]`; the deletions produce a diff with status `D`, and `detect.mjs` only accepts status `A`; and even if both failed, no valid *added* manifest exists, so detect exits `0`. Any one of the three suffices. This is deliberate redundancy at the most dangerous joint in the system — a cleanup commit that triggered builds would be an infinite loop that burns the user's Actions minutes.

---

## 12. How initialization avoids triggering compilation

Four layers, each independently sufficient:

1. `auto_init: false` on repo creation — no initial commit exists, no push event.
2. The seed commit is created through the **Git Data API**, which is still a push event, but it touches only `.github/`, `scripts/`, `README.md`, `.gitignore` — **no `jobs/` path**, so `paths: ['jobs/**']` filters it out before a run is created.
3. The seed commit message ends with `[skip ci]`.
4. `detect.mjs` finds no added manifest and exits `0`.

The `crucible-logs` orphan branch is created with an empty tree and is excluded by `branches: [main]`.

**Ordering note:** GitHub evaluates a `push`-triggered workflow using the workflow file *as of the pushed commit*. The seed commit is what first introduces `build.yml`, and it is filtered out; the first commit that can possibly trigger it is the first pour. There is no window in which a workflow runs against a repo that doesn't yet contain it.

---

## 13. How the frontend avoids exposing secrets

**In the browser**

- **No application secret exists in the frontend.** Mode A has none by definition. Mode B's `client_secret` lives only in the relay's environment; the page holds only the public `client_id`.
- The token is held in **`sessionStorage`, not `localStorage`** — it dies with the tab, is not shared across tabs, and is not readable by a later visit. A "keep me signed in for this browser" opt-in is offered; it stores the token in IndexedDB **encrypted with AES-GCM under a non-extractable `CryptoKey`** derived via PBKDF2 (310 000 iterations) from a passphrase the user types. The raw token never touches persistent storage in either case.
- The token is sent **only** as an `Authorization: Bearer` header to `https://api.github.com`. Never a query parameter, never a URL, never a fragment, never a log line, never an error message. The API client asserts the target origin before every request and throws if it isn't `api.github.com`.
- A strict `Content-Security-Policy` (`default-src 'self'; connect-src 'self' https://api.github.com https://github.com; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`) plus `no-referrer` blocks exfiltration paths. **Zero third-party scripts** — no analytics, no CDN, no font host, no framework runtime. Nothing on the page can read the token except the page.
- Sign out clears sessionStorage, IndexedDB, in-memory state, and offers a deep link to GitHub's token revocation page.

**In the build environment**

This is the sharper problem, because `cargo build` executes arbitrary user code: `build.rs`, proc macros, and `cargo test`/`--build-plan` hooks all run on the runner.

- **`permissions:` is `contents: write` + nothing else.** No `actions:write`, no `packages`, no `id-token`. The default is already floored to `read` at the repository level (§2).
- **No repository or organisation secrets are ever created.** The build environment contains exactly one credential: the ephemeral `GITHUB_TOKEN`, scoped to that repo, expiring when the job ends.
- **`GITHUB_TOKEN` cannot modify workflows.** GitHub refuses `contents: write` writes to `.github/workflows/**` from an Actions token (`refusing to allow a GitHub App to create or update workflow`). A malicious `build.rs` therefore cannot rewrite the workflow to escalate. This is a platform guarantee, not a Thermite check — and it is why Thermite deliberately does *not* need write access to workflows at build time.
- **Linux targets compile inside a container** (`docker run --rm -e-nothing --network=bridge -v <jobdir>:/pour:ro`) with the token absent from the container environment and `/proc` of the host not visible. This is the genuinely isolated path and covers the default targets.
- **Windows/macOS targets compile natively**, where the token is present in the runner's process table. **Residual risk, stated plainly:** a malicious `build.rs` on those targets can read `/proc/*/environ` (or the equivalent) and obtain a token that can write to *the submitter's own throwaway public repo*, and nothing else. The blast radius is one disposable repo belonging to the person who submitted the code. The UI labels native-runner targets with this. It is not hidden in a comment.
- The compile step runs with `env: { GITHUB_TOKEN: '', GH_TOKEN: '' }` and the relay is started beforehand in a separate process, so the token is not in the compiler's own environment.

---

## 14. How abuse and rate limiting work

**Validated at the client and re-validated in the workflow.** Client checks are UX; the workflow checks are the enforcement, because a determined user can push commits directly to their own repo.

| Limit | Value | Enforced |
| --- | --- | --- |
| Single `.rs` file | 512 KiB | client + workflow |
| ZIP upload | 12 MiB compressed | client |
| Inflated project | 64 MiB | client, checked *during* inflation |
| Files per project | 1 200 | client + workflow |
| Any single file | 8 MiB | client + workflow |
| Path depth / length | 24 / 200 chars | client + workflow |
| Pours per hour, per user | 12 | client (token-bucket in sessionStorage + reconciled against the repo's real commit history, so clearing storage doesn't reset it) |
| In-flight pours | 3 | client, reconciled from live Actions runs |
| Duplicate submission | content hash of the tree; identical tree within 60 s is refused with a link to the existing pour | client |
| Build wall-clock | `timeout-minutes: 25` (job) + `--timeout` on the compile step | workflow |
| Artifact retention | 7 days repo default | provisioning |

**Input validation (workflow side, `detect.mjs`):**

- job id: `^[0-9A-HJKMNP-TV-Z]{26}$`
- toolchain: `^(stable|beta|nightly|nightly-\d{4}-\d{2}-\d{2}|\d+\.\d+(\.\d+)?)$`
- target: must be a key in the workflow's own **allowlist table** — the client's list is advisory, the workflow's is authoritative
- `projectType ∈ {single, cargo}`
- every source path: `^[A-Za-z0-9._/-]+$`, no `..`, no leading `/`, no `.github`
- manifest ≤ 8 KiB, no unknown top-level keys

**Workflow-file integrity:** `detect.mjs` fails the run if the triggering commit touched `.github/**`, `scripts/**`, or any path outside `jobs/<id>/`. Combined with the client's `.github` rejection and GitHub's own `GITHUB_TOKEN` workflow-write ban, there are three locks on that door.

**GitHub API budget:** the client keeps a live model of `x-ratelimit-remaining` / `-reset` from every response. Below 1 000 remaining it doubles all poll intervals; below 300 it pauses background polling for inactive jobs and shows a banner with the reset time. `secondary rate limit` / `403` with `retry-after` is honoured exactly. All polling uses ETags, so steady-state watching of a build costs close to nothing. Every request is retried with full jitter on 5xx/network error, max 4, and never retried on 4xx except 403-with-retry-after and 409/422 on ref races.

---

## 15. GitHub Actions limits that matter

- **Free tier, public repository: Actions minutes are unmetered** — which is the entire economic reason the crucible repo is public. Private would burn the user's 2 000 min/month in a few dozen builds.
- **Not unlimited, though:** 20 concurrent jobs and 5 macOS jobs per free account; a 6 h job cap (Thermite uses 25 min); 500 workflow runs per 10 s across a repo; API-created runs subject to the same 1 000 req/hr/repo Actions API budget. Thermite's 12/hr + 3-in-flight caps sit far below all of these.
- **Artifacts:** default 90-day retention, set to 7 here; 500 MB free storage per account for artifacts — another reason the release asset is the primary download path, since release storage is unlimited for public repos.
- **Scheduled workflows** are best-effort, can be delayed at peak, and are **disabled automatically after 60 days of repository inactivity**. Thermite handles this: the client checks `GET /actions/workflows/cleanup.yml` on load and, if `state == "disabled_inactivity"`, tells the user and offers a one-click re-enable (`PUT /actions/workflows/{id}/enable` — the only write to the Actions API, and it is opt-in and explicit, which is why the base token needs only `Actions: read`).
- **Logs** are retained 90 days; the crucible-logs copy outlives that.
- **Runner images** change; the workflow pins `runs-on` labels explicitly and records the actual image in `pour.json` rather than assuming.

---

## 16. GitHub API limits that shape the design

- **No CORS on `github.com/login/*`** → §0, the one non-static piece.
- **No CORS on Actions log and artifact redirect targets** → §8 log relay, §9 release assets. These two are the load-bearing consequences.
- **No partial-log API even server-side** — GitHub has no "logs since offset" endpoint. Confirms §8 is not merely a CORS workaround but the only route to live logs at all.
- **5 000 req/hr authenticated**, 1 000/hr per repo for Actions endpoints; **304s are free**, which is why ETags are everywhere.
- **Contents API is one commit per call** → Git Data API for all multi-file writes.
- **Ref updates are compare-and-swap** with `force: false` → free optimistic concurrency (§4).
- **Repo creation is not instantly consistent**; the first few calls against a brand-new repo can 404. Provisioning polls `GET /repos/…` until it resolves before writing the seed.
- **`GITHUB_TOKEN` cannot write `.github/workflows/**`** → a security guarantee Thermite relies on (§13).
- Search API is 30 req/min and eventually consistent → never used; job discovery is by ref and SHA only.

---

## 17. What is genuinely impossible from a pure static site

| Requirement | Status |
| --- | --- |
| OAuth / device-flow token exchange | **Impossible.** No CORS, needs a secret. → Mode A (PAT) or a 50-line stateless relay. |
| Reading Actions job logs directly | **Impossible.** 302 → non-CORS blob host. → workflow-side log relay (§8), which is better anyway: it survives log retention and is offset-readable. |
| Downloading an Actions artifact via `fetch` | **Impossible.** Same wall. → release assets, which need no auth at all on a public repo (§9). |
| Truly server-authoritative rate limiting | **Impossible** without a server. Client limits are advisory against a *determined self-attacker*, who is only able to exhaust **their own** account's quota. There is no shared resource to protect, which is the whole point of the per-user-repo design. |
| Hiding the build repo | Not impossible, but rejected: private repos meter Actions minutes. |
| Cancelling a run from the UI | Possible, but requires `Actions: write`. Deliberately not requested; the UI links to GitHub instead. |

Everything else in the brief is achievable exactly as specified.

---

## 18. Exact repository structure

### `thermite-web` — the site (GitHub Pages, static, no build step)

```
thermite-web/
├── index.html                  single document, all scenes
├── 404.html
├── .nojekyll
├── styles/
│   ├── core.css                tokens, type scale, layout primitives
│   ├── scenes.css              the descent: scroll-linked stations
│   └── crucible.css            terminal + pipeline + ingot
├── js/
│   ├── config.js               targets, toolchains, limits, RELAY_URL
│   ├── util.js                 ULID, base64, sanitising, retry, ETag store
│   ├── github.js               API client: auth, retry, rate-limit, ETags
│   ├── auth.js                 Mode A + Mode B, token vault
│   ├── unzip.js                DecompressionStream ZIP reader + guards
│   ├── provision.js            repo creation, workflow install, repair
│   ├── submit.js               validation → blobs → tree → commit
│   ├── watch.js                run/job/log/artifact polling state machine
│   ├── workflows.js            generated: workflow templates as strings
│   └── ui/
│       ├── scroll.js           scene engine, scroll-linked progress
│       ├── fx.js               pour-line canvas, spark field
│       ├── crucible.js         molten pool driven by real log throughput
│       ├── terminal.js         virtualised log view, ANSI, copy, follow
│       └── history.js          past pours, rehydrated from GitHub
└── tools/embed-workflows.mjs   regenerates js/workflows.js from the template
```

The site is a **single HTML document with no bundler and no framework** — ES modules straight from Pages. `git push` is the deploy. Nothing here can ever trigger a build: it is a different repository with no workflows that watch `jobs/**`.

### `thermite-crucible` — the per-user build repo (public, auto-created)

```
thermite-crucible/
├── README.md                   what this repo is, how to delete it
├── .gitignore
├── .github/workflows/
│   ├── build.yml               push → jobs/** → detect → build → cast
│   └── cleanup.yml             cron */6h → sweep spent pours
├── scripts/
│   ├── detect.mjs              diff-based job discovery + validation
│   ├── relay.mjs               live log streamer → crucible-logs
│   ├── package.mjs             ingot packaging + checksums + pour.json
│   └── sweep.mjs               cleanup with liveness checks
└── jobs/
    └── <ULID>/
        ├── manifest.json
        └── source/…            main.rs, or the whole cargo project

branch: crucible-logs (orphan)
└── logs/
    ├── <ULID>.log
    └── <ULID>.state.json

releases: pour-<ULID> → ingot archive + pour.log
```

### `manifest.json`

```json
{
  "schema": 1,
  "id": "01JQ8Z4K7T3M9V2B6X1Y5R8W0C",
  "toolchain": "1.89.0",
  "target": "x86_64-unknown-linux-gnu",
  "projectType": "cargo",
  "name": "hyperloop",
  "entry": "source/Cargo.toml",
  "submittedAt": "2026-08-20T09:14:02.318Z",
  "client": "thermite-web/1.0.0",
  "files": 42,
  "bytes": 118234,
  "treeHash": "sha256:…"
}
```

Nothing in it is trusted. Every field is re-validated by `detect.mjs` before use, and `treeHash` is recomputed from the checked-out files to detect tampering between commit and build.

---
---

# Extension — consent, confidentiality, and cleanup

Everything above still holds. Nothing in this extension weakens a control in it:
one pour is still one commit is still one run is still one artifact, a workflow
still builds only its triggering commit, cleanup still never touches a live
build, and no private key is ever committed.

---

## 19. The EULA flow, and what it cannot be

**The flow.** Terms and security are a full page in the same visual language as
the rest of the site — a blueprint overlay reachable from the top bar, from the
hero, and from a link in the consent block itself — not a line of small print.
It leads with the fact that compiling Rust executes `build.rs`, procedural
macros and dependency build scripts, and it separates **data confidentiality**
from **build environment security** in two facing columns so the distinction
cannot be skimmed past.

Immediately above the pour button sit two checkboxes:

- that the user understands Thermite compiles their project on GitHub-hosted
  runners under their own account, that this executes code, and that they are
  responsible for what they submit;
- that they have read the terms and security information, including that
  encryption is not a sandbox.

**The pour button is disabled until both are ticked** — and it says why, rather
than sitting greyed out and mute. Acceptance is stored in `sessionStorage`,
keyed to a terms version so a material change re-prompts. A separate opt-in
writes the same record to `localStorage` for the device.

**What this cannot be.** It is a gate in an interface, not a record of
acceptance. There is no server, so nothing witnessed the click; the only
artifact is a value the user's own browser wrote and can rewrite in the console.
A static architecture cannot produce server-authoritative, tamper-evident proof
of acceptance, and Thermite does not simulate one — no fabricated receipt, no
hash chain implying more than it delivers. This limitation is stated in the
terms themselves, not buried in a comment. If provable acceptance is a
requirement, it needs a server, and that is a different product.

---

## 20. Source encryption

```
browser                          public crucible                runner
───────                          ───────────────                ──────
files ─┬─ pack ─ gzip ─ AES-GCM ─┬─ jobs/<id>/source.tenc ──────┬─ unseal step
       │                         │                              │  (only step with
       └─ wrap CEK with ──────────┘                             │   the secret)
          source public key                                     ├─ validate paths
                                                                ├─ write source/
       .thermite/keys/source-public.pem  ← committed, public    ├─ compile
       THERMITE_SOURCE_KEY (Actions secret) ← user-configured   └─ shed plaintext
```

The whole project is packed into one **charge** — a JSON envelope of paths and
base64 contents — gzipped, encrypted once, and committed as a single blob at
`jobs/<ULID>/source.tenc`. The manifest stays plaintext, carries no key material,
and gains one field: `encryption.source.keyId`.

**The consequence that has to be handled:** a sealed pour is ciphertext at commit
time, so `detect.mjs` cannot inspect its file paths. Every check it would have
made — path shape, traversal, depth, `.github/`, symlinks, file count, per-file
and total size — is therefore made by `unseal.mjs` **after decryption and before
a single byte is written to disk**, with a final `resolve()` containment check
against the job's source root. An encrypted pour is not a less-validated pour.
This is tested with a charge whose ciphertext contains
`../../../.github/workflows/pwn.yml`; it is refused.

**Where the source private key lives, and for how long.** It is a repository
secret named `THERMITE_SOURCE_KEY`, referenced by exactly one workflow step. That
step runs to completion before the compile step starts, so by the time any
`build.rs` or proc macro executes, the process that held the key no longer
exists. The compile step's environment has never contained it.

**The log leak this closes.** Compiler diagnostics quote source. On a public
repository, the Actions job log is world-readable, and so is the `crucible-logs`
branch. So on a sealed pour: `compile.sh` sends compiler output only to
`pour.log`, never to stdout (markers still print, so the run stays legible on
GitHub); the relay encrypts the log with the **artifact** public key before
publishing it; and the release's log asset is sealed too. Sealing the source
while streaming the compiler's rendering of it would have been theatre.

---

## 21. Artifact encryption

```
runner                                    release              browser
──────                                    ───────              ───────
binary ─ package ─ tar.gz ─┬─ AES-GCM ────┬─ *.tenc ───────────┬─ fetch
                           │              │                    ├─ unwrap CEK
        artifact public ───┘              │                    ├─ AES-GCM verify
        key (from the repo)               │                    ├─ gunzip
                                          │                    └─ save locally
                                    plaintext never leaves the runner
```

`package.mjs` seals the archive and then **deletes the plaintext**, so neither
the release nor the Actions artifact contains an openable binary. The Actions
artifact holds the same container, not a plaintext copy — otherwise the whole
exercise would be defeated by the artifact tab.

The keypair is generated **in the browser** with Web Crypto. The public half is
committed to `.thermite/keys/artifact-public.pem`; the private half is displayed
once, with copy and download, and a warning that says exactly what is true: lose
it and the ingot cannot be opened, by anyone. Thermite has no escrow, no hidden
copy, and no recovery path — deliberately, because a recovery path is by
definition a way for someone other than the holder to open the data.

Because the key is read from the repository **at the pour's commit**, rotating it
later does not retroactively break older pours: each was sealed for whatever key
was registered at its own commit, which is the same commit-pinning invariant the
build side rests on.

---

## 22. The two private keys, and why they are never one key

| | **Source private key** | **Artifact private key** |
| --- | --- | --- |
| Lives in | GitHub Actions repository secret | Wherever the user puts it |
| Used by | the runner, during compilation | the user's browser, on retrieval |
| Thermite | never reads it; the API does not expose secret values | never receives it |
| Committed | never | never |
| If lost | regenerate the pair, re-register, update the secret | **the ingot is unrecoverable** |

They are separate cryptographic identities and are never reused across purposes.
A single keypair would mean the key GitHub must hold in order to compile is also
the key that opens the finished binary — which would make "only you can open your
ingot" false.

The container's `purpose` field (`source` / `artifact` / `log`) is inside the
authenticated header, so a container sealed for one purpose cannot be presented
as another without the GCM tag failing.

---

## 23. THERMITE-ENC v1

Hybrid encryption assembled from Web Crypto and Node primitives only. No custom
primitive, no custom mode, no unauthenticated path anywhere.

```
┌────────────┬──────────────┬───────────────┬──────────────────────────┐
│ "THRMENC1" │ u32be hdrLen │ header (JSON) │ ciphertext ‖ GCM tag     │
└────────────┴──────────────┴───────────────┴──────────────────────────┘
      8 B          4 B           hdrLen                 rest
      └──────────── AAD ────────────┘
```

- **Content encryption:** AES-256-GCM, 96-bit random IV, 128-bit tag.
- **Key wrapping:** RSA-OAEP-4096 with SHA-256 over a fresh 256-bit content key.
- **AAD:** the magic, length and full header — so format, version, purpose, pour
  id and recipient key id are all authenticated. Swap any of them and decryption
  fails rather than succeeding differently.
- **Key id:** first 16 hex of SHA-256 over the SPKI DER. Shown in the UI so a
  user can see which key an ingot needs before trying.
- **Versioned** in both the magic and the header, so v2 can change the
  construction without ambiguity.

Two deliberate omissions. The header carries **no hash of the plaintext** — in a
public repository that would let anyone confirm a guess at the source. And there
is no password-based mode: a passphrase-derived key on a public artifact is an
offline-crackable artifact.

The format is implemented twice — `web/js/crypto.js` and
`build-repo-template/scripts/tenc.mjs` — because the browser and the runner do
not share a runtime. Both are tested against each other in both directions,
including tamper detection and wrong-key rejection.

---

## 24. Client-side decryption and what "returned" means

Retrieval is a claim with consequences, because a pour set to clean up on return
is deleted on the strength of it. So it means all of:

1. the bytes are in the browser,
2. if sealed, the container decrypted with the user's private key,
3. the GCM tag verified — the bytes are the runner's bytes,
4. the file reached the user's downloads.

Only then is the pour marked returned. **If any step fails, nothing is deleted**
and the user can retry. A plain download link sits beside the retrieve button and
is labelled as not counting — because Thermite cannot observe whether it
succeeded.

Release assets are cross-origin. If the browser cannot read the asset host
directly, the failure is caught and explained, with the fallback of downloading
the file and dropping it back in to open and verify locally. That path needs no
network access at all.

---

## 25. Manual cleanup

Three operations, deliberately distinct, with deliberately different weights.

**Clean up pour** — one pour: its `jobs/<ULID>/`, its log and state files on both
plaintext and sealed paths, its release and its tag. One deletion commit,
`[skip ci]`, deletions only. Nothing else on the repository is touched.

**Clean up all** — every pour that is *verifiably* safe to remove. The
confirmation shows a tally: completed, failed, **still active**, and
**unverifiable**, with the specific reason each retained pour is being left
alone. Active and unverifiable pours are listed by id, never hidden. Workflows,
scripts, encryption keys, repository configuration and the repository itself are
out of scope by construction — the operation only ever enumerates `jobs/`.

**Decommission crucible** — the uninstall, and the only thing here that deletes
the repository. It is not reachable from either cleanup button, requires typing
`<owner>/thermite-crucible` exactly, refuses while any pour is building or any
pour's state cannot be confirmed, and offers an explicit override that states
plainly that overriding cancels running builds. Afterwards local pour history is
cleared and any loaded artifact key is dropped from memory. Thermite offers to
build a fresh crucible next time.

Every confirmation shows three columns, not two: **deleted by Thermite**, **left
untouched**, and **retained by GitHub regardless** — the Actions run record and
job log (~90 days, unreachable with read-only Actions access), the Actions
artifact until its own expiry, and Git history, which keeps the commit that added
the pour even after the files are gone. Claiming otherwise would be the easiest
lie in the product and the least defensible.

---

## 26. Cleanup policies

Chosen per pour at submission and recorded in the manifest as
`cleanup: { policy, onFailure }`.

| Policy | Meaning | Enforced by |
| --- | --- | --- |
| `expire` (default) | 24 hours, then swept | the scheduled sweep |
| `onSuccess` | eligible as soon as a successful run completes | the sweep, early |
| `onReturn` | removed once the ingot is verifiably back with the user | the browser, with the sweep as 24-hour backstop |
| `onFailure: keep` (default) | failed pours survive to 24 hours | the sweep |
| `onFailure: clean` | failed pours eligible immediately | the sweep, early |

`onReturn` is browser-driven because only the browser can observe retrieval — a
workflow cannot know whether a download succeeded, let alone whether a container
decrypted. The sweep never releases an `onReturn` pour early; it only applies the
ordinary 24-hour rule, so an abandoned pour still gets collected.

Cleaning up a failed pour destroys the compiler output that is usually the only
reason to have it, so it is off by default and its confirmation says so in those
terms and uses the destructive styling.

---

## 27. Cleanup safety, unchanged and extended

The rule from §11 applies identically to every manual path:

1. resolve the pour's **triggering commit SHA** — the commit that *added* its
   manifest, the same key the build side used;
2. read every Actions run for that SHA, fresh;
3. proceed only if **all** are `completed`;
4. cross-check the log state file for a stream that is still being written;
5. re-classify each pour **immediately before deletion**, so a build that started
   while the confirmation dialog was open is still protected.

And the failure mode, which matters more than the checks: if the commit cannot be
resolved, if the runs cannot be read, if the network fails, if the state is
ambiguous — **the pour is kept**. `"I could not check"` is never collapsed into
`"it must be finished"`. The survey reports those pours as *unverifiable* and
excludes them from the eligible count rather than quietly including them.

Manual cleanup commits cannot start a build, by the same three independent
mechanisms as the scheduled sweep: `[skip ci]` in the message, deletions-only
diffs where `detect.mjs` accepts only added manifests, and no valid added
manifest to find.

---

## 28. Documentation

A first-class scene, not a README link: a full-screen blueprint overlay with a
chapter index, hairline grid, plate numbering and the site's own typography.
Eight chapters — getting started, single-file builds, cargo projects, targets,
encryption, cleanup, security model, and an FAQ of the twelve questions people
actually ask, including *"Is Thermite a sandbox?"* answered *"No."*

Content lives as structured data (`web/js/docs.js`) and is rendered through the
same element helpers as everything else, so it inherits the design system rather
than importing a second one. Inline markup is limited to bold and code, and
everything is escaped before rendering.

The encryption chapter draws the flow the brief asks for —
SOURCE → LOCK → CRUCIBLE → BUILD → LOCK → INGOT → UNLOCK LOCALLY — and cleanup
draws POUR → SPENT → COOL → RECYCLE, as structural diagrams in the manual's own
visual language.

---

## 29. Interface changes

- **A new station, 05 / SEAL**, between source and confirm. A single unambiguous
  `ENCRYPTED POUR [OFF|ON]` switch, and when on, two panes of live checks —
  source public key, `THERMITE_SOURCE_KEY` presence, artifact public key,
  artifact private key loaded — each with a real verdict: ✓, ✕, or an honest `!`
  when the token lacks `Secrets: read` and Thermite *cannot* verify.
- **`ENCRYPTION NOT READY`** is shown as a verdict bar and blocks the pour
  button. A partially configured encrypted pour is **never** silently downgraded
  to plaintext — that would be the worst possible failure mode for this feature.
- **Private keys are shown exactly once**, in a bordered panel with copy,
  download, a deep link to the repository's secrets page (source) or an opt-in
  passphrase-encrypted device vault (artifact), and an explicit *I have saved it*
  before it is dismissed.
- **The consent block** sits directly above the pour button with a link into the
  terms.
- **The ledger** gains a per-row *Clean up pour* (disabled, with a reason, while
  a pour is live), *Clean up all*, and *Decommission crucible*.
- **The furnace** gains *Retrieve ingot*, a sealed-log state that explains itself
  and offers to load the key, and a *Returned* record showing size, SHA-256 and
  the key that opened it.
- **Connected identity** — the GitHub login and the crucible repository are shown
  in the top bar and on the connect station throughout, so which account is
  active is never ambiguous. Signing out clears the token, session storage, the
  cached identity, the crucible reference, the key state and any loaded artifact
  private key, then reloads: one account's repository can never leak into another
  account's session.

Reduced motion, keyboard focus, focus trapping in dialogs, Escape ordering
(dialog → manual → ledger → furnace) and mobile layout apply to all of it.

---

## 30. Security implications of the extension

**What improves.** Source at rest in a public repository becomes ciphertext.
Published artifacts become ciphertext openable only by the user. Build logs stop
leaking source through compiler diagnostics. Users get an explicit, informed
consent step before their first build. Users get precise control over how long
their data persists, with a fail-closed deletion path.

**What does not change, and is stated everywhere it matters.** Compilation
requires plaintext. The runner decrypts the source in order to compile it; while
the build runs, plaintext exists in the runner's filesystem and memory. Build
scripts and procedural macros execute with the runner's privileges regardless of
how the source arrived. **Encryption is a confidentiality feature; it is not a
malicious-code containment feature, and Thermite does not claim a sandbox.**

**What the extension adds to the threat surface, named.** A repository secret now
exists in the crucible. It is referenced by exactly one step, which completes
before user code runs — but a user who edits their own workflow could expose it,
and a user who reuses the source keypair elsewhere widens its blast radius. The
plaintext-shedding step after a build is best effort; the actual assurance is
that the runner VM is destroyed, and the README says so rather than implying the
`rm` is the guarantee.

**What remains impossible.** Server-authoritative proof of acceptance. Recovery
of a lost artifact private key. Deletion of GitHub's own retained records with
read-only Actions access. Containment of arbitrary compile-time code. All four
are stated to the user in the interface, not only here.
