import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  classifyRpcHandler,
  isAlwaysCloudPreferred,
  readGeneratedRoutes,
  readSidecarCloudPreferred,
  scanRpcHandlers,
  wholeSeedOnlyPrefixes,
} from './helpers/seed-only-rpc-routes.mjs';

// #5906: the desktop sidecar has no Redis credentials, a Redis miss degrades
// to an empty 200, and an empty 200 never trips the `!response.ok` cloud
// fallback. Every RPC handler that only reads seed-owned Redis therefore has
// to be cloud-preferred in the sidecar, or the desktop renders a blank panel
// with no error anywhere. The hand-maintained list in local-api-server.mjs
// covered 5 of 34 domains when this was filed; this test derives the set from
// the generated route tables and server/worldmonitor so the list cannot
// silently fall behind again.

const root = resolve(import.meta.dirname, '..');
const sidecarSource = readFileSync(resolve(root, 'src-tauri/sidecar/local-api-server.mjs'), 'utf8');
const decl = readSidecarCloudPreferred(sidecarSource);
const { routes, byPrefix } = scanRpcHandlers(root);
const routeByPath = new Map(routes.map((r) => [r.route, r]));
const seedOnlyRoutes = routes.filter((r) => r.seedOnly);

// Exact entries that are not sebuf RPC routes: the bootstrap endpoint is a
// legacy api/bootstrap.js entry with no generated route behind it.
const NON_RPC_EXACT = new Set(['/api/bootstrap']);

describe('handler classifier', () => {
  it('treats a Redis-only reader as seed-only and any outbound call as live', () => {
    assert.equal(classifyRpcHandler("import { getCachedJson } from '../../../_shared/redis';\nreturn getCachedJson(KEY);").seedOnly, true);
    assert.equal(classifyRpcHandler("const data = await getCachedJson(KEY); const r = await fetch(url);").seedOnly, false);
    assert.equal(classifyRpcHandler("const data = await getCachedJson(KEY); return wtoFetch(q);").seedOnly, false);
    assert.equal(classifyRpcHandler("const rows = await getCachedJsonBatch(keys); const x = fredFetchJson(u);").seedOnly, false);
    assert.equal(classifyRpcHandler("await cachedFetchJson(key, ttl, fetcher);").seedOnly, false);
    assert.equal(classifyRpcHandler("return runRedisPipeline([['ZRANGEBYSCORE', KEY, 0, 10]], true);").seedOnly, true);
    assert.equal(classifyRpcHandler("return runRedisPipeline([['SET', KEY, value]], true);").seedOnly, false);
  });

  it('treats readRequiredSeed as a Redis read (#8360)', () => {
    assert.equal(classifyRpcHandler("const seed = await readRequiredSeed(KEY, decode);").seedOnly, true);
  });

  it('counts fetch helpers whose names carry digits or type arguments as outbound', () => {
    // get-country-chokepoint-index calls lazyFetchBilateralHs4(…).
    assert.equal(classifyRpcHandler("const s = await getCachedJson(K); const hs4 = await lazyFetchBilateralHs4(iso2);").seedOnly, false);
    assert.equal(classifyRpcHandler("const s = await getCachedJson(K); const r = await fetchJson<Rows>(u);").seedOnly, false);
  });

  it('ignores relay and proxy mentions in comments', () => {
    const src = [
      '// All UCDP fetching happens on Railway (ais-relay.cjs seedUcdpEvents loop).',
      '/* The edge proxy forwards this; see https://example.com/notes */',
      'const seed = await getCachedJson(KEY);',
    ].join('\n');
    assert.equal(classifyRpcHandler(src).seedOnly, true);
  });

  it('still sees outbound tokens in code, including URLs inside strings', () => {
    assert.equal(classifyRpcHandler("const s = await getCachedJson(K); const u = 'https://api.example.com/x';").seedOnly, false);
    assert.equal(classifyRpcHandler("const s = await getCachedJson(K); const base = getRelayBaseUrl();").seedOnly, false);
  });

  it('does not mistake fetchedAt fields for network calls', () => {
    const src = "const p = await getCachedJson(KEY); return { fetchedAt: normalizeFetchedAt(p), snapshotFetchedAt: p.fetchedAt };";
    assert.equal(classifyRpcHandler(src).seedOnly, true);
  });

  it('classifies a handler with no Redis read as live, not seed-only', () => {
    assert.equal(classifyRpcHandler('return { ok: true };').seedOnly, false);
  });
});

