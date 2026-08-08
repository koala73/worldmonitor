/**
 * Cross-user aggregate for client-side analytics collector health.
 *
 * A browser cannot tell whether a receiptless collector response came from a
 * privacy layer or from a collector outage. It reports only bounded counter
 * deltas here; Redis supplies the cross-user denominator and Sentry receives a
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
 * anything. Derived rather than picked: the half-width of the 95% Wilson
 * interval at the worst case p = 0.5 is `z * sqrt(0.25 / n)`, so n = 31 is the
 * smallest denominator that resolves the rate to within +/-0.15 (0.1477) — just
 * enough to separate an ordinary ad-blocker baseline from a collector that has
 * stopped accepting writes. The pre-#6026 floor of 5 resolved it to +/-0.368,
 * which is to say not at all.
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
 * Rolling per-day baseline for a cohort's ordinary failure rate. Held for two
 * days so the previous — complete — day stays readable while the current one
 * accumulates. A day-scoped key means re-arming its TTL on every write does not
 * extend the window it measures.
 */
const BASELINE_KEY_TTL_SECONDS = 172_800;
const WINDOWS_PER_DAY = 86_400 / HEALTH_WINDOW_SECONDS;

/**
 * A baseline may only license or veto an alert once it is resolved an order of
 * magnitude better than the single window it is judging.
 */
const MIN_BASELINE_WRITES = MIN_WRITES * 20;

const MAX_BODY_BYTES = 1_024;
const MAX_COUNTER_DELTA = 10_000;
const RATE_LIMIT_SCOPE = 'analytics-health';
const RATE_LIMIT_PER_MINUTE = 60;
const ALLOWED_COHORTS = new Set(['event', 'critical-event', 'identify']);
const ALLOWED_FAILURE_KINDS = new Set(['network', 'timeout', 'missing-receipt']);

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

function baselineKey(dayIndex, cohort, suffix) {
  return `${keyPrefix()}:day:${dayIndex}:${cohort}:${suffix}`;
}

export function dayIndexForBucket(bucket) {
  return Math.floor(bucket / WINDOWS_PER_DAY);
}

function finiteCounter(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_COUNTER_DELTA;
}

export function parseCollectorHealthReport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { cohort, writes, failures, failureKind } = payload;
  if (!ALLOWED_COHORTS.has(cohort) || !ALLOWED_FAILURE_KINDS.has(failureKind)) return null;
  if (!finiteCounter(writes) || !finiteCounter(failures) || failures > writes) return null;
  return { cohort, writes, failures, failureKind };
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
 * Three independent conditions, in cost order:
 *   1. the window carries enough samples to resolve a rate at all;
 *   2. the low end of its confidence interval still clears the absolute floor —
 *      a point estimate would let 3-of-5 read as "50% failing";
 *   3. that low end sits above the high end of this cohort's own baseline, so
 *      the alert fires on a *departure* from normal rather than on normal.
 *
 * (3) is skipped until a baseline day exists and is well resolved; until then
 * (1) and (2) carry the decision, which is the pre-#6026 behaviour with an
 * honest denominator.
 */
export function shouldEmitAggregateAlert(writes, failures, baseline = null) {
  if (!(writes >= MIN_WRITES)) return false;
  const observed = wilsonBounds(failures, writes).lower;
  if (observed < MIN_FAILURE_RATE) return false;
  if (!baseline) return true;
  return observed > wilsonBounds(baseline.failures, baseline.writes).upper;
}

function counterResult(entry) {
  if (!entry || Object.prototype.hasOwnProperty.call(entry, 'error')) return null;
  const value = typeof entry.result === 'string' ? Number(entry.result) : entry.result;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringResult(entry) {
  if (!entry || Object.prototype.hasOwnProperty.call(entry, 'error')) return null;
  return typeof entry.result === 'string' ? entry.result : null;
}

export function readBaseline(writesEntry, failuresEntry) {
  const writes = counterResult(writesEntry);
  const failures = counterResult(failuresEntry);
  if (writes === null || failures === null) return null;
  if (writes < MIN_BASELINE_WRITES || failures > writes) return null;
  return { writes, failures };
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
    return 1;
  }
  if (previousBucket === bucket) return previousCount;
  if (previousBucket === bucket - 1) return previousCount + 1;
  return 1;
}

