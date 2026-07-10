#!/usr/bin/env node
import http, { createServer } from 'node:http';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import dns from 'node:dns/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { brotliCompress, gzipSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const brotliCompressAsync = promisify(brotliCompress);
const DESKTOP_AUTH_SECRET_ENV = 'WM_DESKTOP_SHARED_SECRET';
const DESKTOP_AUTH_TIMESTAMP_HEADER = 'X-WorldMonitor-Desktop-Timestamp';
const DESKTOP_AUTH_SIGNATURE_HEADER = 'X-WorldMonitor-Desktop-Signature';

// Monkey-patch globalThis.fetch to force IPv4 for HTTPS requests.
// Node.js built-in fetch (undici) tries IPv6 first via Happy Eyeballs.
// Government APIs (EIA, NASA FIRMS, FRED) publish AAAA records but their
// IPv6 endpoints time out, causing ETIMEDOUT. This override ensures ALL
// fetch() calls in dynamically-loaded handler modules (api/*.js) use IPv4.
const _originalFetch = globalThis.fetch;
const ALLOW_PRIVATE_NETWORK_FETCH = Symbol('worldmonitor.allowPrivateNetworkFetch');
const sidecarAllowedPrivateFetchOrigins = new Set();

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

function canonicalizeDesktopAuthPayload(payload) {
  return JSON.stringify({
    email: typeof payload?.email === 'string' ? payload.email : '',
    source: typeof payload?.source === 'string' ? payload.source : '',
    appVersion: typeof payload?.appVersion === 'string' ? payload.appVersion : '',
    referredBy: typeof payload?.referredBy === 'string' ? payload.referredBy : '',
    website: typeof payload?.website === 'string' ? payload.website : '',
    turnstileToken: typeof payload?.turnstileToken === 'string' ? payload.turnstileToken : '',
  });
}

function signDesktopAuthPayload(secret, timestamp, payload) {
  const message = `${timestamp}\n${canonicalizeDesktopAuthPayload(payload)}`;
  return `sha256=${createHmac('sha256', secret).update(message).digest('hex')}`;
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

// Global concurrency limiter for upstream requests.
let _activeUpstream = 0;
const _upstreamQueue = [];
const MAX_CONCURRENT_UPSTREAM = 6;
function acquireUpstreamSlot() {
  if (_activeUpstream < MAX_CONCURRENT_UPSTREAM) {
    _activeUpstream++;
    return Promise.resolve();
  }
  return new Promise(resolve => _upstreamQueue.push(resolve));
}
function releaseUpstreamSlot() {
  if (_upstreamQueue.length > 0) {
    _upstreamQueue.shift()();
  } else {
    _activeUpstream--;
  }
}

// Global Yahoo Finance rate gate — shared across ALL handler bundles.
let _yahooLastReq = 0;
let _yahooQueue = Promise.resolve();
function sidecarYahooGate() {
  _yahooQueue = _yahooQueue.then(async () => {
    const elapsed = Date.now() - _yahooLastReq;
    if (elapsed < 600) await new Promise(r => setTimeout(r, 600 - elapsed));
    _yahooLastReq = Date.now();
  });
  return _yahooQueue;
}

function redactUrlForLog(rawUrl) {
  try {
    const redacted = new URL(String(rawUrl));
    redacted.username = '';
    redacted.password = '';
    redacted.search = '';
    redacted.hash = '';
    return redacted.toString();
  } catch {
    return String(rawUrl);
  }
}

function makeSsrfBlockedError(reason, rawUrl) {
  const error = new Error(`SSRF blocked: ${reason} (url=${redactUrlForLog(rawUrl)})`);
  error.code = 'ERR_SSRF_BLOCKED';
  return error;
}

function firstIPv4Address(addresses = []) {
  return addresses.find((addr) => isIP(addr) === 4) ?? null;
}

function firstIPv6Address(addresses = []) {
  return addresses.find((addr) => isIP(addr) === 6) ?? null;
}

// IPv4-first, IPv6 fallback. Returning the family alongside the address lets
// the caller pin both the lookup callback AND http(s).request({ family })
// to the same family — otherwise an IPv6-only public hostname would be
// validated against AAAA records but reconnected under family:4 by the OS,
// reopening the TOCTOU window the pinned lookup is meant to close.
function pickPinnedAddress(addresses = []) {
  const v4 = firstIPv4Address(addresses);
  if (v4) return { address: v4, family: 4 };
  const v6 = firstIPv6Address(addresses);
  if (v6) return { address: v6, family: 6 };
  return null;
}

function makePinnedLookup(address, family = 4) {
  return (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const lookupOptions = typeof options === 'object' && options !== null ? options : {};
    queueMicrotask(() => {
      if (lookupOptions.all) cb(null, [{ address, family }]);
      else cb(null, address, family);
    });
  };
}

function registerSidecarAllowedPrivateFetchOrigins(port, extraOrigins = []) {
  const origins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...extraOrigins,
  ];
  for (const origin of origins) sidecarAllowedPrivateFetchOrigins.add(origin);
  return () => {
    for (const origin of origins) sidecarAllowedPrivateFetchOrigins.delete(origin);
  };
}

function isAllowedPrivateSidecarFetch(url) {
  return sidecarAllowedPrivateFetchOrigins.has(url.origin);
}

