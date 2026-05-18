import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, before } from 'node:test';

// validateApiKey (added to handler for issue #3723) requires a valid
// X-WorldMonitor-Key. Mint a real wms_ session token for the positive-path
// tests; explicit "no key" / "no origin" tests live in their own block.
process.env.WM_SESSION_SECRET ||= 'test-secret-must-be-at-least-32-chars-long-xxx';
const { issueSessionToken } = await import('../api/_session.js');
let SESSION_TOKEN;
before(async () => {
  SESSION_TOKEN = (await issueSessionToken()).token;
});

const originalFetch = globalThis.fetch;

function buildHeaders(origin, { authed = true, extra = {} } = {}) {
  const h = { ...extra };
  if (origin !== null) h.origin = origin;
  if (authed) h['X-WorldMonitor-Key'] = SESSION_TOKEN;
  return h;
}

function makeGetRequest(params = {}, origin = 'https://worldmonitor.app', opts = {}) {
  const url = new URL('https://worldmonitor.app/api/mcp-proxy');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return new Request(url.toString(), {
    method: 'GET',
    headers: buildHeaders(origin, opts),
  });
}

function makePostRequest(body = {}, origin = 'https://worldmonitor.app', opts = {}) {
  return new Request('https://worldmonitor.app/api/mcp-proxy', {
    method: 'POST',
    headers: buildHeaders(origin, { ...opts, extra: { 'Content-Type': 'application/json', ...(opts.extra || {}) } }),
    body: JSON.stringify(body),
  });
}

function makeOptionsRequest(origin = 'https://worldmonitor.app') {
  return new Request('https://worldmonitor.app/api/mcp-proxy', {
    method: 'OPTIONS',
    headers: { origin },
  });
}

