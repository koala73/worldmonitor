// Regression test: a seed-meta key must never expire BEFORE the data key it
// vouches for.
//
// api/health.js decides freshness from `seed-meta:<domain>:<resource>` and
// falls through to plain OK when that key is absent but the data key still has
// bytes (classifyKey's `seedStale === true` arm at api/health.js:2336 is the
// only STALE_SEED path, and a missing meta yields `seedStale: null`). So a meta
// TTL shorter than the data TTL does not merely lose a heartbeat — it makes the
// STALE_SEED alarm UNREACHABLE for the whole gap, and the first signal an
// operator gets is the day the data key itself expires into a crit EMPTY.
//
// That is exactly what seed-economy's four EIA weekly keys shipped with:
// 21-day data TTL, default 7-day meta TTL, 14-day health budget. A dead EIA
// fetch read OK from day 7 to day 21, then flipped straight to EMPTY, and the
// 14-day warn in between could never fire.
//
// `writeFreshnessMetadata` has clamped its own meta writes to
// `Math.max(7d, dataTtl)` for exactly this reason; these two extra-key paths
// did not. The assertion below is the invariant, not the constant: it holds for
// every caller regardless of the TTLs they choose.

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { writeExtraKeyWithMeta, resolveSeedMetaTtl, SEED_META_MIN_TTL_SECONDS } =
  await import('../scripts/_seed-utils.mjs');

const originalFetch = globalThis.fetch;

/** seed-economy.mjs CRUDE_INVENTORIES_TTL / NAT_GAS_TTL / SPR_TTL / REFINERY_INPUTS_TTL. */
const EIA_WEEKLY_DATA_TTL = 1_814_400; // 21 days
/** api/health.js SEED_META.crudeInventories.maxStaleMin, in seconds. */
const EIA_HEALTH_BUDGET_SECONDS = 20160 * 60; // 14 days

let sets;

function ttlOf(command) {
  const exIndex = command.indexOf('EX');
  return exIndex === -1 ? null : command[exIndex + 1];
}

beforeEach(() => {
  sets = [];
  globalThis.fetch = async (url, opts = {}) => {
    const command = opts?.body ? JSON.parse(opts.body) : null;
    if (Array.isArray(command) && command[0] === 'SET') sets.push(command);
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('writeExtraKeyWithMeta: seed-meta outlives the data key it vouches for', async () => {
  await writeExtraKeyWithMeta(
    'economic:crude-inventories:v1',
    { weeks: [{ period: '2026-08-21', value: 1 }] },
    EIA_WEEKLY_DATA_TTL,
    1,
  );

  const dataSet = sets.find((c) => c[1] === 'economic:crude-inventories:v1');
  const metaSet = sets.find((c) => c[1] === 'seed-meta:economic:crude-inventories');
  assert.ok(dataSet, 'data key was written');
  assert.ok(metaSet, 'seed-meta key was written');

  assert.equal(ttlOf(dataSet), EIA_WEEKLY_DATA_TTL);
  assert.ok(
    ttlOf(metaSet) >= ttlOf(dataSet),
    `seed-meta TTL (${ttlOf(metaSet)}s) must be >= the data TTL (${ttlOf(dataSet)}s) — `
    + 'otherwise health reads OK on data the meta can no longer describe',
  );
  assert.ok(
    ttlOf(metaSet) >= EIA_HEALTH_BUDGET_SECONDS,
    `seed-meta TTL (${ttlOf(metaSet)}s) must outlast the health staleness budget `
    + `(${EIA_HEALTH_BUDGET_SECONDS}s) so STALE_SEED can actually fire`,
  );
});

test('writeExtraKeyWithMeta: short data TTLs keep the 7-day meta floor', async () => {
  await writeExtraKeyWithMeta('market:gold-extended:v1', { rows: [] }, 600, 0);

  const metaSet = sets.find((c) => c[1] === 'seed-meta:market:gold-extended');
  assert.ok(metaSet, 'seed-meta key was written');
  // The floor is what lets health report STALE_SEED on a key whose data expired
  // hours ago (api/health.js:2280) — a data-TTL-only meta would vanish with it.
  assert.equal(ttlOf(metaSet), SEED_META_MIN_TTL_SECONDS);
});

test('writeExtraKeyWithMeta: an explicit metaTtlSeconds still wins', async () => {
  // The clamp is a DEFAULT, not an override: the parameter keeps meaning what
  // it says for any caller that needs a TTL of its own.
  await writeExtraKeyWithMeta('intel:cross-strait:v1', { x: 1 }, 600, 1, undefined, 300);

  const metaSet = sets.find((c) => c[1] === 'seed-meta:intel:cross-strait');
  assert.ok(metaSet, 'seed-meta key was written');
  assert.equal(ttlOf(metaSet), 300);
});

test('resolveSeedMetaTtl: floor, clamp, and explicit override', () => {
  assert.equal(resolveSeedMetaTtl(undefined, 600), SEED_META_MIN_TTL_SECONDS);
  assert.equal(resolveSeedMetaTtl(undefined, EIA_WEEKLY_DATA_TTL), EIA_WEEKLY_DATA_TTL);
  assert.equal(resolveSeedMetaTtl(undefined, undefined), SEED_META_MIN_TTL_SECONDS);
  assert.equal(resolveSeedMetaTtl(300, EIA_WEEKLY_DATA_TTL), 300);
});
