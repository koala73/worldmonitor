import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { issueSessionToken } from '../api/_session.js';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { createEconomicServiceRoutes, type EconomicServiceHandler } from '../src/generated/server/worldmonitor/economic/v1/service_server.ts';
import { createIntelligenceServiceRoutes, type IntelligenceServiceHandler } from '../src/generated/server/worldmonitor/intelligence/v1/service_server.ts';
import { getFredSeries } from '../server/worldmonitor/economic/v1/get-fred-series.ts';
import { getGdeltTopicTimeline } from '../server/worldmonitor/intelligence/v1/get-gdelt-topic-timeline.ts';
import { getCountryEnergyProfile } from '../server/worldmonitor/intelligence/v1/get-country-energy-profile.ts';
import { sidecarCacheSet } from '../server/_shared/sidecar-cache.ts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const redisUrl = 'https://redis.example.test';
const fredPath = '/api/economic/v1/get-fred-series';
const gdeltPath = '/api/intelligence/v1/get-gdelt-topic-timeline';
const energyPath = '/api/intelligence/v1/get-country-energy-profile';
let token: string;

beforeEach(async () => {
  delete process.env.LOCAL_API_MODE;
  delete process.env.VERCEL_ENV;
  process.env.UPSTASH_REDIS_REST_URL = redisUrl;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.WM_SESSION_SECRET = 'cache-boundary-session-secret-at-least-32';
  token = (await issueSessionToken()).token;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

const gateway = createDomainGateway([
  ...createEconomicServiceRoutes({ getFredSeries } as EconomicServiceHandler, serverOptions)
    .filter(route => route.path === fredPath),
  ...createIntelligenceServiceRoutes({ getGdeltTopicTimeline, getCountryEnergyProfile } as IntelligenceServiceHandler, serverOptions)
    .filter(route => [gdeltPath, energyPath].includes(route.path)),
]);

function request(path: string): Promise<Response> {
  return gateway(new Request(`https://worldmonitor.app${path}`, {
    headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
  }));
}

function redisStub(read: (key: string) => unknown | Promise<unknown>): string[] {
  const keys: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.ok(url.startsWith(`${redisUrl}/get/`), `unexpected request: ${url}`);
    const key = decodeURIComponent(url.slice(`${redisUrl}/get/`.length));
    keys.push(key);
    const value = await read(key);
    if (value instanceof Response) return value;
    return Response.json({ result: value == null ? null : JSON.stringify(value) });
  }) as typeof fetch;
  return keys;
}

function assertNoStore(response: Response): void {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('CDN-Cache-Control'), null);
  assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), null);
}

it('rejects unsupported, delimiter, encoded-delimiter and oversized FRED IDs before Redis', async () => {
  const keys = redisStub(() => null);
  for (const seriesId of ['PRIVATE', 'GDP:private', 'GDP%3Aprivate', 'x'.repeat(2048)]) {
    const response = await request(`${fredPath}?series_id=${encodeURIComponent(seriesId)}`);
    assert.equal(response.status, 400, seriesId);
    assertNoStore(response);
  }
  assert.deepEqual(keys, []);
});

it('normalizes supported FRED IDs and retains the observation limit', async () => {
  const keys = redisStub(() => ({ series: {
    seriesId: 'GDP', observations: [{ date: '2026-01-01', value: 1 }, { date: '2026-04-01', value: 2 }],
  } }));
  const response = await request(`${fredPath}?series_id=%20gdp%20&limit=1`);
  assert.equal(response.status, 200);
  assert.deepEqual(keys, ['economic:fred:v1:GDP:0']);
  assert.deepEqual((await response.json()).series.observations, [{ date: '2026-04-01', value: 2 }]);
});

