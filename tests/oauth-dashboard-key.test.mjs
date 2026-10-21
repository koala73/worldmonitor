import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import handler from '../api/oauth/authorize.js';
import tokenEndpoint from '../api/oauth/token.ts';
import { resolveBearerToContext } from '../api/_oauth-token.js';
import { sha256Hex } from '../api/_crypto.js';

const key = `wm_${'b'.repeat(40)}`;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let store;
let validation;
let convexCalls;
let rateCount;
beforeEach(() => {
  store = new Map();
  validation = { userId: 'user_dashboard' };
  convexCalls = 0;
  rateCount = 1;
  Object.assign(process.env, {
    UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'fake',
    CONVEX_SITE_URL: 'https://convex.test', CONVEX_SERVER_SHARED_SECRET: 'fake',
    WORLDMONITOR_VALID_KEYS: 'enterprise-test-key',
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const origin = new URL(url).origin;
    if (origin === 'https://convex.test') {
      convexCalls++;
      assert.equal(JSON.parse(init.body).keyHash, await sha256Hex(key));
      return Response.json(validation, { status: validation === 'unavailable' ? 503 : 200 });
    }
    assert.equal(origin, 'https://redis.test');
    const command = (cmd) => {
      const [op, name, value] = cmd;
      if (op.toUpperCase() === 'GET') return { result: store.get(name) ?? null };
      if (op.toUpperCase() === 'SET') { store.set(name, value); return { result: 'OK' }; }
      if (op.toUpperCase() === 'INCR') return { result: rateCount };
      if (op.toUpperCase() === 'EXPIRE') return { result: 1 };
      if (op.toUpperCase() === 'TTL') return { result: 60 };
      // Upstash rate-limit scripts are outside this auth integration test.
      return { result: [1, 60000, 0] };
    };
    if (url.endsWith('/pipeline')) return Response.json(JSON.parse(init.body).map(command));
    const match = new URL(url).pathname.match(/^\/(get|getdel)\/(.+)$/);
    if (match) {
      const name = decodeURIComponent(match[2]);
      const value = store.get(name) ?? null;
      if (match[1] === 'getdel') store.delete(name);
      return Response.json({ result: value });
    }
    return Response.json(command(JSON.parse(init.body)));
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
});

async function consent(apiKey = key, xhr = true) {
  const challenge = Buffer.from(await sha256Hex('a'.repeat(64)), 'hex').toString('base64url');
  store.set('oauth:nonce:test', JSON.stringify({ client_id: 'client', redirect_uri: 'https://client.test/callback', code_challenge: challenge, state: 'state' }));
  store.set('oauth:client:client', JSON.stringify({ redirect_uris: ['https://client.test/callback'] }));
  return handler(new Request('https://api.worldmonitor.app/oauth/authorize', {
    method: 'POST', body: new URLSearchParams({ _nonce: 'test', _js: xhr ? '1' : '', api_key: apiKey }),
  }));
}

it('consents a dashboard key and resolves its bearer as a metered user', async () => {
  const response = await consent();
  assert.equal(response.status, 200);
  const code = new URL((await response.json()).location).searchParams.get('code');
  const record = JSON.parse(store.get(`oauth:code:${code}`));
  assert.equal(record.kind, 'user_key');
  assert.equal(record.api_key_hash, await sha256Hex(key));
  assert.ok(!JSON.stringify([...store]).includes(key));
  const exchange = await tokenEndpoint(new Request('https://api.worldmonitor.app/oauth/token', {
    method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: 'a'.repeat(64),
      client_id: 'client', redirect_uri: 'https://client.test/callback',
    }),
  }));
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json();
  assert.deepEqual(await resolveBearerToContext(tokens.access_token), { kind: 'user_key', userId: 'user_dashboard' });
  assert.ok(!JSON.stringify([...store]).includes(key));
});

it('keeps enterprise consent on the legacy path', async () => {
  const response = await consent('enterprise-test-key');
  assert.equal(response.status, 200);
  const code = new URL((await response.json()).location).searchParams.get('code');
  assert.equal(JSON.parse(store.get(`oauth:code:${code}`)).kind, undefined);
  assert.equal(convexCalls, 0);
});

it('rejects revoked dashboard keys', async () => {
  validation = null;
  assert.equal((await consent()).status, 400);
});

it('reports validation failure as retryable', async () => {
  validation = 'unavailable';
  const response = await consent();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '5');
  const retry = await response.json();
  assert.equal(retry.error, 'temporarily_unavailable');
  assert.ok(retry.nonce);
  assert.equal(store.has('oauth:nonce:test'), false);
  validation = { userId: 'user_dashboard' };
  const recovered = await handler(new Request('https://api.worldmonitor.app/oauth/authorize', {
    method: 'POST', body: new URLSearchParams({ _nonce: retry.nonce, _js: '1', api_key: key }),
  }));
  assert.equal(recovered.status, 200);
  assert.equal(new URL((await recovered.json()).location).hostname, 'client.test');
});

it('renders a usable native consent form after transient validation failure', async () => {
  validation = 'unavailable';
  const response = await consent(key, false);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '5');
  const html = await response.text();
  const nonce = html.match(/id="nn" value="([^"]+)"/)?.[1];
  assert.ok(nonce);
  assert.notEqual(nonce, 'test');
  assert.ok(store.has(`oauth:nonce:${nonce}`));
});

it('returns a fresh nonce when dashboard validation is rate limited', async () => {
  rateCount = 601;
  const response = await consent();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  const retry = await response.json();
  assert.equal(retry.error, 'temporarily_unavailable');
  assert.ok(store.has(`oauth:nonce:${retry.nonce}`));
  assert.equal(convexCalls, 0);
});

it('rejects scoped company keys on the generic consent path', async () => {
  validation = { userId: 'user_dashboard', scopes: ['company_monitoring:read'], companyMonitoringAccountId: 'account' };
  assert.equal((await consent()).status, 400);
});

it('revalidates bearer key revocation and preserves backend failures', async () => {
  store.set('oauth:token:bearer', JSON.stringify({ kind: 'user_key', api_key_hash: await sha256Hex(key) }));
  validation = 'unavailable';
  await assert.rejects(resolveBearerToContext('bearer'));
  validation = null;
  assert.equal(await resolveBearerToContext('bearer'), null);
});

it('rejects malformed bearer hashes without reaching Convex', async () => {
  for (const hash of [null, '', 'a'.repeat(63), 'A'.repeat(64), {}]) {
    store.set('oauth:token:bearer', JSON.stringify({ kind: 'user_key', api_key_hash: hash }));
    assert.equal(await resolveBearerToContext('bearer'), null);
  }
  assert.equal(convexCalls, 0);
});

it('rejects a dashboard bearer from a revoked refresh family before key validation', async () => {
  store.set('oauth:token:bearer', JSON.stringify({ kind: 'user_key', api_key_hash: await sha256Hex(key) }));
  store.set('oauth:tokenfam:bearer', JSON.stringify('family'));
  store.set('oauth:famrev:family', JSON.stringify(true));
  assert.equal(await resolveBearerToContext('bearer'), null);
  assert.equal(convexCalls, 0);
});