async function assertSafeSidecarFetchUrl(url) {
  if (isAllowedPrivateSidecarFetch(url)) {
    return { safe: true, resolvedAddresses: [url.hostname] };
  }

  const safety = await isSafeUrl(url.toString());
  if (!safety.safe) {
    throw makeSsrfBlockedError(safety.reason, url.toString());
  }
  return safety;
}

globalThis.fetch = async function ipv4Fetch(input, init) {
  const isRequest = input && typeof input === 'object' && 'url' in input;
  let url;
  try { url = new URL(typeof input === 'string' ? input : input.url); } catch { return _originalFetch(input, init); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return _originalFetch(input, init);
  const allowPrivateNetwork = init?.[ALLOW_PRIVATE_NETWORK_FETCH] === true;
  const safety = allowPrivateNetwork
    ? { safe: true, resolvedAddresses: [url.hostname] }
    : await assertSafeSidecarFetchUrl(url);
  if (url.hostname.includes('finance.yahoo.com')) await sidecarYahooGate();
  await acquireUpstreamSlot();
  try {
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
    const pinned = isAllowedPrivateSidecarFetch(url) ? null : pickPinnedAddress(safety.resolvedAddresses);
    const requestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      // Default to IPv4 (broken-IPv6 servers like EIA/NASA FIRMS); when we
      // pinned a specific address, use its family so http(s).request and the
      // lookup callback agree.
      family: pinned?.family ?? 4,
    };
    if (pinned) {
      requestOptions.lookup = makePinnedLookup(pinned.address, pinned.family);
    }
    return await new Promise((resolve, reject) => {
      const req = mod.request(requestOptions, (res) => {
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
  } finally {
    releaseUpstreamSlot();
  }
};

const ALLOWED_ENV_KEYS = new Set([
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'EXA_API_KEYS', 'BRAVE_API_KEYS', 'SERPAPI_API_KEYS', 'FRED_API_KEY', 'EIA_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'ACLED_ACCESS_TOKEN', 'URLHAUS_AUTH_KEY',
  'OTX_API_KEY', 'ABUSEIPDB_API_KEY', 'WINGBITS_API_KEY', 'WS_RELAY_URL',
  'VITE_OPENSKY_RELAY_URL', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET',
  'AISSTREAM_API_KEY', 'VITE_WS_RELAY_URL', 'FINNHUB_API_KEY', 'NASA_FIRMS_API_KEY',
  'OLLAMA_API_URL', 'OLLAMA_MODEL', 'WORLDMONITOR_API_KEY', 'WTO_API_KEY',
  'AVIATIONSTACK_API', 'ICAO_API_KEY', 'UCDP_ACCESS_TOKEN', DESKTOP_AUTH_SECRET_ENV,
]);

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── SSRF protection ──────────────────────────────────────────────────────
// Block requests to private/reserved IP ranges to prevent the RSS proxy
// from being used as a localhost pivot or internal network scanner.

function ipv4ToInt(parts) {
  return (
    ((parts[0] << 24) >>> 0) +
    (parts[1] << 16) +
    (parts[2] << 8) +
    parts[3]
  ) >>> 0;
}

const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],       // "this" network
  ['10.0.0.0', 8],      // RFC1918 private
  ['100.64.0.0', 10],   // carrier-grade NAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local
  ['172.16.0.0', 12],   // RFC1918 private
  ['192.0.0.0', 24],    // IETF protocol assignments
  ['192.0.2.0', 24],    // documentation
  ['192.88.99.0', 24],  // deprecated 6to4 relay anycast
  ['192.168.0.0', 16],  // RFC1918 private
  ['198.18.0.0', 15],   // benchmark testing
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24],  // documentation
  ['224.0.0.0', 3],     // multicast, reserved, limited broadcast
].map(([base, prefix]) => {
  const baseInt = ipv4ToInt(base.split('.').map(Number));
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [baseInt, mask];
});

function isPrivateIP(ip) {
  // IPv4-mapped IPv6 — extract the v4 portion
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const addr = v4Mapped ? v4Mapped[1] : ip;

  // IPv6 loopback
  if (addr === '::1' || addr === '::') return true;

  // IPv6 link-local / unique-local
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true; // fc00::/7 (ULA)
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;  // fe80::/10 (link-local)
  if (/^ff[0-9a-f]{2}:/i.test(addr)) return true;      // ff00::/8 multicast

  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false; // not an IPv4

  const ipInt = ipv4ToInt(parts);
  return BLOCKED_IPV4_RANGES.some(([baseInt, mask]) => {
    return (ipInt & mask) === (baseInt & mask);
  });
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
  if (isIP(ipLiteral)) {
    return { safe: true, resolvedAddresses: [ipLiteral] };
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
  const headers = toHeaders(req.headers, { stripOrigin: true });
  // Strip sidecar auth token — meaningless to cloud API.
  headers.delete('Authorization');
  // Strip conditional headers so cloud always returns fresh 200, not 304.
  // The browser may have stale ETags from previous sessions with empty data.
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  // Identify sidecar as trusted origin so the cloud API key validator
  // doesn't reject the request (no origin + no key = 401).
  headers.set('Origin', 'https://worldmonitor.app');
  // Inject the configured enterprise key for cloud calls that pass through the
  // sidecar so auth-gated endpoints (e.g. /api/mcp-proxy per PR #3768, issue
  // #3723) succeed without each renderer call having to attach it. Renderer-
  // supplied X-WorldMonitor-Key (e.g. a wm_ user key from runtime config) wins
  // — don't clobber it.
  if (!headers.has('X-WorldMonitor-Key')) {
    const wmKey = process.env.WORLDMONITOR_API_KEY;
    if (wmKey) headers.set('X-WorldMonitor-Key', wmKey);
  }
  return fetch(target, {
    method: req.method,
    headers,
    body,
  });
}

async function proxyRegisterInterestToCloud(requestUrl, req, context) {
  const target = `${context.remoteBase}${requestUrl.pathname}${requestUrl.search}`;
  const bodyBuffer = await readBody(req);
  let payload = {};
  if (bodyBuffer?.length) {
    try {
      payload = JSON.parse(bodyBuffer.toString('utf8'));
    } catch {
      payload = {};
    }
  }

  const normalizedPayload = {
    ...payload,
    source: 'desktop-settings',
  };
  const body = JSON.stringify(normalizedPayload);
  const headers = toHeaders(req.headers, { stripOrigin: true });
  headers.delete('Authorization');
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  headers.delete('Transfer-Encoding');
  headers.delete('Content-Encoding');
  headers.delete('Connection');
  headers.delete('Expect');
  headers.delete(DESKTOP_AUTH_TIMESTAMP_HEADER);
  headers.delete(DESKTOP_AUTH_SIGNATURE_HEADER);
  headers.set('Origin', 'https://worldmonitor.app');
  headers.set('User-Agent', CHROME_UA);
  headers.set('Content-Type', 'application/json');
  headers.set('Content-Length', String(Buffer.byteLength(body)));

  const secret = process.env[DESKTOP_AUTH_SECRET_ENV];
  if (secret) {
    const timestamp = String(Date.now());
    headers.set(DESKTOP_AUTH_TIMESTAMP_HEADER, timestamp);
    headers.set(DESKTOP_AUTH_SIGNATURE_HEADER, signDesktopAuthPayload(secret, timestamp, normalizedPayload));
  }

  return fetchWithTimeout(target, {
    method: 'POST',
    headers: Object.fromEntries(headers.entries()),
    body,
  }, 15000);
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

// Routes/prefixes that should always proxy to cloud. The sidecar lacks
// WS_RELAY_URL (Yahoo/Finnhub relay) and seeded Redis data. These routes
// return 200-with-empty-data locally, so normal cloudFallback won't trigger.
const cloudPreferredPrefixes = !process.env.WS_RELAY_URL
  ? [
    '/api/market/v1/',
    '/api/economic/v1/',
    '/api/infrastructure/v1/',
    '/api/news/v1/',
    '/api/research/v1/',
  ]
  : [];
const cloudPreferredExact = !process.env.WS_RELAY_URL
  ? new Set(['/api/bootstrap'])
  : new Set();

function isCloudPreferred(pathname) {
  if (cloudPreferred.has(pathname)) return true;
  if (cloudPreferredExact.has(pathname)) return true;
  return cloudPreferredPrefixes.some(p => pathname.startsWith(p));
}

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

function remoteBaseLooksPrivate(remoteBase) {
  let parsed;
  try { parsed = new URL(remoteBase); } catch { return false; }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost') return true;
  if (isIP(hostname)) return isPrivateIP(hostname);
  return false;
}

function resolveConfig(options = {}) {
  const port = Number(options.port ?? process.env.LOCAL_API_PORT ?? 46123);
  const remoteBase = String(options.remoteBase ?? process.env.LOCAL_API_REMOTE_BASE ?? 'https://api.worldmonitor.app').replace(/\/$/, '');
  const resourceDir = String(options.resourceDir ?? process.env.LOCAL_API_RESOURCE_DIR ?? process.cwd());
  const apiDir = options.apiDir
    ? String(options.apiDir)
    : [
      path.join(resourceDir, 'api'),
      path.join(resourceDir, '_up_', 'api'),
    ].find((candidate) => existsSync(candidate)) ?? path.join(resourceDir, 'api');
  const dataDir = String(options.dataDir ?? process.env.LOCAL_API_DATA_DIR ?? resourceDir);
  const mode = String(options.mode ?? process.env.LOCAL_API_MODE ?? 'desktop-sidecar');
  const requestedFallback = String(options.cloudFallback ?? process.env.LOCAL_API_CLOUD_FALLBACK ?? '') === 'true';
  const cloudFallback = mode === 'docker' ? false : requestedFallback;
  // Programmatic dev/test escape hatch only; CLI/env startup keeps private remoteBase blocked.
  const allowPrivateRemoteBase = options.allowPrivateRemoteBase === true;
  // Programmatic-only test escape hatch for adding extra origins to the
  // private-fetch allowlist (e.g. distinct upstream test servers). Mirrors
  // allowPrivateRemoteBase: no env-var path, so production startup can't
  // widen the SSRF boundary by accident.
  const allowPrivateFetchOrigins = Array.isArray(options.allowPrivateFetchOrigins)
    ? options.allowPrivateFetchOrigins.filter((o) => typeof o === 'string' && o.length > 0)
    : [];
  const logger = options.logger ?? console;
  if (mode === 'docker' && requestedFallback) {
    logger.warn('[local-api] Cloud fallback disabled in Docker mode (self-hosted instances must not proxy to api.worldmonitor.app)');
  }
  if (cloudFallback && !allowPrivateRemoteBase && remoteBaseLooksPrivate(remoteBase)) {
    logger.warn(
      `[local-api] cloudFallback enabled but remoteBase=${remoteBase} is private/loopback; ` +
      'requests will be blocked by SSRF protection. Pass allowPrivateRemoteBase=true programmatically for dev/test.'
    );
  }

  return {
    port,
    remoteBase,
    resourceDir,
    dataDir,
    apiDir,
    mode,
    cloudFallback,
    allowPrivateRemoteBase,
    allowPrivateFetchOrigins,
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
    const resp = await proxyToCloud(requestUrl, req, context.remoteBase);
    if (!resp.ok) {
      context.logger.warn(`[local-api] cloud returned ${resp.status} for ${requestUrl.pathname}`);
    }
    return resp;
  } catch (error) {
    if (error?.code === 'ERR_SSRF_BLOCKED') {
      // error.message already carries "SSRF blocked: <reason> (url=<redacted>)".
      // Surface the actionable remediation so a misconfigured LOCAL_API_REMOTE_BASE
      // doesn't read as a vague 5xx.
      context.logger.error(
        `[local-api] cloud fallback blocked by SSRF protection for ${requestUrl.pathname}: ${error.message}. ` +
        'If remoteBase intentionally points at a private/loopback host, pass allowPrivateRemoteBase=true programmatically.'
      );
    } else {
      context.logger.error('[local-api] cloud fallback failed', requestUrl.pathname, error);
    }
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Desktop-Timestamp, X-WorldMonitor-Desktop-Signature',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  // Use node:https with IPv4 forced — Node.js built-in fetch (undici) tries IPv6
  // first and some servers (EIA, NASA FIRMS) have broken IPv6 causing ETIMEDOUT.
  const u = new URL(url);
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  const fetchOptions = { ...options };
  delete fetchOptions.allowPrivateNetwork;
  if (u.protocol === 'https:') {
    return new Promise((resolve, reject) => {
      const reqOpts = {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: fetchOptions.method || 'GET',
        headers: fetchOptions.headers || {},
        family: 4,
      };
      // Pin to a pre-resolved IP to prevent TOCTOU DNS rebinding.
      // The hostname is kept for SNI / TLS certificate validation.
      if (fetchOptions.resolvedAddress) {
        reqOpts.lookup = makePinnedLookup(fetchOptions.resolvedAddress, 4);
      }
      const req = https.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          try {
            resolve(buildSafeResponse(res.statusCode, res.statusMessage, headers, body));
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out')); });
      if (fetchOptions.body) {
        const body = normalizeRequestBody(fetchOptions.body);
        if (body != null) req.write(body);
      }
      req.end();
    });
  }
  // HTTP fallback (localhost sidecar, etc.)
  // For pinned addresses on plain HTTP, rewrite the URL to connect to the
  // validated IP and set the Host header so virtual-host routing still works.
  let fetchUrl = url;
  const fetchHeaders = { ...(fetchOptions.headers || {}) };
  if (fetchOptions.resolvedAddress && u.protocol === 'http:') {
    const pinned = new URL(url);
    fetchHeaders['Host'] = pinned.host;
    pinned.hostname = fetchOptions.resolvedAddress;
    fetchUrl = pinned.toString();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestOptions = { ...fetchOptions, headers: fetchHeaders, signal: controller.signal };
    if (allowPrivateNetwork) requestOptions[ALLOW_PRIVATE_NETWORK_FETCH] = true;
    return await fetch(fetchUrl, requestOptions);
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
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().split('T')[0];
      const acledProbeUrl = `https://acleddata.com/api/acled/read?event_type=Protests&event_date=${fmt(weekAgo)}|${fmt(now)}&event_date_where=BETWEEN&limit=1&_format=json`;
      const response = await fetchWithTimeout(acledProbeUrl, {
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
      const response = await fetchWithTimeout(`https://finnhub.io/api/v1/quote?symbol=AAPL`, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA, 'X-Finnhub-Token': value },
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

    case 'UCDP_ACCESS_TOKEN': {
      const year = new Date().getFullYear() - 2000;
      const candidates = [...new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1'])];
      for (const version of candidates) {
        try {
          const response = await fetchWithTimeout(
            `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=1`,
            { headers: { Accept: 'application/json', 'x-ucdp-access-token': value, 'User-Agent': CHROME_UA } }
          );
          if (isAuthFailure(response.status)) return fail('UCDP rejected this token');
          if (!response.ok) continue;
          const text = await response.text();
          let payload = null;
          try { payload = JSON.parse(text); } catch { /* ignore */ }
          if (Array.isArray(payload?.Result)) return ok(`UCDP token verified (GED v${version})`);
        } catch { continue; }
      }
      return fail('Could not verify UCDP token (all GED versions failed)');
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
      const response = await fetchWithTimeout(probeUrl, { method: 'GET', allowPrivateNetwork: true }, 8000);
      if (!response.ok) {
        // Fall back to native Ollama /api/tags endpoint
        try {
          const tagsUrl = new URL('/api/tags', value).toString();
          const tagsResponse = await fetchWithTimeout(tagsUrl, { method: 'GET', allowPrivateNetwork: true }, 8000);
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

    case 'AVIATIONSTACK_API': {
      const response = await fetchWithTimeout(
        `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(value)}&limit=1`,
        { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } }
      );
      const text = await response.text();
      if (isCloudflareChallenge403(response, text)) return ok('AviationStack key stored (Cloudflare blocked verification)');
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* ignore */ }
      if (payload?.error?.code === 101 || payload?.error?.code === 105) return fail('AviationStack rejected this key');
      if (!response.ok && response.status !== 200) return fail(`AviationStack probe failed (${response.status})`);
      return ok('AviationStack key verified');
    }

    case 'ICAO_API_KEY':
      return ok('ICAO API key stored (verification requires NOTAM endpoint access)');

    case DESKTOP_AUTH_SECRET_ENV:
      return ok('Desktop shared secret stored');

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

  // Liveness probe — exempt from auth so container/orchestrator healthchecks
  // can hit it without the per-session LOCAL_API_TOKEN. Deliberately minimal
  // and dependency-free: a 200 here proves the sidecar process is up and
  // routing (and, when reached via nginx /api/, that the whole request path
  // works end-to-end). Does not touch cloud, Redis, or any data source.
  if (requestUrl.pathname === '/api/sidecar-health') {
    return json({ status: 'ok', mode: context.mode, port: context.port });
  }

  // Health check — exempt from auth to support external monitoring tools
  if (requestUrl.pathname === '/api/service-status') {
    return handleLocalServiceStatus(context);
  }

  // HLS proxy — exempt from auth because <video src="..."> cannot carry
  // custom headers.  Proxies HLS manifests and segments from allowlisted CDN
  // hosts, adding the required Referer header that browsers cannot set.
  // Desktop-only (sidecar); web uses YouTube fallback.
  if (requestUrl.pathname === '/api/hls-proxy') {
    const ALLOWED_HLS_HOSTS = new Set(['cdn-ca2-na.lncnetworks.host']);
    const upstreamRaw = requestUrl.searchParams.get('url');
    if (!upstreamRaw) return new Response('Missing url param', { status: 400, headers: { 'content-type': 'text/plain', ...makeCorsHeaders(req) } });
    let upstream;
    try { upstream = new URL(upstreamRaw); } catch { return new Response('Invalid url', { status: 400, headers: { 'content-type': 'text/plain', ...makeCorsHeaders(req) } }); }
    if (upstream.protocol !== 'https:' || !ALLOWED_HLS_HOSTS.has(upstream.hostname)) {
      return new Response('Host not allowed', { status: 403, headers: { 'content-type': 'text/plain', ...makeCorsHeaders(req) } });
    }
    try {
      const hlsResp = await new Promise((resolve, reject) => {
        const reqOpts = {
          hostname: upstream.hostname,
          port: 443,
          path: upstream.pathname + upstream.search,
          method: 'GET',
          headers: { 'Referer': 'https://livenewschat.eu/', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
          family: 4,
        };
        const r = https.request(reqOpts, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        r.on('error', reject);
        r.setTimeout(10000, () => r.destroy(new Error('HLS upstream timeout')));
        r.end();
      });
      if (hlsResp.status < 200 || hlsResp.status >= 300) {
        return new Response(`Upstream ${hlsResp.status}`, { status: hlsResp.status, headers: { 'content-type': 'text/plain', ...makeCorsHeaders(req) } });
      }
      const ct = hlsResp.headers['content-type'] || '';
      const isManifest = upstreamRaw.endsWith('.m3u8') || ct.includes('mpegurl') || ct.includes('x-mpegurl');
      if (isManifest) {
        const basePath = upstream.pathname.substring(0, upstream.pathname.lastIndexOf('/') + 1);
        const baseOrigin = upstream.origin;
        let manifest = hlsResp.body.toString('utf-8');
        manifest = manifest.replace(/^(?!#)(\S+)/gm, (match) => {
          const full = match.startsWith('http') ? match : `${baseOrigin}${basePath}${match}`;
          return `/api/hls-proxy?url=${encodeURIComponent(full)}`;
        });
        manifest = manifest.replace(/URI="([^"]+)"/g, (_m, uri) => {
          const full = uri.startsWith('http') ? uri : `${baseOrigin}${basePath}${uri}`;
          return `URI="/api/hls-proxy?url=${encodeURIComponent(full)}"`;
        });
        return new Response(manifest, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache', ...makeCorsHeaders(req) } });
      }
      return new Response(hlsResp.body, { status: 200, headers: { 'content-type': ct || 'application/octet-stream', 'cache-control': 'no-cache', ...makeCorsHeaders(req) } });
    } catch (e) {
      context.logger.warn('[hls-proxy] error:', e.message);
      return new Response('Proxy error', { status: 502, headers: { 'content-type': 'text/plain', ...makeCorsHeaders(req) } });
    }
  }

  // YouTube embed bridge — exempt from auth because iframe src cannot carry
  // Authorization headers.  Serves a minimal HTML page that loads the YouTube
  // IFrame Player API from a localhost origin (which YouTube accepts, unlike
  // tauri://localhost).  No sensitive data is exposed.
  if (requestUrl.pathname === '/api/youtube-embed') {
    const videoId = requestUrl.searchParams.get('videoId');
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return new Response('Invalid videoId', { status: 400, headers: { 'content-type': 'text/plain' } });
    }
    const autoplay = requestUrl.searchParams.get('autoplay') === '0' ? '0' : '1';
    const mute = requestUrl.searchParams.get('mute') === '0' ? '0' : '1';
    const vq = ['small','medium','large','hd720','hd1080'].includes(requestUrl.searchParams.get('vq') || '') ? requestUrl.searchParams.get('vq') : '';
    const origin = `http://localhost:${context.port}`;
    // parentOrigin is the actual parent window origin (tauri://localhost, asset://localhost, etc.)
    // passed by the frontend so window.parent.postMessage reaches it. Only accept known desktop
    // schemes; fall back to '*' if absent or unrecognised.
    const rawParentOrigin = requestUrl.searchParams.get('parentOrigin') || '';
    const isAllowedParentOrigin = /^(tauri|asset):\/\/localhost$/.test(rawParentOrigin)
      || /^https?:\/\/localhost(:\d{1,5})?$/.test(rawParentOrigin)
      || /^https?:\/\/[\w-]+\.tauri\.localhost(:\d{1,5})?$/.test(rawParentOrigin);
    const parentOrigin = isAllowedParentOrigin ? rawParentOrigin : '*';
    const safeVideoId = JSON.stringify(String(videoId));
    const safeOrigin = JSON.stringify(origin);
    const safeParentOrigin = JSON.stringify(parentOrigin);
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="strict-origin-when-cross-origin"><style>html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}#player{width:100%;height:100%}#play-overlay{position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;pointer-events:none;background:rgba(0,0,0,0.15)}#play-overlay svg{width:72px;height:72px;opacity:0.9;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.5))}#play-overlay.hidden{display:none}</style></head><body><div id="player"></div><div id="play-overlay" class="hidden"><svg viewBox="0 0 68 48"><path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55C3.97 2.33 2.27 4.81 1.48 7.74.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="red"/><path d="M45 24L27 14v20" fill="#fff"/></svg></div><script>function tryStorageAccess(){if(document.requestStorageAccess){document.requestStorageAccess().catch(function(){})}}tryStorageAccess();var tag=document.createElement('script');tag.src='https://www.youtube.com/iframe_api';document.head.appendChild(tag);var player,overlay=document.getElementById('play-overlay'),started=false,muteSyncId,retryTimers=[];var obs=new MutationObserver(function(muts){for(var i=0;i<muts.length;i++){var nodes=muts[i].addedNodes;for(var j=0;j<nodes.length;j++){if(nodes[j].tagName==='IFRAME'){var a=nodes[j].getAttribute('allow')||'';if(a.indexOf('autoplay')===-1){nodes[j].setAttribute('allow','autoplay; encrypted-media; picture-in-picture; storage-access'+(a?'; '+a:''));console.log('[yt-embed] patched iframe allow=autoplay+storage-access')}obs.disconnect();return}}}});obs.observe(document.getElementById('player'),{childList:true,subtree:true});function hideOverlay(){overlay.classList.add('hidden')}function readMuted(){if(!player)return null;if(typeof player.isMuted==='function')return player.isMuted();if(typeof player.getVolume==='function')return player.getVolume()===0;return null}function stopMuteSync(){if(muteSyncId){clearInterval(muteSyncId);muteSyncId=null}}function startMuteSync(){if(muteSyncId)return;var last=readMuted();if(last!==null)window.parent.postMessage({type:'yt-mute-state',muted:last},${safeParentOrigin});muteSyncId=setInterval(function(){var m=readMuted();if(m!==null&&m!==last){last=m;window.parent.postMessage({type:'yt-mute-state',muted:m},${safeParentOrigin})}},500)}function tryAutoplay(){if(!player||!player.playVideo)return;try{player.mute();player.playVideo();console.log('[yt-embed] tryAutoplay: mute+play')}catch(e){}}function onYouTubeIframeAPIReady(){player=new YT.Player('player',{videoId:${safeVideoId},host:'https://www.youtube.com',playerVars:{autoplay:${autoplay},mute:${mute},playsinline:1,rel:0,controls:1,modestbranding:1,enablejsapi:1,origin:${safeOrigin},widget_referrer:${safeOrigin}},events:{onReady:function(){console.log('[yt-embed] onReady');window.parent.postMessage({type:'yt-ready'},${safeParentOrigin});${vq ? `if(player.setPlaybackQuality)player.setPlaybackQuality(${JSON.stringify(vq)});` : ''}if(${autoplay}===1){tryAutoplay();retryTimers.push(setTimeout(function(){if(!started)tryAutoplay()},500));retryTimers.push(setTimeout(function(){if(!started)tryAutoplay()},1500));retryTimers.push(setTimeout(function(){if(!started){console.log('[yt-embed] autoplay failed after retries');window.parent.postMessage({type:'yt-autoplay-failed'},${safeParentOrigin})}},2500))}startMuteSync()},onError:function(e){console.log('[yt-embed] error code='+e.data);stopMuteSync();window.parent.postMessage({type:'yt-error',code:e.data},${safeParentOrigin})},onStateChange:function(e){window.parent.postMessage({type:'yt-state',state:e.data},${safeParentOrigin});if(e.data===1||e.data===3){hideOverlay();started=true;retryTimers.forEach(clearTimeout);retryTimers=[]}}}})}setTimeout(function(){if(!started)overlay.classList.remove('hidden')},4000);window.addEventListener('message',function(e){if(!player||!player.getPlayerState)return;var m=e.data;if(!m||!m.type)return;switch(m.type){case'play':player.playVideo();break;case'pause':player.pauseVideo();break;case'mute':player.mute();break;case'unmute':player.unMute();break;case'loadVideo':if(m.videoId)player.loadVideoById(m.videoId);break;case'setQuality':if(m.quality&&player.setPlaybackQuality)player.setPlaybackQuality(m.quality);break}});window.addEventListener('beforeunload',function(){stopMuteSync();obs.disconnect();retryTimers.forEach(clearTimeout)})<\/script></body></html>`;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'permissions-policy': 'autoplay=*, encrypted-media=*, storage-access=(self "https://www.youtube.com")', ...makeCorsHeaders(req) } });
  }

  // ── Global auth gate ────────────────────────────────────────────────────
  // Every endpoint below requires a valid LOCAL_API_TOKEN.  This prevents
  // other local processes, malicious browser scripts, and rogue extensions
  // from accessing the sidecar API without the per-session token.
  //
  // Default-deny: if LOCAL_API_TOKEN is unset/empty we reject every request.
  // Treating "unset" as "auth disabled" turns any standalone sidecar run
  // (e.g. Docker mode) into an open local-HTTP proxy reachable by other
  // local users, browser tabs on allowed origins, etc. The Tauri Rust
  // shell always sets LOCAL_API_TOKEN at launch; production callers must
  // do the same.
  const expectedToken = process.env.LOCAL_API_TOKEN;
  if (!expectedToken) {
    context.logger.warn(
      `[local-api] LOCAL_API_TOKEN not set — refusing request to ${requestUrl.pathname}. ` +
      `Set LOCAL_API_TOKEN before starting the sidecar.`,
    );
    return json({ error: 'Service misconfigured: LOCAL_API_TOKEN not set' }, 503);
  }
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${expectedToken}`) {
    context.logger.warn(`[local-api] unauthorized request to ${requestUrl.pathname}`);
    return json({ error: 'Unauthorized' }, 401);
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
  // LLM health endpoint — mirrors probe logic from server/_shared/llm-health.ts.
  // TODO: refactor to import getLlmHealthStatus() once handlers share a process-level module cache.
  if (requestUrl.pathname === '/api/llm-health') {
    const PROBE_TIMEOUT = 2000;
    async function probeOrigin(url, options = {}) {
      try {
        await fetchWithTimeout(url, { method: 'GET', allowPrivateNetwork: options.allowPrivateNetwork === true }, PROBE_TIMEOUT);
        return true;
      } catch {
        return false;
      }
    }
    const providers = [];
    const providerChecks = [];
    const ollamaUrl = process.env.OLLAMA_API_URL || process.env.LLM_API_URL;
    const groqKey = process.env.GROQ_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

    if (ollamaUrl) {
      try {
        const origin = new URL(ollamaUrl).origin;
        providerChecks.push(
          probeOrigin(origin, { allowPrivateNetwork: true }).then((available) => ({ name: 'ollama', url: origin, available })),
        );
      } catch {}
    }
    if (groqKey?.startsWith('gsk_')) {
      providerChecks.push(
        probeOrigin('https://api.groq.com').then((available) => ({ name: 'groq', url: 'https://api.groq.com', available })),
      );
    }
    if (openrouterKey) {
      providerChecks.push(
        probeOrigin('https://openrouter.ai').then((available) => ({ name: 'openrouter', url: 'https://openrouter.ai', available })),
      );
    }
    if (providerChecks.length > 0) {
      providers.push(...(await Promise.all(providerChecks)));
    }

    const anyAvailable = providers.some(p => p.available);
    return json({ available: anyAvailable, providers, checkedAt: Date.now() });
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
  // Registration — call Convex directly when CONVEX_URL is available (self-hosted),
  // otherwise proxy to cloud (desktop sidecar never has CONVEX_URL).
  // Keeps the legacy /api/register-interest local path so older desktop builds
  // continue to work; cloud fallback rewrites to the new sebuf RPC path.
  if (requestUrl.pathname === '/api/register-interest' && req.method === 'POST') {
    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      const cloudUrl = new URL(requestUrl);
      cloudUrl.pathname = '/api/leads/v1/register-interest';
      try {
        const cloudResponse = await proxyRegisterInterestToCloud(cloudUrl, req, context);
        if (!cloudResponse.ok) {
          context.logger.warn(`[local-api] cloud returned ${cloudResponse.status} for ${cloudUrl.pathname}`);
        }
        return cloudResponse;
      } catch (error) {
        context.logger.error('[local-api] register-interest cloud fallback failed', error);
      }
      return json({ error: 'Registration service unavailable' }, 503);
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

  // YouTube live detection — requires residential proxy (Railway relay).
  // Direct fetch from sidecar fails (YouTube blocks datacenter IPs).
  // Always proxy to cloud, bypassing the cloudFallback flag.
  if (requestUrl.pathname === '/api/youtube/live') {
    const cloudResponse = await tryCloudFallback(requestUrl, req, context, 'youtube-live needs relay');
    if (cloudResponse) return cloudResponse;
    return json({ error: 'YouTube live detection unavailable' }, 503);
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

  if (requestUrl.pathname === '/api/local-env-update-batch') {
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
    const body = await readBody(req);
    if (!body) return json({ error: 'expected { entries: [{key, value}, ...] }' }, 400);
    try {
      const { entries } = JSON.parse(body.toString());
      if (!Array.isArray(entries)) return json({ error: 'entries must be an array' }, 400);
      if (entries.length > 50) return json({ error: 'too many entries (max 50)' }, 400);
      const results = [];
      for (const { key, value } of entries) {
        if (typeof key !== 'string' || !key.length || !ALLOWED_ENV_KEYS.has(key)) {
          results.push({ key, ok: false, error: 'not in allowlist' });
          continue;
        }
        if (value == null || value === '') {
          delete process.env[key];
          context.logger.log(`[local-api] env unset: ${key}`);
        } else {
          process.env[key] = String(value);
          context.logger.log(`[local-api] env set: ${key}`);
        }
        results.push({ key, ok: true });
      }
      if (results.some(r => r.ok)) {
        moduleCache.clear();
        failedImports.clear();
        cloudPreferred.clear();
      }
      return json({ ok: true, results });
    } catch { /* bad JSON */ }
    return json({ error: 'invalid JSON' }, 400);
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

  if (context.cloudFallback && isCloudPreferred(requestUrl.pathname)) {
    const cloudResponse = await tryCloudFallback(requestUrl, req, context, 'cloud-preferred');
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
    const hdrs = toHeaders(req.headers, { stripOrigin: true });
    hdrs.set('Origin', `http://127.0.0.1:${context.port}`);
    const request = new Request(requestUrl.toString(), {
      method: req.method,
      headers: hdrs,
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
    logOnce(context.logger, requestUrl.pathname, reason);
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
  let unregisterSelfFetchOrigins = null;

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
      || requestUrl.pathname === '/api/local-env-update-batch'
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
      const extraAllowedPrivateOrigins = [];
      // Docker self-host ONLY: the Redis REST proxy (UPSTASH_REDIS_REST_URL)
      // points at an internal private host (e.g. http://redis-rest:80 on a
      // docker network). Without trusting it the SSRF guard blocks every Redis
      // call and all /api/* return 503 REDIS_DOWN. Gated on mode === 'docker'
      // so desktop/production startup never widens the SSRF boundary via env
      // — the same containment as the cloudFallback=false docker policy above,
      // and the programmatic allowPrivateFetchOrigins escape hatch stays
      // env-free. On desktop UPSTASH_REDIS_REST_URL is a public Upstash https
      // origin that already passes the SSRF check, so this path is docker-only.
      if (context.mode === 'docker' && process.env.UPSTASH_REDIS_REST_URL) {
        try {
          extraAllowedPrivateOrigins.push(new URL(process.env.UPSTASH_REDIS_REST_URL).origin);
        } catch (err) {
          context.logger.warn(
            `[local-api] UPSTASH_REDIS_REST_URL is not a valid URL; not added to the private-fetch allowlist (Redis calls will be SSRF-blocked): ${err.message}`,
          );
        }
      }
      if (context.allowPrivateRemoteBase) {
        try { extraAllowedPrivateOrigins.push(new URL(context.remoteBase).origin); } catch {}
      }
      for (const origin of context.allowPrivateFetchOrigins) {
        try { extraAllowedPrivateOrigins.push(new URL(origin).origin); } catch {}
      }
      unregisterSelfFetchOrigins = registerSidecarAllowedPrivateFetchOrigins(boundPort, extraAllowedPrivateOrigins);

      const portFile = process.env.LOCAL_API_PORT_FILE;
      if (portFile) {
        try { writeFileSync(portFile, String(boundPort)); } catch {}
      }

      context.logger.log(`[local-api] listening on http://127.0.0.1:${boundPort} (apiDir=${context.apiDir}, routes=${routes.length}, cloudFallback=${context.cloudFallback})`);

      // Warm LLM health cache in background (non-blocking)
      (async () => {
        const urls = [
          process.env.OLLAMA_API_URL || process.env.LLM_API_URL,
          process.env.GROQ_API_KEY ? 'https://api.groq.com' : null,
          process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai' : null,
        ].filter(Boolean);
        for (const url of urls) {
          const allowPrivateNetwork = url === process.env.OLLAMA_API_URL || url === process.env.LLM_API_URL;
          try { await fetchWithTimeout(url, { method: 'GET', allowPrivateNetwork }, 2000); } catch {}
        }
        if (urls.length) console.log(`[local-api] LLM health warmed for ${urls.length} provider(s)`);
      })();

      return { port: boundPort };
    },
    async close() {
      if (unregisterSelfFetchOrigins) {
        unregisterSelfFetchOrigins();
        unregisterSelfFetchOrigins = null;
      }
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
