// #6249 — the single global OpenSky /states/all query retries bounded,
// transient failures and leaves 429s (and auth failures) on their existing
// no-retry / immediate-refresh contracts.

import { beforeEach, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WINGBITS_API_KEY = 'test-wingbits';
process.env.WM_ENABLE_NONCOMMERCIAL_ADSB_GAP_FILL = '1';
process.env.OPENSKY_CLIENT_ID = 'test-id';
process.env.OPENSKY_CLIENT_SECRET = 'test-secret';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.OPENSKY_PROXY_AUTH;

const { fetchOpenSkyAuthenticated } = await import('../scripts/seed-military-flights.mjs');

const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_URL = 'https://opensky-network.org/api/states/all?extended=1';

const originalFetch = globalThis.fetch;
let statesCalls;
let statesAuth;
let statesResponses;
let tokenCalls;
let tokenSerial = 0;

function installStates(responses) {
  statesResponses = [...responses];
  statesCalls = [];
  statesAuth = [];
  tokenCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const raw = typeof url === 'string' ? url : url.url;
    if (raw === TOKEN_URL) {
      tokenCalls += 1;
      tokenSerial += 1;
      return Response.json({ access_token: `token-${tokenSerial}`, expires_in: 1800 });
    }
    if (raw === STATES_URL) {
      const headers = init.headers && typeof init.headers === 'object' ? init.headers : {};
      statesAuth.push(headers.Authorization || headers.authorization || '');
      statesCalls.push(raw);
      const next = statesResponses.shift();
      if (typeof next === 'number') {
        return new Response(JSON.stringify({ error: 'upstream' }), {
          status: next,
          headers: { 'Content-Type': 'application/json', ...({ 429: { 'Retry-After': '900' } })[next] },
        });
      }
      return Response.json(next ?? { states: [] });
    }
    return Response.json({});
  };
}

beforeEach(() => installStates([]));
afterEach(() => { globalThis.fetch = originalFetch; });

describe('OpenSky global fetch retry ladder (#6249)', () => {
  test('a transient 5xx is retried once and then succeeds', async () => {
    installStates([500, { states: [['ae0001', 'RCH101', 'US', 40, -100]] }]);
    const result = await fetchOpenSkyAuthenticated();
    assert.equal(result.status, 'success:direct');
    assert.equal(result.states.length, 1);
    assert.equal(statesCalls.length, 2, 'exactly one bounded retry');
  });

  test('a 429 is never retried', async () => {
    installStates([429]);
    const result = await fetchOpenSkyAuthenticated();
    assert.match(result.status, /error:.*429/);
    assert.equal(result.rateLimited, true);
    assert.equal(result.retryAfterSeconds, 900);
    assert.equal(statesCalls.length, 1, 'a 429 must not be retried (#6241)');
  });

  test('a 401 refreshes the token immediately and retries once', async () => {
    installStates([401, { states: [] }]);
    const result = await fetchOpenSkyAuthenticated();
    assert.equal(result.status, 'success:direct');
    assert.equal(statesCalls.length, 2);
    assert.match(statesAuth[0], /^Bearer /);
    assert.match(statesAuth[1], /^Bearer /);
    assert.notEqual(
      statesAuth[1],
      statesAuth[0],
      'the unauthorized attempt must refresh the bearer, not retry the same token',
    );
  });

  test('two consecutive 401s report without looping', async () => {
    installStates([401, 401]);
    const result = await fetchOpenSkyAuthenticated();
    assert.match(result.status, /unauthorized after token refresh/);
    assert.equal(result.states, null);
    assert.equal(statesCalls.length, 2);
  });

  test('a persistent transient failure exhausts the ladder and reports the error', async () => {
    installStates([503, 503]);
    const result = await fetchOpenSkyAuthenticated();
    assert.match(result.status, /error:/);
    assert.equal(result.states, null);
    assert.equal(statesCalls.length, 2, 'ladder is bounded at two attempts');
  });
});
