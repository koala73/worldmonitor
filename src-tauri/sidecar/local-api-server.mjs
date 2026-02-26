#!/usr/bin/env node
import http, { createServer } from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliCompress, gzipSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const brotliCompressAsync = promisify(brotliCompress);

// Monkey-patch globalThis.fetch to force IPv4 for HTTPS requests.
// Node.js built-in fetch (undici) tries IPv6 first via Happy Eyeballs.
// Government APIs (EIA, NASA FIRMS, FRED) publish AAAA records but their
// IPv6 endpoints time out, causing ETIMEDOUT. This override ensures ALL
// fetch() calls in dynamically-loaded handler modules (api/*.js) use IPv4.
const _originalFetch = globalThis.fetch;

function normalizeRequestBody(body) {
  if (body == null) return null;
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return body;
}

async function resolveRequestBody(input, init, method, isRequest) {
  if (method === 'GET' || method === 'HEAD') return null;

  if (init?.body != null) {
    return normalizeRequestBody(init.body);
  }

  if (isRequest && input?.body) {
    const clone = typeof input.clone === 'function' ? input.clone() : input;
    const buffer = await clone.arrayBuffer();
    return normalizeRequestBody(buffer);
  }

  return null;
}

function buildSafeResponse(statusCode, statusText, headers, bodyBuffer) {
  const status = Number.isInteger(statusCode) ? statusCode : 500;
  const body = (status === 204 || status === 205 || status === 304) ? null : bodyBuffer;
  return new Response(body, { status, statusText, headers });
}

function isTransientVerificationError(error) {
  if (!(error instanceof Error)) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }
  if (error.name === 'AbortError') return true;
  return /timed out|timeout|network|fetch failed|failed to fetch|socket hang up/i.test(error.message);
}

globalThis.fetch = async function ipv4Fetch(input, init) {
  const isRequest = input && typeof input === 'object' && 'url' in input;
  let url;
  try { url = new URL(typeof input === 'string' ? input : input.url); } catch { return _originalFetch(input, init); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return _originalFetch(input, init);
  const mod = url.protocol === 'https:' ? https : http;
  const method = init?.method || (isRequest ? input.method : 'GET');
  const body = await resolveRequestBody(input, init, method, isRequest);
  const headers = {};
  const rawHeaders = init?.headers || (isRequest ? input.headers : null);
  if (rawHeaders) {
    const h = rawHeaders instanceof Headers ? Object.fromEntries(rawHeaders.entries())
      : Array.isArray(rawHeaders) ? Object.fromEntries(rawHeaders) : rawHeaders;
    Object.assign(headers, h);
  }
  return new Promise((resolve, reject) => {
    const req = mod.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method, headers, family: 4 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v) responseHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
        }
        try {
          resolve(buildSafeResponse(res.statusCode, res.statusMessage, responseHeaders, buf));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (init?.signal) { init.signal.addEventListener('abort', () => req.destroy()); }
    if (body != null) req.write(body);
    req.end();
  });
};

const ALLOWED_ENV_KEYS = new Set([
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'FRED_API_KEY', 'EIA_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'ACLED_ACCESS_TOKEN', 'URLHAUS_AUTH_KEY',
  'OTX_API_KEY', 'ABUSEIPDB_API_KEY', 'WINGBITS_API_KEY', 'WS_RELAY_URL',
  'VITE_OPENSKY_RELAY_URL', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET',
  'AISSTREAM_API_KEY', 'VITE_WS_RELAY_URL', 'FINNHUB_API_KEY', 'NASA_FIRMS_API_KEY',
  'OLLAMA_API_URL', 'OLLAMA_MODEL', 'WORLDMONITOR_API_KEY', 'WTO_API_KEY',
]);

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── SSRF protection ──────────────────────────────────────────────────────
// Block requests to private/reserved IP ranges to prevent the RSS proxy
// from being used as a localhost pivot or internal network scanner.

function isPrivateIP(ip) {
  // IPv4-mapped IPv6 — extract the v4 portion
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const addr = v4Mapped ? v4Mapped[1] : ip;

  // IPv6 loopback
  if (addr === '::1' || addr === '::') return true;

  // IPv6 link-local / unique-local
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true; // fc00::/7 (ULA)
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;  // fe80::/10 (link-local)

  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return false; // not an IPv4

  const [a, b] = parts;
  if (a === 127) return true;                       // 127.0.0.0/8  loopback
  if (a === 10) return true;                        // 10.0.0.0/8   private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a >= 224) return true;                         // 224.0.0.0+ multicast/reserved
  return false;
}

