/**
 * Cross-user aggregate for client-side analytics collector health.
 *
 * A browser cannot tell whether a receiptless collector response came from a
 * privacy layer or from a collector outage. It reports only bounded counter
 * deltas here, including the compatibility-timeout numerator; Redis supplies
 * the cross-user denominator and Sentry receives a
 * single warning when one request cohort's failure rate separates from that
 * cohort's own observed baseline. No event payload, user id, URL, or browser
 * fingerprint is accepted.
 */

export const config = { runtime: 'edge' };

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { checkRateLimit } from './_rate-limit.js';
import { captureSilentError } from './_sentry-edge.js';
import { redisPipeline } from './_upstash-json.js';

const HEALTH_WINDOW_SECONDS = 60;
const HEALTH_KEY_TTL_SECONDS = 120;

/**
 * One-sided 95% z score. Every rate judgement below is made on a Wilson score
 * interval rather than on the raw quotient, because `failures / writes` carries
 * no information about how many samples produced it: 5/5 and 5000/5000 read
 * identically and are not remotely the same claim (#6026).
 */
const ALERT_CONFIDENCE_Z = 1.6448536269514722;

/**
 * Minimum writes in one window before its failure rate is allowed to decide
 * anything. Derived rather than picked, using the NORMAL (Wald) half-width at
 * the worst case p = 0.5, `z * sqrt(0.25 / n)`: n = 31 is the smallest
 * denominator that resolves the rate to within +/-0.15 (0.1477; n = 30 gives
 * 0.1502) — just enough to separate an ordinary ad-blocker baseline from a
 * collector that has stopped accepting writes. The pre-#6026 floor of 5
 * resolved it to +/-0.368, which is to say not at all.
 *
 * The formula above is deliberately NOT the Wilson half-width, even though
 * judgements below use a Wilson interval. Wilson admits n = 28 for the same
 * target, so keeping 31 is the conservative floor.
 */
const MIN_WRITES = 31;

/**
 * Absolute backstop rate. The primary gate is the comparison against this
 * cohort's own observed baseline; this floor only stops an alert on a
 * deployment whose baseline is so low that a statistically real excursion is
 * still operationally uninteresting.
 *
 * Deliberately left at the pre-#6026 value. Raising it is the one part of this
 * that needs the measured ad-block baseline, which is an operator input rather
 * than something derivable from code.
 */
const MIN_FAILURE_RATE = 0.5;

/**
 * Consecutive breached windows required before Sentry hears about it. The
 * incident evidence in #6026 shows a real outage stays breached for tens of
 * consecutive windows, so this costs at most two extra minutes of detection
 * latency — the 2026-08-01 outage was surfaced in 9 — while removing any single
 * noisy window from the alert path.
 */
const MIN_CONSECUTIVE_BREACHED_WINDOWS = 3;
const STREAK_KEY_TTL_SECONDS = HEALTH_WINDOW_SECONDS * 3;

/**
 * Same-hour-of-day baseline for a cohort's ordinary failure rate. Held for two
 * days so the previous — complete — day stays readable while the current one
 * accumulates. Keeping each UTC hour separate prevents a busy, high-blocking
 * hour from being judged against a quiet daily mean.
 */
const BASELINE_KEY_TTL_SECONDS = 172_800;
const WINDOWS_PER_DAY = 86_400 / HEALTH_WINDOW_SECONDS;
const WINDOWS_PER_HOUR = 3_600 / HEALTH_WINDOW_SECONDS;

/**
 * A baseline may only license or veto an alert once it is resolved an order of
 * magnitude better than the single window it is judging.
 */
const MIN_BASELINE_WRITES = MIN_WRITES * 20;
const MIN_BASELINE_WINDOWS = 20;

/** A baseline above this rate is not allowed to veto an outage. */
const MAX_BASELINE_FAILURE_RATE = 0.7;

const MAX_BODY_BYTES = 1_024;
const MAX_COUNTER_DELTA = 10_000;
/** Allow a delayed browser report to land in its real or one of the prior two windows. */
const MAX_HEALTH_BUCKET_LAG = 2;
const RATE_LIMIT_SCOPE = 'analytics-health';
const RATE_LIMIT_PER_MINUTE = 60;
const ALLOWED_COHORTS = new Set(['event', 'critical-event', 'identify']);
const ALLOWED_FAILURE_KINDS = new Set(['network', 'timeout', 'missing-receipt', 'none']);

