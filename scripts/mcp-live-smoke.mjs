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
// WHERE THE ANONYMOUS WALK RUNS: the transport at /mcp challenges an
// unauthenticated `initialize` — hosted connectors (Cursor's agent backend,
// grok-connectors-manager) read a 200 on that handshake as "connected, nothing
// to authenticate" and could then never sign in. A strict client opens with
// `initialize`, so its anonymous walk lives on the machine-discovery alias
// /.well-known/mcp (same handler). Step 0 asserts the connect-time challenge
// on /mcp itself, plus the stateless keyless calls the published CLI and SDKs
// make there, which must keep answering.
//
// This script does what a strict anonymous MCP client does, against LIVE
// production, once on the canonical product origin (`https://worldmonitor.app`):
//   0. the connect-time challenge — an unauthenticated initialize on /mcp must
//      answer 401 with a WWW-Authenticate challenge naming the /mcp
//      protected-resource document, and echo the JSON-RPC id so an SDK
//      transport can correlate the refusal (an id:null 401 hangs it, #4937);
//      and a keyless `tools/list` with no prior initialize must still answer
//      200 — that is exactly what `worldmonitor-cli` sends
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
//   6. Listed production aliases (www, api, and the dashboard variants) are a
//      client-migration surface: ordinary GET/HEAD 308 to apex, transport
//      POST/SSE/replay 410. They are not additional servers and do not get a
//      second capability walk.
//   7. Direct www `/api/mcp-proxy` liveness (OPTIONS 204 + anonymous GET 401).
//      An apex redirect alone does not prove that function is healthy.
//
// Report and console output are grouped as `canonical`, `aliases`, and `proxy`.
// A later group still runs after an earlier group fails; any failure fails the job.
//
// Every request runs under a hard timeout that covers BODY READ, not just
// response headers — a server/CDN that sends headers then stalls the body
// reports as HANG instead of idling until the workflow timeout (the fetch
// AbortSignal aborts the body stream too, so the timer is held until the
// text is fully read).
//
// Request budget: the anonymous discovery limiter is 60/min shared per client
// IP. The full capability walk runs once on the canonical origin. Alias 308/410
// probes return before applyAnonDiscoveryLimit. Current canonical shape: ≤16
// discovery POSTs + 3 non-/mcp OAuth probes + the existing discovery GET/HEADs.
// Apex `/api/mcp` initialize stays an in-process handler check; live smoke does
// not POST it because the apex CDN 301s that path to www. Alias hosts add
// OPTIONS/GET/HEAD/POST routing probes that do not consume the discovery
// bucket. www `/api/mcp-proxy` is two non-/mcp requests. MCP_SMOKE_HOSTS still
// overrides the canonical origin for local fixtures; when it is set, default
// production aliases and the www proxy host are not used unless the caller
// also sets MCP_SMOKE_ALIAS_HOSTS / MCP_SMOKE_VARIANT_HOSTS /
// MCP_SMOKE_PROXY_HOSTS.
//
// Usage: node scripts/mcp-live-smoke.mjs
//   MCP_SMOKE_HOSTS=https://a,https://b  overrides the canonical host list.
//   MCP_SMOKE_ALIAS_HOSTS / MCP_SMOKE_VARIANT_HOSTS  override alias hosts
//     (`tech` or a full origin). Empty string skips the alias group.
//   MCP_SMOKE_PROXY_HOSTS  overrides the proxy liveness origin list.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { isDeepStrictEqual } from 'node:util';

import {
  collectRequiredCapabilityFailures,
  collectToolSchemaWireFailures,
} from './mcp-schema-wire-check.mjs';
import {
  createTimedFetch,
  formatSafeError,
  safeUrlLabel,
  validateMalformedOAuthResponse,
} from './mcp-smoke-http.mjs';
import { runMcpProxyProbe } from './mcp-proxy-live-smoke.mjs';

const CANONICAL_ORIGIN = 'https://worldmonitor.app';
const CANONICAL_MCP = `${CANONICAL_ORIGIN}/mcp`;
const CANONICAL_LINK_RE = /<https:\/\/worldmonitor\.app\/mcp>;\s*rel="canonical"/i;
const DEFAULT_ALIAS_LABELS = ['www', 'api', 'tech', 'finance', 'commodity', 'happy', 'energy'];

