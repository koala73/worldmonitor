import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash, redisPipeline as rawRedisPipeline, getRedisCredentials } from './_upstash-json.js';
// @ts-expect-error — JS module, no declaration file
import { resolveBearerToContext } from './_oauth-token.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes } from './_crypto.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import COUNTRY_BBOXES from '../shared/country-bboxes.js';
// @ts-expect-error — generated JS module, no declaration file
import MINING_SITES_RAW from '../shared/mining-sites.js';
import { getEntitlements } from '../server/_shared/entitlement-check';
import {
  validateProMcpTokenOrNull,
  dailyCounterKey,
  secondsUntilUtcMidnight,
  PRO_DAILY_QUOTA_LIMIT,
  PRO_DAILY_QUOTA_TTL_SECONDS,
} from '../server/_shared/pro-mcp-token';
import {
  signInternalMcpRequest,
  buildInternalMcpHeaders,
} from '../server/_shared/mcp-internal-hmac';

export const config = { runtime: 'edge' };

const MCP_PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'worldmonitor';
const SERVER_VERSION = '1.0';

// Country-code whitelist for get_consumer_prices. The consumer-prices seeder
// currently only produces data for AE (UAE); future markets will be added
// here as they're seeded. Kept near COUNTRY_BBOXES (the other ISO-3166 alpha-2
// lookup table used by tools) so adding a market is a single-file change.
const SUPPORTED_CONSUMER_PRICES_COUNTRIES = new Set(['ae']);

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
//   - Legacy per-key 60/min (Starter+ env-key bearers): prefix `rl:mcp`,
//     keyed `key:<apiKey>`. Unchanged from pre-U7.
//   - Pro per-user 60/min: prefix `rl:mcp:pro-min`, keyed `pro-user:<userId>`.
//     Independent limiter so a Pro user with two Claude installations sees
//     combined 60/min across both bearers (same userId).
// ---------------------------------------------------------------------------

let mcpRatelimit: Ratelimit | null = null;
let mcpProMinRatelimit: Ratelimit | null = null;

function getMcpRatelimit(): Ratelimit | null {
  if (mcpRatelimit) return mcpRatelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  mcpRatelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'rl:mcp',
    analytics: false,
  });
  return mcpRatelimit;
}

function getMcpProMinRatelimit(): Ratelimit | null {
  if (mcpProMinRatelimit) return mcpProMinRatelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  mcpProMinRatelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'rl:mcp:pro-min',
    analytics: false,
  });
  return mcpProMinRatelimit;
}

// ---------------------------------------------------------------------------
// Auth-context shape passed into tool _execute. U7 widened the previous
// `apiKey: string` to a discriminated union so per-tool fetches can branch
// header construction (`X-WorldMonitor-Key` for env_key, internal-HMAC for
// Pro) from a single point.
// ---------------------------------------------------------------------------

export type McpAuthContext =
  | { kind: 'env_key'; apiKey: string }
  | { kind: 'pro'; userId: string; mcpTokenId: string };

/**
 * Build the Authorization header set for a downstream `_execute` fetch.
 *
 *   - env_key → `X-WorldMonitor-Key: <apiKey>` (existing, unchanged).
 *   - pro     → `X-WM-MCP-Internal: <ts>.<sig>` + `X-WM-MCP-User-Id: <userId>`.
 *               Signature binds method+pathname+queryHash+bodyHash+userId.
 *
 * `body` MUST be the EXACT bytes the caller passes to `fetch()` so the
 * signed payload matches the wire bytes. For JSON, pre-stringify on the
 * caller side and pass the same string here.
 */
