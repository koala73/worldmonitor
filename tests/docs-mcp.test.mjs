// RUN WITH: `npm run test:data` OR `node --import=tsx --test tests/docs-mcp.test.mjs`.
// The handler under test (api/docs-mcp.ts) imports ENDPOINT_RATE_POLICIES from
// server/_shared/rate-limit (extensionless TS). Plain `node --test` cannot
// resolve that import and will fail with ERR_MODULE_NOT_FOUND — this is
// expected; use tsx (the project's standard test runner).
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import handler, {
  buildJsonRpcError,
  classifyJsonRpcRequest,
  liftProtocolErrorFromToolResult,
  normalizeToolCallResponseBody,
} from '../api/docs-mcp.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// No Upstash env is set in this suite, so checkScopedRateLimit degrades
// availability-first (fail-open) and the handler proceeds to the upstream —
// which every test below mocks.
function mockUpstream(body, { contentType = 'text/event-stream', status = 200 } = {}) {
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
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
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
  it('answers malformed JSON locally with a structured -32700 error and CORS headers', async () => {
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

  it('answers OPTIONS preflight locally with permissive CORS', async () => {
    const res = await handler(
      new Request('https://www.worldmonitor.app/api/docs-mcp', { method: 'OPTIONS' }),
    );
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  });

  it('maps upstream fetch failures to a structured -32603 error', async () => {
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
