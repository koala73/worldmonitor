// RUN WITH: `npm run test:data` OR `node --import=tsx --test tests/docs-mcp.test.mjs`.
// The handler under test (api/docs-mcp.ts) imports ENDPOINT_RATE_POLICIES from
// server/_shared/rate-limit (extensionless TS). Plain `node --test` cannot
// resolve that import and will fail with ERR_MODULE_NOT_FOUND — this is
// expected; use tsx (the project's standard test runner).
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { Ratelimit } from '@upstash/ratelimit';
import handler, {
  buildJsonRpcError,
  classifyJsonRpcRequest,
  liftProtocolErrorFromToolResult,
  normalizeToolCallResponseBody,
} from '../api/docs-mcp.ts';
import { __resetRateLimitForTest } from '../server/_shared/rate-limit.ts';
import { CACHE_POLICY_HEADER_NAME, CDN_CACHE_HEADERS } from './helpers/shared-cache-policy.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalSlidingWindow = Ratelimit.slidingWindow;

function clearUpstashEnv() {
  // This suite assumes Redis is absent so checkScopedRateLimit fails open
  // without an Upstash fetch. Cloud agent / local envs may inject UPSTASH_*.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

afterEach(() => {
  __resetRateLimitForTest();
  Ratelimit.slidingWindow = originalSlidingWindow;
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

function forceRateLimitDenial() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  __resetRateLimitForTest();
  const calls = [];
  Ratelimit.slidingWindow = (tokens, window) => () => ({
    async limit(_ctx, key) {
      calls.push({ key, tokens, window });
      return {
        success: false,
        limit: tokens,
        remaining: 0,
        reset: Date.now() + 60_000,
        pending: Promise.resolve(),
      };
    },
  });
  return calls;
}

// No Upstash env is set in this suite, so checkScopedRateLimit degrades
// availability-first (fail-open) and the handler proceeds to the upstream —
// which every test below mocks.
function mockUpstream(body, { contentType = 'text/event-stream', status = 200 } = {}) {
  clearUpstashEnv();
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers: { 'content-type': contentType } });
  };
  return calls;
}

function post(body, headers = {}) {
  return new Request('https://www.worldmonitor.app/api/docs-mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-real-ip': '203.0.113.42',
      ...headers,
    },
    body,
  });
}

describe('docs-mcp classifyJsonRpcRequest', () => {
  it('flags non-JSON bodies', () => {
    assert.deepEqual(classifyJsonRpcRequest('not json{'), { kind: 'invalid-json' });
  });

  it('flags envelopes without jsonrpc/method, preserving the id', () => {
    assert.deepEqual(classifyJsonRpcRequest('{"id": 7}'), { kind: 'invalid-request', id: 7 });
    assert.deepEqual(classifyJsonRpcRequest('{"jsonrpc":"2.0","id":"a"}'), {
      kind: 'invalid-request',
      id: 'a',
    });
    assert.deepEqual(classifyJsonRpcRequest('"just a string"'), { kind: 'invalid-request', id: null });
  });

  it('classifies well-formed single requests and forwards batches untouched', () => {
    assert.deepEqual(
      classifyJsonRpcRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}'),
      { kind: 'single', method: 'tools/call', id: 1 },
    );
    assert.deepEqual(classifyJsonRpcRequest('[{"jsonrpc":"2.0","id":1,"method":"ping"}]'), {
      kind: 'forward',
    });
  });
});

describe('docs-mcp liftProtocolErrorFromToolResult', () => {
  const unknownToolEnvelope = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: 'MCP error -32602: Tool nonexistent_tool not found' }],
      structuredContent: { code: -32602, message: 'Tool nonexistent_tool not found' },
      isError: true,
    },
  };

  it("lifts the upstream's unknown-tool isError result into a JSON-RPC error", () => {
    assert.deepEqual(
      liftProtocolErrorFromToolResult(unknownToolEnvelope),
      buildJsonRpcError(1, -32602, 'Tool nonexistent_tool not found'),
    );
  });

  it('falls back to parsing the text block when structuredContent is missing', () => {
    const envelope = {
      jsonrpc: '2.0',
      id: 'req-2',
      result: {
        content: [{ type: 'text', text: 'MCP error -32601: Method not found' }],
        isError: true,
      },
    };
    assert.deepEqual(
      liftProtocolErrorFromToolResult(envelope),
      buildJsonRpcError('req-2', -32601, 'Method not found'),
    );
  });

  it('leaves genuine tool-execution failures as isError results', () => {
    const executionFailure = {
      jsonrpc: '2.0',
      id: 3,
      result: {
        content: [{ type: 'text', text: 'search backend timed out after 10s' }],
        isError: true,
      },
    };
    assert.equal(liftProtocolErrorFromToolResult(executionFailure), null);
    // Non-protocol code in structuredContent must not be lifted either.
    const applicationCode = {
      jsonrpc: '2.0',
      id: 4,
      result: { structuredContent: { code: -32000, message: 'backend error' }, isError: true },
    };
    assert.equal(liftProtocolErrorFromToolResult(applicationCode), null);
  });

  it('ignores successful results and envelopes that already carry an error', () => {
    assert.equal(
      liftProtocolErrorFromToolResult({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
      null,
    );
    assert.equal(
      liftProtocolErrorFromToolResult({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'already structured' },
      }),
      null,
    );
  });
});

