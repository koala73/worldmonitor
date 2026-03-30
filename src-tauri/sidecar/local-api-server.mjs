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
import { WebSocket as AisWebSocket } from 'ws';

const brotliCompressAsync = promisify(brotliCompress);

// ── AIS Stream Manager ────────────────────────────────────────────────────
// Connects directly to aisstream.io using AISSTREAM_API_KEY (set via settings).
// Maintains in-memory vessel state; serves /api/ais-snapshot with no relay needed.
const AISSTREAM_WS_URL = 'wss://stream.aisstream.io/v0/stream';
const AIS_VESSEL_TTL_MS = 30 * 60 * 1000;
const AIS_MAX_VESSELS = 20_000;
const AIS_RECONNECT_DELAY_MS = 5_000;
const AIS_NAVAL_PREFIX_RE = /^(USS|USNS|HMS|HMAS|HMCS|INS|JS|ROKS|TCG|FS|BNS|RFS|PLAN|PLA|CGC|PNS|KRI|ITS|SNS)/i;

const aisState = {
  socket: null,
  vessels: new Map(),
  candidateReports: new Map(),
  reconnectTimer: null,
  messageCount: 0,
  sequence: 0,
  lastSnapshotAt: 0,
  lastSnapshotJson: null,
  activeKey: null,
};

function aisBuildSnapshot() {
  const now = Date.now();
  if (aisState.lastSnapshotJson && now - aisState.lastSnapshotAt < 2500) {
    return aisState.lastSnapshotJson;
  }
  const cutoff = now - AIS_VESSEL_TTL_MS;
  for (const [mmsi, v] of aisState.vessels) {
    if (v.timestamp < cutoff) aisState.vessels.delete(mmsi);
  }
  if (aisState.vessels.size > AIS_MAX_VESSELS) {
    const sorted = [...aisState.vessels.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (const [mmsi] of sorted.slice(0, aisState.vessels.size - AIS_MAX_VESSELS)) aisState.vessels.delete(mmsi);
  }
  const snapshot = {
    sequence: ++aisState.sequence,
    timestamp: new Date(now).toISOString(),
    status: {
      connected: aisState.socket?.readyState === 1,
      vessels: aisState.vessels.size,
      messages: aisState.messageCount,
    },
    disruptions: [],
    density: [],
    candidateReports: [...aisState.candidateReports.values()].slice(0, 1500),
  };
  aisState.lastSnapshotJson = JSON.stringify(snapshot);
  aisState.lastSnapshotAt = now;
  return aisState.lastSnapshotJson;
}

function aisIsLikelyMilitary(meta) {
  const shipType = Number(meta?.ShipType);
  if (shipType === 35 || shipType === 55 || (shipType >= 50 && shipType <= 59)) return true;
  const name = (meta?.ShipName || '').trim();
  if (name && AIS_NAVAL_PREFIX_RE.test(name)) return true;
  const mmsi = String(meta?.MMSI || '');
  if (mmsi.length >= 9 && (mmsi.substring(3).startsWith('00') || mmsi.substring(3).startsWith('99'))) return true;
  return false;
}

function aisProcessMessage(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (parsed?.MessageType !== 'PositionReport') return;
  const meta = parsed.MetaData;
  const pos = parsed.Message?.PositionReport;
  if (!meta || !pos) return;
  const mmsi = String(meta.MMSI || '');
  if (!mmsi) return;
  const lat = Number.isFinite(pos.Latitude) ? pos.Latitude : meta.latitude;
  const lon = Number.isFinite(pos.Longitude) ? pos.Longitude : meta.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const now = Date.now();
  aisState.vessels.set(mmsi, {
    mmsi, name: meta.ShipName || '', lat, lon, timestamp: now,
    shipType: meta.ShipType, heading: pos.TrueHeading, speed: pos.Sog, course: pos.Cog,
  });
  aisState.messageCount++;
  aisState.lastSnapshotJson = null; // invalidate cache
  if (aisIsLikelyMilitary(meta)) {
    aisState.candidateReports.set(mmsi, {
      mmsi, name: meta.ShipName || '', lat, lon,
      shipType: meta.ShipType, heading: pos.TrueHeading, speed: pos.Sog, course: pos.Cog, timestamp: now,
    });
  }
}

function aisConnect(apiKey) {
  if (!apiKey) return;
  if (aisState.socket && (aisState.socket.readyState === 0 || aisState.socket.readyState === 1)) return;
  aisState.activeKey = apiKey;
  const socket = new AisWebSocket(AISSTREAM_WS_URL);
  aisState.socket = socket;

  socket.on('open', () => {
    socket.send(JSON.stringify({
      APIKey: apiKey,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ['PositionReport'],
    }));
  });

  socket.on('message', (data) => {
    aisProcessMessage(typeof data === 'string' ? data : data.toString());
  });

  socket.on('close', () => {
    if (aisState.socket === socket) {
      aisState.socket = null;
      const currentKey = process.env.AISSTREAM_API_KEY;
      if (currentKey && currentKey === aisState.activeKey) {
        aisState.reconnectTimer = setTimeout(() => aisConnect(currentKey), AIS_RECONNECT_DELAY_MS);
      }
    }
  });

  socket.on('error', () => { /* close event handles reconnect */ });
}

function aisDisconnect() {
  aisState.activeKey = null;
  if (aisState.reconnectTimer) { clearTimeout(aisState.reconnectTimer); aisState.reconnectTimer = null; }
  if (aisState.socket) { try { aisState.socket.close(); } catch {} aisState.socket = null; }
}

function aisOnKeyChanged(newKey) {
  aisDisconnect();
  if (newKey) aisConnect(newKey);
}

if (process.env.AISSTREAM_API_KEY) {
  aisConnect(process.env.AISSTREAM_API_KEY);
}
// ── end AIS Stream Manager ────────────────────────────────────────────────

// Monkey-patch globalThis.fetch to force IPv4 for HTTPS requests.
// Node.js built-in fetch (undici) tries IPv6 first via Happy Eyeballs.
// Government APIs (EIA, NASA FIRMS, FRED) publish AAAA records but their
// IPv6 endpoints time out, causing ETIMEDOUT. This override ensures ALL
// fetch() calls in dynamically-loaded handler modules (api/*.js) use IPv4.
const _originalFetch = globalThis.fetch;

function normalizeRequestBody(body) {
  if (body == undefined) return null;
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return body;
}

async function resolveRequestBody(input, init, method, isRequest) {
  if (method === 'GET' || method === 'HEAD') return null;

  if (init?.body != undefined) {
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
      : (Array.isArray(rawHeaders) ? Object.fromEntries(rawHeaders) : rawHeaders);
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
    if (body != undefined) req.write(body);
    req.end();
  });
};

