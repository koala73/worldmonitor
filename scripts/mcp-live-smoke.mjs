#!/usr/bin/env node
// Live production smoke for the MCP surface (#4937 / #4938 regression net).
//
// WHY THIS EXISTS: the two customer-facing MCP outages of 2026-07-06 were
// invisible to unit tests by construction:
//   #4937 — an advertised-but-auth-gated method (prompts/list) answered
//           HTTP 401 with JSON-RPC id:null; strict SDK clients (Claude
//           Desktop via mcp-remote) can't correlate that, hang 30s, and mark
//           the server unstable. Unit tests exercised the method WITH
//           credentials, so the anonymous path was never walked.
//   #4938 — the Cloudflare apex→www 301 excluded /mcp but not /oauth/*, so
//           mcp-remote's OAuth dynamic-client-registration POST was redirected,
//           converted to GET, and died with 405. No in-process test can see a
//           CDN redirect rule.
//
// This script does what a strict anonymous MCP client does, against LIVE
// production, on BOTH hosts (the apex serves /mcp too, and apex-vs-www split
// is exactly where #4938 lived):
//   1. initialize → notifications/initialized → ping (the connect sequence)
//   2. a capability walk DERIVED from the initialize response — every
//      advertised capability's methods must answer 200 with the id echoed
//   3. the auth wall — anonymous tools/call must answer 401 carrying the
//      origin's WWW-Authenticate challenge (fast, never a hang; the body is
//      deliberately NOT parsed — the wire contract a strict client acts on is
//      status + challenge header, and a CDN-fabricated 401 would lack it)
//   4. OAuth routing — the endpoints declared by
//      /.well-known/oauth-authorization-server must be reachable by POST
//      (no 3xx redirect, no 405 — the #4938 fingerprints). Probes use a
//      malformed body so nothing is ever registered/minted.
//   5. The discovery surface and the cache key behind it. /mcp and
//      /.well-known/mcp content-negotiate on Accept: a plain GET is a
//      crawler/human discovery read, an `Accept: text/event-stream` GET is a
//      transport stream-open that must STILL answer 405. Vercel's edge keys
//      on URL alone unless the origin sends Vary, and it caches these routes
//      — a cacheable discovery 200 without Vary is replayed to the SSE GET,
//      handing an SDK client a document body where the transport contract
//      requires 405. This was reproduced on production against
//      /.well-known/mcp (`x-vercel-cache: HIT` on the SSE GET). Like #4938 it
//      lives in the CDN and is invisible to every in-process test, so the
//      probe warms the cache with the plain GET first and only then issues
//      the SSE GET.
//   6. Variant-subdomain canonicalization — crawler-facing GETs on the
//      product variants must 308 to the apex /mcp (Google reported the
//      variant URLs as unreachable), while POST must NOT be redirected.
//
// Every request runs under a hard timeout that covers BODY READ, not just
// response headers — a server/CDN that sends headers then stalls the body
// reports as HANG instead of idling until the workflow timeout (the fetch
// AbortSignal aborts the body stream too, so the timer is held until the
// text is fully read).
//
// Request budget: the anonymous /mcp limiter is 60/min shared per client IP
// and both hosts see the same runner IP, so the walk caps its fan-out
// (MAX_PROMPT_GETS / MAX_RESOURCE_READS) and reuses each catalog listing
// instead of re-fetching it per sub-walk. Current shape: ≤16 /mcp POSTs per
// host (≤32 total) + 3 non-/mcp OAuth probes per host — comfortable headroom
// under the bucket even as the prompt/resource catalogs grow. The discovery
// probes (5) add 6 GET/HEAD requests per host that cost NOTHING against the bucket: both
// the discovery branch and the transport 405 return ahead of
// applyAnonDiscoveryLimit (the replay-shaped GET stops at auth). The variant
// probes (6) add one limiter-counted ping plus four GET/HEADs per variant host;
// redirect, stream-open, and unauthenticated replay all stop before a limiter.
//
// Usage: node scripts/mcp-live-smoke.mjs
//   MCP_SMOKE_HOSTS=https://a,https://b  overrides the default host list.

const HOSTS = (process.env.MCP_SMOKE_HOSTS ?? 'https://worldmonitor.app,https://www.worldmonitor.app')
  .split(',').map((h) => h.trim()).filter(Boolean);
