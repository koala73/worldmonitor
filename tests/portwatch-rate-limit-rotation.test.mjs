// #8501: ArcGIS rate-limits the heavy-country rotation.
//
// The 2026-09-22T12:00Z tick attempted 30 cold fetches, got 6 through and 24
// back as HTTP-200-with-`Too many requests`, then threw
// `Incomplete PortWatch coverage; canonical retained` — exit 1, Railway
// "Deploy Crashed!", twice a day — even though all 174 countries stayed
// usable and nothing was lost. Meanwhile the 24 rate-limited countries kept
// their cacheWrittenAt and walked toward the seven-day MAX_CACHE_AGE_MS
// cliff with no scheduling priority over countries that were merely due.
//
// These tests pin the four behaviours that fix is made of:
//   1. a stalled rotation that lost no coverage is publish-blocked, not a crash;
//   2. a country approaching the hard cache expiry outranks ordinary rotation;
//   3. a batch that is mostly rate-limited trips the circuit-breaker;
//   4. rate-limit pressure widens the inter-batch backoff, and a per-country
//      retry that cannot fit its cooldown reports rate_limited, not timeout.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PUBLISH_BLOCKED_EXIT_CODE } from '../scripts/_seed-utils.mjs';
import * as portwatchSeed from '../scripts/seed-portwatch-port-activity.mjs';
import {
  orderColdFetchQueue,
  PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES,
  PORTWATCH_EXPIRY_PRIORITY_LEAD_MINUTES,
  PORTWATCH_MAX_CACHE_AGE_MS,
} from '../scripts/_portwatch-content-freshness.mjs';

const seederSrc = readFileSync(
  fileURLToPath(new URL('../scripts/seed-portwatch-port-activity.mjs', import.meta.url)),
  'utf-8',
);

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-22T12:00:00Z');

// ── 1. rotation-incomplete is not a crash ────────────────────────────────────
describe('publication block classification (#8501)', () => {
  const { classifyPublicationBlock } = portwatchSeed;

  // The exact shape of the 12:00Z tick: every country still usable and
  // published, 24 of them carrying a persisted rate_limited refresh failure.
  const stalledRotation = {
    countryCount: 174,
    referenceCountryCount: 174,
    upstreamContactCount: 6,
    coverage: {
      complete: true,
      target: 174,
      refreshFailures: Array.from({ length: 24 }, (_, i) => ({
        iso2: `X${i}`,
        code: 'rate_limited',
      })),
    },
  };

  it('is exported', () => {
    assert.equal(typeof classifyPublicationBlock, 'function');
  });

  it('returns null for a run that may advance the canonical list', () => {
    assert.equal(classifyPublicationBlock({
      ...stalledRotation,
      coverage: { ...stalledRotation.coverage, refreshFailures: [] },
    }), null);
  });

  it('classifies a full-coverage, refresh-failed run as a publish block, not a crash', () => {
    const block = classifyPublicationBlock(stalledRotation);
    assert.equal(block?.kind, 'rotation_incomplete');
    assert.equal(block.exitCode, PUBLISH_BLOCKED_EXIT_CODE);
    assert.match(block.reason, /24/);
  });

  it('keeps a hard failure when a country actually fell out of coverage', () => {
    const block = classifyPublicationBlock({
      ...stalledRotation,
      countryCount: 173,
      coverage: { ...stalledRotation.coverage, complete: false },
    });
    assert.equal(block?.kind, 'coverage_shortfall');
    assert.equal(block.exitCode, 1);
  });

  it('keeps a hard failure when the run made no upstream contact at all', () => {
    const block = classifyPublicationBlock({ ...stalledRotation, upstreamContactCount: 0 });
    assert.equal(block?.kind, 'coverage_shortfall');
  });

  it('keeps a hard failure when the reference feed itself came back short', () => {
    const block = classifyPublicationBlock({ ...stalledRotation, referenceCountryCount: 153 });
    assert.equal(block?.kind, 'coverage_shortfall');
  });

  it('wires the soft block to an exit code the bundle runner does not call a crash', () => {
    assert.match(seederSrc, /publishBlocked:\s*true/,
      'main() must return the publish-blocked outcome instead of throwing');
    assert.match(seederSrc, /process\.exit\(PUBLISH_BLOCKED_EXIT_CODE\)/,
      'the isMain wrapper must translate that outcome into exit 76');
  });
});

