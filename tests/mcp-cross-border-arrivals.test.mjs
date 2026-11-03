import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { executeTool } from '../api/mcp/dispatch.ts';
import { McpSourceUnavailableError } from '../api/mcp/source-unavailable.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import Ajv2020 from 'ajv/dist/2020.js';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const NOW = Date.parse('2026-10-08T04:00:00Z');
const KEY = 'displacement:cross-border:v1';
const META = 'seed-meta:displacement:cross-border';
const tool = CACHE_TOOLS.find(t => t.name === 'get_cross_border_arrivals');
const ajv = new Ajv2020({ strict: false, validateFormats: false });
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
      trend: { measure: 'stock', points: [['2026-10-07', 100]], latestDelta: 10, latestDays: 6, accelerating: true } },
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

test('trend tuple uses an object schema for Inspector portability with identical validation', () => {
  const point = tool.outputSchema.properties.data.properties.crossBorderArrivals.properties.situations.items.properties.trend.properties.points.items;
  assert.equal(typeof point.items, 'object', 'Inspector strict rejects a bare boolean tuple terminator');
  const portable = ajv.compile(point);
  const standard = ajv.compile({ ...point, items: false });
  for (const [value, valid] of [
    [['2026-10-07', 100], true], [['2026-10-07', 0], true],
    [[], false], [['2026-10-07'], false], [['2026-10-07', 100, 200], false],
    [[100, '2026-10-07'], false], [['2026-10-07', '100'], false],
    [['2026-10-07', null], false], [null, false], [{ date: '2026-10-07', number: 100 }, false],
  ]) {
    assert.equal(standard(value), valid, JSON.stringify(value));
    assert.equal(portable(value), valid, JSON.stringify(value));
  }
});

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
  assert.ok(ajv.validate(tool.outputSchema, result), ajv.errorsText());
  const unknownTrend = structuredClone(snapshot);
  unknownTrend.situations[0].trend.latestDelta = null;
  unknownTrend.situations[0].trend.latestDays = null;
  seed(unknownTrend);
  assert.ok(ajv.validate(tool.outputSchema, await executeTool(tool, {}, NOW)), ajv.errorsText());
  for (const points of [[{ date: '2026-10-07', number: 100 }], [[100, '2026-10-07']], [['2026-10-07', 100, 200]]]) {
    const invalid = structuredClone(result);
    invalid.data.crossBorderArrivals.situations[0].trend.points = points;
    assert.equal(ajv.validate(tool.outputSchema, invalid), false);
  }
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
  assert.deepEqual(Object.keys(annual.inputSchema.properties), ['view', 'route', 'countries', 'limit']);
  assert.deepEqual(annual._cacheKeys.filter(key => key.startsWith('displacement:summary:')), [`displacement:summary:v1:${new Date().getUTCFullYear()}`]);
  assert.deepEqual(annual._freshnessChecks.filter(check => check.key === 'seed-meta:displacement:summary'), [{ key: 'seed-meta:displacement:summary', maxStaleMin: 3600 }]);
});

test('summaries keep attribution and source URLs with and without projection', async () => {
  const wide = structuredClone(snapshot);
  wide.situations.push({ ...structuredClone(snapshot.situations[0]), id: 'third' }, { ...structuredClone(snapshot.situations[0]), id: 'fourth' });
  for (const arguments_ of [{ summary: true }, { summary: true, jmespath: 'data.crossBorderArrivals.situations[].name' }]) {
    seed(wide);
    const mod = await import('../api/mcp.ts');
    const { deps } = makeProDeps();
    const res = await mod.mcpHandler(proReq('POST', callBody('get_cross_border_arrivals', arguments_)), deps);
    const body = await res.json();
    assert.ok(body.result, JSON.stringify(body.error));
    const value = body.result.structuredContent;
    if (arguments_.jmespath) {
      assert.equal(value.data.length, 3);
      assert.equal(value._attribution.sources[0].attribution.license, 'CC BY 4.0');
      assert.equal(value._attribution.sources[0].sourceUrl, snapshot.situations[0].sourceUrl);
    } else {
      const data = value.projection.data.crossBorderArrivals;
      assert.equal(data.situationCount, 4);
      assert.equal(data.situations.length, 3);
      assert.equal(data.attribution.license, 'CC BY 4.0');
      assert.equal(data.attribution.sourceUrl, 'https://data.unhcr.org/');
      assert.match(data.attribution.changes, /WorldMonitor/);
      assert.deepEqual(data.unavailable, ['sudan']);
      assert.ok(ajv.validate(tool.outputSchema, value.projection), ajv.errorsText());
    }
  }
});


