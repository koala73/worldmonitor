import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { executeTool } from '../api/mcp/dispatch.ts';
import { McpSourceUnavailableError } from '../api/mcp/source-unavailable.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { validate } from './helpers/json-schema-mini.mjs';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const NOW = Date.parse('2026-10-08T04:00:00Z');
const KEY = 'displacement:cross-border:v1';
const META = 'seed-meta:displacement:cross-border';
const tool = CACHE_TOOLS.find(t => t.name === 'get_cross_border_arrivals');
const originalFetch = globalThis.fetch;
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'MCP_INTERNAL_HMAC_SECRET', 'MCP_TELEMETRY'];
const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
const meta = { fetchedAt: NOW - 60000, recordCount: 12, sourceState: 'ok', newestItemAt: NOW - 86400000, oldestItemAt: NOW - 86400000 * 60, maxContentAgeMin: 45 * 1440 };
const snapshot = {
  source: 'UNHCR Operational Data Portal',
  unavailable: ['sudan'],
  situations: [
    { id: 'sahel', name: 'Sahel', origin: null, sourceUrl: 'https://data.unhcr.org/en/situations/sahelcrisis', asOf: '2026-10-07', accelerating: true,
      flows: [{ kind: 'outflow', label: 'Refugees', measure: 'stock', total: 100, asOf: '2026-10-07', countries: [{ country: 'Chad', iso2: 'TD', individuals: 100, date: '2026-10-07', change: { since: '2026-10-01', delta: 10 } }] }],
      trend: { measure: 'stock', points: [{ date: '2026-10-07', number: 100 }], latestDelta: 10, latestDays: 6, accelerating: true } },
    { id: 'mediterranean', name: 'Mediterranean', asOf: '2026-10-07',
      flows: [{ kind: 'arrival', label: 'Arrivals', measure: 'monthly', total: 100, months: [{ month: '2026-10', individuals: 10 }, { month: '2026-09', individuals: 90 }], countries: [{ country: 'Chad', iso2: 'TD', individuals: 100, date: '2026-10-07' }] },
        { kind: 'death', label: 'Dead and missing', measure: 'stock', total: 2, countries: [] }] },
  ],
};

beforeEach(() => {
  assert.ok(tool, 'ordinary cross-border MCP tool must be registered');
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function seed(data = snapshot, metadata = meta) {
  return installRedis({ [KEY]: { _seed: { fetchedAt: metadata.fetchedAt }, data }, [META]: metadata });
}

test('ordinary cached aggregate contract preserves partial data, source clocks and overlap', async () => {
  seed();
  assert.deepEqual(tool._cacheKeys, [KEY]);
  assert.deepEqual(tool._freshnessChecks, [{ key: META, maxStaleMin: 2880, minRecordCount: 12, honorContentAge: true }]);
  assert.equal(tool._execute, undefined);
  const result = await executeTool(tool, {}, NOW);
  const data = result.data.crossBorderArrivals;
  assert.deepEqual(data.situations, snapshot.situations);
  assert.deepEqual(data.unavailable, ['sudan']);
  assert.equal(data.source, snapshot.source);
  assert.equal(data.total, undefined);
  assert.equal(data.globalTotals, undefined);
  assert.equal(data.history, undefined);
  assert.equal(data._seed, undefined);
  assert.equal(result.stale, false);
  assert.equal(result.cached_at, new Date(meta.fetchedAt).toISOString());
  assert.equal(data.attribution.license, 'CC BY 4.0');
  assert.deepEqual(validate(result, tool.outputSchema), []);
  const unknownTrend = structuredClone(snapshot);
  unknownTrend.situations[0].trend.latestDelta = null;
  unknownTrend.situations[0].trend.latestDays = null;
  seed(unknownTrend);
  assert.deepEqual(validate(await executeTool(tool, {}, NOW), tool.outputSchema), []);
});

test('seed age, cardinality and freshest content age fail separately', async () => {
  for (const patch of [
    { fetchedAt: NOW - 2881 * 60000 },
    { recordCount: 11 },
    { newestItemAt: NOW - 46 * 86400000 },
  ]) {
    seed(snapshot, { ...meta, ...patch });
    assert.equal((await executeTool(tool, {}, NOW)).stale, true);
  }
});

test('published empty remains distinct from missing cache', async () => {
  seed({ source: snapshot.source, situations: [], unavailable: ['sahel'] }, { ...meta, recordCount: 0 });
  const result = await executeTool(tool, {}, NOW);
  assert.deepEqual(result.data.crossBorderArrivals.situations, []);
  assert.deepEqual(result.data.crossBorderArrivals.unavailable, ['sahel']);
  assert.equal(result.stale, true);
  installRedis({ [META]: meta });
  await assert.rejects(executeTool(tool, {}, NOW), /cache_all_null/);
});

test('unreadable data is a source outage and makes no provider fallback', async () => {
  installRedis({ [META]: meta });
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (decodeURIComponent(String(input)).includes(`/get/${KEY}`)) throw new DOMException('timeout', 'TimeoutError');
    return fakeFetch(input, init);
  };
  await assert.rejects(executeTool(tool, {}, NOW), error => error instanceof McpSourceUnavailableError);
});

test('projection keeps the license, credit and transformation notice', async () => {
  seed();
  const mod = await import('../api/mcp.ts');
  const { deps } = makeProDeps();
  const res = await mod.mcpHandler(proReq('POST', callBody('get_cross_border_arrivals', { jmespath: 'data.crossBorderArrivals.situations[].name' })), deps);
  const body = await res.json();
  assert.ok(body.result, JSON.stringify(body.error));
  assert.equal(body.result.isError, undefined);
  const value = body.result.structuredContent;
  assert.deepEqual(value.data, ['Sahel', 'Mediterranean']);
  assert.equal(value._attribution.required, true);
  assert.equal(value._attribution.sources[0].attribution.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/');
  assert.match(value._attribution.sources[0].attribution.changes, /WorldMonitor/);
  assert.equal(value._attribution.sources[0].sourceUrl, snapshot.situations[0].sourceUrl);
  assert.equal(value._attribution.sources[0].asOf, snapshot.situations[0].asOf);
});

test('annual displacement default contract stays annual', () => {
  const annual = CACHE_TOOLS.find(t => t.name === 'get_displacement_data');
  assert.deepEqual(Object.keys(annual.inputSchema.properties), ['countries', 'limit']);
  assert.deepEqual(annual._cacheKeys, [`displacement:summary:v1:${new Date().getUTCFullYear()}`]);
  assert.deepEqual(annual._freshnessChecks, [{ key: 'seed-meta:displacement:summary', maxStaleMin: 3600 }]);
});
