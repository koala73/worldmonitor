import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import handler, { isValidChannel, toChannelPath } from '../api/youtube/live.js';
import { __resetRateLimitForTest } from '../api/_rate-limit.js';

const makeRequest = (query) => new Request(`https://api.worldmonitor.app/api/youtube/live${query}`);

const originalFetch = globalThis.fetch;
const UPSTASH_HOST = 'https://fake-upstash.example';

// Route every outbound call through a recorder so a test can assert WHICH
// upstreams were reached and in what order. Upstash throws (checkRateLimit then
// fails open); YouTube returns a benign miss.
function installFetchRecorder() {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(UPSTASH_HOST)) {
      calls.push('upstash');
      throw new Error('upstash unreachable');
    }
    calls.push('youtube');
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

function withUpstashConfigured() {
  process.env.UPSTASH_REDIS_REST_URL = UPSTASH_HOST;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
}

function resetEnvAndLimiter() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.WS_RELAY_URL;
  __resetRateLimitForTest();
  globalThis.fetch = originalFetch;
}

test('accepts YouTube handles and canonical channel ids', () => {
  assert.equal(isValidChannel('@SkyNews'), true);
  assert.equal(isValidChannel('SkyNews'), true);
  assert.equal(isValidChannel('UCXuqSBlHAE6Xw-yeJA0Tunw'), true);
});

test('accepts non-ASCII YouTube handles', () => {
  // Regression guard: an ASCII-only handle class 400s this shipped channel and
  // takes it permanently offline, since it has no fallbackVideoId or hlsUrl.
  assert.equal(isValidChannel('@中天新聞CtiNews'), true);
});

test('every shipped live-news channel handle passes isValidChannel', () => {
  // Table-driven over the real catalog: a future tightening of CHANNEL_RE that
  // rejects any built-in channel fails here instead of in production.
  const panelSrc = readFileSync(
    fileURLToPath(new URL('../src/components/LiveNewsPanel.ts', import.meta.url)),
    'utf8',
  );
  const handles = [...new Set([...panelSrc.matchAll(/handle:\s*'([^']+)'/g)].map((m) => m[1]))];
  assert.ok(handles.length > 50, `expected the shipped channel catalog, found ${handles.length} handles`);
  const rejected = handles.filter((h) => !isValidChannel(h));
  assert.deepEqual(rejected, [], `these shipped handles would now 400: ${rejected.join(', ')}`);
});

test('rejects channel values that escape the YouTube channel path', () => {
  assert.equal(isValidChannel('@x/../../watch?v=abc'), false);
  assert.equal(isValidChannel('@x?foo=bar'), false);
  assert.equal(isValidChannel('@x#frag'), false);
  assert.equal(isValidChannel('@x&y=1'), false);
  assert.equal(isValidChannel('@x%2F..'), false);
  assert.equal(isValidChannel('@x\\y'), false);
  assert.equal(isValidChannel('a'.repeat(200)), false);
  assert.equal(isValidChannel(''), false);
});

test('builds the right YouTube path for each accepted channel shape', () => {
  // A canonical id lives at /channel/UCxxxx; prefixing '@' onto it 404s.
  assert.equal(toChannelPath('UCXuqSBlHAE6Xw-yeJA0Tunw'), 'channel/UCXuqSBlHAE6Xw-yeJA0Tunw');
  assert.equal(toChannelPath('@SkyNews'), '@SkyNews');
  assert.equal(toChannelPath('SkyNews'), '@SkyNews');
});

test('handler rejects malformed channel and videoId before any upstream fetch', async (t) => {
  withUpstashConfigured();
  const calls = installFetchRecorder();
  t.after(resetEnvAndLimiter);

  const badChannel = await handler(makeRequest('?channel=%40x%2F..%2F..%2Fwatch'));
  assert.equal(badChannel.status, 400);
  assert.equal((await badChannel.json()).error, 'Invalid channel parameter');

  // 'notavalidid' is exactly 11 chars of [A-Za-z0-9_-] and therefore VALID —
  // use a value the regex genuinely rejects.
  const badVideo = await handler(makeRequest('?videoId=not-a-valid-id'));
  assert.equal(badVideo.status, 400);
  assert.equal((await badVideo.json()).error, 'Invalid videoId parameter');

  const empty = await handler(makeRequest(''));
  assert.equal(empty.status, 400);

  // The name of this test is only true if nothing went out on the wire.
  assert.deepEqual(calls, [], `expected zero upstream calls, got: ${calls.join(', ')}`);
});

test('malformed-input 400s explain the accepted shape', async () => {
  const badChannel = await handler(makeRequest('?channel=%40x%3Ffoo'));
  assert.match((await badChannel.json()).error_description, /handle|channel id/i);

  const badVideo = await handler(makeRequest('?videoId=short'));
  assert.match((await badVideo.json()).error_description, /11-character/i);
});

test('valid input is metered by the rate limiter before reaching YouTube', async (t) => {
  withUpstashConfigured();
  const calls = installFetchRecorder();
  t.after(resetEnvAndLimiter);

  const res = await handler(makeRequest('?videoId=iEpJwprxDdk'));

  // Upstash unreachable -> checkRateLimit fails open by design, so the request
  // still completes; what this pins is that the limiter was CONSULTED, and
  // consulted before any YouTube call. Deleting the checkRateLimit call from
  // live.js drops 'upstash' from this list and fails the assertion.
  assert.ok(calls.includes('upstash'), `rate limiter was never consulted; calls: ${calls.join(', ')}`);
  assert.equal(calls[0], 'upstash', `limiter must run before upstream; calls: ${calls.join(', ')}`);
  assert.equal(res.status, 200);
});
