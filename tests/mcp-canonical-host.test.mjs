/**
 * Canonical product MCP host (#8451 PR2).
 *
 * Alias hosts must redirect ordinary discovery and retire transport before
 * auth, quota, session, or dispatch. Canonical apex behaviour is unchanged.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { mcpHandler } from '../api/mcp.ts';
import { MAX_JSON_RPC_BODY_BYTES } from '../api/mcp/body-limits.ts';
import { mcpReasonFor } from '../api/mcp/usage.ts';
import {
  MCP_CANONICAL_ENDPOINT,
  MCP_CANONICAL_ENDPOINT_ERROR_CODE,
  MCP_CANONICAL_ENDPOINT_ERROR_DATA,
  MCP_CANONICAL_ENDPOINT_ERROR_MESSAGE,
  MCP_CANONICAL_LINK,
  MCP_CANONICAL_ORIGIN,
  MCP_PRODUCTION_ALIAS_LABELS,
  MCP_PRODUCT_PATHS,
} from '../shared/mcp-host-policy.ts';

const originalEnv = { ...process.env };

afterEach(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

function explodingDeps() {
  return new Proxy({}, {
    get(_target, prop) {
      return () => {
        throw new Error(`alias host policy must not call deps.${String(prop)}`);
      };
    },
  });
}

function aliasUrl(label, path) {
  return `https://${label}.worldmonitor.app${path}`;
}

function request(url, init = {}) {
  const parsed = new URL(url);
  const headers = {
    host: parsed.host,
    ...init.headers,
  };
  return new Request(url, { ...init, headers });
}

function rpc(method, { id = 7, params = {} } = {}) {
  const body = { jsonrpc: '2.0', method, params };
  if (id !== undefined) body.id = id;
  return body;
}

async function post(url, body, headers = {}) {
  return mcpHandler(request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), explodingDeps());
}

function assertNoStoreCorsCanonical(res, label) {
  assert.match(res.headers.get('cache-control') ?? '', /\bno-store\b/, `${label}: Cache-Control`);
  assert.equal(res.headers.get('access-control-allow-origin'), '*', `${label}: CORS`);
  assert.equal(res.headers.get('link'), MCP_CANONICAL_LINK, `${label}: Link`);
}

function assertGoneRpc(body, expectedId) {
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, expectedId);
  assert.equal(body.error?.code, MCP_CANONICAL_ENDPOINT_ERROR_CODE);
  assert.equal(body.error?.message, MCP_CANONICAL_ENDPOINT_ERROR_MESSAGE);
  assert.deepEqual(body.error?.data, MCP_CANONICAL_ENDPOINT_ERROR_DATA);
}

describe('canonical apex transport is unchanged', () => {
  it('still challenges unauthenticated initialize on /mcp', async () => {
    const res = await mcpHandler(request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(rpc('initialize', {
        id: 1,
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
      })),
    }), explodingDeps());
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp"/);
  });

  it('still challenges unauthenticated initialize on the internal /api/mcp path', async () => {
    const res = await mcpHandler(request('https://worldmonitor.app/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(rpc('initialize', { id: 2 })),
    }), explodingDeps());
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/api\/mcp"/);
  });

  it('still serves OPTIONS 204 on the canonical host', async () => {
    const res = await mcpHandler(request('https://worldmonitor.app/mcp', { method: 'OPTIONS' }), explodingDeps());
    assert.equal(res.status, 204);
  });
});

describe('alias ordinary GET/HEAD redirect', () => {
  for (const label of MCP_PRODUCTION_ALIAS_LABELS) {
    for (const path of MCP_PRODUCT_PATHS) {
      it(`${label} GET ${path} 308s to the canonical location without copying query`, async () => {
        const res = await mcpHandler(
          request(`${aliasUrl(label, path)}?token=secret`, {
            headers: { Accept: 'text/html,*/*' },
          }),
          explodingDeps(),
        );
        assert.equal(res.status, 308, `${label} ${path}`);
        const expected = path === '/mcp' || path === '/api/mcp'
          ? MCP_CANONICAL_ENDPOINT
          : `${MCP_CANONICAL_ORIGIN}${path}`;
        assert.equal(res.headers.get('location'), expected);
        assert.match(res.headers.get('vary') ?? '', /\bAccept\b(?!-)/);
        assert.match(res.headers.get('vary') ?? '', /Last-Event-ID/i);
      });
    }
  }

  it('HEAD /mcp on www matches GET status and Location and has no body', async () => {
    const res = await mcpHandler(request(aliasUrl('www', '/mcp'), {
      method: 'HEAD',
      headers: { Accept: 'text/html' },
    }), explodingDeps());
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('location'), MCP_CANONICAL_ENDPOINT);
    assert.equal(await res.text(), '');
  });

  it('SSE q=0 remains an ordinary redirect', async () => {
    const res = await mcpHandler(request(aliasUrl('tech', '/mcp'), {
      headers: { Accept: 'text/event-stream;q=0, text/html' },
    }), explodingDeps());
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('location'), MCP_CANONICAL_ENDPOINT);
  });
});