// ── 2. the expiring tail outranks ordinary rotation ──────────────────────────
describe('cold-fetch priority for the expiring tail (#8501)', () => {
  const lead = PORTWATCH_EXPIRY_PRIORITY_LEAD_MINUTES * 60_000;

  function item(iso2, { cacheWrittenAt, refreshAttemptedAt }) {
    return { iso2, iso3: `${iso2}X`, prevPayload: { iso2, cacheWrittenAt, refreshAttemptedAt } };
  }

  it('derives a lead of at least one full nominal rotation', () => {
    const runsPerSweep = Math.ceil(
      portwatchSeed.PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES / portwatchSeed.MAX_COLD_FETCH_PER_RUN,
    );
    const sweepMinutes = runsPerSweep * PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES;
    assert.ok(
      PORTWATCH_EXPIRY_PRIORITY_LEAD_MINUTES >= sweepMinutes,
      `lead ${PORTWATCH_EXPIRY_PRIORITY_LEAD_MINUTES}min must cover one ${sweepMinutes}min sweep`,
    );
    assert.ok(lead < PORTWATCH_MAX_CACHE_AGE_MS,
      'the priority window must be a tail of the cache lifetime, not all of it');
  });

  it('puts a country near the hard cache expiry ahead of a merely-due one', () => {
    // MY was rate-limited on every recent run, so oldest-attempt-first sorts
    // it last — exactly the ordering that walked it toward the cliff.
    const nearCliff = item('MY', {
      cacheWrittenAt: NOW - (PORTWATCH_MAX_CACHE_AGE_MS - lead + 1),
      refreshAttemptedAt: NOW - 1_000,
    });
    const merelyDue = item('ZA', {
      cacheWrittenAt: NOW - 3 * DAY,
      refreshAttemptedAt: NOW - 30 * DAY,
    });
    const ordered = orderColdFetchQueue([merelyDue, nearCliff], undefined, { now: NOW })
      .map((entry) => entry.iso2);
    assert.deepEqual(ordered, ['MY', 'ZA']);
  });

  it('orders the expiring cohort closest-to-the-cliff first', () => {
    const cohort = [
      item('BR', { cacheWrittenAt: NOW - (PORTWATCH_MAX_CACHE_AGE_MS - lead + 1), refreshAttemptedAt: NOW }),
      item('CM', { cacheWrittenAt: NOW - (PORTWATCH_MAX_CACHE_AGE_MS - 3_600_000), refreshAttemptedAt: NOW }),
      item('IT', { cacheWrittenAt: NOW - (PORTWATCH_MAX_CACHE_AGE_MS - 2 * 3_600_000), refreshAttemptedAt: NOW }),
    ];
    const ordered = orderColdFetchQueue(cohort, undefined, { now: NOW }).map((entry) => entry.iso2);
    assert.deepEqual(ordered, ['CM', 'IT', 'BR']);
  });

  it('still lets the decision-critical countries lead the queue', () => {
    const ordered = orderColdFetchQueue([
      item('MY', { cacheWrittenAt: NOW - (PORTWATCH_MAX_CACHE_AGE_MS - 3_600_000), refreshAttemptedAt: NOW }),
      item('CN', { cacheWrittenAt: NOW - DAY, refreshAttemptedAt: NOW }),
    ], undefined, { now: NOW }).map((entry) => entry.iso2);
    assert.deepEqual(ordered, ['CN', 'MY']);
  });

  it('does not promote a payload that already passed the expiry it cannot come back from', () => {
    // Past MAX_CACHE_AGE_MS the payload is unpublishable anyway; spending a
    // scarce cold-fetch slot on it would starve a country still inside it.
    const ordered = orderColdFetchQueue([
      item('EX', { cacheWrittenAt: NOW - (PORTWATCH_MAX_CACHE_AGE_MS + DAY), refreshAttemptedAt: NOW }),
      item('SV', { cacheWrittenAt: NOW - (PORTWATCH_MAX_CACHE_AGE_MS - 3_600_000), refreshAttemptedAt: NOW }),
    ], undefined, { now: NOW }).map((entry) => entry.iso2);
    assert.deepEqual(ordered, ['SV', 'EX']);
  });
});

