import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { PluginBuild } from 'esbuild';
import { readFileSync } from 'node:fs';

// #7048 — getHydratedData() is consume-once, so a recurring loader that
// returned an accepted bootstrap value directly refetched its RPC on every
// later viewport/refresh call. These tests pin the reuse contract: a valid
// hydrated value must survive into the owning breaker cache (or, for loaders
// with no breaker, the service-owned hydration handoff), so the second call
// makes zero network requests; empty hydration still falls through once; the
// handoff expires so a normal refresh can resume.

type Harness = {
  fetchBootstrapData: () => Promise<void>;
  bootstrapTesting: { resetBootstrapForTests: () => void };
  fetchNaturalEvents: () => Promise<Array<{ id: string; title: string }>>;
  fetchAllFires: () => Promise<{ totalCount: number; regions?: Record<string, unknown[]>; skipped?: boolean }>;
  fetchEarthquakes: () => Promise<Array<{ id: string }>>;
  fetchSocialVelocity: () => Promise<{ posts: Array<{ id: string }>; fetchedAt: number }>;
  fetchDiseaseOutbreaks: () => Promise<{ outbreaks: Array<{ id: string }>; fetchedAt: number }>;
  fetchSanctionsPressure: () => Promise<{ totalCount: number; entries: Array<{ id: string }> }>;
  fetchConsumerPriceOverview: (marketCode?: string, basketSlug?: string) => Promise<{ marketCode: string; asOf: string }>;
  fetchConsumerPriceCategories: (marketCode?: string, basketSlug?: string, range?: string) => Promise<{
    marketCode: string;
    asOf: string;
    categories: Array<{ slug: string }>;
  }>;
  fetchConsumerPriceMovers: (marketCode?: string, range?: string, categorySlug?: string) => Promise<{
    marketCode: string;
    asOf: string;
    risers: Array<{ productId: string }>;
    fallers: Array<{ productId: string }>;
  }>;
  fetchRetailerPriceSpreads: (marketCode?: string, basketSlug?: string) => Promise<{
    marketCode: string;
    asOf: string;
    retailers: Array<{ slug: string }>;
  }>;
  createHydrationHandoff: <T>(
    key: string,
    validate: (value: unknown) => T | null,
    options?: { ttlMs?: number },
  ) => { accept: () => T | null; read: () => T | null };
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalFetch = globalThis.fetch;
let harness: Harness;

const NATURAL_EVENT = {
  id: 'eonet-EONET_1', title: 'Storm Alpha', category: 'severeStorms', categoryTitle: 'Severe Storms',
  lat: 12.5, lon: -70.1, date: '2026-08-01T00:00:00Z', closed: false,
};
const FIRE_DETECTION = {
  id: 'fire-1', region: 'BR', brightness: 330.5, frp: 12.5, confidence: 'FIRE_CONFIDENCE_HIGH',
  acq_date: '2026-08-01', daynight: 'N', location: { latitude: -10.2, longitude: -55.3 },
};
const EARTHQUAKE = {
  id: 'us-7001', place: '12 km SE of X', magnitude: 4.6, depthKm: 33.2,
  occurredAt: 1754000000, sourceUrl: 'https://example.org/eq', source: 'usgs', category: 'usgs',
};
const CONCURRENT_EARTHQUAKE = {
  ...EARTHQUAKE,
  id: 'us-concurrent-7002',
  place: 'Concurrent hydration sentinel',
};
const SOCIAL_POST = { id: 'post-1', title: 'headline', velocity: 42 };
const OUTBREAK = { id: 'out-1', disease: 'Cholera', country: 'YY', cases: 10 };

function bootstrapStub(
  payload: Record<string, unknown>,
  rpcResponseForUrl: (url: string) => unknown = (url) => ({ __rpc: true, url }),
) {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/api/bootstrap')) {
      return new Response(JSON.stringify({ data: payload, missing: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(rpcResponseForUrl(url)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return requests;
}

function rpcUrlCount(requests: string[]): number {
  return requests.filter((url) => !url.includes('/api/bootstrap')).length;
}

before(async () => {
  // sanctions-pressure pulls panel-gating (billing/entitlements -> i18n's
  // import.meta.glob, which only exists under Vite). Stub the two browser-only
  // seams; forcing hasPremiumAccess() true also makes the recurring path the
  // premium breaker itself, which is exactly what the warm targets.
  const stubBrowserSeams = {
    name: 'stub-browser-seams',
    setup(b: PluginBuild) {
      b.onResolve({ filter: /^@\/utils$/ }, (args) => (
        args.importer.endsWith('/src/services/consumer-prices/index.ts')
          ? { path: resolve(root, 'src/utils/circuit-breaker.ts') }
          : undefined
      ));
      b.onResolve({ filter: /services\/panel-gating/ }, () => ({ path: 'stub:panel-gating', namespace: 'stub-seam' }));
      b.onResolve({ filter: /services\/premium-fetch/ }, () => ({ path: 'stub:premium-fetch', namespace: 'stub-seam' }));
      b.onLoad({ filter: /.*/, namespace: 'stub-seam' }, (args) => ({
        contents: args.path === 'stub:panel-gating'
          ? 'export function hasPremiumAccess() { return true; }'
          : 'export async function premiumFetch(...args) { return globalThis.fetch(...args); }',
        loader: 'js',
      }));
    },
  };
  const result = await build({
    stdin: {
      contents: [
        "export { fetchNaturalEvents } from './src/services/eonet.ts';",
        "export { fetchAllFires } from './src/services/wildfires/index.ts';",
        "export { fetchEarthquakes } from './src/services/earthquakes.ts';",
        "export { fetchSocialVelocity } from './src/services/social-velocity.ts';",
        "export { fetchDiseaseOutbreaks } from './src/services/disease-outbreaks.ts';",
        "export { fetchSanctionsPressure } from './src/services/sanctions-pressure.ts';",
        "export { fetchConsumerPriceOverview, fetchConsumerPriceCategories, fetchConsumerPriceMovers, fetchRetailerPriceSpreads } from './src/services/consumer-prices/index.ts';",
        "export { createHydrationHandoff } from './src/services/hydration-handoff.ts';",
        "export { fetchBootstrapData, __testing__ as bootstrapTesting } from './src/services/bootstrap.ts';",
      ].join('\n'),
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'bootstrap-hydration-reuse-entry.ts',
    },
    bundle: true,
    define: { 'import.meta.env': '{"DEV":false}' },
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
    plugins: [stubBrowserSeams],
  });
  const source = result.outputFiles[0]?.text;
  assert.ok(source, 'esbuild must emit the hydration-reuse harness');
  harness = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as Harness;
});

afterEach(() => {
  harness.bootstrapTesting.resetBootstrapForTests();
  globalThis.fetch = originalFetch;
});

describe('bootstrap hydration reuse (#7048)', () => {
  // Runs FIRST: the service breakers are module singletons, so a later test
  // that warms a cache would otherwise answer this fallthrough scenario from
  // that stale entry.
  it('empty hydration falls through once to the fetch path (recovery preserved)', async () => {
    const requests = bootstrapStub({ naturalEvents: { events: [] } });
    await harness.fetchBootstrapData();

    const result = await harness.fetchNaturalEvents();
    assert.deepEqual(result, [], 'breaker fallback shape is preserved for rejected hydration');
    assert.equal(rpcUrlCount(requests), 1, 'rejected hydration must fall through to the live path exactly once');
  });

  it('naturalEvents: a second call is served from the warmed breaker with zero RPC requests', async () => {
    const requests = bootstrapStub({ naturalEvents: { events: [NATURAL_EVENT] } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchNaturalEvents();
    const second = await harness.fetchNaturalEvents();

    assert.equal(first.length, 1);
    assert.equal(first[0].id, 'eonet-EONET_1');
    assert.deepEqual(second, first, 'second call must return equivalent data');
    assert.equal(rpcUrlCount(requests), 0, 'accepted hydration must not be followed by an RPC refetch');
  });

  it('wildfires: a second call is served from the warmed breaker with zero RPC requests', async () => {
    const requests = bootstrapStub({ wildfires: { fireDetections: [FIRE_DETECTION], fetchedAt: 1, dataAvailable: true } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchAllFires();
    const second = await harness.fetchAllFires();

    assert.equal(first.totalCount, 1);
    assert.ok(first.regions && Object.keys(first.regions).length === 1, 'detections are grouped by region');
    assert.deepEqual(second, first);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('concurrent first earthquake calls consume accepted hydration before the breaker is warm', async () => {
    const requests = bootstrapStub({ earthquakes: { earthquakes: [CONCURRENT_EARTHQUAKE] } });
    await harness.fetchBootstrapData();

    const [a, b] = await Promise.all([harness.fetchEarthquakes(), harness.fetchEarthquakes()]);
    assert.equal(a.length, 1);
    assert.equal(a[0].id, 'us-concurrent-7002');
    assert.deepEqual(b, a);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('earthquakes: newer hydration replaces a fresh breaker entry and is reused', async () => {
    const requests = bootstrapStub({ earthquakes: { earthquakes: [EARTHQUAKE] } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchEarthquakes();
    const second = await harness.fetchEarthquakes();

    assert.equal(first.length, 1);
    assert.equal(first[0].id, 'us-7001');
    assert.deepEqual(second, first);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('socialVelocity (no breaker): the hydration handoff answers recurring reads', async () => {
    const requests = bootstrapStub({ socialVelocity: { posts: [SOCIAL_POST], fetchedAt: 1 } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchSocialVelocity();
    const second = await harness.fetchSocialVelocity();

    assert.equal(first.posts.length, 1);
    assert.deepEqual(second, first);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('diseaseOutbreaks (no breaker): the hydration handoff answers recurring reads', async () => {
    const requests = bootstrapStub({ diseaseOutbreaks: { outbreaks: [OUTBREAK], fetchedAt: 1, alertLevelMethodologyVersion: 'v1' } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchDiseaseOutbreaks();
    const second = await harness.fetchDiseaseOutbreaks();

    assert.equal(first.outbreaks.length, 1);
    assert.deepEqual(second, first);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('sanctionsPressure: accepted hydration reaches callers and warms the premium breaker', async () => {
    // hasPremiumAccess() is stubbed true (see the build plugin), so the
    // recurring path is the premium breaker the recordSuccess warm targets:
    // zero RPC requests on the second call is the assertion that matters.
    const requests = bootstrapStub({
      sanctionsPressure: { entries: [{ id: 'sdn-1', name: 'X', entityType: 'ENTITY', countryCodes: [], countryNames: [], programs: [], sourceLists: [], effectiveAt: 0, isNew: false, note: '' }], countries: [], programs: [], totalCount: 1, sdnCount: 1, consolidatedCount: 0, semaCount: 0, newEntryCount: 0, vesselCount: 0, aircraftCount: 0, fetchedAt: 1, datasetDate: 1 },
    });
    await harness.fetchBootstrapData();

    const first = await harness.fetchSanctionsPressure();
    const second = await harness.fetchSanctionsPressure();

    assert.equal(first.totalCount, 1);
    assert.deepEqual(second, first);
    assert.equal(rpcUrlCount(requests), 0, 'the premium sanctions RPC must not fire for bootstrap-sourced data');
  });

  it('consumer prices: default hydration is isolated from parameterized cache keys and reused', async () => {
    const defaultOverview = {
      marketCode: 'all', asOf: 'bootstrap-overview', currencyCode: 'AED', essentialsIndex: 101,
      valueBasketIndex: 99, wowPct: 1, momPct: 2, retailerSpreadPct: 3, coveragePct: 100,
      freshnessLagMin: 5, topCategories: [], upstreamUnavailable: false,
    };
    const defaultCategories = {
      marketCode: 'all', asOf: 'bootstrap-categories', range: '30d', upstreamUnavailable: false,
      categories: [{ slug: 'bootstrap-category', name: 'Bootstrap category', wowPct: 1, momPct: 2, currentIndex: 101, sparkline: [], coveragePct: 100, itemCount: 1 }],
    };
    const defaultMovers = {
      marketCode: 'all', asOf: 'bootstrap-movers', range: '30d', upstreamUnavailable: false, fallers: [],
      risers: [{ productId: 'bootstrap-mover', title: 'Bootstrap mover', category: 'food', retailerSlug: 'bootstrap', changePct: 4, currentPrice: 10, currencyCode: 'AED' }],
    };
    const defaultSpread = {
      marketCode: 'all', asOf: 'bootstrap-spread', basketSlug: 'essentials-ae', currencyCode: 'AED',
      spreadPct: 7, upstreamUnavailable: false,
      retailers: [{ slug: 'bootstrap-retailer', name: 'Bootstrap retailer', basketTotal: 100, deltaVsCheapest: 0, deltaVsCheapestPct: 0, itemCount: 1, freshnessMin: 5, currencyCode: 'AED' }],
    };
    const requests = bootstrapStub({
      consumerPricesOverview: defaultOverview,
      consumerPricesCategories: defaultCategories,
      consumerPricesMovers: defaultMovers,
      consumerPricesSpread: defaultSpread,
    }, (url) => {
      if (url.includes('/get-consumer-price-overview')) {
        return { ...defaultOverview, marketCode: 'ae', asOf: 'rpc-overview' };
      }
      if (url.includes('/list-consumer-price-categories')) {
        return { ...defaultCategories, marketCode: 'ae', asOf: 'rpc-categories', range: '90d' };
      }
      if (url.includes('/list-consumer-price-movers')) {
        return { ...defaultMovers, marketCode: 'ae', asOf: 'rpc-movers', range: '7d' };
      }
      if (url.includes('/list-retailer-price-spreads')) {
        return { ...defaultSpread, marketCode: 'ae', asOf: 'rpc-spread', basketSlug: 'value-ae' };
      }
      return { unexpectedRpcUrl: url };
    });
    await harness.fetchBootstrapData();

    const parameterized = await Promise.all([
      harness.fetchConsumerPriceOverview('ae', 'value-ae'),
      harness.fetchConsumerPriceCategories('ae', 'value-ae', '90d'),
      harness.fetchConsumerPriceMovers('ae', '7d', 'food'),
      harness.fetchRetailerPriceSpreads('ae', 'value-ae'),
    ]);
    assert.deepEqual(parameterized.map((value) => value.asOf), [
      'rpc-overview', 'rpc-categories', 'rpc-movers', 'rpc-spread',
    ], 'each non-default parameter tuple must use its own RPC result');
    assert.equal(rpcUrlCount(requests), 4);

    const firstDefaults = await Promise.all([
      harness.fetchConsumerPriceOverview(),
      harness.fetchConsumerPriceCategories(),
      harness.fetchConsumerPriceMovers(),
      harness.fetchRetailerPriceSpreads(),
    ]);
    const secondDefaults = await Promise.all([
      harness.fetchConsumerPriceOverview(),
      harness.fetchConsumerPriceCategories(),
      harness.fetchConsumerPriceMovers(),
      harness.fetchRetailerPriceSpreads(),
    ]);

    assert.deepEqual(firstDefaults.map((value) => value.asOf), [
      'bootstrap-overview', 'bootstrap-categories', 'bootstrap-movers', 'bootstrap-spread',
    ], 'parameterized breaker entries must not shadow the default bootstrap payloads');
    assert.deepEqual(secondDefaults, firstDefaults, 'the exact default cache keys must reuse bootstrap hydration');
    assert.equal(rpcUrlCount(requests), 4, 'default bootstrap reads must add no RPC requests');
  });

  it('hydration handoff: TTL expiry lets the normal fetch path resume', async () => {
    const handoff = harness.createHydrationHandoff<{ v: number }>(
      'unitHandoffKey',
      (value) => (value && typeof (value as { v?: unknown }).v === 'number' ? value as { v: number } : null),
      { ttlMs: 5 },
    );
    assert.equal(handoff.read(), null, 'nothing accepted yet');

    // Seed the bootstrap slot the way fetchBootstrapData would.
    const requests = bootstrapStub({ unitHandoffKey: { v: 7 } });
    await harness.fetchBootstrapData();
    assert.equal(handoff.accept()?.v, 7);
    assert.equal(handoff.read()?.v, 7);

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(handoff.read(), null, 'an expired handoff must not answer recurring reads');
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('hydration handoff: rejected values are not retained', async () => {
    const handoff = harness.createHydrationHandoff<{ v: number }>(
      'unitHandoffRejectedKey',
      (value) => ((value as { v?: unknown })?.v === 42 ? value as { v: number } : null),
      { ttlMs: 60_000 },
    );
    bootstrapStub({ unitHandoffRejectedKey: { v: 41 } });
    await harness.fetchBootstrapData();
    assert.equal(handoff.accept(), null, 'invalid hydration is not accepted');
    assert.equal(handoff.read(), null, 'and therefore not retained');
  });

  it('the mandatory services warm their owner cache in source (#7048 regression pin)', () => {
    // Behavioral coverage above exercises the reuse loop; this pins that the
    // recordSuccess-based warmers (whose owners are typed results rather than
    // raw responses) keep the call, mirroring hydration-lock-keys.test.mts.
    const mustWarm: Array<[string, RegExp]> = [
      ['src/services/sanctions-pressure.ts', /breaker\.recordSuccess\(result\)/],
      ['src/services/radiation.ts', /breaker\.recordSuccess\(result\)/],
      ['src/services/aviation/index.ts', /breakerDelays\.recordSuccess\(alerts\)/],
      ['src/services/conflict/index.ts', /iranBreaker\.recordSuccess\(hydrated\)/],
      ['src/services/pizzint.ts', /pizzintBreaker\.recordSuccess\(status\)/],
      ['src/services/thermal-escalation.ts', /breaker\.recordSuccess\(watch\)/],
      ['src/services/unrest/index.ts', /unrestBreaker\.recordSuccess\(hydrated\)/],
      ['src/services/economic/index.ts', /bisPolicyBreaker\.recordSuccess\(hPolicy\)/],
    ];
    for (const [file, marker] of mustWarm) {
      const source = readFileSync(resolve(root, file), 'utf8');
      assert.match(source, marker, `${file} must warm its owner cache with accepted hydration`);
    }
  });
});
