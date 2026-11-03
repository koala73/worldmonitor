import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { executeTool } from '../api/mcp/dispatch.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import Ajv2020 from 'ajv/dist/2020.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const YEAR = new Date().getUTCFullYear();
const UNHCR_KEY = `displacement:summary:v1:${YEAR}`;
const UNHCR_META = 'seed-meta:displacement:summary';
const IDU_KEY = 'displacement:idmc-idu:v1';
const IDU_META = 'seed-meta:displacement:idmc-idu';
const tool = CACHE_TOOLS.find(t => t.name === 'get_displacement_data');
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const originalFetch = globalThis.fetch;
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));

const event = (id, countryCode, overrides = {}) => ({
  id, countryCode, countryName: countryCode, displacementType: 'Disaster', figure: 100, qualifier: 'total',
  displacementDate: '2026-10-01', startDate: '2026-10-01', endDate: '2026-10-01', eventId: '9', eventName: 'Storm',
  category: 'Weather related', hazardType: 'Storm', locationName: 'Somewhere', locationAccuracy: 'ADM1',
  sources: 'Agency', createdAt: '2026-10-02', location: { latitude: 1, longitude: 2 }, ...overrides,
});
const country = (countryCode, displaced30d, surge = false) => ({
  countryCode, countryName: countryCode, displaced30d, conflict30d: 0, disaster30d: displaced30d, events30d: 1,
  newlyReported7d: 0, latestDisplacementDate: '2026-10-01', baselineMonthly: 100, surge,
});
const iduSnapshot = {
  source: 'IDMC Internal Displacement Updates (via HDX)',
  windowFrom: '2026-04-24',
  missingCountries: [],
  countries: [country('PHL', 759032, true), country('ETH', 150009, true), country('SDN', 0)],
  events: [
    ...Array.from({ length: 150 }, (_, i) => event(`p${i}`, 'PHL')),
    event('s1', 'SDN', { displacementType: 'Conflict' }),
  ],
};
const unhcrSummary = { summary: { year: YEAR - 1, globalTotals: { total: 1 }, countries: [{ code: 'SDN' }], topFlows: [] } };

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
  [UNHCR_KEY]: unhcrSummary,
  [UNHCR_META]: { fetchedAt: NOW - 60_000, recordCount: 1 },
  [IDU_KEY]: { _seed: { fetchedAt: NOW - 60_000 }, data: iduSnapshot },
  [IDU_META]: { fetchedAt: NOW - 60_000, recordCount: 3833 },
});

beforeEach(() => assert.ok(tool));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test('freshness for the events view matches the health budget', () => {
  assert.deepEqual(tool._freshnessChecks.find(c => c.key === IDU_META), { key: IDU_META, maxStaleMin: 2880, minRecordCount: 500 });
});

test('the default annual view never reads the IDMC snapshot', async () => {
  seed(fixtures());
  const result = await executeTool(tool, {}, NOW);
  assert.equal(result.data.iduEvents, undefined);
  assert.equal(result.data.summary.year, YEAR - 1);
  assert.equal(read(IDU_KEY) || read(IDU_META), false);
  assert.equal(result.stale, false);
});

test('view events reads only the IDMC snapshot, caps events at the default limit and attributes IDMC', async () => {
  seed(fixtures());
  const result = await executeTool(tool, { view: 'events' }, NOW);
  assert.equal(result.data.summary, undefined);
  assert.equal(read(UNHCR_KEY) || read(UNHCR_META), false);
  const data = result.data.iduEvents;
  assert.deepEqual(data.countries.map(c => c.countryCode), ['PHL', 'ETH', 'SDN']);
  assert.equal(data.events.length, 30);
  assert.equal(data.events[0].sources, 'Agency', 'MCP keeps the full IDMC row');
  assert.equal(data.attribution.license, 'CC BY-IGO');
  assert.equal(result.stale, false);
  assert.equal(result.cached_at, new Date(NOW - 60_000).toISOString());
  assert.ok(ajv.validate(tool.outputSchema, result), ajv.errorsText());
});

test('limit 0 still caps events at 100; countries narrows both lists', async () => {
  seed(fixtures());
  const all = await executeTool(tool, { view: 'events', limit: 0 }, NOW);
  assert.equal(all.data.iduEvents.events.length, 100);
  assert.equal(all.data.iduEvents.countries.length, 3);
  const sudan = await executeTool(tool, { view: 'events', countries: ['Sudan'] }, NOW);
  assert.deepEqual(sudan.data.iduEvents.countries.map(c => c.countryCode), ['SDN']);
  assert.deepEqual(sudan.data.iduEvents.events.map(e => e.id), ['s1']);
});

test('a stale IDMC seed marks only the events view stale', async () => {
  seed({ ...fixtures(), [IDU_META]: { fetchedAt: NOW - 3 * 86_400_000, recordCount: 3833 } });
  assert.equal((await executeTool(tool, { view: 'events' }, NOW)).stale, true);
  assert.equal((await executeTool(tool, {}, NOW)).stale, false);
});

test('the movements view never reads the IDMC snapshot', async () => {
  seed(fixtures());
  // No border feeds are seeded here, so the call may fail; only the reads matter.
  await executeTool(tool, { view: 'movements' }, NOW).catch(() => {});
  assert.ok(reads.length > 0);
  assert.equal(read(IDU_KEY) || read(IDU_META), false);
});

test('an unknown view is rejected; the three documented views pass', () => {
  assert.throws(() => tool._validateArgs({ view: 'monthly' }), (err) => err.violations?.[0]?.field === 'view');
  for (const view of ['annual', 'movements', 'events']) tool._validateArgs({ view });
  tool._validateArgs({});
});