const TIMEOUT_MS = 15_000;
const USER_AGENT = 'WorldMonitor-MCP-Smoke/1.0 (+https://worldmonitor.app; github-actions)';
// Fan-out caps: keep the walk inside the shared anon 60/min/IP bucket as the
// catalogs grow. 6 covers today's full prompt registry and concrete resource
// list; growth beyond a cap trims coverage (logged), never correctness.
const MAX_PROMPT_GETS = 6;
const MAX_RESOURCE_READS = 6;

// Capability key → methods the walk exercises. A capability advertised by the
// anonymous initialize with no mapping here fails the run — mirror of
// tests/mcp-anon-client-conformance.test.mjs.
const CAPABILITY_METHODS = {
  tools: ['tools/list'],
  prompts: ['prompts/list', 'prompts/get'],
  resources: ['resources/list', 'resources/templates/list', 'resources/read'],
  logging: ['logging/setLevel'],
  extensions: null,
};

const failures = [];
let checks = 0;

function fail(host, check, detail) {
  failures.push({ host, check, detail });
  console.log(`  ✖ [${host}] ${check}: ${detail}`);
}

function ok(host, check, detail = '') {
  console.log(`  ✔ [${host}] ${check}${detail ? ` — ${detail}` : ''}`);
}

// Fetch with a hard timeout spanning the WHOLE exchange including body read.
// The AbortSignal is wired into fetch, so aborting mid-body rejects the
// text() promise — clearing the timer only after the body is consumed is what
// turns a stalled-body response into a fast HANG failure instead of a job
// that idles until the workflow timeout.
async function timedFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      ...init,
      headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

