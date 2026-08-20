// THERMITE — GitHub API client.
//
// One place where the token is used, one place where failure is interpreted.
// The token is only ever an Authorization header, only ever to api.github.com,
// and the origin is asserted on every call.

import { APP } from './config.js';
import { sleep, backoff } from './util.js';

const ORIGIN = 'https://api.github.com';

export class ApiError extends Error {
  constructor(status, message, { body, url, response } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.response = response;
  }
  /** What the user should actually do about it. */
  get advice() {
    switch (this.status) {
      case 401: return 'Your forge key is no longer valid. Sign in again.';
      case 403: return this.body?.message?.includes('rate limit')
        ? 'GitHub is rate-limiting this key. Thermite will resume automatically.'
        : 'GitHub refused this operation. The key is probably missing a permission.';
      case 404: return 'Not found — either it does not exist, or the key cannot see it.';
      case 409: return 'Something changed underneath this request. Retrying usually fixes it.';
      case 422: return this.body?.message || 'GitHub rejected the contents of this request.';
      default:  return this.status >= 500 ? 'GitHub is having a moment. Try again shortly.' : '';
    }
  }
}

export const budget = {
  remaining: null,
  limit: null,
  resetAt: null,
  observe(res) {
    const r = res.headers.get('x-ratelimit-remaining');
    if (r != null) {
      this.remaining = Number(r);
      this.limit = Number(res.headers.get('x-ratelimit-limit'));
      this.resetAt = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      listeners.forEach((f) => f(this));
    }
  },
};
const listeners = new Set();
export const onBudget = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export class GitHub {
  #token = null;
  #etags = new Map();
  #cache = new Map();

  setToken(t) { this.#token = t; this.#etags.clear(); this.#cache.clear(); }
  get authed() { return !!this.#token; }

  /**
   * @param {string} path  API path, or a full https://api.github.com URL.
   * @param {object} opts  { method, body, accept, etag, retries, signal, raw }
   */
  async call(path, opts = {}) {
    const url = path.startsWith('http') ? path : ORIGIN + path;
    if (!url.startsWith(ORIGIN + '/')) {
      throw new Error('Thermite refuses to send a credential anywhere but api.github.com');
    }

    const { method = 'GET', body, accept = 'application/vnd.github+json',
            etag = false, retries = 4, signal, raw = false } = opts;

    const headers = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const cacheKey = method + ' ' + url;
    if (etag && this.#etags.has(cacheKey)) headers['If-None-Match'] = this.#etags.get(cacheKey);

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method, headers, signal,
          body: body === undefined ? undefined : JSON.stringify(body),
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        lastErr = new ApiError(0, 'Network unreachable. Check your connection.', { url });
        if (attempt === retries) throw lastErr;
        await sleep(backoff(attempt));
        continue;
      }

      budget.observe(res);

      // 304: nothing changed, and it cost no rate-limit budget.
      if (res.status === 304 && etag) return { notModified: true, data: this.#cache.get(cacheKey) };

      if (res.status === 403 || res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const remaining = Number(res.headers.get('x-ratelimit-remaining'));
        if (retryAfter || remaining === 0) {
          const waitMs = retryAfter ? retryAfter * 1000
            : Math.max(0, reset * 1000 - Date.now()) + 1000;
          if (waitMs > 90_000 || attempt === retries) {
            throw new ApiError(res.status, 'GitHub rate limit reached.', {
              body: await safeJson(res), url, response: res,
            });
          }
          await sleep(waitMs);
          continue;
        }
      }

      if (res.status >= 500) {
        lastErr = new ApiError(res.status, `GitHub returned ${res.status}.`, { url, response: res });
        if (attempt === retries) throw lastErr;
        await sleep(backoff(attempt));
        continue;
      }

      if (!res.ok) {
        const b = await safeJson(res);
        throw new ApiError(res.status, b?.message || `${res.status} ${res.statusText}`, {
          body: b, url, response: res,
        });
      }

      const tag = res.headers.get('etag');
      let data;
      if (raw) data = await res.text();
      else if (res.status === 204) data = null;
      else data = await safeJson(res);

      if (etag && tag) { this.#etags.set(cacheKey, tag); this.#cache.set(cacheKey, data); }
      return { data, response: res, notModified: false };
    }
    throw lastErr;
  }

  async get(path, opts) { return (await this.call(path, opts)).data; }
  async post(path, body, opts) { return (await this.call(path, { ...opts, method: 'POST', body })).data; }
  async patch(path, body, opts) { return (await this.call(path, { ...opts, method: 'PATCH', body })).data; }
  async put(path, body, opts) { return (await this.call(path, { ...opts, method: 'PUT', body })).data; }
  async del(path, opts) { return (await this.call(path, { ...opts, method: 'DELETE' })).data; }

  /** Follows Link headers. Bounded, because an unbounded loop is a rate-limit bug. */
  async paginate(path, { max = 300, ...opts } = {}) {
    let url = path;
    const out = [];
    for (let page = 0; page < 10 && url && out.length < max; page++) {
      const { data, response } = await this.call(url, opts);
      const items = Array.isArray(data) ? data : (data.workflow_runs || data.artifacts || []);
      out.push(...items);
      const link = response?.headers.get('link') || '';
      const next = /<([^>]+)>;\s*rel="next"/.exec(link);
      url = next ? next[1] : null;
    }
    return out.slice(0, max);
  }

  // ---------------------------------------------------------------- helpers --

  me() { return this.get('/user'); }

  repo(owner, name) { return this.get(`/repos/${owner}/${name}`); }

  async runsForCommit(owner, repo, sha) {
    const { data } = await this.call(
      `/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=20`, { etag: true });
    return data?.workflow_runs || [];
  }

  async runJobs(owner, repo, runId) {
    const { data } = await this.call(
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=50`, { etag: true });
    return data?.jobs || [];
  }

  async runArtifacts(owner, repo, runId) {
    const { data } = await this.call(
      `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`, { etag: true });
    return data?.artifacts || [];
  }

  async releaseByTag(owner, repo, tag) {
    try { return await this.get(`/repos/${owner}/${repo}/releases/tags/${tag}`, { etag: true }); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  /** Raw file contents from any ref. CORS-clean, unlike the Actions log endpoint. */
  async rawFile(owner, repo, path, ref) {
    try {
      const { data, notModified } = await this.call(
        `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        { accept: 'application/vnd.github.raw', raw: true, etag: true, retries: 1 });
      return { text: data ?? '', notModified };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
}

async function safeJson(res) {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 400) }; }
}

export const gh = new GitHub();
export { APP };
