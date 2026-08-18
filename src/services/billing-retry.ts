/**
 * The client half of the retryable billing-verification contract (#5622).
 *
 * The server marks an entitlement lookup it could not complete as RETRYABLE:
 * HTTP 503 + `Retry-After` + `X-Billing-Verification: <code>` (built in one
 * place by `classifyBillingVerification` in
 * server/_shared/entitlement-check.ts, documented in docs/usage-errors.mdx).
 * That contract is inert unless a client actually honors it.
 *
 * This module is the single client-side decision point, mirroring the server's
 * own "one classifier, many renderers" shape. It was extracted from
 * `notification-channels.ts` when the premium RPC surface needed the same
 * decision (#6483): the gateway 503s EVERY tier-gated path on an unverifiable
 * entitlement, so the settings wizard was never the only caller that could see
 * one — it was just the only one that coped.
 *
 * The DECISION half (`billingVerificationRetryDelayMs`,
 * `readBillingVerificationCode`) is pure and transport-free, because "how do I
 * re-issue this request" differs per surface: `notification-channels.ts` must
 * re-derive its token and re-assert its account before replaying an
 * authenticated POST, so it drives the decision itself.
 *
 * `withBillingVerificationRetry` adds the one re-send shape that is NOT
 * surface-specific — replaying a request verbatim — so the fetch patches can
 * honor the contract without each restating the decision. It lives here rather
 * than beside them because a second copy of "which codes are retryable" is
 * exactly the drift this module exists to prevent.
 */

/**
 * The `code`s the server marks RETRYABLE on a 503.
 *
 * An allowlist, not "any 503", and that is the whole point. Endpoints also
 * answer 503 for a missing Convex/relay env and for relay failures that happen
 * AFTER a mutation may have partially landed — blind-retrying a POST on those
 * risks a duplicate write. A billing-verification denial is emitted by the gate
 * BEFORE the handler runs, so retrying it is side-effect-free.
 *
 * `subscription_lapsed` is absent on purpose: it is a 403 and terminal.
 */
const RETRYABLE_BILLING_CODES = new Set([
  'entitlement_verification_unavailable',
  'renewal_verification_pending',
  'renewal_verification_failed',
]);

/** Used when the server omitted Retry-After; matches the server's own default. */
const DEFAULT_BILLING_RETRY_AFTER_SECONDS = 5;

/**
 * Longest delay worth waiting out inline. The server clamps Retry-After to
 * 1-60s; a user sitting in front of the page will not wait a minute, so a
 * longer hint means "surface the failure now" rather than "retry early".
 *
 * This threshold is not arbitrary — it lands between the delays the three
 * retryable states actually ask for (convex/payments/billing.ts):
 *
 *   entitlement_verification_unavailable  fixed 5s      -> retried
 *   renewal_verification_pending          1-3s, from
 *                                         the 2s Dodo
 *                                         re-check window -> retried
 *   renewal_verification_failed           up to 60s, the
 *                                         per-subscription
 *                                         failure cooldown -> NOT retried
 *
 * Declining the third is the correct outcome, not a shortfall: that cooldown
 * exists to stop re-querying Dodo, so a retry inside it is answered from the
 * same cooled-down state. Waiting it out inline would block for a minute to
 * arrive at the same denial.
 *
 * Retrying EARLIER than the server asked is deliberately not an option either:
 * it violates the Retry-After contract and, because the server negative-caches
 * a transient answer for a few seconds
 * (UNAVAILABLE_NEGATIVE_CACHE_TTL_MS in server/_shared/entitlement-check.ts),
 * an early retry would deterministically be served the same cached failure.
 */
export const BILLING_RETRY_MAX_DELAY_MS = 10_000;

/**
 * How long to wait before the single retry, or null when this response must not
 * be retried. Pure — the wire decision, testable without a network.
 */
export function billingVerificationRetryDelayMs(input: {
  status: number;
  code: string | null;
  retryAfterHeader: string | null;
}): number | null {
  if (input.status !== 503) return null;
  if (!input.code || !RETRYABLE_BILLING_CODES.has(input.code)) return null;

  const parsed = Number(input.retryAfterHeader);
  const seconds = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BILLING_RETRY_AFTER_SECONDS;
  const delayMs = Math.ceil(seconds * 1_000);
  return delayMs > BILLING_RETRY_MAX_DELAY_MS ? null : delayMs;
}

