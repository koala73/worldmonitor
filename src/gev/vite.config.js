/**
 * Vite configuration for God's Eye View — a cinematic geospatial app.
 *
 * Registers the dev-server proxy middlewares that bypass CORS and add
 * caching/auth for upstream APIs:
 *   1. OpenSky  — aircraft state vectors (OAuth / Basic / anon)
 *   2. CelesTrak — satellite TLE orbital elements
 *   3. Overpass  — OpenStreetMap road geometry queries
 *   4. GBFS     — bike-share station feeds
 *   5. CCTV     — traffic-camera frames, media streams, and fallback SVG
 *   6. adsb.lol — military aircraft tracking
 *   7. AIS live — AISStream websocket-backed live vessel positions
 *   8. Terrain heights — Re:Earth keyless point-height lookups (ellipsoidal ground)
 *   9. TomTom   — live traffic-flow vector tiles (budget-governed, keyless-degradable)
 *  10. NASA FIRMS — live active-fire detections (VIIRS ×3, trailing 24 h)
 *  11. Military-installation context — bounded, cached OpenStreetMap features
 *  12. Regional briefing — cached place, weather, and recent location-matched news
 *  13. Weather effects — camera-local Open-Meteo observations without news/geocoding overhead
 *  14. Rocket launches — recent Launch Library 2 mission metadata
 *  15. Radio Browser — public-domain station directory and click counting
 *
 * Also exposes Cesium and Google 3D Tiles API keys to the
 * client via `import.meta.env.*` defines.
 *
 * @module vite.config
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import https from 'node:https';
import { lookup as lookupDns } from 'node:dns/promises';
import { directionToHeading } from './src/data/directionText.js';
import {
  isValidTileCoord as isValidTomTomTile,
  utcDayKey as tomtomUtcDayKey,
  normalizeBudget as normalizeTomTomBudget,
  isOverBudget as isTomTomOverBudget,
} from './src/data/tomtomTiles.js';
import { filterTrailing24h, parseFirmsCsv } from './src/data/firmsCsv.js';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { defineConfig, loadEnv } from 'vite';
import cesium from 'vite-plugin-cesium';
import { normalizeRadioCountryInput } from './src/data/radioCountry.js';
import {
  normalizeRegionalArticles,
  normalizeRegionalPlace,
  normalizeRegionalWeather,
} from './src/data/regionalBrief.js';
import { normalizeAdsbLolPointResponse } from './src/data/adsbLolFallback.js';
import { createAisStreamAdapter, isRecognizedAisEnvelope } from './src/data/aisStreamAdapter.js';
import { parseSilenceTimeoutEnv } from './src/data/aisWatchdog.js';
import {
  fetchTerrainChunkWithRetry,
  parseTerrainPoints,
  resolveTerrainHeightRequest,
  terrainPointKey,
  validTerrainResult,
} from './src/data/terrainHeightsProxy.js';
import { VOICE_MODELS, isKnownVoiceTier, resolveVoiceModel } from './src/voice/voiceCost.js';

/** Resolve __dirname for ESM context. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// OpenSky OAuth2 token + response cache state
// ---------------------------------------------------------------------------
/** @type {string|null} Current OAuth2 bearer token. */
let _openskyToken = null;
/** @type {number} Epoch-ms when the current token expires. */
let _openskyTokenExpiry = 0;
/** @type {Promise<string|null>|null} In-flight token refresh promise (coalesces concurrent callers). */
let _openskyTokenPromise = null;
/** @type {string|null} Cached upstream response body (JSON text). */
let _openskyCacheBody = null;
/** @type {number} HTTP status of the cached response. */
let _openskyCacheStatus = 0;
/** @type {number} Epoch-ms when the response was cached. */
let _openskyCacheTime = 0;
/** @type {{requestedMode:string,usedMode:string,reason:string}|null} Auth metadata for the cached response. */
let _openskyCacheMeta = null;
/** @type {number|null} Source snapshot epoch from the cached OpenSky body. */
let _openskyCacheSourceEpochMs = null;
/** TTL for the OpenSky response cache (ms). */
const OPENSKY_CACHE_MS = 9000;
// --- OpenSky credit governor (field-test fix 2026-07-06) -------------------
// The global /states/all this proxy fetches costs 4 CREDITS per call against
// OpenSky's ~4000/day authenticated budget — a day with the app open burned
// the whole quota in ~8h and the layer then hard-died until the daily reset
// ("rate limited for 48h" owner report; auth itself was fine). Three levers:
//  1. Adaptive TTL: OpenSky returns X-Rate-Limit-Remaining on success; as the
//     budget thins, the proxy stretches its cache TTL so a full day of
//     continuous use never exhausts it.
//  2. 429 cooldown: honor X-Rate-Limit-Retry-After-Seconds — no upstream
//     attempts until it passes (bounded 30 s … 30 min).
//  3. Serve-stale: while rate-limited/cooling, serve the last-good body (200 +
//     X-OpenSky-Stale) so the layer keeps rendering instead of dying.
/** @type {number} Current adaptive TTL (ms) — starts at the base cache TTL. */
let _openskyTtlMs = OPENSKY_CACHE_MS;
/** @type {number} Epoch-ms before which no upstream fetch is attempted. */
let _openskyCooldownUntil = 0;
/**
 * Picks the cache TTL from the remaining daily credit budget.
 * Client polls every 30 s, so tiers ≤30 s cost the same 480 credits/h; the
 * later tiers stretch the day: >2400 → ~3 h of full freshness, then 30 s
 * (~2.5 h), 90 s (~5 h), 300 s (~8 h) ≈ 18+ h of continuous use per day.
 * @param {number} remaining - X-Rate-Limit-Remaining header value.
 * @returns {number} TTL in ms.
 */
function openskyAdaptiveTtlMs(remaining) {
  if (!Number.isFinite(remaining)) return OPENSKY_CACHE_MS;
  if (remaining > 2400) return OPENSKY_CACHE_MS;
  if (remaining > 1200) return 30_000;
  if (remaining > 400) return 90_000;
  return 300_000;
}
/** @type {boolean} Guards duplicate auth-failure warnings in logs. */
let _openskyAuthWarned = false;
/** @type {boolean} Guards duplicate invalid-auth-mode warnings. */
let _openskyAuthModeWarned = false;
/** Default auth mode when OPENSKY_AUTH_MODE env is unset. */
const OPENSKY_AUTH_MODE_DEFAULT = 'oauth';
/** Set of valid OPENSKY_AUTH_MODE values. */
const OPENSKY_AUTH_MODE_SET = new Set(['basic', 'oauth', 'auto', 'anon']);
/** Regional civilian fallback cache, keyed by a coarse 0.25° view anchor. */
const _adsbLolPointCache = new Map();
/** Per-anchor single-flight map for concurrent regional fallback requests. */
const _adsbLolPointInFlight = new Map();
const ADSBLOL_POINT_CACHE_MS = 12000;
const ADSBLOL_POINT_CACHE_MAX = 80;
const ADSBLOL_POINT_RADIUS_NM = 250;
const ADSBLOL_POINT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// A 200 response can still contain an old OpenSky snapshot. Past this point
// the viewport-scoped adsb.lol source is more honest and keeps local motion
// current instead of coasting a stale worldwide frame indefinitely.
const OPENSKY_SOURCE_STALE_MS = 120_000;
// ---------------------------------------------------------------------------
// Overpass API proxy constants and cache state
// ---------------------------------------------------------------------------
/** Ordered list of Overpass API mirrors; tried sequentially on failure/rate-limit. */
const OVERPASS_UPSTREAMS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  // Community full-planet instance (privateforge nonprofit) — added 2026-07-30
  // when all three mirrors above refused this IP (likely a dev-traffic rate
  // ban; refused connections fail in ms, so healthy mirrors above still win).
  // Verified: planet coverage (Texas query), CORS *, ~5-20 s cold latency.
  'https://overpass.private.coffee/api/interpreter',
];
/**
 * TTL for FRESH cached Overpass responses (ms). Road geometry is static for
 * months — the original 45 s TTL forced a public-mirror round-trip on nearly
 * every viewport revisit and left nothing to serve when the mirrors 502
 * (field-test 2026-07-17: all three mirrors down during US morning peak =
 * "traffic takes forever to load"). 24 h in memory; the disk layer below
 * keeps 7 days and also survives dev-server restarts.
 */
const OVERPASS_CACHE_MS = 86_400_000;
/** Disk-cache TTL for Overpass responses (ms) — 7 days. */
const OVERPASS_DISK_TTL_MS = 7 * 86_400_000;
/**
 * Disk-cache TTL for BOUNDARY-class queries (is_in / admin-relation pivots) — 30
 * days. Admin boundaries change ≈never, and their pivots are the most expensive
 * queries the app issues (multi-MB coastline geometry, 10–25 s on public mirrors —
 * field test 2026-07-23: outline latency + the Sicily miss). Keeping them a month
 * means each boundary is fetched roughly once per machine, ever.
 */
const OVERPASS_BOUNDARY_DISK_TTL_MS = 30 * 86_400_000;
/** Disk-cache directory for Overpass responses. */
const OVERPASS_DISK_DIR = path.join(process.cwd(), '.gev-cache', 'overpass');
/** Per-upstream fetch timeout (ms). */
const OVERPASS_TIMEOUT_MS = 22000;
/** Max entries in the Overpass response cache (LRU-like, oldest evicted first). */
const OVERPASS_CACHE_MAX_ENTRIES = 120;
/** @type {Map<string,{status:number,body:string,contentType:string,endpoint:string,cachedAt:number}>} */
const _overpassCache = new Map();
/** @type {Map<string,Promise>} In-flight Overpass requests keyed by normalized query body. */
const _overpassInFlight = new Map();

/**
 * Whether a normalized Overpass query is BOUNDARY-class (admin `is_in` lookups
 * and area→relation pivots) — the static, expensive geometry that earns the
 * 30-day disk TTL. The enclosing-compound sweep and road fetches keep the
 * default TTL. Exported for tests.
 */