function csvList(raw) {
  return String(raw ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

function toOrigin(entry) {
  if (/^https?:\/\//i.test(entry)) return entry.replace(/\/+$/, '');
  return `https://${entry}.worldmonitor.app`;
}

const hostsOverride = Object.hasOwn(process.env, 'MCP_SMOKE_HOSTS');
const HOSTS = hostsOverride ? csvList(process.env.MCP_SMOKE_HOSTS) : [CANONICAL_ORIGIN];

const aliasOverride = process.env.MCP_SMOKE_ALIAS_HOSTS ?? process.env.MCP_SMOKE_VARIANT_HOSTS;
let ALIAS_HOSTS;
if (aliasOverride !== undefined) {
  ALIAS_HOSTS = csvList(aliasOverride).map(toOrigin);
} else if (hostsOverride) {
  ALIAS_HOSTS = [];
} else {
  ALIAS_HOSTS = DEFAULT_ALIAS_LABELS.map(toOrigin);
}

let PROXY_HOSTS;
if (process.env.MCP_SMOKE_PROXY_HOSTS !== undefined) {
  PROXY_HOSTS = csvList(process.env.MCP_SMOKE_PROXY_HOSTS);
} else if (hostsOverride) {
  PROXY_HOSTS = [];
} else {
  PROXY_HOSTS = [toOrigin('www')];
}

const TIMEOUT_MS = 15_000;
// The workflow job has a 12 minute hard limit. Keep the request walk within
// ten minutes so normal failure handling can write its report and GitHub can
// upload it before the job is terminated. A request is never started unless
// its own full timeout still fits in this run budget.
const DEFAULT_RUN_BUDGET_MS = 600_000;
// The transport challenges an unauthenticated `initialize`; a full anonymous
// handshake is served on the machine-discovery alias (same handler).
const TRANSPORT_PATH = '/mcp';
const ANON_DISCOVERY_PATH = '/.well-known/mcp';
const USER_AGENT = 'WorldMonitor-MCP-Smoke/1.0 (+https://worldmonitor.app; github-actions)';
// Fan-out caps: keep the walk inside the shared anon 60/min/IP bucket as the
// catalogs grow. 6 covers today's full prompt registry and concrete resource
// list; growth beyond a cap trims coverage (logged), never correctness.
const MAX_PROMPT_GETS = 6;
const MAX_RESOURCE_READS = 6;
const RUNNER_LABEL = 'runner';

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
const requests = [];
const completedGroups = [];
let checks = 0;
let runBudgetMs = DEFAULT_RUN_BUDGET_MS;
let runDeadlineAt = null;
let runBudgetError = null;

class RunBudgetExhaustedError extends Error {
  constructor(remainingMs) {
    super(`Run budget exhausted before starting another request (${Math.max(0, remainingMs)}ms remaining; requires ${TIMEOUT_MS}ms)`);
    this.name = 'RunBudgetExhaustedError';
    this.code = 'MCP_SMOKE_RUN_BUDGET_EXHAUSTED';
  }
}

function completeGroup(group) {
  completedGroups.push(group);
}

function throwIfRunBudgetExhausted(error) {
  if (error?.code === 'MCP_SMOKE_RUN_BUDGET_EXHAUSTED') throw error;
}

function stopIfRunBudgetExhausted() {
  if (runBudgetError) throw runBudgetError;
}

function fail(host, check, detail) {
  const safeHost = host === RUNNER_LABEL ? RUNNER_LABEL : safeUrlLabel(host);
  failures.push({ host: safeHost, check, detail });
  console.log(`  ✖ [${safeHost}] ${check}: ${detail}`);
}

function ok(host, check, detail = '') {
  console.log(`  ✔ [${safeUrlLabel(host)}] ${check}${detail ? ` — ${detail}` : ''}`);
}

// Fetch with a hard timeout spanning the WHOLE exchange including body read.
// The helper records one safe, bounded result for every attempted request,
// including failures before headers and failures while consuming a body.
const requestTimedFetch = createTimedFetch({
  deadlineMs: TIMEOUT_MS,
  userAgent: USER_AGENT,
  onRecord: (record) => requests.push(record),
});

async function timedFetch(...args) {
  const remainingMs = runDeadlineAt === null ? 0 : runDeadlineAt - Date.now();
  if (remainingMs < TIMEOUT_MS) {
    runBudgetError ??= new RunBudgetExhaustedError(remainingMs);
    throw runBudgetError;
  }
  return requestTimedFetch(...args);
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
    ({ res, text, ms } = await timedFetch(`${host}${ANON_DISCOVERY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    }, { group: 'canonical', rpcMethod: method }));
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, check, `HANG/transport error inside the ${TIMEOUT_MS}ms budget: ${formatSafeError(err)}`);
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
    fail(host, check, 'JSON-RPC error response');
    return null;
  }
  ok(host, check, `${ms}ms`);
  return body.result ?? body;
}

// 0. Connect-time challenge on the transport. A connector that gets a 200 here
//    records the server as needing no sign-in and can never authenticate later,
//    so an unauthenticated initialize MUST be refused — with the challenge that
//    names this path's protected-resource document, and with the request id
//    echoed (the header is checked first: a CDN-fabricated 401 lacks it).
async function probeConnectChallenge(host) {
  const check = `initialize on ${TRANSPORT_PATH} (anon → 401 challenge)`;
  checks += 1;
  const id = nextId++;
  let res, text, ms;
  try {
    ({ res, text, ms } = await timedFetch(`${host}${TRANSPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wm-mcp-live-smoke', version: '1.0' } },
      }),
    }, { group: 'canonical', rpcMethod: 'initialize' }));
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, check, `HANG/transport error inside the ${TIMEOUT_MS}ms budget: ${formatSafeError(err)}`);
    return;
  }
  if (res.status !== 401) {
    fail(host, check, `expected HTTP 401, got ${res.status} — a connector that is not challenged at connect time records "no sign-in needed" and its Authorize control can never obtain an authentication URL`);
    return;
  }
  const challenge = res.headers.get('www-authenticate') ?? '';
  const expectedDocument = `${host}/.well-known/oauth-protected-resource${TRANSPORT_PATH}`;
  if (!challenge.includes(`resource_metadata="${expectedDocument}"`)) {
    fail(host, check, `challenge does not name ${expectedDocument} (got "${challenge}")`);
    return;
  }
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (body?.id !== id) {
    fail(host, check, `401 body id ${JSON.stringify(body?.id)} does not echo request id ${id} — uncorrelatable, strict SDK clients hang (#4937)`);
    return;
  }
  ok(host, check, `${ms}ms`);
}