/**
 * The denial code, header-first with a body fallback.
 *
 * `X-Billing-Verification` is now in Access-Control-Expose-Headers (#5622), but
 * the dashboard's same-origin calls are not the only consumers — the Tauri shell
 * and widget embeds are cross-origin, and an intermediary can strip a header.
 * The body's `code` mirrors it, read off a CLONE so the caller's response stream
 * is untouched whether or not we end up retrying.
 */
export async function readBillingVerificationCode(res: Response): Promise<string | null> {
  const header = res.headers.get('X-Billing-Verification');
  if (header) return header;
  try {
    const body = await res.clone().json() as { code?: unknown };
    return typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verbatim replay (#6483 follow-up)
// ---------------------------------------------------------------------------

/**
 * Whether this call can be re-issued verbatim.
 *
 * A `Request` owns a body stream the first attempt may already have consumed,
 * and a stream/blob `init.body` is single-use for the same reason. Everything
 * the generated RPC clients send is a URL string plus a string body (or no body
 * at all), so the common path is replayable; anything else declines the retry
 * rather than risk a truncated second request.
 */
export function isResendable(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (typeof Request !== 'undefined' && input instanceof Request) return false;
  const body = init?.body;
  if (body === undefined || body === null) return true;
  return typeof body === 'string' || body instanceof URLSearchParams;
}

/**
 * Waits out the server's Retry-After. Rejects if `signal` aborts first, so a
 * caller that gave up is never kept waiting on our behalf.
 */
export function sleepBeforeRetry(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wraps a dispatch function so ONE bounded retry absorbs a retryable
 * billing-verification 503.
 *
 * It sits at the `window.fetch` patch rather than in `premiumFetch` for
 * DEFENCE IN DEPTH, and it is worth being precise about why, because the
 * obvious-sounding reason is wrong.
 *
 * The server's contract is genuinely route-agnostic — the legacy-Pro-bearer
 * gate (server/gateway.ts:1467) resolves `getEntitlements()` for ANY
 * authenticated request and can 503 a route in neither ENDPOINT_ENTITLEMENTS
 * nor PREMIUM_RPC_PATHS. But that does NOT mean the browser sees such routes.
 * Over the 30 days to 2026-08-12, `billing_verification_503` hit 12 routes /
 * 31 events, and they split cleanly by caller:
 *
 *   clerk_jwt (browser)     24 events, 7 routes — ALL in PREMIUM_RPC_PATHS
 *   user_api_key (server)    7 events, 5 routes — never load browser code
 *
 * So every route a browser can hit this way is already a premium path, and
 * correct `premiumFetch` wiring alone would cover all 24. The 7 server-to-server
 * events are unreachable from any client change; those consumers have to honour
 * `Retry-After` themselves (docs/usage-errors.mdx), and at least one measurably
 * does not — list-ucdp-events retried 3x in 1.7s on 2026-07-27, every attempt
 * landing inside the 3s negative cache and therefore guaranteed to fail.
 *
 * The reason to put it here anyway is that "correct premiumFetch wiring" is not
 * enforceable today: scripts/enforce-premium-fetch.mjs matches `varName.method()`
 * and is blind to the accessor pattern (`getClient().method()`), which is how
 * resilience.ts shipped two premium paths on a bare `globalThis.fetch`. At this
 * layer a future mis-wiring costs Sentry visibility but never the retry itself.
 *
 * Exactly one layer may own this. `premiumFetch` deliberately no longer
 * retries: it calls `globalThis.fetch`, which IS this wrapper once the patch is
 * installed, so keeping a second retry there would double the bound to two
 * attempts and ~10s of inline waiting. It still reports the FINAL response to
 * Sentry, so an absorbed transient produces no event and a sustained outage
 * still yields exactly one per call.
 *
 * Any failure of the retry itself yields the ORIGINAL response, so the worst
 * case is exactly the pre-retry behavior: the caller sees the 503 it would
 * have seen.
 */
export function withBillingVerificationRetry(
  dispatch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  sleepImpl: (ms: number, signal: AbortSignal | null) => Promise<void> = sleepBeforeRetry,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const first = await dispatch(input, init);
    // Cheapest possible guard first: this wraps EVERY request the page makes,
    // and only a 503 can carry the contract. No body is read otherwise.
    if (first.status !== 503 || !isResendable(input, init)) return first;
    const delayMs = billingVerificationRetryDelayMs({
      status: first.status,
      code: await readBillingVerificationCode(first),
      retryAfterHeader: first.headers.get('Retry-After'),
    });
    if (delayMs === null) return first;
    try {
      await sleepImpl(delayMs, init?.signal ?? null);
      return await dispatch(input, init);
    } catch {
      return first;
    }
  };
}
