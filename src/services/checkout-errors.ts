/**
 * Primitive B — client-side checkout error taxonomy.
 *
 * Maps HTTP status + body shape (and thrown exceptions) to a small
 * typed set of error codes with stable user-facing copy. Raw server
 * messages from the edge/Convex relay are NEVER rendered to the user
 * — they're included in the Sentry `extra` block for engineers and
 * kept off screens where they could disclose internal state or leak
 * implementation detail.
 *
 * Exported as a separate pure module (no SDK imports) so:
 *   - Tests can exercise the classifier without a browser env.
 *   - PR-7 (duplicate-subscription dialog) reuses the same codes + copy.
 *   - Future caller additions can't drift into ad-hoc user-visible text.
 */

export type CheckoutErrorCode =
  | 'unauthorized'
  | 'session_expired'
  | 'duplicate_subscription'
  | 'invalid_product'
  | 'service_unavailable'
  | 'unknown';

export interface CheckoutError {
  code: CheckoutErrorCode;
  userMessage: string;
  /** Raw server response — Sentry only; do NOT display. */
  serverMessage?: string;
  /** HTTP status, if the error came from an HTTP response. */
  httpStatus?: number;
  retryable: boolean;
}

const USER_COPY: Record<CheckoutErrorCode, string> = {
  unauthorized: 'Please sign in to continue your purchase.',
  session_expired: 'Your session expired. Sign in again to continue.',
  duplicate_subscription: "You already have an active subscription. Let's open the billing portal instead.",
  invalid_product: "That product isn't available. Please refresh and try again.",
  service_unavailable: 'Checkout is temporarily unavailable. Please try again in a moment.',
  unknown: "Something went wrong. Please try again or contact support if it keeps happening.",
};

const RETRYABLE: Record<CheckoutErrorCode, boolean> = {
  unauthorized: true,        // after sign-in
  session_expired: true,     // after sign-in
  duplicate_subscription: false,
  invalid_product: false,
  service_unavailable: true,
  unknown: true,
};

const ACTIVE_SUBSCRIPTION_EXISTS = 'ACTIVE_SUBSCRIPTION_EXISTS';

/** Body shape we've observed from `/api/create-checkout` failures. */
export interface CheckoutErrorBody {
  error?: string;
  message?: string;
  code?: string;
}

function pickUserMessage(code: CheckoutErrorCode): string {
  return USER_COPY[code];
}

function extractServerMessage(body: CheckoutErrorBody | undefined): string | undefined {
  if (!body) return undefined;
  if (typeof body.message === 'string' && body.message.length > 0) return body.message;
  if (typeof body.error === 'string' && body.error.length > 0) return body.error;
  return undefined;
}

function statusToCode(status: number, body: CheckoutErrorBody | undefined): CheckoutErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 409 && body?.error === ACTIVE_SUBSCRIPTION_EXISTS) return 'duplicate_subscription';
  // 403 from /api/create-checkout is infrastructure (Vercel firewall / WAF / edge
  // bot-protection) — neither the edge gateway nor the Convex relay handler
  // ever emits 403 on this route. Treat as retryable service unavailability so
  // the user gets accurate copy instead of the misleading "That product isn't
  // available" they'd see under the generic 4xx → invalid_product branch.
  if (status === 403) return 'service_unavailable';
  if (status >= 400 && status < 500) return 'invalid_product';
  if (status >= 500 && status < 600) return 'service_unavailable';
  return 'unknown';
}

/**
 * Classify an HTTP-response failure into a CheckoutError.
 *
 * Callers that have a parsed body should pass it; otherwise pass
 * undefined. Never throws — bad input yields `{ code: 'unknown' }`.
 */
export function classifyHttpCheckoutError(
  status: number,
  body?: CheckoutErrorBody,
): CheckoutError {
  const code = statusToCode(status, body);
  return {
    code,
    userMessage: pickUserMessage(code),
    serverMessage: extractServerMessage(body),
    httpStatus: status,
    retryable: RETRYABLE[code],
  };
}

/**
 * Classify a thrown exception (network failure, abort, etc.) into a
 * CheckoutError. Everything non-HTTP is treated as service-unavailable
 * — that's the closest user-facing accurate description for the
 * common real cases (timeouts, DNS, offline, CORS preflight failures).
 */
