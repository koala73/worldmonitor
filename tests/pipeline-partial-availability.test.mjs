import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listPipelines } from '../server/worldmonitor/supply-chain/v1/list-pipelines.ts';

test('pipeline availability accounts for each requested registry', async (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.VERCEL_ENV = 'production';
  const gas = { pipelines: { gas1: { id: 'gas1', commodityType: 'gas' } }, classifierVersion: 'v2', updatedAt: '2026-09-14T00:00:00Z' };
  const oil = { pipelines: { oil1: { id: 'oil1', commodityType: 'oil' } }, classifierVersion: 'v1', updatedAt: '2026-09-13T00:00:00Z' };
  let registries = { gas, oil: null };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const key = decodeURIComponent(new URL(url).pathname);
    assert.match(key, /^\/get\/energy:pipelines:(gas|oil):v1$/);
    const value = registries[key.includes(':gas:') ? 'gas' : 'oil'];
    return Response.json({ result: value ? JSON.stringify(value) : null });
  });
  for (const [gasData, oilData, commodityType, unavailable, ids] of [
    [gas, null, '', true, ['gas1']], [null, oil, '', true, ['oil1']],
    [null, null, '', true, []], [gas, oil, '', false, ['gas1', 'oil1']],
    [gas, { pipelines: {} }, '', false, ['gas1']], [{ pipelines: {} }, { pipelines: {} }, '', false, []],
    [gas, null, 'gas', false, ['gas1']], [null, oil, 'oil', false, ['oil1']],
    [null, oil, 'gas', true, []], [gas, null, 'oil', true, []],
  ]) {
    registries = { gas: gasData, oil: oilData };
    const result = await listPipelines({}, { commodityType });
    assert.equal(result.upstreamUnavailable, unavailable, `${commodityType || 'both'}: ${ids}`);
    assert.deepEqual(result.pipelines.map(p => p.id), ids);
  }
});


test('pipeline filters reject unknown values before reads and do not invent freshness', async (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  const keys = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    keys.push(decodeURIComponent(new URL(url).pathname));
    return Response.json({ result: null });
  });
  for (const commodityType of ['coal', 'gas:extra', 'x'.repeat(100)]) {
    await assert.rejects(listPipelines({}, { commodityType }), { name: 'ValidationError' });
    assert.deepEqual(keys, []);
  }
  const result = await listPipelines({}, { commodityType: 'GAS' });
  assert.deepEqual(keys, ['/get/energy:pipelines:gas:v1']);
  assert.equal(result.fetchedAt, '');
  assert.equal(result.upstreamUnavailable, true);
});