export function isOverpassBoundaryQuery(cacheKey) {
  return /is_in\s*\(|\bpivot\b/i.test(String(cacheKey || ''));
}

/** Disk TTL for a query: boundary geometry keeps for a month, the rest 7 days. */
function overpassDiskTtlMs(cacheKey) {
  return isOverpassBoundaryQuery(cacheKey) ? OVERPASS_BOUNDARY_DISK_TTL_MS : OVERPASS_DISK_TTL_MS;
}

/** Iterative Douglas-Peucker on [{lat,lon},...] (planar-degree approx — fine at
 *  the ~44 m tolerance used here). Endpoints always kept. */
function douglasPeucker(points, toleranceDeg) {
  const n = points.length;
  if (n <= 2) return points;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = points[a].lon;
    const ay = points[a].lat;
    const vx = points[b].lon - ax;
    const vy = points[b].lat - ay;
    const c2 = vx * vx + vy * vy;
    let worst = -1;
    let worstDist = toleranceDeg;
    for (let i = a + 1; i < b; i++) {
      const wx = points[i].lon - ax;
      const wy = points[i].lat - ay;
      let d;
      if (c2 === 0) {
        d = Math.hypot(wx, wy);
      } else {
        const t = Math.max(0, Math.min(1, (vx * wx + vy * wy) / c2));
        d = Math.hypot(wx - t * vx, wy - t * vy);
      }
      if (d > worstDist) {
        worstDist = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Simplify one element's geometry array in place if it is big enough. */
function simplifyElementGeometry(el, minPoints, toleranceDeg) {
  if (Array.isArray(el?.geometry) && el.geometry.length >= minPoints) {
    el.geometry = douglasPeucker(el.geometry, toleranceDeg);
  }
  if (Array.isArray(el?.members)) {
    for (const member of el.members) {
      if (Array.isArray(member?.geometry) && member.geometry.length >= minPoints) {
        member.geometry = douglasPeucker(member.geometry, toleranceDeg);
      }
    }
  }
}

/**
 * Server-side geometry simplification for large Overpass `out geom` payloads.
 * Region/state boundary pivots return multi-MB coastline rings whose fidelity
 * nothing downstream needs (the client re-simplifies for draw); decimating them
 * HERE shrinks the disk cache, the wire, and client parse time — and is what
 * makes the raised read cap safe. Anything unparseable or below the thresholds
 * passes through byte-identical. Exported for tests (opts override thresholds).
 *
 * @param {string} bodyText - Raw upstream JSON body.
 * @returns {string} Possibly-simplified JSON body.
 */
export function simplifyOverpassPayloadBody(bodyText, opts = {}) {
  const minBytes = opts.minBytes ?? OVERPASS_SIMPLIFY_MIN_BYTES;
  const minPoints = opts.minPoints ?? OVERPASS_SIMPLIFY_MIN_POINTS;
  const toleranceDeg = opts.toleranceDeg ?? OVERPASS_SIMPLIFY_TOLERANCE_DEG;
  if (typeof bodyText !== 'string' || bodyText.length < minBytes) return bodyText;
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!Array.isArray(data?.elements)) return bodyText;
  for (const el of data.elements) simplifyElementGeometry(el, minPoints, toleranceDeg);
  try {
    return JSON.stringify(data);
  } catch {
    return bodyText;
  }
}

/** Normalized Overpass query -> stable disk-cache file path. */
function overpassDiskPath(cacheKey) {
  return path.join(OVERPASS_DISK_DIR, `${createHash('sha1').update(cacheKey).digest('hex')}.json`);
}

/**
 * Read a disk-cached Overpass payload. maxAgeMs Infinity = any age (the
 * serve-stale path when every mirror is down).
 * @returns {Promise<?Object>} Payload with cachedAt, or null.
 */
async function readOverpassDisk(cacheKey, maxAgeMs) {
  try {
    const raw = await fsp.readFile(overpassDiskPath(cacheKey), 'utf8');
    const payload = JSON.parse(raw);
    if (!payload || typeof payload.body !== 'string' || !Number.isFinite(payload.cachedAt)) return null;
    if (Date.now() - payload.cachedAt > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Fire-and-forget disk write for a successful Overpass payload. */
function writeOverpassDisk(cacheKey, payload) {
  fsp.mkdir(OVERPASS_DISK_DIR, { recursive: true })
    .then(() => fsp.writeFile(overpassDiskPath(cacheKey), JSON.stringify(payload)))
    .catch((err) => console.warn('[Overpass Proxy] disk cache write failed:', err?.message || err));
}

/**
 * Resolve every cache/coalescing layer before admitting a request to the local
 * upstream rate limiter. The injected limiter callback is invoked exactly once
 * for a complete cache miss and never for memory, in-flight, or disk hits.
 * Exported so the admission ordering can be tested without a Vite server.
 *
 * @param {object} options
 * @param {string} options.cacheKey
 * @param {Map<string, object>} options.memoryCache
 * @param {Map<string, Promise<object>>} options.inFlight
 * @param {()=>Promise<object|null>} options.readDisk
 * @param {()=>boolean} options.allowUpstream
 * @param {number} [options.now]
 * @param {number} [options.cacheMs]
 * @returns {Promise<{source:'HIT'|'INFLIGHT'|'DISK'|'UPSTREAM'|'RATE_LIMITED', payload:object|null}>}
 */
export async function resolveOverpassPreflight({
  cacheKey,
  memoryCache,
  inFlight,
  readDisk,
  allowUpstream,
  now = Date.now(),
  cacheMs = OVERPASS_CACHE_MS,
}) {
  const cached = memoryCache.get(cacheKey);
  if (cached && now - cached.cachedAt <= cacheMs) return { source: 'HIT', payload: cached };

  const pending = inFlight.get(cacheKey);
  if (pending) return { source: 'INFLIGHT', payload: await pending };

  const disk = await readDisk();
  if (disk) return { source: 'DISK', payload: disk };

  return allowUpstream()
    ? { source: 'UPSTREAM', payload: null }
    : { source: 'RATE_LIMITED', payload: null };
}
/** OSM routing (FOSSGIS OSRM) cache: profile|coords -> { payload, cachedAt }. */
const ROUTE_CACHE_MS = 600000;
const _routeCache = new Map();

// --- Abuse guards shared by the Overpass + route proxies --------------------
/** Max accepted POST body for the Overpass proxy (Overpass QL queries are tiny). */
const OVERPASS_MAX_BODY_BYTES = 24 * 1024; // 24 KB
/**
 * Hard cap on a single Overpass upstream response we will buffer into memory.
 * 32 MB (was 12 MB): a dense island/state admin boundary at full `out geom`
 * fidelity — Sicilia's Mediterranean coastline — can exceed 12 MB, and clipping
 * it read as a permanent "transient" failure (field test 2026-07-23, Sicily
 * never traced). The buffered payload is SIMPLIFIED server-side before it is
 * cached or sent (simplifyOverpassPayloadBody), so the raised cap does not
 * raise what clients receive or what the disk stores.
 */
const OVERPASS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // 32 MB
/** Only payloads at least this large go through geometry simplification. */
const OVERPASS_SIMPLIFY_MIN_BYTES = 1_500_000;
/** Only per-element geometry arrays with at least this many points are simplified. */
const OVERPASS_SIMPLIFY_MIN_POINTS = 1200;
/**
 * Douglas-Peucker tolerance (degrees, ≈44 m of latitude). Region/state boundary
 * rings are drawn at regional camera scale and the client simplifies again for
 * draw, so ~44 m fidelity is invisible; building footprints never reach the
 * point threshold above and pass through untouched.
 */
const OVERPASS_SIMPLIFY_TOLERANCE_DEG = 0.0004;
/** Max concurrent in-flight upstream Overpass fetches across all distinct queries. */
const OVERPASS_MAX_CONCURRENT = 6;
let _overpassConcurrent = 0;
/** Hard cap on the OSRM route response we will buffer. */
const ROUTE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB
/** Reject routes whose straight-line spans are obviously abusive (km). */
const ROUTE_MAX_LEG_KM = 600;
const ROUTE_MAX_TOTAL_KM = 2500;

/**
 * Minimal fixed-window per-key rate limiter for the dev proxies. Not a hard
 * security boundary (dev-only), just a backstop so a runaway client can't hammer
 * the public Overpass / OSRM mirrors or exhaust this process.
 */
const RATE_LIMITER_MAX_KEYS = 2000;
function makeRateLimiter({ windowMs, max, globalMax }) {
  const hits = new Map(); // key -> number[] (timestamps within window)
  let globalTimes = []; // all hits in window, for the global backstop
  return function allow(key) {
    const now = Date.now();
    globalTimes = globalTimes.filter((t) => now - t < windowMs);
    if (globalMax && globalTimes.length >= globalMax) return false; // global backstop
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    globalTimes.push(now);
    // Hard key cap so a key-rotating caller can't grow the map without bound.
    if (hits.size > RATE_LIMITER_MAX_KEYS) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
    if (hits.size > 256) {
      for (const [k, v] of hits) {
        if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
      }
    }
    return true;
  };
}
const _overpassRateLimiter = makeRateLimiter({ windowMs: 60_000, max: 90, globalMax: 300 });
const _militaryInstallationsRateLimiter = makeRateLimiter({ windowMs: 60_000, max: 90, globalMax: 300 });
const _routeRateLimiter = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 200 });

/**
 * Opt-in per-IP rate limiter for the cost-bearing API proxies (OpenAI / Google).
 * DEFAULT IS UNLIMITED: when the env var is unset, `0`, or non-numeric, this
 * returns `null` and the caller skips the check entirely — a runtime no-op that
 * preserves the original behavior. Only a positive integer N enables a fixed
 * 60s window of N requests/IP (built lazily once, then reused so its per-IP
 * window state persists across requests). The global backstop is set to a
 * generous multiple of the per-IP cap so a single host can't starve the rest.
 *
 * @param {string|undefined} envValue - Raw env value (requests/min/IP).
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when unlimited.
 */
function makeOptInRateLimiter(envValue) {
  const max = Number(envValue);
  if (!Number.isFinite(max) || max <= 0) return null; // unset/0/garbage -> unlimited
  return makeRateLimiter({ windowMs: 60_000, max: Math.floor(max), globalMax: Math.floor(max) * 20 });
}
// Built LAZILY on first request, NOT at module load: `.env` values are applied to process.env later
// (the plugin config hook calls loadEnv → process.env, AFTER this module is imported), so reading
// process.env here at import time would always see them unset and silently stay unlimited even when
// configured via .env. Building on first request (like the OPENAI_API_KEY reads) sees the loaded env;
// the result is cached so the limiter's per-IP window state persists. `null` = unlimited (default).
let _openAiRateLimiter; // undefined = not built yet; null = unlimited; fn = active limiter
let _googleRateLimiter;
/** OpenAI cost endpoints (realtime/token + hud-summary). Null = unlimited (default). */
function openAiRateLimiter() {
  if (_openAiRateLimiter === undefined) _openAiRateLimiter = makeOptInRateLimiter(process.env.GEV_RATELIMIT_OPENAI_PER_MIN);
  return _openAiRateLimiter;
}
/** Google cost endpoint (nearby-places). Null = unlimited (default). */
function googleRateLimiter() {
  if (_googleRateLimiter === undefined) _googleRateLimiter = makeOptInRateLimiter(process.env.GEV_RATELIMIT_GOOGLE_PER_MIN);
  return _googleRateLimiter;
}

/**
 * Apply an opt-in limiter to a request, writing a 429 when over the cap.
 * When `limiter` is null (unlimited, the default) this is a no-op returning
 * `true`, so the handler proceeds exactly as before.
 *
 * @param {((key:string)=>boolean)|null} limiter
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} True if the request may proceed; false if a 429 was sent.
 */
function enforceOptInRateLimit(limiter, req, res) {
  if (!limiter) return true; // unlimited (default) — no behavior change
  if (limiter(clientKey(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', '5');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}

/**
 * Client key for rate limiting. Uses the real socket peer address only — we do
 * NOT trust X-Forwarded-For (client-controlled; a rotating value would mint fresh
 * quota and grow the limiter map). This is a localhost dev proxy, so the socket
 * address is the real client.
 */
function clientKey(req) {
  return String(req.socket?.remoteAddress || 'local');
}

/** Server-side timeout ceiling (seconds) we allow inside an Overpass QL query. */
const OVERPASS_MAX_QL_TIMEOUT = 30;
/** Max `around:` radius (m) — every app caller uses <= 1800 m. */
const OVERPASS_MAX_AROUND_M = 50000;
/** Max bbox span (degrees) — app bboxes are small viewport tiles. */
const OVERPASS_MAX_BBOX_DEG = 12;
/**
 * Every Overpass element-type specifier, including the combined shortcuts
 * (nwr/nw/nr/wr) and `rel`. Shared by the selector + area-element-deny regexes so
 * they can't drift (a missing shortcut like `wr` was an area-scan bypass).
 */
const OVERPASS_ELEMENT_TYPES = 'node|way|relation|nwr|nw|nr|wr|rel';
/** Element-selector (incl. `area`) whose statements must be individually bounded. */
const OVERPASS_SELECTOR_RE = new RegExp(`\\b(?:${OVERPASS_ELEMENT_TYPES}|area)\\b`);
/** An element selector bounded BY an area — the country-scan abuse shape. */
const OVERPASS_AREA_ELEMENT_RE = new RegExp(`\\b(?:${OVERPASS_ELEMENT_TYPES})\\s*\\(\\s*area\\b`, 'i');
/** A single bbox 4-tuple `(s,w,n,e)` (non-global so it does not advance lastIndex). */
const OVERPASS_BBOX_RE = /\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/;

/**
 * Validate + clamp an Overpass form body. Defends the generic proxy against
 * planet-scale abuse: requires exactly one `data` query in which EVERY element
 * selector is individually spatially bounded (around / bbox / is_in / poly /
 * area-set / pivot), rejects oversized radii and world-sized bboxes, and clamps
 * every `[timeout:]` directive. Comments + quoted literals are stripped first so
 * a fake bound inside a tag value can't satisfy the check.
 *
 * Every real app caller passes (annotations/locations/cctv use `around:`/`is_in`/
 * `area.`/`pivot`; traffic uses a small `(s,w,n,e)` bbox); a mixed query that
 * pairs one bounded selector with a global one is rejected.
 *
 * @returns {{ok:true, body:string} | {ok:false, error:string}}
 */
/**
 * Single-pass lexer: blank out quoted literals (→ empty quotes) and strip line
 * and block comments — recognizing each in one walk so a comment marker INSIDE a
 * quoted string is treated as string content, not a comment (and vice versa).
 * Chained regex replaces get the ordering wrong (a quoted slash-slash would hide
 * the rest of the line), which is exactly the bypass this avoids.
 */
function stripOverpassNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; } // escaped char
        if (src[i] === quote) { i += 1; break; } // closing quote
        i += 1;
      }
      out += quote + quote; // collapse the literal to empty quotes
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function sanitizeOverpassBody(rawBody) {
  let params;
  try { params = new URLSearchParams(rawBody); } catch { return { ok: false, error: 'Malformed query body' }; }
  const all = params.getAll('data');
  if (all.length !== 1) return { ok: false, error: 'Exactly one data query is required' };
  const data = all[0];
  if (!data || !data.trim()) return { ok: false, error: 'Missing Overpass data query' };

  // Blank quoted literals + strip comments in one lexer pass so a fake bound or a
  // `//` inside a string can't hide an unbounded selector (or satisfy a bound).
  const stripped = stripOverpassNoise(data);

  // Reject oversized radii in EVERY around form — point `around:r,lat,lon` AND the
  // input-set form `around.set:r` — and parse the full numeric token so scientific
  // notation (`5e7`) can't slip a planet-scale radius past the cap.
  for (const m of stripped.matchAll(/around(?:\.\w+)?:\s*([\d.eE+-]+)/gi)) {
    const radius = Number(m[1]);
    if (!Number.isFinite(radius) || radius > OVERPASS_MAX_AROUND_M) {
      return { ok: false, error: 'Overpass around radius too large' };
    }
  }
  // Reject world-sized / oversized bboxes.
  for (const m of stripped.matchAll(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g)) {
    const s = Number(m[1]); const w = Number(m[2]); const n = Number(m[3]); const e = Number(m[4]);
    if (Math.abs(n - s) > OVERPASS_MAX_BBOX_DEG || Math.abs(e - w) > OVERPASS_MAX_BBOX_DEG) {
      return { ok: false, error: 'Overpass bbox too large' };
    }
  }

  // Reject control-flow constructs the app never uses — their set/bound semantics
  // are hard to validate statically. The app only uses plain selectors + is_in /
  // area / pivot / recursion, so this denylist closes loop/transform escape hatches.
  if (/\b(?:foreach|complete|retro|compare|convert|make)\b/i.test(stripped)) {
    return { ok: false, error: 'Unsupported Overpass construct' };
  }
  // `poly:` has unchecked extent and the app never uses it — reject outright
  // (position-independent, so tag filters can't hide it).
  if (/\bpoly\s*:/i.test(stripped)) {
    return { ok: false, error: 'Overpass poly filter not allowed' };
  }

  // Every selector statement must be individually bounded, WITH set provenance: a
  // set counts as a bound only if it was assigned (->.set) by an already-bounded
  // statement. So `way[...]->.a` (global assigned to a set) is rejected, while the
  // app's `is_in(...)->.a; area.a[...]` and `area(id)->.x; rel(pivot.x)` validate.
  const boundedSets = new Set();
  for (let stmt of stripped.split(';')) {
    stmt = stmt.trim();
    if (!stmt || stmt.startsWith('[') || /^out\b/.test(stmt)) continue;

    // Strip output-set assignments (NOT input bounds), then strip bracket tag
    // filters so a tag KEY/value (e.g. `way[is_in]`, `node[around]`) can never be
    // misread as a spatial bound. Bounds live in (...) / function calls / set
    // refs, never inside [...], so the probe loses nothing real.
    const outSets = [];
    const body = stmt.replace(/->\s*\.(\w+)/g, (_, name) => { outSets.push(name); return ' '; });
    const probe = body.replace(/\[[^\]]*\]/g, ' ');

    // Reject element-in-area scans on the TAG-STRIPPED probe, so a tag filter
    // between the selector and the area filter (way["highway"](area.a)) can't hide
    // it. An area has unbounded extent (could be a whole country); the app only
    // SELECTS admin areas (area.set) and pivots (rel(pivot.x)), never node/way/
    // relation(area...). The probe collapses tags so `way (area.a)` is caught.
    if (OVERPASS_AREA_ELEMENT_RE.test(probe)) {
      return { ok: false, error: 'Overpass area-bounded element selector not allowed' };
    }

    const hasSelector = OVERPASS_SELECTOR_RE.test(probe);
    const inputSets = [...probe.matchAll(/(?<!\d)\.([a-z_]\w*)/gi)].map((m) => m[1]);
    const directBound = /around:\s*\d/.test(probe)
      || OVERPASS_BBOX_RE.test(probe)
      || /is_in\s*\(/.test(probe)                 // is_in(lat,lon) — the function form only
      || /\barea\s*\(/.test(probe);               // area(id) — bounded as a set definition

    const setBound = inputSets.some((s) => boundedSets.has(s));
    const bounded = directBound || setBound;

    if (hasSelector && !bounded) {
      return { ok: false, error: 'Overpass query has an unbounded selector' };
    }
    // Only a bounded statement can mark its output sets as bounded.
    if (bounded) for (const name of outSets) boundedSets.add(name);
  }

  const clamped = data.replace(
    /\[timeout:\s*(\d+)\s*\]/gi,
    (_, n) => `[timeout:${Math.min(Number(n) || OVERPASS_MAX_QL_TIMEOUT, OVERPASS_MAX_QL_TIMEOUT)}]`,
  );
  return { ok: true, body: `data=${encodeURIComponent(clamped)}` };
}

/** Read a request body with a hard byte cap; throws { code:'BODY_TOO_LARGE' } past the cap. */
async function readRequestBodyCapped(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Read a fetch() Response body as text with a hard byte cap. Rejects early on an
 * oversized Content-Length, then streams with a running cap so a chunked or
 * length-omitted response cannot blow past the limit. Throws { code:'RESPONSE_TOO_LARGE' }.
 */
export async function readResponseTextCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = new Error('Upstream response too large');
    err.code = 'RESPONSE_TOO_LARGE';
    throw err;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      const err = new Error('Upstream response too large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    return text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* no-op */ }
      const err = new Error('Upstream response too large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Parse a fetch() JSON response only after enforcing a hard byte cap. */
export async function readResponseJsonCapped(response, maxBytes) {
  return JSON.parse(await readResponseTextCapped(response, maxBytes));
}

/**
 * Return the existing promise for a cache key, or create one and remove it
 * only when that exact promise settles.
 */
export function coalesceProxyRequest(inFlight, key, create) {
  const existing = inFlight.get(key);
  if (existing) return { promise: existing, shared: true };
  let promise;
  promise = Promise.resolve()
    .then(create)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return { promise, shared: false };
}

// ---------------------------------------------------------------------------
// Radio Browser directory proxy
// ---------------------------------------------------------------------------
const RADIO_DIRECTORY_CACHE_MS = 45 * 60 * 1000;
const RADIO_DIRECTORY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RADIO_MIRROR_CACHE_MS = 6 * 60 * 60 * 1000;
const RADIO_FETCH_TIMEOUT_MS = 12_000;
const RADIO_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const RADIO_DIRECTORY_LIMIT = 750;
const RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES = 5;
const RADIO_CATALOG_HEALTHY_MIN_STATIONS = Math.ceil(RADIO_DIRECTORY_LIMIT / 2);
const RADIO_USER_AGENT = 'GodsEyeView/1.0 (Radio Browser directory client)';
const RADIO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RADIO_FALLBACK_MIRRORS = Object.freeze([
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
]);

function cleanRadioText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
}

function isNonGlobalIpv4(hostname) {
  const pieces = hostname.split('.');
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece))) return false;
  const values = pieces.map(Number);
  if (values.some((value) => value > 255)) return true;
  const [a, b, c] = values;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

/** Return a normalized public HTTPS URL, or null for local/private targets. */
export function publicRadioHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || !hostname) return null;
    if (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || isNonGlobalIpv4(hostname)
      || hostname.includes(':')
    ) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Normalize one Radio Browser station and omit favicons and unsafe streams. */
export function normalizeRadioBrowserStation(raw) {
  const id = cleanRadioText(raw?.stationuuid, 40).toLowerCase();
  const lat = raw?.geo_lat === null || raw?.geo_lat === '' ? null : Number(raw?.geo_lat);
  const lon = raw?.geo_long === null || raw?.geo_long === '' ? null : Number(raw?.geo_long);
  const codec = cleanRadioText(raw?.codec, 16).toUpperCase();
  const streamUrl = publicRadioHttpsUrl(raw?.url_resolved || raw?.url);
  if (
    !RADIO_UUID_RE.test(id)
    || Number(raw?.lastcheckok) !== 1
    || Number(raw?.hls) === 1
    || !Number.isFinite(lat) || lat < -90 || lat > 90
    || !Number.isFinite(lon) || lon < -180 || lon > 180
    || !/^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i.test(codec)
    || !streamUrl
  ) return null;

  const name = cleanRadioText(raw?.name, 140);
  if (!name) return null;
  const tags = String(raw?.tags ?? '')
    .split(',')
    .map((tag) => cleanRadioText(tag, 80).toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 24);
  const languages = String(raw?.language ?? '')
    .split(',')
    .map((language) => cleanRadioText(language, 40))
    .filter(Boolean)
    .slice(0, 8);
  const rawCountryCode = cleanRadioText(raw?.countrycode, 2).toUpperCase();
  const normalizedCode = normalizeRadioCountryInput(rawCountryCode);
  const normalizedCountry = normalizedCode.valid && !normalizedCode.empty
    ? normalizedCode
    : normalizeRadioCountryInput(cleanRadioText(raw?.country, 80));
  const bitrate = Number(raw?.bitrate);
  return {
    id,
    name,
    lat,
    lon,
    streamUrl,
    homepage: publicRadioHttpsUrl(raw?.homepage),
    tags,
    languages,
    state: cleanRadioText(raw?.state, 80),
    country: normalizedCountry.valid && !normalizedCountry.empty
      ? normalizedCountry.name
      : cleanRadioText(raw?.country, 80),
    countryCode: normalizedCountry.valid ? normalizedCountry.code : '',
    metadataTrust: 'untrusted-community',
    codec,
    bitrate: Number.isInteger(bitrate) && bitrate >= 8 && bitrate <= 1024 ? bitrate : null,
    clickCount: Math.max(0, Math.min(10_000_000, Number(raw?.clickcount) || 0)),
  };
}

export function publicRadioStation(station) {
  return {
    id: station.id,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    streamUrl: station.streamUrl,
    homepage: station.homepage,
    tags: station.tags,
    languages: station.languages,
    state: station.state,
    country: station.country,
    countryCode: station.countryCode,
    metadataTrust: station.metadataTrust,
    codec: station.codec,
    bitrate: station.bitrate,
  };
}

function radioMirrorOrigin(value) {
  const hostname = String(value ?? '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.api\.radio-browser\.info$/.test(hostname)) return null;
  return `https://${hostname}`;
}

/** Return whether a resolved Radio Browser address is safe for an outbound request. */
export function isPublicRadioAddress(value) {
  const address = String(value ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!address) return false;
  if (!address.includes(':')) {
    const ipv4 = address.split('.');
    return ipv4.length === 4
      && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
      && !isNonGlobalIpv4(address);
  }
  const pieces = address.split('::');
  if (pieces.length > 2) return false;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1)) return false;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
  const numeric = groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
  const inCidr = (base, prefix) => {
    const shift = 128n - BigInt(prefix);
    return (numeric >> shift) === (base >> shift);
  };
  const base = (text) => text.split(':').reduce(
    (total, group) => (total << 16n) | BigInt(`0x${group || '0'}`),
    0n,
  );
  const cidr = (text, prefix) => inCidr(base(text), prefix);
  return cidr('2000:0:0:0:0:0:0:0', 3)
    && !cidr('2001:0:0:0:0:0:0:0', 23)
    && !cidr('2001:db8:0:0:0:0:0:0', 32)
    && !cidr('2002:0:0:0:0:0:0:0', 16)
    && !cidr('3fff:0:0:0:0:0:0:0', 20);
}

function radioProxyDestination(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  const origin = radioMirrorOrigin(url.hostname);
  if (
    !origin
    || url.origin !== origin
    || url.username
    || url.password
    || url.port
    || url.hash
  ) return null;
  const discovery = url.hostname.toLowerCase() === 'all.api.radio-browser.info'
    && url.pathname === '/json/servers'
    && !url.search;
  const directory = url.pathname === '/json/stations/search';
  const click = /^\/json\/url\/[0-9a-f-]+$/i.test(url.pathname) && !url.search;
  return discovery || directory || click ? url : null;
}

async function resolveRadioProxyAddresses(hostname, lookupImpl) {
  const resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  const rows = Array.isArray(resolved) ? resolved : [resolved];
  const addresses = rows
    .map((row) => ({ address: String(row?.address || ''), family: Number(row?.family) || undefined }))
    .filter((row) => row.address);
  if (!addresses.length || addresses.some((row) => !isPublicRadioAddress(row.address))) {
    throw new Error('Radio Browser resolved to a forbidden address');
  }
  return addresses;
}

function fetchPinnedRadioResponse(url, options, addresses) {
  return new Promise((resolve, reject) => {
    const address = addresses[0];
    const request = https.request(url, {
      method: 'GET',
      headers: options.headers,
      signal: options.signal,
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) callback(null, addresses);
        else callback(null, address.address, address.family);
      },
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, String(value));
      }
      resolve(new Response(Readable.toWeb(response), {
        status: response.statusCode || 500,
        statusText: response.statusMessage || '',
        headers,
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function mapRadioConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Create the testable Connect middleware backing `/api/radio`. */
export function createRadioProxyMiddleware({ fetchImpl = null, lookupImpl = lookupDns, now = Date.now } = {}) {
  let mirrorCache = { origins: [...RADIO_FALLBACK_MIRRORS], cachedAt: 0 };
  let mirrorPromise = null;
  let catalogCache = null;
  let catalogGeneration = 0;
  // The generation counter is process-local, so it restarts from 1 with the
  // server. The instance token scopes each generation sequence: a client that
  // sees a new instance must treat the catalog as a fresh sequence, never as a
  // repeat ("still generation 1") or a regression ("generation went backward").
  const catalogInstance = randomUUID();
  let servedStationIds = new Set();
  let refreshPromise = null;

  async function fetchJson(url, maxBytes = RADIO_RESPONSE_MAX_BYTES) {
    const destination = radioProxyDestination(url);
    if (!destination) throw new Error('Radio Browser destination is not permitted');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RADIO_FETCH_TIMEOUT_MS);
    try {
      const addresses = await resolveRadioProxyAddresses(destination.hostname, lookupImpl);
      const options = {
        headers: { Accept: 'application/json', 'User-Agent': RADIO_USER_AGENT },
        signal: controller.signal,
        redirect: 'manual',
      };
      const response = fetchImpl
        ? await fetchImpl(destination.href, options)
        : await fetchPinnedRadioResponse(destination, options, addresses);
      if (response.status >= 300 && response.status < 400) {
        try { await response.body?.cancel?.(); } catch { /* no-op */ }
        throw new Error('Radio Browser redirects are refused');
      }
      if (!response.ok) throw new Error(`Radio Browser returned ${response.status}`);
      const text = await readResponseTextCapped(response, maxBytes);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async function mirrors() {
    if (now() - mirrorCache.cachedAt < RADIO_MIRROR_CACHE_MS) return mirrorCache.origins;
    if (!mirrorPromise) {
      mirrorPromise = (async () => {
        try {
          const rows = await fetchJson('https://all.api.radio-browser.info/json/servers', 256 * 1024);
          const discovered = [...new Set((Array.isArray(rows) ? rows : []).map((row) => radioMirrorOrigin(row?.name)).filter(Boolean))];
          if (discovered.length) {
            mirrorCache = { origins: [...discovered, ...RADIO_FALLBACK_MIRRORS.filter((origin) => !discovered.includes(origin))], cachedAt: now() };
          }
        } catch {
          mirrorCache = { ...mirrorCache, cachedAt: now() };
        }
        return mirrorCache.origins;
      })().finally(() => { mirrorPromise = null; });
    }
    return mirrorPromise;
  }

  async function fetchPath(pathname) {
    let lastError = null;
    for (const origin of await mirrors()) {
      try {
        return await fetchJson(`${origin}${pathname}`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('No Radio Browser mirror is available');
  }

  async function refreshCatalog() {
    const queries = [null, 'news', 'talk', 'weather', 'emergency', 'scanner', 'aviation', 'marine', 'traffic'];
    const outcomes = await mapRadioConcurrent(queries, 3, async (tag, index) => {
      const params = new URLSearchParams({
        has_geo_info: 'true',
        is_https: 'true',
        hidebroken: 'true',
        order: 'clickcount',
        reverse: 'true',
        limit: index === 0 ? '1800' : '220',
      });
      if (tag) params.set('tag', tag);
      try {
        const rows = await fetchPath(`/json/stations/search?${params}`);
        if (!Array.isArray(rows)) throw new Error('Radio Browser catalog payload was not an array');
        if (!rows.every((row) => (
          row
          && typeof row === 'object'
          && !Array.isArray(row)
          && typeof row.stationuuid === 'string'
          && typeof row.name === 'string'
          && (typeof row.url_resolved === 'string' || typeof row.url === 'string')
        ))) throw new Error('Radio Browser catalog contained a malformed station row');
        const stations = rows.map(normalizeRadioBrowserStation).filter(Boolean);
        const requestedTag = cleanRadioText(tag, 80)
          .toLocaleLowerCase()
          .replace(/[_-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const requestedTagCovered = !requestedTag || stations.some((station) => (
          station.tags.some((stationTag) => stationTag === requestedTag || stationTag.includes(requestedTag))
        ));
        return {
          // Query coverage is based on accepted rows, not merely a payload that
          // happens to match the upstream schema. Specialist responses must
          // also contain an accepted station tagged for the requested category.
          succeeded: stations.length > 0 && requestedTagCovered,
          stations,
        };
      } catch {
        return { succeeded: false, stations: [] };
      }
    });
    const resultSets = outcomes.map((outcome) => outcome.stations);

    const selected = [];
    const seen = new Set();
    const take = (station) => {
      if (!station || seen.has(station.id) || selected.length >= RADIO_DIRECTORY_LIMIT) return;
      seen.add(station.id);
      selected.push(station);
    };
    // Seed specialist station-tag queries before popularity fill so operational
    // categories remain represented even when global click charts skew musical.
    for (const rows of resultSets.slice(1)) rows.slice(0, 45).forEach(take);
    resultSets.flat().sort((a, b) => b.clickCount - a.clickCount || a.name.localeCompare(b.name)).forEach(take);
    const timestamp = now();
    const successfulQueries = outcomes.filter((outcome) => outcome.succeeded).length;
    const broadQueryHealthy = outcomes[0].succeeded && outcomes[0].stations.length > 0;
    const healthReasons = [];
    if (!broadQueryHealthy) healthReasons.push('broad-query-unhealthy');
    if (successfulQueries < RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES) healthReasons.push('query-coverage-below-policy');
    if (selected.length < RADIO_CATALOG_HEALTHY_MIN_STATIONS) healthReasons.push('station-coverage-below-policy');
    const degraded = healthReasons.length > 0;
    const coverage = {
      successfulQueries,
      totalQueries: queries.length,
      stationCount: selected.length,
      healthyStationMinimum: RADIO_CATALOG_HEALTHY_MIN_STATIONS,
    };
    const nextCatalog = {
      cachedAt: timestamp,
      updatedAt: new Date(timestamp).toISOString(),
      stations: selected.map(publicRadioStation),
      stationIds: new Set(selected.map((station) => station.id)),
      degraded,
      degradedReason: degraded ? healthReasons.join(',') : null,
      coverage,
    };
    if (degraded && catalogCache) {
      const error = new Error('Radio Browser catalog refresh did not meet health policy');
      error.radioCatalogDegraded = true;
      error.radioDegradedReason = nextCatalog.degradedReason;
      error.radioCoverage = coverage;
      throw error;
    }
    if (degraded && !selected.length) {
      const error = new Error('Radio Browser catalog refresh returned no usable stations');
      error.radioCatalogDegraded = true;
      error.radioDegradedReason = nextCatalog.degradedReason;
      error.radioCoverage = coverage;
      throw error;
    }
    if (degraded) {
      servedStationIds = nextCatalog.stationIds;
      return { ...nextCatalog, acceptedGeneration: null };
    }
    catalogCache = {
      ...nextCatalog,
      acceptedGeneration: ++catalogGeneration,
    };
    servedStationIds = catalogCache.stationIds;
    return catalogCache;
  }

  async function getCatalog() {
    if (catalogCache && now() - catalogCache.cachedAt < RADIO_DIRECTORY_CACHE_MS) {
      return { ...catalogCache, stale: false };
    }
    if (!refreshPromise) {
      refreshPromise = refreshCatalog().finally(() => { refreshPromise = null; });
    }
    try {
      return { ...await refreshPromise, stale: false };
    } catch (error) {
      if (catalogCache && now() - catalogCache.cachedAt <= RADIO_DIRECTORY_STALE_MS) {
        return {
          ...catalogCache,
          stale: true,
          degraded: true,
          degradedReason: error?.radioDegradedReason || 'refresh-failed',
          coverage: error?.radioCoverage || catalogCache.coverage,
        };
      }
      throw error;
    }
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  return async function radioProxyMiddleware(req, res) {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (requestUrl.pathname === '/stations') {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      try {
        const catalog = await getCatalog();
        sendJson(res, 200, {
          stations: catalog.stations,
          updatedAt: catalog.updatedAt,
          stale: catalog.stale,
          degraded: Boolean(catalog.degraded),
          degradedReason: catalog.degradedReason || null,
          coverage: catalog.coverage || null,
          acceptedGeneration: catalog.acceptedGeneration ?? null,
          catalogInstance,
        });
      } catch (error) {
        sendJson(res, 503, {
          error: 'Radio directory is temporarily unavailable',
          degraded: Boolean(error?.radioCatalogDegraded),
          degradedReason: error?.radioDegradedReason || null,
        });
      }
      return;
    }

    const clickMatch = requestUrl.pathname.match(/^\/click\/([0-9a-f-]+)$/i);
    if (clickMatch) {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const id = clickMatch[1].toLowerCase();
      if (!RADIO_UUID_RE.test(id) || !servedStationIds.has(id)) {
        sendJson(res, 404, { error: 'Unknown radio station' });
        return;
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      void fetchPath(`/json/url/${id}`).catch(() => {});
      return;
    }

    sendJson(res, 404, { error: 'Unknown radio route' });
  };
}

function radioBrowserProxy() {
  const middleware = createRadioProxyMiddleware();
  const install = (server) => {
    server.middlewares.use('/api/radio', middleware);
  };
  return {
    name: 'radio-browser-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
// ---------------------------------------------------------------------------
// GBFS (General Bikeshare Feed Specification) proxy constants
// ---------------------------------------------------------------------------
/** Upstream fetch timeout for GBFS requests (ms). */
const GBFS_PROXY_TIMEOUT_MS = 12000;
/** Allowlisted GBFS hostnames; wildcard *.publicbikesystem.net also accepted. */
const GBFS_ALLOWED_HOSTS = new Set([
  'gbfs.lyft.com',
  'gbfs.bluebikes.com',
  'gbfs.bcycle.com',
  'gbfs.biketownpdx.com',
  'gbfs.cogobikeshare.com',
  'austin.publicbikesystem.net',
  'hon.publicbikesystem.net',
  'chat.publicbikesystem.net',
]);

// ---------------------------------------------------------------------------
// AISStream live vessel cache state
// ---------------------------------------------------------------------------
const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const AISSTREAM_DEFAULT_BBOXES = [[[-90, -180], [90, 180]]];
const AISSTREAM_DEFAULT_MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
];
const AISSTREAM_CACHE_MAX = 50000;
const AISSTREAM_STALE_MS = 30 * 60 * 1000;
// Per-MMSI recent-path ring buffers (PRD WS-F F3). Float32 lat/lon (~1m
// precision, fine for 25m thinning) + Uint32 epoch seconds ≈ 12B/sample;
// 64 samples × 50k MMSIs worst case ≈ 38MB. Tracks exist only while the dev
// server runs — this is "recent path", not voyage history.
const AIS_TRACK_SAMPLES = 64;
const AIS_TRACK_MIN_GAP_SEC = 30;
const AIS_TRACK_MIN_MOVE_M = 25;
// Watchdog budgets (policy lives in src/data/aisWatchdog.js). Silence is
// REPORTED quickly and ACTED ON slowly: a dead feed must read as dead within
// ~2 min, but recycling the socket is throttled so recovery can never become a
// reconnect cycle against AISStream's one-connection-per-key limit.
const AISSTREAM_SILENCE_REPORT_MS = 120_000;
/** Recycle threshold as a multiple of the report threshold. */
const AISSTREAM_RECYCLE_RATIO = 2.5;
const AISSTREAM_BACKOFF_MS = Object.freeze([5_000, 15_000, 60_000, 300_000]);
/** Slow retry cadence once the ladder is spent and the feed reads DOWN. */
const AISSTREAM_DOWN_RETRY_MS = 900_000;
/**
 * Probe cadence while AISStream is rejecting the key. Retrying cannot fix a
 * bad credential, so this exists only to recover from an upstream-side
 * mistake — it must never approach the ladder's pace.
 */
const AISSTREAM_AUTH_PROBE_MS = 3_600_000;
/** How often the watchdog re-evaluates without request traffic. */
const AISSTREAM_TICK_MS = 15_000;
// Sourced from the shared voice-model registry so the client's cost estimate
// can never be computed against a different model than the session runs on.
const OPENAI_REALTIME_MODEL_DEFAULT = VOICE_MODELS.standard.id;
const OPENAI_REALTIME_MODEL_MINI_DEFAULT = VOICE_MODELS.mini.id;
const OPENAI_REALTIME_VOICE_DEFAULT = 'marin';
const OPENAI_REALTIME_REASONING_DEFAULT = 'low';
const OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT = 3000;
const OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT = 0.5;
const OPENAI_HUD_SUMMARY_MODEL_DEFAULT = 'gpt-5-nano';
const REALTIME_DEBUG_LOG_DIR = path.join(__dirname, '.gev-logs');
const REALTIME_DEBUG_LOG_FILE = path.join(REALTIME_DEBUG_LOG_DIR, 'realtime-conversations.jsonl');
const REALTIME_DEBUG_LOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * @type {ReturnType<typeof createAisStreamAdapter>|null}
 * Module-lifetime: it owns the socket-generation namespace, which must never
 * restart across a dev-server reload (see aisStreamAdapter.js ownership rules).
 */
let _aisAdapter = null;
/** @type {{silenceWatch:boolean,reportMs:number,recycleMs:number,url:string}|null} */
let _aisWatchdogPolicy = null;
/** @type {number|null} */
let _aisStreamTickTimer = null;
/** Set by dispose so the next ensure() re-derives budgets from a reloaded .env. */
let _aisNeedsRearm = false;
/** @type {Function|null|undefined} `ws` constructor; null = unavailable, undefined = not yet probed. */
let _aisWebSocketImpl;
/** @type {Map<string,object>} */
const _aisStreamVessels = new Map();
/** @type {Map<string,object>} */
const _aisStreamStatic = new Map();
/** @type {Map<string,{lats:Float32Array,lons:Float32Array,times:Uint32Array,head:number,len:number}>} mmsi -> track ring buffer */
const _aisStreamTracks = new Map();
/** @type {Map<string,{lat:number,lon:number,epochSec:number}>} mmsi -> first fix awaiting second (lazy buffer allocation) */
const _aisStreamTrackPending = new Map();

/**
 * Obtain a valid OpenSky OAuth2 bearer token, refreshing if needed.
 *
 * Uses the client_credentials grant against the OpenSky Keycloak realm.
 * Concurrent callers share a single in-flight refresh promise so only
 * one token request is issued at a time.
 *
 * @returns {Promise<string|null>} Bearer token string, or null if unavailable.
 */
async function getOpenSkyToken() {
  const now = Date.now();
  // Return cached token if still valid (with 60 s safety margin)
  if (_openskyToken && now < _openskyTokenExpiry - 60000) return _openskyToken;

  // Coalesce concurrent refresh requests — if a refresh is already in-flight,
  // return the same promise instead of issuing a duplicate token request
  if (_openskyTokenPromise) return _openskyTokenPromise;

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Wrap the async token fetch in a shared promise stored in _openskyTokenPromise
  _openskyTokenPromise = (async () => {
    try {
      const res = await fetch(
        'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
        }
      );

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      const accessToken = data?.access_token;
      const expiresIn = Number(data?.expires_in);
      if (!res.ok || !accessToken) {
        if (!_openskyAuthWarned) {
          const detail = data?.error_description || data?.error || `HTTP ${res.status}`;
          console.warn('[OpenSky] OAuth client_credentials failed:', detail);
          _openskyAuthWarned = true;
        }
        _openskyToken = null;
        _openskyTokenExpiry = 0;
        return null;
      }

      _openskyToken = accessToken;
      // Default to 1800 s (30 min) if expires_in is missing or non-finite
      _openskyTokenExpiry = Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000;
      console.log('[OpenSky] OAuth token refreshed, expires in', Number.isFinite(expiresIn) ? expiresIn : 1800, 's');
      _openskyAuthWarned = false;
      return _openskyToken;
    } catch (err) {
      if (!_openskyAuthWarned) {
        console.warn('[OpenSky] OAuth token request failed:', err?.message || String(err));
        _openskyAuthWarned = true;
      }
      _openskyToken = null;
      _openskyTokenExpiry = 0;
      return null;
    } finally {
      // Clear the shared promise so the next caller can start a fresh refresh
      _openskyTokenPromise = null;
    }
  })();

  return _openskyTokenPromise;
}

/**
 * Validate and normalize the OPENSKY_AUTH_MODE env value.
 *
 * @param {string} value - Raw env value (e.g. 'basic', 'oauth', 'auto', 'anon').
 * @returns {string} One of the valid mode strings, or the default ('oauth').
 */
function normalizeOpenSkyAuthMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return OPENSKY_AUTH_MODE_DEFAULT;
  if (OPENSKY_AUTH_MODE_SET.has(raw)) return raw;
  if (!_openskyAuthModeWarned) {
    console.warn(
      `[OpenSky] Invalid OPENSKY_AUTH_MODE="${raw}", defaulting to "${OPENSKY_AUTH_MODE_DEFAULT}"`
    );
    _openskyAuthModeWarned = true;
  }
  return OPENSKY_AUTH_MODE_DEFAULT;
}

/**
 * Build standard response headers for OpenSky proxy responses.
 *
 * Includes diagnostic X-OpenSky-* headers so the client can inspect
 * cache hit/miss status and which auth mode was actually used.
 *
 * @param {object} opts
 * @param {string} opts.cacheStatus - 'HIT', 'MISS', or 'STALE'.
 * @param {string} opts.requestedMode - The auth mode the config requested.
 * @param {string} opts.usedMode - The auth mode actually used for the upstream call.
 * @param {string} opts.reason - Human-readable reason string for diagnostics.
 * @returns {Record<string,string>} Header object.
 */
function buildOpenSkyHeaders({ cacheStatus, requestedMode, usedMode, reason, staleSeconds, retryAfterSeconds }) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-OpenSky-Cache': cacheStatus,
    'X-OpenSky-Auth': usedMode,
    'X-OpenSky-Auth-Mode-Requested': requestedMode,
    'X-OpenSky-Auth-Mode-Used': usedMode,
    'X-OpenSky-Auth-Reason': reason,
  };
  // Credit-governor extras (field-test fix 2026-07-06): the client can show a
  // STALE cue / countdown without parsing the body.
  if (Number.isFinite(staleSeconds)) headers['X-OpenSky-Stale-Seconds'] = String(Math.round(staleSeconds));
  if (Number.isFinite(retryAfterSeconds)) headers['X-OpenSky-Retry-After-Seconds'] = String(Math.round(retryAfterSeconds));
  return headers;
}

/**
 * Vite plugin: CelesTrak TLE proxy.
 *
 * CelesTrak does not send CORS headers, so this middleware fetches
 * satellite TLE data server-side and forwards it to the browser.
 * Upstream URL: https://celestrak.org/NORAD/elements/gp.php
 *
 * @returns {import('vite').Plugin}
 */
/**
 * CelesTrak GP/TLE proxy with a memory + disk cache.
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 * CelesTrak asks clients not to re-fetch GP data more than ~every 2 h and
 * throttles offenders; every dev reload used to refetch every group. Cache TTL
 * 6 h; on upstream failure the freshest stale copy is served (a stale TLE
 * beats an empty satellites layer). Pattern mirrors openSkyProxy's
 * cache+serve-stale. Adapted from skylight's TleStore (MIT).
 */
function celestrakProxy() {
  const TLE_TTL_MS = 6 * 3600_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const mem = new Map(); // group -> { at: epochMs, body: string }
  const inflight = new Map(); // group -> Promise<{at, body}|null>

  const diskPath = (group) => path.join(CACHE_DIR, `celestrak-${group}.json`);

  async function readDisk(group) {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskPath(group), 'utf8'));
      if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at)) return parsed;
    } catch { /* no disk cache yet */ }
    return null;
  }

  async function writeDisk(group, entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(diskPath(group), JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn(`[celestrak-proxy] cache write failed for ${group}:`, err?.message || err);
    }
  }

  async function fetchUpstream(group) {
    const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
    url.searchParams.set('GROUP', group);
    url.searchParams.set('FORMAT', 'tle');
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(20000),
      // CelesTrak 403s bulk groups (e.g. `active`) unless the request carries a
      // descriptive User-Agent with a contact point.
      headers: { 'User-Agent': 'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    // An upstream error page parses to zero TLEs — treat as failure, keep cache.
    if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
    return { at: Date.now(), body };
  }

  return {
    name: 'celestrak-proxy',
    configureServer(server) {
      server.middlewares.use('/api/celestrak', async (req, res) => {
        const group = String(req.url || '').replace(/^\//, '').split('?')[0];
        if (!/^[a-z0-9-]+$/i.test(group)) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('invalid group');
          return;
        }
        const send = (status, body, cacheStatus) => {
          // Guard against a double-send (e.g. a throw AFTER a response already
          // went out routing into the catch's send): writeHead after headersSent
          // throws "Cannot set headers after they are sent".
          if (res.headersSent) return;
          res.writeHead(status, { 'Content-Type': 'text/plain', 'x-tle-cache': cacheStatus });
          res.end(body);
        };
        try {
          const now = Date.now();
          let entry = mem.get(group);
          if (!entry) {
            entry = await readDisk(group);
            if (entry) mem.set(group, entry);
          }
          if (entry && now - entry.at < TLE_TTL_MS) {
            send(200, entry.body, 'HIT');
            return;
          }
          // Stale or missing → refresh, single-flight per group.
          if (!inflight.has(group)) {
            inflight.set(group, fetchUpstream(group)
              .then(async (fresh) => {
                mem.set(group, fresh);
                await writeDisk(group, fresh);
                return fresh;
              })
              .catch((err) => {
                console.warn(`[celestrak-proxy] ${group} refresh failed (${err?.message || err}) — serving cache if any`);
                return null;
              })
              .finally(() => inflight.delete(group)));
          }
          const fresh = await inflight.get(group);
          if (fresh) {
            send(200, fresh.body, 'MISS');
          } else if (entry) {
            send(200, entry.body, 'STALE-ERROR'); // upstream down — stale beats empty
          } else {
            send(502, 'celestrak fetch failed and no cache available', 'NONE');
          }
        } catch (err) {
          send(500, `celestrak proxy error: ${err?.message || err}`, 'ERROR');
        }
      });
    },
  };
}

export const LL2_CACHE_TTL_MS = 15 * 60_000;

/** Build LL2 request headers without exposing its optional token client-side. */
export function launchLibraryRequestHeaders(token = process.env.LL2_API_TOKEN) {
  const normalized = String(token || '').trim();
  return {
    Accept: 'application/json',
    ...(normalized ? { Authorization: `Token ${normalized}` } : {}),
  };
}

/** Proxy the public Launch Library 2 recent-launch feed server-side. */
function rocketLaunchesProxy() {
  const ttlMs = LL2_CACHE_TTL_MS;
  const maxResponseBytes = 12 * 1024 * 1024;
  const maxDiskCacheBytes = 24 * 1024 * 1024;
  const cachePath = path.join(process.cwd(), '.gev-cache', 'launch-library-2-v2.3.json');
  let cache = null;
  let diskLoaded = false;
  const inFlight = new Map();

  async function loadDiskCache() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const stat = await fsp.stat(cachePath);
      if (stat.size > maxDiskCacheBytes) throw new Error('cache file too large');
      const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      if (Number.isFinite(parsed?.at) && typeof parsed?.body === 'string') {
        const body = JSON.parse(parsed.body);
        if (Array.isArray(body?.results)) cache = parsed;
      }
    } catch { /* first run or invalid cache */ }
  }

  async function saveDiskCache(entry) {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify(entry), 'utf8');
    } catch (error) {
      console.warn(`[launch-library-proxy] cache write failed: ${error?.message || error}`);
    }
  }

  function send(res, status, body, cacheState) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': status === 200 ? 'public, max-age=900' : 'no-store',
      'X-GEV-Cache': cacheState,
    });
    res.end(body);
  }

  async function refreshUpstream() {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400000);
    const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
    url.searchParams.set('net__gte', start.toISOString());
    url.searchParams.set('net__lte', end.toISOString());
    url.searchParams.set('limit', '100');
    url.searchParams.set('mode', 'detailed');
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: launchLibraryRequestHeaders(),
    });
    const body = await readResponseTextCapped(upstream, maxResponseBytes);
    if (!upstream.ok) {
      const error = new Error(`upstream HTTP ${upstream.status}`);
      error.upstreamStatus = upstream.status;
      error.upstreamBody = body;
      throw error;
    }
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.results)) throw new Error('malformed upstream response');
    const fresh = { at: Date.now(), body };
    cache = fresh;
    void saveDiskCache(fresh);
    return fresh;
  }

  function install(middlewares) {
    middlewares.use('/api/launches', async (req, res) => {
      if (req.method !== 'GET') {
        send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }), 'NONE');
        return;
      }
      await loadDiskCache();
      const now = Date.now();
      if (cache && now - cache.at < ttlMs) {
        send(res, 200, cache.body, 'HIT');
        return;
      }
      const stale = cache;
      const request = coalesceProxyRequest(inFlight, 'recent-launches', refreshUpstream);
      try {
        const fresh = await request.promise;
        send(res, 200, fresh.body, request.shared ? 'INFLIGHT' : 'MISS');
      } catch (error) {
        if (stale) {
          if (!request.shared) console.warn(`[launch-library-proxy] refresh failed (${error?.message || error}) — serving stale cache`);
          send(res, 200, stale.body, 'STALE-ERROR');
          return;
        }
        send(
          res,
          Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : 502,
          error?.upstreamBody || JSON.stringify({ error: 'Launch Library 2 unavailable' }),
          'NONE',
        );
      }
    });
  }

  return {
    name: 'rocket-launches-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

/**
 * TomTom traffic-flow vector-tile proxy with a daily budget governor.
 *
 * Upstream: https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf
 * (style `relative`; the response is an UNCOMPRESSED Mapbox Vector Tile, layer
 * "Traffic flow"). The key comes from TOMTOM_API_KEY server-side only — the
 * browser fetches same-origin `/api/tomtom/flow/{z}/{x}/{y}.pbf`.
 *
 * Cache: memory + disk (.gev-cache/tomtom/), TTL 120 s (traffic is fresh
 * data), single-flight per tile, serve-stale-on-failure — the celestrakProxy
 * pattern. Cache hits never count against the budget.
 *
 * Budget governor (mirrors the OpenSky credit-governor philosophy — last-good
 * data beats a dead layer): a persistent counter (.gev-cache/tomtom/budget.json,
 * keyed by UTC date, reset on day change) counts upstream fetch attempts
 * against a soft cap (TOMTOM_DAILY_TILE_BUDGET, default 40,000 of the free
 * tier's ~50k/day). Over the cap the proxy serves stale tiles when available,
 * else 429 {error:'budget'}.
 *
 * GET /api/tomtom/status → {hasKey, dailyCount, budget, date}. Keyless mode:
 * status reports hasKey:false and the tile endpoint 503s {error:'no_key'}
 * without touching upstream — the traffic layer then stays in simulation mode.
 *
 * @returns {import('vite').Plugin}
 */
function tomtomProxy() {
  const TILE_TTL_MS = 120_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache', 'tomtom');
  const BUDGET_PATH = path.join(CACHE_DIR, 'budget.json');
  const DEFAULT_DAILY_BUDGET = 40000;
  const MEM_MAX_ENTRIES = 256;
  const UPSTREAM_TIMEOUT_MS = 15000;

  /** @type {Map<string, {at:number, buf:Buffer}>} tile key `z/x/y` -> cached tile (kept past TTL for serve-stale). */
  const mem = new Map();
  /** @type {Map<string, Promise<{at:number, buf:Buffer}|null>>} single-flight per tile. */
  const inflight = new Map();

  /** @type {{date:string, count:number}|null} lazily-loaded persistent counter. */
  let budget = null;
  let budgetLoaded = false;

  function dailyBudgetLimit() {
    const raw = Number.parseInt(process.env.TOMTOM_DAILY_TILE_BUDGET || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
  }

  async function loadBudgetOnce() {
    if (budgetLoaded) return;
    budgetLoaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(BUDGET_PATH, 'utf8'));
      if (parsed && typeof parsed.date === 'string' && Number.isFinite(parsed.count)) {
        budget = parsed;
      }
    } catch { /* no budget file yet */ }
  }

  async function persistBudget() {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(BUDGET_PATH, JSON.stringify(budget), 'utf8');
    } catch (err) {
      console.warn('[tomtom-proxy] budget write failed:', err?.message || err);
    }
  }

  /** Roll the counter to today (UTC) and return it. */
  function currentBudget() {
    budget = normalizeTomTomBudget(budget, tomtomUtcDayKey());
    return budget;
  }

  /** Count one upstream fetch attempt against today's budget (async persist). */
  function recordUpstreamFetch() {
    currentBudget().count += 1;
    void persistBudget();
  }

  const tilePath = (key) => path.join(CACHE_DIR, `flow-${key.replaceAll('/', '-')}.pbf`);

  /** Disk-cache read; tile age comes from the file's mtime. */
  async function readDiskTile(key) {
    try {
      const [stat, buf] = await Promise.all([
        fsp.stat(tilePath(key)),
        fsp.readFile(tilePath(key)),
      ]);
      return { at: stat.mtimeMs, buf };
    } catch { return null; }
  }

  async function writeDiskTile(key, buf) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(tilePath(key), buf);
    } catch (err) {
      console.warn(`[tomtom-proxy] tile cache write failed for ${key}:`, err?.message || err);
    }
  }

  /** LRU-ish memory insert (Map preserves insertion order; evict the oldest). */
  function memSet(key, entry) {
    if (!mem.has(key) && mem.size >= MEM_MAX_ENTRIES) {
      const oldest = mem.keys().next().value;
      mem.delete(oldest);
    }
    mem.set(key, entry);
  }

  async function fetchUpstream(z, x, y) {
    const url = 'https://api.tomtom.com/traffic/map/4/tile/flow/relative/'
      + `${z}/${x}/${y}.pbf?key=${encodeURIComponent(process.env.TOMTOM_API_KEY)}`;
    recordUpstreamFetch(); // attempts count — upstream bills the request either way
    const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('empty tile body');
    return buf;
  }

  return {
    name: 'tomtom-proxy',
    configureServer(server) {
      server.middlewares.use('/api/tomtom', async (req, res) => {
        // Sanitized responses only (proxy/security baseline): no upstream
        // error details, and never echo the key or the upstream URL.
        const sendJson = (status, obj, extraHeaders = {}) => {
          if (res.headersSent) return;
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...extraHeaders,
          });
          res.end(JSON.stringify(obj));
        };
        const sendTile = (buf, cacheStatus) => {
          if (res.headersSent) return;
          res.writeHead(200, {
            'Content-Type': 'application/x-protobuf',
            'Cache-Control': 'no-store',
            'x-tomtom-cache': cacheStatus,
          });
          res.end(buf);
        };

        try {
          await loadBudgetOnce();
          const urlPath = String(req.url || '').split('?')[0];

          if (urlPath === '/status') {
            const hasKey = Boolean(process.env.TOMTOM_API_KEY);
            const b = currentBudget();
            sendJson(200, { hasKey, dailyCount: b.count, budget: dailyBudgetLimit(), date: b.date });
            return;
          }

          const m = urlPath.match(/^\/flow\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
          if (!m) {
            sendJson(404, { error: 'not_found' });
            return;
          }
          const z = Number(m[1]);
          const x = Number(m[2]);
          const y = Number(m[3]);
          if (!isValidTomTomTile(z, x, y)) {
            sendJson(400, { error: 'invalid_tile' });
            return;
          }
          if (!process.env.TOMTOM_API_KEY) {
            sendJson(503, { error: 'no_key' });
            return;
          }

          const key = `${z}/${x}/${y}`;
          const now = Date.now();

          let entry = mem.get(key);
          if (!entry) {
            entry = await readDiskTile(key);
            if (entry) memSet(key, entry);
          }
          // Fresh cache hit — never counts against the budget.
          if (entry && now - entry.at < TILE_TTL_MS) {
            sendTile(entry.buf, 'HIT');
            return;
          }

          // Budget governor: over the soft cap, last-good data beats a dead layer.
          if (isTomTomOverBudget(currentBudget(), dailyBudgetLimit())) {
            if (entry) {
              sendTile(entry.buf, 'STALE-BUDGET');
            } else {
              sendJson(429, { error: 'budget' });
            }
            return;
          }

          // Stale or missing → refresh, single-flight per tile.
          if (!inflight.has(key)) {
            inflight.set(key, fetchUpstream(z, x, y)
              .then(async (buf) => {
                const fresh = { at: Date.now(), buf };
                memSet(key, fresh);
                await writeDiskTile(key, buf);
                return fresh;
              })
              .catch((err) => {
                console.warn(`[tomtom-proxy] ${key} fetch failed (${err?.message || err}) — serving stale if any`);
                return null;
              })
              .finally(() => inflight.delete(key)));
          }
          const fresh = await inflight.get(key);
          if (fresh) {
            sendTile(fresh.buf, 'MISS');
          } else if (entry) {
            sendTile(entry.buf, 'STALE-ERROR'); // upstream down — stale beats empty
          } else {
            sendJson(502, { error: 'upstream' });
          }
        } catch (err) {
          console.warn('[tomtom-proxy] error:', err?.message || err);
          sendJson(500, { error: 'proxy' });
        }
      });
    },
  };
}