// 0b. The published `worldmonitor` CLI and the SDKs never send `initialize`:
//     they POST `tools/list` (and `tools/call get_sources`) straight to the
//     transport with no key. Installed versions cannot be updated, so the
//     connect-time challenge must never widen to catch this.
async function probeStatelessKeylessList(host) {
  const check = `tools/list on ${TRANSPORT_PATH} (keyless, no initialize → 200)`;
  checks += 1;
  const id = nextId++;
  try {
    const { res, text, ms } = await timedFetch(`${host}${TRANSPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }),
    }, { group: 'canonical', rpcMethod: 'tools/list' });
    if (res.status !== 200) {
      fail(host, check, `expected HTTP 200, got ${res.status} — this breaks every installed worldmonitor CLI/SDK, which lists tools without a key`);
      return;
    }
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!(Array.isArray(body?.result?.tools) && body.result.tools.length > 0)) {
      fail(host, check, 'HTTP 200 but no tool catalog in the body');
      return;
    }
    ok(host, check, `${ms}ms, ${body.result.tools.length} tools`);
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, check, `HANG/transport error inside the ${TIMEOUT_MS}ms budget: ${formatSafeError(err)}`);
  }
}

// 0c. Every tool advertises an `outputSchema`, so a strict MCP client (the
//     official SDK, Grok Bot's host) throws -32600 on any `tools/call` result
//     that carries no `structuredContent`, before the model sees it (#8328).
//     `get_sources` is the one tool callable without a key, so it stands in for
//     the shared dispatch path: a plain call must return the payload as an
//     object equal to the text, and a projection must come back wrapped as
//     `{ projection }`, because the field has to be a JSON object.
async function probeStructuredContent(host) {
  for (const [label, args, matches] of [
    ['plain', {}, (sc, parsed) => isDeepStrictEqual(sc, parsed)],
    ['projection', { jmespath: 'view' }, (sc, parsed) => isDeepStrictEqual(sc, { projection: parsed })],
  ]) {
    const check = `tools/call get_sources on ${TRANSPORT_PATH} returns structuredContent (${label})`;
    checks += 1;
    const id = nextId++;
    try {
      const { res, text, ms } = await timedFetch(`${host}${TRANSPORT_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_sources', arguments: args } }),
      }, { group: 'canonical', rpcMethod: 'tools/call' });
      if (res.status === 429) {
        // The free tool has its own 10/min/IP ceiling, and a shared CI egress
        // IP can legitimately hit it. That is not a missing-field regression.
        ok(host, check, `skipped: the anonymous get_sources ceiling answered 429 in ${ms}ms`);
        continue;
      }
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      const result = body?.result;
      if (res.status !== 200 || !result) {
        fail(host, check, `expected HTTP 200 with a result, got ${res.status}`);
        continue;
      }
      const sc = result.structuredContent;
      if (sc === null || typeof sc !== 'object' || Array.isArray(sc)) {
        fail(host, check, 'result has no structuredContent object — every strict MCP client rejects the call with -32600 "has an output schema but did not return structured content"');
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(result.content?.[0]?.text); } catch { parsed = undefined; }
      if (parsed === undefined || !matches(sc, parsed)) {
        fail(host, check, 'structuredContent does not correspond to content[0].text');
        continue;
      }
      ok(host, check, `${ms}ms`);
    } catch (err) {
      throwIfRunBudgetExhausted(err);
      fail(host, check, `HANG/transport error inside the ${TIMEOUT_MS}ms budget: ${formatSafeError(err)}`);
    }
  }
}