// Minimal MCP server stub — returns valid JSON-RPC responses
function makeMcpFetch({ initStatus = 200, listStatus = 200, callStatus = 200, tools = [], callResult = { content: [] } } = {}) {
  return async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (body.method === 'initialize' || body.method === 'notifications/initialized') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }), {
        status: initStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (body.method === 'tools/list') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools } }), {
        status: listStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (body.method === 'tools/call') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: callResult }), {
        status: callStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

let handler;

describe('api/mcp-proxy', () => {
  beforeEach(async () => {
    const mod = await import(`../api/mcp-proxy.js?t=${Date.now()}`);
    handler = mod.default;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Auth gate (issue #3723) ───────────────────────────────────────────────

  describe('Auth gate', () => {
    it('returns 401 when no X-WorldMonitor-Key is provided', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }, 'https://worldmonitor.app', { authed: false }));
      assert.equal(res.status, 401);
    });

    it('returns 401 for curl-style request (no Origin, no key) — the #3723 bypass', async () => {
      // isDisallowedOrigin returns false on null Origin (correct for legit
      // server-to-server callers on other endpoints). The auth check is what
      // closes the bypass here.
      const url = new URL('https://worldmonitor.app/api/mcp-proxy');
      url.searchParams.set('serverUrl', 'https://mcp.example.com/mcp');
      const res = await handler(new Request(url.toString(), { method: 'GET' }));
      assert.equal(res.status, 401);
    });

    it('returns 401 for POST without key', async () => {
      const res = await handler(makePostRequest({ serverUrl: 'https://mcp.example.com/mcp', toolName: 'search' }, 'https://worldmonitor.app', { authed: false }));
      assert.equal(res.status, 401);
    });

    it('still returns 204 for OPTIONS preflight without key (preflights must not require auth)', async () => {
      const res = await handler(makeOptionsRequest());
      assert.equal(res.status, 204);
    });

    // wm_ user-key fallback (PR review finding). validateApiKey returns
    // {required:true, valid:false} for wm_ keys so the API-gateway can do
    // Convex-backed validation — but /api/mcp-proxy is a direct Edge
    // function with no gateway in front, so it must mirror the gateway's
    // wm_ fallback inline. Without it, every wm_ user API key 401s here
    // even though the PR description advertised wm_ support.
    it('rejects a wm_ user key that Convex says is invalid', async () => {
      // No CONVEX_SITE_URL / CONVEX_SERVER_SHARED_SECRET set in test env →
      // validateUserApiKey returns null → wm_ key still rejected. Asserts
      // the wm_ branch fails safely when the validator can't run.
      const url = new URL('https://worldmonitor.app/api/mcp-proxy');
      url.searchParams.set('serverUrl', 'https://mcp.example.com/mcp');
      const req = new Request(url.toString(), {
        method: 'GET',
        headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': 'wm_user_definitely_not_real_abc123' },
      });
      const res = await handler(req);
      assert.equal(res.status, 401);
    });
  });

  // ── CORS / method guards ──────────────────────────────────────────────────

  describe('CORS and method handling', () => {
    it('returns 403 for disallowed origin', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }, 'https://evil.com'));
      assert.equal(res.status, 403);
    });

    it('returns 204 for OPTIONS preflight', async () => {
      const res = await handler(makeOptionsRequest());
      assert.equal(res.status, 204);
    });

    it('returns 405 for DELETE', async () => {
      const res = await handler(new Request('https://worldmonitor.app/api/mcp-proxy', {
        method: 'DELETE',
        headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }));
      assert.equal(res.status, 405);
    });

    it('returns 405 for PUT', async () => {
      const res = await handler(new Request('https://worldmonitor.app/api/mcp-proxy', {
        method: 'PUT',
        headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
        body: '{}',
      }));
      assert.equal(res.status, 405);
    });
  });

  // ── GET — list tools ──────────────────────────────────────────────────────

  describe('GET /api/mcp-proxy (list tools)', () => {
    it('returns 400 when serverUrl is missing', async () => {
      const res = await handler(makeGetRequest());
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /serverUrl/i);
    });

    it('returns 400 for non-http(s) protocol', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'ftp://mcp.example.com/mcp' }));
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /invalid serverUrl/i);
    });

    it('returns 400 for localhost', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'http://localhost/mcp' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for 127.x.x.x', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'http://127.0.0.1:8080/mcp' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for 10.x.x.x (RFC1918)', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'http://10.0.0.1/mcp' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for 192.168.x.x (RFC1918)', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'http://192.168.1.1/mcp' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for 172.16.x.x (RFC1918)', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'http://172.16.0.1/mcp' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for link-local 169.254.x.x (cloud metadata)', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'http://169.254.169.254/latest/meta-data/' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for garbled URL', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'not a url at all' }));
      assert.equal(res.status, 400);
    });

    it('returns 200 with tools array on successful list', async () => {
      const sampleTools = [{ name: 'search', description: 'Web search', inputSchema: {} }];
      globalThis.fetch = makeMcpFetch({ tools: sampleTools });
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.tools));
      assert.equal(data.tools.length, 1);
      assert.equal(data.tools[0].name, 'search');
    });

    it('returns empty tools array when server returns none', async () => {
      globalThis.fetch = makeMcpFetch({ tools: [] });
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data.tools, []);
    });

    it('returns 422 when upstream returns non-ok status', async () => {
      globalThis.fetch = makeMcpFetch({ initStatus: 401 });
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 422);
    });

    it('returns 422 when upstream returns JSON-RPC error', async () => {
      globalThis.fetch = async () => new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.match(data.error, /Method not found/i);
    });

    it('returns 504 on fetch timeout', async () => {
      globalThis.fetch = async () => {
        const err = new Error('The operation timed out.');
        err.name = 'TimeoutError';
        throw err;
      };
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 504);
      const data = await res.json();
      assert.match(data.error, /timed out/i);
    });

    it('ignores invalid JSON in headers param', async () => {
      globalThis.fetch = makeMcpFetch({ tools: [] });
      const url = new URL('https://worldmonitor.app/api/mcp-proxy');
      url.searchParams.set('serverUrl', 'https://mcp.example.com/mcp');
      url.searchParams.set('headers', 'not json');
      const req = new Request(url.toString(), { method: 'GET', headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN } });
      const res = await handler(req);
      assert.equal(res.status, 200);
    });

    it('passes custom headers to upstream', async () => {
      let capturedHeaders = {};
      globalThis.fetch = async (url, opts) => {
        capturedHeaders = Object.fromEntries(Object.entries(opts?.headers || {}));
        return makeMcpFetch({ tools: [] })(url, opts);
      };
      const res = await handler(makeGetRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        headers: JSON.stringify({ Authorization: 'Bearer test-key' }),
      }));
      assert.equal(res.status, 200);
      assert.equal(capturedHeaders['Authorization'], 'Bearer test-key');
    });

    it('strips CRLF from injected headers', async () => {
      let capturedHeaders = {};
      globalThis.fetch = async (url, opts) => {
        capturedHeaders = Object.fromEntries(Object.entries(opts?.headers || {}));
        return makeMcpFetch({ tools: [] })(url, opts);
      };
      const res = await handler(makeGetRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        headers: JSON.stringify({ 'X-Evil\r\nInjected': 'bad' }),
      }));
      assert.equal(res.status, 200);
      for (const k of Object.keys(capturedHeaders)) {
        assert.ok(!k.includes('\r') && !k.includes('\n'), `Header key contains CRLF: ${JSON.stringify(k)}`);
      }
    });
  });

  // ── POST — call tool ──────────────────────────────────────────────────────

  describe('POST /api/mcp-proxy (call tool)', () => {
    it('returns 400 when serverUrl is missing', async () => {
      const res = await handler(makePostRequest({ toolName: 'search' }));
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /serverUrl/i);
    });

    it('returns 400 when toolName is missing', async () => {
      const res = await handler(makePostRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /toolName/i);
    });

    it('returns 400 for blocked host in POST body', async () => {
      const res = await handler(makePostRequest({
        serverUrl: 'http://localhost/mcp',
        toolName: 'search',
      }));
      assert.equal(res.status, 400);
    });

    it('returns 200 with result on successful tool call', async () => {
      const callResult = { content: [{ type: 'text', text: 'Hello' }] };
      globalThis.fetch = makeMcpFetch({ callResult });
      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'search',
        toolArgs: { query: 'test' },
      }));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data.result, callResult);
    });

    it('returns 422 when tools/call returns non-ok status', async () => {
      globalThis.fetch = makeMcpFetch({ callStatus: 403 });
      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'search',
      }));
      assert.equal(res.status, 422);
    });

    it('returns 422 when tools/call returns JSON-RPC error', async () => {
      globalThis.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'tools/call') {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unknown tool' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return makeMcpFetch()(url, opts);
      };
      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'nonexistent_tool',
      }));
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.match(data.error, /Unknown tool/i);
    });

    it('returns 504 on timeout during tool call', async () => {
      globalThis.fetch = async () => {
        const err = new Error('signal timed out');
        err.name = 'TimeoutError';
        throw err;
      };
      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'search',
      }));
      assert.equal(res.status, 504);
    });

    it('includes Cache-Control: no-store on success', async () => {
      globalThis.fetch = makeMcpFetch({ callResult: { content: [] } });
      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'search',
      }));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
    });
  });

  // ── SSE transport detection ───────────────────────────────────────────────

  describe('SSE transport routing', () => {
    it('uses SSE transport when URL path ends with /sse', async () => {
      let connectCalled = false;
      globalThis.fetch = async (url, opts) => {
        const u = typeof url === 'string' ? url : url.toString();
        // SSE connect — GET with Accept: text/event-stream
        if (opts?.headers?.['Accept']?.includes('text/event-stream') || !opts?.body) {
          connectCalled = true;
          // Return SSE stream with endpoint event then close
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      // SSE transport returns 422 because the endpoint is /messages which resolves relative to the SSE URL domain
      // and the subsequent JSON-RPC calls over SSE will fail (no real SSE server)
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/sse' }));
      assert.ok(connectCalled, 'Expected SSE connect to be called');
      // Result is 422 (stream closed before endpoint or RPC error) — not a node: DNS failure
      assert.ok([200, 422, 504].includes(res.status), `Unexpected status: ${res.status}`);
    });
  });

  // ── SSE SSRF protection ───────────────────────────────────────────────────

  describe('SSE endpoint SSRF protection', () => {
    it('rejects SSE endpoint event that redirects to private IP', async () => {
      globalThis.fetch = async (url, opts) => {
        const u = typeof url === 'string' ? url : url.toString();
        // First call = SSE connect
        if (!opts?.body) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              // Malicious server tries to redirect to internal IP
              controller.enqueue(encoder.encode('event: endpoint\ndata: http://192.168.1.100/steal\n\n'));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/sse' }));
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.match(data.error, /blocked|SSRF|endpoint/i);
    });
  });

  // ── SSE response parsing ──────────────────────────────────────────────────

  describe('SSE content-type response parsing', () => {
    it('parses JSON-RPC result from SSE response body', async () => {
      const sseTools = [{ name: 'web_search', description: 'Search', inputSchema: {} }];
      globalThis.fetch = async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.method === 'initialize') {
          const sseData = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {} } })}\n\n`;
          return new Response(sseData, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (body.method === 'tools/list') {
          const sseData = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: sseTools } })}\n\n`;
          return new Response(sseData, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.tools[0].name, 'web_search');
    });
  });
});
