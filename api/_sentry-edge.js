/**
 * Sentry capture for Vercel edge-runtime API functions.
 *
 * Thin wrapper over `_sentry-common.js`. The shared module owns the
 * envelope format, stack parsing, and fire-and-forget fetch (with
 * `keepalive: true` so events survive isolate teardown). This file just
 * binds runtime tags.
 *
 * Public surface:
 *   - `captureSilentError(err, { tags?, extra? })` — preferred. Pair
 *     with `ctx.waitUntil(...)` from the Vercel handler context to
 *     guarantee the isolate stays alive long enough to dispatch the
 *     fetch:
 *
 *       ctx.waitUntil(captureSilentError(err, { tags: { route: '...' } }));
 *
 *     `keepalive: true` on the underlying fetch is the safety net for
 *     callers that don't have ctx in scope (e.g. nested helpers). It
 *     lets the connection complete after isolate shutdown but doesn't
 *     prevent the shutdown itself — prefer waitUntil where available.
 *
 *   - `captureEdgeException(err, context)` — backwards-compat alias for
 *     the original (pre-sweep) shape. Existing callers in
 *     `notification-channels.ts` keep working unchanged. New code
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
 * @returns {Promise<void>}
 */
export async function captureEdgeException(err, context = {}) {
  await captureSilentError(err, { extra: context });
}