async function isSafeUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Only allow http(s) protocols
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: 'Only http and https protocols are allowed' };
  }

  // Block URLs with credentials
  if (parsed.username || parsed.password) {
    return { safe: false, reason: 'URLs with credentials are not allowed' };
  }

  const hostname = parsed.hostname;

  // Quick-reject obvious private hostnames before DNS resolution
  if (hostname === 'localhost' || hostname === '[::1]') {
    return { safe: false, reason: 'Requests to localhost are not allowed' };
  }

  // Check if the hostname is already an IP literal
  const ipLiteral = hostname.replace(/^\[|\]$/g, '');
  if (isPrivateIP(ipLiteral)) {
    return { safe: false, reason: 'Requests to private/reserved IP addresses are not allowed' };
  }

  // DNS resolution check — resolve the hostname and verify all resolved IPs
  // are public. This prevents DNS rebinding attacks where a public domain
  // resolves to a private IP.
  let addresses = [];
  try {
    try {
      const v4 = await dns.resolve4(hostname);
      addresses = addresses.concat(v4);
    } catch { /* no A records — try AAAA */ }
    try {
      const v6 = await dns.resolve6(hostname);
      addresses = addresses.concat(v6);
    } catch { /* no AAAA records */ }

    if (addresses.length === 0) {
      return { safe: false, reason: 'Could not resolve hostname' };
    }

    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        return { safe: false, reason: 'Hostname resolves to a private/reserved IP address' };
      }
    }
  } catch {
    return { safe: false, reason: 'DNS resolution failed' };
  }

  return { safe: true, resolvedAddresses: addresses };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function canCompress(headers, body) {
  return body.length > 1024 && !headers['content-encoding'];
}

function appendVary(existing, token) {
  const value = typeof existing === 'string' ? existing : '';
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.some((p) => p.toLowerCase() === token.toLowerCase())) {
    parts.push(token);
  }
  return parts.join(', ');
}

async function maybeCompressResponseBody(body, headers, acceptEncoding = '') {
  if (!canCompress(headers, body)) return body;
  headers['vary'] = appendVary(headers['vary'], 'Accept-Encoding');

  if (acceptEncoding.includes('br')) {
    headers['content-encoding'] = 'br';
    return brotliCompressAsync(body);
  }

  if (acceptEncoding.includes('gzip')) {
    headers['content-encoding'] = 'gzip';
    return gzipSync(body);
  }

  return body;
}

function isBracketSegment(segment) {
  return segment.startsWith('[') && segment.endsWith(']');
}

function splitRoutePath(routePath) {
  return routePath.split('/').filter(Boolean);
}

function routePriority(routePath) {
  const parts = splitRoutePath(routePath);
  return parts.reduce((score, part) => {
    if (part.startsWith('[[...') && part.endsWith(']]')) return score + 0;
    if (part.startsWith('[...') && part.endsWith(']')) return score + 1;
    if (isBracketSegment(part)) return score + 2;
    return score + 10;
  }, 0);
}

function matchRoute(routePath, pathname) {
  const routeParts = splitRoutePath(routePath);
  const pathParts = splitRoutePath(pathname.replace(/^\/api/, ''));

  let i = 0;
  let j = 0;

  while (i < routeParts.length && j < pathParts.length) {
    const routePart = routeParts[i];
    const pathPart = pathParts[j];

    if (routePart.startsWith('[[...') && routePart.endsWith(']]')) {
      return true;
    }

    if (routePart.startsWith('[...') && routePart.endsWith(']')) {
      return true;
    }

    if (isBracketSegment(routePart)) {
      i += 1;
      j += 1;
      continue;
    }

    if (routePart !== pathPart) {
      return false;
    }

    i += 1;
    j += 1;
  }

  if (i === routeParts.length && j === pathParts.length) return true;

  if (i === routeParts.length - 1) {
    const tail = routeParts[i];
    if (tail?.startsWith('[[...') && tail.endsWith(']]')) {
      return true;
    }
    if (tail?.startsWith('[...') && tail.endsWith(']')) {
      return j < pathParts.length;
    }
  }

  return false;
}

async function buildRouteTable(root) {
  if (!existsSync(root)) return [];

  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      if (entry.name.startsWith('_')) continue;

      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      const routePath = relative.replace(/\.js$/, '').replace(/\/index$/, '');
      files.push({ routePath, modulePath: absolute });
    }
  }

  await walk(root);

  files.sort((a, b) => routePriority(b.routePath) - routePriority(a.routePath));
  return files;
}

const REQUEST_BODY_CACHE = Symbol('requestBodyCache');

async function readBody(req) {
  if (Object.prototype.hasOwnProperty.call(req, REQUEST_BODY_CACHE)) {
    return req[REQUEST_BODY_CACHE];
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  req[REQUEST_BODY_CACHE] = body;
  return body;
}

function toHeaders(nodeHeaders, options = {}) {
  const stripOrigin = options.stripOrigin === true;
  const headers = new Headers();
  Object.entries(nodeHeaders).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host') return;
    if (stripOrigin && (lowerKey === 'origin' || lowerKey === 'referer' || lowerKey.startsWith('sec-fetch-'))) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(v => headers.append(key, v));
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  });
  return headers;
}

async function proxyToCloud(requestUrl, req, remoteBase) {
  const target = `${remoteBase}${requestUrl.pathname}${requestUrl.search}`;
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  return fetch(target, {
    method: req.method,
    // Strip browser-origin headers for server-to-server parity.
    headers: toHeaders(req.headers, { stripOrigin: true }),
    body,
  });
}