describe('route derivation from the generated route tables', () => {
  it('pairs each generated path with the handler method it dispatches to', () => {
    const generated = readFileSync(resolve(root, 'src/generated/server/worldmonitor/infrastructure/v1/service_server.ts'), 'utf8');
    const pairs = readGeneratedRoutes(generated);
    assert.ok(pairs.some((p) => p.path === '/api/infrastructure/v1/list-internet-ddos-attacks'));
  });

  it('maps an RPC to its implementation file even when the file name differs from the route', () => {
    assert.equal(routeByPath.get('/api/infrastructure/v1/list-internet-ddos-attacks')?.file, 'server/worldmonitor/infrastructure/v1/list-ddos-attacks.ts');
    assert.equal(routeByPath.get('/api/news/v1/summarize-article-cache')?.file, 'server/worldmonitor/news/v1/get-summarize-article-cache.ts');
    assert.equal(routeByPath.get('/api/resilience/v1/get-runtime-manifest')?.file, 'server/worldmonitor/resilience/v1/get-resilience-runtime-manifest.ts');
  });

  it('maps the shipping v2 family to /api/v2/shipping/…, the URL api/v2/shipping/[rpc].ts actually serves (#5907)', () => {
    const shipping = routes.filter((r) => r.file.startsWith('server/worldmonitor/shipping/'));
    assert.ok(shipping.length > 0);
    for (const r of shipping) assert.match(r.route, /^\/api\/v2\/shipping\//, r.route);
  });

  it('finds the scan surface it expects', () => {
    assert.ok(routes.length > 200, `scanned only ${routes.length} routes`);
    assert.ok(seedOnlyRoutes.length > 80, `only ${seedOnlyRoutes.length} seed-only routes found`);
  });

  it('classifies the trade handlers that call WITS/HTS live (#9084, #9086) as live', () => {
    for (const route of ['/api/trade/v1/get-bilateral-tariff', '/api/trade/v1/get-us-import-duty']) {
      assert.equal(routeByPath.get(route)?.seedOnly, false, route);
    }
  });
});

describe('sidecar cloud-preferred coverage of seed-only routes', () => {
  it('routes daily country history to its cloud archive', () => {
    assert.ok(isAlwaysCloudPreferred('/api/intelligence/v1/get-country-history', decl));
  });
  it('cloud-prefers every seed-only route regardless of WS_RELAY_URL', () => {
    const uncovered = seedOnlyRoutes
      .filter((r) => !isAlwaysCloudPreferred(r.route, decl))
      .map((r) => `${r.route}  (${r.file})`);
    assert.deepEqual(uncovered, [], 'seed-only routes the desktop would serve as an empty 200');
  });

  it('uses a route prefix exactly for the families where every route is seed-only', () => {
    assert.deepEqual(
      [...decl.seedOnlyPrefixes].sort(),
      wholeSeedOnlyPrefixes(byPrefix),
      'cloudPreferredSeedOnlyPrefixes must equal the whole-seed-only prefix set: a family that gains a live handler must move to exact entries so that handler can still run locally',
    );
  });

  it('never cloud-prefers a live handler through the seed-only prefixes', () => {
    const wrongly = routes
      .filter((r) => !r.seedOnly && decl.seedOnlyPrefixes.some((p) => r.route.startsWith(p)))
      .map((r) => r.route);
    assert.deepEqual(wrongly, []);
  });

  it('keeps every exact entry a real generated RPC route', () => {
    const unknown = decl.exact.filter((route) => !NON_RPC_EXACT.has(route) && !routeByPath.has(route));
    assert.deepEqual(unknown, [], 'exact entries that no generated service_server.ts serves');
  });

  it('keeps every exact entry seed-only, so no live handler is forced to the cloud', () => {
    const live = decl.exact
      .filter((route) => routeByPath.get(route)?.seedOnly === false)
      .map((route) => `${route}  (${routeByPath.get(route).file})`);
    assert.deepEqual(live, [], 'exact entries whose handler reaches an upstream itself');
  });

  it('does not repeat an exact entry that a seed-only prefix already covers', () => {
    const redundant = decl.exact.filter((route) => decl.seedOnlyPrefixes.some((p) => route.startsWith(p)));
    assert.deepEqual(redundant, []);
  });

  it('consults the seed-only prefixes in isCloudPreferred', () => {
    assert.match(
      sidecarSource,
      /function isCloudPreferred\(pathname\) \{[\s\S]*?cloudPreferredSeedOnlyPrefixes\.some\(p => pathname\.startsWith\(p\)\)[\s\S]*?\n\}/,
    );
  });
});
