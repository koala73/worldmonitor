/**
 * RFC 9207 issuer identification on the OAuth authorization response.
 *
 * ChatGPT only uses its stable redirect URI
 * (https://chatgpt.com/connector_platform_oauth_redirect) for authorization
 * servers that advertise `authorization_response_iss_parameter_supported` and
 * return `iss` on every authorization response, compared by exact string
 * against the metadata `issuer`. Claude and other RFC 9207 clients apply the
 * same comparison whenever `iss` is present, so a wrong value breaks working
 * clients.
 *
 * The metadata `issuer` is host-derived (api/_agent-metadata.ts), but the
 * authorization response can leave from a different host than the one the
 * client discovered: the consent form's native submit targets
 * api.worldmonitor.app, and the Pro flow always lands on
 * api.worldmonitor.app/oauth/authorize-pro. So the issuer is captured on the
 * GET /oauth/authorize that starts the flow (the host whose metadata named that
 * endpoint), stored in the server-held nonce, and replayed from there.
 */

import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';

import { resolveMetadataOrigin } from '../api/_agent-metadata.ts';

const REDIS_URL = 'https://redis.test';
const ENTERPRISE_KEY = 'enterprise-test-key';
const CLIENT_ID = 'client_chatgpt';
const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CODE_CHALLENGE = 'a'.repeat(43);

const originalFetch = globalThis.fetch;
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'WORLDMONITOR_VALID_KEYS'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let store;

function installRedisStub() {
  store = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== REDIS_URL) throw new Error(`unexpected fetch ${url}`);
    const [, op, rawKey] = url.pathname.split('/');
    const reply = (result) => new Response(JSON.stringify({ result }), { status: 200 });
    if (op === 'get') return reply(store.get(decodeURIComponent(rawKey)) ?? null);
    if (op === 'getdel') {
      const key = decodeURIComponent(rawKey);
      const value = store.get(key) ?? null;
      store.delete(key);
      return reply(value);
    }
    const body = JSON.parse(init.body);
    const pipeline = Array.isArray(body[0]);
    const results = (pipeline ? body : [body]).map(([cmd, key, value]) => {
      // Upstash rate limiter script: always under the limit.
      if (['eval', 'evalsha'].includes(cmd.toLowerCase())) return { result: [9, 10] };
      assert.equal(cmd, 'SET');
      store.set(key, value);
      return { result: 'OK' };
    });
    return Response.json(pipeline ? results : results[0]);
  };
}

before(() => {
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { default: authorizeHandler, resolveAuthorizationIssuer } = await import('../api/oauth/authorize.js');

function registerClient() {
  store.set(`oauth:client:${CLIENT_ID}`, JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [REDIRECT_URI] }));
}

async function startFlow(host) {
  const url = new URL(`https://${host}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    state: 'state_abc',
  }).toString();
  const res = await authorizeHandler(new Request(url, { headers: { host } }));
  assert.equal(res.status, 200, 'consent page renders');
  const nonceKey = [...store.keys()].find((k) => k.startsWith('oauth:nonce:'));
  assert.ok(nonceKey, 'GET stores the nonce');
  return { nonce: nonceKey.slice('oauth:nonce:'.length), nonceData: JSON.parse(store.get(nonceKey)) };
}

function submitConsent(nonce, { host = 'api.worldmonitor.app', xhr = false, apiKey = ENTERPRISE_KEY } = {}) {
  const body = new URLSearchParams({ api_key: apiKey, _nonce: nonce, ...(xhr ? { _js: '1' } : {}) });
  return authorizeHandler(new Request(`https://${host}/oauth/authorize`, {
    method: 'POST',
    headers: { host, origin: `https://${host}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }));
}

describe('RFC 9207 — authorization server metadata', () => {
  it('advertises authorization_response_iss_parameter_supported on every host', async () => {
    const { default: asHandler } = await import('../api/oauth-authorization-server.ts');
    for (const host of ['worldmonitor.app', 'www.worldmonitor.app', 'api.worldmonitor.app']) {
      const res = await asHandler(new Request(`https://${host}/.well-known/oauth-authorization-server`, { headers: { host } }));
      const json = await res.json();
      assert.equal(json.authorization_response_iss_parameter_supported, true, host);
    }
  });
});

describe('RFC 9207 — issuer captured when the flow starts', () => {
  it('derives the same origin as the AS metadata issuer, including spoofed-Host fallback', () => {
    const hosts = [
      'worldmonitor.app', 'www.worldmonitor.app', 'api.worldmonitor.app', 'tech.worldmonitor.app',
      'API.WorldMonitor.app', 'evil.com', 'worldmonitor.app.evil.com', 'evilworldmonitor.app',
      'x.y.worldmonitor.app', 'api.worldmonitor.app:443',
    ];
    for (const host of hosts) {
      const req = new Request('https://worldmonitor.app/oauth/authorize', { headers: { host } });
      assert.equal(resolveAuthorizationIssuer(req), resolveMetadataOrigin(req), host);
    }
  });

  for (const host of ['worldmonitor.app', 'www.worldmonitor.app', 'api.worldmonitor.app']) {
    it(`GET on ${host} stores iss=https://${host} in the nonce`, async () => {
      installRedisStub();
      registerClient();
      const { nonceData } = await startFlow(host);
      assert.equal(nonceData.iss, `https://${host}`);
    });
  }
});

describe('RFC 9207 — API-key consent redirect carries iss', () => {
  it('native form submit landing on api.* returns the issuer the client discovered (www)', async () => {
    installRedisStub();
    registerClient();
    const { nonce } = await startFlow('www.worldmonitor.app');
    const res = await submitConsent(nonce, { host: 'api.worldmonitor.app' });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('Location'));
    assert.equal(loc.origin + loc.pathname, REDIRECT_URI);
    assert.ok(loc.searchParams.get('code'));
    assert.equal(loc.searchParams.get('state'), 'state_abc');
    assert.equal(loc.searchParams.get('iss'), 'https://www.worldmonitor.app');
  });

  it('JS (XHR) submit returns a location carrying iss', async () => {
    installRedisStub();
    registerClient();
    const { nonce } = await startFlow('worldmonitor.app');
    const res = await submitConsent(nonce, { host: 'worldmonitor.app', xhr: true });
    assert.equal(res.status, 200);
    const { location } = await res.json();
    assert.equal(new URL(location).searchParams.get('iss'), 'https://worldmonitor.app');
  });

  it('a bad-key retry mints a fresh nonce that still carries the original issuer', async () => {
    installRedisStub();
    registerClient();
    const { nonce } = await startFlow('www.worldmonitor.app');
    const retry = await submitConsent(nonce, { host: 'www.worldmonitor.app', xhr: true, apiKey: 'not-a-valid-key' });
    assert.equal(retry.status, 400);
    const { error, nonce: retryNonce } = await retry.json();
    assert.equal(error, 'invalid_key');
    assert.ok(retryNonce && retryNonce !== nonce);

    const res = await submitConsent(retryNonce, { host: 'api.worldmonitor.app' });
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('Location')).searchParams.get('iss'), 'https://www.worldmonitor.app');
  });

  it('a nonce stored before the deploy (no iss) redirects without an iss param', async () => {
    installRedisStub();
    registerClient();
    store.set('oauth:nonce:legacy', JSON.stringify({
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_challenge: CODE_CHALLENGE, state: '', created_at: Date.now(),
    }));
    const res = await submitConsent('legacy');
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('Location'));
    assert.ok(loc.searchParams.get('code'));
    assert.equal(loc.searchParams.has('iss'), false);
  });
});
