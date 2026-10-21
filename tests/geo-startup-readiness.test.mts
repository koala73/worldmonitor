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
