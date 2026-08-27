import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, test } from 'node:test';

process.env.WINGBITS_API_KEY = 'test-wingbits';
process.env.OPENSKY_CLIENT_ID = 'test-id';
process.env.OPENSKY_CLIENT_SECRET = 'test-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.WM_SEED_RETRY_DELAY_MS = '1';
delete process.env.OPENSKY_PROXY_AUTH;
delete process.env.PROXY_URL;

const { fetchOpenSkyGlobal } = await import('../scripts/seed-military-flights.mjs');
const {
  OPENSKY_COOLDOWN_KEY,
  accountFingerprint,
  buildCooldownRecord,
} = createRequire(import.meta.url)('../scripts/_opensky-account-cooldown.cjs');

const originalFetch = globalThis.fetch;
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_HOST = 'opensky-network.org';

let redisGets;
let openskyCalls;

function isRedisUrl(raw) {
  try {
    return new URL(raw).host === 'redis.test';
  } catch {
    return raw.includes('redis.test');
  }
}

function isCooldownGet(raw) {
  return raw.includes(`/get/${encodeURIComponent(OPENSKY_COOLDOWN_KEY)}`)
    || raw.includes('/get/opensky:cooldown-until:v1');
}

function install({ redisRecord = null, redisError = false, allowOpenSky = false } = {}) {
  redisGets = 0;
  openskyCalls = 0;
  globalThis.fetch = async (url) => {
    const raw = typeof url === 'string' ? url : url.url;
    if (isCooldownGet(raw)) {
      redisGets += 1;
      if (redisError) return new Response('redis down', { status: 500 });
      return Response.json({
        result: redisRecord == null ? null : JSON.stringify(redisRecord),
      });
    }
    if (isRedisUrl(raw)) {
      // SET/DEL from clearOpenSkyCooldown / recordOpenSkyCooldown — acknowledge.
      return Response.json({ result: 'OK' });
    }
    if (raw.startsWith(TOKEN_URL) || new URL(raw).host === STATES_HOST) {
      openskyCalls += 1;
      if (!allowOpenSky) throw new Error(`OpenSky must not be contacted, but requested ${raw}`);
      if (raw.startsWith(TOKEN_URL)) {
        return Response.json({ access_token: 'tok', expires_in: 1800 });
      }
      return Response.json({ states: [] });
    }
    throw new Error(`unexpected fetch ${raw}`);
  };
}

beforeEach(() => install());
afterEach(() => { globalThis.fetch = originalFetch; });

function emptySources() {
  return { regions: [] };
}

test('a relay-written shared cooldown makes the seeder skip without an OpenSky request (#6253)', async () => {
  const now = Date.now();
  const record = buildCooldownRecord({
    now,
    cooldownMs: 10 * 60_000,
    retryAfterSeconds: 900,
    account: accountFingerprint('test-id'),
    recordedBy: 'ais-relay',
  });
  install({ redisRecord: record });
  const fetchSources = emptySources();
  await fetchOpenSkyGlobal({
    source: { value: 'none' },
    fetchSources,
    seenIds: new Set(),
    allStates: [],
  });
  assert.equal(openskyCalls, 0);
  assert.equal(redisGets, 1);
  assert.match(fetchSources.regions[0].authStatus, /^quota-cooldown:/);
  assert.ok(fetchSources.openSkyCooldownRemainingMs > 0);
});

test('an account mismatch fails open and still attempts OpenSky', async () => {
  const record = buildCooldownRecord({
    cooldownMs: 10 * 60_000,
    account: accountFingerprint('someone-else'),
    recordedBy: 'ais-relay',
  });
  install({ redisRecord: record, allowOpenSky: true });
  const fetchSources = emptySources();
  await fetchOpenSkyGlobal({
    source: { value: 'none' },
    fetchSources,
    seenIds: new Set(),
    allStates: [],
  });
  assert.ok(openskyCalls >= 1, 'mismatch must not inherit another account lockout');
  assert.match(fetchSources.regions[0].authStatus, /^(success|empty):/);
});

test('a Redis read failure fails open so the seeder still attempts OpenSky', async () => {
  install({ redisError: true, allowOpenSky: true });
  const fetchSources = emptySources();
  await fetchOpenSkyGlobal({
    source: { value: 'none' },
    fetchSources,
    seenIds: new Set(),
    allStates: [],
  });
  assert.ok(redisGets >= 1);
  assert.ok(openskyCalls >= 1, 'Redis errors must fail open rather than park OpenSky');
});
