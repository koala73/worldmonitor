// Relay warm-ping internal-auth — behavioral + wiring regression tests.
//
// The Railway relay warm-pings cacheable, non-premium RPC endpoints
// (service-statuses, get-risk-scores, get-chokepoint-status, get-cable-health)
// to keep their compute caches hot. These require a session token or API key in
// normal traffic, and the #3541 hardening removed Origin-trust — so relay
// warm-pings 401 without a real credential. The relay now authenticates as a
// trusted internal caller via X-WorldMonitor-Key = WORLDMONITOR_RELAY_KEY,
// validated by the gateway against its own WORLDMONITOR_RELAY_KEY for these
// paths only.
//
// These tests exercise the real isRelayWarmPingRequest verifier and pin the
// least-privilege scoping + timing-safe comparison so a future edit can't widen
// the bypass or regress to a forgeable direct-equality check.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRelayWarmPingRequest, RELAY_WARM_PING_PATHS } from '../server/gateway.ts';

const SECRET = 'test-relay-warm-ping-secret-xxxxxxxxxxxxxxxxxxxx';
const WARM_PATH = '/api/supply-chain/v1/get-chokepoint-status';
const NON_WARM_PATH = '/api/intelligence/v1/get-country-risk';

function req(pathname: string, key?: string): Request {
  const headers: Record<string, string> = {};
  if (key !== undefined) headers['X-WorldMonitor-Key'] = key;
  return new Request(`https://api.worldmonitor.app${pathname}`, { headers });
}

describe('relay warm-ping internal auth', () => {
  const original = process.env.WORLDMONITOR_RELAY_KEY;
  beforeEach(() => { process.env.WORLDMONITOR_RELAY_KEY = SECRET; });
  afterEach(() => {
    if (original === undefined) delete process.env.WORLDMONITOR_RELAY_KEY;
    else process.env.WORLDMONITOR_RELAY_KEY = original;
  });

  it('covers exactly the free relay warm-ping endpoints', () => {
    assert.deepEqual(
      [...RELAY_WARM_PING_PATHS].sort(),
      [
        '/api/infrastructure/v1/get-cable-health',
        '/api/infrastructure/v1/list-service-statuses',
        '/api/infrastructure/v1/list-temporal-anomalies',
        '/api/intelligence/v1/get-risk-scores',
        '/api/supply-chain/v1/get-chokepoint-status',
      ],
    );
  });

  it('accepts warm-ping paths carrying the correct relay key', async () => {
    for (const path of RELAY_WARM_PING_PATHS) {
      assert.equal(await isRelayWarmPingRequest(req(path, SECRET), path), true, path);
    }
  });

  it('rejects the wrong key on a warm-ping path', async () => {
    assert.equal(await isRelayWarmPingRequest(req(WARM_PATH, 'nope'), WARM_PATH), false);
  });

  it('rejects a warm-ping path with no key header', async () => {
    assert.equal(await isRelayWarmPingRequest(req(WARM_PATH), WARM_PATH), false);
  });

  it('does NOT bypass a non-warm-ping path even with the correct relay key (scoping)', async () => {
    assert.equal(await isRelayWarmPingRequest(req(NON_WARM_PATH, SECRET), NON_WARM_PATH), false);
  });

  it('fails CLOSED when WORLDMONITOR_RELAY_KEY is unset (no bypass)', async () => {
    delete process.env.WORLDMONITOR_RELAY_KEY;
    assert.equal(await isRelayWarmPingRequest(req(WARM_PATH, SECRET), WARM_PATH), false);
  });

  it('fails CLOSED when the relay key is blank/whitespace', async () => {
    process.env.WORLDMONITOR_RELAY_KEY = '   ';
    assert.equal(await isRelayWarmPingRequest(req(WARM_PATH, '   '), WARM_PATH), false);
  });
});

// Source-text guardrail — mirrors tests/resilience-seed-refresh-auth.test.mts.
// The relay key comparison MUST stay timing-safe, and the verifier MUST remain
// wired into BOTH the key-check bypass and the entitlement skip so the bypass
// can't silently drift to a forgeable check or grant entitlement access.
describe('relay warm-ping auth wiring (source guardrail)', () => {
  it('keeps the active Service Statuses relay loop on shared warm-ping auth headers', async () => {
    const src = await readFile(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    assert.match(src, /const SERVICE_STATUSES_RPC_URL = 'https:\/\/api\.worldmonitor\.app\/api\/infrastructure\/v1\/list-service-statuses'/);
    assert.match(
      src,
      /fetch\(SERVICE_STATUSES_RPC_URL,\s*\{[\s\S]{0,240}?headers: warmPingHeaders\(\{ 'Content-Type': 'application\/json' \}\)/,
      'Service Statuses warm-ping must keep sending the relay key via warmPingHeaders()',
    );
  });

  it('uses timingSafeEqual (no direct equality) and is wired into both gates', async () => {
    const src = await readFile(new URL('../server/gateway.ts', import.meta.url), 'utf8');
    // verifier uses the timing-safe comparator against the env secret + header
    assert.match(src, /isRelayWarmPingRequest/);
    assert.match(src, /RELAY_WARM_PING_PATHS\.has\(pathname\)/);
    assert.match(src, /timingSafeEqual\(candidate, expected\)/);
    assert.doesNotMatch(src, /candidate\s*===?\s*expected/, 'relay key compare must be timing-safe, not direct equality');
    // key-check bypass includes relayWarmPingVerified
    assert.match(src, /seedRefreshVerified \|\| relayWarmPingVerified\b/);
    // entitlement skip excludes verified relay warm-pings
    assert.match(src, /!seedRefreshVerified && !relayWarmPingVerified/);
  });
});