describe('docs-mcp normalizeToolCallResponseBody', () => {
  const sseBody = [
    'event: message',
    'data: {"result":{"content":[{"type":"text","text":"MCP error -32602: Tool nope not found"}],"structuredContent":{"code":-32602,"message":"Tool nope not found"},"isError":true},"jsonrpc":"2.0","id":1}',
    '',
    '',
  ].join('\n');

  it('rewrites the single-event SSE unknown-tool envelope in place, preserving framing', () => {
    const normalized = normalizeToolCallResponseBody(sseBody, 'text/event-stream');
    assert.ok(normalized, 'expected the SSE body to be rewritten');
    const lines = normalized.split('\n');
    assert.equal(lines[0], 'event: message');
    assert.deepEqual(
      JSON.parse(lines[1].slice('data: '.length)),
      buildJsonRpcError(1, -32602, 'Tool nope not found'),
    );
    assert.equal(lines.at(-1), '', 'trailing SSE frame separator must survive');
  });

  it('rewrites plain-JSON envelopes too', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      result: { structuredContent: { code: -32602, message: 'Invalid arguments' }, isError: true },
    });
    assert.deepEqual(
      JSON.parse(normalizeToolCallResponseBody(body, 'application/json')),
      buildJsonRpcError(9, -32602, 'Invalid arguments'),
    );
  });

  it('passes through successful results, multi-event streams, and unknown content types', () => {
    const okSse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n';
    assert.equal(normalizeToolCallResponseBody(okSse, 'text/event-stream'), null);
    const multiEvent = `${sseBody}\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n`;
    assert.equal(normalizeToolCallResponseBody(multiEvent, 'text/event-stream'), null);
    assert.equal(normalizeToolCallResponseBody(sseBody, 'text/plain'), null);
    assert.equal(normalizeToolCallResponseBody('not json', 'application/json'), null);
  });
});