/**
 * NASA FIRMS live active-fire proxy with a memory + disk cache.
 * Upstream: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/world/2
 *
 * Merges three VIIRS NRT sources (NOAA-20, NOAA-21, Suomi-NPP — independent
 * satellites, no cross-source dedup) fetched sequentially with `days=2`
 * (`days=1` means "current UTC day", nearly empty just after 00:00Z) and
 * clamps to the trailing 24 h via src/data/firmsCsv.js. FIRMS quota is
 * 5,000 transactions / 10 min per MAP_KEY, so the cache is the point:
 * TTL 30 min, single-flight refresh, serve-stale-on-failure, and a
 * fresh-enough disk cache (.gev-cache/firms.json) prevents ANY upstream
 * fetch across dev-server restarts. Pattern mirrors celestrakProxy.
 *
 * Routes:
 *   GET /api/firms        → {fetchedAt, stale, ttlMs, sources, count, fires}
 *   GET /api/firms/status → {hasKey, lastFetch, count, stale, ttlMs, transactions}
 *
 * Keyless (no FIRMS_MAP_KEY): /api/firms → 503 {error:'no_key'}; status →
 * {hasKey:false}. Upstream is never touched without a key.
 *
 * @returns {import('vite').Plugin}
 */
function firmsProxy() {
  const TTL_MS = 30 * 60_000;
  const STATUS_TTL_MS = 5 * 60_000;
  const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'firms.json');

  /** @type {?{at: number, sources: Array<object>, fires: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, sources: Array<object>, fires: Array<object>}>} single-flight refresh */
  let inflight = null;
  /** @type {?{at: number, transactions: ?{used: number, limit: number}}} mapkey_status cache */
  let statusCache = null;
  /** @type {?Promise<?{used: number, limit: number}>} */
  let statusInflight = null;

  const mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim();

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.sources) && Array.isArray(parsed?.fires)) {
        mem = parsed;
      }
    } catch { /* no disk cache yet */ }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[firms-proxy] cache write failed:', err?.message || err);
    }
  }

  /**
   * Fetch + parse one FIRMS source. Throws on HTTP error or a non-CSV body
   * (FIRMS reports errors as HTML/plain text, never CSV). Never log the URL —
   * it embeds the MAP_KEY.
   */
  async function fetchSource(key, source) {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = parseFirmsCsv(await res.text());
    if (records === null) throw new Error('non-CSV upstream response');
    return records;
  }

  /**
   * Refresh all sources sequentially (quota courtesy — never in parallel).
   * Partial success (≥1 source ok) still produces a cacheable entry with the
   * failed sources marked ok:false; total failure throws so the caller can
   * serve stale.
   */
  async function refreshUpstream(key) {
    const now = Date.now();
    const sources = [];
    const fires = [];
    for (const source of SOURCES) {
      try {
        const records = filterTrailing24h(await fetchSource(key, source), now);
        sources.push({ source, count: records.length, ok: true });
        fires.push(...records);
      } catch (err) {
        console.warn(`[firms-proxy] ${source} fetch failed:`, err?.message || err);
        sources.push({ source, count: 0, ok: false });
      }
    }
    if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
    return { at: now, sources, fires };
  }

  /**
   * Cache entry → response payload. Fires are RE-filtered to the trailing
   * 24 h at serve time so a stale cache never serves >24h-old detections.
   */
  function buildPayload(entry, stale) {
    const fires = filterTrailing24h(entry.fires, Date.now());
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      sources: entry.sources,
      count: fires.length,
      fires,
    };
  }

  /** mapkey_status transactions, cached 5 min, best-effort (null on failure). */
  function getTransactions(key) {
    const now = Date.now();
    if (statusCache && now - statusCache.at < STATUS_TTL_MS) {
      return Promise.resolve(statusCache.transactions);
    }
    if (!statusInflight) {
      statusInflight = (async () => {
        try {
          const url = `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          const used = Number(body?.current_transactions);
          const limit = Number(body?.transaction_limit);
          return Number.isFinite(used) && Number.isFinite(limit) ? { used, limit } : null;
        } catch (err) {
          console.warn('[firms-proxy] mapkey status failed:', err?.message || err);
          return null;
        }
      })()
        .then((transactions) => {
          statusCache = { at: Date.now(), transactions };
          return transactions;
        })
        .finally(() => { statusInflight = null; });
    }
    return statusInflight;
  }

  return {
    name: 'firms-proxy',
    configureServer(server) {
      server.middlewares.use('/api/firms', async (req, res) => {
        const sendJson = (status, obj) => {
          if (res.headersSent) return;
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(obj));
        };
        try {
          const subPath = String(req.url || '').split('?')[0];
          const key = mapKey();
          await readDiskOnce();

          if (subPath === '/status') {
            if (!key) {
              sendJson(200, { hasKey: false, lastFetch: null, count: null, stale: false, ttlMs: TTL_MS, transactions: null });
              return;
            }
            const transactions = await getTransactions(key);
            sendJson(200, {
              hasKey: true,
              lastFetch: mem ? mem.at : null,
              count: mem ? mem.fires.length : null,
              stale: mem ? Date.now() - mem.at >= TTL_MS : false,
              ttlMs: TTL_MS,
              transactions,
            });
            return;
          }

          if (!key) {
            sendJson(503, { error: 'no_key' });
            return;
          }

          const entry = mem;
          if (entry && Date.now() - entry.at < TTL_MS) {
            sendJson(200, buildPayload(entry, false));
            return;
          }
          // Stale or missing → refresh, single-flight (concurrent requests
          // share one upstream pass). Capture the promise locally BEFORE
          // awaiting: the .finally() nulls `inflight` the moment it settles.
          if (!inflight) {
            inflight = refreshUpstream(key)
              .then(async (fresh) => {
                mem = fresh;
                await writeDisk(fresh);
                return fresh;
              })
              .catch((err) => {
                console.warn(`[firms-proxy] refresh failed (${err?.message || err}) — serving cache if any`);
                return null;
              })
              .finally(() => { inflight = null; });
          }
          const pending = inflight;
          const fresh = await pending;
          if (fresh) {
            sendJson(200, buildPayload(fresh, false));
          } else if (entry) {
            sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
          } else {
            sendJson(502, { error: 'firms fetch failed and no cache available' });
          }
        } catch (err) {
          console.warn('[firms-proxy] error:', err?.message || err);
          sendJson(500, { error: 'firms proxy error' });
        }
      });
    },
  };
}

/**
 * Re:Earth terrain point-height proxy: batched lon/lat → ellipsoidal height
 * lookups, keyless. Upstream: https://terrain.reearth.land/heights.json
 * (≤256 points per call). Terrain doesn't move, so results are cached to
 * disk with a long TTL (30 days) — mirrors celestrakProxy's memory+disk
 * cache and serve-stale shape. Cache entries and stale fallback are keyed per
 * 5dp point, so reordered and partially overlapping batches reuse prior work.
 * Only missing/stale points go upstream; the response is rebuilt in exact
 * request order. Oversized requests (>256 points) are chunked sequentially.
 */
function terrainHeightsProxy() {
  const TTL_MS = 30 * 24 * 3600_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'terrain-heights.json');
  const UPSTREAM_CHUNK = 256;
  const MAX_POINTS = 2000;

  /** @type {Map<string, {at:number, result:object}>} keyed by canonical 5dp lon/lat. */
  const mem = new Map();
  /** @type {Map<string, Promise<Array<object>>>} single-flight per missing-point subset. */
  const inflight = new Map();
  let diskLoaded = false;
  let diskDirty = false;

  /** Load the on-disk cache into memory once, lazily (first request only). */
  async function loadDiskOnce() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      const pointEntries = parsed?.version === 2 && parsed.points && typeof parsed.points === 'object'
        ? parsed.points
        : null;
      if (pointEntries) {
        for (const [key, entry] of Object.entries(pointEntries)) {
          if (entry && Number.isFinite(entry.at) && validTerrainResult(entry.result)) {
            mem.set(key, entry);
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        // One-time migration from the former raw-batch cache. Zip only real,
        // positionally present results; an absent value never becomes height 0.
        for (const [rawPoints, entry] of Object.entries(parsed)) {
          const points = parseTerrainPoints(rawPoints);
          if (!points || !entry || !Number.isFinite(entry.at) || !Array.isArray(entry.results)) continue;
          for (let i = 0; i < points.length; i += 1) {
            const result = entry.results[i];
            if (!validTerrainResult(result)) continue;
            const key = terrainPointKey(points[i]);
            const existing = mem.get(key);
            if (!existing || entry.at > existing.at) mem.set(key, { at: entry.at, result });
          }
        }
        diskDirty = mem.size > 0;
      }
    } catch { /* no disk cache yet */ }
    // Periodic flush, same shape as adsbdbProxy: coalesce writes instead of
    // hitting disk on every request.
    setInterval(async () => {
      if (!diskDirty) return;
      diskDirty = false;
      try {
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        const obj = { version: 2, points: Object.fromEntries(mem.entries()) };
        await fsp.writeFile(CACHE_PATH, JSON.stringify(obj), 'utf8');
      } catch (err) {
        diskDirty = true; // retry next tick
        console.warn('[terrain-heights-proxy] cache write failed:', err?.message || err);
      }
    }, 15_000).unref?.();
  }

  /**
   * Fetch all missing chunks sequentially (upstream caps each call at 256).
   *
   * The first try keeps its empirically required 30s timeout; network errors,
   * 429, and 5xx receive up to three jittered retries sharing a 10s added-time
   * budget, with Retry-After honored within that bound.
   * @param {Array<[number, number]>} points
   * @returns {Promise<Array<object>>}
   */
  async function fetchUpstreamAll(points) {
    const results = [];
    for (let i = 0; i < points.length; i += UPSTREAM_CHUNK) {
      const chunk = points.slice(i, i + UPSTREAM_CHUNK);
      const chunkResults = await fetchTerrainChunkWithRetry(chunk);
      // Keep later chunks aligned even if a malformed upstream response omits
      // trailing positions. The resolver will reject each null individually.
      for (let j = 0; j < chunk.length; j += 1) results.push(chunkResults[j] ?? null);
    }
    return results;
  }

  /** Coalesce concurrent requests for the same canonical missing-point list. */
  function fetchMissingSingleFlight(points) {
    const key = points.map(terrainPointKey).join(';');
    if (!inflight.has(key)) {
      const request = fetchUpstreamAll(points)
        .finally(() => {
          if (inflight.get(key) === request) inflight.delete(key);
        });
      inflight.set(key, request);
    }
    return inflight.get(key);
  }

  return {
    name: 'terrain-heights-proxy',
    configureServer(server) {
      server.middlewares.use('/api/terrain/heights', async (req, res) => {
        const send = (status, bodyObj) => {
          if (res.headersSent) return;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(bodyObj));
        };
        try {
          await loadDiskOnce();
          const parsedUrl = new URL(req.url || '', 'http://internal');
          const rawPoints = parsedUrl.searchParams.get('points');
          const points = parseTerrainPoints(rawPoints);
          if (!points) {
            send(400, { error: 'invalid points parameter — expected "lon,lat;lon,lat;…" with finite numbers' });
            return;
          }
          if (points.length > MAX_POINTS) {
            send(500, { error: `too many points (${points.length}); max ${MAX_POINTS} per request` });
            return;
          }

          const outcome = await resolveTerrainHeightRequest({
            points,
            cache: mem,
            fetchMissing: fetchMissingSingleFlight,
            ttlMs: TTL_MS,
          });
          if (outcome.cacheChanged) diskDirty = true;
          if (outcome.upstreamError) {
            console.warn(
              `[terrain-heights-proxy] refresh incomplete (${outcome.upstreamError?.message || outcome.upstreamError})`
              + ' — serving stale points when available'
            );
          }
          send(outcome.status, outcome.body);
        } catch (err) {
          send(500, { error: `terrain heights proxy error: ${err?.message || err}` });
        }
      });
    },
  };
}

/**
 * adsbdb.com enrichment proxy: callsign → route (airline + origin/destination
 * airports) and hex → aircraft type/registration. Free community API — cached
 * aggressively: ONE upstream request per new key ever (404s negative-cached),
 * persisted to disk so restarts don't re-hammer it. Adapted from skylight
 * (MIT) server/src/enrich/routes.ts.
 */
function adsbdbProxy() {
  const TTL_MS = 24 * 3600_000;
  const CACHE_PATH = path.join(process.cwd(), '.gev-cache', 'adsbdb.json');
  let cache = { routes: {}, aircraft: {} };
  let dirty = false;
  let loaded = false;
  const inflight = new Map();

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      cache = { routes: parsed.routes ?? {}, aircraft: parsed.aircraft ?? {} };
    } catch { /* first run */ }
    setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
        await fsp.writeFile(CACHE_PATH, JSON.stringify(cache), 'utf8');
      } catch { dirty = true; } // retry next tick
    }, 15_000).unref?.();
  }

  const fresh = (e) => e && Date.now() - e.at < TTL_MS;

  function parseRoute(json) {
    const fr = json?.response?.flightroute;
    if (!fr?.origin || !fr?.destination) return null;
    const airport = (a) => ({
      code: a.iata_code || a.icao_code || '',
      name: a.municipality || a.name || '',
      lat: Number.isFinite(a.latitude) ? a.latitude : null,
      lon: Number.isFinite(a.longitude) ? a.longitude : null,
    });
    return { airline: fr.airline?.name || null, origin: airport(fr.origin), destination: airport(fr.destination) };
  }

  function parseAircraft(json) {
    const a = json?.response?.aircraft;
    if (!a) return null;
    return {
      typeCode: a.icao_type || null, // ICAO designator, e.g. "B738" — feeds classifyAircraft
      typeName: a.manufacturer && a.type ? `${a.manufacturer} ${a.type}` : (a.type || null),
      registration: a.registration || null,
    };
  }

  function lookup(kind, key) {
    const store = kind === 'route' ? cache.routes : cache.aircraft;
    if (fresh(store[key])) return Promise.resolve(store[key].data);
    const ik = `${kind}:${key}`;
    if (!inflight.has(ik)) {
      inflight.set(ik, (async () => {
        try {
          const url = kind === 'route'
            ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`
            : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (res.ok) {
            const data = kind === 'route' ? parseRoute(await res.json()) : parseAircraft(await res.json());
            store[key] = { at: Date.now(), data }; // data may be null — negative cache
            dirty = true;
            return data;
          }
          if (res.status === 404) {
            store[key] = { at: Date.now(), data: null }; // known-missing — cache the miss
            dirty = true;
          }
          // other statuses: leave uncached so we retry later
          return fresh(store[key]) ? store[key].data : null;
        } catch {
          return fresh(store[key]) ? store[key].data : null; // network error → stale if any
        } finally {
          inflight.delete(ik);
        }
      })());
    }
    return inflight.get(ik);
  }

  return {
    name: 'adsbdb-proxy',
    configureServer(server) {
      server.middlewares.use('/api/adsbdb', async (req, res) => {
        await loadOnce();
        const send = (status, obj) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        try {
          const [, kind, rawKey] = String(req.url || '').split('?')[0].split('/');
          if (kind === 'route') {
            const cs = String(rawKey || '').toUpperCase();
            if (!/^[A-Z0-9]{2,8}$/.test(cs)) return send(400, { error: 'invalid callsign' });
            const data = await lookup('route', cs);
            return send(200, data ? { found: true, ...data } : { found: false });
          }
          if (kind === 'type') {
            const hex = String(rawKey || '').toLowerCase();
            if (!/^[0-9a-f]{6}$/.test(hex)) return send(400, { error: 'invalid hex' });
            const data = await lookup('aircraft', hex);
            return send(200, data ? { found: true, ...data } : { found: false });
          }
          return send(404, { error: 'unknown endpoint' });
        } catch (err) {
          return send(500, { error: String(err?.message || err) });
        }
      });
    },
  };
}

/**
 * Detect whether an Overpass API response body indicates rate-limiting.
 *
 * Checks for known rate-limit phrases in the body text regardless of
 * HTTP status code, since some mirrors return 200 with an error payload.
 *
 * @param {string} bodyText - Upstream response body.
 * @returns {boolean} True if the body looks rate-limited.
 */
function overpassLooksRateLimited(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return text.includes('rate_limited')
    || text.includes('quota of your ip address')
    || text.includes('dispatcher_client::request_read_and_idx::rate_limited')
    || text.includes('too many requests');
}

/**
 * Detect an Overpass HTTP-200 body that is actually a runtime FAILURE (server-side
 * timeout / out-of-memory) via its `remark`. These are transient upstream failures,
 * not authoritative empty results, so they must not be returned or cached.
 */
function overpassLooksRuntimeError(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return text.includes('runtime error')
    || text.includes('timed out')
    || text.includes('out of memory');
}

/** Evict oldest Overpass cache entries until size is within the cap. */
function trimOverpassCache() {
  while (_overpassCache.size > OVERPASS_CACHE_MAX_ENTRIES) {
    const oldestKey = _overpassCache.keys().next().value;
    if (!oldestKey) break;
    _overpassCache.delete(oldestKey);
  }
}

/**
 * Write a completed Overpass payload to the HTTP response.
 *
 * @param {import('http').ServerResponse} res - Node HTTP response.
 * @param {{status:number,body:string,contentType:string,endpoint:string}} payload
 * @param {string} [cacheStatus='MISS'] - 'HIT', 'MISS', or 'INFLIGHT'.
 */
function sendOverpassResponse(res, payload, cacheStatus = 'MISS') {
  res.writeHead(payload.status, {
    'Content-Type': payload.contentType || 'application/json',
    'Cache-Control': 'public, max-age=15',
    'X-Overpass-Cache': cacheStatus,
    'X-Overpass-Upstream': payload.endpoint || 'unknown',
  });
  res.end(payload.body || '');
}

/**
 * Try each Overpass upstream in order until one succeeds.
 *
 * Skips rate-limited or 5xx responses and falls through to the next
 * mirror. If all mirrors fail, returns the last rate-limited payload
 * (if any) or throws the last error.
 *
 * @param {string} body - URL-encoded Overpass QL query body.
 * @param {number} [maxResponseBytes] Endpoint-specific response cap.
 * @returns {Promise<{status:number,body:string,contentType:string,endpoint:string,rateLimited:boolean}>}
 */
async function fetchOverpassPayload(body, maxResponseBytes = OVERPASS_MAX_RESPONSE_BYTES) {
  let lastError = null;
  let lastRateLimitPayload = null;

  for (const endpoint of OVERPASS_UPSTREAMS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

    try {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'gods-eye-view-overpass-proxy/1.0',
        },
        body,
        signal: controller.signal,
      });

      const responseBody = await readResponseTextCapped(upstream, maxResponseBytes);
      const contentType = upstream.headers.get('content-type') || 'application/json';
      const status = upstream.status;
      const rateLimited = status === 429 || overpassLooksRateLimited(responseBody);
      const runtimeError = overpassLooksRuntimeError(responseBody);
      const payload = {
        status,
        body: responseBody,
        contentType,
        endpoint,
        rateLimited,
        runtimeError,
      };

      if (rateLimited) {
        lastRateLimitPayload = payload;
        continue;
      }
      // A 200 body carrying a runtime error / timeout is a transient upstream
      // failure — skip to the next mirror rather than returning or caching it.
      if (runtimeError) {
        lastError = new Error(`Overpass runtime error (${endpoint})`);
        continue;
      }
      if (status >= 500) {
        lastError = new Error(`Overpass upstream returned ${status} (${endpoint})`);
        continue;
      }

      // Success: decimate giant boundary geometry before it reaches the cache,
      // the disk, or the client (what makes the 32 MB read cap safe to hold).
      payload.body = simplifyOverpassPayloadBody(payload.body);
      return payload;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastRateLimitPayload) return lastRateLimitPayload;
  throw lastError || new Error('All Overpass upstreams failed');
}

/**
 * Vite plugin: Overpass API proxy with response caching and request coalescing.
 *
 * Accepts POST requests at /api/overpass, normalizes the query body for
 * cache keying, and fans out to multiple Overpass mirrors with per-upstream
 * timeout and rate-limit detection. Successful responses are cached for
 * OVERPASS_CACHE_MS. Concurrent identical queries share a single upstream
 * request via the in-flight map.
 *
 * @returns {import('vite').Plugin}
 */
function overpassProxy() {
  return {
    name: 'overpass-proxy',
    configureServer(server) {
      server.middlewares.use('/api/overpass', async (req, res) => {
        // Hoisted out of the try so the catch's serve-stale lookup can see it
        // (a body-read failure would otherwise hit an out-of-scope reference).
        let cacheKey = null;
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          // Collect POST body with a hard byte cap (Overpass QL queries are small)
          let body;
          try {
            body = (await readRequestBodyCapped(req, OVERPASS_MAX_BODY_BYTES)).toString();
          } catch (err) {
            if (err?.code === 'BODY_TOO_LARGE') {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Overpass query too large' }));
              return;
            }
            throw err;
          }
          if (!body) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing Overpass query body' }));
            return;
          }

          // Validate + clamp the QL: reject unbounded/global queries and cap the
          // server-side timeout so a tiny body can't request planet-scale work.
          const sanitized = sanitizeOverpassBody(body);
          if (!sanitized.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: sanitized.error }));
            return;
          }
          const safeBody = sanitized.body;

          // Normalize whitespace so semantically identical Overpass QL queries share cache entries
          cacheKey = safeBody.replace(/\s+/g, ' ').trim();
          const preflight = await resolveOverpassPreflight({
            cacheKey,
            memoryCache: _overpassCache,
            inFlight: _overpassInFlight,
            // Fresh-enough disk entries survive restarts and skip the public
            // mirrors; boundary-class queries keep their month-long TTL.
            readDisk: () => readOverpassDisk(cacheKey, overpassDiskTtlMs(cacheKey)),
            allowUpstream: () => _overpassRateLimiter(clientKey(req)),
          });
          if (preflight.source === 'RATE_LIMITED') {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
            res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
            return;
          }
          if (preflight.source !== 'UPSTREAM') {
            if (preflight.source === 'DISK') {
              _overpassCache.set(cacheKey, preflight.payload);
              trimOverpassCache();
            }
            sendOverpassResponse(res, preflight.payload, preflight.source);
            return;
          }

          // From here onward the request is genuinely upstream-bound and has
          // consumed one local limiter slot. Cache and dedupe hits above do not.
          if (_overpassConcurrent >= OVERPASS_MAX_CONCURRENT) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
            res.end(JSON.stringify({ error: 'Overpass proxy busy — try again shortly' }));
            return;
          }
          _overpassConcurrent += 1;
          const requestPromise = fetchOverpassPayload(safeBody)
            .then((payload) => {
              if (payload.status < 500 && !payload.rateLimited && !payload.runtimeError) {
                const entry = { ...payload, cachedAt: Date.now() };
                _overpassCache.set(cacheKey, entry);
                trimOverpassCache();
                writeOverpassDisk(cacheKey, entry);
              }
              return payload;
            })
            .finally(() => {
              _overpassConcurrent -= 1;
              _overpassInFlight.delete(cacheKey);
            });

          _overpassInFlight.set(cacheKey, requestPromise);
          const payload = await requestPromise;
          // Degraded upstream (rate-limited on every mirror / 5xx / runtime
          // error): last-good roads beat an empty layer — serve stale from
          // memory or disk at ANY age before surfacing the failure.
          if (payload.rateLimited || payload.runtimeError || payload.status >= 500) {
            const stale = _overpassCache.get(cacheKey) || await readOverpassDisk(cacheKey, Infinity);
            if (stale) {
              sendOverpassResponse(res, stale, 'STALE');
              return;
            }
          }
          sendOverpassResponse(res, payload, 'MISS');
        } catch (e) {
          // Every mirror threw (network-level). Same serve-stale rule.
          const stale = cacheKey
            ? (_overpassCache.get(cacheKey) || await readOverpassDisk(cacheKey, Infinity).catch(() => null))
            : null;
          if (stale) {
            sendOverpassResponse(res, stale, 'STALE');
            return;
          }
          console.error('[Overpass Proxy]', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Overpass proxy error' }));
        }
      });

      // Real OSM routing via the public FOSSGIS OSRM servers (foot/car/bike).
      // GET /api/route?profile=foot|car|bike&coords=lon,lat;lon,lat[;...]
      server.middlewares.use('/api/route', async (req, res) => {
        const fail = (msg) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: msg }));
        };
        try {
          if (!_routeRateLimiter(clientKey(req))) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
            res.end(JSON.stringify({ ok: false, error: 'rate limited' }));
            return;
          }
          const url = new URL(req.url, 'http://localhost');
          const raw = (url.searchParams.get('profile') || 'foot').toLowerCase();
          const profile = (raw === 'car' || raw === 'driving') ? 'car'
            : (raw === 'bike' || raw === 'cycling' || raw === 'bicycle') ? 'bike'
              : (raw === 'foot' || raw === 'walking' || raw === 'walk') ? 'foot'
                : null;
          if (!profile) return fail('invalid profile');
          const osrmProfile = profile === 'car' ? 'driving' : profile;
          const pairs = (url.searchParams.get('coords') || '').split(';').map((s) => s.trim()).filter(Boolean);
          if (pairs.length < 2 || pairs.length > 12) return fail('need 2-12 coordinates');
          const clean = [];
          const pts = [];
          for (const pr of pairs) {
            const parts = pr.split(',');
            if (parts.length !== 2) return fail('invalid coordinate');
            const lon = Number(parts[0]);
            const lat = Number(parts[1]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
              return fail('invalid coordinate');
            }
            clean.push(`${lon},${lat}`);
            pts.push([lon, lat]);
          }
          // Reject obviously-abusive spans — a real walking/driving route is local,
          // so a cross-continent request is either a bug or an attempt to drive
          // heavy upstream OSRM work.
          let totalKm = 0;
          for (let i = 1; i < pts.length; i += 1) {
            // pts are [lon, lat]; existing haversineKm takes (lat1, lon1, lat2, lon2).
            const legKm = haversineKm(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
            if (legKm > ROUTE_MAX_LEG_KM) return fail('route leg too long');
            totalKm += legKm;
          }
          if (totalKm > ROUTE_MAX_TOTAL_KM) return fail('route too long');
          const coords = clean.join(';');
          const cacheKey = `${profile}|${coords}`;
          const now = Date.now();
          const cached = _routeCache.get(cacheKey);
          if (cached && now - cached.cachedAt <= ROUTE_CACHE_MS) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(cached.payload));
            return;
          }
          const upstream = `https://routing.openstreetmap.de/routed-${profile}/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          let osrm;
          try {
            const upstreamRes = await fetch(upstream, {
              signal: controller.signal,
              headers: { 'User-Agent': 'gods-eye-view/dev (local)' },
            });
            if (!upstreamRes.ok) return fail('no route found');
            const ctype = upstreamRes.headers.get('content-type') || '';
            if (!ctype.includes('json')) return fail('no route found');
            const text = await readResponseTextCapped(upstreamRes, ROUTE_MAX_RESPONSE_BYTES);
            osrm = JSON.parse(text);
          } finally {
            clearTimeout(timer);
          }
          const route = osrm?.routes?.[0];
          if (osrm?.code !== 'Ok' || !route?.geometry?.coordinates?.length) return fail('no route found');
          const payload = {
            ok: true,
            profile,
            distanceM: Math.round(route.distance),
            durationS: Math.round(route.duration),
            geometry: route.geometry.coordinates,
          };
          _routeCache.set(cacheKey, { payload, cachedAt: now });
          if (_routeCache.size > 200) _routeCache.delete(_routeCache.keys().next().value);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } catch (e) {
          console.error('[Route Proxy]', e?.message || e);
          fail('route proxy error');
        }
      });
    },
  };
}

export function adsbLolFallbackAnchor(req) {
  const incoming = new URL(req?.url || '', 'http://localhost');
  const latitude = requiredFiniteQueryNumber(incoming.searchParams, 'lat');
  const longitude = requiredFiniteQueryNumber(incoming.searchParams, 'lon');
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

async function fetchAdsbLolPointFallback(req) {
  const anchor = adsbLolFallbackAnchor(req);
  if (!anchor) return null;
  const roundedLat = Math.round(anchor.latitude * 4) / 4;
  const roundedLon = Math.round(anchor.longitude * 4) / 4;
  const cacheKey = `${roundedLat.toFixed(2)},${roundedLon.toFixed(2)}`;
  const cached = _adsbLolPointCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.cachedAt < ADSBLOL_POINT_CACHE_MS) {
    return { ...cached, cacheStatus: 'HIT' };
  }

  const request = coalesceProxyRequest(_adsbLolPointInFlight, cacheKey, async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const upstream = await fetch(
        `https://api.adsb.lol/v2/lat/${roundedLat}/lon/${roundedLon}/dist/${ADSBLOL_POINT_RADIUS_NM}`,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'gods-eye-view-adsblol-regional-fallback/1.0',
          },
          signal: controller.signal,
        },
      );
      if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
      const payload = await readResponseJsonCapped(upstream, ADSBLOL_POINT_MAX_RESPONSE_BYTES);
      const normalized = normalizeAdsbLolPointResponse(payload);
      const record = {
        body: JSON.stringify(normalized),
        cachedAt: Date.now(),
        count: normalized.states.length,
      };
      _adsbLolPointCache.delete(cacheKey);
      _adsbLolPointCache.set(cacheKey, record);
      while (_adsbLolPointCache.size > ADSBLOL_POINT_CACHE_MAX) {
        _adsbLolPointCache.delete(_adsbLolPointCache.keys().next().value);
      }
      return record;
    } finally {
      clearTimeout(timeoutId);
    }
  });
  try {
    const record = await request.promise;
    return { ...record, cacheStatus: request.shared ? 'INFLIGHT' : 'MISS' };
  } catch (error) {
    if (!request.shared && error?.name !== 'AbortError') {
      console.warn('[adsb.lol Flights Fallback]', error?.message || error);
    }
    return cached ? { ...cached, cacheStatus: 'STALE' } : null;
  }
}

