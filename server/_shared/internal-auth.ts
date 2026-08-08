/**
 * Shared helper for internal-auth Vercel edge endpoints.
 *
 * Bearer-header authentication with a fixed-digest comparison. Hashing both
 * strings before the byte compare keeps the helper Edge-safe and avoids
 * leaking the raw input length through early returns.
 *
 * Usage in an endpoint handler:
 *
 *   const unauthorized = await authenticateInternalRequest(req, 'RELAY_SHARED_SECRET');
 *   if (unauthorized) return unauthorized;
 *   // ...proceed with request handling
 *
 * Returns null on successful auth, or a 401 Response that the caller
 * should return directly. Callers are responsible for adding their own
 * CORS headers to the returned Response (pass through `corsHeaders` if
 * needed).
 *
 * The endpoint using this MUST be an internal-only route — no Pro check,
 * no IP rate-limit (Railway crons hit from a single NAT IP and would
 * saturate).
 */

/**
 * Constant-time string comparison. Exported so that endpoints
 * authenticating against secrets passed in a non-`Authorization` header
 * (e.g. `x-probe-secret`) can reuse the same primitive instead of
 * falling back to `!==`, which leaks length and per-byte timing.
 * See issue #3803.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(a)));
  const bHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(b)));
  const n = bHash.length;
  let diff = 0;
  for (let i = 0; i < n; i++) {
    // non-null asserted: bounds checked via the for condition; TS just
    // doesn't narrow Uint8Array index access to number under strict mode.
    diff |= (aHash[i] as number) ^ (bHash[i] as number);
  }
  return diff === 0;
}

/**
 * Authenticate an incoming request against a named secret env var. The
 * expected header is `Authorization: Bearer ${process.env[secretEnvVar]}`.
 *
 * @param req             The incoming Request.
 * @param secretEnvVar    Name of the env var that holds the shared secret.
 *                        Typically `'RELAY_SHARED_SECRET'`.
 * @param extraHeaders    Optional headers to attach to the 401 response
 *                        (e.g. CORS). The successful-auth path returns
 *                        null; callers handle response construction.
 * @returns null on success, or a 401 Response on failure.
 */
export async function authenticateInternalRequest(
  req: Request,
  secretEnvVar: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response | null> {
  const auth = req.headers.get('authorization') || '';
  const secret = process.env[secretEnvVar];
  if (!secret || !(await timingSafeEqual(auth, `Bearer ${secret}`))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });
  }
  return null;
}
