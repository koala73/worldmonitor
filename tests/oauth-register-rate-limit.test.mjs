import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let handler;
let writes;
let limiterCalls;
let decision;
let releaseLimiter;
let errors;

beforeEach(async () => {
  errors = [];
  mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  writes = [];
  limiterCalls = [];
  decision = 'allow';
  releaseLimiter = undefined;
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).startsWith('https://redis.test/'));
    const body = JSON.parse(init.body);
    const pipeline = Array.isArray(body[0]);
    const results = [];
    for (const command of pipeline ? body : [body]) {
      if (['eval', 'evalsha'].includes(command[0].toLowerCase())) {
        limiterCalls.push(command);
        if (decision === 'timeout') await new Promise(resolve => { releaseLimiter = resolve; });
        if (decision === 'error') results.push({ error: 'fixture admission failure secret-token client-private-data' });
        else results.push({ result: [decision === 'deny' ? -1 : 4, 5] });
      } else {
        assert.equal(command[0], 'SET');
        writes.push(command);
        results.push({ result: 'OK' });
      }
    }
    return Response.json(pipeline ? results : results[0]);
  };
  ({ default: handler } = await import(`../api/oauth/register.js?test=${crypto.randomUUID()}`));
});

afterEach(() => {
  mock.restoreAll();
  releaseLimiter?.();
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

function request(redirect = 'http://localhost:4200/callback') {
  return new Request('https://api.worldmonitor.app/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': '192.0.2.10' },
    body: JSON.stringify({ client_name: 'Admission fixture', redirect_uris: [redirect] }),
  });
}

it('admits public clients and preserves hosted and loopback redirects', async () => {
  for (const uri of ['http://localhost:4200/callback', 'http://127.0.0.1:9000/callback', 'https://claude.ai/api/mcp/auth_callback']) {
    const response = await handler(request(uri));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    assert.equal(body.token_endpoint_auth_method, 'none');
    assert.deepEqual(body.redirect_uris, [uri]);
    const write = writes.at(-1);
    assert.equal(write[1], `oauth:client:${body.client_id}`);
    assert.deepEqual(JSON.parse(write[2]).redirect_uris, [uri]);
    assert.equal(write[4], 90 * 24 * 3600);
  }
  assert.equal(writes.length, 3);
  assert.ok(limiterCalls.every(command => command[3].includes('rl:oauth-register:ip:192.0.2.10')));
});

it('returns 429 for a confirmed denial before body parsing or persistence', async () => {
  decision = 'deny';
  const req = request();
  const response = await handler(req);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, 'rate_limit_exceeded');
  assert.equal(req.bodyUsed, false);
  assert.deepEqual(writes, []);
});

for (const failure of ['timeout', 'error', 'missing-url', 'missing-token', 'invalid-url']) {
  it(`returns 503 without parsing or persistence when admission is unavailable: ${failure}`, async () => {
    decision = failure;
    if (failure === 'missing-url') delete process.env.UPSTASH_REDIS_REST_URL;
    if (failure === 'missing-token') delete process.env.UPSTASH_REDIS_REST_TOKEN;
    if (failure === 'invalid-url') process.env.UPSTASH_REDIS_REST_URL = 'invalid';
    const req = request();
    const response = await handler(req);
    assert.deepEqual(writes, [], 'unavailable admission must not write client metadata');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'temporarily_unavailable');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('retry-after'), '5');
    assert.equal(response.headers.get('x-ratelimit-mode'), 'degraded');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(req.bodyUsed, false);
    const stage = failure === 'timeout' ? 'oauthRegister:timeout'
      : failure.startsWith('missing-') ? 'oauthRegister:missing-config' : 'oauthRegister';
    assert.equal(errors.length, 1);
    assert.ok(errors[0].startsWith(`[rate-limit] redis-error stage=${stage} msg=`));
    assert.doesNotMatch(errors[0], /secret-token|client-private-data|192\.0\.2\.10/);
    if (failure === 'timeout') {
      // Exercise the real SDK's success:true/reason:timeout, then allow its
      // still-pending Redis operation to settle. Neither path may store a client.
      assert.ok(releaseLimiter);
      releaseLimiter();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(writes, []);
    }
  });
}

it('bounds repeated degraded reports and reports again after one minute', async () => {
  let now = 1_800_000_030_000;
  mock.method(Date, 'now', () => now);
  decision = 'error';
  for (let i = 0; i < 3; i++) assert.equal((await handler(request())).status, 503);
  assert.equal(errors.length, 1);
  now += 60_000;
  assert.equal((await handler(request())).status, 503);
  assert.equal(errors.length, 2);
  assert.deepEqual(writes, []);
});

it('accepts a later request when admission recovers', async () => {
  decision = 'error';
  assert.equal((await handler(request())).status, 503);
  assert.deepEqual(writes, []);
  decision = 'allow';
  assert.equal((await handler(request())).status, 201);
  assert.equal(writes.length, 1);
});

it('keeps OPTIONS and unsupported methods independent of admission infrastructure', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  for (const [method, status] of [['OPTIONS', 204], ['GET', 405]]) {
    assert.equal((await handler(new Request(request().url, { method }))).status, status);
  }
  assert.deepEqual(limiterCalls, []);
  assert.deepEqual(writes, []);
});
