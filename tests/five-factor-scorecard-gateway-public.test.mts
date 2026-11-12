import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const cases = [
  ['get-five-factor-scorecard', '?countryCode=US'],
  ['get-bloc-scorecard', '?members=US&members=CA'],
  ['list-five-factor-scorecards', ''],
] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

async function loadGateway() {
  installRedis({});
  const [{ createDomainGateway, serverOptions }, { createScorecardServiceRoutes }, { scorecardHandler }] = await Promise.all([
    import('../server/gateway.ts'),
    import('../src/generated/server/worldmonitor/scorecard/v1/service_server.ts'),
    import('../server/worldmonitor/scorecard/v1/handler.ts'),
  ]);
  return createDomainGateway(createScorecardServiceRoutes(scorecardHandler, serverOptions));
}

describe('five-factor scorecard public gateway', { concurrency: 1 }, () => {
  for (const [operation, query] of cases) {
    const path = `/api/scorecard/v1/${operation}`;

    it(`serves ${operation} without headers or cookies`, async () => {
      const gateway = await loadGateway();
      const response = await gateway(new Request(`https://api.worldmonitor.app${path}${query}`));
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).unavailable, true);
    });

    it(`fails closed for ${operation} when Redis is unavailable`, async () => {
      const gateway = await loadGateway();
      globalThis.fetch = async () => { throw new Error('Redis unavailable'); };
      const response = await gateway(new Request(`https://api.worldmonitor.app${path}${query}`));
      assert.equal(response.status, 503, await response.text());
      assert.equal(response.headers.get('X-RateLimit-Mode'), 'degraded');
    });
  }
});
