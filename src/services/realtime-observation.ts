/** A provider observation must carry its own source and valid observation time. */
export interface TimedProviderObservation {
  source: string;
  observedAt: Date;
}

export interface FreshProviderObservation {
  source: string;
  observedAt: Date;
  ageMs: number;
}

/**
 * Returns only a provider-attributed observation within the requested freshness
 * window. A layer being enabled, a non-empty cache, or an undated sample is
 * not enough to call a live/readily observed state.
 */
export function latestFreshProviderObservation<T extends TimedProviderObservation>(
  observations: readonly T[],
  nowMs = Date.now(),
  freshnessMs = 5 * 60_000,
): FreshProviderObservation | null {
  if (!Number.isFinite(nowMs) || !Number.isFinite(freshnessMs) || freshnessMs < 0) return null;

  let latest: FreshProviderObservation | null = null;
  for (const observation of observations) {
    const observedAtMs = observation.observedAt instanceof Date
      ? observation.observedAt.getTime()
      : Number.NaN;
    const source = observation.source.trim();
    if (!source || !Number.isFinite(observedAtMs) || observedAtMs > nowMs) continue;
    const ageMs = nowMs - observedAtMs;
    if (ageMs > freshnessMs) continue;
    if (!latest || observedAtMs > latest.observedAt.getTime()) {
      latest = { source, observedAt: observation.observedAt, ageMs };
    }
  }
  return latest;
}
