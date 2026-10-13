import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { LOCAL_MCP_FETCH } from '../scripts/shared/local-mcp-config.mjs';

process.env.WM_SESSION_SECRET ||= 'local-mcp-fixture-session-secret-at-least-32-chars';
const { default: handler } = await import('../api/mcp-proxy.ts');
const originalFetch = globalThis.fetch;
const operatorKey = 'local-mcp-operator-fixture-key';
const targetUrl = 'http://127.0.0.1:8123/mcp';
const configured = (url = targetUrl) => JSON.stringify({
  osint: { url, headers: { Authorization: { env: 'LOCAL_MCP_TEST_TOKEN', prefix: 'Bearer ' } } },
});
const envNames = ['LOCAL_API_MODE', 'MCP_LOCAL_SERVERS', 'LOCAL_MCP_TEST_TOKEN', 'WORLDMONITOR_VALID_KEYS'];
let saved;

function request(body, key = operatorKey) {
  return new Request('http://localhost:3000/api/mcp-proxy', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': key },
    body: JSON.stringify({ serverUrl: 'mcp-local://osint', action: 'tools/list', ...body }),
  });
}

function upstream(seen) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, headers: new Headers(init.headers), redirect: init.redirect, body, localMcp: init[LOCAL_MCP_FETCH] });
    let result = {};
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: {} };
    if (body.method === 'tools/list') result = { tools: [{ name: 'latest_observations', inputSchema: { type: 'object' } }] };
    if (body.method === 'tools/call') result = { content: [{ type: 'text', text: 'fixture observations' }] };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
}

describe('configured local MCP proxy transport', () => {
  beforeEach(() => {
    saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.LOCAL_API_MODE = 'docker';
    process.env.MCP_LOCAL_SERVERS = configured();
    process.env.LOCAL_MCP_TEST_TOKEN = 'fixture-upstream-token';
    process.env.WORLDMONITOR_VALID_KEYS = operatorKey;
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    globalThis.fetch = originalFetch;
  });

  it('initializes and lists tools using only server credentials and the configured endpoint', async () => {
    const seen = [];
    globalThis.fetch = upstream(seen);
    const response = await handler(request({}));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).tools.map((tool) => tool.name), ['latest_observations']);
    assert.deepEqual(seen.map((call) => call.body.method), ['initialize', 'notifications/initialized', 'tools/list']);
    for (const call of seen) {
      assert.equal(call.url, targetUrl);
      assert.equal(call.headers.get('Authorization'), 'Bearer fixture-upstream-token');
      assert.equal(call.headers.get('X-WorldMonitor-Key'), null);
      assert.equal(call.redirect, 'manual');
      assert.equal(call.localMcp, true);
    }
  });

  it('calls a tool with the selected arguments through the configured server', async () => {
    const seen = [];
    globalThis.fetch = upstream(seen);
    const response = await handler(request({ action: undefined, toolName: 'latest_observations', toolArgs: { area: 'test' } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.content[0].text, 'fixture observations');
    assert.deepEqual(seen.at(-1).body.params, { name: 'latest_observations', arguments: { area: 'test' } });
  });

  it('never marks ordinary public MCP requests as configured local traffic', async () => {
    const resolver = Symbol.for('worldmonitor.mcpProxy.resolveHostnameForTest');
    const previous = globalThis[resolver];
    globalThis[resolver] = async () => ['93.184.216.34'];
    try {
      const seen = [];
      globalThis.fetch = upstream(seen);
      assert.equal((await handler(request({ serverUrl: 'https://mcp.example.com/mcp' }))).status, 200);
      assert.equal(seen.length, 3);
      assert.ok(seen.every((call) => call.localMcp === undefined));
    } finally {
      if (previous === undefined) delete globalThis[resolver]; else globalThis[resolver] = previous;
    }
  });

  it('accepts the installation operator cookie without storing the MCP credential in the browser', async () => {
    globalThis.fetch = upstream([]);
    const req = request({}, '');
    req.headers.set('Cookie', `__Host-wm-pro-key=${operatorKey}`);
    assert.equal((await handler(req)).status, 200);
  });

  for (const [label, body] of [
    ['unknown alias', { serverUrl: 'mcp-local://unknown' }],
    ['alias path injection', { serverUrl: 'mcp-local://osint/admin' }],
    ['raw private URL', { serverUrl: targetUrl }],
    ['browser credential', { customHeaders: { Authorization: 'browser-secret' } }],
    ['browser environment reference', { customHeaders: { Authorization: { env: 'UNRELATED_SECRET' } } }],
  ]) {
    it(`refuses ${label} before contacting any upstream`, async () => {
      let calls = 0;
      globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
      const response = await handler(request(body));
      assert.equal(response.status, 400);
      assert.equal(calls, 0);
      assert.doesNotMatch(await response.text(), /browser-secret|fixture-upstream-token/);
    });
  }

  it('refuses an unauthenticated caller', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
    assert.equal((await handler(request({}, ''))).status, 401);
    assert.equal(calls, 0);
  });

  it('does not activate on a hosted deployment even with the operator key and configuration', async () => {
    delete process.env.LOCAL_API_MODE;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
    assert.equal((await handler(request({}))).status, 400);
    assert.equal(calls, 0);
  });

  it('fails closed when a configured credential is unavailable', async () => {
    delete process.env.LOCAL_MCP_TEST_TOKEN;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
    const response = await handler(request({}));
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
    assert.doesNotMatch(await response.text(), /LOCAL_MCP_TEST_TOKEN/);
  });

  for (const location of ['http://127.0.0.1:9000/private', 'https://example.com/steal', '/other']) {
    it(`never follows a configured local server redirect to ${location}`, async () => {
      const seen = [];
      globalThis.fetch = async (url) => {
        seen.push(url);
        return new Response(null, { status: 307, headers: { Location: location } });
      };
      const response = await handler(request({}));
      assert.equal(response.status, 422);
      assert.deepEqual(seen, [targetUrl]);
    });
  }

  it('supports legacy SSE on the configured origin and closes the stream', async () => {
    process.env.MCP_LOCAL_SERVERS = configured('http://127.0.0.1:8123/sse');
    const encoder = new TextEncoder();
    let controller;
    let cancelled = false;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push(url);
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-upstream-token');
      assert.equal(init[LOCAL_MCP_FETCH], true);
      if (!init.body) {
        return new Response(new ReadableStream({
          start(stream) { controller = stream; stream.enqueue(encoder.encode('event: endpoint\ndata: /messages?session=1\n\n')); },
          cancel() { cancelled = true; },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      const body = JSON.parse(init.body);
      if (body.id) controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [{ name: 'local_sse' }] } : {},
      })}\n\n`));
      return new Response(null, { status: 202 });
    };
    const response = await handler(request({}));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).tools[0].name, 'local_sse');
    assert.equal(cancelled, true);
    assert.deepEqual(seen, ['http://127.0.0.1:8123/sse', ...Array(3).fill('http://127.0.0.1:8123/messages?session=1')]);
  });

  for (const endpoint of ['http://127.0.0.1:9000/messages', 'https://example.com/messages', 'http://user:password@127.0.0.1:8123/messages']) {
    it(`rejects an SSE endpoint outside the configured authority: ${endpoint}`, async () => {
      process.env.MCP_LOCAL_SERVERS = configured('http://127.0.0.1:8123/sse');
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response(new ReadableStream({ start(stream) {
          stream.enqueue(new TextEncoder().encode(`event: endpoint\ndata: ${endpoint}\n\n`));
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      };
      assert.equal((await handler(request({}))).status, 422);
      assert.equal(calls, 1);
    });
  }
});
