/**
 * Shared helper for internal-auth Vercel edge endpoints.
 *
 * Bearer-header authentication with a constant-time HMAC comparison —
 * the canonical pattern in this repo (see api/cache-purge.js:74-88).
 * The HMAC wrap guarantees a timing-safe compare without depending on
 * node:crypto's timingSafeEqual, which is unavailable in Edge Runtime.
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

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    aBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, bBuf);
  const expected = await crypto.subtle.sign('HMAC', key, aBuf);
  const sigArr = new Uint8Array(sig);
  const expArr = new Uint8Array(expected);
  const n = sigArr.length;
  if (n !== expArr.length) return false;
  let diff = 0;
  for (let i = 0; i < n; i++) {
    // non-null asserted: bounds checked via the for condition; TS just
    // doesn't narrow Uint8Array index access to number under strict mode.
    diff |= (sigArr[i] as number) ^ (expArr[i] as number);
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
