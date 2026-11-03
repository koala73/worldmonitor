import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { executeTool } from '../api/mcp/dispatch.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import Ajv2020 from 'ajv/dist/2020.js';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const YEAR = new Date().getUTCFullYear();
const UNHCR_KEY = `displacement:summary:v1:${YEAR}`;
const UNHCR_META = 'seed-meta:displacement:summary';
const IDU_KEY = 'displacement:idmc-idu:v1';
const IDU_META = 'seed-meta:displacement:idmc-idu';
const DTM_KEY = 'displacement:dtm:v1';
const DTM_META = 'seed-meta:displacement:dtm';
const DAY_MS = 86_400_000;
const tool = CACHE_TOOLS.find(t => t.name === 'get_displacement_data');
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const originalFetch = globalThis.fetch;
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));

// Shapes follow scripts/seed-dtm-displacement.mjs (the 2026-10-21 Sudan round).
const operation = (countryCode, operationName, totalIdps, overrides = {}) => ({
  countryCode, countryName: countryCode, operation: operationName, reportingDate: '2026-08-31', roundNumber: 12, totalIdps,
  reasons: [{ reason: 'Conflict', idps: totalIdps }],
  regions: [{ pcode: 'SD03', name: 'South Darfur', idps: 1765922, location: { latitude: 11.03, longitude: 24.55 } }],
  flows: [{
    originPcode: 'SD01', originName: 'Khartoum', destinationPcode: 'SD05', destinationName: 'East Darfur', idps: 352543,
    originLocation: { latitude: 15.86, longitude: 32.56 }, destinationLocation: { latitude: 11.05, longitude: 26.5 },
  }],
  ...overrides,
});
const operations = [
  operation('SDN', 'Armed Clashes in Sudan (Overview)', 8583274),
  ...Array.from({ length: 33 }, (_, i) => operation('COD', `Operation ${i}`, 1_000_000 - i)),
  operation('UKR', 'Displacement due to Conflict in Ukraine', 3858000),
];
const dtmSnapshot = { source: 'IOM DTM', lookbackFrom: '2025-04-01', operations };
const dtmMeta = (overrides = {}) => ({
  fetchedAt: NOW - 60_000, recordCount: operations.length, newestItemAt: NOW - 51 * DAY_MS, maxContentAgeMin: 129600, ...overrides,
});

let reads;
function seed(fixtures) {
  const state = installRedis(fixtures);
  reads = [];
  globalThis.fetch = async (input, init) => {
    reads.push(decodeURIComponent(String(input)) + (init?.body ? ` ${init.body}` : ''));
    return state.fetchImpl(input, init);
  };
}
const read = (key) => reads.some(r => r.includes(key));

const fixtures = () => ({
  [UNHCR_KEY]: { summary: { year: YEAR - 1, globalTotals: { total: 1 }, countries: [{ code: 'SDN' }], topFlows: [] } },
  [UNHCR_META]: { fetchedAt: NOW - 60_000, recordCount: 1 },
  [IDU_KEY]: { _seed: { fetchedAt: NOW - 60_000 }, data: { countries: [], events: [] } },
  [IDU_META]: { fetchedAt: NOW - 60_000, recordCount: 3833 },
  [DTM_KEY]: { _seed: { fetchedAt: NOW - 60_000 }, data: dtmSnapshot },
  [DTM_META]: dtmMeta(),
});

beforeEach(() => assert.ok(tool));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test('freshness for the regions view matches the health budget', () => {
  assert.deepEqual(tool._freshnessChecks.find(c => c.key === DTM_META), { key: DTM_META, maxStaleMin: 2880, minRecordCount: 15, honorContentAge: true });
});

test('view regions reads only the DTM snapshot, keeps whole operations and attributes IOM DTM', async () => {
  seed(fixtures());
  const result = await executeTool(tool, { view: 'regions' }, NOW);
  assert.equal(result.data.summary, undefined);
  assert.equal(result.data.iduEvents, undefined);
  assert.equal(read(UNHCR_KEY) || read(UNHCR_META) || read(IDU_KEY) || read(IDU_META), false);
  const data = result.data.dtmRegions;
  assert.equal(data.lookbackFrom, '2025-04-01');
  assert.equal(data.operations.length, 30, 'default limit caps operations');
  assert.equal(data.operations[0].operation, 'Armed Clashes in Sudan (Overview)');
  assert.equal(data.operations[0].flows[0].originName, 'Khartoum', 'regions and flows ride along whole');
  assert.equal(data.attribution.sourceUrl, 'https://dtm.iom.int/');
  assert.match(data.attribution.notice, /do not add/);
  assert.equal(result.stale, false);
  assert.equal(result.cached_at, new Date(NOW - 60_000).toISOString());
  assert.ok(ajv.validate(tool.outputSchema, result), ajv.errorsText());
});

test('limit 0 returns every operation; countries narrows by ISO3, ISO2 or name', async () => {
  seed(fixtures());
  assert.equal((await executeTool(tool, { view: 'regions', limit: 0 }, NOW)).data.dtmRegions.operations.length, operations.length);
  for (const filter of ['UKR', 'UA', 'Ukraine']) {
    const result = await executeTool(tool, { view: 'regions', countries: [filter] }, NOW);
    assert.deepEqual(result.data.dtmRegions.operations.map(op => op.countryCode), ['UKR'], filter);
  }
});

test('a missed seed or an old newest round marks only the regions view stale', async () => {
  seed({ ...fixtures(), [DTM_META]: dtmMeta({ fetchedAt: NOW - 3 * DAY_MS }) });
  assert.equal((await executeTool(tool, { view: 'regions' }, NOW)).stale, true);
  assert.equal((await executeTool(tool, {}, NOW)).stale, false);
  assert.equal((await executeTool(tool, { view: 'events' }, NOW)).stale, false);
  seed({ ...fixtures(), [DTM_META]: dtmMeta({ newestItemAt: NOW - 91 * DAY_MS }) });
  assert.equal((await executeTool(tool, { view: 'regions' }, NOW)).stale, true);
});

test('the other views never read the DTM snapshot', async () => {
  seed(fixtures());
  await executeTool(tool, {}, NOW);
  await executeTool(tool, { view: 'events' }, NOW);
  // No border feeds are seeded here, so the call may fail; only the reads matter.
  await executeTool(tool, { view: 'movements' }, NOW).catch(() => {});
  assert.equal(read(DTM_KEY) || read(DTM_META), false);
});

test('regions is a documented view', () => {
  tool._validateArgs({ view: 'regions' });
  assert.ok(tool.inputSchema.properties.view.enum.includes('regions'));
  assert.match(tool.description, /view=regions: IOM DTM/);
});