function pickModule(pathname, routes) {
  const apiPath = pathname.startsWith('/api') ? pathname.slice(4) || '/' : pathname;

  for (const candidate of routes) {
    if (matchRoute(candidate.routePath, apiPath)) {
      return candidate.modulePath;
    }
  }

  return null;
}

const moduleCache = new Map();
const failedImports = new Set();
const fallbackCounts = new Map();
const cloudPreferred = new Set();

const TRAFFIC_LOG_MAX = 200;
const trafficLog = [];
let verboseMode = false;
let _verboseStatePath = null;

function loadVerboseState(dataDir) {
  _verboseStatePath = path.join(dataDir, 'verbose-mode.json');
  try {
    const data = JSON.parse(readFileSync(_verboseStatePath, 'utf-8'));
    verboseMode = !!data.verboseMode;
  } catch { /* file missing or invalid — keep default false */ }
}

function saveVerboseState() {
  if (!_verboseStatePath) return;
  try { writeFileSync(_verboseStatePath, JSON.stringify({ verboseMode })); } catch { /* ignore */ }
}

function recordTraffic(entry) {
  trafficLog.push(entry);
  if (trafficLog.length > TRAFFIC_LOG_MAX) trafficLog.shift();
  if (verboseMode) {
    const ts = entry.timestamp.split('T')[1].replace('Z', '');
    console.log(`[traffic] ${ts} ${entry.method} ${entry.path} → ${entry.status} ${entry.durationMs}ms`);
  }
}

function logOnce(logger, route, message) {
  const key = `${route}:${message}`;
  const count = (fallbackCounts.get(key) || 0) + 1;
  fallbackCounts.set(key, count);
  if (count === 1) {
    logger.warn(`[local-api] ${route} → ${message}`);
  } else if (count === 5 || count % 100 === 0) {
    logger.warn(`[local-api] ${route} → ${message} (x${count})`);
  }
}

async function importHandler(modulePath) {
  if (failedImports.has(modulePath)) {
    throw new Error(`cached-failure:${path.basename(modulePath)}`);
  }

  const cached = moduleCache.get(modulePath);
  if (cached) return cached;

  try {
    const mod = await import(pathToFileURL(modulePath).href);
    moduleCache.set(modulePath, mod);
    return mod;
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      failedImports.add(modulePath);
    }
    throw error;
  }
}

