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

function classifySetNxResult(result) {
  if (result === 'OK') return 'new';
  if (result === null) return 'duplicate';
  return 'error';
}

function isHighPriorityNotificationSeverity(severity) {
  const normalized = String(severity ?? '').toLowerCase();
  return normalized === 'critical' || normalized === 'high';
}

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

function buildSetNxErrorTelemetryLine({ surface, eventType, severity, action }) {
  return `[notifications] wm_notification_dedup_setnx_error ` +
    `count=1 ` +
    `surface=${normalizeTelemetryToken(surface)} ` +
    `event_type=${normalizeTelemetryToken(eventType)} ` +
    `severity=${normalizeTelemetryToken(severity)} ` +
    `action=${normalizeTelemetryToken(action)}`;
}

module.exports = {
  buildDedupMaterial,
  classifySetNxResult,
  shouldPublishAfterDedupResult,
  buildSetNxErrorTelemetryLine,
};
