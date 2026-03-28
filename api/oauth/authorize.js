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

const GLOBE_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' };

function htmlError(title, detail) {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error &#x2014; WorldMonitor MCP</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:ui-monospace,'SF Mono','Cascadia Code',monospace;background:#0a0a0a;color:#e8e8e8;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.5rem}.wm-logo{display:flex;align-items:center;gap:.5rem;margin-bottom:2rem;text-decoration:none}.wm-logo svg{color:#2d8a6e}.wm-logo-text{font-size:.75rem;color:#555;letter-spacing:.1em;text-transform:uppercase}.card{width:100%;max-width:420px;background:#111;border:1px solid #1e1e1e;padding:2rem}h1{font-size:.95rem;font-weight:600;color:#ef4444;margin-bottom:.75rem;letter-spacing:.02em}p{font-size:.85rem;color:#666;line-height:1.6}.back{display:inline-block;margin-top:1.5rem;font-size:.75rem;color:#444;text-decoration:none;letter-spacing:.03em}.back:hover{color:#888}.footer{margin-top:1.5rem;font-size:.7rem;color:#2a2a2a;text-align:center}.footer a{color:#333;text-decoration:none}.footer a:hover{color:#555}</style></head>
<body><a href="https://www.worldmonitor.app" class="wm-logo" target="_blank" rel="noopener">${GLOBE_SVG}<span class="wm-logo-text">WorldMonitor MCP</span></a>
<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><a href="javascript:history.back()" class="back">&#8592; go back</a></div>
<p class="footer"><a href="https://www.worldmonitor.app" target="_blank" rel="noopener">worldmonitor.app</a></p>
</body></html>`, { status: 400, headers: PAGE_HEADERS });
}

function consentPage(params, nonce, errorMsg = '') {
  const { client_name, redirect_uri } = params;
  const redirectHost = new URL(redirect_uri).hostname;
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize &#x2014; WorldMonitor MCP</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-monospace,'SF Mono','Cascadia Code',monospace;background:#0a0a0a;color:#e8e8e8;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.5rem}
.wm-logo{display:flex;align-items:center;gap:.5rem;margin-bottom:2rem;text-decoration:none}
.wm-logo svg{color:#2d8a6e}
.wm-logo-text{font-size:.75rem;color:#555;letter-spacing:.1em;text-transform:uppercase}
.card{width:100%;max-width:440px;background:#111;border:1px solid #1e1e1e;padding:2rem}
.client-hd{margin-bottom:1.25rem}
.client-name{font-size:1rem;color:#fff;font-weight:600;margin-bottom:.25rem}
.client-host{font-size:.75rem;color:#444}
hr{border:none;border-top:1px solid #1e1e1e;margin:1.25rem 0}
.scope-label{font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;color:#444;margin-bottom:.6rem}
.scope-list{list-style:none}
.scope-list li{font-size:.8rem;color:#666;padding:.2rem 0;display:flex;align-items:flex-start;gap:.5rem}
.scope-list li::before{content:'→';color:#2d8a6e;flex-shrink:0;margin-top:.05em}
label{display:block;font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;color:#444;margin-bottom:.4rem}
input[type=password]{width:100%;padding:.65rem .75rem;background:#0a0a0a;border:1px solid #2a2a2a;color:#e8e8e8;font-family:inherit;font-size:.9rem;outline:none;border-radius:0}
input[type=password]:focus{border-color:#2d8a6e}
.hint{font-size:.72rem;color:#333;margin-top:.4rem}
.hint a{color:#2d8a6e;text-decoration:none}
.hint a:hover{text-decoration:underline}
.error{color:#ef4444;font-size:.8rem;margin:.5rem 0 0}
button{width:100%;margin-top:1.25rem;padding:.75rem;background:#2563eb;color:#fff;border:none;font-family:inherit;font-size:.9rem;cursor:pointer;font-weight:500;letter-spacing:.02em;border-radius:0}
button:hover{background:#1d4ed8}
button:disabled{opacity:.5;cursor:default}
.footer{font-size:.7rem;color:#2a2a2a;text-align:center;margin-top:1.25rem}
.footer a{color:#333;text-decoration:none}
.footer a:hover{color:#555}
</style></head>
<body>
<a href="https://www.worldmonitor.app" class="wm-logo" target="_blank" rel="noopener">${GLOBE_SVG}<span class="wm-logo-text">WorldMonitor MCP</span></a>
<div class="card">
<div class="client-hd">
<div class="client-name">${escapeHtml(client_name)} wants access</div>
<div class="client-host">via ${escapeHtml(redirectHost)}</div>
</div>
<hr>
<p class="scope-label">Read-only access to</p>
<ul class="scope-list">
<li>Real-time news &amp; events from 100+ global sources</li>
<li>Live flight tracking &amp; AIS vessel positions</li>
<li>Weather alerts, earthquakes &amp; natural disasters</li>
<li>Geopolitical risk indicators &amp; conflict data</li>
<li>Markets: stocks, commodities, crypto &amp; FX</li>
</ul>
<hr>
<form id="cf" method="POST" action="https://api.worldmonitor.app/oauth/authorize">
<input type="hidden" name="_nonce" id="nn" value="${escapeHtml(nonce)}">
<input type="hidden" name="_js" id="jf" value="">
<label for="api_key">API Key</label>
<input type="password" id="api_key" name="api_key" placeholder="wm_&#8230;" autocomplete="current-password" required>
<p class="hint">No key? <a href="https://www.worldmonitor.app/pro" target="_blank" rel="noopener">Get one at worldmonitor.app/pro &#x2192;</a></p>
<p class="error" id="ke"${errorMsg ? '' : ' style="display:none"'}>${errorMsg ? escapeHtml(errorMsg) : ''}</p>
<button type="submit" id="ab">Authorize</button>
</form>
</div>
<p class="footer"><a href="https://www.worldmonitor.app" target="_blank" rel="noopener">worldmonitor.app</a> &middot; <a href="https://www.worldmonitor.app/pro" target="_blank" rel="noopener">Get an API key &#x2192;</a></p>
<script>document.getElementById('cf').addEventListener('submit',function(e){e.preventDefault();var jf=document.getElementById('jf');if(jf)jf.value='1';var b=document.getElementById('ab');b.disabled=true;b.textContent='Authorizing\u2026';var d=new URLSearchParams(new FormData(e.target));fetch('/oauth/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:d}).then(function(r){var c=r.headers.get('Content-Type')||'';if(c.indexOf('json')>=0)return r.json().then(function(j){if(j.location){window.location.replace(j.location);return;}if(j.error==='invalid_key'){var n=document.getElementById('nn');if(n)n.value=j.nonce||'';var em=document.getElementById('ke');if(em){em.textContent='Invalid API key. Please check and try again.';em.style.display='';}}b.disabled=false;b.textContent='Authorize';});return r.text().then(function(h){document.open();document.write(h);document.close();});}).catch(function(){b.disabled=false;b.textContent='Authorize';});})</script>
</body></html>`, { status: 200, headers: PAGE_HEADERS });
}

