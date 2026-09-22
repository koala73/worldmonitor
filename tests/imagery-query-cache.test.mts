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
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('https://redis.test/')) return redis.fetchImpl(input, init);
    assert.equal(url, 'https://earth-search.aws.element84.com/v1/search');
    assert.equal(init?.method, 'POST');
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ features: [{
      id: `scene-${bodies.length}`, properties: { datetime: request.datetime }, geometry: null,
      assets: { thumbnail: { href: 's3://fixture-bucket/preview.png' }, visual: { href: 'http://127.0.0.1/private' } },
    }] });
  });
  return { bodies, urls, redis };
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
