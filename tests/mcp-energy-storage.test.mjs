import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

import handler from '../api/mcp.ts';
import { executeTool } from '../api/mcp/dispatch.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { buildPublicTool } from '../api/mcp/registry/index.ts';
import { buildEuGasStoragePayload } from '../scripts/seed-gie-gas-storage.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const keys = ['economic:eu-gas-storage:v1', 'economic:nat-gas-storage:v1', 'economic:crude-inventories:v1'];
const STORAGE = ['eu-gas-storage', 'nat-gas-storage', 'crude-inventories'];
const tool = () => {
  const found = CACHE_TOOLS.find(candidate => candidate.name === 'get_energy_intelligence');
  assert.ok(found, 'get_energy_intelligence must be callable');
  return found;
};
const storage = (args = {}) => executeTool(tool(), { dataset: STORAGE, ...args });
const mcpCall = (name, args, headers = { 'X-WorldMonitor-Key': 'wm_storage_fixture' }) => handler(new Request('https://worldmonitor.app/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
}));

let snapshots;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://storage-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.WORLDMONITOR_VALID_KEYS = 'wm_storage_fixture';
  const now = Date.now();
  snapshots = new Map([
    [keys[0], buildEuGasStoragePayload([
      { gasDayStart: '2026-09-28', full: 82, gasInStorage: 880 },
      { gasDayStart: '2026-09-27', full: 81, gasInStorage: 870 },
    ])],
    [keys[1], { latestPeriod: '2026-09-25', weeks: [
      { period: '2026-09-25', storBcf: 3100, weeklyChangeBcf: 0 },
      { period: '2026-09-18', storBcf: 3100, weeklyChangeBcf: null },
    ] }],
    [keys[2], { latestPeriod: '2026-09-25', weeks: [
      { period: '2026-09-25', stocksMb: 420, weeklyChangeMb: -2 },
      { period: '2026-09-18', stocksMb: 422, weeklyChangeMb: null },
    ] }],
    ...tool()._freshnessChecks.map(check => [check.key, { fetchedAt: now, recordCount: 2 }]),
  ]);
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://storage-redis.test', 'this tool must not contact a provider');
    assert.ok(url.pathname.startsWith('/get/'));
    const value = snapshots.get(decodeURIComponent(url.pathname.slice(5)));
    return Response.json({ result: value == null ? null : JSON.stringify(value) });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe('energy storage observations on get_energy_intelligence', () => {
  it('returns dated EU and US observations accepted by the advertised schema', async () => {
    const result = await storage();
    assert.deepEqual(Object.keys(result.data).sort(), [...STORAGE].sort());
    assert.equal(result.data['eu-gas-storage'].fillPct, 82);
    assert.equal(result.data['nat-gas-storage'].weeks[0].storBcf, 3100);
    assert.equal(result.data['crude-inventories'].weeks[0].stocksMb, 420);
    assert.equal(result.stale, false);
    const ajv = new Ajv2020({ allowUnionTypes: true, strict: true, strictRequired: false, validateFormats: false });
    const validate = ajv.compile(buildPublicTool(tool(), { compressDescriptions: true }).outputSchema.anyOf[0]);
    assert.ok(validate(result), JSON.stringify(validate.errors));
  });

  it('selects only the requested dataset and caps newest-first history', async () => {
    const result = await storage({ dataset: ['eu-gas-storage'], limit: 1 });
    assert.deepEqual(Object.keys(result.data), ['eu-gas-storage']);
    assert.deepEqual(result.data['eu-gas-storage'].history.map(row => row.date), ['2026-09-28']);
    assert.equal(snapshots.get(keys[0]).history.length, 2, 'filtering must not change stored observations');
  });

  it('preserves zero changes and unknown changes separately', async () => {
    const result = await storage({ dataset: ['nat-gas-storage'], limit: 0 });
    assert.equal(result.data['nat-gas-storage'].weeks[0].weeklyChangeBcf, 0);
    assert.equal(result.data['nat-gas-storage'].weeks[1].weeklyChangeBcf, null);
  });

  it('caps each history by default and permits the full seeded history with limit zero', async () => {
    snapshots.get(keys[0]).history = Array.from({ length: 40 }, (_, i) => ({
      date: `observation-${i}`, fillPct: 82 - i / 10, gasTwh: 880 - i,
    }));
    assert.equal((await storage()).data['eu-gas-storage'].history.length, 30);
    assert.equal((await storage({ limit: 0 })).data['eu-gas-storage'].history.length, 40);
    const capped = await storage({ limit: 1 });
    assert.equal(capped.data['nat-gas-storage'].weeks.length, 1);
    assert.equal(capped.data['crude-inventories'].weeks.length, 1);
  });

  it('retains a missing dataset as null while serving other sources', async () => {
    snapshots.delete(keys[0]);
    const result = await storage();
    assert.equal(result.data['eu-gas-storage'], null);
    assert.equal(result.data['crude-inventories'].weeks.length, 2);
  });

  it('reports missing storage sources as null and stale, never as invented quantities', async () => {
    keys.forEach(key => { snapshots.delete(key); snapshots.delete(`seed-meta:${key.replace(/:v1$/, '')}`); });
    snapshots.set('energy:eia-petroleum:v1', { WCESTUS1: { current: 420, previous: 422, date: '2026-09-25', unit: 'MBBL' } });
    const result = await storage();
    assert.deepEqual(result.data, { 'eu-gas-storage': null, 'nat-gas-storage': null, 'crude-inventories': null });
    assert.equal(result.stale, true);
    snapshots.delete('energy:eia-petroleum:v1');
    await assert.rejects(storage(), /cache_all_null/, 'a bundle with no readable source at all is still a tool error');
  });

  it('marks expired or missing seed timestamps stale', async () => {
    snapshots.set('seed-meta:economic:eu-gas-storage', { fetchedAt: Date.now() - 49 * 60 * 60 * 1000 });
    assert.equal((await storage()).stale, true);
    snapshots.delete('seed-meta:economic:eu-gas-storage');
    const missing = await storage();
    assert.equal(missing.stale, true);
    assert.equal(missing.cached_at, null);
  });

  it('serves structured content through tools/call', async () => {
    const response = await mcpCall('get_energy_intelligence', { dataset: ['crude-inventories'], limit: 1 });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.equal(body.result?.isError, undefined, JSON.stringify(body));
    assert.equal(body.result.structuredContent.data['crude-inventories'].weeks[0].stocksMb, 420);
    assert.equal(body.result.structuredContent.data['crude-inventories'].weeks.length, 1);
  });

  it('keeps the retired get_energy_storage name working with a deprecation notice', async () => {
    const body = await (await mcpCall('get_energy_storage', { dataset: ['crude-inventories'], limit: 1 })).json();
    assert.equal(body.result?.isError, undefined, JSON.stringify(body));
    const content = body.result.structuredContent;
    assert.deepEqual(Object.keys(content.data), ['crude-inventories']);
    assert.equal(content.data['crude-inventories'].weeks[0].stocksMb, 420);
    assert.equal(content.deprecation.replacement, 'get_energy_intelligence');
    const omitted = (await (await mcpCall('get_energy_storage', {})).json()).result.structuredContent;
    assert.deepEqual(Object.keys(omitted.data).sort(), [...STORAGE].sort(), 'an omitted dataset still means all three storage series');
  });

  it('rejects a retired-name dataset the old tool never served', async () => {
    const body = await (await mcpCall('get_energy_storage', { dataset: ['electricity'] })).json();
    assert.match(JSON.stringify(body), /dataset must be one or more of eu-gas-storage, nat-gas-storage, crude-inventories/);
    assert.equal(body.result?.structuredContent?.data, undefined);
  });

  it('requires authentication for the storage observations', async () => {
    const response = await mcpCall('get_energy_intelligence', {}, {});
    assert.equal(response.status, 401);
  });
});
