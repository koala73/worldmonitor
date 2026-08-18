/** Shared materialized union for the province-owned canadaAlerts feeds. */

import {
  extendExistingTtl,
  readSeedSnapshot,
  writeExtraKey,
  writeFreshnessMetadataSafely,
} from '../_seed-utils.mjs';

export const CANADA_ALERTS_KEY = 'alerts:canada:v1';
export const CANADA_ALERTS_LEGACY_KEY = 'alerts:alberta-aea:v1';
export const CANADA_ALERTS_TTL_SECONDS = 5_400;
export const CANADA_ALERTS_SOURCE_VERSION = 'canada-provincial-alerts-v1';
export const CANADA_ALERTS_MAX_PUBLISHED = 200;

export const CANADA_ALERT_SOURCES = Object.freeze([
  Object.freeze({
    province: 'AB',
    key: 'alerts:canada:alberta-aea:v1',
    metaKey: 'seed-meta:alerts:alberta-aea',
    maxStaleMin: 45,
  }),
  Object.freeze({
    province: 'BC',
    key: 'alerts:canada:bc-evacuation:v1',
    metaKey: 'seed-meta:alerts:bc-emergency-info',
    maxStaleMin: 45,
  }),
  Object.freeze({
    province: 'SK',
    key: 'alerts:canada:saskalert:v1',
    metaKey: 'seed-meta:alerts:saskalert',
    maxStaleMin: 45,
  }),
]);

const SEVERITY_RANK = Object.freeze({ Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 });

export function buildCanadaAlertsUnion(inputs, nowMs = Date.now()) {
  const alerts = [];
  const seen = new Set();
  const missingSources = [];
  const staleSources = [];
  const degradedSources = [];

  for (const { source, snapshot, meta } of inputs) {
    const validSnapshot = snapshot != null
      && typeof snapshot === 'object'
      && Array.isArray(snapshot.alerts);
    if (!validSnapshot || !Number.isFinite(meta?.fetchedAt)) {
      missingSources.push(source.province);
    } else if (nowMs - meta.fetchedAt > source.maxStaleMin * 60_000) {
      staleSources.push(source.province);
    } else if (typeof meta.sourceState === 'string' && meta.sourceState !== 'ok') {
      degradedSources.push(source.province);
    }

    if (!validSnapshot) continue;
    for (const alert of snapshot.alerts) {
      if (!alert || alert.province !== source.province || !alert.id) continue;
      const identity = `${source.province}:${alert.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      alerts.push(alert);
    }
  }

  alerts.sort((a, b) => (
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
    || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  ));
  if (alerts.length > CANADA_ALERTS_MAX_PUBLISHED) {
    alerts.length = CANADA_ALERTS_MAX_PUBLISHED;
  }
  const degraded = missingSources.length > 0 || staleSources.length > 0 || degradedSources.length > 0;
  return {
    alerts,
    missingSources,
    staleSources,
    degradedSources,
    sourceState: degraded ? 'degraded' : 'ok',
    errorCode: missingSources.length > 0
      ? 'CANADA_ALERT_SOURCE_MISSING'
      : staleSources.length > 0
        ? 'CANADA_ALERT_SOURCE_STALE'
        : degradedSources.length > 0
          ? 'CANADA_ALERT_SOURCE_DEGRADED'
        : undefined,
  };
}

export async function rebuildCanadaAlertsUnion({
  nowMs = Date.now(),
  currentSource,
  readSnapshot = readSeedSnapshot,
  writeKey = writeExtraKey,
  writeMeta = writeFreshnessMetadataSafely,
  extendTtl = extendExistingTtl,
} = {}) {
  const inputs = await Promise.all(CANADA_ALERT_SOURCES.map(async (source) => {
    if (currentSource?.province === source.province) {
      return {
        source,
        snapshot: currentSource.snapshot,
        meta: { fetchedAt: nowMs, sourceState: 'ok', ...(currentSource.metaPatch || {}) },
      };
    }
    const [snapshot, meta] = await Promise.all([
      readSnapshot(source.key, { strict: true }),
      readSnapshot(source.metaKey, { strict: true }),
    ]);
    return { source, snapshot, meta };
  }));

  const result = buildCanadaAlertsUnion(inputs, nowMs);
  const hasPeerGap = result.missingSources.length > 0 || result.staleSources.length > 0;
  let preserved = false;
  let publishedCount = result.alerts.length;

  if (hasPeerGap) {
    const existing = await readSnapshot(CANADA_ALERTS_KEY, { strict: true });
    const existingAlerts = existing != null
      && typeof existing === 'object'
      && Array.isArray(existing.alerts)
      ? existing.alerts
      : [];
    if (existingAlerts.length > 0) {
      const extended = await extendTtl([CANADA_ALERTS_KEY], CANADA_ALERTS_TTL_SECONDS);
      if (extended === true) {
        preserved = true;
        publishedCount = existingAlerts.length;
      }
    }
  }

  if (!preserved) {
    await writeKey(
      CANADA_ALERTS_KEY,
      { alerts: result.alerts },
      CANADA_ALERTS_TTL_SECONDS,
      {
        fetchedAt: nowMs,
        recordCount: publishedCount,
        sourceVersion: CANADA_ALERTS_SOURCE_VERSION,
        schemaVersion: 1,
        state: publishedCount > 0 ? 'OK' : 'OK_ZERO',
      },
    );
  }

  await writeMeta(
    'alerts',
    'canada-union',
    publishedCount,
    CANADA_ALERTS_SOURCE_VERSION,
    CANADA_ALERTS_TTL_SECONDS,
    undefined,
    undefined,
    {
      sourceState: result.sourceState,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      missingSources: result.missingSources,
      staleSources: result.staleSources,
      degradedSources: result.degradedSources,
      ...(preserved ? { preserved: true } : {}),
    },
  );
  return { ...result, preserved };
}
