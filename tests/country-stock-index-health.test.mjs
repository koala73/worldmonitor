import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// #6235 follow-up: seeding the whole 45-country enum is only half the gold
// standard — without its own freshness metadata a run where every country
// failed would leave seed-meta:market:stocks fresh and health green while the
// country caches expired and the RPC silently reverted to per-request Yahoo.

const seedSource = readFileSync(new URL('../scripts/seed-market-quotes.mjs', import.meta.url), 'utf8');
const healthSource = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');

test('the country-index pass publishes its own freshness metadata', () => {
  assert.match(
    seedSource,
    /writeFreshnessMetadataSafely\(\s*'market',\s*'country-indexes',\s*seeded,/,
    'the seeded count — not the work-list size — must be what health thresholds on',
  );
});

test('the closed-market fast path refreshes country-index freshness too', () => {
  // Without this the alarm fires across every 60h+ weekend on data that is
  // present and deliberately TTL-preserved.
  assert.match(
    seedSource,
    /writeFreshnessMetadataSafely\(\s*'market',\s*'country-indexes',\s*countryTtl\.extendedKeys\.length,/,
    'the closed-market branch must report the count it actually extended',
  );
});

test('the closed-market fast path is not gated on the best-effort country keys', () => {
  // extendExistingTtl returns true only when EVERY key extends. Several
  // countries have no Yahoo-serviceable symbol (#6240) so their keys never
  // exist — gating on all 45 would make this branch never confirm and force a
  // full fetch on every closed day.
  assert.match(
    seedSource,
    /extendExistingTtl\(\[CANONICAL_KEY, 'seed-meta:market:stocks', RPC_KEY\], CACHE_TTL\)/,
    'the gating list must contain only the canonical keys',
  );
  assert.doesNotMatch(
    seedSource,
    /extendExistingTtl\(\[CANONICAL_KEY[^\]]*\.\.\.COUNTRY_STOCK_INDEX_KEYS\]/,
    'country keys must not gate the closed-market fast path',
  );
  assert.match(
    seedSource,
    /extendExistingTtlDetailed\(COUNTRY_STOCK_INDEX_KEYS, CACHE_TTL\)/,
    'country keys must be extended best-effort via the detailed variant',
  );
});

test('the shared country-index module stays free of filesystem reads', () => {
  // scripts/ais-relay.cjs imports this module for the CN key and the snapshot
  // builder. Every file it touches joins the always-on relay's Railway
  // runtime-dependency closure (tests/railway-watch-path-audit.test.mjs), so a
  // readFileSync here forces a relay redeploy whenever an unrelated country
  // entry changes — and fails the closure audit until someone widens the
  // relay's watch patterns for a dependency it never uses.
  const sharedSource = readFileSync(new URL('../scripts/_country-stock-index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(sharedSource, /readFileSync|node:fs/, 'the work-list belongs in _country-stock-index-registry.mjs');

  const registrySource = readFileSync(new URL('../scripts/_country-stock-index-registry.mjs', import.meta.url), 'utf8');
  assert.match(registrySource, /openapi-filter-param-contracts\.json/, 'the registry module owns the enum read');

  const relaySource = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    relaySource,
    /_country-stock-index-registry/,
    'the relay must not pull in the seeder-only work-list',
  );
});

test('health.js tracks the country-index seed with a floor below the measured success rate', () => {
  const entry = healthSource.match(
    /countryStockIndexes:\s*\{\s*key:\s*'seed-meta:market:country-indexes',\s*maxStaleMin:\s*(\d+),\s*minRecordCount:\s*(\d+)\s*\}/,
  );
  assert.ok(entry, 'the country-index seed must be registered in the health source registry');

  const maxStaleMin = Number(entry[1]);
  const minRecordCount = Number(entry[2]);

  assert.equal(maxStaleMin, 30, 'should mirror the market:stocks staleness budget it shares a cron with');
  // Measured 2026-08-05: 37/45 symbols return usable closes. The floor must sit
  // below that (or it alarms permanently on the eight known-dead symbols) and
  // above zero (or a total seeding failure stays green).
  assert.ok(minRecordCount > 0, 'a zero floor would let a total seeding failure report healthy');
  assert.ok(minRecordCount < 37, 'a floor at or above the measured success rate would alarm permanently');
});