async function buildAuthHeaders(
  context: McpAuthContext,
  method: string,
  url: string,
  body: BodyInit | null | undefined,
): Promise<Record<string, string>> {
  if (context.kind === 'env_key') {
    return { 'X-WorldMonitor-Key': context.apiKey };
  }
  // context.kind === 'pro'
  const secret = process.env.MCP_INTERNAL_HMAC_SECRET ?? '';
  if (!secret) {
    // Should never happen in production (deploy gate at U10) — surface as
    // an error so the tool fetch fails fast rather than silently 401-ing
    // at the gateway with a confusing "invalid_internal_mcp_signature".
    throw new Error('MCP_INTERNAL_HMAC_SECRET not configured');
  }
  const signed = await signInternalMcpRequest({
    method,
    url,
    body,
    userId: context.userId,
    secret,
  });
  return buildInternalMcpHeaders(signed);
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------
interface BaseToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

interface FreshnessCheck {
  key: string;
  maxStaleMin: number;
}

// Cache-read tool: reads one or more Redis keys and returns them with staleness info.
interface CacheToolDef extends BaseToolDef {
  _cacheKeys: string[];
  _seedMetaKey: string;
  _maxStaleMin: number;
  _freshnessChecks?: FreshnessCheck[];
  _execute?: never;
  // U3 (Tier-4 parity): REQUIRED. Every OpenAPI operation served by this
  // tool's cache keys ("METHOD path") so the U5 MCP↔API parity test can
  // verify every op in docs/api/*.openapi.json is covered by some tool's
  // `_apiPaths` or explicitly excluded. Empty `[]` is valid for tools
  // whose cache keys aren't served by any OpenAPI op (bootstrap aggregates).
  _apiPaths: string[];
}

// AI inference tool: calls an internal RPC endpoint and returns the raw response.
// Hybrid variant: when an _execute tool also reads cache keys directly
// (e.g. parameterised by country_code), it MAY declare `_coverageKeys` so the
// U7 Tier 3 parity test can verify that every BOOTSTRAP_KEYS/STANDALONE_KEYS
// entry it owns is covered by some tool — cache-tool's `_cacheKeys` and
// hybrid _execute's `_coverageKeys` are equivalent for that audit.
interface RpcToolDef extends BaseToolDef {
  _cacheKeys?: never;
  _seedMetaKey?: never;
  _maxStaleMin?: never;
  _freshnessChecks?: never;
  _execute: (params: Record<string, unknown>, base: string, context: McpAuthContext) => Promise<unknown>;
  _coverageKeys?: string[];
  // U3 (Tier-4 parity): REQUIRED. Every OpenAPI operation this `_execute`
  // body proxies via fetch (extracted from `${base}/api/...` callsites),
  // using the OPENAPI-declared method (not the runtime fetch method) so the
  // parity test's source-of-truth is the public spec.
  //
  // Empty `[]` is valid ONLY when:
  //   (a) The tool hits no HTTP endpoint at all (e.g. AI tools reading a
  //       static JSON registry — see get_commodity_geo), OR
  //   (b) The tool's _execute fetches an endpoint whose runtime method
  //       drifts from the OpenAPI spec AND no covering op exists in the
  //       spec (e.g. generate_forecasts POSTs /api/forecast/v1/get-forecasts
  //       but the spec declares only GET — that GET is owned by
  //       get_forecast_predictions). Document the drift inline; an EXCLUDED
  //       entry is the wrong fix (the op IS covered, just via a sibling
  //       tool with matching method).
  //
  // A new tool whose POST endpoint IS in the spec MUST list it here —
  // don't default to `[]` when the spec actually exposes the path.
  _apiPaths: string[];
}

type ToolDef = CacheToolDef | RpcToolDef;

const TOOL_REGISTRY: ToolDef[] = [
  {
    name: 'get_market_data',
    description: 'Real-time equity quotes, commodity prices (including gold futures GC=F), crypto prices, forex FX rates (USD/EUR, USD/JPY etc.), sector performance, ETF flows, and Gulf market quotes from WorldMonitor\'s curated bootstrap cache.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'market:stocks-bootstrap:v1',
      'market:commodities-bootstrap:v1',
      'market:crypto:v1',
      'market:sectors:v2',
      'market:etf-flows:v1',
      'market:gulf-quotes:v1',
      'market:fear-greed:v1',
    ],
    _seedMetaKey: 'seed-meta:market:stocks',
    _maxStaleMin: 30,
    // NOTE: `GET /api/market/v1/get-gold-intelligence` is NOT covered here.
    // The audit-time cross-reference matched on the single `market:commodities-bootstrap:v1`
    // key shared between this tool and the gold-intel handler, but the handler also reads 4
    // gold-specific keys (COT, gold-extended, gold-ETF-flows, gold-CB-reserves) that this
    // tool's `_cacheKeys` does NOT expose. Excluded as `deferred-to-future-tool` in
    // tests/mcp-api-parity.test.mjs until a future commodities-expansion tool bundles those.
    _apiPaths: [
      "GET /api/market/v1/get-fear-greed-index",
      "GET /api/market/v1/get-sector-summary",
      "GET /api/market/v1/list-commodity-quotes",
      "GET /api/market/v1/list-crypto-quotes",
      "GET /api/market/v1/list-etf-flows",
      "GET /api/market/v1/list-gulf-quotes",
      "GET /api/market/v1/list-market-quotes",
    ],
  },
  {
    name: 'get_conflict_events',
    description: 'Active armed conflict events (UCDP, Iran), unrest events with geo-coordinates, and country risk scores. Covers ongoing conflicts, protests, and instability indices worldwide.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'conflict:ucdp-events:v1',
      'conflict:iran-events:v1',
      'unrest:events:v1',
      'risk:scores:sebuf:stale:v1',
    ],
    _seedMetaKey: 'seed-meta:conflict:ucdp-events',
    _maxStaleMin: 30,
    // NOTE: `GET /api/intelligence/v1/get-risk-scores` is NOT covered here.
    // The audit-time hint matched on 3 keys (conflict:ucdp-events:v1,
    // conflict:iran-events:v1, risk:scores:sebuf:stale:v1) but the handler at
    // server/worldmonitor/intelligence/v1/get-risk-scores.ts:242-256 reads 12
    // cross-domain keys (infra outages, climate anomalies, cyber threats,
    // wildfires, GPS jamming, OREF history, security advisories, displacement,
    // news insights, news threats). Excluded as `deferred-to-future-tool` —
    // belongs in a future expanded_risk_scores composite tool, not here.
    _apiPaths: [
      "GET /api/conflict/v1/list-iran-events",
      "GET /api/conflict/v1/list-ucdp-events",
      "GET /api/unrest/v1/list-unrest-events",
    ],
  },
  {
    name: 'get_aviation_status',
    description: 'Airport delays, NOTAM airspace closures, and tracked military aircraft. Covers FAA delay data and active airspace restrictions.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['aviation:delays-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:aviation:faa',
    _maxStaleMin: 90,
    _apiPaths: [],
  },
  {
    name: 'get_news_intelligence',
    description: 'AI-classified geopolitical threat news summaries, GDELT intelligence signals, cross-source signals, and security advisories from WorldMonitor\'s intelligence layer.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'news:insights:v1',
      'intelligence:gdelt-intel:v1',
      'intelligence:cross-source-signals:v1',
      'intelligence:advisories-bootstrap:v1',
    ],
    _seedMetaKey: 'seed-meta:news:insights',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/intelligence/v1/list-cross-source-signals",
      "GET /api/intelligence/v1/search-gdelt-documents",
    ],
  },
  {
    name: 'get_natural_disasters',
    description: 'Recent earthquakes (USGS), active wildfires (NASA FIRMS), and natural hazard events. Includes magnitude, location, and threat severity.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'seismology:earthquakes:v1',
      'wildfire:fires:v1',
      'natural:events:v1',
    ],
    _seedMetaKey: 'seed-meta:seismology:earthquakes',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/natural/v1/list-natural-events",
      "GET /api/seismology/v1/list-earthquakes",
      "GET /api/wildfire/v1/list-fire-detections",
    ],
  },
  {
    name: 'get_military_posture',
    description: 'Theater posture assessment and military risk scores. Reflects aggregated military positioning and escalation signals across global theaters.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['theater_posture:sebuf:stale:v1'],
    _seedMetaKey: 'seed-meta:intelligence:risk-scores',
    _maxStaleMin: 120,
    // CASCADE-MIRROR EQUIVALENCE: the API handler at
    // server/worldmonitor/military/v1/get-theater-posture.ts:23 reads 3 cascade
    // variants (live + stale + backup) and returns the freshest available.
    // This MCP tool reads only the stale variant; PR #3658's U7 already
    // documents `theater-posture:sebuf:v1` and `theater-posture:sebuf:backup:v1`
    // as `cascade-mirror: covered by get_military_posture` exclusions in the
    // bootstrap-parity test — they share the same payload shape, only freshness
    // differs. Coverage is intentional. The audit script's partial-overlap
    // warning for this op is suppressed via CASCADE_MIRROR_EXEMPT in
    // scripts/audit-mcp-api-coverage.mjs.
    _apiPaths: [
      "GET /api/military/v1/get-theater-posture",
    ],
  },
  {
    name: 'get_cyber_threats',
    description: 'Active cyber threat intelligence: malware IOCs (URLhaus, Feodotracker), CISA known exploited vulnerabilities, and active command-and-control infrastructure.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['cyber:threats-bootstrap:v2'],
    _seedMetaKey: 'seed-meta:cyber:threats',
    _maxStaleMin: 240,
    _apiPaths: [],
  },
  {
    name: 'get_economic_data',
    description: 'Macro economic indicators: Fed Funds rate (FRED), economic calendar events, fuel prices, ECB FX rates, EU yield curve, earnings calendar, COT positioning, energy storage data, BIS household debt service ratio (DSR, quarterly, leading indicator of household financial stress across ~40 advanced economies), and BIS residential + commercial property price indices (real, quarterly).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'economic:fred:v1:FEDFUNDS:0',
      'economic:econ-calendar:v1',
      'economic:fuel-prices:v1',
      'economic:ecb-fx-rates:v1',
      'economic:yield-curve-eu:v1',
      'economic:spending:v1',
      'market:earnings-calendar:v1',
      'market:cot:v1',
      'economic:bis:dsr:v1',
      'economic:bis:property-residential:v1',
      'economic:bis:property-commercial:v1',
    ],
    _seedMetaKey: 'seed-meta:economic:econ-calendar',
    _maxStaleMin: 1440,
    _freshnessChecks: [
      { key: 'seed-meta:economic:econ-calendar', maxStaleMin: 1440 },
      // Per-dataset BIS seed-meta keys — the aggregate
      // `seed-meta:economic:bis-extended` would report "fresh" even if only
      // one of the three datasets (DSR / SPP / CPP) is current, matching the
      // false-freshness bug already fixed for /api/health and resilience.
      { key: 'seed-meta:economic:bis-dsr', maxStaleMin: 1440 }, // 12h cron × 2
      { key: 'seed-meta:economic:bis-property-residential', maxStaleMin: 1440 },
      { key: 'seed-meta:economic:bis-property-commercial', maxStaleMin: 1440 },
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-ecb-fx-rates",
      "GET /api/economic/v1/get-economic-calendar",
      "GET /api/economic/v1/get-eu-yield-curve",
      "GET /api/economic/v1/list-fuel-prices",
      "GET /api/market/v1/get-cot-positioning",
      "GET /api/market/v1/list-earnings-calendar",
    ],
  },
  {
    name: 'get_country_macro',
    description: 'Per-country macroeconomic indicators from IMF WEO (~210 countries, monthly cadence). Bundles fiscal/external balance (inflation, current account, gov revenue/expenditure/primary balance, CPI), growth & per-capita (real GDP growth, GDP/capita USD & PPP, savings & investment rates, savings-investment gap), labor & demographics (unemployment, population), and external trade (current account USD, import/export volume % changes). Latest available year per series. Use for country-level economic screening, peer benchmarking, and stagflation/imbalance flags. NOTE: export/import LEVELS in USD (exportsUsd, importsUsd, tradeBalanceUsd) are returned as null — WEO retracted broad coverage for BX/BM indicators in 2026-04; use currentAccountUsd or volume changes (import/exportVolumePctChg) instead.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'economic:imf:macro:v2',
      'economic:imf:growth:v1',
      'economic:imf:labor:v1',
      'economic:imf:external:v1',
    ],
    _seedMetaKey: 'seed-meta:economic:imf-macro',
    _maxStaleMin: 100800, // monthly WEO release; 70d = 2× interval (absorbs one missed run)
    _freshnessChecks: [
      { key: 'seed-meta:economic:imf-macro', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-growth', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-labor', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-external', maxStaleMin: 100800 },
    ],
    _apiPaths: [],
  },
  {
    name: 'get_eu_housing_cycle',
    description: 'Eurostat annual house price index (prc_hpi_a, base 2015=100) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes the latest value, prior value, date, unit, and a 10-year sparkline series. Complements BIS WS_SPP with broader EU coverage for the Housing cycle tile.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['economic:eurostat:house-prices:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-house-prices',
    _maxStaleMin: 60 * 24 * 50, // weekly cron, annual data
    _apiPaths: [],
  },
  {
    name: 'get_eu_quarterly_gov_debt',
    description: 'Eurostat quarterly general government gross debt (gov_10q_ggdebt, %GDP) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes latest value, prior value, quarter label, and an 8-quarter sparkline series. Provides fresher debt-trajectory signal than annual IMF GGXWDG_NGDP for EU panels.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['economic:eurostat:gov-debt-q:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-gov-debt-q',
    _maxStaleMin: 60 * 24 * 14, // quarterly data, 2-day cron
    _apiPaths: [],
  },
  {
    name: 'get_eu_industrial_production',
    description: 'Eurostat monthly industrial production index (sts_inpr_m, NACE B-D industry excl. construction, SCA, base 2021=100) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes latest value, prior value, month label, and a 12-month sparkline series. Leading indicator of real-economy activity used by the "Real economy pulse" sparkline.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['economic:eurostat:industrial-production:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-industrial-production',
    _maxStaleMin: 60 * 24 * 5, // monthly data, daily cron
    _apiPaths: [],
  },
  {
    name: 'get_prediction_markets',
    description: 'Active Polymarket event contracts with current probabilities. Covers geopolitical, economic, and election prediction markets.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['prediction:markets-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:prediction:markets',
    _maxStaleMin: 90,
    _apiPaths: [
      "GET /api/prediction/v1/list-prediction-markets",
    ],
  },
  {
    name: 'get_sanctions_data',
    description: 'OFAC SDN sanctioned entities list and sanctions pressure scores by country. Useful for compliance screening and geopolitical pressure analysis.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['sanctions:entities:v1', 'sanctions:pressure:v1'],
    _seedMetaKey: 'seed-meta:sanctions:entities',
    _maxStaleMin: 1440,
    _apiPaths: [
      "GET /api/sanctions/v1/list-sanctions-pressure",
      "GET /api/sanctions/v1/lookup-sanction-entity",
    ],
  },
  {
    name: 'get_displacement_data',
    description: 'Refugee and IDP counts by country (UNHCR annual data).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    // Dynamic-year key resolved once at module evaluation — mirrors the
    // STANDALONE_KEYS pattern in api/health.js:147. The UNHCR seeder publishes
    // a single current-year key; the prior year exists at the same prefix but
    // is intentionally excluded — the executeTool label-walk would strip the
    // year segment from both keys and collide on the same `summary` label,
    // causing the second result to overwrite the first.
    _cacheKeys: [`displacement:summary:v1:${new Date().getUTCFullYear()}`],
    _seedMetaKey: 'seed-meta:displacement:summary',
    _maxStaleMin: 3600,
    // Audit miss: handler uses cachedFetchJson with a year-suffixed key the
    // audit's regex couldn't statically resolve. The op IS covered by this
    // tool — same underlying displacement:summary:v1:<year> cache.
    _apiPaths: [
      'GET /api/displacement/v1/get-displacement-summary',
    ],
  },
  {
    name: 'get_health_signals',
    description: 'Active disease outbreaks (WHO/ECDC etc.) and global air-quality station readings (OpenAQ/WAQI PM2.5). For health-risk screening.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    // Uses the health-domain canonical key health:air-quality:v1 (NOT the
    // climate-domain mirror climate:air-quality:v1, which stays exclusively
    // in get_climate_data). Both are written by the same seeder
    // (scripts/seed-health-air-quality.mjs exports HEALTH_AIR_QUALITY_KEY +
    // CLIMATE_AIR_QUALITY_KEY) so no duplicate seed work.
    _cacheKeys: ['health:disease-outbreaks:v1', 'health:air-quality:v1'],
    _seedMetaKey: 'seed-meta:health:disease-outbreaks',
    _maxStaleMin: 2880,
    _freshnessChecks: [
      { key: 'seed-meta:health:disease-outbreaks', maxStaleMin: 2880 }, // daily cron; 48h budget
      { key: 'seed-meta:health:air-quality', maxStaleMin: 180 },        // hourly cron; 3h budget
    ],
    _apiPaths: [
      "GET /api/health/v1/list-air-quality-alerts",
      "GET /api/health/v1/list-disease-outbreaks",
    ],
  },
  {
    name: 'get_energy_intelligence',
    description: 'Energy supply, prices, storage, disruptions, and policy: EIA petroleum stocks, electricity prices (Ember), gas storage (GIE), fuel shortages, fossil & renewable shares, active energy disruptions, government crisis policies.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    // Broad 9-key energy bundle mirroring get_economic_data. Cadences span
    // hourly (electricity prices) to annual (World Bank renewable share); use
    // _freshnessChecks with per-key maxStaleMin pulled from
    // api/health.js::SEED_META so a slow-cadence key doesn't drag the
    // aggregate stale flag unnecessarily.
    _cacheKeys: [
      'energy:eia-petroleum:v1',                  // STANDALONE_KEYS::eiaPetroleum
      'energy:electricity:v1:index',              // BOOTSTRAP_KEYS::electricityPrices
      'energy:ember:v1:_all',                     // STANDALONE_KEYS::emberElectricity
      'energy:gas-storage:v1:_countries',         // BOOTSTRAP_KEYS::gasStorageCountries
      'energy:fuel-shortages:v1',                 // STANDALONE_KEYS::fuelShortages
      'energy:disruptions:v1',                    // STANDALONE_KEYS::energyDisruptions
      'energy:crisis-policies:v1',                // STANDALONE_KEYS::energyCrisisPolicies
      'resilience:fossil-electricity-share:v1',   // STANDALONE_KEYS::fossilElectricityShare
      'economic:worldbank-renewable:v1',          // BOOTSTRAP_KEYS::renewableEnergy
    ],
    _seedMetaKey: 'seed-meta:energy:eia-petroleum',
    _maxStaleMin: 4320, // EIA petroleum daily-bundle baseline; per-key budgets via _freshnessChecks below
    _freshnessChecks: [
      { key: 'seed-meta:energy:eia-petroleum',                  maxStaleMin: 4320 },   // daily bundle; 72h = 3× interval
      { key: 'seed-meta:energy:electricity-prices',             maxStaleMin: 2880 },   // daily cron (14:00 UTC); 48h = 2× interval
      { key: 'seed-meta:energy:ember',                          maxStaleMin: 2880 },   // daily cron (08:00 UTC); 48h = 2× interval
      { key: 'seed-meta:energy:gas-storage-countries',          maxStaleMin: 2880 },   // daily cron at 10:30 UTC; 48h = 2× interval
      { key: 'seed-meta:energy:fuel-shortages',                 maxStaleMin: 2880 },   // 2d — daily cron × 2 headroom
      { key: 'seed-meta:energy:disruptions',                    maxStaleMin: 20160 },  // 14d — weekly cron × 2 headroom
      { key: 'seed-meta:energy:crisis-policies',                maxStaleMin: 60 * 24 * 400 }, // ~400d static registry
      { key: 'seed-meta:resilience:fossil-electricity-share',   maxStaleMin: 11520 },  // ~8d (annual WB-style cadence)
      { key: 'seed-meta:economic:worldbank-renewable:v1',       maxStaleMin: 10080 },  // 7d WB weekly-cron annual data
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-energy-crisis-policies",
      "GET /api/supply-chain/v1/get-fuel-shortage-detail",
      "GET /api/supply-chain/v1/list-energy-disruptions",
      "GET /api/supply-chain/v1/list-fuel-shortages",
    ],
  },
  {
    name: 'get_climate_data',
    description: 'Climate intelligence: temperature/precipitation anomalies (vs 30-year WMO normals), climate-relevant disaster alerts (ReliefWeb/GDACS/FIRMS), atmospheric CO2 trend (NOAA Mauna Loa), air quality (OpenAQ/WAQI PM2.5 stations), Arctic sea ice extent and ocean heat indicators (NSIDC/NOAA), weather alerts, and climate news.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['climate:anomalies:v2', 'climate:disasters:v1', 'climate:co2-monitoring:v1', 'climate:air-quality:v1', 'climate:ocean-ice:v1', 'climate:news-intelligence:v1', 'weather:alerts:v1'],
    _seedMetaKey: 'seed-meta:climate:co2-monitoring',
    _maxStaleMin: 2880,
    _freshnessChecks: [
      { key: 'seed-meta:climate:anomalies', maxStaleMin: 120 },
      { key: 'seed-meta:climate:disasters', maxStaleMin: 720 },
      { key: 'seed-meta:climate:co2-monitoring', maxStaleMin: 2880 },
      { key: 'seed-meta:health:air-quality', maxStaleMin: 180 },
      { key: 'seed-meta:climate:ocean-ice', maxStaleMin: 1440 },
      { key: 'seed-meta:climate:news-intelligence', maxStaleMin: 90 },
      { key: 'seed-meta:weather:alerts', maxStaleMin: 45 },
    ],
    _apiPaths: [
      "GET /api/climate/v1/get-co2-monitoring",
      "GET /api/climate/v1/get-ocean-ice-data",
      "GET /api/climate/v1/list-air-quality-data",
      "GET /api/climate/v1/list-climate-anomalies",
      "GET /api/climate/v1/list-climate-disasters",
      "GET /api/climate/v1/list-climate-news",
    ],
  },
  {
    name: 'get_infrastructure_status',
    description: 'Internet infrastructure health: Cloudflare Radar outages and service status for major cloud providers and internet services.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['infra:outages:v1'],
    _seedMetaKey: 'seed-meta:infra:outages',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/infrastructure/v1/list-internet-outages",
    ],
  },
  {
    name: 'get_supply_chain_data',
    description: 'Dry bulk shipping stress index, customs revenue flows, and COMTRADE bilateral trade data. Tracks global supply chain pressure and trade disruptions.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'supply_chain:shipping_stress:v1',
      'trade:customs-revenue:v1',
      'comtrade:flows:v1',
    ],
    _seedMetaKey: 'seed-meta:trade:customs-revenue',
    _maxStaleMin: 2880,
    _apiPaths: [
      "GET /api/supply-chain/v1/get-shipping-stress",
      "GET /api/trade/v1/get-customs-revenue",
    ],
  },
  {
    name: 'get_tariff_trends',
    description: 'Global trade and pricing indicators: US tariff trends (HTS-coded), BigMac index, FAO Food Price Index, and per-country national debt levels.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    // 4-key bundle spanning trade + economic domains. Cadences span hourly-ish
    // (tariffs co-pinned to 8h TARIFF_TTL) to monthly (FAO / national debt).
    // Per-key _freshnessChecks pulled from api/health.js::SEED_META so a slow
    // monthly key doesn't drag the aggregate stale flag and a fast tariff
    // outage isn't masked by a long FAO budget.
    _cacheKeys: [
      'trade:tariffs:v1:840:all:10',   // STANDALONE_KEYS::tariffTrendsUs
      'economic:bigmac:v1',            // BOOTSTRAP_KEYS::bigmac
      'economic:fao-ffpi:v1',          // BOOTSTRAP_KEYS::faoFoodPriceIndex
      'economic:national-debt:v1',     // BOOTSTRAP_KEYS::nationalDebt
    ],
    _seedMetaKey: 'seed-meta:trade:tariffs:v1:840:all:10',
    _maxStaleMin: 540, // tariff cron baseline; per-key budgets via _freshnessChecks below
    _freshnessChecks: [
      { key: 'seed-meta:trade:tariffs:v1:840:all:10', maxStaleMin: 540 },   // TARIFF_TTL 8h + 60min grace
      { key: 'seed-meta:economic:bigmac',             maxStaleMin: 10080 }, // weekly seed; 7d
      { key: 'seed-meta:economic:fao-ffpi',           maxStaleMin: 86400 }, // monthly seed; 60d (2× interval)
      { key: 'seed-meta:economic:national-debt',      maxStaleMin: 86400 }, // monthly seed; 60d (2× interval)
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-fao-food-price-index",
      "GET /api/economic/v1/get-national-debt",
      "GET /api/economic/v1/list-bigmac-prices",
    ],
  },
  {
    name: 'get_chokepoint_status',
    description: 'Live maritime chokepoint status: per-chokepoint vessel transit counts (10-min cadence), rolling transit summaries, per-port activity, plus static reference data (chokepoint geometry, canonical 13-chokepoint registry) and flow aggregates. Covers Suez, Hormuz, Malacca, Bab-el-Mandeb, Panama, etc.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    // Maritime chokepoint bundle distinct from get_supply_chain_data (which keeps
    // shipping-stress + customs + comtrade). Cadences span 10-minute relay
    // (transit-summaries, chokepoint_transits) to ~400-day static registries
    // (chokepoint-baselines), so per-key _freshnessChecks pulled from
    // api/health.js::SEED_META — a fast transit outage isn't masked by the
    // slow chokepoint-baselines budget, and the long-cadence portwatch keys
    // don't drag aggregate stale flagging.
    //
    // Payload measurement (PR pre-merge, fun-toad-55127.upstash.io 2026-05-11):
    //   transit-summaries:v1                        — 6.8 KB
    //   chokepoint_transits:v1                      — 1.1 KB
    //   portwatch-ports:v1:_countries               — 0.9 KB
    //   energy:chokepoint-baselines:v1              — 0.6 KB
    //   portwatch:chokepoints:ref:v1                — 7.9 KB
    //   energy:chokepoint-flows:v1                  — 1.2 KB
    //   ────────────────────────────────────────────────────
    //   Total: 18.5 KB (well under the 200KB/single-key and 500KB/aggregate
    //   thresholds that historically tripped handler timeouts —
    //   see tests/transit-summaries.test.mjs:539-545).
    //
    // EXCLUDED on purpose: supply_chain:corridorrisk:v1 is an intermediate
    // key whose data flows through supply_chain:transit-summaries:v1
    // (api/health.js:461). U7 will add corridorrisk to EXCLUDED_FROM_MCP.
    _cacheKeys: [
      'supply_chain:transit-summaries:v1',          // STANDALONE_KEYS::transitSummaries
      'supply_chain:chokepoint_transits:v1',        // STANDALONE_KEYS::chokepointTransits
      'supply_chain:portwatch-ports:v1:_countries', // STANDALONE_KEYS::portwatchPortActivity
      'energy:chokepoint-baselines:v1',             // STANDALONE_KEYS::chokepointBaselines
      'portwatch:chokepoints:ref:v1',               // STANDALONE_KEYS::portwatchChokepointsRef
      'energy:chokepoint-flows:v1',                 // STANDALONE_KEYS::chokepointFlows
    ],
    _seedMetaKey: 'seed-meta:supply_chain:transit-summaries',
    _maxStaleMin: 30, // transit-summaries 10-min relay baseline; per-key budgets via _freshnessChecks below
    _freshnessChecks: [
      { key: 'seed-meta:supply_chain:transit-summaries',   maxStaleMin: 30 },             // 10-min relay; 30min = 3× interval
      { key: 'seed-meta:supply_chain:chokepoint_transits', maxStaleMin: 30 },             // 10-min relay; 30min = 3× interval
      { key: 'seed-meta:supply_chain:portwatch-ports',     maxStaleMin: 2160 },           // 12h cron; 36h = 3× interval
      { key: 'seed-meta:energy:chokepoint-baselines',      maxStaleMin: 60 * 24 * 400 },  // ~400d static registry
      { key: 'seed-meta:portwatch:chokepoints-ref',        maxStaleMin: 60 * 24 * 14 },   // weekly cron; 14d = 2× interval
      { key: 'seed-meta:energy:chokepoint-flows',          maxStaleMin: 720 },            // 6h cron; 12h = 2× interval
    ],
    _apiPaths: [
      "GET /api/intelligence/v1/get-country-port-activity",
      "GET /api/supply-chain/v1/get-chokepoint-status",
    ],
  },
  {
    name: 'get_positive_events',
    description: 'Positive geopolitical events: diplomatic agreements, humanitarian aid, development milestones, and peace initiatives worldwide.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['positive_events:geo-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:positive-events:geo',
    _maxStaleMin: 60,
    _apiPaths: [
      'GET /api/positive-events/v1/list-positive-geo-events',
    ],
  },
  {
    name: 'get_radiation_data',
    description: 'Radiation observation levels from global monitoring stations. Flags anomalous readings that may indicate nuclear incidents.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['radiation:observations:v1'],
    _seedMetaKey: 'seed-meta:radiation:observations',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/radiation/v1/list-radiation-observations",
    ],
  },
  {
    name: 'get_research_signals',
    description: 'Tech and research event signals: emerging technology events bootstrap data from curated research feeds.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['research:tech-events-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:research:tech-events',
    _maxStaleMin: 480,
    _apiPaths: [
      'GET /api/research/v1/list-tech-events',
    ],
  },
  {
    name: 'get_forecast_predictions',
    description: 'AI-generated geopolitical and economic forecasts from WorldMonitor\'s predictive models. Covers upcoming risk events and probability assessments.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['forecast:predictions:v2'],
    _seedMetaKey: 'seed-meta:forecast:predictions',
    _maxStaleMin: 90,
    _apiPaths: [
      "GET /api/forecast/v1/get-forecasts",
    ],
  },

  // -------------------------------------------------------------------------
  // Social velocity — cache read (Reddit signals, seeded by relay)
  // -------------------------------------------------------------------------
  {
    name: 'get_social_velocity',
    description: 'Reddit geopolitical social velocity: top posts from worldnews, geopolitics, and related subreddits with engagement scores and trend signals.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['intelligence:social:reddit:v1'],
    _seedMetaKey: 'seed-meta:intelligence:social-reddit',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/intelligence/v1/get-social-velocity",
    ],
  },

  // -------------------------------------------------------------------------
  // AI inference tools — call LLM endpoints, not cached Redis reads
  // -------------------------------------------------------------------------
  {
    name: 'get_world_brief',
    description: 'AI-generated world intelligence brief. Fetches the latest geopolitical headlines along with their RSS article bodies and produces a grounded LLM-summarized brief. Supply an optional geo_context to focus on a region or topic.',
    inputSchema: {
      type: 'object',
      properties: {
        geo_context: { type: 'string', description: 'Optional focus context (e.g. "Middle East tensions", "US-China trade war")' },
      },
      required: [],
    },
    _execute: async (params, base, context) => {
      const UA = 'worldmonitor-mcp-edge/1.0';
      // Step 1: fetch current geopolitical headlines (budget: 6 s, leaves ~24 s for LLM)
      const digestUrl = `${base}/api/news/v1/list-feed-digest?variant=geo&lang=en`;
      const digestAuth = await buildAuthHeaders(context, 'GET', digestUrl, null);
      const digestRes = await fetch(digestUrl, {
        headers: { ...digestAuth, 'User-Agent': UA },
        signal: AbortSignal.timeout(6_000),
      });
      if (!digestRes.ok) throw new Error(`feed-digest HTTP ${digestRes.status}`);
      type DigestPayload = { categories?: Record<string, { items?: { title?: string; snippet?: string }[] }> };
      const digest = await digestRes.json() as DigestPayload;
      // Pair headlines with their RSS snippets so the LLM grounds per-story
      // on article bodies instead of hallucinating across unrelated titles.
      const pairs = Object.values(digest.categories ?? {})
        .flatMap(cat => cat.items ?? [])
        .map(item => ({ title: item.title ?? '', snippet: item.snippet ?? '' }))
        .filter(p => p.title.length > 0)
        .slice(0, 10);
      const headlines = pairs.map(p => p.title);
      const bodies = pairs.map(p => p.snippet);
      // Step 2: summarize with LLM (budget: 18 s — combined 24 s, well under 30 s edge ceiling)
      const briefUrl = `${base}/api/news/v1/summarize-article`;
      const briefBody = JSON.stringify({
        provider: 'openrouter',
        headlines,
        bodies,
        mode: 'brief',
        geoContext: String(params.geo_context ?? ''),
        variant: 'geo',
        lang: 'en',
      });
      const briefAuth = await buildAuthHeaders(context, 'POST', briefUrl, briefBody);
      const briefRes = await fetch(briefUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...briefAuth, 'User-Agent': UA },
        body: briefBody,
        signal: AbortSignal.timeout(18_000),
      });
      if (!briefRes.ok) throw new Error(`summarize-article HTTP ${briefRes.status}`);
      return briefRes.json();
    },
    _apiPaths: [
      "GET /api/news/v1/list-feed-digest",
      "POST /api/news/v1/summarize-article",
    ],
  },
  {
    name: 'get_country_brief',
    description: 'AI-generated per-country intelligence brief. Produces an LLM-analyzed geopolitical and economic assessment for the given country. Supports analytical frameworks for structured lenses.',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. "US", "DE", "CN", "IR"' },
        framework: { type: 'string', description: 'Optional analytical framework instructions to shape the analysis lens (e.g. Ray Dalio debt cycle, PMESII-PT)' },
      },
      required: ['country_code'],
    },
    _execute: async (params, base, context) => {
      const UA = 'worldmonitor-mcp-edge/1.0';
      const countryCode = String(params.country_code ?? '').toUpperCase().slice(0, 2);

      // Fetch current geopolitical headlines to ground the LLM (budget: 2 s — cached endpoint).
      // Without context the model hallucinates events — real headlines anchor it.
      // 2 s + 22 s brief = 24 s worst-case; 6 s margin before the 30 s Edge kill.
      let contextParam = '';
      try {
        const digestUrl = `${base}/api/news/v1/list-feed-digest?variant=geo&lang=en`;
        const digestAuth = await buildAuthHeaders(context, 'GET', digestUrl, null);
        const digestRes = await fetch(digestUrl, {
          headers: { ...digestAuth, 'User-Agent': UA },
          signal: AbortSignal.timeout(2_000),
        });
        if (digestRes.ok) {
          type DigestPayload = { categories?: Record<string, { items?: { title?: string }[] }> };
          const digest = await digestRes.json() as DigestPayload;
          const headlines = Object.values(digest.categories ?? {})
            .flatMap(cat => cat.items ?? [])
            .map(item => item.title ?? '')
            .filter(Boolean)
            .slice(0, 15)
            .join('\n');
          if (headlines) contextParam = encodeURIComponent(headlines.slice(0, 4000));
        }
      } catch { /* proceed without context — better than failing */ }

      const briefUrl = contextParam
        ? `${base}/api/intelligence/v1/get-country-intel-brief?context=${contextParam}`
        : `${base}/api/intelligence/v1/get-country-intel-brief`;

      const briefBody = JSON.stringify({ country_code: countryCode, framework: String(params.framework ?? '') });
      const briefAuth = await buildAuthHeaders(context, 'POST', briefUrl, briefBody);
      const res = await fetch(briefUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...briefAuth, 'User-Agent': UA },
        body: briefBody,
        signal: AbortSignal.timeout(22_000),
      });
      if (!res.ok) throw new Error(`get-country-intel-brief HTTP ${res.status}`);
      return res.json();
    },
    // METHOD DRIFT: _execute POSTs above but OpenAPI declares only GET on this
    // path (verified against docs/api/IntelligenceService.openapi.json). The
    // gateway routes by path, not method, so POST works at runtime. We declare
    // GET here because OpenAPI is the parity test's source-of-truth — fixing
    // the spec to add POST (or migrating the handler to GET) is out of scope.
    _apiPaths: [
      "GET /api/intelligence/v1/get-country-intel-brief",
    ],
  },
  {
    name: 'get_country_risk',
    description: 'Structured risk intelligence for a specific country: Composite Instability Index (CII) score 0-100, component breakdown (unrest/conflict/security/news), travel advisory level, and OFAC sanctions exposure. Fast Redis read — no LLM. Use for quantitative risk screening or to answer "how risky is X right now?"',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. "RU", "IR", "CN", "UA"' },
      },
      required: ['country_code'],
    },
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const url = `${base}/api/intelligence/v1/get-country-risk?country_code=${encodeURIComponent(code)}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`get-country-risk HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "GET /api/intelligence/v1/get-country-risk",
    ],
  },
  {
    name: 'get_consumer_prices',
    description: "Per-country consumer-prices intelligence: 30-day overview, category-level inflation, retailer spread (essentials basket), top movers, and source freshness. Requires country_code (currently only 'ae' is seeded).",
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code. Currently supported: AE (case-insensitive).',
        },
      },
      required: ['country_code'],
    },
    // Hybrid _execute (not a pure cache tool) because the cache keys are
    // parameterised by country. Mirrors api/health.js::BOOTSTRAP_KEYS:55-59
    // exactly so the U7 Tier-3 parity test treats every key as covered.
    _coverageKeys: [
      'consumer-prices:overview:ae',
      'consumer-prices:categories:ae:30d',
      'consumer-prices:movers:ae:30d',
      'consumer-prices:retailer-spread:ae:essentials-ae',
      'consumer-prices:freshness:ae',
    ],
    _execute: async (params) => {
      // Result-level errors (NOT throws) for user-input issues — the dispatcher
      // maps thrown errors to JSON-RPC -32603 "Internal error", which is
      // misleading for a clearly-user-side fault like a missing/unknown
      // country_code. Returning {error: ...} surfaces a usable message via
      // the normal tools/call result envelope.
      if (!params.country_code || typeof params.country_code !== 'string') {
        return { error: 'country_code is required' };
      }
      const code = params.country_code.toLowerCase();
      // Strict ISO 3166-1 alpha-2 shape: exactly two lowercase letters.
      // Without this, .slice(0,2) would silently truncate inputs like
      // "aexxx" or "AE-DXB" to "ae" and serve AE data — masking client bugs.
      if (!/^[a-z]{2}$/.test(code)) {
        return { error: 'country_code must be a two-letter ISO code (e.g. "ae")' };
      }
      if (!SUPPORTED_CONSUMER_PRICES_COUNTRIES.has(code)) {
        return { error: 'Country not yet supported. Available: ae' };
      }

      const dataKeys = [
        `consumer-prices:overview:${code}`,
        `consumer-prices:categories:${code}:30d`,
        `consumer-prices:movers:${code}:30d`,
        `consumer-prices:retailer-spread:${code}:essentials-${code}`,
        `consumer-prices:freshness:${code}`,
      ];

      // Freshness checks use the producer's actual meta keys. Note the spread
      // entry: scripts/seed-consumer-prices.mjs:151 writes
      // `seed-meta:consumer-prices:spread:<code>` (NO `retailer-` prefix,
      // NO `:essentials-<code>` suffix). api/health.js:337 has the documented
      // drift bug (expects `retailer-spread:<code>:essentials-<code>` which
      // never exists) and so would always report stale; we deliberately
      // diverge from health.js here to match the actual producer.
      const freshnessChecks: FreshnessCheck[] = [
        { key: `seed-meta:consumer-prices:overview:${code}`,      maxStaleMin: 1500 }, // 25h = 24h cron + 1h grace
        { key: `seed-meta:consumer-prices:categories:${code}:30d`, maxStaleMin: 1500 },
        { key: `seed-meta:consumer-prices:movers:${code}:30d`,     maxStaleMin: 1500 },
        { key: `seed-meta:consumer-prices:spread:${code}`,         maxStaleMin: 1500 }, // producer's actual key shape
        { key: `seed-meta:consumer-prices:freshness:${code}`,      maxStaleMin: 1500 },
      ];

      const [dataResults, metaResults] = await Promise.all([
        Promise.all(dataKeys.map((k) => readJsonFromUpstash(k))),
        Promise.all(freshnessChecks.map((c) => readJsonFromUpstash(c.key))),
      ]);

      // F6 contract parity with the cache-tool path (executeTool, ~line 1139):
      // if every data read is null/undefined, this is a degenerate-empty
      // response (Redis transient / stampede / pre-seed). Throw so
      // dispatchToolsCall's catch fires proRollback — without this, the Pro
      // user's daily MCP counter increments by 1 for a useless result while
      // every other cache-tool refunds via the same code path.
      if (dataResults.every((v: unknown) => v === null || v === undefined)) {
        throw new Error('cache_all_null');
      }

      const { cached_at, stale } = evaluateFreshness(freshnessChecks, metaResults);

      return {
        cached_at,
        stale,
        country_code: code,
        data: {
          overview: dataResults[0],
          categories: dataResults[1],
          movers: dataResults[2],
          retailerSpread: dataResults[3],
          freshness: dataResults[4],
        },
      };
    },
    // Hybrid tool covers the consumer-prices domain via direct Redis reads
    // of the same keys the per-method handlers expose via the API. The
    // OpenAPI ops listed here read parameterized keys (the audit's
    // manual-mapping case); this MCP tool wraps the 'ae'-instance equivalent.
    //
    // NOTE: `get-consumer-price-basket-series` is NOT covered here — that
    // handler reads `consumer-prices:basket-series:${market}:${basket}:${range}`
    // which is a separate parameterized time-series key, NOT in this tool's
    // `_coverageKeys`. Excluded as `deferred-to-future-tool` in
    // tests/mcp-api-parity.test.mjs until a future expanded_consumer_prices
    // tool exposes the basket-series time series.
    _apiPaths: [
      'GET /api/consumer-prices/v1/get-consumer-price-freshness',
      'GET /api/consumer-prices/v1/get-consumer-price-overview',
      'GET /api/consumer-prices/v1/list-consumer-price-categories',
      'GET /api/consumer-prices/v1/list-consumer-price-movers',
      'GET /api/consumer-prices/v1/list-retailer-price-spreads',
    ],
  },
  {
    name: 'get_airspace',
    description: 'Live ADS-B aircraft over a country. Returns civilian flights (OpenSky) and identified military aircraft with callsigns, positions, altitudes, and headings. Answers questions like "how many planes are over the UAE right now?" or "are there military aircraft over Taiwan?"',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code (e.g. "AE", "US", "GB", "JP")',
        },
        type: {
          type: 'string',
          enum: ['all', 'civilian', 'military'],
          description: 'Filter: all flights (default), civilian only, or military only',
        },
      },
      required: ['country_code'],
    },
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const bbox = COUNTRY_BBOXES[code];
      if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2 (e.g. "AE", "US", "GB").` };
      const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
      const type = String(params.type ?? 'all');
      const UA = 'worldmonitor-mcp-edge/1.0';
      const bboxQ = `sw_lat=${sw_lat}&sw_lon=${sw_lon}&ne_lat=${ne_lat}&ne_lon=${ne_lon}`;

      type CivilianResp = {
        positions?: { callsign: string; icao24: string; lat: number; lon: number; altitude_m: number; ground_speed_kts: number; track_deg: number; on_ground: boolean }[];
        source?: string;
        updated_at?: number;
      };
      type MilResp = {
        flights?: { callsign: string; hex_code: string; aircraft_type: string; aircraft_model: string; operator: string; operator_country: string; location?: { latitude: number; longitude: number }; altitude: number; heading: number; speed: number; is_interesting: boolean; note: string }[];
      };

      const civUrl = `${base}/api/aviation/v1/track-aircraft?${bboxQ}`;
      const milUrl = `${base}/api/military/v1/list-military-flights?${bboxQ}&page_size=100`;
      const civAuth = type === 'military' ? null : await buildAuthHeaders(context, 'GET', civUrl, null);
      const milAuth = type === 'civilian' ? null : await buildAuthHeaders(context, 'GET', milUrl, null);

      const [civResult, milResult] = await Promise.allSettled([
        type === 'military' || !civAuth
          ? Promise.resolve(null)
          : fetch(civUrl, { headers: { ...civAuth, 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) })
              .then(r => r.ok ? r.json() as Promise<CivilianResp> : Promise.reject(new Error(`HTTP ${r.status}`))),
        type === 'civilian' || !milAuth
          ? Promise.resolve(null)
          : fetch(milUrl, { headers: { ...milAuth, 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) })
              .then(r => r.ok ? r.json() as Promise<MilResp> : Promise.reject(new Error(`HTTP ${r.status}`))),
      ]);

      const civOk = type === 'military' || civResult.status === 'fulfilled';
      const milOk = type === 'civilian' || milResult.status === 'fulfilled';

      // Both sources down — total outage, don't return misleading empty data
      if (!civOk && !milOk) throw new Error('Airspace data unavailable: both civilian and military sources failed');

      const civ = civResult.status === 'fulfilled' ? civResult.value : null;
      const mil = milResult.status === 'fulfilled' ? milResult.value : null;
      const warnings: string[] = [];
      if (!civOk) warnings.push('civilian ADS-B data unavailable');
      if (!milOk) warnings.push('military flight data unavailable');

      const civilianFlights = (civ?.positions ?? []).slice(0, 100).map(p => ({
        callsign: p.callsign, icao24: p.icao24,
        lat: p.lat, lon: p.lon,
        altitude_m: p.altitude_m, speed_kts: p.ground_speed_kts,
        heading_deg: p.track_deg, on_ground: p.on_ground,
      }));
      const militaryFlights = (mil?.flights ?? []).slice(0, 100).map(f => ({
        callsign: f.callsign, hex_code: f.hex_code,
        aircraft_type: f.aircraft_type, aircraft_model: f.aircraft_model,
        operator: f.operator, operator_country: f.operator_country,
        lat: f.location?.latitude, lon: f.location?.longitude,
        altitude: f.altitude, heading: f.heading, speed: f.speed,
        is_interesting: f.is_interesting, ...(f.note ? { note: f.note } : {}),
      }));

      return {
        country_code: code,
        bounding_box: { sw_lat, sw_lon, ne_lat, ne_lon },
        civilian_count: civilianFlights.length,
        military_count: militaryFlights.length,
        ...(type !== 'military' && { civilian_flights: civilianFlights }),
        ...(type !== 'civilian' && { military_flights: militaryFlights }),
        ...(warnings.length > 0 && { partial: true, warnings }),
        source: civ?.source ?? 'opensky',
        updated_at: civ?.updated_at ? new Date(civ.updated_at).toISOString() : new Date().toISOString(),
      };
    },
    _apiPaths: [
      "GET /api/aviation/v1/track-aircraft",
      "GET /api/military/v1/list-military-flights",
    ],
  },
  {
    name: 'get_maritime_activity',
    description: "Live vessel traffic and maritime disruptions for a country's waters. Returns AIS density zones (ships-per-day, intensity score), dark ship events, and chokepoint congestion from AIS tracking.",
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code (e.g. "AE", "SA", "JP", "EG")',
        },
      },
      required: ['country_code'],
    },
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const bbox = COUNTRY_BBOXES[code];
      if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2 (e.g. "AE", "SA", "JP").` };
      const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
      const bboxQ = `sw_lat=${sw_lat}&sw_lon=${sw_lon}&ne_lat=${ne_lat}&ne_lon=${ne_lon}`;
      const url = `${base}/api/maritime/v1/get-vessel-snapshot?${bboxQ}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);

      type VesselResp = {
        snapshot?: {
          snapshot_at?: number;
          density_zones?: { name: string; intensity: number; ships_per_day: number; delta_pct: number; note: string }[];
          disruptions?: { name: string; type: string; severity: string; dark_ships: number; vessel_count: number; region: string; description: string }[];
        };
      };

      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`get-vessel-snapshot HTTP ${res.status}`);
      const data = await res.json() as VesselResp;
      const snap = data.snapshot ?? {};

      return {
        country_code: code,
        bounding_box: { sw_lat, sw_lon, ne_lat, ne_lon },
        snapshot_at: snap.snapshot_at ? new Date(snap.snapshot_at).toISOString() : new Date().toISOString(),
        total_zones: (snap.density_zones ?? []).length,
        total_disruptions: (snap.disruptions ?? []).length,
        density_zones: (snap.density_zones ?? []).map(z => ({
          name: z.name, intensity: z.intensity, ships_per_day: z.ships_per_day,
          delta_pct: z.delta_pct, ...(z.note ? { note: z.note } : {}),
        })),
        disruptions: (snap.disruptions ?? []).map(d => ({
          name: d.name, type: d.type, severity: d.severity,
          dark_ships: d.dark_ships, vessel_count: d.vessel_count,
          region: d.region, description: d.description,
        })),
      };
    },
    _apiPaths: [
      "GET /api/maritime/v1/get-vessel-snapshot",
    ],
  },
  {
    name: 'analyze_situation',
    description: 'AI geopolitical situation analysis (DeductionPanel). Provide a query and optional geo-political context; returns an LLM-powered analytical deduction with confidence and supporting signals.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or situation to analyze, e.g. "What are the implications of the Taiwan strait escalation for semiconductor supply chains?"' },
        context: { type: 'string', description: 'Optional additional geo-political context to include in the analysis' },
        framework: { type: 'string', description: 'Optional analytical framework instructions to shape the analysis lens (e.g. Ray Dalio debt cycle, PMESII-PT, Porter\'s Five Forces)' },
      },
      required: ['query'],
    },
    _execute: async (params, base, context) => {
      const url = `${base}/api/intelligence/v1/deduct-situation`;
      const body = JSON.stringify({ query: String(params.query ?? ''), geoContext: String(params.context ?? ''), framework: String(params.framework ?? '') });
      const auth = await buildAuthHeaders(context, 'POST', url, body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body,
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`deduct-situation HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "POST /api/intelligence/v1/deduct-situation",
    ],
  },
  {
    name: 'generate_forecasts',
    description: 'Generate live AI geopolitical and economic forecasts. Unlike get_forecast_predictions (pre-computed cache), this calls the forecasting model directly for fresh probability estimates. Note: slower than cache tools.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Forecast domain: "geopolitical", "economic", "military", "climate", or empty for all domains' },
        region: { type: 'string', description: 'Geographic region filter, e.g. "Middle East", "Europe", "Asia Pacific", or empty for global' },
      },
      required: [],
    },
    _execute: async (params, base, context) => {
      // 25 s — stays within Vercel Edge's ~30 s hard ceiling (was 60 s, which exceeded the limit)
      const url = `${base}/api/forecast/v1/get-forecasts`;
      const body = JSON.stringify({ domain: String(params.domain ?? ''), region: String(params.region ?? '') });
      const auth = await buildAuthHeaders(context, 'POST', url, body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body,
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`get-forecasts HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [],
  },
  {
    name: 'search_flights',
    description: 'Search Google Flights for real-time flight options between two airports on a specific date. Returns available flights with prices, stops, airline, and segment details. Use IATA airport codes (e.g. "JFK", "LHR", "DXB").',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'IATA code for the departure airport, e.g. "JFK"' },
        destination: { type: 'string', description: 'IATA code for the arrival airport, e.g. "LHR"' },
        departure_date: { type: 'string', description: 'Departure date in YYYY-MM-DD format' },
        return_date: { type: 'string', description: 'Return date in YYYY-MM-DD format for round trips (optional)' },
        cabin_class: { type: 'string', description: 'Cabin class: "economy", "premium_economy", "business", or "first" (optional, default economy)' },
        max_stops: { type: 'string', description: 'Max stops: "0" or "non_stop" for nonstop, "1" or "one_stop" for max one stop, or omit for any (optional)' },
        passengers: { type: 'number', description: 'Number of passengers (1-9, default 1)' },
        sort_by: { type: 'string', description: 'Sort order: "price" (cheapest), "duration", "departure", or "arrival" (optional)' },
      },
      required: ['origin', 'destination', 'departure_date'],
    },
    _execute: async (params, base, context) => {
      const qs = new URLSearchParams({
        origin: String(params.origin ?? ''),
        destination: String(params.destination ?? ''),
        departure_date: String(params.departure_date ?? ''),
        ...(params.return_date ? { return_date: String(params.return_date) } : {}),
        ...(params.cabin_class ? { cabin_class: String(params.cabin_class) } : {}),
        ...(params.max_stops ? { max_stops: String(params.max_stops) } : {}),
        ...(params.sort_by ? { sort_by: String(params.sort_by) } : {}),
        passengers: String(Math.max(1, Math.min(Number(params.passengers ?? 1), 9))),
      });
      const url = `${base}/api/aviation/v1/search-google-flights?${qs}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`search-google-flights HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "GET /api/aviation/v1/search-google-flights",
    ],
  },
  {
    name: 'search_flight_prices_by_date',
    description: 'Search Google Flights date-grid pricing across a date range. Returns cheapest prices for each departure date between two airports. Useful for finding the cheapest day to fly. Use IATA airport codes.',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'IATA code for the departure airport, e.g. "JFK"' },
        destination: { type: 'string', description: 'IATA code for the arrival airport, e.g. "LHR"' },
        start_date: { type: 'string', description: 'Start of the date range in YYYY-MM-DD format' },
        end_date: { type: 'string', description: 'End of the date range in YYYY-MM-DD format' },
        is_round_trip: { type: 'boolean', description: 'Whether to search round-trip prices (default false). Requires trip_duration when true.' },
        trip_duration: { type: 'number', description: 'Trip duration in days — required when is_round_trip is true (e.g. 7 for a one-week trip)' },
        cabin_class: { type: 'string', description: 'Cabin class: "economy", "premium_economy", "business", or "first" (optional)' },
        passengers: { type: 'number', description: 'Number of passengers (1-9, default 1)' },
        sort_by_price: { type: 'boolean', description: 'Sort results by price ascending (default false, sorts by date)' },
      },
      required: ['origin', 'destination', 'start_date', 'end_date'],
    },
    _execute: async (params, base, context) => {
      const qs = new URLSearchParams({
        origin: String(params.origin ?? ''),
        destination: String(params.destination ?? ''),
        start_date: String(params.start_date ?? ''),
        end_date: String(params.end_date ?? ''),
        is_round_trip: String(params.is_round_trip ?? false),
        ...(params.trip_duration ? { trip_duration: String(params.trip_duration) } : {}),
        ...(params.cabin_class ? { cabin_class: String(params.cabin_class) } : {}),
        sort_by_price: String(params.sort_by_price ?? false),
        passengers: String(Math.max(1, Math.min(Number(params.passengers ?? 1), 9))),
      });
      const url = `${base}/api/aviation/v1/search-google-dates?${qs}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`search-google-dates HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "GET /api/aviation/v1/search-google-dates",
    ],
  },
  {
    name: 'get_commodity_geo',
    description: 'Global mining sites with coordinates, operator, mineral type, and production status. Covers 71 major mines spanning gold, silver, copper, lithium, uranium, coal, and other minerals worldwide.',
    inputSchema: {
      type: 'object',
      properties: {
        mineral: { type: 'string', description: 'Filter by mineral type (e.g. "Gold", "Copper", "Lithium")' },
        country: { type: 'string', description: 'Filter by country name (e.g. "Australia", "Chile")' },
      },
      required: [],
    },
    _execute: async (params: Record<string, unknown>) => {
      type MineSite = { id: string; name: string; lat: number; lon: number; mineral: string; country: string; operator: string; status: string; significance: string; annualOutput?: string; productionRank?: number; openPitOrUnderground?: string };
      let sites = MINING_SITES_RAW as MineSite[];
      if (params.mineral) sites = sites.filter((s) => s.mineral === String(params.mineral));
      if (params.country) sites = sites.filter((s) => s.country.toLowerCase().includes(String(params.country).toLowerCase()));
      return { sites, total: sites.length };
    },
    _apiPaths: [],
  },
];

// Public shape for tools/list (strip internal _-prefixed fields, add MCP annotations)
const TOOL_LIST_RESPONSE = TOOL_REGISTRY.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
}));

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------
function rpcOk(id: unknown, result: unknown, extraHeaders: Record<string, string> = {}): Response {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, result }, 200, extraHeaders);
}

function rpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, 200);
}

export function evaluateFreshness(checks: FreshnessCheck[], metas: unknown[], now = Date.now()): { cached_at: string | null; stale: boolean } {
  let stale = false;
  let oldestFetchedAt = Number.POSITIVE_INFINITY;
  let hasAnyValidMeta = false;
  let hasAllValidMeta = true;

  for (const [i, check] of checks.entries()) {
    const meta = metas[i];
    const fetchedAt = meta && typeof meta === 'object' && 'fetchedAt' in meta
      ? Number((meta as { fetchedAt: unknown }).fetchedAt)
      : Number.NaN;

    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
      hasAllValidMeta = false;
      stale = true;
      continue;
    }

    hasAnyValidMeta = true;
    oldestFetchedAt = Math.min(oldestFetchedAt, fetchedAt);
    stale ||= (now - fetchedAt) / 60_000 > check.maxStaleMin;
  }

  return {
    cached_at: hasAnyValidMeta && hasAllValidMeta ? new Date(oldestFetchedAt).toISOString() : null,
    stale,
  };
}

// ---------------------------------------------------------------------------
// Tool execution (cache tools — no _execute)
// ---------------------------------------------------------------------------
async function executeTool(tool: CacheToolDef): Promise<{ cached_at: string | null; stale: boolean; data: Record<string, unknown> }> {
  const reads = tool._cacheKeys.map(k => readJsonFromUpstash(k));
  const freshnessChecks = tool._freshnessChecks?.length
    ? tool._freshnessChecks
    : [{ key: tool._seedMetaKey, maxStaleMin: tool._maxStaleMin }];
  const metaReads = freshnessChecks.map((check) => readJsonFromUpstash(check.key));
  const [results, metas] = await Promise.all([Promise.all(reads), Promise.all(metaReads)]);
  const { cached_at, stale } = evaluateFreshness(freshnessChecks, metas);

  // F6: if every cache key returned null/undefined AND the tool actually
  // had keys configured, this is a degenerate-empty result (Redis transient
  // / stampede). Throw so dispatchToolsCall's catch fires the DECR rollback
  // — without this, the user's quota burns silently on a useless response.
  //
  // Cache-tools always have at least one key (validated in the registry
  // type). The all-null case is structurally distinguishable from "the
  // upstream returned an empty list" (which is a JSON value, not null).
  if (
    tool._cacheKeys.length > 0 &&
    results.every((v: unknown) => v === null || v === undefined)
  ) {
    throw new Error('cache_all_null');
  }

  const data: Record<string, unknown> = {};
  // Walk backward through ':'-delimited segments, skipping non-informative suffixes
  // (version tags, bare numbers, internal format names) to produce a readable label.
  const NON_LABEL = /^(v\d+|\d+|stale|sebuf)$/;
  tool._cacheKeys.forEach((key, i) => {
    const parts = key.split(':');
    let label = '';
    for (let idx = parts.length - 1; idx >= 0; idx--) {
      const seg = parts[idx] ?? '';
      if (!NON_LABEL.test(seg)) { label = seg; break; }
    }
    data[label || (parts[0] ?? key)] = results[i];
  });

  return { cached_at, stale, data };
}

// ---------------------------------------------------------------------------
// Daily quota helpers (Pro-only). INCR-first reservation runs synchronously
// on the critical path BEFORE tool dispatch — never inside `waitUntil`.
// On any post-INCR rejection (cap exceeded OR tool dispatch failure) we
// best-effort DECR. A failed DECR overshoots the counter by 1, but never
// undershoots — cost-protection > user-fairness.
// ---------------------------------------------------------------------------

type PipelineFn = (commands: Array<Array<string | number>>, timeoutMs?: number) => Promise<Array<{ result: unknown }> | null>;

interface QuotaReserved {
  ok: true;
  newCount: number;
  /** Roll back the INCR (best-effort). Idempotent — safe to call multiple times. */
  rollback: () => Promise<void>;
}
interface QuotaRejected {
  ok: false;
  reason: 'cap-exceeded' | 'redis-unavailable';
  /** When cap-exceeded: count after the rejected reservation was rolled back (i.e. the floor). */
  floor?: number;
}

async function reserveQuota(
  userId: string,
  pipeline: PipelineFn,
): Promise<QuotaReserved | QuotaRejected> {
  const key = dailyCounterKey(userId);
  if (!key) return { ok: false, reason: 'redis-unavailable' };

  let pipeResult: Array<{ result: unknown }> | null;
  try {
    pipeResult = await pipeline([
      ['INCR', key],
      ['EXPIRE', key, PRO_DAILY_QUOTA_TTL_SECONDS],
    ]);
  } catch {
    pipeResult = null;
  }

  if (!pipeResult || !Array.isArray(pipeResult) || pipeResult.length === 0) {
    // Hard cap correctness: NEVER dispatch on reservation failure.
    return { ok: false, reason: 'redis-unavailable' };
  }

  const incrRaw = pipeResult[0]?.result;
  const newCount = typeof incrRaw === 'number' ? incrRaw : Number(incrRaw);
  if (!Number.isFinite(newCount) || newCount < 1) {
    return { ok: false, reason: 'redis-unavailable' };
  }

  // Build idempotent rollback. `await rollback()` runs DECR once; subsequent
  // calls are no-ops.
  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await pipeline([['DECR', key]]);
    } catch {
      // Best-effort: a transient Redis failure means the counter overshoots
      // by 1, which is the cost-protection-correct direction.
    }
  };

  if (newCount > PRO_DAILY_QUOTA_LIMIT) {
    // Reject and roll back immediately so the floor stays at the limit
    // (or wherever concurrent rollbacks land it).
    await rollback();

    // Counter-clamp (F4): if multiple DECR rollbacks have failed during
    // a Redis hiccup, the counter can overshoot indefinitely (e.g. land
    // at 100 instead of 50). Without clamping, every subsequent INCR for
    // the rest of the UTC day yields >50 → the user is locked out until
    // the 48h key TTL expires.
    //
    // After the rollback, peek at the post-DECR count via a single
    // best-effort INCR-then-DECR pair — if it's STILL above the limit,
    // we know the rollback didn't land. Force a defensive
    // `SET key <limit> KEEPTTL` so the next legitimate INCR (next UTC
    // day OR next request after the hiccup) starts at limit+1 → 429,
    // not limit+N → 429-forever.
    //
    // Why use INCR-then-DECR instead of GET? Keeps the helper to the
    // same pipeline contract (the tests' makePipelineMock supports
    // INCR/DECR/EXPIRE only) and avoids adding a new verb. The probe
    // costs one round-trip but only on the rejection path.
    if (newCount > PRO_DAILY_QUOTA_LIMIT + 1) {
      try {
        const probe = await pipeline([['INCR', key], ['DECR', key]]);
        const probeIncrRaw = probe?.[0]?.result;
        const postRollbackCount = typeof probeIncrRaw === 'number' ? probeIncrRaw - 1 : Number.NaN;
        if (Number.isFinite(postRollbackCount) && postRollbackCount > PRO_DAILY_QUOTA_LIMIT) {
          // Rollback chain has overshot — force the counter back to the
          // limit via SET KEEPTTL. This is fail-soft: a concurrent INCR
          // immediately after this SET will land at limit+1 and 429
          // normally, which is the desired behavior.
          //
          // Use DECR repeatedly as the pipeline-supported clamp (avoids
          // adding a new verb to test mocks). DECR N times where N is
          // the overshoot delta. Cap at 100 DECRs to bound the worst-
          // case round-trip cost.
          const overshoot = postRollbackCount - PRO_DAILY_QUOTA_LIMIT;
          const decrs = Math.min(overshoot, 100);
          const clamp = Array.from({ length: decrs }, () => ['DECR', key] as Array<string | number>);
          // Best-effort: failure here is the cost-protection-correct
          // direction (counter stays high → users 429, no DoS exposure).
          await pipeline(clamp).catch(() => {});
        }
      } catch {
        // Probe failed — leave counter as-is. Worst case the user 429s
        // until UTC midnight; never under-cap, never DoS exposure.
      }
    }

    return { ok: false, reason: 'cap-exceeded', floor: PRO_DAILY_QUOTA_LIMIT };
  }

  return { ok: true, newCount, rollback };
}

// ---------------------------------------------------------------------------
// Auth resolution — exported types so deps-injecting callers (tests) can
// supply alternates without re-deriving the shape.
// ---------------------------------------------------------------------------

export interface McpHandlerDeps {
  resolveBearerToContext: (token: string) => Promise<McpAuthContext | null>;
  validateProMcpToken: (tokenId: string) => Promise<{ userId: string } | null>;
  getEntitlements: (userId: string) => Promise<{ planKey?: string; features: { tier: number; mcpAccess?: boolean }; validUntil: number } | null>;
  redisPipeline: PipelineFn;
}

const PRODUCTION_DEPS: McpHandlerDeps = {
  resolveBearerToContext,
  // Per-request validate path uses the legacy `userId | null` wrapper —
  // transient Convex blips fail-closed (401 prompts the client to retry
  // via OAuth, which is the correct safety direction here). The refresh-
  // grant path in api/oauth/token.ts uses the discriminated-union form
  // to distinguish revoked from transient (F3 of the U7+U8 review pass).
  validateProMcpToken: validateProMcpTokenOrNull,
  getEntitlements,
  redisPipeline: rawRedisPipeline,
};

// ---------------------------------------------------------------------------
// Auth + Pro-pre-check helpers (extracted from mcpHandler so the top-level
// handler stays under the cognitive-complexity threshold).
// ---------------------------------------------------------------------------

function wwwAuthHeader(resourceMetadataUrl: string, errorParam = ''): string {
  const errSegment = errorParam ? `, error="${errorParam}"` : '';
  return `Bearer realm="worldmonitor"${errSegment}, resource_metadata="${resourceMetadataUrl}"`;
}

interface AuthResolution {
  ok: true;
  context: McpAuthContext;
}
interface AuthResolutionRejected {
  ok: false;
  response: Response;
}

async function resolveAuthContext(
  req: Request,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
): Promise<AuthResolution | AuthResolutionRejected> {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    let context: McpAuthContext | null;
    try {
      context = await deps.resolveBearerToContext(token);
    } catch {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Auth service temporarily unavailable. Try again.' } }),
          { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders } },
        ),
      };
    }
    if (!context) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid or expired OAuth token. Re-authenticate via /oauth/token.' } }),
          { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders } },
        ),
      };
    }
    return { ok: true, context };
  }

  const candidateKey = req.headers.get('X-WorldMonitor-Key') ?? '';
  if (!candidateKey) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Authentication required. Use OAuth (/oauth/token) or pass your API key via X-WorldMonitor-Key header.' } }),
        { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl), ...corsHeaders } },
      ),
    };
  }
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  if (!await timingSafeIncludes(candidateKey, validKeys)) {
    return { ok: false, response: rpcError(null, -32001, 'Invalid API key') };
  }
  return { ok: true, context: { kind: 'env_key', apiKey: candidateKey } };
}

/**
 * Pro-only pre-checks: validate Convex row + cross-user-binding + entitlement
 * re-check. Returns null on success; a 401 Response on any check failure.
 */
async function runProPreChecks(
  context: Extract<McpAuthContext, { kind: 'pro' }>,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response | null> {
  // F12: Pro path is unusable without MCP_INTERNAL_HMAC_SECRET — every
  // tool fetch will throw inside buildAuthHeaders. Surface the misconfig
  // at auth-resolution time so operators see a single clear 503 rather
  // than a confusing mid-tool-fetch -32603. Belt-and-suspenders with the
  // U10 deploy gate; matches the runtime check in `buildAuthHeaders`.
  if (!process.env.MCP_INTERNAL_HMAC_SECRET) {
    captureSilentError(new Error('MCP_INTERNAL_HMAC_SECRET unset'), {
      tags: { route: 'api/mcp', step: 'pro-secret-preflight' },
      ctx,
    });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Service temporarily unavailable, retry in a moment.' } }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders } },
    );
  }

  const validation = await deps.validateProMcpToken(context.mcpTokenId);
  if (!validation || validation.userId !== context.userId) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'MCP authorization revoked. Re-authorize at https://worldmonitor.app/mcp-grant.' } }),
      { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders } },
    );
  }

  let ent: Awaited<ReturnType<typeof deps.getEntitlements>> = null;
  try {
    ent = await deps.getEntitlements(context.userId);
  } catch (err) {
    // Fail-closed per memory `entitlement-signal-server-outlier-sweep`.
    captureSilentError(err, { tags: { route: 'api/mcp', step: 'pro-entitlement-recheck' }, ctx });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Subscription not active.' } }),
      { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders } },
    );
  }
  const tier = ent?.features?.tier ?? 0;
  const mcpAccess = ent?.features?.mcpAccess === true;
  const validUntil = ent?.validUntil ?? 0;
  if (!ent || tier < 1 || !mcpAccess || validUntil < Date.now()) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Subscription not active.' } }),
      { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders } },
    );
  }
  return null;
}

/** Per-minute rate limit. Both paths fail-OPEN on Upstash error (graceful);
 *  the daily quota is the hard-cap fail-CLOSED gate. Returns null on success
 *  or pass-through, a Response on a real 60/min limit hit. */
async function applyPerMinuteLimit(context: McpAuthContext): Promise<Response | null> {
  if (context.kind === 'env_key') {
    const rl = getMcpRatelimit();
    if (!rl) return null;
    try {
      const { success } = await rl.limit(`key:${context.apiKey}`);
      if (!success) return rpcError(null, -32029, 'Rate limit exceeded. Max 60 requests per minute per API key.');
    } catch { /* graceful degradation */ }
    return null;
  }
  const rl = getMcpProMinRatelimit();
  if (!rl) return null;
  try {
    const { success } = await rl.limit(`pro-user:${context.userId}`);
    if (!success) return rpcError(null, -32029, 'Rate limit exceeded. Max 60 requests per minute per Pro user.');
  } catch { /* graceful degradation */ }
  return null;
}

async function dispatchToolsCall(
  req: Request,
  context: McpAuthContext,
  deps: McpHandlerDeps,
  body: { id?: unknown; params?: unknown },
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const id = body.id ?? null;
  const p = body.params as { name?: string; arguments?: Record<string, unknown> } | null;
  if (!p || typeof p.name !== 'string') {
    return rpcError(id, -32602, 'Invalid params: missing tool name');
  }
  const tool = TOOL_REGISTRY.find((t) => t.name === p.name);
  if (!tool) {
    return rpcError(id, -32602, `Unknown tool: ${p.name}`);
  }

  // Pro-only INCR-first reservation. Both cache-only AND RPC tools count.
  let proRollback: (() => Promise<void>) | null = null;
  if (context.kind === 'pro') {
    const reservation = await reserveQuota(context.userId, deps.redisPipeline);
    if (!reservation.ok) {
      if (reservation.reason === 'cap-exceeded') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32029, message: `Daily MCP quota exceeded (${PRO_DAILY_QUOTA_LIMIT}/day). Resets at next UTC midnight.` } }),
          { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(secondsUntilUtcMidnight()), ...corsHeaders } },
        );
      }
      // Hard-cap correctness: NEVER dispatch on reservation failure.
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Service temporarily unavailable, retry in a moment.' } }),
        { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders } },
      );
    }
    proRollback = reservation.rollback;
  }

  try {
    let result: unknown;
    if (tool._execute) {
      const baseUrl = new URL(req.url).origin;
      result = await tool._execute(p.arguments ?? {}, baseUrl, context);
    } else {
      result = await executeTool(tool);
    }
    // Convex `internal-validate-pro-mcp-token` schedules touchProMcpTokenLastUsed
    // itself (convex/http.ts:1035-1040), so no waitUntil needed here.
    return rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }, corsHeaders);
  } catch (err: unknown) {
    if (proRollback) await proRollback();
    // HTTP 4xx from an internal sibling fetch (e.g. `feed-digest HTTP 401`)
    // is expected-but-trackable: transient HMAC/auth/quota drift, replay-window
    // skew, or a single user's expired context. Report at `warning` so single
    // occurrences don't drown real 5xx bugs in alerts; the pattern still
    // surfaces if it recurs. Non-HTTP errors and 5xx stay at default `error`.
    // Log-drain consumers (Vercel, Datadog) read console severity, so route
    // the `console.*` call to match the Sentry level — otherwise log alerts
    // fire on 4xx while Sentry does not, defeating the downgrade.
    const message = err instanceof Error ? err.message : String(err);
    const isClient4xx = /HTTP 4\d\d\b/.test(message);
    const log = isClient4xx ? console.warn : console.error;
    log('[mcp] tool execution error:', err);
    captureSilentError(err, {
      tags: { route: 'api/mcp', step: 'tool-execution', tool: tool.name },
      ctx,
      ...(isClient4xx ? { level: 'warning' as const } : {}),
    });
    return rpcError(id, -32603, 'Internal error: data fetch failed');
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function mcpHandler(
  req: Request,
  deps: McpHandlerDeps,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  // MCP is a public API endpoint secured by API key — allow all origins (claude.ai, Claude Desktop, custom agents)
  const corsHeaders = getPublicCorsHeaders('POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST, HEAD, OPTIONS', ...corsHeaders } });
  }

  // Origin validation: allow claude.ai/claude.com web clients; allow absent origin (desktop/CLI)
  const origin = req.headers.get('Origin');
  if (origin && origin !== 'https://claude.ai' && origin !== 'https://claude.com') {
    return new Response('Forbidden', { status: 403, headers: corsHeaders });
  }
  // Host-derived resource_metadata pointer matches api/oauth-protected-resource.ts.
  const requestHost = req.headers.get('host') ?? new URL(req.url).host;
  const resourceMetadataUrl = `https://${requestHost}/.well-known/oauth-protected-resource`;

  const auth = await resolveAuthContext(req, deps, resourceMetadataUrl, corsHeaders);
  if (!auth.ok) return auth.response;
  const context = auth.context;

  if (context.kind === 'pro') {
    const proCheck = await runProPreChecks(context, deps, resourceMetadataUrl, corsHeaders, ctx);
    if (proCheck) return proCheck;
  }

  const limited = await applyPerMinuteLimit(context);
  if (limited) return limited;

  // Parse body
  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32600, 'Invalid request: malformed JSON');
  }

  if (!body || typeof body.method !== 'string') {
    return rpcError(body?.id ?? null, -32600, 'Invalid request: missing method');
  }

  const { id, method } = body;

  // Dispatch
  switch (method) {
    case 'initialize': {
      const sessionId = crypto.randomUUID();
      return rpcOk(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }, { 'Mcp-Session-Id': sessionId, ...corsHeaders });
    }
    case 'notifications/initialized':
      return new Response(null, { status: 202, headers: corsHeaders });
    case 'ping':
      return rpcOk(id, {}, corsHeaders);
    case 'tools/list':
      return rpcOk(id, { tools: TOOL_LIST_RESPONSE }, corsHeaders);
    case 'tools/call':
      return dispatchToolsCall(req, context, deps, body, corsHeaders, ctx);
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Default Vercel-edge entry — wires production deps. Tests call mcpHandler
// directly with mock deps.
// ---------------------------------------------------------------------------
export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  return mcpHandler(req, PRODUCTION_DEPS, ctx);
}

// ---------------------------------------------------------------------------
// Test-only escape hatch. Exposes the TOOL_REGISTRY for the U7 Tier 3 parity
// test (tests/mcp-bootstrap-parity.test.mjs), which asserts that every
// canonical seeded cache key from api/health.js (BOOTSTRAP_KEYS ∪
// STANDALONE_KEYS) is either covered by some tool's `_cacheKeys` (cache-tool)
// or `_coverageKeys` (RpcToolDef hybrid), or explicitly excluded via the
// test's EXCLUDED_FROM_MCP map with a documented reason.
// ---------------------------------------------------------------------------
export const __testing__ = {
  TOOL_REGISTRY,
};
