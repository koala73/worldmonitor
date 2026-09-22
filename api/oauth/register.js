// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { getClientIp, RATE_LIMIT_DEGRADED_HEADERS, rateLimitErrorLevel, rateLimitFingerprintStage } from '../_rate-limit.js';
import { captureSilentError } from '../_sentry-edge.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from '../_json-response.js';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { isAllowedRedirectUri } from './_redirect-uri.js';

export const config = { runtime: 'edge' };

const CLIENT_TTL_SECONDS = 90 * 24 * 3600; // 90 days sliding
// VS Code registers 4 redirect URIs at once. Every entry must still pass the
// allowlist, so this only bounds the stored record.
const MAX_REDIRECT_URIS = 8;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_REDIRECT_URI_BYTES = 2 * 1024;
const MAX_METADATA_BYTES = 8 * 1024;
const encoder = new TextEncoder();

async function readRegistrationBody(req) {
  if (Number(req.headers.get('content-length')) > MAX_REQUEST_BYTES) {
    throw new RangeError('Registration body too large');
  }
  if (!req.body) return '';

  const reader = req.body.getReader();
  const bytes = new Uint8Array(MAX_REQUEST_BYTES);
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_REQUEST_BYTES - total) {
        // Cancellation must not delay rejection if the stream never settles it.
        void reader.cancel().catch(() => {});
        throw new RangeError('Registration body too large');
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, total));
}

const lastDegradedReport = new Map();
function reportAdmissionUnavailable(stage, message, ctx) {
  const now = Date.now();
  const last = lastDegradedReport.get(stage);
  if (last !== undefined && now - last < 60_000) return;
  lastDegradedReport.set(stage, now);
  // Only fixed messages: SDK errors can include credentials or request data.
  console.error(`[rate-limit] redis-error stage=${stage} msg=${message}`);
  captureSilentError(new Error(message), {
    tags: { surface: 'api', component: 'rate-limit', route: 'api/oauth/register', stage },
    fingerprint: ['rate-limit', 'redis-error', rateLimitFingerprintStage(stage)],
    level: rateLimitErrorLevel(stage, message),
    ctx,
  });
}

function jsonResp(body, status = 200) {
  return jsonResponse(body, status, getPublicCorsHeaders('POST, OPTIONS'));
}

let _rl = null;
function getRatelimit() {
  if (_rl) return _rl;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _rl = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(5, '60 s'),
    prefix: 'rl:oauth-register',
    analytics: false,
  });
  return _rl;
}

async function storeClient(clientId, serializedMetadata) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['SET', `oauth:client:${clientId}`, serializedMetadata, 'EX', CLIENT_TTL_SECONDS],
      ]),
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return false;
    const results = await resp.json().catch(() => null);
    return Array.isArray(results) && results[0]?.result === 'OK';
  } catch { return false; }
}

export default async function handler(req, ctx) {
  const corsHeaders = getPublicCorsHeaders('POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResp({ error: 'method_not_allowed' }, 405);
  }

  let admission;
  let missingConfig = false;
  try {
    const rl = getRatelimit();
    missingConfig = !rl;
    if (rl) admission = await rl.limit(`ip:${getClientIp(req)}`);
  } catch { /* Missing admission is unavailable, never permission to persist. */ }
  // Upstash can resolve a timeout with success:true without an admission decision.
  if (!admission || admission.reason === 'timeout' || typeof admission.success !== 'boolean') {
    const stage = missingConfig ? 'oauthRegister:missing-config'
      : admission?.reason === 'timeout' ? 'oauthRegister:timeout' : 'oauthRegister';
    const message = missingConfig ? 'Upstash Redis is not configured'
      : admission?.reason === 'timeout' ? 'Upstash rate-limit decision timed out' : 'Upstash rate-limit decision unavailable';
    reportAdmissionUnavailable(stage, message, ctx);
    return jsonResponse({
      error: 'temporarily_unavailable',
      error_description: 'Client registration admission is temporarily unavailable.',
    }, 503, { ...corsHeaders, ...RATE_LIMIT_DEGRADED_HEADERS, 'Cache-Control': 'no-store' });
  }
  if (!admission.success) {
    return jsonResp({ error: 'rate_limit_exceeded', error_description: 'Too many registration requests.' }, 429);
  }

  let body;
  try {
    body = JSON.parse(await readRegistrationBody(req));
  } catch (error) {
    if (error instanceof RangeError) {
      return jsonResp({ error: 'invalid_request', error_description: 'Registration body exceeds 16384 bytes' }, 413);
    }
    return jsonResp({ error: 'invalid_request', error_description: 'Invalid JSON body' }, 400);
  }

  const { client_name, redirect_uris } = body ?? {};

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return jsonResp({ error: 'invalid_request', error_description: 'redirect_uris is required' }, 400);
  }
  if (redirect_uris.length > MAX_REDIRECT_URIS) {
    return jsonResp({ error: 'invalid_request', error_description: `Maximum ${MAX_REDIRECT_URIS} redirect_uris allowed` }, 400);
  }
  for (const uri of redirect_uris) {
    if (typeof uri === 'string' && encoder.encode(uri).byteLength > MAX_REDIRECT_URI_BYTES) {
      return jsonResp({ error: 'invalid_redirect_uri', error_description: 'Redirect URI exceeds 2048 bytes' }, 400);
    }
    if (typeof uri !== 'string' || !isAllowedRedirectUri(uri)) {
      return jsonResp({
        error: 'invalid_redirect_uri',
        error_description: `Redirect URI not allowed: ${uri}. Allowed: http loopback and the MCP client callbacks listed at https://www.worldmonitor.app/docs/mcp-overview#redirect-uri-allowlist`,
      }, 400);
    }
  }

  const clientId = crypto.randomUUID();
  const metadata = {
    client_name: typeof client_name === 'string' ? client_name.slice(0, 100) : 'Unknown Client',
    redirect_uris,
    created_at: Date.now(),
  };

  const serializedMetadata = JSON.stringify(metadata);
  if (encoder.encode(serializedMetadata).byteLength > MAX_METADATA_BYTES) {
    return jsonResp({ error: 'invalid_request', error_description: 'Client metadata exceeds 8192 bytes' }, 400);
  }
  const stored = await storeClient(clientId, serializedMetadata);
  if (!stored) {
    return jsonResp({ error: 'server_error', error_description: 'Client registration storage failed' }, 500);
  }

  return jsonResp({
    client_id: clientId,
    client_name: metadata.client_name,
    redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201);
}
