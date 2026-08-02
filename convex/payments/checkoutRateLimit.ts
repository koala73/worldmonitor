export const CHECKOUT_RATE_LIMITED = "CHECKOUT_RATE_LIMITED";
export const CHECKOUT_RETRY_AFTER_SECONDS = 10;

export interface CheckoutRateLimitedOutcome {
  checkoutFailed: true;
  code: typeof CHECKOUT_RATE_LIMITED;
  retryAfterSeconds: number;
}

/**
 * Classify a provider failure as a rate limit. Primary signal is the typed
 * SDK error's HTTP status (the direct REST client in lib/dodo.ts throws
 * APIError with `status: 429`); the message regex is kept as a belt for
 * wrapped/stringified shapes (e.g. the retired component path's
 * "Failed to create checkout session: 429 status code (no body)").
 */
export function checkoutRateLimitedOutcomeFromError(
  error: unknown,
): CheckoutRateLimitedOutcome | null {
  const rateLimited: CheckoutRateLimitedOutcome = {
    checkoutFailed: true,
    code: CHECKOUT_RATE_LIMITED,
    retryAfterSeconds: CHECKOUT_RETRY_AFTER_SECONDS,
  };
  if ((error as { status?: unknown } | null)?.status === 429) {
    return rateLimited;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!/\b429\b.*(?:status code|too many requests|rate limit)/i.test(message)) {
    return null;
  }
  return rateLimited;
}

/**
 * Extract the provider's advertised wait from a typed SDK error, when present.
 * Returns milliseconds, or null when no parseable Retry-After is advertised.
 * Callers must cap it — a verbatim honor can be minutes (see billing.ts
 * renewal reconciliation, which pins maxRetries: 0 for the same reason).
 */
export function retryAfterMsFromError(error: unknown): number | null {
  const headers = (error as { headers?: unknown } | null)?.headers;
  if (
    typeof headers !== "object" ||
    headers === null ||
    typeof (headers as Headers).get !== "function"
  ) {
    return null;
  }
  const get = (name: string) => (headers as Headers).get(name);
  const ms = Number.parseFloat(get("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const seconds = Number.parseFloat(get("retry-after") ?? "");
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return null;
}

/**
 * Bounded retry ladder for provider 429s inside the checkout action (#6027).
 *
 * Dodo's limit is keyed to our API key (one DODO_API_KEY shared by every
 * user), so a client-side retry re-enters the same shared bucket with no new
 * information — the server-side action is the right place to absorb a
 * transient limit. The provider seam (lib/dodo.ts) pins the SDK to
 * maxRetries: 0 with a per-attempt timeout, so this ladder is the ONLY retry
 * layer and each attempt is individually bounded.
 */
export const CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_500];

/** Total provider attempts the ladder may make (1 initial + one per delay). */
export const CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS =
  1 + CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS.length;

/**
 * Wall-clock budget for the whole ladder, measured from ladder entry. The
 * edge gateway aborts its Convex fetch at 15s (api/create-checkout.ts) and
 * converts the abort to a 502, which the client transport
 * (checkout-transport.ts) retries exactly once — client-side timeouts
 * themselves are NOT retried. So a ladder that outlives this budget doesn't
 * dedupe anything; it just burns user-perceived latency and keeps issuing
 * orphaned provider calls (possibly alongside the client's one 502 retry)
 * against the already-limited shared key. Once the next wait plus the following
 * attempt's timeout would cross the deadline, bail to the typed outcome instead.
 */
export const CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS = 8_000;

/**
 * Object seam (not bare functions) so tests can vi.spyOn the properties —
 * compressing the ladder to zero wall-clock, scripting the deadline, or
 * pinning jitter — while every other code path stays real.
 */
export const checkoutRetryClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

export interface CheckoutRateLimitRetryOptions {
  /** Maximum wall-clock duration of the provider attempt admitted after a wait. */
  attemptTimeoutMs: number;
  onRetry?: (delayMs: number) => void;
}

type CheckoutAttemptResult<T> =
  | { value: T }
  | { rateLimited: CheckoutRateLimitedOutcome; retryAfterMs: number | null };

/** Single source for the absorb-vs-rethrow decision on a provider failure. */
async function attemptCheckoutOnce<T>(
  attempt: () => Promise<T>,
): Promise<CheckoutAttemptResult<T>> {
  try {
    return { value: await attempt() };
  } catch (err) {
    const outcome = checkoutRateLimitedOutcomeFromError(err);
    if (!outcome) throw err;
    return { rateLimited: outcome, retryAfterMs: retryAfterMsFromError(err) };
  }
}

/**
 * Run the provider checkout call, absorbing 429s with the bounded ladder.
 * Returns the successful provider result, or the typed rate-limited outcome
 * once the ladder — attempts or time budget — is exhausted. Any non-429
 * failure rethrows immediately: a retry there could duplicate work the
 * provider may have already accepted, and the existing error channel
 * (ConvexError) already covers it.
 *
 * Wait per retry: jitter the ladder step +/-25% so concurrent checkouts on the
 * shared key don't re-collide in lockstep, then apply any advertised
 * Retry-After as a hard provider floor. A retry is admitted only when both its
 * wait and the following provider attempt's maximum timeout fit in the budget.
 */
export async function runCheckoutWithRateLimitRetry<T>(
  attempt: () => Promise<T>,
  options: CheckoutRateLimitRetryOptions,
): Promise<T | CheckoutRateLimitedOutcome> {
  const deadline = checkoutRetryClock.now() + CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS;
  let result = await attemptCheckoutOnce(attempt);
  for (const delayMs of CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS) {
    if ("value" in result) break;
    const jitteredDelayMs = Math.round(
      delayMs * (0.75 + checkoutRetryClock.random() * 0.5),
    );
    const providerFloorMs = Math.ceil(result.retryAfterMs ?? 0);
    const waitMs = Math.max(jitteredDelayMs, providerFloorMs);
    if (
      checkoutRetryClock.now() + waitMs + options.attemptTimeoutMs > deadline
    ) {
      break;
    }
    options.onRetry?.(waitMs);
    await checkoutRetryClock.sleep(waitMs);
    // Timers can wake late under event-loop pressure. Re-check the real clock
    // after sleeping so an overshoot cannot admit an attempt that no longer
    // fits inside the wall-clock budget.
    if (checkoutRetryClock.now() + options.attemptTimeoutMs > deadline) break;
    result = await attemptCheckoutOnce(attempt);
  }
  return "value" in result ? result.value : result.rateLimited;
}

export function isCheckoutRateLimitedOutcome(
  value: unknown,
): value is CheckoutRateLimitedOutcome {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CheckoutRateLimitedOutcome>;
  return (
    candidate.checkoutFailed === true &&
    candidate.code === CHECKOUT_RATE_LIMITED &&
    candidate.retryAfterSeconds === CHECKOUT_RETRY_AFTER_SECONDS
  );
}