it('does not cache an unavailable FRED seed for an hour', async () => {
  for (const value of [null, new Response('unavailable', { status: 503 })]) {
    redisStub(() => value);
    const response = await request(`${fredPath}?series_id=GDP`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
    assertNoStore(response);
  }
});

const failures = {
  http: () => new Response('unavailable', { status: 503 }),
  command: () => Response.json({ error: 'Redis unavailable' }),
  network: () => { throw new TypeError('fetch failed'); },
  timeout: () => { throw new DOMException('deadline exceeded', 'TimeoutError'); },
  malformed: () => Response.json({ result: 'not json' }),
};

for (const [name, fail] of Object.entries(failures)) {
  it(`reports GDELT Redis ${name} failures as unavailable and recovers`, async () => {
    redisStub(fail);
    const failed = await request(`${gdeltPath}?topic=military`);
    assert.equal(failed.status, 200);
    assert.equal((await failed.json()).error, 'unavailable');
    assertNoStore(failed);

    redisStub(() => ({ data: [], fetchedAt: '2026-09-13T00:00:00Z' }));
    const recovered = await request(`${gdeltPath}?topic=military`);
    assert.equal((await recovered.json()).error, '');
    assert.notEqual(recovered.headers.get('Cache-Control'), 'no-store');
  });

  it(`reports energy Redis ${name} failures as HTTP 503`, async () => {
    redisStub(fail);
    const response = await request(`${energyPath}?country_code=DE`);
    assert.equal(response.status, 503);
    assertNoStore(response);
  });
}

it('preserves genuine Redis misses for GDELT and energy', async () => {
  redisStub(() => null);
  const gdelt = await request(`${gdeltPath}?topic=military`);
  assert.equal(gdelt.status, 200);
  assert.equal((await gdelt.json()).error, '');
  const energy = await request(`${energyPath}?country_code=DE`);
  assert.equal(energy.status, 200);
  const body = await energy.json();
  assert.equal(body.mixAvailable, false);
  assert.equal(body.jodiOilAvailable, false);
});

it('does not hide failures in legacy energy or direct Ember fallback reads', async () => {
  for (const failedPrefix of ['energy:jodi-oil:', 'energy:ember:']) {
    const keys = redisStub(key => {
      if (key.startsWith(failedPrefix)) return new Response('down', { status: 503 });
      if (failedPrefix.includes('ember') && key.startsWith('energy:spine:')) {
        return { coverage: { hasMix: true }, sources: { mixYear: 2025 }, mix: { coalShare: 10 } };
      }
      return null;
    });
    const response = await request(`${energyPath}?country_code=DE`);
    assert.ok(keys.some(key => key.startsWith(failedPrefix)));
    assert.equal(response.status, 503);
    assertNoStore(response);
  }
});

it('does not report a partly failed primary energy read as complete', async () => {
  redisStub(key => key.startsWith('energy:spine:')
    ? { coverage: { hasMix: true }, sources: { mixYear: 2025 }, mix: { coalShare: 10 } }
    : key.startsWith('energy:gas-storage:') ? new Response('down', { status: 503 }) : null);
  const response = await request(`${energyPath}?country_code=DE`);
  assert.equal(response.status, 503);
  assertNoStore(response);
});

it('reads a seeded energy spine and direct Ember fallback without a deployment prefix', async () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_SHA = '12345678';
  const keys = redisStub(key => {
    if (key === 'energy:spine:v1:DE') return {
      _seed: { schemaVersion: 1, fetchedAt: Date.parse('2026-09-13T00:00:00Z'), recordCount: 1, sourceVersion: 'test', state: 'OK' },
      data: { coverage: { hasMix: true }, sources: { mixYear: 2025 }, mix: { coalShare: 10 } },
    };
    if (key === 'energy:ember:v1:DE') return { fossilShare: 25, dataMonth: '2026-06' };
    if (key === 'energy:gas-storage:v1:DE') return { fillPct: 80, date: '2026-09-13' };
    return null;
  });
  const response = await request(`${energyPath}?country_code=de`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mixAvailable, true);
  assert.equal(body.coalShare, 10);
  assert.equal(body.emberFossilShare, 25);
  assert.equal(body.gasStorageFillPct, 80);
  assert.ok(keys.every(key => !key.startsWith('preview:')));
  assert.ok(!keys.some(key => key.startsWith('energy:jodi-oil:')), 'usable spine bypasses legacy reads');
});

it('preserves local sidecar FRED, GDELT, and energy reads', async () => {
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const keys = redisStub(() => assert.fail('sidecar must not use remote Redis'));
  sidecarCacheSet('economic:fred:v1:ESTR:0', { series: { seriesId: 'ESTR', observations: [] } }, 60);
  sidecarCacheSet('gdelt:intel:tone:cyber', { data: [{ date: '2026-09-13', value: 1 }], fetchedAt: '2026-09-13' }, 60);
  sidecarCacheSet('energy:mix:v1:FR', { year: 2025, nuclearShare: 70 }, 60);
  const ctx = { request: new Request('https://worldmonitor.app'), pathParams: {}, headers: {} };
  assert.equal((await getFredSeries(ctx, { seriesId: 'estr', limit: 1 })).series?.seriesId, 'ESTR');
  assert.equal((await getGdeltTopicTimeline(ctx, { topic: 'cyber' })).tone.length, 1);
  assert.equal((await getCountryEnergyProfile(ctx, { countryCode: 'FR' })).nuclearShare, 70);
  assert.deepEqual(keys, []);
});

it('reports missing Redis configuration as unavailable, not an observed empty seed', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const gdelt = await request(`${gdeltPath}?topic=military`);
  assert.equal((await gdelt.json()).error, 'unavailable');
  assertNoStore(gdelt);
  const energy = await request(`${energyPath}?country_code=DE`);
  assert.equal(energy.status, 503);
  assertNoStore(energy);
});

it('retains partial energy coverage and observed zero measurements after recovery', async () => {
  redisStub(key => key.startsWith('energy:jodi-oil:')
    ? { dataMonth: '2026-06', crude: { importsKbd: 0 } } : null);
  const response = await request(`${energyPath}?country_code=DE`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.jodiOilAvailable, true);
  assert.equal(body.crudeImportsKbd, 0);
  assert.deepEqual(body.jodiOilObservedMeasurements, ['crude.importsKbd']);
  assert.equal(body.mixAvailable, false);
});
