import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, test } from 'node:test';

process.env.WINGBITS_API_KEY = 'test-wingbits';
process.env.OPENSKY_CLIENT_ID = 'test-id';
process.env.OPENSKY_CLIENT_SECRET = 'test-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.WM_SEED_RETRY_DELAY_MS = '1';
process.env.OPENSKY_LEGACY_COOLDOWN_COMPAT_UNTIL = '2099-01-01T00:00:00.000Z';
delete process.env.OPENSKY_PROXY_AUTH;
delete process.env.PROXY_URL;

const { fetchOpenSkyGlobal } = await import('../scripts/seed-military-flights.mjs');
const {
  cooldownKeyForAccount,
  OPENSKY_LEGACY_COOLDOWN_KEY,
  OPENSKY_MAX_DEADLINE_SET_LUA,
  OPENSKY_COMPARE_AND_DEL_LUA,
  accountFingerprint,
  buildCooldownRecord,
  applyMaxDeadlineWrite,
  applyCompareAndDelete,
} = createRequire(import.meta.url)('../scripts/_opensky-account-cooldown.cjs');
const OPENSKY_COOLDOWN_KEY = cooldownKeyForAccount(accountFingerprint('test-id'));
const OPENSKY_LEGACY_KEY = OPENSKY_LEGACY_COOLDOWN_KEY;

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
  return raw.includes('/get/' + encodeURIComponent(OPENSKY_COOLDOWN_KEY))
    || raw.includes('/get/' + encodeURIComponent(OPENSKY_LEGACY_KEY));
}

