import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const TEST_KEY = 'rss-body-test-key';
process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
const { default: handler } = await import('./rss-proxy.js');
const { __resetRateLimitForTest } = await import('./_rate-limit.js');

beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.WS_RELAY_URL;
  __resetRateLimitForTest();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});

function makeRequest(feedUrl) {
  return new Request(`https://api.worldmonitor.app/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`, {
    headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': TEST_KEY },
  });
}
function spyFetch(respond) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push(String(input));
    return respond(String(input), init, calls);
  };
  return calls;
}

test('real fetch rejects a gzip body whose decoded bytes exceed the cap', async (t) => {
  const compressed = gzipSync('x'.repeat(5 * 1024 * 1024 + 1));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
    res.end(compressed);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // Only the transport destination is replaced; native fetch performs decompression.
  spyFetch((_url, init) => originalFetch(`http://127.0.0.1:${server.address().port}`, init));
  const response = await handler(makeRequest('https://techcrunch.com/feed'));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'Failed to fetch feed');
});

test('a response arriving after timeout has its body canceled', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchStarted = Promise.withResolvers();
  const bodyCanceled = Promise.withResolvers();
  let release;
  let canceled = false;
  spyFetch(() => new Promise((resolve) => {
    release = resolve;
    fetchStarted.resolve();
  }));
  const pending = handler(makeRequest('https://techcrunch.com/feed'));
  await fetchStarted.promise;
  assert.ok(release);
  t.mock.timers.tick(12_001);
  assert.equal((await pending).status, 504);
  release(new Response(new ReadableStream({ cancel() {
    canceled = true;
    bodyCanceled.resolve();
  } })));
  await bodyCanceled.promise;
  assert.equal(canceled, true);
});

test('a failed body read aborts transport, releases its reader and uses relay fallback', async () => {
  process.env.WS_RELAY_URL = 'wss://relay.example.com';
  let signal;
  const body = new ReadableStream({ pull(controller) { controller.error(new Error('connection lost')); } });
  spyFetch((_url, init, calls) => {
    if (calls.length > 1) return new Response('<rss/>');
    signal = init.signal;
    return new Response(body);
  });
  const response = await handler(makeRequest('https://techcrunch.com/feed'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<rss/>');
  assert.equal(signal.aborted, true);
  assert.equal(body.locked, false);
});

test('rejects decoded bodies over 5 MiB regardless of Content-Length and aborts consumption', async () => {
  for (const headers of [{}, { 'Content-Length': '1', 'Content-Encoding': 'gzip' }]) {
    let canceled = false;
    let signal;
    let chunks = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (chunks++ < 7) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
      cancel() { canceled = true; },
    });
    spyFetch((_url, init) => {
      signal = init.signal;
      return new Response(body, { headers });
    });
    const response = await handler(makeRequest('https://techcrunch.com/feed'));
    assert.equal(response.status, 502);
    assert.equal(canceled, true);
    assert.equal(signal.aborted, true);
    assert.equal(body.locked, false);
  }
});

test('body deadline covers slow chunks and cancels a stalled read without waiting for cancel', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const firstRead = Promise.withResolvers();
  const nextRead = Promise.withResolvers();
  let reads = 0;
  let canceled = false;
  let signal;
  let streamController;
  const body = new ReadableStream({
    start(controller) { streamController = controller; },
    pull() { (reads++ === 0 ? firstRead : nextRead).resolve(); },
    cancel() { canceled = true; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  spyFetch((_url, init) => { signal = init.signal; return new Response(body); });
  const pending = handler(makeRequest('https://techcrunch.com/feed'));
  // API-key hashing is async: scheduler turns do not prove read admission.
  // No prefetch means pull runs only when the proxy actually asks for a chunk.
  await firstRead.promise;
  assert.ok(signal);
  assert.equal(body.locked, true);
  t.mock.timers.tick(11_000);
  streamController.enqueue(new TextEncoder().encode('<rss>'));
  await nextRead.promise;
  t.mock.timers.tick(1_001);
  const response = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(canceled, true);
  assert.equal(response.status, 504);
  assert.equal(body.locked, false);
});

test('preserves split UTF-8 at the exact byte limit and clears the completed deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const text = '<rss>é</rss>' + ' '.repeat(5 * 1024 * 1024 - 13);
  const bytes = new TextEncoder().encode(text);
  assert.equal(bytes.byteLength, 5 * 1024 * 1024);
  let signal;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 6));
      controller.enqueue(bytes.slice(6));
      controller.close();
    },
  });
  spyFetch((_url, init) => { signal = init.signal; return new Response(body); });
  const response = await handler(makeRequest('https://techcrunch.com/feed'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), text);
  assert.equal(body.locked, false);
  t.mock.timers.tick(20_001);
  assert.equal(signal.aborted, false);
});

test('oversize direct body falls back to bounded relay with inert output and cache markers', async () => {
  process.env.WS_RELAY_URL = 'wss://relay.example.com';
  const calls = spyFetch((_url, _init, seen) => seen.length === 1
    ? new Response('x'.repeat(5 * 1024 * 1024 + 1))
    : new Response('<rss/>', { headers: { 'X-Cache': 'STALE', 'X-Relay-Stale': '1' } }));
  const response = await handler(makeRequest('https://techcrunch.com/feed'));
  assert.equal(calls.length, 2);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<rss/>');
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(response.headers.get('x-cache'), 'STALE');
  assert.equal(response.headers.get('x-relay-stale'), '1');
});

test('oversize relay retry preserves the original non-ok direct body and status', async () => {
  process.env.WS_RELAY_URL = 'wss://relay.example.com';
  spyFetch((_url, _init, seen) => seen.length === 1
    ? new Response('upstream unavailable', { status: 503 })
    : new Response('x'.repeat(5 * 1024 * 1024 + 1)));
  const response = await handler(makeRequest('https://techcrunch.com/feed'));
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'upstream unavailable');
});

test('relay-only body stalls time out and abort the relay transport', { timeout: 5000 }, async (t) => {
  process.env.WS_RELAY_URL = 'wss://relay.example.com';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let canceled = false;
  const readStarted = Promise.withResolvers();
  const body = new ReadableStream({
    pull() { readStarted.resolve(); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  const calls = spyFetch((_url, init) => { signal = init.signal; return new Response(body); });
  const pending = handler(makeRequest('https://rss.cnn.com/rss/edition.rss'));
  await readStarted.promise;
  assert.equal(body.locked, true);
  t.mock.timers.tick(12_001);
  assert.equal((await pending).status, 504);
  assert.equal(canceled, true);
  assert.equal(signal.aborted, true);
  assert.equal(calls.length, 1);
});

test('cancels an unused redirect body before rejecting its forbidden destination', async () => {
  let canceled = false;
  const body = new ReadableStream({ cancel() { canceled = true; } });
  const calls = spyFetch(() => new Response(body, {
    status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' },
  }));
  const response = await handler(makeRequest('https://techcrunch.com/feed'));
  assert.equal(response.status, 403);
  assert.equal(canceled, true);
  assert.equal(calls.length, 1);
});