let nextId = 1;
// One JSON-RPC call. Returns the parsed result on success; records a failure
// and returns null otherwise. `expectStatus: 401` is the auth-wall probe: it
// asserts the origin's WWW-Authenticate challenge and deliberately skips body
// parsing (see header comment).
async function rpc(host, method, params, { expectStatus = 200, label } = {}) {
  const check = label ?? method;
  checks += 1;
  const id = method.startsWith('notifications/') ? undefined : nextId++;
  const payload = { jsonrpc: '2.0', method, params };
  if (id !== undefined) payload.id = id;
  let res, text, ms;
  try {
    ({ res, text, ms } = await timedFetch(`${host}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    }));
  } catch (err) {
    fail(host, check, `HANG/transport error inside the ${TIMEOUT_MS}ms budget: ${err?.name ?? err}`);
    return null;
  }
  if (res.status !== expectStatus) {
    fail(host, check, `expected HTTP ${expectStatus}, got ${res.status} — a non-200 on a discovery method is uncorrelatable and hangs strict SDK clients (#4937)`);
    return null;
  }
  if (expectStatus === 202) { ok(host, check, `${ms}ms`); return {}; }
  if (expectStatus === 401) {
    if (!(res.headers.get('www-authenticate') ?? '').includes('Bearer')) {
      fail(host, check, '401 lacks the WWW-Authenticate Bearer challenge — not the origin MCP auth wall (CDN-fabricated 401?)');
      return null;
    }
    ok(host, check, `${ms}ms`);
    return {};
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(host, check, `HTTP ${res.status} but body is not JSON`);
    return null;
  }
  if (body.id !== id) {
    fail(host, check, `response id ${JSON.stringify(body.id)} does not echo request id ${id} — uncorrelatable (#4937)`);
    return null;
  }
  if (body.error) {
    fail(host, check, `JSON-RPC error: ${JSON.stringify(body.error)}`);
    return null;
  }
  ok(host, check, `${ms}ms`);
  return body.result ?? body;
}

async function walkHost(host) {
  console.log(`\n── ${host} ──`);

  // 1. Connect sequence.
  const init = await rpc(host, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'wm-mcp-live-smoke', version: '1.0' },
  });
  if (!init) return; // nothing else is meaningful if the handshake fails
  await rpc(host, 'notifications/initialized', undefined, { expectStatus: 202 });
  await rpc(host, 'ping', {});

  // 2. Derived capability walk. Catalog listings are fetched once per host
  //    and reused by their sub-walks (request-budget discipline, see header).
  const capabilities = init.capabilities ?? {};
  let promptsList = null;
  let resourcesList = null;
  for (const capability of Object.keys(capabilities)) {
    if (!(capability in CAPABILITY_METHODS)) {
      checks += 1;
      fail(host, `capability:${capability}`,
        'advertised on the anonymous initialize but unmapped in this smoke — add the mapping AND ensure its methods are anonymously servable (#4937)');
      continue;
    }
    const methods = CAPABILITY_METHODS[capability];
    if (!methods) continue;
    for (const method of methods) {
      if (method === 'tools/list') {
        const r = await rpc(host, 'tools/list', {});
        if (r && !(Array.isArray(r.tools) && r.tools.length > 0)) fail(host, 'tools/list', 'empty catalog');
      } else if (method === 'prompts/list') {
        promptsList = await rpc(host, 'prompts/list', {});
        if (promptsList && !(Array.isArray(promptsList.prompts) && promptsList.prompts.length > 0)) {
          fail(host, 'prompts/list', 'empty catalog');
        }
      } else if (method === 'prompts/get') {
        const prompts = promptsList?.prompts ?? [];
        for (const prompt of prompts.slice(0, MAX_PROMPT_GETS)) {
          const args = {};
          for (const a of prompt.arguments ?? []) if (a.required) args[a.name] = 'DE';
          await rpc(host, 'prompts/get', { name: prompt.name, arguments: args }, { label: `prompts/get(${prompt.name})` });
        }
        if (prompts.length > MAX_PROMPT_GETS) {
          console.log(`  ℹ [${host}] prompts/get walk capped at ${MAX_PROMPT_GETS} of ${prompts.length} prompts (request budget)`);
        }
      } else if (method === 'resources/list') {
        resourcesList = await rpc(host, 'resources/list', {});
        if (resourcesList && !(Array.isArray(resourcesList.resources) && resourcesList.resources.length > 0)) {
          fail(host, 'resources/list', 'empty catalog');
        }
      } else if (method === 'resources/templates/list') {
        const r = await rpc(host, 'resources/templates/list', {});
        if (r && !Array.isArray(r.resourceTemplates)) fail(host, 'resources/templates/list', 'missing resourceTemplates array');
      } else if (method === 'resources/read') {
        const resources = resourcesList?.resources ?? [];
        for (const resource of resources.slice(0, MAX_RESOURCE_READS)) {
          await rpc(host, 'resources/read', { uri: resource.uri }, { label: `resources/read(${resource.uri})` });
        }
        if (resources.length > MAX_RESOURCE_READS) {
          console.log(`  ℹ [${host}] resources/read walk capped at ${MAX_RESOURCE_READS} of ${resources.length} resources (request budget)`);
        }
      } else if (method === 'logging/setLevel') {
        await rpc(host, 'logging/setLevel', { level: 'info' });
      }
    }
  }

  // 3. The auth wall must still answer — fast, with the origin's 401 +
  //    WWW-Authenticate challenge; never a hang, never a silent anonymous
  //    data leak (200).
  await rpc(host, 'tools/call', { name: 'get_market_data', arguments: {} },
    { expectStatus: 401, label: 'tools/call (anon → 401 wall)' });

  // 4. OAuth routing (#4938): every endpoint the metadata declares must be
  //    POST-reachable — a 3xx means a CDN redirect will strip the POST
  //    (fetch converts 301/302 POST→GET), a 405 means the redirect already
  //    ate it. Malformed bodies keep the probes side-effect-free.
  checks += 1;
  let meta;
  try {
    const { res, text } = await timedFetch(`${host}/.well-known/oauth-authorization-server`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    meta = JSON.parse(text);
    ok(host, 'oauth metadata', 'served');
  } catch (err) {
    fail(host, 'oauth metadata', `not served: ${err?.message ?? err}`);
    return;
  }
  for (const key of ['registration_endpoint', 'token_endpoint']) {
    checks += 1;
    const endpoint = meta[key];
    if (typeof endpoint !== 'string') {
      fail(host, `oauth ${key}`, 'missing from metadata');
      continue;
    }
    try {
      const { res, ms } = await timedFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{', // malformed on purpose: reaches the origin, registers nothing
      });
      if (res.status >= 300 && res.status < 400) {
        fail(host, `oauth ${key}`, `POST answered ${res.status} redirect → ${res.headers.get('location')} — a redirected POST becomes a GET and OAuth dies with 405 (#4938)`);
      } else if (res.status === 405) {
        fail(host, `oauth ${key}`, 'POST answered 405 — endpoint not accepting POST (#4938 fingerprint)');
      } else {
        ok(host, `oauth ${key}`, `POST reaches origin (HTTP ${res.status}, ${ms}ms)`);
      }
    } catch (err) {
      fail(host, `oauth ${key}`, `HANG/transport error: ${err?.name ?? err}`);
    }
  }
}

// Discovery + cache-key contract. These requests are answered before the
// anonymous rate limiter (the discovery branch and the transport 405 both
// return ahead of it), so they cost nothing against the shared 60/min bucket.
async function probeDiscovery(host) {
  // Plain GET /mcp — the "can Google read this?" shape.
  checks += 1;
  try {
    const { res, text } = await timedFetch(`${host}/mcp`, { headers: { Accept: 'text/html,*/*' } });
    if (res.status !== 200) {
      fail(host, 'GET /mcp (crawler)', `expected 200, got ${res.status} — Search Console reports this shape as "cannot access"`);
    } else if (!/text\/markdown/i.test(res.headers.get('content-type') ?? '')) {
      fail(host, 'GET /mcp (crawler)', `expected the markdown guide, got content-type ${res.headers.get('content-type')}`);
    } else if (!/\bno-store\b/i.test(res.headers.get('cache-control') ?? '')) {
      fail(host, 'GET /mcp (crawler)', `transport URL guide must be no-store (got "${res.headers.get('cache-control')}")`);
    } else if (!/\bAccept\b(?!-)/i.test(res.headers.get('vary') ?? '')) {
      fail(host, 'GET /mcp (crawler)', `guide lacks "Vary: Accept" (got "${res.headers.get('vary')}")`);
    } else if (!/\bLast-Event-ID\b/i.test(res.headers.get('vary') ?? '')) {
      fail(host, 'GET /mcp (crawler)', `guide lacks "Vary: Last-Event-ID" (got "${res.headers.get('vary')}")`);
    } else if (!text.includes('World Monitor MCP Server')) {
      fail(host, 'GET /mcp (crawler)', 'body is not the mcp-server.md guide');
    } else {
      ok(host, 'GET /mcp (crawler)', '200 markdown guide');
    }
  } catch (err) {
    fail(host, 'GET /mcp (crawler)', `HANG/transport error: ${err?.name ?? err}`);
  }

  // HEAD must expose the same discovery metadata without a response body.
  // This is a separate deployed method path, so unit coverage cannot prove
  // that the CDN and routing layers preserve it.
  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, {
      method: 'HEAD',
      headers: { Accept: 'text/html,*/*' },
    });
    if (res.status !== 200) {
      fail(host, 'HEAD /mcp (crawler)', `expected 200, got ${res.status}`);
    } else if (!/text\/markdown/i.test(res.headers.get('content-type') ?? '')) {
      fail(host, 'HEAD /mcp (crawler)', `expected markdown metadata, got content-type ${res.headers.get('content-type')}`);
    } else if (!/\bno-store\b/i.test(res.headers.get('cache-control') ?? '')) {
      fail(host, 'HEAD /mcp (crawler)', `transport URL guide must be no-store (got "${res.headers.get('cache-control')}")`);
    } else if (!/\bAccept\b(?!-)/i.test(res.headers.get('vary') ?? '')) {
      fail(host, 'HEAD /mcp (crawler)', `guide lacks "Vary: Accept" (got "${res.headers.get('vary')}")`);
    } else if (!/\bLast-Event-ID\b/i.test(res.headers.get('vary') ?? '')) {
      fail(host, 'HEAD /mcp (crawler)', `guide lacks "Vary: Last-Event-ID" (got "${res.headers.get('vary')}")`);
    } else if (!/<https:\/\/worldmonitor\.app\/mcp>;\s*rel="canonical"/i.test(res.headers.get('link') ?? '')) {
      fail(host, 'HEAD /mcp (crawler)', `guide lacks the apex canonical Link (got "${res.headers.get('link')}")`);
    } else {
      ok(host, 'HEAD /mcp (crawler)', '200 markdown metadata');
    }
  } catch (err) {
    fail(host, 'HEAD /mcp (crawler)', `HANG/transport error: ${err?.name ?? err}`);
  }

  // The canary: an SSE stream-open on the URL just warmed must still be 405.
  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, { headers: { Accept: 'text/event-stream' } });
    if (res.status !== 405) {
      const cached = res.headers.get('x-vercel-cache') === 'HIT'
        ? ' from a CDN cache HIT — the discovery 200 is being replayed to transport clients (missing/ignored Vary)'
        : '';
      fail(host, 'GET /mcp (SSE stream open)', `expected 405, got ${res.status}${cached}`);
    } else {
      ok(host, 'GET /mcp (SSE stream open)', '405 preserved after a discovery GET');
    }
  } catch (err) {
    fail(host, 'GET /mcp (SSE stream open)', `HANG/transport error: ${err?.name ?? err}`);
  }

  // Same contract on the well-known manifest, which IS cacheable and so
  // depends on Vary rather than no-store.
  checks += 1;
  try {
    const { res, text } = await timedFetch(`${host}/.well-known/mcp`, { headers: { Accept: 'application/json' } });
    if (res.status !== 200) {
      fail(host, 'GET /.well-known/mcp', `expected 200, got ${res.status}`);
    // `(?!-)` is load-bearing: `-` is a word boundary, so a naive /\bAccept\b/
    // matches the `accept-encoding` that the edge adds on its own and the
    // check passes against an origin that sends no Vary at all.
    } else if (!/\bAccept\b(?!-)/i.test(res.headers.get('vary') ?? '')) {
      fail(host, 'GET /.well-known/mcp', `cacheable manifest 200 lacks "Vary: Accept" (got "${res.headers.get('vary')}") — a shared cache will serve it to an SSE GET`);
    } else if (!/\bLast-Event-ID\b/i.test(res.headers.get('vary') ?? '')) {
      fail(host, 'GET /.well-known/mcp', `cacheable manifest 200 lacks "Vary: Last-Event-ID" (got "${res.headers.get('vary')}") — a shared cache will serve it to a replay GET`);
    } else {
      JSON.parse(text);
      ok(host, 'GET /.well-known/mcp', 'cacheable card, correctly varied');
    }
  } catch (err) {
    fail(host, 'GET /.well-known/mcp', `not served or not JSON: ${err?.message ?? err}`);
  }

  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/.well-known/mcp`, { headers: { Accept: 'text/event-stream' } });
    if (res.status !== 405) {
      const cached = res.headers.get('x-vercel-cache') === 'HIT'
        ? ' from a CDN cache HIT — the manifest is being replayed to transport clients'
        : '';
      fail(host, '/.well-known/mcp (SSE stream open)', `expected 405, got ${res.status}${cached}`);
    } else {
      ok(host, '/.well-known/mcp (SSE stream open)', '405 preserved after a manifest GET');
    }
  } catch (err) {
    fail(host, '/.well-known/mcp (SSE stream open)', `HANG/transport error: ${err?.name ?? err}`);
  }

  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/.well-known/mcp`, {
      headers: { Accept: 'application/json', 'Last-Event-ID': 'smoke-canary' },
    });
    if (res.status !== 401 || !/^Bearer\b/i.test(res.headers.get('www-authenticate') ?? '')) {
      const cached = res.headers.get('x-vercel-cache') === 'HIT' ? ' from a CDN cache HIT' : '';
      fail(host, '/.well-known/mcp (replay-shaped GET)', `expected origin 401 with Bearer challenge, got ${res.status}${cached}`);
    } else {
      ok(host, '/.well-known/mcp (replay-shaped GET)', '401 preserved after a manifest GET');
    }
  } catch (err) {
    fail(host, '/.well-known/mcp (replay-shaped GET)', `HANG/transport error: ${err?.name ?? err}`);
  }
}

