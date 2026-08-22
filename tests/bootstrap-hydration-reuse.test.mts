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
  fetchFlightDelays: () => Promise<Array<{ id: string; updatedAt: Date }>>;
  fetchTrafficAnomalies: (country?: string) => Promise<{ anomalies: Array<{ id: string }>; totalCount: number }>;
  fetchSocialVelocity: () => Promise<{ posts: Array<{ id: string }>; fetchedAt: number }>;
  fetchDiseaseOutbreaks: () => Promise<{ outbreaks: Array<{ id: string }>; fetchedAt: number }>;
  fetchSanctionsPressure: () => Promise<{
    totalCount: number;
    semaError: string | null;
    entries: Array<{ id: string }>;
  }>;
  fetchPizzIntStatus: () => Promise<{
    dataFreshness: 'fresh' | 'stale';
    lastUpdate: Date;
  }>;
  fetchChokepointStatus: () => Promise<{
    chokepoints: Array<{ id: string }>;
    fetchedAt: string;
    upstreamUnavailable: boolean;
  }>;
  refreshChokepointStatusAfterHydration: (response: {
    chokepoints: Array<{ id: string }>;
    fetchedAt: string;
    upstreamUnavailable: boolean;
  }) => Promise<{
    chokepoints: Array<{ id: string }>;
    fetchedAt: string;
    upstreamUnavailable: boolean;
  } | null>;
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
  ) => {
    get: () => T | null;
    getOrLoad: (load: () => Promise<T>, fallback: T) => Promise<T>;
  };
};

