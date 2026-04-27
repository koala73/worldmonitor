/**
 * Sentry capture for Vercel Node-runtime API functions.
 *
 * Thin wrapper over `_sentry-common.js` (mirror of `_sentry-edge.js`,
 * tagged `runtime: 'node'`, `platform: 'node'`). Exists so callers in
 * Node-runtime files can import a helper that tags events correctly
 * without a runtime check on every call.
 *
 * See `_sentry-edge.js` for the public-API docs — the surface is
 * identical.
 */

import { makeCaptureSilentError } from './_sentry-common.js';

export const captureSilentError = makeCaptureSilentError({
  runtime: 'node',
  platform: 'node',
  logPrefix: '[sentry-node]',
});
