import { getCorsHeaders, getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';
import {
  USER_API_KEY_GATEWAY_VALIDATION_ERROR,
  getHeaderApiKey,
  validateApiKey,
} from './_api-key.js';
import { jsonResponse } from './_json-response.js';
import {
  checkBootstrapUserApiKeyRateLimit,
  isCanonicalUserApiKey,
  validateBootstrapUserApiAccess,
  validateBootstrapUserApiKey,
} from './_user-api-key.js';
// @ts-expect-error — JS module, no declaration file
import { redisPipeline } from './_upstash-json.js';
import { unwrapEnvelope } from './_seed-envelope.js';
import { CII_RISK_SCORE_CACHE_KEYS } from './_cii-risk-cache-keys.js';
import { compactWildfireDashboardPayload } from './_wildfire-dashboard.js';

export const config = { runtime: 'edge' };

// Iran-events domain sunset (war ended 2026-07). Default OFF: don't ship the
// domain to the client. Set IRAN_EVENTS_ENABLED=true to restore. See api/health.js.
const IRAN_EVENTS_ENABLED = (process.env.IRAN_EVENTS_ENABLED ?? 'false').toLowerCase() === 'true';

const BOOTSTRAP_CACHE_KEYS = {
  earthquakes:      'seismology:earthquakes:v1',
  outages:          'infra:outages:v1',
  serviceStatuses:  'infra:service-statuses:v1',
  ddosAttacks:      'cf:radar:ddos:v1',
  trafficAnomalies: 'cf:radar:traffic-anomalies:v1',
  marketQuotes:     'market:stocks-bootstrap:v1',
  commodityQuotes:  'market:commodities-bootstrap:v1',
  sectors:          'market:sectors:v2',
  etfFlows:         'market:etf-flows:v1',
  macroSignals:     'economic:macro-signals:v1',
  bisPolicy:        'economic:bis:policy:v1',
  bisExchange:      'economic:bis:eer:v1',
  bisCredit:        'economic:bis:credit:v1',
  bisDsr:           'economic:bis:dsr:v1',
  bisPropertyResidential: 'economic:bis:property-residential:v1',
  bisPropertyCommercial:  'economic:bis:property-commercial:v1',
  imfMacro:         'economic:imf:macro:v2',
  imfGrowth:        'economic:imf:growth:v1',
  imfLabor:         'economic:imf:labor:v1',
  imfExternal:      'economic:imf:external:v1',
  chinaMacro:       'economic:china:macro:v1',
  chinaReleaseCalendar: 'economic:china:release-calendar:v1',
  // plan 2026-04-25-004 Phase 2 (financialSystemExposure data keys):
  // intentionally NOT added here. The 3 new keys
  // (economic:wb-external-debt:v1, economic:bis-lbs:v1,
  //  economic:fatf-listing:v1) are SERVER-ONLY inputs to
  // scoreFinancialSystemExposure — no client-side panel consumes them
  // directly. AGENTS.md's "new data sources must hydrate via bootstrap"
  // applies to keys with `getHydratedData` consumers in src/; the
  // bootstrap-key-hydration-coverage test enforces that invariant. If
  // a future PR adds a client panel that displays raw BIS LBS / FATF /
  // WB external-debt data, register the keys here AND add the
  // corresponding consumer + cache-keys.ts entries in the same PR.
  shippingRates:    'supply_chain:shipping:v2',
  chokepoints:      'supply_chain:chokepoints:v4',
  minerals:         'supply_chain:minerals:v2',
  giving:           'giving:summary:v1',
  climateAnomalies: 'climate:anomalies:v2',
  climateDisasters: 'climate:disasters:v1',
  co2Monitoring: 'climate:co2-monitoring:v1',
  oceanIce: 'climate:ocean-ice:v1',
  climateNews:      'climate:news-intelligence:v1',
  radiationWatch: 'radiation:observations:v1',
  thermalEscalation: 'thermal:escalation:v1',
  crossSourceSignals: 'intelligence:cross-source-signals:v1',
  wildfires:        'wildfire:fires-bootstrap:v1',
  cyberThreats:     'cyber:threats-bootstrap:v2',
  techReadiness:    'economic:worldbank-techreadiness:v1',
  progressData:     'economic:worldbank-progress:v1',
  renewableEnergy:  'economic:worldbank-renewable:v1',
  positiveGeoEvents: 'positive_events:geo-bootstrap:v1',
  theaterPosture: 'theater_posture:sebuf:stale:v1',
  riskScores: CII_RISK_SCORE_CACHE_KEYS.stale,
  naturalEvents: 'natural:events:v1',
  flightDelays: 'aviation:delays-bootstrap:v2',
  insights: 'news:insights:v1',
  predictions: 'prediction:markets-bootstrap:v1',
  cryptoQuotes:     'market:crypto:v1',
  cryptoSectors:    'market:crypto-sectors:v1',
  defiTokens:       'market:defi-tokens:v1',
  aiTokens:         'market:ai-tokens:v1',
  otherTokens:      'market:other-tokens:v1',
  gulfQuotes:       'market:gulf-quotes:v1',
  stablecoinMarkets: 'market:stablecoins:v1',
  unrestEvents: 'unrest:events:v1',
  iranEvents: 'conflict:iran-events:v1',
  ucdpEvents: 'conflict:ucdp-events:v1',
  temporalAnomalies: 'temporal:anomalies:v1',
  weatherAlerts:     'weather:alerts:v1',
  spending:          'economic:spending:v1',
  techEvents:        'research:tech-events-bootstrap:v1',
  gdeltIntel:        'intelligence:gdelt-intel:v1',
  correlationCards:   'correlation:cards-bootstrap:v1',
  forecasts:         'forecast:predictions:v2',
  securityAdvisories: 'intelligence:advisories-bootstrap:v1',
  customsRevenue:    'trade:customs-revenue:v1',
  sanctionsPressure: 'sanctions:pressure:v1',
  consumerPricesOverview:   'consumer-prices:overview:ae',
  consumerPricesCategories: 'consumer-prices:categories:ae:30d',
  consumerPricesMovers:     'consumer-prices:movers:ae:30d',
  consumerPricesSpread:     'consumer-prices:retailer-spread:ae:essentials-ae',
  groceryBasket: 'economic:grocery-basket:v1',
  bigmac:        'economic:bigmac:v1',
  fuelPrices:    'economic:fuel-prices:v1',
  faoFoodPriceIndex: 'economic:fao-ffpi:v1',
  nationalDebt:      'economic:national-debt:v1',
  euGasStorage:      'economic:eu-gas-storage:v1',
  eurostatCountryData: 'economic:eurostat-country-data:v1',
  eurostatHousePrices: 'economic:eurostat:house-prices:v1',
  eurostatGovDebtQ:    'economic:eurostat:gov-debt-q:v1',
  eurostatIndProd:     'economic:eurostat:industrial-production:v1',
  marketImplications: 'intelligence:market-implications:v1',
  fearGreedIndex:    'market:fear-greed:v1',
  hyperliquidFlow:   'market:hyperliquid:flow:v1',
  crudeInventories:  'economic:crude-inventories:v1',
  natGasStorage:     'economic:nat-gas-storage:v1',
  ecbFxRates:        'economic:ecb-fx-rates:v1',
  euFsi:             'economic:fsi-eu:v1',
  shippingStress:    'supply_chain:shipping_stress:v1',
  socialVelocity:    'intelligence:social:reddit:v1',
  wsbTickers:        'intelligence:wsb-tickers:v1',
  pizzint:           'intelligence:pizzint:seed:v1',
  diseaseOutbreaks:  'health:disease-outbreaks:v1',
  economicStress:    'economic:stress-index:v1',
  electricityPrices:    'energy:electricity:v1:index',
  jodiOil:              'energy:jodi-oil:v1:_countries',
  chokepointBaselines:  'energy:chokepoint-baselines:v1',
  portwatchChokepointsRef: 'portwatch:chokepoints:ref:v1',
  portwatchPortActivity: 'supply_chain:portwatch-ports:v1:_countries',
  oilStocksAnalysis:    'energy:oil-stocks-analysis:v1',
  lngVulnerability:     'energy:lng-vulnerability:v1',
  sprPolicies:          'energy:spr-policies:v1',
  pipelinesGas:         'energy:pipelines:gas:v1',
  pipelinesOil:         'energy:pipelines:oil:v1',
  storageFacilities:    'energy:storage-facilities:v1',
  fuelShortages:        'energy:fuel-shortages:v1',
  energyDisruptions:    'energy:disruptions:v1',
  energyCrisisPolicies: 'energy:crisis-policies:v1',
  aaiiSentiment:        'market:aaii-sentiment:v1',
  breadthHistory:       'market:breadth-history:v1',
};

const SLOW_KEYS = new Set([
  'bisPolicy', 'bisExchange', 'bisCredit',
  'bisDsr', 'bisPropertyResidential', 'bisPropertyCommercial',
  'imfMacro', 'imfGrowth', 'imfLabor', 'imfExternal', 'chinaMacro', 'chinaReleaseCalendar', 'minerals', 'giving',
  'sectors', 'etfFlows', 'wildfires', 'climateAnomalies', 'climateDisasters', 'co2Monitoring', 'oceanIce', 'climateNews',
  'radiationWatch', 'thermalEscalation', 'crossSourceSignals',
  'cyberThreats', 'techReadiness', 'progressData', 'renewableEnergy',
  'naturalEvents',
  'cryptoQuotes', 'cryptoSectors', 'defiTokens', 'aiTokens', 'otherTokens',
  'gulfQuotes', 'stablecoinMarkets', 'unrestEvents', 'ucdpEvents',
  'techEvents',
  'securityAdvisories',
  'customsRevenue',
  'sanctionsPressure',
  'consumerPricesOverview', 'consumerPricesCategories', 'consumerPricesMovers', 'consumerPricesSpread',
  'groceryBasket',
  'bigmac',
  'fuelPrices',
  'faoFoodPriceIndex',
  'nationalDebt',
  'euGasStorage',
  'eurostatCountryData',
  'eurostatHousePrices',
  'eurostatGovDebtQ',
  'eurostatIndProd',
  'marketImplications',
  'fearGreedIndex',
  'hyperliquidFlow',
  'crudeInventories',
  'natGasStorage',
  'ecbFxRates',
  'euFsi',
  'diseaseOutbreaks',
  'economicStress',
  'pizzint',
  'electricityPrices',
  'jodiOil',
  'chokepointBaselines',
  'portwatchChokepointsRef',
  'portwatchPortActivity',
  'oilStocksAnalysis',
  'lngVulnerability',
  'sprPolicies',
  'pipelinesGas',
  'pipelinesOil',
  'storageFacilities',
  'fuelShortages',
  'energyDisruptions',
  'energyCrisisPolicies',
  'aaiiSentiment',
  'breadthHistory',
]);
const FAST_KEYS = new Set([
  'earthquakes', 'outages', 'serviceStatuses', 'ddosAttacks', 'trafficAnomalies', 'macroSignals', 'chokepoints',
  'marketQuotes', 'commodityQuotes', 'positiveGeoEvents', 'riskScores', 'flightDelays','insights', 'predictions',
  'iranEvents', 'temporalAnomalies', 'weatherAlerts', 'spending', 'theaterPosture', 'gdeltIntel',
  'correlationCards', 'forecasts', 'shippingRates', 'shippingStress', 'socialVelocity', 'wsbTickers',
]);

// Iran-events sunset: strip the domain from the bootstrap payload + fast tier
// when disabled (default), so the client never hydrates it.
if (!IRAN_EVENTS_ENABLED) {
  delete BOOTSTRAP_CACHE_KEYS.iranEvents;
  FAST_KEYS.delete('iranEvents');
}

// No public/s-maxage: CF (in front of api.worldmonitor.app) ignores Vary: Origin and would
// pin ACAO: worldmonitor.app on cached responses, breaking CORS for preview deployments.
// Vercel CDN caching is handled by TIER_CDN_CACHE via CDN-Cache-Control below.
const TIER_CACHE = {
  slow: 'max-age=300, stale-while-revalidate=600, stale-if-error=3600',
  fast: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
};
const TIER_CDN_CACHE = {
  slow: 'public, s-maxage=7200, stale-while-revalidate=1800, stale-if-error=7200',
  fast: 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
};

export function isPublicWeatherBootstrapRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const url = new URL(req.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (pathname !== '/api/bootstrap') return false;

  const params = Array.from(url.searchParams.keys());
  if (params.some((key) => key !== 'keys')) return false;

  const keyParams = url.searchParams.getAll('keys');
  if (keyParams.length !== 1) return false;

  const requested = keyParams[0].split(',').map((key) => key.trim()).filter(Boolean);
  return requested.length === 1 && requested[0] === 'weatherAlerts';
}

const PUBLIC_BOOTSTRAP_TIERS = new Set(['fast', 'slow']);

// An explicit public tier bootstrap read (?tier=fast|slow&public=1, no other
// params) returns the shared
// production seed payload — identical for every caller (see PR #4499 non-goals:
// only static transforms like wildfire compaction / enrichmentMeta strip apply,
// never per-user variance). The explicit marker gives the shared response its
// own CDN cache key; the legacy ?tier=fast|slow URLs remain credentialed and
// no-store, so a warmed public response cannot bypass their auth/CORS contract.
// The public URL is public regardless of request credentials because a CDN hit
// occurs before handler auth. Callers that need credential processing must use
// the legacy URL. Scoped to the two fixed public shapes so the CDN key space
// stays tiny and hit rate high.
//
// GET only: a HEAD here would still run the full registry Redis read to build a
// body it must not return — the exact unshielded egress this path exists to
// avoid. HEAD tier reads have no client and fall through to the no-store path.
export function isPublicTierBootstrapRequest(req) {
  if (req.method !== 'GET') return false;

  const url = new URL(req.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (pathname !== '/api/bootstrap') return false;

  const params = Array.from(url.searchParams.keys());
  if (params.some((key) => key !== 'tier' && key !== 'public')) return false;

  const tierParams = url.searchParams.getAll('tier');
  const publicParams = url.searchParams.getAll('public');
  if (tierParams.length !== 1 || publicParams.length !== 1 || publicParams[0] !== '1') return false;

  return PUBLIC_BOOTSTRAP_TIERS.has(tierParams[0]);
}

const BOOTSTRAP_CREDENTIAL_COOKIES = new Set(['wm-session', 'wm-pro-key', 'wm-widget-key']);

function hasBootstrapCredentialCookie(req) {
  const raw = req.headers.get('Cookie') || req.headers.get('cookie') || '';
  if (!raw) return false;

  for (const part of raw.split(';')) {
    const name = part.trim().split('=', 1)[0];
    if (BOOTSTRAP_CREDENTIAL_COOKIES.has(name)) return true;
  }
  return false;
}

const NEG_SENTINEL = '__WM_NEG__';
export const compactWildfireBootstrapPayload = compactWildfireDashboardPayload;

async function getCachedJsonBatch(keys) {
  const result = new Map();
  if (keys.length === 0) return result;

  // Always read unprefixed keys — bootstrap is a read-only consumer of
  // production cache data. Preview/branch deploys don't run handlers that
  // populate prefixed keys, so prefixing would always miss.
  const pipeline = keys.map((k) => ['GET', k]);
  const data = await redisPipeline(pipeline, 3000);
  if (!Array.isArray(data) || data.length !== keys.length) {
    throw new Error('Bootstrap Redis pipeline unavailable');
  }

  for (let i = 0; i < keys.length; i++) {
    const entry = data[i];
    if (
      !entry
      || typeof entry !== 'object'
      || !('result' in entry)
      || entry.error != null
    ) {
      throw new Error('Bootstrap Redis pipeline command failed');
    }
    const raw = entry.result;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed === NEG_SENTINEL) continue;
        // Envelope-aware: bootstrap is a public-boundary consumer — strip _seed
        // from contract-mode canonical keys so clients never see envelope
        // metadata. Legacy bare-shape values pass through unchanged.
        result.set(keys[i], unwrapEnvelope(parsed).data);
      } catch { /* skip malformed */ }
    }
  }
  return result;
}

