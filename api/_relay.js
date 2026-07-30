// Edge function copy — canonical version at server/_shared/relay.ts
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { checkRateLimit } from './_rate-limit.js';
import { jsonResponse } from './_json-response.js';

export function getRelayBaseUrl() {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '');
}

export function getRelayHeaders(baseHeaders = {}) {
  const headers = { ...baseHeaders };
  const relaySecret = process.env.RELAY_SHARED_SECRET || '';
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
    if (relayHeader !== 'authorization') {
      headers.Authorization = `Bearer ${relaySecret}`;
    }
  }
  return headers;
}

export async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Build the final relay response — wraps non-JSON errors in a JSON envelope
 *  so the client can always parse the body (guards against Cloudflare HTML 502s).
 *  Exported so that standalone handlers (e.g. telegram-feed.js) can reuse it. */
export function buildRelayResponse(response, body, headers) {
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  // Treat any JSON-compatible type as JSON: application/json, application/problem+json,
  // application/vnd.api+json, application/ld+json, etc.
  const isNonJsonError = !response.ok && !ct.includes('/json') && !ct.includes('+json');
  if (isNonJsonError) {
    console.warn(`[relay] Wrapping non-JSON ${response.status} upstream error (ct: ${ct || 'none'}); body preview: ${String(body).slice(0, 120)}`);
  }
  return new Response(
    isNonJsonError ? JSON.stringify({ error: `Upstream error: HTTP ${response.status}`, status: response.status }) : body,
    {
      status: response.status,
      headers: {
        'Content-Type': isNonJsonError ? 'application/json' : (response.headers.get('content-type') || 'application/json'),
        ...headers,
      },
    },
  );
}

export function createRelayHandler(cfg) {
  return async function handler(req) {
    const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

    if (isDisallowedOrigin(req)) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (req.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    if (cfg.requireApiKey) {
      const keyCheck = await validateApiKey(req);
      if (keyCheck.required && !keyCheck.valid) {
        return jsonResponse({ error: keyCheck.error }, 401, corsHeaders);
      }
    }

    if (cfg.requireRateLimit) {
      const rateLimitResponse = await checkRateLimit(req, corsHeaders);
      if (rateLimitResponse) return rateLimitResponse;
    }

    const relayBaseUrl = getRelayBaseUrl();
    if (!relayBaseUrl) {
      if (cfg.fallback) return cfg.fallback(req, corsHeaders);
      return jsonResponse({ error: 'WS_RELAY_URL is not configured' }, 503, corsHeaders);
    }

    try {
      const requestUrl = new URL(req.url);
      const path = typeof cfg.buildRelayPath === 'function'
        ? cfg.buildRelayPath(req, requestUrl)
        : cfg.relayPath;
      const search = cfg.forwardSearch !== false ? (requestUrl.search || '') : '';
      const relayUrl = `${relayBaseUrl}${path}${search}`;

      const reqHeaders = cfg.requestHeaders || { Accept: 'application/json' };
      const response = await fetchWithTimeout(relayUrl, {
        headers: getRelayHeaders(reqHeaders),
      }, cfg.timeout || 15000);

      if (cfg.onlyOk && !response.ok && cfg.fallback) {
        return cfg.fallback(req, corsHeaders);
      }

      const extraHeaders = cfg.extraHeaders ? cfg.extraHeaders(response) : {};
      const body = await response.text();
      const isSuccess = response.status >= 200 && response.status < 300;
      const cacheHeaders = cfg.cacheHeaders ? cfg.cacheHeaders(isSuccess) : {};

      return buildRelayResponse(response, body, { ...cacheHeaders, ...extraHeaders, ...corsHeaders });
    } catch (error) {
      if (cfg.fallback) return cfg.fallback(req, corsHeaders);
      const isTimeout = error?.name === 'AbortError';
      return jsonResponse({
        error: isTimeout ? 'Relay timeout' : 'Relay request failed',
        details: error?.message || String(error),
      }, isTimeout ? 504 : 502, corsHeaders);
    }
  };
}
