import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { searchImagery } from '../server/worldmonitor/imagery/v1/search-imagery.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const request = { bbox: '0.1,0.1,1.1,1.1', datetime: '2026-08-01T00:00:00Z', source: '', limit: 5 };

function setup(t: TestContext) {
  for (const [name, value] of Object.entries({
    UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'fixture', VERCEL_ENV: 'production',
  })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const redis = createRedisFetch({});
  const bodies: Array<{ bbox: number[]; datetime: string; collections: string[]; limit: number }> = [];
  const urls: string[] = [];
  // STAC answers 200 with one scene unless a test says otherwise.
  const control = { stacStatus: 200, empty: false };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('https://redis.test/')) return redis.fetchImpl(input, init);
    assert.equal(url, 'https://earth-search.aws.element84.com/v1/search');
    assert.equal(init?.method, 'POST');
    bodies.push(JSON.parse(String(init?.body)));
    if (control.stacStatus !== 200) return new Response(null, { status: control.stacStatus });
    if (control.empty) return Response.json({ features: [] });
    return Response.json({ features: [{
      id: `scene-${bodies.length}`, properties: { datetime: request.datetime }, geometry: null,
      assets: { thumbnail: { href: 's3://fixture-bucket/preview.png' }, visual: { href: 'http://127.0.0.1/private' } },
    }] });
  });
  return { bodies, urls, redis, control };
}

test('unknown and legacy sources selecting default collections share one cache entry', async t => {
  const { bodies } = setup(t);
  for (const source of ['', 'capella', 'unknown-one', 'unknown-two', 'sentinel', '__proto__']) {
    const result = await searchImagery({} as never, { ...request, source });
    assert.equal(result.scenes[0]?.id, 'scene-1');
  }
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]!.collections, ['sentinel-2-l2a', 'sentinel-1-grd']);
});

test('collection aliases reuse their cache but different collections stay separate', async t => {
  const { bodies } = setup(t);
  for (const source of [' Sentinel-2 ', 'sentinel-2-l2a', 'sentinel-1', 'sentinel-1-grd']) {
    await searchImagery({} as never, { ...request, source });
  }
  assert.deepEqual(bodies.map(body => body.collections), [['sentinel-2-l2a'], ['sentinel-1-grd']]);
});

test('equivalent instants reuse cache without dropping fractional precision', async t => {
  const { bodies } = setup(t);
  for (const datetime of [request.datetime, '2026-08-01T02:00:00+02:00', '2026-08-01t00:00:00.000z']) {
    await searchImagery({} as never, { ...request, datetime });
  }
  for (const datetime of ['2026-08-01T00:00:00.0001Z', '2026-08-01T00:00:00.00010Z', '2026-08-01T00:00:00.0002Z']) {
    await searchImagery({} as never, { ...request, datetime });
  }
  assert.deepEqual(bodies.map(body => body.datetime), [request.datetime, '2026-08-01T00:00:00.0001Z', '2026-08-01T00:00:00.0002Z']);
});

test('cache identity preserves the precise bbox and limit sent to STAC', async t => {
  const { bodies } = setup(t);
  for (const bbox of [request.bbox, '0.10,0.10,1.10,1.10', '0.2,0.2,1.2,1.2']) {
    await searchImagery({} as never, { ...request, bbox });
  }
  await searchImagery({} as never, { ...request, limit: 50 });
  await searchImagery({} as never, { ...request, limit: 500 });
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.map(body => body.bbox), [[0.1, 0.1, 1.1, 1.1], [0.2, 0.2, 1.2, 1.2], [0.1, 0.1, 1.1, 1.1]]);
  assert.deepEqual(bodies.map(body => body.limit), [5, 5, 50]);
});

test('malformed, oversized, impossible and reversed datetimes fail before Redis or STAC', async t => {
  const { urls } = setup(t);
  for (const datetime of ['junk', 'x'.repeat(1024), '2026-02-31', '2026-02-31T00:00:00Z', '2026-08-01T25:00:00Z',
    '2026-08-01T00:00:00+25:00', '2026-08-01T00:00:00', '../..', '2026-08-02/2026-08-01',
    '2026-08-01T00:00:00.0002Z/2026-08-01T00:00:00.0001Z', 'a/b/c']) {
    await assert.rejects(searchImagery({} as never, { ...request, datetime }), error => (error as { violations: Array<{ field: string }> }).violations[0]?.field === 'datetime');
    assert.equal(urls.length, 0);
  }
});

test('default week and equivalent explicit intervals share one query', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 7, 8, 12, 0, 0) });
  const { bodies } = setup(t);
  await searchImagery({} as never, { ...request, datetime: '' });
  const first = bodies[0]!.datetime;
  const offsetAlias = first.replaceAll('T12:00:00Z', 'T14:00:00+02:00');
  await searchImagery({} as never, { ...request, datetime: first });
  await searchImagery({} as never, { ...request, datetime: offsetAlias });
  assert.equal(bodies.length, 1);
  assert.equal(first, '2026-08-01T12:00:00Z/2026-08-08T12:00:00Z');
});

test('historical date ranges and open bounds stay supported; response URLs are never fetched', async t => {
  const { bodies, urls } = setup(t);
  for (const datetime of ['2020-01-01/2024-02-29', '../2026-08-01T00:00:00Z', '/2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z/..']) {
    const result = await searchImagery({} as never, { ...request, datetime });
    assert.equal(result.scenes[0]?.previewUrl, 'https://fixture-bucket.s3.amazonaws.com/preview.png');
    assert.equal(result.scenes[0]?.assetUrl, 'http://127.0.0.1/private');
  }
  assert.equal(bodies.length, 3);
  assert.ok(urls.every(url => url.startsWith('https://redis.test/') || url === 'https://earth-search.aws.element84.com/v1/search'));
});

// A transient provider failure used to be stored as a successful empty result
// for CACHE_TTL, so one 503 answered "no scenes over this box" to every caller
// of that query for the next hour, and the call was reported upstream as a 200.
test('a failed STAC search is negative-cached, not stored as an hour of "no scenes"', async t => {
  const { bodies, redis, control } = setup(t);
  control.stacStatus = 503;

  const failed = await searchImagery({} as never, request);
  assert.deepEqual(failed, { scenes: [], totalResults: 0, cacheHit: false });
  assert.equal(bodies.length, 1, 'the provider was asked');

  const key = [...redis.redis.keys()].find(name => name.startsWith('imagery:search:v2:'));
  assert.ok(key, 'the failed search leaves a cache marker');
  const stored = redis.redis.get(key)!;
  assert.doesNotMatch(stored, /scenes/, 'a provider failure is not a positive empty result');
  assert.match(stored, /__WM_NEG__/, 'it takes the negative-sentinel path');
  assert.ok(redis.expires.get(key)! <= 300, `a failure must not hold the 1h positive TTL (got ${redis.expires.get(key)})`);
});

// Positive control: a real empty answer from a healthy provider still caches
// as "no scenes" for the full hour. Only a failed call takes the negative path.
test('a healthy empty STAC answer is cached positively for the full hour', async t => {
  const { redis, control } = setup(t);
  control.empty = true;
  const result = await searchImagery({} as never, request);
  assert.deepEqual(result, { scenes: [], totalResults: 0, cacheHit: false });
  const key = [...redis.redis.keys()].find(name => name.startsWith('imagery:search:v2:'))!;
  const stored = redis.redis.get(key)!;
  assert.doesNotMatch(stored, /__WM_NEG__/);
  assert.deepEqual(JSON.parse(stored), { scenes: [], totalResults: 0 });
  assert.equal(redis.expires.get(key), 3600);
});