async function serveAdsbLolPointFallback(req, res, requestedMode, reason) {
  const fallback = await fetchAdsbLolPointFallback(req);
  if (!fallback) return false;
  res.writeHead(200, {
    ...buildOpenSkyHeaders({
      cacheStatus: fallback.cacheStatus,
      requestedMode,
      usedMode: 'adsblol-regional',
      reason,
    }),
    'X-Flight-Source': 'adsb.lol',
    'X-Flight-Coverage': `${ADSBLOL_POINT_RADIUS_NM}nm regional fallback`,
    'X-Flight-Count': String(fallback.count),
  });
  res.end(fallback.body);
  return true;
}

function openSkySourceEpochMs(body) {
  try {
    const seconds = Number(JSON.parse(body)?.time);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

function openSkySourceIsStale(sourceEpochMs, now = Date.now()) {
  return Number.isFinite(sourceEpochMs)
    && now - sourceEpochMs > OPENSKY_SOURCE_STALE_MS;
}

/**
 * Vite plugin: OpenSky Network proxy with multi-mode auth and response caching.
 *
 * Supports four auth modes controlled by OPENSKY_AUTH_MODE env:
 *   - 'oauth'  (default) — client_credentials bearer token
 *   - 'basic'  — HTTP Basic with OPENSKY_USERNAME / OPENSKY_PASSWORD
 *   - 'auto'   — try OAuth first, fall back to Basic, then anon
 *   - 'anon'   — no credentials
 *
 * Successful responses are cached for OPENSKY_CACHE_MS (~9 s). On
 * upstream failure the proxy serves a stale cached response if available, or
 * a bounded 250 nm adsb.lol point snapshot around the current view anchor.
 *
 * @returns {import('vite').Plugin}
 */
function openSkyProxy() {
  return {
    name: 'opensky-proxy',
    configureServer(server) {
      server.middlewares.use('/api/opensky', async (req, res) => {
        try {
          const requestedMode = normalizeOpenSkyAuthMode(process.env.OPENSKY_AUTH_MODE);
          const now = Date.now();
          const inCooldown = now < _openskyCooldownUntil;
          // Fresh-enough cache (adaptive TTL) OR any cache during a 429
          // cooldown: serve it without touching upstream. Stale-during-cooldown
          // is deliberate (credit governor): last-good planes beat a dead layer.
          if (_openskyCacheBody && (now - _openskyCacheTime < _openskyTtlMs || inCooldown)) {
            if (
              openSkySourceIsStale(_openskyCacheSourceEpochMs, now)
              && await serveAdsbLolPointFallback(
                req,
                res,
                requestedMode,
                'opensky_snapshot_stale_regional_fallback',
              )
            ) {
              return;
            }
            const cachedMeta = _openskyCacheMeta || {
              requestedMode,
              usedMode: 'unknown',
              reason: 'cached',
            };
            const isStale = now - _openskyCacheTime >= _openskyTtlMs;
            res.writeHead(
              _openskyCacheStatus || 200,
              buildOpenSkyHeaders({
                cacheStatus: isStale ? 'STALE' : 'HIT',
                requestedMode: cachedMeta.requestedMode || requestedMode,
                usedMode: cachedMeta.usedMode || 'unknown',
                reason: isStale ? 'rate_limited_serving_stale' : (cachedMeta.reason || 'cached'),
                staleSeconds: isStale ? (now - _openskyCacheTime) / 1000 : undefined,
                retryAfterSeconds: inCooldown ? (_openskyCooldownUntil - now) / 1000 : undefined,
              })
            );
            res.end(_openskyCacheBody);
            return;
          }
          // Cooling down with nothing cached (cold start into a rate limit):
          // synthesize the 429 locally — hammering upstream mid-cooldown can't
          // succeed and just burns goodwill.
          if (inCooldown) {
            if (await serveAdsbLolPointFallback(req, res, requestedMode, 'opensky_cooldown_regional_fallback')) return;
            res.writeHead(429, buildOpenSkyHeaders({
              cacheStatus: 'COOLDOWN',
              requestedMode,
              usedMode: 'none',
              reason: 'rate_limited',
              retryAfterSeconds: (_openskyCooldownUntil - now) / 1000,
            }));
            res.end(JSON.stringify({ error: 'OpenSky rate limited; proxy cooling down.' }));
            return;
          }

          const basicUser = process.env.OPENSKY_USERNAME || '';
          const basicPass = process.env.OPENSKY_PASSWORD || '';
          const hasBasicCreds = Boolean(basicUser && basicPass);
          const headers = { 'Accept': 'application/json' };
          let usedMode = 'anon';
          let reason = 'forced_anonymous';

          if (requestedMode === 'basic') {
            if (hasBasicCreds) {
              headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
              usedMode = 'basic';
              reason = 'basic_credentials';
            } else {
              reason = 'missing_basic_creds';
            }
          } else if (requestedMode === 'oauth') {
            const token = await getOpenSkyToken();
            if (token) {
              headers.Authorization = `Bearer ${token}`;
              usedMode = 'oauth';
              reason = 'oauth_token';
            } else {
              reason = 'oauth_invalid_or_missing';
            }
          } else if (requestedMode === 'auto') {
            const token = await getOpenSkyToken();
            if (token) {
              headers.Authorization = `Bearer ${token}`;
              usedMode = 'oauth';
              reason = 'oauth_token';
            } else if (hasBasicCreds) {
              headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
              usedMode = 'basic';
              reason = 'oauth_unavailable_fallback_basic';
            } else {
              reason = 'missing_oauth_and_basic_creds';
            }
          }

          let upstream = await fetch('https://opensky-network.org/api/states/all?extended=1', { headers });
          // Auto-mode fallback: if OAuth was rejected, retry with Basic credentials
          if (
            (upstream.status === 401 || upstream.status === 403) &&
            requestedMode === 'auto' &&
            usedMode === 'oauth' &&
            hasBasicCreds
          ) {
            const retryHeaders = {
              Accept: 'application/json',
              Authorization: `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`,
            };
            upstream = await fetch('https://opensky-network.org/api/states/all?extended=1', { headers: retryHeaders });
            usedMode = 'basic';
            reason = 'oauth_rejected_fallback_basic';
          }

          let body = await upstream.text();
          const sourceEpochMs = upstream.ok ? openSkySourceEpochMs(body) : null;
          if (
            upstream.ok
            && openSkySourceIsStale(sourceEpochMs, now)
            && await serveAdsbLolPointFallback(
              req,
              res,
              requestedMode,
              'opensky_snapshot_stale_regional_fallback',
            )
          ) {
            // Keep the last global snapshot available as a fail-soft cache,
            // but do not label or render it as a fresh live result.
            _openskyCacheBody = body;
            _openskyCacheStatus = upstream.status;
            _openskyCacheTime = now;
            _openskyCacheSourceEpochMs = sourceEpochMs;
            _openskyCacheMeta = { requestedMode, usedMode, reason };
            return;
          }
          if (upstream.status === 429) {
            reason = 'rate_limited';
            // Credit governor: honor OpenSky's retry-after (bounded 30 s … 30 min;
            // 2 min when the header is absent) — no upstream attempts until then.
            const retryAfterSec = Number(upstream.headers.get('x-rate-limit-retry-after-seconds'));
            const cooldownMs = Math.min(
              Math.max(Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 120_000, 30_000),
              30 * 60_000
            );
            _openskyCooldownUntil = now + cooldownMs;
            // Serve the last-good body instead of the 429 when we have one —
            // the layer keeps rendering (STALE-cued) instead of dying.
            if (_openskyCacheBody && _openskyCacheStatus === 200) {
              res.writeHead(200, buildOpenSkyHeaders({
                cacheStatus: 'STALE',
                requestedMode,
                usedMode,
                reason: 'rate_limited_serving_stale',
                staleSeconds: (now - _openskyCacheTime) / 1000,
                retryAfterSeconds: cooldownMs / 1000,
              }));
              res.end(_openskyCacheBody);
              return;
            }
          }

          if (!upstream.ok && !_openskyCacheBody) {
            const servedFallback = await serveAdsbLolPointFallback(
              req,
              res,
              requestedMode,
              `opensky_http_${upstream.status}_regional_fallback`,
            );
            if (servedFallback) return;
          }

          if (upstream.status === 401 || upstream.status === 403) {
            if (requestedMode === 'basic' && !hasBasicCreds) {
              body = JSON.stringify({
                error: 'OpenSky auth missing. Basic mode requires OPENSKY_USERNAME and OPENSKY_PASSWORD.',
              });
              reason = 'missing_basic_creds';
            } else if (requestedMode === 'oauth' && usedMode !== 'oauth') {
              body = JSON.stringify({
                error: 'OpenSky auth invalid. OAuth mode requires valid OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.',
              });
              reason = 'oauth_invalid_or_missing';
            } else if (usedMode === 'basic') {
              body = JSON.stringify({
                error: 'OpenSky auth invalid. Username/password were rejected.',
              });
              reason = 'basic_invalid_credentials';
            } else if (usedMode === 'oauth') {
              body = JSON.stringify({
                error: 'OpenSky auth invalid. OAuth client credentials were rejected.',
              });
              reason = 'oauth_invalid_credentials';
            } else if (requestedMode === 'auto' && !hasBasicCreds) {
              body = JSON.stringify({
                error: 'OpenSky auth missing. Provide basic credentials or valid OAuth client credentials.',
              });
              reason = 'missing_oauth_and_basic_creds';
            } else {
              body = JSON.stringify({
                error: 'OpenSky auth required.',
              });
              reason = 'auth_required';
            }
          }

          // Refine the reason string to reflect the actual outcome
          if (upstream.ok && reason === 'forced_anonymous') {
            reason = 'anonymous_ok';
          } else if (upstream.ok && usedMode === 'basic' && reason === 'basic_credentials') {
            reason = 'basic_ok';
          } else if (upstream.ok && usedMode === 'oauth' && reason === 'oauth_token') {
            reason = 'oauth_ok';
          }

          // Only cache successful responses — error responses (401/403/429/5xx)
          // should not be served from cache on subsequent requests
          if (upstream.ok) {
            _openskyCacheBody = body;
            _openskyCacheStatus = upstream.status;
            _openskyCacheTime = now;
            _openskyCacheSourceEpochMs = sourceEpochMs;
            _openskyCacheMeta = {
              requestedMode,
              usedMode,
              reason,
            };
            // Credit governor: adapt the cache TTL to the remaining daily
            // budget so a continuously-open app stretches its polls instead of
            // exhausting the quota mid-day. Success also clears any cooldown.
            const remaining = Number(upstream.headers.get('x-rate-limit-remaining'));
            _openskyTtlMs = openskyAdaptiveTtlMs(remaining);
            _openskyCooldownUntil = 0;
          }

          res.writeHead(
            upstream.status,
            buildOpenSkyHeaders({
              cacheStatus: 'MISS',
              requestedMode,
              usedMode,
              reason,
            })
          );
          res.end(body);
        } catch (e) {
          console.error('[OpenSky Proxy]', e.message);
          if (_openskyCacheBody) {
            const cachedMeta = _openskyCacheMeta || {
              requestedMode: normalizeOpenSkyAuthMode(process.env.OPENSKY_AUTH_MODE),
              usedMode: 'unknown',
              reason: 'cached_stale',
            };
            res.writeHead(
              _openskyCacheStatus || 200,
              buildOpenSkyHeaders({
                cacheStatus: 'STALE',
                requestedMode: cachedMeta.requestedMode || OPENSKY_AUTH_MODE_DEFAULT,
                usedMode: cachedMeta.usedMode || 'unknown',
                reason: cachedMeta.reason || 'cached_stale',
              })
            );
            res.end(_openskyCacheBody);
            return;
          }
          const requestedMode = normalizeOpenSkyAuthMode(process.env.OPENSKY_AUTH_MODE);
          if (await serveAdsbLolPointFallback(req, res, requestedMode, 'opensky_proxy_error_regional_fallback')) return;
          res.writeHead(
            502,
            buildOpenSkyHeaders({
              cacheStatus: 'MISS',
              requestedMode,
              usedMode: 'error',
              reason: 'proxy_error',
            })
          );
          res.end(JSON.stringify({ error: 'OpenSky proxy error' }));
        }
      });
    },
  };
}

/**
 * Check whether a hostname is in the GBFS allowlist.
 *
 * Also accepts any subdomain of publicbikesystem.net.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isAllowedGbfsHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  if (GBFS_ALLOWED_HOSTS.has(host)) return true;
  return host.endsWith('.publicbikesystem.net');
}

/**
 * Only allow station_information.json and station_status.json endpoints.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
function isAllowedGbfsPath(pathname) {
  return /\/station_(information|status)\.json$/i.test(String(pathname || ''));
}

/**
 * Return an appropriate Cache-Control header for a GBFS endpoint.
 *
 * station_information is semi-static (5 min cache); station_status is
 * real-time (no-store).
 *
 * @param {string} pathname
 * @returns {string} Cache-Control header value.
 */
function gbfsCacheControl(pathname) {
  if (/\/station_information\.json$/i.test(String(pathname || ''))) {
    return 'public, max-age=300';
  }
  return 'no-store';
}

/**
 * Vite plugin: GBFS bike-share proxy with host allowlisting and size limits.
 *
 * Accepts GET /api/gbfs/<encoded-upstream-URL> and proxies the request
 * to the upstream GBFS provider. Validates hostname against an allowlist,
 * restricts to station_information/station_status paths, enforces HTTPS,
 * and caps response body at 5 MB.
 *
 * @returns {import('vite').Plugin}
 */
function gbfsProxy() {
  return {
    name: 'gbfs-proxy',
    configureServer(server) {
      server.middlewares.use('/api/gbfs', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          const url = new URL(req.url || '/', 'http://localhost');
          const encodedTarget = url.pathname.replace(/^\/+/, '');
          if (!encodedTarget) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Missing GBFS upstream target' }));
            return;
          }

          let decodedTarget = '';
          try {
            decodedTarget = decodeURIComponent(encodedTarget);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Invalid GBFS target encoding' }));
            return;
          }

          let upstreamUrl = null;
          try {
            upstreamUrl = new URL(decodedTarget);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Invalid GBFS upstream URL' }));
            return;
          }

          if (upstreamUrl.protocol !== 'https:') {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Only https GBFS targets are allowed' }));
            return;
          }

          if (!isAllowedGbfsHost(upstreamUrl.hostname)) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'GBFS host not allowed' }));
            return;
          }

          if (!isAllowedGbfsPath(upstreamUrl.pathname)) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Only station_information/station_status endpoints are allowed' }));
            return;
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), GBFS_PROXY_TIMEOUT_MS);
          let upstream;
          try {
            upstream = await fetch(upstreamUrl.toString(), {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                'User-Agent': 'gods-eye-view-gbfs-proxy/1.0',
              },
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutId);
          }

          // Limit response size to prevent memory exhaustion from malicious upstream
          const GBFS_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
          const contentLength = Number(upstream.headers.get('content-length'));
          if (Number.isFinite(contentLength) && contentLength > GBFS_MAX_BODY_BYTES) {
            res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'GBFS upstream response too large' }));
            return;
          }
          const body = await upstream.text();
          if (body.length > GBFS_MAX_BODY_BYTES) {
            res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'GBFS upstream response too large' }));
            return;
          }
          const contentType = upstream.headers.get('content-type') || 'application/json';
          res.writeHead(upstream.status, {
            'Content-Type': contentType,
            'Cache-Control': gbfsCacheControl(upstreamUrl.pathname),
            'X-GBFS-Upstream': upstreamUrl.hostname,
            'X-GBFS-Cache': 'MISS',
          });
          res.end(body);
        } catch (error) {
          if (error?.name === 'AbortError') {
            res.writeHead(504, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'GBFS upstream timeout' }));
            return;
          }
          console.error('[GBFS Proxy]', error?.message || String(error));
          res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'GBFS proxy error' }));
        }
      });
    },
  };
}

/**
 * FNV-1a 32-bit hash of a string, used to derive deterministic pseudo-random
 * values (e.g. hue for synthetic SVG billboards, fallback heading angles).
 *
 * @param {string} text
 * @returns {number} Unsigned 32-bit hash.
 */
function hashSeed(text) {
  let h = 2166136261 >>> 0; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  return h >>> 0;
}

/**
 * Escape special XML/HTML characters for safe embedding in SVG text nodes.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Canonicalize a CCTV feed type string to one of:
 * 'image', 'mjpeg', 'mp4', 'webm', 'hls', or pass-through.
 *
 * @param {string} value - Raw feed type (e.g. 'jpeg', 'mjpg', 'video', 'stream').
 * @returns {string} Normalized feed type.
 */
function normalizeFeedType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'image';
  if (raw === 'jpeg' || raw === 'jpg' || raw === 'png') return 'image';
  if (raw === 'mjpg') return 'mjpeg';
  if (raw === 'video') return 'mp4';
  if (raw === 'stream') return 'hls';
  return raw;
}

/**
 * Check whether a normalized feed type represents streaming video.
 *
 * @param {string} feedType
 * @returns {boolean}
 */
function isVideoFeedType(feedType) {
  return feedType === 'mp4' || feedType === 'webm' || feedType === 'hls';
}