export default async function handler(req) {
  const method = req.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
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
    // Origin validation: allow our domain, absent origin (server/CLI), and 'null'
    // (WebView with opaque/sandboxed origin). CSRF nonce provides the actual protection.
    const origin = req.headers.get('origin');
    if (origin && origin !== 'https://api.worldmonitor.app' && origin !== 'null') {
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

    const api_key = params.get('api_key') ?? '';
    const nonce = params.get('_nonce') ?? '';
    // _js=1 is set by the inline script before building FormData — distinguishes
    // the JS/WebView path (needs JSON response) from native form submit (needs 302).
    const isXHR = params.get('_js') === '1';

    if (!nonce) {
      return htmlError('Bad Request', 'Missing session token.');
    }

    // Atomically consume CSRF nonce (GETDEL — prevents concurrent submit race).
    // All security-critical values are derived from nonceData, not from mutable
    // form fields — prevents authorization misbinding via cross-origin form POST.
    let nonceData;
    try {
      nonceData = await redisGetDel(`oauth:nonce:${nonce}`);
    } catch {
      return htmlError('Service Unavailable', 'Authorization service is temporarily unavailable. Please try again shortly.');
    }
    if (!nonceData) {
      return htmlError('Session Expired', 'Authorization session expired or is invalid. Please start over.');
    }

    // Authoritative values come exclusively from server-stored nonce.
    const { client_id, redirect_uri, code_challenge, state } = nonceData;

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
      if (isXHR) {
        return new Response(JSON.stringify({ error: 'invalid_key', nonce: retryNonce }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      return consentPage({
        client_name: client.client_name ?? 'Unknown Client',
        redirect_uri, client_id, response_type: 'code', code_challenge, code_challenge_method: 'S256', state,
      }, retryNonce, 'Invalid API key. Please check and try again.');
    }

    // Issue authorization code — all fields sourced from nonceData
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

    // XHR (JavaScript fetch) path: return JSON so the page can navigate the WebView.
    // Native form submit path: return 302 redirect (curl, non-JS fallback).
    if (isXHR) {
      return new Response(JSON.stringify({ location: redirectUrl.toString() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
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
