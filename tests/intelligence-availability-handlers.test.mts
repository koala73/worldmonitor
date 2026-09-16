import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { listSatellites } from '../server/worldmonitor/intelligence/v1/list-satellites';
import { listSecurityAdvisories } from '../server/worldmonitor/intelligence/v1/list-security-advisories';
import { searchGdeltDocuments } from '../server/worldmonitor/intelligence/v1/search-gdelt-documents';
import { INTEL_TOPIC_IDS, MIN_ADVISORY_COUNTRY_COVERAGE } from '../shared/intelligence-snapshots.js';

const satellite = { id: '25544', name: 'ISS', country: 'US', type: 'station', line1: '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992', line2: '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442' };
const advisory = { title: 'Travel update', link: 'https://example.com/advice', pubDate: '2026-09-15T00:00:00Z', source: 'FCDO', sourceCountry: 'UK', level: 'caution', country: 'UA' };
const article = { title: 'Military exercise', url: 'https://example.com/news', source: 'example.com', date: '20260915T000000Z', image: '', language: 'English', tone: 0 };
const coveredByCountry = Object.fromEntries(Array.from({ length: MIN_ADVISORY_COUNTRY_COVERAGE }, (_, i) => [
  `C${String(i).padStart(3, '0')}`,
  i === 0 ? 'caution' : 'normal',
]));
const gdeltTopics = (articlesById: Record<string, typeof article[]> = {}) => ({
  topics: INTEL_TOPIC_IDS.map(id => ({ id, articles: articlesById[id] ?? [] })),
});

for (const [name, call, empty, present, malformed] of [
  ['satellites', () => listSatellites({} as never, { country: '' }), { satellites: [] }, { satellites: [satellite] }, { satellites: [null] }],
  ['advisories', () => listSecurityAdvisories({} as never, {}), { advisories: [], byCountry: {} }, { advisories: [advisory], byCountry: coveredByCountry }, { advisories: [{ ...advisory, pubDate: 'bad' }], byCountry: {} }],
] as const) {
  test(`${name}: empty/hit succeed; miss, malformed and Redis failure are unavailable; repaired seed recovers`, async t => {
    let value: unknown = null;
    let failure = false;
    t.mock.method(globalThis, 'fetch', async () => failure ? new Response('', { status: 503 }) : Response.json({ result: value === null ? null : JSON.stringify(value) }));
    for (const invalid of [null, {}, malformed, { ...present, fallback: true }, ...(name === 'satellites' ? [{ satellites: [{ ...satellite, line1: 'broken' }] }] : [{ advisories: [advisory], byCountry: { UA: 'caution' } }])]) {
      value = invalid;
      await assert.rejects(call, (e: any) => e.statusCode === 503);
    }
    failure = true;
    await assert.rejects(call, (e: any) => e.statusCode === 503);
    failure = false;
    value = empty;
    assert.deepEqual(await call(), empty);
    value = present;
    const response = await call();
    assert.equal(name === 'satellites' ? (response as any).satellites.length : (response as any).advisories.length, 1);
  });
}

test('GDELT topics distinguish empty matches from unavailable or malformed seed and read errors', async t => {
  let value: unknown = null;
  let failure = false;
  t.mock.method(globalThis, 'fetch', async () => failure ? new Response('', { status: 503 }) : Response.json({ result: value === null ? null : JSON.stringify(value) }));
  const call = () => searchGdeltDocuments({} as never, { query: 'military', maxRecords: 10, timespan: '', toneFilter: '', sort: '' });
  for (const invalid of [null, {}, { topics: [] }, { topics: [{ id: 'military', articles: [] }] }, { topics: INTEL_TOPIC_IDS.slice(0, 5).map(id => ({ id, articles: [] })) }, { topics: [{ id: 'military', articles: [] }], fallback: true }, { topics: {} }, { topics: [null] }, { topics: [{ id: 'military', articles: [{ title: 'Missing fields', url: 'https://example.com/news' }] }] }, { topics: [{ id: 'military', articles: [{ title: 3 }] }] }]) {
    value = invalid;
    assert.ok((await call()).error);
  }
  failure = true;
  assert.equal((await call()).error, 'seed-read-failed');
  failure = false;
  value = gdeltTopics();
  assert.deepEqual((await call()).articles, []);
  assert.equal((await call()).error, '');
  value = gdeltTopics({ military: [article] });
  assert.deepEqual((await call()).articles, [article]);
});

const originalEnv = { ...process.env };
before(() => { process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example'; process.env.UPSTASH_REDIS_REST_TOKEN = 'test'; delete process.env.LOCAL_API_MODE; });
after(() => { process.env = originalEnv; });

test('generated intelligence routes preserve unavailable HTTP status and successful empty bodies', async t => {
  const { createIntelligenceServiceRoutes } = await import('../src/generated/server/worldmonitor/intelligence/v1/service_server');
  const { mapErrorToResponse } = await import('../server/error-mapper');
  const routes = createIntelligenceServiceRoutes({ listSatellites, listSecurityAdvisories } as never, { onError: mapErrorToResponse });
  let value: unknown = null;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ result: value === null ? null : JSON.stringify(value) }));
  for (const [suffix, empty] of [['list-satellites', { satellites: [] }], ['list-security-advisories', { advisories: [], byCountry: {} }]] as const) {
    const route = routes.find(route => route.path.endsWith(suffix))!;
    value = null;
    assert.equal((await route.handler(new Request(`https://app.example${route.path}`))).status, 503);
    value = empty;
    const recovered = await route.handler(new Request(`https://app.example${route.path}`));
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), empty);
  }
});
