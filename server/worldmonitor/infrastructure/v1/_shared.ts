declare const process: { env: Record<string, string | undefined> };

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 10_000;

// Temporal baseline constants
export const BASELINE_TTL = 7776000; // 90 days in seconds
export const MIN_SAMPLES = 10;
export const Z_THRESHOLD_LOW = 1.5;
export const Z_THRESHOLD_MEDIUM = 2.0;
export const Z_THRESHOLD_HIGH = 3.0;

export const VALID_BASELINE_TYPES = [
  'military_flights', 'vessels', 'protests', 'news', 'ais_gaps', 'satellite_fires',
];

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

export function getBaselineSeverity(zScore: number): string {
  if (zScore >= Z_THRESHOLD_HIGH) return 'critical';
  if (zScore >= Z_THRESHOLD_MEDIUM) return 'high';
  if (zScore >= Z_THRESHOLD_LOW) return 'medium';
  return 'normal';
}

// ========================================================================
// Upstash Redis MGET helper (edge-compatible)
// getCachedJson / setCachedJson are imported from ../../../_shared/redis.ts
// ========================================================================

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
    return (data.result || []).map(v => v ? JSON.parse(v) : null);
  } catch {
    return keys.map(() => null);
  }
}