function authFailure(body, status, cors, extraHeaders = {}) {
  // no-store is spread last so a caller-supplied Cache-Control in extraHeaders
  // can never weaken the non-cacheable posture of an auth-failure response.
  return jsonResponse(body, status, {
    ...cors,
    ...extraHeaders,
    'Cache-Control': 'no-store',
  });
}

async function validateBootstrapAuth(req, cors) {
  const headerKey = getHeaderApiKey(req);
  // The explicit public URL must have one response contract for every request:
  // Vercel may serve it from cache before cookie/header auth reaches this code.
  if (isPublicTierBootstrapRequest(req)) {
    return { ok: true, kind: 'public-tier' };
  }
  if (!headerKey && !hasBootstrapCredentialCookie(req)) {
    if (isPublicWeatherBootstrapRequest(req)) {
      return { ok: true, kind: 'public-weather' };
    }
  }

  const apiKeyResult = await validateApiKey(req);
  if (!apiKeyResult.required || apiKeyResult.valid) {
    return { ok: true, kind: apiKeyResult.kind || 'unknown' };
  }

  if (apiKeyResult.error === USER_API_KEY_GATEWAY_VALIDATION_ERROR && headerKey.startsWith('wm_')) {
    if (!isCanonicalUserApiKey(headerKey)) {
      return {
        ok: false,
        response: authFailure({ error: 'Invalid API key' }, 401, cors),
      };
    }

    const rateLimitResult = await checkBootstrapUserApiKeyRateLimit(req);
    if (!rateLimitResult.ok) {
      return {
        ok: false,
        response: authFailure(
          { error: rateLimitResult.error },
          rateLimitResult.status,
          cors,
          rateLimitResult.headers,
        ),
      };
    }

    // Propagate the validation result's status/error/headers (all generic,
    // leak-free strings) rather than hardcoding 401/403: a Convex outage surfaces
    // as a retryable 503 + Retry-After (status 503, unavailable:true) instead of
    // a misleading "Invalid API key" 401, mirroring the rate-limit path above.
    const userKeyResult = await validateBootstrapUserApiKey(headerKey);
    if (!userKeyResult.ok) {
      return {
        ok: false,
        response: authFailure(
          { error: userKeyResult.error },
          userKeyResult.status,
          cors,
          userKeyResult.headers,
        ),
      };
    }

    const entitlementResult = await validateBootstrapUserApiAccess(userKeyResult.userId);
    if (!entitlementResult.ok) {
      return {
        ok: false,
        response: authFailure(
          { error: entitlementResult.error },
          entitlementResult.status,
          cors,
          entitlementResult.headers,
        ),
      };
    }

    return { ok: true, kind: 'user' };
  }

  const error = apiKeyResult.error === USER_API_KEY_GATEWAY_VALIDATION_ERROR
    ? 'Invalid API key'
    : apiKeyResult.error;
  return {
    ok: false,
    response: authFailure({ error }, 401, cors),
  };
}