describe('docs-mcp handler', () => {
  it('echoes string and numeric request ids, including 0, on a forced -32029 denial', async () => {
    const limiterCalls = forceRateLimitDenial();
    for (const id of ['docs-rate-1', 7, 0]) {
      const res = await handler(post(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })));
      assert.equal(res.status, 429);
      const payload = await res.json();
      assert.equal(payload.id, id);
      assert.equal(payload.error.code, -32029);
    }
    const unsafe = await handler(post(JSON.stringify({
      jsonrpc: '2.0',
      id: '🚀'.repeat(65),
      method: 'tools/list',
    })));
    assert.equal((await unsafe.json()).id, null, 'a string id over 256 UTF-8 bytes must not be echoed');
    const nonFinite = await handler(post('{"jsonrpc":"2.0","id":1e400,"method":"tools/list"}'));
    assert.equal((await nonFinite.json()).id, null, 'a non-finite numeric id must not be echoed');
    assert.deepEqual(
      limiterCalls,
      Array.from({ length: 5 }, () => ({
        key: 'rl:scope:/api/docs-mcp:203.0.113.42',
        tokens: 60,
        window: '60 s',
      })),
      'the production limiter key and 60/min/IP policy must stay unchanged',
    );
  });

  it('rejects a UTF-8 request body whose encoded size exceeds 256 KiB', async () => {
    const limiterCalls = forceRateLimitDenial();
    const upstreamCalls = [];
    globalThis.fetch = async (url) => {
      upstreamCalls.push(String(url));
      return new Response('{}');
    };
    // Each e-acute is one JavaScript UTF-16 code unit but two UTF-8 bytes.
    // Including the JSON quotes, this stays well below the cap by .length
    // while exceeding it on the wire.
    const prefix = '{"jsonrpc":"2.0","id":"oversized-docs","method":"tools/call","params":{"text":"';
    const body = `${prefix}${'é'.repeat(131_072)}"}}`;
    assert.ok(body.length < 262_144);
    assert.ok(new TextEncoder().encode(body).byteLength > 262_144);

    const res = await handler(post(body));

    assert.equal(res.status, 413);
    assert.equal(
      upstreamCalls.filter((url) => url.includes('mintlify')).length,
      0,
      'oversized bodies must not reach the upstream',
    );
    const payload = await res.json();
    assert.equal(payload.id, null, 'an oversized body must not echo an id');
    assert.equal(payload.error.code, -32600);
    assert.equal(limiterCalls.length, 0, 'the byte cap must reject before the scoped limiter runs');
  });

  it('counts a leading UTF-8 BOM against the raw 256 KiB request limit', async () => {
    clearUpstashEnv();
    const upstreamCalls = [];
    globalThis.fetch = async (url) => {
      upstreamCalls.push(String(url));
      return new Response('{}');
    };
    const rpc = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    const decodedBody = `${rpc}${' '.repeat(262_144 - rpc.length)}`;
    const encodedBody = new TextEncoder().encode(decodedBody);
    assert.equal(encodedBody.byteLength, 262_144);

    const wireBody = new Uint8Array(encodedBody.byteLength + 3);
    wireBody.set([0xef, 0xbb, 0xbf]);
    wireBody.set(encodedBody, 3);

    const res = await handler(post(wireBody));

    assert.equal(res.status, 413);
    assert.equal(
      upstreamCalls.filter((url) => url.includes('mintlify')).length,
      0,
      'BOM-prefixed oversized bodies must not reach the upstream',
    );
    const payload = await res.json();
    assert.equal(payload.error.code, -32600);
  });

  it('answers malformed JSON locally with a structured -32700 error and CORS headers', async () => {
    clearUpstashEnv();
    let upstreamCalled = false;
    globalThis.fetch = async () => {
      upstreamCalled = true;
      return new Response('{}');
    };
    const res = await handler(post('this is not json'));
    assert.equal(res.status, 400);
    assert.equal(upstreamCalled, false, 'parse errors must not reach the upstream');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.error.code, -32700);
    assert.ok(body.error.message.length > 0);
  });

  it('answers non-JSON-RPC envelopes locally with -32600', async () => {
    clearUpstashEnv();
    const res = await handler(post('{"hello":"world","id":5}'));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, -32600);
    assert.equal(body.id, 5);
  });

  it('lifts the upstream unknown-tool SSE envelope into a top-level JSON-RPC error', async () => {
    const sse =
      'event: message\ndata: {"result":{"content":[{"type":"text","text":"MCP error -32602: Tool nope not found"}],"structuredContent":{"code":-32602,"message":"Tool nope not found"},"isError":true},"jsonrpc":"2.0","id":1}\n\n';
    const calls = mockUpstream(sse);
    const res = await handler(
      post('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nope","arguments":{}}}'),
    );
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://worldmonitor.mintlify.dev/docs/mcp');
    const text = await res.text();
    const data = JSON.parse(text.split('\n').find((l) => l.startsWith('data: ')).slice('data: '.length));
    assert.deepEqual(data, buildJsonRpcError(1, -32602, 'Tool nope not found'));
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
  });

  it('passes successful tools/call responses through byte-for-byte', async () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"hit"}]}}\n\n';
    mockUpstream(sse);
    const res = await handler(
      post('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_world_monitor","arguments":{"query":"auth"}}}'),
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), sse);
  });

  it('forwards non-tools/call methods without buffering or rewriting', async () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"tools":[]}}\n\n';
    mockUpstream(sse);
    const res = await handler(post('{"jsonrpc":"2.0","id":3,"method":"tools/list"}'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), sse);
  });

  it('forces no-store on proxied responses, including the cacheable 405 Mintlify returns for a bare GET', async () => {
    clearUpstashEnv();
    // Every header that can carry a shared-cache policy, from the shared list:
    // a CDN-specific one left in place outranks the handler's no-store.
    const upstreamHeaders = {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=0, must-revalidate',
      ...Object.fromEntries(CDN_CACHE_HEADERS.map((name) => [name.toLowerCase(), 'public, s-maxage=600, stale-while-revalidate=60'])),
    };
    globalThis.fetch = async () =>
      new Response('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}', {
        status: 405,
        headers: upstreamHeaders,
      });
    const res = await handler(
      new Request('https://www.worldmonitor.app/api/docs-mcp', { method: 'GET', headers: { accept: 'application/json' } }),
    );
    assert.equal(res.status, 405, 'the upstream status is preserved');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    for (const name of CDN_CACHE_HEADERS) {
      assert.equal(res.headers.get(name), null, `${name} must be stripped from the proxied response`);
    }
    for (const [name, value] of res.headers) {
      assert.ok(!CACHE_POLICY_HEADER_NAME.test(name) || value === 'no-store', `${name}: ${value} is a shared-cache policy`);
    }
    assert.equal(res.headers.get('content-type'), 'application/json');
  });

  it('answers OPTIONS preflight locally with permissive CORS', async () => {
    const res = await handler(
      new Request('https://www.worldmonitor.app/api/docs-mcp', { method: 'OPTIONS' }),
    );
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  });

  it('maps upstream fetch failures to a structured -32603 error', async () => {
    clearUpstashEnv();
    globalThis.fetch = async () => {
      throw new Error('connect ETIMEDOUT');
    };
    const res = await handler(post('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{}}'));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, -32603);
    assert.equal(body.id, 8);
  });
});
