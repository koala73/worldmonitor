// /api/seed-health must agree with /api/health on the reservoir levels rollout: the row is
// pending (not degraded) until the seeder's activation marker exists, and coverage is
// partial when a watchlist reservoir drops out of the record count.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const originalFetch = globalThis.fetch;
const originalEnv = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
};
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
process.env.WORLDMONITOR_VALID_KEYS = 'test-key';

const { handleSeedHealth } = await import('../api/seed-health.js');
const { RESERVOIR_LEVELS_ACTIVATION_KEY } = await import('../scripts/seed-reservoir-levels.mjs');

const NOW = Date.parse('2026-11-12T00:00:00.000Z');
const META_KEY = 'seed-meta:climate:reservoir-levels';
const wl = JSON.parse(readFileSync(new URL('../scripts/data/strategic-reservoirs.json', import.meta.url), 'utf8'));
const WATCHLIST_SIZE = (Array.isArray(wl) ? wl : wl.reservoirs).length;

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function installRedisMock({ activated, meta }) {
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map(([operation, key]) => {
      if (operation === 'EXISTS') return { result: key === RESERVOIR_LEVELS_ACTIVATION_KEY && activated ? 1 : 0 };
      if (key === META_KEY) return { result: meta == null ? null : JSON.stringify(meta) };
      return { result: JSON.stringify({ fetchedAt: NOW, recordCount: 10_000 }) };
    });
    return new Response(JSON.stringify(results), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

async function readEntry() {
  const response = await handleSeedHealth(new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  }), { now: NOW });
  return (await response.json()).seeds['climate:reservoir-levels'];
}

test('reservoir levels stay pending before the first publication', async () => {
  installRedisMock({ activated: false, meta: null });
  const entry = await readEntry();
  assert.equal(entry.status, 'pending-activation');
  assert.equal(entry.stale, false);
});

test('reservoir levels are missing once the marker exists and meta is gone', async () => {
  installRedisMock({ activated: true, meta: null });
  assert.notEqual((await readEntry()).status, 'pending-activation');
});

test('reservoir levels read ok at full watchlist coverage and partial below it', async () => {
  installRedisMock({ activated: true, meta: { fetchedAt: NOW - 60_000, recordCount: WATCHLIST_SIZE } });
  assert.equal((await readEntry()).status, 'ok');
  installRedisMock({ activated: true, meta: { fetchedAt: NOW - 60_000, recordCount: WATCHLIST_SIZE - 1 } });
  assert.equal((await readEntry()).status, 'coverage_partial');
});
