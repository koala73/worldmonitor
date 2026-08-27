import filterParamContracts from '../../../../shared/openapi-filter-param-contracts.json';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 10_000;

// Temporal baseline constants
export const BASELINE_TTL = 7776000; // 90 days in seconds
export const MIN_SAMPLES = 10;
export {
  Z_THRESHOLD_LOW,
  Z_THRESHOLD_MEDIUM,
  Z_THRESHOLD_HIGH,
  getBaselineSeverity,
} from '../../../../shared/analysis-temporal-severity';

export const VALID_BASELINE_TYPES = filterParamContracts.infrastructureTemporalBaselineTypes;

// ========================================================================
// Temporal baseline helpers
// ========================================================================

export interface BaselineEntry {
  mean: number;
  m2: number;
  sampleCount: number;
  lastUpdated: string;
}

export function makeBaselineKey(type: string, region: string, weekday: number, month: number): string {
  return `baseline:${type}:${region}:${weekday}:${month}`;
}

export function makeBaselineKeyV2(type: string, region: string, weekday: number, month: number): string {
  return `baseline:v2:${type}:${region}:${weekday}:${month}`;
}

export const COUNT_SOURCE_KEYS: Record<string, string> = {
  news: 'news:insights:v1',
  satellite_fires: 'wildfire:fires:v1',
};

export const TEMPORAL_ANOMALIES_KEY = 'temporal:anomalies:v1';

/**
 * Redis key lifetime. Deliberately LONGER than the rebuild threshold below so an
 * expired-but-usable snapshot survives as the stale fallback: when the snapshot is
 * due for rebuild, whichever request loses the lock race still returns this cached
 * body rather than an empty result.
 */
export const TEMPORAL_ANOMALIES_TTL = 3600;

/**
 * How old a snapshot may get before the next request rebuilds it.
 *
 * This also sets the cadence of `seed-meta:temporal:anomalies`, because the stamp is
 * written ONLY on a successful rebuild — it means "the data was rebuilt recently",
 * not "somebody requested this recently". Health consumers watch that key at
 * maxStaleMin: 45, so this must stay comfortably below 45 minutes or the monitor
 * false-alarms on a single missed cycle. At 20 minutes the alarm has ~2.25x margin
 * and never sits on the refresh period.
 *
 * Changing this without moving those consumers' maxStaleMin is a monitoring change,
 * not just a caching one. See tests/temporal-anomalies-cache.test.mts.
 *
 * KNOWN LIMIT — this is a rebuild clock, not a content clock. A "successful rebuild"
 * only means the reads from COUNT_SOURCE_KEYS resolved; it does not check whether
 * those upstream sources actually advanced. If news:insights:v1 or wildfire:fires:v1
 * freezes, this route keeps stamping fresh every cycle and the monitor stays green.
 * Moving the stamp off request traffic closed the larger hole (traffic alone used to
 * keep it green), but detecting a frozen UPSTREAM needs a content clock — compare the
 * sources' own timestamps, not merely the success of reading them.
 */
export const TEMPORAL_ANOMALIES_REBUILD_AFTER_MS = 20 * 60 * 1000;

/**
 * How often a rebuild folds a new sample into the `baseline:v2:*` running mean.
 *
 * Independent of the rebuild cadence on purpose. These were coupled only by
 * accident — a rebuild used to sample every time it ran — so changing the cache
 * interval silently changed the sample rate of a slow-moving signal, shrinking the
 * variance estimate and shifting every z-score. 60 minutes preserves the sampling
 * rate the baselines were accumulated at; change it only as a deliberate
 * statistical decision, never to tune caching.
 */
export const BASELINE_SAMPLE_INTERVAL_MS = 60 * 60 * 1000;
export const BASELINE_LOCK_KEY = 'baseline:lock';
export const BASELINE_LOCK_TTL = 30;


// ========================================================================
// Upstash Redis MGET helper (edge-compatible)
// getCachedJson / setCachedJson are imported from ../../../_shared/redis.ts
// ========================================================================

import { unwrapEnvelope } from '../../../_shared/seed-envelope';

export async function mgetJson(keys: string[]): Promise<(unknown | null)[]> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return keys.map(() => null);
  try {
    const resp = await fetch(`${url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['MGET', ...keys]),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return keys.map(() => null);
    const data = (await resp.json()) as { result?: (string | null)[] };
    // Envelope-aware: several of these count-source keys (wildfire:fires:v1,
    // news:insights:v1) are contract-mode canonical keys post-PR-2.
    return (data.result || []).map(v => v ? unwrapEnvelope(JSON.parse(v)).data : null);
  } catch {
    return keys.map(() => null);
  }
}
