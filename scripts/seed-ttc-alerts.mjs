#!/usr/bin/env node
/**
 * Seed TTC service alerts from the official GTFS-RT disruptions feed.
 *
 * Canonical key: transit:ttc:alerts:v1
 * seed-meta key:  seed-meta:transit:ttc-alerts — runSeed derives it from
 * (domain, resource) = ('transit', 'ttc-alerts'), so it takes a HYPHEN and is
 * NOT the canonical key with :v1 stripped. Probing the colon form watches a key
 * that is never written.
 *
 * Runs as the TTC-Alerts member of seed-bundle-canada (#6711), not as its own
 * Railway service; the bundle's five-minute cron and this member's intervalMs
 * of 5min keep the cadence the standalone cron had. No user-facing surface
 * consumes this key until a transit panel exists. Do not overload VIA or 511.
 *
 * The combined `alerts/all` feed is the primary source. TTC encodes it in one
 * pass, so a single alert its protobuf encoder chokes on turns the whole feed
 * into an HTTP 500 (2026-11-06: one streetcar alert took down `all` and
 * `streetcar` while `subway`, `bus` and `accessibility` kept serving). When
 * the combined feed fails, the seeder reads the per-mode feeds that make it up,
 * merges them, and records the modes it could not read in seed-meta
 * (`feedSource: 'per-mode'`, `missingModes`).
 *
 * Usage:
 *   node scripts/seed-ttc-alerts.mjs
 */

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { gtfsRtHeaderContentMeta, gtfsrtAdapter } from './lib/gtfsrt.mjs';

loadEnvFile(import.meta.url);

export const TTC_ALERTS_KEY = 'transit:ttc:alerts:v1';
export const TTC_GTFS_RT_ALERTS_URL = 'https://gtfsrt.ttc.ca/alerts/all?format=binary';
export const TTC_GTFS_RT_HOST = 'gtfsrt.ttc.ca';
// The per-mode feeds that together make up `alerts/all`, as listed on
// https://gtfsrt.ttc.ca/. Their union matched the combined feed's entity ids
// exactly when probed on 2026-11-07.
export const TTC_GTFS_RT_MODE_ALERT_URLS = Object.freeze({
  subway: 'https://gtfsrt.ttc.ca/alerts/subway?format=binary',
  bus: 'https://gtfsrt.ttc.ca/alerts/bus?format=binary',
  streetcar: 'https://gtfsrt.ttc.ca/alerts/streetcar?format=binary',
  accessibility: 'https://gtfsrt.ttc.ca/alerts/accessibility?format=binary',
  stops: 'https://gtfsrt.ttc.ca/alerts/stops?format=binary',
});
export const TTC_ALERTS_TTL_SECONDS = 3600;
export const TTC_ALERTS_MAX_STALE_MIN = 30;

function unixSecondsToIso(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

export function buildTtcAlertsSnapshot(feed, fetchedAt = new Date()) {
  const alerts = Array.isArray(feed?.alerts) ? feed.alerts : [];
  return {
    schemaVersion: 1,
    agency: 'ttc',
    source: 'gtfsrt',
    feedUrl: TTC_GTFS_RT_ALERTS_URL,
    feedSource: feed?.feedSource === 'per-mode' ? 'per-mode' : 'combined',
    missingModes: Array.isArray(feed?.missingModes) ? [...feed.missingModes] : [],
    fetchedAt: fetchedAt.toISOString(),
    header: {
      gtfsRealtimeVersion: feed?.header?.gtfsRealtimeVersion ?? null,
      incrementality: feed?.header?.incrementality ?? null,
      timestamp: unixSecondsToIso(feed?.header?.timestamp),
    },
    alerts: alerts.map((alert) => ({
      id: alert.id,
      headerText: alert.headerText,
      descriptionText: alert.descriptionText,
      url: alert.url,
      cause: alert.cause,
      effect: alert.effect,
      activePeriod: (alert.activePeriod || []).map((period) => ({
        start: unixSecondsToIso(period.start),
        end: unixSecondsToIso(period.end),
      })),
      informedEntities: (alert.informedEntities || []).map((entity) => ({
        agencyId: entity.agencyId ?? null,
        routeId: entity.routeId ?? null,
        stopId: entity.stopId ?? null,
        routeType: entity.routeType ?? null,
        directionId: entity.directionId ?? null,
      })),
    })),
  };
}

export function validateTtcAlertsSnapshot(snapshot) {
  return snapshot?.schemaVersion === 1
    && snapshot?.agency === 'ttc'
    && snapshot?.source === 'gtfsrt'
    && snapshot?.feedUrl === TTC_GTFS_RT_ALERTS_URL
    && typeof snapshot?.header?.gtfsRealtimeVersion === 'string'
    && snapshot.header.gtfsRealtimeVersion.trim() !== ''
    && Array.isArray(snapshot?.alerts);
}

// 18x the 5min seed-bundle-canada member interval.
export const TTC_ALERTS_MAX_CONTENT_AGE_MIN = 90;

export function declareRecords(snapshot) {
  return Array.isArray(snapshot?.alerts) ? snapshot.alerts.length : 0;
}

// Merge per-mode feeds into one combined-shaped feed. An alert that touches
// two modes appears in both feeds under the same entity id; keep the first.
// The header carries the OLDEST producer timestamp so the content clock can
// only read staler, never fresher, than the feeds actually merged. If any
// merged feed has no usable stamp the merged stamp is unknown (null), which
// the content clock reads as stale, same as a stampless combined feed.
export function mergeTtcModeFeeds(feeds) {
  const seen = new Set();
  const alerts = [];
  for (const feed of feeds) {
    for (const alert of feed?.alerts || []) {
      if (alert?.id != null) {
        if (seen.has(alert.id)) continue;
        seen.add(alert.id);
      }
      alerts.push(alert);
    }
  }
  const headers = feeds.map((feed) => feed?.header).filter(Boolean);
  const timestamps = headers
    .map((header) => header.timestamp)
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    header: {
      gtfsRealtimeVersion: headers.find((header) => header.gtfsRealtimeVersion)?.gtfsRealtimeVersion ?? null,
      incrementality: headers[0]?.incrementality ?? null,
      timestamp: timestamps.length > 0 && timestamps.length === feeds.length ? Math.min(...timestamps) : null,
    },
    alerts,
  };
}

