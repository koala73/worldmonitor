import assert from 'node:assert/strict';
import { beforeEach, afterEach, it, mock } from 'node:test';
import { reserveDailyMeter } from '../server/_shared/api-key-rate-limit.ts';
import { redisPipeline } from '../api/_upstash-json.js';
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
let accountRemaining;
let accountRedisStatus;
let dailyInitial;
let daily;
let commandsSeen;
let testId = 0;
let cachedEntitlement;
let relayStatus;
beforeEach(() => {
  __resetRateLimitForTest();
  calls = [];
  keyValue = { id: 'synthetic_key', userId: `synthetic_owner_${++testId}`, name: 'test' };
  entitlement = { planKey: 'api_starter', validUntil: Date.now() + 60000, features: { apiAccess: true, apiRateLimit: 60, apiDailyAllowance: 1000 } };
  backendStatus = 200;
  redisStatus = 200;
  remaining = 1;
  accountRemaining = 1;
  cachedEntitlement = false;
  relayStatus = 200;
  accountRedisStatus = 200;
  dailyInitial = 0;
  daily = new Map();
  commandsSeen = [];
  process.env.API_RATE_LIMIT_ENFORCE = 'true';
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
    if (new URL(url).hostname === 'redis.test') {
      const commands = JSON.parse(String(init?.body));
      const accountCommands = commands.some(command => command.some(arg => String(arg).startsWith('rl:apikey:')));
      return new Response(JSON.stringify(commands.map(command => {
        commandsSeen.push(command);
        const verb = String(command[0]).toUpperCase();
        if (verb === 'GET') return { result: cachedEntitlement && String(command[1]).startsWith('entitlements:') ? JSON.stringify(entitlement) : null };
        if (verb === 'SET') return { result: 'OK' };
        if (verb === 'INCR' || verb === 'DECR') {
          const value = (daily.get(command[1]) ?? dailyInitial) + (verb === 'INCR' ? 1 : -1);
          daily.set(command[1], value);
          return { result: value };
        }
        if (verb === 'EXPIRE') return { result: 1 };
        assert.match(verb, /^EVAL(SHA)?$/);
        const accountBurst = String(command[3]).startsWith('rl:apikey:min:');
        // Upstash sliding-window Lua returns [remainingTokens, effectiveLimit].
        return { result: [accountBurst ? accountRemaining : remaining, Number(command[3 + Number(command[2])])] };
      })), { status: accountCommands ? accountRedisStatus : redisStatus });
    }
    if (url === 'https://convex.test/api/internal-validate-api-key') {
      const body = JSON.parse(init.body);
      assert.match(body.keyHash, /^[a-f0-9]{64}$/);
      assert.ok(!init.body.includes(KEY));
      return Response.json(keyValue, { status: backendStatus });
    }
    if (url === 'https://convex.test/api/internal-entitlements') return Response.json(entitlement, { status: backendStatus });
    assert.equal(new URL(url).origin, 'https://relay.test');
    assert.match(new URL(url).pathname, /^\/telegram\/(feed|resolve|channel)$/);
    if (new URL(url).pathname.endsWith('/resolve')) return Response.json({ username: 'channel_one', title: 'Channel One', memberCount: 42 });
    return Response.json({ enabled: true, messages: [] }, { status: relayStatus });
  });
});
afterEach(() => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
async function request(key = KEY, name = 'X-WorldMonitor-Key', withCookie = true, query = '') {
  const { token } = await issueSessionToken();
  return handler(new Request(`https://worldmonitor.app/api/telegram-feed${query}`,  { headers: {
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
    assert.ok(calls.some(url => new URL(url).hostname === 'relay.test'));
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
    assert.ok(!commandsSeen.some(command => command.some(arg => String(arg).startsWith('rl:apikey:'))));
    assert.ok(!calls.some(url => new URL(url).hostname === 'relay.test'));
    if (['malformed', 'limiter-outage', 'limited'].includes(mode)) assert.ok(!calls.some(url => new URL(url).hostname === 'convex.test'));
    if (['outage', 'limiter-outage'].includes(mode)) assert.ok(response.headers.get('Retry-After'));
  });
}

function dailyCommands(verb) {
  return commandsSeen.filter(command => command[0] === verb && String(command[1]).startsWith('rl:apikey:day:'));
}
it('allows the gateway-sized pre-auth budget while retaining mode and account limits', async () => {
  assert.equal((await request()).status, 200);
  const validation = commandsSeen.find(command => /^EVAL(SHA)?$/.test(String(command[0]).toUpperCase())
    && String(command[3]).includes('telegram-user-key-validation'));
  assert.ok(validation);
  assert.equal(Number(validation[3 + Number(validation[2])]), 600);
  assert.equal(burstCommands().length, 1);
  assert.equal(dailyCommands('INCR').length, 1);
});
function burstCommands() {
  return commandsSeen.filter(command => /^EVAL(SHA)?$/.test(String(command[0]).toUpperCase()) && String(command[3]).startsWith('rl:apikey:min:'));
}
for (const mode of ['feed', 'resolve', 'channel']) {
  it(`meters ${mode} exactly once and preserves its response`, async () => {
    const response = await request(KEY, 'X-Api-Key', false, `?mode=${mode}&username=channel_one`);
    assert.equal(response.status, 200);
    const body = await response.json();
    if (mode === 'resolve') assert.deepEqual(body, { username: 'channel_one', title: 'Channel One', memberCount: 42, url: 'https://t.me/channel_one' });
    else assert.deepEqual(body, { source: 'telegram', earlySignal: false, enabled: true, count: 0, updatedAt: null, items: [] });
    assert.equal(burstCommands().length, 1);
    assert.equal(dailyCommands('INCR').length, 1);
    assert.equal(dailyCommands('EXPIRE')[0][2], 172800);
    assert.equal(dailyCommands('DECR').length, 0);
  });
}
it('shares the gateway daily namespace across two keys owned by the same account', async () => {
  dailyInitial = 999;
  assert.equal((await request()).status, 200);
  const response = await request('wm_' + 'b'.repeat(40));
  assert.equal(response.status, 429);
  assert.equal((await response.json()).limit_type, 'daily');
  const key = `rl:apikey:day:${keyValue.userId}:${new Date().toISOString().slice(0, 10)}`;
  assert.equal(daily.get(key), 1000);
  assert.deepEqual(dailyCommands('INCR').map(command => command[1]), [key, key]);
  assert.equal(dailyCommands('DECR').length, 1);
  assert.equal(burstCommands()[0][3], burstCommands()[1][3]);
  assert.equal(calls.filter(url => new URL(url).hostname === 'relay.test').length, 1);
  assert.equal(response.headers.get('RateLimit-Policy'), '"default";q=1000;w=86400');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
it('keeps different accounts in separate counters', async () => {
  assert.equal((await request()).status, 200);
  keyValue.userId += '_other';
  assert.equal((await request('wm_' + 'b'.repeat(40))).status, 200);
  assert.equal(daily.size, 2);
  assert.deepEqual([...daily.values()], [1, 1]);
});
it('enforces the verified Business burst limit before reserving daily usage', async () => {
  entitlement.planKey = 'api_business';
  entitlement.features.apiRateLimit = 300;
  accountRemaining = -1;
  const response = await request();
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.limit_type, 'per_minute');
  assert.equal(body.limit, 300);
  assert.equal(body.plan, 'api_business');
  assert.equal(response.headers.get('RateLimit-Policy'), '"default";q=300;w=60');
  assert.equal(dailyCommands('INCR').length, 0);
  assert.ok(!calls.some(url => new URL(url).hostname === 'relay.test'));
});
it('serves shadow daily excess and retains its increment', async () => {
  process.env.API_RATE_LIMIT_ENFORCE = 'false';
  dailyInitial = 1000;
  assert.equal((await request()).status, 200);
  assert.deepEqual([...daily.values()], [1001]);
  assert.equal(dailyCommands('DECR').length, 0);
});
it('serves shadow burst excess without a daily reservation', async () => {
  delete process.env.API_RATE_LIMIT_ENFORCE;
  accountRemaining = -1;
  assert.equal((await request()).status, 200);
  assert.equal(burstCommands().length, 1);
  assert.equal(dailyCommands('INCR').length, 0);
});
for (const allowance of [-1, 0, undefined]) {
  it(`keeps allowance ${allowance} unmetered`, async () => {
    entitlement.features.apiDailyAllowance = allowance;
    assert.equal((await request()).status, 200);
    assert.equal(burstCommands().length, 1);
    assert.equal(dailyCommands('INCR').length, 0);
  });
}
it('retains shared-meter fail-open behavior after successful auth admission', async () => {
  accountRedisStatus = 503;
  assert.equal((await request()).status, 200);
  assert.equal(burstCommands().length, 1);
  assert.equal(dailyCommands('INCR').length, 1);
  assert.equal(dailyCommands('DECR').length, 0);
});
for (const query of ['?mode=invalid', '?mode=channel&username=!', '?mode=resolve']) {
  it(`rejects invalid input before account metering: ${query}`, async () => {
    assert.equal((await request(KEY, 'X-Api-Key', false, query)).status, 400);
    assert.equal(burstCommands().length, 0);
    assert.equal(dailyCommands('INCR').length, 0);
  });
}

it('charges a cached verified entitlement without another entitlement lookup', async () => {
  cachedEntitlement = true;
  dailyInitial = 1000;
  assert.equal((await request()).status, 429);
  assert.equal(dailyCommands('INCR').length, 1);
  assert.ok(!calls.some(url => url.endsWith('/api/internal-entitlements')));
});
it('counts an admitted request when the relay fails', async () => {
  relayStatus = 503;
  assert.equal((await request()).status, 503);
  assert.deepEqual([...daily.values()], [1]);
  assert.equal(dailyCommands('DECR').length, 0);
});
it('shares daily usage with the gateway typed adapter without double accounting', async () => {
  dailyInitial = 998;
  const gatewayMeter = await reserveDailyMeter({ userId: keyValue.userId, allowance: 1000, pipeline: redisPipeline });
  assert.equal(gatewayMeter.count, 999);
  assert.equal((await request()).status, 200);
  assert.deepEqual([...daily.values()], [1000]);
  assert.equal(dailyCommands('INCR').length, 2);
});