// ---------------------------------------------------------------------------
// CCTV proxy constants and source cache state
// ---------------------------------------------------------------------------
/** Path to the optional static CCTV source list (JSON array). */
const DEFAULT_CCTV_SOURCE_FILE = 'config/cctv_sources.austin.json';
/** Austin Open Data portal endpoint for traffic camera records. */
const DEFAULT_AUSTIN_ROWS_URL = 'https://data.austintexas.gov/api/views/b4k4-adkb/rows.json?accessType=DOWNLOAD';
/** Default cap on Austin cameras after distance-based prioritization. */
const DEFAULT_AUSTIN_MAX_SOURCES = 250;
/** Global cap on total CCTV sources served by the proxy. */
const DEFAULT_CCTV_MAX_SOURCES = 900;
/** Reference point for Austin camera prioritization (Congress & 6th). */
const AUSTIN_DOWNTOWN = { lat: 30.2672, lon: -97.7431 };
/** Caltrans CCTV: one JSON feed per district, identical schema statewide. */
const CALTRANS_CCTV_URL = (district) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`;
/** Districts fetched by default: SF Bay (4), LA (7), San Diego (11), Sacramento (3). */
const DEFAULT_CALTRANS_DISTRICTS = '4,7,11,3';
const DEFAULT_CALTRANS_MAX_SOURCES = 300;
/** Prioritization anchors: downtown cores of the four default metros. */
const CALTRANS_ANCHORS = [
  { lat: 37.7793, lon: -122.4193 }, // San Francisco
  { lat: 34.0537, lon: -118.2428 }, // Los Angeles
  { lat: 32.7157, lon: -117.1611 }, // San Diego
  { lat: 38.5816, lon: -121.4944 }, // Sacramento
];
/** TfL JamCams: one keyless list endpoint; frames live on a public S3 bucket. */
const TFL_JAMCAM_URL = 'https://api.tfl.gov.uk/Place/Type/JamCam';
const TFL_IMAGE_ORIGIN = 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/';
const DEFAULT_TFL_MAX_SOURCES = 250;
const LONDON_CENTER = { lat: 51.5074, lon: -0.1278 };
/** Camera CATALOGS change rarely; 15 min keeps multi-megabyte upstream list refetches (Austin rows.json + 4 Caltrans districts + TfL) infrequent. Frames are fetched per-request and are unaffected. */
const CCTV_SOURCE_CACHE_MS = 15 * 60 * 1000;
/** Per-provider catalog-fetch timeout. Bounds the worst-case refresh so one
 * stalled upstream can't leave getCctvSources (and thus every CCTV route)
 * pending forever — a hung fetch aborts, the loader returns [], and
 * serve-stale/other packs take over. */
const CCTV_SOURCE_FETCH_TIMEOUT_MS = 15 * 1000;
/** Individual CCTV image fetches must settle before the active 10-second
 * client refresh cadence. A bounded miss can fall through to Street View or
 * the synthetic frame instead of leaving the browser preview pending. */
export const CCTV_FRAME_FETCH_TIMEOUT_MS = 8 * 1000;
/** @type {Array<object>} Cached merged + normalized CCTV source list. */
let _cctvSourceCache = [];
/** @type {number} Epoch-ms when the source cache was last refreshed. */
let _cctvSourceCacheAt = 0;
/** @type {Promise<Array<object>>|null} In-flight refresh, shared by concurrent
 * callers so a post-TTL burst launches ONE refetch, not one per request. */
let _cctvSourceInflight = null;

/**
 * Coerce a value to a finite number, returning fallback if NaN/Infinity.
 *
 * @param {*} value
 * @param {number} [fallback=NaN]
 * @returns {number}
 */
function toFiniteNumber(value, fallback = NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Normalize a column/field name to a lowercase snake_case key.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Load CCTV sources from a local JSON file (CCTV_SOURCES_FILE env or default).
 *
 * @returns {Array<object>} Array of raw source objects, or [] on error.
 */
function loadSourcesFromFile() {
  const sourceFile = process.env.CCTV_SOURCES_FILE || DEFAULT_CCTV_SOURCE_FILE;
  const resolved = path.isAbsolute(sourceFile)
    ? sourceFile
    : path.resolve(__dirname, sourceFile);
  try {
    if (!fs.existsSync(resolved)) return [];
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[CCTV] failed to read source file:', resolved, error?.message || error);
    return [];
  }
}

/**
 * Load CCTV sources from the CCTV_SOURCES_JSON env variable (inline JSON).
 *
 * @returns {Array<object>} Array of raw source objects, or [] if unset/invalid.
 */
function loadSourcesFromEnv() {
  const raw = process.env.CCTV_SOURCES_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}


/**
 * Parse a WKT POINT string (e.g. "POINT(-97.74 30.27)") into lat/lon.
 *
 * WKT uses (lon lat) order; returned object uses {lat, lon}.
 *
 * @param {string} value
 * @returns {{lat:number, lon:number}}
 */
function parsePointString(value) {
  const match = String(value || '').match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (!match) return { lat: NaN, lon: NaN };
  return {
    lon: toFiniteNumber(match[1]),
    lat: toFiniteNumber(match[2]),
  };
}

/**
 * Extract lat/lon from a variety of coordinate representations.
 *
 * Handles WKT POINT strings, and objects with latitude/lat/y or
 * longitude/lon/lng/x properties (various casing).
 *
 * @param {string|object|null} value
 * @returns {{lat:number, lon:number}}
 */
function coerceLatLon(value) {
  if (!value) return { lat: NaN, lon: NaN };

  if (typeof value === 'string') {
    return parsePointString(value);
  }

  if (typeof value !== 'object') {
    return { lat: NaN, lon: NaN };
  }

  const lat = toFiniteNumber(
    value.latitude ?? value.lat ?? value.y ?? value.Latitude ?? value.Lat,
    NaN
  );
  const lon = toFiniteNumber(
    value.longitude ?? value.lon ?? value.lng ?? value.x ?? value.Longitude ?? value.Lon,
    NaN
  );
  return { lat, lon };
}

/**
 * Extract geographic coordinates from an Austin Open Data camera record.
 *
 * Tries several candidate fields (location, coordinates, the_geom,
 * point, geocoded_column) via coerceLatLon, then falls back to
 * explicit latitude/longitude scalar fields.
 *
 * @param {object} record - Flattened camera record.
 * @returns {{lat:number, lon:number}}
 */
function extractAustinCoords(record) {
  const candidates = [
    record.location,
    record.coordinates,
    record.the_geom,
    record.point,
    record.geocoded_column,
  ];
  for (const candidate of candidates) {
    const parsed = coerceLatLon(candidate);
    if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon)) return parsed;
  }

  const lat = toFiniteNumber(
    record.latitude ?? record.lat ?? record.camera_latitude ?? record.location_latitude,
    NaN
  );
  const lon = toFiniteNumber(
    record.longitude ?? record.lon ?? record.lng ?? record.camera_longitude ?? record.location_longitude,
    NaN
  );
  return { lat, lon };
}

/**
 * Extract a numeric camera ID from an Austin Open Data record.
 *
 * Tries well-known field names first, then scans any field whose key
 * contains "camera"/"cam"/"device" + "id".
 *
 * @param {object} record - Flattened camera record.
 * @returns {string} Numeric ID string, or '' if none found.
 */
function extractAustinCameraId(record) {
  const preferredKeys = [
    'camera_id',
    'cameraid',
    'cam_id',
    'device_id',
    'intersection_id',
    'id',
  ];
  for (const key of preferredKeys) {
    const value = record[key];
    if (value == null) continue;
    const asText = String(value).trim();
    if (!asText) continue;
    if (/^\d+$/.test(asText)) return asText;
  }

  for (const [key, value] of Object.entries(record)) {
    if (!/camera|cam|device/.test(key)) continue;
    if (!/id/.test(key)) continue;
    const asText = String(value || '').trim();
    if (!asText) continue;
    if (/^\d+$/.test(asText)) return asText;
  }

  return '';
}

/**
 * Extract a human-readable camera name from an Austin record.
 *
 * @param {object} record - Flattened camera record.
 * @param {string} cameraId - Fallback identifier if no name field found.
 * @returns {string}
 */
function extractAustinName(record, cameraId) {
  const preferredKeys = [
    'camera_name',
    'location_name',
    'intersection_name',
    'location',
    'cross_street',
    'description',
    'name',
  ];
  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return `Austin Camera ${cameraId}`;
}

/**
 * Extract camera heading (compass bearing) from an Austin record.
 *
 * Tries explicit numeric heading fields first, then direction-keyword
 * fields, then infers from the camera name/description text.
 *
 * @param {object} record - Flattened camera record.
 * @returns {number} Heading in degrees [0..360), or NaN if unknown.
 */
function extractAustinHeading(record) {
  const direct = toFiniteNumber(record.heading_deg ?? record.heading ?? record.bearing, NaN);
  if (Number.isFinite(direct)) return ((direct % 360) + 360) % 360;

  // Dedicated direction fields: bare cardinal words ("West") are real facings.
  const directionKeys = ['direction', 'travel_direction', 'facing', 'facing_direction'];
  for (const key of directionKeys) {
    const heading = directionToHeading(record[key], true);
    if (Number.isFinite(heading)) return heading;
  }

  // Free-form name/intersection text: only explicit travel forms ("WESTBOUND"/
  // "WB") count — a bare "West" here is a street name ("5TH ST / WEST AVE"), not
  // a facing, and must not promote the camera to a false high-confidence heading.
  const nameProbe = [
    record.camera_name,
    record.location_name,
    record.intersection_name,
    record.location,
    record.cross_street,
    record.description,
    record.name,
  ].filter(Boolean).join(' ');
  const inferred = directionToHeading(nameProbe);
  if (Number.isFinite(inferred)) return inferred;

  return NaN;
}

/**
 * Bounding-box sanity check: is this coordinate plausibly in the Austin metro area?
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
function isLikelyAustinCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= 30.02 && lat <= 30.58 && lon >= -98.12 && lon <= -97.40;
}

/**
 * Derive a deterministic fallback heading from a camera ID hash.
 *
 * Produces one of 16 evenly-spaced compass directions (0, 22.5, 45, ...).
 *
 * @param {string} cameraId
 * @returns {number} Heading in degrees [0..360).
 */
function fallbackHeadingFromId(cameraId) {
  return (hashSeed(String(cameraId)) % 16) * 22.5;
}

/**
 * Convert a Socrata rows.json array row into a keyed object using column metadata.
 *
 * @param {Array} row - Array of cell values from the Socrata payload.
 * @param {Array<{fieldName?:string, name?:string}>} columns - Column descriptors.
 * @returns {object} Keyed record with normalized snake_case keys.
 */
function rowArrayToObject(row, columns) {
  const record = {};
  for (let idx = 0; idx < columns.length; idx++) {
    const col = columns[idx];
    const key = normalizeKey(col.fieldName || col.name || `col_${idx}`);
    if (!key) continue;
    record[key] = row[idx];
  }
  return record;
}

/**
 * Haversine great-circle distance between two WGS-84 points.
 *
 * @param {number} lat1 - Latitude of point A (degrees).
 * @param {number} lon1 - Longitude of point A (degrees).
 * @param {number} lat2 - Latitude of point B (degrees).
 * @param {number} lon2 - Longitude of point B (degrees).
 * @returns {number} Distance in kilometers.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Distance-prioritizes cameras to a cap: keeps the maxCount cameras closest
 * to ANY of the given anchor points (min distance over anchors), tie-broken
 * by original array order. Used by every live source pack (Austin: one
 * downtown anchor; Caltrans: one anchor per major CA metro; TfL: central
 * London) so a cap always keeps the densest, most interesting cores.
 *
 * @param {Array<object>} cameras - Normalized camera source objects.
 * @param {number} maxCount - Cap (<=0 or >= length disables).
 * @param {Array<{lat:number,lon:number}>} anchors - At least one anchor.
 * @returns {Array<object>} Capped, priority-ordered camera list.
 */
function prioritizeSources(cameras, maxCount, anchors) {
  const list = Array.isArray(cameras) ? cameras : [];
  const anchorList = (Array.isArray(anchors) ? anchors : []).filter(
    (a) => Number.isFinite(a?.lat) && Number.isFinite(a?.lon)
  );
  if (!Number.isFinite(maxCount) || maxCount <= 0 || list.length <= maxCount || !anchorList.length) {
    return list;
  }

  const scored = list.map((camera, idx) => {
    const lat = Number(camera?.lat);
    const lon = Number(camera?.lon);
    const distKm = Number.isFinite(lat) && Number.isFinite(lon)
      ? Math.min(...anchorList.map((a) => haversineKm(lat, lon, a.lat, a.lon)))
      : Number.POSITIVE_INFINITY;
    return { camera, idx, distKm };
  });

  scored.sort((a, b) => {
    if (a.distKm !== b.distKm) return a.distKm - b.distKm;
    return a.idx - b.idx;
  });

  return scored.slice(0, maxCount).map((entry) => entry.camera);
}

/**
 * Fetch and parse Austin traffic camera records from the city Open Data portal.
 *
 * Downloads the Socrata rows.json payload, converts each row to a keyed
 * record, extracts camera ID / coords / heading / name, validates against
 * the Austin bounding box, deduplicates by ID, then distance-prioritizes
 * to stay within CCTV_AUSTIN_MAX_SOURCES.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
async function loadAustinSourcesFromOpenData() {
  const endpoint = process.env.CCTV_AUSTIN_ROWS_URL || DEFAULT_AUSTIN_ROWS_URL;
  try {
    const resp = await fetch(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS) });
    if (!resp.ok) {
      console.warn('[CCTV] Austin source download failed:', resp.status);
      return [];
    }
    const payload = await resp.json();
    const columns = Array.isArray(payload?.meta?.view?.columns) ? payload.meta.view.columns : [];
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (!columns.length || !rows.length) return [];

    const cameras = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const record = rowArrayToObject(row, columns);
      const cameraId = extractAustinCameraId(record);
      if (!cameraId) continue;

      // Only live cameras: the dataset carries DESIRED (planned, not built),
      // REMOVED and VOID rows whose frame URLs never resolve — those cameras
      // would render as permanent Street View / synthetic fallbacks. Tolerate
      // a missing column (keep the row) so a schema change fails open.
      const status = String(record.camera_status || '').trim().toUpperCase();
      if (status && status !== 'TURNED_ON') continue;

      const { lat, lon } = extractAustinCoords(record);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!isLikelyAustinCoordinate(lat, lon)) continue;

      const extractedHeading = extractAustinHeading(record);
      const hasHeading = Number.isFinite(extractedHeading);
      const headingDeg = hasHeading ? extractedHeading : fallbackHeadingFromId(cameraId);
      cameras.push({
        id: cameraId,
        name: extractAustinName(record, cameraId),
        city: 'Austin',
        cityId: 'austin',
        provider: 'Austin Transportation & Public Works',
        lat,
        lon,
        headingDeg,
        headingConfidence: hasHeading ? 'high' : 'low',
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        groundElevationM: 150,
        feedType: 'image',
        url: `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`,
        snapshotUrl: `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`,
        sourceKind: 'austin-open-data',
        license: 'Public city traffic camera frame',
      });
    }

    const unique = Array.from(new Map(cameras.map((camera) => [camera.id, camera])).values());
    const maxRaw = Number(process.env.CCTV_AUSTIN_MAX_SOURCES || DEFAULT_AUSTIN_MAX_SOURCES);
    const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(300, Math.floor(maxRaw))) : DEFAULT_AUSTIN_MAX_SOURCES;
    const prioritized = prioritizeSources(unique, maxCount, [AUSTIN_DOWNTOWN]);
    if (prioritized.length < unique.length) {
      console.log(`[CCTV] Loaded Austin camera sources: ${unique.length} (using nearest ${prioritized.length})`);
    } else {
      console.log('[CCTV] Loaded Austin camera sources:', prioritized.length);
    }
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] Austin source download error:', error?.message || error);
    return [];
  }
}

/**
 * Fetch Caltrans CCTV cameras for the configured districts (CCTV_CALTRANS_DISTRICTS,
 * comma-separated 1..12; empty string disables the pack). One official JSON feed per
 * district, identical schema statewide; keyless. Only inService cameras with finite
 * coords and a cwwp2.dot.ca.gov https image URL are kept (the image-URL origin check
 * is defense-in-depth: the proxy only ever fetches catalog URLs, and this pins the
 * catalog to the official host). Districts fetch in parallel and fail independently
 * (Promise.allSettled) — one district outage never darkens the others.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
async function loadCaltransSourcesFromOpenData() {
  const districtsRaw = process.env.CCTV_CALTRANS_DISTRICTS ?? DEFAULT_CALTRANS_DISTRICTS;
  const districts = String(districtsRaw)
    .split(',')
    .map((token) => Number(token.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
  if (!districts.length) return [];

  const settled = await Promise.allSettled(
    districts.map(async (district) => {
      const resp = await fetch(CALTRANS_CCTV_URL(district), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`D${district} HTTP ${resp.status}`);
      const payload = await resp.json();
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      return { district, rows };
    })
  );

  const cameras = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      console.warn('[CCTV] Caltrans district fetch failed:', result.reason?.message || result.reason);
      continue;
    }
    const { district, rows } = result.value;
    for (const row of rows) {
      const cctv = row?.cctv;
      if (!cctv || String(cctv.inService).toLowerCase() !== 'true') continue;
      const loc = cctv.location || {};
      const lat = toFiniteNumber(loc.latitude);
      const lon = toFiniteNumber(loc.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const imageUrl = String(cctv.imageData?.static?.currentImageURL || '');
      // Official-host pin (see JSDoc). Also drops records with no still image.
      if (!imageUrl.startsWith('https://cwwp2.dot.ca.gov/')) continue;

      const locationName = String(loc.locationName || '').trim();
      // Leading token of locationName is the stable camera code ("TV102 -- I-580 : …").
      const codeMatch = /^([A-Za-z0-9_-]+)\s*--/.exec(locationName);
      const code = (codeMatch ? codeMatch[1] : `x${cameras.length}`).toLowerCase();
      const cameraId = `ca-d${district}-${code}`;

      // loc.direction is a dedicated field ("West", "South") → allow bare words.
      const heading = directionToHeading(loc.direction, true);
      const hasHeading = Number.isFinite(heading);
      const label = locationName.replace(/^([A-Za-z0-9_-]+)\s*--\s*/, '') || `Caltrans D${district} ${code}`;
      cameras.push({
        id: cameraId,
        name: loc.nearbyPlace ? `${label} (${loc.nearbyPlace})` : label,
        city: String(loc.nearbyPlace || `Caltrans D${district}`),
        cityId: `ca-d${district}`,
        provider: 'Caltrans',
        lat,
        lon,
        headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
        headingConfidence: hasHeading ? 'high' : 'low',
        // Same two fabricated pose personalities as Austin (design §1a): these are
        // RAW PRIOR starting points; the client's one-shot ground snap + manual
        // calibration own the truth.
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        // loc.elevation is reported in FEET (verified: D3 maxes at 7427 ft ≈
        // 2264 m for the Sierra passes — as metres that would top Mt Whitney).
        // Convert to metres and clamp to a sane CA-roads range so an occasional
        // garbage upstream value can't fling a camera kilometres up. Prior only:
        // the client one-shot snap corrects it on 3D-tile stacks — but on a
        // no-tileset stack (keyless OSM) the snap misses and this height freezes,
        // so it must be right-ish on its own.
        groundElevationM: (() => {
          const ft = toFiniteNumber(loc.elevation, NaN);
          return Number.isFinite(ft) ? Math.max(-100, Math.min(4000, ft * 0.3048)) : 150;
        })(),
        feedType: 'image',
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'caltrans-open-data',
        license: 'Public Caltrans highway camera frame',
      });
    }
  }

  const maxRaw = Number(process.env.CCTV_CALTRANS_MAX_SOURCES || DEFAULT_CALTRANS_MAX_SOURCES);
  const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(600, Math.floor(maxRaw))) : DEFAULT_CALTRANS_MAX_SOURCES;
  const prioritized = prioritizeSources(cameras, maxCount, CALTRANS_ANCHORS);
  console.log(`[CCTV] Loaded Caltrans camera sources: ${cameras.length} inService (using nearest ${prioritized.length})`);
  return prioritized;
}

/**
 * Fetch TfL JamCams (London). Keyless: the optional TFL_APP_KEY only raises the
 * list-endpoint rate limit (frames come from TfL's public S3 bucket, which is not
 * rate-limited); the 15-min source cache keeps list hits far below anonymous
 * limits anyway. Only `available === "true"` cameras with finite coords and an
 * image URL on the official bucket are kept. Attribution: "Powered by TfL Open
 * Data" (registered in src/data/dataCredits.js).
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
async function loadTflSourcesFromOpenData() {
  try {
    const appKey = String(process.env.TFL_APP_KEY || '').trim();
    const url = appKey ? `${TFL_JAMCAM_URL}?app_key=${encodeURIComponent(appKey)}` : TFL_JAMCAM_URL;
    const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS) });
    if (!resp.ok) {
      console.warn('[CCTV] TfL JamCam download failed:', resp.status);
      return [];
    }
    const places = await resp.json();
    if (!Array.isArray(places)) return [];

    const cameras = [];
    for (const place of places) {
      const props = {};
      for (const p of place?.additionalProperties || []) {
        if (p?.key) props[p.key] = p.value;
      }
      if (String(props.available).toLowerCase() !== 'true') continue;
      const lat = toFiniteNumber(place?.lat);
      const lon = toFiniteNumber(place?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const imageUrl = String(props.imageUrl || '');
      if (!imageUrl.startsWith(TFL_IMAGE_ORIGIN)) continue; // official-bucket pin

      // "JamCams_00002.00865" → "tfl-00002.00865" (provider-stable id).
      const rawId = String(place?.id || '').replace(/^JamCams_/, '');
      if (!rawId) continue;
      const cameraId = `tfl-${rawId}`;

      cameras.push({
        id: cameraId,
        name: String(place?.commonName || `JamCam ${rawId}`),
        city: 'London',
        cityId: 'london',
        provider: 'Transport for London',
        lat,
        lon,
        // No heading signal at all in JamCam data → id-hash fallback, low
        // confidence personality (same as headingless Austin cameras).
        headingDeg: fallbackHeadingFromId(cameraId),
        headingConfidence: 'low',
        pitchDeg: -18,
        fovDeg: 44,
        rangeM: 145,
        mountHeightM: 8,
        groundElevationM: 15, // Thames-basin prior; one-shot snap corrects.
        feedType: 'image', // stills-first (product rule); props.videoUrl deliberately unused
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'tfl-open-data',
        license: 'Powered by TfL Open Data',
      });
    }

    const maxRaw = Number(process.env.CCTV_TFL_MAX_SOURCES || DEFAULT_TFL_MAX_SOURCES);
    const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(600, Math.floor(maxRaw))) : DEFAULT_TFL_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, [LONDON_CENTER]);
    console.log(`[CCTV] Loaded TfL JamCam sources: ${cameras.length} available (using nearest ${prioritized.length})`);
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] TfL JamCam download error:', error?.message || error);
    return [];
  }
}

/**
 * Normalize a raw CCTV source item into a canonical shape with safe defaults.
 *
 * @param {object} item - Raw source from file, env, or Austin Open Data.
 * @returns {object} Normalized source with all expected fields populated.
 */
function normalizeSourceItem(item) {
  return {
    id: String(item.id || '').trim(),
    name: String(item.name || item.id || '').trim(),
    city: String(item.city || ''),
    cityId: String(item.cityId || ''),
    provider: String(item.provider || 'Configured CCTV Source'),
    lat: toFiniteNumber(item.lat),
    lon: toFiniteNumber(item.lon),
    headingDeg: toFiniteNumber(item.headingDeg),
    headingConfidence: String(item.headingConfidence || item.headingSource || '').toLowerCase(),
    pitchDeg: toFiniteNumber(item.pitchDeg),
    fovDeg: toFiniteNumber(item.fovDeg),
    rangeM: toFiniteNumber(item.rangeM),
    mountHeightM: toFiniteNumber(item.mountHeightM),
    groundElevationM: toFiniteNumber(item.groundElevationM),
    feedType: normalizeFeedType(item.feedType || item.type || ''),
    url: typeof item.url === 'string' ? item.url : '',
    snapshotUrl: typeof item.snapshotUrl === 'string' ? item.snapshotUrl : '',
    license: String(item.license || item.licenseNote || ''),
    sourceKind: String(item.sourceKind || item.kind || 'configured'),
    // Optional CAL badge input (cctv-v2 design §3b/§9.2, additive-only per the
    // global constraints — nothing else in this file changes): hand-authored
    // file/env catalog entries may declare poseSource:'curated' so the panel
    // badge can distinguish them from raw automated priors (e.g. Austin Open
    // Data, which never sets this field). Passed through as-is to the client.
    poseSource: item.poseSource === 'curated' ? 'curated' : undefined,
  };
}

/**
 * Assemble and cache the merged CCTV source list.
 *
 * Merges sources from three origins (Austin Open Data, local file,
 * env variable), deduplicates by ID, applies the global max cap, and
 * caches for CCTV_SOURCE_CACHE_MS.
 *
 * @returns {Promise<Array<object>>} Deduplicated, capped source list.
 */
async function getCctvSources() {
  const now = Date.now();
  if (_cctvSourceCache.length && now - _cctvSourceCacheAt <= CCTV_SOURCE_CACHE_MS) {
    return _cctvSourceCache;
  }
  // Single-flight: a burst of requests arriving past the TTL shares ONE refresh
  // instead of each launching the full multi-provider refetch. The `.finally`
  // clears the ref so the next post-TTL cycle starts fresh.
  if (_cctvSourceInflight) return _cctvSourceInflight;
  _cctvSourceInflight = refreshCctvSources().finally(() => { _cctvSourceInflight = null; });
  return _cctvSourceInflight;
}

/**
 * Assemble and cache the merged CCTV source list from file/env + live packs.
 * Always resolves (loaders self-catch to []); on a fully-empty refresh with a
 * good prior catalog it serves stale rather than blanking the CCTV layer.
 *
 * @returns {Promise<Array<object>>} Deduplicated, capped source list.
 */
async function refreshCctvSources() {
  const fromFile = loadSourcesFromFile();
  const fromEnv = loadSourcesFromEnv();

  const forceAustin = String(process.env.CCTV_FORCE_AUSTIN || '').trim() === '1';
  const preferAustin = String(process.env.CCTV_PREFER_AUSTIN || '1').trim() !== '0';
  // Live open-data packs (Austin + Caltrans + TfL) load unless a file/env pack
  // is configured and live packs aren't forced — same gate that governed the
  // Austin-only fetch, now governing all three. Each pack fails independently.
  const needsLiveSources = forceAustin || ((fromFile.length + fromEnv.length) === 0 && preferAustin);
  const tflEnabled = String(process.env.CCTV_TFL_ENABLED || '1').trim() !== '0';

  let fromAustin = [];
  let fromCaltrans = [];
  let fromTfl = [];
  if (needsLiveSources) {
    const [austinResult, caltransResult, tflResult] = await Promise.allSettled([
      loadAustinSourcesFromOpenData(),
      loadCaltransSourcesFromOpenData(),
      tflEnabled ? loadTflSourcesFromOpenData() : Promise.resolve([]),
    ]);
    fromAustin = austinResult.status === 'fulfilled' ? austinResult.value : [];
    fromCaltrans = caltransResult.status === 'fulfilled' ? caltransResult.value : [];
    fromTfl = tflResult.status === 'fulfilled' ? tflResult.value : [];
  }
  // Live sources first so file/env overrides win on duplicate IDs (Map last-write).
  const merged = [...fromAustin, ...fromCaltrans, ...fromTfl, ...fromFile, ...fromEnv];

  // Deduplicate by camera ID (last-write wins because of Map.set)
  const byId = new Map();
  for (const item of merged) {
    if (!item || typeof item !== 'object') continue;
    const normalized = normalizeSourceItem(item);
    if (!normalized.id) continue;
    byId.set(normalized.id, normalized);
  }

  const mergedSources = Array.from(byId.values());
  const maxRaw = Number(process.env.CCTV_MAX_SOURCES || DEFAULT_CCTV_MAX_SOURCES);
  const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(1200, Math.floor(maxRaw))) : DEFAULT_CCTV_MAX_SOURCES;
  if (mergedSources.length > maxCount) {
    console.warn(`[CCTV] source catalog ${mergedSources.length} exceeds cap ${maxCount}; keeping the first ${maxCount} (raise CCTV_MAX_SOURCES or lower a per-pack cap to change which).`);
  }
  const capped = mergedSources.length > maxCount ? mergedSources.slice(0, maxCount) : mergedSources;
  if (capped.length > 0 || _cctvSourceCache.length === 0) {
    _cctvSourceCache = capped;
  } else {
    // Every source came back empty (all live packs timed out / upstream outage)
    // but a good catalog is already cached — serve it stale rather than blanking
    // every CCTV route. Advancing the timestamp waits one TTL before retrying,
    // which (with single-flight) bounds load on a persistently-down upstream.
    console.warn(`[CCTV] source refresh returned empty; serving ${_cctvSourceCache.length} stale cameras`);
  }
  _cctvSourceCacheAt = Date.now();
  return _cctvSourceCache;
}

/**
 * Generate a synthetic SVG billboard image for a CCTV camera placeholder.
 *
 * Produces a 960x540 SVG with a deterministic gradient (hue derived from
 * camera ID hash), scanline overlay, HUD-style grid, and text labels
 * showing camera name, city, ID, status, and current timestamp. Used
 * when no upstream image or Street View fallback is available.
 *
 * @param {object} opts
 * @param {string} opts.cameraId
 * @param {string} opts.label
 * @param {string} [opts.city]
 * @param {string} [opts.status]
 * @returns {string} SVG markup string.
 */
function buildSyntheticCctvSvg({ cameraId, label, city, status }) {
  const seed = hashSeed(`${cameraId}:${label}:${city}`);
  const hue = seed % 360;
  const hue2 = (hue + 46) % 360;
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').replace('Z', 'Z').slice(0, 20);
  const safeLabel = escapeXml(label);
  const safeCity = escapeXml(city || 'GLOBAL GRID');
  const safeId = escapeXml(cameraId);
  const safeStatus = escapeXml(status || 'SYNTHETIC');

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 35%, 10%)" />
      <stop offset="60%" stop-color="hsl(${hue2}, 42%, 6%)" />
      <stop offset="100%" stop-color="#020509" />
    </linearGradient>
    <radialGradient id="flare" cx="0.22" cy="0.24" r="0.78">
      <stop offset="0%" stop-color="hsla(${hue2}, 100%, 65%, 0.35)" />
      <stop offset="100%" stop-color="hsla(${hue2}, 100%, 40%, 0)" />
    </radialGradient>
    <pattern id="scan" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="transparent" />
      <rect y="0" width="8" height="1" fill="rgba(255,255,255,0.08)" />
      <rect y="4" width="8" height="1" fill="rgba(255,255,255,0.05)" />
    </pattern>
  </defs>
  <rect width="960" height="540" fill="url(#bg)" />
  <rect width="960" height="540" fill="url(#flare)" />
  <rect width="960" height="540" fill="url(#scan)" />
  <g stroke="rgba(123,233,255,0.25)" stroke-width="1" fill="none">
    <path d="M60 460 Q300 300 520 420 T900 320" />
    <path d="M100 160 Q340 40 620 130 T920 90" />
    <path d="M20 280 Q220 230 390 270 T760 250" />
  </g>
  <g fill="none" stroke="rgba(180,248,255,0.2)" stroke-width="1">
    <rect x="70" y="80" width="820" height="380" rx="8" />
    <line x1="70" y1="270" x2="890" y2="270" />
    <line x1="480" y1="80" x2="480" y2="460" />
  </g>
  <g fill="#9cefff" font-family="JetBrains Mono, monospace" text-transform="uppercase">
    <text x="74" y="54" font-size="16" letter-spacing="2">CCTV FEED PLACEHOLDER</text>
    <text x="74" y="512" font-size="14" letter-spacing="1.5">${safeLabel} · ${safeCity}</text>
    <text x="646" y="512" font-size="13" letter-spacing="1.2">${safeId}</text>
    <text x="704" y="54" font-size="15" letter-spacing="2">${escapeXml(ts)}</text>
    <text x="74" y="486" font-size="13" letter-spacing="1.3">${safeStatus}</text>
  </g>
</svg>`.trim();
}

/**
 * Coerce a fetch() response body to a Node.js Readable stream.
 *
 * Handles both Node-native streams (.pipe) and web ReadableStreams (.getReader).
 *
 * @param {ReadableStream|NodeJS.ReadableStream|null} body
 * @returns {import('stream').Readable|null}
 */
function toReadable(body) {
  if (!body) return null;
  if (typeof body.pipe === 'function') return body;
  if (typeof body.getReader === 'function') {
    return Readable.fromWeb(body);
  }
  return null;
}

/**
 * Pipe an upstream fetch Response (image or video) to the client HTTP response.
 *
 * Forwards Content-Type, Content-Length, Content-Range, Accept-Ranges, and
 * Cache-Control headers from the upstream. Falls back to buffered arrayBuffer
 * if the body is not streamable.
 *
 * @param {import('http').ServerResponse} res
 * @param {Response} upstream - fetch() Response object.
 * @param {object} [opts]
 * @param {string} [opts.sourceHeader='upstream'] - Value for X-CCTV-Source header.
 */
/**
 * Read a fetch Response body as text while enforcing a hard byte cap during
 * the read — so a malicious or buggy upstream that streams an unbounded body
 * (no/oversized Content-Length, chunked) can't OOM the proxy. Returns
 * { tooLarge, text }. Cancels the stream as soon as the cap is crossed.
 * @param {Response} upstream - fetch() response.
 * @param {number} maxBytes - hard ceiling on decoded bytes.
 * @returns {Promise<{tooLarge: boolean, text: string}>}
 */
async function readCappedResponseText(upstream, maxBytes) {
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await upstream.body?.cancel(); } catch { /* no-op */ }
    return { tooLarge: true, text: '' };
  }
  if (!upstream.body || typeof upstream.body[Symbol.asyncIterator] !== 'function') {
    const text = await upstream.text();
    return text.length > maxBytes ? { tooLarge: true, text: '' } : { tooLarge: false, text };
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for await (const chunk of upstream.body) {
    total += chunk.length;
    if (total > maxBytes) {
      try { await upstream.body.cancel(); } catch { /* no-op */ }
      return { tooLarge: true, text: '' };
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return { tooLarge: false, text };
}

async function proxyMediaResponse(res, upstream, { sourceHeader = 'upstream' } = {}) {
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const cacheControl = upstream.headers.get('cache-control') || 'no-store';
  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  const acceptRanges = upstream.headers.get('accept-ranges');
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'X-CCTV-Source': sourceHeader,
  };
  if (contentLength) headers['Content-Length'] = contentLength;
  if (contentRange) headers['Content-Range'] = contentRange;
  if (acceptRanges) headers['Accept-Ranges'] = acceptRanges;

  // Cheap defense: reject an upstream that DECLARES an oversized fixed body.
  // Live MJPEG/HLS streams are unbounded by design and send no content-length,
  // so they pipe normally (piping streams to the client, never buffering).
  const MEDIA_DECLARED_CAP_BYTES = 64 * 1024 * 1024;
  if (Number.isFinite(Number(contentLength)) && Number(contentLength) > MEDIA_DECLARED_CAP_BYTES) {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Upstream media exceeds size cap' }));
    try { await upstream.body?.cancel(); } catch { /* no-op */ }
    return;
  }

  res.writeHead(upstream.status, headers);

  const stream = toReadable(upstream.body);
  if (!stream) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
    return;
  }

  stream.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  stream.pipe(res);
}

/**
 * Fetch one upstream CCTV image within the frame-refresh budget.
 *
 * A timeout is treated like every other upstream miss so the caller can
 * continue through the Street View and synthetic fallback chain. `fetchImpl`
 * and `timeoutMs` are injectable only to keep the timeout contract unit-testable.
 *
 * @param {string} url - Server-registered upstream image URL.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl=fetch] - Fetch implementation.
 * @param {number} [options.timeoutMs=CCTV_FRAME_FETCH_TIMEOUT_MS] - Abort timeout.
 * @returns {Promise<{ok:true,body:Buffer,contentType:string}|null>}
 */
export async function fetchCctvImageFromUpstream(url, {
  fetchImpl = fetch,
  timeoutMs = CCTV_FRAME_FETCH_TIMEOUT_MS,
} = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('CCTV upstream frame fetch timed out', 'TimeoutError'));
  }, timeoutMs);
  try {
    const upstream = await fetchImpl(url, {
      headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
      signal: controller.signal,
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !contentType.startsWith('image/')) return null;
    return {
      ok: true,
      body: Buffer.from(await upstream.arrayBuffer()),
      contentType,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Vite plugin: CCTV camera proxy with source registry, frame/media serving,
 * fallback chain (upstream -> Street View -> synthetic SVG), and health tracking.
 *
 * Endpoints:
 *   GET /api/cctv/sources        — list all registered camera sources
 *   GET /api/cctv/health         — per-camera health/status report
 *   GET /api/cctv/stream/:id     — stream info (feedType, URLs) for a camera
 *   GET /api/cctv/media/:id      — proxy live video/image media from upstream
 *   GET /api/cctv/frame/:id      — single frame with fallback chain
 *
 * @returns {import('vite').Plugin}
 */
function cctvProxy() {
  /** @type {Map<string,{id:string,status:string,sourceKind:string,label:string,message:string,updatedAt:number}>} */
  const health = new Map();
  /** Cap on health map entries to prevent unbounded growth. Sized to cover the
   * full served catalog (CCTV_MAX_SOURCES hard-bounds at 1200) so health/status
   * observability isn't silently evicted for a default 800-camera catalog. */
  const HEALTH_MAX_ENTRIES = 1200;

  /** Update the health entry for a camera, evicting the oldest entry if at capacity. */
  const setHealth = (cameraId, patch) => {
    // Evict oldest entries if the health map grows beyond the cap
    if (!health.has(cameraId) && health.size >= HEALTH_MAX_ENTRIES) {
      const oldest = health.keys().next().value;
      health.delete(oldest);
    }
    const prev = health.get(cameraId) || {};
    health.set(cameraId, {
      id: cameraId,
      status: patch.status || prev.status || 'unknown',
      sourceKind: patch.sourceKind || prev.sourceKind || 'unknown',
      label: patch.label || prev.label || '',
      message: patch.message || prev.message || '',
      updatedAt: Date.now(),
    });
  };

  /** Snapshot all camera health entries as an array. */
  const listHealth = () => Array.from(health.values());

  /** Build a JSON payload describing stream info (feedType, URLs) for a camera. */
  const buildStreamPayload = (source, cameraId) => {
    const feedType = normalizeFeedType(source?.feedType || 'image');
    return {
      id: cameraId,
      feedType,
      mediaUrl: isVideoFeedType(feedType)
        ? `/api/cctv/media/${encodeURIComponent(cameraId)}`
        : null,
      frameUrl: `/api/cctv/frame/${encodeURIComponent(cameraId)}`,
      provider: source?.provider || '',
      sourceKind: source?.sourceKind || (source?.url ? 'configured' : 'fallback'),
    };
  };

  /** Fetch a Google Street View static image as a fallback frame. Requires GOOGLE_MAPS_API_KEY. */
  const streetViewFallback = async ({ lat, lon, heading, fov, pitch }) => {
    const streetViewKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!streetViewKey || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    try {
      const sv = new URL('https://maps.googleapis.com/maps/api/streetview');
      sv.searchParams.set('size', '960x540');
      sv.searchParams.set('location', `${lat},${lon}`);
      sv.searchParams.set('heading', String(Number.isFinite(heading) ? heading : 0));
      sv.searchParams.set('fov', String(Number.isFinite(fov) ? Math.max(20, Math.min(120, fov)) : 80));
      sv.searchParams.set('pitch', String(Number.isFinite(pitch) ? Math.max(-40, Math.min(20, pitch)) : 0));
      sv.searchParams.set('source', 'outdoor');
      sv.searchParams.set('return_error_code', 'true');
      sv.searchParams.set('key', streetViewKey);

      const svResp = await fetch(sv.toString(), {
        headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
        signal: AbortSignal.timeout(CCTV_FRAME_FETCH_TIMEOUT_MS),
      });
      const svType = svResp.headers.get('content-type') || '';
      if (!svResp.ok || !svType.startsWith('image/')) return null;

      return {
        ok: true,
        body: Buffer.from(await svResp.arrayBuffer()),
        contentType: svType,
      };
    } catch {
      return null;
    }
  };

  return {
    name: 'cctv-proxy',
    configureServer(server) {
      server.middlewares.use('/api/cctv', async (req, res) => {
        try {
          const sources = await getCctvSources();
          const sourceById = new Map(sources.map((source) => [source.id, source]));
          const url = new URL(req.url || '/', 'http://localhost');

          if (url.pathname === '/sources') {
            const body = {
              sources: sources.map((source) => ({
                id: source.id,
                name: source.name,
                city: source.city,
                cityId: source.cityId,
                provider: source.provider,
                lat: source.lat,
                lon: source.lon,
                headingDeg: source.headingDeg,
                headingConfidence: source.headingConfidence || '',
                pitchDeg: source.pitchDeg,
                fovDeg: source.fovDeg,
                rangeM: source.rangeM,
                mountHeightM: source.mountHeightM,
                groundElevationM: source.groundElevationM,
                feedType: normalizeFeedType(source.feedType),
                sourceKind: source.sourceKind || (source.url ? 'configured' : 'fallback'),
                poseSource: source.poseSource,
                license: source.license,
              })),
            };
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
            return;
          }

          if (url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ cameras: listHealth() }));
            return;
          }

          if (url.pathname.startsWith('/stream/')) {
            const cameraId = decodeURIComponent(url.pathname.replace('/stream/', '').trim()) || 'camera';
            const source = sourceById.get(cameraId);
            const payload = buildStreamPayload(source, cameraId);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(payload));
            return;
          }

          if (url.pathname.startsWith('/media/')) {
            const cameraId = decodeURIComponent(url.pathname.replace('/media/', '').trim()) || 'camera';
            const source = sourceById.get(cameraId);
            const mediaUrl = source?.url || '';
            const feedType = normalizeFeedType(source?.feedType || 'image');

            if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'fallback',
                label: source?.provider || 'No upstream URL',
                message: 'No stream URL configured',
              });
              res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify({ error: 'No media URL configured for this camera' }));
              return;
            }

            try {
              const upstreamHeaders = { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' };
              const requestRange = req.headers?.range;
              if (requestRange) upstreamHeaders.Range = requestRange;
              const upstream = await fetch(mediaUrl, {
                headers: upstreamHeaders,
              });
              const contentType = upstream.headers.get('content-type') || '';
              if (!upstream.ok) {
                setHealth(cameraId, {
                  status: 'degraded',
                  sourceKind: 'upstream',
                  label: source?.provider || 'Configured source',
                  message: `Upstream HTTP ${upstream.status}`,
                });
                res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify({ error: `Upstream returned ${upstream.status}` }));
                return;
              }

              if (isVideoFeedType(feedType) && !(contentType.startsWith('video/') || contentType.includes('mpegurl'))) {
                setHealth(cameraId, {
                  status: 'degraded',
                  sourceKind: 'upstream',
                  label: source?.provider || 'Configured source',
                  message: `Unexpected media type ${contentType || 'unknown'}`,
                });
              } else {
                setHealth(cameraId, {
                  status: 'ok',
                  sourceKind: isVideoFeedType(feedType) ? 'live' : 'snapshot',
                  label: source?.provider || 'Configured source',
                  message: isVideoFeedType(feedType) ? 'Live stream connected' : 'Snapshot feed connected',
                });
              }

              await proxyMediaResponse(res, upstream, {
                sourceHeader: isVideoFeedType(feedType) ? 'live-media' : 'upstream-image',
              });
              return;
            } catch (error) {
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'upstream',
                label: source?.provider || 'Configured source',
                message: error?.message || 'Media fetch failed',
              });
              res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify({ error: 'Media proxy failed' }));
              return;
            }
          }

          if (!url.pathname.startsWith('/frame/')) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
            return;
          }

          const cameraId = decodeURIComponent(url.pathname.replace('/frame/', '').trim()) || 'camera';
          const source = sourceById.get(cameraId);
          const label = url.searchParams.get('label') || source?.name || cameraId;
          const city = url.searchParams.get('city') || source?.city || '';
          const lat = Number(url.searchParams.get('lat') || source?.lat);
          const lon = Number(url.searchParams.get('lon') || source?.lon);
          const heading = Number(url.searchParams.get('heading') || source?.headingDeg);
          const fov = Number(url.searchParams.get('fov') || source?.fovDeg);
          const pitch = Number(url.searchParams.get('pitch') || source?.pitchDeg);

          // Only use server-registered upstream URLs — never accept client-supplied URLs
          // (prevents SSRF via ?upstream= query parameter)
          const upstreamCandidate =
            source?.snapshotUrl
            || (!isVideoFeedType(normalizeFeedType(source?.feedType)) ? source?.url : '');

          const upstreamImage = await fetchCctvImageFromUpstream(upstreamCandidate);
          if (upstreamImage?.ok) {
            setHealth(cameraId, {
              status: 'ok',
              sourceKind: 'snapshot',
              label: source?.provider || 'Configured source',
              message: 'Upstream snapshot active',
            });
            res.writeHead(200, {
              'Content-Type': upstreamImage.contentType,
              'Cache-Control': 'no-store',
              'X-CCTV-Source': 'upstream-image',
            });
            res.end(upstreamImage.body);
            return;
          }

          const sv = await streetViewFallback({ lat, lon, heading, fov, pitch });
          if (sv?.ok) {
            setHealth(cameraId, {
              status: 'degraded',
              sourceKind: 'streetview',
              label: 'Google Street View',
              message: 'Fallback Street View frame',
            });
            res.writeHead(200, {
              'Content-Type': sv.contentType,
              'Cache-Control': 'no-store',
              'X-CCTV-Source': 'streetview',
            });
            res.end(sv.body);
            return;
          }

          const svg = buildSyntheticCctvSvg({
            cameraId,
            label,
            city,
            status: source?.url ? 'UPSTREAM UNAVAILABLE' : 'NO UPSTREAM CONFIGURED',
          });

          setHealth(cameraId, {
            status: 'degraded',
            sourceKind: 'synthetic',
            label: source?.provider || 'Synthetic fallback',
            message: source?.url ? 'Upstream unavailable' : 'No source configured',
          });

          res.writeHead(200, {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store',
            'X-CCTV-Source': 'synthetic',
          });
          res.end(svg);
        } catch (error) {
          console.error('[CCTV Proxy]', error?.message || String(error));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CCTV proxy error' }));
        }
      });
    },
  };
}

