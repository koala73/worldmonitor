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

import { ACLED_TTL } from '../scripts/seed-conflict-intel.mjs';
import { __testing__ } from '../api/health.js';

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
