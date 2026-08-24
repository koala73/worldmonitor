import type {
  ServerContext,
  ListTemporalAnomaliesRequest,
  ListTemporalAnomaliesResponse,
  TemporalAnomaly as TemporalAnomalyProto,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { resolveFireDetectionTotalCount } from '../../../../src/services/wildfires/payload';
import {
  BASELINE_TTL,
  MIN_SAMPLES,
  Z_THRESHOLD_LOW,
  Z_THRESHOLD_MEDIUM,
  Z_THRESHOLD_HIGH,
  makeBaselineKeyV2,
  COUNT_SOURCE_KEYS,
  TEMPORAL_ANOMALIES_KEY,
  TEMPORAL_ANOMALIES_TTL,
  TEMPORAL_ANOMALIES_REBUILD_AFTER_MS,
  BASELINE_SAMPLE_INTERVAL_MS,
  BASELINE_LOCK_KEY,
  BASELINE_LOCK_TTL,
  type BaselineEntry,
} from './_shared';

interface AnomalySnapshot {
  anomalies: TemporalAnomalyProto[];
  trackedTypes: string[];
  computedAt: string;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const TYPE_LABELS: Record<string, string> = {
  news: 'News velocity',
  satellite_fires: 'Satellite fire detections',
};

function getSeverity(zScore: number): string {
  if (zScore >= Z_THRESHOLD_HIGH) return 'critical';
  if (zScore >= Z_THRESHOLD_MEDIUM) return 'high';
  if (zScore >= Z_THRESHOLD_LOW) return 'medium';
  return 'normal';
}

function formatMessage(type: string, count: number, mean: number, multiplier: number, weekday: number, month: number): string {
  const mult = multiplier < 10 ? `${multiplier.toFixed(1)}x` : `${Math.round(multiplier)}x`;
  return `${TYPE_LABELS[type] || type} ${mult} normal for ${WEEKDAY_NAMES[weekday]} (${MONTH_NAMES[month]}) — ${count} vs baseline ${Math.round(mean)}`;
}

function redisCmd(cmd: string[]): { url: string; token: string; body: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token, body: JSON.stringify(cmd) };
}

async function tryAcquireLock(): Promise<boolean> {
  const r = redisCmd(['SET', BASELINE_LOCK_KEY, '1', 'NX', 'EX', String(BASELINE_LOCK_TTL)]);
  if (!r) return false;
  try {
    const resp = await fetch(r.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json' },
      body: r.body,
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { result?: string | null };
    return data.result === 'OK';
  } catch {
    return false;
  }
}

function countSnapshotCoverage(snapshot: AnomalySnapshot): number {
  if (Array.isArray(snapshot.trackedTypes)) return snapshot.trackedTypes.length;
  if (Array.isArray(snapshot.anomalies)) return snapshot.anomalies.length;
  return 0;
}

async function writeTemporalAnomaliesSeedMeta(snapshot: AnomalySnapshot): Promise<boolean> {
  return setCachedJson('seed-meta:temporal:anomalies', {
    fetchedAt: Date.now(),
    recordCount: countSnapshotCoverage(snapshot),
  }, 604800).catch(() => false);
}

export async function listTemporalAnomalies(
  _ctx: ServerContext,
  _req: ListTemporalAnomaliesRequest,
): Promise<ListTemporalAnomaliesResponse> {
  try {
    // HOT PATH — exactly ONE Redis round trip, no writes.
    //
    // This previously re-SET the snapshot and re-stamped seed-meta on every cache
    // hit, which cost two further serial round trips on ~200k requests/day. Against
    // a single-region store those round trips dominate the response: measured p50
    // was ~3x the caller's RTT to us-east (12ms in iad1, 384ms in fra1, 1077ms in
    // hkg1). The stamp is now written only by a successful rebuild below, so it
    // reports "the data was rebuilt recently" instead of "somebody asked recently".
    const cached = await getCachedJson(TEMPORAL_ANOMALIES_KEY) as AnomalySnapshot | null;
    if (cached?.computedAt) {
      const age = Date.now() - new Date(cached.computedAt).getTime();
      if (age < TEMPORAL_ANOMALIES_REBUILD_AFTER_MS) return cached;
    }

    const lockAcquired = await tryAcquireLock();
    if (!lockAcquired) {
      if (cached) return cached;
      return { anomalies: [], trackedTypes: [], computedAt: '' };
    }

    {
      const now = new Date();
      const weekday = now.getUTCDay();
      const month = now.getUTCMonth() + 1;
      const trackedTypes = Object.keys(COUNT_SOURCE_KEYS);
      const anomalies: TemporalAnomalyProto[] = [];

      const counts: Record<string, number> = {};
      const countEntries = await Promise.all(
        Object.entries(COUNT_SOURCE_KEYS).map(async ([type, sourceKey]) => [
          type,
          await getCachedJson(sourceKey) as Record<string, unknown> | null,
        ] as const),
      );
      for (const [type, data] of countEntries) {
        if (!data) continue;

        if (type === 'news') {
          const stories = (data as { topStories?: unknown[] })?.topStories;
          counts[type] = stories?.length ?? 0;
        } else if (type === 'satellite_fires') {
          // wildfire:fires:v1 is itself capped at WILDFIRE_CANONICAL_DETECTION_LIMIT (#5866)
          // and carries the pre-cap FIRMS total in `pagination`. Counting the array instead
          // would saturate this baseline at the cap, silently flattening every fire-volume
          // anomaly above it — the z-score would read "normal" during a record fire season.
          const fires = (data as { fireDetections?: unknown[] })?.fireDetections;
          counts[type] = resolveFireDetectionTotalCount({
            fireDetections: fires ?? [],
            pagination: (data as { pagination?: { totalCount?: number } })?.pagination,
          });
        }
      }

      const typesWithCounts = trackedTypes.filter(t => counts[t] !== undefined);

      const baselines = await Promise.all(
        typesWithCounts.map(t =>
          getCachedJson(makeBaselineKeyV2(t, 'global', weekday, month)) as Promise<BaselineEntry | null>
        )
      );

      let writeFailures = 0;
      let attemptedWrites = 0;
      for (let i = 0; i < typesWithCounts.length; i++) {
        const type = typesWithCounts[i]!;
        const count = counts[type]!;
        const baseline = baselines[i];

        if (baseline && baseline.sampleCount >= MIN_SAMPLES) {
          const variance = Math.max(0, baseline.m2 / (baseline.sampleCount - 1));
          const stdDev = Math.sqrt(variance);
          const zScore = stdDev > 0 ? Math.abs((count - baseline.mean) / stdDev) : 0;

          if (zScore >= Z_THRESHOLD_LOW) {
            const multiplier = baseline.mean > 0
              ? Math.round((count / baseline.mean) * 100) / 100
              : count > 0 ? 999 : 1;

            anomalies.push({
              type,
              region: 'global',
              currentCount: count,
              expectedCount: Math.round(baseline.mean),
              zScore: Math.round(zScore * 100) / 100,
              severity: getSeverity(zScore),
              multiplier,
              message: formatMessage(type, count, baseline.mean, multiplier, weekday, month),
            });
          }
        }

        const prev: BaselineEntry = baseline || { mean: 0, m2: 0, sampleCount: 0, lastUpdated: '' };

        // The baseline's sampling interval is a STATISTICAL parameter and must not
        // ride on the cache rebuild cadence. Those two were coupled only by accident
        // (rebuild folded one sample per cycle), so shortening the rebuild interval
        // would silently triple the sample rate on a slow-moving signal — shrinking
        // the variance estimate and shifting every z-score. Sample on its own clock.
        const lastSampledAt = prev.lastUpdated ? new Date(prev.lastUpdated).getTime() : 0;
        const dueForSample = !Number.isFinite(lastSampledAt)
          || now.getTime() - lastSampledAt >= BASELINE_SAMPLE_INTERVAL_MS;
        if (!dueForSample) continue;

        const n = prev.sampleCount + 1;
        const delta = count - prev.mean;
        const newMean = prev.mean + delta / n;
        const delta2 = count - newMean;
        const newM2 = prev.m2 + delta * delta2;

        // Check the RETURN VALUE, not a thrown error: setCachedJson catches its own
        // failures and resolves false (server/_shared/redis.ts), so a try/catch here
        // never runs and a failed baseline write is invisible. Count attempts
        // separately from tracked types — the dueForSample `continue` above means
        // most rebuilds attempt none, so typesWithCounts.length is not the denominator.
        attemptedWrites++;
        const wrote = await setCachedJson(makeBaselineKeyV2(type, 'global', weekday, month), {
          mean: newMean,
          m2: newM2,
          sampleCount: n,
          lastUpdated: now.toISOString(),
        }, BASELINE_TTL);
        if (!wrote) writeFailures++;
      }

      if (writeFailures > 0) {
        console.warn(`[TemporalBaseline] ${writeFailures}/${attemptedWrites} baseline writes failed`);
      }

      anomalies.sort((a, b) => b.zScore - a.zScore);

      const snapshot: AnomalySnapshot = {
        anomalies,
        trackedTypes,
        computedAt: now.toISOString(),
      };

      const published = await setCachedJson(TEMPORAL_ANOMALIES_KEY, snapshot, TEMPORAL_ANOMALIES_TTL);
      if (published) {
        // This stamp is now the ONLY freshness producer for three health consumers.
        // A silent failure here reads as a stalled producer 45min later with nothing
        // in the logs to explain it, and the next attempt is a full rebuild cycle
        // away — so surface it with a grep-able marker rather than discarding it.
        const stamped = await writeTemporalAnomaliesSeedMeta(snapshot);
        if (!stamped) {
          console.warn(
            '[TemporalAnomalies] seed-meta stamp FAILED after a successful publish; '
            + 'health consumers will read STALE_SEED within maxStaleMin if this repeats',
          );
        }
      }
      return snapshot;
    }
  } catch {
    return { anomalies: [], trackedTypes: [], computedAt: '' };
  }
}
