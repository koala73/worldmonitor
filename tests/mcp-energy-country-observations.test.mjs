import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { executeTool } from '../api/mcp/dispatch.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { buildCountriesPayload } from '../scripts/seed-gas-storage-countries.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildPublicTool } from '../api/mcp/registry/index.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const observations = Object.fromEntries(buildCountriesPayload([
  { iso2: 'DE', entries: [{ full: '57.92', gasInStorage: '143.4', gasDayStart: '2026-09-29' }] },
  { iso2: 'FR', entries: [{ full: '83.48', gasInStorage: '103.4', gasDayStart: '2026-09-29' }] },
]).map(row => [row.iso2, row]));
let snapshots;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://energy-fixture.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  const tool = CACHE_TOOLS.find(row => row.name === 'get_energy_intelligence');
  snapshots = new Map([
    ['energy:gas-storage:v1:_countries', ['DE', 'FR']],
    ['energy:gas-storage:v1:all', observations],
    ...tool._freshnessChecks.map(check => [check.key, { fetchedAt: Date.now(), recordCount: 2 }]),
  ]);
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://energy-fixture.test');
    const value = snapshots.get(decodeURIComponent(url.pathname.slice(5)));
    return Response.json({ result: value == null ? null : JSON.stringify(value) });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

it('returns country quantities and dates alongside the country index', async () => {
  const tool = CACHE_TOOLS.find(row => row.name === 'get_energy_intelligence');
  const result = await executeTool(tool, { dataset: ['gas-storage'], country: 'Germany' });
  assert.deepEqual(result.data._countries, ['DE']);
  assert.deepEqual(result.data['gas-storage'], { DE: observations.DE });
  assert.equal(result.data['gas-storage'].DE.fillPct, 57.92);
  assert.equal(result.data['gas-storage'].DE.gasTwh, 143.4);
  assert.equal(result.data['gas-storage'].DE.date, '2026-09-29');
  const validate = new Ajv2020({ allowUnionTypes: true, strict: false, validateFormats: false })
    .compile(buildPublicTool(tool, { compressDescriptions: true }).outputSchema);
  assert.ok(validate(result), JSON.stringify(validate.errors));
});

it('caps country observations and skips them for other dataset selections', async () => {
  const tool = CACHE_TOOLS.find(row => row.name === 'get_energy_intelligence');
  const capped = await executeTool(tool, { dataset: ['gas-storage'], limit: 1 });
  assert.deepEqual(Object.keys(capped.data['gas-storage']), ['DE']);
  assert.deepEqual(capped.data._countries, ['DE']);
  const full = await executeTool(tool, { dataset: ['gas-storage'], limit: 0 });
  assert.deepEqual(Object.keys(full.data['gas-storage']), ['DE', 'FR']);
  const other = await executeTool(tool, { dataset: ['electricity'] });
  assert.deepEqual(Object.keys(other.data), ['index']);
});

it('keeps missing observations unavailable instead of presenting an index as quantities', async () => {
  snapshots.delete('energy:gas-storage:v1:all');
  const tool = CACHE_TOOLS.find(row => row.name === 'get_energy_intelligence');
  const result = await executeTool(tool, { dataset: ['gas-storage'] });
  assert.equal(result.data['gas-storage'], null);
  assert.deepEqual(result.data._countries, ['DE', 'FR']);
});

it('returns no EU quantities when the requested country has no gas-storage coverage', async () => {
  const tool = CACHE_TOOLS.find(row => row.name === 'get_energy_intelligence');
  const result = await executeTool(tool, { dataset: ['gas-storage'], country: 'Japan' });
  assert.deepEqual(result.data['gas-storage'], {});
  assert.deepEqual(result.data._countries, []);
});
