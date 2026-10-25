import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing__ as health } from '../api/health.js';
import { executeTool } from '../api/mcp/dispatch.ts';
import { evaluateFreshness } from '../api/mcp/freshness.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const NOW = Date.parse('2026-10-21T05:13:52.558Z');
const MINUTE = 60_000;
const tool = CACHE_TOOLS.find(t => t.name === 'get_climate_data');
const checks = tool._freshnessChecks;
const healthNames = ['climateAnomalies', 'climateDisasters', 'co2Monitoring', 'climateAirQuality', 'oceanIce', 'climateNews', 'weatherAlerts'];
const metaAtAge = age => ({ fetchedAt: NOW - age * MINUTE, recordCount: 3, status: 'ok' });
const auditMetas = () => [130, 130, 1210, 9, 312, 28, 11].map(metaAtAge);

test('climate MCP uses the health seed budgets for each contributing dataset', () => {
  assert.deepEqual(checks.map(({ key, maxStaleMin }) => ({ key, maxStaleMin })),
    healthNames.map(name => ({ key: health.SEED_META[name].key, maxStaleMin: health.SEED_META[name].maxStaleMin })));
});

test('the audit-age climate bundle stays fresh through the real cache reader with limit 3', async t => {
  const originalEnv = process.env;
  process.env = { ...originalEnv, UPSTASH_REDIS_REST_URL: 'https://climate-redis.test', UPSTASH_REDIS_REST_TOKEN: 'test-token' };
  t.after(() => { process.env = originalEnv; });
  const data = [
    { anomalies: [{ zone: 'Ukraine' }, { zone: 'Europe' }, { zone: 'East Asia' }, { zone: 'North America' }] },
    { disasters: [] }, { monitoring: { currentPpm: 426.67 } }, { stations: [] },
    { seaIce: { extent: 7 } }, { items: [] }, { alerts: [] },
  ];
  const metas = auditMetas();
  const values = new Map([
    ...tool._cacheKeys.map((key, i) => [key, data[i]]),
    ...checks.map((check, i) => [check.key, metas[i]]),
  ]);
  t.mock.method(globalThis, 'fetch', async url => {
    const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
    assert.ok(values.has(key), `unexpected Redis read ${key}`);
    return Response.json({ result: JSON.stringify(values.get(key)) });
  });

  const result = await executeTool(tool, { limit: 3 }, NOW);
  assert.equal(result.stale, false);
  assert.equal(result.cached_at, new Date(metas[2].fetchedAt).toISOString());
  assert.equal(result.data.anomalies.anomalies.length, 3);
  assert.deepEqual(result.data.disasters.disasters, []);
});

test('anomalies stay fresh between three-hour runs, including routine cron jitter', () => {
  for (const age of [130, 179, 183]) {
    assert.equal(evaluateFreshness([checks[0]], [metaAtAge(age)], NOW).stale, false, `age ${age}`);
  }
});

test('daily CO2 stays fresh at 60 hours and becomes stale after 72 hours', () => {
  assert.equal(evaluateFreshness([checks[2]], [metaAtAge(60 * 60)], NOW).stale, false);
  assert.equal(evaluateFreshness([checks[2]], [metaAtAge(72 * 60 + 1)], NOW).stale, true);
});

for (const [i, name] of healthNames.entries()) {
  test(`${name} preserves its own seed expiry, failure, and missing-metadata gates`, () => {
    const check = checks[i];
    const budget = health.SEED_META[name].maxStaleMin;
    assert.equal(evaluateFreshness([check], [metaAtAge(budget)], NOW).stale, false);
    assert.equal(evaluateFreshness([check], [metaAtAge(budget + 1)], NOW).stale, true);
    assert.equal(evaluateFreshness([check], [{ ...metaAtAge(1), status: 'error' }], NOW).stale, true);
    assert.deepEqual(evaluateFreshness([check], [null], NOW), { cached_at: null, stale: true });
    assert.deepEqual(evaluateFreshness([check], [{ fetchedAt: 'invalid' }], NOW), { cached_at: null, stale: true });
  });
}

for (const [index, budget] of [[0, 14 * 24 * 60], [5, 7 * 24 * 60]]) {
  test(`${healthNames[index]} honors the producer content clock independently of fetch age`, () => {
    const check = checks[index];
    const cfg = health.SEED_META[healthNames[index]];
    for (const [newestItemAt, stale] of [
      [NOW - 314 * MINUTE, false],
      [NOW - budget * MINUTE, false],
      [NOW - (budget + 1) * MINUTE, true],
      [null, true],
      [NOW + 10 * MINUTE, true],
    ]) {
      const meta = { ...metaAtAge(1), maxContentAgeMin: budget, newestItemAt };
      const healthMeta = health.readSeedMeta(cfg, new Map([[cfg.key, JSON.stringify(meta)]]), new Map(), NOW);
      assert.equal(healthMeta.contentAge.contentStale, stale);
      assert.equal(evaluateFreshness([check], [meta], NOW).stale, stale, `newestItemAt ${newestItemAt}`);
    }
  });
}

test('one expired weather seed marks the bundle stale while its other seeds remain fresh', () => {
  const metas = auditMetas();
  metas[6] = metaAtAge(46);
  assert.equal(evaluateFreshness(checks, metas, NOW).stale, true);
  assert.equal(evaluateFreshness([checks[0]], [metas[0]], NOW).stale, false);
});
