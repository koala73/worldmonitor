// RUN WITH: `npm run test:data` OR `npx tsx --test tests/mcp-proxy-node-entry.test.mjs`.
//
// Guard for the #4749 -> #4754 revert. On Vercel's Node runtime a
// default-exported function is invoked as `handler(req, res)` with a raw
// `http.IncomingMessage` / `http.ServerResponse` pair (@vercel/node
// serverless-handler: `return listener(req, res)`). The Web
// `(request: Request) => Response` signature is only dispatched for named
// GET/POST/... exports. #4749 declared `runtime: 'nodejs'` but kept the Web
// signature, so `req.headers.get()` threw on every request in production;
// `tests/mcp-proxy.test.mjs` never noticed because it hands the handler a
// `Request` object. This file drives the route's default export exactly the
// way the platform does — plain headers OBJECT, `method`, `url`, and a Node
// readable body — so the mismatch cannot ship again.
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { Readable } from 'node:stream';
import {
  applyVercelHelpersBodyShim,
  makeFakeNodeRequest,
  makeIncomingMessage,
  makeMcpFetch,
  makeServerResponse,
} from './helpers/node-http-shapes.mjs';

// The route imports server/_shared/premium-check, which loads api/_session.js
// at module scope; that module throws without a session secret.
process.env.WM_SESSION_SECRET ||= 'test-secret-must-be-at-least-32-chars-long-xxx';
const ENTERPRISE_KEY = 'test-enterprise-key-mcp-proxy-node-entry';
process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;

const TEST_RESOLVER_KEY = Symbol.for('worldmonitor.mcpProxy.resolveHostnameForTest');
const TEST_NODE_REQUEST_KEY = Symbol.for('worldmonitor.mcpProxy.nodeRequestForTest');
const PUBLIC_TEST_ADDRESS = '93.184.216.34';
const originalFetch = globalThis.fetch;

function baseHeaders(extra = {}) {
  return {
    host: 'worldmonitor.app',
    'x-forwarded-proto': 'https',
    origin: 'https://worldmonitor.app',
    'x-worldmonitor-key': ENTERPRISE_KEY,
    ...extra,
  };
}

function responseText(state) {
  return Buffer.concat(
    [...state.writes, ...state.endPayloads].map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))),
  ).toString('utf8');
}

