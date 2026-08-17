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
  | 'payment_in_progress'
  | 'invalid_product'
  | 'rate_limited'
  | 'service_unavailable'
  | 'unknown';

export interface CheckoutError {
  code: CheckoutErrorCode;
  userMessage: string;
  /** Raw server response — Sentry only; do NOT display. */
  serverMessage?: string;
  /** HTTP status, if the error came from an HTTP response. */
  httpStatus?: number;
  /** Server-requested checkout cooldown, bounded to the edge contract. */
  retryAfterSeconds?: number;
  retryable: boolean;
}

const USER_COPY: Record<CheckoutErrorCode, string> = {
  unauthorized: 'Please sign in to continue your purchase.',
  session_expired: 'Your session expired. Sign in again to continue.',
  duplicate_subscription: "You already have an active subscription. Let's open the billing portal instead.",
  payment_in_progress: 'You have a payment in progress. Finish it, or start a new checkout.',
  invalid_product: "That product isn't available. Please refresh and try again.",
  rate_limited: 'Checkout is temporarily rate limited. Please wait a moment and try again.',
  service_unavailable: 'Checkout is temporarily unavailable. Please try again in a moment.',
  unknown: "Something went wrong. Please try again or contact support if it keeps happening.",
};

const RETRYABLE: Record<CheckoutErrorCode, boolean> = {
  unauthorized: true,        // after sign-in
  session_expired: true,     // after sign-in
  duplicate_subscription: false,
  // The recovery is a dialog confirmation ("start a new checkout"), not a
  // network retry — so the generic retry affordance stays off (#4438).
  payment_in_progress: false,
  invalid_product: false,
  rate_limited: true,
  service_unavailable: true,
  unknown: true,
};

const ACTIVE_SUBSCRIPTION_EXISTS = 'ACTIVE_SUBSCRIPTION_EXISTS';
const PAYMENT_IN_PROGRESS = 'PAYMENT_IN_PROGRESS';
export const DEFAULT_CHECKOUT_RETRY_AFTER_SECONDS = 10;

/** Body shape we've observed from `/api/create-checkout` failures. */
export interface CheckoutErrorBody {
  error?: string;
  message?: string;
  code?: string;
  /**
   * Context object on a 409 block. The two block shapes share the route and are
   * discriminated by `error`: `ACTIVE_SUBSCRIPTION_EXISTS` carries `subscription`,
   * `PAYMENT_IN_PROGRESS` carries `pendingPayment` (#4438). Both are partial —
   * the body is parsed defensively (`parseCheckoutErrorBody`) and may be absent.
   */
  subscription?: { planKey?: string };
  pendingPayment?: { planKey?: string };
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

/**
 * The edge gateway exposes only a numeric 1-4 digit Retry-After value. Mirror
 * that closed contract here so browser state never trusts an unbounded or
 * date-shaped header when calculating the checkout cooldown.
 */
export function parseCheckoutRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value || !/^\d{1,4}$/.test(value)) return undefined;
  return Number(value);
}

