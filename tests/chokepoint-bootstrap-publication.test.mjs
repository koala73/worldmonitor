import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import handler from '../api/bootstrap.js';
import { assembleBootstrapTierPayload } from '../scripts/publish-bootstrap-tiers.mjs';

const capture = JSON.parse(readFileSync(new URL('./fixtures/chokepoints-routing-advice-2026-09-10.json', import.meta.url), 'utf8'));

test('bootstrap origin and tier publisher withhold legacy advice without changing risk observations', async () => {
  const originalFetch = globalThis.fetch;
  const keys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
  const originalEnv = keys.map(key => process.env[key]);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  const fetchFn = async (input, init) => {
    assert.equal(String(input), 'https://redis.test/pipeline');
    const commands = JSON.parse(init.body);
    return Response.json(commands.map(([command, key]) => {
      assert.equal(command, 'GET');
      return { result: key === 'supply_chain:chokepoints:v4' ? JSON.stringify(capture.body) : null };
    }));
  };
  globalThis.fetch = fetchFn;
  try {
    const response = await handler(new Request('https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1'));
    assert.equal(response.status, 200);
    const origin = await response.json();
    const published = await assembleBootstrapTierPayload({ chokepoints: 'supply_chain:chokepoints:v4' }, { fetchFn });
    const expected = structuredClone(capture.body);
    for (const cp of expected.chokepoints) Object.assign(cp.transitSummary, { riskSummary: '', riskReportAction: '' });
    assert.deepEqual(origin.data.chokepoints, expected);
    assert.deepEqual(published.data.chokepoints, expected);
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => {
      if (originalEnv[index] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[index];
    });
  }
});
