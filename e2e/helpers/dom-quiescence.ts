/**
 * Best-effort DOM quiescence wait for the cold-load metric probe (#7837).
 *
 * The cold-load budget is asserted at SVG map first paint, which samples the
 * pre-hydration shell, and the CI failure that opened #7837 measured 15,506 on
 * a settled page against the same 15,000 ceiling. So the settled page is
 * sampled too and RECORDED, never asserted, so CI publishes how much of that
 * ceiling the hydrated dashboard actually uses instead of leaving it unknown.
 * On CI run 34148378315 that is 10,726-10,748 post-GC renderer nodes against
 * 8,946-9,838 at first paint.
 *
 * Recorded-not-asserted is why a timeout returns `quiesced: false` rather than
 * throwing: a diagnostic that reddens a required gate whenever a loaded runner
 * is slow would be a worse flake than the one it documents.
 *
 * The signal is the #7212 shape — consecutive unchanged samples with nothing in
 * flight — not a fixed sleep. A sleep cannot separate a settled page from one
 * still mid-cascade, and the 2 s settle this replaces is exactly what let the
 * pre-#7848 measurement span 7.0k-24.7k renderer nodes on one source tree.
 * Waiting for the real signal is also what makes the settled sample the STEADIER
 * of the two: across 21 local loads its range was 182 counts, against 1,196
 * for the first-paint sample it sits beside (22 and 892 on CI run
 * 34148378315, over the 2 of 3 loads that produced a settled sample).
 *
 * Three things the quiet check deliberately compares, because two of them are
 * invisible to the third:
 *
 *   - `elementCount` — the page still growing.
 *   - `inflight` — a request open ACROSS a sample boundary.
 *   - `requestsStarted` — a monotonic total, because a request that both starts
 *     and finishes BETWEEN two 200 ms polls leaves `inflight` at 0 at every
 *     poll and is otherwise undetectable. `waitForHydrationRequestQuiescence`
 *     compares cumulative per-key counters for exactly this reason; comparing
 *     only the instantaneous gauge would be a strictly weaker signal than the
 *     helper this one mirrors.
 *
 * Known limit, deliberately not chased: `elementCount` misses text-node and
 * equal-sized subtree churn. The request counters cover the case that matters
 * here (still hydrating), and the caller gates on `wmInitialDataReady` before
 * this wait even begins.
 */

export const DOM_QUIESCENCE_SAMPLE_MS = 200;
export const DOM_QUIESCENCE_STABLE_SAMPLES = 3;
/**
 * Outer budget. With the caller gating on `wmInitialDataReady` first, the wait
 * returned in 1.2-2.0 s locally and 3.2-9.0 s on CI run 34148378315 — the
 * margin this 15 s covers is real, not theoretical. This bounds the POLL LOOP only —
 * a wedged renderer hangs inside an `elementCount` round-trip that no deadline
 * here can interrupt, so the caller additionally races the whole diagnostic
 * against its own budget.
 */
export const DEFAULT_DOM_QUIESCENCE_TIMEOUT_MS = 15_000;

/** Minimal clock/page surface so unit tests need no Playwright Page. */
export type DomQuiescenceProbe = {
  waitForTimeout: (ms: number) => Promise<void>;
  /** Live element count for the document under measurement. */
  elementCount: () => Promise<number>;
  /** Requests started but not yet finished or failed. */
  inflight: () => number;
  /** Monotonic count of requests started since the load began. */
  requestsStarted: () => number;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
};

export type DomQuiescenceResult = {
  /** False when the outer budget expired first — the sample is still taken. */
  quiesced: boolean;
  waitedMs: number;
  /** Consecutive quiet samples observed at the point the wait returned. */
  stableSamples: number;
  /** Polls performed, including the pre-loop baseline read. */
  polls: number;
  elements: number;
  inflight: number;
  requestsStarted: number;
};

export async function waitForDomQuiescence(
  probe: DomQuiescenceProbe,
  options: { timeout?: number } = {},
): Promise<DomQuiescenceResult> {
  const now = probe.now ?? Date.now;
  const timeoutMs = options.timeout ?? DEFAULT_DOM_QUIESCENCE_TIMEOUT_MS;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let previousElements = await probe.elementCount();
  let previousRequests = probe.requestsStarted();
  // Last values actually observed, so the timeout path reports the sample it
  // gave up on rather than the baseline it was comparing against.
  let latestElements = previousElements;
  let latestInflight = probe.inflight();
  let latestRequests = previousRequests;
  let stableSamples = 0;
  let polls = 1;

  while (now() < deadline) {
    await probe.waitForTimeout(DOM_QUIESCENCE_SAMPLE_MS);
    latestElements = await probe.elementCount();
    latestInflight = probe.inflight();
    latestRequests = probe.requestsStarted();
    polls += 1;
    const quiet = latestInflight === 0
      && latestElements === previousElements
      && latestRequests === previousRequests;
    if (quiet) {
      stableSamples += 1;
      if (stableSamples >= DOM_QUIESCENCE_STABLE_SAMPLES) {
        return {
          quiesced: true,
          waitedMs: now() - startedAt,
          stableSamples,
          polls,
          elements: latestElements,
          inflight: latestInflight,
          requestsStarted: latestRequests,
        };
      }
    } else {
      stableSamples = 0;
      previousElements = latestElements;
      previousRequests = latestRequests;
    }
  }

  return {
    quiesced: false,
    waitedMs: now() - startedAt,
    stableSamples,
    polls,
    elements: latestElements,
    inflight: latestInflight,
    requestsStarted: latestRequests,
  };
}
