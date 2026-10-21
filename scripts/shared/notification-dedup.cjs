'use strict';

/**
 * Slot B dedup-material builder — the single source of truth shared by every
 * notification publisher.
 *
 * When a coalesceKey is set (an NWS VTEC family string, a market asset-family
 * key, an airport/ICAO key, ...) the dedup key is derived from it so adjacent
 * or repeated same-family events collapse to one notification. Otherwise it
 * falls back to the eventType:title hash.
 *
 * Extracted from the three previously byte-identical inline copies in
 * ais-relay.cjs, seed-aviation.mjs, and notification-relay.cjs so the
 * coalesce/fallback formula changes in one place (WM PR #4985 review, finding #2).
 *
 * @param {string} eventType         producer event type (e.g. 'market_alert')
 * @param {string|undefined} title   payload title; coerced to '' when absent
 * @param {string|undefined} coalesceKey  family key; when truthy it wins
 * @returns {string} the material to hash into the dedup key
 */
function buildDedupMaterial(eventType, title, coalesceKey) {
  return coalesceKey ? `coalesce:${coalesceKey}` : `${eventType}:${title ?? ''}`;
}

const failOpenFallbackDedup = new Map();
const MAX_FAIL_OPEN_FALLBACK_KEYS = 10_000;

/**
 * Convert an Upstash SET NX REST result into the publisher-facing dedup state.
 *
 * @param {unknown} result Upstash command result (`"OK"` for a new key, `null`
 *   for an existing key); callers may also pass the already-classified
 *   `"disabled"` token when Redis is deliberately unavailable.
 * @returns {'new'|'duplicate'|'error'|'disabled'}
 */
function classifySetNxResult(result) {
  if (result === 'OK') return 'new';
  if (result === null) return 'duplicate';
  if (result === 'disabled') return 'disabled';
  return 'error';
}

/**
 * Normalize alert severity before dedup policy decisions and telemetry. Missing
 * severity defaults to `high`, matching notification-relay's historical
 * fail-open default for alert events.
 *
 * @param {unknown} severity
 * @returns {string}
 */
function normalizeNotificationSeverity(severity) {
  return String(severity ?? 'high').trim().toLowerCase() || 'high';
}

function isHighPriorityNotificationSeverity(severity) {
  const normalized = normalizeNotificationSeverity(severity);
  return normalized === 'critical' || normalized === 'high';
}

/**
 * Decide whether a publisher should continue after the dedup SET NX result.
 *
 * New keys always publish; duplicate keys suppress; disabled Redis suppresses
 * without telemetry; SET NX errors fail open only for high/critical alerts.
 *
 * @param {'new'|'duplicate'|'error'|'disabled'} dedupResult
 * @param {unknown} severity
 * @returns {boolean}
 */
function shouldPublishAfterDedupResult(dedupResult, severity) {
  if (dedupResult === 'new') return true;
  if (dedupResult === 'duplicate') return false;
  if (dedupResult === 'error') return isHighPriorityNotificationSeverity(severity);
  return false;
}

function normalizeTelemetryToken(raw) {
  const value = String(raw ?? 'unknown').trim().toLowerCase();
  return (value || 'unknown').replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 80);
}

/**
 * Build the low-cardinality marker used by logs/Sentry/metrics for SET NX
 * failures. Do not include user IDs, titles, or dedup keys.
 *
 * @param {{surface: unknown, eventType: unknown, severity: unknown, action: unknown, reason?: unknown}} params
 * @returns {string}
 */
function buildSetNxErrorTelemetryLine({ surface, eventType, severity, action, reason = 'setnx_error' }) {
  return `[notifications] wm_notification_dedup_setnx_error ` +
    `count=1 ` +
    `surface=${normalizeTelemetryToken(surface)} ` +
    `event_type=${normalizeTelemetryToken(eventType)} ` +
    `severity=${normalizeTelemetryToken(severity)} ` +
    `action=${normalizeTelemetryToken(action)} ` +
    `reason=${normalizeTelemetryToken(reason)}`;
}

function normalizeDedupResult(result) {
  if (result === 'new' || result === 'duplicate' || result === 'error' || result === 'disabled') return result;
  if (result === true) return 'new';
  if (result === false) return 'duplicate';
  return classifySetNxResult(result);
}

function reserveFailOpenFallback(key, ttlSeconds, nowMs) {
  if (!key || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return false;
  const existing = failOpenFallbackDedup.get(key);
  if (existing && existing > nowMs) return true;

  failOpenFallbackDedup.set(key, nowMs + ttlSeconds * 1000);
  for (const [seenKey, expiresAt] of failOpenFallbackDedup) {
    if (expiresAt <= nowMs || failOpenFallbackDedup.size > MAX_FAIL_OPEN_FALLBACK_KEYS) {
      failOpenFallbackDedup.delete(seenKey);
    }
    if (failOpenFallbackDedup.size <= MAX_FAIL_OPEN_FALLBACK_KEYS) break;
  }
  return false;
}

/**
 * Centralize the side-effecting SET NX dedup policy for notification publishers.
 *
 * During transient SET NX failures, high/critical alerts fail open once per
 * dedup key and then use a bounded in-process fallback dedup for the same TTL.
 * This is not a substitute for Redis, but it prevents a hot-loop duplicate
 * storm while preserving the first critical delivery during a partial outage.
 *
 * @param {unknown} dedupResult Raw or classified SET NX result.
 * @param {{
 *   surface: unknown,
 *   eventType: unknown,
 *   severity?: unknown,
 *   fallbackKey?: string,
 *   fallbackTtlSeconds?: number,
 *   nowMs?: number,
 *   emitTelemetry?: (event: {line: string, action: string, reason: string, severity: string}) => void,
 * }} options
 * @returns {{shouldPublish: boolean, isDuplicate: boolean, dedupResult: string, action: string, severity: string}}
 */
function recordDedupOutcome(dedupResult, options) {
  const result = normalizeDedupResult(dedupResult);
  const severity = normalizeNotificationSeverity(options?.severity);
  if (result === 'new') {
    return { shouldPublish: true, isDuplicate: false, dedupResult: result, action: 'publish', severity };
  }
  if (result === 'duplicate') {
    return { shouldPublish: false, isDuplicate: true, dedupResult: result, action: 'dedup_hit', severity };
  }
  if (result === 'disabled') {
    return { shouldPublish: false, isDuplicate: false, dedupResult: result, action: 'disabled', severity };
  }

  const highPriority = isHighPriorityNotificationSeverity(severity);
  let shouldPublish = highPriority;
  let action = highPriority ? 'fail_open' : 'fail_closed';
  if (highPriority && reserveFailOpenFallback(
    options?.fallbackKey,
    Number(options?.fallbackTtlSeconds),
    Number(options?.nowMs) || Date.now(),
  )) {
    shouldPublish = false;
    action = 'fallback_suppressed';
  }
  const reason = 'setnx_error';
  const line = buildSetNxErrorTelemetryLine({
    surface: options?.surface,
    eventType: options?.eventType,
    severity,
    action,
    reason,
  });
  if (typeof options?.emitTelemetry === 'function') {
    options.emitTelemetry({ line, action, reason, severity });
  }
  return { shouldPublish, isDuplicate: action === 'fallback_suppressed', dedupResult: result, action, severity };
}

module.exports = {
  buildDedupMaterial,
  classifySetNxResult,
  normalizeNotificationSeverity,
  shouldPublishAfterDedupResult,
  buildSetNxErrorTelemetryLine,
  recordDedupOutcome,
};
