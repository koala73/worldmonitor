import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ as healthTesting } from '../api/health.js';
import { handleSeedHealth } from '../api/seed-health.js';

const NAME = 'fredRatesSeeder';
const META_KEY = 'seed-meta:economic:fred-rates';
const DEPLOYED_AT = Date.parse('2031-04-12T09:30:00Z');

test('FRED rates remains dark in public health before production pre-seed evidence', () => {
  assert.equal(Object.hasOwn(healthTesting.BOOTSTRAP_KEYS, NAME), false);
  assert.equal(Object.hasOwn(healthTesting.STANDALONE_KEYS, NAME), false);
  assert.equal(Object.hasOwn(healthTesting.SEED_META, NAME), false);
  assert.equal(Object.hasOwn(healthTesting.ACTIVATION_MARKERS, NAME), false);
  assert.equal(Object.hasOwn(healthTesting.RUNTIME_ROLLOUT_PENDING_POLICIES, NAME), false);
});

test('operator seed-health remains strict for partial and complete FRED coverage', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
  process.env.WORLDMONITOR_VALID_KEYS = 'fred-health-test-key';

  try {
    for (const [recordCount, expectedStatus] of [[18, 'coverage_partial'], [24, 'ok']]) {
      globalThis.fetch = async (_url, init) => {
        const commands = JSON.parse(init.body);
        const results = commands.map(([op, key]) => {
          if (op === 'EXISTS') return { result: 0 };
          if (op === 'GET' && key === META_KEY) {
            return { result: JSON.stringify({ fetchedAt: DEPLOYED_AT, recordCount }) };
          }
          if (op === 'GET') {
            return { result: JSON.stringify({ fetchedAt: DEPLOYED_AT, recordCount: 10_000 }) };
          }
          return { result: 'OK' };
        });
        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const response = await handleSeedHealth(new Request('https://api.worldmonitor.app/api/seed-health', {
        headers: { 'x-worldmonitor-key': 'fred-health-test-key' },
      }), { now: DEPLOYED_AT });
      const body = await response.json();
      const entry = body.seeds['economic:fred-rates'];
      assert.equal(entry.status, expectedStatus);
      assert.equal(entry.recordCount, recordCount);
      assert.equal(entry.minRecordCount, 24);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
