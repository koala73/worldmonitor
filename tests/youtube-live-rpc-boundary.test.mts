import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getYoutubeLiveStreamInfo } from '../server/worldmonitor/aviation/v1/get-youtube-live-stream-info.ts';
import { ApiError, createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { __resetRateLimitForTest, ENDPOINT_RATE_POLICIES } from '../server/_shared/rate-limit.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { issueSessionToken } from '../api/_session.js';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const PATH = '/api/aviation/v1/get-youtube-live-stream-info';
const VIDEO = 'abcdefghijk';
const CHANNEL_ID = 'UCabcdefghijklmnopqrstuv';
const gateway = createDomainGateway(createAviationServiceRoutes(aviationHandler, serverOptions));
let calls: URL[];
let redis: ReturnType<typeof installRedis>;
let relayFails: boolean;
let directFails: boolean;
let session: string;
beforeEach(async () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.WORLDMONITOR_VALID_KEYS;
  process.env.WS_RELAY_URL = 'https://relay.example.test';
  process.env.WM_SESSION_SECRET = 'synthetic-youtube-anonymous-session-secret';
  session = (await issueSessionToken()).token;
  __resetRateLimitForTest();
  calls = [];
  relayFails = false;
  directFails = false;
  redis = installRedis({});
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === 'relay.example.test') return relayFails ? new Response('', { status: 503 }) : Response.json({ videoId: VIDEO, isLive: true, channelExists: true });
    if (url.hostname === 'www.youtube.com') {
      if (directFails) return new Response('', { status: 503 });
      if (url.pathname === '/oembed') return Response.json({ title: 'Synthetic video', author_name: 'Synthetic channel' });
      return new Response(`{"channelId":"${CHANNEL_ID}","videoDetails":{"videoId":"${VIDEO}","isLive":true}}`);
    }
    return redis.fetchImpl(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});
function request(params: Record<string, string> = {}) {
  return new Request(`https://api.worldmonitor.app${PATH}?${new URLSearchParams(params)}`, { headers: { 'X-WorldMonitor-Key': session, 'x-vercel-forwarded-for': '192.0.2.1' } });
}
function ctx() { return { request: request(), pathParams: {}, headers: {} }; }
const providers = () => calls.filter(url => url.hostname !== 'redis.example');

