// THERMITE — watching a pour.
//
// Everything here is observed, never inferred. Stages advance on evidence from
// the Actions API and from markers the workflow actually printed. There is no
// percentage, because GitHub does not expose one, and inventing one would be a
// lie told at 60fps.

import { APP, POLL } from './config.js';
import { gh, budget, ApiError } from './github.js';
import { sleep, stripAnsi, dec } from './util.js';
import { unseal, parseHeader, CryptoError } from './crypto.js';
import { held } from './keys.js';

const NAME = APP.repoName;
const STORE = 'thermite.pours';

export const STAGES = ['SOURCE', 'INGEST', 'IGNITE', 'COMPILE', 'LINK', 'CAST', 'READY'];

export const STATUS = {
  QUEUED:    { label: 'Queued',    tone: 'cold' },
  STARTING:  { label: 'Starting',  tone: 'warm' },
  BUILDING:  { label: 'Building',  tone: 'hot' },
  SUCCESS:   { label: 'Success',   tone: 'quench' },
  FAILED:    { label: 'Failed',    tone: 'fault' },
  CANCELLED: { label: 'Cancelled', tone: 'cold' },
  EXPIRED:   { label: 'Expired',   tone: 'cold' },
  UNKNOWN:   { label: 'Unknown',   tone: 'cold' },
};

// ------------------------------------------------------------ local store ---
// Non-sensitive pour metadata only, so history survives a reload. Everything
// authoritative is re-read from GitHub; this is just the index.

export function loadPours() {
  try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; }
}

export function savePour(p) {
  const all = loadPours().filter((x) => x.id !== p.id);
  all.unshift({ ...p, savedAt: Date.now() });
  try { localStorage.setItem(STORE, JSON.stringify(all.slice(0, 100))); } catch {}
}

export function forgetPours() { try { localStorage.removeItem(STORE); } catch {} }

// ---------------------------------------------------------------- watcher ---

export class PourWatcher extends EventTarget {
  /**
   * @param {{login:string, id:string, commitSha:string, submittedAt?:string}} pour
   */
  constructor(pour) {
    super();
    this.pour = pour;
    this.state = {
      id: pour.id,
      commitSha: pour.commitSha,
      status: 'QUEUED',
      stage: 'INGEST',
      run: null,
      job: null,
      log: '',
      logLines: [],
      lineRate: 0,
      meta: null,
      artifact: null,
      download: null,
      releaseUrl: null,
      error: null,
      logStreamLost: false,
      sealed: !!pour.sealed,
      logSealed: false,
      logLocked: false,        // sealed, and no private key loaded in this tab
      retrieved: null,         // set once the ingot is verifiably in the browser
      startedAt: pour.submittedAt ? Date.parse(pour.submittedAt) : Date.now(),
      finishedAt: null,
      lastPollAt: null,
    };
    this.stopped = false;
    this._sinceRunAppeared = 0;
    this._tailBytes = 0;
    this._lastLineCount = 0;
    this._misses = 0;
  }

  emit() { this.dispatchEvent(new CustomEvent('update', { detail: this.state })); }

  stop() { this.stopped = true; }

  get elapsed() {
    return (this.state.finishedAt || Date.now()) - this.state.startedAt;
  }

  async start() {
    this.emit();
    let tick = 0;
    while (!this.stopped) {
      const factor = budget.remaining != null && budget.remaining < POLL.budgetWarn ? POLL.slowFactor : 1;
      try {
        await this.pollRun();
        if (tick % 1 === 0) await this.pollLog();
        this.state.lastPollAt = Date.now();
        this.state.error = null;
      } catch (e) {
        this.state.error = e instanceof ApiError
          ? `${e.message}${e.advice ? ' — ' + e.advice : ''}`
          : e.message;
      }
      this.emit();

      if (this.isTerminal()) {
        // Two more passes after completion: the release asset and the artifact
        // record both land a moment after the run reports done.
        if (++this._misses > 3) break;
      }

      if (budget.remaining != null && budget.remaining < POLL.budgetStop && !this.isTerminal()) {
        this.state.error = `Paused: only ${budget.remaining} GitHub API calls left this hour.`;
        this.emit();
        await sleep(30_000);
        continue;
      }

      await sleep(POLL.log * factor);
      tick++;
    }
    this.emit();
  }

