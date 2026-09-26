import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  classifyRpcHandler,
  handlerFileForRoute,
  isAlwaysCloudPreferred,
  readSidecarCloudPreferred,
  scanRpcHandlers,
  wholeSeedOnlyDomains,
} from './helpers/seed-only-rpc-routes.mjs';

// #5906: the desktop sidecar has no Redis credentials, a Redis miss degrades
// to an empty 200, and an empty 200 never trips the `!response.ok` cloud
// fallback. Every RPC handler that only reads seed-owned Redis therefore has
// to be cloud-preferred in the sidecar, or the desktop renders a blank panel
// with no error anywhere. The hand-maintained list in local-api-server.mjs
// covered 5 of 34 domains when this was filed; this test derives the set from
// server/worldmonitor so the list cannot silently fall behind again.

const root = resolve(import.meta.dirname, '..');
const sidecarSource = readFileSync(resolve(root, 'src-tauri/sidecar/local-api-server.mjs'), 'utf8');
const decl = readSidecarCloudPreferred(sidecarSource);
const { routes, byDomain } = scanRpcHandlers(root);
const seedOnlyRoutes = routes.filter((r) => r.seedOnly);

describe('handler classifier', () => {
  it('treats a Redis-only reader as seed-only and any outbound call as live', () => {
    assert.equal(classifyRpcHandler("import { getCachedJson } from '../../../_shared/redis';\nreturn getCachedJson(KEY);").seedOnly, true);
    assert.equal(classifyRpcHandler("const data = await getCachedJson(KEY); const r = await fetch(url);").seedOnly, false);
    assert.equal(classifyRpcHandler("const data = await getCachedJson(KEY); return wtoFetch(q);").seedOnly, false);
    assert.equal(classifyRpcHandler("const rows = await getCachedJsonBatch(keys); const x = fredFetchJson(u);").seedOnly, false);
    assert.equal(classifyRpcHandler("await cachedFetchJson(key, ttl, fetcher);").seedOnly, false);
  });

  it('does not mistake fetchedAt fields for network calls', () => {
    const src = "const p = await getCachedJson(KEY); return { fetchedAt: normalizeFetchedAt(p), snapshotFetchedAt: p.fetchedAt };";
    assert.equal(classifyRpcHandler(src).seedOnly, true);
  });

  it('classifies a handler with no Redis read as live, not seed-only', () => {
    assert.equal(classifyRpcHandler('return { ok: true };').seedOnly, false);
  });
});

describe('sidecar cloud-preferred coverage of seed-only routes', () => {
  it('finds the scan surface it expects', () => {
    assert.ok(routes.length > 200, `scanned only ${routes.length} handlers`);
    assert.ok(seedOnlyRoutes.length > 80, `only ${seedOnlyRoutes.length} seed-only handlers found`);
  });

  it('cloud-prefers every seed-only route regardless of WS_RELAY_URL', () => {
    const uncovered = seedOnlyRoutes
      .filter((r) => !isAlwaysCloudPreferred(r.route, decl))
      .map((r) => `${r.route}  (${r.file})`);
    assert.deepEqual(uncovered, [], 'seed-only routes the desktop would serve as an empty 200');
  });

  it('uses a domain prefix exactly for the domains where every handler is seed-only', () => {
    const whole = wholeSeedOnlyDomains(byDomain).map((d) => `/api/${d}/v1/`);
    assert.deepEqual(
      [...decl.seedOnlyPrefixes].sort(),
      whole,
      'cloudPreferredSeedOnlyPrefixes must equal the whole-seed-only domain set: a domain that gains a live handler must move to exact entries so that handler can still run locally',
    );
  });

  it('never cloud-prefers a live handler through the seed-only prefixes', () => {
    const wrongly = routes
      .filter((r) => !r.seedOnly && decl.seedOnlyPrefixes.some((p) => r.route.startsWith(p)))
      .map((r) => r.route);
    assert.deepEqual(wrongly, []);
  });

  it('keeps every exact entry pointing at a handler that still exists', () => {
    const stale = decl.exact
      .filter((route) => route !== '/api/bootstrap')
      .filter((route) => {
        const handler = handlerFileForRoute(route);
        return !handler || !existsSync(resolve(root, handler));
      });
    assert.deepEqual(stale, [], 'exact entries with no handler file behind them');
  });

  it('consults the seed-only prefixes in isCloudPreferred', () => {
    assert.match(
      sidecarSource,
      /function isCloudPreferred\(pathname\) \{[\s\S]*?cloudPreferredSeedOnlyPrefixes\.some\(p => pathname\.startsWith\(p\)\)[\s\S]*?\n\}/,
    );
  });
});

describe('route derivation for versioned families (#5907)', () => {
  it('maps the shipping v2 family to /api/v2/shipping/…, the URL api/v2/shipping/[rpc].ts actually serves', () => {
    const shipping = routes.filter((r) => r.domain === 'shipping');
    assert.ok(shipping.length > 0);
    for (const r of shipping) assert.match(r.route, /^\/api\/v2\/shipping\//, r.route);
    assert.equal(handlerFileForRoute('/api/v2/shipping/route-intelligence'), 'server/worldmonitor/shipping/v2/route-intelligence.ts');
    assert.equal(handlerFileForRoute('/api/market/v1/list-market-quotes'), 'server/worldmonitor/market/v1/list-market-quotes.ts');
    assert.equal(handlerFileForRoute('/api/bootstrap'), null);
  });
});
