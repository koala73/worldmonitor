import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import handler from '../api/channel-oauth-bind.ts';
import { createChannelOAuthState, callbackMatchesBrowser } from '../server/_shared/channel-oauth-state.ts';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const preview = 'https://worldmonitor-git-review-eliewm.vercel.app';
const stateToken = 's'.repeat(27);

async function setup(provider, destination) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const req = new Request(`https://api.worldmonitor.app/api/${provider}/oauth/start`, { headers: { origin: preview } });
  const binding = await createChannelOAuthState(provider, req, 'user-test');
  const record = JSON.parse(binding.record);
  const oauthUrl = provider === 'slack' ? 'https://slack.com/oauth/v2/authorize' : 'https://discord.com/oauth2/authorize';
  let raw = JSON.stringify({ ...record, oauthUrl: destination ?? `${oauthUrl}?state=${stateToken}` });
  let consumes = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/get/')) return Response.json({ result: raw });
    const [cmd, , , key, expected] = JSON.parse(init.body);
    assert.equal(cmd, 'EVAL');
    assert.equal(key, `wm:${provider}:oauth:launch:${stateToken}`);
    if (raw === expected) { raw = null; consumes++; return Response.json({ result: 1 }); }
    return Response.json({ result: 0 });
  };
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
    globalThis.fetch = async () => Response.json({ result: null });
    assert.equal((await handler(flow.request())).status, 400);
    globalThis.fetch = async () => Response.json({ error: 'upstream failed' });
    const response = await handler(flow.request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Set-Cookie'), null);
  });

  test(`${provider} fails closed when Redis cannot read the launch`, async () => {
    const flow = await setup(provider);
    globalThis.fetch = async () => { throw new Error('Redis unavailable'); };
    const response = await handler(flow.request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Set-Cookie'), null);
  });
}