  isTerminal() {
    return ['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(this.state.status);
  }

  // -------------------------------------------------------------- run ------

  async pollRun() {
    const { login } = this.pour;
    const runs = await gh.runsForCommit(login, NAME, this.state.commitSha);
    const run = runs.find((r) => r.path?.endsWith('build.yml')) || runs[0] || null;

    if (!run) {
      this._sinceRunAppeared++;
      // GitHub normally creates the run within a couple of seconds. If it never
      // appears, the most likely causes are worth naming rather than spinning.
      if (this._sinceRunAppeared > 24) {
        this.state.status = 'UNKNOWN';
        this.state.error =
          'GitHub never created a run for this commit. Actions may be disabled on the ' +
          'crucible, or the commit did not add a job directory.';
      }
      return;
    }

    this.state.run = {
      id: run.id,
      url: run.html_url,
      status: run.status,
      conclusion: run.conclusion,
      startedAt: run.run_started_at,
      attempt: run.run_attempt,
    };
    if (run.run_started_at) this.state.startedAt = Date.parse(run.run_started_at);

    const jobs = await gh.runJobs(login, NAME, run.id);
    const job = jobs.find((j) => j.name?.includes(this.state.id)) || jobs[jobs.length - 1] || null;
    if (job) {
      this.state.job = {
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        runnerName: job.runner_name,
        labels: job.labels,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        steps: (job.steps || []).map((s) => ({
          name: s.name, status: s.status, conclusion: s.conclusion,
        })),
      };
      if (job.completed_at) this.state.finishedAt = Date.parse(job.completed_at);
    }

    // Detect the "detect said no" case: the run completes with only the detect
    // job, meaning the commit did not carry a valid pour.
    if (run.status === 'completed' && !jobs.some((j) => j.name?.includes(this.state.id))) {
      this.state.status = 'FAILED';
      this.state.stage = 'INGEST';
      this.state.error =
        'The build workflow ran but refused this commit. Open the run\u2019s summary on ' +
        'GitHub for the exact reason.';
      this.state.finishedAt = Date.parse(run.updated_at || Date.now());
      return;
    }

    this.state.status = deriveStatus(run, job);
    this.state.stage = deriveStage(this.state);

    if (this.state.status === 'SUCCESS') await this.resolveIngot(run.id);
  }

  // -------------------------------------------------------------- logs -----

  async pollLog() {
    const { login, id } = this.pour;
    try {
      const [plainRes, sealedRes, stateRes] = await Promise.all([
        this.state.logSealed ? null : gh.rawFile(login, NAME, `logs/${id}.log`, APP.logBranch),
        this.state.sealed || this.state.logSealed
          ? gh.rawFile(login, NAME, `logs/${id}.log.tenc`, APP.logBranch) : null,
        gh.rawFile(login, NAME, `logs/${id}.state.json`, APP.logBranch),
      ]);

      let logRes = plainRes;
      if (sealedRes?.text) {
        this.state.logSealed = true;
        logRes = await this.openSealedLog(sealedRes);
      }

      if (logRes && !logRes.notModified) {
        const text = logRes.text || '';
        if (text !== this.state.log) {
          this.state.log = text;
          const lines = text.split('\n');
          this.state.lineRate = Math.max(0, lines.length - this._lastLineCount);
          this._lastLineCount = lines.length;
          this.state.logLines = lines;
        } else {
          this.state.lineRate = 0;
        }
      } else if (logRes?.notModified) {
        this.state.lineRate = 0;
      }

      if (stateRes && stateRes.text) {
        try { this.state.meta = JSON.parse(stateRes.text); } catch { /* mid-write */ }
      }

      // The log branch is written by the runner. If the run is clearly going
      // and nothing has appeared for a while, say so instead of showing an
      // empty terminal forever.
      const running = this.state.status === 'BUILDING';
      this.state.logStreamLost = running && !this.state.log &&
        Date.now() - this.state.startedAt > 90_000;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }

  /**
   * A sealed pour's log is encrypted with the artifact public key, because
   * compiler diagnostics quote source and the log branch is public. It can only
   * be read here with the private key the user holds.
   */
  async openSealedLog(res) {
    if (!held.artifact) {
      this.state.logLocked = true;
      return { text: '', notModified: true };
    }
    if (res.notModified) return { text: this.state.log, notModified: true };
    try {
      const b64 = (res.text || '').replace(/\s+/g, '');
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const { bytes: plain } = await unseal(bytes, held.artifact);
      this.state.logLocked = false;
      return { text: dec.decode(plain), notModified: false };
    } catch (e) {
      this.state.logLocked = true;
      this.state.error = e instanceof CryptoError
        ? `Sealed log: ${e.message}` : 'The sealed log could not be opened.';
      return { text: this.state.log, notModified: true };
    }
  }

  // ------------------------------------------------------------ artifact ---

  async resolveIngot(runId) {
    const { login, id } = this.pour;

    if (!this.state.artifact) {
      const arts = await gh.runArtifacts(login, NAME, runId);
      const mine = arts.find((a) => a.name === `thermite-${id}`);
      if (mine) {
        this.state.artifact = {
          id: mine.id,
          name: mine.name,
          bytes: mine.size_in_bytes,
          expired: mine.expired,
          expiresAt: mine.expires_at,
          url: `https://github.com/${login}/${NAME}/actions/runs/${runId}/artifacts/${mine.id}`,
        };
        if (mine.expired) this.state.status = 'EXPIRED';
      }
    }

    if (!this.state.download) {
      const rel = await gh.releaseByTag(login, NAME, `pour-${id}`);
      if (rel) {
        this.state.releaseUrl = rel.html_url;
        const asset = (rel.assets || []).find((a) => a.name.startsWith(`thermite-${id}`));
        const logAsset = (rel.assets || []).find((a) => a.name === 'pour.log' || a.name === 'pour.log.tenc');
        if (asset) {
          this.state.download = {
            name: asset.name,
            bytes: asset.size,
            // Public repo: a plain unauthenticated URL. This is the download
            // the button uses, because the Actions artifact endpoint redirects
            // to a host with no CORS headers and a browser cannot follow it.
            url: asset.browser_download_url,
            sealed: asset.name.endsWith('.tenc'),
          };
        }
        if (logAsset) this.state.fullLogUrl = logAsset.browser_download_url;
      }
    }
  }
}

// -------------------------------------------------------------- derivation --

function deriveStatus(run, job) {
  if (!run) return 'QUEUED';
  if (run.status === 'queued' || run.status === 'requested' || run.status === 'pending') return 'QUEUED';
  if (run.status === 'waiting') return 'QUEUED';
  if (run.status === 'in_progress') {
    if (!job || job.status === 'queued') return 'STARTING';
    return 'BUILDING';
  }
  switch (run.conclusion) {
    case 'success': return 'SUCCESS';
    case 'failure': case 'timed_out': case 'startup_failure': return 'FAILED';
    case 'cancelled': return 'CANCELLED';
    case 'skipped': return 'CANCELLED';
    default: return 'UNKNOWN';
  }
}

/** Stage comes from real markers in the real log, and from real job state. */
function deriveStage(s) {
  if (s.status === 'SUCCESS') return 'READY';
  if (s.status === 'FAILED' || s.status === 'CANCELLED') {
    return s.log ? (stageFromLog(s.log) || 'COMPILE') : 'INGEST';
  }
  if (s.status === 'QUEUED') return 'INGEST';
  const fromLog = stageFromLog(s.log || '');
  if (fromLog) return fromLog;
  if (s.meta?.phase && STAGES.includes(s.meta.phase)) return s.meta.phase;
  return s.status === 'BUILDING' ? 'IGNITE' : 'INGEST';
}

function stageFromLog(log) {
  const plain = stripAnsi(log);
  if (/^##thermite:packaged/m.test(plain) || /^##thermite:ingot/m.test(plain)) return 'CAST';
  if (/^##thermite:linking/m.test(plain) || /^\s*Finished\b/m.test(plain)) return 'LINK';
  if (/^\s{3}Compiling\b/m.test(plain) || /^##thermite:compiling/m.test(plain)) return 'COMPILE';
  if (/^##thermite:toolchain-ready/m.test(plain)) return 'IGNITE';
  return null;
}

/** Pull structured compiler errors out of the human log for the failure panel. */
export function diagnosticsFrom(log) {
  const plain = stripAnsi(log || '');
  const out = [];
  const re = /^(error(?:\[E\d+\])?|warning): (.+)$/gm;
  let m;
  while ((m = re.exec(plain)) && out.length < 40) {
    const rest = plain.slice(m.index, m.index + 900);
    const at = /^\s*-->\s+(\S+?):(\d+):(\d+)/m.exec(rest);
    out.push({
      level: m[1].startsWith('error') ? 'error' : 'warning',
      code: /\[(E\d+)\]/.exec(m[1])?.[1] || null,
      message: m[2],
      file: at?.[1] || null,
      line: at ? Number(at[2]) : null,
      column: at ? Number(at[3]) : null,
    });
  }
  return out;
}

/** Rehydrate a stored pour from GitHub alone — history needs no database. */
export async function rehydrate(login, pour) {
  const w = new PourWatcher({ ...pour, login });
  try {
    await w.pollRun();
    await w.pollLog();
  } catch (e) {
    w.state.error = e.message;
  }
  return w.state;
}
