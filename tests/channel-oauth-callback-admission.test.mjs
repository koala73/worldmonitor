import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

// The callbacks read their env at import time, so set it before importing them.
const saved = { ...process.env };
Object.assign(process.env, {
  UPSTASH_REDIS_REST_URL: 'https://redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'test-token',
  DISCORD_CLIENT_ID: 'id', DISCORD_CLIENT_SECRET: 'secret', DISCORD_REDIRECT_URI: 'https://www.worldmonitor.app/api/discord/oauth/callback',
  SLACK_CLIENT_ID: 'id', SLACK_CLIENT_SECRET: 'secret', SLACK_REDIRECT_URI: 'https://www.worldmonitor.app/api/slack/oauth/callback',
  CONVEX_SITE_URL: 'https://convex.test',
  CONVEX_TENANT_RELAY_SECRET: 'relay',
  NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
});
const { __resetRateLimitForTest } = await import('../server/_shared/rate-limit.ts');
const handlers = {
  discord: (await import('../api/discord/oauth/callback.ts')).default,
  slack: (await import('../api/slack/oauth/callback.ts')).default,
};

const originalFetch = globalThis.fetch;
let limiterMode;
let calls;

beforeEach(() => {
  __resetRateLimitForTest();
  limiterMode = 'allow';
  calls = { limiter: [], getdel: 0 };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/getdel/')) {
      calls.getdel++;
      return Response.json({ result: null });
    }
    calls.limiter.push(String(init?.body ?? ''));
    if (limiterMode === 'outage') throw new Error('limiter unavailable');
    // Sliding-window reply is [remainingTokens, effectiveLimit]; success = remaining >= 0.
    const result = limiterMode === 'deny' ? [-1, 30] : [29, 30];
    const parsed = JSON.parse(init.body);
    return Array.isArray(parsed[0]) ? Response.json(parsed.map(() => ({ result }))) : Response.json({ result });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

process.on('exit', () => { process.env = saved; });

const ctx = { waitUntil() {} };
const callback = (provider) => new Request(`https://www.worldmonitor.app/api/${provider}/oauth/callback?code=c&state=made-up`);

for (const provider of ['discord', 'slack']) {
  describe(`${provider} OAuth callback admission`, () => {
    test('a caller under the per-IP budget reaches the state lookup', async () => {
      const response = await handlers[provider](callback(provider), ctx);
      assert.equal(calls.getdel, 1);
      assert.ok(calls.limiter.some((body) => body.includes(`${provider}-oauth-callback`)), 'scoped to the route');
      assert.match(await response.text(), /invalid_state/);
    });

    test('a caller over the budget gets a 429 that tells the opener, and no state lookup runs', async () => {
      limiterMode = 'deny';
      const response = await handlers[provider](callback(provider), ctx);
      assert.equal(response.status, 429);
      const html = await response.text();
      assert.match(html, new RegExp(`wm:${provider}_error`));
      assert.match(html, /rate_limited/);
      assert.equal(calls.getdel, 0);
    });

    test('a limiter outage fails closed before the state lookup', async () => {
      limiterMode = 'outage';
      const response = await handlers[provider](callback(provider), ctx);
      assert.equal(response.status, 503);
      assert.match(await response.text(), /service_unavailable/);
      assert.equal(calls.getdel, 0);
    });
  });
}
