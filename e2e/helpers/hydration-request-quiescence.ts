/**
 * Quiescence wait for hydration request-budget counters (#7212).
 *
 * A fixed wall-clock sleep cannot prove the first fallback pass finished: it
 * freezes mid-cascade (false red) or after a premature baseline (false green).
 * Consecutive unchanged samples with `inflight === 0` are the signal.
 */

export const QUIESCENCE_SAMPLE_MS = 200;
export const QUIESCENCE_STABLE_SAMPLES = 3;

/** Default outer budget; matches the former fixed settle window. */
export const DEFAULT_QUIESCENCE_TIMEOUT_MS = 6_000;

export type HydrationRequestLog = {
  /** Per logical dataset: RPC hits plus public per-key bootstrap hits. */
  counts: Record<string, number>;
  tiers: string[];
  /** Route handlers currently inside their fulfill body (including delays). */
  inflight: number;
};

/** Minimal clock/sleep surface so unit tests need no Playwright Page. */
export type QuiescenceClock = {
  waitForTimeout: (ms: number) => Promise<void>;
};

export function snapshotHydrationCounts(
  log: HydrationRequestLog,
  keys: readonly string[],
): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, log.counts[key] ?? 0]));
}

export async function waitForHydrationRequestQuiescence(
  clock: QuiescenceClock,
  log: HydrationRequestLog,
  keys: readonly string[],
  options: { timeout?: number; message?: string } = {},
): Promise<Record<string, number>> {
  const timeoutMs = options.timeout ?? DEFAULT_QUIESCENCE_TIMEOUT_MS;
  const message = options.message
    ?? 'hydration request counters did not quiesce';
  const deadline = Date.now() + timeoutMs;
  let previous = snapshotHydrationCounts(log, keys);
  let stableSamples = 0;

  while (Date.now() < deadline) {
    await clock.waitForTimeout(QUIESCENCE_SAMPLE_MS);
    const current = snapshotHydrationCounts(log, keys);
    const quiet = log.inflight === 0
      && keys.every((key) => (current[key] ?? 0) === (previous[key] ?? 0));
    if (quiet) {
      stableSamples += 1;
      if (stableSamples >= QUIESCENCE_STABLE_SAMPLES) return current;
    } else {
      stableSamples = 0;
      previous = current;
    }
  }

  throw new Error(
    `${message} (inflight=${log.inflight}, lastCounts=${JSON.stringify(previous)})`,
  );
}