type MirrorHarness = {
  fetchRadiationWatch: () => Promise<unknown>;
  getLatestRadiationWatch: () => unknown;
  fetchSanctionsPressure: () => Promise<unknown>;
  getLatestSanctionsPressure: () => unknown;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalFetch = globalThis.fetch;
let harness: Harness;
let mirrorHarness: MirrorHarness;
let capturedBreakerOptions: Record<string, {
  revivePersistedData?: (data: unknown) => unknown;
}>;

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
const FLIGHT_DELAY = {
  id: 'delay-1', iata: 'JFK', icao: 'KJFK', name: 'John F. Kennedy International', city: 'New York', country: 'US',
  location: { latitude: 40.6413, longitude: -73.7781 }, region: 'AIRPORT_REGION_AMERICAS',
  delayType: 'FLIGHT_DELAY_TYPE_GENERAL', severity: 'FLIGHT_DELAY_SEVERITY_MINOR', avgDelayMinutes: 18,
  delayedFlightsPct: 12, cancelledFlights: 0, totalFlights: 100, reason: 'weather',
  source: 'FLIGHT_DELAY_SOURCE_FAA', updatedAt: 1_754_000_000_000,
};
const SOCIAL_POST = { id: 'post-1', title: 'headline', velocity: 42 };
const OUTBREAK = { id: 'out-1', disease: 'Cholera', country: 'YY', cases: 10 };

function bootstrapStub(
  payload: Record<string, unknown>,
  rpcResponseForUrl: (url: string) => unknown | Promise<unknown> = (url) => ({
    __rpc: true,
    url,
    events: [],
    fireDetections: [],
    anomalies: [],
    totalCount: 0,
  }),
) {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/api/bootstrap')) {
      // A real bootstrap key belongs to one tier. Keep the deferred slow-tier
      // request empty so it cannot repopulate a consume-once test key and mask
      // whether the service cache or handoff answered the recurring call.
      const data = url.includes('tier=slow') ? {} : payload;
      return new Response(JSON.stringify({ data, missing: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(await rpcResponseForUrl(url)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return requests;
}

function rpcUrlCount(requests: string[]): number {
  return requests.filter((url) => !url.includes('/api/bootstrap')).length;
}

async function waitForRpcCount(requests: string[], expected: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && rpcUrlCount(requests) < expected; attempt += 1) {
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
  assert.equal(rpcUrlCount(requests), expected);
}

before(async () => {
  // sanctions-pressure pulls panel-gating (billing/entitlements -> i18n's
  // import.meta.glob, which only exists under Vite). Stub the two browser-only
  // seams. Anonymous access is intentional: it exercises sanctions' public
  // bootstrap fallback, the branch used by ordinary visitors.
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
      b.onResolve({ filter: /services\/i18n/ }, () => ({ path: 'stub:i18n', namespace: 'stub-seam' }));
      b.onLoad({ filter: /.*/, namespace: 'stub-seam' }, (args) => ({
        contents: args.path === 'stub:panel-gating'
          ? 'export function hasPremiumAccess() { return false; }'
          : args.path === 'stub:premium-fetch'
            ? 'export async function premiumFetch(...args) { return globalThis.fetch(...args); }'
            : "export function t(key) { return key; } export function getCurrentLanguageTag() { return 'en'; }",
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
        "export { fetchFlightDelays } from './src/services/aviation/index.ts';",
        "export { fetchTrafficAnomalies } from './src/services/infrastructure/index.ts';",
        "export { fetchSocialVelocity } from './src/services/social-velocity.ts';",
        "export { fetchDiseaseOutbreaks } from './src/services/disease-outbreaks.ts';",
        "export { fetchSanctionsPressure } from './src/services/sanctions-pressure.ts';",
        "export { fetchPizzIntStatus } from './src/services/pizzint.ts';",
        "export { fetchChokepointStatus, refreshChokepointStatusAfterHydration } from './src/services/supply-chain/index.ts';",
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

  const captureCircuitBreakerOptions = {
    name: 'capture-circuit-breaker-options',
    setup(b: PluginBuild) {
      b.onResolve({ filter: /utils\/circuit-breaker/ }, () => ({ path: 'stub:circuit-breaker', namespace: 'capture-breaker' }));
      b.onLoad({ filter: /.*/, namespace: 'capture-breaker' }, () => ({
        contents: `
          globalThis.__wmCapturedBreakerOptions ??= {};
          export function createCircuitBreaker(options) {
            globalThis.__wmCapturedBreakerOptions[options.name] = options;
            return {
              recordSuccess() {},
              getCached() { return null; },
              clearCache() {},
              getStatus() { return 'ok'; },
              async execute(fn, fallback) {
                const replay = globalThis.__wmBreakerReplay?.[options.name];
                if (replay !== undefined) {
                  if (globalThis.__wmBreakerRunBackground?.includes(options.name)) {
                    const background = Promise.resolve().then(fn);
                    (globalThis.__wmBreakerBackgroundPromises ??= []).push(background);
                  }
                  return replay;
                }
                try { return await fn(); } catch { return fallback; }
              },
            };
          }
        `,
        loader: 'js',
      }));
    },
  };
  const captureRpcClients = {
    name: 'capture-rpc-clients',
    setup(b: PluginBuild) {
      b.onResolve({ filter: /services\/generated-rpc-clients/ }, () => ({
        path: 'stub:generated-rpc-clients',
        namespace: 'capture-rpc',
      }));
      b.onLoad({ filter: /.*/, namespace: 'capture-rpc' }, () => ({
        contents: `
          export class AviationServiceClient { constructor() {} }
          export class IntelligenceServiceClient { constructor() {} }
          export class RadiationServiceClient {
            constructor() {}
            async listRadiationObservations() { return globalThis.__wmCapturedLiveRadiation; }
          }
          export class SanctionsServiceClient { constructor() {} }
          export class ThermalServiceClient { constructor() {} }
        `,
        loader: 'js',
      }));
    },
  };
  const reviverCapture = await build({
    stdin: {
      contents: [
        "import './src/services/aviation/index.ts';",
        "import './src/services/pizzint.ts';",
        "export { fetchRadiationWatch, getLatestRadiationWatch } from './src/services/radiation.ts';",
        "export { fetchSanctionsPressure, getLatestSanctionsPressure } from './src/services/sanctions-pressure.ts';",
        "import './src/services/thermal-escalation.ts';",
      ].join('\n'),
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'bootstrap-persisted-date-revivers-entry.ts',
    },
    bundle: true,
    define: { 'import.meta.env': '{"DEV":false}' },
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
    plugins: [captureCircuitBreakerOptions, captureRpcClients, stubBrowserSeams],
  });
  const reviverSource = reviverCapture.outputFiles[0]?.text;
  assert.ok(reviverSource, 'esbuild must emit the Date-reviver capture harness');
  mirrorHarness = await import(
    `data:text/javascript;base64,${Buffer.from(reviverSource).toString('base64')}`
  ) as MirrorHarness;
  capturedBreakerOptions = (globalThis as typeof globalThis & {
    __wmCapturedBreakerOptions: typeof capturedBreakerOptions;
  }).__wmCapturedBreakerOptions;
  delete (globalThis as typeof globalThis & {
    __wmCapturedBreakerOptions?: typeof capturedBreakerOptions;
  }).__wmCapturedBreakerOptions;
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

    const first = await harness.fetchNaturalEvents();
    assert.deepEqual(first, [], 'breaker fallback shape is preserved for rejected hydration');
    assert.equal(rpcUrlCount(requests), 1, 'the first rejected hydration falls through exactly once');

    const second = await harness.fetchNaturalEvents();
    assert.deepEqual(second, []);
    assert.equal(rpcUrlCount(requests), 2, 'an empty live response is not promoted into the breaker cache');
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

  it('concurrent first reads of accepted hydration make zero RPC requests', async () => {
    const requests = bootstrapStub({ earthquakes: { earthquakes: [EARTHQUAKE] } });
    await harness.fetchBootstrapData();

    const [a, b] = await Promise.all([harness.fetchEarthquakes(), harness.fetchEarthquakes()]);
    assert.equal(a.length, 1);
    assert.deepEqual(b, a);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('wildfires: rejected hydration and empty live data remain retryable', async () => {
    const requests = bootstrapStub({ wildfires: { fireDetections: [], fetchedAt: 0, dataAvailable: false } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchAllFires();
    const second = await harness.fetchAllFires();

    assert.equal(first.totalCount, 0);
    assert.equal(second.totalCount, 0);
    assert.equal(rpcUrlCount(requests), 2, 'each call retries because empty wildfire data is not cached');
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

  it('earthquakes: a second call is served from the warmed breaker with zero RPC requests', async () => {
    const requests = bootstrapStub({ earthquakes: { earthquakes: [EARTHQUAKE] } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchEarthquakes();
    const second = await harness.fetchEarthquakes();

    assert.equal(first.length, 1);
    assert.equal(first[0].id, 'us-7001');
    assert.deepEqual(second, first);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('flightDelays: concurrent on-demand hydration is one-flight and then stays in the breaker', async () => {
    const requests = bootstrapStub({ flightDelays: { alerts: [FLIGHT_DELAY] } });

    const [first, second] = await Promise.all([
      harness.fetchFlightDelays(),
      harness.fetchFlightDelays(),
    ]);
    assert.equal(first.length, 1);
    assert.ok(first[0]?.updatedAt instanceof Date);
    assert.deepEqual(second, first);
    assert.equal(
      requests.filter((url) => url.includes('keys=flightDelays')).length,
      1,
      'concurrent first calls share the on-demand request',
    );

    const third = await harness.fetchFlightDelays();
    assert.deepEqual(third, first);
    assert.equal(
      requests.filter((url) => url.includes('keys=flightDelays')).length,
      1,
      'the accepted on-demand result is retained by the delays breaker',
    );
  });

  it('traffic anomalies: global hydration never satisfies a country-specific cache key', async () => {
    const requests = bootstrapStub({
      trafficAnomalies: { anomalies: [{ id: 'global-1' }], totalCount: 1 },
    });
    await harness.fetchBootstrapData();

    const global = await harness.fetchTrafficAnomalies();
    const filtered = await harness.fetchTrafficAnomalies('US');

    assert.equal(global.anomalies[0]?.id, 'global-1');
    assert.deepEqual(filtered.anomalies, []);
    assert.equal(rpcUrlCount(requests), 1, 'the filtered read must use its own RPC/cache key');
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

  it('sanctionsPressure: partial SEMA results remain visible but retry instead of entering the success cache', async () => {
    const partial = {
      entries: [{
        id: 'sdn-partial', name: 'Partial entry', entityType: 'ENTITY', countryCodes: [],
        countryNames: [], programs: [], sourceLists: [], effectiveAt: 0, isNew: false, note: '',
      }],
      countries: [], programs: [], totalCount: 1, sdnCount: 1, consolidatedCount: 0,
      semaCount: 0, semaError: 'SEMA HTTP 503', newEntryCount: 0, vesselCount: 0,
      aircraftCount: 0, fetchedAt: 1, datasetDate: 1,
    };
    const requests = bootstrapStub({ sanctionsPressure: partial });
    await harness.fetchBootstrapData();

    const hydrated = await harness.fetchSanctionsPressure();
    const firstRetry = await harness.fetchSanctionsPressure();
    const secondRetry = await harness.fetchSanctionsPressure();

    assert.equal(hydrated.semaError, 'SEMA HTTP 503');
    assert.equal(firstRetry.semaError, 'SEMA HTTP 503');
    assert.equal(secondRetry.semaError, 'SEMA HTTP 503');
    assert.equal(
      requests.filter((url) => url.includes('keys=sanctionsPressure')).length,
      2,
      'partial SEMA data must not suppress later recovery attempts',
    );
  });

  it('sanctionsPressure: accepted hydration reaches callers and warms the anonymous path', async () => {
    // hasPremiumAccess() is stubbed false (see the build plugin), so this pins
    // the anonymous branch used by ordinary visitors.
    const requests = bootstrapStub({
      sanctionsPressure: { entries: [{ id: 'sdn-1', name: 'X', entityType: 'ENTITY', countryCodes: [], countryNames: [], programs: [], sourceLists: [], effectiveAt: 0, isNew: false, note: '' }], countries: [], programs: [], totalCount: 1, sdnCount: 1, consolidatedCount: 0, semaCount: 0, newEntryCount: 0, vesselCount: 0, aircraftCount: 0, fetchedAt: 1, datasetDate: 1 },
    });
    await harness.fetchBootstrapData();

    const first = await harness.fetchSanctionsPressure();
    const second = await harness.fetchSanctionsPressure();

    assert.equal(first.totalCount, 1);
    assert.deepEqual(second, first);
    assert.equal(rpcUrlCount(requests), 0, 'the sanctions RPC must not fire for bootstrap-sourced data');
    assert.equal(
      requests.filter((url) => url.includes('keys=sanctionsPressure')).length,
      0,
      'the anonymous per-key bootstrap path must not refetch accepted tier data',
    );
  });

  it('PizzINT: stale hydration is shown once, then a fresh live result is cached', async () => {
    const staleStatus = {
      defconLevel: 4, defconLabel: 'stale', aggregateActivity: 10, activeSpikes: 1,
      locationsMonitored: 1, locationsOpen: 1, updatedAt: 1,
      dataFreshness: 'DATA_FRESHNESS_STALE', locations: [],
    };
    const freshStatus = {
      ...staleStatus,
      defconLevel: 3,
      defconLabel: 'fresh',
      updatedAt: 2,
      dataFreshness: 'DATA_FRESHNESS_FRESH',
    };
    const requests = bootstrapStub(
      { pizzint: { pizzint: staleStatus, tensionPairs: [] } },
      () => ({ pizzint: freshStatus, tensionPairs: [] }),
    );
    await harness.fetchBootstrapData();

    const hydrated = await harness.fetchPizzIntStatus();
    const recovered = await harness.fetchPizzIntStatus();
    const cached = await harness.fetchPizzIntStatus();

    assert.equal(hydrated.dataFreshness, 'stale');
    assert.equal(recovered.dataFreshness, 'fresh');
    assert.deepEqual(cached, recovered);
    assert.equal(rpcUrlCount(requests), 1, 'stale hydration must retry once and cache only the fresh result');
  });

  it('chokepoints: degraded hydration renders promptly, refreshes once, and remains retryable', async () => {
    const degraded = {
      chokepoints: [{ id: 'hydrated-degraded' }],
      fetchedAt: 'hydrated',
      upstreamUnavailable: true,
    };
    const degradedLive = {
      chokepoints: [{ id: 'live-degraded' }],
      fetchedAt: 'live',
      upstreamUnavailable: true,
    };
    let releaseFirstRefresh!: (value: typeof degradedLive) => void;
    const firstRefresh = new Promise<typeof degradedLive>((resolveRefresh) => {
      releaseFirstRefresh = resolveRefresh;
    });
    let liveCalls = 0;
    const requests = bootstrapStub({ chokepoints: degraded }, () => {
      liveCalls += 1;
      return liveCalls === 1 ? firstRefresh : degradedLive;
    });
    await harness.fetchBootstrapData();

    const initial = await harness.fetchChokepointStatus();
    const refresh = harness.refreshChokepointStatusAfterHydration(initial);
    const concurrentRead = harness.fetchChokepointStatus();

    assert.equal(initial.chokepoints[0]?.id, 'hydrated-degraded');
    await waitForRpcCount(requests, 1);
    const concurrent = await concurrentRead;
    assert.equal(concurrent.chokepoints[0]?.id, 'hydrated-degraded');

    releaseFirstRefresh(degradedLive);
    const refreshed = await refresh;
    assert.equal(refreshed?.chokepoints[0]?.id, 'live-degraded');
    assert.equal(rpcUrlCount(requests), 1, 'concurrent readers join the hydration refresh');

    const retry = await harness.fetchChokepointStatus();
    assert.equal(retry.chokepoints[0]?.id, 'live-degraded');
    assert.equal(rpcUrlCount(requests), 2, 'degraded live data is not promoted into the breaker cache');
  });

  it('chokepoints: accepted hydration stays immediate and one refresh replaces the warmed cache', async () => {
    const hydrated = {
      chokepoints: [{ id: 'hydrated-valid' }],
      fetchedAt: 'hydrated',
      upstreamUnavailable: false,
    };
    const live = {
      chokepoints: [{ id: 'live-valid' }],
      fetchedAt: 'live',
      upstreamUnavailable: false,
    };
    let releaseRefresh!: (value: typeof live) => void;
    const liveResponse = new Promise<typeof live>((resolveRefresh) => {
      releaseRefresh = resolveRefresh;
    });
    const requests = bootstrapStub({ chokepoints: hydrated }, () => liveResponse);
    await harness.fetchBootstrapData();

    const initial = await harness.fetchChokepointStatus();
    const refresh = harness.refreshChokepointStatusAfterHydration(initial);
    const concurrentRead = harness.fetchChokepointStatus();

    assert.equal(initial.chokepoints[0]?.id, 'hydrated-valid');
    await waitForRpcCount(requests, 1);
    const concurrent = await concurrentRead;
    assert.equal(concurrent.chokepoints[0]?.id, 'hydrated-valid');

    releaseRefresh(live);
    const refreshed = await refresh;
    assert.equal(refreshed?.chokepoints[0]?.id, 'live-valid');

    const cachedLive = await harness.fetchChokepointStatus();
    assert.equal(cachedLive.chokepoints[0]?.id, 'live-valid');
    assert.equal(rpcUrlCount(requests), 1, 'the successful refresh replaces the hydrated cache');
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
    assert.equal(handoff.get(), null, 'nothing accepted yet');

    // Seed the bootstrap slot the way fetchBootstrapData would.
    const requests = bootstrapStub({ unitHandoffKey: { v: 7 } });
    await harness.fetchBootstrapData();
    assert.equal(handoff.get()?.v, 7);
    assert.equal(handoff.get()?.v, 7);

    await new Promise((r) => setTimeout(r, 20));
    let liveCalls = 0;
    const refreshed = await handoff.getOrLoad(async () => {
      liveCalls++;
      return { v: 8 };
    }, { v: 0 });
    const repeated = await handoff.getOrLoad(async () => {
      liveCalls++;
      return { v: 9 };
    }, { v: 0 });
    assert.equal(refreshed.v, 8, 'expiry permits the normal live refresh');
    assert.equal(repeated.v, 8, 'a valid live refresh starts a new bounded TTL');
    assert.equal(liveCalls, 1, 'the retained live refresh prevents a second load');
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('hydration handoff: concurrent first live loads are one-flight', async () => {
    const handoff = harness.createHydrationHandoff<{ v: number }>(
      'unitHandoffConcurrentKey',
      (value) => ((value as { v?: unknown })?.v === 7 ? value as { v: number } : null),
    );
    let liveCalls = 0;
    let release!: (value: { v: number }) => void;
    const pending = new Promise<{ v: number }>((resolve) => { release = resolve; });
    const load = () => {
      liveCalls++;
      return pending;
    };

    const first = handoff.getOrLoad(load, { v: 0 });
    const second = handoff.getOrLoad(load, { v: 0 });
    assert.equal(liveCalls, 1);
    release({ v: 7 });
    assert.deepEqual(await first, { v: 7 });
    assert.deepEqual(await second, { v: 7 });
    assert.deepEqual(await handoff.getOrLoad(load, { v: 0 }), { v: 7 });
    assert.equal(liveCalls, 1, 'the accepted live result remains in the handoff cache');
  });

  it('hydration handoff: rejected values are not retained', async () => {
    const handoff = harness.createHydrationHandoff<{ v: number }>(
      'unitHandoffRejectedKey',
      (value) => ((value as { v?: unknown })?.v === 42 ? value as { v: number } : null),
      { ttlMs: 60_000 },
    );
    bootstrapStub({ unitHandoffRejectedKey: { v: 41 } });
    await harness.fetchBootstrapData();
    assert.equal(handoff.get(), null, 'invalid hydration is not accepted');
    assert.equal(handoff.get(), null, 'and therefore not retained');
  });

  it('mapped breaker results revive Date fields after JSON persistence', () => {
    const roundTrip = <T>(breakerName: string, value: T): T => {
      const revive = capturedBreakerOptions[breakerName]?.revivePersistedData;
      assert.ok(revive, `${breakerName} must configure revivePersistedData`);
      return revive(JSON.parse(JSON.stringify(value))) as T;
    };

    const aviation = roundTrip('Flight Delays v2', [{ updatedAt: new Date(1) }]);
    assert.ok(aviation[0]?.updatedAt instanceof Date);

    const pizzint = roundTrip('PizzINT', { lastUpdate: new Date(2) });
    assert.ok(pizzint.lastUpdate instanceof Date);

    const radiation = roundTrip('Radiation Watch', {
      fetchedAt: new Date(3),
      observations: [{ observedAt: new Date(4) }],
    });
    assert.ok(radiation.fetchedAt instanceof Date);
    assert.ok(radiation.observations[0]?.observedAt instanceof Date);

    const sanctions = roundTrip('Sanctions Pressure', {
      fetchedAt: new Date(5),
      datasetDate: new Date(6),
      entries: [{ effectiveAt: new Date(7) }, { effectiveAt: null }],
    });
    assert.ok(sanctions.fetchedAt instanceof Date);
    assert.ok(sanctions.datasetDate instanceof Date);
    assert.ok(sanctions.entries[0]?.effectiveAt instanceof Date);
    assert.equal(sanctions.entries[1]?.effectiveAt, null);

    const thermal = roundTrip('Thermal Escalation', {
      fetchedAt: new Date(8),
      clusters: [{ firstDetectedAt: new Date(9), lastDetectedAt: new Date(10) }],
    });
    assert.ok(thermal.fetchedAt instanceof Date);
    assert.ok(thermal.clusters[0]?.firstDetectedAt instanceof Date);
    assert.ok(thermal.clusters[0]?.lastDetectedAt instanceof Date);
  });

  it('persistent breaker replay updates the sanctions and radiation integration mirrors', async () => {
    const radiation = {
      fetchedAt: new Date(11),
      observations: [{ observedAt: new Date(12) }],
      coverage: { epa: 1, safecast: 0 },
      summary: {
        anomalyCount: 0, elevatedCount: 0, spikeCount: 0, corroboratedCount: 0,
        lowConfidenceCount: 0, conflictingCount: 0, convertedFromCpmCount: 0,
      },
    };
    const sanctions = {
      fetchedAt: new Date(13), datasetDate: new Date(14), totalCount: 1,
      sdnCount: 1, consolidatedCount: 0, semaCount: 0, semaError: null,
      newEntryCount: 0, vesselCount: 0, aircraftCount: 0,
      countries: [], programs: [], entries: [{ effectiveAt: new Date(15) }],
    };
    (globalThis as typeof globalThis & {
      __wmBreakerReplay: Record<string, unknown>;
    }).__wmBreakerReplay = {
      'Radiation Watch': radiation,
      'Sanctions Pressure': sanctions,
    };

    try {
      const replayedRadiation = await mirrorHarness.fetchRadiationWatch();
      const replayedSanctions = await mirrorHarness.fetchSanctionsPressure();
      assert.strictEqual(mirrorHarness.getLatestRadiationWatch(), replayedRadiation);
      assert.strictEqual(mirrorHarness.getLatestSanctionsPressure(), replayedSanctions);
    } finally {
      delete (globalThis as typeof globalThis & {
        __wmBreakerReplay?: Record<string, unknown>;
      }).__wmBreakerReplay;
    }
  });

  it('stale-while-revalidate advances sanctions and radiation integration mirrors', async () => {
    const staleRadiation = {
      fetchedAt: new Date(20), observations: [], coverage: { epa: 0, safecast: 0 },
      summary: {
        anomalyCount: 0, elevatedCount: 0, spikeCount: 0, corroboratedCount: 0,
        lowConfidenceCount: 0, conflictingCount: 0, convertedFromCpmCount: 0,
      },
    };
    const staleSanctions = {
      fetchedAt: new Date(21), datasetDate: null, totalCount: 1,
      sdnCount: 1, consolidatedCount: 0, semaCount: 0, semaError: null,
      newEntryCount: 0, vesselCount: 0, aircraftCount: 0,
      countries: [], programs: [], entries: [],
    };
    const liveRadiation = {
      fetchedAt: 22,
      observations: [{
        id: 'rad-live', source: 'RADIATION_SOURCE_EPA_RADNET', contributingSources: [],
        locationName: 'Live station', country: 'US', location: { latitude: 1, longitude: 2 },
        value: 0.1, unit: 'uSv/h', observedAt: 23, freshness: 'RADIATION_FRESHNESS_LIVE',
        baselineValue: 0.1, delta: 0, zScore: 0, severity: 'RADIATION_SEVERITY_NORMAL',
        confidence: 'RADIATION_CONFIDENCE_HIGH', corroborated: false, conflictingSources: false,
        convertedFromCpm: false, sourceCount: 1,
      }],
      epaCount: 1, safecastCount: 0, anomalyCount: 0, elevatedCount: 0, spikeCount: 0,
      corroboratedCount: 0, lowConfidenceCount: 0, conflictingCount: 0, convertedFromCpmCount: 0,
    };
    const liveSanctions = {
      entries: [{
        id: 'sdn-live', name: 'Live entry', entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY',
        countryCodes: [], countryNames: [], programs: [], sourceLists: [], effectiveAt: 24,
        isNew: false, note: '',
      }],
      countries: [], programs: [], totalCount: 2, sdnCount: 2, consolidatedCount: 0,
      semaCount: 0, semaError: '', newEntryCount: 0, vesselCount: 0, aircraftCount: 0,
      fetchedAt: 25, datasetDate: 26,
    };
    const scopedGlobal = globalThis as typeof globalThis & {
      __wmBreakerReplay: Record<string, unknown>;
      __wmBreakerRunBackground: string[];
      __wmBreakerBackgroundPromises: Promise<unknown>[];
      __wmCapturedLiveRadiation: unknown;
    };
    scopedGlobal.__wmBreakerReplay = {
      'Radiation Watch': staleRadiation,
      'Sanctions Pressure': staleSanctions,
    };
    scopedGlobal.__wmBreakerRunBackground = ['Radiation Watch', 'Sanctions Pressure'];
    scopedGlobal.__wmBreakerBackgroundPromises = [];
    scopedGlobal.__wmCapturedLiveRadiation = liveRadiation;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: { sanctionsPressure: liveSanctions },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    try {
      await mirrorHarness.fetchRadiationWatch();
      await mirrorHarness.fetchSanctionsPressure();
      await Promise.all(scopedGlobal.__wmBreakerBackgroundPromises);
      const radiationMirror = mirrorHarness.getLatestRadiationWatch() as { observations?: unknown[] };
      const sanctionsMirror = mirrorHarness.getLatestSanctionsPressure() as { totalCount?: number };
      assert.equal(radiationMirror.observations?.length, 1);
      assert.equal(sanctionsMirror.totalCount, 2);
    } finally {
      delete (scopedGlobal as Partial<typeof scopedGlobal>).__wmBreakerReplay;
      delete (scopedGlobal as Partial<typeof scopedGlobal>).__wmBreakerRunBackground;
      delete (scopedGlobal as Partial<typeof scopedGlobal>).__wmBreakerBackgroundPromises;
      delete (scopedGlobal as Partial<typeof scopedGlobal>).__wmCapturedLiveRadiation;
      globalThis.fetch = originalFetch;
    }
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
      ['src/services/thermal-escalation.ts', /breaker\.recordSuccess\(watch, cacheKey\)/],
      ['src/services/unrest/index.ts', /unrestBreaker\.recordSuccess\(hydrated\)/],
      ['src/services/economic/index.ts', /bisPolicyBreaker\.recordSuccess\(hPolicy\)/],
      ['src/services/consumer-prices/index.ts', /overviewBreaker\.recordSuccess\(hydrated,/],
    ];
    for (const [file, marker] of mustWarm) {
      const source = readFileSync(resolve(root, file), 'utf8');
      assert.match(source, marker, `${file} must warm its owner cache with accepted hydration`);
    }

    const thermalSource = readFileSync(resolve(root, 'src/services/thermal-escalation.ts'), 'utf8');
    assert.match(thermalSource, /revivePersistedData:/, 'persisted thermal Date fields must be revived');
    assert.match(thermalSource, /cacheKey,\s*\n\s*shouldCache:/, 'thermal cache identity must include maxItems');

    for (const file of [
      'src/services/aviation/index.ts',
      'src/services/pizzint.ts',
      'src/services/radiation.ts',
      'src/services/sanctions-pressure.ts',
    ]) {
      const source = readFileSync(resolve(root, file), 'utf8');
      assert.match(source, /revivePersistedData:/, `${file} must revive Date fields after JSON persistence`);
    }

    const chokepointPanel = readFileSync(resolve(root, 'src/components/ChokepointStripPanel.ts'), 'utf8');
    assert.doesNotMatch(
      chokepointPanel,
      /getHydratedData\(['"]chokepoints['"]\)/,
      'the service must be the sole owner that consumes and caches chokepoint hydration',
    );
  });
});
