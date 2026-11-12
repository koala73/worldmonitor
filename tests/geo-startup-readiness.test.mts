// Geolocation removed from dashboard readiness (#7778).
//
// Bundles src/utils/user-location.ts + src/services/prediction/index.ts through
// esbuild with browser-platform stubs (the pattern in
// tests/prediction-country-markets-pools.test.mts) because the modules are
// browser-side: user-location touches sessionStorage/Intl, prediction imports
// the generated RPC client, bootstrap hydration cache, and config.

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');

interface GeoFixture {
  permissionState: 'granted' | 'denied' | 'prompt' | 'missing-api' | 'rejecting-api' | 'missing-geolocation';
  position?: { lat: number; lon: number };
  positionError?: boolean;
  neverResolve?: boolean;
  timezone?: string;
  cachedCoords?: { lat: number; lon: number } | null;
  cachedRegion?: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __wmGeoStartupFixture: GeoFixture | undefined;
  // eslint-disable-next-line no-var
  var __wmPredictionStubState: { hydrated?: unknown } | undefined;
}

function installFixture(fixture: GeoFixture): { getPositionCalls: () => number } {
  let getPositionCalls = 0;
  const state = { getPositionCalls: () => getPositionCalls };

  const session = new Map<string, string>();
  if (fixture.cachedCoords) session.set('wm-geo-coords', JSON.stringify(fixture.cachedCoords));
  if (fixture.cachedRegion) session.set('wm-geo-region', fixture.cachedRegion);
  (globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string) => (session.has(k) ? session.get(k)! : null),
    setItem: (k: string, v: string) => { session.set(k, String(v)); },
    removeItem: (k: string) => { session.delete(k); },
    clear: () => session.clear(),
    get length() { return session.size; },
    key: (i: number) => [...session.keys()][i] ?? null,
  };

  const nav: Record<string, unknown> = {};
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  if (fixture.permissionState === 'missing-api') {
    nav.permissions = undefined;
  } else if (fixture.permissionState === 'rejecting-api') {
    nav.permissions = { query: async () => { throw new Error('denied'); } };
  } else {
    nav.permissions = { query: async () => ({ state: fixture.permissionState }) };
  }
  if (fixture.permissionState === 'missing-geolocation') {
    nav.geolocation = undefined;
  } else {
    nav.geolocation = {
      getCurrentPosition: (
        onSuccess: (pos: unknown) => void,
        onError: (err: unknown) => void,
      ) => {
        getPositionCalls += 1;
        if (fixture.neverResolve) return; // deliberately unresolved lookup
        if (fixture.positionError || !fixture.position) {
          queueMicrotask(() => onError(new Error('Position unavailable')));
          return;
        }
        const { lat, lon } = fixture.position;
        queueMicrotask(() => onSuccess({ coords: { latitude: lat, longitude: lon } }));
      },
    };
  }
  const tz = fixture.timezone ?? 'UTC';
  const dtf = Intl.DateTimeFormat;
  (Intl as Record<string, unknown>).DateTimeFormat = function (...args: unknown[]) {
    const fmt = new (dtf as new (...a: unknown[]) => { resolvedOptions: () => { timeZone?: string } })(...args);
    const orig = fmt.resolvedOptions.bind(fmt);
    fmt.resolvedOptions = () => ({ ...orig(), timeZone: tz });
    return fmt;
  } as unknown as typeof Intl.DateTimeFormat;

  return state;
}