test('movement view reads source envelopes independently and preserves explicit zero with country and route filters', async () => {
  const annual = CACHE_TOOLS.find(t => t.name === 'get_displacement_data');
  const stamp = Date.now() - 60000;
  const asOf = new Date(stamp).toISOString().slice(0, 10);
  installRedis({
    'displacement:border-uk:v1': { _seed: { fetchedAt: stamp }, data: { routes: [{ id: 'english-channel', name: 'Channel', countryCode: 'GB', kind: 'arrival', measure: 'daily', asOf, latestCount: 0, last7Days: 0, last30Days: 3, period: 'day', surge: false }] } },
    'seed-meta:displacement:border-uk': { fetchedAt: stamp, recordCount: 1 },
  });
  const result = await executeTool(annual, { view: 'movements', countries: ['United Kingdom'], route: 'english-channel', limit: 0 });
  const data = result.data.crossBorderMovements;
  assert.equal(data.movements.length, 1);
  assert.equal(data.movements[0].count, 0);
  assert.equal(data.movements[0].last7Days, 0);
  assert.equal(data.sources.find(s => s.id === 'odp').status, 'unavailable');
  assert.equal(data.movements[0].license, 'Open Government Licence v3.0');
  assert.equal((await executeTool(annual, { view: 'movements', countries: ['US'] })).data.crossBorderMovements.movements.length, 0);
  assert.equal((await executeTool(annual, { view: 'movements', route: 'unknown' })).data.crossBorderMovements.movements.length, 0);
  assert.ok(ajv.validate(annual.outputSchema, result), ajv.errorsText());
});

test('movement route filters preserve the exact source ID case while trimming input', () => {
  const tool = CACHE_TOOLS.find(t => t.name === 'get_displacement_data');
  const stamp = Date.now() - 60000;
  const data = { uk: { _seed: { fetchedAt: stamp }, data: { routes: [{
    id: 'Channel-ID', countryCode: 'GB', kind: 'arrival', measure: 'daily',
    asOf: new Date(stamp).toISOString().slice(0, 10), latestCount: 0,
  }] } } };
  const filter = route => tool._postFilter(data, { view: 'movements', route });
  assert.equal(filter(' Channel-ID ').crossBorderMovements.movements.length, 1);
  assert.equal(filter('channel-id').crossBorderMovements.movements.length, 0);
});

test('movement freshness excludes proven inactive sources but retains activated and unreadable failures', async () => {
  const annual = CACHE_TOOLS.find(t => t.name === 'get_displacement_data');
  const stamp = Date.now() - 60000;
  const fixtures = {
    [KEY]: { _seed: { fetchedAt: stamp }, data: { situations: [snapshot.situations[0]] } },
    [META]: { fetchedAt: stamp },
    'displacement:border-uk:v1': { _seed: { fetchedAt: stamp }, data: { routes: [{ id: 'english-channel', countryCode: 'GB', kind: 'arrival', measure: 'daily', asOf: new Date(stamp).toISOString().slice(0, 10), latestCount: 0 }] } },
    'seed-meta:displacement:border-uk': { fetchedAt: stamp },
  };
  installRedis(fixtures);
  const fresh = await executeTool(annual, { view: 'movements' });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.cached_at, new Date(stamp).toISOString());
  assert.equal(fresh.data.crossBorderMovements.sources.find(s => s.id === 'panama').status, 'unavailable');
  installRedis({ ...fixtures, 'seed-activated:displacement:border-panama': 1 });
  const missingActive = await executeTool(annual, { view: 'movements' });
  assert.equal(missingActive.stale, true);
  assert.equal(missingActive.cached_at, null);
  assert.ok(missingActive.data.crossBorderMovements.movements.some(m => m.route === 'english-channel'));
  installRedis({ ...fixtures, 'seed-meta:displacement:border-panama': { fetchedAt: stamp, status: 'error' } });
  assert.equal((await executeTool(annual, { view: 'movements' })).stale, true);
  const redis = installRedis(fixtures);
  globalThis.fetch = async (input, init) => {
    const commands = JSON.parse(init?.body ?? '[]');
    if (Array.isArray(commands[0]) && commands.some(c => c[0] === 'EXISTS')) return new Response('unavailable', { status: 500 });
    return redis.fetchImpl(input, init);
  };
  const unknown = await executeTool(annual, { view: 'movements' });
  assert.equal(unknown.stale, true);
  assert.equal(unknown.activationUnknown, true);
});
