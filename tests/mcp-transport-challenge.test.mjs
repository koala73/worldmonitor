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
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

async function request(url, init = {}, ctx = { skip: false }) {
  const { mcpHandler } = await import('../api/mcp/handler.ts');
  const host = new URL(url).host;
  return mcpHandler(new Request(url, {
    ...init,
    headers: { host, ...(init.headers ?? {}) },
  }), undefined, ctx);
}

describe('an unauthenticated initialize on the transport is challenged', () => {
  for (const [url, document] of [['https://worldmonitor.app/mcp', 'https://worldmonitor.app/.well-known/oauth-protected-resource/mcp']]) {
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

const PRODUCT_MCP_ALIASES = [
  'www.worldmonitor.app',
  'api.worldmonitor.app',
  'tech.worldmonitor.app',
  'finance.worldmonitor.app',
  'commodity.worldmonitor.app',
  'happy.worldmonitor.app',
  'energy.worldmonitor.app',
];

const MCP_PATHS = ['/mcp', '/api/mcp', '/.well-known/mcp', '/.well-known/mcp.json'];

describe('product MCP host aliases are migration-only', () => {
  it('redirects ordinary discovery GETs and HEADs to constant canonical locations', async () => {
    for (const host of PRODUCT_MCP_ALIASES) {
      for (const path of MCP_PATHS) {
        const expected = path === '/api/mcp'
          ? 'https://worldmonitor.app/mcp'
          : `https://worldmonitor.app${path}`;
        for (const method of ['GET', 'HEAD']) {
          const res = await request(`https://${host}${path}?caller-controlled=1`, { method, headers: { Accept: 'text/html' } });
          assert.equal(res.status, 308, `${host}${path} ${method}`);
          assert.equal(res.headers.get('location'), expected);
          assert.equal(res.headers.get('vary'), 'Accept, Last-Event-ID');
          assert.equal(res.headers.get('cache-control'), 'no-store');
          assert.equal(res.headers.get('access-control-allow-origin'), '*');
        }
      }
    }
  });

  it('rejects SSE stream and replay operations before auth, sessions, Redis, or dispatch', async () => {
    for (const host of PRODUCT_MCP_ALIASES) {
      for (const path of MCP_PATHS) {
        for (const headers of [
          { Accept: 'text/event-stream' },
          { 'Last-Event-ID': 'cursor-1' },
        ]) {
          const res = await request(`https://${host}${path}`, { method: 'GET', headers });
          assert.equal(res.status, 410, `${host}${path}`);
          assert.equal(res.headers.get('link'), '<https://worldmonitor.app/mcp>; rel="canonical"');
          assert.match(res.headers.get('cache-control') ?? '', /no-store/);
          assert.equal(res.headers.get('access-control-allow-origin'), '*');
          assert.deepEqual(await res.json(), {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32000,
              message: 'Use https://worldmonitor.app/mcp',
              data: {
                reason: 'canonical_endpoint_required',
                endpoint: 'https://worldmonitor.app/mcp',
              },
            },
          });
        }
      }
    }

    const head = await request(`https://${'api'}.worldmonitor.app/api/mcp`, { method: 'HEAD', headers: { Accept: 'text/event-stream' } });
    assert.equal(head.status, 410);
    assert.equal(await head.text(), '');

    const replayHead = await request(`https://${'api'}.worldmonitor.app/api/mcp`, { method: 'HEAD', headers: { 'Last-Event-ID': 'cursor-1' } });
    assert.equal(replayHead.status, 410);
    assert.equal(replayHead.headers.get('link'), '<https://worldmonitor.app/mcp>; rel="canonical"');
    assert.equal(replayHead.headers.get('access-control-allow-origin'), '*');
    assert.equal(await replayHead.text(), '');
  });

  it('treats text/event-stream;q=0 as ordinary discovery', async () => {
    const res = await request('https://www.worldmonitor.app/mcp', {
      method: 'GET', headers: { Accept: 'text/event-stream;q=0, text/html' },
    });
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('location'), 'https://worldmonitor.app/mcp');
  });

  it('returns the migration JSON-RPC error from every alias path and preserves valid request ids', async () => {
    for (const host of PRODUCT_MCP_ALIASES) {
      for (const path of MCP_PATHS) {
        const res = await post(`https://${host}${path}`, rpc('initialize', INIT_PARAMS, 0));
        assert.equal(res.status, 410, `${host}${path}`);
        const body = await res.json();
        assert.equal(body.id, 0);
        assert.equal(body.error.code, -32000);
        assert.equal(body.error.message, 'Use https://worldmonitor.app/mcp');
        assert.deepEqual(body.error.data, {
          reason: 'canonical_endpoint_required', endpoint: 'https://worldmonitor.app/mcp',
        });
      }
    }

    for (const id of ['', null]) {
      const res = await post(`https://${'api'}.worldmonitor.app/api/mcp`, rpc('initialize', INIT_PARAMS, id));
      assert.equal(res.status, 410);
      const body = await res.json();
      assert.equal(body.id, id);
    }

    for (const host of PRODUCT_MCP_ALIASES) {
      for (const path of MCP_PATHS) {
        const notification = await post(`https://${host}${path}`, { jsonrpc: '2.0', method: 'notifications/initialized' });
        assert.equal(notification.status, 410, `${host}${path}`);
        assert.equal(await notification.text(), '');
      }
    }
  });

  it('keeps OPTIONS and unsupported-method contracts explicit on aliases', async () => {
    for (const host of PRODUCT_MCP_ALIASES) {
      for (const path of MCP_PATHS) {
        const options = await request(`https://${host}${path}`, { method: 'OPTIONS' });
        assert.equal(options.status, 204, `${host}${path}`);
        assert.match(options.headers.get('access-control-allow-methods') ?? '', /POST/);

        const put = await request(`https://${host}${path}`, { method: 'PUT' });
        assert.equal(put.status, 405, `${host}${path}`);
        assert.equal(put.headers.get('allow'), 'POST, GET, HEAD, OPTIONS');
        assert.equal(put.headers.get('link'), '<https://worldmonitor.app/mcp>; rel="canonical"');
        assert.equal(put.headers.get('access-control-allow-origin'), '*');
      }
    }
  });

  it('still returns malformed-envelope errors before migration handling', async () => {
    const res = await request(`https://${'api'}.worldmonitor.app/api/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not-json',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error.code, -32600);

    const invalidId = await post(`https://${'api'}.worldmonitor.app/api/mcp`, { jsonrpc: '2.0', id: {}, method: 'initialize' });
    assert.equal(invalidId.status, 200);
    assert.equal((await invalidId.json()).error.code, -32600);

    const missingMethod = await post(`https://${'api'}.worldmonitor.app/api/mcp`, { jsonrpc: '2.0', id: 'missing-method' });
    assert.equal(missingMethod.status, 200);
    const missingMethodBody = await missingMethod.json();
    assert.equal(missingMethodBody.id, 'missing-method');
    assert.equal(missingMethodBody.error.code, -32600);

    const { MAX_JSON_RPC_BODY_BYTES } = await import('../api/mcp/constants.ts');
    const oversized = await request(`https://${'api'}.worldmonitor.app/api/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(MAX_JSON_RPC_BODY_BYTES + 1),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, -32600);
  });

  it('does not let a conflicting Host header or trailing DNS dot bypass the alias boundary', async () => {
    const hostConflict = await post(
      `https://${'api'}.worldmonitor.app/api/mcp`,
      rpc('initialize', INIT_PARAMS),
      { host: 'worldmonitor.app' },
    );
    assert.equal(hostConflict.status, 410);

    const trailingDot = await post('https://www.worldmonitor.app./mcp', rpc('initialize', INIT_PARAMS));
    assert.equal(trailingDot.status, 410);

    const inverseHostConflict = await post(
      'https://worldmonitor.app/mcp',
      rpc('initialize', INIT_PARAMS),
      { host: 'api.worldmonitor.app:443' },
    );
    assert.equal(inverseHostConflict.status, 410);
  });

  it('classifies every handler-originated alias response as a migration event', async () => {
    const { mcpReasonFor } = await import('../api/mcp/usage.ts');
    assert.equal(mcpReasonFor('migration', 308), 'canonical_endpoint_required');
    assert.equal(mcpReasonFor('migration', 410), 'canonical_endpoint_required');
    assert.equal(mcpReasonFor('migration', 405), 'canonical_endpoint_required');
  });

  it('emits bounded migration events for alias redirects and rejections', async () => {
    const originalFetch = globalThis.fetch;
    const originalUsage = process.env.USAGE_TELEMETRY;
    const originalToken = process.env.AXIOM_API_TOKEN;
    const events = [];
    const pending = [];
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('api.axiom.co')) {
        events.push(...JSON.parse(String(init?.body ?? '[]')));
        return new Response('{}', { status: 200 });
      }
      return originalFetch(input, init);
    };

    try {
      const res = await request(
        'https://www.worldmonitor.app/mcp?query=payload-secret',
        { method: 'GET', headers: { Authorization: 'Bearer credential-secret' } },
        { waitUntil: (promise) => { pending.push(promise); } },
      );
      assert.equal(res.status, 308);
      const sse = await request(
        `https://${'api'}.worldmonitor.app/api/mcp?query=payload-secret`,
        { method: 'GET', headers: { Authorization: 'Bearer credential-secret', Accept: 'text/event-stream' } },
        { waitUntil: (promise) => { pending.push(promise); } },
      );
      assert.equal(sse.status, 410);
      const put = await request(
        `https://${'api'}.worldmonitor.app/api/mcp?query=payload-secret`,
        { method: 'PUT', headers: { Authorization: 'Bearer credential-secret' } },
        { waitUntil: (promise) => { pending.push(promise); } },
      );
      assert.equal(put.status, 405);
      await Promise.all(pending);
      assert.deepEqual(events.map((event) => [event.status, event.reason]), [
        [308, 'canonical_endpoint_required'],
        [410, 'canonical_endpoint_required'],
        [405, 'canonical_endpoint_required'],
      ]);
      assert.doesNotMatch(JSON.stringify(events), /credential-secret|payload-secret/);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUsage === undefined) delete process.env.USAGE_TELEMETRY;
      else process.env.USAGE_TELEMETRY = originalUsage;
      if (originalToken === undefined) delete process.env.AXIOM_API_TOKEN;
      else process.env.AXIOM_API_TOKEN = originalToken;
    }
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
