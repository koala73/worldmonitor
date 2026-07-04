// MCP resources wire-contract + stability + auth-symmetry.
//
// Three load-bearing concerns:
//   1. **Stability** — the chokepoint slug table is a publicly-bookmarkable
//      contract. The byte-for-byte snapshot test fails on ANY slug-table
//      change so a casual rename forces a deliberate snapshot update.
//   2. **Auth symmetry** — resources/read MUST consume Pro daily quota
//      IDENTICALLY to a tools/call against the equivalent tool. This is
//      the test that catches a "resources are quota-exempt" regression:
//      the dispatcher counter increment is asserted equal between
//      resources/read and tools/call against the same backing tool, with
//      identical pre-seeded counter state. Asymmetric auth is a known MCP
//      data-leak vector — a Pro user at the daily cap could otherwise
//      keep reading data through resources for free.
//   3. **Freshness envelope** — every successful resources/read response
//      carries `cached_at` and `stale` in the content payload. Cache-tool-
//      backed resources inherit the envelope from cacheEnvelope; RPC-tool-
//      backed resources (just country risk in v1) wrap explicitly via
//      evaluateFreshness against the underlying seed-meta key.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  BASE_URL,
  HMAC_SECRET,
  callBody,
  makeProDeps,
  proReq,
} from './helpers/mcp-pro-deps.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const VALID_KEY = 'wm_test_key_resources';

function envKeyReq(body, headers = {}) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WorldMonitor-Key': VALID_KEY,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// Anonymous request (NO credentials) — exercises the public-discovery /
// public-resource-read path an agent-readiness scanner (orank) uses.
function anonReq(body, headers = {}) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// resources/read JSON-RPC body factory.
function readBody(uri, id = 100) {
  return { jsonrpc: '2.0', id, method: 'resources/read', params: { uri } };
}