function resolveConfig(options = {}) {
  const port = Number(options.port ?? process.env.LOCAL_API_PORT ?? 46123);
  const remoteBase = String(options.remoteBase ?? process.env.LOCAL_API_REMOTE_BASE ?? 'https://worldmonitor.app').replace(/\/$/, '');
  const resourceDir = String(options.resourceDir ?? process.env.LOCAL_API_RESOURCE_DIR ?? process.cwd());
  const apiDir = options.apiDir
    ? String(options.apiDir)
    : [
      path.join(resourceDir, 'api'),
      path.join(resourceDir, '_up_', 'api'),
    ].find((candidate) => existsSync(candidate)) ?? path.join(resourceDir, 'api');
  const dataDir = String(options.dataDir ?? process.env.LOCAL_API_DATA_DIR ?? resourceDir);
  const mode = String(options.mode ?? process.env.LOCAL_API_MODE ?? 'desktop-sidecar');
  const cloudFallback = String(options.cloudFallback ?? process.env.LOCAL_API_CLOUD_FALLBACK ?? '') === 'true';
  const logger = options.logger ?? console;

  return {
    port,
    remoteBase,
    resourceDir,
    dataDir,
    apiDir,
    mode,
    cloudFallback,
    logger,
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

async function handleLocalServiceStatus(context) {
  return json({
    success: true,
    timestamp: new Date().toISOString(),
    summary: { operational: 2, degraded: 0, outage: 0, unknown: 0 },
    services: [
      { id: 'local-api', name: 'Local Desktop API', category: 'dev', status: 'operational', description: `Running on 127.0.0.1:${context.port}` },
      { id: 'cloud-pass-through', name: 'Cloud pass-through', category: 'cloud', status: 'operational', description: `Fallback target ${context.remoteBase}` },
    ],
    local: { enabled: true, mode: context.mode, port: context.port, remoteBase: context.remoteBase },
  });
}

async function tryCloudFallback(requestUrl, req, context, reason) {
  if (reason) {
    const route = requestUrl.pathname;
    const count = (fallbackCounts.get(route) || 0) + 1;
    fallbackCounts.set(route, count);
    if (count === 1) {
      const brief = reason instanceof Error
        ? (reason.code === 'ERR_MODULE_NOT_FOUND' ? 'missing npm dependency' : reason.message)
        : reason;
      context.logger.warn(`[local-api] ${route} → cloud (${brief})`);
    } else if (count === 5 || count % 100 === 0) {
      context.logger.warn(`[local-api] ${route} → cloud x${count}`);
    }
  }
  try {
    return await proxyToCloud(requestUrl, req, context.remoteBase);
  } catch (error) {
    context.logger.error('[local-api] cloud fallback failed', requestUrl.pathname, error);
    return null;
  }
}

const SIDECAR_ALLOWED_ORIGINS = [
  /^tauri:\/\/localhost$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  // Only allow exact domain or single-level subdomains (e.g. preview-xyz.worldmonitor.app).
  // The previous (.*\.)? pattern was overly broad. Anchored to prevent spoofing
  // via domains like worldmonitorEVIL.vercel.app.
  /^https:\/\/([a-z0-9-]+\.)?worldmonitor\.app$/,
];

function getSidecarCorsOrigin(req) {
  const origin = req.headers?.origin || req.headers?.get?.('origin') || '';
  if (origin && SIDECAR_ALLOWED_ORIGINS.some(p => p.test(origin))) return origin;
  return 'tauri://localhost';
}

function makeCorsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': getSidecarCorsOrigin(req),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  // Use node:https with IPv4 forced — Node.js built-in fetch (undici) tries IPv6
  // first and some servers (EIA, NASA FIRMS) have broken IPv6 causing ETIMEDOUT.
  const u = new URL(url);
  if (u.protocol === 'https:') {
    return new Promise((resolve, reject) => {
      const reqOpts = {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        family: 4,
      };
      // Pin to a pre-resolved IP to prevent TOCTOU DNS rebinding.
      // The hostname is kept for SNI / TLS certificate validation.
      if (options.resolvedAddress) {
        reqOpts.lookup = (_hostname, _opts, cb) => cb(null, options.resolvedAddress, 4);
      }
      const req = https.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: { get: (k) => res.headers[k.toLowerCase()] || null },
            text: () => Promise.resolve(body),
            json: () => Promise.resolve(JSON.parse(body)),
          });
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out')); });
      if (options.body) {
        const body = normalizeRequestBody(options.body);
        if (body != null) req.write(body);
      }
      req.end();
    });
  }
  // HTTP fallback (localhost sidecar, etc.)
  // For pinned addresses on plain HTTP, rewrite the URL to connect to the
  // validated IP and set the Host header so virtual-host routing still works.
  let fetchUrl = url;
  const fetchHeaders = { ...(options.headers || {}) };
  if (options.resolvedAddress && u.protocol === 'http:') {
    const pinned = new URL(url);
    fetchHeaders['Host'] = pinned.host;
    pinned.hostname = options.resolvedAddress;
    fetchUrl = pinned.toString();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(fetchUrl, { ...options, headers: fetchHeaders, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function relayToHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isAuthFailure(status, text = '') {
  // Intentionally broad for provider auth responses.
  // Callers MUST check isCloudflareChallenge403() first or CF challenge pages
  // may be misclassified as credential failures.
  if (status === 401 || status === 403) return true;
  return /unauthori[sz]ed|forbidden|invalid api key|invalid token|bad credentials/i.test(text);
}

function isCloudflareChallenge403(response, text = '') {
  if (response.status !== 403 || !response.headers.get('cf-ray')) return false;
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const body = String(text || '').toLowerCase();
  const looksLikeHtml = contentType.includes('text/html') || body.includes('<html');
  if (!looksLikeHtml) return false;
  const matches = [
    'attention required',
    'cf-browser-verification',
    '__cf_chl',
    'ray id',
  ].filter((marker) => body.includes(marker)).length;
  return matches >= 2;
}

async function validateSecretAgainstProvider(key, rawValue, context = {}) {
  const value = String(rawValue || '').trim();
  if (!value) return { valid: false, message: 'Value is required' };

  const fail = (message) => ({ valid: false, message });
  const ok = (message) => ({ valid: true, message });

  try {
    switch (key) {
    case 'GROQ_API_KEY': {
      const response = await fetchWithTimeout('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${value}`, 'User-Agent': CHROME_UA },
      });
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('Groq key stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('Groq rejected this key');
      if (!response.ok) return fail(`Groq probe failed (${response.status})`);
      return ok('Groq key verified');
    }

    case 'OPENROUTER_API_KEY': {
      const response = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${value}`, 'User-Agent': CHROME_UA },
      });
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('OpenRouter key stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('OpenRouter rejected this key');
      if (!response.ok) return fail(`OpenRouter probe failed (${response.status})`);
      return ok('OpenRouter key verified');
    }

    case 'FRED_API_KEY': {
      const response = await fetchWithTimeout(
        `https://api.stlouisfed.org/fred/series?series_id=GDP&api_key=${encodeURIComponent(value)}&file_type=json`,
        { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } }
      );
      const text = await response.text();
      if (!response.ok) return fail(`FRED probe failed (${response.status})`);
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* ignore */ }
      if (payload?.error_code || payload?.error_message) return fail('FRED rejected this key');
      if (!Array.isArray(payload?.seriess)) return fail('Unexpected FRED response');
      return ok('FRED key verified');
    }

    case 'EIA_API_KEY': {
      const response = await fetchWithTimeout(
        `https://api.eia.gov/v2/?api_key=${encodeURIComponent(value)}`,
        { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } }
      );
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('EIA key stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('EIA rejected this key');
      if (!response.ok) return fail(`EIA probe failed (${response.status})`);
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* ignore */ }
      if (payload?.response?.id === undefined && !payload?.response?.routes) return fail('Unexpected EIA response');
      return ok('EIA key verified');
    }

    case 'CLOUDFLARE_API_TOKEN': {
      const response = await fetchWithTimeout(
        'https://api.cloudflare.com/client/v4/radar/annotations/outages?dateRange=1d&limit=1',
        { headers: { Authorization: `Bearer ${value}`, 'User-Agent': CHROME_UA } }
      );
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('Cloudflare token stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('Cloudflare rejected this token');
      if (!response.ok) return fail(`Cloudflare probe failed (${response.status})`);
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* ignore */ }
      if (payload?.success !== true) return fail('Cloudflare Radar API did not return success');
      return ok('Cloudflare token verified');
    }

    case 'ACLED_ACCESS_TOKEN': {
      const response = await fetchWithTimeout('https://acleddata.com/api/acled/read?_format=json&limit=1', {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${value}`,
          'User-Agent': CHROME_UA,
        },
      });
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('ACLED token stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('ACLED rejected this token');
      if (!response.ok) return fail(`ACLED probe failed (${response.status})`);
      return ok('ACLED token verified');
    }

    case 'URLHAUS_AUTH_KEY': {
      const response = await fetchWithTimeout('https://urlhaus-api.abuse.ch/v1/urls/recent/limit/1/', {
        headers: {
          Accept: 'application/json',
          'Auth-Key': value,
          'User-Agent': CHROME_UA,
        },
      });
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('URLhaus key stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('URLhaus rejected this key');
      if (!response.ok) return fail(`URLhaus probe failed (${response.status})`);
      return ok('URLhaus key verified');
    }

    case 'OTX_API_KEY': {
      const response = await fetchWithTimeout('https://otx.alienvault.com/api/v1/user/me', {
        headers: {
          Accept: 'application/json',
          'X-OTX-API-KEY': value,
          'User-Agent': CHROME_UA,
        },
      });
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('OTX key stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('OTX rejected this key');
      if (!response.ok) return fail(`OTX probe failed (${response.status})`);
      return ok('OTX key verified');
    }

    case 'ABUSEIPDB_API_KEY': {
      const response = await fetchWithTimeout('https://api.abuseipdb.com/api/v2/check?ipAddress=8.8.8.8&maxAgeInDays=90', {
        headers: {
          Accept: 'application/json',
          Key: value,
          'User-Agent': CHROME_UA,
        },
      });
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('AbuseIPDB key stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('AbuseIPDB rejected this key');
      if (!response.ok) return fail(`AbuseIPDB probe failed (${response.status})`);
      return ok('AbuseIPDB key verified');
    }

    case 'WINGBITS_API_KEY': {
      const response = await fetchWithTimeout('https://customer-api.wingbits.com/v1/flights/details/3c6444', {
        headers: {
          Accept: 'application/json',
          'x-api-key': value,
          'User-Agent': CHROME_UA,
        },
      });
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('Wingbits key stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('Wingbits rejected this key');
      if (response.status >= 500) return fail(`Wingbits probe failed (${response.status})`);
      return ok('Wingbits key accepted');
    }

    case 'FINNHUB_API_KEY': {
      const response = await fetchWithTimeout(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${encodeURIComponent(value)}`, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      });
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('Finnhub key stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('Finnhub rejected this key');
      if (response.status === 429) return ok('Finnhub key accepted (rate limited)');
      if (!response.ok) return fail(`Finnhub probe failed (${response.status})`);
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* ignore */ }
      if (typeof payload?.error === 'string' && payload.error.toLowerCase().includes('invalid')) {
        return fail('Finnhub rejected this key');
      }
      if (typeof payload?.c !== 'number') return fail('Unexpected Finnhub response');
      return ok('Finnhub key verified');
    }

    case 'NASA_FIRMS_API_KEY': {
      const response = await fetchWithTimeout(
        `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(value)}/VIIRS_SNPP_NRT/22,44,40,53/1`,
        { headers: { Accept: 'text/csv', 'User-Agent': CHROME_UA } }
      );
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('NASA FIRMS key stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('NASA FIRMS rejected this key');
      if (!response.ok) return fail(`NASA FIRMS probe failed (${response.status})`);
      if (/invalid api key|not authorized|forbidden/i.test(text)) return fail('NASA FIRMS rejected this key');
      return ok('NASA FIRMS key verified');
    }

    case 'OLLAMA_API_URL': {
      let probeUrl;
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) return fail('Must be an http(s) URL');
        // Probe the OpenAI-compatible models endpoint
        probeUrl = new URL('/v1/models', value).toString();
      } catch {
        return fail('Invalid URL');
      }
      const response = await fetchWithTimeout(probeUrl, { method: 'GET' }, 8000);
      if (!response.ok) {
        // Fall back to native Ollama /api/tags endpoint
        try {
          const tagsUrl = new URL('/api/tags', value).toString();
          const tagsResponse = await fetchWithTimeout(tagsUrl, { method: 'GET' }, 8000);
          if (!tagsResponse.ok) return fail(`Ollama probe failed (${tagsResponse.status})`);
          return ok('Ollama endpoint verified (native API)');
        } catch {
          return fail(`Ollama probe failed (${response.status})`);
        }
      }
      return ok('Ollama endpoint verified');
    }

    case 'OLLAMA_MODEL':
      return ok('Model name stored');

    case 'WS_RELAY_URL':
    case 'VITE_WS_RELAY_URL':
    case 'VITE_OPENSKY_RELAY_URL': {
      const probeUrl = relayToHttpUrl(value);
      if (!probeUrl) return fail('Relay URL is invalid');
      const response = await fetchWithTimeout(probeUrl, { method: 'GET' });
      if (response.status >= 500) return fail(`Relay probe failed (${response.status})`);
      return ok('Relay URL is reachable');
    }

    case 'OPENSKY_CLIENT_ID':
    case 'OPENSKY_CLIENT_SECRET': {
      const contextClientId = typeof context.OPENSKY_CLIENT_ID === 'string' ? context.OPENSKY_CLIENT_ID.trim() : '';
      const contextClientSecret = typeof context.OPENSKY_CLIENT_SECRET === 'string' ? context.OPENSKY_CLIENT_SECRET.trim() : '';
      const clientId = key === 'OPENSKY_CLIENT_ID'
        ? value
        : (contextClientId || String(process.env.OPENSKY_CLIENT_ID || '').trim());
      const clientSecret = key === 'OPENSKY_CLIENT_SECRET'
        ? value
        : (contextClientSecret || String(process.env.OPENSKY_CLIENT_SECRET || '').trim());
      if (!clientId || !clientSecret) {
        return fail('Set both OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET before verification');
      }
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      });
      const response = await fetchWithTimeout(
        'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CHROME_UA },
          body,
        }
      );
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('OpenSky credentials stored (Cloudflare blocked verification)');
      if (isAuthFailure(response.status, text)) return fail('OpenSky rejected these credentials');
      if (!response.ok) return fail(`OpenSky auth probe failed (${response.status})`);
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* ignore */ }
      if (!payload?.access_token) return fail('OpenSky auth response did not include an access token');
      return ok('OpenSky credentials verified');
    }

    case 'AISSTREAM_API_KEY':
      return ok('AISSTREAM key stored (live verification not available in sidecar)');

    case 'WTO_API_KEY':
      return ok('WTO API key stored (live verification not available in sidecar)');

      default:
        return ok('Key stored');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'provider probe failed';
    if (isTransientVerificationError(error)) {
      return { valid: true, message: `Saved (could not verify: ${message})` };
    }
    return fail(`Verification request failed: ${message}`);
  }
}

