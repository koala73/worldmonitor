import type {
  ServerContext,
  ListTemporalAnomaliesRequest,
  ListTemporalAnomaliesResponse,
  TemporalAnomaly as TemporalAnomalyProto,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
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

export async function listTemporalAnomalies(
  _ctx: ServerContext,
  _req: ListTemporalAnomaliesRequest,
): Promise<ListTemporalAnomaliesResponse> {
  try {
    const cached = await getCachedJson(TEMPORAL_ANOMALIES_KEY) as AnomalySnapshot | null;
    if (cached?.computedAt) {
      const age = Date.now() - new Date(cached.computedAt).getTime();
      if (age < TEMPORAL_ANOMALIES_TTL * 1000) {
        return cached;
      }
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
      for (const [type, sourceKey] of Object.entries(COUNT_SOURCE_KEYS)) {
        const data = await getCachedJson(sourceKey) as Record<string, unknown> | null;
        if (!data) continue;

        if (type === 'news') {
          const stories = (data as { topStories?: unknown[] })?.topStories;
          counts[type] = stories?.length ?? 0;
        } else if (type === 'satellite_fires') {
          const fires = (data as { fireDetections?: unknown[] })?.fireDetections;
          counts[type] = fires?.length ?? 0;
        }
      }

      const typesWithCounts = trackedTypes.filter(t => counts[t] !== undefined);

      const baselines = await Promise.all(
        typesWithCounts.map(t =>
          getCachedJson(makeBaselineKeyV2(t, 'global', weekday, month)) as Promise<BaselineEntry | null>
        )
      );

      let writeFailures = 0;
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
        const n = prev.sampleCount + 1;
        const delta = count - prev.mean;
        const newMean = prev.mean + delta / n;
        const delta2 = count - newMean;
        const newM2 = prev.m2 + delta * delta2;

        try {
          await setCachedJson(makeBaselineKeyV2(type, 'global', weekday, month), {
            mean: newMean,
            m2: newM2,
            sampleCount: n,
            lastUpdated: now.toISOString(),
          }, BASELINE_TTL);
        } catch {
          writeFailures++;
        }
      }

      if (writeFailures > 0) {
        console.warn(`[TemporalBaseline] ${writeFailures}/${typesWithCounts.length} baseline writes failed`);
      }

      anomalies.sort((a, b) => b.zScore - a.zScore);

      const snapshot: AnomalySnapshot = {
        anomalies,
        trackedTypes,
        computedAt: now.toISOString(),
      };

      await setCachedJson(TEMPORAL_ANOMALIES_KEY, snapshot, TEMPORAL_ANOMALIES_TTL);
      return snapshot;
    }
  } catch {
    return { anomalies: [], trackedTypes: [], computedAt: '' };
  }
}
