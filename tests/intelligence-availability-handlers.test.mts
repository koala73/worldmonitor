import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { listSatellites } from '../server/worldmonitor/intelligence/v1/list-satellites';
import { listSecurityAdvisories } from '../server/worldmonitor/intelligence/v1/list-security-advisories';
import { searchGdeltDocuments } from '../server/worldmonitor/intelligence/v1/search-gdelt-documents';

const INTEL_TOPIC_IDS = ['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'maritime'];
const MIN_ADVISORY_COUNTRY_COVERAGE = 100;
const satellite = { id: '25544', name: 'ISS', country: 'US', type: 'station', line1: '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992', line2: '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442' };
const advisory = { title: 'Travel update', link: 'https://example.com/advice', pubDate: '2026-09-15T00:00:00Z', source: 'FCDO', sourceCountry: 'UK', level: 'caution', country: 'UA' };
const article = { title: 'Military exercise', url: 'https://example.com/news', source: 'example.com', date: '20260915T000000Z', image: '', language: 'English', tone: 0 };
const untitled = { ...article, title: '', url: 'https://example.com/untitled' };
const coveredByCountry = Object.fromEntries(Array.from({ length: MIN_ADVISORY_COUNTRY_COVERAGE }, (_, i) => [
  `C${String(i).padStart(3, '0')}`,
  i === 0 ? 'caution' : 'normal',
]));
const gdeltTopics = (articlesById: Record<string, unknown[]> = {}) => ({
  topics: INTEL_TOPIC_IDS.map(id => ({ id, articles: articlesById[id] ?? [] })),
});

const originalEnv = { ...process.env };
before(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
  delete process.env.LOCAL_API_MODE;
});
after(() => { process.env = originalEnv; });

function mockRedis(t: { mock: { method: typeof import('node:test').mock.method } }) {
  const state = { value: null as unknown, failure: false };
  t.mock.method(globalThis, 'fetch', async () => state.failure
    ? new Response('', { status: 503 })
    : Response.json({ result: state.value === null ? null : JSON.stringify(state.value) }));
  return state;
}

for (const [name, call, empty, present, malformed, mixed] of [
  [
    'satellites',
    () => listSatellites({} as never, { country: '' }),
    { satellites: [] },
    { satellites: [satellite] },
    [{ satellites: [null] }, { satellites: [{ ...satellite, line1: 'broken' }] }],
    { satellites: [satellite, { ...satellite, line1: 'broken' }, null] },
  ],
  [
    'advisories',
    () => listSecurityAdvisories({} as never, {}),
    { advisories: [], byCountry: {} },
    { advisories: [advisory], byCountry: coveredByCountry },
    [{ advisories: [{ ...advisory, pubDate: 'bad' }], byCountry: coveredByCountry }, { advisories: [advisory], byCountry: { UA: 'caution' } }],
    { advisories: [advisory, { ...advisory, pubDate: 'bad' }, null], byCountry: coveredByCountry },
  ],
] as const) {
  test(`${name}: empty/hit succeed; miss, malformed and Redis failure are unavailable; repaired seed recovers`, async t => {
    const redis = mockRedis(t);
    for (const invalid of [null, {}, ...malformed, { ...present, fallback: true }]) {
      redis.value = invalid;
      await assert.rejects(call, (e: { statusCode?: number }) => e.statusCode === 503, JSON.stringify(invalid));
    }
    redis.failure = true;
    await assert.rejects(call, (e: { statusCode?: number }) => e.statusCode === 503);
    redis.failure = false;
    redis.value = empty;
    assert.deepEqual(await call(), empty);
    redis.value = present;
    const response = await call() as { satellites?: unknown[]; advisories?: unknown[] };
    assert.equal((response.satellites ?? response.advisories)?.length, 1);
  });

  test(`${name}: an invalid record is dropped and the valid ones are served`, async t => {
    const redis = mockRedis(t);
    redis.value = mixed;
    const response = await call() as { satellites?: Array<{ id: string }>; advisories?: Array<{ title: string }> };
    const records = response.satellites ?? response.advisories;
    assert.equal(records?.length, 1);
  });
}

test('GDELT topics distinguish empty matches from unavailable or malformed seed and read errors', async t => {
  const redis = mockRedis(t);
  const call = () => searchGdeltDocuments({} as never, { query: 'military', maxRecords: 10, timespan: '', toneFilter: '', sort: '' });
  for (const invalid of [
    null, {}, { topics: [] }, { topics: {} }, { topics: [null] },
    { topics: [{ id: 'military', articles: [] }] },
    { topics: INTEL_TOPIC_IDS.slice(0, 5).map(id => ({ id, articles: [] })) },
    { ...gdeltTopics({ military: [article] }), fallback: true },
    gdeltTopics({ military: [{ title: 'Missing fields', url: 'https://example.com/news' }] }),
  ]) {
    redis.value = invalid;
    assert.equal((await call()).error, 'seed-unavailable', JSON.stringify(invalid));
  }
  redis.failure = true;
  assert.equal((await call()).error, 'seed-read-failed');
  redis.failure = false;
  redis.value = gdeltTopics();
  assert.deepEqual(await call(), { articles: [], query: 'military', error: '' });
  redis.value = gdeltTopics({ military: [article] });
  assert.deepEqual((await call()).articles, [article]);
});

test('GDELT: one untitled article in the seed is dropped, the valid articles are still served', async t => {
  const redis = mockRedis(t);
  redis.value = gdeltTopics({ military: [untitled, article], cyber: [{ ...article, url: 'https://example.com/cyber' }] });
  const response = await searchGdeltDocuments({} as never, { query: 'military', maxRecords: 10, timespan: '', toneFilter: '', sort: '' });
  assert.equal(response.error, '');
  assert.deepEqual(response.articles, [article]);
});

test('generated intelligence routes preserve unavailable HTTP status and successful empty bodies', async t => {
  const { createIntelligenceServiceRoutes } = await import('../src/generated/server/worldmonitor/intelligence/v1/service_server');
  const { mapErrorToResponse } = await import('../server/error-mapper');
  const routes = createIntelligenceServiceRoutes({ listSatellites, listSecurityAdvisories } as never, { onError: mapErrorToResponse });
  const redis = mockRedis(t);
  for (const [suffix, empty, malformed] of [
    ['list-satellites', { satellites: [] }, { satellites: [null] }],
    ['list-security-advisories', { advisories: [], byCountry: {} }, { advisories: [null], byCountry: coveredByCountry }],
  ] as const) {
    const route = routes.find(candidate => candidate.path.endsWith(suffix))!;
    for (const unavailable of [null, malformed]) {
      redis.value = unavailable;
      assert.equal((await route.handler(new Request(`https://app.example${route.path}`))).status, 503);
    }
    redis.value = empty;
    const recovered = await route.handler(new Request(`https://app.example${route.path}`));
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), empty);
  }
});
