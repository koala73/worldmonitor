import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { __testing__ as health } from '../api/health.js';
import { utf8ByteLength } from '../api/mcp.ts';
import { validateToolArgs } from '../api/mcp/_validate-args.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { executeTool } from '../api/mcp/dispatch.ts';
import { evaluateFreshness } from '../api/mcp/freshness.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { RESERVOIR_STATUSES } from '../api/mcp/registry/_reservoir-levels.ts';
import { classifyStatus } from '../scripts/_reservoir-levels.mjs';
import { buildSummary } from '../scripts/seed-reservoir-levels.mjs';

const NOW = Date.parse('2026-11-12T06:00:00.000Z');
const DAY = 86_400_000;
const KEY = 'climate:reservoir-levels:v1';
const META_KEY = 'seed-meta:climate:reservoir-levels';
const tool = CACHE_TOOLS.find(t => t.name === 'get_reservoir_levels');
const watchlist = JSON.parse(readFileSync(new URL('../scripts/data/strategic-reservoirs.json', import.meta.url), 'utf8')).reservoirs;

// The real watchlist through the seeder's own summary builder, with five years of
// synthetic passes every 30 days (36-37 series points each, above production's ~27).
// Every seventh reservoir's newest pass is 200 days old, so no_recent_data occurs.
function buildSnapshot() {
  const byId = {};
  for (const [i, e] of watchlist.entries()) {
    const lastPass = NOW - (i % 7 === 0 ? 200 : 55 + (i % 15)) * DAY;
    const passes = [];
    for (let t = lastPass - 5 * 365 * DAY; t <= lastPass; t += 30 * DAY) {
      const phase = (2 * Math.PI * (t - Date.UTC(2020, 0, 1))) / (365.25 * DAY);
      const levelM = 150 + i * 37 + (3 + (i % 5)) * Math.sin(phase + i) - ((t - lastPass) / DAY) * 0.001 * (i % 3);
      passes.push([new Date(t).toISOString(), 100 + (i % 9), Math.round(levelM * 1000) / 1000, 0.05, 40, 0.1]);
    }
    byId[e.id] = { passes };
  }
  return buildSummary(watchlist, byId, NOW);
}

const SNAPSHOT = buildSnapshot();
const freshMeta = { fetchedAt: NOW - 60 * 60_000, recordCount: 50, status: 'ok' };

async function call(t, args, { snapshot = SNAPSHOT, meta = freshMeta } = {}) {
  const originalEnv = process.env;
  process.env = { ...originalEnv, UPSTASH_REDIS_REST_URL: 'https://reservoir-redis.test', UPSTASH_REDIS_REST_TOKEN: 'test-token' };
  t.after(() => { process.env = originalEnv; });
  const values = new Map([[KEY, snapshot], [META_KEY, meta]]);
  t.mock.method(globalThis, 'fetch', async url => {
    const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
    assert.ok(values.has(key), `unexpected Redis read ${key}`);
    return Response.json({ result: JSON.stringify(values.get(key)) });
  });
  validateToolArgs(tool, args);
  return executeTool(tool, args, NOW);
}

test('the fixture covers the whole watchlist with production-like series and a no_recent_data case', () => {
  assert.equal(SNAPSHOT.reservoirs.length, 50);
  assert.ok(SNAPSHOT.reservoirs.every(r => r.latest && r.latest.ageDays >= 55));
  assert.ok(SNAPSHOT.reservoirs.every(r => r.series.length >= 27 && Array.isArray(r.series[0])));
  assert.ok(SNAPSHOT.reservoirs.some(r => r.status === 'no_recent_data'));
});

test('the default call returns all 50 reservoirs without series', async t => {
  const result = await call(t, {});
  const out = result.data['reservoir-levels'];
  assert.equal(result.stale, false);
  assert.equal(out.dataAvailable, true);
  assert.equal(out.reservoirs.length, 50);
  assert.deepEqual(out.reservoirs.map(r => r.id), watchlist.map(r => r.id));
  assert.ok(out.reservoirs.every(r => !('series' in r)));
  assert.equal(out.reservoirs[0].latest.levelM, SNAPSHOT.reservoirs[0].latest.levelM);
  assert.equal(out.source.name, SNAPSHOT.source.name);
});

