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

  it('refuses the soft outcome when the coverage object contradicts its own complete flag', () => {
    // `complete` is derived from missingCountries/unidentifiedMissingCount. If a
    // coverage object ever arrives with complete:true and a country actually
    // missing, the soft path would exit 76 and the bundle would go green over
    // real data loss. The soft branch re-checks the evidence, not the flag.
    assert.equal(classifyPublicationBlock({
      ...stalledRotation,
      coverage: { ...stalledRotation.coverage, missingCountries: ['MY'] },
    })?.kind, 'coverage_shortfall');
    assert.equal(classifyPublicationBlock({
      ...stalledRotation,
      coverage: { ...stalledRotation.coverage, unidentifiedMissingCount: 3 },
    })?.kind, 'coverage_shortfall');
  });

  it('classifies on data loss, not on which failure class caused it', () => {
    // A schema regression that leaves every country cache-served is still a
    // lossless run: canonical retained, meta says error, the freshness monitor
    // alarms. The failure CLASS decides how the run reacts in-flight (the
    // circuit-breaker's abort/slow-down split); it does not decide whether
    // publication being blocked is a crash. Pinning this so the two concerns
    // are not conflated later.
    const block = classifyPublicationBlock({
      ...stalledRotation,
      coverage: {
        ...stalledRotation.coverage,
        refreshFailures: [
          { iso2: 'MY', code: 'rate_limited' },
          { iso2: 'CN', code: 'invalid_query' },
        ],
      },
    });
    assert.equal(block?.kind, 'rotation_incomplete');
    assert.match(block.reason, /invalid_query, rate_limited/);
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
    // The isMain wrapper never runs under test (the harness imports the
    // module), so the decision lives in a pure helper the wrapper calls.
    const { exitCodeForOutcome } = portwatchSeed;
    assert.equal(exitCodeForOutcome({ publishBlocked: true }), PUBLISH_BLOCKED_EXIT_CODE);
    assert.equal(exitCodeForOutcome(undefined), 0, 'a normal run must still exit 0');
    assert.equal(exitCodeForOutcome({}), 0);
    assert.equal(exitCodeForOutcome({ publishBlocked: false }), 0);
    // Pin the literal once: this is a process exit code an external runner
    // interprets, so sharing the constant with the runner is not enough.
    assert.equal(PUBLISH_BLOCKED_EXIT_CODE, 76);
    assert.match(seederSrc, /publishBlocked:\s*true/,
      'main() must return the publish-blocked outcome instead of throwing');
    assert.doesNotMatch(seederSrc, /process\.exit\(PUBLISH_BLOCKED_EXIT_CODE\)/,
      'process.exit would drop the buffered ROTATION INCOMPLETE diagnostic on a piped stdout');
  });

  it('refuses the soft outcome when canonical retention was not confirmed', () => {
    // publishPortActivitySnapshot rewrites every per-country key and the meta on
    // the blocked path, but only pushes CANONICAL_KEY when the canonical
    // advances — so the canonical list survives a blocked run solely on a TTL
    // extension. At TTL/cron = 3d/12h, six unconfirmed runs expire it and the
    // product surface goes dark. That must stay a crash, not a green tick.
    assert.match(seederSrc, /canonicalAtRisk/,
      'main() must disqualify the soft outcome when the canonical TTL was not confirmed');
    assert.match(seederSrc, /const canonicalAtRisk = prevIso2List !== null && !canonicalTtlExtended;/);
  });
});

