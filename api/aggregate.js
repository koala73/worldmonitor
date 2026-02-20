import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

const DEFAULT_ENDPOINT_ALIASES = ['news', 'markets', 'cii', 'conflicts', 'fires', 'signals'];

const ENDPOINT_MAP = {
  news: '/api/hackernews',
  markets: '/api/stock-index?code=SPY',
  cii: '/api/risk-scores',
  conflicts: '/api/acled-conflict',
  fires: '/api/firms-fires?days=3',
  signals: '/api/macro-signals',
};

const MAX_ENDPOINTS = 20;

function resolveEndpointTarget(entry) {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  if (ENDPOINT_MAP[trimmed]) {
    return { key: trimmed, path: ENDPOINT_MAP[trimmed] };
  }

  if (trimmed.startsWith('/api/')) {
    const [pathOnly] = trimmed.split('#', 1);
    return { key: trimmed, path: pathOnly };
  }

  return null;
}

async function fetchEndpoint(baseUrl, target) {
  const startedAt = Date.now();
  try {
    const response = await fetch(new URL(target.path, baseUrl), {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });

    const durationMs = Date.now() - startedAt;
    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');

    if (!response.ok) {
      const errorText = isJson
        ? JSON.stringify(await response.json().catch(() => ({ error: `HTTP ${response.status}` })))
        : await response.text();
      return {
        ok: false,
        status: response.status,
        durationMs,
        error: errorText.slice(0, 300),
      };
    }

    const data = isJson ? await response.json() : await response.text();
    return {
      ok: true,
      status: response.status,
      durationMs,
      data,
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'Unknown fetch error',
    };
  }
}

export default async function handler(req) {
  const cors = getCorsHeaders(req);

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const url = new URL(req.url);
  const rawEndpoints = url.searchParams.get('endpoints');
  const endpointNames = (rawEndpoints ? rawEndpoints.split(',') : DEFAULT_ENDPOINT_ALIASES)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (endpointNames.length === 0) {
    return new Response(JSON.stringify({ error: 'No endpoints requested' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (endpointNames.length > MAX_ENDPOINTS) {
    return new Response(JSON.stringify({ error: `Too many endpoints requested (max ${MAX_ENDPOINTS})` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const targets = endpointNames.map(resolveEndpointTarget);
  const invalidEndpoints = endpointNames.filter((_, idx) => !targets[idx]);

  if (invalidEndpoints.length > 0) {
    return new Response(JSON.stringify({
      error: 'One or more endpoint entries are invalid',
      invalidEndpoints,
      allowedAliases: Object.keys(ENDPOINT_MAP),
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const baseUrl = `${url.protocol}//${url.host}`;
  const validTargets = targets;

  const results = await Promise.all(
    validTargets.map((target) => fetchEndpoint(baseUrl, target))
  );

  const payload = {};
  validTargets.forEach((target, index) => {
    payload[target.key] = results[index];
  });

  return new Response(JSON.stringify({
    requested: endpointNames,
    completed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    payload,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=30',
      ...cors,
    },
  });
}
