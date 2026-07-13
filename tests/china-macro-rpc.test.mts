import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getChinaMacroSnapshot } from '../server/worldmonitor/economic/v1/get-china-macro-snapshot';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
};

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function configureRedis() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.VERCEL_GIT_COMMIT_SHA;
}

describe('getChinaMacroSnapshot seeded RPC', () => {
  it('reads exactly the two canonical seed keys and never fans out to upstream providers', async () => {
    configureRedis();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      assert.deepEqual(JSON.parse(String(init?.body)), [
        ['GET', 'economic:china:macro:v1'],
        ['GET', 'economic:china:release-calendar:v1'],
      ]);
      return new Response(JSON.stringify([
        { result: JSON.stringify({
          countryCode: 'CN', generatedAt: '2026-07-13T00:00:00.000Z', status: 'ready', launchReady: true,
          contentObservationDate: '2026-05', latestObservationDate: '2026-07-10',
          indicators: [{ id: 'cpi_yoy', label: 'CPI (YoY)', category: 'price', value: 1, priorValue: 1.2, unit: '%', observationDate: '2026-06', source: 'OECD Data Explorer', sourceUrl: 'https://oecd.test', stale: false, unavailableReason: '', contextOnly: false }],
          sourceDecisions: [{ source: 'OECD Data Explorer', host: 'sdmx.oecd.org', status: 'accepted', reason: 'OK', checkedAt: '2026-07-13T00:00:00.000Z', optional: false, requestCount: 2 }],
        }) },
        { result: JSON.stringify({
          events: [{ id: 'pboc-lpr-2026-07', event: 'Loan Prime Rate (LPR)', countryCode: 'CN', releaseDate: '2026-07-20', releaseTime: '09:00', timezone: 'Asia/Shanghai', kind: 'pboc_lpr', status: 'provisional', source: 'PBoC rule; realized date verified by ChinaMoney/CFETS', sourceUrl: 'https://chinamoney.test' }],
          sourceDecisions: [{ source: 'PBoC/ChinaMoney LPR verification', host: 'www.chinamoney.com.cn', status: 'accepted', reason: 'OK', checkedAt: '2026-07-13T00:00:00.000Z', optional: false, requestCount: 1 }],
        }) },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await getChinaMacroSnapshot({} as never, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'https://redis.example.test/pipeline');
    assert.equal(response.launchReady, true);
    assert.equal(response.indicators[0]?.hasValue, true);
    assert.equal(response.indicators[0]?.hasPriorValue, true);
    assert.equal(response.releaseEvents[0]?.status, 'provisional');
    assert.equal(response.sourceDecisions.length, 2);
    assert.equal(response.unavailable, false);
  });

  it('returns an explicit unavailable envelope when the macro seed is missing', async () => {
    configureRedis();
    globalThis.fetch = (async () => new Response(JSON.stringify([{ result: null }, { result: null }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    const response = await getChinaMacroSnapshot({} as never, {});
    assert.equal(response.unavailable, true);
    assert.equal(response.launchReady, false);
    assert.deepEqual(response.indicators, []);
    assert.deepEqual(response.releaseEvents, []);
  });

  it('does not expose a partial snapshot when the release-calendar seed is missing', async () => {
    configureRedis();
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { result: JSON.stringify({
        countryCode: 'CN', status: 'ready', launchReady: true,
        indicators: [{ id: 'cpi_yoy', value: 1 }],
      }) },
      { result: null },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const response = await getChinaMacroSnapshot({} as never, {});
    assert.equal(response.unavailable, true);
    assert.equal(response.launchReady, false);
  });
});
