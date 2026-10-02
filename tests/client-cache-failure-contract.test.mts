import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { build, type PluginBuild } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalNow = Date.now;
type RpcQueues = Record<string, Array<unknown | Error>>;
type RuntimeGlobals = typeof globalThis & { __clientRpcQueues?: RpcQueues; __clientHydrated?: Record<string, unknown>; __clientPersistent?: Map<string, unknown>; __clientFreshnessErrors?: Array<[string, string]>; __clientFeatureAvailable?: boolean };
const runtime = globalThis as RuntimeGlobals;

afterEach(() => {
  Date.now = originalNow;
  for (const key of ['__clientRpcQueues', '__clientHydrated', '__clientPersistent', '__clientFreshnessErrors', '__clientFeatureAvailable'] as const) delete runtime[key];
});

function serviceStubs() {
  return { name: 'client-cache-failure-runtime-stubs', setup(b: PluginBuild) {
    b.onResolve({ filter: /^@\/utils$/ }, (args) => (
      args.importer.endsWith('/src/services/consumer-prices/index.ts') || args.importer.endsWith('/src/services/cyber/index.ts')
        ? { path: resolve(root, 'src/utils/circuit-breaker.ts') }
        : undefined
    ));
    b.onResolve({ filter: /services\/generated-rpc-clients/ }, () => ({ path: 'stub:rpc', namespace: 'client-stub' }));
    b.onResolve({ filter: /services\/bootstrap$/ }, () => ({ path: 'stub:bootstrap', namespace: 'client-stub' }));
    b.onResolve({ filter: /services\/persistent-cache$/ }, () => ({ path: 'stub:persistent', namespace: 'client-stub' }));
    b.onResolve({ filter: /data-freshness$/ }, () => ({ path: 'stub:freshness', namespace: 'client-stub' }));
    b.onResolve({ filter: /runtime-config$/ }, () => ({ path: 'stub:runtime-config', namespace: 'client-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'client-stub' }, (args) => {
      if (args.path === 'stub:rpc') return { loader: 'js', contents: `
        function take(name) { const value = globalThis.__clientRpcQueues?.[name]?.shift(); if (value instanceof Error) throw value; return value; }
        export class CyberServiceClient { listCyberThreats() { return take('cyber'); } }
        export class UnrestServiceClient { listUnrestEvents() { return take('unrest'); } }
        export class ClimateServiceClient { listClimateAnomalies() { return take('climate'); } }
        export class ConsumerPricesServiceClient { getConsumerPriceOverview() { return take('consumerOverview'); } getConsumerPriceBasketSeries() { return take('consumerSeries'); } listConsumerPriceCategories() { return take('consumerCategories'); } listConsumerPriceMovers() { return take('consumerMovers'); } listRetailerPriceSpreads() { return take('consumerSpreads'); } getConsumerPriceFreshness() { return take('consumerFreshness'); } }
        export class InfrastructureServiceClient { listInternetOutages() { return take('outages'); } listServiceStatuses() { return take('statuses'); } }
        export class IntelligenceServiceClient { listSecurityAdvisories() { return take('advisories'); } listSatellites() { return take('satellites'); } }
      ` };
      if (args.path === 'stub:bootstrap') return { loader: 'js', contents: `
        export function getHydratedData(key) { return globalThis.__clientHydrated?.[key]; }
        export async function ensureHydrated(key) { const value = globalThis.__clientHydrated?.[key]; if (value instanceof Error) throw value; return value; }
      ` };
      if (args.path === 'stub:persistent') return { loader: 'js', contents: `
        export async function getPersistentCache(key) { const data = globalThis.__clientPersistent?.get(key); return data === undefined ? null : { data, updatedAt: Date.now() }; }
        export async function setPersistentCache(key, data) { globalThis.__clientPersistent?.set(key, data); }
        export async function deletePersistentCache(key) { globalThis.__clientPersistent?.delete(key); }
        export async function deletePersistentCacheByPrefix(prefix) { for (const key of globalThis.__clientPersistent?.keys() ?? []) if (key.startsWith(prefix)) globalThis.__clientPersistent.delete(key); }
      ` };
      if (args.path === 'stub:freshness') return { loader: 'js', contents: `export const dataFreshness = { recordUpdate() {}, recordError(id, error) { globalThis.__clientFreshnessErrors?.push([id, error]); } };` };
      return { loader: 'js', contents: `export function isFeatureAvailable() { return globalThis.__clientFeatureAvailable ?? true; }` };
    });
  } };
}

async function loadHarness<T>(exports: string[]): Promise<T> {
  const result = await build({ stdin: { contents: exports.join('\n'), loader: 'ts', resolveDir: root, sourcefile: 'client-cache-failure-runtime-entry.ts' }, bundle: true, define: { 'import.meta.env': '{"DEV":false}' }, format: 'esm', logLevel: 'silent', platform: 'node', target: 'node20', write: false, plugins: [serviceStubs()] });
  const source = result.outputFiles[0]?.text;
  assert.ok(source);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`) as T;
}

function setup(queues: RpcQueues = {}, hydrated: Record<string, unknown> = {}): void {
  runtime.__clientRpcQueues = queues; runtime.__clientHydrated = hydrated; runtime.__clientPersistent = new Map(); runtime.__clientFreshnessErrors = []; runtime.__clientFeatureAvailable = true;
}
async function settlePersistence(): Promise<void> { await new Promise<void>((resolveWait) => setImmediate(resolveWait)); }

describe('browser service cache failure contracts (#8348)', () => {
  it('cyber and unrest replace stale non-empty observations with confirmed healthy empty snapshots', async () => {
    let now = 1_000_000; Date.now = () => now;
    const threat = {
      id: 'c1', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_FEODO',
      indicator: '192.0.2.1', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP',
      severity: 'CRITICALITY_LEVEL_HIGH', tags: [], firstSeenAt: 0, lastSeenAt: 0,
    };
    const event = { id: 'u1', title: 'event', country: 'AE', severity: '', sourceType: '', sources: [], sourceUrls: [], tags: [], actors: [], occurredAt: 1 };
    setup({ cyber: [{ threats: [threat] }, { threats: [] }], unrest: [{ events: [event] }, { events: [] }] });
    const h = await loadHarness<{ fetchCyberThreats(): Promise<unknown[]>; fetchProtestEvents(): Promise<{ events: unknown[] }> }>(["export { fetchCyberThreats } from './src/services/cyber/index.ts';", "export { fetchProtestEvents } from './src/services/unrest/index.ts';"]);
    assert.equal((await h.fetchCyberThreats()).length, 1); assert.equal((await h.fetchProtestEvents()).events.length, 1);
    now += 11 * 60 * 1000;
    assert.equal((await h.fetchCyberThreats()).length, 1, 'stale read returns last-good while refresh runs');
    assert.equal((await h.fetchProtestEvents()).events.length, 1, 'stale read returns last-good while refresh runs');
    await settlePersistence();
    assert.deepEqual(await h.fetchCyberThreats(), []); assert.deepEqual((await h.fetchProtestEvents()).events, []);
    await settlePersistence(); assert.equal(runtime.__clientPersistent?.size, 2, 'healthy empty snapshots replace persisted non-empty data');
  });

  it('climate clears stale anomalies with healthy empty and service status distinguishes rejection', async () => {
    let now = 1_000_000; Date.now = () => now;
    const anomaly = { zone: 'Gulf', location: { latitude: 1, longitude: 2 }, severity: 'ANOMALY_SEVERITY_EXTREME', type: 'ANOMALY_TYPE_WARM' };
    setup({ climate: [{ anomalies: [anomaly] }, { anomalies: [] }], statuses: [new Error('503'), { statuses: [] }] });
    const h = await loadHarness<{ fetchClimateAnomalies(): Promise<{ ok: boolean; anomalies: unknown[] }>; fetchServiceStatuses(): Promise<{ success: boolean; services: unknown[] }> }>(["export { fetchClimateAnomalies } from './src/services/climate/index.ts';", "export { fetchServiceStatuses } from './src/services/infrastructure/index.ts';"]);
    assert.equal((await h.fetchClimateAnomalies()).anomalies.length, 1);
    now += 21 * 60 * 1000;
    assert.equal((await h.fetchClimateAnomalies()).anomalies.length, 1, 'stale read returns last-good while empty refresh runs');
    await settlePersistence();
    assert.deepEqual(await h.fetchClimateAnomalies(), { ok: true, anomalies: [] });
    const failed = await h.fetchServiceStatuses(); const recovered = await h.fetchServiceStatuses();
    assert.equal(failed.success, false); assert.equal(recovered.success, true); assert.deepEqual(recovered.services, []);
  });

  it('consumer unavailable envelopes are not persisted or replayed as success', async () => {
    setup({ consumerOverview: [{ marketCode: 'ae', asOf: '0', topCategories: [], upstreamUnavailable: true }, { marketCode: 'ae', asOf: '1', topCategories: [], upstreamUnavailable: false }] });
    const h = await loadHarness<{ fetchConsumerPriceOverview(market: string): Promise<{ asOf: string; upstreamUnavailable: boolean }> }>(["export { fetchConsumerPriceOverview } from './src/services/consumer-prices/index.ts';"]);
    const unavailable = await h.fetchConsumerPriceOverview('ae'); assert.equal(unavailable.upstreamUnavailable, true); assert.equal(runtime.__clientPersistent?.size, 0);
    const recovered = await h.fetchConsumerPriceOverview('ae'); assert.equal(recovered.upstreamUnavailable, false); assert.equal(recovered.asOf, '1');
    await settlePersistence(); assert.equal(runtime.__clientPersistent?.size, 1);
  });

  it('outages replace stale non-empty data with healthy empty and remain configured', async () => {
    let now = 1_000_000; Date.now = () => now;
    setup({ outages: [{ outages: [{ id: 'o1', title: 'Outage', link: '', description: '', country: 'AE', severity: '', categories: [] }] }, { outages: [] }] });
    const h = await loadHarness<{ fetchInternetOutages(): Promise<unknown[]>; isOutagesConfigured(): boolean | null }>(["export { fetchInternetOutages, isOutagesConfigured } from './src/services/infrastructure/index.ts';"]);
    assert.equal((await h.fetchInternetOutages()).length, 1); assert.equal(h.isOutagesConfigured(), true);
    now += 31 * 60 * 1000;
    assert.equal((await h.fetchInternetOutages()).length, 1, 'stale read returns last-good while empty refresh runs');
    await settlePersistence();
    assert.deepEqual(await h.fetchInternetOutages(), []); assert.equal(h.isOutagesConfigured(), true);
    runtime.__clientFeatureAvailable = false; assert.deepEqual(await h.fetchInternetOutages(), []); assert.equal(h.isOutagesConfigured(), false);
    runtime.__clientFeatureAvailable = true; assert.deepEqual(await h.fetchInternetOutages(), []); assert.equal(h.isOutagesConfigured(), true, 'cached healthy empty recovers configuration after re-enabling');
  });

  it('consumer hydration preserves healthy empty lists and rejects unavailable nonempty lists', async () => {
    const empty = {
      consumerPricesCategories: { categories: [], upstreamUnavailable: false },
      consumerPricesMovers: { risers: [], fallers: [], upstreamUnavailable: false },
      consumerPricesSpread: { retailers: [], upstreamUnavailable: false },
    };
    type ConsumerHarness = {
      fetchConsumerPriceCategories(): Promise<{ upstreamUnavailable: boolean }>;
      fetchConsumerPriceMovers(): Promise<{ upstreamUnavailable: boolean }>;
      fetchRetailerPriceSpreads(): Promise<{ upstreamUnavailable: boolean }>;
    };
    const exports = ["export { fetchConsumerPriceCategories, fetchConsumerPriceMovers, fetchRetailerPriceSpreads } from './src/services/consumer-prices/index.ts';"];
    setup({ consumerCategories: [new Error('503')], consumerMovers: [new Error('503')], consumerSpreads: [new Error('503')] }, empty);
    const healthy = await loadHarness<ConsumerHarness>(exports);
    for (const fetchData of [healthy.fetchConsumerPriceCategories, healthy.fetchConsumerPriceMovers, healthy.fetchRetailerPriceSpreads]) {
      assert.equal((await fetchData()).upstreamUnavailable, false);
    }
    runtime.__clientHydrated = {};
    for (const fetchData of [healthy.fetchConsumerPriceCategories, healthy.fetchConsumerPriceMovers, healthy.fetchRetailerPriceSpreads]) {
      assert.equal((await fetchData()).upstreamUnavailable, false, 'healthy empty hydration warms the exact default cache key');
    }
    setup({ consumerCategories: [new Error('503')], consumerMovers: [new Error('503')], consumerSpreads: [new Error('503')] }, {
      consumerPricesCategories: { categories: [{}], upstreamUnavailable: true },
      consumerPricesMovers: { risers: [{}], fallers: [], upstreamUnavailable: true },
      consumerPricesSpread: { retailers: [{}], upstreamUnavailable: true },
    });
    const unavailable = await loadHarness<ConsumerHarness>(exports);
    for (const fetchData of [unavailable.fetchConsumerPriceCategories, unavailable.fetchConsumerPriceMovers, unavailable.fetchRetailerPriceSpreads]) {
      assert.equal((await fetchData()).upstreamUnavailable, true);
    }
    await settlePersistence();
    assert.equal(runtime.__clientPersistent?.size, 0, 'unavailable hydration must not persist through recordSuccess');
    assert.ok(Object.values(runtime.__clientRpcQueues!).every(queue => queue.length === 0), 'unavailable hydration falls through to RPC');
  });

  it('advisories and satellites keep last-good data when refresh rejects', async () => {
    let now = 1_000_000; Date.now = () => now;
    // Records must pass shared/intelligence-snapshots.js validation: a real TLE
    // pair and an advisory index at the 100-country coverage floor.
    const byCountry = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`C${i}`, 'normal']));
    const tle = { line1: '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992', line2: '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442' };
    setup({ advisories: [{ advisories: [{ title: 'A', link: 'x', pubDate: '2026-01-01', source: 'gov', sourceCountry: 'AE', level: '', country: 'AE' }], byCountry }, new Error('503')], satellites: [{ satellites: [{ id: '25544', name: 'S', ...tle, type: 'x', country: 'AE' }] }, new Error('503')] });
    const h = await loadHarness<{ loadAdvisoriesFromServer(): Promise<{ ok: boolean; advisories: Array<{ title: string }> }>; fetchSatelliteTLEs(): Promise<Array<{ name: string }> | null>; getSatelliteStatus(): string }>(["export { loadAdvisoriesFromServer } from './src/services/security-advisories.ts';", "export { fetchSatelliteTLEs, getSatelliteStatus } from './src/services/satellites.ts';"]);
    assert.equal((await h.loadAdvisoriesFromServer()).advisories[0]?.title, 'A'); assert.equal((await h.fetchSatelliteTLEs())?.[0]?.name, 'S');
    now += 16 * 60 * 1000;
    const advisoryFailure = await h.loadAdvisoriesFromServer(); const satelliteFailure = await h.fetchSatelliteTLEs();
    assert.equal(advisoryFailure.ok, false); assert.equal(advisoryFailure.advisories[0]?.title, 'A'); assert.equal(satelliteFailure?.[0]?.name, 'S'); assert.equal(h.getSatelliteStatus(), 'degraded'); assert.equal(runtime.__clientFreshnessErrors?.length, 1);
  });

  it('IMF exposes healthy themes on a cold partial load and retries the missing theme', async () => {
    const macro = { countries: { AE: { inflationPct: 2, year: 2026 } } };
    setup({}, { imfMacro: macro, imfGrowth: { countries: [] } });
    const h = await loadHarness<{
      getImfCountryBundle(code: string): Promise<{ macro: { inflationPct: number } | null; growth: unknown; labor: unknown }>;
      getAllCountriesInflation(): Promise<Array<{ iso2: string; inflationPct: number }>>;
    }>(["export { getImfCountryBundle, getAllCountriesInflation } from './src/services/imf-country-data.ts';"]);
    const partial = await h.getImfCountryBundle('AE');
    assert.equal(partial.macro?.inflationPct, 2);
    assert.equal(partial.growth, null);
    assert.equal(partial.labor, null);
    assert.equal((await h.getAllCountriesInflation())[0]?.inflationPct, 2);
    runtime.__clientHydrated = { imfMacro: macro, imfGrowth: { countries: {} }, imfLabor: { countries: { AE: { unemploymentPct: 4 } } }, imfExternal: { countries: {} } };
    assert.deepEqual((await h.getImfCountryBundle('AE')).labor, { unemploymentPct: 4 });
  });

  it('IMF validates four public keys and retains last-good across incomplete refresh', async () => {
    let now = 1_000_000; Date.now = () => now;
    const complete = { imfMacro: { countries: { AE: { inflationPct: 2, year: 2026 } } }, imfGrowth: { countries: { AE: { realGdpGrowthPct: 3, year: 2026 } } }, imfLabor: { countries: { AE: { unemploymentPct: 4, year: 2026 } } }, imfExternal: { countries: { AE: { exportsUsd: 5, year: 2026 } } } };
    setup({}, complete);
    const h = await loadHarness<{ getImfCountryBundle(code: string): Promise<{ macro: { inflationPct: number } | null }> }>(["export { getImfCountryBundle } from './src/services/imf-country-data.ts';"]);
    assert.equal((await h.getImfCountryBundle('AE')).macro?.inflationPct, 2);
    now += 11 * 60 * 1000; runtime.__clientHydrated = { ...complete, imfGrowth: undefined };
    assert.equal((await h.getImfCountryBundle('AE')).macro?.inflationPct, 2);
  });
});
