/**
 * Cross-user aggregate for client-side analytics collector health.
 *
 * A browser cannot tell whether a receiptless collector response came from a
 * privacy layer or from a collector outage. It reports only bounded counter
 * deltas here; Redis supplies the cross-user denominator and Sentry receives a
 * single warning when one request cohort crosses the existing sample/rate
 * floors. No event payload, user id, URL, or browser fingerprint is accepted.
 */

export const config = { runtime: 'edge' };

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { checkRateLimit } from './_rate-limit.js';
import { captureSilentError } from './_sentry-edge.js';
import { redisPipeline } from './_upstash-json.js';

const HEALTH_WINDOW_SECONDS = 60;
const HEALTH_KEY_TTL_SECONDS = 120;
const MIN_WRITES = 5;
const MIN_FAILURE_RATE = 0.5;
const MAX_BODY_BYTES = 1_024;
const MAX_COUNTER_DELTA = 10_000;
const RATE_LIMIT_SCOPE = 'analytics-health';
const RATE_LIMIT_PER_MINUTE = 60;
const ALLOWED_COHORTS = new Set(['event', 'critical-event', 'identify']);
const ALLOWED_FAILURE_KINDS = new Set(['network', 'timeout', 'missing-receipt']);

function redisKey(bucket, cohort, suffix) {
  const environment = process.env.VERCEL_ENV || 'production';
  return `analytics:collector-health:v1:${environment}:${bucket}:${cohort}:${suffix}`;
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

export function shouldEmitAggregateAlert(writes, failures) {
  return writes >= MIN_WRITES && failures / writes >= MIN_FAILURE_RATE;
}

function counterResult(entry) {
  if (!entry || Object.prototype.hasOwnProperty.call(entry, 'error')) return null;
  const value = typeof entry.result === 'string' ? Number(entry.result) : entry.result;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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
  const results = await pipeline([
    ['INCRBY', writesKey, String(report.writes)],
    ['INCRBY', failuresKey, String(report.failures)],
    ['EXPIRE', writesKey, String(HEALTH_KEY_TTL_SECONDS)],
    ['EXPIRE', failuresKey, String(HEALTH_KEY_TTL_SECONDS)],
    ['GET', writesKey],
    ['GET', failuresKey],
  ], 2_500);
  if (!Array.isArray(results) || results.length < 6) return false;

  const writes = counterResult(results[4]);
  const failures = counterResult(results[5]);
  if (writes === null || failures === null || !shouldEmitAggregateAlert(writes, failures)) return true;

  // SET NX is the cross-isolate once-per-window latch. Two requests may both
  // observe the threshold, but only one wins this claim and emits Sentry.
  const claim = await pipeline([
    ['SET', redisKey(bucket, report.cohort, 'reported'), '1', 'NX', 'EX', String(HEALTH_KEY_TTL_SECONDS)],
  ], 2_000);
  const claimEntry = claim?.[0];
  if (!claimEntry || Object.prototype.hasOwnProperty.call(claimEntry, 'error')) return false;
  if (!Object.prototype.hasOwnProperty.call(claimEntry, 'result')) return false;
  if (claimEntry.result !== 'OK') return true;

  capture(new Error('Umami collector environment failures crossed aggregate floor'), {
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
      healthWindowSeconds: HEALTH_WINDOW_SECONDS,
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