describe('alias transport 410', () => {
  it('POST with a numeric id returns HTTP 410 JSON-RPC and does not call deps', async () => {
    const res = await post(aliasUrl('www', '/mcp'), rpc('initialize', { id: 0 }));
    assert.equal(res.status, 410);
    assertNoStoreCorsCanonical(res, 'id 0');
    assertGoneRpc(await res.json(), 0);
  });

  it('preserves an empty-string id', async () => {
    const res = await post(aliasUrl('api', '/api/mcp'), rpc('ping', { id: '' }));
    assert.equal(res.status, 410);
    assertGoneRpc(await res.json(), '');
  });

  it('a notification (no id member) is 410 with an empty body', async () => {
    const res = await post(aliasUrl('finance', '/mcp'), { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 410);
    assertNoStoreCorsCanonical(res, 'notification');
    assert.equal(await res.text(), '');
  });

  it('malformed JSON is still -32600, not a 410', async () => {
    const res = await post(aliasUrl('happy', '/mcp'), '{');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32600);
  });

  it('an oversized body is still HTTP 413 before the host decision', async () => {
    const rpcJson = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}';
    const oversized = `${rpcJson.slice(0, -1)}${' '.repeat(MAX_JSON_RPC_BODY_BYTES - rpcJson.length + 1)}}`;
    const res = await post(aliasUrl('commodity', '/mcp'), oversized);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error?.data?.reason, 'body-too-large');
  });

  it('SSE GET is 410 JSON-RPC with id null', async () => {
    const res = await mcpHandler(request(aliasUrl('energy', '/mcp'), {
      headers: { Accept: 'text/event-stream' },
    }), explodingDeps());
    assert.equal(res.status, 410);
    assertNoStoreCorsCanonical(res, 'SSE GET');
    assert.match(res.headers.get('vary') ?? '', /Accept/);
    assertGoneRpc(await res.json(), null);
  });

  it('replay GET is 410 and never authenticates', async () => {
    const res = await mcpHandler(request(aliasUrl('tech', '/mcp'), {
      headers: { Accept: 'application/json', 'Last-Event-ID': 'stream:0' },
    }), explodingDeps());
    assert.equal(res.status, 410);
    assert.equal(res.headers.get('www-authenticate'), null);
    assertGoneRpc(await res.json(), null);
  });

  it('HEAD SSE has status 410 and no body', async () => {
    const res = await mcpHandler(request(aliasUrl('www', '/mcp'), {
      method: 'HEAD',
      headers: { Accept: 'text/event-stream' },
    }), explodingDeps());
    assert.equal(res.status, 410);
    assertNoStoreCorsCanonical(res, 'HEAD SSE');
    assert.equal(await res.text(), '');
  });

  it('OPTIONS on an alias is still 204 CORS', async () => {
    const res = await mcpHandler(request(aliasUrl('www', '/mcp'), { method: 'OPTIONS' }), explodingDeps());
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
  });

  it('unsupported methods are 405 with Allow and canonical Link', async () => {
    const res = await mcpHandler(request(aliasUrl('api', '/mcp'), { method: 'PUT' }), explodingDeps());
    assert.equal(res.status, 405);
    assert.match(res.headers.get('allow') ?? '', /POST/);
    assertNoStoreCorsCanonical(res, 'PUT');
  });

  it('maps migration 410 onto canonical_endpoint_required usage reason', () => {
    assert.equal(mcpReasonFor('migration', 410), 'canonical_endpoint_required');
    assert.equal(mcpReasonFor('transport', 405), 'method_not_allowed');
  });
});
