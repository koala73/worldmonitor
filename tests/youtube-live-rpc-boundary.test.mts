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
const RETIRED = { videoId: '', isLive: false, channelExists: false, channelName: '', hlsUrl: '', title: '', error: 'channel_live_detection_retired' };
const gateway = createDomainGateway(createAviationServiceRoutes(aviationHandler, serverOptions));
let calls: URL[];
let redis: ReturnType<typeof installRedis>;
let oembedFails: boolean;
let session: string;
beforeEach(async () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.WORLDMONITOR_VALID_KEYS;
  // A configured relay must never be called: it no longer serves YouTube lookups.
  process.env.WS_RELAY_URL = 'https://relay.example.test';
  process.env.WM_SESSION_SECRET = 'synthetic-youtube-anonymous-session-secret';
  session = (await issueSessionToken()).token;
  __resetRateLimitForTest();
  calls = [];
  oembedFails = false;
  redis = installRedis({});
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    // Tripwire: the relay answers as if it still served lookups, so any call to it shows up in the results.
    if (url.hostname === 'relay.example.test') return Response.json({ videoId: VIDEO, isLive: true, channelExists: true });
    if (url.hostname === 'www.youtube.com') {
      if (oembedFails || url.pathname !== '/oembed') return new Response('', { status: 503 });
      return Response.json({ title: 'Synthetic video', author_name: 'Synthetic channel' });
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
const oembedVideo = (url: URL) => new URL(url.searchParams.get('url') ?? '').searchParams.get('v');

describe('YouTube public RPC input boundary and retired channel detection', () => {
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

  it('answers every shipped handle, international handle and channel ID with the retired error and no I/O at all', async () => {
    // Callers built before the retirement still send these handles; they get a stable error, not a 400.
    const source = readFileSync(new URL('../src/services/live-channels.ts', import.meta.url), 'utf8');
    const handles = new Set([...source.matchAll(/handle:\s*'([^']+)'/g)].map(match => match[1]!));
    assert.ok(handles.size > 50);
    for (const channel of [...handles, '@中', '@あい', '@cafe\u0301', '@a·b', CHANNEL_ID]) {
      assert.deepEqual(await getYoutubeLiveStreamInfo(ctx(), { channel, videoId: '' }), RETIRED, channel);
    }
    assert.equal(calls.length, 0);
    assert.equal(redis.redis.size, 0);
  });

  it('names a video from oEmbed only, never the relay, and caches the answer', async () => {
    const result = await getYoutubeLiveStreamInfo(ctx(), { channel: '', videoId: VIDEO });
    assert.deepEqual(result, { videoId: VIDEO, isLive: false, channelExists: true, channelName: 'Synthetic channel', hlsUrl: '', title: 'Synthetic video', error: '' });
    assert.deepEqual(providers().map(url => `${url.hostname}${url.pathname}`), ['www.youtube.com/oembed']);
    assert.equal(oembedVideo(providers()[0]!), VIDEO);
    await getYoutubeLiveStreamInfo(ctx(), { channel: '', videoId: VIDEO });
    assert.equal(providers().length, 1);
  });

  it('answers the video when a request also names a channel, sharing the video cache entry', async () => {
    await getYoutubeLiveStreamInfo(ctx(), { channel: '@SkyNews', videoId: VIDEO });
    await getYoutubeLiveStreamInfo(ctx(), { channel: CHANNEL_ID, videoId: VIDEO });
    await getYoutubeLiveStreamInfo(ctx(), { channel: '', videoId: VIDEO });
    assert.deepEqual(providers().map(url => url.hostname), ['www.youtube.com']);
  });

  it('caches a failed oEmbed lookup separately and reports it', async () => {
    oembedFails = true;
    const result = await getYoutubeLiveStreamInfo(ctx(), { channel: '', videoId: VIDEO });
    assert.equal(result.error, 'Video lookup failed');
    assert.equal(result.channelExists, false);
    const count = providers().length;
    await getYoutubeLiveStreamInfo(ctx(), { channel: '', videoId: VIDEO });
    assert.equal(providers().length, count);
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

  it('fails closed when the lookup limiter store is missing', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const response = await gateway(request({ video_id: VIDEO }));
    assert.equal(response.status, 503);
    assert.equal(providers().length, 0);
  });

  it('preserves authenticated requests and case-sensitive video IDs', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'synthetic-enterprise-key';
    const req = request({ channel: '@SkyNews', video_id: 'AbCdEfGhIjK' });
    req.headers.set('X-WorldMonitor-Key', 'synthetic-enterprise-key');
    const response = await gateway(req);
    assert.equal(response.status, 200);
    assert.equal(providers().length, 1);
    assert.equal(providers()[0]!.hostname, 'www.youtube.com');
    assert.equal(oembedVideo(providers()[0]!), 'AbCdEfGhIjK');
  });

  it('fails closed when the configured lookup limiter store errors', async () => {
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (new URL(String(input)).hostname === 'redis.example') throw new Error('Synthetic store outage');
      return transport(input, init);
    }) as typeof fetch;
    const response = await gateway(request({ video_id: VIDEO }));
    assert.equal(response.status, 503);
    assert.equal(providers().length, 0);
  });

  it('admits 30 public cache misses, then rejects before another lookup', async () => {
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
    const video = (i: number) => `vid${String(i).padStart(8, '0')}`;
    for (let i = 0; i < 30; i++) assert.equal((await gateway(request({ video_id: video(i) }))).status, 200);
    const denied = await gateway(request({ video_id: video(30) }));
    assert.equal(denied.status, 429);
    assert.ok(Number(denied.headers.get('Retry-After')) > 0);
    assert.equal(providers().length, 30);
  });
});
