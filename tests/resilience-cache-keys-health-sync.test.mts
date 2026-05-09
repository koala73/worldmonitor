import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RESILIENCE_SCORE_CACHE_PREFIX,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_HISTORY_KEY_PREFIX,
} from '../server/worldmonitor/resilience/v1/_shared.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// Phase 1 T1.9 cache-key / health-registry sync guard.
//
// If a future PR bumps any of the resilience cache key constants in
// server/worldmonitor/resilience/v1/_shared.ts (e.g. resilience:score:v7
// becomes v8), the api/health.js SEED_META / KEY_TO_DOMAIN registry MUST
// be updated in the same PR or health probes will silently watch the
// wrong key and stop paging on real staleness.
//
// This test reads api/health.js as text and asserts the ranking cache
// key string (the only resilience key currently tracked in health) is
// literally present. When new resilience keys are added to health, add
// their assertions here too.
//
// Rationale: api/health.js is a plain .js file with hand-maintained
// string literals for the KEY_TO_DOMAIN mapping and the SEED_META
// registry. Those string literals are the single source of truth for
// what the health probe watches, and they are copy-pasted (not
// imported) from the server-side TypeScript constants. A literal text
// match is the cheapest possible drift guard.

describe('resilience cache-key health-registry sync (T1.9)', () => {
  const healthText = readFileSync(join(repoRoot, 'api/health.js'), 'utf-8');

  it('RESILIENCE_RANKING_CACHE_KEY literal appears in api/health.js', () => {
    assert.ok(
      healthText.includes(`'${RESILIENCE_RANKING_CACHE_KEY}'`) ||
        healthText.includes(`"${RESILIENCE_RANKING_CACHE_KEY}"`),
      `api/health.js must reference ${RESILIENCE_RANKING_CACHE_KEY} in KEY_TO_DOMAIN or SEED_META. Did you bump the key in _shared.ts without updating health?`,
    );
  });

  it('RESILIENCE_SCORE_CACHE_PREFIX matches expected resilience:score:v<n>: shape', () => {
    // The score key is per-country (prefix + ISO2), so we do not expect
    // the full key literal in health.js. Guard: the prefix string
    // matches the declared resilience:score:v<n>: shape so a typo or an
    // accidental rename is caught at test time.
    const versionMatch = /^resilience:score:v(\d+):$/.exec(RESILIENCE_SCORE_CACHE_PREFIX);
    assert.ok(
      versionMatch,
      `RESILIENCE_SCORE_CACHE_PREFIX must match resilience:score:v<n>: shape, got ${RESILIENCE_SCORE_CACHE_PREFIX}`,
    );
  });

  it('RESILIENCE_HISTORY_KEY_PREFIX matches expected resilience:history:v<n>: shape', () => {
    const versionMatch = /^resilience:history:v(\d+):$/.exec(RESILIENCE_HISTORY_KEY_PREFIX);
    assert.ok(
      versionMatch,
      `RESILIENCE_HISTORY_KEY_PREFIX must match resilience:history:v<n>: shape, got ${RESILIENCE_HISTORY_KEY_PREFIX}`,
    );
  });

  // PR 3A §net-imports adds this block. The cache-prefix-bump-propagation-
  // scope skill documents that "one prefix, many mirrored sites" is the
  // bug class: scorer and seed-resilience-scores agree, but an offline
  // analysis script or a benchmark mirror still reads the old prefix.
  // This test reads every known mirror file and asserts each contains
  // the current version literal (not v_old). If a future cache bump
  // misses a site, the test names it explicitly.
  describe('cache-prefix mirror parity — every declared literal site', () => {
    const SCORE_MIRROR_FILES = [
      'scripts/seed-resilience-scores.mjs',
      'scripts/validate-resilience-correlation.mjs',
      'scripts/backtest-resilience-outcomes.mjs',
      'scripts/validate-resilience-backtest.mjs',
    ] as const;
    const RANKING_MIRROR_FILES = [
      'scripts/seed-resilience-scores.mjs',
      'scripts/benchmark-resilience-external.mjs',
      'api/health.js',
    ] as const;

    it('every score-prefix mirror uses the canonical RESILIENCE_SCORE_CACHE_PREFIX', () => {
      for (const rel of SCORE_MIRROR_FILES) {
        const text = readFileSync(join(repoRoot, rel), 'utf-8');
        // A mirror file's single-source-of-truth invariant: it must
        // contain the canonical prefix literal. A bump that misses the
        // mirror leaves the mirror reading an abandoned Redis key.
        assert.ok(
          text.includes(RESILIENCE_SCORE_CACHE_PREFIX),
          `${rel} must contain RESILIENCE_SCORE_CACHE_PREFIX=${RESILIENCE_SCORE_CACHE_PREFIX}. Did the cache-prefix bump miss this file?`,
        );
        // Also assert the OLD prefix is NOT present — catches the
        // bump-the-constant-but-forget-the-literal pattern.
        const oldPrefixPattern = /resilience:score:v(\d+):/g;
        const matches = [...text.matchAll(oldPrefixPattern)]
          .map((m) => m[0])
          .filter((m) => m !== RESILIENCE_SCORE_CACHE_PREFIX);
        assert.equal(
          matches.length, 0,
          `${rel} has stale score-prefix literal(s): ${matches.join(', ')} — must match ${RESILIENCE_SCORE_CACHE_PREFIX}`,
        );
      }
    });

    it('every ranking-key mirror uses the canonical RESILIENCE_RANKING_CACHE_KEY', () => {
      for (const rel of RANKING_MIRROR_FILES) {
        const text = readFileSync(join(repoRoot, rel), 'utf-8');
        assert.ok(
          text.includes(RESILIENCE_RANKING_CACHE_KEY),
          `${rel} must contain RESILIENCE_RANKING_CACHE_KEY=${RESILIENCE_RANKING_CACHE_KEY}. Did the cache-prefix bump miss this file?`,
        );
        const oldRankingPattern = /resilience:ranking:v(\d+)\b/g;
        const matches = [...text.matchAll(oldRankingPattern)]
          .map((m) => m[0])
          .filter((m) => m !== RESILIENCE_RANKING_CACHE_KEY);
        // Loose match: some files reference older versions in comments
        // (seed-resilience-scores.mjs has historical notes about
        // v9/v10). Only flag non-comment lines.
        const stalePositions = [...text.matchAll(oldRankingPattern)]
          .filter((m) => m[0] !== RESILIENCE_RANKING_CACHE_KEY)
          .filter((m) => {
            // Inspect the line surrounding this match: skip if it's a
            // comment line (starts with //, *, or is inside /* */).
            const lineStart = text.lastIndexOf('\n', m.index ?? 0) + 1;
            const lineEnd = text.indexOf('\n', m.index ?? 0);
            const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
            return !/^\s*(\/\/|\*|#)/.test(line);
          });
        assert.equal(
          stalePositions.length, 0,
          `${rel} has stale ranking-key literal(s) in non-comment code: ${stalePositions.map((m) => m[0]).join(', ')} — must match ${RESILIENCE_RANKING_CACHE_KEY}`,
        );
      }
    });
  });

  // Plan 2026-04-24-003 dual-registry drift guard. `api/health.js` and
  // `api/seed-health.js` maintain INDEPENDENT registries (see
  // `feedback_two_health_endpoints_must_match`). They are NOT globally
  // identical — health.js watches keys seed-health.js doesn't, and vice
  // versa. Only the keys explicitly added by this PR are required in
  // BOTH registries; pre-existing recovery entries (fiscal-space,
  // reserve-adequacy, external-debt, import-hhi, fuel-stocks) live only
  // in api/health.js by design and are NOT asserted here.
  describe('resilience-recovery dual-registry parity (this PR only)', () => {
    const SHARED_RESILIENCE_KEYS = [
      'resilience:recovery:reexport-share',
      'resilience:recovery:sovereign-wealth',
    ] as const;

    const healthJsText = readFileSync(join(repoRoot, 'api/health.js'), 'utf-8');
    const seedHealthJsText = readFileSync(join(repoRoot, 'api/seed-health.js'), 'utf-8');

    for (const key of SHARED_RESILIENCE_KEYS) {
      it(`'${key}' is registered in api/health.js SEED_META`, () => {
        const metaKey = `seed-meta:${key}`;
        assert.ok(
          healthJsText.includes(`'${metaKey}'`) || healthJsText.includes(`"${metaKey}"`),
          `api/health.js must register '${metaKey}' in SEED_META`,
        );
      });

      it(`'${key}' is registered in api/seed-health.js SEED_DOMAINS`, () => {
        assert.ok(
          seedHealthJsText.includes(`'${key}'`) || seedHealthJsText.includes(`"${key}"`),
          `api/seed-health.js must register '${key}' in SEED_DOMAINS`,
        );
      });
    }
  });

  describe('resilienceIntervals maxStaleMin co-pinned to actual 6h writer cadence', () => {
    // Regression-locks two prior fixes:
    //
    // 1. The 2026-04-27 false-OK incident where resilienceIntervals had
    //    maxStaleMin=20160 (14d) — 168× the writer cadence. Combined
    //    with the v15→v16 cache prefix bump in PR #3452 and Upstash
    //    optimistic-OK-but-not-persisted (see PR #3458), production
    //    data was missing in Redis for 11h+ but health stayed
    //    STALE-free because seedAgeMin (671) was far under 20160.
    //
    // 2. The 2026-04-28 false-positive incident where maxStaleMin=360
    //    (= 1× the real cadence) flipped resilienceIntervals to
    //    STALE_SEED on routine cron jitter (seedAgeMin=367 vs
    //    maxStale=360) despite the bundle running cleanly on schedule.
    //    Root cause: prior fix took the in-bundle 2h section gate as
    //    the cadence baseline, but the actual Railway cron is
    //    `0 */6 * * *` (every 6h on the hour, UTC) — the 2h in-bundle
    //    gate never gets to fire because Railway only invokes the
    //    bundle every 6h.
    //
    // CADENCE BASELINE — empirically verified 2026-04-28 from Railway
    // logs (6h2min between two clean bundle runs, no skips/errors).
    // The in-bundle `intervalMs=2h` claim in
    // scripts/seed-bundle-resilience.mjs is what the section's
    // skip-gate uses, but the OUTER Railway cron schedule
    // (`0 */6 * * *`) determines how often the bundle fires at all.
    // Real cadence = 6h. 720 = 12h staleness = 2 missed cron ticks
    // (project convention: 2× cadence; matches resilienceRanking
    // immediately above, written by the SAME cron section).
    //
    // Prior values (audit trail):
    //   20160 (14d, 168× cadence) — silent during real outage.
    //   1080  (18h, 3× cadence)   — over-permissive, would mask 12h outage.
    //   360   (1×,  1× cadence)   — false-positive on routine jitter.
    //   720   (12h, 2× cadence)   — current; matches resilienceRanking.
    const healthSrc = readFileSync(join(repoRoot, 'api/health.js'), 'utf-8');
    const bundleSrc = readFileSync(join(repoRoot, 'scripts/seed-bundle-resilience.mjs'), 'utf-8');

    function extractMaxStaleMin(name: string): number {
      const re = new RegExp(`${name}:\\s*\\{[^}]*?maxStaleMin:\\s*(\\d+)`, 'ms');
      const m = healthSrc.match(re);
      if (!m) throw new Error(`could not find ${name}.maxStaleMin in health src`);
      return parseInt(m[1]!, 10);
    }

    function extractSectionGateHours(label: string): number {
      const re = new RegExp(`label:\\s*'${label}'[\\s\\S]*?intervalMs:\\s*(\\d+)\\s*\\*\\s*HOUR`, 'm');
      const m = bundleSrc.match(re);
      if (!m) throw new Error(`could not find bundle entry for ${label}`);
      return parseInt(m[1]!, 10);
    }

    it('Resilience-Scores in-bundle section gate is 2h (intervalMs in seed-bundle-resilience.mjs)', () => {
      // The in-bundle gate value is still 2h in scripts/seed-bundle-
      // resilience.mjs source — kept intact because that's what the
      // section's interval-skip logic uses. Whether the bundle's
      // OUTER cron fires often enough to make that gate matter is a
      // separate question: empirically the Railway cron is `0 */6 * *
      // *`, so the bundle fires every 6h regardless of the in-bundle
      // 2h gate (the gate never has the chance to skip — the cron
      // doesn't fire mid-window). If the bundle ever moves to a
      // sub-6h Railway schedule, this assertion stays correct; only
      // the resilienceIntervals.maxStaleMin contract below would need
      // tightening.
      assert.equal(extractSectionGateHours('Resilience-Scores'), 2);
    });

    it('resilienceIntervals.maxStaleMin is 720min (2 missed cron ticks at real 6h cadence; matches resilienceRanking)', () => {
      // Real Railway cron is `0 */6 * * *` (every 6h on the hour, UTC),
      // verified 2026-04-28 via Railway logs (6h2min between two clean
      // bundle runs, no skips/errors). Both resilienceIntervals AND
      // resilienceRanking are written by the SAME Resilience-Scores
      // section, so they share the same maxStaleMin pattern: 720min =
      // 12h staleness = 2 missed cron ticks. Prior 360 (1× cadence)
      // false-positive'd on routine jitter (2026-04-28 incident:
      // seedAgeMin=367 vs maxStale=360); see api/health.js:381 comment
      // for the prior-values trail.
      assert.equal(extractMaxStaleMin('resilienceIntervals'), 720);
    });

    it('resilienceIntervals.maxStaleMin >= 540 (no false-STALE on routine jitter at 6h cadence)', () => {
      const maxStale = extractMaxStaleMin('resilienceIntervals');
      assert.ok(
        maxStale >= 540,
        `resilienceIntervals.maxStaleMin (${maxStale}) must be >= 540 (1.5× the real 6h cadence); ` +
        `tighter values flip to STALE_SEED on routine cron jitter — see the 2026-04-28 incident ` +
        `where 360 (= 1× cadence) false-positive'd at seedAgeMin=367 vs maxStale=360.`,
      );
    });

    it('resilienceIntervals.maxStaleMin <= 1080 (still catches a real outage within ~3 missed cron ticks)', () => {
      const maxStale = extractMaxStaleMin('resilienceIntervals');
      assert.ok(
        maxStale <= 1080,
        `resilienceIntervals.maxStaleMin (${maxStale}) must be <= 1080 (3× the real 6h cadence); ` +
        `looser values mask real upstream outages from the alerting threshold — ` +
        `the 2026-04-27 incident's 14d (20160) setting hid an 11h outage. The standard ` +
        `project convention is 2× cadence (720 here, matching resilienceRanking).`,
      );
    });
  });
});
