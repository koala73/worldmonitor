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
 * Usage:
 *   node scripts/seed-ttc-alerts.mjs
 */

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { gtfsRtHeaderContentMeta, gtfsrtAdapter } from './lib/gtfsrt.mjs';

loadEnvFile(import.meta.url);

export const TTC_ALERTS_KEY = 'transit:ttc:alerts:v1';
export const TTC_GTFS_RT_ALERTS_URL = 'https://gtfsrt.ttc.ca/alerts/all?format=binary';
export const TTC_GTFS_RT_HOST = 'gtfsrt.ttc.ca';
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


async function fetchTtcAlerts() {
  const feed = await gtfsrtAdapter(TTC_GTFS_RT_ALERTS_URL, {
    allowedHosts: [TTC_GTFS_RT_HOST],
  });
  return buildTtcAlertsSnapshot(feed);
}

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
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