export function classifyThrownCheckoutError(caught: unknown): CheckoutError {
  const message = caught instanceof Error ? caught.message : String(caught);
  const code: CheckoutErrorCode = 'service_unavailable';
  return {
    code,
    userMessage: pickUserMessage(code),
    serverMessage: message,
    retryable: RETRYABLE[code],
  };
}

/**
 * Classify a synthetic "no Clerk session" or "no token" condition.
 * These don't correspond to an HTTP response, but should still flow
 * through the taxonomy so the toast copy stays consistent.
 */
export function classifySyntheticCheckoutError(
  kind: 'unauthorized' | 'session_expired',
): CheckoutError {
  return {
    code: kind,
    userMessage: pickUserMessage(kind),
    retryable: RETRYABLE[kind],
  };
}

/**
 * Snapshot of upstream-emitter identity captured from a failed HTTP
 * response. Attached to the Sentry payload so a future 403/4xx event
 * carries enough information to identify whether Cloudflare, Vercel,
 * or our own app emitted it.
 *
 * Originating triage: WORLDMONITOR-RN — a 403 on /api/create-checkout
 * had no signal beyond status code because the old failure path called
 * `resp.json().catch(() => ({}))` and discarded both the response body
 * (Cloudflare 403 pages are HTML and silently became `{}`) AND the
 * response headers (cf-ray, server, x-vercel-id would have named the
 * emitter in one glance). This snapshot is the diagnostic recovery.
 */
export interface UpstreamSnapshot {
  /** Cloudflare ray identifier — presence is definitive for CF emission. */
  cfRay?: string;
  /** `server` response header — "cloudflare" / "Vercel" / etc. */
  server?: string;
  /** Vercel function/edge invocation ID — presence means Vercel saw the request. */
  vercelId?: string;
  /** Vercel cache status (HIT/MISS/STALE/BYPASS). */
  vercelCache?: string;
  /** First 200 chars of the response body (truncated). HTML 403 pages from
   *  CF/Vercel are distinctive; our own JSON errors fit comfortably. */
  bodySnippet?: string;
}

const BODY_SNIPPET_MAX = 200;

/**
 * Safely parse a response body string into a CheckoutErrorBody.
 *
 * Returns `{}` for: invalid JSON, the literal `null`, JSON arrays,
 * JSON primitives (numbers, strings, booleans). Only a plain-object
 * parse result is accepted — anything else would be a structural lie
 * if cast to CheckoutErrorBody (which is a `{ error?, message?, code? }`
 * shape) and would set traps for future consumers that don't add
 * defensive optional-chaining.
 *
 * Why this matters even though current callers are defensive: the cast
 * is an implicit contract. A future consumer writing
 * `body.message.toLowerCase()` against a server that returned `null` or
 * `[]` would crash. Returning `{}` from this helper makes the contract
 * "downstream may treat body as a plain CheckoutErrorBody-shaped object"
 * actually true at runtime. (Greptile P2 review of PR #3894.)
 */
export function parseCheckoutErrorBody(rawText: string): CheckoutErrorBody {
  if (rawText.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as CheckoutErrorBody;
}

/**
 * Build an UpstreamSnapshot from a fetch Response (already-read text body
 * is passed in because Response bodies are single-use; the caller must
 * read it once for both classifier parsing and snapshot capture).
 *
 * All fields are optional — missing headers map to `undefined`, not
 * empty strings, so Sentry's `extra` view filters cleanly.
 */
export function snapshotUpstreamResponse(
  resp: Pick<Response, 'headers'>,
  rawBody: string,
): UpstreamSnapshot {
  const headers = resp.headers;
  const snap: UpstreamSnapshot = {
    cfRay: headers.get('cf-ray') ?? undefined,
    server: headers.get('server') ?? undefined,
    vercelId: headers.get('x-vercel-id') ?? undefined,
    vercelCache: headers.get('x-vercel-cache') ?? undefined,
  };
  if (rawBody.length > 0) {
    snap.bodySnippet = rawBody.length > BODY_SNIPPET_MAX
      ? rawBody.slice(0, BODY_SNIPPET_MAX)
      : rawBody;
  }
  return snap;
}