async function walkHost(host) {
  console.log(`\n── ${safeUrlLabel(host)} ──`);

  await probeConnectChallenge(host);
  await probeStatelessKeylessList(host);
  await probeStructuredContent(host);

  // 1. Connect sequence (anonymous, on the discovery alias).
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
  for (const detail of collectRequiredCapabilityFailures(capabilities)) {
    checks += 1;
    fail(host, 'required capability', detail);
  }
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
        if (r && !(Array.isArray(r.tools) && r.tools.length > 0)) {
          fail(host, 'tools/list', 'empty catalog');
        } else if (r) {
          for (const detail of collectToolSchemaWireFailures(r.tools)) {
            fail(host, 'tools/list schema wire', detail);
          }
        }
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
          console.log(`  ℹ [${safeUrlLabel(host)}] prompts/get walk capped at ${MAX_PROMPT_GETS} of ${prompts.length} prompts (request budget)`);
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
          await rpc(host, 'resources/read', { uri: resource.uri }, { label: 'resources/read' });
        }
        if (resources.length > MAX_RESOURCE_READS) {
          console.log(`  ℹ [${safeUrlLabel(host)}] resources/read walk capped at ${MAX_RESOURCE_READS} of ${resources.length} resources (request budget)`);
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
    }, { group: 'canonical' });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    meta = JSON.parse(text);
    ok(host, 'oauth metadata', 'served');
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, 'oauth metadata', `not served: ${formatSafeError(err)}`);
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
      const { res, text, ms } = await timedFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{', // malformed on purpose: reaches the origin, registers nothing
      }, { group: 'canonical' });
      const result = validateMalformedOAuthResponse(res, text);
      if (!result.ok) fail(host, `oauth ${key}`, `${result.detail} (${ms}ms)`);
      else ok(host, `oauth ${key}`, `POST reaches origin (${result.detail}, ${ms}ms)`);
    } catch (err) {
      throwIfRunBudgetExhausted(err);
      fail(host, `oauth ${key}`, `HANG/transport error: ${formatSafeError(err)}`);
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
    const { res, text } = await timedFetch(`${host}/mcp`, { headers: { Accept: 'text/html,*/*' } }, { group: 'canonical' });
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
    throwIfRunBudgetExhausted(err);
    fail(host, 'GET /mcp (crawler)', `HANG/transport error: ${formatSafeError(err)}`);
  }

  // HEAD must expose the same discovery metadata without a response body.
  // This is a separate deployed method path, so unit coverage cannot prove
  // that the CDN and routing layers preserve it.
  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, {
      method: 'HEAD',
      headers: { Accept: 'text/html,*/*' },
    }, { group: 'canonical' });
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
    } else if (!CANONICAL_LINK_RE.test(res.headers.get('link') ?? '')) {
      fail(host, 'HEAD /mcp (crawler)', `guide lacks the apex canonical Link (got "${res.headers.get('link')}")`);
    } else {
      ok(host, 'HEAD /mcp (crawler)', '200 markdown metadata');
    }
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, 'HEAD /mcp (crawler)', `HANG/transport error: ${formatSafeError(err)}`);
  }

  // The canary: an SSE stream-open on the URL just warmed must still be 405.
  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, { headers: { Accept: 'text/event-stream' } }, { group: 'canonical' });
    if (res.status !== 405) {
      const cached = res.headers.get('x-vercel-cache') === 'HIT'
        ? ' from a CDN cache HIT — the discovery 200 is being replayed to transport clients (missing/ignored Vary)'
        : '';
      fail(host, 'GET /mcp (SSE stream open)', `expected 405, got ${res.status}${cached}`);
    } else {
      ok(host, 'GET /mcp (SSE stream open)', '405 preserved after a discovery GET');
    }
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, 'GET /mcp (SSE stream open)', `HANG/transport error: ${formatSafeError(err)}`);
  }

  // Same contract on the well-known manifest, which IS cacheable and so
  // depends on Vary rather than no-store.
  checks += 1;
  try {
    const { res, text } = await timedFetch(`${host}/.well-known/mcp`, { headers: { Accept: 'application/json' } }, { group: 'canonical' });
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
    throwIfRunBudgetExhausted(err);
    fail(host, 'GET /.well-known/mcp', `not served or not JSON: ${formatSafeError(err)}`);
  }

  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/.well-known/mcp`, { headers: { Accept: 'text/event-stream' } }, { group: 'canonical' });
    if (res.status !== 405) {
      const cached = res.headers.get('x-vercel-cache') === 'HIT'
        ? ' from a CDN cache HIT — the manifest is being replayed to transport clients'
        : '';
      fail(host, '/.well-known/mcp (SSE stream open)', `expected 405, got ${res.status}${cached}`);
    } else {
      ok(host, '/.well-known/mcp (SSE stream open)', '405 preserved after a manifest GET');
    }
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, '/.well-known/mcp (SSE stream open)', `HANG/transport error: ${formatSafeError(err)}`);
  }

  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/.well-known/mcp`, {
      headers: { Accept: 'application/json', 'Last-Event-ID': 'smoke-canary' },
    }, { group: 'canonical' });
    if (res.status !== 401 || !/^Bearer\b/i.test(res.headers.get('www-authenticate') ?? '')) {
      const cached = res.headers.get('x-vercel-cache') === 'HIT' ? ' from a CDN cache HIT' : '';
      fail(host, '/.well-known/mcp (replay-shaped GET)', `expected origin 401 with Bearer challenge, got ${res.status}${cached}`);
    } else {
      ok(host, '/.well-known/mcp (replay-shaped GET)', '401 preserved after a manifest GET');
    }
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, '/.well-known/mcp (replay-shaped GET)', `HANG/transport error: ${formatSafeError(err)}`);
  }
}

