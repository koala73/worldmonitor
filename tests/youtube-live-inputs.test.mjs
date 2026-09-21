import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, test } from 'node:test';
import handler from '../api/youtube/live.js';
import { __resetRateLimitForTest } from '../api/_rate-limit.js';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const region = source.slice(source.indexOf('const ytLiveCache ='), source.indexOf('// Periodic cleanup for YouTube cache'));
const html = '{"channelId":"UCabcdefghijklmnopqrstuv","videoDetails":{"videoId":"abcdefghijk","isLive":true}}';
function relay() {
  const calls = [];
  const run = runInNewContext(region + '\nhandleYouTubeLiveRequest', {
    URL, Date, console, PORT: 3004,
    ytFetch: async url => { calls.push(url); return { ok: true, body: html }; },
    sendCompressed: (_req, res, status, _headers, body) => res.done({ status, body: JSON.parse(body) }),
  });
  return { calls, request: params => new Promise(resolve => run({ url: '/youtube-live?' + new URLSearchParams(params) }, { done: resolve })) };
}
function edge() {
  const calls = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  delete process.env.WS_RELAY_URL;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('redis.example')) return Response.json([{ result: [29, 30] }]);
    calls.push(url);
    return new Response(html);
  };
  return { calls, request: params => handler(new Request('https://worldmonitor.app/api/youtube/live?' + new URLSearchParams(params))) };
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});
test('Edge and direct relay reject path and query injection before provider work', async () => {
  for (const surface of [edge(), relay()]) {
    for (const channel of ['@x/../redirect?q=https://attacker.example', '..%2Fredirect%3Fq%3Dhttps:%2F%2Fattacker', '@abc?x=1', '@abc#x', '@abc\\x', '@abc\n', '@' + 'a'.repeat(1000), '@.abc', '@abc.']) {
      assert.equal((await surface.request({ channel })).status, 400, channel);
    }
    for (const videoId of ['short', 'abcdefghijk\n', 'abcdefghij?']) {
      assert.equal((await surface.request({ channel: '@Valid', videoId })).status, 400);
    }
    assert.deepEqual(surface.calls, []);
  }
});
test('Edge rejects invalid input before forwarding to its configured relay', async () => {
  const surface = edge();
  process.env.WS_RELAY_URL = 'https://relay.example';
  assert.equal((await surface.request({ channel: '@abc/../redirect' })).status, 400);
  assert.deepEqual(surface.calls, []);
});
test('shipped handles, international handles and channel IDs keep safe paths', async () => {
  const panel = readFileSync(new URL('../src/services/live-channels.ts', import.meta.url), 'utf8');
  const handles = new Set([...panel.matchAll(/handle:\s*'([^']+)'/g)].map(match => match[1]));
  assert.ok(handles.size > 50);
  for (const surface of [edge(), relay()]) {
    for (const channel of [...handles, '@中', '@あい', '@cafe\u0301', '@a·b', 'UCabcdefghijklmnopqrstuv']) {
      assert.equal((await surface.request({ channel })).status, 200, channel);
    }
    const paths = surface.calls.map(url => new URL(url).pathname);
    assert.ok(paths.every(path => path.endsWith('/live')));
    assert.ok(paths.includes('/channel/UCabcdefghijklmnopqrstuv/live'));
    assert.ok(paths.includes('/@%E4%B8%AD/live'));
  }
});
