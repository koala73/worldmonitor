export function postureAssessedAtIso(assessedAtValues: readonly number[]): string {
  let oldest = Number.POSITIVE_INFINITY;
  for (const value of assessedAtValues) {
    if (Number.isFinite(value) && value > 0 && value < oldest) oldest = value;
  }
  if (oldest === Number.POSITIVE_INFINITY) return new Date(0).toISOString();
  return new Date(oldest).toISOString();
}

export const POSTURE_FRESH_MS = 15 * 60 * 1000;

interface PostureTimestamp {
  timestamp: string;
  stale?: boolean;
}

/** Mark cache-fallback and SWR restores so the posture panel can warn and refetch. */
export function withPostureFreshness<T extends PostureTimestamp>(data: T, now = Date.now()): T {
  const age = now - Date.parse(data.timestamp);
  const stale = data.stale === true || !Number.isFinite(age) || age > POSTURE_FRESH_MS;
  if (stale === Boolean(data.stale)) return data;
  return { ...data, stale };
}
