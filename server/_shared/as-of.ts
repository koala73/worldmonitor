export interface HistoricalObservation {
  observed_at: string;
  formulaVersion?: string;
}

export class AsOfError extends Error {
  readonly code = -32602;

  constructor(readonly data: {
    reason: 'invalid_as_of' | 'as_of_in_future' | 'before_history_start';
    historyStart?: string | null;
  }) {
    super(data.reason);
    this.name = 'AsOfError';
  }
}

function utcTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19)
    ? timestamp : NaN;
}

export function resolveAsOf<T extends HistoricalObservation>(
  observations: readonly T[],
  asOf: string,
  { granularity, now = Date.now() }: { granularity: number; now?: number },
): {
  observation: T;
  cacheAsOf: string;
  asOf: { requested: string; matchedObservedAt: string; matchOffsetSeconds: number; formulaVersion?: string };
} {
  if (!Number.isSafeInteger(granularity) || granularity <= 0 || !Number.isFinite(now)) {
    throw new RangeError('History granularity must be a positive integer in milliseconds and now must be finite');
  }
  const requestedAt = utcTimestamp(asOf);
  if (!Number.isFinite(requestedAt)) throw new AsOfError({ reason: 'invalid_as_of' });
  if (requestedAt > now) throw new AsOfError({ reason: 'as_of_in_future' });

  let earliest: T | undefined;
  let earliestAt = Infinity;
  let matched: T | undefined;
  let matchedAt = -Infinity;
  const observedTimes = new Set<number>();
  for (const observation of observations) {
    const observedAt = utcTimestamp(observation.observed_at);
    if (!Number.isFinite(observedAt)) throw new TypeError('History observation has an invalid observed_at');
    if (observedAt % granularity !== 0) throw new TypeError('History observation is not aligned with granularity');
    if (observedTimes.has(observedAt)) throw new TypeError('History observations must have unique observed_at timestamps');
    observedTimes.add(observedAt);
    if (observedAt < earliestAt) {
      earliest = observation;
      earliestAt = observedAt;
    }
    if (observedAt <= requestedAt && observedAt > matchedAt) {
      matched = observation;
      matchedAt = observedAt;
    }
  }
  if (!matched) throw new AsOfError({ reason: 'before_history_start', historyStart: earliest?.observed_at ?? null });

  return {
    observation: matched,
    cacheAsOf: new Date(Math.floor(requestedAt / granularity) * granularity).toISOString(),
    asOf: {
      requested: asOf,
      matchedObservedAt: matched.observed_at,
      matchOffsetSeconds: (requestedAt - matchedAt) / 1000,
      ...(matched.formulaVersion === undefined ? {} : { formulaVersion: matched.formulaVersion }),
    },
  };
}
