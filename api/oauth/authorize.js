// @ts-expect-error — JS module, no declaration file
import { getClientIp } from '../_rate-limit.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes, sha256Hex } from '../_crypto.js';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

const CODE_TTL_SECONDS = 600;
const CLIENT_TTL_SECONDS = 90 * 24 * 3600; // 90-day sliding reset

let _rl = null;
function getRatelimit() {
  if (_rl) return _rl;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _rl = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(10, '60 s'),
    prefix: 'rl:oauth-authorize',
    analytics: false,
  });
  return _rl;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Atomic GETDEL — returns null on genuine key-miss; throws on transport/HTTP failure.
async function redisGetDel(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  const resp = await fetch(`${url}/getdel/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data?.result) return null; // key did not exist
  try { return JSON.parse(data.result); } catch { return null; }
}

// Returns null on genuine key-miss; throws on transport/HTTP failure
// so callers can distinguish "key not found" from "storage unavailable".
async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data?.result) return null; // key did not exist
  try { return JSON.parse(data.result); } catch { return null; }
}

async function redisSet(key, value, exSeconds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', exSeconds]]),
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return false;
    const results = await resp.json().catch(() => null);
    return Array.isArray(results) && results[0]?.result === 'OK';
  } catch { return false; }
}

function htmlError(title, detail) {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Authorization Error</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{max-width:400px;padding:2rem;background:#1a1a1a;border-radius:8px;border:1px solid #333}
h1{color:#f87171;font-size:1.25rem;margin:0 0 1rem}p{margin:0;color:#aaa;line-height:1.5}</style></head>
<body><div class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></div></body></html>`, {
    status: 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
  });
}

