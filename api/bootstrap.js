import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';

export const config = { runtime: 'edge' };

// ── Upstream proxy config ──────────────────────────────────────────
// When our Redis is empty we fetch from the original project's API.
const UPSTREAM_BASE = 'https://api.worldmonitor.app';
const UPSTREAM_TIMEOUT_MS = 8_000;
const UPSTREAM_HEADERS = {
  'Origin': 'https://www.worldmonitor.app',
  'Referer': 'https://www.worldmonitor.app/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// TTLs for data we backfill from upstream → our Redis
const UPSTREAM_BACKFILL_TTL = {
  fast: 600,   // 10 min — fast-tier data refreshes often upstream
  slow: 3600,  // 1 hour — slow-tier data is already long-lived
};

// ── Redis key map ──────────────────────────────────────────────────

const BOOTSTRAP_CACHE_KEYS = {
  earthquakes:      'seismology:earthquakes:v1',
  outages:          'infra:outages:v1',
  serviceStatuses:  'infra:service-statuses:v1',
  marketQuotes:     'market:stocks-bootstrap:v1',
  commodityQuotes:  'market:commodities-bootstrap:v1',
  sectors:          'market:sectors:v1',
  etfFlows:         'market:etf-flows:v1',
  macroSignals:     'economic:macro-signals:v1',
  bisPolicy:        'economic:bis:policy:v1',
  bisExchange:      'economic:bis:eer:v1',
  bisCredit:        'economic:bis:credit:v1',
  shippingRates:    'supply_chain:shipping:v2',
  chokepoints:      'supply_chain:chokepoints:v2',
  minerals:         'supply_chain:minerals:v2',
  giving:           'giving:summary:v1',
  climateAnomalies: 'climate:anomalies:v1',
  wildfires:        'wildfire:fires:v1',
  cyberThreats:     'cyber:threats-bootstrap:v2',
  techReadiness:    'economic:worldbank-techreadiness:v1',
  progressData:     'economic:worldbank-progress:v1',
  renewableEnergy:  'economic:worldbank-renewable:v1',
  positiveGeoEvents: 'positive-events:geo-bootstrap:v1',
  theaterPosture: 'theater-posture:sebuf:stale:v1',
  riskScores: 'risk:scores:sebuf:stale:v1',
  naturalEvents: 'natural:events:v1',
  flightDelays: 'aviation:delays-bootstrap:v1',
  insights: 'news:insights:v1',
  worldBrief: 'news:world-brief:v1',
  predictions: 'prediction:markets-bootstrap:v1',
  cryptoQuotes: 'market:crypto:v1',
  gulfQuotes: 'market:gulf-quotes:v1',
  stablecoinMarkets: 'market:stablecoins:v1',
  unrestEvents: 'unrest:events:v1',
  iranEvents: 'conflict:iran-events:v1',
  ucdpEvents: 'conflict:ucdp-events:v1',
  temporalAnomalies: 'temporal:anomalies:v1',
  weatherAlerts:     'weather:alerts:v1',
  spending:          'economic:spending:v1',
};

const SLOW_KEYS = new Set([
  'bisPolicy', 'bisExchange', 'bisCredit', 'minerals', 'giving',
  'sectors', 'etfFlows', 'shippingRates', 'wildfires', 'climateAnomalies',
  'cyberThreats', 'techReadiness', 'progressData', 'renewableEnergy',
  'naturalEvents',
  'cryptoQuotes', 'gulfQuotes', 'stablecoinMarkets', 'unrestEvents', 'ucdpEvents',
]);
const FAST_KEYS = new Set([
  'earthquakes', 'outages', 'serviceStatuses', 'macroSignals', 'chokepoints',
  'marketQuotes', 'commodityQuotes', 'positiveGeoEvents', 'riskScores', 'flightDelays','insights', 'worldBrief', 'predictions',
  'iranEvents', 'temporalAnomalies', 'weatherAlerts', 'spending', 'theaterPosture',
]);

const TIER_CACHE = {
  slow: 'public, s-maxage=3600, stale-while-revalidate=600, stale-if-error=3600',
  fast: 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
};
const TIER_CDN_CACHE = {
  slow: 'public, s-maxage=7200, stale-while-revalidate=1800, stale-if-error=7200',
  fast: 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
};

const NEG_SENTINEL = '__WM_NEG__';

// ── Value decompression ────────────────────────────────────────────
// Large Redis values are gzip-compressed by server/_shared/redis.ts when
// WM_REDIS_COMPRESSION=1, stored as a self-describing envelope:
//   { "__wmgz": 1, "d": "<base64-gzip>" }
// Every reader must be compression-aware. This mirrors `decodeFromStorage`
// in server/_shared/redis.ts — bootstrap keeps its own copy because it is a
// deliberately self-contained edge function.
const COMPRESSION_ENVELOPE_KEY = '__wmgz';

function isCompressedEnvelope(v) {
  return (
    typeof v === 'object' && v !== null
    && COMPRESSION_ENVELOPE_KEY in v
    && typeof v.d === 'string'
  );
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function gunzipToString(bytes) {
  const stream = new Response(new Blob([bytes])).body.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

/** Decode a raw Upstash pipeline result. Handles the dual-shape response
 *  (string vs already-parsed object) and the gzip envelope. Returns null on
 *  any failure — caller treats null as a cache miss. */
async function decodeFromStorage(raw) {
  let parsed;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return null; }
  } else {
    parsed = raw;
  }
  if (isCompressedEnvelope(parsed)) {
    try {
      return JSON.parse(await gunzipToString(base64ToBytes(parsed.d)));
    } catch {
      return null;
    }
  }
  return parsed;
}

// ── Redis helpers ──────────────────────────────────────────────────

async function getCachedJsonBatch(keys) {
  const result = new Map();
  if (keys.length === 0) return result;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return result;

  const pipeline = keys.map((k) => ['GET', k]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) return result;

  const data = await resp.json();
  if (!Array.isArray(data)) return result;

  // Decode every result in parallel — `decodeFromStorage` handles both the
  // dual-shape Upstash response and the gzip-envelope format.
  const decoded = await Promise.all(
    data.map((entry) => {
      const raw = entry?.result;
      return raw === undefined || raw === null
        ? Promise.resolve(null)
        : decodeFromStorage(raw);
    }),
  );
  for (let i = 0; i < keys.length; i++) {
    const parsed = decoded[i];
    if (parsed !== null && parsed !== undefined && parsed !== NEG_SENTINEL) {
      result.set(keys[i], parsed);
    }
  }
  return result;
}

async function setCachedJsonBatch(entries, ttlSeconds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || entries.length === 0) return;

  try {
    const pipeline = entries.map(([key, value]) => [
      'SET', key, JSON.stringify(value), 'EX', String(ttlSeconds),
    ]);
    await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn('[bootstrap] Redis backfill write failed:', err?.message || err);
  }
}

