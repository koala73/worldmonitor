// A seeded key's data TTL must OUTLIVE the health staleness threshold for that key.
//
// Bug (found 2026-07-14 in production): seed-conflict-intel runs on `*/15 * * * *`
// and wrote `conflict:acled:v1:all:0:0` with ACLED_TTL = 900s — a 15-minute TTL on a
// 15-minute refresh interval. Zero headroom: ONE late, slow, or Railway-SKIPPED tick
// and the key expires before the next write lands. Observed live: last successful run
// 23 min ago (recordCount 67, status ok), data key already gone (EXISTS 0, TTL -2),
// /api/health = EMPTY (crit) — and consumers of the forecast EMA input got nothing.
//
// The incoherence this pins: health's maxStaleMin for acledIntel is 38 minutes, but
// the data evaporated at 15. The key disappeared BEFORE the staleness warning could
// fire, so a mild "the seeder is running late" condition reported as a CRIT (EMPTY)
// instead of escalating gracefully through STALE_SEED (warn).
//
// The invariant: TTL > maxStaleMin. Then the escalation is ordered and truthful —
// seeder late  -> STALE_SEED (warn, data still served)
// seeder dead  -> EMPTY (crit, data genuinely gone)
//
// This is NOT the SAM/NOT_CONFIGURED case. That key has no keyless path and correctly
// reports `unavailable`. This one is populated by a credential-free source
// (sourceVersion "acled-hapi-pizzint", 67 records), so an EMPTY here is a real outage
// and must stay a crit — it just must not fire spuriously.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ACLED_TTL } from '../scripts/seed-conflict-intel.mjs';
import { CACHE_TTL as CORRELATION_TTL } from '../scripts/seed-correlation.mjs';
import { __testing__ } from '../api/health.js';

const radarSeeder = readFileSync(new URL('../scripts/seed-internet-outages.mjs', import.meta.url), 'utf8');
for (const [name, constant] of [['ddosAttacks', 'DDOS_TTL'], ['trafficAnomalies', 'ANOMALIES_TTL']]) {
  test(`${name} payload survives the rounded health staleness boundary`, () => {
    const match = radarSeeder.match(new RegExp(`^const ${constant} = (\\d+);`, 'm'));
    assert.ok(match, `${constant} must remain discoverable in the seeder`);
    const ttl = Number(match[1]);
    const { SEED_META, BOOTSTRAP_KEYS, classifyKey } = __testing__;
    const config = SEED_META[name];
    assert.ok(ttl > (config.maxStaleMin + 0.5) * 60,
      `${constant} must outlive the rounded staleness boundary`);
    const now = 1_700_000_000_000;
    const redisKey = BOOTSTRAP_KEYS[name];
    for (const ageSeconds of [config.maxStaleMin * 60 + 29, config.maxStaleMin * 60 + 31]) {
      assert.ok(ttl > ageSeconds);
      const entry = classifyKey(name, redisKey, { allowOnDemand: false }, {
        keyStrens: new Map([[redisKey, 128]]), keyErrors: new Map(),
        keyMetaValues: new Map([[config.key, JSON.stringify({ fetchedAt: now - ageSeconds * 1000, recordCount: 0 })]]),
        keyMetaErrors: new Map(), now,
      });
      assert.equal(entry.status, ageSeconds < (config.maxStaleMin + 0.5) * 60 ? 'OK' : 'STALE_SEED');
    }
  });
}

test('the ACLED conflict key outlives its own health staleness threshold', () => {
  const { SEED_META } = __testing__;
  const maxStaleSeconds = SEED_META.acledIntel.maxStaleMin * 60;

  assert.ok(
    ACLED_TTL > maxStaleSeconds,
    `ACLED_TTL (${ACLED_TTL}s) must exceed health maxStaleMin `
      + `(${SEED_META.acledIntel.maxStaleMin}min = ${maxStaleSeconds}s), or the data key expires `
      + 'before STALE_SEED can fire and a late seeder reports as an EMPTY crit',
  );
});

