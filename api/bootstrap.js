import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { maybePutLkg, getLkg } from './_lkg.js';
// Bootstrap anomalies are reported by the 🛰️ US Edge Probe (it sees the
// no-store/503 from US vantage every 15 min) — the Origin Monitor stays
// quiet for bootstrap and only sends its one-time introduction from here.
import { announceOriginMonitorOnce } from './_slack.js';

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

// stale-if-error is the worst-case safety net: when the origin can't produce a
// fresh bootstrap (Redis degraded), the CDN keeps serving the last KNOWN-GOOD
// response for this long instead of a blank app. Freshness matters far less than
// never going empty, so this is a full day — a sustained overnight Redis outage
// no longer blanks the app (the cause of the 17%→9% conversion drop).
const TIER_CACHE = {
  slow: 'public, s-maxage=3600, stale-while-revalidate=600, stale-if-error=86400',
  fast: 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=86400',
};
const TIER_CDN_CACHE = {
  slow: 'public, s-maxage=7200, stale-while-revalidate=1800, stale-if-error=86400',
  fast: 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=86400',
};

const NEG_SENTINEL = '__WM_NEG__';

// ── Mobile-relevant keys ───────────────────────────────────────────
// The iOS app is the revenue surface, and it renders ONLY these keys
// (verified against the app's Feature screens 2026-06-11; chokepoints
// excluded — the map falls back to its static dataset). Cacheability,
// the hard-down 503, and Slack alerts are all gated on THESE: a response
// missing only web-only keys (BIS, predictions, weather alerts, …) is
// healthy for mobile, so it caches normally and stays silent.
// Trade-off (accepted): such a response pins a degraded WEB dashboard
// for up to s-maxage — mobile correctness is worth more.
const MOBILE_KEYS = new Set([
  // fast tier
  'earthquakes', 'outages', 'serviceStatuses', 'marketQuotes', 'commodityQuotes',
  'macroSignals', 'riskScores', 'theaterPosture', 'insights', 'worldBrief', 'iranEvents',
  // slow tier
  'sectors', 'cryptoQuotes', 'ucdpEvents', 'wildfires', 'naturalEvents', 'cyberThreats',
]);

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

  // One-time Slack self-introduction on the first request after the deploy
  // that ships the Origin Monitor (no-op forever after; see _slack.js).
  await announceOriginMonitorOnce();

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

  // ④ Last-known-good fill — sections still missing after Redis + upstream
  // are restored from the persisted healthy bootstrap (Vercel Blob — a
  // different failure domain from Upstash, so it survives a Redis outage).
  // This is what keeps worldBrief (the premium hook) effectively
  // un-blankable: losing the key now means "serve the ≤48h-old copy",
  // not "hard-down the fast tier".
  const lkgFilled = [];
  if (missing.length > 0 && (tier === 'fast' || tier === 'slow')) {
    const lkg = await getLkg(`bootstrap-${tier}`);
    if (lkg?.payload) {
      for (const name of [...missing]) {
        if (lkg.payload[name] !== undefined) {
          data[name] = lkg.payload[name];
          lkgFilled.push(name);
        }
      }
      if (lkgFilled.length > 0) {
        missing.length = 0;
        for (const name of names) {
          if (data[name] === undefined) missing.push(name);
        }
        console.warn(
          `[bootstrap] LKG fill (${lkg.ageMinutes} min old): [${lkgFilled.join(',')}]` +
          (missing.length ? ` — still missing: [${missing.join(',')}]` : ''),
        );
      }
    }
  }

  // ── Never-cache-empty / worst-case CDN safety ───────────────────────────────
  // A bootstrap degrades when Redis reads miss keys (e.g. the oversized digest /
  // world-brief blobs time out) AND the upstream backfill can't fill them (it has
  // been returning 401) AND the LKG fill above couldn't restore them (Blob copy
  // missing or >48h old). Caching such a response pins a blank/partial app across
  // an entire edge region for the TTL — the conversion killer. So:
  // All judged against MOBILE-relevant keys only (web-only keys never gate):
  //   • Broadly degraded (≥half the tier's MOBILE keys missing → the app's
  //     screens would be largely empty) → 503, so the CDN's stale-if-error
  //     serves the last KNOWN-GOOD full bootstrap.
  //   • CRITICAL key missing (worldBrief — the premium hook the paywall sells)
  //     → also 503, even when everything else is present. A brief-less 200
  //     no-store would be served to users indefinitely with no stale rescue
  //     (stale-if-error only fires on 5xx); a 503 keeps the last full
  //     bootstrap flowing for up to 24h instead.
  //   • Some mobile keys absent (below the half threshold) → 200 but no-store,
  //     so we never overwrite the cached good copy with a partial one.
  //   • Only web-only keys absent, or nothing missing → healthy: cache with
  //     the long stale-if-error window.
  const CRITICAL_KEYS = ['worldBrief'];
  const isTier = tier === 'fast' || tier === 'slow';
  const mobileNames = names.filter((n) => MOBILE_KEYS.has(n));
  const mobileMissing = missing.filter((n) => MOBILE_KEYS.has(n));
  const otherMissing = missing.filter((n) => !MOBILE_KEYS.has(n));
  const criticalMissing = missing.filter((n) => CRITICAL_KEYS.includes(n));
  const hardDown = isTier && mobileNames.length > 0
    && (mobileMissing.length >= Math.ceil(mobileNames.length / 2) || criticalMissing.length > 0);
  if (hardDown) {
    console.error(
      `[bootstrap] DEGRADED hard — ${mobileMissing.length}/${mobileNames.length} mobile keys missing` +
      (criticalMissing.length ? ` (critical: ${criticalMissing.join(',')})` : '') +
      `; returning 503 so the CDN serves last known-good [mobile: ${mobileMissing.join(',')}] [other: ${otherMissing.join(',')}]`,
    );
    return new Response(JSON.stringify({ error: 'Bootstrap temporarily degraded', missing }), {
      status: 503,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  // Persist the healthy bootstrap as last-known-good — only when nothing
  // mobile-relevant is missing AND nothing in it came from the LKG itself
  // (never let stale data re-persist as "known good").
  if (isTier && mobileMissing.length === 0 && lkgFilled.length === 0) {
    await maybePutLkg(`bootstrap-${tier}`, data);
  }

  // Only MOBILE-relevant gaps make a response uncacheable; web-only gaps
  // cache normally (still listed in the response's `missing` for clients).
  // LKG-filled sections are stale data: serve them, but with a SHORT CDN
  // window so old data never enters the long cache and recovery is fast.
  const degraded = mobileMissing.length > 0;
  const lkgServed = lkgFilled.length > 0;
  const cacheControl = degraded
    ? 'no-store'
    : lkgServed
      ? 'public, s-maxage=60'
      : (tier && TIER_CACHE[tier]) || 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=86400';
  const cdnCacheControl = degraded
    ? 'no-store'
    : lkgServed
      ? 'public, s-maxage=60'
      : (tier && TIER_CDN_CACHE[tier]) || TIER_CDN_CACHE.fast;
  if (degraded) {
    console.warn(
      `[bootstrap] partial — ${mobileMissing.length} mobile keys missing, no-store ` +
      `[mobile: ${mobileMissing.join(',')}] [other: ${otherMissing.join(',')}]`,
    );
    // Partial = served live but NOT cacheable, so the CDN's last-known-good
    // copy stops refreshing while this persists. No Slack from here — the
    // US Edge Probe sees the no-store from US vantage and reports it.
  } else if (missing.length > 0) {
    console.log(`[bootstrap] web-only keys missing (cacheable, no alert): [${missing.join(',')}]`);
  }

  // `stale` lists LKG-restored sections (iOS Codable ignores unknown keys;
  // web can surface a "data may be delayed" hint from it later).
  const body = lkgServed ? { data, missing, stale: lkgFilled } : { data, missing };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
      'CDN-Cache-Control': cdnCacheControl,
      ...(lkgServed ? { 'X-WM-Data-Source': 'lkg-fill' } : {}),
    },
  });
}