/**
 * Vite plugin: adsb.lol military aircraft proxy with 12 s response cache.
 *
 * Proxies GET /api/adsblol/mil to https://api.adsb.lol/v2/mil. On upstream
 * failure, serves a stale cached response if one exists.
 *
 * @returns {import('vite').Plugin}
 */
function adsbLolProxy() {
  /** @type {string|null} Cached upstream JSON body. */
  let _cache = null;
  /** @type {number} Epoch-ms when the cache was populated. */
  let _cacheAt = 0;
  /** Response cache TTL (ms). */
  const CACHE_MS = 12000;
  return {
    name: 'adsblol-proxy',
    configureServer(server) {
      server.middlewares.use('/api/adsblol/mil', async (req, res) => {
        try {
          const now = Date.now();
          if (_cache && now - _cacheAt < CACHE_MS) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-ADS-B-Cache': 'HIT' });
            res.end(_cache);
            return;
          }
          const upstream = await fetch('https://api.adsb.lol/v2/mil', {
            headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
          });
          const body = await upstream.text();
          if (upstream.ok) {
            _cache = body;
            _cacheAt = now;
          }
          res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-ADS-B-Cache': 'MISS' });
          res.end(body);
        } catch (e) {
          console.error('[adsb.lol Proxy]', e.message);
          if (_cache) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-ADS-B-Cache': 'STALE' });
            res.end(_cache);
            return;
          }
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'ADS-B proxy error' }));
        }
      });
    },
  };
}

/**
 * Vite plugin: AISStream live vessel cache.
 *
 * AISStream does not support browser CORS and requires a private API key, so
 * the Vite server keeps one backend websocket open and exposes a same-origin
 * JSON snapshot to the Cesium layer.
 */
function aisLiveProxy() {
  function install(middlewares) {
    middlewares.use('/api/ais-live', async (req, res) => {
      try {
        ensureAisStreamConnection();
        const incoming = new URL(req.url || '', 'http://localhost');

        // Track sub-route MUST be handled before the rows snapshot — this
        // mount prefix-matches every subpath, so without this branch
        // /api/ais-live/track would be silently answered with vessel rows.
        if (incoming.pathname === '/track' || incoming.pathname.startsWith('/track/')) {
          const mmsi = String(incoming.searchParams.get('mmsi') || '').trim();
          res.statusCode = /^\d{5,10}$/.test(mmsi) ? 200 : 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          if (res.statusCode !== 200) {
            res.end(JSON.stringify({ error: 'mmsi query param required', samples: [] }));
            return;
          }
          res.end(JSON.stringify({
            mmsi,
            samples: readAisTrack(mmsi),
            source: 'AISStream (accumulated since server start)',
            retainedSec: Math.floor(AISSTREAM_STALE_MS / 1000),
          }));
          return;
        }

        const maxRows = clampInt(incoming.searchParams.get('maxRows'), 1, AISSTREAM_CACHE_MAX, AISSTREAM_CACHE_MAX);
        const rows = aisStreamRows(maxRows);

        const feed = aisStreamStatusSnapshot();

        res.statusCode = process.env.AISSTREAM_API_KEY ? 200 : 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({
          rows,
          source: 'AISStream',
          status: feed.status,
          error: feed.error,
          refreshing: feed.status !== 'live',
          newestPositionAt: newestAisPositionAt(rows),
          lastMessageAt: feed.lastMessageAt,
          // Honest-failure metadata: how long the feed has been quiet, which
          // recovery attempt we are on, and when the next one lands.
          silentForMs: feed.silentForMs,
          reconnectAttempt: feed.reconnectAttempt,
          nextAttemptAt: feed.nextAttemptAt,
          staleAfterMs: feed.staleAfterMs,
          watchdog: feed.watchdog,
        }));
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ error: error?.message || 'AIS live stream error', rows: [] }));
      }
    });
  }

  return {
    name: 'ais-live-proxy',
    configureServer(server) {
      install(server.middlewares);
      startAisStreamWatchdogTick();
      // Vite restarts the server in-process on a config change while this
      // module's state survives; without teardown each reload stacks another
      // interval and another socket.
      server.httpServer?.on('close', disposeAisStream);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
      startAisStreamWatchdogTick();
      server.httpServer?.on('close', disposeAisStream);
    },
    // Middleware-mode backstop: there is no httpServer to hang 'close' on.
    closeBundle() {
      disposeAisStream();
    },
  };
}

/**
 * Vite plugin: aircraft track-history backfill proxies (PRD WS-F F1/F2).
 *
 * /api/opensky-track?icao24=<hex6> — OpenSky GET /tracks/all (experimental;
 *   own credit bucket, 4 credits per call on the free tier). OAuth via the
 *   shared coalesced token. 60s per-icao cache; 404/429 forwarded so the
 *   client can fall back to its accumulated trail silently.
 * /api/adsblol/trace?hex=<hex> — adsb.lol tar1090 readsb trace
 *   (undocumented but live; no browser CORS, hence this proxy). Up to ~24h
 *   of real history per aircraft. Treat as best-effort; data is ODbL —
 *   credit "adsb.lol (ODbL)" in the UI.
 */