function install({ redisRecord = null, legacyRedisRecord = null, redisError = false, migrationError = false, allowOpenSky = false } = {}) {
  redisGets = 0;
  openskyCalls = 0;
  globalThis.fetch = async (url, init) => {
    const raw = typeof url === 'string' ? url : url.url;
    if (isCooldownGet(raw)) {
      redisGets += 1;
      if (redisError) return new Response('redis down', { status: 500 });
      const record = raw.includes('/get/' + encodeURIComponent(OPENSKY_LEGACY_KEY))
        ? legacyRedisRecord
        : redisRecord;
      return Response.json({
        result: record == null ? null : JSON.stringify(record),
      });
    }
    if (isRedisUrl(raw)) {
      if (migrationError && String(init?.body || '').startsWith('["EVAL",')) {
        return new Response('redis down', { status: 500 });
      }
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
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.OPENSKY_LEGACY_COOLDOWN_COMPAT_UNTIL = '2099-01-01T00:00:00.000Z';
});

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

test('a matching legacy v1 cooldown is honored and copied into the account v2 key', async () => {
  const record = buildCooldownRecord({
    cooldownMs: 10 * 60_000,
    retryAfterSeconds: 900,
    account: accountFingerprint('test-id'),
    recordedBy: 'ais-relay',
  });
  const store = { [OPENSKY_LEGACY_KEY]: JSON.stringify(record) };
  installInterleavedStore(store, { allowOpenSky: false });
  const fetchSources = emptySources();
  await fetchOpenSkyGlobal({
    source: { value: 'none' },
    fetchSources,
    seenIds: new Set(),
    allStates: [],
  });
  assert.equal(openskyCalls, 0);
  assert.equal(redisGets, 2, 'the seeder must check v2 before falling back to v1');
  assert.match(fetchSources.regions[0].authStatus, /^quota-cooldown:/);
  assert.deepEqual(JSON.parse(store[OPENSKY_COOLDOWN_KEY]), record);
  assert.equal(store[OPENSKY_LEGACY_KEY], JSON.stringify(record), 'migration must not delete or rewrite v1');
});

test('a matching legacy v1 cooldown remains honored when migration fails', async () => {
  const record = buildCooldownRecord({
    cooldownMs: 10 * 60_000,
    account: accountFingerprint('test-id'),
    recordedBy: 'ais-relay',
  });
  install({ legacyRedisRecord: record, migrationError: true, allowOpenSky: false });
  const fetchSources = emptySources();
  await fetchOpenSkyGlobal({
    source: { value: 'none' },
    fetchSources,
    seenIds: new Set(),
    allStates: [],
  });
  assert.equal(openskyCalls, 0, 'the observed legacy cooldown must still block OpenSky');
  assert.equal(redisGets, 2);
  assert.match(fetchSources.regions[0].authStatus, /^quota-cooldown:/);
});

test('an expired legacy cutoff avoids the v1 read on a clean v2 miss', async () => {
  const record = buildCooldownRecord({
    cooldownMs: 10 * 60_000,
    account: accountFingerprint('test-id'),
    recordedBy: 'ais-relay',
  });
  process.env.OPENSKY_LEGACY_COOLDOWN_COMPAT_UNTIL = '2000-01-01T00:00:00.000Z';
  install({ legacyRedisRecord: record, allowOpenSky: true });
  const fetchSources = emptySources();
  await fetchOpenSkyGlobal({
    source: { value: 'none' },
    fetchSources,
    seenIds: new Set(),
    allStates: [],
  });
  assert.equal(redisGets, 1);
  assert.ok(openskyCalls >= 1);
  assert.match(fetchSources.regions[0].authStatus, /^(success|empty):/);
});

test('a mismatched legacy v1 cooldown fails open and is not migrated', async () => {
  const record = buildCooldownRecord({
    cooldownMs: 10 * 60_000,
    account: accountFingerprint('someone-else'),
    recordedBy: 'ais-relay',
  });
  install({ legacyRedisRecord: record, allowOpenSky: true });
  const fetchSources = emptySources();
  await fetchOpenSkyGlobal({
    source: { value: 'none' },
    fetchSources,
    seenIds: new Set(),
    allStates: [],
  });
  assert.ok(openskyCalls >= 1, 'mismatch must not inherit another account lockout');
  assert.equal(redisGets, 2);
  assert.match(fetchSources.regions[0].authStatus, /^(success|empty):/);
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

function installInterleavedStore(store, { onOpenSky, allowOpenSky = true } = {}) {
  redisGets = 0;
  openskyCalls = 0;
  globalThis.fetch = async (url, init) => {
    const raw = typeof url === 'string' ? url : url.url;
    if (isCooldownGet(raw)) {
      redisGets += 1;
      const key = raw.includes('/get/' + encodeURIComponent(OPENSKY_LEGACY_KEY))
        ? OPENSKY_LEGACY_KEY
        : OPENSKY_COOLDOWN_KEY;
      const value = store[key];
      return Response.json({ result: value == null ? null : value });
    }
    if (isRedisUrl(raw)) {
      let command = null;
      try { command = JSON.parse(init?.body || 'null'); } catch { command = null; }
      if (Array.isArray(command) && command[0] === 'EVAL') {
        const keyCount = Number(command[2]);
        const keys = command.slice(3, 3 + keyCount);
        const args = command.slice(3 + keyCount);
        if (command[1] === OPENSKY_MAX_DEADLINE_SET_LUA) {
          const record = JSON.parse(args[0]);
          const writes = keys.reduce((count, key) => {
            const decision = applyMaxDeadlineWrite(store, key, record, Number(args[1]));
            return count + (decision.write ? 1 : 0);
          }, 0);
          return Response.json({ result: writes });
        }
        if (command[1] === OPENSKY_COMPARE_AND_DEL_LUA) {
          const decision = applyCompareAndDelete(store, keys[0], {
            expectedJson: args[0],
            expectedRevision: args[1],
            watermarkUntil: Number(args[2]),
          });
          return Response.json({ result: decision.delete ? 1 : 0 });
        }
      }
      return Response.json({ result: 'OK' });
    }
    if (raw.startsWith(TOKEN_URL) || new URL(raw).host === STATES_HOST) {
      openskyCalls += 1;
      onOpenSky?.({ raw, store });
      if (!allowOpenSky) throw new Error(`OpenSky must not be contacted, but requested ${raw}`);
      if (raw.startsWith(TOKEN_URL)) {
        return Response.json({ access_token: 'tok', expires_in: 1800 });
      }
      if (typeof allowOpenSky === 'function') return allowOpenSky(raw);
      return Response.json({ states: [] });
    }
    throw new Error(`unexpected fetch ${raw}`);
  };
}

test('a seeder 429 atomically dual-writes v2 and v1 for old readers', async () => {
  const store = {};
  installInterleavedStore(store, {
    allowOpenSky: (raw) => {
      if (raw.startsWith(TOKEN_URL)) return Response.json({ access_token: 'tok', expires_in: 1800 });
      return new Response('quota', { status: 429, headers: { 'Retry-After': '120' } });
    },
  });
  await fetchOpenSkyGlobal({
    source: { value: 'none' },
    fetchSources: emptySources(),
    seenIds: new Set(),
    allStates: [],
  });

  assert.ok(store[OPENSKY_COOLDOWN_KEY]);
  assert.equal(store[OPENSKY_LEGACY_KEY], store[OPENSKY_COOLDOWN_KEY]);
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

test('a late shorter 429 SET does not overwrite a longer in-flight cooldown', async () => {
  const now = Date.now();
  const store = {};
  const longer = buildCooldownRecord({
    now,
    cooldownMs: 20 * 60_000,
    retryAfterSeconds: 1200,
    account: accountFingerprint('test-id'),
    recordedBy: 'ais-relay',
  });
  installInterleavedStore(store, {
    onOpenSky: ({ raw }) => {
      if (new URL(raw).host === STATES_HOST) {
        applyMaxDeadlineWrite(store, OPENSKY_COOLDOWN_KEY, longer);
      }
    },
    allowOpenSky: (raw) => {
      if (raw.startsWith(TOKEN_URL)) return Response.json({ access_token: 'tok', expires_in: 1800 });
      return new Response('quota', { status: 429, headers: { 'Retry-After': '30' } });
    },
  });
  await fetchOpenSkyGlobal({
    source: { value: 'none' },
    fetchSources: emptySources(),
    seenIds: new Set(),
    allStates: [],
  });
  assert.ok(openskyCalls >= 1);
  assert.equal(JSON.parse(store[OPENSKY_COOLDOWN_KEY]).until, longer.until);
  assert.equal(JSON.parse(store[OPENSKY_COOLDOWN_KEY]).recordedBy, 'ais-relay');
});

test('a stale success DEL does not erase a newer longer cooldown', async () => {
  const now = Date.now();
  const store = {};
  const newer = buildCooldownRecord({
    now: now + 15,
    cooldownMs: 15 * 60_000,
    retryAfterSeconds: 900,
    account: accountFingerprint('test-id'),
    recordedBy: 'ais-relay',
  });
  installInterleavedStore(store, {
    onOpenSky: ({ raw }) => {
      if (new URL(raw).host === STATES_HOST) {
        applyMaxDeadlineWrite(store, OPENSKY_COOLDOWN_KEY, newer);
      }
    },
  });
  const fetchSources = emptySources();
  await fetchOpenSkyGlobal({
    source: { value: 'none' },
    fetchSources,
    seenIds: new Set(),
    allStates: [],
  });
  assert.ok(openskyCalls >= 1);
  assert.match(fetchSources.regions[0].authStatus, /^(success|empty):/);
  assert.equal(JSON.parse(store[OPENSKY_COOLDOWN_KEY]).until, newer.until);
  assert.equal(JSON.parse(store[OPENSKY_COOLDOWN_KEY]).revision, newer.revision);
});
