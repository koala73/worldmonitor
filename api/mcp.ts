import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash } from './_upstash-json.js';
// @ts-expect-error — JS module, no declaration file
import { resolveApiKeyFromBearer } from './_oauth-token.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes } from './_crypto.js';
import COUNTRY_BBOXES from '../shared/country-bboxes.js';
// @ts-expect-error — generated JS module, no declaration file
import MINING_SITES_RAW from '../shared/mining-sites.js';

export const config = { runtime: 'edge' };

const MCP_PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'worldmonitor';
const SERVER_VERSION = '1.0';

// ---------------------------------------------------------------------------
// Per-key rate limiter (60 calls/min per PRO API key)
// ---------------------------------------------------------------------------
let mcpRatelimit: Ratelimit | null = null;

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
  _outputLabels?: Record<string, string>;
  _execute?: never;
}

// AI inference tool: calls an internal RPC endpoint and returns the raw response.
interface RpcToolDef extends BaseToolDef {
  _cacheKeys?: never;
  _seedMetaKey?: never;
  _maxStaleMin?: never;
  _freshnessChecks?: never;
  _outputLabels?: never;
  _execute: (params: Record<string, unknown>, base: string, apiKey: string) => Promise<unknown>;
}

type ToolDef = CacheToolDef | RpcToolDef;

