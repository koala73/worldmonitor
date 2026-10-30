// RUN WITH: `npm run test:data` OR `node --import=tsx --test tests/gateway-401-www-authenticate.test.mjs`.
//
// RFC 9728 §5.1 / #4840: every REST gateway 401 carries a `WWW-Authenticate`
// bearer challenge whose `resource_metadata` points at the protected-resource
// metadata document for the request's host, so an agent learns the auth
// requirements from the rejection itself instead of hunting for the
// well-known document. The MCP transport and /agent/auth already did this;
// this suite pins the gateway and the shared helper they now all use.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import { bearerChallenge, protectedResourceMetadataUrl, wwwAuthHeader } from '../api/_www-authenticate.ts';
import { wwwAuthHeader as mcpWwwAuthHeader } from '../api/mcp/auth.ts';

const VALID_KEY = 'www-authenticate-test-operator-key';
const APEX_CHALLENGE = 'Bearer realm="worldmonitor", resource_metadata="https://worldmonitor.app/.well-known/oauth-protected-resource"';

function gateway() {
  return createDomainGateway([
    {
      method: 'GET',
      path: '/api/seismology/v1/list-earthquakes',
      handler: async () => Response.json({ source: 'rpc' }),
    },
  ]);
}

describe('shared bearer challenge helper', () => {
  it('is the single definition the MCP transport re-exports', () => {
    assert.equal(mcpWwwAuthHeader, wwwAuthHeader);
    assert.equal(wwwAuthHeader('https://worldmonitor.app/.well-known/oauth-protected-resource'), APEX_CHALLENGE);
    assert.equal(
      wwwAuthHeader('https://worldmonitor.app/.well-known/oauth-protected-resource', 'invalid_token'),
      'Bearer realm="worldmonitor", error="invalid_token", resource_metadata="https://worldmonitor.app/.well-known/oauth-protected-resource"',
    );
  });

  it('derives the metadata URL from an allowed Host and falls back to the apex otherwise', () => {
    const req = (host) => new Request('https://worldmonitor.app/api/x', { headers: { host } });
    assert.equal(protectedResourceMetadataUrl(req('api.worldmonitor.app')), 'https://api.worldmonitor.app/.well-known/oauth-protected-resource');
    assert.equal(protectedResourceMetadataUrl(req('www.worldmonitor.app')), 'https://www.worldmonitor.app/.well-known/oauth-protected-resource');
    assert.equal(protectedResourceMetadataUrl(req('evil.com')), 'https://worldmonitor.app/.well-known/oauth-protected-resource');
    assert.equal(bearerChallenge(req('evil.com')), APEX_CHALLENGE);
  });
});

describe('REST gateway 401 challenge (#4840)', () => {
  const originalValidKeys = process.env.WORLDMONITOR_VALID_KEYS;
  afterEach(() => {
    if (originalValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
    else process.env.WORLDMONITOR_VALID_KEYS = originalValidKeys;
  });

  it('a request without credentials gets 401 + the apex challenge', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    const res = await gateway()(new Request('https://worldmonitor.app/api/seismology/v1/list-earthquakes'));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), APEX_CHALLENGE);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('link') ?? '', /rel="deprecation"/);
  });

  it('an invalid API key gets the same challenge', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    const res = await gateway()(new Request('https://worldmonitor.app/api/seismology/v1/list-earthquakes', {
      headers: { 'X-WorldMonitor-Key': 'not-the-key' },
    }));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), APEX_CHALLENGE);
  });

  it('an invalid bearer session gets the challenge', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    const res = await gateway()(new Request('https://worldmonitor.app/api/seismology/v1/list-earthquakes', {
      headers: { Authorization: 'Bearer definitely-not-a-session' },
    }));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), APEX_CHALLENGE);
  });

  it('points at the metadata document of the request host, never a spoofed one', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    const g = gateway();
    const api = await g(new Request('https://api.worldmonitor.app/api/seismology/v1/list-earthquakes', {
      headers: { host: 'api.worldmonitor.app' },
    }));
    assert.equal(api.status, 401);
    assert.equal(
      api.headers.get('www-authenticate'),
      'Bearer realm="worldmonitor", resource_metadata="https://api.worldmonitor.app/.well-known/oauth-protected-resource"',
    );
    const spoofed = await g(new Request('https://worldmonitor.app/api/seismology/v1/list-earthquakes', {
      headers: { host: 'evil.com' },
    }));
    assert.equal(spoofed.status, 401);
    assert.equal(spoofed.headers.get('www-authenticate'), APEX_CHALLENGE);
  });

  it('a valid key still succeeds without a challenge', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    const res = await gateway()(new Request('https://worldmonitor.app/api/seismology/v1/list-earthquakes', {
      headers: { 'X-WorldMonitor-Key': VALID_KEY },
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('www-authenticate'), null);
  });
});
