import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { __testing__ } from '../api/health.js';
import { handleSeedHealth } from '../api/seed-health.js';
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
const now = Date.parse('2026-10-19T12:00:00Z');
after(() => {
  globalThis.fetch = savedFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

async function health(activated, age = 1) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
  globalThis.fetch = async (_input, init) => Response.json(JSON.parse(init.body).map(([op, key]) => {
    if (op === 'EXISTS') return { result: activated ? 1 : 0 };
    return { result: key.startsWith('seed-meta:displacement:border-')
      ? activated ? JSON.stringify({ fetchedAt: now - age * 60000, recordCount: 1 }) : null
      : JSON.stringify({ fetchedAt: now, recordCount: 10000 }) };
  }));
  const response = await handleSeedHealth(new Request('https://api.worldmonitor.app/api/seed-health', { headers: { 'X-WorldMonitor-Key': 'test-key' } }), { now });
  return response.json();
}

test('new source health stays pending before activation and follows the same 48-hour fetch budget on both health endpoints', async () => {
  const pending = await health(false);
  const fresh = await health(true, 2880);
  const stale = await health(true, 2881);
  for (const [id, name] of [['uk', 'borderUk'], ['cbp', 'borderCbp'], ['frontex', 'borderFrontex'], ['panama', 'borderPanama']]) {
    assert.equal(__testing__.STANDALONE_KEYS[name], `displacement:border-${id}:v1`);
    assert.equal(__testing__.SEED_META[name].maxStaleMin, 2880);
    assert.equal(pending.seeds[`displacement:border-${id}`].status, 'pending-activation');
    assert.equal(fresh.seeds[`displacement:border-${id}`].stale, false);
    assert.equal(stale.seeds[`displacement:border-${id}`].stale, true);
  }
});
