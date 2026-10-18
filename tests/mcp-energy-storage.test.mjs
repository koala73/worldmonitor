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
const tool = () => {
  const found = CACHE_TOOLS.find(candidate => candidate.name === 'get_energy_storage');
  assert.ok(found, 'get_energy_storage must be callable');
  return found;
};

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
    ...keys.map(key => [`seed-meta:${key.replace(/:v1$/, '')}`, { fetchedAt: now, recordCount: 2 }]),
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

describe('energy storage MCP workflow', () => {
  it('returns dated EU and US observations accepted by the advertised schema', async () => {
    const result = await executeTool(tool());
    assert.equal(result.data['eu-gas-storage'].fillPct, 82);
    assert.equal(result.data['nat-gas-storage'].weeks[0].storBcf, 3100);
    assert.equal(result.data['crude-inventories'].weeks[0].stocksMb, 420);
    assert.equal(result.stale, false);
    const ajv = new Ajv2020({ allowUnionTypes: true, strict: true, strictRequired: false, validateFormats: false });
    const validate = ajv.compile(buildPublicTool(tool(), { compressDescriptions: true }).outputSchema.anyOf[0]);
    assert.ok(validate(result), JSON.stringify(validate.errors));
  });

  it('selects only the requested dataset and caps newest-first history', async () => {
    const result = await executeTool(tool(), { dataset: ['eu-gas-storage'], limit: 1 });
    assert.deepEqual(Object.keys(result.data), ['eu-gas-storage']);
    assert.deepEqual(result.data['eu-gas-storage'].history.map(row => row.date), ['2026-09-28']);
    assert.equal(snapshots.get(keys[0]).history.length, 2, 'filtering must not change stored observations');
  });

  it('preserves zero changes and unknown changes separately', async () => {
    const result = await executeTool(tool(), { dataset: ['nat-gas-storage'], limit: 0 });
    assert.equal(result.data['nat-gas-storage'].weeks[0].weeklyChangeBcf, 0);
    assert.equal(result.data['nat-gas-storage'].weeks[1].weeklyChangeBcf, null);
  });

  it('caps each history by default and permits the full seeded history with limit zero', async () => {
    snapshots.get(keys[0]).history = Array.from({ length: 40 }, (_, i) => ({
      date: `observation-${i}`, fillPct: 82 - i / 10, gasTwh: 880 - i,
    }));
    assert.equal((await executeTool(tool())).data['eu-gas-storage'].history.length, 30);
    assert.equal((await executeTool(tool(), { limit: 0 })).data['eu-gas-storage'].history.length, 40);
    const capped = await executeTool(tool(), { limit: 1 });
    assert.equal(capped.data['nat-gas-storage'].weeks.length, 1);
    assert.equal(capped.data['crude-inventories'].weeks.length, 1);
  });

  it('retains a missing dataset as null while serving other sources', async () => {
    snapshots.delete(keys[0]);
    const result = await executeTool(tool());
    assert.equal(result.data['eu-gas-storage'], null);
    assert.equal(result.data['crude-inventories'].weeks.length, 2);
  });

  it('rejects all-missing sources instead of returning invented quantities', async () => {
    keys.forEach(key => snapshots.delete(key));
    await assert.rejects(executeTool(tool()), /cache_all_null/);
  });

  it('marks expired or missing seed timestamps stale', async () => {
    snapshots.set('seed-meta:economic:eu-gas-storage', { fetchedAt: Date.now() - 49 * 60 * 60 * 1000 });
    assert.equal((await executeTool(tool())).stale, true);
    snapshots.delete('seed-meta:economic:eu-gas-storage');
    const missing = await executeTool(tool());
    assert.equal(missing.stale, true);
    assert.equal(missing.cached_at, null);
  });

  it('rejects invalid selectors and limits instead of serving an unfiltered response', async () => {
    for (const args of [{ dataset: ['other'] }, { dataset: 'eu-gas-storage' }, { limit: -1 }, { limit: 1.5 }]) {
      await assert.rejects(executeTool(tool(), args), error => error.name === 'RpcValidationError');
    }
  });

  it('serves structured content through tools/call', async () => {
    const response = await handler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'wm_storage_fixture' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'get_energy_storage', arguments: { dataset: ['crude-inventories'], limit: 1 },
      } }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.equal(body.result?.isError, undefined, JSON.stringify(body));
    assert.equal(body.result.structuredContent.data['crude-inventories'].weeks[0].stocksMb, 420);
    assert.equal(body.result.structuredContent.data['crude-inventories'].weeks.length, 1);
  });

  it('requires authentication for the storage tool', async () => {
    const response = await handler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'get_energy_storage', arguments: {},
      } }),
    }));
    assert.equal(response.status, 401);
  });
});
