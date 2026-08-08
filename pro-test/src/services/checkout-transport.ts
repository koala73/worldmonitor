/**
 * Transport for POST /api/create-checkout: idempotency key + single retry.
 *
 * WORLDMONITOR-Q4 triage: 8 of 9 "Checkout error: service_unavailable"
 * events were Cloudflare-emitted 502s (cf-ray present, CF error-page
 * HTML body) — transient origin failures on the checkout-session POST.
 * The edge handler already dedupes replays via the Idempotency-Key
 * header (api/_idempotency.ts), but the clients sent no key and never
 * retried, so each transient turned into a lost checkout attempt unless
 * the user manually re-clicked.
 *
 * Retry policy:
 *   - One key per logical call, reused across attempts — the server
 *     collapses a duplicate that raced a slow first attempt.
 *   - One retry, only for 502/503/504 or a fast network failure
 *     (fetch rejecting with e.g. TypeError before the timeout budget).
 *   - Timeout/abort rejections do NOT retry: the user already waited a
 *     full attempt budget; the caller classifies and shows retry copy.
 *   - Every attempt gets a fresh timeout signal (a shared signal would
 *     start attempt 2 with an already-spent budget).
 *
 * Kept free of Clerk/Dodo/Sentry imports so it loads under the
 * tsx --test harness (see tests/checkout-transport.test.mts).
 */

export const RETRYABLE_CHECKOUT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export const CHECKOUT_RETRY_DELAY_MS = 1_500;

export const CHECKOUT_ATTEMPT_TIMEOUT_MS = 15_000;

export interface CreateCheckoutTransportDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  delay: (ms: number) => Promise<void>;
  generateIdempotencyKey: () => string;
  createTimeoutSignal: (ms: number) => AbortSignal;
}

export interface CreateCheckoutArgs {
  url: string;
  token: string;
  payload: unknown;
}

/** Browser-default deps; split out so tests can inject deterministic ones. */
export function createDefaultCheckoutTransportDeps(): CreateCheckoutTransportDeps {
  return {
    fetch: (url, init) => globalThis.fetch(url, init),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    generateIdempotencyKey: () => crypto.randomUUID(),
    createTimeoutSignal: (ms) => AbortSignal.timeout(ms),
  };
}

function isTimeoutOrAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * POST the create-checkout payload with one idempotent retry on
 * transient failure. Resolves with whatever Response the final attempt
 * produced (including non-ok ones — status classification stays with
 * the caller); rethrows the final attempt's network/timeout error.
 */
export async function postCreateCheckout(
  deps: CreateCheckoutTransportDeps,
  args: CreateCheckoutArgs,
): Promise<Response> {
  const idempotencyKey = deps.generateIdempotencyKey();

  const attempt = (): Promise<Response> =>
    deps.fetch(args.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.token}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(args.payload),
      signal: deps.createTimeoutSignal(CHECKOUT_ATTEMPT_TIMEOUT_MS),
    });

  try {
    const resp = await attempt();
    if (!RETRYABLE_CHECKOUT_STATUSES.has(resp.status)) return resp;
  } catch (err) {
    if (isTimeoutOrAbort(err)) throw err;
    // Fast network failure — fall through to the single retry.
  }

  await deps.delay(CHECKOUT_RETRY_DELAY_MS);
  return attempt();
}
