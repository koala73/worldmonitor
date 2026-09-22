import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { consumeSubRequestAdmission, issueSubRequestAdmission, SUB_REQUEST_MARKER_HEADER } from '../server/_shared/sub-request-admission.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
const url = 'https://www.worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL';
const request = (target = url, key = 'test-key', method = 'GET') => new Request(target, {
  method, headers: { 'x-worldmonitor-key': key },
});
async function marked(original = request(), target = original) {
  const token = await issueSubRequestAdmission(original);
  assert.ok(token);
  const headers = new Headers(target.headers);
  headers.set(SUB_REQUEST_MARKER_HEADER, token);
  return new Request(target, { headers });
}
it('binds each admission to its URL, method and credentials', async () => {
  installRedis({});
  for (const changed of [request(url + 'X'), request(url, 'other'), request(url, 'test-key', 'POST')]) {
    assert.equal(await consumeSubRequestAdmission(await marked(request(), changed)), 'invalid');
  }
  assert.equal(await consumeSubRequestAdmission(await marked()), 'admitted');
});
it('consumes admission atomically across concurrent replay attempts', async () => {
  installRedis({});
  const outbound = await marked();
  const accepted = await Promise.all([consumeSubRequestAdmission(outbound), consumeSubRequestAdmission(outbound)]);
  assert.equal(accepted.filter(value => value === 'admitted').length, 1);
  assert.equal(accepted.filter(value => value === 'invalid').length, 1);
});
it('expires admissions and keeps credentials out of Redis', async () => {
  let now = 1000;
  const redis = installRedis({}, { now: () => now });
  const outbound = await marked();
  assert.ok([...redis.redis.values()].every(value => !value.includes('test-key')));
  now += 31_000;
  assert.equal(await consumeSubRequestAdmission(outbound), 'invalid');
});
it('does not grant admission when Redis is unavailable', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  assert.equal(await issueSubRequestAdmission(request()), null);
  const headers = new Headers(request().headers);
  headers.set(SUB_REQUEST_MARKER_HEADER, crypto.randomUUID());
  assert.equal(await consumeSubRequestAdmission(new Request(request(), { headers })), 'unavailable');
});

it('accepts router echoes and query ordering without ignoring caller data', async () => {
  installRedis({});
  assert.equal(await consumeSubRequestAdmission(await marked(request(), request(url + '&rpc=list-market-quotes'))), 'admitted');
  assert.equal(await consumeSubRequestAdmission(await marked(request(), request(url + '&rpc=other'))), 'invalid');
  assert.equal(await consumeSubRequestAdmission(await marked(request(url + '&rpc=other'), request(url + '&rpc=other&rpc=list-market-quotes'))), 'admitted');
  assert.equal(await consumeSubRequestAdmission(await marked(request(url + '#not-sent'), request())), 'admitted');
  const reordered = url.replace('?symbols=AAPL', '?lang=en&symbols=AAPL');
  assert.equal(await consumeSubRequestAdmission(await marked(request(url + '&lang=en'), request(reordered))), 'admitted');
});

it('never waives a principal bucket using an IP or different-scope admission', async () => {
  installRedis({});
  for (const charged of [null, 'api_key:user1', 'session:user2']) {
    const outbound = request();
    const token = await issueSubRequestAdmission(outbound, charged);
    assert.ok(token);
    outbound.headers.set(SUB_REQUEST_MARKER_HEADER, token);
    assert.equal(await consumeSubRequestAdmission(outbound, 'session:user1'), 'invalid');
  }
  const outbound = request();
  const token = await issueSubRequestAdmission(outbound, 'session:user1');
  assert.ok(token);
  outbound.headers.set(SUB_REQUEST_MARKER_HEADER, token);
  assert.equal(await consumeSubRequestAdmission(outbound, 'session:user1'), 'admitted');
});

it('accepts a principal-bound admission when a public inner route has no principal', async () => {
  installRedis({});
  const outbound = request();
  const token = await issueSubRequestAdmission(outbound, 'api_key:user1');
  assert.ok(token);
  outbound.headers.set(SUB_REQUEST_MARKER_HEADER, token);
  assert.equal(await consumeSubRequestAdmission(outbound), 'admitted');
});
