/**
 * Transport for POST /api/create-checkout: idempotency key + single retry.
 *
 * WORLDMONITOR-Q4 triage: 8 of 9 "Checkout error: service_unavailable"
 * events were Cloudflare-emitted 502s (cf-ray present, CF error-page
 * HTML body) — transient origin failures on the checkout-session POST.
 * The edge handler dedupes replays via the Idempotency-Key header
 * (api/_idempotency.js), but the clients sent no key and never retried, so
 * each transient turned into a lost checkout attempt unless the user manually
 * re-clicked.
 *
 * That dedupe is best-effort, not a guarantee: every Upstash failure arm
 * returns `kind: 'disabled'` and the route proceeds unguarded, so a retry
 * during a Redis outage can create a second provider checkout session. It is
 * not a double charge — the buyer only ever navigates to the last returned
 * `checkout_url` — but the exposure correlates with exactly the origin
 * brownouts the 52x statuses below describe.
 *
 * Retry policy:
 *   - One key per logical call, reused across attempts — the server
 *     collapses a duplicate that raced a slow first attempt.
 *   - One retry, only for a status in RETRYABLE_CHECKOUT_STATUSES (the
 *     gateway trio plus Cloudflare 520-525) or a fast network failure
 *     (fetch rejecting with e.g. TypeError before the timeout budget).
 *   - Timeout/abort rejections do NOT retry: the user already waited a
 *     full attempt budget; the caller classifies and shows retry copy.
 *   - Every attempt gets a fresh timeout signal (a shared signal would
 *     start attempt 2 with an already-spent budget).
 *
 * Kept free of Clerk/Dodo/Sentry imports so it loads under the
 * tsx --test harness (see tests/checkout-transport.test.mts).
 */

import { createTimeoutSignal as abortTimeoutSignal } from './timeout-signal';

/**
 * Statuses that mean the edge never got an application response out of our
 * origin, so a second attempt can still produce a checkout session.
 *
 * The gateway trio is the standard spelling. Cloudflare answers the same
 * condition with its own 52x family, and shipping only 502/503/504 left that
 * half unretried: the WORLDMONITOR-Q4 event on 2026-09-12 was a bare 520 on
 * POST /api/create-checkout, classified `service_unavailable` for the user and
 * then handed straight back with no second attempt.
 *
 * 520-523 and 525 describe an origin Cloudflare could not reach, could not
 * complete a handshake with, or that answered unintelligibly — transient by
 * nature. Three neighbours are deliberately absent:
 *   - 524 (origin response timeout) fires at Cloudflare's 100s deadline, and
 *     CHECKOUT_ATTEMPT_TIMEOUT_MS aborts this client ~85s earlier, so it can
 *     never reach the browser on this route. Listing it would advertise
 *     coverage of slow-origin checkouts that the client abort still drops.
 *     522 is kept but is the same shape at a ~15s deadline: expect it rarely.
 *   - 526 (invalid origin certificate) and 530 (wrapped origin DNS / Worker
 *     error) are standing misconfigurations that no 1.5s retry clears, so the
 *     user sees the failure copy immediately instead of after a dead wait.
 *
 * Application 5xx stays out too: our own relay emits a JSON envelope on 500,
 * and replaying that only doubles the provider call.
 */
export const RETRYABLE_CHECKOUT_STATUSES: ReadonlySet<number> = new Set([
  502, 503, 504,
  520, 521, 522, 523, 525,
]);

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
    createTimeoutSignal: (ms) => abortTimeoutSignal(ms),
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