async function loadUserLocation() {
  const result = await build({
    entryPoints: [resolve(root, 'src/utils/user-location.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [{
      name: 'geo-startup-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@\/services\/runtime$/ }, () => ({ path: 'runtime-stub', namespace: 'stub' }));
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export function isDesktopRuntime() { return false; }
export function toApiUrl(p) { return p; }`,
          loader: 'ts',
        }));
      },
    }],
  });
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`;
  return import(url) as Promise<typeof import('../src/utils/user-location.ts')>;
}

async function loadPredictionService() {
  const stubModules = new Map<string, string>([
    ['rpc-client-stub', `export function getRpcBaseUrl() { return 'https://example.test'; }`],
    ['config-stub', `export const SITE_VARIANT = 'full';`],
    ['utils-stub', `export function createCircuitBreaker() {
      return { execute: async (fn, fallback) => { try { return await fn(); } catch { return fallback; } } };
    }`],
    ['bootstrap-stub', `export function getHydratedData() {
      return globalThis.__wmPredictionStubState?.hydrated;
    }`],
    ['generated-rpc-clients-stub', `export class PredictionServiceClient {
      async listPredictionMarkets() { return { markets: [], dataAvailable: false }; }
    }`],
  ]);
  const aliases = new Map([
    ['@/services/rpc-client', 'rpc-client-stub'],
    ['@/config', 'config-stub'],
    ['@/utils', 'utils-stub'],
    ['@/services/bootstrap', 'bootstrap-stub'],
    ['@/services/generated-rpc-clients', 'generated-rpc-clients-stub'],
  ]);
  const result = await build({
    entryPoints: [resolve(root, 'src/services/prediction/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    loader: { '.json': 'json' },
    plugins: [{
      name: 'geo-prediction-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          const target = aliases.get(args.path);
          return target ? { path: target, namespace: 'stub' } : null;
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubModules.get(args.path),
          loader: 'ts',
        }));
      },
    }],
  });
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`;
  return import(url) as Promise<typeof import('../src/services/prediction/index.ts')>;
}

const originalDateTimeFormat = Intl.DateTimeFormat;

after(() => {
  Intl.DateTimeFormat = originalDateTimeFormat;
  delete (globalThis as Record<string, unknown>).navigator;
  delete (globalThis as Record<string, unknown>).sessionStorage;
  delete globalThis.__wmGeoStartupFixture;
  delete globalThis.__wmPredictionStubState;
});

describe('geolocation off the readiness path (#7778)', () => {
  let userLocation: Awaited<ReturnType<typeof loadUserLocation>>;

  beforeEach(async () => {
    userLocation = await loadUserLocation();
    userLocation.__resetSharedPositionRequestForTests();
  });

  it('initial region resolves synchronously without permission/position work', () => {
    installFixture({ permissionState: 'granted', neverResolve: true, timezone: 'Europe/Berlin' });
    // Berlin → eu with zero async work and zero position calls.
    assert.equal(userLocation.initialRegionFromCache(true), 'eu');
    assert.equal(userLocation.initialRegionFromCache(false), 'global');
  });

  it('usable cached region wins; cached coords derive; failures stay global', () => {
    installFixture({ permissionState: 'denied', cachedRegion: 'asia', timezone: 'Europe/Berlin' });
    assert.equal(userLocation.initialRegionFromCache(true), 'asia');

    installFixture({ permissionState: 'denied', cachedCoords: { lat: 35.7, lon: 139.7 }, timezone: 'Europe/Berlin' });
    assert.equal(userLocation.initialRegionFromCache(true), 'asia');

    installFixture({ permissionState: 'denied', timezone: 'UTC' });
    assert.equal(userLocation.initialRegionFromCache(true), 'global');
  });

  it('cached coords on both Mediterranean shores resolve to their own continent', () => {
    // The Africa and Europe boxes overlap across 35-40°N; neither shore may take the other's region.
    const cases: Array<[string, number, number, string]> = [
      ['Lisbon', 38.72, -9.14, 'eu'],
      ['Seville', 37.39, -5.98, 'eu'],
      ['Málaga', 36.72, -4.42, 'eu'],
      ['Gibraltar', 36.14, -5.35, 'eu'],
      ['Cagliari', 39.22, 9.11, 'eu'],
      ['Palermo', 38.12, 13.36, 'eu'],
      ['Valletta', 35.90, 14.51, 'eu'],
      ['Athens', 37.98, 23.73, 'eu'],
      ['Tangier', 35.77, -5.80, 'africa'],
      ['Oran', 35.70, -0.63, 'africa'],
      ['Algiers', 36.75, 3.06, 'africa'],
      ['Tabarka', 36.95, 8.76, 'africa'],
      ['Sidi Mechreg', 37.17, 9.13, 'africa'],
      ['Cape Serrat', 37.22, 9.22, 'africa'],
      ['La Galite', 37.53, 8.93, 'africa'],
      ['Bizerte', 37.27, 9.87, 'africa'],
      ['Tunis', 36.81, 10.18, 'africa'],
      ['Tripoli', 32.89, 13.19, 'africa'],
    ];
    for (const [city, lat, lon, region] of cases) {
      installFixture({ permissionState: 'denied', cachedCoords: { lat, lon }, timezone: 'UTC' });
      assert.equal(userLocation.initialRegionFromCache(true), region, city);
    }
  });

  it('one in-flight position request is shared between region and precise consumers', async () => {
    const calls = installFixture({
      permissionState: 'granted',
      position: { lat: 40.7, lon: -74 },
      timezone: 'Europe/Berlin',
    });
    const [region, coords] = await Promise.all([
      userLocation.resolveUserRegion(),
      userLocation.resolvePreciseUserCoordinates(5000),
    ]);
    assert.equal(region, 'america');
    assert.deepEqual(coords, { lat: 40.7, lon: -74 });
    assert.equal(calls.getPositionCalls(), 1);
  });

  it('readiness completes while a granted lookup stays unresolved; failure keeps the fallback', async () => {
    installFixture({ permissionState: 'granted', neverResolve: true, timezone: 'Europe/Berlin' });
    // Synchronous seed — this is the value layout uses; it must not await.
    assert.equal(userLocation.initialRegionFromCache(true), 'eu');

    installFixture({ permissionState: 'granted', positionError: true, timezone: 'Europe/Berlin' });
    userLocation.__resetSharedPositionRequestForTests();
    assert.equal(await userLocation.resolveUserRegion(), 'eu');
    assert.equal(await userLocation.resolvePreciseUserCoordinates(5000), null);
  });

  it('denied / prompt / missing geolocation / rejecting permissions API never prompt and fall back', async () => {
    for (const permissionState of ['denied', 'prompt', 'missing-geolocation', 'missing-api', 'rejecting-api'] as const) {
      installFixture({ permissionState, timezone: 'Europe/Berlin' });
      userLocation.__resetSharedPositionRequestForTests();
      assert.equal(await userLocation.resolveUserRegion(), 'eu', `region for ${permissionState}`);
      assert.equal(await userLocation.resolvePreciseUserCoordinates(5000), null, `coords for ${permissionState}`);
    }
  });

  it('cached-region-only and cached-coordinate-only cases skip position work', async () => {
    const cached = installFixture({
      permissionState: 'granted',
      neverResolve: true,
      cachedRegion: 'mena',
      timezone: 'Europe/Berlin',
    });
    assert.equal(await userLocation.resolveUserRegion(), 'mena');
    assert.equal(cached.getPositionCalls(), 0);

    const coordOnly = installFixture({
      permissionState: 'granted',
      neverResolve: true,
      cachedCoords: { lat: 48.8, lon: 2.35 },
      timezone: 'America/New_York',
    });
    userLocation.__resetSharedPositionRequestForTests();
    assert.equal(await userLocation.resolveUserRegion(), 'eu');
    assert.equal(coordOnly.getPositionCalls(), 0);
  });

  it('late-region re-ranking matches fetch-time ranking without another fetch', async () => {
    const prediction = await loadPredictionService();
    const markets = [
      { title: 'US election odds shift', yesPrice: 55, regions: ['america'] },
      { title: 'Global markets steady', yesPrice: 50 },
      { title: 'Germany coalition talks', yesPrice: 60, regions: ['eu'] },
    ];
    const fetchTime = prediction.reprioritizeMarketsForRegion(markets, 'eu', 15);
    assert.deepEqual(fetchTime.map((m) => m.title), [
      'Germany coalition talks',
      'US election odds shift',
      'Global markets steady',
    ]);
    // Stable within partitions: base relevance order preserved.
    const rerank = prediction.reprioritizeMarketsForRegion(markets, 'america', 15);
    assert.deepEqual(rerank.map((m) => m.title), [
      'US election odds shift',
      'Global markets steady',
      'Germany coalition talks',
    ]);
    assert.deepEqual(prediction.reprioritizeMarketsForRegion(markets, 'global', 15), markets);
  });

  it('retained candidate pool promotes region matches hidden below the display slice', async () => {
    const prediction = await loadPredictionService();
    // 16 non-matching markets fill the display slice; the region match sits at
    // position 17 of the 25-candidate pool — invisible to a re-rank of the
    // truncated 15, promotable from the retained pool.
    const pool = Array.from({ length: 16 }, (_, i) => ({ title: `Global market ${i}`, yesPrice: 50 }));
    pool.push({ title: 'Germany coalition talks', yesPrice: 60, regions: ['eu'] });
    for (let i = 0; i < 8; i++) pool.push({ title: `Global tail ${i}`, yesPrice: 50 });
    assert.equal(pool.length, 25);

    const displayed = pool.slice(0, 15);
    assert.ok(!displayed.some((m) => m.regions?.includes('eu')));

    const rerankedTruncated = prediction.reprioritizeMarketsForRegion(displayed, 'eu', 15);
    assert.ok(!rerankedTruncated.some((m) => m.regions?.includes('eu')));

    const rerankedPool = prediction.reprioritizeMarketsForRegion(
      prediction.predictionCandidatePool(pool), 'eu', 15,
    );
    assert.equal(rerankedPool[0]?.title, 'Germany coalition talks');
  });
});

describe('user region classification: coordinates and timezone agree on every continent', () => {
  let userLocation: Awaited<ReturnType<typeof loadUserLocation>>;

  beforeEach(async () => {
    userLocation = await loadUserLocation();
  });

  // [place, lat, lon, IANA zone, region]. Regions follow shared/iso2-to-region.json
  // with the map views' choices: Mexico is 'america', the Caribbean and Central
  // America 'latam', Turkey and the Caucasus 'mena', Egypt 'mena' and the Maghreb
  // 'africa', Central Asia and Siberia 'asia'.
  const places: Array<[string, number, number, string, string]> = [
    ['Lisbon', 38.72, -9.14, 'Europe/Lisbon', 'eu'],
    ['Madrid', 40.42, -3.70, 'Europe/Madrid', 'eu'],
    ['Athens', 37.98, 23.73, 'Europe/Athens', 'eu'],
    ['Thessaloniki', 40.64, 22.94, 'Europe/Athens', 'eu'],
    ['Alexandroupoli', 40.85, 25.87, 'Europe/Athens', 'eu'],
    ['Heraklion', 35.34, 25.13, 'Europe/Athens', 'eu'],
    ['Rhodes', 36.43, 28.22, 'Europe/Athens', 'eu'],
    ['Kos', 36.89, 27.29, 'Europe/Athens', 'eu'],
    ['Mytilene', 39.10, 26.55, 'Europe/Athens', 'eu'],
    ['Bucharest', 44.43, 26.10, 'Europe/Bucharest', 'eu'],
    ['Constanța', 44.17, 28.63, 'Europe/Bucharest', 'eu'],
    ['Varna', 43.21, 27.91, 'Europe/Sofia', 'eu'],
    ['Burgas', 42.50, 27.47, 'Europe/Sofia', 'eu'],
    ['Sevastopol', 44.62, 33.53, 'Europe/Simferopol', 'eu'],
    ['Sochi', 43.60, 39.73, 'Europe/Moscow', 'eu'],
    ['Vladikavkaz', 43.02, 44.68, 'Europe/Moscow', 'eu'],
    ['Makhachkala', 42.98, 47.50, 'Europe/Moscow', 'eu'],
    ['Astrakhan', 46.35, 48.04, 'Europe/Astrakhan', 'eu'],
    ['Kazan', 55.79, 49.12, 'Europe/Moscow', 'eu'],
    ['Moscow', 55.76, 37.62, 'Europe/Moscow', 'eu'],
    ['Kyiv', 50.45, 30.52, 'Europe/Kyiv', 'eu'],
    ['Nicosia', 35.17, 33.36, 'Asia/Nicosia', 'eu'],
    ['Limassol', 34.68, 33.04, 'Asia/Nicosia', 'eu'],
    ['Paphos', 34.77, 32.42, 'Asia/Nicosia', 'eu'],
    ['Patmos', 37.31, 26.55, 'Europe/Athens', 'eu'],
    ['Agathonisi', 37.46, 26.97, 'Europe/Athens', 'eu'],
    ['Reykjavik', 64.15, -21.94, 'Atlantic/Reykjavik', 'eu'],
    ['Ponta Delgada', 37.74, -25.67, 'Atlantic/Azores', 'eu'],
    ['Funchal', 32.65, -16.91, 'Atlantic/Madeira', 'eu'],
    ['Las Palmas', 28.12, -15.43, 'Atlantic/Canary', 'eu'],
    ['Longyearbyen', 78.22, 15.65, 'Arctic/Longyearbyen', 'eu'],
    ['Istanbul', 41.01, 28.98, 'Europe/Istanbul', 'mena'],
    ['Edirne', 41.68, 26.56, 'Europe/Istanbul', 'mena'],
    ['Izmir', 38.42, 27.14, 'Europe/Istanbul', 'mena'],
    ['Bodrum', 37.03, 27.43, 'Europe/Istanbul', 'mena'],
    ['Marmaris', 36.85, 28.27, 'Europe/Istanbul', 'mena'],
    ['Trabzon', 41.00, 39.72, 'Europe/Istanbul', 'mena'],
    ['Tbilisi', 41.72, 44.79, 'Asia/Tbilisi', 'mena'],
    ['Baku', 40.41, 49.87, 'Asia/Baku', 'mena'],
    ['Cairo', 30.04, 31.24, 'Africa/Cairo', 'mena'],
    ['Jeddah', 21.49, 39.19, 'Asia/Riyadh', 'mena'],
    ["Sana'a", 15.37, 44.19, 'Asia/Aden', 'mena'],
    ['Southern Socotra', 12.35, 54.0, 'Asia/Aden', 'mena'],
    ['Didim', 37.37, 27.27, 'Europe/Istanbul', 'mena'],
    ['Dubai', 25.20, 55.27, 'Asia/Dubai', 'mena'],
    ['Tehran', 35.69, 51.39, 'Asia/Tehran', 'mena'],
    ['Mashhad', 36.30, 59.60, 'Asia/Tehran', 'mena'],
    ['Tel Aviv', 32.08, 34.78, 'Asia/Jerusalem', 'mena'],
    ['Khartoum', 15.50, 32.56, 'Africa/Khartoum', 'africa'],
    ['Port Sudan', 19.62, 37.22, 'Africa/Khartoum', 'africa'],
    ['Asmara', 15.32, 38.93, 'Africa/Asmara', 'africa'],
    ['Djibouti', 11.59, 43.15, 'Africa/Djibouti', 'africa'],
    ['Tunis', 36.81, 10.18, 'Africa/Tunis', 'africa'],
    ['Algiers', 36.75, 3.06, 'Africa/Algiers', 'africa'],
    ['Casablanca', 33.57, -7.59, 'Africa/Casablanca', 'africa'],
    ['Lagos', 6.52, 3.38, 'Africa/Lagos', 'africa'],
    ['Nairobi', -1.29, 36.82, 'Africa/Nairobi', 'africa'],
    ['Cape Town', -33.92, 18.42, 'Africa/Johannesburg', 'africa'],
    ['Praia', 14.93, -23.51, 'Atlantic/Cape_Verde', 'africa'],
    ['Antananarivo', -18.88, 47.51, 'Indian/Antananarivo', 'africa'],
    ['Port Louis', -20.16, 57.50, 'Indian/Mauritius', 'africa'],
    ['Atyrau', 47.11, 51.92, 'Asia/Atyrau', 'asia'],
    ['Ashgabat', 37.95, 58.38, 'Asia/Ashgabat', 'asia'],
    ['Tashkent', 41.30, 69.24, 'Asia/Tashkent', 'asia'],
    ['Almaty', 43.24, 76.89, 'Asia/Almaty', 'asia'],
    ['Karachi', 24.86, 67.01, 'Asia/Karachi', 'asia'],
    ['Kabul', 34.53, 69.17, 'Asia/Kabul', 'asia'],
    ['Delhi', 28.61, 77.21, 'Asia/Kolkata', 'asia'],
    ['Bangalore', 12.97, 77.59, 'Asia/Kolkata', 'asia'],
    ['Chennai', 13.08, 80.27, 'Asia/Kolkata', 'asia'],
    ['Kochi', 9.93, 76.27, 'Asia/Kolkata', 'asia'],
    ['Colombo', 6.93, 79.86, 'Asia/Colombo', 'asia'],
    ['Malé', 4.18, 73.51, 'Indian/Maldives', 'asia'],
    ['Dhaka', 23.81, 90.41, 'Asia/Dhaka', 'asia'],
    ['Bangkok', 13.76, 100.50, 'Asia/Bangkok', 'asia'],
    ['Ho Chi Minh City', 10.82, 106.63, 'Asia/Ho_Chi_Minh', 'asia'],
    ['Manila', 14.60, 120.98, 'Asia/Manila', 'asia'],
    ['Kuala Lumpur', 3.14, 101.69, 'Asia/Kuala_Lumpur', 'asia'],
    ['Singapore', 1.35, 103.82, 'Asia/Singapore', 'asia'],
    ['Jakarta', -6.21, 106.85, 'Asia/Jakarta', 'asia'],
    ['Denpasar', -8.65, 115.22, 'Asia/Makassar', 'asia'],
    ['Jayapura', -2.53, 140.72, 'Asia/Jayapura', 'asia'],
    ['Tokyo', 35.68, 139.69, 'Asia/Tokyo', 'asia'],
    ['Vladivostok', 43.12, 131.89, 'Asia/Vladivostok', 'asia'],
    ['Magadan', 59.56, 150.80, 'Asia/Magadan', 'asia'],
    ['Yekaterinburg', 56.84, 60.61, 'Asia/Yekaterinburg', 'asia'],
    ['Sydney', -33.87, 151.21, 'Australia/Sydney', 'oceania'],
    ['Darwin', -12.46, 130.84, 'Australia/Darwin', 'oceania'],
    ['Auckland', -36.85, 174.76, 'Pacific/Auckland', 'oceania'],
    ['Port Moresby', -9.44, 147.18, 'Pacific/Port_Moresby', 'oceania'],
    ['Hagåtña', 13.44, 144.79, 'Pacific/Guam', 'oceania'],
    ['Suva', -18.14, 178.44, 'Pacific/Fiji', 'oceania'],
    ['Papeete', -17.54, -149.57, 'Pacific/Tahiti', 'oceania'],
    ['Apia', -13.83, -171.76, 'Pacific/Apia', 'oceania'],
    ['Honolulu', 21.31, -157.86, 'Pacific/Honolulu', 'america'],
    ['Anchorage', 61.22, -149.90, 'America/Anchorage', 'america'],
    ['New York', 40.71, -74.01, 'America/New_York', 'america'],
    ['Indianapolis', 39.77, -86.16, 'America/Indiana/Indianapolis', 'america'],
    ['Key West', 24.56, -81.78, 'America/New_York', 'america'],
    ['Miami', 25.76, -80.19, 'America/New_York', 'america'],
    ['Toronto', 43.65, -79.38, 'America/Toronto', 'america'],
    ['Mexico City', 19.43, -99.13, 'America/Mexico_City', 'america'],
    ['Cancún', 21.16, -86.85, 'America/Cancun', 'america'],
    ['Chetumal', 18.50, -88.30, 'America/Cancun', 'america'],
    ['Xcalak', 18.27, -87.83, 'America/Cancun', 'america'],
    ['Tapachula', 14.90, -92.26, 'America/Mexico_City', 'america'],
    ['Nuuk', 64.18, -51.72, 'America/Nuuk', 'america'],
    ['Tasiilaq', 65.61, -37.64, 'America/Nuuk', 'america'],
    ['Guatemala City', 14.63, -90.51, 'America/Guatemala', 'latam'],
    ['Flores', 16.93, -89.89, 'America/Guatemala', 'latam'],
    ['Belize City', 17.50, -88.20, 'America/Belize', 'latam'],
    ['Corozal', 18.39, -88.39, 'America/Belize', 'latam'],
    ['Orange Walk', 18.08, -88.56, 'America/Belize', 'latam'],
    ['San Pedro (Ambergris Caye)', 17.92, -87.96, 'America/Belize', 'latam'],
    ['Roatán', 16.33, -86.53, 'America/Tegucigalpa', 'latam'],
    ['Jizan', 16.90, 42.57, 'Asia/Riyadh', 'mena'],
    ['Timbuktu', 16.77, -3.01, 'Africa/Bamako', 'africa'],
    ['Hyderabad', 17.38, 78.49, 'Asia/Kolkata', 'asia'],
    ['Hue', 16.46, 107.59, 'Asia/Ho_Chi_Minh', 'asia'],
    ['San Pedro Sula', 15.50, -88.03, 'America/Tegucigalpa', 'latam'],
    ['Havana', 23.11, -82.37, 'America/Havana', 'latam'],
    ['Nassau', 25.05, -77.35, 'America/Nassau', 'latam'],
    ['San Juan', 18.47, -66.11, 'America/Puerto_Rico', 'latam'],
    ['Bogotá', 4.71, -74.07, 'America/Bogota', 'latam'],
    ['São Paulo', -23.55, -46.63, 'America/Sao_Paulo', 'latam'],
    ['Buenos Aires', -34.60, -58.38, 'America/Argentina/Buenos_Aires', 'latam'],
    ['Santiago', -33.45, -70.67, 'America/Santiago', 'latam'],
    ['Puerto Ayora', -0.74, -90.31, 'Pacific/Galapagos', 'latam'],
    ['Hanga Roa', -27.15, -109.43, 'Pacific/Easter', 'latam'],
    ['Stanley', -51.70, -57.85, 'Atlantic/Stanley', 'latam'],
  ];

  it('coordinates resolve each place to its region', () => {
    const wrong = places
      .map(([place, lat, lon, , region]) => [place, region, userLocation.coordsToRegion(lat, lon)])
      .filter(([, want, got]) => want !== got);
    assert.deepEqual(wrong, []);
  });

  it('the timezone resolves each place to the same region', () => {
    const wrong = places
      .map(([place, , , tz, region]) => [place, tz, region, userLocation.timezoneToRegion(tz)])
      .filter(([, , want, got]) => want !== got);
    assert.deepEqual(wrong, []);
  });

  it('a visitor without location permission gets the region from the timezone', () => {
    for (const [tz, region] of [['Asia/Kolkata', 'asia'], ['America/Sao_Paulo', 'latam'], ['Asia/Bangkok', 'asia']]) {
      installFixture({ permissionState: 'prompt', timezone: tz });
      assert.equal(userLocation.initialRegionFromCache(true), region, tz);
    }
  });

  it('zones with no region stay global', () => {
    for (const tz of ['UTC', 'Etc/GMT+3', 'Antarctica/McMurdo', 'Atlantic/Nowhere']) {
      assert.equal(userLocation.timezoneToRegion(tz), null, tz);
    }
    assert.equal(userLocation.coordsToRegion(-75, 0), 'global');
  });
});
