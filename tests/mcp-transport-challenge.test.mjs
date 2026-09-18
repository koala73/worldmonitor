/**
 * The MCP transport challenges an unauthenticated client at connect time.
 *
 * `/mcp` used to complete `initialize` and `tools/list` anonymously and only
 * answer `401` once a client called a paid tool. Hosted connectors decide
 * whether a server needs sign-in from their first unauthenticated probe
 * (`grok-connectors-manager`, Cursor's agent backend): a `200` recorded
 * WorldMonitor as "connected, nothing to authenticate", so the later `401` had
 * no authorization server behind it and their sign-in control never worked
 * ("Could not obtain authentication URL"). Over 48 hours of production traffic
 * 79% of Claude's requests were authenticated, against 11% of Cursor's, 4% of
 * OpenAI's and 2% of Grok's.
 *
 * The transport now does what Linear, Sentry and Notion do: no credential, no
 * answer — `401` plus the `WWW-Authenticate` challenge, on every method, with
 * the JSON-RPC id echoed so an SDK transport can correlate the refusal.
 *
 * Anonymous discovery survives only on the machine-discovery aliases
 * (`/.well-known/mcp`, `/.well-known/mcp.json`), which is where agent-readiness
 * scanners POST their handshake and which no connector is ever pointed at.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const rpc = (method, params = {}, id = 7) => ({ jsonrpc: '2.0', id, method, params });

async function post(url, body, headers = {}) {
  const { mcpHandler } = await import('../api/mcp/handler.ts');
  const host = new URL(url).host;
  return mcpHandler(new Request(url, {
    method: 'POST',
    headers: { host, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  }), undefined, { skip: false });
}

const DISCOVERY_METHODS = ['initialize', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'ping'];

describe('unauthenticated requests on the transport are challenged', () => {
  for (const [url, document] of [
    ['https://worldmonitor.app/mcp', 'https://worldmonitor.app/.well-known/oauth-protected-resource/mcp'],
    ['https://www.worldmonitor.app/mcp', 'https://www.worldmonitor.app/.well-known/oauth-protected-resource/mcp'],
    ['https://api.worldmonitor.app/api/mcp', 'https://api.worldmonitor.app/.well-known/oauth-protected-resource/api/mcp'],
  ]) {
    for (const method of DISCOVERY_METHODS) {
      it(`${new URL(url).host}${new URL(url).pathname} ${method} → 401 + challenge`, async () => {
        const res = await post(url, rpc(method));
        assert.equal(res.status, 401);
        assert.equal(
          res.headers.get('www-authenticate'),
          `Bearer realm="worldmonitor", resource_metadata="${document}"`,
        );
      });
    }
  }

  it('echoes the JSON-RPC id so the client can correlate the refusal instead of hanging', async () => {
    const res = await post('https://worldmonitor.app/mcp', rpc('initialize', {}, 'req-42'));
    const body = await res.json();
    assert.equal(body.id, 'req-42');
    assert.equal(body.error.code, -32001);
  });

  it('the refusal is JSON, never an SSE stream, even for an SSE-capable client', async () => {
    const res = await post('https://worldmonitor.app/mcp', rpc('initialize'));
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });

  it('the free tool is refused too: a client cannot reach it without connecting', async () => {
    const res = await post('https://worldmonitor.app/mcp', rpc('tools/call', { name: 'get_sources', arguments: {} }));
    assert.equal(res.status, 401);
  });

  it('a notification without credentials is refused as well', async () => {
    const res = await post('https://worldmonitor.app/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 401);
  });
});

describe('the machine-discovery aliases keep anonymous discovery', () => {
  for (const alias of ['/.well-known/mcp', '/.well-known/mcp.json']) {
    it(`${alias} still completes initialize and tools/list anonymously`, async () => {
      const init = await post(`https://worldmonitor.app${alias}`, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scanner', version: '1' } }));
      assert.equal(init.status, 200);
      const list = await post(`https://worldmonitor.app${alias}`, rpc('tools/list'));
      assert.equal(list.status, 200);
    });
  }
});

describe('what is not a transport request is untouched', () => {
  it('a plain GET to /mcp is still the human-readable server guide, not a challenge', async () => {
    const { mcpHandler } = await import('../api/mcp/handler.ts');
    const res = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'GET', headers: { host: 'worldmonitor.app', Accept: 'text/html' },
    }), undefined, { skip: false });
    assert.notEqual(res.status, 401);
  });

  it('CORS preflight is still answered', async () => {
    const { mcpHandler } = await import('../api/mcp/handler.ts');
    const res = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'OPTIONS', headers: { host: 'worldmonitor.app' },
    }), undefined, { skip: false });
    assert.equal(res.status, 204);
  });
});
