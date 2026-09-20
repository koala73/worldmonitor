/**
 * The MCP transport challenges an unauthenticated client at connect time.
 *
 * `/mcp` used to complete `initialize` anonymously and only answer `401` once a
 * client called a paid tool. Hosted connectors (`grok-connectors-manager`,
 * Cursor's agent backend) decide whether a server needs sign-in from how their
 * opening `initialize` is answered: a `200` recorded WorldMonitor as "connected,
 * nothing to authenticate", so the later `401` had no authorization server
 * behind it and their sign-in control never worked ("Could not obtain
 * authentication URL"). Over 48 hours of production traffic 79% of Claude's
 * requests were authenticated, against 11% of Cursor's, 4% of OpenAI's and 2%
 * of Grok's.
 *
 * Only the handshake is challenged. `initialize` is what every interactive MCP
 * client must open with; stateless callers never send it. The published
 * `worldmonitor` CLI and the SDKs POST `tools/list` and `tools/call get_sources`
 * straight to `/mcp` with no key (production shows `worldmonitor-cli/0.1.3`
 * doing exactly that), and those installed versions cannot be updated — so
 * keyless catalog reads and the free tool must keep answering.
 *
 * A full anonymous handshake survives on the machine-discovery aliases, which is
 * where agent-readiness scanners POST theirs and where no connector is pointed.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const rpc = (method, params = {}, id = 7) => ({ jsonrpc: '2.0', id, method, params });
const INIT_PARAMS = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } };

async function post(url, body, headers = {}) {
  const { mcpHandler } = await import('../api/mcp/handler.ts');
  const host = new URL(url).host;
  return mcpHandler(new Request(url, {
    method: 'POST',
    headers: { host, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  }), undefined, { skip: false });
}

describe('an unauthenticated initialize on the transport is challenged', () => {
  for (const [url, document] of [
    ['https://worldmonitor.app/mcp', 'https://worldmonitor.app/.well-known/oauth-protected-resource/mcp'],
    ['https://www.worldmonitor.app/mcp', 'https://www.worldmonitor.app/.well-known/oauth-protected-resource/mcp'],
    ['https://api.worldmonitor.app/api/mcp', 'https://api.worldmonitor.app/.well-known/oauth-protected-resource/api/mcp'],
  ]) {
    it(`${new URL(url).host}${new URL(url).pathname} → 401 + challenge naming its own document`, async () => {
      const res = await post(url, rpc('initialize', INIT_PARAMS));
      assert.equal(res.status, 401);
      assert.equal(
        res.headers.get('www-authenticate'),
        `Bearer realm="worldmonitor", resource_metadata="${document}"`,
      );
    });
  }

  it('echoes the JSON-RPC id so the client can correlate the refusal instead of hanging (#4937)', async () => {
    const res = await post('https://worldmonitor.app/mcp', rpc('initialize', INIT_PARAMS, 'req-42'));
    const body = await res.json();
    assert.equal(body.id, 'req-42');
    assert.equal(body.error.code, -32001);
    assert.equal(body.error.data?.reason, 'no-account', 'the refusal carries the same structured denial as a gated tool call');
  });

  it('the refusal is JSON, never an SSE stream, even for an SSE-capable client', async () => {
    const res = await post('https://worldmonitor.app/mcp', rpc('initialize', INIT_PARAMS));
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });
});

describe('stateless keyless calls keep working on the transport (published CLI / SDK contract)', () => {
  it('tools/list without credentials and without a prior initialize still lists the catalog', async () => {
    const res = await post('https://worldmonitor.app/mcp', rpc('tools/list'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.result?.tools) && body.result.tools.length > 0);
  });

  it('the free tool is still reached without credentials: it is never refused with 401', async () => {
    const res = await post('https://worldmonitor.app/mcp', rpc('tools/call', { name: 'get_sources', arguments: {} }));
    assert.notEqual(res.status, 401, 'get_sources must not hit the auth wall (its own limiter may answer 429/503 without a backend)');
  });

  it('a paid tool without credentials still hits the auth wall, with the /mcp challenge', async () => {
    const res = await post('https://worldmonitor.app/mcp', rpc('tools/call', { name: 'get_world_brief', arguments: {} }));
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp"/);
  });
});

describe('the machine-discovery aliases keep the full anonymous handshake', () => {
  for (const alias of ['/.well-known/mcp', '/.well-known/mcp.json']) {
    it(`${alias} still completes initialize and tools/list anonymously`, async () => {
      const init = await post(`https://worldmonitor.app${alias}`, rpc('initialize', INIT_PARAMS));
      assert.equal(init.status, 200);
      const list = await post(`https://worldmonitor.app${alias}`, rpc('tools/list'));
      assert.equal(list.status, 200);
    });
  }
});

describe('what is not a handshake is untouched', () => {
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