// /api/mcp-proxy liveness (issue #7663, GHSA-887j).
//
// This is a SEPARATE Vercel function from /mcp with its own runtime config,
// and it has gone hard-down twice from a runtime/handler mismatch: #4749
// (reverted by #4754 after 31 minutes) and #7578 (reverted by #7605 after
// ~3 hours). Both answered FUNCTION_INVOCATION_FAILED on EVERY request,
// OPTIONS included. Everything else in this script walks the MCP *server*
// surface and never requests this path, which is why a green 15-minute smoke
// sat alongside the second outage for three hours. Cadence was never the
// problem; coverage was.
//
// The unauthenticated GET is the discriminating assertion: a healthy deploy
// answers the handler's OWN 401 JSON, a broken one answers a platform 5xx.
// That separates "the function ran and rejected me" from "the function
// crashed at invocation".
async function probeMcpProxy(host) {
  // The serverUrl is never fetched: both probes are refused by the auth wall
  // before URL validation runs. `example.com` rather than a subdomain of it
  // because the source-attribution inventory treats an unrecognised hostname
  // literal in scripts/ as an unregistered data source.
  const url = `${host}/api/mcp-proxy?serverUrl=${encodeURIComponent('https://example.com/mcp')}`;
  const records = await runMcpProxyProbe(url, timedFetch);
  for (const record of records) {
    checks += 1;
    if (record.ok) ok(host, record.check, record.detail);
    else fail(host, record.check, record.detail);
  }
}

