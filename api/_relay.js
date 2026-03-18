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
    headers.Authorization = `Bearer ${relaySecret}`;
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
      const keyCheck = validateApiKey(req);
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

      return new Response(body, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('content-type') || 'application/json',
          ...cacheHeaders,
          ...extraHeaders,
          ...corsHeaders,
        },
      });
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