function describeFeedError(error) {
  return error?.message || error?.code || String(error);
}

export async function fetchTtcAlertsFeed(options = {}) {
  const adapterOptions = { allowedHosts: [TTC_GTFS_RT_HOST], fetch: options.fetch };
  try {
    return await gtfsrtAdapter(TTC_GTFS_RT_ALERTS_URL, adapterOptions);
  } catch (combinedError) {
    console.warn(`  [ttc-alerts] combined feed failed (${describeFeedError(combinedError)}); reading per-mode feeds`);
    const modes = Object.keys(TTC_GTFS_RT_MODE_ALERT_URLS);
    const results = await Promise.allSettled(
      modes.map((mode) => gtfsrtAdapter(TTC_GTFS_RT_MODE_ALERT_URLS[mode], adapterOptions)),
    );
    const feeds = [];
    const missingModes = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        feeds.push(result.value);
      } else {
        missingModes.push(modes[index]);
        console.warn(`  [ttc-alerts] ${modes[index]} feed failed (${describeFeedError(result.reason)}); skipping`);
      }
    });
    // Nothing read: fail exactly as a combined-only run would.
    if (feeds.length === 0) throw combinedError;
    if (missingModes.length > 0) {
      console.warn(`  [ttc-alerts] partial publish from per-mode feeds; missing modes: ${missingModes.join(', ')}`);
    }
    return { ...mergeTtcModeFeeds(feeds), feedSource: 'per-mode', missingModes };
  }
}

async function fetchTtcAlerts() {
  return buildTtcAlertsSnapshot(await fetchTtcAlertsFeed());
}

// Surfaces a per-mode fallback in seed-meta; the combined path reports
// feedSource 'combined' with no missing modes.
export function ttcAlertsFreshnessMetaPatch(snapshot) {
  return {
    feedSource: snapshot?.feedSource === 'per-mode' ? 'per-mode' : 'combined',
    missingModes: Array.isArray(snapshot?.missingModes) ? snapshot.missingModes : [],
  };
}

if (process.argv[1]?.endsWith('seed-ttc-alerts.mjs')) {
  runSeed('transit', 'ttc-alerts', TTC_ALERTS_KEY, fetchTtcAlerts, {
    validateFn: validateTtcAlertsSnapshot,
    ttlSeconds: TTC_ALERTS_TTL_SECONDS,
    sourceVersion: 'gtfsrt-service-alerts',
    declareRecords,
    zeroIsValid: true,
    schemaVersion: 1,
    maxStaleMin: TTC_ALERTS_MAX_STALE_MIN,
    contentMeta: gtfsRtHeaderContentMeta,
    maxContentAgeMin: TTC_ALERTS_MAX_CONTENT_AGE_MIN,
    afterPublish: async (snapshot) => ({ freshnessMetaPatch: ttcAlertsFreshnessMetaPatch(snapshot) }),
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