function keyPrefix() {
  const environment = process.env.VERCEL_ENV || 'production';
  return `analytics:collector-health:v1:${environment}`;
}

function redisKey(bucket, cohort, suffix) {
  return `${keyPrefix()}:${bucket}:${cohort}:${suffix}`;
}

/** Spans windows, so it is deliberately not bucket-scoped. */
function streakKeyFor(cohort) {
  return `${keyPrefix()}:${cohort}:streak`;
}

function baselineKey(dayIndex, hourIndex, cohort, suffix) {
  return `${keyPrefix()}:day:${dayIndex}:hour:${hourIndex}:${cohort}:${suffix}`;
}

function baselineFinalizationKey(bucket, cohort) {
  return `${keyPrefix()}:baseline-finalized:${bucket}:${cohort}`;
}

export function dayIndexForBucket(bucket) {
  return Math.floor(bucket / WINDOWS_PER_DAY);
}

export function hourIndexForBucket(bucket) {
  return Math.floor((bucket % WINDOWS_PER_DAY) / WINDOWS_PER_HOUR);
}

function finiteCounter(value, minimum = 1) {
  return Number.isInteger(value) && value >= minimum && value <= MAX_COUNTER_DELTA;
}

export function parseCollectorHealthReport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { cohort, writes, failures, failureKind } = payload;
  const manualTimeoutWrites = payload.manualTimeoutWrites ?? 0;
  if (!ALLOWED_COHORTS.has(cohort) || !ALLOWED_FAILURE_KINDS.has(failureKind)) return null;
  if (!finiteCounter(writes) || !finiteCounter(failures, 0) || failures > writes) return null;
  if (!finiteCounter(manualTimeoutWrites, 0) || manualTimeoutWrites > writes) return null;
  if (failureKind === 'none' && failures !== 0) return null;
  if (payload.bucket !== undefined && (!Number.isSafeInteger(payload.bucket) || payload.bucket < 0)) return null;
  return payload.bucket === undefined
    ? { cohort, writes, manualTimeoutWrites, failures, failureKind }
    : { cohort, writes, manualTimeoutWrites, failures, failureKind, bucket: payload.bucket };
}

/**
 * Wilson score interval for a binomial proportion. Preferred over the normal
 * approximation because it stays inside [0, 1] and stays honest at the small
 * denominators this endpoint actually sees.
 */
export function wilsonBounds(successes, total, z = ALERT_CONFIDENCE_Z) {
  if (!(total > 0)) return { lower: 0, upper: 1 };
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return {
    lower: Math.max(0, (centre - margin) / denominator),
    upper: Math.min(1, (centre + margin) / denominator),
  };
}

/**
 * Decide whether one window's failure rate is worth an operator's attention.
 *
 * Three conjunctive conditions, short-circuited in cost order:
 *   1. the window carries enough samples to resolve a rate at all;
 *   2. the low end of its confidence interval still clears the absolute floor —
 *      a point estimate would let 3-of-5 read as "50% failing";
 *   3. that low end sits above the high end of this cohort's own baseline, so
 *      the alert fires on a *departure* from normal rather than on normal.
 *
 * (3) is skipped until a previous same-hour baseline exists and is well
 * resolved; until then (1) and (2) carry the decision, which is the pre-#6026
 * behaviour with an honest denominator.
 */
export function shouldEmitAggregateAlert(writes, failures, baseline = null) {
  if (!(writes >= MIN_WRITES)) return false;
  const observed = wilsonBounds(failures, writes).lower;
  if (observed < MIN_FAILURE_RATE) return false;
  if (!isVetoCapableBaseline(baseline)) return true;
  return observed > wilsonBounds(baseline.failures, baseline.writes).upper;
}

/**
 * A baseline can veto only while it still describes ordinary traffic. The
 * endpoint accepts bounded browser reports, so a saturated or outage-shaped
 * baseline must lose its veto instead of making the comparison unsatisfiable.
 */
function isVetoCapableBaseline(baseline) {
  if (!baseline) return false;
  return wilsonBounds(baseline.failures, baseline.writes).upper <= MAX_BASELINE_FAILURE_RATE;
}