function consentPage(params, nonce, errorMsg = '') {
  const { client_name, redirect_uri, client_id, response_type, code_challenge, code_challenge_method, state } = params;
  const redirectHost = new URL(redirect_uri).hostname;
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize — WorldMonitor</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e8e8e8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem}
.card{width:100%;max-width:420px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:2rem}
h1{font-size:1.1rem;margin:0 0 0.25rem;color:#fff}
.sub{color:#888;font-size:0.85rem;margin:0 0 1.5rem}
.scope-badge{display:inline-block;background:#1e3a5f;color:#7dd3fc;border-radius:4px;padding:0.2rem 0.5rem;font-size:0.8rem;margin-bottom:1.5rem}
label{display:block;font-size:0.85rem;color:#aaa;margin-bottom:0.4rem}
input[type=password]{width:100%;padding:0.6rem 0.75rem;background:#111;border:1px solid #333;border-radius:6px;color:#fff;font-size:0.95rem;outline:none}
input[type=password]:focus{border-color:#60a5fa}
.error{color:#f87171;font-size:0.85rem;margin:0.5rem 0 0}
button{width:100%;margin-top:1.25rem;padding:0.7rem;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:1rem;cursor:pointer;font-weight:500}
button:hover{background:#1d4ed8}
.redirect{font-size:0.75rem;color:#666;margin-top:1rem;text-align:center}
</style></head>
<body><div class="card">
<h1>${escapeHtml(client_name)} wants to connect</h1>
<p class="sub">to WorldMonitor via <strong>${escapeHtml(redirectHost)}</strong></p>
<span class="scope-badge">mcp — read access</span>
<form method="POST" action="/oauth/authorize">
<input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
<input type="hidden" name="response_type" value="${escapeHtml(response_type)}">
<input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
<input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method)}">
<input type="hidden" name="state" value="${escapeHtml(state ?? '')}">
<input type="hidden" name="_nonce" value="${escapeHtml(nonce)}">
<label for="api_key">WorldMonitor API Key</label>
<input type="password" id="api_key" name="api_key" placeholder="wm_…" autocomplete="current-password" required>
${errorMsg ? `<p class="error">${escapeHtml(errorMsg)}</p>` : ''}
<button type="submit">Authorize</button>
</form>
<p class="redirect">You will be redirected to ${escapeHtml(redirectHost)}</p>
</div></body></html>`, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
  });
}

export default async function handler(req) {
  const method = req.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
  }

  if (method === 'GET') {
    const url = new URL(req.url);
    const p = url.searchParams;
    const client_id = p.get('client_id');
    const redirect_uri = p.get('redirect_uri');
    const response_type = p.get('response_type');
    const code_challenge = p.get('code_challenge');
    const code_challenge_method = p.get('code_challenge_method');
    const state = p.get('state') ?? '';

    if (!client_id || !redirect_uri || response_type !== 'code' || !code_challenge || code_challenge_method !== 'S256') {
      return htmlError('Invalid Authorization Request', 'Missing or invalid required parameters (client_id, redirect_uri, response_type=code, code_challenge, code_challenge_method=S256).');
    }

    // Validate code_challenge format: 43-char base64url
    if (code_challenge.length !== 43 || !/^[A-Za-z0-9\-_]+$/.test(code_challenge)) {
      return htmlError('Invalid Request', 'code_challenge must be a 43-character base64url string.');
    }

    let client;
    try {
      client = await redisGet(`oauth:client:${client_id}`);
    } catch {
      return htmlError('Service Unavailable', 'Authorization service is temporarily unavailable. Please try again shortly.');
    }
    if (!client) {
      return htmlError('Unknown Client', 'The client_id is not registered or has expired. Please re-register the client.');
    }

    const uris = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
    if (!uris.includes(redirect_uri)) {
      return htmlError('Redirect URI Mismatch', 'The redirect_uri does not match any registered redirect URI for this client.');
    }

    // Reset client TTL (sliding 90-day window)
    await redisSet(`oauth:client:${client_id}`, { ...client, last_used: Date.now() }, CLIENT_TTL_SECONDS);

    const nonce = crypto.randomUUID();
    const nonceStored = await redisSet(`oauth:nonce:${nonce}`, { client_id, redirect_uri, code_challenge, state, created_at: Date.now() }, 600);
    if (!nonceStored) {
      return htmlError('Service Unavailable', 'Authorization service is temporarily unavailable. Please try again shortly.');
    }

    return consentPage({
      client_name: client.client_name ?? 'Unknown Client',
      redirect_uri, client_id, response_type: 'code', code_challenge, code_challenge_method: 'S256', state,
    }, nonce);
  }

  if (method === 'POST') {
    // Origin validation: form submits from our own domain
    const origin = req.headers.get('origin');
    if (origin && origin !== 'https://api.worldmonitor.app') {
      return new Response('Forbidden', { status: 403 });
    }

    const rl = getRatelimit();
    if (rl) {
      try {
        const { success } = await rl.limit(`ip:${getClientIp(req)}`);
        if (!success) {
          return new Response('Too Many Requests', { status: 429 });
        }
      } catch { /* graceful degradation */ }
    }

    let params;
    try {
      params = new URLSearchParams(await req.text());
    } catch {
      return htmlError('Bad Request', 'Could not parse form data.');
    }

    const client_id = params.get('client_id');
    const redirect_uri = params.get('redirect_uri');
    const response_type = params.get('response_type');
    const code_challenge = params.get('code_challenge');
    const code_challenge_method = params.get('code_challenge_method');
    const state = params.get('state') ?? '';
    const api_key = params.get('api_key') ?? '';
    const nonce = params.get('_nonce') ?? '';

    if (!client_id || !redirect_uri || response_type !== 'code' || !code_challenge || code_challenge_method !== 'S256') {
      return htmlError('Invalid Request', 'Missing required parameters.');
    }

    // Validate and atomically consume CSRF nonce (GETDEL — prevents concurrent submit race)
    let nonceData;
    try {
      nonceData = await redisGetDel(`oauth:nonce:${nonce}`);
    } catch {
      return htmlError('Service Unavailable', 'Authorization service is temporarily unavailable. Please try again shortly.');
    }
    if (!nonceData || nonceData.client_id !== client_id || nonceData.redirect_uri !== redirect_uri) {
      return htmlError('Session Expired', 'Authorization session expired or is invalid. Please start over.');
    }

    let client;
    try {
      client = await redisGet(`oauth:client:${client_id}`);
    } catch {
      return htmlError('Service Unavailable', 'Authorization service is temporarily unavailable. Please try again shortly.');
    }
    if (!client) {
      return htmlError('Unknown Client', 'The client registration has expired. Please re-register.');
    }

    const uris = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
    if (!uris.includes(redirect_uri)) {
      return htmlError('Redirect URI Mismatch', 'redirect_uri does not match registered set.');
    }

    // Validate API key
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
    if (!await timingSafeIncludes(api_key, validKeys)) {
      // Generate and store a fresh nonce; fail closed if storage is unavailable
      const retryNonce = crypto.randomUUID();
      const retryNonceStored = await redisSet(`oauth:nonce:${retryNonce}`, { client_id, redirect_uri, code_challenge, state, created_at: Date.now() }, 600);
      if (!retryNonceStored) {
        return htmlError('Service Unavailable', 'Authorization service is temporarily unavailable. Please try again shortly.');
      }
      return consentPage({
        client_name: client.client_name ?? 'Unknown Client',
        redirect_uri, client_id, response_type: 'code', code_challenge, code_challenge_method: 'S256', state,
      }, retryNonce, 'Invalid API key. Please check and try again.');
    }

    // Issue authorization code
    const code = crypto.randomUUID();
    const codeData = {
      client_id,
      redirect_uri,
      code_challenge,
      scope: 'mcp',
      api_key_hash: await sha256Hex(api_key),
    };
    const stored = await redisSet(`oauth:code:${code}`, codeData, CODE_TTL_SECONDS);
    if (!stored) {
      return htmlError('Server Error', 'Failed to store authorization code. Please try again.');
    }

    // Reset client TTL
    await redisSet(`oauth:client:${client_id}`, { ...client, last_used: Date.now() }, CLIENT_TTL_SECONDS);

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl.toString(),
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache',
      },
    });
  }

  return new Response(null, { status: 405, headers: { Allow: 'GET, POST, OPTIONS' } });
}
