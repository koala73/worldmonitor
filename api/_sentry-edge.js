/**
 * Sentry capture for Vercel edge-runtime API functions.
 *
 * Thin wrapper over `_sentry-common.js`. The shared module owns the
 * envelope format, stack parsing, and fire-and-forget fetch (with
 * `keepalive: true` so events survive isolate teardown). This file just
 * binds runtime tags.
 *
 * Public surface:
 *   - `captureSilentError(err, { tags?, extra?, ctx? })` — preferred.
 *     Pass the Vercel handler's `ctx` so the helper can register the
 *     delivery via `ctx.waitUntil`. When ctx is absent (local tests,
 *     sidecar invocations, non-Vercel callers), the helper falls back
 *     to fire-and-forget — `keepalive: true` on the underlying fetch
 *     is the transport-level safety net, and the unhandled-rejection
 *     defuse keeps Node's test runner happy.
 *
 *       captureSilentError(err, {
 *         tags: { route: 'api/foo', step: 'bar' },
 *         ctx, // optional — required for guaranteed delivery on Vercel
 *       });
 *
 *   - `captureEdgeException(err, context, ctx?)` — backwards-compat
 *     alias for the original (pre-sweep) shape. Existing callers in
 *     `notification-channels.ts` keep working unchanged; new callers
 *     should use `captureSilentError`.
 *
 * Sentry project: same DSN as the frontend (`VITE_SENTRY_DSN`). Events
 * are tagged `surface: api`, `runtime: edge` for filtering. The DSN is
 * already public in the browser bundle, so reusing it server-side adds
 * no exposure.
 */

import { makeCaptureSilentError } from './_sentry-common.js';

export const captureSilentError = makeCaptureSilentError({
  runtime: 'edge',
  platform: 'javascript',
  logPrefix: '[sentry-edge]',
});

/**
 * Backwards-compat alias for the pre-sweep call shape. Existing callers
 * pass `(err, contextObject)` — we coerce contextObject into `extra` so
 * data still lands in Sentry. Prefer `captureSilentError` in new code.
 *
 * @param {unknown} err
 * @param {Record<string, unknown>} [context]
 * @param {{ waitUntil: (p: Promise<unknown>) => void }} [vctx]
 *   Optional Vercel handler context. Passed through to
 *   `captureSilentError` so the isolate is held alive for delivery.
 * @returns {Promise<void>}
 */
export async function captureEdgeException(err, context = {}, vctx) {
  await captureSilentError(err, { extra: context, ctx: vctx });
}