/** A per-command Upstash error is not the same as a genuine key miss. */
function hasEntryError(entry) {
  return Boolean(entry) && Object.prototype.hasOwnProperty.call(entry, 'error');
}

function hasResult(entry) {
  return Boolean(entry)
    && !hasEntryError(entry)
    && Object.prototype.hasOwnProperty.call(entry, 'result');
}

/**
 * A completed window may train the next day's same-hour baseline only if it is
 * bounded and did not itself look like an outage. This is deliberately
 * evaluated before the window is admitted to the accumulator, so a breach
 * cannot train its own next-day veto.
 */
function isBaselineWindowEligible(writes, failures, baseline) {
  if (!(writes >= MIN_WRITES) || failures > writes) return false;
  if (wilsonBounds(failures, writes).upper > MAX_BASELINE_FAILURE_RATE) return false;
  return !baseline || !shouldEmitAggregateAlert(writes, failures, baseline);
}

function counterResult(entry) {
  if (!entry || Object.prototype.hasOwnProperty.call(entry, 'error')) return null;
  const value = typeof entry.result === 'string' ? Number(entry.result) : entry.result;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringResult(entry) {
  if (!entry || hasEntryError(entry)) return null;
  return typeof entry.result === 'string' ? entry.result : null;
}

export function readBaseline(writesEntry, failuresEntry, windowsEntry = null) {
  const writes = counterResult(writesEntry);
  const failures = counterResult(failuresEntry);
  const windows = windowsEntry === null ? MIN_BASELINE_WINDOWS : counterResult(windowsEntry);
  if (writes === null || failures === null) return null;
  if (windows === null || writes < MIN_BASELINE_WRITES || windows < MIN_BASELINE_WINDOWS || failures > writes) return null;
  return { writes, failures, windows };
}

/**
 * Advance the consecutive-breach counter for this cohort.
 *
 * The stored value is `count:bucket`, so a gap of two or more windows resets
 * the run instead of letting alternating breached/healthy windows accumulate
 * into a false streak. Re-entering the same bucket is idempotent: every isolate
 * in a window reads the same prior value and computes the same successor.
 */
export function advanceBreachStreak(raw, bucket) {
  const [rawCount, rawBucket] = typeof raw === 'string' ? raw.split(':') : [];
  const previousCount = Number(rawCount);
  const previousBucket = Number(rawBucket);
  if (
    !Number.isSafeInteger(previousCount)
    || previousCount < 1
    || !Number.isSafeInteger(previousBucket)
  ) {
    return { count: 1, bucket };
  }
  if (previousBucket === bucket) return { count: previousCount, bucket };
  if (previousBucket === bucket - 1) return { count: previousCount + 1, bucket };
  if (previousBucket > bucket) return { count: previousCount, bucket: previousBucket };
  return { count: 1, bucket };
}

/**
 * Redis evaluates this transition atomically. The JavaScript calculation is a
 * useful local prediction, while the script protects it from a newer request
 * winning between the read and the write. It also claims the per-window latch
 * in the same transaction, so neither state write can silently fail alone.
 */
const ATOMIC_BREACH_STREAK_CLAIM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local previousCount, previousBucket = string.match(raw or '', '^(%d+):(%d+)$')
local incomingCount = tonumber(ARGV[1])
local incomingBucket = tonumber(ARGV[2])
if previousBucket then
  previousCount = tonumber(previousCount)
  previousBucket = tonumber(previousBucket)
  if previousBucket > incomingBucket then
    return 'STALE:' .. tostring(previousCount)
  end
  if previousBucket == incomingBucket and previousCount > incomingCount then
    incomingCount = previousCount
  elseif previousBucket == incomingBucket - 1 and previousCount + 1 > incomingCount then
    incomingCount = previousCount + 1
  end
end
redis.call('SET', KEYS[1], tostring(incomingCount) .. ':' .. tostring(incomingBucket), 'EX', ARGV[3])
local claimed = redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[4])
if claimed == 'OK' then
  return 'CLAIMED:' .. tostring(incomingCount)