function hasDiscoveryVary(res) {
  const vary = res.headers.get('vary') ?? '';
  return /\bAccept\b(?!-)/i.test(vary) && /\bLast-Event-ID\b/i.test(vary);
}

function hasGoneTransportHeaders(res) {
  return /\bno-store\b/i.test(res.headers.get('cache-control') ?? '')
    && CANONICAL_LINK_RE.test(res.headers.get('link') ?? '');
}

async function probeAliasRedirect(host, { method = 'GET', path = '/mcp' } = {}) {
  const check = `${method} ${path} → canonical`;
  checks += 1;
  try {
    const { res } = await timedFetch(`${host}${path}`, {
      method,
      headers: { Accept: 'text/html,*/*' },
    }, { group: 'aliases' });
    const location = res.headers.get('location');
    if (res.status !== 308 || location !== CANONICAL_MCP) {
      fail(host, check, `expected 308 → ${CANONICAL_MCP}, got ${res.status} → ${safeUrlLabel(location)}`);
    } else if (!hasDiscoveryVary(res)) {
      fail(host, check, `308 lacks Vary: Accept, Last-Event-ID (got "${res.headers.get('vary')}")`);
    } else {
      ok(host, check, '308');
    }
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, check, `HANG/transport error: ${formatSafeError(err)}`);
  }
}

// Listed production aliases are a client-migration surface, not extra servers.
// Ordinary GET/HEAD 308 to apex; POST/SSE/replay 410. No capability walk.
async function probeAliasMigration(host) {
  await probeAliasRedirect(host, { method: 'GET', path: '/mcp' });
  await probeAliasRedirect(host, { method: 'HEAD', path: '/mcp' });
  await probeAliasRedirect(host, { method: 'GET', path: '/api/mcp' });

  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, { headers: { Accept: 'Text/Event-Stream' } }, { group: 'aliases' });
    if (res.status !== 410) {
      const cached = res.headers.get('x-vercel-cache') === 'HIT' ? ' from a CDN cache HIT' : '';
      fail(host, 'GET /mcp SSE retired', `expected 410, got ${res.status}${cached}`);
    } else if (!hasGoneTransportHeaders(res)) {
      fail(host, 'GET /mcp SSE retired', `410 lacks no-store + canonical Link (cache="${res.headers.get('cache-control')}", link="${res.headers.get('link')}")`);
    } else {
      ok(host, 'GET /mcp SSE retired', '410');
    }
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, 'GET /mcp SSE retired', `HANG/transport error: ${formatSafeError(err)}`);
  }

  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, {
      headers: { Accept: 'application/json', 'Last-Event-ID': 'smoke-canary' },
    }, { group: 'aliases' });
    if (res.status !== 410) {
      const cached = res.headers.get('x-vercel-cache') === 'HIT' ? ' from a CDN cache HIT' : '';
      fail(host, 'GET /mcp replay retired', `expected 410, got ${res.status}${cached}`);
    } else if (res.headers.get('www-authenticate')) {
      fail(host, 'GET /mcp replay retired', '410 must not emit WWW-Authenticate — aliases never authenticate');
    } else {
      ok(host, 'GET /mcp replay retired', '410');
    }
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, 'GET /mcp replay retired', `HANG/transport error: ${formatSafeError(err)}`);
  }

  checks += 1;
  try {
    const { res, text, ms } = await timedFetch(`${host}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    }, { group: 'aliases', rpcMethod: 'initialize' });
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (res.status >= 300 && res.status < 400) {
      fail(host, 'POST /mcp retired', `POST answered ${res.status} → ${safeUrlLabel(res.headers.get('location'))} — a redirected POST becomes a GET (#4938)`);
    } else if (res.status !== 410) {
      fail(host, 'POST /mcp retired', `expected 410, got ${res.status}`);
    } else if (body?.id !== 1 || body?.error?.code !== -32000 || body?.error?.data?.reason !== 'canonical_endpoint_required') {
      fail(host, 'POST /mcp retired', '410 body is not the canonical-endpoint JSON-RPC error');
    } else if (!hasGoneTransportHeaders(res)) {
      fail(host, 'POST /mcp retired', `410 lacks no-store + canonical Link (cache="${res.headers.get('cache-control')}", link="${res.headers.get('link')}")`);
    } else {
      ok(host, 'POST /mcp retired', `410 ${ms}ms`);
    }
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, 'POST /mcp retired', `HANG/transport error: ${formatSafeError(err)}`);
  }

  checks += 1;
  try {
    const { res } = await timedFetch(`${host}/mcp`, { method: 'OPTIONS' }, { group: 'aliases' });
    if (res.status !== 204) {
      fail(host, 'OPTIONS /mcp CORS', `expected 204, got ${res.status}`);
    } else {
      ok(host, 'OPTIONS /mcp CORS', '204');
    }
  } catch (err) {
    throwIfRunBudgetExhausted(err);
    fail(host, 'OPTIONS /mcp CORS', `HANG/transport error: ${formatSafeError(err)}`);
  }
}