// Variant subdomains: crawler GETs canonicalize to apex, POST never does.
const VARIANT_HOSTS = (process.env.MCP_SMOKE_VARIANT_HOSTS
  ?? 'tech,finance,commodity,happy,energy')
  .split(',').map((v) => v.trim()).filter(Boolean)
  .map((v) => `https://${v}.worldmonitor.app`);

async function probeVariantCanonical(host) {
  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, { headers: { Accept: 'text/html,*/*' } });
    const location = res.headers.get('location');
    if (res.status !== 308 || location !== 'https://worldmonitor.app/mcp') {
      fail(host, 'GET /mcp → apex canonical', `expected 308 → https://worldmonitor.app/mcp, got ${res.status} → ${location}`);
    } else if (!/\bAccept\b(?!-)/i.test(res.headers.get('vary') ?? '')) {
      fail(host, 'GET /mcp → apex canonical', `cacheable 308 lacks "Vary: Accept" (got "${res.headers.get('vary')}")`);
    } else if (!/\bLast-Event-ID\b/i.test(res.headers.get('vary') ?? '')) {
      fail(host, 'GET /mcp → apex canonical', `cacheable 308 lacks "Vary: Last-Event-ID" (got "${res.headers.get('vary')}")`);
    } else {
      ok(host, 'GET /mcp → apex canonical', '308');
    }
  } catch (err) {
    fail(host, 'GET /mcp → apex canonical', `HANG/transport error: ${err?.name ?? err}`);
  }

  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, {
      method: 'HEAD',
      headers: { Accept: 'text/html,*/*' },
    });
    const location = res.headers.get('location');
    if (res.status !== 308 || location !== 'https://worldmonitor.app/mcp') {
      fail(host, 'HEAD /mcp → apex canonical', `expected 308 → https://worldmonitor.app/mcp, got ${res.status} → ${location}`);
    } else if (!/\bAccept\b(?!-)/i.test(res.headers.get('vary') ?? '')) {
      fail(host, 'HEAD /mcp → apex canonical', `cacheable 308 lacks "Vary: Accept" (got "${res.headers.get('vary')}")`);
    } else if (!/\bLast-Event-ID\b/i.test(res.headers.get('vary') ?? '')) {
      fail(host, 'HEAD /mcp → apex canonical', `cacheable 308 lacks "Vary: Last-Event-ID" (got "${res.headers.get('vary')}")`);
    } else {
      ok(host, 'HEAD /mcp → apex canonical', '308');
    }
  } catch (err) {
    fail(host, 'HEAD /mcp → apex canonical', `HANG/transport error: ${err?.name ?? err}`);
  }

  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, { headers: { Accept: 'Text/Event-Stream' } });
    if (res.status !== 405) {
      const cached = res.headers.get('x-vercel-cache') === 'HIT' ? ' from a CDN cache HIT' : '';
      fail(host, 'GET /mcp SSE stays on variant', `expected 405, got ${res.status}${cached}`);
    } else {
      ok(host, 'GET /mcp SSE stays on variant', '405 preserved after cached canonical redirect');
    }
  } catch (err) {
    fail(host, 'GET /mcp SSE stays on variant', `HANG/transport error: ${err?.name ?? err}`);
  }

  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, {
      headers: { Accept: 'application/json', 'Last-Event-ID': 'smoke-canary' },
    });
    if (res.status !== 401 || !/^Bearer\b/i.test(res.headers.get('www-authenticate') ?? '')) {
      const cached = res.headers.get('x-vercel-cache') === 'HIT' ? ' from a CDN cache HIT' : '';
      fail(host, 'GET /mcp replay stays on variant', `expected origin 401 with Bearer challenge, got ${res.status}${cached}`);
    } else {
      ok(host, 'GET /mcp replay stays on variant', '401 preserved after cached canonical redirect');
    }
  } catch (err) {
    fail(host, 'GET /mcp replay stays on variant', `HANG/transport error: ${err?.name ?? err}`);
  }

  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    if (res.status >= 300 && res.status < 400) {
      fail(host, 'POST /mcp stays on host', `POST answered ${res.status} → ${res.headers.get('location')} — a redirected POST becomes a GET and the handshake dies (#4938)`);
    } else if (res.status !== 200) {
      fail(host, 'POST /mcp stays on host', `expected 200 ping, got ${res.status}`);
    } else {
      ok(host, 'POST /mcp stays on host', '200 — handshake not canonicalized');
    }
  } catch (err) {
    fail(host, 'POST /mcp stays on host', `HANG/transport error: ${err?.name ?? err}`);
  }
}

for (const host of HOSTS) {
  await walkHost(host);
  await probeDiscovery(host);
}

console.log('\n── variant canonicalization ──');
for (const host of VARIANT_HOSTS) {
  await probeVariantCanonical(host);
}

console.log(`\n${checks} checks across ${HOSTS.length} host(s); ${failures.length} failure(s).`);
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  [${f.host}] ${f.check}: ${f.detail}`);
  process.exit(1);
}
