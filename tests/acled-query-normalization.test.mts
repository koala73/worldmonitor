import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { fetchAcledCached } from '../server/_shared/acled.ts';
import { getAcledFetchWindows } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { resolveAcledEventWindow } from '../server/worldmonitor/conflict/v1/list-acled-events.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const NOW = Date.UTC(2026, 2, 15, 12);
const query = { eventTypes: 'Battles', startDate: '2026-02-13', endDate: '2026-03-15' };

function setup(t: TestContext) {
  for (const [name, value] of Object.entries({
    ACLED_EMAIL: '', ACLED_PASSWORD: '', ACLED_ACCESS_TOKEN: 'fixture-token',
    UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'fixture',
    VERCEL_ENV: 'production',
  })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  t.mock.method(Date, 'now', () => NOW);
  const redis = createRedisFetch({});
  const calls: URL[] = [];
  const provider: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    if (url.origin === 'https://redis.test') return redis.fetchImpl(input, init);
    assert.equal(url.origin + url.pathname, 'https://acleddata.com/api/acled/read');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-token');
    provider.push(url);
    return Response.json({ data: [{ event_id_cnty: 'fixture-event' }] });
  });
  return { calls, provider, redis };
}

test('rejects unsupported ACLED queries before authentication, cache, or upstream I/O', async t => {
  const { calls } = setup(t);
  process.env.ACLED_EMAIL = 'fixture@example.test';
  process.env.ACLED_PASSWORD = 'fixture-password';
  const invalid = [
    { country: 'arbitrary-fixture' }, { country: 'US|GB' }, { country: 'US:all' },
    { country: 'x'.repeat(1024) }, { country: '__proto__' }, { country: null },
    { eventTypes: '' }, { eventTypes: '%' }, { eventTypes: 'Battles|unknown' },
    { eventTypes: 'Battles||Riots' }, { eventTypes: 'Battles'.repeat(100) },
    { startDate: '' }, { startDate: '2026-02-31' }, { startDate: '2026-2-13' },
    { startDate: '2026-03-15', endDate: '2026-03-14' }, { endDate: '10000-01-01' },
    { endDate: '2026-03-15|2099-01-01' }, { endDate: '2026-03-15T00:00:00Z' },
    { limit: 0 }, { limit: -1 }, { limit: 1001 }, { limit: 1.5 },
    { limit: NaN }, { limit: Infinity }, { limit: '500' }, { limit: null },
  ];
  for (const invalidFields of invalid) {
    await assert.rejects(
      fetchAcledCached({ ...query, ...invalidFields } as Parameters<typeof fetchAcledCached>[0]),
      /Invalid ACLED query/,
      JSON.stringify(invalidFields),
    );
    assert.equal(calls.length, 0, 'invalid input must not reach OAuth, Redis, or ACLED');
  }
});

test('equivalent country and event filters share one bounded provider query and cache entry', async t => {
  const { provider, redis } = setup(t);
  for (const country of ['US', 'us', ' United States ']) {
    const events = await fetchAcledCached({
      ...query, country, eventTypes: country === 'US' ? 'Riots|Battles' : ' battles |RIOTS|Battles',
    });
    assert.equal(events[0]?.event_id_cnty, 'fixture-event');
  }
  assert.equal(provider.length, 1);
  const params = provider[0]!.searchParams;
  assert.equal(params.get('iso'), '840');
  assert.equal(params.has('country'), false);
  assert.equal(params.get('event_type'), 'Battles|Riots');
  assert.equal(params.get('event_date'), '2026-02-13|2026-03-15');
  assert.equal(params.get('event_date_where'), 'BETWEEN');
  assert.equal(params.get('limit'), '500');
  const cacheKeys = [...redis.redis.keys()].filter(key => key.startsWith('acled:shared:'));
  assert.equal(cacheKeys.length, 1);
  assert.equal(redis.expires.get(cacheKeys[0]!), 900);
});

test('current conflict and risk-score query windows remain supported', async t => {
  const { provider } = setup(t);
  const conflict = resolveAcledEventWindow({ start: 0, end: 0 }, NOW);
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  await fetchAcledCached({
    eventTypes: 'Battles|Explosions/Remote violence|Violence against civilians',
    startDate: date(conflict.startMs), endDate: date(conflict.endMs),
  });
  const windows = getAcledFetchWindows(NOW);
  for (const window of [windows.recent, windows.older]) {
    await fetchAcledCached({
      ...window, eventTypes: 'Protests|Riots|Battles|Explosions/Remote violence|Violence against civilians', limit: 1000,
    });
  }
  assert.equal(provider.length, 3);
  assert.deepEqual(provider.map(url => url.searchParams.get('limit')), ['500', '1000', '1000']);
  assert.ok(provider.every(url => !url.searchParams.has('country') && !url.searchParams.has('iso')));
});

test('single-day queries and the smallest limit preserve provider semantics', async t => {
  const { provider } = setup(t);
  await fetchAcledCached({ ...query, startDate: query.endDate, country: 'AF', limit: 1 });
  assert.equal(provider[0]!.searchParams.get('iso'), '4');
  assert.equal(provider[0]!.searchParams.get('limit'), '1');
  assert.equal(provider[0]!.searchParams.get('event_date'), '2026-03-15|2026-03-15');
});

test('distinct countries and limits stay separate while empty and omitted country share global data', async t => {
  const { provider } = setup(t);
  await fetchAcledCached(query);
  await fetchAcledCached({ ...query, country: '' });
  await fetchAcledCached({ ...query, country: 'US' });
  await fetchAcledCached({ ...query, country: 'GB' });
  await fetchAcledCached({ ...query, country: 'GB', limit: 1000 });
  assert.deepEqual(provider.map(url => [url.searchParams.get('iso'), url.searchParams.get('limit')]), [
    [null, '500'], ['840', '500'], ['826', '500'], ['826', '1000'],
  ]);
});

test('preserves documented historical ranges and explicit future end dates', async t => {
  const { provider } = setup(t);
  for (const [startDate, endDate] of [['2020-01-01', '2024-02-29'], ['2020-01-01', '2030-01-01']] as const) {
    const events = await fetchAcledCached({ ...query, startDate, endDate });
    assert.equal(events[0]?.event_id_cnty, 'fixture-event');
  }
  assert.deepEqual(provider.map(url => url.searchParams.get('event_date')), [
    '2020-01-01|2024-02-29', '2020-01-01|2030-01-01',
  ]);
});
test('Kosovo aliases use ACLED iso zero and remain separate from global queries', async t => {
  const { provider, redis } = setup(t);
  for (const country of ['XK', 'Kosovo', 'xk']) {
    await fetchAcledCached({ ...query, country });
  }
  await fetchAcledCached(query);
  assert.deepEqual(provider.map(url => url.searchParams.get('iso')), ['0', null]);
  const keys = [...redis.redis.keys()].filter(key => key.startsWith('acled:shared:'));
  assert.equal(keys.length, 2);
  assert.ok(keys.some(key => key.endsWith(':0:500')));
  assert.ok(keys.some(key => key.endsWith(':all:500')));
});
