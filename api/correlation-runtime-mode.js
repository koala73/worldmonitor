import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-edge.js';
// @ts-expect-error — JS module, no declaration file
import { redisPipeline } from './_upstash-json.js';

export const config = { runtime: 'edge' };

// Keep this edge-safe mirror aligned with shared/correlation-runtime-mode.js.
// api/*.js cannot import repository-root shared modules because each entry is
// bundled as a self-contained Vercel Edge Function.
const CORRELATION_RUNTIME_MODE_KEY = 'correlation:runtime-mode:v1';
const VALID_MODES = new Set(['legacy', 'exact', 'fuzzy']);
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  'CDN-Cache-Control': 'no-store',
};

function resolveMode(value) {
  const candidate = typeof value === 'string'
    ? value
    : value != null && typeof value === 'object' && !Array.isArray(value)
      ? value.mode
      : undefined;
  return typeof candidate === 'string' && VALID_MODES.has(candidate)
    ? candidate
    : 'legacy';
}

async function readModeFromRedis() {
  try {
    const entries = await redisPipeline([['GET', CORRELATION_RUNTIME_MODE_KEY]], 3_000);
    const entry = entries?.[0];
    // An Upstash-reported error is a broken control plane, not an unset key —
    // report it so it stays distinguishable from the (silent, expected) no-key
    // case. The handler still answers 200 with legacy, so without this the
    // failure is invisible to route-level error-rate monitoring.
    if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'error')) {
      console.warn('[correlation-runtime-mode] Upstash error entry; using legacy:', entry.error);
      captureSilentError(new Error(String(entry.error)), {
        tags: { route: 'api/correlation-runtime-mode', step: 'redis-error-entry' },
      });
      return 'legacy';
    }
    if (
      !entry
      || typeof entry !== 'object'
      || !Object.prototype.hasOwnProperty.call(entry, 'result')
      || entry.result == null
    ) return 'legacy';

    const raw = typeof entry.result === 'string'
      ? JSON.parse(entry.result)
      : entry.result;
    return resolveMode(raw);
  } catch (error) {
    console.warn('[correlation-runtime-mode] Redis read failed; using legacy:', error);
    captureSilentError(error, {
      tags: { route: 'api/correlation-runtime-mode', step: 'redis-read' },
    });
    return 'legacy';
  }
}

export default async function handler(req) {
  if (isDisallowedOrigin(req)) {
    return new Response('Forbidden', {
      status: 403,
      headers: NO_STORE_HEADERS,
    });
  }

  const cors = getCorsHeaders(req, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...NO_STORE_HEADERS, ...cors },
    });
  }
  if (req.method !== 'GET') {
    return jsonResponse(
      { error: 'Method not allowed' },
      405,
      { ...NO_STORE_HEADERS, ...cors },
    );
  }

  return jsonResponse(
    { mode: await readModeFromRedis() },
    200,
    { ...NO_STORE_HEADERS, ...cors },
  );
}

export const __testing__ = {
  resolveMode,
  readModeFromRedis,
  // Exported so the test suite can pin this edge-local copy to the canonical
  // constants in shared/correlation-runtime-mode.js. Without this, a drifted
  // key or mode set here would silently read the wrong control forever while
  // every assertion stayed green.
  CORRELATION_RUNTIME_MODE_KEY,
  VALID_MODES,
};
