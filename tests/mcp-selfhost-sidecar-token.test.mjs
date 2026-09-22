import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { buildAuthHeaders, resolveAuthContext } from '../api/mcp/auth.ts';
import { buildMcpDownstreamHeaders, createMcpToolExecutionContext, fetchMcpDownstream } from '../api/mcp/downstream.ts';

const SIDECAR_TOKEN = 'sidecar-transport-token-abc123';
const VALID_KEY = 'wm_selfhost_valid_key';
const RESOURCE_METADATA_URL = 'https://example.test/.well-known/oauth-protected-resource';

// The bearer branch must not be consulted for the sidecar token. A throwing
// stub turns "we still treated it as OAuth" into a loud failure rather than a
// silent 401 that a shallower assertion could mistake for correct behaviour.
const throwingDeps = {
  resolveBearerToContext: async () => {
    throw new Error('sidecar transport token must not reach the OAuth resolver');
  },
  validateProMcpToken: async () => null,
  getEntitlements: async () => null,
  validateUserApiKey: async () => null,
  guardUserApiKeyValidation: async () => null,
  redisPipeline: async () => [],
};

function request(headers) {
  return new Request('https://example.test/api/mcp', { method: 'POST', headers });
}

describe('self-hosted sidecar token vs MCP auth', () => {
  let priorToken;
  let priorKeys;

  before(() => {
    priorToken = process.env.LOCAL_API_TOKEN;
    priorKeys = process.env.WORLDMONITOR_VALID_KEYS;
    process.env.LOCAL_API_TOKEN = SIDECAR_TOKEN;
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
  });

  after(() => {
    if (priorToken === undefined) delete process.env.LOCAL_API_TOKEN;
    else process.env.LOCAL_API_TOKEN = priorToken;
    if (priorKeys === undefined) delete process.env.WORLDMONITOR_VALID_KEYS;
    else process.env.WORLDMONITOR_VALID_KEYS = priorKeys;
  });

  it('authenticates via X-WorldMonitor-Key alongside the nginx transport header', async () => {
    const result = await resolveAuthContext(
      request({
        'X-WorldMonitor-Local-Token': SIDECAR_TOKEN,
        'X-WorldMonitor-Key': VALID_KEY,
      }),
      throwingDeps,
      RESOURCE_METADATA_URL,
      {},
    );

    assert.equal(result.ok, true, 'expected the API key to authenticate');
    assert.equal(result.context.kind, 'env_key');
    assert.equal(result.context.apiKey, VALID_KEY);
  });

  it('grants NO authority on its own — sidecar token without a valid key is 401', async () => {
    const result = await resolveAuthContext(
      request({ 'X-WorldMonitor-Local-Token': SIDECAR_TOKEN }),
      throwingDeps,
      RESOURCE_METADATA_URL,
      {},
    );

    assert.equal(result.ok, false, 'transport token alone must not authenticate');
    assert.equal(result.response.status, 401);
  });

  it('rejects an invalid API key even when the sidecar token is present', async () => {
    const result = await resolveAuthContext(
      request({
        'X-WorldMonitor-Local-Token': SIDECAR_TOKEN,
        'X-WorldMonitor-Key': 'wm_not_a_configured_key',
      }),
      throwingDeps,
      RESOURCE_METADATA_URL,
      {},
    );

    assert.equal(result.ok, false, 'an unconfigured key must not authenticate');
    assert.equal(result.response.status, 401);
  });

  it('leaves the hosted OAuth path untouched for any other bearer', async () => {
    let sawToken = null;
    const result = await resolveAuthContext(
      request({ Authorization: 'Bearer some-real-oauth-token' }),
      {
        ...throwingDeps,
        resolveBearerToContext: async (token) => {
          sawToken = token;
          return { kind: 'pro', userId: 'user_1', apiKey: 'k', mcpTokenId: 't' };
        },
      },
      RESOURCE_METADATA_URL,
      {},
    );

    assert.equal(sawToken, 'some-real-oauth-token', 'non-sidecar bearers must still reach the OAuth resolver');
    assert.equal(result.ok, true);
    assert.equal(result.context.kind, 'pro');
  });

  it('re-attaches the transport token on internal tool fetches', async () => {
    // A tool's `_execute` targets the sidecar directly (origin of req.url),
    // bypassing the nginx hop that would have added this header — without it
    // the sidecar gate 401s and the tool reports "data fetch failed".
    const auth = await buildAuthHeaders(
      { kind: 'env_key', apiKey: VALID_KEY },
      'GET',
      'http://127.0.0.1:46123/api/intelligence/v1/get-country-risk',
      null,
    );

    const origin = 'http://127.0.0.1:46123';
    const headers = buildMcpDownstreamHeaders(origin, createMcpToolExecutionContext(`${origin}/api/mcp`), auth);
    assert.equal(headers['X-WorldMonitor-Key'], VALID_KEY);
    assert.equal(headers['X-WorldMonitor-Local-Token'], SIDECAR_TOKEN);
    assert.equal(headers.Authorization, undefined);
  });

  it('attaches no transport token or redirect override when LOCAL_API_TOKEN is unset', async () => {
    // The "self-hosted or not" branch is `if (!token) return headers` in
    // buildMcpDownstreamHeaders: even a loopback execution context must leave
    // the request untouched when the process holds no sidecar token.
    delete process.env.LOCAL_API_TOKEN;
    const originalFetch = globalThis.fetch;
    let seen;
    globalThis.fetch = async (_url, init) => {
      seen = init;
      return Response.json({});
    };
    try {
      const origin = 'http://127.0.0.1:46123';
      const url = `${origin}/api/intelligence/v1/get-country-risk`;
      const auth = await buildAuthHeaders({ kind: 'env_key', apiKey: VALID_KEY }, 'GET', url, null);
      await fetchMcpDownstream(url, { headers: auth, redirect: 'manual' }, createMcpToolExecutionContext(`${origin}/api/mcp`));

      const headers = new Headers(seen.headers);
      assert.equal(headers.get('X-WorldMonitor-Key'), VALID_KEY);
      assert.equal(headers.get('X-WorldMonitor-Local-Token'), null, 'no sidecar token to attach');
      assert.equal(seen.redirect, 'manual', 'redirect policy is only overridden when a token is attached');
    } finally {
      globalThis.fetch = originalFetch;
      process.env.LOCAL_API_TOKEN = SIDECAR_TOKEN;
    }
  });
});