function statusToCode(status: number, body: CheckoutErrorBody | undefined): CheckoutErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 409 && body?.error === ACTIVE_SUBSCRIPTION_EXISTS) return 'duplicate_subscription';
  if (status === 409 && body?.error === PAYMENT_IN_PROGRESS) return 'payment_in_progress';
  // Dodo can rate-limit checkout-session creation. The relay preserves 429 so
  // the transport does not auto-retry it as a generic 502 and amplify the
  // provider cooldown. This remains a temporary, user-retryable failure.
  if (status === 429) return 'rate_limited';
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
  retryAfter?: string | null,
): CheckoutError {
  const code = statusToCode(status, body);
  const retryAfterSeconds = code === 'rate_limited'
    ? parseCheckoutRetryAfterSeconds(retryAfter) ?? DEFAULT_CHECKOUT_RETRY_AFTER_SECONDS
    : undefined;
  const userMessage = retryAfterSeconds === undefined
    ? pickUserMessage(code)
    : `Checkout is temporarily rate limited. Please wait ${retryAfterSeconds} ${
        retryAfterSeconds === 1 ? 'second' : 'seconds'
      } and try again.`;
  return {
    code,
    userMessage,
    serverMessage: extractServerMessage(body),
    httpStatus: status,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
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
  /** Key names only, for a body that parsed as our own JSON envelope. See
   *  snapshotUpstreamBodyKeys for why values are withheld there. */
  bodyKeys?: string[];
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

/** Body of a 200 response from POST /api/create-checkout. */
export interface CheckoutSuccessBody {
  checkout_url?: unknown;
  anonymous_claim_token?: unknown;
}

/**
 * Why a 200 body could not be used, when it could not.
 *
 * These are separate arms rather than one `null` because they point at
 * different layers, and the Sentry message must not claim more than was
 * observed: `empty` and `invalid-json` suggest transport corruption or a
 * middlebox, while `non-object` is valid JSON the relay should never have
 * sent. Calling the latter a "non-JSON body" would be false.
 */
export type CheckoutSuccessBodyOutcome =
  | { kind: 'object'; body: CheckoutSuccessBody }
  | { kind: 'empty' }
  | { kind: 'invalid-json' }
  | { kind: 'non-object' };

/**
 * Parse a 200 create-checkout body.
 *
 * The success path used to call `resp.json()` directly. On a 200 whose
 * body is not valid JSON that throws an engine-specific DOMException
 * (Safari: `SyntaxError: The string did not match the expected pattern.`,
 * code 12), which escaped past the "200 without a usable checkout_url"
 * contract-violation reporter into the generic catch — losing the
 * upstream snapshot and splitting one bug across a Sentry fingerprint per
 * browser engine. WORLDMONITOR-XV.
 *
 * An unusable body stays distinct from a well-formed one missing
 * checkout_url, which the caller reports separately. Same plain-object-only
 * rule as parseCheckoutErrorBody — arrays and primitives cannot carry
 * checkout_url, so accepting them would be a structural lie.
 */
export function parseCheckoutSuccessBody(rawText: string): CheckoutSuccessBodyOutcome {
  if (rawText.length === 0) return { kind: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { kind: 'invalid-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'non-object' };
  }
  return { kind: 'object', body: parsed as CheckoutSuccessBody };
}

/**
 * Sentry `serverMessage` for each way a 200 body can be unusable. Keyed by
 * the outcome so the message can never drift from the branch that produced
 * it.
 */
export const UNUSABLE_SUCCESS_BODY_MESSAGE: Record<
  Exclude<CheckoutSuccessBodyOutcome['kind'], 'object'>,
  string
> = {
  empty: 'Server returned 200 with an empty body',
  'invalid-json': 'Server returned 200 with a non-JSON body',
  'non-object': 'Server returned 200 with a JSON body that is not an object',
};

/**
 * Masks the `anonymous_claim_token` value in a raw body string.
 *
 * A 200 create-checkout body carries that token, which the client
 * persists to localStorage as claim proof for migrating protected payment
 * rows — i.e. a bearer-like credential that must never reach Sentry. The
 * trailing `"?` makes the match tolerate a body cut mid-token, since a
 * leaked prefix is still a leak. Applied inside the snapshot builder
 * rather than at the call site so no future caller can forget it; it is a
 * no-op for error bodies, which never carry the field.
 */
const ANON_CLAIM_TOKEN_PATTERN = /("anonymous_claim_token"\s*:\s*")(?:\\.|[^"\\])*"?/g;

function redactCheckoutSecrets(rawBody: string): string {
  return rawBody.replace(ANON_CLAIM_TOKEN_PATTERN, '$1[redacted]"');
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
  const snap = snapshotUpstreamHeaders(resp);
  // Redact BEFORE truncating: the other order would emit the first 200
  // chars verbatim, shipping any token that sits inside them in full.
  const safeBody = redactCheckoutSecrets(rawBody);
  if (safeBody.length > 0) {
    snap.bodySnippet = safeBody.length > BODY_SNIPPET_MAX
      ? safeBody.slice(0, BODY_SNIPPET_MAX)
      : safeBody;
  }
  return snap;
}

function snapshotUpstreamHeaders(resp: Pick<Response, 'headers'>): UpstreamSnapshot {
  const headers = resp.headers;
  return {
    cfRay: headers.get('cf-ray') ?? undefined,
    server: headers.get('server') ?? undefined,
    vercelId: headers.get('x-vercel-id') ?? undefined,
    vercelCache: headers.get('x-vercel-cache') ?? undefined,
  };
}

/**
 * Snapshot for a body that already parsed as our own JSON envelope:
 * headers plus the payload's KEY NAMES, never its values.
 *
 * The 200 create-checkout payload is built server-side as
 * `{ ...result, anonymous_claim_token }` — a wholesale spread of the Dodo
 * SDK's checkout-session response. Its field set is therefore defined by a
 * third party, so value-level capture would be a standing bet that no
 * future SDK field is sensitive, enforced only by a redaction deny-list
 * that a schema change silently outruns.
 *
 * Key names carry the entire diagnostic here anyway — "had session_id, no
 * checkout_url" is the finding — so withholding values costs nothing.
 * Values are still captured for a body that did NOT parse as our envelope
 * (see snapshotUpstreamResponse), where the raw bytes are the whole point.
 * Sorted for stable Sentry grouping.
 */
export function snapshotUpstreamBodyKeys(
  resp: Pick<Response, 'headers'>,
  body: object,
): UpstreamSnapshot {
  const snap = snapshotUpstreamHeaders(resp);
  snap.bodyKeys = Object.keys(body).sort();
  return snap;
}