describe('api/mcp-proxy Node runtime entry point (guard for #4749 / #4754)', () => {
  let handler;
  let pinnedRequests;

  beforeEach(async () => {
    const mod = await import(`../api/mcp-proxy.ts?entry=${Date.now()}`);
    handler = mod.default;
    globalThis[TEST_RESOLVER_KEY] = async () => [PUBLIC_TEST_ADDRESS];
    pinnedRequests = [];
    globalThis[TEST_NODE_REQUEST_KEY] = makeFakeNodeRequest({ seen: pinnedRequests });
    globalThis.fetch = makeMcpFetch({
      tools: [{ name: 'search', description: 'Web search', inputSchema: {} }],
      callResult: { content: [{ type: 'text', text: 'hello' }] },
    });
  });

  afterEach(() => {
    delete globalThis[TEST_RESOLVER_KEY];
    delete globalThis[TEST_NODE_REQUEST_KEY];
    globalThis.fetch = originalFetch;
  });

  it('is not declared as an Edge function — the (req, res) contract below only holds on the Node runtime', async () => {
    const mod = await import('../api/mcp-proxy.ts');
    assert.notEqual(
      mod.config?.runtime,
      'edge',
      'api/mcp-proxy.ts must run on the Node runtime (socket pinning needs node:https)',
    );
  });

  it('answers an OPTIONS preflight from a raw IncomingMessage/ServerResponse pair with 204 and no body', async () => {
    assert.equal(typeof handler, 'function');

    const req = makeIncomingMessage({
      method: 'OPTIONS',
      url: '/api/mcp-proxy',
      headers: {
        host: 'worldmonitor.app',
        'x-forwarded-proto': 'https',
        origin: 'https://worldmonitor.app',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-worldmonitor-key',
      },
    });
    const { res, state } = makeServerResponse();

    // #4749's shape rejects here: `req.headers.get is not a function`.
    await handler(req, res);

    assert.equal(state.statusCode, 204, 'preflight must answer 204');
    assert.equal(state.ended, true, 'the response must be finished with res.end()');
    assert.deepEqual(state.writes, [], 'a 204 must not write body chunks');
    assert.deepEqual(state.endPayloads, [], 'a 204 must be ended without a payload (writing to a null-body status is a protocol error)');
    assert.equal(state.headers['cache-control'], 'no-store');
    assert.equal(state.headers['access-control-allow-origin'], 'https://worldmonitor.app');
    assert.match(String(state.headers['access-control-allow-methods']), /OPTIONS/);
  });

  it('rebuilds the request URL from host + x-forwarded-proto and serves a GET tools/list as a buffered JSON body', async () => {
    const req = makeIncomingMessage({
      method: 'GET',
      url: '/api/mcp-proxy?serverUrl=https%3A%2F%2Fmcp.example.com%2Fmcp',
      headers: baseHeaders(),
    });
    const { res, state } = makeServerResponse();
    await handler(req, res);

    assert.equal(state.statusCode, 200);
    assert.equal(state.headers['content-type'], 'application/json');
    assert.equal(state.headers['cache-control'], 'no-store');
    const text = responseText(state);
    assert.equal(state.headers['content-length'], String(Buffer.byteLength(text)));
    assert.deepEqual(JSON.parse(text).tools.map((tool) => tool.name), ['search']);
    assert.equal(pinnedRequests.length, 3, 'initialize, notifications/initialized, tools/list');
    for (const entry of pinnedRequests) assert.equal(entry.address, PUBLIC_TEST_ADDRESS);
  });

  it('streams a chunked POST body into the bounded reader (no up-front buffering) and proxies the tool call', async () => {
    const payload = JSON.stringify({ serverUrl: 'https://mcp.example.com/mcp', toolName: 'search', toolArgs: { q: 'x' } });
    const req = makeIncomingMessage({
      method: 'POST',
      url: '/api/mcp-proxy',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: [payload.slice(0, 10), payload.slice(10, 40), payload.slice(40)],
    });
    const { res, state } = makeServerResponse();
    await handler(req, res);

    assert.equal(state.statusCode, 200, responseText(state));
    assert.deepEqual(JSON.parse(responseText(state)).result, { content: [{ type: 'text', text: 'hello' }] });
  });

  it("parses the POST body after @vercel/node's helpers have consumed the stream (restoreBody shim)", async () => {
    // Production: helpers are on by default, so the platform drains the
    // IncomingMessage before the handler runs and re-exposes the bytes only
    // through `req.on('data' | 'end')`. Readable.toWeb(req) reads an EMPTY
    // stream in that state (it consults stream.finished() on the drained
    // original) — which would 400 every real POST while every mocked test
    // stayed green. The adapter bridges on 'data'/'end' for exactly this.
    const payload = JSON.stringify({ serverUrl: 'https://mcp.example.com/mcp', toolName: 'search' });
    const req = makeIncomingMessage({
      method: 'POST',
      url: '/api/mcp-proxy',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: [payload],
    });
    const drained = [];
    for await (const chunk of req) drained.push(chunk);
    assert.equal(req.readableEnded, true, 'fixture must reproduce the drained IncomingMessage');
    applyVercelHelpersBodyShim(req, Buffer.concat(drained));

    const { res, state } = makeServerResponse();
    await handler(req, res);

    assert.equal(state.statusCode, 200, responseText(state));
    assert.deepEqual(JSON.parse(responseText(state)).result, { content: [{ type: 'text', text: 'hello' }] });
  });

  it('keeps the Content-Length early reject: an oversized advertised body is refused with 413 before it is read', async () => {
    const { MAX_JSON_RPC_BODY_BYTES } = await import('../api/mcp/body-limits.ts');
    const req = makeIncomingMessage({
      method: 'POST',
      url: '/api/mcp-proxy',
      headers: baseHeaders({ 'content-type': 'application/json', 'content-length': String(MAX_JSON_RPC_BODY_BYTES + 1) }),
      body: ['{"serverUrl":"https://mcp.example.com/mcp"'],
    });
    const { res, state } = makeServerResponse();
    await handler(req, res);

    assert.equal(state.statusCode, 413);
    assert.equal(JSON.parse(responseText(state)).error, `Request body exceeds ${MAX_JSON_RPC_BODY_BYTES} bytes`);
    assert.equal(pinnedRequests.length, 0, 'nothing may go upstream for a rejected body');
  });

  it('keeps the streaming byte cap: a chunked body with no Content-Length is cut off at the cap with 413', async () => {
    const { MAX_JSON_RPC_BODY_BYTES } = await import('../api/mcp/body-limits.ts');
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const chunks = [];
    for (let total = 0; total <= MAX_JSON_RPC_BODY_BYTES; total += chunk.byteLength) chunks.push(chunk);
    const req = makeIncomingMessage({
      method: 'POST',
      url: '/api/mcp-proxy',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: chunks,
    });
    const { res, state } = makeServerResponse();
    await handler(req, res);

    assert.equal(state.statusCode, 413);
    assert.equal(pinnedRequests.length, 0);
  });

  it('copies every inbound header into the Web request (origin gate, auth gate, array-valued headers)', async () => {
    const forbidden = makeIncomingMessage({
      method: 'GET',
      url: '/api/mcp-proxy?serverUrl=https%3A%2F%2Fmcp.example.com%2Fmcp',
      headers: baseHeaders({ origin: 'https://evil.example' }),
    });
    const forbiddenRes = makeServerResponse();
    await handler(forbidden, forbiddenRes.res);
    assert.equal(forbiddenRes.state.statusCode, 403, 'origin header must reach isDisallowedOrigin');

    const unauthenticated = makeIncomingMessage({
      method: 'GET',
      url: '/api/mcp-proxy?serverUrl=https%3A%2F%2Fmcp.example.com%2Fmcp',
      headers: { host: 'worldmonitor.app', origin: 'https://worldmonitor.app' },
    });
    const unauthenticatedRes = makeServerResponse();
    await handler(unauthenticated, unauthenticatedRes.res);
    assert.equal(unauthenticatedRes.state.statusCode, 401, 'auth gate must still run through the adapter');

    // Node hands set-cookie through as an array; the adapter must join it
    // rather than throw on a non-string header value.
    const arrayValued = makeIncomingMessage({
      method: 'GET',
      url: '/api/mcp-proxy?serverUrl=https%3A%2F%2Fmcp.example.com%2Fmcp',
      headers: baseHeaders({ 'set-cookie': ['a=1', 'b=2'] }),
    });
    const arrayValuedRes = makeServerResponse();
    await handler(arrayValued, arrayValuedRes.res);
    assert.equal(arrayValuedRes.state.statusCode, 200, responseText(arrayValuedRes.state));
  });

  it('answers an unexpected failure with a 500 JSON body and no-store instead of leaking an unhandled rejection', async () => {
    const req = makeIncomingMessage({
      method: 'GET',
      // Not a resolvable path/URL pair: `new URL()` throws inside the adapter.
      url: 'https://exa mple.com/api/mcp-proxy',
      headers: baseHeaders(),
    });
    const { res, state } = makeServerResponse();
    await handler(req, res);

    assert.equal(state.statusCode, 500);
    assert.equal(state.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(responseText(state)), { error: 'Internal error' });
  });

  it('does not leave the body unread on a GET (no body stream is attached to a bodiless method)', async () => {
    const req = makeIncomingMessage({
      method: 'GET',
      url: '/api/mcp-proxy?serverUrl=https%3A%2F%2Fmcp.example.com%2Fmcp',
      headers: baseHeaders(),
    });
    assert.ok(req instanceof Readable);
    const { res, state } = makeServerResponse();
    await handler(req, res);
    assert.equal(state.statusCode, 200);
  });
});
