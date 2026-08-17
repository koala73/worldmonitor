/**
 * Backoff for viewport-triggered panel priming (#4487 INP).
 *
 * `primeVisiblePanelData` records a panel as primed only after its loader
 * RESOLVES. A loader that rejects therefore leaves no record, and because the
 * pass is re-entered from a scroll handler's rAF, a panel whose endpoint fails
 * fast — adblocked, CORS-blocked, DNS-blocked, or a premium 403 — re-enters on
 * every subsequent scroll frame, forever. Each re-entry runs the loader body
 * synchronously up to its first await, and several panels write DOM there
 * (`showLoading` / `renderPanel`), which reinstates the read/write layout
 * thrash the viewport-read batching exists to remove.
 *
 * The in-flight guard bounds re-entry by request latency, so a SLOW failure is
 * self-limiting. A fast one is not — which is the common field case and the one
 * that never appears in a lab run with healthy endpoints.
 */

/** First retry waits this long after the initial failure. */
export const PRIME_RETRY_BASE_MS = 30_000;

/** Ceiling, so a permanently dead endpoint still retries occasionally. */
export const PRIME_RETRY_MAX_MS = 5 * 60_000;

/**
 * Delay before a failed prime may be retried, doubling per consecutive failure
 * and capped at {@link PRIME_RETRY_MAX_MS}.
 *
 * `failures` is the count INCLUDING the one that just happened, so the first
 * failure yields the base delay. Non-positive or non-finite input is treated as
 * a single failure rather than throwing — a corrupt counter must not translate
 * into an unbounded retry loop, which is the bug this exists to prevent.
 */
export function nextPrimeRetryDelayMs(failures: number): number {
  if (!Number.isFinite(failures) || failures < 1) return PRIME_RETRY_BASE_MS;
  // The exponent is capped for intent, not safety: `2 ** big` saturates to
  // Infinity rather than wrapping, so Math.min already yields the ceiling. The
  // cap just keeps the arithmetic in a range a reader can evaluate.
  const steps = Math.min(Math.floor(failures) - 1, 20);
  return Math.min(PRIME_RETRY_BASE_MS * 2 ** steps, PRIME_RETRY_MAX_MS);
}