export const TOOL_REGISTRY: ToolDef[] = [
  {
    name: 'get_market_data',
    description: 'Real-time market dashboard: equity and commodity quotes, crypto prices, crypto sector breadth, stablecoin peg health, shared FX rates, ETF flows, sector performance, fear/greed, and Gulf market quotes. Useful for cross-asset risk and sentiment checks.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'market:stocks-bootstrap:v1',
      'market:commodities-bootstrap:v1',
      'market:crypto:v1',
      'market:sectors:v2',
      'market:etf-flows:v1',
      'market:gulf-quotes:v1',
      'market:fear-greed:v1',
      'market:crypto-sectors:v1',
      'market:stablecoins:v1',
      'shared:fx-rates:v1',
    ],
    _seedMetaKey: 'seed-meta:market:stocks',
    _maxStaleMin: 30,
    _freshnessChecks: [
      { key: 'seed-meta:market:stocks', maxStaleMin: 30 },
      { key: 'seed-meta:market:commodities', maxStaleMin: 30 },
      { key: 'seed-meta:market:crypto', maxStaleMin: 30 },
      { key: 'seed-meta:market:sectors', maxStaleMin: 30 },
      { key: 'seed-meta:market:etf-flows', maxStaleMin: 60 },
      { key: 'seed-meta:market:gulf-quotes', maxStaleMin: 30 },
      { key: 'seed-meta:market:fear-greed', maxStaleMin: 720 },
      { key: 'seed-meta:market:crypto-sectors', maxStaleMin: 120 },
      { key: 'seed-meta:market:stablecoins', maxStaleMin: 60 },
      { key: 'seed-meta:shared:fx-rates', maxStaleMin: 1500 },
    ],
    _outputLabels: {
      'market:crypto-sectors:v1': 'crypto_sectors',
      'shared:fx-rates:v1': 'fx_rates',
    },
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
  },
  {
    name: 'get_aviation_status',
    description: 'Airport delays, NOTAM airspace closures, and tracked military aircraft. Covers FAA delay data and active airspace restrictions.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['aviation:delays-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:aviation:faa',
    _maxStaleMin: 90,
  },
  {
    name: 'get_news_intelligence',
    description: 'AI-classified geopolitical intelligence: news summaries, GDELT signals, cross-source corroboration, and official security advisories. Useful for grounding a situation report in current reporting and government warnings.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'news:insights:v1',
      'intelligence:gdelt-intel:v1',
      'intelligence:cross-source-signals:v1',
      'intelligence:advisories-bootstrap:v1',
      'intelligence:advisories:v1',
    ],
    _seedMetaKey: 'seed-meta:news:insights',
    _maxStaleMin: 30,
    _freshnessChecks: [
      { key: 'seed-meta:news:insights', maxStaleMin: 30 },
      { key: 'seed-meta:intelligence:gdelt-intel', maxStaleMin: 420 },
      { key: 'seed-meta:intelligence:cross-source-signals', maxStaleMin: 30 },
      { key: 'seed-meta:intelligence:advisories', maxStaleMin: 120 },
    ],
    _outputLabels: {
      'intelligence:advisories:v1': 'security_advisories',
    },
  },
  {
    name: 'get_natural_disasters',
    description: 'Recent earthquakes (USGS), active wildfires (NASA FIRMS), natural hazard events, and thermal escalation clusters derived from wildfire heat signatures. Use for disaster monitoring and fast-moving environmental escalation.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'seismology:earthquakes:v1',
      'wildfire:fires:v1',
      'natural:events:v1',
      'thermal:escalation:v1',
    ],
    _seedMetaKey: 'seed-meta:seismology:earthquakes',
    _maxStaleMin: 30,
    _freshnessChecks: [
      { key: 'seed-meta:seismology:earthquakes', maxStaleMin: 30 },
      { key: 'seed-meta:wildfire:fires', maxStaleMin: 360 },
      { key: 'seed-meta:natural:events', maxStaleMin: 360 },
      { key: 'seed-meta:thermal:escalation', maxStaleMin: 360 },
    ],
    _outputLabels: {
      'thermal:escalation:v1': 'thermal_escalation',
    },
  },
  {
    name: 'get_military_posture',
    description: 'Theater posture assessment and military risk scores. Reflects aggregated military positioning and escalation signals across global theaters.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['theater_posture:sebuf:stale:v1'],
    _seedMetaKey: 'seed-meta:theater-posture',
    _maxStaleMin: 60,
  },
  {
    name: 'get_cyber_threats',
    description: 'Active cyber threat intelligence from WorldMonitor\'s bootstrap and canonical feeds: malware IOCs (URLhaus, Feodotracker), CISA known exploited vulnerabilities, command-and-control infrastructure, and deduplicated threat records.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['cyber:threats-bootstrap:v2', 'cyber:threats:v2'],
    _seedMetaKey: 'seed-meta:cyber:threats',
    _maxStaleMin: 240,
    _outputLabels: {
      'cyber:threats:v2': 'threats',
    },
  },
  {
    name: 'get_economic_data',
    description: 'Macro and real-economy bundle: Fed Funds, economic calendar, fuel prices, ECB FX, EU yield curve, earnings calendar, COT positioning, BIS household stress/property series, World Bank tech-readiness/progress/renewable snapshots, national debt, Big Mac PPP, grocery basket prices, FAO food inflation, Eurostat country data, and curated US BLS series.',
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
      'economic:worldbank-techreadiness:v1',
      'economic:worldbank-progress:v1',
      'economic:worldbank-renewable:v1',
      'economic:national-debt:v1',
      'economic:bigmac:v1',
      'economic:grocery-basket:v1',
      'economic:fao-ffpi:v1',
      'economic:eurostat-country-data:v1',
      'bls:series:v1',
    ],
    _seedMetaKey: 'seed-meta:economic:econ-calendar',
    _maxStaleMin: 1440,
    _freshnessChecks: [
      { key: 'seed-meta:economic:fred:v1:FEDFUNDS:0', maxStaleMin: 1500 },
      { key: 'seed-meta:economic:econ-calendar', maxStaleMin: 1440 },
      { key: 'seed-meta:economic:fuel-prices', maxStaleMin: 10080 },
      { key: 'seed-meta:economic:ecb-fx-rates', maxStaleMin: 5760 },
      { key: 'seed-meta:economic:yield-curve-eu', maxStaleMin: 4320 },
      { key: 'seed-meta:economic:spending', maxStaleMin: 120 },
      { key: 'seed-meta:market:earnings-calendar', maxStaleMin: 1440 },
      { key: 'seed-meta:market:cot', maxStaleMin: 14400 },
      // Per-dataset BIS seed-meta keys — the aggregate
      // `seed-meta:economic:bis-extended` would report "fresh" even if only
      // one of the three datasets (DSR / SPP / CPP) is current, matching the
      // false-freshness bug already fixed for /api/health and resilience.
      { key: 'seed-meta:economic:bis-dsr', maxStaleMin: 1440 }, // 12h cron × 2
      { key: 'seed-meta:economic:bis-property-residential', maxStaleMin: 1440 },
      { key: 'seed-meta:economic:bis-property-commercial', maxStaleMin: 1440 },
      { key: 'seed-meta:economic:worldbank-techreadiness:v1', maxStaleMin: 10080 },
      { key: 'seed-meta:economic:worldbank-progress:v1', maxStaleMin: 10080 },
      { key: 'seed-meta:economic:worldbank-renewable:v1', maxStaleMin: 10080 },
      { key: 'seed-meta:economic:national-debt', maxStaleMin: 10080 },
      { key: 'seed-meta:economic:bigmac', maxStaleMin: 10080 },
      { key: 'seed-meta:economic:grocery-basket', maxStaleMin: 10080 },
      { key: 'seed-meta:economic:fao-ffpi', maxStaleMin: 86400 },
      { key: 'seed-meta:economic:eurostat-country-data', maxStaleMin: 4320 },
      { key: 'seed-meta:economic:bls-series', maxStaleMin: 2880 },
    ],
    _outputLabels: {
      'economic:worldbank-techreadiness:v1': 'tech_readiness',
      'economic:worldbank-progress:v1': 'worldbank_progress',
      'economic:worldbank-renewable:v1': 'renewable_energy',
      'economic:national-debt:v1': 'national_debt',
      'economic:bigmac:v1': 'bigmac_index',
      'economic:grocery-basket:v1': 'grocery_basket',
      'economic:fao-ffpi:v1': 'fao_food_price_index',
      'economic:eurostat-country-data:v1': 'eurostat_country_data',
      'bls:series:v1': 'bls_series',
    },
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
  },
  {
    name: 'get_eu_housing_cycle',
    description: 'Eurostat annual house price index (prc_hpi_a, base 2015=100) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes the latest value, prior value, date, unit, and a 10-year sparkline series. Complements BIS WS_SPP with broader EU coverage for the Housing cycle tile.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['economic:eurostat:house-prices:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-house-prices',
    _maxStaleMin: 60 * 24 * 50, // weekly cron, annual data
  },
  {
    name: 'get_eu_quarterly_gov_debt',
    description: 'Eurostat quarterly general government gross debt (gov_10q_ggdebt, %GDP) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes latest value, prior value, quarter label, and an 8-quarter sparkline series. Provides fresher debt-trajectory signal than annual IMF GGXWDG_NGDP for EU panels.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['economic:eurostat:gov-debt-q:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-gov-debt-q',
    _maxStaleMin: 60 * 24 * 14, // quarterly data, 2-day cron
  },
  {
    name: 'get_eu_industrial_production',
    description: 'Eurostat monthly industrial production index (sts_inpr_m, NACE B-D industry excl. construction, SCA, base 2021=100) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes latest value, prior value, month label, and a 12-month sparkline series. Leading indicator of real-economy activity used by the "Real economy pulse" sparkline.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['economic:eurostat:industrial-production:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-industrial-production',
    _maxStaleMin: 60 * 24 * 5, // monthly data, daily cron
  },
  {
    name: 'get_prediction_markets',
    description: 'Active Polymarket event contracts with current probabilities. Covers geopolitical, economic, and election prediction markets.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['prediction:markets-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:prediction:markets',
    _maxStaleMin: 90,
  },
  {
    name: 'get_sanctions_data',
    description: 'OFAC SDN sanctioned entities list and sanctions pressure scores by country. Useful for compliance screening and geopolitical pressure analysis.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['sanctions:entities:v1', 'sanctions:pressure:v1'],
    _seedMetaKey: 'seed-meta:sanctions:entities',
    _maxStaleMin: 1440,
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
  },
  {
    name: 'get_infrastructure_status',
    description: 'Operational infrastructure watch: internet outages, major cloud/software service-status pages, and submarine cable network topology. Useful for outage triage, dependency monitoring, and communications-route context.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'infra:outages:v1',
      'infra:service-statuses:v1',
      'infrastructure:submarine-cables:v1',
    ],
    _seedMetaKey: 'seed-meta:infra:outages',
    _maxStaleMin: 30,
    _freshnessChecks: [
      { key: 'seed-meta:infra:outages', maxStaleMin: 30 },
      { key: 'seed-meta:infra:service-statuses', maxStaleMin: 60 },
      { key: 'seed-meta:infrastructure:submarine-cables', maxStaleMin: 20160 },
    ],
    _outputLabels: {
      'infra:service-statuses:v1': 'service_statuses',
      'infrastructure:submarine-cables:v1': 'submarine_cables',
    },
  },
  {
    name: 'get_supply_chain_data',
    description: 'Global supply-chain and maritime access data: shipping stress, customs revenue, COMTRADE flows, Strait of Hormuz tracker, PortWatch chokepoint and port-activity snapshots, and active port disruptions.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'supply_chain:shipping_stress:v1',
      'trade:customs-revenue:v1',
      'comtrade:flows:v1',
      'supply_chain:hormuz_tracker:v1',
      'supply_chain:portwatch:v1',
      'supply_chain:portwatch-ports:v1:_countries',
      'portwatch:chokepoints:ref:v1',
      'portwatch:disruptions:active:v1',
    ],
    _seedMetaKey: 'seed-meta:trade:customs-revenue',
    _maxStaleMin: 2880,
    _freshnessChecks: [
      { key: 'seed-meta:supply_chain:shipping_stress', maxStaleMin: 45 },
      { key: 'seed-meta:trade:customs-revenue', maxStaleMin: 1440 },
      { key: 'seed-meta:trade:comtrade-flows', maxStaleMin: 2880 },
      { key: 'seed-meta:supply_chain:hormuz_tracker', maxStaleMin: 2880 },
      { key: 'seed-meta:supply_chain:portwatch', maxStaleMin: 720 },
      { key: 'seed-meta:supply_chain:portwatch-ports', maxStaleMin: 2160 },
      { key: 'seed-meta:portwatch:chokepoints-ref', maxStaleMin: 20160 },
      { key: 'seed-meta:portwatch:disruptions', maxStaleMin: 120 },
    ],
    _outputLabels: {
      'supply_chain:portwatch-ports:v1:_countries': 'port_activity_by_country',
      'portwatch:chokepoints:ref:v1': 'portwatch_chokepoints',
      'portwatch:disruptions:active:v1': 'portwatch_disruptions',
    },
  },
  {
    name: 'get_resilience_recovery',
    description: 'Country recovery-capacity indicators across fiscal space, reserve adequacy, debt-vs-reserves, import concentration, and strategic fuel stocks. Monthly cross-country resilience inputs for recovery and shock-absorption analysis.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'resilience:recovery:fiscal-space:v1',
      'resilience:recovery:reserve-adequacy:v1',
      'resilience:recovery:external-debt:v1',
      'resilience:recovery:import-hhi:v1',
      'resilience:recovery:fuel-stocks:v1',
    ],
    _seedMetaKey: 'seed-meta:resilience:recovery:fiscal-space',
    _maxStaleMin: 86400,
    _freshnessChecks: [
      { key: 'seed-meta:resilience:recovery:fiscal-space', maxStaleMin: 86400 },
      { key: 'seed-meta:resilience:recovery:reserve-adequacy', maxStaleMin: 86400 },
      { key: 'seed-meta:resilience:recovery:external-debt', maxStaleMin: 86400 },
      { key: 'seed-meta:resilience:recovery:import-hhi', maxStaleMin: 86400 },
      { key: 'seed-meta:resilience:recovery:fuel-stocks', maxStaleMin: 86400 },
    ],
    _outputLabels: {
      'resilience:recovery:fiscal-space:v1': 'fiscal_space',
      'resilience:recovery:reserve-adequacy:v1': 'reserve_adequacy',
      'resilience:recovery:external-debt:v1': 'external_debt',
      'resilience:recovery:import-hhi:v1': 'import_hhi',
      'resilience:recovery:fuel-stocks:v1': 'fuel_stocks',
    },
  },
  {
    name: 'get_energy_security',
    description: 'Energy-security and chokepoint data: EU gas storage, EIA baseline chokepoints, live chokepoint flow estimates, SPR registries, energy-crisis policies, IEA oil-stock coverage, JODI oil/gas balances, LNG import vulnerability, and curated energy intelligence headlines.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'economic:eu-gas-storage:v1',
      'energy:chokepoint-baselines:v1',
      'energy:chokepoint-flows:v1',
      'energy:crisis-policies:v1',
      'energy:iea-oil-stocks:v1:index',
      'energy:oil-stocks-analysis:v1',
      'energy:intelligence:feed:v1',
      'energy:jodi-gas:v1:_countries',
      'energy:lng-vulnerability:v1',
      'energy:jodi-oil:v1:_countries',
      'energy:spr-policies:v1',
    ],
    _seedMetaKey: 'seed-meta:economic:eu-gas-storage',
    _maxStaleMin: 2880,
    _freshnessChecks: [
      { key: 'seed-meta:economic:eu-gas-storage', maxStaleMin: 2880 },
      { key: 'seed-meta:energy:chokepoint-baselines', maxStaleMin: 60 * 24 * 400 },
      { key: 'seed-meta:energy:chokepoint-flows', maxStaleMin: 720 },
      { key: 'seed-meta:energy:crisis-policies', maxStaleMin: 60 * 24 * 400 },
      { key: 'seed-meta:energy:iea-oil-stocks', maxStaleMin: 60 * 24 * 40 },
      { key: 'seed-meta:energy:oil-stocks-analysis', maxStaleMin: 60 * 24 * 50 },
      { key: 'seed-meta:energy:intelligence', maxStaleMin: 720 },
      { key: 'seed-meta:energy:jodi-gas', maxStaleMin: 60 * 24 * 40 },
      { key: 'seed-meta:energy:jodi-oil', maxStaleMin: 60 * 24 * 40 },
      { key: 'seed-meta:energy:spr-policies', maxStaleMin: 60 * 24 * 400 },
    ],
    _outputLabels: {
      'economic:eu-gas-storage:v1': 'eu_gas_storage',
      'energy:chokepoint-baselines:v1': 'chokepoint_baselines',
      'energy:chokepoint-flows:v1': 'chokepoint_flows',
      'energy:crisis-policies:v1': 'energy_crisis_policies',
      'energy:iea-oil-stocks:v1:index': 'iea_oil_stocks',
      'energy:oil-stocks-analysis:v1': 'oil_stocks_analysis',
      'energy:intelligence:feed:v1': 'energy_intelligence',
      'energy:jodi-gas:v1:_countries': 'jodi_gas_countries',
      'energy:lng-vulnerability:v1': 'lng_vulnerability',
      'energy:jodi-oil:v1:_countries': 'jodi_oil_countries',
      'energy:spr-policies:v1': 'spr_policies',
    },
  },
  {
    name: 'get_positive_events',
    description: 'Positive geopolitical events: diplomatic agreements, humanitarian aid, development milestones, and peace initiatives worldwide.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['positive_events:geo-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:positive-events:geo',
    _maxStaleMin: 60,
  },
  {
    name: 'get_radiation_data',
    description: 'Radiation observation levels from global monitoring stations. Flags anomalous readings that may indicate nuclear incidents.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['radiation:observations:v1'],
    _seedMetaKey: 'seed-meta:radiation:observations',
    _maxStaleMin: 30,
  },
  {
    name: 'get_research_signals',
    description: 'Emerging technology and defense-innovation signals: curated tech event feed plus the latest defense and dual-use patent filings by strategic CPC category.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['research:tech-events-bootstrap:v1', 'patents:defense:latest'],
    _seedMetaKey: 'seed-meta:research:tech-events',
    _maxStaleMin: 480,
    _freshnessChecks: [
      { key: 'seed-meta:research:tech-events', maxStaleMin: 480 },
      { key: 'seed-meta:military:defense-patents', maxStaleMin: 20160 },
    ],
    _outputLabels: {
      'patents:defense:latest': 'defense_patents',
    },
  },
  {
    name: 'get_health_data',
    description: 'Global health surveillance: WHO/CDC/outbreak feeds plus the ThinkGlobalHealth vaccine-preventable disease tracker. Returns realtime outbreak alerts and historical annual case series.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'health:disease-outbreaks:v1',
      'health:vpd-tracker:realtime:v1',
      'health:vpd-tracker:historical:v1',
    ],
    _seedMetaKey: 'seed-meta:health:disease-outbreaks',
    _maxStaleMin: 2880,
    _freshnessChecks: [
      { key: 'seed-meta:health:disease-outbreaks', maxStaleMin: 2880 },
      { key: 'seed-meta:health:vpd-tracker', maxStaleMin: 2880 },
    ],
    _outputLabels: {
      'health:disease-outbreaks:v1': 'disease_outbreaks',
      'health:vpd-tracker:realtime:v1': 'vpd_realtime',
      'health:vpd-tracker:historical:v1': 'vpd_historical',
    },
  },
  {
    name: 'get_regulatory_actions',
    description: 'Latest high-signal regulatory actions from SEC, CFTC, Federal Reserve, FDIC, and FINRA feeds. Includes enforcement, rulemaking, guidance, and bank or systems-risk actions.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['regulatory:actions:v1'],
    _seedMetaKey: 'seed-meta:regulatory:actions',
    _maxStaleMin: 360,
    _outputLabels: {
      'regulatory:actions:v1': 'regulatory_actions',
    },
  },
  {
    name: 'get_correlation_signals',
    description: 'Cross-domain correlation cards that fuse military, unrest, outages, disasters, markets, and news into fast-moving systemic signal clusters. Seeded every 5 minutes for situational correlation checks.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['correlation:cards-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:correlation:cards',
    _maxStaleMin: 15,
    _outputLabels: {
      'correlation:cards-bootstrap:v1': 'correlation_cards',
    },
  },
  {
    name: 'get_forecast_predictions',
    description: 'AI-generated geopolitical and economic forecasts from WorldMonitor\'s predictive models. Covers upcoming risk events and probability assessments.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['forecast:predictions:v2'],
    _seedMetaKey: 'seed-meta:forecast:predictions',
    _maxStaleMin: 90,
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
  },

  // -------------------------------------------------------------------------
  // AI inference tools — call LLM endpoints, not cached Redis reads
  // -------------------------------------------------------------------------
  {
    name: 'get_world_brief',
    description: 'AI-generated world intelligence brief. Fetches the latest geopolitical headlines and produces an LLM-summarized brief. Supply an optional geo_context to focus on a region or topic.',
    inputSchema: {
      type: 'object',
      properties: {
        geo_context: { type: 'string', description: 'Optional focus context (e.g. "Middle East tensions", "US-China trade war")' },
      },
      required: [],
    },
    _execute: async (params, base, apiKey) => {
      const UA = 'worldmonitor-mcp-edge/1.0';
      // Step 1: fetch current geopolitical headlines (budget: 6 s, leaves ~24 s for LLM)
      const digestRes = await fetch(`${base}/api/news/v1/list-feed-digest?variant=geo&lang=en`, {
        headers: { 'X-WorldMonitor-Key': apiKey, 'User-Agent': UA },
        signal: AbortSignal.timeout(6_000),
      });
      if (!digestRes.ok) throw new Error(`feed-digest HTTP ${digestRes.status}`);
      type DigestPayload = { categories?: Record<string, { items?: { title?: string }[] }> };
      const digest = await digestRes.json() as DigestPayload;
      const headlines = Object.values(digest.categories ?? {})
        .flatMap(cat => cat.items ?? [])
        .map(item => item.title ?? '')
        .filter(Boolean)
        .slice(0, 10);
      // Step 2: summarize with LLM (budget: 18 s — combined 24 s, well under 30 s edge ceiling)
      const briefRes = await fetch(`${base}/api/news/v1/summarize-article`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': apiKey, 'User-Agent': UA },
        body: JSON.stringify({
          provider: 'openrouter',
          headlines,
          mode: 'brief',
          geoContext: String(params.geo_context ?? ''),
          variant: 'geo',
          lang: 'en',
        }),
        signal: AbortSignal.timeout(18_000),
      });
      if (!briefRes.ok) throw new Error(`summarize-article HTTP ${briefRes.status}`);
      return briefRes.json();
    },
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
    _execute: async (params, base, apiKey) => {
      const UA = 'worldmonitor-mcp-edge/1.0';
      const countryCode = String(params.country_code ?? '').toUpperCase().slice(0, 2);

      // Fetch current geopolitical headlines to ground the LLM (budget: 2 s — cached endpoint).
      // Without context the model hallucinates events — real headlines anchor it.
      // 2 s + 22 s brief = 24 s worst-case; 6 s margin before the 30 s Edge kill.
      let contextParam = '';
      try {
        const digestRes = await fetch(`${base}/api/news/v1/list-feed-digest?variant=geo&lang=en`, {
          headers: { 'X-WorldMonitor-Key': apiKey, 'User-Agent': UA },
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

      const res = await fetch(briefUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': apiKey, 'User-Agent': UA },
        body: JSON.stringify({ country_code: countryCode, framework: String(params.framework ?? '') }),
        signal: AbortSignal.timeout(22_000),
      });
      if (!res.ok) throw new Error(`get-country-intel-brief HTTP ${res.status}`);
      return res.json();
    },
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
    _execute: async (params, base, apiKey) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const res = await fetch(
        `${base}/api/intelligence/v1/get-country-risk?country_code=${encodeURIComponent(code)}`,
        {
          headers: { 'X-WorldMonitor-Key': apiKey, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!res.ok) throw new Error(`get-country-risk HTTP ${res.status}`);
      return res.json();
    },
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
    _execute: async (params, base, apiKey) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const bbox = COUNTRY_BBOXES[code];
      if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2 (e.g. "AE", "US", "GB").` };
      const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
      const type = String(params.type ?? 'all');
      const UA = 'worldmonitor-mcp-edge/1.0';
      const headers = { 'X-WorldMonitor-Key': apiKey, 'User-Agent': UA };
      const bboxQ = `sw_lat=${sw_lat}&sw_lon=${sw_lon}&ne_lat=${ne_lat}&ne_lon=${ne_lon}`;

      type CivilianResp = {
        positions?: { callsign: string; icao24: string; lat: number; lon: number; altitude_m: number; ground_speed_kts: number; track_deg: number; on_ground: boolean }[];
        source?: string;
        updated_at?: number;
      };
      type MilResp = {
        flights?: { callsign: string; hex_code: string; aircraft_type: string; aircraft_model: string; operator: string; operator_country: string; location?: { latitude: number; longitude: number }; altitude: number; heading: number; speed: number; is_interesting: boolean; note: string }[];
      };

      const [civResult, milResult] = await Promise.allSettled([
        type === 'military'
          ? Promise.resolve(null)
          : fetch(`${base}/api/aviation/v1/track-aircraft?${bboxQ}`, { headers, signal: AbortSignal.timeout(8_000) })
              .then(r => r.ok ? r.json() as Promise<CivilianResp> : Promise.reject(new Error(`HTTP ${r.status}`))),
        type === 'civilian'
          ? Promise.resolve(null)
          : fetch(`${base}/api/military/v1/list-military-flights?${bboxQ}&page_size=100`, { headers, signal: AbortSignal.timeout(8_000) })
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
    _execute: async (params, base, apiKey) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const bbox = COUNTRY_BBOXES[code];
      if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2 (e.g. "AE", "SA", "JP").` };
      const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
      const bboxQ = `sw_lat=${sw_lat}&sw_lon=${sw_lon}&ne_lat=${ne_lat}&ne_lon=${ne_lon}`;
      const headers = { 'X-WorldMonitor-Key': apiKey, 'User-Agent': 'worldmonitor-mcp-edge/1.0' };

      type VesselResp = {
        snapshot?: {
          snapshot_at?: number;
          density_zones?: { name: string; intensity: number; ships_per_day: number; delta_pct: number; note: string }[];
          disruptions?: { name: string; type: string; severity: string; dark_ships: number; vessel_count: number; region: string; description: string }[];
        };
      };

      const res = await fetch(`${base}/api/maritime/v1/get-vessel-snapshot?${bboxQ}`, {
        headers, signal: AbortSignal.timeout(8_000),
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
    _execute: async (params, base, apiKey) => {
      const res = await fetch(`${base}/api/intelligence/v1/deduct-situation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': apiKey, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body: JSON.stringify({ query: String(params.query ?? ''), geoContext: String(params.context ?? ''), framework: String(params.framework ?? '') }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`deduct-situation HTTP ${res.status}`);
      return res.json();
    },
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
    _execute: async (params, base, apiKey) => {
      // 25 s — stays within Vercel Edge's ~30 s hard ceiling (was 60 s, which exceeded the limit)
      const res = await fetch(`${base}/api/forecast/v1/get-forecasts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': apiKey, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body: JSON.stringify({ domain: String(params.domain ?? ''), region: String(params.region ?? '') }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`get-forecasts HTTP ${res.status}`);
      return res.json();
    },
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
    _execute: async (params, base, apiKey) => {
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
      const res = await fetch(`${base}/api/aviation/v1/search-google-flights?${qs}`, {
        headers: { 'X-WorldMonitor-Key': apiKey, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`search-google-flights HTTP ${res.status}`);
      return res.json();
    },
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
    _execute: async (params, base, apiKey) => {
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
      const res = await fetch(`${base}/api/aviation/v1/search-google-dates?${qs}`, {
        headers: { 'X-WorldMonitor-Key': apiKey, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`search-google-dates HTTP ${res.status}`);
      return res.json();
    },
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

function deriveCacheOutputLabel(key: string): string {
  const parts = key.split(':');
  const NON_LABEL = /^(v\d+|\d+|stale|sebuf|_countries|_all|latest|index|feed|ref|active)$/;
  for (let idx = parts.length - 1; idx >= 0; idx--) {
    const seg = parts[idx] ?? '';
    if (!NON_LABEL.test(seg)) return seg;
  }
  return parts[0] ?? key;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------
async function executeTool(tool: CacheToolDef): Promise<{ cached_at: string | null; stale: boolean; data: Record<string, unknown> }> {
  const reads = tool._cacheKeys.map(k => readJsonFromUpstash(k));
  const freshnessChecks = tool._freshnessChecks?.length
    ? tool._freshnessChecks
    : [{ key: tool._seedMetaKey, maxStaleMin: tool._maxStaleMin }];
  const metaReads = freshnessChecks.map((check) => readJsonFromUpstash(check.key));
  const [results, metas] = await Promise.all([Promise.all(reads), Promise.all(metaReads)]);
  const { cached_at, stale } = evaluateFreshness(freshnessChecks, metas);

  const data: Record<string, unknown> = {};
  tool._cacheKeys.forEach((key, i) => {
    let label = tool._outputLabels?.[key] ?? deriveCacheOutputLabel(key);
    if (!label || Object.prototype.hasOwnProperty.call(data, label)) {
      label = key.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }
    data[label] = results[i];
  });

  return { cached_at, stale, data };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req: Request): Promise<Response> {
  // MCP is a public API endpoint secured by API key — allow all origins (claude.ai, Claude Desktop, custom agents)
  const corsHeaders = getPublicCorsHeaders('POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // HEAD probe — return 200 with no body (Anthropic submission guide compatibility)
  if (req.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  // MCP Streamable HTTP transport (2025-03-26) uses POST only.
  // Return 405 for GET/other so clients don't mistake JSON error for a valid SSE stream.
  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST, HEAD, OPTIONS', ...corsHeaders } });
  }

  // Origin validation: allow claude.ai/claude.com web clients; allow absent origin (desktop/CLI)
  const origin = req.headers.get('Origin');
  if (origin && origin !== 'https://claude.ai' && origin !== 'https://claude.com') {
    return new Response('Forbidden', { status: 403, headers: corsHeaders });
  }
  // Auth chain (in priority order):
  //   1. Authorization: Bearer <oauth_token> — issued by /oauth/token (spec-compliant OAuth 2.0)
  //   2. X-WorldMonitor-Key header — direct API key (curl, custom integrations)
  let apiKey = '';
  const authHeader = req.headers.get('Authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    let bearerApiKey: string | null;
    try {
      bearerApiKey = await resolveApiKeyFromBearer(token);
    } catch {
      // Redis/network error — return 503 so clients know to retry, not re-authenticate
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Auth service temporarily unavailable. Try again.' } }),
        { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders } }
      );
    }
    if (bearerApiKey) {
      apiKey = bearerApiKey;
    } else {
      // Bearer token present but unresolvable — expired or invalid UUID
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid or expired OAuth token. Re-authenticate via /oauth/token.' } }),
        { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="worldmonitor", error="invalid_token", resource_metadata="https://api.worldmonitor.app/.well-known/oauth-protected-resource"', ...corsHeaders } }
      );
    }
  } else {
    const candidateKey = req.headers.get('X-WorldMonitor-Key') ?? '';
    if (!candidateKey) {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Authentication required. Use OAuth (/oauth/token) or pass your API key via X-WorldMonitor-Key header.' } }),
        { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="worldmonitor", resource_metadata="https://api.worldmonitor.app/.well-known/oauth-protected-resource"', ...corsHeaders } }
      );
    }
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
    if (!await timingSafeIncludes(candidateKey, validKeys)) {
      return rpcError(null, -32001, 'Invalid API key');
    }
    apiKey = candidateKey;
  }


  // Per-key rate limit
  const rl = getMcpRatelimit();
  if (rl) {
    try {
      const { success } = await rl.limit(`key:${apiKey}`);
      if (!success) {
        return rpcError(null, -32029, 'Rate limit exceeded. Max 60 requests per minute per API key.');
      }
    } catch {
      // Upstash unavailable — allow through (graceful degradation)
    }
  }

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

  const { id, method, params } = body;

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

    case 'tools/call': {
      const p = params as { name?: string; arguments?: Record<string, unknown> } | null;
      if (!p || typeof p.name !== 'string') {
        return rpcError(id, -32602, 'Invalid params: missing tool name');
      }
      const tool = TOOL_REGISTRY.find(t => t.name === p.name);
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${p.name}`);
      }
      try {
        let result: unknown;
        if (tool._execute) {
          const origin = new URL(req.url).origin;
          result = await tool._execute(p.arguments ?? {}, origin, apiKey);
        } else {
          result = await executeTool(tool);
        }
        return rpcOk(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        }, corsHeaders);
      } catch (err: unknown) {
        console.error('[mcp] tool execution error:', err);
        return rpcError(id, -32603, 'Internal error: data fetch failed');
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