// ── 2. the expiring tail outranks ordinary rotation ──────────────────────────
describe('cold-fetch priority for the expiring tail (#8501)', () => {
  const lead = PORTWATCH_EXPIRY_PRIORITY_LEAD_MINUTES * 60_000;

  function item(iso2, { cacheWrittenAt, refreshAttemptedAt }) {
    return { iso2, iso3: `${iso2}X`, prevPayload: { iso2, cacheWrittenAt, refreshAttemptedAt } };
  }

  it('derives a lead of at least one full nominal rotation', () => {
    // Divide by the ROTATION slots, not the raw cap: fetchAll reserves one slot
    // per decision-critical country every run, so the sweep is over 28, not 30.
    // Dividing by 30 here would make the assertion agree with the constant for
    // the wrong reason and go green on a lead that cannot finish a sweep.
    const rotationSlots = portwatchSeed.MAX_COLD_FETCH_PER_RUN
      - portwatchSeed.PORTWATCH_DECISION_CRITICAL_COUNTRIES.length;
    const runsPerSweep = Math.ceil(
      portwatchSeed.PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES / rotationSlots,
    );
    const sweepMinutes = runsPerSweep * PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES;
    assert.ok(
      PORTWATCH_EXPIRY_PRIORITY_LEAD_MINUTES >= sweepMinutes,
      `lead ${PORTWATCH_EXPIRY_PRIORITY_LEAD_MINUTES}min must cover one ${sweepMinutes}min sweep`,
    );
    assert.ok(lead <= PORTWATCH_MAX_CACHE_AGE_MS / 2,
      'the priority window must stay a tail of the cache lifetime; past half, most '
      + 'cached countries qualify and the tier stops prioritising anything');
  });

  it('keeps a never-cached country ahead of the expiring tier', () => {
    // #4293: a country with no usable prior payload is ALREADY out of coverage,
    // so it outranks countries that are merely close to the cliff but still
    // publishable today. The expiring tier must not demote it.
    const ordered = orderColdFetchQueue([
      item('AA', { cacheWrittenAt: NOW - (PORTWATCH_MAX_CACHE_AGE_MS - 3_600_000), refreshAttemptedAt: NOW }),
      { iso2: 'ZZ', iso3: 'ZZZ', prevPayload: null },
    ], undefined, { now: NOW }).map((entry) => entry.iso2);
    assert.deepEqual(ordered, ['ZZ', 'AA']);
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

  it('holds both edges of the priority window exactly', () => {
    // Fixtures sit ON the boundaries, so `>=` -> `>` and `<` -> `<=` both fail.
    // The far edge is the one that matters: with `<=`, a payload that has just
    // crossed MAX_CACHE_AGE_MS re-enters the tier and — being the oldest — sorts
    // to the very front, spending the scarcest slot in the run on a country
    // that is already unpublishable.
    const onNearEdge = item('NE', {
      cacheWrittenAt: NOW - (PORTWATCH_MAX_CACHE_AGE_MS - lead),
      refreshAttemptedAt: NOW,
    });
    const onFarEdge = item('FE', {
      cacheWrittenAt: NOW - PORTWATCH_MAX_CACHE_AGE_MS,
      refreshAttemptedAt: NOW,
    });
    const merelyDue = item('DD', { cacheWrittenAt: NOW - DAY, refreshAttemptedAt: NOW - 30 * DAY });

    assert.deepEqual(
      orderColdFetchQueue([merelyDue, onNearEdge], undefined, { now: NOW }).map((e) => e.iso2),
      ['NE', 'DD'],
      'a payload exactly at the window edge is inside the tier',
    );
    assert.deepEqual(
      orderColdFetchQueue([merelyDue, onFarEdge], undefined, { now: NOW }).map((e) => e.iso2),
      ['DD', 'FE'],
      'a payload exactly at the hard expiry is already unpublishable and is not promoted',
    );
  });

  it('spends the capped slots on the countries closest to the cliff', () => {
    // The tier only matters through the MAX_COLD_FETCH_PER_RUN slice, which
    // every other case in this suite is too small to reach.
    const cap = portwatchSeed.MAX_COLD_FETCH_PER_RUN;
    const expiring = Array.from({ length: 40 }, (_, i) => item(`E${String(i).padStart(2, '0')}`, {
      // E00 is closest to the cliff, E39 furthest.
      cacheWrittenAt: NOW - (PORTWATCH_MAX_CACHE_AGE_MS - 60_000 - i * 60_000),
      refreshAttemptedAt: NOW,
    }));
    const due = Array.from({ length: 140 }, (_, i) => item(`D${String(i).padStart(3, '0')}`, {
      cacheWrittenAt: NOW - 2 * DAY,
      refreshAttemptedAt: NOW - (140 - i) * 60_000,
    }));

    const ordered = orderColdFetchQueue([...due, ...expiring], undefined, { now: NOW });
    assert.equal(ordered.length, 180, 'ordering is a permutation');
    assert.equal(new Set(ordered.map((e) => e.iso2)).size, 180, 'no country is duplicated');
    assert.deepEqual(
      ordered.slice(0, cap).map((e) => e.iso2),
      expiring.slice(0, cap).map((e) => e.iso2),
      'the capped run goes to the 30 closest to the cliff, in cliff order',
    );
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

  it('measures the rate over the batch, not over the errors it collected', () => {
    // Both entries are rate-limited, so dividing by errors.length would give
    // 1.0 and trip. The batch had six countries; two failing is not a posture.
    assert.equal(
      classifyBatchCircuitBreak(['A: 429 rate-limited', 'B: 429 rate-limited'], 6),
      null,
    );
  });

  it('trips exactly at the declared rate, not above it', () => {
    // Brackets CIRCUIT_BREAKER_TRIP_RATE from both sides so lowering it — the
    // tuning edit someone makes mid-incident — cannot pass unnoticed, and so
    // `>=` cannot silently become `>`.
    const limited = (n) => Array.from({ length: n }, () => 'X: 429 rate-limited');
    assert.equal(portwatchSeed.CIRCUIT_BREAKER_TRIP_RATE, 0.8);
    assert.equal(classifyBatchCircuitBreak(limited(4), 5)?.code, 'rate_limited',
      '4 of 5 is exactly the trip rate and must trip');
    assert.equal(classifyBatchCircuitBreak(limited(3), 5), null,
      '3 of 5 is under the trip rate and must not');
  });

  it('reports the class no amount of backing off can recover when a batch carries both', () => {
    // The precedence drives the operator-facing diagnosis and the abort/slow-down
    // split. Swapping the two arms must not be free.
    const mixed = [
      ...Array.from({ length: 5 }, () => 'A: Cannot perform query. Invalid query parameters.'),
      ...Array.from({ length: 5 }, () => 'B: Unable to perform query. Too many requests.'),
    ];
    assert.equal(classifyBatchCircuitBreak(mixed, 6)?.code, 'invalid_query');
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

  // The two classes need opposite responses. Aborting on rate_limited would
  // abandon 24 of the run's 30 cold-fetch slots in the incident that motivated
  // this change (6 of 30 countries DID land), starving the expiring-tail tier
  // of exactly the slots it needs. Aborting on invalid_query is right: the
  // remaining batches would fail identically.
  it('aborts the run only for the failure class the rest of the run cannot beat', () => {
    const { circuitBreakerAction } = portwatchSeed;
    assert.equal(typeof circuitBreakerAction, 'function');
    assert.equal(circuitBreakerAction({ code: 'invalid_query', rate: 1 }), 'abort');
    assert.equal(circuitBreakerAction({ code: 'rate_limited', rate: 1 }), 'slow-down');
    assert.equal(circuitBreakerAction(null), 'continue');
  });

  it('keeps the remaining cold-fetch slots when upstream is merely throttling', () => {
    // A fully rate-limited batch 1 must not end the run: at the incident's
    // 20% success rate the abandoned batches are worth ~5x the recovery.
    const fullyThrottled = Array.from({ length: 6 },
      () => 'X: ArcGIS error: Unable to perform query. Too many requests.');
    const tripped = classifyBatchCircuitBreak(fullyThrottled, 6);
    assert.equal(tripped.code, 'rate_limited');
    assert.notEqual(portwatchSeed.circuitBreakerAction(tripped), 'abort');
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
    assert.equal(four, three, 'a single gap is capped');
  });

  it('keeps the run inside the bundle section timeout it is meant to protect', () => {
    // Derived, not hardcoded: raising PER_COUNTRY_TIMEOUT_MS, CONCURRENCY, the
    // cold-fetch cap, or lowering the bundle's section timeout must be able to
    // fail this. A section timeout is a hard bundle failure — the same Railway
    // crash this change removes — so the extra backoff a run may spend has to
    // fit the headroom the activity loop leaves.
    const sectionTimeoutMs = Number(
      readFileSync(
        fileURLToPath(new URL('../scripts/seed-bundle-portwatch-port-activity.mjs', import.meta.url)),
        'utf-8',
      ).match(/timeoutMs:\s*([\d_]+)/)[1].replace(/_/g, ''),
    );
    assert.ok(Number.isFinite(sectionTimeoutMs) && sectionTimeoutMs > 0,
      'the bundle section timeout must be readable, or this assertion proves nothing');

    const batches = Math.ceil(portwatchSeed.MAX_COLD_FETCH_PER_RUN / portwatchSeed.CONCURRENCY);
    const activityWorstCaseMs = batches * portwatchSeed.PER_COUNTRY_TIMEOUT_MS
      + (batches - 1) * 5_000;

    let spent = 0;
    const gaps = Array.from({ length: batches - 1 }, (_, i) => {
      const delay = rateLimitedBatchBackoffMs(i + 1, { spentExtraMs: spent });
      spent += delay - 5_000;
      return delay;
    });
    assert.ok(gaps.every((gap) => gap >= 5_000), 'a gap never drops below the baseline');
    assert.ok(
      activityWorstCaseMs + spent < sectionTimeoutMs,
      `activity worst case ${activityWorstCaseMs}ms + ${spent}ms of backoff must fit ${sectionTimeoutMs}ms`,
    );
  });

  it('leaves room for the batch it admits and the publication after it', () => {
    // The dispatch deadline admits a batch when now + PER_COUNTRY_TIMEOUT_MS is
    // still inside it, so the admitted batch can run a full wrap AFTER the
    // deadline, and the Redis publication runs after that. A deadline that
    // ignores either term overruns the section timeout — a hard bundle failure,
    // the exact crash this change removes. 480s did exactly that.
    const src = readFileSync(
      fileURLToPath(new URL('../scripts/seed-portwatch-port-activity.mjs', import.meta.url)),
      'utf-8',
    );
    const dispatchDeadlineMs = Number(
      src.match(/RUN_DISPATCH_DEADLINE_MS = ([\d_]+)/)[1].replace(/_/g, ''),
    );
    const redisTimeoutMs = 30_000; // AbortSignal.timeout in redisPipeline / publish
    const sectionTimeoutMs = Number(
      readFileSync(
        fileURLToPath(new URL('../scripts/seed-bundle-portwatch-port-activity.mjs', import.meta.url)),
        'utf-8',
      ).match(/timeoutMs:\s*([\d_]+)/)[1].replace(/_/g, ''),
    );
    assert.ok(
      dispatchDeadlineMs + portwatchSeed.PER_COUNTRY_TIMEOUT_MS + redisTimeoutMs < sectionTimeoutMs,
      `a batch admitted at the ${dispatchDeadlineMs}ms deadline runs to `
      + `${dispatchDeadlineMs + portwatchSeed.PER_COUNTRY_TIMEOUT_MS}ms and must still publish `
      + `within ${sectionTimeoutMs}ms`,
    );
  });

  it('falls back to the baseline gap once the run budget is exhausted', () => {
    assert.equal(rateLimitedBatchBackoffMs(3, { spentExtraMs: 60_000 }), 5_000);
    assert.equal(rateLimitedBatchBackoffMs(3, { spentExtraMs: 999_999 }), 5_000);
  });

  it('yields to the wall clock, not just the static budget', () => {
    // The static budget alone is not a safety argument: the 540s section
    // timeout also covers the snapshot read, schema introspection, the
    // un-wrapped paginated reference fetch, the 174-country preflight, and the
    // ~176-key publication. So the gap is additionally clamped by the room
    // actually left in the run, net of the next batch's per-country wrap.
    assert.equal(rateLimitedBatchBackoffMs(3, { availableMs: 12_000 }), 17_000);
    assert.equal(rateLimitedBatchBackoffMs(3, { availableMs: 0 }), 5_000,
      'no room left means the baseline gap, never a widened one');
    assert.equal(rateLimitedBatchBackoffMs(3, { availableMs: -50_000 }), 5_000,
      'an already-overrun run must not go backwards');
    assert.equal(rateLimitedBatchBackoffMs(3, {}), 40_000,
      'no deadline supplied leaves the static budget in charge');
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

  it('declines when the cooldown fits but the attempt after it does not', async () => {
    // Makes RATE_LIMIT_RETRY_MIN_ATTEMPT_MS load-bearing: 8s of cooldown fits
    // inside 20s, but the attempt it would start cannot finish. Dropping the
    // minAttempt term (or the delay term) from the guard's sum reinstates
    // exactly the bug it exists to prevent — a retry killed mid-flight by the
    // per-country wrap and recorded as `timeout` instead of `rate_limited`.
    const sleepCalls = [];
    let attempts = 0;
    await assert.rejects(retryRateLimited(async () => {
      attempts += 1;
      throw new Error('ArcGIS error: Unable to perform query. Too many requests.');
    }, {
      deadlineAt: Date.now() + 20_000,
      sleepFn: async (ms) => { sleepCalls.push(ms); },
    }), /Too many requests/);
    assert.equal(attempts, 1);
    assert.deepEqual(sleepCalls, []);
  });

  it('carries the deadline from the per-country wrap into the retry guard', async () => {
    // Proves the production wiring, not just the helper: dropping `deadlineAt`
    // from fetchCountryActivityWithRecovery's retryRateLimited options makes
    // the guard inert in the only place it runs.
    let attempts = 0;
    const sleepCalls = [];
    await assert.rejects(portwatchSeed.fetchCountryActivityWithRecovery('MYS', {
      deadlineAt: Date.now() + 2_000,
      anchorEpochMs: NOW,
      dateField: 'date',
      preflightObservation: { status: 'observed', maxDate: '2026-09-09' },
      fetchAccumFn: async () => {
        attempts += 1;
        throw new Error('ArcGIS error: Unable to perform query. Too many requests.');
      },
      sleepFn: async (ms) => { sleepCalls.push(ms); },
    }), /Too many requests/);
    assert.equal(attempts, 1, 'the doomed cooldown must not be started');
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