// Mock fetch covering every read path the four resources can touch:
//   - Upstash REST cache reads (`GET /get/<key>`) → return Redis JSON.
//   - get_country_risk RPC (sibling fetch to /api/intelligence/v1/get-country-risk).
//   - Upstash REST sliding-window ratelimit (pipeline / EVALSHA against the
//     same host) → return null shape so the @upstash/ratelimit limiter
//     degrades gracefully and doesn't add latency to every test.
function installMockFetch({ riskPayload = null } = {}) {
  const NOW = Date.now();
  const META = { fetchedAt: NOW, recordCount: 1 };

  // Default payloads for the cache keys the four resources touch. Empty
  // arrays / objects keep the schema valid; the F6 cache_all_null guard
  // requires at least ONE key to come back non-null per tool.
  const stocks = { quotes: [{ symbol: 'AAPL', price: 100, changePercent: 1.2 }, { symbol: 'MSFT', price: 200, changePercent: -0.3 }] };
  const commodities = { quotes: [{ symbol: 'GC=F', price: 2500, changePercent: 0.5 }] };
  const crypto = { quotes: [{ symbol: 'BTC-USD', price: 100000, changePercent: 0.0 }] };
  const transit = { summaries: { suez: { todayTotal: 100, todayTanker: 30, todayCargo: 50, riskLevel: 'normal', riskSummary: 'Normal flow.', dataAvailable: true } } };
  const chokeRef = { hormuz: { name: 'Strait of Hormuz' } };

  const keyMap = {
    // get_market_data cache
    'market:stocks-bootstrap:v1': stocks,
    'market:commodities-bootstrap:v1': commodities,
    'market:crypto:v1': crypto,
    'market:sectors:v2': null,
    'market:etf-flows:v1': null,
    'market:gulf-quotes:v1': null,
    'market:fear-greed:v1': null,
    'seed-meta:market:stocks': META,
    // get_chokepoint_status cache
    'supply_chain:transit-summaries:v1': transit,
    'supply_chain:chokepoint_transits:v1': null,
    'supply_chain:portwatch-ports:v1:_countries': null,
    'energy:chokepoint-baselines:v1': null,
    'portwatch:chokepoints:ref:v1': chokeRef,
    'energy:chokepoint-flows:v1': null,
    'seed-meta:supply_chain:transit-summaries': META,
    'seed-meta:supply_chain:chokepoint_transits': META,
    'seed-meta:supply_chain:portwatch-ports': META,
    'seed-meta:energy:chokepoint-baselines': META,
    'seed-meta:portwatch:chokepoints-ref': META,
    'seed-meta:energy:chokepoint-flows': META,
    // get_country_risk freshness wrap (resource-layer read, distinct from
    // the RPC's own fetch path)
    'seed-meta:intelligence:risk-scores': META,
  };

  globalThis.fetch = async (url, init) => {
    const u = url.toString();

    // get_country_risk RPC — the sibling fetch dispatch._execute does.
    if (u.includes('/api/intelligence/v1/get-country-risk')) {
      const body = riskPayload ?? {
        country_code: 'DE',
        cii: 28,
        components: { unrest: 12, conflict: 8, security: 5, news: 3 },
        travelAdvisory: { level: 1 },
        sanctionsExposure: [],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Upstash REST cache reads — `GET /get/<urlencoded-key>` → `{result}`.
    for (const [k, v] of Object.entries(keyMap)) {
      if (u.includes(`/get/${encodeURIComponent(k)}`)) {
        return new Response(JSON.stringify({ result: v === null ? null : JSON.stringify(v) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Default upstash bucket — unrecognised key returns null. Also catches
    // the @upstash/ratelimit sliding-window EVALSHA / pipeline shape so
    // the limiter degrades gracefully (~5ms instead of timing out).
    if (u.includes('fake.upstash') || u.includes('stub.upstash') || u.includes('upstash.io')) {
      return new Response(JSON.stringify({ result: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    return originalFetch(url, init);
  };
}

let handler;
let mcpHandler;
let PUBLIC_RESOURCE_REGISTRY;
let TEMPLATE_RESOURCE_REGISTRY;
let TOOL_REGISTRY;
let CHOKEPOINT_SLUGS;

describe('api/mcp.ts — resources capability + stability + auth-symmetry', () => {
  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';

    installMockFetch();

    const mod = await import(`../api/mcp.ts?t=${Date.now()}-resources`);
    handler = mod.default;
    mcpHandler = mod.mcpHandler;
    PUBLIC_RESOURCE_REGISTRY = mod.__testing__.PUBLIC_RESOURCE_REGISTRY;
    TEMPLATE_RESOURCE_REGISTRY = mod.__testing__.TEMPLATE_RESOURCE_REGISTRY;
    TOOL_REGISTRY = mod.__testing__.TOOL_REGISTRY;
    CHOKEPOINT_SLUGS = mod.CHOKEPOINT_SLUGS;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  // -------------------------------------------------------------------------
  // initialize advertises the new capability
  // -------------------------------------------------------------------------
  it('initialize advertises capabilities.resources.{subscribe: false, listChanged: false}', async () => {
    const res = await handler(envKeyReq({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.result?.capabilities?.resources,
      { subscribe: false, listChanged: false },
      'capabilities.resources must declare both flags explicitly false (stateless transport)',
    );
    // Sibling capabilities must NOT be regressed.
    assert.ok(body.result.capabilities.tools, 'capabilities.tools must still be present');
    assert.ok(body.result.capabilities.prompts, 'capabilities.prompts must still be present');
    assert.ok(body.result.capabilities.logging, 'capabilities.logging must still be present');
  });

  // -------------------------------------------------------------------------
  // MCP Apps handshake — initialize declares the extension (the SIGNAL that
  // pairs with the ui:// resource + tool `_meta` CONTENT asserted below).
  // Hosts and agent-readiness scanners classify an MCP-App surface off this
  // `capabilities.extensions` key; 1.11.0 shipped the ui:// artifacts but not
  // this declaration, so the surface read as a plain MCP server. Guarding it
  // here keeps the full MCP Apps triad (capability + resource + tool meta)
  // enforced in one file.
  // -------------------------------------------------------------------------
  it('initialize declares the MCP Apps extension capabilities.extensions["io.modelcontextprotocol/ui"]', async () => {
    const res = await handler(envKeyReq({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const extensions = body.result?.capabilities?.extensions;
    assert.ok(extensions && typeof extensions === 'object',
      'capabilities.extensions must be an object declaring supported MCP extensions');
    assert.deepEqual(
      extensions['io.modelcontextprotocol/ui'], {},
      "capabilities.extensions['io.modelcontextprotocol/ui'] must be declared (empty object — the " +
      'extension carries no negotiation parameters), signalling MCP Apps support to hosts/scanners',
    );
  });

  // -------------------------------------------------------------------------
  // resources/list shape
  // -------------------------------------------------------------------------
  it('resources/list returns only concrete anon-readable resources: DATA freshness probe + ui:// shell, no {template} URIs', async () => {
    const res = await handler(envKeyReq({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.result?.resources), 'result.resources must be an array');
    // resources/list = concrete DATA resource(s) (metadata-only, anon-readable)
    // + the MCP Apps ui:// app-shell (v1.11.0). NO {placeholder} templates —
    // those moved to resources/templates/list (a literal {iso2} can't resolve,
    // which would break an anonymous validator's resources/read probe).
    const actualUris = body.result.resources.map((r) => r.uri);
    assert.deepEqual(actualUris, [
      'worldmonitor://seed-meta/freshness',
      'ui://worldmonitor/country-risk.html',
    ], 'resources/list = concrete DATA freshness probe then ui:// shell, in order');
    for (const r of body.result.resources) {
      assert.equal(typeof r.uri, 'string', `resource ${r.uri}: uri must be a string`);
      assert.ok(r.uri.length > 0, `resource ${r.uri}: uri must be non-empty`);
      assert.doesNotMatch(r.uri, /[{}]/,
        `resource ${r.uri}: resources/list must not contain template {placeholder} URIs (use resources/templates/list)`);
      assert.equal(typeof r.name, 'string', `resource ${r.uri}: name must be a string`);
      assert.equal(typeof r.description, 'string', `resource ${r.uri}: description must be a string`);
      // Per-uri mimeType: DATA resources are application/json; the MCP Apps
      // ui:// shell is the extension's content profile text/html;profile=mcp-app.
      const expectedMime = r.uri.startsWith('ui://') ? 'text/html;profile=mcp-app' : 'application/json';
      assert.equal(r.mimeType, expectedMime, `resource ${r.uri}: mimeType must be ${expectedMime}`);
      // Internal authoring fields must NOT leak via resources/list.
      assert.equal(r.read, undefined, `resource ${r.uri}: internal "read" must not leak via resources/list`);
      assert.equal(r.tool, undefined, `resource ${r.uri}: internal "tool" must not leak via resources/list`);
      assert.equal(r.paramExtractor, undefined, `resource ${r.uri}: internal "paramExtractor" must not leak via resources/list`);
      assert.equal(r.freshnessWrap, undefined, `resource ${r.uri}: internal "freshnessWrap" must not leak via resources/list`);
      assert.equal(r.html, undefined, `resource ${r.uri}: internal "html" must not leak via resources/list`);
      // ui:// shells advertise their CSP/render policy via _meta.ui; DATA
      // resources carry no _meta.
      if (r.uri.startsWith('ui://')) {
        assert.ok(r._meta?.ui?.csp, `ui:// resource ${r.uri} must advertise _meta.ui.csp`);
      } else {
        assert.equal(r._meta, undefined, `DATA resource ${r.uri} must not carry _meta`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // MCP Apps ui:// resource — read is public + quota-exempt (v1.11.0)
  // -------------------------------------------------------------------------
  it('resources/read ui://worldmonitor/country-risk.html returns the app-shell HTML (mimeType text/html;profile=mcp-app)', async () => {
    const res = await handler(envKeyReq(readBody('ui://worldmonitor/country-risk.html')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, undefined, `unexpected error: ${JSON.stringify(body.error)}`);
    assert.equal(body.result.contents.length, 1);
    const c = body.result.contents[0];
    assert.equal(c.uri, 'ui://worldmonitor/country-risk.html');
    assert.equal(c.mimeType, 'text/html;profile=mcp-app');
    assert.match(c.text, /^<!doctype html>/i, 'ui:// resource must return self-contained HTML');
    assert.match(c.text, /ui\/initialize/, 'app shell must implement the MCP Apps postMessage handshake');
    assert.match(c.text, /ui\/notifications\/tool-result/, 'app shell must consume tool-result notifications');
  });

  it('ui:// app-shell HTML carries the orank view-quality + view-csp signals (uppercase DOCTYPE, color-scheme, scoped CSP)', async () => {
    // orank Experience checks mcp-apps-ui-quality / mcp-view-domain / mcp-view-csp
    // read the served HTML statically. Guard each required token so a future
    // edit can't silently regress the score.
    const res = await handler(envKeyReq(readBody('ui://worldmonitor/country-risk.html')));
    const html = (await res.json()).result.contents[0].text;

    // ui-quality + view-domain: UPPERCASE DOCTYPE + color-scheme meta.
    assert.match(html, /^<!DOCTYPE html>/, 'HTML must open with an uppercase <!DOCTYPE html> (orank mcp-apps-ui-quality)');
    assert.match(html, /<meta\s+name="color-scheme"\s+content="light dark">/, 'must declare <meta name="color-scheme" content="light dark">');
    assert.doesNotMatch(html, /wm_[a-f0-9]{40}|X-WorldMonitor-Key|Bearer\s+[A-Za-z0-9]/, 'app shell must not hardcode secrets/keys');

    // view-csp: a <meta http-equiv> CSP scoping all four required directive categories.
    const cspMatch = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/);
    assert.ok(cspMatch, 'must carry a <meta http-equiv="Content-Security-Policy"> tag');
    const csp = cspMatch[1];
    assert.match(csp, /connect-src[^;]*worldmonitor\.app/, 'connect-src must include the MCP server origin');
    assert.match(csp, /frame-ancestors[^;]*https:\/\/chatgpt\.com/, 'frame-ancestors must include https://chatgpt.com');
    assert.match(csp, /frame-ancestors[^;]*https:\/\/claude\.ai/, 'frame-ancestors must include https://claude.ai');
    assert.match(csp, /form-action\s+'none'/, 'form-action must be scoped');
    assert.match(csp, /(img|script|style)-src/, 'img/script/style-src must be present');
    assert.doesNotMatch(csp, /default-src\s+\*/, 'must NOT use a permissive default-src * (loses orank credit)');
  });

  it('resources/read ui:// response carries spec _meta.ui.csp with secure empty allowlists', async () => {
    const res = await handler(envKeyReq(readBody('ui://worldmonitor/country-risk.html')));
    const meta = (await res.json()).result.contents[0]._meta;
    assert.ok(meta?.ui?.csp, 'contents[0]._meta.ui.csp must be present (ext-apps UIResourceMeta)');
    // connectDomains mirrors the HTML meta CSP's connect-src (the MCP origin);
    // the other allowlists stay empty (secure default — app loads nothing external).
    assert.deepEqual(meta.ui.csp.connectDomains, ['https://worldmonitor.app', 'https://www.worldmonitor.app'],
      'connectDomains must mirror the HTML connect-src (MCP server origin)');
    assert.deepEqual(meta.ui.csp.resourceDomains, [], 'resourceDomains empty = no external resources');
    assert.deepEqual(meta.ui.csp.frameDomains, [], 'frameDomains empty = no nested frames');
    assert.deepEqual(meta.ui.csp.baseUriDomains, [], 'baseUriDomains empty = base-uri self');

    // Consistency guard: every connectDomain must actually appear in the
    // served HTML's connect-src (catches the two CSP declarations drifting).
    // Parse the CSP from the meta CONTENT attribute — not a bare `connect-src`
    // grep, which would also hit the word in the head comment.
    const htmlRes = await handler(envKeyReq(readBody('ui://worldmonitor/country-risk.html')));
    const html = (await htmlRes.json()).result.contents[0].text;
    const cspContent = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/)[1];
    const connectSrc = cspContent.match(/connect-src([^;]+)/)[1];
    for (const d of meta.ui.csp.connectDomains) {
      assert.ok(connectSrc.includes(d), `_meta.ui.csp.connectDomains "${d}" must also be in the HTML connect-src`);
    }
  });

  it('resources/read of the ui:// shell is PUBLIC — served with NO credentials', async () => {
    const anonReq = new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readBody('ui://worldmonitor/country-risk.html')),
    });
    const res = await handler(anonReq);
    assert.equal(res.status, 200, 'ui:// read must be servable without auth (static, data-free template)');
    const body = await res.json();
    assert.equal(body.error, undefined, `anon ui:// read must succeed, got: ${JSON.stringify(body.error)}`);
    assert.equal(body.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  });

  it('every tool _uiResourceUri resolves to a listed ui:// resource, and every ui:// resource is reachable (bidirectional integrity)', async () => {
    // Enumerate the ui:// URIs the server actually advertises via resources/list.
    const res = await handler(envKeyReq({ jsonrpc: '2.0', id: 9, method: 'resources/list', params: {} }));
    const body = await res.json();
    const listedUiUris = new Set(
      body.result.resources.map((r) => r.uri).filter((u) => u.startsWith('ui://')),
    );

    // Every tool that declares a UI linkage must point at a listed resource
    // (no dangling _meta.ui.resourceUri that 404s on resources/read).
    const linkedByTools = new Set();
    for (const tool of TOOL_REGISTRY) {
      if (tool._uiResourceUri) {
        linkedByTools.add(tool._uiResourceUri);
        assert.ok(
          listedUiUris.has(tool._uiResourceUri),
          `tool "${tool.name}" links _uiResourceUri "${tool._uiResourceUri}" but resources/list does not advertise it`,
        );
        // And the read must actually resolve (public, static template).
        const readRes = await handler(envKeyReq(readBody(tool._uiResourceUri)));
        const readBodyJson = await readRes.json();
        assert.equal(readBodyJson.error, undefined,
          `resources/read of "${tool._uiResourceUri}" (linked by ${tool.name}) must resolve`);
      }
    }

    // And every advertised ui:// resource must be linked by at least one tool
    // — an orphan app shell no tool can trigger is dead surface.
    for (const uri of listedUiUris) {
      assert.ok(linkedByTools.has(uri),
        `ui:// resource "${uri}" is advertised but no tool references it via _uiResourceUri`);
    }
  });

  it('resources/templates/list returns the three data-bearing URI templates', async () => {
    const res = await handler(envKeyReq({ jsonrpc: '2.0', id: 3, method: 'resources/templates/list', params: {} }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.result?.resourceTemplates), 'result.resourceTemplates must be an array');

    const expectedTemplates = [
      'worldmonitor://countries/{iso2}/risk',
      'worldmonitor://chokepoints/{slug}/status',
      'worldmonitor://markets/{symbol}/quote',
    ];
    const actualTemplates = body.result.resourceTemplates.map((r) => r.uriTemplate);
    assert.deepEqual(actualTemplates, expectedTemplates,
      'resource template URIs and order must match the documented set');

    for (const r of body.result.resourceTemplates) {
      assert.equal(typeof r.uriTemplate, 'string', `template ${r.uriTemplate}: uriTemplate must be a string`);
      assert.match(r.uriTemplate, /\{[a-z0-9]+\}/i, `template ${r.uriTemplate}: must contain a {placeholder}`);
      assert.equal(typeof r.name, 'string', `template ${r.uriTemplate}: name must be a string`);
      assert.equal(typeof r.description, 'string', `template ${r.uriTemplate}: description must be a string`);
      assert.equal(r.mimeType, 'application/json', `template ${r.uriTemplate}: mimeType must be application/json`);
      // Internal authoring fields must NOT leak via resources/templates/list.
      assert.equal(r.tool, undefined, `template ${r.uriTemplate}: internal "tool" must not leak`);
      assert.equal(r.paramExtractor, undefined, `template ${r.uriTemplate}: internal "paramExtractor" must not leak`);
      assert.equal(r.freshnessWrap, undefined, `template ${r.uriTemplate}: internal "freshnessWrap" must not leak`);
    }
  });

  // -------------------------------------------------------------------------
  // orank mcp-resource-quality — every resources/list entry must resources/read
  // cleanly for an ANONYMOUS caller (no credentials). This is the exact probe
  // an agent-readiness scanner runs; a 401 here is the failure it reports.
  // -------------------------------------------------------------------------
  it('ANON: every resources/list entry reads cleanly without credentials (orank mcp-resource-quality)', async () => {
    const listRes = await handler(anonReq({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} }));
    assert.equal(listRes.status, 200, 'anonymous resources/list must be public');
    const listBody = await listRes.json();
    const uris = listBody.result.resources.map((r) => r.uri);
    assert.ok(uris.length >= 1, 'resources/list must advertise at least one resource');

    for (const uri of uris) {
      const res = await handler(anonReq(readBody(uri)));
      assert.equal(res.status, 200, `anonymous resources/read ${uri} must return 200, got ${res.status}`);
      const body = await res.json();
      assert.equal(body.error, undefined,
        `anonymous resources/read ${uri} must not error, got ${JSON.stringify(body.error)}`);
      const c = body.result?.contents?.[0];
      assert.ok(c, `resources/read ${uri} must return a content entry`);
      // Mixed catalog: concrete DATA resources are application/json; the ui://
      // shell is text/html;profile=mcp-app. orank requires a valid declared
      // mimeType + non-empty content for every entry.
      assert.ok(typeof c.mimeType === 'string' && c.mimeType.length > 0,
        `resources/read ${uri}: must declare a mimeType`);
      assert.ok(typeof c.text === 'string' && c.text.length > 0, `resources/read ${uri}: content must be non-empty`);
      if (c.mimeType === 'application/json') JSON.parse(c.text); // valid JSON for the declared type
    }
  });

  // -------------------------------------------------------------------------
  // resources/read — each URI resolves (env-key auth path)
  // -------------------------------------------------------------------------
  it('resources/read worldmonitor://countries/de/risk returns country-risk content with cached_at + stale', async () => {
    const res = await handler(envKeyReq(readBody('worldmonitor://countries/de/risk')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, undefined, `unexpected error: ${JSON.stringify(body.error)}`);
    assert.ok(Array.isArray(body.result?.contents), 'result.contents must be an array');
    assert.equal(body.result.contents.length, 1, 'must return exactly one content entry');
    const c = body.result.contents[0];
    assert.equal(c.uri, 'worldmonitor://countries/de/risk', 'echo the requested uri verbatim');
    assert.equal(c.mimeType, 'application/json');
    const payload = JSON.parse(c.text);
    assert.equal(typeof payload.cached_at === 'string' || payload.cached_at === null, true,
      'cached_at must be string-or-null');
    assert.equal(typeof payload.stale, 'boolean', 'stale must be a boolean');
    // The RPC-backed payload merges through — assert the country-risk
    // shape survived the freshness wrap.
    assert.equal(payload.country_code, 'DE', 'country_code must round-trip through the freshness wrap');
    assert.equal(payload.cii, 28);
  });

  it('resources/read worldmonitor://chokepoints/suez/status returns the transit-summary envelope with cached_at + stale', async () => {
    const res = await handler(envKeyReq(readBody('worldmonitor://chokepoints/suez/status')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, undefined, `unexpected error: ${JSON.stringify(body.error)}`);
    const payload = JSON.parse(body.result.contents[0].text);
    assert.equal(typeof payload.cached_at === 'string' || payload.cached_at === null, true);
    assert.equal(typeof payload.stale, 'boolean');
    // Cache-tool envelope — data is keyed by the last-segment label.
    assert.ok(payload.data, 'cache-tool envelope must carry a data field');
  });

  it('resources/read worldmonitor://seed-meta/freshness returns envelope-only (no data field)', async () => {
    const res = await handler(envKeyReq(readBody('worldmonitor://seed-meta/freshness')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, undefined, `unexpected error: ${JSON.stringify(body.error)}`);
    const payload = JSON.parse(body.result.contents[0].text);
    // The jmespath projection in the resource definition collapses to
    // ONLY {cached_at, stale} — no data field, no nested payload.
    assert.equal(typeof payload.cached_at === 'string' || payload.cached_at === null, true);
    assert.equal(typeof payload.stale, 'boolean');
    assert.equal(Object.keys(payload).sort().join(','), 'cached_at,stale',
      'envelope-only projection must contain exactly cached_at + stale');
  });

  it('resources/read worldmonitor://markets/AAPL/quote returns the matched single-symbol slice with cached_at + stale', async () => {
    const res = await handler(envKeyReq(readBody('worldmonitor://markets/AAPL/quote')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, undefined, `unexpected error: ${JSON.stringify(body.error)}`);
    const payload = JSON.parse(body.result.contents[0].text);
    assert.equal(typeof payload.cached_at === 'string' || payload.cached_at === null, true);
    assert.equal(typeof payload.stale, 'boolean');
    assert.ok(payload.data, 'cache-tool envelope must carry a data field');
  });

  // -------------------------------------------------------------------------
  // resources/read error paths
  // -------------------------------------------------------------------------
  it('resources/read with an unknown URI prefix returns -32602', async () => {
    const res = await handler(envKeyReq(readBody('worldmonitor://nope/asdf')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32602, `unknown uri prefix must be -32602, got ${body.error?.code}`);
  });

  it('resources/read with a malformed iso2 (3 letters) returns -32602 with a specific message', async () => {
    const res = await handler(envKeyReq(readBody('worldmonitor://countries/deu/risk')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32602);
    assert.ok(/iso2|alpha-2/i.test(body.error?.message ?? ''),
      `error must explain the iso2 constraint — got: ${body.error?.message}`);
  });

  it('resources/read with an uppercase iso2 returns -32602 (lowercase canonical)', async () => {
    // Stability contract: the URI is case-sensitive. "DE" is invalid;
    // "de" is canonical. Documented inline in the resource description.
    const res = await handler(envKeyReq(readBody('worldmonitor://countries/DE/risk')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32602);
  });

  it('resources/read with an unknown chokepoint slug returns -32602 listing the known slugs', async () => {
    const res = await handler(envKeyReq(readBody('worldmonitor://chokepoints/no-such-slug/status')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32602);
    assert.ok(/no-such-slug/.test(body.error?.message ?? ''),
      'error message must echo the unknown slug for debuggability');
    assert.ok(/suez/.test(body.error?.message ?? ''),
      'error message must list at least one known slug');
  });

  it('resources/read with a lowercase ticker returns -32602', async () => {
    const res = await handler(envKeyReq(readBody('worldmonitor://markets/aapl/quote')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32602);
  });

  it('resources/read with no uri param returns -32602', async () => {
    const res = await handler(envKeyReq({ jsonrpc: '2.0', id: 50, method: 'resources/read', params: {} }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32602);
  });

  // -------------------------------------------------------------------------
  // Stability — CHOKEPOINT_SLUGS table is a publicly bookmarkable contract.
  // -------------------------------------------------------------------------
  it('CHOKEPOINT_SLUGS exposes a frozen 13-entry kebab-case slug table', () => {
    const entries = Object.entries(CHOKEPOINT_SLUGS);
    assert.equal(entries.length, 13, `Expected 13 chokepoint slugs, got ${entries.length}`);
    for (const [slug, matcher] of entries) {
      assert.match(slug, /^[a-z][a-z0-9-]*$/, `slug "${slug}" must be lowercase kebab-case`);
      assert.equal(typeof matcher, 'string', `slug "${slug}" matcher must be a string`);
      assert.ok(matcher.length > 0, `slug "${slug}" matcher must be non-empty`);
    }
  });

  it('CHOKEPOINT_SLUGS exact byte-snapshot matches the canonical 13-entry registry', () => {
    // Stability snapshot. Any slug-table edit must update this expected
    // map deliberately — a casual rename / re-ordering fails here and
    // forces the author to acknowledge the public contract change.
    // Source-of-truth slugs map (alphabetical by slug) — the test failure
    // when this drifts reports both expected and actual.
    const expected = {
      'bab-el-mandeb': 'bab',
      'bosphorus': 'bosphorus',
      'cape-of-good-hope': 'cape',
      'dover-strait': 'dover',
      'kerch-strait': 'kerch',
      'korea-strait': 'korea',
      'lombok-strait': 'lombok',
      'panama-canal': 'panama',
      'strait-of-gibraltar': 'gibraltar',
      'strait-of-hormuz': 'hormuz',
      'strait-of-malacca': 'malacca',
      'suez': 'suez',
      'taiwan-strait': 'taiwan',
    };
    // Order doesn't matter (Object.freeze preserves declaration order; we
    // compare as sorted entries to avoid coupling to authoring order).
    const actualSorted = Object.fromEntries(
      Object.entries(CHOKEPOINT_SLUGS).sort(([a], [b]) => a.localeCompare(b)),
    );
    assert.deepEqual(actualSorted, expected, 'CHOKEPOINT_SLUGS contents must match the snapshot byte-for-byte');
  });

  it('api/mcp/resources/slugs.ts file-on-disk parses to the same CHOKEPOINT_SLUGS export', () => {
    // Defense-in-depth: the snapshot test above runs against the
    // already-loaded module; this one re-reads the source file from disk
    // so a sabotage that edits ONLY the in-memory const (test bypass)
    // would still fail here.
    const src = readFileSync(resolve(__dirname, '..', 'api', 'mcp', 'resources', 'slugs.ts'), 'utf8');
    for (const slug of Object.keys(CHOKEPOINT_SLUGS)) {
      assert.ok(src.includes(`'${slug}'`),
        `slugs.ts must contain a literal entry for slug "${slug}"`);
    }
  });

  // -------------------------------------------------------------------------
  // Auth symmetry — the load-bearing assertion.
  // -------------------------------------------------------------------------
  it('LOAD-BEARING: Pro resources/read on countries/de/risk decrements the daily-quota counter by exactly 1 (identical to tools/call(get_country_risk))', async () => {
    const { deps: depsR, pipe: pipeR } = makeProDeps({ pipelineOpts: { initialCount: 0 } });
    const resR = await mcpHandler(
      proReq('POST', readBody('worldmonitor://countries/de/risk')),
      depsR,
    );
    const bodyR = await resR.json();
    assert.equal(bodyR.error, undefined, `resources/read should succeed, got error: ${JSON.stringify(bodyR.error)}`);
    assert.equal(pipeR.count, 1,
      `Pro resources/read MUST increment quota counter by EXACTLY 1 (got ${pipeR.count}). If resources are quota-exempt, this is the data-leak vector the test exists to catch.`);

    // PARITY — tools/call against the same backing tool from an identical
    // initial state must produce the SAME counter delta. The two paths
    // share the dispatcher, so divergence here means resources/read
    // skipped the dispatcher.
    const { deps: depsT, pipe: pipeT } = makeProDeps({ pipelineOpts: { initialCount: 0 } });
    const resT = await mcpHandler(
      proReq('POST', callBody('get_country_risk', { country_code: 'DE' })),
      depsT,
    );
    const bodyT = await resT.json();
    assert.equal(bodyT.error, undefined, `tools/call should succeed, got error: ${JSON.stringify(bodyT.error)}`);
    assert.equal(pipeT.count, pipeR.count,
      `auth symmetry: tools/call counter delta (${pipeT.count}) must equal resources/read counter delta (${pipeR.count})`);
  });

  it('Pro resources/read on data-bearing template URIs (markets, chokepoints) increments counter by 1 each', async () => {
    const uris = [
      'worldmonitor://markets/AAPL/quote',
      'worldmonitor://chokepoints/suez/status',
    ];
    for (const uri of uris) {
      const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 0 } });
      const res = await mcpHandler(proReq('POST', readBody(uri)), deps);
      const body = await res.json();
      assert.equal(body.error, undefined,
        `resources/read ${uri} should succeed, got error: ${JSON.stringify(body.error)}`);
      assert.equal(pipe.count, 1,
        `${uri} MUST increment Pro counter by exactly 1, got ${pipe.count}`);
    }
  });

  it('PUBLIC seed-meta/freshness resources/read is quota-exempt (metadata-class, mirrors resources/list) even for Pro', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 0 } });
    const res = await mcpHandler(proReq('POST', readBody('worldmonitor://seed-meta/freshness')), deps);
    const body = await res.json();
    assert.equal(body.error, undefined, `should succeed, got error: ${JSON.stringify(body.error)}`);
    assert.equal(pipe.count, 0,
      'seed-meta/freshness is a metadata-only freshness probe — it must NOT consume the Pro daily quota');
    // Envelope-only content survives the public direct-read path.
    const payload = JSON.parse(body.result.contents[0].text);
    assert.equal(Object.keys(payload).sort().join(','), 'cached_at,stale',
      'public freshness read must return exactly {cached_at, stale}');
  });

  it('ANON seed-meta/freshness resources/read succeeds (no credentials, no quota)', async () => {
    const res = await handler(anonReq(readBody('worldmonitor://seed-meta/freshness')));
    assert.equal(res.status, 200, 'anonymous public-resource read must return 200');
    const body = await res.json();
    assert.equal(body.error, undefined, `anonymous read must not error: ${JSON.stringify(body.error)}`);
    const payload = JSON.parse(body.result.contents[0].text);
    assert.equal(typeof payload.stale, 'boolean');
    assert.equal(typeof payload.cached_at === 'string' || payload.cached_at === null, true);
  });

  it('ANON resources/read of a data-bearing TEMPLATE instantiation stays gated (401 — no quota bypass)', async () => {
    // The data-leak / quota-bypass protection: only concrete PUBLIC resources
    // are anon-readable. A template instantiation (country risk) requires auth.
    const res = await handler(anonReq(readBody('worldmonitor://countries/de/risk')));
    assert.equal(res.status, 401, 'anonymous read of a data-bearing template must be 401');
    assert.ok(
      res.headers.get('WWW-Authenticate')?.includes('Bearer'),
      'gated resource read must advertise WWW-Authenticate: Bearer',
    );
  });

  it('a PUBLIC resource whose read() throws surfaces a clean -32603 (contract enforced at the dispatcher boundary)', async () => {
    // The PublicResourceDef `read` "MUST be robust" contract is documentation;
    // the dispatcher enforces it so a future non-robust reader returns -32603
    // rather than bubbling an unhandled rejection through mcpHandler to the edge.
    const def = PUBLIC_RESOURCE_REGISTRY[0];
    const originalRead = def.read;
    def.read = async () => { throw new Error('simulated reader failure'); };
    try {
      const res = await handler(anonReq(readBody(def.uri)));
      assert.equal(res.status, 200, 'JSON-RPC errors ride inside HTTP 200');
      const body = await res.json();
      assert.equal(body.error?.code, -32603,
        'a throwing public reader must surface -32603, not an unhandled rejection');
    } finally {
      def.read = originalRead;
    }
  });

  it('env-key resources/read on countries/de/risk does NOT touch the Pro quota path (env-key tier is its own quota)', async () => {
    // env-key auth path uses X-WorldMonitor-Key. The dispatcher's INCR
    // reservation only fires for context.kind === 'pro'. This test asserts
    // the response succeeds AND no Pro pipeline activity was attempted.
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 0 } });
    const res = await mcpHandler(envKeyReq(readBody('worldmonitor://countries/de/risk')), deps);
    const body = await res.json();
    assert.equal(body.error, undefined, `env-key resources/read should succeed, got error: ${JSON.stringify(body.error)}`);
    assert.equal(pipe.count, 0, 'env-key auth must NOT touch the Pro daily-quota counter');
  });

  it('resources/list does NOT increment the Pro quota counter (metadata-class, mirrors prompts/list)', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 0 } });
    const res = await mcpHandler(
      proReq('POST', { jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} }),
      deps,
    );
    const body = await res.json();
    assert.equal(body.error, undefined);
    assert.equal(pipe.count, 0, 'resources/list is metadata-class — must NOT count toward daily quota');
  });

  it('Pro resources/read of the ui:// shell does NOT increment the daily-quota counter (static template, quota-exempt)', async () => {
    // Unlike a DATA resources/read (which reserves against the 50/day Pro cap
    // symmetrically with tools/call), a ui:// read returns a static, data-free
    // app shell and spends no quota — the load-bearing distinction that lets
    // an unauthenticated host fetch the shell to render it.
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 0 } });
    const res = await mcpHandler(
      proReq('POST', readBody('ui://worldmonitor/country-risk.html')),
      deps,
    );
    const body = await res.json();
    assert.equal(body.error, undefined, `ui:// read should succeed, got: ${JSON.stringify(body.error)}`);
    assert.equal(body.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.equal(pipe.count, 0, 'ui:// resources/read is quota-exempt — must NOT count toward the Pro daily cap');
  });

  it('Pro resources/read returns -32029 when the daily quota is exhausted (identical to tools/call)', async () => {
    // Pre-seed the counter at the cap so the next INCR rejects.
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 50 } });
    const res = await mcpHandler(
      proReq('POST', readBody('worldmonitor://countries/de/risk')),
      deps,
    );
    assert.equal(res.status, 429, 'cap-exceeded must surface as HTTP 429');
    const body = await res.json();
    assert.equal(body.error?.code, -32029, 'cap-exceeded must use the -32029 quota code');
    assert.equal(pipe.count, 50,
      'counter must return to the cap after the rejected reservation rolls back (initialCount=50, no net change)');
  });

  it('cap-exhausted resources/read forwards Retry-After header (parity with tools/call)', async () => {
    // Greptile P1 regression guard. A correctly-implemented MCP client
    // backing off on 429 will retry immediately if Retry-After is absent.
    // tools/call attaches Retry-After (seconds until UTC midnight on quota
    // cap, "5" on reservation failure); resources/read must forward it
    // verbatim or the auth-symmetry contract is broken on the error path.
    const RealDate = globalThis.Date;
    const fixedNowMs = RealDate.parse('2026-05-29T12:00:00.000Z');
    globalThis.Date = class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fixedNowMs] : args));
      }

      static now() {
        return fixedNowMs;
      }

      static parse(value) {
        return RealDate.parse(value);
      }

      static UTC(...args) {
        return RealDate.UTC(...args);
      }
    };

    try {
      const { deps: depsR } = makeProDeps({ pipelineOpts: { initialCount: 50 } });
      const resR = await mcpHandler(
        proReq('POST', readBody('worldmonitor://countries/de/risk')),
        depsR,
      );
      assert.equal(resR.status, 429);
      const retryAfterR = resR.headers.get('Retry-After');
      assert.ok(retryAfterR, 'resources/read 429 MUST attach a Retry-After header (Greptile P1)');
      // Cross-check: tools/call against the same backing tool from the same
      // pre-seeded state must attach the SAME header. Date is pinned for this
      // assertion so CI scheduling cannot create a one-second midnight-delta
      // drift between the two sequential requests.
      const { deps: depsT } = makeProDeps({ pipelineOpts: { initialCount: 50 } });
      const resT = await mcpHandler(
        proReq('POST', callBody('get_country_risk', { country_code: 'DE' })),
        depsT,
      );
      assert.equal(resT.status, 429);
      const retryAfterT = resT.headers.get('Retry-After');
      assert.equal(retryAfterR, retryAfterT,
        `Retry-After symmetry: resources/read="${retryAfterR}" must match tools/call="${retryAfterT}"`);
    } finally {
      globalThis.Date = RealDate;
    }
  });

  it('_budget_exceeded soft envelope from country-risk RPC passes through unchanged (no freshness merge)', async () => {
    // Greptile P2 regression guard. When the RPC return exceeds the
    // 256 KB budget, dispatchToolsCall emits a 200 with
    // `{_budget_exceeded, budget_bytes, actual_bytes, hint}` inside
    // content[0].text. The freshness-wrap branch must detect this and
    // pass through unchanged — merging the sentinel with `{cached_at,
    // stale, ...}` would produce a hybrid shape where clients detecting
    // soft errors by top-level key see "valid-looking" content with the
    // error sentinel buried as an inner field.
    //
    // Trigger: mock get_country_risk to return a payload >256 KB.
    const huge = { padding: 'x'.repeat(300_000) }; // > 262_144 budget
    installMockFetch({ riskPayload: huge });

    const res = await handler(envKeyReq(readBody('worldmonitor://countries/de/risk')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, undefined, 'budget-exceeded surfaces as success-shape, not JSON-RPC error');
    const payload = JSON.parse(body.result.contents[0].text);
    assert.equal(payload._budget_exceeded, true, '_budget_exceeded sentinel must survive at top level');
    assert.equal(typeof payload.budget_bytes, 'number');
    assert.equal(typeof payload.actual_bytes, 'number');
    // Critically — no freshness fields silently merged onto the soft-error.
    assert.equal(payload.cached_at, undefined,
      'cached_at must NOT be merged onto a soft-error envelope (Greptile P2)');
    assert.equal(payload.stale, undefined,
      'stale must NOT be merged onto a soft-error envelope (Greptile P2)');
  });

  // -------------------------------------------------------------------------
  // Tool-existence parity (every resource.tool exists in TOOL_REGISTRY)
  // -------------------------------------------------------------------------
  it('every TEMPLATE_RESOURCE_REGISTRY entry references a tool that exists in TOOL_REGISTRY', () => {
    const toolNames = new Set(TOOL_REGISTRY.map((t) => t.name));
    for (const r of TEMPLATE_RESOURCE_REGISTRY) {
      assert.ok(
        toolNames.has(r.tool),
        `resource "${r.uriTemplate}" references unknown tool "${r.tool}". Known: [${[...toolNames].sort().join(', ')}]`,
      );
    }
  });

  it('PUBLIC_RESOURCE_REGISTRY entries are concrete (no {template}) and expose a read() function', () => {
    assert.ok(PUBLIC_RESOURCE_REGISTRY.length >= 1, 'at least one public resource must exist');
    for (const r of PUBLIC_RESOURCE_REGISTRY) {
      assert.doesNotMatch(r.uri, /[{}]/, `public resource ${r.uri} must be a concrete URI`);
      assert.equal(typeof r.read, 'function', `public resource ${r.uri} must expose a read() function`);
    }
  });

  // -------------------------------------------------------------------------
  // server-card.json drift (mirrors the prompts test posture)
  // -------------------------------------------------------------------------
  it('server-card.json advertises resources: true (matches the wire capability)', () => {
    const card = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'public', '.well-known', 'mcp', 'server-card.json'), 'utf8'),
    );
    assert.equal(card.capabilities?.resources, true,
      'server-card.json::capabilities.resources must be true (wire-card parity)');
  });
});
