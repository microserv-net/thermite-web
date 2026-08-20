// THERMITE — device-flow relay.
//
// This exists for exactly one reason: GitHub's OAuth endpoints on github.com
// send no CORS headers and require a client secret, so a browser cannot talk to
// them and a static page cannot hold the secret. That is a wall, not a design
// choice.
//
// This is the smallest thing that gets past it. It has no database, no session,
// no logging, no state of any kind. It adds a secret to two requests and adds
// CORS headers to the two responses. Deploy it or don't — leave RELAY_URL empty
// in js/config.js and Thermite runs entirely on fine-grained tokens with no
// infrastructure at all.
//
// Cloudflare Workers:
//   wrangler secret put GITHUB_CLIENT_SECRET
//   wrangler deploy
//
// Environment:
//   GITHUB_CLIENT_SECRET   the GitHub App's client secret
//   ALLOWED_ORIGIN         e.g. https://you.github.io   (exact match, no wildcard)

const GITHUB = {
  code: 'https://github.com/login/device/code',
  token: 'https://github.com/login/oauth/access_token',
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '';

    // Exact-origin only. A wildcard here would let any page on the internet use
    // this relay to mint tokens against your client id.
    if (allowed && origin !== allowed) {
      return new Response('Forbidden origin', { status: 403 });
    }

    const cors = {
      'Access-Control-Allow-Origin': allowed || origin || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));

    let upstream, payload;
    if (url.pathname.endsWith('/device/code')) {
      upstream = GITHUB.code;
      payload = { client_id: body.client_id, scope: body.scope || '' };
    } else if (url.pathname.endsWith('/device/token')) {
      upstream = GITHUB.token;
      payload = {
        client_id: body.client_id,
        device_code: body.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_secret: env.GITHUB_CLIENT_SECRET,
      };
    } else {
      return new Response('Not found', { status: 404, headers: cors });
    }

    const res = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });

    // Passed through verbatim. Nothing is inspected, stored or logged: the
    // token is between the user and GitHub.
    return new Response(await res.text(), {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
