# Thermite

**Fe₂O₃ + 2Al → Al₂O₃ + 2Fe + heat.** The reaction that consumes rust and pours
molten iron.

A browser-based Rust build service with no backend. It compiles your code on
GitHub's own hosted runners, in your account, on your quota, and hands you a
binary for any of eleven targets. The website is a static page on GitHub Pages.
There is no server, no database, and no shared queue.

Read **[ARCHITECTURE.md](ARCHITECTURE.md)** first — it explains the whole design,
including the two places where a purely static site provably cannot do something
and what Thermite does instead.

## Layout

```
./                        the site — deploy this to GitHub Pages
build-repo-template/      what gets written into each user's crucible
tools/embed-workflows.mjs regenerates js/workflows.js from that template
relay/                    optional 50-line stateless OAuth relay (you may skip it)
web-repo-workflow/        the Pages deploy workflow for the website repo
ARCHITECTURE.md           the design
```

## Deploying

1. Create a **new, separate** repository — `thermite-web`. It must not be anyone's
   build repository; that separation is why deploying the site can never start a
   compilation.
2. Copy the site files into the repository root, and `web-repo-workflow/pages.yml` to
   `.github/workflows/pages.yml`.
3. Settings → Pages → Source: **GitHub Actions**. Push.

That is the whole deployment. Users sign in with a fine-grained token they create
themselves, and Thermite provisions their `thermite-crucible` repository on first
use.

Optionally, deploy `relay/worker.js` to Cloudflare Workers and set `OAUTH.RELAY_URL`
and `OAUTH.CLIENT_ID` in `js/config.js` to enable *Sign in with GitHub* via the
device flow. Leave them blank and that option never appears.

## Changing the build workflow

Edit the real files under `build-repo-template/`, then:

```
node tools/embed-workflows.mjs
```

This regenerates `js/workflows.js` and bumps the template revision, which is
how existing crucibles are offered a one-click re-lining.

## What it does not claim

Thermite compiles code, and compiling Rust executes `build.rs`, procedural macros
and dependency build scripts with the runner's privileges. Thermite provides no
sandbox and no containment of its own. Optional encryption protects
confidentiality at rest — it does not make untrusted code safe to run. The
in-product terms page says this in more detail, and says it before the first
build rather than after.