// ── 3. the circuit-breaker learns the rate-limit arm ─────────────────────────
describe('batch circuit-breaker classification (#8501)', () => {
  const { classifyBatchCircuitBreak } = portwatchSeed;

  it('is exported', () => {
    assert.equal(typeof classifyBatchCircuitBreak, 'function');
  });

  it('trips on a batch that is mostly rate-limited', () => {
    // The observed batch: 5 of 6 countries back with the ArcGIS 200 body.
    const errors = [
      'MYS: ArcGIS error (via proxy after HTTP 200 rate-limited): Unable to perform query. Too many requests.',
      'CHN: ArcGIS error (via proxy after HTTP 200 rate-limited): Unable to perform query. Too many requests.',
      'MEX: ArcGIS error (via proxy after HTTP 200 rate-limited): Unable to perform query. Too many requests.',
      'ITA: ArcGIS error (via proxy after HTTP 200 rate-limited): Unable to perform query. Too many requests.',
      'BRA: ArcGIS error (via proxy after HTTP 200 rate-limited): Unable to perform query. Too many requests.',
      'USA: per-country timeout after 90s (USA)',
    ];
    assert.equal(classifyBatchCircuitBreak(errors, 6)?.code, 'rate_limited');
  });

  it('still trips on the schema-regression class it was written for', () => {
    const errors = Array.from({ length: 5 },
      () => 'XYZ: Cannot perform query. Invalid query parameters.');
    assert.equal(classifyBatchCircuitBreak(errors, 5)?.code, 'invalid_query');
  });

  it('does not trip on a minority of rate-limited countries', () => {
    assert.equal(classifyBatchCircuitBreak(['A: 429 rate-limited', 'B: boom'], 6), null);
  });

  it('does not trip on a mixed bag of unrelated failures', () => {
    const errors = [
      'A: per-country timeout after 90s (A)',
      'B: empty final port list',
      'C: unverified empty activity after proxy retry',
      'D: incomplete page',
      'E: fetch failed',
    ];
    assert.equal(classifyBatchCircuitBreak(errors, 5), null);
  });
});

// ── 4. backing off harder under rate-limit pressure ──────────────────────────
describe('rate-limit backoff (#8501)', () => {
  const { rateLimitedBatchBackoffMs, retryRateLimited } = portwatchSeed;

  it('widens the inter-batch gap for each consecutive rate-limited batch', () => {
    assert.equal(typeof rateLimitedBatchBackoffMs, 'function');
    const [clean, one, two, three, four] = [0, 1, 2, 3, 4].map((n) => rateLimitedBatchBackoffMs(n));
    assert.equal(clean, 5_000, 'a clean batch keeps the baseline gap');
    assert.equal(one, 10_000);
    assert.equal(two, 20_000);
    assert.equal(three, 40_000);
    assert.equal(four, three, 'the gap is capped so a bad run still fits the bundle budget');
  });

  it('waits materially longer than one ArcGIS round trip before a country retry', async () => {
    const sleepCalls = [];
    let attempts = 0;
    await assert.rejects(retryRateLimited(async () => {
      attempts += 1;
      throw new Error('ArcGIS error: Unable to perform query. Too many requests.');
    }, { sleepFn: async (ms) => { sleepCalls.push(ms); } }), /Too many requests/);
    assert.equal(attempts, 2);
    assert.deepEqual(sleepCalls, [8_000]);
  });

  it('reports rate_limited rather than burning the per-country budget on a doomed retry', async () => {
    // The cooldown cannot fit before the 90s per-country wrap fires. Sleeping
    // anyway converts a truthful rate_limited failure into a timeout, which
    // hides the rate limiting from the circuit-breaker and the failure meta.
    const sleepCalls = [];
    let attempts = 0;
    await assert.rejects(retryRateLimited(async () => {
      attempts += 1;
      throw new Error('ArcGIS error: Unable to perform query. Too many requests.');
    }, {
      deadlineAt: Date.now() + 2_000,
      sleepFn: async (ms) => { sleepCalls.push(ms); },
    }), /Too many requests/);
    assert.equal(attempts, 1, 'no retry may start when its cooldown cannot fit');
    assert.deepEqual(sleepCalls, []);
  });

  it('still retries when the per-country budget has room for the cooldown', async () => {
    const sleepCalls = [];
    let attempts = 0;
    const result = await retryRateLimited(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ArcGIS HTTP 429 rate-limited');
      return 'recovered';
    }, {
      deadlineAt: Date.now() + 90_000,
      sleepFn: async (ms) => { sleepCalls.push(ms); },
    });
    assert.equal(result, 'recovered');
    assert.deepEqual(sleepCalls, [8_000]);
  });
});
