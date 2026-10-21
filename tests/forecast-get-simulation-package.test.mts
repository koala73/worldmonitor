import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function makeCtx() {
  return {
    request: new Request('https://worldmonitor.app/api/forecast/v1/get-simulation-package'),
    pathParams: {},
    headers: {},
  };
}

describe('getSimulationPackage response disclosure guard (#5213)', () => {
  let getSimulationPackage: typeof import('../server/worldmonitor/forecast/v1/get-simulation-package').getSimulationPackage;

  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    ({ getSimulationPackage } = await import('../server/worldmonitor/forecast/v1/get-simulation-package.ts'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  it('does not disclose the internal storage key in a successful public response', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      result: JSON.stringify({
        runId: '1734567890123-abc',
        pkgKey: 'seed-data/forecast-traces/2026/07/11/1734567890123-abc/simulation-package.json',
        schemaVersion: 'v1',
        theaterCount: 1,
        generatedAt: 1700000000000,
      }),
    }), { status: 200 })) as typeof fetch;

    const response = await getSimulationPackage(makeCtx(), { runId: '' });
    assert.equal(response.found, true);
    assert.ok(!('pkgKey' in response), 'public package response must not disclose its internal storage key');
  });
});
