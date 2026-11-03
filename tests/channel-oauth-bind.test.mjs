import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import handler from '../api/channel-oauth-bind.ts';
import { createChannelOAuthState, callbackMatchesBrowser } from '../server/_shared/channel-oauth-state.ts';
import { __resetRateLimitForTest } from '../server/_shared/rate-limit.ts';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const preview = 'https://worldmonitor-git-review-eliewm.vercel.app';
const stateToken = 's'.repeat(27);

// The route now admits by IP before touching the launch key. The limiter uses
// the same Upstash transport, so route its commands by key prefix: this keeps
// the launch-read and compare-and-delete mocks below untouched.
const limiter = { mode: 'allow', calls: [] };
function isLimiterCall(url, init) {
  if (String(url).includes('/get/')) return false;
  const text = typeof init?.body === 'string' ? init.body : '';
  return text.includes('rl:scope:channel-oauth-bind') || String(url).includes('/pipeline');
}
function answerLimiter(init) {
  const parsed = JSON.parse(init.body);
  limiter.calls.push(parsed);
  if (limiter.mode === 'outage') throw new Error('limiter unavailable');
  // Sliding-window reply is [remainingTokens, effectiveLimit]; success = remaining >= 0.
  const result = limiter.mode === 'deny' ? [-1, 30] : [29, 30];
  return Array.isArray(parsed[0]) ? Response.json(parsed.map(() => ({ result }))) : Response.json({ result });
}
/** Wrap a per-test fetch override so limiter traffic is still answered. */
function withLimiter(responder) {
  return async (url, init) => (isLimiterCall(url, init) ? answerLimiter(init) : responder(url, init));
}

async function setup(provider, destination) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const req = new Request(`https://api.worldmonitor.app/api/${provider}/oauth/start`, { headers: { origin: preview } });
  const binding = await createChannelOAuthState(provider, req, 'user-test');
  const record = JSON.parse(binding.record);
  const oauthUrl = provider === 'slack' ? 'https://slack.com/oauth/v2/authorize' : 'https://discord.com/oauth2/authorize';
  let raw = JSON.stringify({ ...record, oauthUrl: destination ?? `${oauthUrl}?state=${stateToken}` });
  let consumes = 0;
  globalThis.fetch = withLimiter(async (url, init) => {
    if (String(url).includes('/get/')) return Response.json({ result: raw });
    const [cmd, , , key, expected] = JSON.parse(init.body);
    assert.equal(cmd, 'EVAL');
    assert.equal(key, `wm:${provider}:oauth:launch:${stateToken}`);
    if (raw === expected) { raw = null; consumes++; return Response.json({ result: 1 }); }
    return Response.json({ result: 0 });
  });
  const request = (token = binding.bindValue, origin = preview) => new Request(
    `https://api.worldmonitor.app/api/channel-oauth-bind?provider=${provider}&state=${stateToken}`, {
      method: 'POST', headers: { origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    },
  );
  return { binding, record, request, consumes: () => consumes };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  limiter.mode = 'allow';
  limiter.calls.length = 0;
  __resetRateLimitForTest(); // drop the limiter's ephemeral block cache between cases
  if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
  if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
});

for (const provider of ['slack', 'discord']) {
  test(`${provider} binds the preview popup and consumes its launch only once`, async () => {
    const flow = await setup(provider);
    assert.equal(flow.record.openerOrigin, preview);
    const responses = await Promise.all([handler(flow.request()), handler(flow.request())]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 503]);
    assert.equal(flow.consumes(), 1);
    const response = responses.find(r => r.status === 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const cookie = response.headers.get('Set-Cookie');
    assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/);
    const html = await response.text();
    assert.match(html, /http-equiv="refresh"/);
    assert.ok(!html.includes(flow.binding.bindValue));
    assert.equal(await callbackMatchesBrowser(provider, new Request('https://api.worldmonitor.app/callback', {
      headers: { cookie: cookie.split(';')[0] },
    }), flow.record), true);
  });

  test(`${provider} rejects a forwarded launch or wrong binding without consuming it`, async () => {
    const flow = await setup(provider);
    assert.equal((await handler(new Request(flow.request().url))).status, 405);
    assert.equal((await handler(flow.request('wrong-token'))).status, 403);
    assert.equal((await handler(flow.request(flow.binding.bindValue, 'https://evil.test'))).status, 403);
    assert.equal(flow.consumes(), 0);
    assert.equal((await handler(flow.request())).status, 200);
  });

  test(`${provider} refuses an untrusted provider destination before consuming the launch`, async () => {
    const flow = await setup(provider, `https://evil.test/authorize?state=${stateToken}`);
    const response = await handler(flow.request());
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(flow.consumes(), 0);
  });

  test(`${provider} distinguishes an expired launch from a malformed Redis response`, async () => {
    const flow = await setup(provider);
    globalThis.fetch = withLimiter(async () => Response.json({ result: null }));
    assert.equal((await handler(flow.request())).status, 400);
    globalThis.fetch = withLimiter(async () => Response.json({ error: 'upstream failed' }));
    const response = await handler(flow.request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Set-Cookie'), null);
  });

  test(`${provider} fails closed when Redis cannot read the launch`, async () => {
    const flow = await setup(provider);
    globalThis.fetch = withLimiter(async () => { throw new Error('Redis unavailable'); });
    const response = await handler(flow.request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Set-Cookie'), null);
  });

  test(`${provider} admits by IP before reading the launch, and fails closed on a limiter outage`, async () => {
    const flow = await setup(provider);
    let launchReads = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/get/')) launchReads++;
      return inner(url, init);
    };

    assert.equal((await handler(flow.request())).status, 200);
    assert.ok(limiter.calls.length > 0, 'limiter consulted');
    assert.ok(JSON.stringify(limiter.calls).includes('rl:scope:channel-oauth-bind'), 'scoped to the route');
    assert.equal(launchReads, 1);

    limiter.mode = 'outage';
    const degraded = await handler(flow.request());
    assert.equal(degraded.status, 503);
    assert.equal(degraded.headers.get('Set-Cookie'), null);
    assert.equal(launchReads, 1, 'no launch read when the limiter is unavailable');
    assert.equal(flow.consumes(), 1);
  });

  test(`${provider} returns 429 once the per-IP budget is spent, without touching Redis`, async () => {
    const flow = await setup(provider);
    let launchReads = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/get/')) launchReads++;
      return inner(url, init);
    };
    limiter.mode = 'deny';
    const response = await handler(flow.request());
    assert.equal(response.status, 429);
    assert.ok(response.headers.get('Retry-After'));
    assert.equal(launchReads, 0);
    assert.equal(flow.consumes(), 0);
  });

}
