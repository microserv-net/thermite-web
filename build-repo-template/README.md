# thermite-crucible

This repository is a **build crucible**. Thermite created it on your GitHub
account so that your Rust compilations run on GitHub's own hosted runners,
under your account, using your quota, with nothing of anyone else's in the loop.

It is public on purpose: Actions minutes are unmetered for public repositories,
and metered for private ones.

## What lives here

```
jobs/<POUR-ID>/          one submission — manifest.json + source/
.github/workflows/       build.yml (push → jobs/**) and cleanup.yml (cron)
scripts/                 the compiler driver and the housekeeping
```

Plus two things that are not files on `main`:

- branch **`crucible-logs`** — live build output, written every 2.5 s while a
  pour runs, so the website can show you the log as it happens. GitHub's own
  log endpoint cannot be read from a browser; this is the way around that.
- releases **`pour-<POUR-ID>`** — the finished binary, with a plain download
  URL that needs no token.

## Encryption (optional)

If you set up encrypted pours, two more things live here:

```
.thermite/keys/source-public.pem     public — used by your browser to seal source
.thermite/keys/artifact-public.pem   public — used by the runner to seal your ingot
```

Both are public keys and are safe in a public repository. **No private key belongs
in this repository, ever.**

- The **source private key** goes in Settings → Secrets and variables → Actions,
  named exactly `THERMITE_SOURCE_KEY`. Only the `Unseal the charge` step sees it,
  and that step finishes before the compiler starts — so by the time your
  `build.rs` runs, the process holding the key is gone.
- The **artifact private key** never comes near this repository. It stays with
  you, and it is the only thing that can open your sealed ingots and logs.
  Nobody can recover it for you.

On a sealed pour, compiler output does not go to the Actions job log at all
(that log is public on a public repository). It goes only into the encrypted log
on the `crucible-logs` branch.

## Housekeeping

`Thermite sweep` runs every six hours and removes pours older than 24 hours,
along with their logs and releases. **It never touches a pour whose run has not
finished** — it checks the Actions API for liveness before deleting anything.

You can run it by hand from the Actions tab, with a dry-run option. Each pour can
also carry its own policy — clean up on success, clean up once the ingot has been
retrieved, or the default 24 hours — and the website can clean up individual
pours on demand.

Note that GitHub keeps some things Thermite cannot delete: Actions run records
and their job logs (~90 days), Actions artifacts until their own expiry, and Git
history, which retains the commit that added a pour even after its files are
removed.

## What a pour can and cannot do

Your submitted code is compiled here, and compiling Rust runs arbitrary code:
`build.rs`, procedural macros, and anything they invoke.

**Cannot:**

- change any workflow in this repository. GitHub refuses workflow file writes
  from an Actions token, so a malicious `build.rs` cannot rewrite `build.yml`
  to escalate.
- reach any other repository. `GITHUB_TOKEN` is scoped to this repo alone and
  expires when the job ends.
- read a secret. This repository has no secrets, and none should ever be added
  to it.
- use a third-party action. Actions permissions here are set to GitHub-owned
  actions only.

**Can, in the worst case:** on **Windows and macOS** runners, read the
short-lived `GITHUB_TOKEN` out of the log relay's process environment and use
it to write to *this* repository — a disposable build repo that holds nothing
but throwaway jobs. On **Linux** runners the compile runs as a separate
unprivileged local user, which closes that path at the kernel level.

If that residual risk matters to you, prefer the Linux targets, or delete this
repository when you are done with it. Deleting it costs nothing; Thermite will
offer to build a new one next time you pour.

## Deleting this repository

Settings → General → Danger Zone → Delete this repository. Nothing else of
yours is affected.