// ── Upstream fetch ─────────────────────────────────────────────────

async function fetchUpstreamBootstrap(tier) {
  const url = `${UPSTREAM_BASE}/api/bootstrap?tier=${tier}`;
  // The Vercel region this function ran in. The upstream's Cloudflare appears
  // to block SOME of Vercel's egress IPs (the 401s are intermittent) — logging
  // the region on both success and failure lets us see whether the blocks
  // cluster in one region (e.g. iad1/US), which would explain a region-specific
  // conversion impact while other regions stay healthy.
  const region = process.env.VERCEL_REGION || '-';
  try {
    const resp = await fetch(url, {
      headers: UPSTREAM_HEADERS,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // A bare status code can't tell us WHY upstream rejects us. Capture the
      // body + telling headers so we can distinguish:
      //   • auth failure  → JSON error body and/or `www-authenticate`
      //   • Cloudflare bot-block → `cf-ray` + `cf-mitigated`, HTML "Just a
      //     moment…" / "Attention Required" body, `server: cloudflare`
      //   • rate limiting → `retry-after` / 429-style body
      // Body is truncated + whitespace-collapsed to keep the log line readable.
      const bodyText = await resp.text().catch(() => '');
      const h = (k) => resp.headers.get(k) || '-';
      console.warn(
        `[upstream] bootstrap/${tier} → HTTP ${resp.status} region=${region} ${url} ` +
        `ct="${h('content-type')}" server="${h('server')}" ` +
        `cf-ray=${h('cf-ray')} cf-mitigated=${h('cf-mitigated')} ` +
        `www-authenticate="${h('www-authenticate')}" retry-after=${h('retry-after')} ` +
        `body="${bodyText.slice(0, 300).replace(/\s+/g, ' ').trim()}"`,
      );
      return null;
    }
    const body = await resp.json();
    if (!body?.data) return null;
    const keys = Object.keys(body.data);
    console.log(`[upstream] bootstrap/${tier} → ${keys.length} keys fetched region=${region}`);
    return body.data;
  } catch (err) {
    console.warn(`[upstream] bootstrap/${tier} failed region=${region}:`, err?.message || err);
    return null;
  }
}

// ── Main handler ───────────────────────────────────────────────────

export default async function handler(req) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  const apiKeyResult = validateApiKey(req);
  if (apiKeyResult.required && !apiKeyResult.valid)
    return new Response(JSON.stringify({ error: apiKeyResult.error }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  const url = new URL(req.url);
  const tier = url.searchParams.get('tier');
  let registry;
  if (tier === 'slow' || tier === 'fast') {
    const tierSet = tier === 'slow' ? SLOW_KEYS : FAST_KEYS;
    registry = Object.fromEntries(Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([k]) => tierSet.has(k)));
  } else {
    const requested = url.searchParams.get('keys')?.split(',').filter(Boolean).sort();
    registry = requested
      ? Object.fromEntries(Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([k]) => requested.includes(k)))
      : BOOTSTRAP_CACHE_KEYS;
  }

  const keys = Object.values(registry);
  const names = Object.keys(registry);

  // ① Read our Redis
  let cached;
  try {
    cached = await getCachedJsonBatch(keys);
  } catch {
    cached = new Map();
  }

  // Build initial data + missing list
  const data = {};
  const missing = [];
  for (let i = 0; i < names.length; i++) {
    const val = cached.get(keys[i]);
    if (val !== undefined) data[names[i]] = val;
    else missing.push(names[i]);
  }

  // Per-execution summary so bootstrap isn't a black box on the happy path.
  // Only fires on a cache MISS (cache hits never run the function), but every
  // run now reports how many sections were served from Redis vs missing — and
  // the region — so we can see whether the missing-section pattern clusters in
  // one region (e.g. iad1/US) without having to catch an intermittent upstream 401.
  const region = process.env.VERCEL_REGION || '-';
  console.log(
    `[bootstrap] tier=${tier ?? 'custom'} region=${region} ` +
    `keys=${names.length} present=${names.length - missing.length} missing=${missing.length}` +
    (missing.length ? ` [${missing.join(',')}]` : ''),
  );

  // ② If we have missing keys → backfill from upstream
  if (missing.length > 0 && (tier === 'fast' || tier === 'slow')) {
    const upstreamData = await fetchUpstreamBootstrap(tier);
    if (upstreamData) {
      const backfillEntries = [];
      for (const name of missing) {
        if (upstreamData[name] !== undefined) {
          data[name] = upstreamData[name];
          // Queue Redis write: map logical name → Redis cache key
          const redisKey = BOOTSTRAP_CACHE_KEYS[name];
          if (redisKey) backfillEntries.push([redisKey, upstreamData[name]]);
        }
      }

      // ③ Write backfilled data to our Redis (fire-and-forget, don't block response)
      if (backfillEntries.length > 0) {
        const ttl = UPSTREAM_BACKFILL_TTL[tier] || 600;
        console.log(`[upstream] backfilling ${backfillEntries.length} keys to Redis (TTL: ${ttl}s)`);
        // Use waitUntil-style: don't await, let it complete after response
        setCachedJsonBatch(backfillEntries, ttl).catch(() => {});
      }

      // Recalculate missing
      missing.length = 0;
      for (const name of names) {
        if (data[name] === undefined) missing.push(name);
      }
    }
  }

  const cacheControl = (tier && TIER_CACHE[tier]) || 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900';

  return new Response(JSON.stringify({ data, missing }), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
      'CDN-Cache-Control': (tier && TIER_CDN_CACHE[tier]) || TIER_CDN_CACHE.fast,
    },
  });
}
