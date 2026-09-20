import { listWorldBankIndicators } from '../server/worldmonitor/economic/v1/list-world-bank-indicators';
import { listCryptoQuotes } from '../server/worldmonitor/market/v1/list-crypto-quotes';
import { getPhysicalPremiums } from '../server/worldmonitor/market/v1/get-physical-premiums';
import { createInfrastructureServiceRoutes } from '../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { listInternetOutages } from '../server/worldmonitor/infrastructure/v1/list-internet-outages';
import { listClimateAnomalies } from '../server/worldmonitor/climate/v1/list-climate-anomalies';
import { createCyberServiceRoutes } from '../src/generated/server/worldmonitor/cyber/v1/service_server';
import { listCyberThreats } from '../server/worldmonitor/cyber/v1/list-cyber-threats';
import { getSectorSummary } from '../server/worldmonitor/market/v1/get-sector-summary';
import { createUnrestServiceRoutes } from '../src/generated/server/worldmonitor/unrest/v1/service_server';
import { listUnrestEvents } from '../server/worldmonitor/unrest/v1/list-unrest-events';
import { createSeismologyServiceRoutes } from '../src/generated/server/worldmonitor/seismology/v1/service_server';
import { listEarthquakes } from '../server/worldmonitor/seismology/v1/list-earthquakes';
import { listSecurityAdvisories } from '../server/worldmonitor/intelligence/v1/list-security-advisories';
import { listSatellites } from '../server/worldmonitor/intelligence/v1/list-satellites';
import { listCrossSourceSignals } from '../server/worldmonitor/intelligence/v1/list-cross-source-signals';
import { getSocialVelocity } from '../server/worldmonitor/intelligence/v1/get-social-velocity';
import { createConflictServiceRoutes } from '../src/generated/server/worldmonitor/conflict/v1/service_server';
import { getHumanitarianSummary } from '../server/worldmonitor/conflict/v1/get-humanitarian-summary';
import { getBlsSeries } from '../server/worldmonitor/economic/v1/get-bls-series';
import assert from 'node:assert/strict';
import { after, before, beforeEach, it } from 'node:test';
import { createDomainGateway, serverOptions } from '../server/gateway';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import { issueSessionToken } from '../api/_session.js';
import { createMarketServiceRoutes } from '../src/generated/server/worldmonitor/market/v1/service_server';
import { createClimateServiceRoutes } from '../src/generated/server/worldmonitor/climate/v1/service_server';
import { createEconomicServiceRoutes } from '../src/generated/server/worldmonitor/economic/v1/service_server';
import { createIntelligenceServiceRoutes } from '../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { listCryptoSectors } from '../server/worldmonitor/market/v1/list-crypto-sectors';
import { listEtfFlows } from '../server/worldmonitor/market/v1/list-etf-flows';
import { listGulfQuotes } from '../server/worldmonitor/market/v1/list-gulf-quotes';
import { listAirQualityData } from '../server/worldmonitor/climate/v1/list-air-quality-data';
import { getOilInventories } from '../server/worldmonitor/economic/v1/get-oil-inventories';
import { getPizzintStatus } from '../server/worldmonitor/intelligence/v1/get-pizzint-status';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const cache = new Map<string, unknown>();
let mode: 'hit' | 'miss' | 'http-error' | 'timeout' | 'malformed' | 'command-error' = 'miss';
let token: string;
let providerPayload: unknown;
let writes = 0;
const gateway = createDomainGateway([
  ...createInfrastructureServiceRoutes({ listInternetOutages } as never, serverOptions),
  ...createCyberServiceRoutes({ listCyberThreats } as never, serverOptions),
  ...createUnrestServiceRoutes({ listUnrestEvents } as never, serverOptions),
  ...createSeismologyServiceRoutes({ listEarthquakes } as never, serverOptions),
  ...createConflictServiceRoutes({ getHumanitarianSummary } as never, serverOptions),
  ...createMarketServiceRoutes({ listCryptoQuotes, getPhysicalPremiums, getSectorSummary, listCryptoSectors, listEtfFlows, listGulfQuotes } as never, serverOptions),
  ...createClimateServiceRoutes({ listClimateAnomalies, listAirQualityData } as never, serverOptions),
  ...createEconomicServiceRoutes({ listWorldBankIndicators, getBlsSeries, getOilInventories } as never, serverOptions),
  ...createIntelligenceServiceRoutes({ getSocialVelocity, listCrossSourceSignals, listSatellites, listSecurityAdvisories, getPizzintStatus } as never, serverOptions),
]);

