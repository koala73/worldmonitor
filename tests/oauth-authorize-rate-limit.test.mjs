import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const redirectUri = 'https://client.test/callback';
let handler;
let commands;
let counts;

beforeEach(async () => {
  mock.method(Date, 'now', () => 1_800_000_030_000);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  commands = [];
  counts = new Map();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://redis.test/get/')) {
      commands.push(['GET', decodeURIComponent(url.split('/get/')[1])]);
      return Response.json({ result: JSON.stringify({ redirect_uris: [redirectUri] }) });
    }
    assert.ok(url.startsWith('https://redis.test/'), `Unexpected fetch: ${url}`);
    const body = JSON.parse(init.body);
    const pipeline = Array.isArray(body[0]);
    const results = (pipeline ? body : [body]).map((command) => {
      commands.push(command);
      if (['eval', 'evalsha'].includes(command[0].toLowerCase())) {
        const key = command[3];
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { result: [10 - count, 10] };
      }
      assert.equal(command[0], 'SET');
      return { result: 'OK' };
    });
    return Response.json(pipeline ? results : results[0]);
  };
  ({ default: handler } = await import(`../api/oauth/authorize.js?test=${crypto.randomUUID()}`));
});

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

function request(ip = '192.0.2.1', clientId = 'registered-client') {
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
  });
  return new Request(`https://api.worldmonitor.app/oauth/authorize?${params}`, {
    headers: { 'x-real-ip': ip },
  });
}

it('limits GET by trusted IP before client reads or nonce writes, even when client IDs rotate', async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await handler(request('192.0.2.1', `client-${i}`))).status, 200);
  }
  commands.length = 0;
  assert.equal((await handler(request('192.0.2.1', 'another-client'))).status, 429);
  assert.ok(commands.every((c) => !['GET', 'SET'].includes(c[0])));
  assert.equal((await handler(request('192.0.2.2'))).status, 200);
});

it('renders consent and stores a nonce without renewing the client registration', async () => {
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Authorize/);
  const writes = commands.filter((c) => c[0] === 'SET');
  assert.equal(writes.length, 1);
  assert.match(writes[0][1], /^oauth:nonce:/);
  assert.equal(writes[0][4], 600);
});

it('OPTIONS and unsupported methods do not consume rate-limit or storage operations', async () => {
  for (const [method, status] of [['OPTIONS', 204], ['DELETE', 405]]) {
    assert.equal((await handler(new Request(request().url, { method }))).status, status);
  }
  assert.deepEqual(commands, []);
});

it('POST shares the IP budget and is rejected before nonce consumption', async () => {
  for (let i = 0; i < 10; i++) await handler(request());
  commands.length = 0;
  const response = await handler(new Request(request().url, {
    method: 'POST', headers: { 'x-real-ip': '192.0.2.1' }, body: '_nonce=test',
  }));
  assert.equal(response.status, 429);
  assert.ok(commands.every((c) => !['GET', 'GETDEL', 'SET'].includes(c[0])));
});