test('include_series returns the stored tuples as {date, levelM} points', async t => {
  const result = await call(t, { include_series: true });
  const out = result.data['reservoir-levels'];
  assert.equal(out.reservoirs.length, 50);
  for (const [i, r] of out.reservoirs.entries()) {
    assert.deepEqual(r.series, SNAPSHOT.reservoirs[i].series.map(([date, levelM]) => ({ date, levelM })));
  }
});

test('country matches the holding country or any riparian', async t => {
  const result = await call(t, { country: 'Egypt' });
  const ids = result.data['reservoir-levels'].reservoirs.map(r => r.id);
  const expected = watchlist.filter(r => r.country === 'EG' || r.riparians.includes('EG')).map(r => r.id);
  assert.ok(ids.includes('gerd'), 'GERD is held by Ethiopia and shared with Egypt');
  assert.ok(watchlist.find(r => r.id === 'gerd').country !== 'EG');
  assert.deepEqual(ids, expected);
});

test('status and id narrow the list', async t => {
  const byStatus = await call(t, { status: 'no_recent_data' });
  const statusIds = byStatus.data['reservoir-levels'].reservoirs.map(r => r.id);
  assert.deepEqual(statusIds, SNAPSHOT.reservoirs.filter(r => r.status === 'no_recent_data').map(r => r.id));
  assert.ok(statusIds.length > 0);

  const byId = await call(t, { id: 'mead', include_series: true });
  const [mead] = byId.data['reservoir-levels'].reservoirs;
  assert.equal(byId.data['reservoir-levels'].reservoirs.length, 1);
  assert.equal(mead.id, 'mead');
  assert.ok(mead.series.length > 0);
});

test('invalid country and status are rejected as Invalid params', () => {
  assert.throws(() => validateToolArgs(tool, { country: 'Atlantis' }), RpcValidationError);
  assert.throws(() => validateToolArgs(tool, { status: 'dry' }), RpcValidationError);
});

test('the status enum matches every status the seeder can classify', () => {
  const returned = new Set([...classifyStatus.toString().matchAll(/return '([a-z_]+)'/g)].map(m => m[1]));
  assert.deepEqual([...returned].sort(), [...RESERVOIR_STATUSES].sort());
});

test('freshness follows the health seed budget and watchlist floor', () => {
  const cfg = health.SEED_META.reservoirLevels;
  assert.deepEqual(tool._freshnessChecks, [{ key: cfg.key, maxStaleMin: cfg.maxStaleMin, minRecordCount: cfg.minRecordCount }]);
  const [check] = tool._freshnessChecks;
  const at = ageMin => ({ ...freshMeta, fetchedAt: NOW - ageMin * 60_000 });
  assert.equal(evaluateFreshness([check], [at(4320)], NOW).stale, false);
  assert.equal(evaluateFreshness([check], [at(4321)], NOW).stale, true);
  assert.equal(evaluateFreshness([check], [{ ...freshMeta, recordCount: 49 }], NOW).stale, true);
  assert.equal(evaluateFreshness([check], [{ ...freshMeta, status: 'error' }], NOW).stale, true);
  assert.equal(evaluateFreshness([check], [null], NOW).stale, true);
});

test('old passes with a fresh seed run are not stale; an old seed run is', async t => {
  const oldPasses = structuredClone(SNAPSHOT);
  for (const r of oldPasses.reservoirs) r.latest.ageDays = 400;
  const fresh = await call(t, {}, { snapshot: oldPasses });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.data['reservoir-levels'].reservoirs[0].latest.ageDays, 400);

  const oldRun = await call(t, {}, { meta: { ...freshMeta, fetchedAt: NOW - 4 * DAY } });
  assert.equal(oldRun.stale, true);
});

test('the full watchlist fits the output budget with and without series', async t => {
  const wire = result => utf8ByteLength(JSON.stringify({ cached_at: result.cached_at, stale: result.stale, data: result.data }));
  const defaultBytes = wire(await call(t, {}));
  const seriesBytes = wire(await call(t, { include_series: true }));
  t.diagnostic(`stored ${utf8ByteLength(JSON.stringify(SNAPSHOT))} B, default ${defaultBytes} B, include_series ${seriesBytes} B, budget ${tool._outputBudgetBytes} B`);
  assert.ok(defaultBytes < 64 * 1024, `default ${defaultBytes}`);
  assert.ok(seriesBytes <= tool._outputBudgetBytes, `include_series ${seriesBytes}`);
});
