/**
 * Error-to-HTTP-response mapper for the sebuf server gateway.
 *
 * Used as the `onError` callback in ServerOptions. The generated code already
 * handles ValidationError (400) before calling onError, so this only handles:
 * - ApiError (with statusCode) -- upstream proxy failures
 * - Network/fetch errors -- 502 Bad Gateway
 * - Unknown errors -- 500 Internal Server Error
 */

/**
 * Detects network/fetch errors across runtimes. Per Fetch spec, network
 * errors throw TypeError. We also check common error message patterns
 * for V8, Deno, Bun, and Cloudflare Workers edge runtimes.
 */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('connect') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('socket');
}

/**
 * Maps a thrown error to an appropriate HTTP Response.
 * Matches the `ServerOptions.onError` signature:
 *   (error: unknown, req: Request) => Response | Promise<Response>
 */
export function mapErrorToResponse(error: unknown, _req: Request): Response {
  // ApiError: has statusCode property (e.g., upstream returns 429, 403, etc.)
  if (error instanceof Error && 'statusCode' in error) {
    const statusCode = (error as Error & { statusCode: number }).statusCode;
    // Only expose error.message for 4xx (client errors). Use generic message for 5xx
    // to avoid leaking internal details like upstream URLs or API key fragments (H-3 fix).
    const message = statusCode >= 400 && statusCode < 500
      ? error.message
      : 'Internal server error';
    const body: Record<string, unknown> = { message };

    // Rate limit: include retryAfter if present
    if (statusCode === 429 && 'retryAfter' in error) {
      body.retryAfter = (error as Error & { retryAfter: number }).retryAfter;
    }

    if (statusCode >= 500) {
      // Log upstream response body (truncated) for debugging (M-4 fix)
      const apiBody = 'body' in error ? String((error as any).body).slice(0, 500) : '';
      console.error(`[error-mapper] ${statusCode}:`, error.message, apiBody ? `| body: ${apiBody}` : '');
    }

    return new Response(JSON.stringify(body), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Network/fetch errors: upstream is unreachable (M-5 fix: runtime-agnostic detection)
  if (isNetworkError(error)) {
    return new Response(JSON.stringify({ message: 'Upstream unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Catch-all: 500 Internal Server Error
  console.error('[error-mapper] Unhandled error:', error instanceof Error ? error.message : error);
  return new Response(JSON.stringify({ message: 'Internal server error' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}
