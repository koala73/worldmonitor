import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';
import handler from '../api/oauth/register.js';
import { isAllowedRedirectUri } from '../api/oauth/_redirect-uri.js';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let writes;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  writes = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://redis.test/'));
    const body = JSON.parse(init.body);
    const pipeline = Array.isArray(body[0]);
    const results = (pipeline ? body : [body]).map(command => {
      if (['eval', 'evalsha'].includes(command[0].toLowerCase())) return { result: [4, 5] };
      assert.equal(command[0], 'SET');
      writes.push(command);
      return { result: 'OK' };
    });
    return Response.json(pipeline ? results : results[0]);
  };
});
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  Object.assign(process.env, originalEnv);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
});

function request(body, headers) {
  return new Request('https://api.worldmonitor.app/oauth/register', {
    method: 'POST', body, headers, duplex: 'half',
  });
}
function payload(uris = ['http://localhost:49152/callback'], name = 'Client') {
  return JSON.stringify({ redirect_uris: uris, client_name: name });
}
async function rejected(req, status, error) {
  const response = await handler(req);
  assert.equal(response.status, status);
  assert.equal((await response.json()).error, error);
  assert.deepEqual(writes, []);
}

it('rejects a declared oversized body without reading it', async () => {
  let reads = 0;
  const body = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
  const req = request(body, { 'content-length': '16385' });
  // A read must fail immediately on the old unbounded implementation, not hang.
  mock.method(req, 'json', async () => { reads++; throw new Error('unexpected parse'); });
  await rejected(req, 413, 'invalid_request');
  assert.equal(reads, 0);
});

for (const headers of [undefined, { 'content-length': '1' }, { 'content-length': 'invalid' }]) {
  it(`rejects actual body bytes regardless of length header ${JSON.stringify(headers)}`, async () => {
    await rejected(request(payload(undefined, 'é'.repeat(9000)), headers), 413, 'invalid_request');
  });
}

it('cancels chunked overflow without waiting for cancellation to settle', async () => {
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (++pulls <= 2) controller.enqueue(new Uint8Array(9000).fill(32));
      else controller.close();
    },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  await rejected(request(stream), 413, 'invalid_request');
  assert.equal(cancelled, true);
  assert.equal(pulls, 2);
});

it('accepts exactly 16 KiB and ignores unpersisted metadata', async () => {
  const base = payload();
  const response = await handler(request(base + ' '.repeat(16384 - Buffer.byteLength(base))));
  assert.equal(response.status, 201);
  assert.equal(writes.length, 1);
});

it('bounds each URI in UTF-8 bytes before parsing without echoing it', async () => {
  for (const uri of ['http://localhost/' + 'a'.repeat(2048), 'http://localhost/' + 'é'.repeat(1100)]) {
    const response = await handler(request(payload([uri])));
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.error, 'invalid_redirect_uri');
    assert.ok(!result.error_description.includes(uri));
  }
  assert.deepEqual(writes, []);
});

it('bounds serialized metadata including JSON escaping before writing', async () => {
  const uri = 'http://localhost/' + '\u0001'.repeat(1000);
  assert.equal(isAllowedRedirectUri(uri), true);
  assert.ok(Buffer.byteLength(payload([uri, uri])) < 16384);
  await rejected(request(payload([uri, uri])), 400, 'invalid_request');
});

it('preserves callbacks, arbitrary loopback ports, name truncation, response and TTL', async () => {
  const uris = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback', 'http://127.0.0.1:65535/callback?state=x'];
  const response = await handler(request(payload(uris, 'é'.repeat(101))));
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.client_name, 'é'.repeat(100));
  assert.deepEqual(result.redirect_uris, uris);
  assert.deepEqual(result.grant_types, ['authorization_code', 'refresh_token']);
  assert.equal(result.token_endpoint_auth_method, 'none');
  assert.equal(writes[0][1], `oauth:client:${result.client_id}`);
  assert.deepEqual(writes[0].slice(3), ['EX', 90 * 24 * 3600]);
  assert.deepEqual(JSON.parse(writes[0][2]).redirect_uris, uris);
  assert.ok(Buffer.byteLength(writes[0][2]) <= 8192);
});

it('accepts exactly 2048 URI bytes and multibyte stream chunks', async () => {
  const prefix = 'http://localhost:12345/';
  const uri = prefix + 'a'.repeat(2048 - prefix.length);
  const bytes = new TextEncoder().encode(payload([uri], '😀'));
  let offset = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) controller.close();
    else controller.enqueue(bytes.slice(offset, ++offset));
  } });
  assert.equal((await handler(request(stream))).status, 201);
  assert.equal(JSON.parse(writes[0][2]).client_name, '😀');
});

it('preserves malformed JSON, list cap, redirect rejection and default name', async () => {
  await rejected(request('{'), 400, 'invalid_request');
  await rejected(request(payload(Array(9).fill('http://localhost/'))), 400, 'invalid_request');
  await rejected(request(payload(['https://evil.test/'])), 400, 'invalid_redirect_uri');
  assert.equal((await handler(request(payload(undefined, null)))).status, 201);
  assert.equal(JSON.parse(writes[0][2]).client_name, 'Unknown Client');
});

it('accepts exactly 8192 metadata bytes and rejects one more byte', async () => {
  mock.method(Date, 'now', () => 1_800_000_000_000);
  const prefix = 'http://localhost/' + '\u0001'.repeat(1300);
  const metadata = { client_name: 'Client', redirect_uris: [prefix], created_at: Date.now() };
  const uri = prefix + 'a'.repeat(8192 - Buffer.byteLength(JSON.stringify(metadata)));
  assert.ok(Buffer.byteLength(uri) <= 2048);
  assert.equal((await handler(request(payload([uri])))).status, 201);
  assert.equal(Buffer.byteLength(writes[0][2]), 8192);
  writes.length = 0;
  await rejected(request(payload([uri + 'a'])), 400, 'invalid_request');
});

it('returns invalid JSON on an interrupted stream and releases its reader', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('disconnected')); } });
  await rejected(request(stream), 400, 'invalid_request');
  assert.equal(stream.locked, false);
  await rejected(request(undefined), 400, 'invalid_request');
});
