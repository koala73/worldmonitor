import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
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
    if (
      !entry
      || typeof entry !== 'object'
      || Object.prototype.hasOwnProperty.call(entry, 'error')
      || !Object.prototype.hasOwnProperty.call(entry, 'result')
      || entry.result == null
    ) return 'legacy';

    const raw = typeof entry.result === 'string'
      ? JSON.parse(entry.result)
      : entry.result;
    return resolveMode(raw);
  } catch {
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
};