before(async () => {
  process.env.WM_SESSION_SECRET = 'synthetic-cache-session-secret-at-least-32-characters';
  token = (await issueSessionToken()).token;
});
beforeEach(() => {
  cache.clear();
  writes = 0;
  providerPayload = undefined;
  mode = 'miss';
  delete process.env.LOCAL_API_MODE;
  process.env.VERCEL_ENV = 'production';
  process.env.UPSTASH_REDIS_REST_URL = 'https://cache-redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  const { fetchImpl } = createRedisFetch({});
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://api.worldbank.org') return providerPayload === undefined ? new Response('', { status: 503 }) : Response.json(providerPayload);
    assert.equal(url.origin, 'https://cache-redis.invalid');
    if (url.pathname.startsWith('/set/') || (url.pathname === '/' && typeof init?.body === 'string' && JSON.parse(init.body)[0] === 'SET')) writes++;
    if (!url.pathname.startsWith('/get/')) return fetchImpl(input, init);
    if (mode === 'command-error') return Response.json({ error: 'ERR fixture' });
    if (mode === 'http-error') return new Response('', { status: 503 });
    if (mode === 'timeout') throw new DOMException('Fixture timeout', 'TimeoutError');
    const key = decodeURIComponent(url.pathname.slice(5));
    return Response.json({ result: mode === 'malformed' ? '{invalid' : mode === 'hit' && cache.has(key) ? JSON.stringify(cache.get(key)) : null });
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function request(path: string) {
  return gateway(new Request(`https://worldmonitor.app/api/${path}`, {
    headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
  }));
}
function assertNoStore(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('CDN-Cache-Control'), null);
  assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), null);
}
const cases = [
  { path: 'market/v1/list-crypto-sectors', key: 'market:crypto-sectors:v1', payload: { sectors: [{ id: 'ai', name: 'AI', change: 1 }] }, field: 'sectors' },
  { path: 'market/v1/list-etf-flows', key: 'market:etf-flows:v1', payload: { etfs: [], timestamp: '2026-09-01T00:00:00Z', rateLimited: false }, field: 'etfs' },
  { path: 'market/v1/list-gulf-quotes', key: 'market:gulf-quotes:v1', payload: { quotes: [], rateLimited: false }, field: 'quotes' },
  { path: 'climate/v1/list-air-quality-data', key: 'climate:air-quality:v1', payload: { stations: [], fetchedAt: 123 }, field: 'stations' },
  { path: 'economic/v1/get-oil-inventories', key: 'economic:crude-inventories:v1', payload: { weeks: [{ period: '2026-09-01', stocksMb: 440 }] }, field: 'crudeWeeks' },
  { path: 'intelligence/v1/get-pizzint-status', key: 'intelligence:pizzint:seed:v1', payload: { pizzint: { locations: [], defconLevel: 5 }, tensionPairs: [] }, field: 'tensionPairs' },
];
for (const entry of cases) {
  for (const failure of ['miss', 'http-error', 'timeout', 'malformed'] as const) {
    if (entry.path.includes('pizzint') && failure === 'miss') continue;
    it(`${entry.path} keeps ${failure} out of HTTP caches and recovers on the next request`, async () => {
      mode = failure;
      const response = await request(entry.path);
      assertNoStore(response);
      const body = await response.json();
      assert.deepEqual(body[entry.field], []);
      if (entry.path.includes('etf')) assert.equal(body.timestamp, '');
      if (entry.path.includes('oil-inventories')) assert.equal(body.updatedAt, '');
      mode = 'hit';
      cache.set(entry.key, entry.payload);
      const recovered = await request(entry.path);
      assert.equal(recovered.status, 200);
      assert.match(recovered.headers.get('Cache-Control') ?? '', /^private, max-age=300(?:,|$)/);
      const recoveredBody = await recovered.json();
      if (entry.field === 'crudeWeeks') assert.equal(recoveredBody.crudeWeeks[0].stocksMb, 440);
      else if (entry.field === 'tensionPairs') assert.equal(recoveredBody.pizzint.defconLevel, 5);
      else assert.deepEqual(recoveredBody[entry.field], entry.payload[entry.field]);
    });
  }
}
it('preserves a genuine PizzINT miss as a cacheable empty response', async () => {
  const response = await request('intelligence/v1/get-pizzint-status');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Cache-Control') ?? '', /^private, max-age=300(?:,|$)/);
  assert.deepEqual(await response.json(), { tensionPairs: [] });
});
it('preserves PizzINT includeGdelt filtering on a valid seed', async () => {
  mode = 'hit';
  const payload = { pizzint: { locations: [], defconLevel: 5 }, tensionPairs: [{ pair: 'usa_china' }] };
  cache.set('intelligence:pizzint:seed:v1', payload);
  assert.deepEqual((await (await request('intelligence/v1/get-pizzint-status?include_gdelt=true')).json()).tensionPairs, payload.tensionPairs);
  assert.deepEqual((await (await request('intelligence/v1/get-pizzint-status?include_gdelt=false')).json()).tensionPairs, []);
});
for (const entry of cases.filter(entry => !entry.path.includes('pizzint'))) {
  it(`${entry.path} does not cache a missing Redis configuration`, async () => {
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    assertNoStore(await request(entry.path));
  });
}
for (const entry of cases.filter(entry => entry.path.startsWith('market/') || entry.path.startsWith('climate/'))) {
  it(`${entry.path} rejects a seed without its collection`, async () => {
    mode = 'hit';
    cache.set(entry.key, {});
    assertNoStore(await request(entry.path));
  });
}
it('preserves a valid empty crypto sector collection', async () => {
  mode = 'hit';
  cache.set('market:crypto-sectors:v1', { sectors: [] });
  const response = await request('market/v1/list-crypto-sectors');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Cache-Control') ?? '', /^private, max-age=300(?:,|$)/);
  assert.deepEqual(await response.json(), { sectors: [] });
});

