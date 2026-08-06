// Self-hosted Docker: the nginx-injected sidecar token must not masquerade as
// an MCP OAuth credential.
//
// Background. In the Docker self-host, `docker/nginx.conf` sets
//   proxy_set_header Authorization "Bearer ${LOCAL_API_TOKEN}"
// on every /api/ request, because the sidecar's global auth gate
// (src-tauri/sidecar/local-api-server.mjs) rejects anything without it. That
// header is transport auth between nginx and the sidecar. `resolveAuthContext`
// used to treat ANY bearer as an OAuth token, so it tried (and failed) to
// resolve the sidecar token and returned 401 before ever reaching the
// `X-WorldMonitor-Key` branch that `WORLDMONITOR_VALID_KEYS` exists to serve.
//
// nginx OVERWRITES the header rather than appending, so no client could work
// around it: strip it and the sidecar gate rejects the request; keep it and MCP
// rejects it. /api/mcp was therefore unreachable on every self-hosted
// deployment, by any header combination.
//
// These tests pin both halves of the fix AND the security boundary: the
// transport token grants no authority of its own — a valid
// WORLDMONITOR_VALID_KEYS entry is still required.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { buildAuthHeaders, resolveAuthContext } from '../api/mcp/auth.ts';

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

  it('authenticates via X-WorldMonitor-Key despite the nginx-injected bearer', async () => {
    const result = await resolveAuthContext(
      request({
        Authorization: `Bearer ${SIDECAR_TOKEN}`,
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
      request({ Authorization: `Bearer ${SIDECAR_TOKEN}` }),
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
        Authorization: `Bearer ${SIDECAR_TOKEN}`,
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
    const headers = await buildAuthHeaders(
      { kind: 'env_key', apiKey: VALID_KEY },
      'GET',
      'http://127.0.0.1:46123/api/intelligence/v1/get-country-risk',
      null,
    );

    assert.equal(headers['X-WorldMonitor-Key'], VALID_KEY);
    assert.equal(headers.Authorization, `Bearer ${SIDECAR_TOKEN}`);
  });

  it('adds no Authorization header when not self-hosted', async () => {
    delete process.env.LOCAL_API_TOKEN;
    try {
      const headers = await buildAuthHeaders(
        { kind: 'env_key', apiKey: VALID_KEY },
        'GET',
        'https://api.worldmonitor.app/api/intelligence/v1/get-country-risk',
        null,
      );

      assert.equal(headers['X-WorldMonitor-Key'], VALID_KEY);
      assert.equal('Authorization' in headers, false, 'hosted requests must not carry a sidecar token');
    } finally {
      process.env.LOCAL_API_TOKEN = SIDECAR_TOKEN;
    }
  });
});
