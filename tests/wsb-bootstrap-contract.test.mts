import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import rpc from '../api/infrastructure/v1/[rpc].ts';
import intelligence from '../api/intelligence/v1/[rpc].ts';
import bootstrap from '../api/bootstrap.js';
import { issueSessionToken } from '../api/_session.js';
import worker from '../workers/api-cors-preflight/src/index.js';
const PATH = 'https://api.worldmonitor.app/api/infrastructure/v1/get-bootstrap-data';
const SEED = 'intelligence:wsb-tickers:v1';
const fixture = { tickers: [{ symbol: 'SYNTH', mentionCount: 12, uniquePosts: 3, totalScore: 40, avgUpvoteRatio: 0.8, subreddits: ['synthetic'], velocityScore: 25 }], fetchedAt: 1 };
async function setup(t: TestContext) {
  for (const [name, value] of Object.entries({
    IRAN_EVENTS_ENABLED: 'false', WM_SESSION_SECRET: 'bootstrap-contract-synthetic-secret-32',
    UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'fixture',
    VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'abcdef123456', BOOTSTRAP_R2_SHADOW_MEASURE: '0',
  })) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const rateRedis = createRedisFetch({});
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
  t.after(() => assert.ok(warnings.every(line => !line.includes('[rate-limit]')), warnings.join('\n')));
  const values = new Map<string, unknown>();
  const reads: string[] = [];
  const origins = new Set<string>();
  t.after(() => assert.ok([...origins].every(origin => origin === 'https://redis.test')));
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const origin = new URL(input instanceof Request ? input.url : String(input)).origin;
    origins.add(origin);
    assert.equal(origin, 'https://redis.test');
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path.startsWith('/get/')) {
      const key = decodeURIComponent(path.slice(5)); reads.push(key);
      return Response.json({ result: values.has(key) ? JSON.stringify(values.get(key)) : null });
    }
    const commands = JSON.parse(String(init?.body));
    if (!Array.isArray(commands[0]) || commands.some(([op]: string[]) => op !== 'GET')) {
      return rateRedis.fetchImpl(input, init);
    }
    return Response.json(commands.map(([op, key]: string[]) => {
      if (op !== 'GET') return { result: 1 };
      reads.push(key);
      return { result: values.has(key) ? JSON.stringify(values.get(key)) : null };
    }));
  });
  const token = (await issueSessionToken()).token;
  const request = (query: string) => rpc(new Request(PATH + query, { headers: { 'X-WorldMonitor-Key': token, Origin: 'https://worldmonitor.app' } }));
  return { values, reads, request, token };
}



test('public WSB bootstrap denies anonymous callers and sessions cannot read its seed', async t => {
  const { values, reads, request, token } = await setup(t); values.set(SEED, fixture);
  const url = 'https://api.worldmonitor.app/api/bootstrap?keys=wsbTickers&public=1';
  const response = await bootstrap(new Request(url));
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /SYNTH/);
  const legacy = await bootstrap(new Request(url, { headers: { 'X-WorldMonitor-Key': token } }));
  assert.doesNotMatch(await legacy.text(), /SYNTH/);
  const rpcResponse = await request('?keys=wsbTickers');
  assert.doesNotMatch(await rpcResponse.text(), /SYNTH/);
  assert.ok(!reads.includes(SEED));
});

test('Worker blocks retired WSB bootstrap before any cached origin read', async t => {
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => { reads++; return Response.json({ data: { wsbTickers: fixture } }); });
  for (const query of ['?keys=wsbTickers&public=1', '?keys=wsbTickers', '?keys=insights,wsbTickers&public=1', '?keys=%20wsbTickers%20&public=1', '?keys=insights&keys=wsbTickers&public=1']) {
    const response = await worker.fetch(new Request('https://api.worldmonitor.app/api/bootstrap' + query), {}, {});
    assert.equal(response.status, 401); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(await response.text(), /SYNTH/);
  }
  assert.equal(reads, 0);
});

test('retired WSB bootstrap permits preflight but rejects GET without reading origin', async t => {
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => { reads++; return Response.json({ data: { wsbTickers: fixture } }); });
  const url = 'https://api.worldmonitor.app/api/bootstrap?keys=wsbTickers';
  const origin = 'https://worldmonitor.app';
  const preflight = await worker.fetch(new Request(url, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-WorldMonitor-Key' },
  }), {}, {});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers') || '', /X-WorldMonitor-Key/i);
  const response = await worker.fetch(new Request(url, { headers: { Origin: origin, 'X-WorldMonitor-Key': 'synthetic' } }), {}, {});
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.doesNotMatch(await response.text(), /SYNTH/);
  assert.equal(reads, 0);
});

test('WSB RPC rejects public callers and serves enterprise callers without shared caching', async t => {
  const { values, reads, token } = await setup(t);
  values.set(SEED, fixture);
  const endpoint = 'https://api.worldmonitor.app/api/intelligence/v1/list-wsb-tickers';
  for (const headers of [{}, { 'X-WorldMonitor-Key': token }]) {
    const response = await intelligence(new Request(endpoint, { headers }));
    assert.ok([401, 403].includes(response.status));
    assert.doesNotMatch(await response.text(), /SYNTH/);
  }
  assert.ok(!reads.includes(SEED));
  const previous = process.env.WORLDMONITOR_VALID_KEYS;
  process.env.WORLDMONITOR_VALID_KEYS = 'synthetic-enterprise-wsb';
  t.after(() => { if (previous === undefined) delete process.env.WORLDMONITOR_VALID_KEYS; else process.env.WORLDMONITOR_VALID_KEYS = previous; });
  const response = await intelligence(new Request(endpoint, { headers: { 'X-WorldMonitor-Key': 'synthetic-enterprise-wsb' } }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Cache-Control') || '', /no-store/);
  assert.deepEqual((await response.json()).tickers, fixture.tickers.map(({ symbol, mentionCount, totalScore, subreddits, velocityScore }) => ({ symbol, mentionCount, totalScore, subreddits, velocityScore })));
  assert.ok(reads.includes(SEED));
});