async function dispatch(requestUrl, req, routes, context) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: makeCorsHeaders(req) });
  }

  // Health check — exempt from auth to support external monitoring tools
  if (requestUrl.pathname === '/api/service-status') {
    return handleLocalServiceStatus(context);
  }

  // ── Global auth gate ────────────────────────────────────────────────────
  // Every endpoint below requires a valid LOCAL_API_TOKEN.  This prevents
  // other local processes, malicious browser scripts, and rogue extensions
  // from accessing the sidecar API without the per-session token.
  const expectedToken = process.env.LOCAL_API_TOKEN;
  if (expectedToken) {
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${expectedToken}`) {
      context.logger.warn(`[local-api] unauthorized request to ${requestUrl.pathname}`);
      return json({ error: 'Unauthorized' }, 401);
    }
  }

  if (requestUrl.pathname === '/api/local-status') {
    return json({
      success: true,
      mode: context.mode,
      port: context.port,
      apiDir: context.apiDir,
      remoteBase: context.remoteBase,
      cloudFallback: context.cloudFallback,
      routes: routes.length,
    });
  }
  if (requestUrl.pathname === '/api/local-traffic-log') {
    if (req.method === 'DELETE') {
      trafficLog.length = 0;
      return json({ cleared: true });
    }
    // Strip query strings from logged paths to avoid leaking feed URLs and
    // user research patterns to anyone who can read the traffic log.
    const sanitized = trafficLog.map(entry => ({
      ...entry,
      path: entry.path?.split('?')[0] ?? entry.path,
    }));
    return json({ entries: sanitized, verboseMode, maxEntries: TRAFFIC_LOG_MAX });
  }
  if (requestUrl.pathname === '/api/local-debug-toggle') {
    if (req.method === 'POST') {
      verboseMode = !verboseMode;
      saveVerboseState();
      context.logger.log(`[local-api] verbose logging ${verboseMode ? 'ON' : 'OFF'}`);
    }
    return json({ verboseMode });
  }
  // Registration — call Convex directly (desktop frontend bypasses sidecar for this endpoint;
  // this handler only runs when CONVEX_URL is available, e.g. self-hosted deployments)
  if (requestUrl.pathname === '/api/register-interest' && req.method === 'POST') {
    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      return json({ error: 'Registration service not configured — use cloud endpoint directly' }, 503);
    }
    try {
      const body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
      });
      const parsed = JSON.parse(body);
      const email = parsed.email;
      if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'Invalid email address' }, 400);
      }
      const response = await fetchWithTimeout(`${convexUrl}/api/mutation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'registerInterest:register',
          args: { email, source: parsed.source || 'desktop', appVersion: parsed.appVersion || 'unknown' },
          format: 'json',
        }),
      }, 15000);
      const responseBody = await response.text();
      let result;
      try { result = JSON.parse(responseBody); } catch { result = { status: 'registered' }; }
      if (result.status === 'error') {
        return json({ error: result.errorMessage || 'Registration failed' }, 500);
      }
      return json(result.value || result);
    } catch (e) {
      context.logger.error(`[register-interest] error: ${e.message}`);
      return json({ error: 'Registration service unreachable' }, 502);
    }
  }

  // RSS proxy — fetch public feeds with SSRF protection
  if (requestUrl.pathname === '/api/rss-proxy') {
    const feedUrl = requestUrl.searchParams.get('url');
    if (!feedUrl) return json({ error: 'Missing url parameter' }, 400);

    // SSRF protection: block private IPs, reserved ranges, and DNS rebinding
    const safety = await isSafeUrl(feedUrl);
    if (!safety.safe) {
      context.logger.warn(`[local-api] rss-proxy SSRF blocked: ${safety.reason} (url=${feedUrl})`);
      return json({ error: safety.reason }, 403);
    }

    try {
      const parsed = new URL(feedUrl);
      // Pin to the first IPv4 address validated by isSafeUrl() so the
      // actual TCP connection goes to the same IP we checked, closing
      // the TOCTOU DNS-rebinding window.
      const pinnedV4 = safety.resolvedAddresses?.find(a => a.includes('.'));
      const response = await fetchWithTimeout(feedUrl, {
        headers: {
          'User-Agent': CHROME_UA,
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        ...(pinnedV4 ? { resolvedAddress: pinnedV4 } : {}),
      }, parsed.hostname.includes('news.google.com') ? 20000 : 12000);
      const contentType = response.headers?.get?.('content-type') || 'application/xml';
      const rssBody = await response.text();
      return new Response(rssBody || '', {
        status: response.status,
        headers: { 'content-type': contentType },
      });
    } catch (e) {
      const isTimeout = e.name === 'AbortError' || e.message?.includes('timeout');
      return json({ error: isTimeout ? 'Feed timeout' : 'Failed to fetch feed', url: feedUrl }, isTimeout ? 504 : 502);
    }
  }

  if (requestUrl.pathname === '/api/local-env-update') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body) {
        try {
          const { key, value } = JSON.parse(body.toString());
          if (typeof key === 'string' && key.length > 0 && ALLOWED_ENV_KEYS.has(key)) {
            if (value == null || value === '') {
              delete process.env[key];
              context.logger.log(`[local-api] env unset: ${key}`);
            } else {
              process.env[key] = String(value);
              context.logger.log(`[local-api] env set: ${key}`);
            }
            moduleCache.clear();
            failedImports.clear();
            cloudPreferred.clear();
            return json({ ok: true, key });
          }
          return json({ error: 'key not in allowlist' }, 403);
        } catch { /* bad JSON */ }
      }
      return json({ error: 'expected { key, value }' }, 400);
    }
    return json({ error: 'POST required' }, 405);
  }

  if (requestUrl.pathname === '/api/local-validate-secret') {
    if (req.method !== 'POST') {
      return json({ error: 'POST required' }, 405);
    }
    const body = await readBody(req);
    if (!body) return json({ error: 'expected { key, value }' }, 400);
    try {
      const { key, value, context } = JSON.parse(body.toString());
      if (typeof key !== 'string' || !ALLOWED_ENV_KEYS.has(key)) {
        return json({ error: 'key not in allowlist' }, 403);
      }
      const safeContext = (context && typeof context === 'object') ? context : {};
      const result = await validateSecretAgainstProvider(key, value, safeContext);
      return json(result, result.valid ? 200 : 422);
    } catch {
      return json({ error: 'expected { key, value }' }, 400);
    }
  }

  if (context.cloudFallback && cloudPreferred.has(requestUrl.pathname)) {
    const cloudResponse = await tryCloudFallback(requestUrl, req, context);
    if (cloudResponse) return cloudResponse;
  }

  const modulePath = pickModule(requestUrl.pathname, routes);
  if (!modulePath || !existsSync(modulePath)) {
    if (context.cloudFallback) {
      const cloudResponse = await tryCloudFallback(requestUrl, req, context, 'handler missing');
      if (cloudResponse) return cloudResponse;
    }
    logOnce(context.logger, requestUrl.pathname, 'no local handler');
    return json({ error: 'No local handler for this endpoint', endpoint: requestUrl.pathname }, 404);
  }

  try {
    const mod = await importHandler(modulePath);
    if (typeof mod.default !== 'function') {
      logOnce(context.logger, requestUrl.pathname, 'invalid handler module');
      if (context.cloudFallback) {
        const cloudResponse = await tryCloudFallback(requestUrl, req, context, `invalid handler module`);
        if (cloudResponse) return cloudResponse;
      }
      return json({ error: 'Invalid handler module', endpoint: requestUrl.pathname }, 500);
    }

    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const request = new Request(requestUrl.toString(), {
      method: req.method,
      headers: toHeaders(req.headers, { stripOrigin: true }),
      body,
    });

    const response = await mod.default(request);
    if (!(response instanceof Response)) {
      logOnce(context.logger, requestUrl.pathname, 'handler returned non-Response');
      if (context.cloudFallback) {
        const cloudResponse = await tryCloudFallback(requestUrl, req, context, 'handler returned non-Response');
        if (cloudResponse) return cloudResponse;
      }
      return json({ error: 'Handler returned invalid response', endpoint: requestUrl.pathname }, 500);
    }

    if (!response.ok && context.cloudFallback) {
      const cloudResponse = await tryCloudFallback(requestUrl, req, context, `local status ${response.status}`);
      if (cloudResponse) { cloudPreferred.add(requestUrl.pathname); return cloudResponse; }
    }

    return response;
  } catch (error) {
    const reason = error.code === 'ERR_MODULE_NOT_FOUND' ? 'missing dependency' : error.message;
    context.logger.error(`[local-api] ${requestUrl.pathname} → ${reason}`);
    if (context.cloudFallback) {
      const cloudResponse = await tryCloudFallback(requestUrl, req, context, error);
      if (cloudResponse) { cloudPreferred.add(requestUrl.pathname); return cloudResponse; }
    }
    return json({ error: 'Local handler error', reason, endpoint: requestUrl.pathname }, 502);
  }
}