it('keeps an oil mapping exception out of HTTP caches without a fresh timestamp', async () => {
  mode = 'hit';
  cache.set('economic:crude-inventories:v1', { weeks: [null] });
  const response = await request('economic/v1/get-oil-inventories');
  assertNoStore(response);
  assert.deepEqual(await response.json(), { crudeWeeks: [], natGasWeeks: [], updatedAt: '' });
});

const requiredCases = [
  ['economic/v1/get-bls-series?series_id=USPRIV', 'bls:series:USPRIV', { series: { observations: [] } }, 'series'],
  ['conflict/v1/get-humanitarian-summary?country_code=US', 'conflict:humanitarian:v1:US', { summary: { countryCode: 'US' } }, 'summary'],
  ['intelligence/v1/get-social-velocity', 'intelligence:social:reddit:v1', { posts: [], fetchedAt: 123 }, 'posts'],
  ['intelligence/v1/list-cross-source-signals', 'intelligence:cross-source-signals:v1', { signals: [] }, 'signals'],
  ['intelligence/v1/list-satellites', 'intelligence:satellites:tle:v1', { satellites: [] }, 'satellites'],
  ['intelligence/v1/list-security-advisories', 'intelligence:advisories:v1', { advisories: [] }, 'advisories'],
  ['seismology/v1/list-earthquakes', 'seismology:earthquakes:v1', { earthquakes: [] }, 'earthquakes'],
  ['unrest/v1/list-unrest-events', 'unrest:events:v1', { events: [] }, 'events'],
  ['market/v1/get-sector-summary', 'market:sectors:v2', { sectors: [] }, 'sectors'],
  ['cyber/v1/list-cyber-threats', 'cyber:threats:v2', { threats: [] }, 'threats'],
  ['climate/v1/list-climate-anomalies', 'climate:anomalies:v2', { anomalies: [] }, 'anomalies'],
  ['infrastructure/v1/list-internet-outages', 'infra:outages:v1', { outages: [] }, 'outages'],
] as const;
for (const [path, key, payload, field] of requiredCases) {
  for (const failure of ['miss', 'http-error', 'timeout', 'malformed', 'command-error', 'shape'] as const) {
    it(`${path} required seed rejects ${failure} and recovers with a healthy observation`, async () => {
      mode = failure === 'shape' ? 'hit' : failure;
      if (failure === 'shape') cache.set(key, {});
      const failed = await request(path);
      assert.equal(failed.status, 503);
      assert.equal(failed.headers.get('Cache-Control'), 'no-store');
      assert.equal(failed.headers.get('CDN-Cache-Control'), null);
      assert.equal(failed.headers.get('Vercel-CDN-Cache-Control'), null);
      mode = 'hit';
      cache.set(key, payload);
      const recovered = await request(path);
      assert.equal(recovered.status, 200);
      assert.notEqual(recovered.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual((await recovered.json())[field], payload[field]);
    });
  }
}
it('cyber proto default page size returns the default page, not one threat', async () => {
  mode = 'hit';
  cache.set('cyber:threats:v2', { threats: Array.from({ length: 3 }, (_, i) => ({ id: String(i) })) });
  const response = await request('cyber/v1/list-cyber-threats');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).threats.length, 3);
});

