import assert from 'node:assert/strict';
import { beforeEach, afterEach, it, mock } from 'node:test';
import handler from '../api/telegram-feed.js';
import { issueSessionToken } from '../api/_session.js';
import { __resetRateLimitForTest } from '../api/_rate-limit.js';
const originalEnv = { ...process.env };
const KEY = 'wm_' + 'a'.repeat(40);
let calls;
let keyValue;
let entitlement;
let backendStatus;
let redisStatus;
let remaining;
beforeEach(() => {
  __resetRateLimitForTest();
  calls = [];
  keyValue = { id: 'synthetic_key', userId: 'synthetic_owner', name: 'test' };
  entitlement = { planKey: 'api_starter', validUntil: Date.now() + 60000, features: { apiAccess: true } };
  backendStatus = 200;
  redisStatus = 200;
  remaining = 1;
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'synthetic-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-token';
  process.env.WM_SESSION_SECRET = 'synthetic-session-secret-for-telegram-test';
  process.env.WS_RELAY_URL = 'https://relay.test';
  process.env.VERCEL_ENV = 'production';
  delete process.env.WORLDMONITOR_VALID_KEYS;
  mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://redis.test')) {
      const commands = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(commands.map(command => {
        const verb = String(command[0]).toUpperCase();
        if (verb === 'GET') return { result: null };
        if (verb === 'SET') return { result: 'OK' };
        assert.match(verb, /^EVAL(SHA)?$/);
        return { result: [remaining, 1] };
      })), { status: redisStatus });
    }
    if (url === 'https://convex.test/api/internal-validate-api-key') {
      const body = JSON.parse(init.body);
      assert.match(body.keyHash, /^[a-f0-9]{64}$/);
      assert.ok(!init.body.includes(KEY));
      return Response.json(keyValue, { status: backendStatus });
    }
    if (url === 'https://convex.test/api/internal-entitlements') return Response.json(entitlement, { status: backendStatus });
    assert.match(url, /^https:\/\/relay.test\/telegram\/feed\?/);
    return Response.json({ enabled: true, messages: [] });
  });
});
afterEach(() => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
async function request(key = KEY, name = 'X-WorldMonitor-Key', withCookie = true) {
  const { token } = await issueSessionToken();
  return handler(new Request('https://worldmonitor.app/api/telegram-feed', { headers: {
    [name]: key, ...(withCookie ? { Cookie: `wm-session=${token}` } : {}),
  } }));
}
for (const name of ['X-WorldMonitor-Key', 'X-Api-Key']) {
  it(`accepts an entitled user key from ${name}`, async () => {
    const errors = mock.method(console, 'error', () => {});
    const warnings = mock.method(console, 'warn', () => {});
    const response = await request(KEY, name, name === 'X-WorldMonitor-Key');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control'), /private/);
    assert.ok(calls.some(url => url.endsWith('/api/internal-validate-api-key')));
    assert.ok(calls.some(url => url.endsWith('/api/internal-entitlements')));
    assert.ok(calls.some(url => url.startsWith('https://relay.test')));
    assert.doesNotMatch([...errors.mock.calls, ...warnings.mock.calls].flatMap(c => c.arguments).join(' '), /\[rate-limit\]/);
  });
}
for (const mode of ['revoked', 'scoped', 'no-access', 'outage', 'malformed', 'limiter-outage', 'limited', 'expired']) {
  it(`denies ${mode} without falling back to the valid session cookie or calling relay`, async () => {
    if (mode === 'revoked') keyValue = null;
    if (mode === 'scoped') keyValue = { ...keyValue, scopes: ['company_monitoring:read'], companyMonitoringAccountId: 'account' };
    if (mode === 'limited') remaining = -1;
    if (mode === 'expired') entitlement.validUntil = Date.now() - 1000;
    if (mode === 'no-access') entitlement.features.apiAccess = false;
    if (mode === 'outage') backendStatus = 503;
    if (mode === 'limiter-outage') redisStatus = 503;
    const response = await request(mode === 'malformed' ? 'wm_bad' : KEY);
    assert.equal(response.status, mode === 'limited' ? 429 : ['no-access', 'expired'].includes(mode) ? 403 : ['outage', 'limiter-outage'].includes(mode) ? 503 : 401);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.ok(!calls.some(url => url.startsWith('https://relay.test')));
    if (['malformed', 'limiter-outage', 'limited'].includes(mode)) assert.ok(!calls.some(url => url.startsWith('https://convex.test')));
    if (['outage', 'limiter-outage'].includes(mode)) assert.ok(response.headers.get('Retry-After'));
  });
}