function trackBackfillProxies() {
  const TRACK_CACHE_MS = 60000;
  const TRACK_CACHE_MAX = 200;
  const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
  /** @type {Map<string, {at:number,status:number,body:string}>} */
  const cache = new Map();

  function cachePut(key, entry) {
    cache.set(key, entry);
    if (cache.size > TRACK_CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
  }

  async function proxyJson(res, key, upstreamUrl, headers = {}) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
      res.statusCode = cached.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(cached.body);
      return;
    }
    const upstream = await fetch(upstreamUrl, { headers, signal: AbortSignal.timeout(12000) });
    const { tooLarge, text } = await readCappedResponseText(upstream, RESPONSE_CAP_BYTES);
    let body;
    if (tooLarge) {
      body = JSON.stringify({ error: 'Upstream track response too large' });
    } else if (!upstream.ok) {
      // Sanitize upstream error surface; status code is signal enough
      body = JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
    } else {
      body = text;
    }
    cachePut(key, { at: Date.now(), status: upstream.status, body });
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  }

  function install(middlewares) {
    middlewares.use('/api/opensky-track', async (req, res) => {
      try {
        const incoming = new URL(req.url || '', 'http://localhost');
        const icao24 = String(incoming.searchParams.get('icao24') || '').trim().toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(icao24)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'icao24 must be a 6-char hex string' }));
          return;
        }
        const token = await getOpenSkyToken();
        await proxyJson(
          res,
          `osky:${icao24}`,
          `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
          token ? { Authorization: `Bearer ${token}` } : {}
        );
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'OpenSky track fetch failed' }));
      }
    });

    middlewares.use('/api/adsblol/trace', async (req, res) => {
      try {
        const incoming = new URL(req.url || '', 'http://localhost');
        const hex = String(incoming.searchParams.get('hex') || '').trim().toLowerCase();
        if (!/^[0-9a-f~]{6,7}$/.test(hex)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'hex must be a 6-7 char hex string' }));
          return;
        }
        await proxyJson(
          res,
          `lol:${hex}`,
          `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`
        );
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'adsb.lol trace fetch failed' }));
      }
    });
  }

  return {
    name: 'track-backfill-proxies',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

/**
 * Vite plugin: OpenAI Realtime ephemeral client secret.
 *
 * Keeps OPENAI_API_KEY server-side while the browser connects to the
 * Realtime API over WebRTC with a short-lived secret.
 */
function openAiRealtimeProxy() {
  function install(middlewares) {
    middlewares.use('/api/openai/hud-summary', async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      // Opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). No-op when unset.
      if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'OPENAI_API_KEY is not set' }));
        return;
      }

      try {
        const body = await readRequestBody(req, 64 * 1024);
        const context = JSON.parse(body || '{}');
        const response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: process.env.OPENAI_HUD_SUMMARY_MODEL || OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
            instructions: [
              "Write one concise intelligence-HUD summary for God's Eye View.",
              'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
              'Prefer the clearest named place and include a relevant enabled layer only when useful.',
              'Do not infer from coordinates or invent a place.',
              'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
            ].join(' '),
            input: JSON.stringify(context),
            reasoning: { effort: 'minimal' },
            max_output_tokens: 100,
          }),
        });
        const data = await response.json().catch(() => ({}));
        const summary = toFiveWordHudSummary(extractOpenAiResponseText(data));
        res.statusCode = response.ok && summary ? 200 : response.status || 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({
          summary: summary || null,
          error: response.ok ? null : data.error?.message || 'OpenAI HUD summary request failed',
        }));
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'OpenAI HUD summary request failed' }));
      }
    });

    middlewares.use('/api/realtime/debug-log', async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      try {
        const body = await readRequestBody(req, REALTIME_DEBUG_LOG_MAX_BYTES);
        const record = JSON.parse(body || '{}');
        fs.mkdirSync(REALTIME_DEBUG_LOG_DIR, { recursive: true });
        fs.appendFileSync(REALTIME_DEBUG_LOG_FILE, `${JSON.stringify({
          loggedAt: new Date().toISOString(),
          ...record,
        })}\n`);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Failed to write Realtime debug log' }));
      }
    });

    middlewares.use('/api/realtime/token', async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      // Opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). No-op when unset.
      if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'OPENAI_API_KEY is not set' }));
        return;
      }

      // Voice model tier, requested by the client as ?tier=standard|mini.
      // resolveVoiceModel is total: an unknown, empty, or hostile value
      // resolves to `standard` instead of reaching OpenAI as a model id, so a
      // bad querystring degrades to a normal session rather than a dead mic.
      // The env overrides stay authoritative per tier (see .env.example) —
      // a wrong upstream model id is then a config fix, not a code change.
      const requestedTier = (() => {
        try {
          return new URL(req.url || '', 'http://localhost').searchParams.get('tier');
        } catch {
          return null;
        }
      })();
      const tier = resolveVoiceModel(requestedTier).tier;
      const model =
        tier === 'mini'
          ? process.env.OPENAI_REALTIME_MODEL_MINI || OPENAI_REALTIME_MODEL_MINI_DEFAULT
          : process.env.OPENAI_REALTIME_MODEL || OPENAI_REALTIME_MODEL_DEFAULT;
      const voice = process.env.OPENAI_REALTIME_VOICE || OPENAI_REALTIME_VOICE_DEFAULT;
      const effort = process.env.OPENAI_REALTIME_REASONING_EFFORT || OPENAI_REALTIME_REASONING_DEFAULT;
      const contextTokenLimit = Math.round(Math.max(
        1000,
        Math.min(12000, Number(process.env.OPENAI_REALTIME_CONTEXT_TOKENS) || OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT)
      ));
      const contextRetentionRatio = Math.max(
        0.1,
        Math.min(1, Number(process.env.OPENAI_REALTIME_CONTEXT_RETENTION) || OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT)
      );
      const sessionConfig = {
        session: {
          type: 'realtime',
          model,
          reasoning: { effort },
          truncation: {
            type: 'retention_ratio',
            retention_ratio: contextRetentionRatio,
            token_limits: {
              post_instructions: contextTokenLimit,
            },
          },
          audio: {
            input: {
              noise_reduction: { type: 'near_field' },
              turn_detection: {
                type: 'semantic_vad',
                eagerness: 'low',
                create_response: true,
                interrupt_response: false,
              },
            },
            output: { voice },
          },
          instructions: [
            "You are GEV Voice Control, a concise voice controller for a Cesium geospatial app called God's Eye View.",
            'Have a natural spoken conversation with the user while the mic session is active.',
            'Do not require a wake phrase. Treat direct commands like "zoom into London" or "open datacenters" as GEV control requests.',
            'Only control the app by calling the provided tools. Never invent tool names or arguments.',
            'Call tools only for clear GEV control, navigation, visual-style, layer, or app-state requests. For ordinary conversation, answer normally without tools.',
            'For requests to open, show, reveal, or focus a menu/panel, call set_panel_open or show_data_layers_menu. "Open Context" means only set_panel_open{panelId:"global-context-panel",open:true}; it does not activate a Context sub-mode. "Open Contacts" means set_context_mode{mode:"contacts"}; that action expands the parent Context panel before activating Contacts.',
            'For requests like "show me the datacenter layers", open the data layers menu and focus the matching layer row; do not enable the layer unless the user asks to turn it on.',
            'For questions like "what am I looking at?", "what is in view?", "what is this?", "that selected thing", nearby datacenter, dam, cable, ship, or current view contents, call get_entity_context first, then answer from the returned scene/entity context.',
            'For "what is this aircraft?" answers, read the callsign, operator, registration, type, and route only from get_entity_context selected.properties. Treat route, routeOrigin, and routeDestination as the only authoritative route fields. Every aircraft identity answer MUST explicitly cover operator, type, and route. When a route is present, repeat its endpoint codes exactly; do not expand airport codes into city names. For a missing field say exactly "Operator details are unavailable", "Aircraft type is unavailable", or "Route details are unavailable" as applicable. Never silently omit missing enrichment or infer it from the callsign.',
            'While a camera motion or route flight is active, a bare "stop" means move_camera{motion:stop} — NOT control_scene and NOT stop_tracking (those need explicit words like "stop the scene" / "stop tracking"). If move_camera stop returns stopped:false and an entity is being tracked, call stop_tracking next — the user means "stop whatever is moving". Flying somewhere while tracking automatically stops the tracking (the result says so): mention it briefly.',
            'For camera-motion requests — "orbit around this", "pan left", "tilt up", "stop moving" — call move_camera. For "fly the route" over a drawn route, call fly_route. Confirm with the RESULTING state ("Orbiting slowly", "Flying the route").',
            'analyst_query ANSWERS questions; it never moves the camera or starts tracking. For requests to FOLLOW or TRACK a specific aircraft/ship, call track_entity (get_entity_context first when the target is ambiguous), never analyst_query as the final or only action. For "follow/track the nearest aircraft", first call analyst_query with the aircraft layer(s), sortBy=distance, and limit=1, then call track_entity with the returned aircraft identity in the same turn. The lookup alone does not fulfill a follow/track command.',
            'For a request to enable an aircraft layer and SELECT or FIND the nearest/closest aircraft near a named place — for example, "Turn on flights and select the closest aircraft to Austin" — call select_nearest_aircraft once. It atomically turns on the requested aircraft layer first, waits for location arrival, refreshes that layer for the destination viewport, filters out landed/on-ground records, and selects the nearest airborne result. A healthy fallback feed is valid data: report the returned feed source briefly, never call it an enable failure. Do not also call fly_to_location, set_layer_visibility, analyst_query, track_entity, set_context_mode, or control_cockpit for the same request. SELECT/FIND never implies Contacts or Cockpit unless the user explicitly asks for either mode.',
            'For ANALYTICAL questions about layer data — how many / which / fastest / highest / biggest / nearest flights, ships, fires, or earthquakes ("how many flights over Texas", "biggest fire near LA", "which ships are headed to Oakland", "anything above 40,000 feet") — call analyst_query, not get_entity_context. Narrate the count plus two or three notable examples by name, and reflect the result\'s coverage note honestly: the answer covers data loaded by enabled layers, not the whole world. If the needed layer is disabled, say so and offer to enable it. For follow-ups about the same set ("which of THOSE is closest?"), call analyst_query with followUp=true and only the new filter/sort.',
            'COUNTING CONTRACT — what "near" means. (1) While Contacts is ACTIVE, "near / nearby / how many aircraft" means the Contacts window: answer from contactsWindow in the tool result — those are the exact numbers on the user\'s panel. set_context_mode, analyst_query, and get_current_view_state carry it after Contacts settles. For "Open Contacts and tell me how many aircraft are within 250 km", call set_context_mode{mode:"contacts"} first and answer from contactsWindow.aircraft; do not answer from a pre-Contacts analyst query. analyst_query\'s own count measures currently-loaded records and is usually lower; never give it as the window count. CENTER PRECEDENCE for a nearby/how-many ask, in order: an explicit place in the question ("over Texas", "near Austin") always wins and ignores Contacts state; else the CONTACTS SUBJECT when Contacts is active and has one — a selected datacenter, dam, fire, or cable does NOT silently become the center; else an entity the user explicitly names ("around this datacenter"); else the current view, said aloud ("nothing is selected, so this is the current view"). With Contacts active but NO subject yet, use the view and say so; never read an empty panel. (2) With Contacts OFF, "nearby" means in view; "near <place>" means a radius around that place. (3) EVERY count names its scope in words — "42 in your window", "8 in view", "about 30 within 250 km of Austin" — never a bare number; analyst_query returns scopeLabel for exactly this. Two different numbers with named scopes are not a contradiction; say both if asked. (4) State counts VERBATIM — never estimate, round, or hedge ("a few", "less than a dozen"): if a tool returns 46, say 46. (5) When it matters, add once: counts cover loaded data, and the flights layer loads where you look.',
            'While Cockpit is active, navigate with control_cockpit (next/previous, optionally targetLayer or aircraftClass). track_entity and fly_to_location are REFUSED by design while Cockpit owns the camera — that refusal is correct, not an error to retry. To go somewhere else, exit Cockpit first. control_cockpit enter establishes Contacts itself, so do not call set_context_mode before or after it.',
            'When the target layer is unknown, OMIT layerId in track_entity so it searches all enabled layers. Passing the wrong layerId ("flights" for a military contact) returns "Nothing matched" even though the contact is loaded.',
            'If get_entity_context has no selected object or overlay entities, use its basemap context: Google Photorealistic 3D Tiles/Cesium source, center target coordinates, reverse-geocoded place, camera altitude, active style, and enabled layers. Do not say there is nothing unless the basemap target is also unavailable.',
            'If basemap context includes knownLandmarks, prefer the nearest known landmark by name for "what am I looking at" answers. For example, if knownLandmarks includes Eiffel Tower, say Eiffel Tower.',
            'At local zoom, use basemap nearbyPlaces, place.labels, viewportPlaces.visibleLabels, and viewportPlaces.streetLabels to identify the building, premises, roads, and named places visible around the screen target.',
            'If basemap context includes viewportPlaces, prefer dominantCountry, dominantRegion, and dominantLocality over raw coordinates.',
            'When basemap context includes viewportSamples or an inferred country, trust that over a single reverse-geocoded address. If most samples indicate Iran, say Iran, not the United States.',
            'When a viewport screenshot is attached after get_entity_context, read clearly legible street, building, and place labels from it and combine them with structured label context. Respect scene viewScale: at global/continental/regional scale, avoid naming a precise street/city from one center pixel.',
            'Do not mention disabled layers or stale selections.',
            'When a request requires a tool call, do not speak in the same response as the tool call. Call the tool first.',
            'When a single user request contains MULTIPLE changes (e.g. "switch to operator layout, use balanced detection at density 50, and switch to Bing aerial"), call ALL the corresponding tools — multiple tool calls in sequence — before speaking. Never confirm a partial subset. If a later tool fails, say which parts succeeded and which failed.',
            'After receiving tool output, speak exactly one short confirmation. Do not repeat the confirmation.',
            'For "show/open/turn on" layer requests, enable the matching layer. For "hide/close/turn off", disable it.',
            // INSTRUCTION-ONLY mapping for the two globe-scale named views.
            //
            // Both are BROADER than the first-run tiles on purpose. A person
            // naming layers out loud has chosen them; a tile is a first
            // impression handed to a stranger. So voice keeps fires in the
            // environmental view and keeps infrastructure entirely, while the
            // launcher's ENVIRONMENTAL tile is quakes-only and has no
            // infrastructure tile at all. See src/firstRunExperience.js for why.
            //
            // Fully expressible with tools that already exist, so
            // GEV_REALTIME_TOOLS is deliberately untouched — deleting this one
            // string is the whole rollback.
            'NAMED VIEWS are shorthand for tool calls you already have — there is no "mode" tool for them. Treat ONLY these as the shorthand: "infrastructure mode" / "the infrastructure view" / "show me global infrastructure" means three set_layer_visibility calls (local-datacenters, local-dams, telegeography-submarine-cables) plus zoom_to_globe; "environmental mode" / "earth watch" / "active events", said as the name of a view, means set_layer_visibility for local-firms and earthquakes plus zoom_to_globe. Anything vaguer is NOT this shorthand — an open-ended question about the world or the news is an ordinary question: answer it, or use analyst_query over the layers already on. Never switch a whole view on to answer a question nobody asked to see. When you do run one, make every call before speaking, then give one confirmation naming the resulting state; if the fires layer comes back unavailable because no FIRMS key is configured, say so plainly — the earthquakes still loaded. "Live contacts" and "space missions" are NOT this pattern: they stay set_context_mode{mode:"contacts"} and set_context_mode{mode:"space-missions"}.',
            'For visual filter requests, call set_visual_style with one of the allowed style IDs.',
            'Disambiguation table — basemap vs layer vs style: basemap switching requires an explicit stack name — "Bing aerial" means set_map_stack bing-aerial, "aerial with labels" means bing-labels, "OSM"/"road map" means osm, "Google 3D"/"photorealistic" means photoreal. Any mention of "satellite" or "satellites" ALWAYS means the satellites DATA LAYER via set_layer_visibility, never a basemap. "surveillance"/"night vision"/"thermal" are visual STYLES via set_visual_style.',
            'HUD requests ("hud on/off", "switch to operator/minimal/tactical layout") use set_hud. Detection requests ("detection on", "dense mode", "balanced mode", "sparse mode", "set density to 25", "use weighted allocation") use set_detection. Density snaps to 0/25/50/75/100 and derives Sparse/Balanced/Dense; panoptic is a legacy alias for Dense.',
            'Bloom/sharpen requests use set_post_processing. Scene requests ("play orbital watch", "stop the scene", "what scenes are there") use control_scene. CCTV camera requests ("next camera", "nearest camera", "select the Congress camera", "show coverage") use control_cctv — the CCTV layer must be enabled first.',
            'Radio playback requests use control_radio. "Turn on/start the radio" means action=play; action=enable only reveals Radio markers and must be reserved for explicit "show/enable the Radio layer/markers" requests. After a prepared playback result, briefly confirm any other completed actions and say "Turning on the radio"—never claim it is already playing. The client keeps Radio muted until playback is verified, then closes voice before restoring Radio volume. Examples: "play news near Austin" → select category=news locationId=austin; "play US news" → select category=news country=US; "Radio volume 30" → volume; pause/resume/stop/next/previous use the matching action. Radio selection never moves the camera.',
            '"Track/follow <something specific>" (a callsign, ship name, satellite name) uses track_entity. "Take me to the biggest fire" uses track_entity with query "biggest fire" (the fires layer must be enabled). Bare "orbit" means camera orbit of the current landmark. "Stop following/tracking" uses stop_tracking.',
            '"Show me which planes are overhead"/"frame the ships"/"show me the satellites above" use frame_overhead with the matching target.',
            "After frame_overhead, speak ONLY from the tool result's count field — e.g. 'Framed fourteen aircraft, labels on'; never reassess or second-guess the count aloud.",
            'Confirmations echo the RESULTING state, never the request: "HUD operator layout", "Density twenty-five percent", "Bing aerial imagery", "Tracking UAL428", "Framed fourteen aircraft". On ok=false, state the failure plainly: "Nothing matched UAL999", "No ships within 120 kilometers". Never claim an action without ok=true in the tool result.',
            'For destination requests such as "take me to Italy", "go to NYC", or "show me the Eiffel Tower", call fly_to_location. Prefer known city IDs when available; otherwise pass the plain place query.',
            'Navigation-only requests ("take me to X", "go to X", "fly to X") are NOT descriptions: call fly_to_location alone and do NOT also call annotate_map, unless the user explicitly asks to mark the place or you go on to explain specific places there. Never drop a point pin on a region-scale natural feature (a mountain range, desert, sea, or forest) — a single point in the middle of the Rockies is meaningless. If the user explicitly asks to mark such a region, prefer type=area.',
            'For country and city destinations, omit rangeM so GEV frames the whole country or city in view. For landmarks and buildings, omit rangeM so GEV chooses a close landmark view.',
            'Only supply rangeM when the user asks for a particular numeric height, distance, closer view, or wider view.',
            'For relative requests such as "zoom out a little", "pull back", "zoom in more", or "get closer", always call adjust_camera_zoom. But "globe view", "whole earth", "the whole planet", or "zoom all the way out" is an ABSOLUTE framing: call zoom_to_globe once instead — repeated adjust_camera_zoom calls can never reach the globe. Never claim the camera moved without the tool returning ok=true.',
            'Keep spoken confirmations short, e.g. "Opening datacenters" or "Flying to London".',
            'WHITEBOARD THE WORLD: whenever you describe or explain a specific place, building, campus, district, boundary, or a spatial relationship between places, call annotate_map to mark it visually as you talk — like sketching on the map. To call out a specific building, campus, compound, park, or district, use type=area (it traces and encloses the real footprint — a building gets a glowing volume, a district gets a draped outline). Use type=highlight only for a transient pulse on a precise spot that has no meaningful footprint, and type=pin to drop a labeled marker. Examples: "what is the Palace of Fine Arts?" → an AREA on it; "the old military base next to it" → an AREA on the Presidio; "ILM is right here" → a pin; "it sits next to the Marina" → an arrow from one to the other. Prefer place NAMES so the app resolves real positions and outlines; never invent coordinates or pixel locations.',
            'On every annotation, also set entityKind to what the thing IS when you know it: building (one structure), compound (campus/grounds/mall/park), district (neighborhood/area of a city), street (a named road), or point_feature (a monument, statue, memorial, plaque, fountain, or other small point landmark). entityKind is a FACT about the target, independent of the mark type you chose — monuments and statues are point_feature even when you use type=area; the app then anchors them as precise points instead of guessing at a footprint.',
            'Use a single annotate_map call with several annotations when you are describing multiple related places at once. Set flyTo true only when the user is not already looking at the place; if every mark in a call lands off-screen the app auto-frames them, so when unsure leave flyTo false. Do NOT say out loud that you are drawing, highlighting, or annotating — just speak naturally about the places while the marks appear. ANNOTATIONS ACCUMULATE AND PERSIST — keep adding marks as you explore; you can fly around, change topic, and jump between far-apart places and the marks STAY, so the user can build up the map and show people things. Do NOT clear on your own initiative: never pass clearPrevious, and call clear_annotations ONLY when the user EXPLICITLY asks to clear or reset the map.',
            'If an annotate_map result has partial:true or any failedLabels, do not pretend those places appeared — briefly work into your narration that you could not pinpoint them (e.g. "I couldn\'t place X"). If a route comes back as a direct line (no street route was found), describe it as a straight-line distance, not a walking/driving time. If an annotate_map result has capped:true, the map is full — ASK the user whether to clear before drawing more; do not clear unprompted. outlinePending:true is NOT a failure, but it is also NOT an outline: the anchor mark is placed and the boundary is still being traced in the background. Narrate it in progress — e.g. "tracing the boundary now" — and NEVER state the outline is already drawn or visible; it may yet come back as just a point. A later system item of type map_annotation_outline reports the final outcome per mark (status resolved or failed, with its label): use it to quietly confirm, or to correct yourself if you implied a boundary that stayed a point — an honest miss beats a misleading guess.',
            'PREFER NAMES. Only when you cannot name or geocode a place but you can clearly SEE the exact spot in the most recent viewport screenshot, fall back to screenX/screenY (normalized 0..1 from that image) to point at it; the app converts the pixel to a real world point. Never use screenX/screenY for something you could name.',
            'PATHS vs DISTANCES: for "walking/driving route from A to B" (or through several stops), use type=route with the ordered points and the matching mode (walking/driving/cycling) — the app draws the real street-following path on the map and reports distance and travel time, which you can read aloud. For "how far is X from Y", "is it nearby", or "X is next to Y", use type=arrow between the two — it draws a floating connector and shows the straight-line distance. Do NOT use route for a simple distance/proximity question.',
          ].join('\n'),
          tools: GEV_REALTIME_TOOLS,
          tool_choice: 'auto',
        },
      };

      try {
        const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'OpenAI-Safety-Identifier': 'gev-local-dev',
          },
          body: JSON.stringify(sessionConfig),
        });
        const body = await response.text();
        res.statusCode = response.status;
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
        // Which tier/model this secret was actually minted for. The upstream
        // body is passed through untouched (the client parses it verbatim), so
        // these headers are the authoritative echo — including the case where a
        // bogus ?tier= was silently downgraded to standard.
        res.setHeader('X-GEV-Voice-Tier', tier);
        res.setHeader('X-GEV-Voice-Model', model);
        if (requestedTier && !isKnownVoiceTier(requestedTier)) {
          res.setHeader('X-GEV-Voice-Tier-Fallback', '1');
        }
        res.end(body);
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Failed to create Realtime token' }));
      }
    });
  }

  return {
    name: 'openai-realtime-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Vite plugin: nearby Google place labels for Realtime scene context.
 *
 * The Photorealistic 3D Tiles mesh does not expose rendered map labels as
 * Cesium feature metadata. Nearby Search supplies the names around the actual
 * screen-space target without exposing the Google API key in the request.
 */
function googlePlacesContextProxy() {
  function install(middlewares) {
    middlewares.use('/api/google/nearby-places', async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Opt-in per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN). No-op when unset.
      // Inlined (not the shared helper) so the 429 body keeps this endpoint's
      // `places: []` contract that the client expects on every error response.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(clientKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'GOOGLE_MAPS_API_KEY is not set', places: [] }));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const latitude = Number(requestUrl.searchParams.get('lat'));
      const longitude = Number(requestUrl.searchParams.get('lon'));
      const radiusM = Math.max(25, Math.min(5000, Number(requestUrl.searchParams.get('radiusM')) || 250));
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Valid lat and lon are required', places: [] }));
        return;
      }

      try {
        const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': [
              'places.id',
              'places.displayName',
              'places.formattedAddress',
              'places.shortFormattedAddress',
              'places.location',
              'places.primaryType',
              'places.primaryTypeDisplayName',
              'places.types',
            ].join(','),
          },
          body: JSON.stringify({
            maxResultCount: 20,
            rankPreference: 'DISTANCE',
            locationRestriction: {
              circle: {
                center: { latitude, longitude },
                radius: radiusM,
              },
            },
          }),
        });
        const data = await response.json().catch(() => ({}));
        const seenPlaces = new Set();
        const places = Array.isArray(data.places) ? data.places
          .map((place) => {
            const placeLatitude = place.location?.latitude ?? null;
            const placeLongitude = place.location?.longitude ?? null;
            const types = Array.isArray(place.types) ? place.types.slice(0, 8) : [];
            return {
              id: place.id || null,
              name: place.displayName?.text || null,
              address: place.shortFormattedAddress || place.formattedAddress || null,
              latitude: placeLatitude,
              longitude: placeLongitude,
              distanceM: approximateDistanceM(latitude, longitude, placeLatitude, placeLongitude),
              primaryType: place.primaryTypeDisplayName?.text || place.primaryType || null,
              types,
              contextPriority: placeContextPriority(types),
            };
          })
          .filter((place) => {
            const key = `${place.name}:${place.address || ''}`.toLowerCase();
            if (!place.name || seenPlaces.has(key)) return false;
            seenPlaces.add(key);
            return true;
          })
          .sort((a, b) => b.contextPriority - a.contextPriority || a.distanceM - b.distanceM)
          .map(({ contextPriority, ...place }) => place)
          .slice(0, 20) : [];

        res.statusCode = response.ok ? 200 : response.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.end(JSON.stringify({
          places,
          error: response.ok ? null : data.error?.message || 'Google Places request failed',
        }));
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: error?.message || 'Google Places request failed', places: [] }));
      }
    });

    // Text Search: resolve a named landmark/POI to a real coordinate, biased to
    // the view. Geocoding scatters obscure monument/POI names across the city;
    // a view-biased Text Search lands on the actual feature. Same key, field
    // mask, throttle, and `places: []` error contract as nearby-places above.
    middlewares.use('/api/google/text-search', async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Opt-in per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN). No-op when unset.
      // Inlined (like nearby-places) so the 429 body keeps the `places: []`
      // contract the client expects on every error response.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(clientKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'GOOGLE_MAPS_API_KEY is not set', places: [] }));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const textQuery = String(requestUrl.searchParams.get('q') || '').trim();
      const latitude = Number(requestUrl.searchParams.get('lat'));
      const longitude = Number(requestUrl.searchParams.get('lon'));
      const radiusM = Math.max(50, Math.min(50000, Number(requestUrl.searchParams.get('radiusM')) || 4000));
      if (!textQuery || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'q, lat and lon are required', places: [] }));
        return;
      }

      try {
        const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': [
              'places.id',
              'places.displayName',
              'places.formattedAddress',
              'places.location',
              'places.viewport',
              'places.primaryType',
              'places.types',
            ].join(','),
          },
          body: JSON.stringify({
            textQuery,
            locationBias: {
              circle: {
                center: { latitude, longitude },
                radius: radiusM,
              },
            },
            maxResultCount: 5,
          }),
        });
        const data = await response.json().catch(() => ({}));
        const places = Array.isArray(data.places) ? data.places
          .map((place) => {
            const placeLatitude = place.location?.latitude ?? null;
            const placeLongitude = place.location?.longitude ?? null;
            const types = Array.isArray(place.types) ? place.types.slice(0, 8) : [];
            // Places returns a lat/lng bounding box (low/high corners) framing the
            // place — no polygon, but enough to SIZE a fallback grounds disc to the
            // real feature instead of a blind constant. Normalize to plain numbers.
            const vp = place.viewport;
            const viewport = (
              Number.isFinite(vp?.low?.latitude) && Number.isFinite(vp?.low?.longitude)
              && Number.isFinite(vp?.high?.latitude) && Number.isFinite(vp?.high?.longitude)
            ) ? {
              low: { latitude: vp.low.latitude, longitude: vp.low.longitude },
              high: { latitude: vp.high.latitude, longitude: vp.high.longitude },
            } : null;
            return {
              id: place.id || null,
              name: place.displayName?.text || null,
              address: place.formattedAddress || null,
              latitude: placeLatitude,
              longitude: placeLongitude,
              distanceM: approximateDistanceM(latitude, longitude, placeLatitude, placeLongitude),
              primaryType: place.primaryType || null,
              types,
              viewport,
            };
          })
          .filter((place) => place.name) : [];

        res.statusCode = response.ok ? 200 : response.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.end(JSON.stringify({
          places,
          error: response.ok ? null : data.error?.message || 'Google Places request failed',
        }));
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: error?.message || 'Google Places request failed', places: [] }));
      }
    });
  }

  return {
    name: 'google-places-context-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

function placeContextPriority(types) {
  const typeSet = new Set(types);
  if (typeSet.has('historical_landmark') || typeSet.has('monument')) return 100;
  if (typeSet.has('tourist_attraction') || typeSet.has('museum')) return 90;
  if (typeSet.has('premise') || typeSet.has('street_address')) return 75;
  if (typeSet.has('point_of_interest')) return 60;
  if (typeSet.has('public_bathroom')) return 10;
  return 40;
}

function approximateDistanceM(latA, lonA, latB, lonB) {
  if (![latA, lonA, latB, lonB].every(Number.isFinite)) return Number.MAX_SAFE_INTEGER;
  const latitudeScale = 111320;
  const longitudeScale = latitudeScale * Math.cos((latA * Math.PI) / 180);
  return Math.round(Math.hypot(
    (latB - latA) * latitudeScale,
    (lonB - lonA) * longitudeScale
  ));
}

const GEV_REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'fly_to_location',
    description: "Fly the God's Eye View camera to a known city, geocoded country/region/city/landmark, or explicit WGS84 coordinate. Countries/cities frame the whole place; landmarks/buildings use close framing.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: {
          type: 'string',
          enum: ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'],
          description: 'Known city preset ID. Use when the requested place matches one of these cities.',
        },
        query: {
          type: 'string',
          description: 'Plain place search query, e.g. "London", "Eiffel Tower", or "Dubai Marina".',
        },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        viewMode: {
          type: 'string',
          enum: ['close', 'overview'],
          description: 'Optional framing intent. Usually omit this; GEV infers whole-place framing for countries/cities and close framing for landmarks.',
        },
        rangeM: {
          type: 'number',
          minimum: 100,
          maximum: 20000000,
          description: 'Optional camera range from the target in meters. Omit it for automatic whole-country/whole-city or close-landmark framing; provide it only when the user explicitly requests a numeric height or distance.',
        },
        waitForArrival: {
          type: 'boolean',
          description: 'Set true when a later tool depends on the destination viewport. The result then waits for the camera flight and returns arrived=true; cancellation returns ok=false.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'select_nearest_aircraft',
    description: 'Atomically fly to a place, wait for arrival, enable and load Flights or Military Flights in that viewport, exclude on-ground records, and select/follow the nearest airborne aircraft. Healthy fallback feeds remain usable and are reported in the result. This does not open Contacts or Cockpit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: ['flights', 'military'],
          description: 'Aircraft layer to enable and search. Use flights unless the user explicitly asks for military aircraft.',
        },
        locationId: {
          type: 'string',
          enum: ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'],
          description: 'Known city preset ID when the place matches one of these cities.',
        },
        locationQuery: {
          type: 'string',
          maxLength: 160,
          description: 'Free-form destination when no locationId matches.',
        },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
      },
      required: ['layerId'],
    },
  },
  {
    type: 'function',
    name: 'adjust_camera_zoom',
    description: 'Move the current Cesium camera closer to or farther from what it is presently looking at. Use for relative zoom requests without changing location.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        direction: {
          type: 'string',
          enum: ['in', 'out'],
        },
        amount: {
          type: 'string',
          enum: ['little', 'medium', 'lot'],
          description: 'Use little for phrases like "a bit" or "a little", medium for ordinary zoom requests, and lot for "way out/in".',
        },
      },
      required: ['direction', 'amount'],
    },
  },
  {
    type: 'function',
    name: 'zoom_to_globe',
    description: 'Pull the camera out to an ABSOLUTE full-Earth globe view (~18,000 km altitude, the whole planet in frame), keeping the current region centered. Use for "globe view", "whole earth", "see the planet", "zoom all the way out". Never use adjust_camera_zoom for these — its relative steps cannot reach the globe.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'set_layer_visibility',
    description: "Enable or disable one registered God's Eye View data layer.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          description:
            'Common-name mapping for the non-obvious ids: space mission(s) → rocket-launches; fires/wildfires/active fires → local-firms (NASA FIRMS); ships/vessels/boats → ais-live-vessels; undersea/submarine cables → telegeography-submarine-cables; datacenters → local-datacenters; dams → local-dams; bikes/bike share → bikeshare; street traffic/congestion → traffic; traffic cameras → cctv; internet radio/stations → radio.',
          enum: [
            'flights',
            'military',
            'earthquakes',
            'satellites',
            'rocket-launches',
            'traffic',
            'cctv',
            'radio',
            'bikeshare',
            'ais-live-vessels',
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
        },
        enabled: { type: 'boolean' },
      },
      required: ['layerId', 'enabled'],
    },
  },
  {
    type: 'function',
    name: 'show_data_layers_menu',
    description: 'Open the data layers dropdown/menu and optionally scroll to a specific layer row without toggling it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: [
            'flights',
            'military',
            'earthquakes',
            'satellites',
            'traffic',
            'cctv',
            'radio',
            'bikeshare',
            'ais-live-vessels',
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
          description: 'Optional layer row to scroll into view and highlight.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'set_panel_open',
    description: 'Open or close a GEV UI panel/dropdown.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        panelId: {
          type: 'string',
          enum: ['data-panel', 'location-bar', 'control-panel', 'cctv-panel', 'radio-panel', 'scene-panel', 'pp-toggles', 'global-context-panel'],
        },
        open: { type: 'boolean' },
      },
      required: ['panelId', 'open'],
    },
  },
  {
    type: 'function',
    name: 'set_context_mode',
    description: 'Enter or exit the Global Context sub-mode used by Contacts and Space Missions. Use Contacts only when the user explicitly requests Contacts, and Space Missions only when explicitly requested. A request to open the parent Context panel alone uses set_panel_open and must not activate either sub-mode. Selecting an aircraft does not imply Context.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['off', 'contacts', 'flights', 'space-missions', 'missions'],
          description: 'Use off to exit context mode.',
        },
      },
      required: ['mode'],
    },
  },
  {
    type: 'function',
    name: 'control_cockpit',
    description: 'Read or control Cockpit when the user explicitly requests Cockpit: establish Contacts and enter from a selected or tracked aircraft; exit; or navigate nearby Contacts with optional filters. Selecting or viewing an aircraft alone must not enter Cockpit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['enter', 'exit', 'previous', 'next', 'prev', 'status'],
          description: 'previous/next (or prev) navigates through nearby contacts in Cockpit context.',
        },
        targetLayer: {
          type: 'string',
          enum: ['flights', 'military', 'ais-live-vessels', 'military-installations'],
          description: 'Optional contact layer filter for next/previous (for example military for a military-only cycle).',
        },
        aircraftClass: {
          type: 'string',
          description: 'Optional aircraft class filter (for example helicopter) when using next/previous navigation.',
        },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'set_visual_style',
    description: "Set the active God's Eye View visual filter/style.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        style: {
          type: 'string',
          enum: ['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow'],
        },
      },
      required: ['style'],
    },
  },
  {
    type: 'function',
    name: 'get_entity_context',
    description: 'Get current GEV scene context, including basemap/3D-tile target context, selected entity metadata if active, and entities currently visible in the camera view.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: ['auto', 'selected', 'in_view'],
          description: 'Use auto by default. selected returns the clicked/selected entity; in_view returns visible entities near the screen center.',
        },
        layerId: {
          type: 'string',
          enum: [
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
          description: 'Optional layer filter for visible entity context.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 12,
        },
      },
    },
  },
  {
    type: 'function',
    name: 'get_current_view_state',
    description: 'Read the current camera, style, Context, Cockpit, HUD, detection, map stack, post-processing, scene-playback, tracked-entity, and layer state before choosing another action.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'set_hud',
    description: 'Control the intelligence HUD overlay: visibility and/or layout variant.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        visible: { type: 'string', enum: ['on', 'off', 'auto'], description: 'auto restores style-driven show/hide.' },
        layout: { type: 'string', enum: ['tactical', 'operator', 'minimal'] },
      },
    },
  },
  {
    type: 'function',
    name: 'set_detection',
    description: 'Control the detection overlay: on/off, density-derived Sparse/Balanced/Dense profile, and Elastic/Weighted layer allocation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: 'false turns detection OFF; true restores the current density-derived profile.' },
        mode: { type: 'string', enum: ['sparse', 'balanced', 'dense'] },
        densityPct: { type: 'number', description: 'Density snaps to 0, 25, 50, 75, or 100 and derives the active profile.' },
        allocationStrategy: { type: 'string', enum: ['elastic', 'weighted'], description: 'Elastic splits evenly then lends unused slots; Weighted follows demand and semantic weight.' },
      },
    },
  },
  {
    type: 'function',
    name: 'set_map_stack',
    description: 'Switch the basemap/imagery stack (NOT the satellites data layer and NOT a visual style filter).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stack: {
          type: 'string',
          enum: ['photoreal', 'bing-aerial', 'bing-labels', 'osm'],
          description: 'photoreal = Google 3D. Use bing-aerial only when the user explicitly says "Bing aerial" — "satellite(s)" never means a basemap.',
        },
      },
      required: ['stack'],
    },
  },
  {
    type: 'function',
    name: 'set_post_processing',
    description: 'Control bloom and sharpen post-processing toggles and intensities.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bloom: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            intensityPct: { type: 'number', description: '0-200 (UI percent).' },
          },
        },
        sharpen: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            intensityPct: { type: 'number', description: '0-100 (UI percent).' },
          },
        },
      },
    },
  },
  {
    type: 'function',
    name: 'control_scene',
    description: 'Cinematic scene playback: list scenes, play one scene by name, stop, advance, or read status. Play starts a single named scene and returns immediately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'play', 'stop', 'next', 'status'] },
        sceneId: { type: 'string', description: 'Scene id or (partial) title for play.' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'control_cctv',
    description: 'CCTV camera operations: enable/disable the layer, select a camera by name, next/prev/nearest/focus, toggle coverage wedges / projection overlay / auto-hop, "viewshed" for color-coded per-camera coverage volumes, and "adjust" for the on-camera calibration gizmo.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['enable', 'disable', 'select', 'next', 'prev', 'nearest', 'focus', 'coverage', 'viewshed', 'adjust', 'projection', 'autohop'] },
        cameraQuery: { type: 'string', description: 'Camera name or id for select.' },
        enabled: { type: 'boolean', description: 'Explicit on/off for coverage/viewshed/adjust/projection/autohop; omit to toggle.' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'control_radio',
    description: 'Control Internet Radio playback without moving the map. Use select whenever the request includes a station category, name, country, coordinates, or nearby place—even when the user says play. Use play only for an unqualified "turn on/start the radio" request so the current or nearest station begins. Enable only reveals the Radio layer/markers without audio. Also supports disable, resume, pause, stop, next/previous, volume, and status.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['enable', 'disable', 'play', 'resume', 'pause', 'stop', 'next', 'previous', 'volume', 'select', 'status'],
          description: 'Use select for any request qualified by category, station, country, coordinates, or place. Use play only for an unqualified turn on/start/listen request. Use enable only when the user explicitly asks to show or enable the Radio layer or its markers without requesting audio.',
        },
        volumePct: { type: 'number', minimum: 0, maximum: 100, description: 'Required for volume; sets the persistent Radio playback volume.' },
        category: {
          type: 'string',
          enum: ['all', 'news', 'talk', 'weather', 'public-safety', 'aviation-marine', 'traffic-transit', 'music'],
          description: 'Station category for select/next/previous. When the user requests playback with a category, action must be select, not play.',
        },
        locationId: {
          type: 'string',
          enum: ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'],
          description: 'Known nearby-city anchor for select.',
        },
        locationQuery: { type: 'string', maxLength: 120, description: 'Place to search near, such as "Austin, Texas" or "Seattle". Selection does not fly the camera.' },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        country: { type: 'string', maxLength: 80, description: 'Country code or name filter, for example US or United States.' },
        stationQuery: { type: 'string', maxLength: 120, description: 'Optional station name/tag substring.' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'track_entity',
    description: 'Find and follow a specific aircraft (callsign/ICAO hex), ship (name/MMSI), or satellite (name/NORAD id) on enabled layers. Camera follows the entity.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Callsign, ship name, satellite name, ICAO hex, MMSI, or NORAD id.' },
        layerId: { type: 'string', description: 'Optional layer hint: flights | military | ais-live-vessels | satellites.' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'stop_tracking',
    description: 'Stop following the tracked aircraft/satellite and clear any selected vessel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'frame_overhead',
    description: 'Cinematically frame entities near the current view: pulls the camera back and angles it so nearby aircraft, ships, or satellites are visible together.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', enum: ['flights', 'military', 'satellites', 'vessels'] },
        radiusKm: { type: 'number', description: 'Search radius around the view target. Defaults: 150 aircraft, 120 ships, 3000 satellites.' },
      },
      required: ['target'],
    },
  },
  {
    type: 'function',
    name: 'annotate_map',
    description: "Draw annotations on the 3D map to visually point out what you are talking about — like sketching on a whiteboard over the world. Use this whenever you mention a specific place, building, campus, boundary, district, or a relationship between two places, so the user can SEE what you mean. Give place NAMES (preferred) or explicit lat/lng; the app resolves them to real-world positions and real building/area outlines — never guess pixel positions. Call this as you begin describing something, and you may mark several places in one call.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        annotations: {
          type: 'array',
          description: 'One or more things to mark. Mark multiple related places together when describing them as a group.',
          minItems: 1,
          maxItems: 24,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: {
                type: 'string',
                enum: ['pin', 'highlight', 'area', 'arrow', 'route', 'label'],
                description: 'pin = planted marker at a spot; highlight = pulsing ring drawing the eye to a point; area = trace the outline of a building/campus/compound/district; arrow = a connector from one place to another (use target as the origin and toTarget as the destination); route = a path through several waypoints (use the points array); label = a floating text callout.',
              },
              target: { type: 'string', maxLength: 200, description: 'Place name to resolve, e.g. "Palace of Fine Arts, San Francisco", "the Pentagon", "Presidio of San Francisco". Preferred over coordinates. For a specific monument/statue/feature that sits within a larger landmark, use its OWN name + city ("Tejano Monument, Austin", "Texas African American History Memorial, Austin") — do NOT phrase it as "X at the Texas State Capitol", which makes the geocoder collapse several of them onto the same centroid so they stack on one spot.' },
              points: {
                type: 'array',
                description: 'For type=route: 2+ ordered waypoints the path passes through, each a place name (or coordinates / screen point).',
                minItems: 2,
                maxItems: 12,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    target: { type: 'string', maxLength: 200, description: 'Waypoint place name.' },
                    latitude: { type: 'number', minimum: -90, maximum: 90 },
                    longitude: { type: 'number', minimum: -180, maximum: 180 },
                    screenX: { type: 'number', minimum: 0, maximum: 1 },
                    screenY: { type: 'number', minimum: 0, maximum: 1 },
                  },
                },
              },
              mode: {
                type: 'string',
                enum: ['walking', 'driving', 'cycling'],
                description: 'For type=route: travel mode for a real street-following route (the app returns distance + time). Pick from the verb the user used ("walk" → walking, "drive" → driving). Defaults to walking.',
              },
              latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Explicit latitude (use only if no good place name exists).' },
              longitude: { type: 'number', minimum: -180, maximum: 180 },
              toTarget: { type: 'string', maxLength: 200, description: 'For type=arrow: the destination place name.' },
              toLatitude: { type: 'number', minimum: -90, maximum: 90 },
              toLongitude: { type: 'number', minimum: -180, maximum: 180 },
              label: { type: 'string', maxLength: 120, description: 'Short caption shown on the map (a few words). Optional.' },
              color: {
                type: 'string',
                enum: ['primary', 'amber', 'cyan', 'green', 'red'],
                description: 'Accent color. primary = neutral, amber = point of interest, cyan = infrastructure, green = confirmed/safe, red = alert.',
              },
              footprint: { type: 'boolean', description: 'For type=area/highlight: trace the real building or campus outline from map data. Defaults true for area.' },
              intent: { type: 'string', enum: ['the_thing', 'around_the_thing'], description: 'For type=area: "the_thing" (default) outlines the place itself (its footprint/boundary); "around_the_thing" highlights a surrounding zone (a buffered radius around it). Infer from phrasing: "the Capitol"/"show me X" → the_thing; "around/near/by X" or "the area around X" → around_the_thing.' },
              entityKind: { type: 'string', enum: ['building', 'compound', 'district', 'street', 'point_feature'], description: 'What KIND of thing the target IS — a fact, not a style choice: building = one structure; compound = campus/grounds/mall/park; district = neighborhood or area of a city; street = a named road/corridor; point_feature = monument/statue/memorial/plaque/fountain or other small point landmark. Set it whenever you know it — it routes the resolver to the right footprint source (point_feature anchors monuments as precise points instead of adopting a nearby building outline).' },
              screenX: { type: 'number', minimum: 0, maximum: 1, description: 'Fallback only: when you cannot name/geocode the place but can SEE it in the latest viewport screenshot, the normalized horizontal position (0=left, 1=right) of the spot. The app converts it back to a real world point under that pixel.' },
              screenY: { type: 'number', minimum: 0, maximum: 1, description: 'Fallback only: normalized vertical position (0=top, 1=bottom) of the spot in the latest viewport screenshot.' },
              toScreenX: { type: 'number', minimum: 0, maximum: 1, description: 'For type=arrow: normalized x of the arrow destination from the screenshot (pixel fallback).' },
              toScreenY: { type: 'number', minimum: 0, maximum: 1, description: 'For type=arrow: normalized y of the arrow destination from the screenshot (pixel fallback).' },
            },
            required: ['type'],
          },
        },
        flyTo: { type: 'boolean', description: 'Also move the camera to frame the first annotation. Default false — leave false if the user is already looking at the spot.' },
        persist: { type: 'boolean', description: 'Keep annotations until cleared (true, default) or let them auto-fade after ~20s (false).' },
      },
      required: ['annotations'],
    },
  },
  {
    type: 'function',
    name: 'clear_annotations',
    description: 'Erase ALL map annotations previously drawn with annotate_map. Call this ONLY when the user EXPLICITLY asks to clear or reset the map. Annotations accumulate and persist across navigation and topic changes by design — never clear on your own initiative.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'move_camera',
    description: 'Direct the camera like a drone operator: orbit the current view target, pan, tilt, or rotate — one bounded nudge (mode=once) or continuous motion until stopped (mode=continuous). Continuous motion also stops on any manual camera input or when a navigation tool runs. Say the RESULTING state when confirming ("Orbiting slowly").',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        motion: { type: 'string', enum: ['orbit', 'pan', 'tilt', 'rotate', 'stop'] },
        direction: { type: 'string', enum: ['left', 'right', 'up', 'down'], description: 'Required except for orbit (defaults right/clockwise) and stop.' },
        speed: { type: 'string', enum: ['slow', 'normal', 'fast'] },
        mode: { type: 'string', enum: ['once', 'continuous'], description: 'once = bounded eased nudge (default); continuous = until stop/manual input.' },
      },
      required: ['motion'],
    },
  },
  {
    type: 'function',
    name: 'fly_route',
    description: 'Cinematic dolly along an EXISTING route annotation (drawn earlier with annotate_map type=route) — flies the street-following path from start to end. Omit label for the newest route. If no route is drawn, this fails with guidance: draw the route first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: 'Match an existing route mark by (partial) label.' },
        speed: { type: 'string', enum: ['slow', 'normal', 'fast'] },
      },
    },
  },
  {
    type: 'function',
    name: 'analyst_query',
    description: 'Answer questions ABOUT the data currently loaded on the map — counts, lists, superlatives, and attribute filters over live layers (flights, military, ships, fires, earthquakes). Examples: "how many flights over Texas", "biggest fire near LA", "which ships are headed to Oakland", "anything above 40,000 feet", "fastest thing in view". Queries ONLY client-side data from ENABLED layers — if the needed layer is off, say so and offer to enable it. For a follow-up about the previous answer\'s set ("which of those is closest?"), set followUp=true and send only the new filters/sort.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layers: {
          type: 'array',
          items: { type: 'string', enum: ['flights', 'military', 'ais-live-vessels', 'local-firms', 'earthquakes'] },
          description: 'Layers to query. fires/wildfires → local-firms; ships/vessels → ais-live-vessels.',
        },
        scope: {
          type: 'object',
          additionalProperties: false,
          description: 'Spatial scope. Default: view (near the camera). Use kind=region for "over Texas"-style asks; kind=anywhere for global questions.',
          properties: {
            kind: { type: 'string', enum: ['view', 'region', 'radius', 'anywhere'] },
            name: { type: 'string', description: 'For kind=region: a state/country ("Texas", "France") or a named natural region ("the Alps", "Gulf of Mexico").' },
            km: { type: 'number', description: 'For kind=radius.' },
            center: { type: 'object', additionalProperties: false, properties: { lat: { type: 'number' }, lon: { type: 'number' } } },
          },
        },
        filters: {
          type: 'array',
          description: 'Attribute predicates, ANDed. ALTITUDE IS METERS (40,000 ft = 12192). Fields: altitudeM, speedMps, military, onGround, aircraftClass, callsign, operator, routeOrigin, routeDestination, originCountry (flights); speedKts, shipType, destination (ships); frp, confidence (fires); magnitude, depthKm, place (earthquakes).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: { type: 'string' },
              op: { type: 'string', enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains'] },
              value: {},
            },
            required: ['field', 'op', 'value'],
          },
        },
        sortBy: { type: 'string', description: 'Field to rank by, or "distance" for nearest-first.' },
        sortDir: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'number' },
        followUp: { type: 'boolean', description: 'true = re-query the PREVIOUS result set instead of fresh data.' },
      },
    },
  },
  {
    type: 'function',
    name: 'next_iss_pass',
    description: "When the user asks when the ISS / the space station will next fly over: returns the next visible ISS pass for the current camera location (or an explicit lat/lon) — rise time (ISO + minutes from now), rise compass direction, peak elevation, and duration. Requires the satellites layer to have loaded its catalog at least once this session; if it hasn't, tell the user to enable the satellites layer and try again.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Optional observer latitude. Omit to use the current camera position.' },
        longitude: { type: 'number', minimum: -180, maximum: 180, description: 'Optional observer longitude. Omit to use the current camera position.' },
        minElevationDeg: { type: 'number', minimum: 5, maximum: 60, description: 'Minimum peak elevation (deg) to count as a pass. Default 10.' },
      },
    },
  },
];

/**
 * Load the `ws` constructor once.
 *
 * Node's built-in WebSocket cannot be used here: it has no terminate(), and
 * its close() waits forever for a close frame a black-holed peer never sends
 * (verified in src/data/aisWatchdogTransport.test.mjs). A socket parked in
 * CLOSING keeps holding AISStream's single per-key connection, which is how
 * the reverted watchdog wedged.
 *
 * Loaded lazily rather than imported at the top of this file so a missing
 * optional dependency degrades the vessel feed honestly instead of breaking
 * the whole dev server and build.
 *
 * @returns {Function|null}
 */
function aisWebSocketImpl() {
  if (_aisWebSocketImpl !== undefined) return _aisWebSocketImpl;
  try {
    _aisWebSocketImpl = createRequire(import.meta.url)('ws');
  } catch (error) {
    _aisWebSocketImpl = null;
    console.warn('[AISStream] `ws` is unavailable; the live vessel feed is off.', error?.message || '');
  }
  return _aisWebSocketImpl;
}

/**
 * Resolve the watchdog policy from the environment, once.
 *
 * Read lazily because module evaluation happens before Vite's loadEnv() copies
 * .env into process.env — the reverted watchdog read these at import time and
 * silently ignored every .env value, including its own kill switch.
 *
 * A custom subscription (one harbor, one message type) can be legitimately
 * silent for minutes, so the silence watch only self-arms for the default
 * worldwide subscription. An operator with a narrow filter opts back in by
 * setting AISSTREAM_SILENCE_TIMEOUT_MS to a value sized for that filter; 0 is
 * an explicit kill switch.
 */
function aisWatchdogPolicy() {
  if (_aisWatchdogPolicy) return _aisWatchdogPolicy;
  const customSubscription = Boolean(
    process.env.AISSTREAM_BOUNDING_BOXES || process.env.AISSTREAM_MESSAGE_TYPES,
  );
  const override = parseSilenceTimeoutEnv(
    process.env.AISSTREAM_SILENCE_TIMEOUT_MS,
    (message) => console.warn(message),
  );
  const reportMs = override.kind === 'timeout' ? override.value : AISSTREAM_SILENCE_REPORT_MS;
  _aisWatchdogPolicy = {
    silenceWatch: override.kind === 'off' ? false : (override.kind === 'timeout' || !customSubscription),
    reportMs,
    recycleMs: Math.round(reportMs * AISSTREAM_RECYCLE_RATIO),
    // Overridable so the watchdog can be exercised end-to-end against a local
    // stand-in upstream without opening a connection to AISStream (which
    // allows only one per key).
    url: process.env.AISSTREAM_URL || AISSTREAM_URL,
  };
  return _aisWatchdogPolicy;
}


/**
 * The transport adapter, built on first use and kept for the module lifetime.
 *
 * Never rebuilt: it owns the socket-generation namespace, and a restarted
 * namespace would let a pre-disposal handler act on its successor's socket.
 */
function aisAdapter() {
  if (_aisAdapter) return _aisAdapter;
  _aisAdapter = createAisStreamAdapter({
    createSocket: (url) => {
      const WebSocketCtor = aisWebSocketImpl();
      if (!WebSocketCtor) throw new Error('ws transport unavailable');
      return new WebSocketCtor(url);
    },
    resolveUrl: () => aisWatchdogPolicy().url,
    buildSubscription: aisStreamSubscription,
    ingestEnvelope: ingestAisStreamEnvelope,
    warn: (message) => console.warn(message),
  });
  _aisAdapter.setWatchdogOptions(aisWatchdogBudgets());
  return _aisAdapter;
}

/** Watchdog budgets derived from the resolved environment policy. */
function aisWatchdogBudgets() {
  const policy = aisWatchdogPolicy();
  return {
    staleMs: policy.reportMs,
    recycleAfterMs: policy.recycleMs,
    backoffMs: [...AISSTREAM_BACKOFF_MS],
    downRetryMs: AISSTREAM_DOWN_RETRY_MS,
    authProbeMs: AISSTREAM_AUTH_PROBE_MS,
  };
}

/**
 * Fingerprint the credential so a key change can clear the terminal
 * auth-failed state. Only a truncated digest is kept — never the key.
 */
function aisKeyFingerprint() {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) return null;
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
}

/**
 * Drive the watchdog once. Called on every /api/ais-live request and on the
 * background interval, so recovery does not depend on browser traffic.
 */
function ensureAisStreamConnection() {
  const adapter = aisAdapter();
  if (_aisNeedsRearm) {
    // Post-dispose re-arm, now that the restarted server's .env is loaded. The
    // adapter keeps its generation namespace across this.
    _aisNeedsRearm = false;
    adapter.setWatchdogOptions(aisWatchdogBudgets());
  }
  const policy = aisWatchdogPolicy();
  adapter.ensure({
    hasKey: Boolean(process.env.AISSTREAM_API_KEY),
    hasTransport: Boolean(aisWebSocketImpl()),
    silenceWatch: policy.silenceWatch,
    keyFingerprint: aisKeyFingerprint(),
  });
}
/** Status metadata for /api/ais-live, safe to call before the first connect. */
function aisStreamStatusSnapshot() {
  const snapshot = _aisAdapter ? _aisAdapter.snapshot() : null;
  if (snapshot) return snapshot;
  return {
    status: process.env.AISSTREAM_API_KEY ? 'idle' : 'missing-key',
    error: process.env.AISSTREAM_API_KEY ? null : 'AISSTREAM_API_KEY is not set',
    lastMessageAt: null,
    silentForMs: null,
    reconnectAttempt: 0,
    nextAttemptAt: null,
    watchdog: 'armed',
    staleAfterMs: AISSTREAM_SILENCE_REPORT_MS,
  };
}

/**
 * Start the background watchdog tick. Unref'd so it never holds the dev server
 * open, and idempotent so a Vite in-process restart cannot stack intervals.
 */
function startAisStreamWatchdogTick() {
  if (_aisStreamTickTimer) return;
  _aisStreamTickTimer = setInterval(() => {
    try {
      ensureAisStreamConnection();
    } catch (error) {
      console.warn('[AISStream] watchdog tick failed', error?.message || '');
    }
  }, AISSTREAM_TICK_MS);
  _aisStreamTickTimer.unref?.();
}

/**
 * Tear down every timer and socket this module owns.
 *
 * Vite restarts the dev server in-process on a config change while module
 * state survives, so without this each reload stacked another interval and
 * another reconnect chain. The cached policy is dropped too, so a restart
 * re-reads .env.
 *
 * The adapter instance itself is deliberately KEPT: it owns the socket
 * generation namespace, which must stay monotonic across restarts so a
 * pre-disposal handler can never collide with a post-disposal socket.
 */
function disposeAisStream() {
  if (_aisStreamTickTimer) {
    clearInterval(_aisStreamTickTimer);
    _aisStreamTickTimer = null;
  }
  if (_aisAdapter) _aisAdapter.dispose();
  // Drop the cached policy and re-arm LAZILY. Re-deriving budgets here would
  // read process.env before the restarted server's loadEnv() has repopulated
  // it, caching the outgoing configuration; the next ensure() runs after that.
  _aisWatchdogPolicy = null;
  _aisNeedsRearm = true;
}

function aisStreamSubscription() {
  return {
    APIKey: process.env.AISSTREAM_API_KEY,
    BoundingBoxes: parseJsonEnv('AISSTREAM_BOUNDING_BOXES', AISSTREAM_DEFAULT_BBOXES),
    FilterMessageTypes: parseCsvOrJsonEnv('AISSTREAM_MESSAGE_TYPES', AISSTREAM_DEFAULT_MESSAGE_TYPES),
  };
}

/**
 * Store one parsed AIS envelope.
 *
 * The return value is the feed's ONLY liveness proof, so it is true strictly
 * when the envelope carried a real AIS record. Malformed frames and error
 * envelopes never reach here — the adapter classifies those — and a JSON
 * object without an MMSI proves nothing about the feed.
 *
 * @param {Object} envelope Parsed, non-error AIS envelope.
 * @returns {boolean} True when an AIS record was recognised.
 */
function ingestAisStreamEnvelope(envelope) {
  // Single shared recognition rule (also used by the adapter's tests), so the
  // liveness predicate that ships is the one under test. An envelope carrying
  // only an MMSI is not proof the feed works.
  if (!isRecognizedAisEnvelope(envelope)) return false;

  const messageType = envelope?.MessageType;
  const message = envelope?.Message?.[messageType] || {};
  const metadata = envelope?.MetaData || envelope?.Metadata || {};
  const mmsi = stringValue(metadata.MMSI ?? message.UserID ?? message.UserId ?? message.Mmsi);
  if (!mmsi) return false;

  if (messageType === 'ShipStaticData' || messageType === 'StaticDataReport') {
    const staticData = {
      name: vesselNameFromAis(metadata, message, _aisStreamStatic.get(mmsi)),
      type: vesselTypeFromAis(message, _aisStreamStatic.get(mmsi)),
      destination: stringValue(message.Destination),
      imo: stringValue(message.ImoNumber ?? message.IMO),
    };
    _aisStreamStatic.set(mmsi, staticData);
    mergeAisStaticIntoLiveVessel(mmsi, staticData);
  }

  const lat = numberValue(metadata.latitude ?? metadata.Latitude ?? message.Latitude);
  const lon = numberValue(metadata.longitude ?? metadata.Longitude ?? message.Longitude);
  // A positionless but well-formed record (static data) is still the feed
  // delivering AIS traffic, so it counts as liveness.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;

  const staticData = _aisStreamStatic.get(mmsi) || {};
  _aisStreamVessels.set(mmsi, {
    lat,
    lon,
    name: vesselNameFromAis(metadata, message, staticData) || `MMSI ${mmsi}`,
    mmsi,
    imo: stringValue(message.ImoNumber ?? message.IMO ?? staticData.imo),
    type: vesselTypeFromAis(message, staticData),
    destination: stringValue(message.Destination ?? staticData.destination),
    speed: numberValue(message.Sog ?? message.SOG),
    course: numberValue(message.Cog ?? message.COG),
    heading: normalizedHeading(message.TrueHeading ?? message.Heading),
    last_position_UTC: normalizeAisTimestamp(metadata.time_utc ?? metadata.TimeUtc),
    // Use the AIS message's own report time, not server ingest wall-clock —
    // trail spacing and dead reckoning depend on true fix epochs.
    last_position_epoch: aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc),
    _updatedAt: Date.now(),
  });

  appendAisTrackSample(mmsi, lat, lon, aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc));

  pruneAisStreamCache();
  return true;
}

/**
 * Parses an AISStream UTC timestamp into epoch seconds (fallback: now).
 */
function aisEpochSeconds(value) {
  const ms = Date.parse(normalizeAisTimestamp(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

/**
 * Appends a thinned position sample to a vessel's track ring buffer.
 * Buffers allocate lazily on the second fix (most MMSIs are seen once);
 * samples are kept only when >=AIS_TRACK_MIN_GAP_SEC and
 * >=AIS_TRACK_MIN_MOVE_M from the previous stored sample, so anchored
 * vessels collapse to a single point.
 */
function appendAisTrackSample(mmsi, lat, lon, epochSec) {
  let track = _aisStreamTracks.get(mmsi);
  if (!track) {
    const pending = _aisStreamTrackPending.get(mmsi);
    if (!pending) {
      _aisStreamTrackPending.set(mmsi, { lat, lon, epochSec });
      return;
    }
    if (epochSec - pending.epochSec < AIS_TRACK_MIN_GAP_SEC) return;
    if (approxMetersBetween(pending.lat, pending.lon, lat, lon) < AIS_TRACK_MIN_MOVE_M) return;
    track = {
      lats: new Float32Array(AIS_TRACK_SAMPLES),
      lons: new Float32Array(AIS_TRACK_SAMPLES),
      times: new Uint32Array(AIS_TRACK_SAMPLES),
      head: 0,
      len: 0,
    };
    _aisStreamTracks.set(mmsi, track);
    _aisStreamTrackPending.delete(mmsi);
    writeAisTrackSample(track, pending.lat, pending.lon, pending.epochSec);
    writeAisTrackSample(track, lat, lon, epochSec);
    return;
  }

  const lastIdx = (track.head - 1 + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
  const lastEpoch = track.times[lastIdx];
  if (epochSec - lastEpoch < AIS_TRACK_MIN_GAP_SEC) return;
  if (approxMetersBetween(track.lats[lastIdx], track.lons[lastIdx], lat, lon) < AIS_TRACK_MIN_MOVE_M) return;
  writeAisTrackSample(track, lat, lon, epochSec);
}

function writeAisTrackSample(track, lat, lon, epochSec) {
  track.lats[track.head] = lat;
  track.lons[track.head] = lon;
  track.times[track.head] = epochSec;
  track.head = (track.head + 1) % AIS_TRACK_SAMPLES;
  track.len = Math.min(track.len + 1, AIS_TRACK_SAMPLES);
}

/**
 * Reads a vessel's accumulated track in chronological order.
 * @returns {Array<{lat:number,lon:number,t:number}>}
 */
function readAisTrack(mmsi) {
  const track = _aisStreamTracks.get(mmsi);
  if (!track || !track.len) return [];
  const samples = [];
  const start = (track.head - track.len + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
  for (let i = 0; i < track.len; i++) {
    const idx = (start + i) % AIS_TRACK_SAMPLES;
    samples.push({ lat: track.lats[idx], lon: track.lons[idx], t: track.times[idx] });
  }
  return samples;
}

/** Equirectangular distance approximation — plenty for 25m thinning. */
function approxMetersBetween(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

function mergeAisStaticIntoLiveVessel(mmsi, staticData) {
  const existing = _aisStreamVessels.get(mmsi);
  if (!existing) return;
  if (staticData.name && (!existing.name || existing.name === `MMSI ${mmsi}`)) existing.name = staticData.name;
  if (staticData.type && !existing.type) existing.type = staticData.type;
  if (staticData.destination && !existing.destination) existing.destination = staticData.destination;
  if (staticData.imo && !existing.imo) existing.imo = staticData.imo;
}

function vesselNameFromAis(metadata, message, staticData = {}) {
  return stringValue(
    metadata.ShipName
      ?? message.Name
      ?? message.ShipName
      ?? message.ReportA?.Name
      ?? staticData.name
  );
}

function vesselTypeFromAis(message, staticData = {}) {
  return stringValue(
    message.Type
      ?? message.ShipType
      ?? message.ReportB?.ShipType
      ?? staticData.type
  );
}

function aisStreamRows(maxRows) {
  const cutoff = Date.now() - AISSTREAM_STALE_MS;
  const rows = [];
  for (const row of _aisStreamVessels.values()) {
    if (row._updatedAt >= cutoff) rows.push(row);
  }
  rows.sort((a, b) => b._updatedAt - a._updatedAt);
  return rows.slice(0, maxRows).map(({ _updatedAt, ...row }) => row);
}

function pruneAisStreamCache() {
  const cutoff = Date.now() - AISSTREAM_STALE_MS;
  for (const [mmsi, row] of _aisStreamVessels) {
    if (row._updatedAt < cutoff) {
      _aisStreamVessels.delete(mmsi);
      _aisStreamTracks.delete(mmsi);
      _aisStreamTrackPending.delete(mmsi);
    }
  }
  // Pending single-fix entries for vessels never seen again must not leak
  const pendingCutoffSec = Math.floor(cutoff / 1000);
  for (const [mmsi, pending] of _aisStreamTrackPending) {
    if (pending.epochSec < pendingCutoffSec) _aisStreamTrackPending.delete(mmsi);
  }
  if (_aisStreamVessels.size <= AISSTREAM_CACHE_MAX) return;
  const ordered = [..._aisStreamVessels.entries()].sort((a, b) => a[1]._updatedAt - b[1]._updatedAt);
  for (const [mmsi] of ordered.slice(0, _aisStreamVessels.size - AISSTREAM_CACHE_MAX)) {
    _aisStreamVessels.delete(mmsi);
    _aisStreamTracks.delete(mmsi);
    _aisStreamTrackPending.delete(mmsi);
  }
}

function newestAisPositionAt(rows) {
  return rows[0]?.last_position_UTC || null;
}

// ---------------------------------------------------------------------------
// Military-installation context proxy
// ---------------------------------------------------------------------------
// This narrow endpoint deliberately does not expose arbitrary Overpass QL to
// the browser. It returns only allow-listed mapped context and rejects global,
// cross-dateline, or oversized requests before touching public OSM mirrors.
const MILITARY_INSTALLATION_CACHE_MS = 5 * 60_000;
const MILITARY_INSTALLATION_STALE_MS = 60 * 60_000;
const MILITARY_INSTALLATION_MAX_CACHE = 80;
const MILITARY_INSTALLATION_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/**
 * Upstream element cap. A response that hits it exactly is SATURATED — Overpass
 * truncated, so off-viewport features from the snapped bbox may have crowded out
 * in-viewport ones. Callers re-ask for the exact viewport in that case.
 */
export const MILITARY_INSTALLATION_ELEMENT_CAP = 700;
/**
 * Disk-cache TTL for mapped installations (ms) — 30 days.
 *
 * Field test 2026-08-18: "search nearby sites" was slow because every look
 * around paid a live Overpass round trip, and the 5-minute in-memory tier died
 * with the dev server. Mapped military features change on a survey timescale,
 * not a session one, so a month-old answer is still the right answer — the same
 * reasoning the Overpass proxy already applies to admin boundaries.
 */
const MILITARY_INSTALLATION_DISK_TTL_MS = 30 * 86_400_000;
/** Disk-cache directory for mapped installation payloads. */
const MILITARY_INSTALLATION_DISK_DIR = path.join(process.cwd(), '.gev-cache', 'military-installations');
/**
 * Cache-key grid step in degrees (~5.5 km).
 *
 * The browser sends the raw view rectangle, so every pixel of pan minted a new
 * key and a new upstream query. Snapping the bbox OUTWARD onto a coarse grid
 * makes neighbouring viewports share one entry, and because the snap only ever
 * grows the box, the cached answer is always a superset of what was asked for.
 */
const MILITARY_INSTALLATION_BBOX_STEP_DEG = 0.05;
const _militaryInstallationCache = new Map();
const _militaryInstallationInFlight = new Map();

/**
 * Snap a request bbox outward onto the shared installation cache grid.
 * @param {{south:number, west:number, north:number, east:number}} box
 * @param {number} [stepDeg]
 * @returns {{south:number, west:number, north:number, east:number}}
 */
export function quantizeMilitaryInstallationBox(box, stepDeg = MILITARY_INSTALLATION_BBOX_STEP_DEG) {
  // Round the ratio first: 29.9999/0.05 lands a hair under an exact grid line
  // in binary floating point, which would otherwise snap a whole cell too far.
  const snap = (value, grow) => {
    const cells = Number((value / stepDeg).toFixed(9));
    return Number(((grow > 0 ? Math.ceil(cells) : Math.floor(cells)) * stepDeg).toFixed(6));
  };
  return {
    south: Math.max(-90, snap(box.south, -1)),
    west: Math.max(-180, snap(box.west, -1)),
    north: Math.min(90, snap(box.north, 1)),
    east: Math.min(180, snap(box.east, 1)),
  };
}

/**
 * Stable disk/memory cache key for an installation bbox.
 *
 * The key's precision must match the precision of the bounds the QUERY uses, or
 * two different queries collide on one entry. Snapped boxes live on a 0.05 deg
 * grid, so 3 decimals is exact for them; an `exact=1` request carries the raw
 * viewport at 5 decimals and must be keyed at 5, otherwise two nearby exact
 * viewports would share an answer and the second would be missing the edge
 * strip it just exposed.
 * @param {{south:number, west:number, north:number, east:number}} box
 * @param {number} [decimals]
 */
export function militaryInstallationCacheKey(box, decimals = 3) {
  return [box.south, box.west, box.north, box.east]
    .map((value) => value.toFixed(decimals))
    .join(',');
}

/**
 * Resolve the READ tiers for one installation request, in order: fresh memory,
 * then disk. Returns UPSTREAM when neither can answer.
 *
 * Disk is skipped while a request for this key is already in flight — the
 * caller joins that instead of paying a read. Exported so the tier ORDER is
 * testable against a real temp directory without a Vite server, mirroring
 * resolveOverpassPreflight.
 *
 * @param {object} options
 * @param {string} options.cacheKey
 * @param {Map<string, {payload: object, cachedAt: number}>} options.memoryCache
 * @param {Map<string, Promise>} options.inFlight
 * @param {() => Promise<?{payload: object, cachedAt: number}>} options.readDisk
 * @param {number} [options.now]
 * @param {number} [options.cacheMs]
 * @returns {Promise<{source: 'HIT'|'DISK'|'UPSTREAM', entry: ?object}>}
 */
export async function resolveMilitaryInstallationTier({
  cacheKey,
  memoryCache,
  inFlight,
  readDisk,
  now = Date.now(),
  cacheMs = MILITARY_INSTALLATION_CACHE_MS,
}) {
  const cached = memoryCache.get(cacheKey);
  if (cached && now - cached.cachedAt <= cacheMs) return { source: 'HIT', entry: cached };
  if (inFlight.has(cacheKey)) return { source: 'UPSTREAM', entry: null };
  const disk = await readDisk();
  return disk ? { source: 'DISK', entry: disk } : { source: 'UPSTREAM', entry: null };
}

/**
 * Bring a stored installation entry up to the current payload shape.
 *
 * Entries written before the saturation guard shipped carry no `saturated`
 * field, and the disk TTL is 30 DAYS — so without this a cached, truncated
 * 700-element snapped response would keep skipping the exact-viewport retry for
 * a month, quietly starving in-view sites. Saturation is DERIVED from the
 * element count rather than invalidating those entries, so warm caches survive
 * the upgrade.
 * @param {?{payload: object, cachedAt: number}} entry
 * @returns {?{payload: object, cachedAt: number}}
 */
export function migrateMilitaryInstallationEntry(entry) {
  if (!entry?.payload || typeof entry.payload.saturated === 'boolean') return entry;
  const elements = Array.isArray(entry.payload.elements) ? entry.payload.elements : [];
  return {
    ...entry,
    payload: {
      ...entry.payload,
      saturated: elements.length >= MILITARY_INSTALLATION_ELEMENT_CAP,
    },
  };
}

/** Whether a stored installation entry is still inside its TTL. */
export function militaryInstallationDiskFresh(
  entry,
  maxAgeMs = MILITARY_INSTALLATION_DISK_TTL_MS,
  now = Date.now(),
) {
  if (!entry || !Number.isFinite(entry.cachedAt) || !Array.isArray(entry.payload?.elements)) return false;
  return now - entry.cachedAt <= maxAgeMs;
}

/** Cache key -> stable disk-cache file path. */
export function militaryInstallationDiskPath(cacheKey, dir = MILITARY_INSTALLATION_DISK_DIR) {
  return path.join(dir, `${createHash('sha1').update(cacheKey).digest('hex')}.json`);
}

/**
 * Read a disk-cached installation entry. maxAgeMs Infinity = any age (the
 * serve-stale path when Overpass is down).
 * @returns {Promise<?{payload: object, cachedAt: number}>}
 */
export async function readMilitaryInstallationDisk(
  cacheKey,
  maxAgeMs,
  dir = MILITARY_INSTALLATION_DISK_DIR,
) {
  try {
    const entry = JSON.parse(await fsp.readFile(militaryInstallationDiskPath(cacheKey, dir), 'utf8'));
    if (!militaryInstallationDiskFresh(entry, maxAgeMs)) return null;
    return migrateMilitaryInstallationEntry(entry);
  } catch {
    return null;
  }
}

/**
 * Persist one installation payload ATOMICALLY: serialize to a temp sibling,
 * then rename over the target. A crash or a full disk mid-write leaves the
 * PREVIOUS entry intact — an in-place overwrite would shred the last-good copy
 * and take serve-stale down with it, exactly when it is needed most.
 * @returns {Promise<boolean>} Whether the entry landed.
 */
export async function writeMilitaryInstallationDisk(
  cacheKey,
  entry,
  dir = MILITARY_INSTALLATION_DISK_DIR,
) {
  const target = militaryInstallationDiskPath(cacheKey, dir);
  // Same directory, so the rename is atomic on POSIX rather than a cross-device copy.
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(temp, JSON.stringify(entry));
    await fsp.rename(temp, target);
    return true;
  } catch (err) {
    console.warn('[Installations Proxy] disk cache write failed:', err?.message || err);
    await fsp.rm(temp, { force: true }).catch(() => {});
    return false;
  }
}

export function validMilitaryInstallationBox(params) {
  const south = requiredFiniteQueryNumber(params, 'south');
  const west = requiredFiniteQueryNumber(params, 'west');
  const north = requiredFiniteQueryNumber(params, 'north');
  const east = requiredFiniteQueryNumber(params, 'east');
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180 || south >= north || west >= east) return null;
  if (north - south > 10 || east - west > 10) return null;
  return { south, west, north, east };
}

function trimMilitaryInstallationCache() {
  while (_militaryInstallationCache.size > MILITARY_INSTALLATION_MAX_CACHE) {
    const oldest = _militaryInstallationCache.keys().next().value;
    if (oldest === undefined) break;
    _militaryInstallationCache.delete(oldest);
  }
}

function militaryInstallationsProxy() {
  async function refresh(box, key) {
    const bbox = `${box.south},${box.west},${box.north},${box.east}`;
    const ql = `[out:json][timeout:20];(nwr["military"~"^(airfield|naval_base|range|barracks|base)$"](${bbox});nwr["landuse"="military"](${bbox}););out center tags geom ${MILITARY_INSTALLATION_ELEMENT_CAP};`;
    const upstream = await fetchOverpassPayload(
      `data=${encodeURIComponent(ql)}`,
      MILITARY_INSTALLATION_MAX_RESPONSE_BYTES,
    );
    if (upstream.status >= 400 || upstream.rateLimited || upstream.runtimeError) {
      throw new Error('Mapped installation upstream unavailable');
    }
    const parsed = JSON.parse(upstream.body);
    const elements = Array.isArray(parsed?.elements)
      ? parsed.elements.slice(0, MILITARY_INSTALLATION_ELEMENT_CAP)
      : [];
    const payload = {
      elements,
      // Honest truncation flag — the client re-asks for its exact viewport so
      // off-view features can never starve in-view ones. The cap travels with
      // the payload so the client never has to hard-code it.
      saturated: elements.length >= MILITARY_INSTALLATION_ELEMENT_CAP,
      elementCap: MILITARY_INSTALLATION_ELEMENT_CAP,
      retrievedAt: new Date().toISOString(),
      status: 'ready',
    };
    const entry = { payload, cachedAt: Date.now() };
    _militaryInstallationCache.set(key, entry);
    trimMilitaryInstallationCache();
    writeMilitaryInstallationDisk(key, entry);
    return payload;
  }

  function install(middlewares) {
    middlewares.use('/api/military-installations', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_militaryInstallationsRateLimiter(clientKey(req))) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const requested = validMilitaryInstallationBox(url.searchParams);
      if (!requested) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A non-dateline bbox no larger than 10 degrees is required' }));
        return;
      }
      // Query the SNAPPED box, not the raw viewport: neighbouring views then
      // share one cache entry, and an outward snap always covers what was asked.
      // `exact=1` opts out — the client sends it after a SATURATED snapped
      // response, so a truncated tile can never starve the actual viewport. It
      // is keyed separately so exact and snapped answers never collide.
      const exact = url.searchParams.get('exact') === '1';
      const box = exact ? requested : quantizeMilitaryInstallationBox(requested);
      // Key at the precision the query actually uses (see militaryInstallationCacheKey).
      const key = exact
        ? `exact:${militaryInstallationCacheKey(box, 5)}`
        : militaryInstallationCacheKey(box);
      const now = Date.now();
      const cached = _militaryInstallationCache.get(key);
      const preflight = await resolveMilitaryInstallationTier({
        cacheKey: key,
        memoryCache: _militaryInstallationCache,
        inFlight: _militaryInstallationInFlight,
        readDisk: () => readMilitaryInstallationDisk(key, MILITARY_INSTALLATION_DISK_TTL_MS),
        now,
      });
      if (preflight.source !== 'UPSTREAM') {
        if (preflight.source === 'DISK') {
          _militaryInstallationCache.set(key, preflight.entry);
          trimMilitaryInstallationCache();
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'X-Military-Installations': preflight.source });
        res.end(JSON.stringify({ ...preflight.entry.payload, status: 'cached' }));
        return;
      }
      const request = coalesceProxyRequest(
        _militaryInstallationInFlight,
        key,
        () => refresh(box, key),
      );
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Military-Installations': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch (error) {
        if (cached && now - cached.cachedAt <= MILITARY_INSTALLATION_STALE_MS) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Military-Installations': 'STALE' });
          res.end(JSON.stringify({ ...cached.payload, status: 'stale' }));
          return;
        }
        // Overpass is down: last-good mapped context at ANY age beats an empty
        // layer (the same serve-stale rule the Overpass proxy applies).
        const stale = await readMilitaryInstallationDisk(key, Infinity);
        if (stale) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Military-Installations': 'STALE-DISK' });
          res.end(JSON.stringify({ ...stale.payload, status: 'stale' }));
          return;
        }
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Mapped installation context is temporarily unavailable' }));
      }
    });
  }

  return {
    name: 'military-installations-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

// ---------------------------------------------------------------------------
// Regional cockpit briefing proxy
// ---------------------------------------------------------------------------
const REGIONAL_BRIEF_CACHE_MS = 5 * 60_000;
const REGIONAL_BRIEF_STALE_MS = 60 * 60_000;
const REGIONAL_BRIEF_MAX_CACHE = 120;
const REGIONAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const _regionalBriefCache = new Map();
const _regionalBriefInFlight = new Map();
const _regionalBriefRateLimiter = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 90 });
const WEATHER_EFFECTS_CACHE_MS = 5 * 60_000;
const WEATHER_EFFECTS_STALE_MS = 30 * 60_000;
const WEATHER_EFFECTS_MAX_CACHE = 180;
const WEATHER_EFFECTS_MAX_RESPONSE_BYTES = 512 * 1024;
const _weatherEffectsCache = new Map();
const _weatherEffectsInFlight = new Map();
const _weatherEffectsRateLimiter = makeRateLimiter({ windowMs: 60_000, max: 45, globalMax: 120 });
let _nominatimQueue = Promise.resolve();
let _nominatimLastRequestAt = 0;

export function requiredFiniteQueryNumber(params, key) {
  const value = params.get(key);
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validRegionalPoint(params) {
  const latitude = requiredFiniteQueryNumber(params, 'latitude');
  const longitude = requiredFiniteQueryNumber(params, 'longitude');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function trimRegionalBriefCache() {
  while (_regionalBriefCache.size > REGIONAL_BRIEF_MAX_CACHE) {
    const oldest = _regionalBriefCache.keys().next().value;
    if (oldest === undefined) break;
    _regionalBriefCache.delete(oldest);
  }
}

function trimWeatherEffectsCache() {
  while (_weatherEffectsCache.size > WEATHER_EFFECTS_MAX_CACHE) {
    const oldest = _weatherEffectsCache.keys().next().value;
    if (oldest === undefined) break;
    _weatherEffectsCache.delete(oldest);
  }
}

async function fetchRegionalJson(url, {
  headers = {},
  timeoutMs = 9000,
  maxBytes = REGIONAL_MAX_RESPONSE_BYTES,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    return readResponseJsonCapped(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRegionalText(url, {
  headers = {},
  timeoutMs = 9000,
  maxBytes = REGIONAL_MAX_RESPONSE_BYTES,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    return readResponseTextCapped(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeRssText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function rssTag(block, tag) {
  return decodeRssText(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)?.[1] || '');
}

function normalizeRssArticles(xml, limit = 5) {
  const seen = new Set();
  const articles = [];
  for (const match of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const title = rssTag(item, 'title').slice(0, 180);
    const url = rssTag(item, 'link');
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { continue; }
    if (!title || !['http:', 'https:'].includes(parsedUrl.protocol)) continue;
    const source = rssTag(item, 'source');
    const signature = `${title.toLowerCase()}|${source.toLowerCase() || parsedUrl.hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const rawDate = rssTag(item, 'pubDate');
    articles.push({
      title,
      url: parsedUrl.href,
      domain: source || parsedUrl.hostname.replace(/^www\./, ''),
      publishedAt: Number.isNaN(Date.parse(rawDate)) ? null : new Date(rawDate).toISOString(),
      sourceCountry: null,
    });
    if (articles.length >= limit) break;
  }
  return articles;
}