const ALLOWED_ENV_KEYS = new Set([
  'WORLDMONITOR_API_KEY',
  'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'FRED_API_KEY', 'EIA_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'ACLED_ACCESS_TOKEN', 'ACLED_EMAIL', 'URLHAUS_AUTH_KEY',
  'OTX_API_KEY', 'ABUSEIPDB_API_KEY', 'WINGBITS_API_KEY', 'WS_RELAY_URL',
  'VITE_OPENSKY_RELAY_URL', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET',
  'AISSTREAM_API_KEY', 'VITE_WS_RELAY_URL', 'FINNHUB_API_KEY', 'NASA_FIRMS_API_KEY',
  'UC_DP_KEY',
  'OLLAMA_API_URL', 'OLLAMA_MODEL', 'WTO_API_KEY', 'AVIATIONSTACK_API',
  'ICAO_API_KEY', 'THREATFOX_API_KEY',
  'NEWSAPI_KEY', 'NEWSDATA_API_KEY', 'VIRUSTOTAL_API_KEY', 'BGPVIEW_API_KEY',
  'SHODAN_API_KEY', 'FMP_API_KEY',
]);

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── IP geolocation helpers ────────────────────────────────────────────────
// ip-api.com batch endpoint: free, no key, up to 100 IPs per request.
// Note: free tier requires HTTP (not HTTPS).
async function geolocateIPs(ips) {
  if (!ips || ips.length === 0) return new Map();
  try {
    const batch = ips.slice(0, 100).map(ip => ({ query: ip, fields: 'query,country,countryCode,lat,lon' }));
    const resp = await fetchWithTimeout('http://ip-api.com/batch?fields=query,country,countryCode,lat,lon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'WorldMonitor/1.0' },
      body: JSON.stringify(batch),
    }, 8000);
    if (!resp.ok) return new Map();
    const results = await resp.json();
    const map = new Map();
    for (const r of results) {
      if (r.query && r.lat && r.lon) {
        map.set(r.query, { lat: r.lat, lon: r.lon, country: r.country ?? '', countryCode: r.countryCode ?? '' });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// IPQuery.io: free, no key, per-IP risk scoring.
async function scoreIPsQuery(ips) {
  if (!ips || ips.length === 0) return new Map();
  const map = new Map();
  const topIps = ips.slice(0, 15);
  await Promise.allSettled(topIps.map(async (ip) => {
    try {
      const resp = await fetchWithTimeout(`https://api.ipquery.io/${encodeURIComponent(ip)}`, {
        headers: { 'User-Agent': 'WorldMonitor/1.0', Accept: 'application/json' },
      }, 5000);
      if (!resp.ok) return;
      const data = await resp.json();
      const score = data?.risk?.risk_score ?? null;
      if (score !== null) map.set(ip, score);
    } catch { /* ignore per-IP failures */ }
  }));
  return map;
}

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
  // eslint-disable-next-line no-restricted-syntax -- intentional: SSRF guard checking request hostname, not constructing a URL
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
  return Response.json(data, {
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
  for (const [key, value] of Object.entries(nodeHeaders)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host') continue;
    if (stripOrigin && (lowerKey === 'origin' || lowerKey === 'referer' || lowerKey.startsWith('sec-fetch-'))) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  return headers;
}

async function proxyToCloud(requestUrl, req, remoteBase) {
  const target = `${remoteBase}${requestUrl.pathname}${requestUrl.search}`;
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(target, {
      method: req.method,
      // Strip browser-origin headers for server-to-server parity.
      headers: toHeaders(req.headers, { stripOrigin: true }),
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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
  const port = Number(options.port ?? process.env.LOCAL_API_PORT ?? 46_123);
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
  // eslint-disable-next-line no-restricted-syntax -- intentional: Tauri IPC origin; must not change to 127.0.0.1
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 12_000) {
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
        if (body != undefined) req.write(body);
      }
      req.end();
    });
  }
  // HTTP fallback (localhost sidecar, etc.)
  // For pinned addresses on plain HTTP, rewrite the URL to connect to the
  // validated IP and set the Host header so virtual-host routing still works.
  let fetchUrl = url;
  const fetchHeaders = { ...options.headers };
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

// CACHE PATTERN: copy this for future cached routes
const _sidecarCache = new Map(); // key -> { data, ts }
function getCached(key, ttlMs) {
  const entry = _sidecarCache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  return null;
}
function getCachedStale(key) {
  const entry = _sidecarCache.get(key);
  return entry ? entry.data : null;
}
function setCached(key, data) {
  _sidecarCache.set(key, { data, ts: Date.now() });
}

let _prevEconomicStressIndex = null;

async function fetchFredSeries(seriesId, apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=1`;
  const res = await fetchWithTimeout(url);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`No data for ${seriesId}: non-JSON response`); }
  const obs = data?.observations?.[0];
  if (!obs || obs.value === '.') throw new Error(`No data for ${seriesId}`);
  return Number.parseFloat(obs.value);
}

function clamp(x) { return Math.min(100, Math.max(0, x)); }

function computeStressIndex(yieldVal, spreadVal, vixVal, fsiVal, scVal, claimsVal) {
  const yieldScore  = clamp((0.5 - yieldVal)  / (0.5 - (-1.5)) * 100);
  const spreadScore = clamp((0.5 - spreadVal)  / (0.5 - (-1)) * 100);
  const vixScore    = clamp((vixVal - 15)      / (80 - 15)      * 100);
  const fsiScore    = clamp((fsiVal - (-1))    / (5 - (-1))     * 100);
  const scScore     = clamp((scVal - (-2))     / (4 - (-2))     * 100);
  const claimsScore = clamp((claimsVal - 180_000) / (500_000 - 180_000) * 100);
  return Math.round(
    yieldScore  * 0.2 +
    spreadScore * 0.15 +
    vixScore    * 0.2 +
    fsiScore    * 0.2 +
    scScore     * 0.15 +
    claimsScore * 0.1
  );
}

function indicatorSeverity(score) {
  return score >= 70 ? 'critical' : (score >= 40 ? 'warning' : 'normal');
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

    case 'THREATFOX_API_KEY': {
      const tfResp = await fetchWithTimeout('https://threatfox-api.abuse.ch/api/v1/', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Auth-Key': value,
          'Content-Type': 'application/json',
          'User-Agent': CHROME_UA,
        },
        body: JSON.stringify({ query: 'get_iocs', days: 1 }),
      });
      const tfText = await tfResp.text();
      if (isCloudflareChallenge403(tfResp, tfText)) return ok('ThreatFox key stored (Cloudflare blocked verification)');
      if (isAuthFailure(tfResp.status, tfText)) return fail('ThreatFox rejected this key');
      if (!tfResp.ok) return fail(`ThreatFox probe failed (${tfResp.status})`);
      return ok('ThreatFox key verified');
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

    case 'OLLAMA_MODEL': {
      return ok('Model name stored');
    }

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

    case 'AISSTREAM_API_KEY': {
      // AISStream is WebSocket-only — no REST probe available. Validate format instead.
      // Valid keys are UUID v4 (e.g. 8fa3b1f0-c68d-4a9a-a7c5-d12345678abc)
      // or a 32–64 char hex string depending on plan tier.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
      const isHex  = /^[0-9a-f]{32,64}$/i.test(value);
      if (!isUuid && !isHex) {
        return fail('AISStream key should be a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) or 32–64 char hex string — verify your key at aisstream.io');
      }
      return ok('AISStream key stored — format valid (live test requires WebSocket)');
    }

    case 'WTO_API_KEY': {
      return ok('WTO API key stored (live verification not available in sidecar)');
    }

    case 'WORLDMONITOR_API_KEY': {
      if (!/^[A-Za-z0-9_-]{16,}$/.test(value)) {
        return fail('WorldMonitor key must be at least 16 URL-safe characters');
      }
      return ok('WorldMonitor API key stored');
    }

      default: {
        return ok('Key stored');
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'provider probe failed';
    if (isTransientVerificationError(error)) {
      return { valid: true, message: `Saved (could not verify: ${message})` };
    }
    return fail(`Verification request failed: ${message}`);
  }
}

// ── Ollama Streaming SSE Handler ─────────────────────────────────────────────
// Handles /api/ollama-stream — bypasses the arrayBuffer() buffering in the
// main request loop so tokens can be streamed back to the frontend in real time.
async function handleOllamaStream(requestUrl, req, res, context) {
  const body = await readBody(req);
  if (!body) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'expected JSON body' }));
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(body.toString());
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  const ollamaBaseUrl = process.env.OLLAMA_API_URL;
  if (!ollamaBaseUrl) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ skipped: true, reason: 'OLLAMA_API_URL not configured' }));
    return;
  }

  // Validate model name: only allow alphanumeric, dash, dot, colon, slash (e.g. 'llama3.1:8b', 'ollama3/8b')
  const rawModel = process.env.OLLAMA_MODEL || 'llama3.1:8b';
  const model = /^[a-zA-Z0-9._:/-]{1,80}$/.test(rawModel) ? rawModel : 'llama3.1:8b';
  const headlines = Array.isArray(parsed.headlines) ? parsed.headlines.slice(0, 10) : [];
  const geoContext = typeof parsed.geoContext === 'string' ? parsed.geoContext.slice(0, 500) : '';
  const lang = typeof parsed.lang === 'string' ? parsed.lang : 'en';

  if (headlines.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'headlines required' }));
    return;
  }

  const headlineText = headlines.slice(0, 5)
    .map((h, i) => `${i + 1}. ${String(h).slice(0, 200)}`)
    .join('\n');
  const geoNote = geoContext ? `\nGeographic context: ${geoContext}` : '';
  const systemPrompt = `You are a senior geopolitical analyst. Summarize the situation described in the headlines in exactly 2-3 concise sentences (under 80 words total). Be factual and direct. No preamble, no markdown formatting, no "Summary:" prefix — just the analysis text.`;
  const userPrompt = `Headlines:${geoNote}\n${headlineText}`;

  let apiUrl;
  try {
    apiUrl = new URL('/v1/chat/completions', ollamaBaseUrl).toString();
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid OLLAMA_API_URL' }));
    return;
  }

  const requestBody = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 150,
    stream: true,
  });

  const corsOrigin = getSidecarCorsOrigin(req);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': corsOrigin,
    'vary': 'Origin',
  });

  try {
    const parsed2 = new URL(apiUrl);
    const mod = parsed2.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed2.hostname,
      port: parsed2.port || (parsed2.protocol === 'https:' ? 443 : 80),
      path: parsed2.pathname + parsed2.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        'User-Agent': CHROME_UA,
      },
      family: 4,
    };

    await new Promise((resolve) => {
      const ollamaReq = mod.request(reqOptions, (ollamaRes) => {
        if (ollamaRes.statusCode !== 200) {
          const chunks = [];
          ollamaRes.on('data', c => chunks.push(c));
          ollamaRes.on('end', () => {
            const errText = Buffer.concat(chunks).toString().slice(0, 300);
            res.write(`data: ${JSON.stringify({ error: `Ollama ${ollamaRes.statusCode}: ${errText}` })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            resolve();
          });
          return;
        }

        let sseBuffer = '';
        ollamaRes.on('data', (chunk) => {
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') continue;
            try {
              const data = JSON.parse(dataStr);
              const token = data.choices?.[0]?.delta?.content;
              if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
            } catch { /* malformed SSE chunk */ }
          }
        });

        ollamaRes.on('end', () => {
          if (sseBuffer.trim().startsWith('data: ')) {
            const dataStr = sseBuffer.trim().slice(6);
            if (dataStr !== '[DONE]') {
              try {
                const data = JSON.parse(dataStr);
                const token = data.choices?.[0]?.delta?.content;
                if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
              } catch { /* ignore */ }
            }
          }
          res.write('data: [DONE]\n\n');
          res.end();
          resolve();
        });

        ollamaRes.on('error', (err) => {
          context.logger.error('[ollama-stream] response error:', err.message);
          try { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); } catch { /* already ended */ }
          resolve();
        });
      });

      ollamaReq.on('error', (err) => {
        context.logger.error('[ollama-stream] request error:', err.message);
        try { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); } catch { /* already ended */ }
        resolve();
      });

      // Destroy the Ollama request if the client disconnects
      req.on('close', () => { try { ollamaReq.destroy(); } catch { /* ignore */ } resolve(); });

      ollamaReq.write(requestBody);
      ollamaReq.end();
    });
  } catch (error) {
    context.logger.error('[ollama-stream] fatal:', error.message);
    try { res.write(`data: ${JSON.stringify({ error: 'Streaming failed' })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); } catch { /* already ended */ }
  }
}

function extractAlertCentroid(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;
  if (geom.type === 'Point') return [geom.coordinates[0], geom.coordinates[1]];
  if (geom.type === 'Polygon' && geom.coordinates?.[0]?.length) {
    const ring = geom.coordinates[0];
    const lons = ring.map(c => c[0]);
    const lats = ring.map(c => c[1]);
    return [
      (Math.min(...lons) + Math.max(...lons)) / 2,
      (Math.min(...lats) + Math.max(...lats)) / 2,
    ];
  }
  if (geom.type === 'MultiPolygon' && geom.coordinates?.[0]?.[0]?.length) {
    const ring = geom.coordinates[0][0];
    const lons = ring.map(c => c[0]);
    const lats = ring.map(c => c[1]);
    return [
      (Math.min(...lons) + Math.max(...lons)) / 2,
      (Math.min(...lats) + Math.max(...lats)) / 2,
    ];
  }
  return null;
}

async function dispatch(requestUrl, req, routes, context) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: makeCorsHeaders(req) });
  }

  // Health check — exempt from auth to support external monitoring tools
  if (requestUrl.pathname === '/api/service-status') {
    return handleLocalServiceStatus(context);
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
    const origin = `http://127.0.0.1:${context.port}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="strict-origin-when-cross-origin"><style>html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}#player{width:100%;height:100%}#play-overlay{position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;pointer-events:none;background:rgba(0,0,0,0.15)}#play-overlay svg{width:72px;height:72px;opacity:0.9;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.5))}#play-overlay.hidden{display:none}</style></head><body><div id="player"></div><div id="play-overlay" class="hidden"><svg viewBox="0 0 68 48"><path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55C3.97 2.33 2.27 4.81 1.48 7.74.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="red"/><path d="M45 24L27 14v20" fill="#fff"/></svg></div><script>var tag=document.createElement('script');tag.src='https://www.youtube.com/iframe_api';document.head.appendChild(tag);var player,overlay=document.getElementById('play-overlay'),started=false,muteSyncId,retryTimers=[];var obs=new MutationObserver(function(muts){for(var i=0;i<muts.length;i++){var nodes=muts[i].addedNodes;for(var j=0;j<nodes.length;j++){if(nodes[j].tagName==='IFRAME'){var a=nodes[j].getAttribute('allow')||'';if(a.indexOf('autoplay')===-1){nodes[j].setAttribute('allow','autoplay; encrypted-media; picture-in-picture '+a);console.log('[yt-embed] patched iframe allow=autoplay')}obs.disconnect();return}}}});obs.observe(document.getElementById('player'),{childList:true,subtree:true});function hideOverlay(){overlay.classList.add('hidden')}function readMuted(){if(!player)return null;if(typeof player.isMuted==='function')return player.isMuted();if(typeof player.getVolume==='function')return player.getVolume()===0;return null}function stopMuteSync(){if(muteSyncId){clearInterval(muteSyncId);muteSyncId=null}}function startMuteSync(){if(muteSyncId)return;var last=readMuted();if(last!==null)window.parent.postMessage({type:'yt-mute-state',muted:last},'*');muteSyncId=setInterval(function(){var m=readMuted();if(m!==null&&m!==last){last=m;window.parent.postMessage({type:'yt-mute-state',muted:m},'*')}},500)}function tryAutoplay(){if(!player||!player.playVideo)return;try{player.mute();player.playVideo();console.log('[yt-embed] tryAutoplay: mute+play')}catch(e){}}function onYouTubeIframeAPIReady(){player=new YT.Player('player',{videoId:'${videoId}',host:'https://www.youtube.com',playerVars:{autoplay:${autoplay},mute:${mute},playsinline:1,rel:0,controls:1,modestbranding:1,enablejsapi:1,origin:'${origin}',widget_referrer:'${origin}'},events:{onReady:function(){console.log('[yt-embed] onReady');window.parent.postMessage({type:'yt-ready'},'*');${vq ? `if(player.setPlaybackQuality)player.setPlaybackQuality('${vq}');` : ''}if(${autoplay}===1){tryAutoplay();retryTimers.push(setTimeout(function(){if(!started)tryAutoplay()},500));retryTimers.push(setTimeout(function(){if(!started)tryAutoplay()},1500));retryTimers.push(setTimeout(function(){if(!started){console.log('[yt-embed] autoplay failed after retries');window.parent.postMessage({type:'yt-autoplay-failed'},'*')}},2500))}startMuteSync()},onError:function(e){console.log('[yt-embed] error code='+e.data);stopMuteSync();window.parent.postMessage({type:'yt-error',code:e.data},'*')},onStateChange:function(e){window.parent.postMessage({type:'yt-state',state:e.data},'*');if(e.data===1||e.data===3){hideOverlay();started=true;retryTimers.forEach(clearTimeout);retryTimers=[]}}}})}setTimeout(function(){if(!started)overlay.classList.remove('hidden')},4000);window.addEventListener('message',function(e){if(!player||!player.getPlayerState)return;var m=e.data;if(!m||!m.type)return;switch(m.type){case'play':player.playVideo();break;case'pause':player.pauseVideo();break;case'mute':player.mute();break;case'unmute':player.unMute();break;case'loadVideo':if(m.videoId)player.loadVideoById(m.videoId);break;case'setQuality':if(m.quality&&player.setPlaybackQuality)player.setPlaybackQuality(m.quality);break}});window.addEventListener('beforeunload',function(){stopMuteSync();obs.disconnect();retryTimers.forEach(clearTimeout)})<\/script></body></html>`;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'permissions-policy': 'autoplay=*, encrypted-media=*', ...makeCorsHeaders(req) } });
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
      }, 15_000);
      const responseBody = await response.text();
      let result;
      try { result = JSON.parse(responseBody); } catch { result = { status: 'registered' }; }
      if (result.status === 'error') {
        return json({ error: result.errorMessage || 'Registration failed' }, 500);
      }
      return json(result.value || result);
    } catch (error) {
      context.logger.error(`[register-interest] error: ${error.message}`);
      return json({ error: 'Registration service unreachable' }, 502);
    }
  }

  // ── OREF (Israel Home Front Command) alerts ──────────────────────────────
  // Handled before dynamic dispatch so we control the relay→tzevaadom fallback
  // chain here rather than relying on the oref-alerts.js bundle which requires
  // WS_RELAY_URL.  The dynamic handler stays in place as a no-op fallback.
  if (requestUrl.pathname === '/api/oref-alerts') {
    const isHistory = requestUrl.searchParams.get('endpoint') === 'history';
    const relayBase = (process.env.WS_RELAY_URL || '')
      .replace('wss://', 'https://')
      .replace('ws://', 'http://')
      .replace(/\/$/, '');

    // 1. Relay path (same behaviour as the oref-alerts.js bundle)
    if (relayBase) {
      try {
        const relaySecret = process.env.RELAY_SHARED_SECRET || '';
        const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
        const relayHeaders = {
          Accept: 'application/json',
          ...(relaySecret ? { [relayHeader]: relaySecret, Authorization: `Bearer ${relaySecret}` } : {}),
        };
        const relayPath = isHistory ? '/oref/history' : '/oref/alerts';
        const relayResp = await fetchWithTimeout(`${relayBase}${relayPath}`, { headers: relayHeaders }, 12_000);
        if (relayResp.ok) {
          return new Response(await relayResp.text(), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      } catch { /* fall through to public proxy */ }
    }

    // 2. Public fallback: tzevaadom.co.il (accessible outside Israel)
    if (isHistory) {
      // No reliable public history endpoint — return empty history rather than "not configured"
      return json({ configured: true, history: [], historyCount24h: 0, timestamp: new Date().toISOString() });
    }
    try {
      const tzResp = await fetchWithTimeout(
        'https://api.tzevaadom.co.il/notifications?networkVersion=1',
        { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } },
        8000,
      );
      if (!tzResp.ok) throw new Error(`tzevaadom ${tzResp.status}`);
      const raw = await tzResp.json();
      const alerts = Array.isArray(raw) ? raw.map(a => ({
        id: String(a.id ?? Date.now()),
        cat: String(a.cat ?? 1),
        title: a.title ?? '',
        data: Array.isArray(a.data) ? a.data : (a.areas ?? []),
        desc: a.desc ?? '',
        alertDate: a.alertDate ?? new Date().toISOString(),
      })) : [];
      return json({
        configured: true,
        alerts,
        historyCount24h: 0,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return json({
        configured: false,
        alerts: [],
        historyCount24h: 0,
        timestamp: new Date().toISOString(),
        error: String(error.message ?? error),
      });
    }
  }

  // ACLED air strikes & drone events (last 30 days)
  if (requestUrl.pathname === '/api/acled-events') {
    const key = process.env.ACLED_ACCESS_TOKEN;
    const email = process.env.ACLED_EMAIL;
    if (!key || !email) {
      return json({ events: [], error: 'ACLED_ACCESS_TOKEN and ACLED_EMAIL are required' });
    }
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const fields = 'event_id_cnty|event_date|event_type|sub_event_type|actor1|actor2|country|admin1|location|latitude|longitude|fatalities|notes';
    const acledUrl = `https://api.acleddata.com/acled/read?key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&event_type=Air%2Fdrone+strike%7CShelling%2Fartillery%2Fmissile+attack&event_date=${since}%7C${today}&event_date_where=BETWEEN&fields=${encodeURIComponent(fields)}&limit=200&sort=event_date&order=desc&_format=json`;
    try {
      const resp = await fetchWithTimeout(acledUrl, {}, 15_000);
      if (!resp.ok) {
        return json({ events: [], error: `ACLED error: ${resp.status}` });
      }
      const data = await resp.json();
      return json({ events: data.data ?? [] });
    } catch (error) {
      return json({ events: [], error: String(error.message ?? error) });
    }
  }

  // ── ThreatFox IOC feed ───────────────────────────────────────────────────
  if (requestUrl.pathname === '/api/threatfox-iocs') {
    const apiKey = process.env.THREATFOX_API_KEY;
    if (!apiKey) return json({ error: 'THREATFOX_API_KEY not configured' }, 503);
    try {
      const resp = await fetchWithTimeout('https://threatfox-api.abuse.ch/api/v1/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Auth-Key': apiKey,
          'User-Agent': CHROME_UA,
        },
        body: JSON.stringify({ query: 'get_iocs', days: 7 }),
      }, 15_000);
      if (!resp.ok) return json([], 200);
      const data = await resp.json();
      const iocs = Array.isArray(data?.data) ? data.data : [];
      const threats = iocs.slice(0, 200).map((ioc, i) => ({
        id: `threatfox-${ioc.id ?? i}`,
        type: ioc.ioc_type?.startsWith('ip') ? 'c2_server' : 'malware_host',
        source: 'threatfox',
        indicator: String(ioc.ioc ?? ''),
        indicatorType: ioc.ioc_type?.startsWith('ip') ? 'ip' : (ioc.ioc_type?.startsWith('url') ? 'url' : 'domain'),
        lat: 0,
        lon: 0,
        country: ioc.country ?? '',
        severity: (ioc.confidence_level ?? 0) >= 90 ? 'critical' : ((ioc.confidence_level ?? 0) >= 70 ? 'high' : 'medium'),
        malwareFamily: ioc.malware_printable ?? ioc.malware ?? '',
        tags: Array.isArray(ioc.tags) ? ioc.tags : [],
        firstSeen: ioc.first_seen ?? '',
        lastSeen: ioc.last_seen ?? ioc.first_seen ?? '',
      }));
      return json(threats);
    } catch {
      return json([], 200);
    }
  }

  // ── OpenPhish phishing URL feed ──────────────────────────────────────────
  if (requestUrl.pathname === '/api/openphish-feed') {
    try {
      const resp = await fetchWithTimeout('https://openphish.com/feed.txt', {
        headers: { 'User-Agent': CHROME_UA },
      }, 12_000);
      if (!resp.ok) return json([], 200);
      const text = await resp.text();
      const urls = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
      const threats = urls.slice(0, 150).map((url, i) => ({
        id: `openphish-${i}`,
        type: 'phishing',
        source: 'openphish',
        indicator: url,
        indicatorType: 'url',
        lat: 0,
        lon: 0,
        country: '',
        severity: 'high',
        malwareFamily: '',
        tags: ['phishing'],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      }));
      return json(threats);
    } catch {
      return json([], 200);
    }
  }

  // ── Spamhaus DROP + EDROP blocklist ─────────────────────────────────────
  if (requestUrl.pathname === '/api/spamhaus-drop') {
    try {
      const [dropResp, edropResp] = await Promise.all([
        fetchWithTimeout('https://www.spamhaus.org/drop/drop.txt', { headers: { 'User-Agent': CHROME_UA } }, 12_000),
        fetchWithTimeout('https://www.spamhaus.org/drop/edrop.txt', { headers: { 'User-Agent': CHROME_UA } }, 12_000),
      ]);
      const dropText = dropResp.ok ? await dropResp.text() : '';
      const edropText = edropResp.ok ? await edropResp.text() : '';
      const lines = [...dropText.split('\n'), ...edropText.split('\n')]
        .map(l => l.trim())
        .filter(l => l && !l.startsWith(';'));
      const threats = lines.slice(0, 200).map((line, i) => {
        const cidr = line.split(';')[0].trim();
        return {
          id: `spamhaus-${i}`,
          type: 'malicious_ip_range',
          source: 'spamhaus',
          indicator: cidr,
          indicatorType: 'ip',
          lat: 0,
          lon: 0,
          country: '',
          severity: 'high',
          malwareFamily: '',
          tags: ['spamhaus', 'drop'],
          firstSeen: '',
          lastSeen: '',
        };
      });
      return json(threats);
    } catch {
      return json([], 200);
    }
  }

  // ── CISA Known Exploited Vulnerabilities ─────────────────────────────────
  if (requestUrl.pathname === '/api/cisa-kev') {
    try {
      const resp = await fetchWithTimeout(
        'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
        { headers: { 'User-Agent': CHROME_UA } },
        15_000,
      );
      if (!resp.ok) return json([], 200);
      const data = await resp.json();
      const vulns = Array.isArray(data?.vulnerabilities) ? data.vulnerabilities : [];
      // Return only recent entries (last 90 days)
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const recent = vulns.filter(v => v.dateAdded && new Date(v.dateAdded).getTime() >= cutoff);
      const threats = recent.slice(0, 200).map((v, i) => ({
        id: `cisa-kev-${v.cveID ?? i}`,
        type: 'exploited_vulnerability',
        source: 'cisa_kev',
        indicator: v.cveID ?? `CVE-${i}`,
        indicatorType: 'domain',
        lat: 0,
        lon: 0,
        country: '',
        severity: 'critical',
        malwareFamily: `${v.vendorProject ?? ''} ${v.product ?? ''}`.trim(),
        tags: ['cisa', 'kev', 'actively-exploited'],
        firstSeen: v.dateAdded ?? '',
        lastSeen: v.dueDate ?? v.dateAdded ?? '',
      }));
      return json(threats);
    } catch {
      return json([], 200);
    }
  }

  // ── AlienVault OTX pulse/IOC feed ────────────────────────────────────────
  if (requestUrl.pathname === '/api/otx-iocs') {
    const apiKey = process.env.OTX_API_KEY;
    if (!apiKey) return json({ error: 'OTX_API_KEY not configured' }, 503);
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const resp = await fetchWithTimeout(
        `https://otx.alienvault.com/api/v1/pulses/subscribed?limit=50&modified_since=${since}`,
        { headers: { 'X-OTX-API-KEY': apiKey, Accept: 'application/json', 'User-Agent': CHROME_UA } },
        15000,
      );
      if (!resp.ok) return json([], 200);
      const data = await resp.json();
      const pulses = Array.isArray(data?.results) ? data.results : [];
      const rawThreats = [];
      for (const pulse of pulses) {
        const indicators = Array.isArray(pulse.indicators) ? pulse.indicators : [];
        for (const ioc of indicators) {
          const itype = ioc.type ?? '';
          const isIP = itype === 'IPv4' || itype === 'IPv6';
          const isURL = itype === 'URL';
          rawThreats.push({
            id: `otx-${pulse.id}-${ioc.id ?? rawThreats.length}`,
            type: isIP ? 'c2_server' : 'malware_host',
            source: 'otx',
            indicator: String(ioc.indicator ?? ''),
            indicatorType: isIP ? 'ip' : isURL ? 'url' : 'domain',
            lat: 0,
            lon: 0,
            country: '',
            severity: 'high',
            malwareFamily: pulse.adversary || (Array.isArray(pulse.tags) ? pulse.tags.slice(0, 3).join(', ') : ''),
            tags: Array.isArray(pulse.tags) ? pulse.tags : [],
            firstSeen: ioc.created ?? pulse.created ?? '',
            lastSeen: ioc.created ?? pulse.modified ?? '',
          });
          if (rawThreats.length >= 300) break;
        }
        if (rawThreats.length >= 300) break;
      }
      // Enrich IP-type IOCs with geolocation
      const ipIOCs = rawThreats.filter(t => t.indicatorType === 'ip').map(t => t.indicator);
      const [geoMap, riskMap] = await Promise.all([geolocateIPs(ipIOCs), scoreIPsQuery(ipIOCs)]);
      for (const t of rawThreats) {
        if (t.indicatorType === 'ip') {
          const geo = geoMap.get(t.indicator);
          if (geo) { t.lat = geo.lat; t.lon = geo.lon; t.country = geo.country; }
          const risk = riskMap.get(t.indicator);
          if (risk !== undefined) t.riskScore = risk;
        }
      }
      return json(rawThreats);
    } catch (e) {
      return json([], 200);
    }
  }

  // ── VirusTotal IOC reputation lookup ─────────────────────────────────────
  if (requestUrl.pathname === '/api/virustotal-lookup') {
    const apiKey = process.env.VIRUSTOTAL_API_KEY;
    if (!apiKey) return json({ error: 'VIRUSTOTAL_API_KEY not configured' }, 503);
    const indicator = requestUrl.searchParams.get('indicator');
    const type = requestUrl.searchParams.get('type') ?? 'domain';
    if (!indicator) return json({ error: 'Missing indicator' }, 400);
    try {
      const endpointMap = { ip: 'ip_addresses', domain: 'domains', url: 'urls' };
      const ep = endpointMap[type] ?? 'domains';
      const encoded = type === 'url'
        ? Buffer.from(indicator).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
        : encodeURIComponent(indicator);
      const resp = await fetchWithTimeout(
        `https://www.virustotal.com/api/v3/${ep}/${encoded}`,
        { headers: { 'x-apikey': apiKey, Accept: 'application/json', 'User-Agent': CHROME_UA } },
        12000,
      );
      if (!resp.ok) return json({ error: `VT responded ${resp.status}` }, resp.status);
      const data = await resp.json();
      const stats = data?.data?.attributes?.last_analysis_stats ?? {};
      return json({
        indicator,
        type,
        malicious: stats.malicious ?? 0,
        suspicious: stats.suspicious ?? 0,
        harmless: stats.harmless ?? 0,
        undetected: stats.undetected ?? 0,
        reputation: data?.data?.attributes?.reputation ?? 0,
        lastAnalysisDate: data?.data?.attributes?.last_analysis_date ?? null,
      });
    } catch (e) {
      return json({ error: String(e.message ?? e) }, 502);
    }
  }

  // ── BGPView ASN info ──────────────────────────────────────────────────────
  if (requestUrl.pathname === '/api/bgpview-asn') {
    const apiKey = process.env.BGPVIEW_API_KEY;
    const asn = requestUrl.searchParams.get('asn');
    if (!asn || !/^\d+$/.test(asn)) return json({ error: 'Invalid ASN' }, 400);
    try {
      const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
      if (apiKey) headers['X-Api-Key'] = apiKey;
      const [asnResp, prefixResp] = await Promise.all([
        fetchWithTimeout(`https://api.bgpview.io/asn/${asn}`, { headers }, 10000),
        fetchWithTimeout(`https://api.bgpview.io/asn/${asn}/prefixes`, { headers }, 10000),
      ]);
      const asnData = asnResp.ok ? await asnResp.json() : {};
      const prefixData = prefixResp.ok ? await prefixResp.json() : {};
      const info = asnData?.data ?? {};
      return json({
        asn: info.asn ?? Number(asn),
        name: info.name ?? '',
        description: info.description_short ?? info.description_full ?? '',
        countryCode: info.country_code ?? '',
        website: info.website ?? '',
        rir: info.rir_allocation?.rir_name ?? '',
        ipv4Prefixes: Array.isArray(prefixData?.data?.ipv4_prefixes) ? prefixData.data.ipv4_prefixes.length : 0,
        ipv6Prefixes: Array.isArray(prefixData?.data?.ipv6_prefixes) ? prefixData.data.ipv6_prefixes.length : 0,
      });
    } catch (e) {
      return json({ error: String(e.message ?? e) }, 502);
    }
  }

  // ── NewsAPI.org headlines ─────────────────────────────────────────────────
  if (requestUrl.pathname === '/api/newsapi-headlines') {
    const apiKey = process.env.NEWSAPI_KEY;
    if (!apiKey) return json({ error: 'NEWSAPI_KEY not configured' }, 503);
    const q = requestUrl.searchParams.get('q') ?? 'geopolitics';
    const pageSize = Math.min(20, parseInt(requestUrl.searchParams.get('pageSize') ?? '10', 10));
    try {
      const params = new URLSearchParams({ q, pageSize: String(pageSize), language: 'en', sortBy: 'publishedAt', apiKey });
      const resp = await fetchWithTimeout(
        `https://newsapi.org/v2/everything?${params}`,
        { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } },
        12000,
      );
      if (!resp.ok) return json([], 200);
      const data = await resp.json();
      const articles = Array.isArray(data?.articles) ? data.articles : [];
      const items = articles.map((a, i) => ({
        id: `newsapi-${i}`,
        source: a.source?.name ?? 'NewsAPI',
        title: a.title ?? '',
        link: a.url ?? '',
        pubDate: a.publishedAt ?? new Date().toISOString(),
        description: a.description ?? '',
        imageUrl: a.urlToImage ?? undefined,
      }));
      return json(items);
    } catch (e) {
      return json([], 200);
    }
  }

  // ── NewsData.io feed ──────────────────────────────────────────────────────
  if (requestUrl.pathname === '/api/newsdata-feed') {
    const apiKey = process.env.NEWSDATA_API_KEY;
    if (!apiKey) return json({ error: 'NEWSDATA_API_KEY not configured' }, 503);
    const q = requestUrl.searchParams.get('q') ?? 'world news';
    try {
      const params = new URLSearchParams({ apikey: apiKey, q, language: 'en' });
      const resp = await fetchWithTimeout(
        `https://newsdata.io/api/1/latest?${params}`,
        { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } },
        12000,
      );
      if (!resp.ok) return json([], 200);
      const data = await resp.json();
      const results = Array.isArray(data?.results) ? data.results : [];
      const items = results.map((a, i) => ({
        id: `newsdata-${i}`,
        source: a.source_name ?? a.source_id ?? 'NewsData',
        title: a.title ?? '',
        link: a.link ?? '',
        pubDate: a.pubDate ?? new Date().toISOString(),
        description: a.description ?? '',
        imageUrl: a.image_url ?? undefined,
      }));
      return json(items);
    } catch (e) {
      return json([], 200);
    }
  }

  // ── USGS Volcano Hazards Program alerts ─────────────────────────────────
  if (requestUrl.pathname === '/api/volcano-alerts') {
    try {
      const resp = await fetchWithTimeout(
        'https://volcanoes.usgs.gov/vsc/api/volcanoApi/volcanoesGet',
        { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } },
        15_000,
      );
      if (!resp.ok) return json([], 200);
      const data = await resp.json();
      const volcanoes = Array.isArray(data) ? data : (data?.features ?? data?.volcanoes ?? []);
      const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
      const alerts = volcanoes
        .filter(v => {
          const level = (v.alertLevel ?? v.alert_level ?? v.currentAlertLevel ?? '').toLowerCase();
          return level && level !== 'normal' && level !== 'unassigned';
        })
        .slice(0, 100)
        .map((v, i) => ({
          id: `usgs-volcano-${v.vnum ?? v.id ?? i}`,
          name: v.volcanoName ?? v.name ?? `Volcano ${i}`,
          location: [v.state ?? '', v.country ?? ''].filter(Boolean).join(', '),
          alertLevel: cap(v.alertLevel ?? v.alert_level ?? v.currentAlertLevel ?? 'Advisory'),
          color: v.colorCode ?? v.color_code ?? 'Yellow',
          lat: Number.parseFloat(v.latitude ?? v.lat ?? 0),
          lon: Number.parseFloat(v.longitude ?? v.lon ?? 0),
          updatedAt: v.activityChangedDate ?? v.updatedAt ?? '',
          observatory: v.observatoryName ?? v.observatory ?? '',
        }));
      return json(alerts);
    } catch {
      return json([], 200);
    }
  }

  // ── NOAA NWS All-Hazards alerts ──────────────────────────────────────────
  if (requestUrl.pathname === '/api/nws-alerts') {
    try {
      const resp = await fetchWithTimeout(
        'https://api.weather.gov/alerts/active?status=actual&message_type=alert&urgency=Immediate,Expected&severity=Extreme,Severe,Moderate',
        { headers: { Accept: 'application/geo+json', 'User-Agent': 'WorldMonitor-NWS/1.0 (https://github.com/bradleybond512/worldmonitor-macos)' } },
        12_000,
      );
      if (!resp.ok) return json([], 200);
      const data = await resp.json();
      const features = Array.isArray(data?.features) ? data.features : [];
      const alerts = features.slice(0, 100).map((f, i) => {
        const p = f.properties ?? {};
        return {
          id: p.id ?? `nws-${i}`,
          event: p.event ?? '',
          headline: p.headline ?? '',
          description: String(p.description ?? '').slice(0, 300),
          severity: p.severity ?? 'Unknown',
          urgency: p.urgency ?? 'Unknown',
          areaDesc: p.areaDesc ?? '',
          onset: p.onset ?? '',
          expires: p.expires ?? '',
          status: p.status ?? '',
          centroid: extractAlertCentroid(f),
        };
      });
      return json(alerts);
    } catch {
      return json([], 200);
    }
  }

  // ── Disease Outbreak proxy (ReliefWeb + WHO, no API key) ─────────────────
  if (requestUrl.pathname === '/api/disease-outbreaks') {
    const RELIEFWEB_URL = 'https://api.reliefweb.int/v1/reports?appname=worldmonitor&filter[field]=type.name&filter[value]=Situation%20Report&filter[conditions][0][field]=theme.name&filter[conditions][0][value]=Health&limit=25&sort[]=date:desc&fields[include][]=title&fields[include][]=date&fields[include][]=country&fields[include][]=url';
    const WHO_URL = 'https://www.who.int/api/hubs/cms/s3fs-public/attachments/disease-outbreak-news.json';
    try {
      const [rwResp, whoResp] = await Promise.allSettled([
        fetchWithTimeout(RELIEFWEB_URL, { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } }, 15_000),
        fetchWithTimeout(WHO_URL, { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } }, 15_000),
      ]);
      const reliefweb = (rwResp.status === 'fulfilled' && rwResp.value.ok)
        ? await rwResp.value.json()
        : null;
      const who = (whoResp.status === 'fulfilled' && whoResp.value.ok)
        ? await whoResp.value.json()
        : null;
      return json({ reliefweb, who });
    } catch (error) {
      return json({ error: `disease-outbreaks fetch error: ${error.message ?? error}` }, 502);
    }
  }

  // ── Space Weather proxy (NOAA SWPC, no API key) ───────────────────────────
  if (requestUrl.pathname === '/api/space-weather-feeds') {
    const SW_URLS = {
      kp:       'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
      mag:      'https://services.swpc.noaa.gov/products/solar-wind/mag-5-minute.json',
      xray:     'https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json',
      alerts:   'https://services.swpc.noaa.gov/products/alerts.json',
      plasma:   'https://services.swpc.noaa.gov/products/solar-wind/plasma-5-minute.json',
    };
    try {
      const entries = Object.entries(SW_URLS);
      const settled = await Promise.allSettled(
        entries.map(([, url]) => fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } }, 15_000)),
      );
      const result = {};
      for (const [i, [key]] of entries.entries()) {
        const r = settled[i];
        result[key] = (r.status === 'fulfilled' && r.value.ok) ? await r.value.json() : null;
      }
      return json(result);
    } catch (error) {
      return json({ error: `space-weather-feeds fetch error: ${error.message ?? error}` }, 502);
    }
  }

  // ── Air Quality proxy (Open-Meteo, no API key, forwards lat/lon) ──────────
  if (requestUrl.pathname === '/api/air-quality-proxy') {
    const lat = requestUrl.searchParams.get('lat');
    const lon = requestUrl.searchParams.get('lon');
    if (!lat || !lon) return json({ error: 'Missing lat or lon query parameters' }, 400);
    const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide&timezone=auto`;
    try {
      const resp = await fetchWithTimeout(aqUrl, { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } }, 15_000);
      if (!resp.ok) return json({ error: `air-quality upstream error: ${resp.status}` }, 502);
      const data = await resp.json();
      return json(data);
    } catch (error) {
      return json({ error: `air-quality-proxy fetch error: ${error.message ?? error}` }, 502);
    }
  }

  // ── Stooq helpers (replaces Yahoo Finance — blocked by Cloudflare) ────────
  // Stooq.com: free, no API key, real-time US equities/ETFs/futures/crypto CSV.
  // Symbol conventions: AAPL → aapl.us, CL=F → cl.f, BTC-USD → btc.v
  // Batch quote URL: /q/l/?s=sym1+sym2&f=sd2t2ohlcvp&h&e=csv
  // Format: Symbol,Date,Time,Open,High,Low,Close,Volume,Prev

  function toStooqSym(yahooSym) {
    const s = (yahooSym ?? '').trim();
    if (!s) return null;
    // Index proxies (Stooq doesn't carry ^GSPC/^DJI/^IXIC directly)
    const IDX = { '^GSPC': 'spy.us', '^DJI': 'dia.us', '^IXIC': 'qqq.us', '^VIX': null };
    if (s in IDX) return IDX[s];
    if (s.endsWith('=F')) return s.slice(0, -2).toLowerCase() + '.f'; // CL=F → cl.f
    if (s.endsWith('-USD')) return s.slice(0, -4).toLowerCase() + '.v'; // BTC-USD → btc.v
    return s.toLowerCase() + '.us'; // AAPL → aapl.us, XLK → xlk.us, BRK-B → brk-b.us
  }

  function parseStooqBatchCsv(text) {
    // Returns Map<stooqSymLower, { price, change, prev }>
    const map = new Map();
    const lines = (text ?? '').trim().split('\n');
    for (let i = 1; i < lines.length; i++) { // skip header row
      const cols = lines[i].split(',');
      const sym   = (cols[0] ?? '').trim().toLowerCase();
      const date  = (cols[1] ?? '').trim();
      const close = Number.parseFloat(cols[6]);
      const prev  = Number.parseFloat(cols[8]);
      if (!sym || date === 'N/D' || isNaN(close)) continue;
      const change = (!isNaN(prev) && prev > 0)
        ? Number.parseFloat(((close - prev) / prev * 100).toFixed(2))
        : 0;
      map.set(sym, { price: close, change, prev: isNaN(prev) ? close : prev });
    }
    return map;
  }

  // Helper: parse a FRED CSV response and return the latest { current, previous } values.
  function parseFredCsvLatest(text) {
    const lines = (text ?? '').trim().split('\n').slice(1).filter(l => l && !/^observation/i.test(l));
    const recent = lines.slice(-2);
    const cur = Number.parseFloat((recent[recent.length - 1] ?? '').split(',')?.[1] ?? '');
    const prv = Number.parseFloat((recent[0] ?? '').split(',')?.[1] ?? '');
    return { current: cur, previous: prv };
  }

  // ── BTC ETF flows via Stooq ───────────────────────────────────────────────
  if (requestUrl.pathname === '/api/btc-etf-flows') {
    const BTC_ETFS = [
      { ticker: 'IBIT',  issuer: 'BlackRock'  },
      { ticker: 'FBTC',  issuer: 'Fidelity'   },
      { ticker: 'BITB',  issuer: 'Bitwise'    },
      { ticker: 'ARKB',  issuer: 'ARK'        },
      { ticker: 'BTCO',  issuer: 'Invesco'    },
      { ticker: 'HODL',  issuer: 'VanEck'     },
      { ticker: 'GBTC',  issuer: 'Grayscale'  },
      { ticker: 'BRRR',  issuer: 'Valkyrie'   },
    ];
    try {
      const stooqSyms = BTC_ETFS.map(e => e.ticker.toLowerCase() + '.us').join('+');
      const r = await fetchWithTimeout(
        `https://stooq.com/q/l/?s=${stooqSyms}&f=sd2t2ohlcvp&h&e=csv`,
        { headers: { 'User-Agent': CHROME_UA } }, 10_000
      );
      if (!r.ok) throw new Error(`Stooq ${r.status}`);
      const stooq = parseStooqBatchCsv(await r.text());
      let totalVolume = 0, totalEstFlow = 0, inflowCount = 0, outflowCount = 0;
      const etfs = BTC_ETFS.map(({ ticker, issuer }) => {
        const d = stooq.get(ticker.toLowerCase() + '.us');
        if (!d) return { ticker, issuer, price: 0, priceChange: 0, volume: 0, avgVolume: 0, volumeRatio: 1, direction: 'neutral', estFlow: 0 };
        const priceChange = d.change;
        // Estimate flow from price momentum (no avg-volume history available from Stooq batch)
        const estFlow = Math.round(d.price * 1_000_000 * (priceChange / 100));
        const direction = priceChange > 0.5 ? 'inflow' : (priceChange < -0.5 ? 'outflow' : 'neutral');
        totalVolume += d.price;
        totalEstFlow += estFlow;
        if (direction === 'inflow') inflowCount++;
        if (direction === 'outflow') outflowCount++;
        return { ticker, issuer, price: d.price, priceChange: d.change, volume: 0, avgVolume: 0, volumeRatio: 1, direction, estFlow };
      });
      const netDirection = totalEstFlow > 0 ? 'inflow' : (totalEstFlow < 0 ? 'outflow' : 'neutral');
      return json({
        timestamp: new Date().toISOString(),
        rateLimited: false,
        summary: { etfCount: etfs.length, totalVolume: Math.round(totalVolume), totalEstFlow: Math.round(totalEstFlow), netDirection, inflowCount, outflowCount },
        etfs,
      });
    } catch (error) {
      return json({ timestamp: new Date().toISOString(), rateLimited: false, etfs: [], error: String(error.message ?? error) });
    }
  }

  // ── Stablecoin markets via CoinGecko ─────────────────────────────────────
  if (requestUrl.pathname === '/api/stablecoin-markets') {
    const STABLECOINS = ['tether', 'usd-coin', 'dai', 'first-digital-usd', 'true-usd', 'frax'];
    try {
      const r = await fetchWithTimeout(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(STABLECOINS.join(','))}&price_change_percentage=24h,7d`,
        { headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' } },
        12_000
      );
      if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
      const data = await r.json();
      let totalMarketCap = 0, totalVolume24h = 0, depeggedCount = 0;
      const stablecoins = data.map(c => {
        const price = c.current_price ?? 1;
        const deviation = Math.abs(price - 1);
        const pegStatus = deviation < 0.002 ? 'ON PEG' : (deviation < 0.01 ? 'SLIGHT DEPEG' : 'DEPEGGED');
        if (pegStatus !== 'ON PEG') depeggedCount++;
        totalMarketCap += c.market_cap ?? 0;
        totalVolume24h += c.total_volume ?? 0;
        return {
          id: c.id,
          symbol: (c.symbol ?? '').toUpperCase(),
          name: c.name,
          price,
          deviation: Number.parseFloat(deviation.toFixed(4)),
          pegStatus,
          marketCap: c.market_cap ?? 0,
          volume24h: c.total_volume ?? 0,
          change24h: Number.parseFloat((c.price_change_percentage_24h ?? 0).toFixed(4)),
          change7d: Number.parseFloat((c.price_change_percentage_7d_in_currency ?? 0).toFixed(4)),
          image: c.image ?? '',
        };
      });
      const healthStatus = depeggedCount === 0 ? 'HEALTHY' : (depeggedCount <= 1 ? 'CAUTION' : 'STRESSED');
      return json({
        timestamp: new Date().toISOString(),
        summary: { totalMarketCap, totalVolume24h, coinCount: stablecoins.length, depeggedCount, healthStatus },
        stablecoins,
      });
    } catch (error) {
      return json({ timestamp: new Date().toISOString(), stablecoins: [], error: String(error.message ?? error) });
    }
  }

  // ── Macro signals (Market Radar) via alternative.me + Stooq ─────────────
  if (requestUrl.pathname === '/api/macro-signals') {
    try {
      // Fetch Fear & Greed (alternative.me) + market prices (Stooq) in parallel
      const [fngResp, pricesResp] = await Promise.allSettled([
        fetchWithTimeout('https://api.alternative.me/fng/?limit=1', { headers: { 'User-Agent': CHROME_UA } }, 8000),
        fetchWithTimeout(
          'https://stooq.com/q/l/?s=btc.v+qqq.us+xlp.us+spy.us+gc.f&f=sd2t2ohlcvp&h&e=csv',
          { headers: { 'User-Agent': CHROME_UA } }, 10_000
        ),
      ]);

      // Fear & Greed
      let fearGreed = null;
      if (fngResp.status === 'fulfilled' && fngResp.value.ok) {
        const fng = await fngResp.value.json();
        const val = Number.parseInt(fng?.data?.[0]?.value ?? '50', 10);
        const classification = fng?.data?.[0]?.value_classification ?? '';
        const status = val >= 75 ? 'EXTREME_GREED' : val >= 55 ? 'GREED' : val >= 45 ? 'NEUTRAL' : val >= 25 ? 'FEAR' : 'EXTREME_FEAR';
        fearGreed = { status, value: val, classification };
      }

      // Price signals from Stooq CSV
      let flowStructure = null, macroRegime = null, technicalTrend = null;
      if (pricesResp.status === 'fulfilled' && pricesResp.value.ok) {
        const stooq = parseStooqBatchCsv(await pricesResp.value.text());
        const btc = stooq.get('btc.v');
        const qqq = stooq.get('qqq.us');
        const xlp = stooq.get('xlp.us');
        const btcChange5 = btc?.change ?? 0;
        const qqqChange5 = qqq?.change ?? 0;
        const xlpChange5 = xlp?.change ?? 0;
        const flowStatus = btcChange5 > 2 && qqqChange5 > 0.5 ? 'RISK_ON' : (btcChange5 < -2 && qqqChange5 < -0.5 ? 'RISK_OFF' : 'NEUTRAL');
        flowStructure = { status: flowStatus, btcReturn5: btcChange5, qqqReturn5: qqqChange5 };
        const regimeStatus = qqqChange5 > 0.5 && xlpChange5 < qqqChange5 ? 'RISK_ON' : (qqqChange5 < -0.5 ? 'RISK_OFF' : 'NEUTRAL');
        macroRegime = { status: regimeStatus, qqqRoc20: qqqChange5, xlpRoc20: xlpChange5 };
        const btcPrice = btc?.price ?? 0;
        const techStatus = btcChange5 > 1 ? 'BULLISH' : (btcChange5 < -1 ? 'BEARISH' : 'NEUTRAL');
        technicalTrend = { status: techStatus, btcPrice, sma50: 0, sma200: 0, vwap30d: 0, mayerMultiple: 0, sparkline: [] };
      }

      const signals = { fearGreed, flowStructure, macroRegime, technicalTrend };
      const bullishCount = [fearGreed?.value > 50, flowStructure?.status === 'RISK_ON', macroRegime?.status === 'RISK_ON', technicalTrend?.status === 'BULLISH'].filter(Boolean).length;
      const totalCount = Object.values(signals).filter(s => s !== null).length;
      const verdict = bullishCount / totalCount > 0.6 ? 'BULLISH' : (bullishCount / totalCount < 0.4 ? 'BEARISH' : 'NEUTRAL');

      return json({
        timestamp: new Date().toISOString(),
        verdict,
        bullishCount,
        totalCount,
        unavailable: false,
        signals,
      });
    } catch (error) {
      return json({ timestamp: new Date().toISOString(), verdict: 'UNAVAILABLE', bullishCount: 0, totalCount: 0, unavailable: true, signals: null, error: String(error.message ?? error) });
    }
  }

  // ── Market quotes (stocks + commodities) via Finnhub → Stooq ────────────
  if (requestUrl.pathname === '/api/market-quotes') {
    const symbols = (requestUrl.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (symbols.length === 0) return json({ quotes: [] });

    // Try Finnhub first if key is set (higher precision, real-time)
    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (finnhubKey) {
      try {
        const quotes = await Promise.all(symbols.map(async sym => {
          try {
            const r = await fetchWithTimeout(
              `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(finnhubKey)}`,
              { headers: { 'User-Agent': CHROME_UA } }, 8000
            );
            if (!r.ok) return { symbol: sym, price: null, change: null };
            const d = await r.json();
            if (typeof d?.c !== 'number') return { symbol: sym, price: null, change: null };
            const change = d.pc > 0 ? ((d.c - d.pc) / d.pc) * 100 : 0;
            return { symbol: sym, price: d.c, change: Number.parseFloat(change.toFixed(2)) };
          } catch { return { symbol: sym, price: null, change: null }; }
        }));
        const valid = quotes.filter(q => q.price !== null);
        if (valid.length > 0) return json({ quotes, source: 'finnhub' });
      } catch { /* fall through to Stooq */ }
    }

    // Stooq CSV batch quote — free, no key, real-time US markets
    try {
      const vixRequested = symbols.includes('^VIX');
      const nonVix = symbols.filter(s => s !== '^VIX');
      const stooqSyms = nonVix.map(toStooqSym).filter(Boolean);

      let stooq = new Map();
      if (stooqSyms.length > 0) {
        const r = await fetchWithTimeout(
          `https://stooq.com/q/l/?s=${stooqSyms.join('+')}&f=sd2t2ohlcvp&h&e=csv`,
          { headers: { 'User-Agent': CHROME_UA } }, 10_000
        );
        if (!r.ok) throw new Error(`Stooq ${r.status}`);
        stooq = parseStooqBatchCsv(await r.text());
      }

      const quotes = symbols.map(origSym => {
        if (origSym === '^VIX') return { symbol: origSym, price: null, change: null }; // filled below
        const key = toStooqSym(origSym);
        const d = key ? stooq.get(key.toLowerCase()) : null;
        return { symbol: origSym, price: d?.price ?? null, change: d?.change ?? null };
      });

      // VIX via FRED CSV (1-day lag; adequate for the volatility indicator)
      if (vixRequested) {
        try {
          const fr = await fetchWithTimeout('https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS', {}, 5000);
          if (fr.ok) {
            const { current, previous } = parseFredCsvLatest(await fr.text());
            if (!isNaN(current)) {
              const vixChange = (!isNaN(previous) && previous > 0)
                ? Number.parseFloat(((current - previous) / previous * 100).toFixed(2)) : 0;
              const vixIdx = symbols.indexOf('^VIX');
              if (vixIdx !== -1) quotes[vixIdx] = { symbol: '^VIX', price: current, change: vixChange };
            }
          }
        } catch { /* leave VIX null */ }
      }

      return json({ quotes, source: 'stooq' });
    } catch (error) {
      return json({ quotes: symbols.map(sym => ({ symbol: sym, price: null, change: null })), error: String(error.message ?? error) });
    }
  }

  // ── Crypto quotes via CoinGecko ───────────────────────────────────────────
  if (requestUrl.pathname === '/api/crypto-quotes') {
    const ids = (requestUrl.searchParams.get('ids') || 'bitcoin,ethereum,solana,ripple');
    try {
      const r = await fetchWithTimeout(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true`,
        { headers: { 'User-Agent': CHROME_UA, 'Accept': 'application/json' } },
        12_000
      );
      if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
      const data = await r.json();
      const quotes = ids.split(',').map(id => {
        const d = data[id.trim()];
        return {
          id: id.trim(),
          price: d?.usd ?? null,
          change: d?.usd_24h_change == undefined ? null : Number.parseFloat(d.usd_24h_change.toFixed(2)),
        };
      });
      return json({ quotes });
    } catch (error) {
      return json({ quotes: [], error: String(error.message ?? error) });
    }
  }

  // ── FRED economic series — direct API call using stored key ──────────────
  // GET /api/fred-series?ids=WALCL,FEDFUNDS,... → calls api.stlouisfed.org
  if (requestUrl.pathname === '/api/fred-series') {
    const apiKey = process.env.FRED_API_KEY;
    if (!apiKey) return json({ series: [], error: 'FRED_API_KEY not configured' }, 503);
    const ids = (requestUrl.searchParams.get('ids') || 'WALCL,FEDFUNDS,T10Y2Y,UNRATE,CPIAUCSL,DGS10,VIXCLS').split(',').map(s => s.trim()).filter(Boolean);
    try {
      const results = await Promise.all(ids.map(async id => {
        try {
          const r = await fetchWithTimeout(
            `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(id)}&api_key=${encodeURIComponent(apiKey)}&file_type=json&limit=120&sort_order=asc&observation_start=2020-01-01`,
            { headers: { 'User-Agent': CHROME_UA } }, 10_000
          );
          if (!r.ok) return { id, observations: [], error: `FRED ${r.status}` };
          const data = await r.json();
          const obs = (data.observations ?? [])
            .filter(o => o.value !== '.')
            .map(o => ({ date: o.date, value: Number.parseFloat(o.value) }));
          return { id, observations: obs };
        } catch (error) {
          return { id, observations: [], error: String(error.message ?? error) };
        }
      }));
      return json({ series: results });
    } catch (error) {
      return json({ series: [], error: String(error.message ?? error) }, 500);
    }
  }

  // ── FRED fallback — free public data sources, no key required ────────────
  // Combines Yahoo Finance (VIX, yields), US Treasury yield curve, BLS (UNRATE/CPI)
  if (requestUrl.pathname === '/api/fred-fallback') {
    try {
      // FRED CSV replaces Yahoo Finance for VIX and Fed Funds — free, no auth, no Cloudflare block.
      // Treasury XML (DGS10, T10Y2Y) and BLS (UNRATE, CPIAUCSL) are already free — kept as-is.
      const [fredVixResp, fredFedFundsResp, treasuryResp, blsUnrateResp, blsCpiResp] = await Promise.allSettled([
        // FRED: VIX closing level (1-day lag)
        fetchWithTimeout('https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS', {}, 8000),
        // FRED: Federal Funds Effective Rate (monthly)
        fetchWithTimeout('https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS', {}, 8000),
        // US Treasury daily yield curve (free, no auth)
        fetchWithTimeout(
          `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${new Date().getFullYear()}`,
          { headers: { 'User-Agent': CHROME_UA, Accept: 'application/xml' } }, 10_000
        ),
        // BLS unemployment rate series (no key, public tier 1)
        fetchWithTimeout(
          'https://api.bls.gov/publicAPI/v1/timeseries/data/LNS14000000',
          { headers: { 'User-Agent': CHROME_UA, 'Content-Type': 'application/json' } }, 10_000
        ),
        // BLS CPI-U series (no key, public tier 1)
        fetchWithTimeout(
          'https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0',
          { headers: { 'User-Agent': CHROME_UA, 'Content-Type': 'application/json' } }, 10_000
        ),
      ]);

      const series = [];
      const today = new Date().toISOString().slice(0, 10);

      // FRED VIX
      if (fredVixResp.status === 'fulfilled' && fredVixResp.value.ok) {
        const { current } = parseFredCsvLatest(await fredVixResp.value.text());
        if (!isNaN(current) && current > 0) {
          series.push({ id: 'VIXCLS', observations: [{ date: today, value: current }] });
        }
      }

      // FRED Federal Funds Rate
      if (fredFedFundsResp.status === 'fulfilled' && fredFedFundsResp.value.ok) {
        const { current } = parseFredCsvLatest(await fredFedFundsResp.value.text());
        if (!isNaN(current) && current > 0) {
          series.push({ id: 'FEDFUNDS', observations: [{ date: today, value: current }] });
        }
      }

      // US Treasury yield curve XML (has 2-year for proper T10Y2Y)
      if (treasuryResp.status === 'fulfilled' && treasuryResp.value.ok) {
        const xml = await treasuryResp.value.text();
        // Extract latest 2-year and 10-year from XML
        const y2 = xml.match(/<d:BC_2YEAR[^>]*>([0-9.]+)<\/d:BC_2YEAR>/)?.[1];
        const y10 = xml.match(/<d:BC_10YEAR[^>]*>([0-9.]+)<\/d:BC_10YEAR>/)?.[1];
        if (y2 && y10) {
          const spread = Number.parseFloat((Number.parseFloat(y10) - Number.parseFloat(y2)).toFixed(2));
          // Overwrite the T10Y2Y approximation with accurate Treasury data
          const idx = series.findIndex(s => s.id === 'T10Y2Y');
          if (idx === -1) {series.push({ id: 'T10Y2Y', observations: [{ date: today, value: spread }] });}
          else {series[idx] = { id: 'T10Y2Y', observations: [{ date: today, value: spread }] };}
          // Also refine DGS10 with Treasury official value
          if (y10) {
            const idx10 = series.findIndex(s => s.id === 'DGS10');
            if (idx10 !== -1) series[idx10] = { id: 'DGS10', observations: [{ date: today, value: Number.parseFloat(y10) }] };
          }
        }
      }

      // BLS unemployment
      const blsUnrateObs = await (async () => {
        if (blsUnrateResp.status !== 'fulfilled' || !blsUnrateResp.value.ok) return null;
        const d = await blsUnrateResp.value.json();
        const pts = d?.Results?.series?.[0]?.data ?? [];
        return pts.slice(0, 6).reverse().map(p => ({
          date: `${p.year}-${String(p.period.replace('M', '')).padStart(2, '0')}-01`,
          value: Number.parseFloat(p.value),
        }));
      })();
      if (blsUnrateObs?.length) series.push({ id: 'UNRATE', observations: blsUnrateObs });

      // BLS CPI
      const blsCpiObs = await (async () => {
        if (blsCpiResp.status !== 'fulfilled' || !blsCpiResp.value.ok) return null;
        const d = await blsCpiResp.value.json();
        const pts = d?.Results?.series?.[0]?.data ?? [];
        return pts.slice(0, 6).reverse().map(p => ({
          date: `${p.year}-${String(p.period.replace('M', '')).padStart(2, '0')}-01`,
          value: Number.parseFloat(p.value),
        }));
      })();
      if (blsCpiObs?.length) series.push({ id: 'CPIAUCSL', observations: blsCpiObs });

      return json({ series, source: 'free-fallback' });
    } catch (error) {
      return json({ series: [], error: String(error.message ?? error) }, 500);
    }
  }

  // ── Energy prices — Stooq (WTI/NatGas) + FRED CSV (Brent) ───────────────
  // Returns WTI (cl.f), Brent (DCOILBRENTEU), NatGas (ng.f) — no API key required
  if (requestUrl.pathname === '/api/energy-fallback') {
    try {
      const [stooqResp, brentResp] = await Promise.allSettled([
        // Stooq: WTI crude + Natural Gas (real-time futures)
        fetchWithTimeout(
          'https://stooq.com/q/l/?s=cl.f+ng.f&f=sd2t2ohlcvp&h&e=csv',
          { headers: { 'User-Agent': CHROME_UA } }, 10_000
        ),
        // FRED: Brent crude daily spot price (1-day lag, free, no auth)
        fetchWithTimeout('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU', {}, 8000),
      ]);

      const prices = [];
      const now = new Date().toISOString();

      if (stooqResp.status === 'fulfilled' && stooqResp.value.ok) {
        const stooq = parseStooqBatchCsv(await stooqResp.value.text());
        const wti = stooq.get('cl.f');
        if (wti && wti.price > 0) prices.push({
          commodity: 'wti', name: 'WTI Crude Oil', price: wti.price, unit: '$/bbl',
          change: wti.change,
          trend: wti.change > 0.5 ? 'up' : (wti.change < -0.5 ? 'down' : 'stable'),
          previous: Number.parseFloat(wti.prev.toFixed(2)), priceAt: now,
        });
        const ng = stooq.get('ng.f');
        if (ng && ng.price > 0) prices.push({
          commodity: 'natgas', name: 'Natural Gas', price: ng.price, unit: '$/MMBtu',
          change: ng.change,
          trend: ng.change > 0.5 ? 'up' : (ng.change < -0.5 ? 'down' : 'stable'),
          previous: Number.parseFloat(ng.prev.toFixed(2)), priceAt: now,
        });
      }

      if (brentResp.status === 'fulfilled' && brentResp.value.ok) {
        const { current, previous } = parseFredCsvLatest(await brentResp.value.text());
        if (!isNaN(current) && current > 0) {
          const change = (!isNaN(previous) && previous > 0)
            ? Number.parseFloat(((current - previous) / previous * 100).toFixed(2)) : 0;
          prices.push({
            commodity: 'brent', name: 'Brent Crude Oil', price: current, unit: '$/bbl',
            change,
            trend: change > 0.5 ? 'up' : (change < -0.5 ? 'down' : 'stable'),
            previous: isNaN(previous) ? current : Number.parseFloat(previous.toFixed(2)), priceAt: now,
          });
        }
      }

      return json({ prices, source: 'stooq+fred' });
    } catch (error) {
      return json({ prices: [], error: String(error.message ?? error) }, 500);
    }
  }

  // ── Stock chart — sparkline history via Stooq daily CSV ──────────────────
  // GET /api/stock-chart?symbol=AAPL&range=1mo&interval=1d
  if (requestUrl.pathname === '/api/stock-chart') {
    const symbol = requestUrl.searchParams.get('symbol') ?? '';
    const range = requestUrl.searchParams.get('range') ?? '1mo';
    if (!symbol) return json({ closes: [], error: 'Missing symbol' }, 400);
    try {
      const stooqSym = toStooqSym(symbol);
      if (!stooqSym) return json({ symbol, points: [], closes: [], error: 'Symbol not mappable' });

      const r = await fetchWithTimeout(
        `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`,
        { headers: { 'User-Agent': CHROME_UA } }, 12_000
      );
      if (!r.ok) throw new Error(`Stooq chart ${r.status}`);
      const text = await r.text();

      // Stooq returns: Date,Open,High,Low,Close,Volume (header + oldest-first rows)
      const RANGE_DAYS = { '1d': 1, '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365, '2y': 730, '5y': 1825, 'max': 999_999 };
      const days = RANGE_DAYS[range] ?? 30;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

      const points = text.trim().split('\n')
        .filter(l => /^\d{4}-\d{2}-\d{2}/.test(l))   // data rows only (skip header)
        .filter(l => l.split(',')[0]?.trim() >= cutoff)
        .map(l => {
          const cols = l.split(',');
          const date = cols[0]?.trim();
          const close = Number.parseFloat(cols[4]);
          return (!date || isNaN(close)) ? null : { date, close };
        })
        .filter(Boolean);

      return json({ symbol, points, closes: points.map(p => p.close) });
    } catch (error) {
      return json({ symbol, points: [], closes: [], error: String(error.message ?? error) });
    }
  }

  // ── NASA FIRMS satellite fire detections ─────────────────────────────────
  if (requestUrl.pathname === '/api/nasa-firms') {
    const apiKey = process.env.NASA_FIRMS_API_KEY;
    if (!apiKey) return json({ fires: [], error: 'NASA_FIRMS_API_KEY not configured' }, 503);

    // Cover the globe with 6 bounding boxes each well under the 10M km² area limit.
    // Format: [west, south, east, north]
    const REGIONS = [
      { name: 'N_America',   bbox: [-170, 15, -52, 72]  },
      { name: 'S_America',   bbox: [-82,  -56, -34, 15]  },
      { name: 'Europe',      bbox: [-25,  35,  55,  72]  },
      { name: 'Africa',      bbox: [-20, -35,  55,  38]  },
      { name: 'Asia',        bbox: [25,  -10, 145,  72]  },
      { name: 'Oceania',     bbox: [100, -50, 180, -10]  },
    ];

    // Parse a VIIRS CSV row into a lightweight fire object
    function parseFiresCsv(csvText, regionName) {
      const lines = csvText.trim().split('\n');
      if (lines.length < 2) return [];
      const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      const latIdx   = header.indexOf('latitude');
      const lonIdx   = header.indexOf('longitude');
      const brightIdx = header.indexOf('bright_ti4');
      const frpIdx   = header.indexOf('frp');
      const confIdx  = header.indexOf('confidence');
      const dateIdx  = header.indexOf('acq_date');
      const dnIdx    = header.indexOf('daynight');
      if (latIdx === -1 || lonIdx === -1) return [];
      return lines.slice(1).flatMap(line => {
        const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
        const lat  = Number.parseFloat(cols[latIdx]);
        const lon  = Number.parseFloat(cols[lonIdx]);
        if (isNaN(lat) || isNaN(lon)) return [];
        const confRaw = (cols[confIdx] ?? '').toLowerCase();
        const confidence = confRaw === 'h' || confRaw === 'high' ? 'FIRE_CONFIDENCE_HIGH'
                         : (confRaw === 'n' || confRaw === 'nominal' ? 'FIRE_CONFIDENCE_NOMINAL'
                         : 'FIRE_CONFIDENCE_LOW');
        return [{
          lat,
          lon,
          brightness: Number.parseFloat(cols[brightIdx]) || 0,
          frp:        Number.parseFloat(cols[frpIdx])    || 0,
          confidence,
          region:     regionName,
          acq_date:   cols[dateIdx] ?? '',
          daynight:   cols[dnIdx]   ?? 'D',
        }];
      });
    }

    try {
      const results = await Promise.allSettled(
        REGIONS.map(({ name, bbox }) => {
          const [w, s, e, n] = bbox;
          const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(apiKey)}/VIIRS_SNPP_NRT/${w},${s},${e},${n}/1`;
          return fetchWithTimeout(url, { headers: { 'User-Agent': CHROME_UA } }, 20_000)
            .then(r => r.ok ? r.text() : Promise.resolve(''))
            .then(csv => parseFiresCsv(csv, name));
        })
      );
      const fires = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
      return json({ fires, count: fires.length });
    } catch (error) {
      return json({ fires: [], error: String(error.message ?? error) }, 500);
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
      }, parsed.hostname.includes('news.google.com') ? 20_000 : 12_000);
      const contentType = response.headers?.get?.('content-type') || 'application/xml';
      const rssBody = await response.text();
      return new Response(rssBody || '', {
        status: response.status,
        headers: { 'content-type': contentType },
      });
    } catch (error) {
      const isTimeout = error.name === 'AbortError' || error.message?.includes('timeout');
      return json({ error: isTimeout ? 'Feed timeout' : 'Failed to fetch feed' }, isTimeout ? 504 : 502);
    }
  }

  if (requestUrl.pathname === '/api/local-env-update') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body) {
        try {
          const { key, value } = JSON.parse(body.toString());
          if (typeof key === 'string' && key.length > 0 && ALLOWED_ENV_KEYS.has(key)) {
            if (value == undefined || value === '') {
              delete process.env[key];
              context.logger.log(`[local-api] env unset: ${key}`);
            } else {
              process.env[key] = String(value);
              context.logger.log(`[local-api] env set: ${key}`);
            }
            if (key === 'AISSTREAM_API_KEY') aisOnKeyChanged(value || null);
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

  // ── AI Strategic Posture — proxy cloud API server-side (bypasses browser CORS) ─
  if (requestUrl.pathname === '/api/military/v1/get-theater-posture') {
    const now = Math.floor(Date.now() / 1000);
    const THEATER_STUB = [
      { theater: 'iran-theater',        postureLevel: 'normal', activeFlights: 0, trackedVessels: 0, activeOperations: [], assessedAt: now },
      { theater: 'taiwan-theater',      postureLevel: 'normal', activeFlights: 0, trackedVessels: 0, activeOperations: [], assessedAt: now },
      { theater: 'baltic-theater',      postureLevel: 'normal', activeFlights: 0, trackedVessels: 0, activeOperations: [], assessedAt: now },
      { theater: 'blacksea-theater',    postureLevel: 'normal', activeFlights: 0, trackedVessels: 0, activeOperations: [], assessedAt: now },
      { theater: 'korea-theater',       postureLevel: 'normal', activeFlights: 0, trackedVessels: 0, activeOperations: [], assessedAt: now },
      { theater: 'south-china-sea',     postureLevel: 'normal', activeFlights: 0, trackedVessels: 0, activeOperations: [], assessedAt: now },
      { theater: 'east-med-theater',    postureLevel: 'normal', activeFlights: 0, trackedVessels: 0, activeOperations: [], assessedAt: now },
      { theater: 'israel-gaza-theater', postureLevel: 'normal', activeFlights: 0, trackedVessels: 0, activeOperations: [], assessedAt: now },
      { theater: 'yemen-redsea-theater',postureLevel: 'normal', activeFlights: 0, trackedVessels: 0, activeOperations: [], assessedAt: now },
    ];
    try {
      // Node.js is not subject to browser CORS — proxy directly to cloud API server-side
      const cloudUrl = 'https://api.worldmonitor.app/api/military/v1/get-theater-posture' + requestUrl.search;
      const cloudResp = await fetchWithTimeout(cloudUrl, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      }, 10_000);
      if (cloudResp.ok) {
        const body = await cloudResp.json();
        // Validate shape before forwarding
        if (body && Array.isArray(body.theaters)) return json(body);
      }
    } catch { /* timeout / network error — fall through to stub */ }
    // Return stub so panel renders all theaters at "normal" rather than spinning forever
    return json({ theaters: THEATER_STUB });
  }

  if (requestUrl.pathname === '/api/comms-health') {
    const cached = getCached('comms-health', 2 * 60 * 1000);
    if (cached) return json(cached);

    const CABLE_AS_MAP = { '3549': 'MAREA', '1273': 'TAT-14', '3257': 'AAG', '2914': 'APAC-1', '6453': 'FLAG' };
    const cfToken = process.env.CLOUDFLARE_API_TOKEN;
    const cfHeaders = cfToken ? { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' } : null;

    const cfHijacksPromise = cfHeaders
      ? fetchWithTimeout('https://api.cloudflare.com/client/v4/radar/bgp/hijacks/events?limit=50', { headers: cfHeaders }, 10_000)
      : Promise.reject(new Error('no CF token'));
    const cfLeaksPromise = cfHeaders
      ? fetchWithTimeout('https://api.cloudflare.com/client/v4/radar/bgp/leaks/events?limit=50', { headers: cfHeaders }, 10_000)
      : Promise.reject(new Error('no CF token'));
    const cfDdosPromise = cfHeaders
      ? fetchWithTimeout('https://api.cloudflare.com/client/v4/radar/attacks/layer7/summary', { headers: cfHeaders }, 10_000)
      : Promise.reject(new Error('no CF token'));
    const ripeStatusPromise = fetchWithTimeout('https://stat.ripe.net/data/routing-status/data.json?resource=0.0.0.0/0', {}, 10_000);
    const ihrPromise = fetchWithTimeout('https://ihr.iijlab.net/ihr/api/network/?format=json&search=&last=1', {}, 10_000);

    const [cfHijacksRes, cfLeaksRes, cfDdosRes, ripeStatusRes, ihrRes] =
      await Promise.allSettled([cfHijacksPromise, cfLeaksPromise, cfDdosPromise, ripeStatusPromise, ihrPromise]);

    try {
      // BGP hijacks
      let hijackCount = 0;
      if (cfHijacksRes.status === 'fulfilled' && cfHijacksRes.value.ok) {
        const d = await cfHijacksRes.value.json().catch(() => null);
        hijackCount = d?.result?.events?.length ?? d?.result?.total ?? 0;
      }

      // BGP leaks
      let leakCount = 0;
      if (cfLeaksRes.status === 'fulfilled' && cfLeaksRes.value.ok) {
        const d = await cfLeaksRes.value.json().catch(() => null);
        leakCount = d?.result?.events?.length ?? d?.result?.total ?? 0;
      }

      const bgpSeverity = hijackCount > 15 ? 'critical' : (hijackCount >= 5 ? 'warning' : 'normal');

      // DDoS
      let ddosL7 = 'normal';
      const ddosMissing = !cfToken;
      if (cfDdosRes.status === 'fulfilled' && cfDdosRes.value.ok) {
        const d = await cfDdosRes.value.json().catch(() => null);
        const pct = d?.result?.summary_0?.total ?? 0;
        ddosL7 = pct > 5 ? 'elevated' : 'normal';
      }

      // Cables — check IHR for AS numbers matching known cable operators
      const degradedCables = [];
      const normalCables = [];
      if (ihrRes.status === 'fulfilled' && ihrRes.value.ok) {
        const d = await ihrRes.value.json().catch(() => null);
        const networks = d?.results ?? [];
        const degradedAsns = new Set(
          networks
            .filter(n => n.ihr_score != undefined && n.ihr_score < 0.5)
            .map(n => String(n.asn ?? ''))
        );
        for (const [asn, cable] of Object.entries(CABLE_AS_MAP)) {
          if (degradedAsns.has(asn)) degradedCables.push(cable);
          else normalCables.push(cable);
        }
      } else {
        normalCables.push(...Object.values(CABLE_AS_MAP));
      }

      // IXP status — use RIPE routing status for broad signal
      let ixpStatus = 'normal';
      if (ripeStatusRes.status === 'fulfilled' && ripeStatusRes.value.ok) {
        const d = await ripeStatusRes.value.json().catch(() => null);
        const visibility = d?.data?.visibility ?? 1;
        if (visibility < 0.9) ixpStatus = 'warning';
      }

      const severityRank = s => s === 'critical' ? 2 : (s === 'warning' ? 1 : 0);
      let overallRank = severityRank(bgpSeverity);
      if (!ddosMissing) overallRank = Math.max(overallRank, severityRank(ddosL7 === 'elevated' ? 'warning' : 'normal'));
      if (ixpStatus !== 'normal') overallRank = Math.max(overallRank, 1);
      if (degradedCables.length > 0) overallRank = Math.max(overallRank, 1);
      const overall = overallRank === 2 ? 'critical' : (overallRank === 1 ? 'warning' : 'normal');

      const result = {
        overall,
        bgp: { hijacks: hijackCount, leaks: leakCount, severity: bgpSeverity },
        ixp: { status: ixpStatus, degraded: [] },
        ddos: { l7: ddosL7, l3: 'normal', cloudflareKeyMissing: ddosMissing },
        cables: { degraded: degradedCables, normal: normalCables },
        updatedAt: new Date().toISOString(),
      };
      setCached('comms-health', result);
      return json(result);
    } catch (error) {
      return json({
        overall: 'unknown',
        bgp: { hijacks: 0, leaks: 0, severity: 'normal' },
        ixp: { status: 'normal', degraded: [] },
        ddos: { l7: 'normal', l3: 'normal', cloudflareKeyMissing: !cfToken },
        cables: { degraded: [], normal: Object.values(CABLE_AS_MAP) },
        updatedAt: new Date().toISOString(),
        error: error?.message ?? 'unknown',
      });
    }
  }

  if (requestUrl.pathname === '/api/economic-stress') {
    const cached = getCached('economic-stress', 15 * 60 * 1000);
    if (cached) return json(cached);

    const fredKey = process.env.FRED_API_KEY;
    if (!fredKey) return json({ fredKeyMissing: true, error: 'FRED_API_KEY required' });

    try {
      const [t10y2yRes, t10y3mRes, vixRes, fsiRes, gscpiRes, icsaRes, wbRes] = await Promise.allSettled([
        fetchFredSeries('T10Y2Y',  fredKey),
        fetchFredSeries('T10Y3M',  fredKey),
        fetchFredSeries('VIXCLS',  fredKey),
        fetchFredSeries('STLFSI4', fredKey),
        fetchFredSeries('GSCPI',   fredKey),
        fetchFredSeries('ICSA',    fredKey),
        fetchWithTimeout('https://api.worldbank.org/v2/country/WLD/indicator/AG.PRD.FOOD.XD?format=json&mrv=1'),
      ]);

      const yieldVal  = t10y2yRes.status === 'fulfilled' ? t10y2yRes.value : 0;
      const spreadVal = t10y3mRes.status === 'fulfilled' ? t10y3mRes.value : 0;
      const vixVal    = vixRes.status   === 'fulfilled' ? vixRes.value   : 20;
      const fsiVal    = fsiRes.status   === 'fulfilled' ? fsiRes.value   : 0;
      const scVal     = gscpiRes.status === 'fulfilled' ? gscpiRes.value : 0;
      const claimsVal = icsaRes.status  === 'fulfilled' ? icsaRes.value  : 220_000;

      const yieldScore  = clamp((0.5 - yieldVal)  / (0.5 - (-1.5)) * 100);
      const spreadScore = clamp((0.5 - spreadVal)  / (0.5 - (-1)) * 100);
      const vixScore    = clamp((vixVal - 15)      / (80 - 15)      * 100);
      const fsiScore    = clamp((fsiVal - (-1))    / (5 - (-1))     * 100);
      const scScore     = clamp((scVal - (-2))     / (4 - (-2))     * 100);
      const claimsScore = clamp((claimsVal - 180_000) / (500_000 - 180_000) * 100);

      const stressIndex = computeStressIndex(yieldVal, spreadVal, vixVal, fsiVal, scVal, claimsVal);

      const trend = _prevEconomicStressIndex === null ? 'stable'
        : stressIndex > _prevEconomicStressIndex + 2 ? 'rising'
        : stressIndex < _prevEconomicStressIndex - 2 ? 'falling'
        : 'stable';
      _prevEconomicStressIndex = stressIndex;

      let foodSecurity;
      if (wbRes.status === 'fulfilled') {
        try {
          const wbData = await wbRes.value.json();
          const val = wbData?.[1]?.[0]?.value;
          foodSecurity = val == undefined
            ? { value: null, severity: 'unknown' }
            : { value: Math.round(val * 10) / 10, severity: val < 50 ? 'critical' : (val < 65 ? 'warning' : 'normal') };
        } catch {
          foodSecurity = { value: null, severity: 'unknown' };
        }
      } else {
        foodSecurity = { value: null, severity: 'unknown' };
      }

      const result = {
        stressIndex,
        trend,
        indicators: {
          yieldCurve:  { value: yieldVal,  label: yieldVal < -0.1 ? 'INVERTED' : (yieldVal < 0.2 ? 'FLAT' : 'NORMAL'),    severity: indicatorSeverity(yieldScore)  },
          bankSpread:  { value: spreadVal, label: spreadVal < -0.1 ? 'INVERTED' : 'NORMAL',                               severity: indicatorSeverity(spreadScore) },
          vix:         { value: vixVal,    label: vixVal > 30 ? 'ELEVATED' : (vixVal > 20 ? 'RISING' : 'NORMAL'),          severity: indicatorSeverity(vixScore)    },
          fsi:         { value: fsiVal,    label: fsiVal > 1 ? 'ELEVATED' : (fsiVal > 0 ? 'RISING' : 'NORMAL'),            severity: indicatorSeverity(fsiScore)    },
          supplyChain: { value: scVal,     label: scVal > 1 ? 'STRAINED' : 'NORMAL',                                      severity: indicatorSeverity(scScore),    lagWeeks: 6 },
          jobClaims:   { value: claimsVal, label: claimsVal > 300_000 ? 'RISING' : 'NORMAL',                               severity: indicatorSeverity(claimsScore) },
        },
        foodSecurity,
        updatedAt: new Date().toISOString(),
      };
      setCached('economic-stress', result);
      return json(result);
    } catch (error) {
      return json({ stressIndex: 0, error: error?.message ?? 'unknown', fredKeyMissing: false });
    }
  }

  // ── Fear & Greed Index (alternative.me, no key required) ─────────────────
  if (requestUrl.pathname === '/api/fear-greed') {
    const cached = getCached('fear-greed', 60 * 60 * 1000); // 1 hour
    if (cached) return json(cached);
    try {
      const res = await fetchWithTimeout('https://api.alternative.me/fng/?limit=7', {}, 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const entries = data?.data ?? [];
      const [latest, ...rest] = entries;
      const result = {
        score: Number.parseInt(latest?.value ?? '50', 10),
        classification: latest?.value_classification ?? 'Neutral',
        history: rest.map(e => ({ value: Number.parseInt(e.value, 10), timestamp: e.timestamp })),
        updatedAt: Number.parseInt(latest?.timestamp ?? String(Math.floor(Date.now() / 1000)), 10),
      };
      setCached('fear-greed', result);
      return json(result);
    } catch (error) {
      return json({ score: 50, classification: 'Neutral', history: [], updatedAt: Math.floor(Date.now() / 1000), error: error?.message ?? 'unknown' });
    }
  }

  // ── National Debt / GDP (World Bank, no key required) ─────────────────────
  if (requestUrl.pathname === '/api/national-debt') {
    const cached = getCached('national-debt', 24 * 60 * 60 * 1000); // 24 hours
    if (cached) return json(cached);
    try {
      const url = 'https://api.worldbank.org/v2/country/all/indicator/GC.DOD.TOTL.GD.ZS?format=json&mrv=5&per_page=300';
      const res = await fetchWithTimeout(url, {}, 12_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = data?.[1] ?? [];
      const seen = new Map();
      for (const row of rows) {
        if (!row.country?.value || row.value == undefined) continue;
        const code = row.countryiso3code || row.country?.id || '';
        // skip aggregates (all-caps 3-char codes are typically regional aggregates from WB)
        if (!code || code.length !== 3) continue;
        if (!seen.has(code)) {
          seen.set(code, { code, name: row.country.value, debtPctGdp: Number.parseFloat(row.value.toFixed(1)), year: row.date });
        }
      }
      const countries = [...seen.values()].sort((a, b) => b.debtPctGdp - a.debtPctGdp).slice(0, 30);
      const result = { countries, updatedAt: Math.floor(Date.now() / 1000) };
      setCached('national-debt', result);
      return json(result);
    } catch (error) {
      return json({ countries: [], updatedAt: Math.floor(Date.now() / 1000), error: error?.message ?? 'unknown' });
    }
  }

  // ── Fuel Prices (EIA v2, free key required) ───────────────────────────────
  if (requestUrl.pathname === '/api/fuel-prices') {
    const eiaKey = process.env.EIA_API_KEY;
    if (!eiaKey) return json({ regions: [], keyMissing: true, updatedAt: Math.floor(Date.now() / 1000) });
    const cached = getCached('fuel-prices', 12 * 60 * 60 * 1000); // 12 hours
    if (cached) return json(cached);
    try {
      const base = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/';
      const params = new URLSearchParams({
        'api_key': eiaKey,
        'frequency': 'weekly',
        'data[0]': 'value',
        'facets[duoarea][]': 'NUS',
        'facets[process][]': 'PTE',
        'sort[0][column]': 'period',
        'sort[0][direction]': 'desc',
        'length': '20',
      });
      // fetch gasoline (EPM0) and diesel (EPD2D) together
      const paramStr = params.toString() + '&facets[duoarea][]=R10&facets[duoarea][]=R20&facets[duoarea][]=R30&facets[duoarea][]=R40&facets[duoarea][]=R50&facets[product][]=EPM0&facets[product][]=EPD2D';
      const res = await fetchWithTimeout(`${base}?${paramStr}`, {}, 12_000);
      if (!res.ok) throw new Error(`EIA HTTP ${res.status}`);
      const data = await res.json();
      const rows = data?.response?.data ?? [];

      const AREA_NAMES = { NUS: 'U.S. Average', R10: 'East Coast', R20: 'Midwest', R30: 'Gulf Coast', R40: 'Rocky Mountain', R50: 'West Coast' };
      const AREA_ORDER = ['NUS', 'R10', 'R20', 'R30', 'R40', 'R50'];

      // Group latest value per (duoarea, product)
      const latest = new Map();
      for (const row of rows) {
        const key = `${row.duoarea}|${row.product}`;
        if (!latest.has(key)) latest.set(key, row);
      }

      const regions = AREA_ORDER.map(area => {
        const gasRow = latest.get(`${area}|EPM0`);
        const dslRow = latest.get(`${area}|EPD2D`);
        return {
          name: AREA_NAMES[area] ?? area,
          gasolineUsd: gasRow ? Number.parseFloat(gasRow.value) : 0,
          dieselUsd: dslRow ? Number.parseFloat(dslRow.value) : 0,
          period: gasRow?.period ?? dslRow?.period ?? '',
        };
      }).filter(r => r.gasolineUsd > 0 || r.dieselUsd > 0);

      const result = { regions, keyMissing: false, updatedAt: Math.floor(Date.now() / 1000) };
      setCached('fuel-prices', result);
      return json(result);
    } catch (error) {
      return json({ regions: [], keyMissing: false, updatedAt: Math.floor(Date.now() / 1000), error: error?.message ?? 'unknown' });
    }
  }

  // ── GDELT Intelligence (no key required, public API) ──────────────────────
  if (requestUrl.pathname === '/api/gdelt-intel') {
    const cached = getCached('gdelt-intel', 15 * 60 * 1000); // 15 minutes
    if (cached) return json(cached);
    try {
      const params = new URLSearchParams({
        query: 'war OR conflict OR crisis OR military OR sanctions OR nuclear',
        mode: 'artlist',
        maxrecords: '25',
        format: 'json',
        sort: 'ToneAsc',
        timespan: '3h',
      });
      const res = await fetchWithTimeout(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, { headers: { 'User-Agent': CHROME_UA } }, 12_000);
      if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
      const data = await res.json();
      const articles = data?.articles ?? [];
      const events = articles.map(a => ({
        title: a.title ?? '',
        url: a.url ?? '',
        source: a.domain ?? '',
        tone: typeof a.tone === 'number' ? Math.round(a.tone * 10) / 10 : 0,
        country: a.sourcecountry ?? '',
        timestamp: a.seendate
          ? new Date(a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')).getTime()
          : Date.now(),
      })).filter(e => e.title && e.url);
      const result = { events, updatedAt: Math.floor(Date.now() / 1000) };
      setCached('gdelt-intel', result);
      return json(result);
    } catch (error) {
      // Serve last-known data rather than an empty response — GDELT 503s are transient
      const stale = getCachedStale('gdelt-intel');
      if (stale) return json({ ...stale, stale: true, error: error?.message ?? 'unknown' });
      return json({ events: [], updatedAt: Math.floor(Date.now() / 1000), error: error?.message ?? 'unknown' });
    }
  }

  // ── Fear & Greed Index (alternative.me, no key required) ─────────────────
  if (requestUrl.pathname === '/api/fear-greed') {
    const cached = getCached('fear-greed', 60 * 60 * 1000); // 1 hour
    if (cached) return json(cached);
    try {
      const res = await fetchWithTimeout('https://api.alternative.me/fng/?limit=7', {}, 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const entries = data?.data ?? [];
      const [latest, ...rest] = entries;
      const result = {
        score: parseInt(latest?.value ?? '50', 10),
        classification: latest?.value_classification ?? 'Neutral',
        history: rest.map(e => ({ value: parseInt(e.value, 10), timestamp: e.timestamp })),
        updatedAt: parseInt(latest?.timestamp ?? String(Math.floor(Date.now() / 1000)), 10),
      };
      setCached('fear-greed', result);
      return json(result);
    } catch (e) {
      return json({ score: 50, classification: 'Neutral', history: [], updatedAt: Math.floor(Date.now() / 1000), error: e?.message ?? 'unknown' });
    }
  }

  // ── National Debt / GDP (World Bank, no key required) ─────────────────────
  if (requestUrl.pathname === '/api/national-debt') {
    const cached = getCached('national-debt', 24 * 60 * 60 * 1000); // 24 hours
    if (cached) return json(cached);
    try {
      const url = 'https://api.worldbank.org/v2/country/all/indicator/GC.DOD.TOTL.GD.ZS?format=json&mrv=5&per_page=300';
      const res = await fetchWithTimeout(url, {}, 12000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = data?.[1] ?? [];
      const seen = new Map();
      for (const row of rows) {
        if (!row.country?.value || row.value == null) continue;
        const code = row.countryiso3code || row.country?.id || '';
        // skip aggregates (all-caps 3-char codes are typically regional aggregates from WB)
        if (!code || code.length !== 3) continue;
        if (!seen.has(code)) {
          seen.set(code, { code, name: row.country.value, debtPctGdp: parseFloat(row.value.toFixed(1)), year: row.date });
        }
      }
      const countries = [...seen.values()].sort((a, b) => b.debtPctGdp - a.debtPctGdp).slice(0, 30);
      const result = { countries, updatedAt: Math.floor(Date.now() / 1000) };
      setCached('national-debt', result);
      return json(result);
    } catch (e) {
      return json({ countries: [], updatedAt: Math.floor(Date.now() / 1000), error: e?.message ?? 'unknown' });
    }
  }

  // ── Fuel Prices (EIA v2, free key required) ───────────────────────────────
  if (requestUrl.pathname === '/api/fuel-prices') {
    const eiaKey = process.env.EIA_API_KEY;
    if (!eiaKey) return json({ regions: [], keyMissing: true, updatedAt: Math.floor(Date.now() / 1000) });
    const cached = getCached('fuel-prices', 12 * 60 * 60 * 1000); // 12 hours
    if (cached) return json(cached);
    try {
      const base = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/';
      const params = new URLSearchParams({
        'api_key': eiaKey,
        'frequency': 'weekly',
        'data[0]': 'value',
        'facets[duoarea][]': 'NUS',
        'facets[process][]': 'PTE',
        'sort[0][column]': 'period',
        'sort[0][direction]': 'desc',
        'length': '20',
      });
      // fetch gasoline (EPM0) and diesel (EPD2D) together
      const paramStr = params.toString() + '&facets[duoarea][]=R10&facets[duoarea][]=R20&facets[duoarea][]=R30&facets[duoarea][]=R40&facets[duoarea][]=R50&facets[product][]=EPM0&facets[product][]=EPD2D';
      const res = await fetchWithTimeout(`${base}?${paramStr}`, {}, 12000);
      if (!res.ok) throw new Error(`EIA HTTP ${res.status}`);
      const data = await res.json();
      const rows = data?.response?.data ?? [];

      const AREA_NAMES = { NUS: 'U.S. Average', R10: 'East Coast', R20: 'Midwest', R30: 'Gulf Coast', R40: 'Rocky Mountain', R50: 'West Coast' };
      const AREA_ORDER = ['NUS', 'R10', 'R20', 'R30', 'R40', 'R50'];

      // Group latest value per (duoarea, product)
      const latest = new Map();
      for (const row of rows) {
        const key = `${row.duoarea}|${row.product}`;
        if (!latest.has(key)) latest.set(key, row);
      }

      const regions = AREA_ORDER.map(area => {
        const gasRow = latest.get(`${area}|EPM0`);
        const dslRow = latest.get(`${area}|EPD2D`);
        return {
          name: AREA_NAMES[area] ?? area,
          gasolineUsd: gasRow ? parseFloat(gasRow.value) : 0,
          dieselUsd: dslRow ? parseFloat(dslRow.value) : 0,
          period: gasRow?.period ?? dslRow?.period ?? '',
        };
      }).filter(r => r.gasolineUsd > 0 || r.dieselUsd > 0);

      const result = { regions, keyMissing: false, updatedAt: Math.floor(Date.now() / 1000) };
      setCached('fuel-prices', result);
      return json(result);
    } catch (e) {
      return json({ regions: [], keyMissing: false, updatedAt: Math.floor(Date.now() / 1000), error: e?.message ?? 'unknown' });
    }
  }

  // ── AIS snapshot — served from sidecar's own aisstream.io connection ────────
  if (requestUrl.pathname === '/api/ais-snapshot') {
    const apiKey = process.env.AISSTREAM_API_KEY;
    if (!apiKey) {
      return json({ error: 'AISSTREAM_API_KEY not configured — add your key in Settings → Tracking & Sensing' }, 503);
    }
    // Ensure connected (handles case where key was just set and connect hasn't fired yet)
    if (!aisState.socket || aisState.socket.readyState > 1) aisConnect(apiKey);
    return new Response(aisBuildSnapshot(), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    });
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

    // Ollama streaming — handled before dispatch() to bypass arrayBuffer() buffering
    if (requestUrl.pathname === '/api/ollama-stream' && req.method === 'POST') {
      const expectedToken = process.env.LOCAL_API_TOKEN;
      if (expectedToken) {
        const authHeader = req.headers['authorization'] || '';
        if (authHeader !== `Bearer ${expectedToken}`) {
          context.logger.warn(`[local-api] unauthorized request to ${requestUrl.pathname}`);
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }
      await handleOllamaStream(requestUrl, req, res, context);
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
      } catch (error) {
        if (error?.code === 'EADDRINUSE') {
          // Never kill arbitrary listeners on occupied ports. Instead, bind to a
          // random OS-assigned port and publish it through service-status/port file.
          context.logger.log(`[local-api] port ${context.port} already in use; falling back to OS-assigned port`);
          await tryListen(0);
        } else {
          throw error;
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