function isPublicBootstrapKind(authKind) {
  return authKind === 'public-weather' || authKind === 'public-tier';
}

function successCacheHeaders(tier, authKind, cors) {
  if (!isPublicBootstrapKind(authKind)) {
    return {
      ...cors,
      'Cache-Control': 'no-store',
    };
  }

  // Public seed payload with no per-user variation: serve with ACAO:* (no
  // Vary: Origin, no Access-Control-Allow-Credentials) so the shared CDN stores
  // ONE entry per URL instead of one per Origin, and no preview/embed origin can
  // pin an echoed ACAO onto a cached response. Safe because isDisallowedOrigin()
  // already rejected unauthorized origins at the handler entry (this is exactly
  // the contract getPublicCorsHeaders documents).
  const publicCors = getPublicCorsHeaders();
  const cacheControl = (tier && TIER_CACHE[tier]) || 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900';
  return {
    ...publicCors,
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': (tier && TIER_CDN_CACHE[tier]) || TIER_CDN_CACHE.fast,
  };
}

export default async function handler(req) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  const auth = await validateBootstrapAuth(req, cors);
  if (!auth.ok) return auth.response;

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

  let cached;
  try {
    cached = await getCachedJsonBatch(keys);
  } catch {
    const isPublic = isPublicBootstrapKind(auth.kind);
    if (isPublic) {
      // Infrastructure failure is not an empty registry. Make it retryable and
      // omit every CDN cache header so the outage response cannot replace a
      // healthy public snapshot at the shared cache key.
      return jsonResponse(
        { error: 'Bootstrap service temporarily unavailable' },
        503,
        {
          ...getPublicCorsHeaders(),
          'Cache-Control': 'no-store',
          'Retry-After': '5',
        },
      );
    }
    return jsonResponse({ data: {}, missing: names }, 200, { ...cors, 'Cache-Control': 'no-store' });
  }

  const data = {};
  const missing = [];
  for (let i = 0; i < names.length; i++) {
    const val = cached.get(keys[i]);
    if (val !== undefined) {
      let responseValue = val;
      // Strip seed-internal metadata not intended for API clients
      if (names[i] === 'forecasts' && val != null && 'enrichmentMeta' in val) {
        const { enrichmentMeta: _stripped, ...rest } = val;
        responseValue = rest;
      }
      if (names[i] === 'wildfires') responseValue = compactWildfireBootstrapPayload(responseValue);
      data[names[i]] = responseValue;
    } else {
      missing.push(names[i]);
    }
  }

  // The browser runtime sends API requests with credentials so session and
  // entitlement cookies can ride along. Credentialed requests cannot consume
  // ACAO: * responses, even for public bootstrap data.
  return jsonResponse({ data, missing }, 200, successCacheHeaders(tier, auth.kind, cors));
}