end
return 'DUPLICATE:' .. tostring(incomingCount)
`;

async function finalizeBaselineWindow(
  pipeline,
  bucket,
  cohort,
  writes,
  failures,
  baseline,
) {
  if (!(writes >= MIN_WRITES) || failures > writes) return true;

  const eligible = isBaselineWindowEligible(writes, failures, baseline);
  const marker = await pipeline([
    ['SET', baselineFinalizationKey(bucket, cohort), eligible ? '1' : '0', 'NX', 'EX', String(BASELINE_KEY_TTL_SECONDS)],
  ], 2_000);
  const markerEntry = marker?.[0];
  if (!hasResult(markerEntry)) return false;
  if (markerEntry.result !== 'OK' || !eligible) return true;

  const day = dayIndexForBucket(bucket);
  const hour = hourIndexForBucket(bucket);
  const baselineWritesKey = baselineKey(day, hour, cohort, 'writes');
  const baselineFailuresKey = baselineKey(day, hour, cohort, 'failures');
  const baselineWindowsKey = baselineKey(day, hour, cohort, 'windows');
  const writesResult = await pipeline([
    ['INCRBY', baselineWritesKey, String(writes)],
    ['INCRBY', baselineFailuresKey, String(failures)],
    ['INCRBY', baselineWindowsKey, '1'],
    ['EXPIRE', baselineWritesKey, String(BASELINE_KEY_TTL_SECONDS)],
    ['EXPIRE', baselineFailuresKey, String(BASELINE_KEY_TTL_SECONDS)],
    ['EXPIRE', baselineWindowsKey, String(BASELINE_KEY_TTL_SECONDS)],
  ], 2_500);
  return Array.isArray(writesResult)
    && writesResult.length >= 6
    && writesResult.every(hasResult);
}

export async function recordCollectorHealthAggregate(
  report,
  bucket,
  ctx,
  dependencies = { redisPipeline, captureSilentError },
) {
  const { redisPipeline: pipeline, captureSilentError: capture } = dependencies;
  const writesKey = redisKey(bucket, report.cohort, 'writes');
  const manualTimeoutWritesKey = redisKey(bucket, report.cohort, 'manual-timeout-writes');
  const failuresKey = redisKey(bucket, report.cohort, 'failures');
  const today = dayIndexForBucket(bucket);
  const hour = hourIndexForBucket(bucket);
  const streakKey = streakKeyFor(report.cohort);
  const previousBucket = bucket - 1;

  // One round trip: the current window, the completed previous window, the
  // previous day's baseline, and the breach streak.
  const results = await pipeline([
    ['INCRBY', writesKey, String(report.writes)],
    ['INCRBY', manualTimeoutWritesKey, String(report.manualTimeoutWrites ?? 0)],
    ['INCRBY', failuresKey, String(report.failures)],
    ['EXPIRE', writesKey, String(HEALTH_KEY_TTL_SECONDS)],
    ['EXPIRE', manualTimeoutWritesKey, String(HEALTH_KEY_TTL_SECONDS)],
    ['EXPIRE', failuresKey, String(HEALTH_KEY_TTL_SECONDS)],
    ['GET', writesKey],
    ['GET', manualTimeoutWritesKey],
    ['GET', failuresKey],
    ['GET', redisKey(previousBucket, report.cohort, 'writes')],
    ['GET', redisKey(previousBucket, report.cohort, 'failures')],
    ['GET', baselineKey(today - 1, hour, report.cohort, 'writes')],
    ['GET', baselineKey(today - 1, hour, report.cohort, 'failures')],
    ['GET', baselineKey(today - 1, hour, report.cohort, 'windows')],
    ['GET', streakKey],
  ], 2_500);
  if (!Array.isArray(results) || results.length < 15) return false;

  if (results.some(hasEntryError)) return false;
  const writes = counterResult(results[6]);
  const manualTimeoutWrites = counterResult(results[7]);
  const failures = counterResult(results[8]);
  if (writes === null || manualTimeoutWrites === null || failures === null) return false;
  if (manualTimeoutWrites > writes) return false;

  const baseline = readBaseline(results[11], results[12], results[13]);
  const previousWrites = counterResult(results[9]);
  const previousFailures = counterResult(results[10]);
  if (previousWrites !== null && previousFailures !== null) {
    const finalized = await finalizeBaselineWindow(
      pipeline,
      previousBucket,
      report.cohort,
      previousWrites,
      previousFailures,
      baseline,
    );
    if (!finalized) return false;
  }

  if (!shouldEmitAggregateAlert(writes, failures, baseline)) return true;

  if (hasEntryError(results[14])) return false;
  const streak = advanceBreachStreak(stringResult(results[14]), bucket);

  // The Lua transition re-reads and updates the streak atomically, rejects
  // stragglers from older buckets, and claims the once-per-window latch.
  const claim = await pipeline([
    [
      'EVAL',
      ATOMIC_BREACH_STREAK_CLAIM_SCRIPT,
      '2',
      streakKey,
      redisKey(bucket, report.cohort, 'reported'),
      String(streak.count),
      String(bucket),
      String(STREAK_KEY_TTL_SECONDS),
      String(HEALTH_KEY_TTL_SECONDS),
    ],
  ], 2_000);
  const claimEntry = claim?.[0];
  if (!hasResult(claimEntry)) return false;
  if (claimEntry.result === null) return true;
  if (typeof claimEntry.result !== 'string') return false;
  const [claimStatus, persistedCountText] = claimEntry.result.split(':');
  if (claimStatus === 'STALE' || claimStatus === 'DUPLICATE') return true;
  if (claimStatus !== 'CLAIMED') return false;
  const persistedCount = Number(persistedCountText);
  if (!Number.isSafeInteger(persistedCount)) return false;
  if (persistedCount < MIN_CONSECUTIVE_BREACHED_WINDOWS) return true;

  const observed = wilsonBounds(failures, writes);
  const baselineBounds = baseline ? wilsonBounds(baseline.failures, baseline.writes) : null;

  capture(new Error('Umami collector failure rate separated from its observed baseline'), {
    level: 'warning',
    tags: {
      component: 'analytics-collector',
      healthCohort: report.cohort,
      failureKind: report.failureKind,
    },
    fingerprint: ['analytics-collector', 'environment-noise', report.cohort],
    extra: {
      failureCount: failures,
      writeCount: writes,
      manualTimeoutWriteCount: manualTimeoutWrites,
      manualTimeoutRate: manualTimeoutWrites / writes,
      failureRate: failures / writes,
      failureRateLowerBound: observed.lower,
      baselineFailureRate: baseline ? baseline.failures / baseline.writes : null,
      baselineFailureRateUpperBound: baselineBounds ? baselineBounds.upper : null,
      baselineWriteCount: baseline ? baseline.writes : null,
      baselineWindowCount: baseline ? baseline.windows : null,
      baselineHourOfDay: hour,
      consecutiveBreachedWindows: persistedCount,
      healthWindowSeconds: HEALTH_WINDOW_SECONDS,
      minWrites: MIN_WRITES,
      minBaselineWindows: MIN_BASELINE_WINDOWS,
      minFailureRate: MIN_FAILURE_RATE,
      maxBaselineFailureRate: MAX_BASELINE_FAILURE_RATE,
    },
    ctx,
  });
  return true;
}

export default async function handler(req, ctx) {
  if (isDisallowedOrigin(req)) return new Response('Forbidden', { status: 403 });

  const cors = {
    ...getCorsHeaders(req, 'POST, OPTIONS'),
    'Cache-Control': 'no-store',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  const limited = await checkRateLimit(req, cors, {
    failClosed: true,
    ctx,
    scope: RATE_LIMIT_SCOPE,
    limit: RATE_LIMIT_PER_MINUTE,
    window: '60 s',
  });
  if (limited) return limited;

  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'Payload too large' }, 413, cors);
  }

  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return jsonResponse({ error: 'Payload too large' }, 413, cors);
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
  }

  const report = parseCollectorHealthReport(body);
  if (!report) return jsonResponse({ error: 'Invalid collector health report' }, 400, cors);

  const currentBucket = Math.floor(Date.now() / (HEALTH_WINDOW_SECONDS * 1_000));
  const bucket = report.bucket ?? currentBucket;
  if (bucket < currentBucket - MAX_HEALTH_BUCKET_LAG || bucket > currentBucket) {
    return jsonResponse({ error: 'Invalid collector health report' }, 400, cors);
  }
  const recorded = await recordCollectorHealthAggregate(report, bucket, ctx);
  if (!recorded) return jsonResponse({ error: 'Health aggregation unavailable' }, 503, cors);
  return new Response(null, { status: 204, headers: cors });
}
