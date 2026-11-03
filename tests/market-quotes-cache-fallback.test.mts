import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import marketGateway from '../api/market/v1/[rpc].ts';
import { __resetRateLimitForTest } from '../api/_rate-limit.js';
import { issueSessionToken } from '../api/_session.js';

const originalEnv = { ...process.env };
const seed = {
  quotes: [{ symbol: 'AAPL', name: 'Apple', display: 'AAPL', price: 100, change: 1, sparkline: [] }],
  finnhubSkipped: false, skipReason: '', rateLimited: false, unavailableSymbols: [], asOf: '2026-09-11T00:00:00Z',
};
let snapshot: unknown;
let seedFails: boolean;
let limiterDecisions: number;
let unexpectedFetches: string[];

beforeEach(() => {
  __resetRateLimitForTest();
  snapshot = seed;
  seedFails = false;
  limiterDecisions = 0;
  unexpectedFetches = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-token';
  process.env.WM_SESSION_SECRET = 'synthetic-market-cache-session-secret';
  process.env.FINNHUB_API_KEY = 'synthetic-finnhub-key';
  delete process.env.ALPHA_VANTAGE_API_KEY;
  delete process.env.LOCAL_API_MODE;
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://redis.test/get/market%3Astocks-bootstrap%3Av1' || url === 'https://redis.test/get/market:stocks-bootstrap:v1') {
      return new Response(JSON.stringify(seedFails ? { error: 'seed read failed' } : { result: snapshot == null ? null : JSON.stringify(snapshot) }), { status: seedFails ? 500 : 200 });
    }
    if (url === 'https://redis.test/pipeline') {
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      return new Response(JSON.stringify(commands.map((command) => {
        assert.match(String(command[0]).toUpperCase(), /^EVAL(SHA)?$/);
        limiterDecisions++;
        return { result: [1, 1] };
      })));
    }
    unexpectedFetches.push(url);
    throw new Error(`unexpected fetch: ${url}`);
  });
});
afterEach(() => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

async function request(symbols = 'AAPL') {
  const { token } = await issueSessionToken();
  return marketGateway(new Request(`https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=${encodeURIComponent(symbols)}&_debug=1`, {
    headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
  }));
}
function assertPrivateCache(response: Response) {
  assert.equal(response.headers.get('X-Cache-Tier'), 'slow-browser');
  assert.match(response.headers.get('Cache-Control') ?? '', /private.*max-age=300/);
  assert.equal(response.headers.get('CDN-Cache-Control'), null);
  assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), null);
}

describe('market seed fallback cache policy through authenticated gateway', () => {
  for (const mode of ['miss', 'empty', 'corrupt', 'error'] as const) {
    it(`${mode} is no-store without provider fan-out and recovers normally`, async () => {
      snapshot = mode === 'miss' ? null : mode === 'empty' ? { quotes: [] } : mode === 'corrupt' ? { quotes: 'invalid' } : seed;
      seedFails = mode === 'error';
      const warnings = mock.method(console, 'warn', () => {});
      const errors = mock.method(console, 'error', () => {});
      const response = await request();
      assert.equal(response.status, 200);
      assert.equal((await response.json()).unavailableSymbols[0].reason, 'MARKET_QUOTE_UNAVAILABLE_REASON_SEED_UNAVAILABLE');
      assert.ok(limiterDecisions > 0);
      assert.deepEqual(unexpectedFetches, [], 'no provider calls on unavailable seed');
      assert.doesNotMatch([...warnings.mock.calls, ...errors.mock.calls].flatMap(c => c.arguments).join(' '), /\[rate-limit\]/);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('X-Cache-Tier'), 'no-store');
      assert.equal(response.headers.get('CDN-Cache-Control'), null);
      assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), null);
      assert.equal(response.headers.get('X-No-Cache'), null);
      const previousDecisions = limiterDecisions;
      snapshot = seed;
      seedFails = false;
      const recovered = await request();
      assert.equal(recovered.status, 200);
      assert.deepEqual((await recovered.json()).quotes, seed.quotes);
      assertPrivateCache(recovered);
      assert.ok(limiterDecisions > previousDecisions);
      assert.deepEqual(unexpectedFetches, []);
      assert.doesNotMatch([...warnings.mock.calls, ...errors.mock.calls].flatMap(c => c.arguments).join(' '), /\[rate-limit\]/);
    });
  }
  it('marks a missing default seed no-store even without unavailable-symbol entries', async () => {
    snapshot = null;
    const warnings = mock.method(console, 'warn', () => {});
    const errors = mock.method(console, 'error', () => {});
    const response = await request('');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.quotes, []);
    assert.deepEqual(body.unavailableSymbols, []);
    assert.ok(limiterDecisions > 0);
    assert.deepEqual(unexpectedFetches, []);
    assert.doesNotMatch([...warnings.mock.calls, ...errors.mock.calls].flatMap(c => c.arguments).join(' '), /\[rate-limit\]/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('CDN-Cache-Control'), null);
    assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), null);
  });
  it('preserves cache policy for a healthy seed filtered to an unsupported provider symbol', async () => {
    const response = await request('^NOSUCH');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.quotes, []);
    assert.equal(body.unavailableSymbols[0].reason, 'MARKET_QUOTE_UNAVAILABLE_REASON_NOT_FOUND');
    assertPrivateCache(response);
    assert.deepEqual(unexpectedFetches, []);
    assert.ok(limiterDecisions > 0);
  });
});
