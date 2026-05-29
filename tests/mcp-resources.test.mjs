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
let RESOURCE_REGISTRY;
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
    RESOURCE_REGISTRY = mod.__testing__.RESOURCE_REGISTRY;
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
  // resources/list shape
  // -------------------------------------------------------------------------
  it('resources/list returns exactly four entries with the documented URIs', async () => {
    const res = await handler(envKeyReq({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.result?.resources), 'result.resources must be an array');
    assert.equal(body.result.resources.length, 4, `Expected 4 resources, got ${body.result.resources.length}`);

    const expectedUris = [
      'worldmonitor://countries/{iso2}/risk',
      'worldmonitor://chokepoints/{slug}/status',
      'worldmonitor://seed-meta/freshness',
      'worldmonitor://markets/{symbol}/quote',
    ];
    const actualUris = body.result.resources.map((r) => r.uri);
    assert.deepEqual(actualUris, expectedUris, 'resource URIs and order must match the documented set');

    for (const r of body.result.resources) {
      assert.equal(typeof r.uri, 'string', `resource ${r.uri}: uri must be a string`);
      assert.ok(r.uri.length > 0, `resource ${r.uri}: uri must be non-empty`);
      assert.equal(typeof r.name, 'string', `resource ${r.uri}: name must be a string`);
      assert.equal(typeof r.description, 'string', `resource ${r.uri}: description must be a string`);
      assert.equal(r.mimeType, 'application/json', `resource ${r.uri}: mimeType must be application/json`);
      // Internal authoring fields must NOT leak via resources/list.
      assert.equal(r.tool, undefined, `resource ${r.uri}: internal "tool" must not leak via resources/list`);
      assert.equal(r.paramExtractor, undefined, `resource ${r.uri}: internal "paramExtractor" must not leak via resources/list`);
      assert.equal(r.freshnessWrap, undefined, `resource ${r.uri}: internal "freshnessWrap" must not leak via resources/list`);
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

  it('Pro resources/read on cache-tool-backed URIs (markets, chokepoints, seed-meta) also increments counter by 1 each', async () => {
    const uris = [
      'worldmonitor://markets/AAPL/quote',
      'worldmonitor://chokepoints/suez/status',
      'worldmonitor://seed-meta/freshness',
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
  it('every RESOURCE_REGISTRY entry references a tool that exists in TOOL_REGISTRY', () => {
    const toolNames = new Set(TOOL_REGISTRY.map((t) => t.name));
    for (const r of RESOURCE_REGISTRY) {
      assert.ok(
        toolNames.has(r.tool),
        `resource "${r.uri}" references unknown tool "${r.tool}". Known: [${[...toolNames].sort().join(', ')}]`,
      );
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
