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