export async function recordCollectorHealthAggregate(
  report,
  bucket,
  ctx,
  dependencies = { redisPipeline, captureSilentError },
) {
  const { redisPipeline: pipeline, captureSilentError: capture } = dependencies;
  const writesKey = redisKey(bucket, report.cohort, 'writes');
  const failuresKey = redisKey(bucket, report.cohort, 'failures');
  const today = dayIndexForBucket(bucket);
  const todayWritesKey = baselineKey(today, report.cohort, 'writes');
  const todayFailuresKey = baselineKey(today, report.cohort, 'failures');
  const streakKey = streakKeyFor(report.cohort);

  // One round trip: the window counters, this day's baseline accumulator, the
  // previous day's baseline, and the breach streak.
  const results = await pipeline([
    ['INCRBY', writesKey, String(report.writes)],
    ['INCRBY', failuresKey, String(report.failures)],
    ['EXPIRE', writesKey, String(HEALTH_KEY_TTL_SECONDS)],
    ['EXPIRE', failuresKey, String(HEALTH_KEY_TTL_SECONDS)],
    ['GET', writesKey],
    ['GET', failuresKey],
    ['INCRBY', todayWritesKey, String(report.writes)],
    ['INCRBY', todayFailuresKey, String(report.failures)],
    ['EXPIRE', todayWritesKey, String(BASELINE_KEY_TTL_SECONDS)],
    ['EXPIRE', todayFailuresKey, String(BASELINE_KEY_TTL_SECONDS)],
    ['GET', baselineKey(today - 1, report.cohort, 'writes')],
    ['GET', baselineKey(today - 1, report.cohort, 'failures')],
    ['GET', streakKey],
  ], 2_500);
  if (!Array.isArray(results) || results.length < 13) return false;

  const writes = counterResult(results[4]);
  const failures = counterResult(results[5]);
  if (writes === null || failures === null) return true;

  const baseline = readBaseline(results[10], results[11]);
  if (!shouldEmitAggregateAlert(writes, failures, baseline)) return true;

  const consecutiveWindows = advanceBreachStreak(stringResult(results[12]), bucket);

  // SET NX is the cross-isolate once-per-window latch. Two requests may both
  // observe the breach, but only one wins this claim and emits Sentry. The
  // streak write rides along in the same pipeline because it is idempotent
  // within a window, so it does not need to be serialized behind the latch.
  const claim = await pipeline([
    ['SET', streakKey, `${consecutiveWindows}:${bucket}`, 'EX', String(STREAK_KEY_TTL_SECONDS)],
    ['SET', redisKey(bucket, report.cohort, 'reported'), '1', 'NX', 'EX', String(HEALTH_KEY_TTL_SECONDS)],
  ], 2_000);
  const claimEntry = claim?.[1];
  if (!claimEntry || Object.prototype.hasOwnProperty.call(claimEntry, 'error')) return false;
  if (!Object.prototype.hasOwnProperty.call(claimEntry, 'result')) return false;
  if (claimEntry.result !== 'OK') return true;
  if (consecutiveWindows < MIN_CONSECUTIVE_BREACHED_WINDOWS) return true;

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
      failureRate: failures / writes,
      failureRateLowerBound: observed.lower,
      baselineFailureRate: baseline ? baseline.failures / baseline.writes : null,
      baselineFailureRateUpperBound: baselineBounds ? baselineBounds.upper : null,
      baselineWriteCount: baseline ? baseline.writes : null,
      consecutiveBreachedWindows: consecutiveWindows,
      healthWindowSeconds: HEALTH_WINDOW_SECONDS,
      minWrites: MIN_WRITES,
      minFailureRate: MIN_FAILURE_RATE,
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

  const bucket = Math.floor(Date.now() / (HEALTH_WINDOW_SECONDS * 1_000));
  const recorded = await recordCollectorHealthAggregate(report, bucket, ctx);
  if (!recorded) return jsonResponse({ error: 'Health aggregation unavailable' }, 503, cors);
  return new Response(null, { status: 204, headers: cors });
}
