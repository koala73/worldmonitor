/**
 * Convex client error introspection for edge-runtime catch paths.
 *
 * Convex's HTTP runtime propagates `ConvexError.data` to the client ONLY when
 * the server-side throw passes object-typed data. String-data ConvexErrors
 * (e.g. `throw new ConvexError("CONFLICT")`) arrive at the client as a plain
 * `Error("[Request ID: X] Server Error")` with `.data === undefined` — a
 * `msg.includes('CONFLICT')` check NEVER matches and the throw gets
 * misclassified as 500. See `node_modules/convex/dist/esm/browser/
 * http_client.js:244` — when `respJSON.errorData === void 0` the client
 * falls through to `throw new Error(respJSON.errorMessage)`.
 *
 * Always throw `ConvexError({ kind, ... })` with object data on the server,
 * and read the kind via {@link extractConvexErrorKind} on the edge.
 *
 * Pure JS so test files (`.mjs`) and edge handlers (`.ts`) can both import
 * directly without going through a build step. JSDoc carries the types.
 */

/**
 * Extract the named-error `kind` from a Convex client throw. Prefers the
 * structured `err.data.kind` (server-side `ConvexError({ kind, ... })`),
 * falls back to substring-matching the legacy string-data error message
 * (`ConvexError("CONFLICT")`) for the deploy-ordering window where the
 * Vercel build may run against an older Convex deployment.
 *
 * @param {unknown} err
 * @param {string} msg `err.message` (passed in to avoid re-coercing in
 *   callers that already computed it).
 * @returns {string | null} the kind, or null when neither path matches.
 */
export function extractConvexErrorKind(err, msg) {
  const data = /** @type {{ data?: unknown } | null | undefined} */ (err)?.data;
  if (data && typeof data === 'object' && 'kind' in data) {
    const kind = /** @type {Record<string, unknown>} */ (data).kind;
    if (typeof kind === 'string') return kind;
  }
  // Convex platform-level 503: the runtime returns a JSON body
  // `{"code":"ServiceUnavailable","message":"Service temporarily unavailable"}`
  // when the deployment is briefly unreachable. The HTTP client surfaces
  // this as `Error('{"code":"ServiceUnavailable",...}')` — `.data` is
  // undefined (it's not a ConvexError, it's a transport-layer 503), so
  // we detect via the JSON-shape substring. Edge maps this to a 503
  // response with Retry-After so clients back off rather than treating
  // it as a permanent 500.
  if (msg.includes('"code":"ServiceUnavailable"')) return 'SERVICE_UNAVAILABLE';
  // Client-side fetch timeout (AbortSignal.timeout fires) — Convex stalled
  // long enough that we aborted before Vercel's 25s edge wall-clock could
  // kill the function with a generic 500. Same remediation as the platform
  // 503 (back off + retry), so reuse SERVICE_UNAVAILABLE. Sentry's
  // `error_shape` classifier still discriminates these two cases via msg
  // pattern (`transport_timeout` vs `convex_service_unavailable`).
  const errName = /** @type {{ name?: string } | null | undefined} */ (err)?.name;
  if (errName === 'TimeoutError' || errName === 'AbortError') return 'SERVICE_UNAVAILABLE';
  if (msg.includes('CONFLICT')) return 'CONFLICT';
  if (msg.includes('BLOB_TOO_LARGE')) return 'BLOB_TOO_LARGE';
  if (msg.includes('UNAUTHENTICATED')) return 'UNAUTHENTICATED';
  return null;
}

/**
 * Read a numeric field from `err.data` (e.g. `actualSyncVersion`,
 * `BLOB_TOO_LARGE.size`). Returns undefined when the field is missing or
 * not a number, so callers can build a strict response contract via
 * `field !== undefined ? { ..., field } : { ... }`.
 *
 * @param {unknown} err
 * @param {string} field
 * @returns {number | undefined}
 */
export function readConvexErrorNumber(err, field) {
  const data = /** @type {{ data?: unknown } | null | undefined} */ (err)?.data;
  if (!data || typeof data !== 'object' || !(field in data)) return undefined;
  const raw = /** @type {Record<string, unknown>} */ (data)[field];
  return typeof raw === 'number' ? raw : undefined;
}
