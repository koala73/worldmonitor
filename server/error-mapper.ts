/**
 * Error-to-HTTP-response mapper for the sebuf server gateway.
 *
 * Used as the `onError` callback in ServerOptions. The generated code already
 * handles ValidationError (400) before calling onError, so this only handles:
 * - ApiError (with statusCode) -- upstream proxy failures
 * - Network/fetch errors -- 502 Bad Gateway
 * - Unknown errors -- 500 Internal Server Error
 */

import { isBillingVerificationCode } from './_shared/entitlement-check';
import { rateLimitHeaders } from './_shared/api-key-rate-limit';

export interface ApiErrorRateLimitMetadata {
  limit: number;
  remaining: number;
  resetMs: number;
  windowSec?: number;
}

export interface ApiErrorHttpResponseMetadata {
  /** Opt in to the public REST error envelope instead of the legacy RPC one. */
  envelope: 'error';
  /** Live quota state for a 429. Ignored for every other status. */
  rateLimit?: ApiErrorRateLimitMetadata;
}

type ApiErrorWithHttpResponseMetadata = Error & {
  httpResponseMetadata?: ApiErrorHttpResponseMetadata;
};

/**
 * Opt one ApiError into the public REST error response contract.
 * All ApiErrors without this metadata retain the legacy `{ message }` envelope.
 */
export function attachApiErrorHttpResponseMetadata<T extends Error>(
  error: T,
  metadata: ApiErrorHttpResponseMetadata,
): T {
  (error as T & ApiErrorWithHttpResponseMetadata).httpResponseMetadata = metadata;
  return error;
}

/**
 * Detects network/fetch errors across runtimes. Per Fetch spec, network
 * errors throw TypeError. We also check common error message patterns
 * for V8, Deno, Bun, and Cloudflare Workers edge runtimes.
 */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('fetch') || msg.includes('network') || msg.includes('connect') || msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('socket');
}

/**
 * Maps a thrown error to an appropriate HTTP Response.
 * Matches the `ServerOptions.onError` signature:
 *   (error: unknown, req: Request) => Response | Promise<Response>
 */
function jsonMessageResponse(message: string, status: number, extras?: Record<string, unknown>, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ message, ...(extras ?? {}) }), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

function jsonErrorResponse(message: string, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

function getHttpResponseMetadata(error: Error): ApiErrorHttpResponseMetadata | null {
  const metadata = (error as ApiErrorWithHttpResponseMetadata).httpResponseMetadata;
  return metadata?.envelope === 'error' ? metadata : null;
}

function isValidRateLimitMetadata(metadata: ApiErrorRateLimitMetadata): boolean {
  return Number.isFinite(metadata.limit)
    && metadata.limit > 0
    && Number.isFinite(metadata.remaining)
    && metadata.remaining >= 0
    && Number.isFinite(metadata.resetMs)
    && metadata.resetMs >= 0
    && (metadata.windowSec === undefined || (Number.isFinite(metadata.windowSec) && metadata.windowSec > 0));
}

export function mapErrorToResponse(error: unknown, _req: Request): Response {
  // ApiError: has statusCode property (e.g., upstream returns 429, 403, etc.)
  if (error instanceof Error && 'statusCode' in error) {
    const statusCode = (error as Error & { statusCode: number }).statusCode;
    const httpResponseMetadata = getHttpResponseMetadata(error);
    // Only expose error.message for 4xx (client errors). Use generic message for 5xx
    // to avoid leaking internal details like upstream URLs or API key fragments (H-3 fix).
    const retryAfter = (statusCode === 429 || statusCode === 503) && 'retryAfter' in error ? Number((error as Error & { retryAfter: number }).retryAfter) : null;
    const billingCodeCandidate = 'billingVerificationCode' in error
      ? (error as Error & { billingVerificationCode: unknown }).billingVerificationCode
      : null;
    const billingVerificationCode = isBillingVerificationCode(billingCodeCandidate)
      ? billingCodeCandidate
      : null;
    const exposesRetryableUnavailable = statusCode === 503
      && retryAfter != null
      && Number.isFinite(retryAfter)
      && ((error as Error & { exposeMessage?: boolean }).exposeMessage === true || httpResponseMetadata != null);
    const message = (statusCode >= 400 && statusCode < 500) || exposesRetryableUnavailable ? error.message : 'Internal server error';
    const extras: Record<string, unknown> = {};
    const headers: Record<string, string> = {};

    // Rate limit: include retryAfter if present
    if (retryAfter != null && Number.isFinite(retryAfter)) {
      extras.retryAfter = retryAfter;
      headers['Retry-After'] = String(retryAfter);
    }
    if (billingVerificationCode) {
      extras.code = billingVerificationCode;
      headers['X-Billing-Verification'] = billingVerificationCode;
    }
    if (
      statusCode === 429
      && retryAfter != null
      && Number.isFinite(retryAfter)
      && httpResponseMetadata?.rateLimit
      && isValidRateLimitMetadata(httpResponseMetadata.rateLimit)
    ) {
      Object.assign(headers, rateLimitHeaders({
        ...httpResponseMetadata.rateLimit,
        retryAfterSec: retryAfter,
      }));
    }

    if (statusCode >= 500) {
      // Log upstream response body (truncated) for debugging (M-4 fix)
      const apiBody = 'body' in error ? String((error as any).body).slice(0, 500) : '';
      console.error(`[error-mapper] ${statusCode}:`, error.message, apiBody ? `| body: ${apiBody}` : '');
    }

    if (httpResponseMetadata) {
      return jsonErrorResponse(
        message,
        statusCode,
        Object.keys(headers).length > 0 ? headers : undefined,
      );
    }

    return jsonMessageResponse(
      message,
      statusCode,
      Object.keys(extras).length > 0 ? extras : undefined,
      Object.keys(headers).length > 0 ? headers : undefined,
    );
  }

  // JSON parse errors from req.json() on malformed/empty POST body → 400 not 500
  if (error instanceof SyntaxError) {
    return jsonMessageResponse('Invalid request body', 400);
  }

  // Network/fetch errors: upstream is unreachable (M-5 fix: runtime-agnostic detection)
  if (isNetworkError(error)) {
    console.error('[error-mapper] Network error (502):', (error as Error).message);
    return jsonMessageResponse('Upstream unavailable', 502);
  }

  // Catch-all: 500 Internal Server Error
  console.error('[error-mapper] Unhandled error:', error instanceof Error ? error.message : error);
  return jsonMessageResponse('Internal server error', 500);
}