export async function createLocalApiServer(options = {}) {
  const context = resolveConfig(options);
  loadVerboseState(context.dataDir);
  const routes = await buildRouteTable(context.apiDir);

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${context.port}`);

    if (!requestUrl.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json', ...makeCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const start = Date.now();
    const skipRecord = req.method === 'OPTIONS'
      || requestUrl.pathname === '/api/local-traffic-log'
      || requestUrl.pathname === '/api/local-debug-toggle'
      || requestUrl.pathname === '/api/local-env-update'
      || requestUrl.pathname === '/api/local-validate-secret';

    try {
      const response = await dispatch(requestUrl, req, routes, context);
      const durationMs = Date.now() - start;
      let body = Buffer.from(await response.arrayBuffer());
      const headers = Object.fromEntries(response.headers.entries());
      const corsOrigin = getSidecarCorsOrigin(req);
      headers['access-control-allow-origin'] = corsOrigin;
      headers['vary'] = appendVary(headers['vary'], 'Origin');

      if (!skipRecord) {
        recordTraffic({
          timestamp: new Date().toISOString(),
          method: req.method,
          path: requestUrl.pathname + (requestUrl.search || ''),
          status: response.status,
          durationMs,
        });
      }

      const acceptEncoding = req.headers['accept-encoding'] || '';
      body = await maybeCompressResponseBody(body, headers, acceptEncoding);

      if (headers['content-encoding']) {
        delete headers['content-length'];
      }

      res.writeHead(response.status, headers);
      res.end(body);
    } catch (error) {
      const durationMs = Date.now() - start;
      context.logger.error('[local-api] fatal', error);

      if (!skipRecord) {
        recordTraffic({
          timestamp: new Date().toISOString(),
          method: req.method,
          path: requestUrl.pathname + (requestUrl.search || ''),
          status: 500,
          durationMs,
          error: error.message,
        });
      }

      res.writeHead(500, { 'content-type': 'application/json', ...makeCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  return {
    context,
    routes,
    server,
    async start() {
      const tryListen = (port) => new Promise((resolve, reject) => {
        const onListening = () => { server.off('error', onError); resolve(); };
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        server.once('listening', onListening);
        server.once('error', onError);
        server.listen(port, '127.0.0.1');
      });

      try {
        await tryListen(context.port);
      } catch (err) {
        if (err?.code === 'EADDRINUSE') {
          context.logger.log(`[local-api] port ${context.port} busy, falling back to OS-assigned port`);
          await tryListen(0);
        } else {
          throw err;
        }
      }

      const address = server.address();
      const boundPort = typeof address === 'object' && address?.port ? address.port : context.port;
      context.port = boundPort;

      const portFile = process.env.LOCAL_API_PORT_FILE;
      if (portFile) {
        try { writeFileSync(portFile, String(boundPort)); } catch {}
      }

      context.logger.log(`[local-api] listening on http://127.0.0.1:${boundPort} (apiDir=${context.apiDir}, routes=${routes.length}, cloudFallback=${context.cloudFallback})`);
      return { port: boundPort };
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

if (isMainModule()) {
  try {
    const app = await createLocalApiServer();
    await app.start();
  } catch (error) {
    console.error('[local-api] startup failed', error);
    process.exit(1);
  }
}