function reportPathFromArgs(args) {
  let reportPath = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--report') throw new Error(`Unknown argument: ${args[index]}`);
    if (reportPath !== null || !args[index + 1]) throw new Error('--report requires exactly one path');
    reportPath = args[index + 1];
    index += 1;
  }
  return reportPath;
}

function checkedOutSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function writeReport(reportPath, completedAllGroups) {
  if (!reportPath) return true;
  const report = {
    version: 'mcp_live_smoke_report/v1',
    runId: process.env.GITHUB_RUN_ID ?? null,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    checkedOutSha: checkedOutSha(),
    nodeVersion: process.version,
    undiciVersion: process.versions.undici ?? null,
    os: platform(),
    architecture: arch(),
    checks: { total: checks, failures: failures.length },
    completedAllGroups,
    completedGroups,
    failures,
    requests,
  };
  try {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`MCP smoke report: ${reportPath}`);
    return true;
  } catch (error) {
    console.error(`Unable to write MCP smoke report: ${formatSafeError(error)}`);
    return false;
  }
}

async function main() {
  let completedAllGroups = false;
  let reportPath = null;
  try {
    reportPath = reportPathFromArgs(process.argv.slice(2));
    runBudgetMs = Number(process.env.MCP_SMOKE_RUN_BUDGET_MS ?? DEFAULT_RUN_BUDGET_MS);
    if (!(Number.isFinite(runBudgetMs) && runBudgetMs > 0)) {
      throw new Error('MCP_SMOKE_RUN_BUDGET_MS must be a positive number');
    }
    runDeadlineAt = Date.now() + runBudgetMs;

    console.log('\n── canonical ──');
    for (const host of HOSTS) {
      await walkHost(host);
      stopIfRunBudgetExhausted();
      await probeDiscovery(host);
      stopIfRunBudgetExhausted();
    }
    completeGroup('canonical');

    console.log('\n── aliases ──');
    for (const host of ALIAS_HOSTS) {
      await probeAliasMigration(host);
      stopIfRunBudgetExhausted();
    }
    completeGroup('aliases');

    console.log('\n── proxy ──');
    for (const host of PROXY_HOSTS) {
      await probeMcpProxy(host);
      stopIfRunBudgetExhausted();
    }
    completeGroup('proxy');
    completedAllGroups = true;
  } catch (error) {
    fail(RUNNER_LABEL, 'execution', formatSafeError(error));
  }

  console.log(`\n${checks} checks across ${HOSTS.length} canonical, ${ALIAS_HOSTS.length} alias, ${PROXY_HOSTS.length} proxy origin(s); ${failures.length} failure(s).`);
  if (failures.length > 0) {
    console.log('\nFAILURES:');
    for (const failure of failures) console.log(`  [${failure.host}] ${failure.check}: ${failure.detail}`);
  }
  const reportWritten = writeReport(reportPath, completedAllGroups);
  if (failures.length > 0 || !reportWritten) process.exitCode = 1;
}

await main();