it('World Bank failure is 503 without cache writes and a zero-record provider response recovers', async () => {
  const path = 'economic/v1/list-world-bank-indicators?indicator_code=SP.POP.TOTL&country_code=US';
  const failed = await request(path);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('Cache-Control'), 'no-store');
  assert.equal(writes, 0);
  providerPayload = [{ total: 0 }, null];
  const recovered = await request(path);
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).data, []);
});
it('default crypto missing seed is degraded and no-store', async () => {
  const response = await request('market/v1/list-crypto-quotes');
  assertNoStore(response);
  assert.equal((await response.json()).provider, 'degraded');
});
it('physical premiums Redis error is 503 and no-store', async () => {
  mode = 'http-error';
  process.env.WORLDMONITOR_VALID_KEYS = 'cache-contract-test-key';
  const response = await gateway(new Request('https://worldmonitor.app/api/market/v1/get-physical-premiums?_debug=1', { headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': 'cache-contract-test-key' } }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

it('default crypto preserves an explicitly empty seed as healthy', async () => {
  mode = 'hit';
  cache.set('market:crypto:v1', { quotes: [] });
  const response = await request('market/v1/list-crypto-quotes');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).provider, 'seed');
  assert.notEqual(response.headers.get('Cache-Control'), 'no-store');
});

for (const [path] of requiredCases) {
  it(`${path} required seed rejects missing Redis credentials`, async () => {
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const response = await request(path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
}
for (const payload of [{}, [{ total: null }, null], [{ total: 1 }, {}]]) {
  it(`World Bank rejects malformed provider data ${JSON.stringify(payload)} without caching`, async () => {
    providerPayload = payload;
    const response = await request('economic/v1/list-world-bank-indicators?indicator_code=SP.POP.TOTL&country_code=GB');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(writes, 0);
  });
}