describe('YouTube public RPC input and scrape boundary', () => {
  for (const [field, value] of [
    ['channel', '@abc/../../watch'], ['channel', '@abc?other=x'], ['channel', '@abc#fragment'],
    ['channel', '@abc%2f..'], ['channel', '@abc\\def'], ['channel', '@abc def'],
    ['channel', '@' + 'a'.repeat(1000)], ['channel', '@.abc'], ['channel', '@abc.'],
    ['videoId', 'short'], ['videoId', 'x'.repeat(1000)], ['videoId', 'abcdefghi?x'],
  ]) {
    it(`rejects malformed ${field} before cache or provider I/O: ${value.slice(0, 24)}`, async () => {
      await assert.rejects(getYoutubeLiveStreamInfo(ctx(), { channel: '@ValidHandle', videoId: '', [field]: value }), (error: unknown) => error instanceof ApiError && error.statusCode === 400);
      assert.equal(calls.length, 0);
      assert.equal(redis.redis.size, 0);
    });
  }

  it('accepts every shipped handle and documented international forms', async () => {
    const source = readFileSync(new URL('../src/components/LiveNewsPanel.ts', import.meta.url), 'utf8');
    const handles = new Set([...source.matchAll(/handle:\s*'([^']+)'/g)].map(match => match[1]!));
    assert.ok(handles.size > 50);
    for (const channel of [...handles, '@中', '@あい', '@cafe\u0301', '@a·b']) {
      assert.equal((await getYoutubeLiveStreamInfo(ctx(), { channel, videoId: '' })).error, '');
    }
  });

  it('shares handle case and @ variants while preserving distinct request shapes', async () => {
    await getYoutubeLiveStreamInfo(ctx(), { channel: '@SkyNews', videoId: '' });
    await getYoutubeLiveStreamInfo(ctx(), { channel: 'skynews', videoId: '' });
    assert.equal(providers().length, 1);
    await getYoutubeLiveStreamInfo(ctx(), { channel: '@SkyNews', videoId: VIDEO });
    await getYoutubeLiveStreamInfo(ctx(), { channel: '', videoId: VIDEO });
    assert.equal(providers().length, 3);
  });

  it('does not share a channel-ID cache entry with a similarly named handle', async () => {
    await getYoutubeLiveStreamInfo(ctx(), { channel: CHANNEL_ID, videoId: '' });
    await getYoutubeLiveStreamInfo(ctx(), { channel: '@' + CHANNEL_ID, videoId: '' });
    assert.equal(providers().length, 2);
  });

  it('uses a canonical channel-ID path on direct fallback', async () => {
    relayFails = true;
    const result = await getYoutubeLiveStreamInfo(ctx(), { channel: CHANNEL_ID, videoId: '' });
    assert.equal(result.isLive, true);
    assert.equal(providers()[1]!.pathname, `/channel/${CHANNEL_ID}/live`);
  });

  it('preserves valid video-only oEmbed fallback and caches failed shapes separately', async () => {
    relayFails = true;
    const result = await getYoutubeLiveStreamInfo(ctx(), { channel: '', videoId: VIDEO });
    assert.equal(result.channelExists, true);
    assert.equal(result.isLive, false);
    directFails = true;
    await getYoutubeLiveStreamInfo(ctx(), { channel: '@NoLive', videoId: '' });
    const count = providers().length;
    await getYoutubeLiveStreamInfo(ctx(), { channel: '@NoLive', videoId: '' });
    assert.equal(providers().length, count);
    await getYoutubeLiveStreamInfo(ctx(), { channel: '@NoLive', videoId: VIDEO });
    assert.ok(providers().length > count);
  });

  it('keeps the missing-input response without provider work', async () => {
    const result = await getYoutubeLiveStreamInfo(ctx(), { channel: '', videoId: '' });
    assert.equal(result.error, 'Missing channel or videoId');
    assert.equal(calls.length, 0);
  });

  it('rejects malformed anonymous-session RPC input before provider work', async () => {
    const response = await gateway(request({ channel: '@abc/def' }));
    assert.equal(response.status, 400);
    assert.equal(providers().length, 0);
    assert.ok([...redis.redis.keys()].every(key => !key.startsWith('aviation:yt-live:')));
  });

  it('fails closed when the scrape limiter store is missing', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const response = await gateway(request({ channel: '@ValidHandle' }));
    assert.equal(response.status, 503);
    assert.equal(providers().length, 0);
  });

  it('preserves authenticated relay requests and case-sensitive video IDs', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'synthetic-enterprise-key';
    const req = request({ channel: '@SkyNews', video_id: 'AbCdEfGhIjK' });
    req.headers.set('X-WorldMonitor-Key', 'synthetic-enterprise-key');
    const response = await gateway(req);
    assert.equal(response.status, 200);
    assert.equal(providers().length, 1);
    assert.equal(providers()[0]!.searchParams.get('channel'), '@skynews');
    assert.equal(providers()[0]!.searchParams.get('videoId'), 'AbCdEfGhIjK');
  });

  it('fails closed when the configured scrape limiter store errors', async () => {
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (new URL(String(input)).hostname === 'redis.example') throw new Error('Synthetic store outage');
      return transport(input, init);
    }) as typeof fetch;
    const response = await gateway(request({ channel: '@ValidHandle' }));
    assert.equal(response.status, 503);
    assert.equal(providers().length, 0);
  });

  it('admits 30 public cache misses, then rejects before another scrape', async () => {
    assert.equal(ENDPOINT_RATE_POLICIES[PATH]?.limit, 30);
    const transport = globalThis.fetch;
    let admitted = 0;
    globalThis.fetch = (async (input, init) => {
      const response = await transport(input, init);
      const commands = init?.body ? JSON.parse(String(init.body)) : [];
      if (!Array.isArray(commands[0])) return response;
      const results = await response.json();
      for (let i = 0; i < commands.length; i++) {
        if (String(commands[i][0]).toUpperCase() === 'EVALSHA') results[i] = { result: [30 - ++admitted, 60] };
      }
      return Response.json(results);
    }) as typeof fetch;
    for (let i = 0; i < 30; i++) assert.equal((await gateway(request({ channel: `@channel${i}` }))).status, 200);
    const denied = await gateway(request({ channel: '@channel30' }));
    assert.equal(denied.status, 429);
    assert.ok(Number(denied.headers.get('Retry-After')) > 0);
    assert.equal(providers().length, 30);
  });
});
