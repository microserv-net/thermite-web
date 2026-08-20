// THERMITE — the forge manual.
//
// Terms and documentation live here as structured content and are rendered into
// the same visual language as the rest of the site: a blueprint, not a settings
// page. Written to be read by someone about to hand a machine their code.

import { el, esc } from './util.js';
import { TERMS_VERSION } from './consent.js';

// ═══════════════════════════════════════════════════════════════ terms ══════

export const TERMS = {
  version: TERMS_VERSION,
  title: 'Terms and security',
  standfirst:
    'Thermite is a static web page that drives your own GitHub account. It has no server, ' +
    'no database, and no copy of anything you submit. That design decides almost everything ' +
    'below — including several things it cannot promise you.',
  sections: [
    {
      id: 'what',
      eyebrow: 'What Thermite is',
      title: 'A page that operates your GitHub account on your behalf.',
      body: [
        'Thermite runs entirely in your browser. When you authorise it, it uses your GitHub credentials to create a public repository on your account, write your submitted source into it as a commit, and read back the resulting workflow run, logs and artifacts.',
        'Every build runs on GitHub-hosted runners, billed to and governed by your GitHub account, under GitHub\u2019s terms and Actions policies. Thermite is not a hosting provider and does not operate the infrastructure your code runs on.',
        'Thermite is provided as-is, without warranty of any kind, express or implied, including any warranty of merchantability, fitness for a particular purpose, or non-infringement. To the maximum extent permitted by applicable law, the authors are not liable for any damages arising from its use.',
      ],
    },
    {
      id: 'execution',
      eyebrow: 'The important one',
      title: 'Compiling Rust executes code. Yours, and your dependencies\u2019.',
      tone: 'warn',
      body: [
        'This is not a caveat, it is the central fact of the service. A Rust build is not a passive transformation of text. During compilation the toolchain runs real programs on the runner:',
      ],
      list: [
        '`build.rs` build scripts from your crate and from every dependency that has one',
        'procedural macros, which execute at compile time with full process privileges',
        'anything those scripts invoke — shell commands, downloads, other compilers',
        '`cargo` itself, which resolves and fetches dependencies from the network',
      ],
      after: [
        'That code runs with the privileges of the runner process, on a machine attached to your GitHub account, with network access. Thermite does not analyse, sandbox, contain, or vet any of it.',
        '**You are responsible for the code you submit, including its dependencies.** Submit only code you trust, from sources you trust. A crate you have never audited is code you have not read running on infrastructure attached to your account.',
        'Thermite makes no representation that submitted code is safe, and provides no malicious-code containment.',
      ],
    },
    {
      id: 'secrets',
      eyebrow: 'Do not do this',
      title: 'Never put credentials in the source you submit.',
      tone: 'warn',
      body: [
        'Your crucible repository is **public**, because GitHub only makes Actions minutes unmetered for public repositories. Anything you commit to it in plaintext is world-readable, permanently, including after deletion — Git history and GitHub\u2019s caches outlive a `git rm`.',
        'Do not submit API keys, passwords, tokens, private certificates, customer data, or anything else you would not publish. Encrypted pours reduce this exposure but do not eliminate the underlying rule: assume anything you send may be read.',
        'If you do publish a credential by accident, revoke it at its source. Deleting the pour does not un-publish it.',
      ],
    },
    {
      id: 'confidentiality',
      eyebrow: 'The distinction that matters',
      title: 'Data confidentiality is not build environment security.',
      tone: 'warn',
      body: [
        'Thermite offers optional encryption. It is important to be exact about what that does and does not buy you.',
      ],
      split: [
        {
          h: 'Data confidentiality — what encryption provides',
          items: [
            'Your source is stored in the public repository as ciphertext rather than plaintext',
            'Your finished binary is published as ciphertext and opened only in your browser',
            'On a sealed pour, the build log is encrypted too, because compiler errors quote your source',
            'Integrity is authenticated: a modified container fails to open rather than opening wrongly',
          ],
        },
        {
          h: 'Build environment security — what encryption does not provide',
          items: [
            'Compilation requires plaintext. Your source is decrypted on the runner in order to be compiled.',
            'While the build runs, plaintext source exists in the runner\u2019s filesystem and memory',
            'Encryption does not restrict what your build scripts and macros can do once running',
            'Encryption is not a sandbox, not isolation, and not a containment boundary',
          ],
        },
      ],
      after: [
        'Encryption is a **confidentiality** feature. It is not a malicious-code containment feature. If you would not run a piece of code on your own machine, encrypting it does not make it safe to run on a GitHub runner.',
      ],
    },
    {
      id: 'keys',
      eyebrow: 'Keys',
      title: 'You hold the keys. All of them. There is no recovery.',
      tone: 'warn',
      body: [
        'Thermite uses two separate keypairs and never mixes them.',
      ],
      split: [
        {
          h: 'Source private key',
          items: [
            'You store it as a GitHub Actions repository secret named `THERMITE_SOURCE_KEY`',
            'GitHub needs it during compilation to decrypt your source',
            'Thermite never reads it. GitHub\u2019s API does not return secret values to anyone.',
            'Rotating it is your responsibility; pours sealed for an old key stop building',
          ],
        },
        {
          h: 'Artifact private key',
          items: [
            'Generated in your browser and shown to you exactly once',
            'Never uploaded, never committed, never placed in GitHub Secrets',
            'Required to open your finished binary and to read a sealed log',
            '**If you lose it, the ingot cannot be recovered — not by you, not by Thermite**',
          ],
        },
      ],
      after: [
        'Thermite has no key escrow, no recovery mechanism and no hidden copy. This is deliberate: a recovery mechanism would be a way for someone other than you to open your data. Back the key up yourself, somewhere you trust.',
      ],
    },
    {
      id: 'account',
      eyebrow: 'Your GitHub account',
      title: 'Everything Thermite does, it does as you.',
      body: [
        'You authorise Thermite with credentials you create and can revoke at any time from GitHub\u2019s settings. Thermite requests the minimum permissions it needs and never asks for organisation scopes or access to unrelated repositories.',
        'You are responsible for the security of your GitHub account and its credentials. Review the permissions you grant before granting them, and revoke them when you are done. Signing out of Thermite clears its in-memory and session state; revoking the credential at GitHub is what actually ends its authority.',
        'Your crucible is an ordinary repository on your account. You can inspect it, modify it, or delete it at any time, from Thermite or from GitHub. Thermite has no way to prevent that and no interest in doing so.',
      ],
    },
    {
      id: 'retention',
      eyebrow: 'Retention',
      title: 'Thermite deletes what it can. GitHub keeps what it keeps.',
      body: [
        'Thermite removes pour directories, logs, releases and tags — on a schedule after roughly 24 hours, or immediately when you ask it to.',
        'GitHub independently retains things Thermite does not control: Actions run records and their job logs (about 90 days), Actions artifacts until their own expiry, and Git history, which keeps the commit that added your pour even after the files are removed. The interface labels these separately rather than claiming everything vanishes.',
        'Artifacts and releases are not backups. Retrieve anything you want to keep.',
      ],
    },
    {
      id: 'acceptance',
      eyebrow: 'About this agreement',
      title: 'A static site cannot prove you agreed.',
      body: [
        'Before your first pour, Thermite asks you to acknowledge the two statements above the pour button. That acknowledgement is stored in your own browser and nowhere else.',
        'Because there is no server, Thermite cannot produce a server-authoritative, tamper-evident record that you accepted these terms: the only record is one your browser wrote and can rewrite. If your situation requires provable acceptance, this architecture cannot supply it, and Thermite does not simulate it.',
        `These terms are version ${TERMS_VERSION}. Material changes reset the acknowledgement and you will be asked again.`,
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════ documentation ══════

export const DOCS = [
  {
    id: 'start',
    eyebrow: '01',
    title: 'Getting started',
    intro: 'From nothing to a compiled binary, in the order it actually happens.',
    blocks: [
      { h: 'What Thermite is', p: [
        'A static web page that compiles Rust for you by driving your own GitHub account. You give it a token, it creates one public repository — your **crucible** — and every build you submit becomes a commit in it. GitHub\u2019s runners do the work. The page watches and reports.',
        'There is no Thermite server. Nothing you submit passes through anyone else\u2019s infrastructure.',
      ] },
      { h: 'How a build works', steps: [
        ['You submit', 'Your files become one commit adding `jobs/<pour-id>/`.'],
        ['GitHub reacts', 'That push starts a workflow run, pinned to that exact commit.'],
        ['The runner compiles', 'It installs your toolchain, adds your target, and builds.'],
        ['The log streams', 'The runner writes its own output to a branch every 2.5 seconds, and this page reads it.'],
        ['The ingot is cast', 'The binary is packaged, checksummed, and published as a GitHub Release asset.'],
        ['You download it', 'A plain URL, no token needed.'],
      ] },
      { h: 'Signing in', p: [
        'Thermite uses a **fine-grained personal access token** — a GitHub credential you create, scope, and revoke yourself. Click *Create one* on the connect station and give it these five permissions: Administration (write), Contents (write), Workflows (write), Actions (read), Metadata (read). Optionally add Secrets (read) so Thermite can confirm your encryption secret is set.',
        'The token lives in this tab\u2019s session storage. Close the tab and it is gone. It is only ever sent to `api.github.com`, as a header, never in a URL.',
        'After your first build, edit the token on GitHub and narrow it to *only* the `thermite-crucible` repository. It needed account-wide access once, to create the repo; it does not need it again.',
      ] },
      { h: 'Your crucible', p: [
        'A public repository called `thermite-crucible`, created on your account the first time you connect. It holds the workflows, your in-flight pours, and your encryption public keys.',
        'It is public because GitHub only makes Actions minutes unmetered for public repositories. Making it private would meter every build against your free 2,000 minutes.',
        'You can delete it whenever you like — from the ledger, with **Decommission crucible**, or from GitHub directly. Thermite will offer to build a new one next time.',
      ] },
    ],
  },
  {
    id: 'single',
    eyebrow: '02',
    title: 'Building a single file',
    intro: 'The fastest path: one `.rs` file, compiled with `rustc -O`.',
    blocks: [
      { h: 'Walkthrough', steps: [
        ['Choose a toolchain', '`stable` unless you need something specific. Pinned versions like `1.89.0` are installed with rustup on the runner.'],
        ['Choose a target', 'Start with *Linux · x86-64* — it is native, so it is the fastest and the least surprising.'],
        ['Stay in single-file mode', 'The default. Drop a `.rs` file containing `fn main()`.'],
        ['Review and pour', 'The confirmation sheet shows the exact command that will run.'],
        ['Watch the crucible', 'The pool\u2019s agitation follows real log throughput. Nothing on this page is a fake progress bar.'],
        ['Download the ingot', 'A `.tar.gz` (or `.zip` for Windows) with the binary, a `SHA256SUMS` file, and a build record.'],
      ] },
      { h: 'What you get', p: [
        'The compile is `rustc --edition 2021 -O --target <triple> -o <name> main.rs`. No cargo, no dependencies, no `Cargo.toml`.',
        'If your file needs a crate from crates.io, it is not a single-file build — switch to project mode.',
      ] },
      { h: 'Common stumbles', list: [
        'No `fn main()` — rustc will not link an executable. Thermite warns before you pour.',
        'A `use some_crate::…` line — single-file mode has no dependency resolution.',
        'Choosing a WebAssembly target — those need a cargo project, and Thermite will say so.',
      ] },
    ],
  },
  {
    id: 'cargo',
    eyebrow: '03',
    title: 'Building a cargo project',
    intro: 'A real project, as a `.zip`, built with `cargo build --release`.',
    blocks: [
      { h: 'How to zip it', p: [
        'Zip the **contents** of your project folder, not the folder itself. `Cargo.toml` must sit at the root of the archive.',
        'Thermite unwraps a single wrapping directory automatically, so `myproject/Cargo.toml` still works — but a nested layout like `src/myproject/Cargo.toml` will be rejected with an explanation.',
      ] },
      { h: 'What gets left behind', p: [
        'Thermite strips `target/`, `.git/`, `node_modules/`, editor folders and OS cruft while reading the archive. Removing `target/` before zipping will usually take you from tens of megabytes to tens of kilobytes.',
      ] },
      { h: 'Limits', list: [
        '12 MiB compressed, 64 MiB once expanded',
        '1,200 files, 8 MiB per file',
        'No symbolic links, no `.github/` directory, no paths that escape the archive root',
        'Deflate only — re-zip if your tool used something exotic',
      ] },
      { h: 'The build', p: [
        'The runner executes `cargo build --release --target <triple>`. Your `Cargo.toml` and `Cargo.lock` are respected exactly as written; committing a lock file makes builds reproducible.',
        'Workspaces build normally. Every produced executable is collected into the ingot.',
        'Dependencies come from crates.io over the network, so the first build of a large tree takes as long as it would locally.',
      ] },
    ],
  },
  {
    id: 'targets',
    eyebrow: '04',
    title: 'Targets, native and cross',
    intro: 'Eleven targets. The difference between them is not cosmetic.',
    blocks: [
      { h: 'Native versus cross', p: [
        '**Native** means the runner\u2019s own architecture. The binary is built and could be run on the same machine.',
        '**Cross** means a different architecture, built with a cross-linker. The binary is produced but never executed here, so nothing on this platform has verified that it runs. Test cross-built binaries on real hardware before trusting them.',
      ] },
      { h: 'Choosing', list: [
        '**Linux · x86-64** — native, fastest, the default.',
        '**Linux · static (musl)** — one self-contained file that runs on any distro, including Alpine and `scratch` containers.',
        '**Linux · ARM64** — servers, Graviton, Raspberry Pi 4 and 5.',
        '**Windows · x86-64 (MSVC)** — native on a Windows runner; what most Windows users want.',
        '**Windows · MinGW** — a Windows binary built on Linux, with no MSVC runtime dependency.',
        '**macOS** — unsigned and unnotarised. Gatekeeper will object; that is expected, not a build failure.',
        '**WebAssembly** — needs a cargo project. `wasm32-unknown-unknown` is bare; `wasm32-wasip1` has files and stdio.',
      ] },
      { h: 'Toolchain compatibility', p: [
        'Not every Rust version knows every target. Thermite greys out combinations it knows are impossible and tells you the minimum version. If rustup still refuses on the runner, the log says so plainly rather than failing mysteriously.',
      ] },
    ],
  },
  {
    id: 'encryption',
    eyebrow: '05',
    title: 'Encrypted pours',
    intro: 'Optional. Off by default. Worth understanding completely before you rely on it.',
    blocks: [
      { h: 'What it changes', flow: ['SOURCE', 'LOCK', 'CRUCIBLE', 'BUILD', 'LOCK', 'INGOT', 'UNLOCK LOCALLY'] },
      { h: 'What it protects', p: [
        '**Source encryption** keeps your project as ciphertext while it sits in the public crucible repository. Your source must still be decrypted inside the build environment in order to compile.',
        '**Artifact encryption** means the finished binary is published encrypted and is decrypted only in your browser, with a key only you hold. The build log is sealed with the same key, because compiler diagnostics quote your source.',
      ] },
      { h: 'What it does not protect', tone: 'warn', p: [
        'Encryption is confidentiality, not containment. The runner decrypts your source to compile it — that is unavoidable, not a shortcoming of the implementation. While the build runs, plaintext exists on the runner, and your build scripts and macros execute with full privileges.',
        'Do not treat an encrypted pour as a sandbox. It is not one.',
      ] },
      { h: 'Setting up source encryption', steps: [
        ['Generate the source keypair', 'Thermite generates RSA-4096 in your browser. The public half is committed to your crucible.'],
        ['Copy the private key', 'Shown once. Copy the whole PEM block, `BEGIN` line to `END` line.'],
        ['Open your repository secrets', 'Settings → Secrets and variables → Actions → New repository secret.'],
        ['Name it exactly `THERMITE_SOURCE_KEY`', 'The workflow looks for that name and no other.'],
        ['Paste and save', 'GitHub encrypts it at rest and never returns its value — not to Thermite, not to you.'],
        ['Verify', 'Thermite checks the secret exists (never its value). With Secrets:read on your token this becomes a green check; without it, an honest "cannot verify".'],
      ] },
      { h: 'Setting up artifact encryption', steps: [
        ['Generate the artifact keypair', 'A completely separate RSA-4096 keypair, also generated in your browser.'],
        ['Save the private key now', 'It is offered once. Download it, or copy it somewhere you trust. There is no second chance and no recovery.'],
        ['The public half is registered', 'Committed to your crucible so the runner can seal your ingot for you.'],
        ['Load it when you retrieve', 'Opening an ingot or reading a sealed log requires the private key loaded in your browser.'],
      ] },
      { h: 'The two keys, side by side', split: [
        { h: 'Source private key → GitHub', items: [
          'Lives in your repository secrets',
          'Used by the runner, during compilation',
          'Thermite never reads it',
          'Losing it: regenerate the pair and re-register',
        ] },
        { h: 'Artifact private key → you', items: [
          'Lives wherever you put it',
          'Used by your browser, when retrieving',
          'Thermite never receives it',
          '**Losing it: the ingot is unrecoverable**',
        ] },
      ] },
      { h: 'The cryptography', p: [
        'Hybrid encryption built only from Web Crypto and Node primitives: a random AES-256-GCM content key encrypts the data, wrapped with the recipient\u2019s RSA-OAEP-4096 public key. The container header — format, version, purpose, pour id, recipient key id — is authenticated as additional data, so none of it can be swapped without the tag failing.',
        'The format is versioned as **THERMITE-ENC v1** so it can evolve without ambiguity. Nothing about it is homemade: no custom cipher, no custom mode, no unauthenticated encryption anywhere.',
        'The header deliberately carries no hash of the plaintext — in a public repository, that would let anyone confirm a guess at your source.',
      ] },
    ],
  },
  {
    id: 'cleanup',
    eyebrow: '06',
    title: 'Cleanup',
    intro: 'What Thermite removes, when, and what GitHub keeps regardless.',
    blocks: [
      { h: 'The lifecycle', flow: ['POUR', 'SPENT', 'COOL', 'RECYCLE'] },
      { h: 'Automatic', p: [
        'A scheduled workflow in your crucible runs every six hours and removes pours older than about 24 hours. It checks the Actions API first: **a pour whose run has not completed is never touched**, no matter how old it is.',
        'If the check cannot be made — API unavailable, network failure, ambiguous state — cleanup fails closed and keeps the pour. "I could not check" is never read as "it must be finished".',
      ] },
      { h: 'Per-pour policies', list: [
        '**Keep for 24 hours** (default) — the standard lifetime.',
        '**Delete after I retrieve the ingot** — cleaned up once the binary is verifiably in your browser: downloaded, decrypted if sealed, and integrity-checked. If retrieval fails, nothing is deleted and you can retry.',
        '**Delete after a successful build** — for pours whose output you do not need to keep around.',
        '**Also clean up failed builds** — off by default, because a failed build\u2019s log is usually the only thing worth having.',
      ] },
      { h: 'Manual', p: [
        '**Clean up pour** removes one pour: its source or sealed charge, its logs, its release and tag. Nothing else.',
        '**Clean up all** removes every pour that is safe to remove and shows you exactly which ones it is leaving alone and why. It never removes workflows, encryption configuration, or the repository.',
        '**Decommission crucible** is the uninstall: it deletes the repository outright. Everything goes — pours, logs, releases, workflows, registered public keys. It requires typing the repository name and refuses while a build is running.',
      ] },
      { h: 'What GitHub keeps anyway', tone: 'warn', list: [
        'The Actions **run record and job log** — about 90 days. Thermite has read-only Actions access and cannot delete these.',
        'The Actions **artifact** — until its own expiry date, which the interface shows you.',
        '**Git history** — the commit that added your pour remains in the repository\u2019s history even after the files are deleted. Only deleting the repository removes it.',
        'Thermite labels these as *retained by GitHub* rather than claiming everything disappears.',
      ] },
    ],
  },
  {
    id: 'security',
    eyebrow: '07',
    title: 'Security model',
    intro: 'Stated plainly, including the parts that are not reassuring.',
    blocks: [
      { h: 'What Thermite relies on GitHub for', list: [
        'Authentication and identity',
        'Repository ownership and access control',
        'Authorization and permission scoping',
        'Actions execution and runner infrastructure',
        'Artifact and release storage',
      ] },
      { h: 'What Thermite does not claim', tone: 'warn', p: [
        'Thermite does not provide a secure sandbox for arbitrary code. It has no containment boundary of its own. Your build runs on GitHub\u2019s infrastructure under GitHub\u2019s isolation model, and everything your compilation executes runs with the runner\u2019s privileges.',
      ] },
      { h: 'What Thermite does do', list: [
        'Requests the minimum GitHub permissions it can operate with, and no organisation scopes',
        'Restricts your crucible to GitHub-owned actions, so a third-party action cannot be introduced',
        'Floors default workflow permissions to read, and grants `contents: write` only where it is needed',
        'Never stores a long-lived credential in durable storage without an explicit passphrase',
        'Runs Linux compiles as a separate unprivileged user, so build scripts cannot read the log relay\u2019s token from `/proc`',
        'Relies on GitHub\u2019s refusal to let an Actions token modify workflow files — so a malicious `build.rs` cannot rewrite the build',
        'Validates decrypted contents as strictly as plaintext ones, because ciphertext cannot be inspected at commit time',
      ] },
      { h: 'The residual risk, named', tone: 'warn', p: [
        'On **Windows and macOS** runners there is no separate-user boundary. A malicious `build.rs` could read the short-lived `GITHUB_TOKEN` from the log relay\u2019s process environment and use it to write to *that same crucible repository* — a disposable repo containing throwaway jobs, belonging to whoever submitted the code. It cannot reach any other repository, cannot modify workflows, and expires when the job ends.',
        'If that matters to you, prefer the Linux targets, or decommission the crucible when you are done.',
      ] },
    ],
  },
  {
    id: 'faq',
    eyebrow: '08',
    title: 'Questions',
    intro: null,
    faq: [
      ['Is Thermite a sandbox?',
        'No. It is a build service that runs your code on GitHub\u2019s runners. It provides no containment of its own and does not claim any. Compiling Rust executes build scripts and procedural macros with full runner privileges.'],
      ['Can Thermite see my source?',
        'There is no "Thermite" to see it. The page runs in your browser and writes directly to your repository. What is true is that your crucible is public, so anyone can read a plaintext pour while it exists. Encrypted pours store ciphertext instead.'],
      ['What exactly does encrypted mode protect?',
        'Confidentiality at rest in the public repository and in the published artifact. Your source is ciphertext in the repo, your binary is ciphertext in the release, and the build log is sealed. It does not protect the build environment — the runner decrypts your source in order to compile it.'],
      ['What happens if I lose my artifact private key?',
        'The ingot cannot be opened. Not by you, not by Thermite, not by GitHub. There is no escrow and no recovery, deliberately — a recovery path would be a way for someone else to open your data. Rebuild from source with a new key.'],
      ['Where are builds executed?',
        'On GitHub-hosted runners: `ubuntu-latest`, `windows-latest` or `macos-latest`, depending on the target. Never on a self-hosted runner, and never on any machine belonging to Thermite.'],
      ['Why is my crucible repository public?',
        'GitHub makes Actions minutes unmetered for public repositories and metered for private ones. A private crucible would consume your free 2,000 minutes a month within a few dozen builds. If your source must not be public, use an encrypted pour.'],
      ['Why does Thermite need GitHub access?',
        'To create the crucible, commit your pour, install the workflow, and read run status. Five permissions, all on your own account, all revocable in one click from GitHub\u2019s settings. It never asks for organisation scopes or for access to other repositories.'],
      ['Can I delete my crucible?',
        'Yes, at any time. Use **Decommission crucible** in the ledger, or delete it from GitHub\u2019s settings. Nothing else on your account is affected, and Thermite will offer to build a fresh one next time you pour.'],
      ['How long are artifacts kept?',
        'Release assets until Thermite\u2019s cleanup removes them, roughly 24 hours after the pour. Actions artifacts until their own expiry, which the interface shows you. Neither is a backup — download anything you want to keep.'],
      ['What happens if a build fails?',
        'No release, no artifact, no placeholder. The log is still published and the compiler\u2019s errors are parsed into a structured list with file, line and error code. Failed pours are kept by default, because their logs are usually the point.'],
      ['Can I switch GitHub accounts?',
        'Sign out first. That clears the token, the session, the cached identity and every in-memory reference to the previous crucible. Thermite will not carry one account\u2019s repository into another account\u2019s session.'],
      ['Does Thermite work without any server at all?',
        'Yes, in its default mode. The one thing a static page provably cannot do is exchange an OAuth code for a token — GitHub\u2019s login endpoints send no CORS headers and require a client secret. That is why the default sign-in is a token you create yourself, and why the optional device-flow relay is a separate, stateless component you may simply not deploy.'],
    ],
  },
];

// ═══════════════════════════════════════════════════════════ rendering ══════

/** Minimal inline markup: **bold** and `code`. Everything is escaped first. */
function rich(text) {
  const span = document.createElement('span');
  span.innerHTML = esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  return span;
}

function paragraphs(list, cls = 'doc__p') {
  return (list || []).map((t) => el('p', { class: cls }, rich(t)));
}

export function renderTerms(root) {
  root.replaceChildren(
    el('header', { class: 'doc__head' },
      el('p', { class: 'eyebrow', text: `Terms · version ${TERMS.version}` }),
      el('h1', { class: 'doc__title', text: TERMS.title }),
      el('p', { class: 'doc__stand' }, rich(TERMS.standfirst)),
    ),
    ...TERMS.sections.map((s) => el('section', {
      class: 'doc__section', id: `terms-${s.id}`, 'data-tone': s.tone || 'plain',
    },
      el('p', { class: 'eyebrow', text: s.eyebrow }),
      el('h2', { class: 'doc__h2' }, rich(s.title)),
      ...paragraphs(s.body),
      s.list ? el('ul', { class: 'doc__list' }, ...s.list.map((t) => el('li', {}, rich(t)))) : null,
      s.split ? el('div', { class: 'doc__split' }, ...s.split.map((c) =>
        el('div', { class: 'doc__col' },
          el('h3', { class: 'doc__h3' }, rich(c.h)),
          el('ul', { class: 'doc__list' }, ...c.items.map((t) => el('li', {}, rich(t))))))) : null,
      ...paragraphs(s.after),
    )),
  );
}

export function renderDocs(root, navRoot, onNav) {
  navRoot.replaceChildren(...DOCS.map((c) => el('button', {
    class: 'docnav', type: 'button', 'data-doc': c.id,
    onclick: () => onNav(c.id),
  },
    el('span', { class: 'docnav__n', text: c.eyebrow }),
    el('span', { class: 'docnav__t', text: c.title }),
  )));

  root.replaceChildren(...DOCS.map((c) => el('section', { class: 'doc__chapter', id: `doc-${c.id}` },
    el('p', { class: 'eyebrow', text: `${c.eyebrow} — chapter` }),
    el('h2', { class: 'doc__title', text: c.title }),
    c.intro ? el('p', { class: 'doc__stand' }, rich(c.intro)) : null,

    ...(c.blocks || []).map((b) => el('div', { class: 'doc__block', 'data-tone': b.tone || 'plain' },
      el('h3', { class: 'doc__h3' }, rich(b.h)),
      ...paragraphs(b.p),
      b.list ? el('ul', { class: 'doc__list' }, ...b.list.map((t) => el('li', {}, rich(t)))) : null,
      b.steps ? el('ol', { class: 'doc__steps' }, ...b.steps.map(([h, d]) =>
        el('li', {}, el('b', {}, rich(h)), el('span', {}, rich(d))))) : null,
      b.flow ? el('div', { class: 'doc__flow' }, ...b.flow.map((s, i) => [
        el('span', { class: 'doc__flowstep', text: s }),
        i < b.flow.length - 1 ? el('span', { class: 'doc__flowarrow', text: '↓' }) : null,
      ].filter(Boolean)).flat()) : null,
      b.split ? el('div', { class: 'doc__split' }, ...b.split.map((col) =>
        el('div', { class: 'doc__col' },
          el('h4', { class: 'doc__h4' }, rich(col.h)),
          el('ul', { class: 'doc__list' }, ...col.items.map((t) => el('li', {}, rich(t))))))) : null,
    )),

    c.faq ? el('div', { class: 'doc__faq' }, ...c.faq.map(([q, a]) =>
      el('details', { class: 'qa' },
        el('summary', {}, rich(q)),
        el('div', { class: 'qa__a' }, rich(a))))) : null,
  )));
}