function fetchRegionalPlace(point) {
  const task = _nominatimQueue.then(async () => {
    const waitMs = Math.max(0, 1100 - (Date.now() - _nominatimLastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    _nominatimLastRequestAt = Date.now();
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: point.latitude.toFixed(5),
      lon: point.longitude.toFixed(5),
      zoom: '10',
      addressdetails: '1',
      'accept-language': 'en',
    });
    const payload = await fetchRegionalJson(`https://nominatim.openstreetmap.org/reverse?${params}`, {
      headers: {
        'User-Agent': 'GodsEyeView/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
        Referer: 'https://github.com/bilawalsidhu/gods-eye-view',
      },
    });
    return normalizeRegionalPlace(payload);
  });
  _nominatimQueue = task.catch(() => null);
  return task;
}

async function fetchRegionalNews(place) {
  const query = place?.locality || place?.region || place?.country;
  if (!query) return { status: 'unavailable', query: null, articles: [], source: null };
  const rssParams = new URLSearchParams({
    q: String(query).replace(/["\\]/g, ' ').trim(),
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  try {
    const xml = await fetchRegionalText(`https://news.google.com/rss/search?${rssParams}`, {
      headers: { 'User-Agent': 'GodsEyeView/0.1' },
      timeoutMs: 12_000,
    });
    const articles = normalizeRssArticles(xml, 5);
    if (articles.length) return { status: 'ready', query, articles, source: 'Google News RSS' };
  } catch { /* fall through to the existing free index */ }
  const params = new URLSearchParams({
    query: `"${String(query).replace(/["\\]/g, ' ').trim()}"`,
    mode: 'artlist',
    format: 'json',
    maxrecords: '5',
    sort: 'datedesc',
    timespan: '48h',
  });
  try {
    const payload = await fetchRegionalJson(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, {
      headers: { 'User-Agent': 'GodsEyeView/0.1' },
      timeoutMs: 12_000,
    });
    const articles = normalizeRegionalArticles(payload, 5);
    return { status: articles.length ? 'ready' : 'empty', query, articles, source: 'GDELT fallback' };
  } catch {
    return { status: 'unavailable', query, articles: [], source: null };
  }
}

async function fetchRegionalWeather(point) {
  const params = new URLSearchParams({
    latitude: point.latitude.toFixed(5),
    longitude: point.longitude.toFixed(5),
    current: 'temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,visibility',
    timezone: 'UTC',
  });
  try {
    const payload = await fetchRegionalJson(`https://api.open-meteo.com/v1/forecast?${params}`, {
      maxBytes: WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
    });
    return normalizeRegionalWeather(payload);
  } catch {
    return null;
  }
}

/** True when at least one regional source produced usable data. */
export function regionalBriefHasAnySource({ place, weather, news } = {}) {
  return Boolean(place || weather || (news && news.status !== 'unavailable'));
}

function regionalBriefProxy() {
  async function refresh(point, key) {
    const [placeResult, weatherResult] = await Promise.allSettled([
      fetchRegionalPlace(point),
      fetchRegionalWeather(point),
    ]);
    const place = placeResult.status === 'fulfilled' ? placeResult.value : null;
    const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
    const news = await fetchRegionalNews(place);
    if (!regionalBriefHasAnySource({ place, weather, news })) {
      throw new Error('All regional briefing sources unavailable');
    }
    const payload = {
      status: place && weather && news.status !== 'unavailable' ? 'ready' : 'partial',
      retrievedAt: new Date().toISOString(),
      coordinates: point,
      place,
      placeStatus: place ? 'ready' : 'unavailable',
      weather,
      weatherStatus: weather ? 'ready' : 'unavailable',
      newsStatus: news.status,
      newsQuery: news.query,
      newsSource: news.source,
      articles: news.articles,
    };
    _regionalBriefCache.set(key, { payload, cachedAt: Date.now() });
    trimRegionalBriefCache();
    return payload;
  }

  function install(middlewares) {
    middlewares.use('/api/regional-brief', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_regionalBriefRateLimiter(clientKey(req))) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '10' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const point = validRegionalPoint(url.searchParams);
      if (!point) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid latitude and longitude are required' }));
        return;
      }
      const key = `${(Math.round(point.latitude * 10) / 10).toFixed(1)},${(Math.round(point.longitude * 10) / 10).toFixed(1)}`;
      const now = Date.now();
      const cached = _regionalBriefCache.get(key);
      if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_CACHE_MS) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'X-Regional-Brief': 'HIT' });
        res.end(JSON.stringify({ ...cached.payload, status: 'cached' }));
        return;
      }
      const request = coalesceProxyRequest(_regionalBriefInFlight, key, () => refresh(point, key));
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Regional-Brief': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch {
        if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_STALE_MS) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Regional-Brief': 'STALE' });
          res.end(JSON.stringify({ ...cached.payload, status: 'stale' }));
          return;
        }
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Regional briefing is temporarily unavailable' }));
      }
    });
  }

  return {
    name: 'regional-brief-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

function weatherEffectsProxy() {
  async function refresh(point, key) {
    const weather = await fetchRegionalWeather(point);
    if (!weather) throw new Error('Weather observation unavailable');
    const payload = {
      status: 'ready',
      retrievedAt: new Date().toISOString(),
      coordinates: point,
      weather,
    };
    _weatherEffectsCache.set(key, { payload, cachedAt: Date.now() });
    trimWeatherEffectsCache();
    return payload;
  }

  function install(middlewares) {
    middlewares.use('/api/weather-effects', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_weatherEffectsRateLimiter(clientKey(req))) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '10' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const point = validRegionalPoint(url.searchParams);
      if (!point) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid latitude and longitude are required' }));
        return;
      }
      const key = `${(Math.round(point.latitude * 10) / 10).toFixed(1)},${(Math.round(point.longitude * 10) / 10).toFixed(1)}`;
      const now = Date.now();
      const cached = _weatherEffectsCache.get(key);
      if (cached && now - cached.cachedAt <= WEATHER_EFFECTS_CACHE_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Weather-Effects': 'HIT',
        });
        res.end(JSON.stringify({ ...cached.payload, status: 'cached' }));
        return;
      }
      const request = coalesceProxyRequest(_weatherEffectsInFlight, key, () => refresh(point, key));
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Weather-Effects': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch {
        if (cached && now - cached.cachedAt <= WEATHER_EFFECTS_STALE_MS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Weather-Effects': 'STALE',
          });
          res.end(JSON.stringify({ ...cached.payload, status: 'stale' }));
          return;
        }
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Weather effects are temporarily unavailable' }));
      }
    });
  }

  return {
    name: 'weather-effects-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

function parseJsonEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    console.warn(`[AISStream] Invalid ${key}; using default.`);
    return fallback;
  }
}

function parseCsvOrJsonEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function stringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedHeading(value) {
  const heading = numberValue(value);
  return heading !== null && heading >= 0 && heading <= 360 ? heading : null;
}

function normalizeAisTimestamp(value) {
  const text = stringValue(value);
  if (!text) return new Date().toISOString();
  const normalized = text.replace(' +0000 UTC', 'Z').replace(' UTC', 'Z');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/**
 * Main Vite configuration factory.
 *
 * Loads .env files via Vite's loadEnv, registers Cesium + local proxy
 * plugins, configures the dev server host/port, and exposes selected
 * API keys to the client as import.meta.env defines.
 */
export default defineConfig(({ mode }) => {
  // Load only this checkout's dotenv files. Shell/Keychain values still win,
  // and no sibling workspace is consulted implicitly.
  const loaded = loadEnv(mode, __dirname, '');
  for (const [key, val] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
  const env = { ...process.env };
  return {
    plugins: [
      cesium(),
      openSkyProxy(),
      celestrakProxy(),
      tomtomProxy(),
      firmsProxy(),
      rocketLaunchesProxy(),
      terrainHeightsProxy(),
      adsbdbProxy(),
      overpassProxy(),
      militaryInstallationsProxy(),
      regionalBriefProxy(),
      weatherEffectsProxy(),
      cctvProxy(),
      radioBrowserProxy(),
      gbfsProxy(),
      adsbLolProxy(),
      aisLiveProxy(),
      trackBackfillProxies(),
      openAiRealtimeProxy(),
      googlePlacesContextProxy(),
    ],
    server: {
      host: env.HOST || 'localhost',
      port: parseInt(env.PORT, 10) || 5173,
      // When binding to all interfaces, allow any host; otherwise restrict to local names
      allowedHosts: (env.HOST === '0.0.0.0' || env.HOST === '::')
        ? true
        : ['localhost', '127.0.0.1', '.local'],
    },
    // Expose selected API keys to the browser via import.meta.env.*
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(env.GOOGLE_MAPS_API_KEY),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(env.CESIUM_ION_TOKEN),
    },
    build: {
      // The Cesium engine bundle is inherently large; raise the warning ceiling
      // so the build log isn't dominated by an expected chunk-size notice.
      chunkSizeWarningLimit: 1500,
    },
  };
});
