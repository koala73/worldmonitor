// The watched-site evidence probe is new: /api/health and /api/seed-health must not read it as
// missing between the Vercel deploy and the climate bundle's first site publication, and must
// enforce it once the seeder's activation marker exists. These cases cover the launched contract
// (ORBITAL_WATCH_ENABLED=true); tests/orbital-sites-dark-launch-health.test.mjs covers the dark one.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalEnv = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
  ORBITAL_WATCH_ENABLED: process.env.ORBITAL_WATCH_ENABLED,
};
process.env.ORBITAL_WATCH_ENABLED = 'true';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
process.env.WORLDMONITOR_VALID_KEYS = 'test-key';

const { __testing__ } = await import('../api/health.js?orbital-watch=lit');
const { handleSeedHealth } = await import('../api/seed-health.js');
const { MAX_STALE_MIN } = await import('../scripts/seed-orbital-sites.mjs');
const { ORBITAL_SITES_ACTIVATION_KEY, ORBITAL_SITES_KEY } = await import('../scripts/_orbital-sites.mjs');

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

const { classifyKey, STANDALONE_KEYS, SEED_META, ACTIVATION_MARKERS, ON_DEMAND_KEYS } = __testing__;
const name = 'orbitalSites';
const key = STANDALONE_KEYS[name];
const metaKey = 'seed-meta:orbital:sites';
const now = Date.parse('2026-11-13T09:30:00Z');

function classify({ until = null, activated = false, meta = null } = {}) {
  return classifyKey(name, key, { allowOnDemand: true }, {
    keyStrens: new Map(meta ? [[key, 4096]] : []), keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map(meta ? [[metaKey, JSON.stringify(meta)]] : []),
    activationStates: new Map([[name, activated]]),
    rolloutPendingUntilMs: new Map(until ? [[name, until]] : []), now,
  }).status;
}

test('the probe, seeder and marker name the same keys', () => {
  assert.equal(key, ORBITAL_SITES_KEY);
  assert.equal(SEED_META[name].key, metaKey);
  assert.equal(SEED_META[name].maxStaleMin, MAX_STALE_MIN);
  assert.equal(SEED_META[name].activationKey, ORBITAL_SITES_ACTIVATION_KEY);
  assert.equal(ACTIVATION_MARKERS[name], ORBITAL_SITES_ACTIVATION_KEY);
  assert.equal(SEED_META[name].cutover.activationKey, ORBITAL_SITES_ACTIVATION_KEY);
  assert.ok(ON_DEMAND_KEYS.has(name));
});

test('health is soft before the activation marker exists and enforced after', () => {
  assert.equal(classify({ until: now + 60_000 }), 'ROLLOUT_PENDING');
  assert.equal(classify({ until: now + 60_000, activated: true }), 'EMPTY');
  assert.equal(classify({ until: now }), 'EMPTY');
});

test('a published site index reads healthy, and a thin or old one does not', () => {
  const fresh = now - 60_000;
  assert.equal(classify({ activated: true, meta: { fetchedAt: fresh, recordCount: 655 } }), 'OK');
  assert.equal(classify({ activated: true, meta: { fetchedAt: fresh, recordCount: SEED_META[name].minRecordCount - 1 } }), 'COVERAGE_PARTIAL');
  assert.equal(classify({ activated: true, meta: { fetchedAt: now - (MAX_STALE_MIN + 1) * 60_000, recordCount: 655 } }), 'STALE_SEED');
});

// The first production run (2026-11-16, RUN_BUDGET_MS with the change-scoring reserve) evaluated
// 171 of 705 sites. A run's count is budget-bound, so this is the throughput to plan against.
const MEASURED_SITES_PER_RUN = 171;

test('a cold start\'s first healthy run does not read as partial coverage', () => {
  assert.equal(classify({ activated: true, meta: { fetchedAt: now - 60_000, recordCount: MEASURED_SITES_PER_RUN } }), 'OK');
});

test('the sites cadence refreshes the whole registry inside the rollup freshness window', async () => {
  const { readFileSync } = await import('node:fs');
  const { ROLLUP_MAX_AGE_MS } = await import('../scripts/shared/orbital/country-rollup.js');
  const { WATCHED_SITES } = await import('../scripts/shared/orbital-watched-sites.generated.mjs');
  const bundle = readFileSync(new URL('../scripts/seed-bundle-climate.mjs', import.meta.url), 'utf8');
  const interval = bundle.match(/label: 'Orbital-Sites'[^}]*intervalMs: ([^,]+),/)?.[1];
  assert.ok(interval, 'Orbital-Sites member has an intervalMs');
  const intervalMs = new Function('HOUR', 'DAY', `return ${interval};`)(3_600_000, 86_400_000);
  // A site evaluated in the oldest run of the window must be re-evaluated before its rollup expires.
  const runsPerWindow = Math.floor(ROLLUP_MAX_AGE_MS / intervalMs);
  assert.ok(runsPerWindow * MEASURED_SITES_PER_RUN >= WATCHED_SITES.length,
    `${runsPerWindow} runs x ${MEASURED_SITES_PER_RUN} sites must cover ${WATCHED_SITES.length} sites within ${ROLLUP_MAX_AGE_MS / 86_400_000} days`);
});

function installRedisMock({ activated, meta }) {
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map(([operation, k]) => {
      if (operation === 'EXISTS') return { result: k === ORBITAL_SITES_ACTIVATION_KEY && activated ? 1 : 0 };
      if (k === metaKey) return { result: meta == null ? null : JSON.stringify(meta) };
      return { result: JSON.stringify({ fetchedAt: now, recordCount: 10_000 }) };
    });
    return new Response(JSON.stringify(results), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

async function seedHealthEntry() {
  const response = await handleSeedHealth(new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  }), { now });
  return (await response.json()).seeds['orbital:sites'];
}

test('seed-health is pending before the first publication and ok after it', async () => {
  installRedisMock({ activated: false, meta: null });
  assert.equal((await seedHealthEntry()).status, 'pending-activation');
  installRedisMock({ activated: true, meta: null });
  assert.notEqual((await seedHealthEntry()).status, 'pending-activation');
  installRedisMock({ activated: true, meta: { fetchedAt: now - 60_000, recordCount: 655 } });
  assert.equal((await seedHealthEntry()).status, 'ok');
});