test('the ACLED key survives more than one missed cron tick', () => {
  // seed-conflict-intel cron is */15. Railway SKIPS a tick whenever the previous run
  // is still in flight (11 SKIPPED ticks observed in a 12h window), so the EFFECTIVE
  // cadence is routinely longer than 15 minutes. A TTL equal to the interval cannot
  // survive that; the repo convention elsewhere is ~3x the interval (see
  // seed-defense-patents.mjs: `CACHE_TTL = 1_814_400; // 21 days (3x weekly interval)`).
  const CRON_INTERVAL_SECONDS = 15 * 60;
  assert.ok(
    ACLED_TTL >= 2 * CRON_INTERVAL_SECONDS,
    `ACLED_TTL (${ACLED_TTL}s) must cover at least 2 refresh intervals `
      + `(${2 * CRON_INTERVAL_SECONDS}s) so a single skipped tick cannot drop the data`,
  );
});

// seed-correlation was the straggler of the #3640 round: api/health.js raised
// correlationCards.maxStaleMin 15 -> 30 to absorb bundle jitter, and the
// sibling it names in that very comment (hyperliquidFlow) had its seeder
// widened to 2700s, but this one kept a 1200s TTL whose comment still cited
// "maxStaleMin:15". Its four extra keys and the bootstrap-tier canonical key
// share the constant, so they all vanished at 20 minutes.
test('the correlation cards key outlives its own health staleness threshold', () => {
  const { SEED_META } = __testing__;
  const maxStaleSeconds = SEED_META.correlationCards.maxStaleMin * 60;

  assert.ok(
    CORRELATION_TTL > (SEED_META.correlationCards.maxStaleMin + 0.5) * 60,
    `CACHE_TTL (${CORRELATION_TTL}s) must exceed the rounded health boundary `
      + `(${SEED_META.correlationCards.maxStaleMin}min = ${maxStaleSeconds}s), or the data key `
      + 'expires before STALE_SEED can fire and a late seeder reports as an EMPTY crit',
  );
});

test('a late correlation run still classifies as STALE_SEED, not EMPTY', () => {
  const { SEED_META, BOOTSTRAP_KEYS, classifyKey } = __testing__;
  const config = SEED_META.correlationCards;
  const redisKey = BOOTSTRAP_KEYS.correlationCards;
  const now = 1_700_000_000_000;

  // The gap #3640 widened the alarm for: the bundle skipped a tick and the
  // next publish lands ~21min late. The payload must still be there to serve.
  for (const ageSeconds of [config.maxStaleMin * 60 + 29, config.maxStaleMin * 60 + 31]) {
    assert.ok(
      CORRELATION_TTL > ageSeconds,
      `the payload must survive ${ageSeconds}s so health can describe it`,
    );
    const entry = classifyKey('correlationCards', redisKey, { allowOnDemand: false }, {
      keyStrens: new Map([[redisKey, 128]]), keyErrors: new Map(),
      keyMetaValues: new Map([[config.key, JSON.stringify({ fetchedAt: now - ageSeconds * 1000, recordCount: 4 })]]),
      keyMetaErrors: new Map(), now,
    });
    assert.equal(entry.status, ageSeconds < (config.maxStaleMin + 0.5) * 60 ? 'OK' : 'STALE_SEED');
  }
});

test('every correlation key published by the run shares that one TTL', () => {
  // The argument above only holds if the four per-domain extra keys expire
  // with the canonical one. If any of them took a literal instead, it would
  // disappear early and the panel would show a partial card set while health
  // still read OK. runSeed's descriptor sits behind an argv guard, so this
  // reads the source, the same technique the DDOS/ANOMALIES cases above use.
  const source = readFileSync(new URL('../scripts/seed-correlation.mjs', import.meta.url), 'utf8');
  for (const domain of ['military', 'escalation', 'economic', 'disaster']) {
    assert.match(
      source,
      new RegExp(`key:\\s*'correlation:${domain}:v1',\\s*ttl:\\s*CACHE_TTL\\b`),
      `correlation:${domain}:v1 must expire with the canonical key, not on a literal of its own`,
    );
  }
  assert.match(
    source,
    /ttlSeconds:\s*CACHE_TTL\b/,
    'the canonical key must take the same constant',
  );
});

test('the correlation cards key survives more than one missed bundle tick', () => {
  // seed-bundle-derived-signals runs every 5min and Railway SKIPs a whole tick
  // while the previous bundle is in flight, which is what produced the 9-19min
  // gaps recorded in the api/health.js note.
  const BUNDLE_INTERVAL_SECONDS = 5 * 60;
  assert.ok(
    CORRELATION_TTL >= 2 * BUNDLE_INTERVAL_SECONDS,
    `CACHE_TTL (${CORRELATION_TTL}s) must cover at least 2 refresh intervals`,
  );
});
