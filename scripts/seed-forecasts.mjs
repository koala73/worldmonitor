#!/usr/bin/env node

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadEnvFile, runSeed, CHROME_UA } from './_seed-utils.mjs';
import { tagRegions } from './_prediction-scoring.mjs';
import { resolveR2StorageConfig, putR2JsonObject, getR2JsonObject } from './_r2-storage.mjs';

const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (_isDirectRun) loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'forecast:predictions:v2';
const PRIOR_KEY = 'forecast:predictions:prior:v2';
const HISTORY_KEY = 'forecast:predictions:history:v1';
const TTL_SECONDS = 21600; // 6h — 6x the 1h cron interval (was 1.75x; hourly miss → 15 min panel gap)
const HISTORY_MAX_RUNS = 200;
const HISTORY_MAX_FORECASTS = 25;
const HISTORY_TTL_SECONDS = 45 * 24 * 60 * 60;
const TRACE_LATEST_KEY = 'forecast:trace:latest:v1';
const TRACE_RUNS_KEY = 'forecast:trace:runs:v1';
const TRACE_RUNS_MAX = 50;
const TRACE_REDIS_TTL_SECONDS = 60 * 24 * 60 * 60;
const WORLD_STATE_HISTORY_LIMIT = 6;
const FORECAST_REFRESH_REQUEST_KEY = 'forecast:refresh-request:v1';
const PUBLISH_MIN_PROBABILITY = 0;
const PANEL_MIN_PROBABILITY = 0.1;
const CANONICAL_PAYLOAD_SOFT_LIMIT_BYTES = 4 * 1024 * 1024;
const ENRICHMENT_COMBINED_MAX = 5;
const ENRICHMENT_SCENARIO_MAX = 3;
const ENRICHMENT_MAX_PER_DOMAIN = 2;
const ENRICHMENT_MIN_READINESS = 0.34;
const ENRICHMENT_PRIORITY_DOMAINS = ['market', 'military'];
// Situation-overlap suppression should require more than a same-cluster/same-region match.
// We only suppress when overlap is strong enough to look like the same forecast expressed twice.
const DUPLICATE_SCORE_THRESHOLD = 6;
const MAX_PUBLISHED_FORECASTS_PER_SITUATION = 3;
const MAX_PUBLISHED_FORECASTS_PER_SITUATION_DOMAIN = 2;
const MAX_PUBLISHED_FORECASTS_PER_FAMILY = 4;
const MAX_PUBLISHED_FORECASTS_PER_FAMILY_DOMAIN = 2;
const MIN_TARGET_PUBLISHED_FORECASTS = 10;
const MAX_TARGET_PUBLISHED_FORECASTS = 14;
const MAX_PRESELECTED_FORECASTS_PER_FAMILY = 3;
const MAX_PRESELECTED_FORECASTS_PER_SITUATION = 2;
const CYBER_MIN_THREATS_PER_COUNTRY = 5;
const CYBER_MAX_FORECASTS = 12;
const CYBER_SCORE_TYPE_MULTIPLIER = 1.5;    // bonus per distinct threat type
const CYBER_SCORE_CRITICAL_MULTIPLIER = 0.75; // bonus per critical-class threat
const CYBER_PROB_MAX = 0.72;                // probability ceiling for cyber forecasts
const CYBER_PROB_VOLUME_WEIGHT = 0.5;       // weight of volume in probability formula
const CYBER_PROB_TYPE_WEIGHT = 0.15;        // weight of type diversity in probability formula
const MAX_MILITARY_SURGE_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_MILITARY_BUNDLE_DRIFT_MS = 5 * 60 * 1000;

const THEATER_IDS = [
  'iran-theater', 'taiwan-theater', 'baltic-theater',
  'blacksea-theater', 'korea-theater', 'south-china-sea',
  'east-med-theater', 'israel-gaza-theater', 'yemen-redsea-theater',
];

const THEATER_REGIONS = {
  'iran-theater': 'Middle East',
  'taiwan-theater': 'Western Pacific',
  'baltic-theater': 'Northern Europe',
  'blacksea-theater': 'Black Sea',
  'korea-theater': 'Korean Peninsula',
  'south-china-sea': 'South China Sea',
  'east-med-theater': 'Eastern Mediterranean',
  'israel-gaza-theater': 'Israel/Gaza',
  'yemen-redsea-theater': 'Red Sea',
};

const THEATER_LABELS = {
  'iran-theater': 'Iran Theater',
  'taiwan-theater': 'Taiwan Strait',
  'baltic-theater': 'Baltic Theater',
  'blacksea-theater': 'Black Sea',
  'korea-theater': 'Korean Peninsula',
  'south-china-sea': 'South China Sea',
  'east-med-theater': 'Eastern Mediterranean',
  'israel-gaza-theater': 'Israel/Gaza',
  'yemen-redsea-theater': 'Yemen/Red Sea',
};

const THEATER_EXPECTED_ACTORS = {
  'taiwan-theater': { countries: ['China'], operators: ['plaaf', 'plan'] },
  'south-china-sea': { countries: ['China', 'USA', 'Japan', 'Philippines'], operators: ['plaaf', 'plan', 'usaf', 'usn'] },
  'korea-theater': { countries: ['USA', 'South Korea', 'China', 'Japan'], operators: ['usaf', 'usn', 'plaaf'] },
  'baltic-theater': { countries: ['NATO', 'USA', 'UK', 'Germany'], operators: ['nato', 'usaf', 'raf', 'gaf'] },
  'blacksea-theater': { countries: ['Russia', 'NATO', 'Turkey'], operators: ['vks', 'nato'] },
  'iran-theater': { countries: ['Iran', 'USA', 'Israel', 'UK'], operators: ['usaf', 'raf', 'iaf'] },
};

const CHOKEPOINT_COMMODITIES = {
  'Middle East': { commodity: 'Oil', sensitivity: 0.8 },
  'Red Sea': { commodity: 'Shipping/Oil', sensitivity: 0.7 },
  'Israel/Gaza': { commodity: 'Gas/Oil', sensitivity: 0.5 },
  'Eastern Mediterranean': { commodity: 'Gas', sensitivity: 0.4 },
  'Western Pacific': { commodity: 'Semiconductors', sensitivity: 0.9 },
  'South China Sea': { commodity: 'Trade goods', sensitivity: 0.6 },
  'Black Sea': { commodity: 'Grain/Energy', sensitivity: 0.7 },
};

const CHOKEPOINT_MARKET_REGIONS = {
  'Strait of Hormuz': 'Middle East',
  'Bab el-Mandeb': 'Red Sea',
  'Suez Canal': 'Red Sea',
  'Taiwan Strait': 'Western Pacific',
  'Strait of Malacca': 'South China Sea',
  'Kerch Strait': 'Black Sea',
  'Bosporus Strait': 'Black Sea',
};

const MARKET_INPUT_KEYS = {
  stocks: 'market:stocks-bootstrap:v1',
  commodities: 'market:commodities-bootstrap:v1',
  sectors: 'market:sectors:v1',
  gulfQuotes: 'market:gulf-quotes:v1',
  etfFlows: 'market:etf-flows:v1',
  crypto: 'market:crypto:v1',
  stablecoins: 'market:stablecoins:v1',
  bisExchange: 'economic:bis:eer:v1',
  bisPolicy: 'economic:bis:policy:v1',
  shippingRates: 'supply_chain:shipping:v2',
  correlationCards: 'correlation:cards-bootstrap:v1',
};

const FRED_MARKET_INPUT_KEYS = {
  WALCL: 'economic:fred:v1:WALCL:0',
  FEDFUNDS: 'economic:fred:v1:FEDFUNDS:0',
  T10Y2Y: 'economic:fred:v1:T10Y2Y:0',
  UNRATE: 'economic:fred:v1:UNRATE:0',
  CPIAUCSL: 'economic:fred:v1:CPIAUCSL:0',
  DGS10: 'economic:fred:v1:DGS10:0',
  VIXCLS: 'economic:fred:v1:VIXCLS:0',
  GDP: 'economic:fred:v1:GDP:0',
  M2SL: 'economic:fred:v1:M2SL:0',
  DCOILWTICO: 'economic:fred:v1:DCOILWTICO:0',
};

const FRED_MARKET_SERIES = Object.keys(FRED_MARKET_INPUT_KEYS);

const MARKET_BUCKET_CONFIG = [
  {
    id: 'energy',
    label: 'Energy',
    signalTypes: ['energy_supply_shock', 'commodity_repricing', 'inflation_impulse', 'oil_macro_shock', 'global_crude_spread_stress', 'gas_supply_stress'],
    signalWeights: {
      energy_supply_shock: 1.15,
      commodity_repricing: 0.92,
      inflation_impulse: 0.56,
      oil_macro_shock: 1.2,
      global_crude_spread_stress: 1.16,
      gas_supply_stress: 1.08,
    },
    edgeWeight: 0.9,
  },
  {
    id: 'freight',
    label: 'Freight',
    signalTypes: ['shipping_cost_shock', 'inflation_impulse', 'global_crude_spread_stress', 'gas_supply_stress'],
    signalWeights: { shipping_cost_shock: 1.2, inflation_impulse: 0.58, global_crude_spread_stress: 0.82, gas_supply_stress: 0.74 },
    edgeWeight: 1,
  },
  {
    id: 'defense',
    label: 'Defense',
    signalTypes: ['security_escalation', 'defense_repricing'],
    signalWeights: { security_escalation: 0.7, defense_repricing: 1.08 },
    edgeWeight: 0.6,
  },
  {
    id: 'semis',
    label: 'Semiconductors',
    signalTypes: ['shipping_cost_shock', 'cyber_cost_repricing', 'infrastructure_capacity_loss'],
    signalWeights: { shipping_cost_shock: 0.84, cyber_cost_repricing: 1.02, infrastructure_capacity_loss: 0.9 },
    edgeWeight: 0.7,
  },
  {
    id: 'sovereign_risk',
    label: 'Sovereign Risk',
    signalTypes: ['security_escalation', 'sovereign_stress', 'risk_off_rotation', 'yield_curve_stress', 'volatility_shock', 'labor_softness', 'safe_haven_bid'],
    signalWeights: {
      security_escalation: 0.74,
      sovereign_stress: 1.12,
      risk_off_rotation: 0.9,
      yield_curve_stress: 0.8,
      volatility_shock: 0.95,
      labor_softness: 0.74,
      safe_haven_bid: 0.72,
    },
    edgeWeight: 0.82,
  },
  {
    id: 'fx_stress',
    label: 'FX Stress',
    signalTypes: ['fx_stress', 'sovereign_stress', 'risk_off_rotation', 'volatility_shock', 'policy_rate_pressure'],
    signalWeights: { fx_stress: 1.15, sovereign_stress: 0.82, risk_off_rotation: 0.8, volatility_shock: 0.88, policy_rate_pressure: 0.72 },
    edgeWeight: 0.72,
  },
  {
    id: 'rates_inflation',
    label: 'Rates and Inflation',
    signalTypes: ['policy_rate_pressure', 'inflation_impulse', 'energy_supply_shock', 'shipping_cost_shock', 'yield_curve_stress', 'liquidity_withdrawal', 'oil_macro_shock', 'global_crude_spread_stress', 'gas_supply_stress'],
    signalWeights: {
      policy_rate_pressure: 1.02,
      inflation_impulse: 1.06,
      energy_supply_shock: 0.72,
      shipping_cost_shock: 0.68,
      yield_curve_stress: 0.92,
      liquidity_withdrawal: 0.76,
      oil_macro_shock: 0.9,
      global_crude_spread_stress: 0.76,
      gas_supply_stress: 0.7,
    },
    edgeWeight: 0.78,
  },
  {
    id: 'crypto_stablecoins',
    label: 'Crypto and Stablecoins',
    signalTypes: ['risk_off_rotation', 'fx_stress', 'liquidity_expansion', 'liquidity_withdrawal'],
    signalWeights: { risk_off_rotation: 0.74, fx_stress: 0.84, liquidity_expansion: 0.86, liquidity_withdrawal: 0.8 },
    edgeWeight: 0.62,
  },
];

const CORE_MARKET_BUCKET_IDS = ['energy', 'freight', 'sovereign_risk', 'rates_inflation', 'fx_stress'];
const MARKET_BUCKET_COVERAGE_KEYS = {
  energy: ['commodities', 'gulfQuotes', 'fredSeries'],
  freight: ['shippingRates', 'commodities', 'correlationCards'],
  sovereign_risk: ['bisExchange', 'bisPolicy', 'fredSeries', 'correlationCards', 'etfFlows'],
  rates_inflation: ['fredSeries', 'bisPolicy', 'commodities'],
  fx_stress: ['bisExchange', 'bisPolicy', 'fredSeries'],
  semis: ['stocks', 'sectors', 'correlationCards'],
  crypto_stablecoins: ['crypto', 'stablecoins', 'etfFlows'],
  defense: ['sectors', 'stocks', 'correlationCards'],
};
const MARKET_BUCKET_CRITICAL_SIGNAL_TYPES = {
  energy: ['energy_supply_shock', 'gas_supply_stress', 'commodity_repricing', 'oil_macro_shock', 'global_crude_spread_stress'],
  freight: ['shipping_cost_shock', 'energy_supply_shock', 'gas_supply_stress'],
  sovereign_risk: ['sovereign_stress', 'policy_rate_pressure', 'shipping_cost_shock', 'energy_supply_shock'],
  rates_inflation: ['policy_rate_pressure', 'inflation_impulse', 'shipping_cost_shock', 'energy_supply_shock', 'gas_supply_stress', 'commodity_repricing'],
  fx_stress: ['fx_stress', 'sovereign_stress', 'policy_rate_pressure'],
  semis: ['infrastructure_capacity_loss', 'shipping_cost_shock'],
  crypto_stablecoins: ['sovereign_stress', 'fx_stress', 'liquidity_withdrawal'],
  defense: ['defense_repricing', 'security_escalation', 'sovereign_stress'],
};
const MARKET_BUCKET_NEIGHBORS = {
  energy: ['freight', 'rates_inflation', 'sovereign_risk'],
  freight: ['rates_inflation', 'energy', 'sovereign_risk'],
  sovereign_risk: ['fx_stress', 'rates_inflation'],
  rates_inflation: ['fx_stress', 'sovereign_risk'],
  fx_stress: ['sovereign_risk', 'rates_inflation'],
  semis: ['freight', 'fx_stress'],
  crypto_stablecoins: ['fx_stress', 'sovereign_risk'],
  defense: ['sovereign_risk'],
};
const MARKET_BUCKET_REPORTABLE_SCORE_FLOORS = {
  energy: 0.42,
  freight: 0.4,
  sovereign_risk: 0.43,
  rates_inflation: 0.48,
  fx_stress: 0.48,
  semis: 0.52,
  crypto_stablecoins: 0.55,
  defense: 0.62,
};
const MARKET_BUCKET_ALLOWED_CHANNELS = {
  energy: ['energy_supply_shock', 'gas_supply_stress', 'commodity_repricing', 'oil_macro_shock', 'global_crude_spread_stress', 'shipping_cost_shock'],
  freight: ['shipping_cost_shock', 'energy_supply_shock', 'gas_supply_stress', 'commodity_repricing'],
  sovereign_risk: ['sovereign_stress', 'risk_off_rotation', 'security_escalation', 'yield_curve_stress', 'volatility_shock', 'safe_haven_bid', 'policy_rate_pressure'],
  fx_stress: ['fx_stress', 'risk_off_rotation', 'sovereign_stress', 'policy_rate_pressure', 'volatility_shock'],
  rates_inflation: ['policy_rate_pressure', 'inflation_impulse', 'energy_supply_shock', 'shipping_cost_shock', 'yield_curve_stress', 'liquidity_withdrawal', 'oil_macro_shock', 'global_crude_spread_stress', 'gas_supply_stress', 'commodity_repricing'],
  semis: ['cyber_cost_repricing', 'infrastructure_capacity_loss', 'shipping_cost_shock'],
  crypto_stablecoins: ['fx_stress', 'risk_off_rotation', 'liquidity_withdrawal', 'sovereign_stress'],
  defense: ['defense_repricing', 'security_escalation'],
};
// Adjacent-path gating intentionally stays aligned with direct gating for most buckets for now.
// The one explicit exception is sovereign risk, where yield-curve and safe-haven confirmation
// are treated as direct-only signals until we have enough live evidence to broaden the adjacent set.
const MARKET_BUCKET_ADJACENT_CHANNELS = {
  energy: ['shipping_cost_shock', 'energy_supply_shock', 'gas_supply_stress', 'commodity_repricing', 'oil_macro_shock', 'global_crude_spread_stress'],
  freight: ['shipping_cost_shock', 'energy_supply_shock', 'gas_supply_stress', 'commodity_repricing'],
  sovereign_risk: ['sovereign_stress', 'risk_off_rotation', 'security_escalation', 'policy_rate_pressure', 'volatility_shock'],
  fx_stress: ['fx_stress', 'risk_off_rotation', 'sovereign_stress', 'policy_rate_pressure', 'volatility_shock'],
  rates_inflation: ['policy_rate_pressure', 'inflation_impulse', 'energy_supply_shock', 'shipping_cost_shock', 'yield_curve_stress', 'liquidity_withdrawal', 'oil_macro_shock', 'global_crude_spread_stress', 'gas_supply_stress', 'commodity_repricing'],
  semis: ['cyber_cost_repricing', 'infrastructure_capacity_loss', 'shipping_cost_shock'],
  crypto_stablecoins: ['fx_stress', 'risk_off_rotation', 'liquidity_withdrawal', 'sovereign_stress'],
  defense: ['defense_repricing', 'security_escalation'],
};
const MARKET_BUCKET_SIMULATION_BIAS = {
  energy: { confirmation: 0.2, pressure: 0.12, edge: 0.1, contradiction: 0.14 },
  freight: { confirmation: 0.18, pressure: 0.12, edge: 0.1, contradiction: 0.14 },
  sovereign_risk: { confirmation: 0.17, pressure: 0.11, edge: 0.09, contradiction: 0.15 },
  rates_inflation: { confirmation: 0.16, pressure: 0.1, edge: 0.08, contradiction: 0.16 },
  fx_stress: { confirmation: 0.15, pressure: 0.09, edge: 0.08, contradiction: 0.14 },
  semis: { confirmation: 0.13, pressure: 0.08, edge: 0.09, contradiction: 0.12 },
  crypto_stablecoins: { confirmation: 0.11, pressure: 0.07, edge: 0.08, contradiction: 0.12 },
  defense: { confirmation: 0.08, pressure: 0.04, edge: 0.05, contradiction: 0.1 },
};
const MARKET_BUCKET_STATE_CALIBRATION = {
  energy: { edgeLift: 0.08, macroLift: 0.14, confidenceLift: 0.05 },
  freight: { edgeLift: 0.09, macroLift: 0.12, confidenceLift: 0.04 },
  sovereign_risk: { edgeLift: 0.07, macroLift: 0.1, confidenceLift: 0.04 },
  rates_inflation: { edgeLift: 0.06, macroLift: 0.12, confidenceLift: 0.05 },
  fx_stress: { edgeLift: 0.05, macroLift: 0.1, confidenceLift: 0.04 },
  semis: { edgeLift: 0.04, macroLift: 0.04, confidenceLift: 0.02 },
  crypto_stablecoins: { edgeLift: 0.03, macroLift: 0.05, confidenceLift: 0.02 },
  defense: { edgeLift: -0.03, macroLift: 0, confidenceLift: -0.03, dampener: 0.12 },
};

const REGION_MACRO_BUCKETS = {
  'Middle East': 'EMEA',
  'Red Sea': 'EMEA',
  'Israel/Gaza': 'EMEA',
  'Eastern Mediterranean': 'EMEA',
  'Black Sea': 'EMEA',
  'Northern Europe': 'EMEA',
  'Europe': 'EMEA',
  'Western Pacific': 'APAC',
  'South China Sea': 'APAC',
  'Korean Peninsula': 'APAC',
  'Asia-Pacific': 'APAC',
  'Latin America': 'Americas',
  'Americas': 'Americas',
  'United States': 'Americas',
};

const REGION_KEYWORDS = {
  'Middle East': ['mena'],
  'Red Sea': ['mena'],
  'Israel/Gaza': ['mena'],
  'Eastern Mediterranean': ['mena', 'eu'],
  'Western Pacific': ['asia'],
  'South China Sea': ['asia'],
  'Black Sea': ['eu'],
  'Korean Peninsula': ['asia'],
  'Northern Europe': ['eu'],
};

const TEXT_STOPWORDS = new Set([
  'will', 'what', 'when', 'where', 'which', 'this', 'that', 'these', 'those',
  'from', 'into', 'onto', 'over', 'under', 'after', 'before', 'through', 'across',
  'about', 'against', 'near', 'amid', 'during', 'with', 'without', 'between',
  'price', 'prices', 'impact', 'risk', 'forecast', 'future', 'major', 'minor',
  'current', 'latest', 'over', 'path', 'case', 'signal', 'signals',
  'would', 'could', 'should', 'might', 'their', 'there', 'than', 'them',
  'market', 'markets', 'political', 'military', 'conflict', 'supply', 'chain',
  'infrastructure', 'cyber', 'active', 'armed', 'instability', 'escalation',
  'disruption', 'concentration',
]);

const FORECAST_DOMAINS = [
  'conflict',
  'market',
  'supply_chain',
  'political',
  'military',
  'cyber',
  'infrastructure',
];
const MARKET_CLUSTER_DOMAINS = new Set(['market', 'supply_chain']);

function getRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  return { url, token };
}

function getDeployRevision() {
  return process.env.RAILWAY_GIT_COMMIT_SHA
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.GITHUB_SHA
    || '';
}

async function redisCommand(url, token, command) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis command failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function redisGet(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data?.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function redisDel(url, token, key) {
  return redisCommand(url, token, ['DEL', key]);
}

// ── Phase 4: Input normalizers ──────────────────────────────
function normalizeChokepoints(raw) {
  if (!raw?.chokepoints && !raw?.corridors) return raw;
  const items = raw.chokepoints || raw.corridors || [];
  return {
    ...raw,
    chokepoints: items.map(cp => ({
      ...cp,
      region: cp.name || cp.region || '',
      riskScore: cp.disruptionScore ?? cp.riskScore ?? 0,
      riskLevel: cp.status === 'red' ? 'critical' : cp.status === 'yellow' ? 'high' : cp.riskLevel || 'normal',
      disrupted: cp.status === 'red' || cp.disrupted || false,
    })),
  };
}

function normalizeGpsJamming(raw) {
  if (!raw) return raw;
  if (raw.hexes && !raw.zones) return { ...raw, zones: raw.hexes };
  return raw;
}

async function warmPingChokepoints() {
  const baseUrl = process.env.WM_API_BASE_URL;
  if (!baseUrl) { console.log('  [Chokepoints] Warm-ping skipped (no WM_API_BASE_URL)'); return; }
  try {
    const resp = await fetch(`${baseUrl}/api/supply-chain/v1/get-chokepoint-status`, {
      headers: { 'User-Agent': CHROME_UA, Origin: 'https://worldmonitor.app' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) console.warn(`  [Chokepoints] Warm-ping failed: HTTP ${resp.status}`);
    else console.log('  [Chokepoints] Warm-ping OK');
  } catch (err) { console.warn(`  [Chokepoints] Warm-ping error: ${err.message}`); }
}

async function readInputKeys() {
  const { url, token } = getRedisCredentials();
  const fredKeys = FRED_MARKET_SERIES.map((seriesId) => FRED_MARKET_INPUT_KEYS[seriesId]);
  const keys = [
    'risk:scores:sebuf:stale:v1',
    'temporal:anomalies:v1',
    'theater_posture:sebuf:stale:v1',
    'military:forecast-inputs:stale:v1',
    'prediction:markets-bootstrap:v1',
    'supply_chain:chokepoints:v4',
    'conflict:iran-events:v1',
    'conflict:ucdp-events:v1',
    'unrest:events:v1',
    'infra:outages:v1',
    'cyber:threats-bootstrap:v2',
    'intelligence:gpsjam:v2',
    'news:insights:v1',
    'news:digest:v1:full:en',
    'sanctions:pressure:v1',
    'thermal:escalation:v1',
    MARKET_INPUT_KEYS.stocks,
    MARKET_INPUT_KEYS.commodities,
    MARKET_INPUT_KEYS.sectors,
    MARKET_INPUT_KEYS.gulfQuotes,
    MARKET_INPUT_KEYS.etfFlows,
    MARKET_INPUT_KEYS.crypto,
    MARKET_INPUT_KEYS.stablecoins,
    MARKET_INPUT_KEYS.bisExchange,
    MARKET_INPUT_KEYS.bisPolicy,
    MARKET_INPUT_KEYS.shippingRates,
    MARKET_INPUT_KEYS.correlationCards,
    ...fredKeys,
  ];
  const pipeline = keys.map(k => ['GET', k]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Redis pipeline failed: ${resp.status}`);
  const results = await resp.json();

  const parse = (i) => {
    try { return results[i]?.result ? JSON.parse(results[i].result) : null; } catch { return null; }
  };
  const parsedByKey = Object.fromEntries(keys.map((key, index) => [key, parse(index)]));
  const fredSeries = Object.fromEntries(
    FRED_MARKET_SERIES
      .map((seriesId) => [seriesId, parsedByKey[FRED_MARKET_INPUT_KEYS[seriesId]]])
      .filter(([, value]) => value),
  );

  return {
    ciiScores: parsedByKey['risk:scores:sebuf:stale:v1'],
    temporalAnomalies: parsedByKey['temporal:anomalies:v1'],
    theaterPosture: parsedByKey['theater_posture:sebuf:stale:v1'],
    militaryForecastInputs: parsedByKey['military:forecast-inputs:stale:v1'],
    predictionMarkets: parsedByKey['prediction:markets-bootstrap:v1'],
    chokepoints: normalizeChokepoints(parsedByKey['supply_chain:chokepoints:v4']),
    iranEvents: parsedByKey['conflict:iran-events:v1'],
    ucdpEvents: parsedByKey['conflict:ucdp-events:v1'],
    unrestEvents: parsedByKey['unrest:events:v1'],
    outages: parsedByKey['infra:outages:v1'],
    cyberThreats: parsedByKey['cyber:threats-bootstrap:v2'],
    gpsJamming: normalizeGpsJamming(parsedByKey['intelligence:gpsjam:v2']),
    newsInsights: parsedByKey['news:insights:v1'],
    newsDigest: parsedByKey['news:digest:v1:full:en'],
    sanctionsPressure: parsedByKey['sanctions:pressure:v1'],
    thermalEscalation: parsedByKey['thermal:escalation:v1'],
    marketQuotes: parsedByKey[MARKET_INPUT_KEYS.stocks],
    commodityQuotes: parsedByKey[MARKET_INPUT_KEYS.commodities],
    sectorSummary: parsedByKey[MARKET_INPUT_KEYS.sectors],
    gulfQuotes: parsedByKey[MARKET_INPUT_KEYS.gulfQuotes],
    etfFlows: parsedByKey[MARKET_INPUT_KEYS.etfFlows],
    cryptoQuotes: parsedByKey[MARKET_INPUT_KEYS.crypto],
    stablecoinMarkets: parsedByKey[MARKET_INPUT_KEYS.stablecoins],
    bisExchangeRates: parsedByKey[MARKET_INPUT_KEYS.bisExchange],
    bisPolicyRates: parsedByKey[MARKET_INPUT_KEYS.bisPolicy],
    shippingRates: parsedByKey[MARKET_INPUT_KEYS.shippingRates],
    correlationCards: parsedByKey[MARKET_INPUT_KEYS.correlationCards],
    fredSeries,
  };
}

function forecastId(domain, region, title) {
  const hash = crypto.createHash('sha256')
    .update(`${domain}:${region}:${title}`)
    .digest('hex').slice(0, 8);
  return `fc-${domain}-${hash}`;
}

function normalize(value, min, max) {
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function getFreshMilitaryForecastInputs(inputs, now = Date.now()) {
  const bundle = inputs?.militaryForecastInputs;
  if (!bundle || typeof bundle !== 'object') return null;

  const fetchedAt = Number(bundle.fetchedAt || 0);
  if (!fetchedAt || now - fetchedAt > MAX_MILITARY_SURGE_AGE_MS) return null;

  const theaters = Array.isArray(bundle.theaters) ? bundle.theaters : [];
  const surges = Array.isArray(bundle.surges) ? bundle.surges : [];

  const isAligned = (value) => {
    const ts = Number(value || 0);
    if (!ts) return true;
    return Math.abs(ts - fetchedAt) <= MAX_MILITARY_BUNDLE_DRIFT_MS;
  };

  if (!theaters.every((theater) => isAligned(theater?.assessedAt))) return null;
  if (!surges.every((surge) => isAligned(surge?.assessedAt))) return null;

  return bundle;
}

function selectPrimaryMilitarySurge(_theaterId, surges) {
  const typePriority = { fighter: 3, airlift: 2, air_activity: 1 };
  return surges
    .slice()
    .sort((a, b) => {
      const aScore = (typePriority[a.surgeType] || 0) * 10
        + (a.persistent ? 5 : 0)
        + (a.persistenceCount || 0) * 2
        + (a.strikeCapable ? 2 : 0)
        + (a.awacs > 0 || a.tankers > 0 ? 1 : 0)
        + (a.surgeMultiple || 0);
      const bScore = (typePriority[b.surgeType] || 0) * 10
        + (b.persistent ? 5 : 0)
        + (b.persistenceCount || 0) * 2
        + (b.strikeCapable ? 2 : 0)
        + (b.awacs > 0 || b.tankers > 0 ? 1 : 0)
        + (b.surgeMultiple || 0);
      return bScore - aScore;
    })[0] || null;
}

function computeTheaterActorScore(theaterId, surge) {
  if (!surge) return 0;
  const expected = THEATER_EXPECTED_ACTORS[theaterId];
  if (!expected) return 0;

  const dominantCountry = surge.dominantCountry || '';
  const dominantOperator = surge.dominantOperator || '';
  const countryMatch = dominantCountry && expected.countries.includes(dominantCountry);
  const operatorMatch = dominantOperator && expected.operators.includes(dominantOperator);

  if (countryMatch || operatorMatch) return 0.12;
  if (dominantCountry || dominantOperator) return -0.12;
  return 0;
}

function canPromoteMilitarySurge(posture, surge) {
  if (!surge) return false;
  if (surge.surgeType !== 'air_activity') return true;
  if (posture === 'critical' || posture === 'elevated') return true;
  if (surge.persistent || surge.surgeMultiple >= 3.5) return true;
  if (surge.strikeCapable || surge.fighters >= 4 || surge.awacs > 0 || surge.tankers > 0) return true;
  return false;
}

function buildMilitaryForecastTitle(_theaterId, theaterLabel, surge) {
  if (!surge) return `Military posture escalation: ${theaterLabel}`;
  const countryPrefix = surge.dominantCountry ? `${surge.dominantCountry}-linked ` : '';
  if (surge.surgeType === 'fighter') return `${countryPrefix}fighter surge near ${theaterLabel}`;
  if (surge.surgeType === 'airlift') return `${countryPrefix}airlift surge near ${theaterLabel}`;
  return `Elevated military air activity near ${theaterLabel}`;
}

function resolveCountryName(raw) {
  if (!raw || raw.length > 3) return raw; // already a full name or long-form
  const codes = loadCountryCodes();
  return codes[raw]?.name || raw;
}

function makePrediction(domain, region, title, probability, confidence, timeHorizon, signals) {
  const now = Date.now();
  return {
    id: forecastId(domain, region, title),
    domain,
    region,
    title,
    scenario: '',
    feedSummary: '',
    probability: Math.round(Math.max(0, Math.min(1, probability)) * 1000) / 1000,
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 1000) / 1000,
    timeHorizon,
    signals,
    cascades: [],
    trend: 'stable',
    priorProbability: 0,
    calibration: null,
    caseFile: null,
    generationOrigin: 'legacy_detector',
    stateDerivedBackfill: false,
    createdAt: now,
    updatedAt: now,
  };
}

// Normalize CII data from sebuf proto format (server-side) to uniform shape.
// Server writes: { ciiScores: [{ region, combinedScore, trend: 'TREND_DIRECTION_RISING', components: {...} }] }
// Frontend computes: [{ code, name, score, level, trend: 'rising', components: { unrest, conflict, ... } }]
function normalizeCiiEntry(c) {
  const score = c.combinedScore ?? c.score ?? c.dynamicScore ?? 0;
  const code = c.region || c.code || '';
  const rawTrend = (c.trend || '').toLowerCase();
  const trend = rawTrend.includes('rising') ? 'rising'
    : rawTrend.includes('falling') ? 'falling'
    : 'stable';
  const level = score >= 81 ? 'critical' : score >= 66 ? 'high' : score >= 51 ? 'elevated' : score >= 31 ? 'normal' : 'low';
  const unrestCandidates = [
    c.components?.unrest,
    c.components?.protest,
    c.components?.geoConvergence,
    c.components?.ciiContribution,
    c.components?.newsActivity,
  ].filter(value => typeof value === 'number' && Number.isFinite(value));
  const unrest = unrestCandidates.length > 0 ? Math.max(...unrestCandidates) : 0;
  // Resolve ISO code to full country name (prevents substring false positives: IL matching Chile)
  let name = c.name || '';
  if (!name && code) {
    const codes = loadCountryCodes();
    name = codes[code]?.name || code;
  }
  return { code, name, score, level, trend, change24h: c.change24h ?? 0, components: { ...c.components, unrest } };
}

function resolveChokepointMarketRegion(cp) {
  const rawRegion = cp.region || cp.name || '';
  if (!rawRegion) return null;
  if (CHOKEPOINT_COMMODITIES[rawRegion]) return rawRegion;
  return CHOKEPOINT_MARKET_REGIONS[rawRegion] || null;
}

function extractCiiScores(inputs) {
  const raw = inputs.ciiScores;
  if (!raw) return [];
  // sebuf proto: { ciiScores: [...] }, frontend: array or { scores: [...] }
  const arr = Array.isArray(raw) ? raw : raw.ciiScores || raw.scores || [];
  return arr.map(normalizeCiiEntry);
}

function detectConflictScenarios(inputs) {
  const predictions = [];
  const scores = extractCiiScores(inputs);
  const theaters = inputs.theaterPosture?.theaters || [];
  const iran = Array.isArray(inputs.iranEvents) ? inputs.iranEvents : inputs.iranEvents?.events || [];
  const ucdp = Array.isArray(inputs.ucdpEvents) ? inputs.ucdpEvents : inputs.ucdpEvents?.events || [];

  for (const c of scores) {
    if (!c.score || c.score <= 60) continue;
    if (c.level !== 'high' && c.level !== 'critical') continue;

    const signals = [
      { type: 'cii', value: `${c.name} CII ${c.score} (${c.level})`, weight: 0.4 },
    ];
    let sourceCount = 1;

    if (c.change24h && Math.abs(c.change24h) > 2) {
      signals.push({ type: 'cii_delta', value: `24h change ${c.change24h > 0 ? '+' : ''}${c.change24h.toFixed(1)}`, weight: 0.2 });
      sourceCount++;
    }

    // Use word-boundary regex to prevent substring false positives (IL matching Chile)
    const countryName = c.name.toLowerCase();
    const countryCode = c.code.toLowerCase();
    const matchRegex = new RegExp(`\\b(${countryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${countryCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'i');
    const matchingIran = iran.filter(e => matchRegex.test(e.country || e.location || ''));
    if (matchingIran.length > 0) {
      signals.push({ type: 'conflict_events', value: `${matchingIran.length} Iran-related events`, weight: 0.2 });
      sourceCount++;
    }

    const matchingUcdp = ucdp.filter(e => matchRegex.test(e.country || e.location || ''));
    if (matchingUcdp.length > 0) {
      signals.push({ type: 'ucdp', value: `${matchingUcdp.length} UCDP events`, weight: 0.2 });
      sourceCount++;
    }

    const ciiNorm = normalize(c.score, 50, 100);
    const eventBoost = (matchingIran.length + matchingUcdp.length) > 0 ? 0.1 : 0;
    const prob = Math.min(0.9, ciiNorm * 0.6 + eventBoost + (c.trend === 'rising' ? 0.1 : 0));
    const confidence = Math.max(0.3, normalize(sourceCount, 0, 4));

    predictions.push(makePrediction(
      'conflict', c.name,
      `Escalation risk: ${c.name}`,
      prob, confidence, '7d', signals,
    ));
  }

  for (const t of theaters) {
    const theaterId = t?.id || t?.theater;
    if (!theaterId) continue;
    const posture = t.postureLevel || t.posture || '';
    if (posture !== 'critical' && posture !== 'elevated') continue;
    const region = THEATER_REGIONS[theaterId] || t.name || theaterId;
    const alreadyCovered = predictions.some(p => p.region === region);
    if (alreadyCovered) continue;

    const signals = [
      { type: 'theater', value: `${t.name || theaterId} posture: ${posture}`, weight: 0.5 },
    ];
    const prob = posture === 'critical' ? 0.65 : 0.4;

    predictions.push(makePrediction(
      'conflict', region,
      `Theater escalation: ${region}`,
      prob, 0.5, '7d', signals,
    ));
  }

  return predictions;
}

function detectMarketScenarios(inputs) {
  const predictions = [];
  const chokepoints = inputs.chokepoints?.routes || inputs.chokepoints?.chokepoints || [];
  const scores = extractCiiScores(inputs);

  const affectedRegions = new Set();

  for (const cp of chokepoints) {
    const risk = cp.riskLevel || cp.risk || '';
    if (risk !== 'high' && risk !== 'critical' && (cp.riskScore || 0) < 60) continue;
    const region = resolveChokepointMarketRegion(cp);
    if (!region) continue;

    const commodity = CHOKEPOINT_COMMODITIES[region];
    if (!commodity) continue;

    if (affectedRegions.has(region)) continue;
    affectedRegions.add(region);

    const riskNorm = normalize(cp.riskScore || (risk === 'critical' ? 85 : 70), 40, 100);
    const prob = Math.min(0.85, riskNorm * commodity.sensitivity);

    predictions.push(makePrediction(
      'market', region,
      `${commodity.commodity} price impact from ${(cp.name || cp.region || region)} disruption`,
      prob, 0.6, '30d',
      [{ type: 'chokepoint', value: `${cp.name || region} risk: ${risk}`, weight: 0.5 },
       { type: 'commodity', value: `${commodity.commodity} sensitivity: ${commodity.sensitivity}`, weight: 0.3 }],
    ));
  }

  // Map high-CII countries to their commodity-sensitive theater via entity graph
  const graph = loadEntityGraph();
  for (const c of scores) {
    if (!c.score || c.score <= 75) continue;
    const countryName = c.name || resolveCountryName(c.code || '') || c.code;
    // Find theater region: check entity graph links for theater nodes with commodity sensitivity
    const nodeId = graph.aliases?.[c.code] || graph.aliases?.[c.name];
    const node = nodeId ? graph.nodes?.[nodeId] : null;
    let region = null;
    if (node) {
      for (const linkId of node.links || []) {
        const linked = graph.nodes?.[linkId];
        if (linked?.type === 'theater' && CHOKEPOINT_COMMODITIES[linked.name]) {
          region = linked.name;
          break;
        }
      }
    }
    // Fallback: direct theater region lookup
    if (!region) {
      const matchedTheater = Object.entries(THEATER_REGIONS).find(([id]) => {
        const theaterId = graph.aliases?.[c.name] || graph.aliases?.[c.code];
        return theaterId && graph.nodes?.[theaterId]?.links?.includes(id);
      });
      region = matchedTheater ? THEATER_REGIONS[matchedTheater[0]] : null;
    }
    if (!region || affectedRegions.has(region)) continue;

    const commodity = CHOKEPOINT_COMMODITIES[region];
    if (!commodity) continue;
    affectedRegions.add(region);

    const prob = Math.min(0.7, normalize(c.score, 60, 100) * commodity.sensitivity * 0.8);
    predictions.push(makePrediction(
      'market', region,
      `${commodity.commodity} volatility from ${countryName} instability`,
      prob, 0.4, '30d',
      [{ type: 'cii', value: `${countryName} CII ${c.score}`, weight: 0.4 },
       { type: 'commodity', value: `${commodity.commodity} sensitivity: ${commodity.sensitivity}`, weight: 0.3 }],
    ));
  }

  return predictions;
}

function detectSupplyChainScenarios(inputs) {
  const predictions = [];
  const chokepoints = inputs.chokepoints?.routes || inputs.chokepoints?.chokepoints || [];
  const anomalies = Array.isArray(inputs.temporalAnomalies) ? inputs.temporalAnomalies : inputs.temporalAnomalies?.anomalies || [];
  const jamming = Array.isArray(inputs.gpsJamming) ? inputs.gpsJamming : inputs.gpsJamming?.zones || [];

  const seenRoutes = new Set();

  for (const cp of chokepoints) {
    const disrupted = cp.disrupted || cp.status === 'disrupted' || (cp.riskScore || 0) > 65;
    if (!disrupted) continue;

    const route = cp.route || cp.name || cp.region || '';
    if (!route || seenRoutes.has(route)) continue;
    seenRoutes.add(route);

    const signals = [
      { type: 'chokepoint', value: `${route} disruption detected`, weight: 0.5 },
    ];
    let sourceCount = 1;

    const aisGaps = anomalies.filter(a =>
      (a.type === 'ais_gaps' || a.type === 'ais_gap') &&
      (a.region || a.zone || '').toLowerCase().includes(route.toLowerCase()),
    );
    if (aisGaps.length > 0) {
      signals.push({ type: 'ais_gap', value: `${aisGaps.length} AIS gap anomalies near ${route}`, weight: 0.3 });
      sourceCount++;
    }

    const nearbyJam = jamming.filter(j =>
      (j.region || j.zone || j.name || '').toLowerCase().includes(route.toLowerCase()),
    );
    if (nearbyJam.length > 0) {
      signals.push({ type: 'gps_jamming', value: `GPS interference near ${route}`, weight: 0.2 });
      sourceCount++;
    }

    const riskNorm = normalize(cp.riskScore || 70, 40, 100);
    const prob = Math.min(0.85, riskNorm * 0.7 + (aisGaps.length > 0 ? 0.1 : 0) + (nearbyJam.length > 0 ? 0.05 : 0));
    const confidence = Math.max(0.3, normalize(sourceCount, 0, 4));

    predictions.push(makePrediction(
      'supply_chain', cp.region || route,
      `Supply chain disruption: ${route}`,
      prob, confidence, '7d', signals,
    ));
  }

  return predictions;
}

function buildStateDomainCoverageIndex(predictions = []) {
  const index = new Map();
  for (const pred of predictions || []) {
    const stateId = getForecastSelectionStateContext(pred)?.id || '';
    if (!stateId) continue;
    let entry = index.get(stateId);
    if (!entry) {
      entry = new Set();
      index.set(stateId, entry);
    }
    entry.add(pred.domain);
  }
  return index;
}

function getStateDerivedBucketSignalTypes(domain, bucketId) {
  if (domain === 'supply_chain') {
    if (bucketId === 'freight') return ['shipping_cost_shock', 'infrastructure_capacity_loss', 'energy_supply_shock', 'gas_supply_stress'];
    if (bucketId === 'energy') return ['shipping_cost_shock', 'energy_supply_shock', 'gas_supply_stress', 'global_crude_spread_stress'];
    return [];
  }
  if (domain === 'market') {
    if (bucketId === 'energy') return ['energy_supply_shock', 'commodity_repricing', 'oil_macro_shock', 'global_crude_spread_stress', 'gas_supply_stress'];
    if (bucketId === 'sovereign_risk') return ['sovereign_stress', 'risk_off_rotation', 'yield_curve_stress', 'volatility_shock', 'safe_haven_bid'];
    if (bucketId === 'rates_inflation') return ['policy_rate_pressure', 'inflation_impulse', 'energy_supply_shock', 'shipping_cost_shock', 'yield_curve_stress', 'oil_macro_shock', 'gas_supply_stress'];
    if (bucketId === 'fx_stress') return ['fx_stress', 'sovereign_stress', 'risk_off_rotation', 'policy_rate_pressure', 'volatility_shock'];
    return [];
  }
  return [];
}

function getStateDerivedAllowedBuckets(domain) {
  if (domain === 'supply_chain') return ['freight', 'energy'];
  if (domain === 'market') return ['energy', 'sovereign_risk', 'rates_inflation', 'fx_stress'];
  return [];
}

function getStateDerivedMinimumScore(domain, bucketId) {
  if (domain === 'supply_chain') {
    if (bucketId === 'freight') return 0.4;
    if (bucketId === 'energy') return 0.44;
    return 0.45;
  }
  if (bucketId === 'energy') return 0.42;
  if (bucketId === 'sovereign_risk') return 0.44;
  if (bucketId === 'rates_inflation') return 0.47;
  if (bucketId === 'fx_stress') return 0.48;
  return 0.48;
}

function buildStateDerivedForecastTitle(domain, stateUnit, bucketId, bucketLabel) {
  if (domain === 'supply_chain') {
    if (bucketId === 'freight') return `Supply chain disruption risk from ${stateUnit.label}`;
    if (bucketId === 'energy') return `Maritime energy flow disruption from ${stateUnit.label}`;
    return `Supply chain stress from ${stateUnit.label}`;
  }

  if (bucketId === 'energy') return `Energy repricing risk from ${stateUnit.label}`;
  if (bucketId === 'sovereign_risk') return `Sovereign risk repricing from ${stateUnit.label}`;
  if (bucketId === 'rates_inflation') return `Inflation and rates pressure from ${stateUnit.label}`;
  if (bucketId === 'fx_stress') return `FX stress from ${stateUnit.label}`;
  return `${bucketLabel || 'Market'} repricing from ${stateUnit.label}`;
}

function humanizeTransmissionChannel(channel) {
  return String(channel || 'derived_transmission').replace(/_/g, ' ');
}

function buildNarrativeSentence(...parts) {
  return parts
    .map((part) => String(part || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
    .join(' ');
}

function buildStateDerivedLeadSignal(domain, stateUnit, bucket, marketContext, channel = '') {
  const channelLabel = humanizeTransmissionChannel(channel || marketContext?.topChannel);
  const pressure = roundPct(bucket.pressureScore || 0);
  const confirmation = roundPct(marketContext?.confirmationScore || 0);

  if (domain === 'supply_chain') {
    if (bucket.id === 'freight') {
      return `${stateUnit.label} is disrupting freight and shipping flows through ${channelLabel}, with ${pressure} freight pressure and ${confirmation} state confirmation`;
    }
    if (bucket.id === 'energy') {
      return `${stateUnit.label} is constraining maritime energy flows through ${channelLabel}, with ${pressure} energy pressure and ${confirmation} state confirmation`;
    }
  }

  if (bucket.id === 'energy') {
    return `${stateUnit.label} is feeding energy repricing through ${channelLabel}, with ${pressure} pressure and ${confirmation} state confirmation`;
  }
  if (bucket.id === 'sovereign_risk') {
    return `${stateUnit.label} is keeping sovereign risk elevated through ${channelLabel}, with ${pressure} pressure and ${confirmation} state confirmation`;
  }
  if (bucket.id === 'rates_inflation') {
    return `${stateUnit.label} is feeding inflation and rates pressure through ${channelLabel}, with ${pressure} pressure and ${confirmation} state confirmation`;
  }
  if (bucket.id === 'fx_stress') {
    return `${stateUnit.label} is keeping FX stress active through ${channelLabel}, with ${pressure} pressure and ${confirmation} state confirmation`;
  }

  return `${stateUnit.label} is transmitting into ${bucket.label} through ${channelLabel}, with ${pressure} pressure and ${confirmation} state confirmation`;
}

function buildStateDerivedFeedSummary(domain, stateUnit, bucket, marketContext, channel = '') {
  const channelLabel = humanizeTransmissionChannel(channel || marketContext?.topChannel);
  const evidence = [];
  if ((marketContext?.transmissionEdgeCount || 0) > 0) evidence.push(`${marketContext.transmissionEdgeCount} transmission path(s)`);
  if ((marketContext?.criticalSignalCount || 0) > 0) evidence.push(`${marketContext.criticalSignalCount} urgent critical signal(s)`);
  const tail = evidence.length ? ` backed by ${evidence.join(' and ')}` : '';

  if (domain === 'supply_chain') {
    if (bucket.id === 'freight') return `${stateUnit.label} is carrying freight disruption through ${channelLabel}${tail}.`;
    if (bucket.id === 'energy') return `${stateUnit.label} is carrying maritime energy-flow disruption through ${channelLabel}${tail}.`;
  }

  if (bucket.id === 'energy') return `${stateUnit.label} is carrying energy repricing pressure through ${channelLabel}${tail}.`;
  if (bucket.id === 'sovereign_risk') return `${stateUnit.label} is carrying sovereign-risk repricing through ${channelLabel}${tail}.`;
  if (bucket.id === 'rates_inflation') return `${stateUnit.label} is carrying inflation-and-rates pressure through ${channelLabel}${tail}.`;
  if (bucket.id === 'fx_stress') return `${stateUnit.label} is carrying FX-stress pressure through ${channelLabel}${tail}.`;
  return `${stateUnit.label} is carrying ${bucket.label.toLowerCase()} pressure through ${channelLabel}${tail}.`;
}

function computeStateDerivedBucketCandidate(domain, stateUnit, bucket, marketContext, linkedSignalTypes = [], marketInputCoverage = null) {
  const supportedTypes = getStateDerivedBucketSignalTypes(domain, bucket.id);
  if (!supportedTypes.length) return null;

  const bucketContext = marketContext?.bucketContexts?.[bucket.id] || null;
  const bucketSignalTypes = uniqueSortedStrings([
    ...(bucketContext?.supportingSignalTypes || []),
    ...linkedSignalTypes,
  ]);
  const overlapTypes = supportedTypes.filter((type) => bucketSignalTypes.includes(type));
  const channel = bucketContext?.topChannel || marketContext?.topChannel || '';
  const channelMatch = channel && supportedTypes.includes(channel);
  const channelAllowed = isMarketBucketChannelAllowed(bucket.id, channel, 'direct');
  const signalMatchCount = overlapTypes.length;
  const stateDomainMatch = intersectAny(stateUnit?.domains || [], domain === 'supply_chain'
    ? ['supply_chain', 'market', 'conflict', 'infrastructure']
    : ['market', 'supply_chain', 'conflict', 'political', 'infrastructure', 'cyber']);
  const directBucket = bucket.id === (marketContext?.topBucketId || '');
  const criticalAlignment = computeCriticalBucketAlignment(bucket.id, marketContext?.criticalSignalTypes || []);
  const criticalLift = criticalAlignment * Number(marketContext?.criticalSignalLift || 0);
  const coverageScore = computeMarketBucketCoverageScore(bucket.id, marketInputCoverage);
  const supportScore = clampUnitInterval(
    Math.min(0.42, signalMatchCount * 0.14) +
    (channelMatch ? 0.12 : 0) +
    (stateDomainMatch ? 0.07 : 0) +
    (directBucket ? 0.06 : 0) +
    (domain === 'supply_chain' && directBucket ? 0.05 : 0),
  );

  const supplyChainFallbackEligible = domain === 'supply_chain'
    && stateDomainMatch
    && directBucket
    && ['freight', 'energy'].includes(bucket.id)
    && channelAllowed
    && (
      channelMatch
      || (marketContext?.transmissionEdgeCount || 0) > 0
      || criticalAlignment >= 0.25
      || Number(bucket.pressureScore || 0) >= 0.62
    );
  const eligible = (
    (signalMatchCount > 0 && channelAllowed)
    || (channelAllowed && stateDomainMatch && directBucket && channelMatch)
    || (domain === 'supply_chain' && bucket.id === 'freight' && stateDomainMatch && directBucket && channel === 'shipping_cost_shock')
    || supplyChainFallbackEligible
  );
  if (!eligible) return null;

  const score = clampUnitInterval(
    (Number(marketContext?.confirmationScore || 0) * 0.28) +
    (Number(bucket.pressureScore || 0) * 0.22) +
    (Number(bucket.confidence || 0) * 0.14) +
    (Number(bucketContext?.topTransmissionStrength || marketContext?.topTransmissionStrength || 0) * 0.1) +
    (Number(stateUnit?.avgProbability || 0) * 0.12) +
    (Number(stateUnit?.avgConfidence || 0) * 0.08) +
    (criticalLift * 0.14) +
    (supportScore * 0.1) +
    (CORE_MARKET_BUCKET_IDS.includes(bucket.id) && coverageScore < 0.45 ? 0.03 : 0),
  );

  return {
    bucketId: bucket.id,
    bucketLabel: bucket.label,
    score: +score.toFixed(3),
    coverageScore,
    criticalAlignment: +criticalAlignment.toFixed(3),
    criticalLift: +criticalLift.toFixed(3),
    signalMatchCount,
    supportScore: +supportScore.toFixed(3),
    primarySignalType: overlapTypes[0] || channel || supportedTypes[0] || '',
    primaryChannel: channel,
    bucketSignalTypes,
    minimumScore: getStateDerivedMinimumScore(domain, bucket.id),
    fallbackScore: Math.max(0.3, getStateDerivedMinimumScore(domain, bucket.id) - 0.08 - (coverageScore < 0.45 ? 0.03 : 0)),
  };
}

function buildStateDerivedForecast(stateUnit, domain, bucket, candidate, marketContext) {
  const bucketContext = marketContext?.bucketContexts?.[bucket.id] || null;
  const title = buildStateDerivedForecastTitle(domain, stateUnit, bucket.id, bucket.label);
  const probability = clampUnitInterval(
    (candidate.score * 0.56) +
    (Number(bucket.pressureScore || 0) * 0.24) +
    (Number(stateUnit?.avgProbability || 0) * 0.18),
  );
  const confidence = clampUnitInterval(
    (candidate.score * 0.34) +
    (Number(bucket.confidence || 0) * 0.28) +
    (Number(marketContext?.confirmationScore || 0) * 0.22) +
    (candidate.criticalLift * 0.12) +
    (Number(stateUnit?.avgConfidence || 0) * 0.1),
  );
  const signals = [
    {
      type: candidate.primarySignalType || candidate.primaryChannel || bucketContext?.topChannel || marketContext?.topChannel || 'derived_transmission',
      value: buildStateDerivedLeadSignal(domain, stateUnit, bucket, marketContext, candidate.primaryChannel || bucketContext?.topChannel || marketContext?.topChannel || ''),
      weight: 0.42,
    },
    {
      type: 'state_unit',
      value: `${stateUnit.label} combines ${stateUnit.situationCount || 0} clustered situations and ${stateUnit.forecastCount || 0} linked forecasts into one canonical state path.`,
      weight: 0.26,
    },
    {
      type: 'market_transmission',
      value: `The strongest transmission path runs through ${humanizeTransmissionChannel(candidate.primaryChannel || bucketContext?.topChannel || marketContext?.topChannel || '')} across ${bucketContext?.edgeCount || marketContext?.transmissionEdgeCount || 0} edge(s) toward ${bucket.label}.`,
      weight: 0.24,
    },
  ];
  if ((marketContext?.criticalSignalCount || 0) > 0) {
    signals.push({
      type: 'critical_news_signal',
      value: `${marketContext.criticalSignalCount} urgent critical signals are reinforcing ${bucket.label} pressure for ${stateUnit.label}.`,
      weight: 0.2,
    });
  }

  const prediction = makePrediction(
    domain,
    stateUnit?.dominantRegion || stateUnit?.regions?.[0] || '',
    title,
    probability,
    confidence,
    domain === 'supply_chain' ? '7d' : '30d',
    signals,
  );
  prediction.generationOrigin = 'state_derived';
  prediction.feedSummary = buildStateDerivedFeedSummary(
    domain,
    stateUnit,
    bucket,
    marketContext,
    candidate.primaryChannel || bucketContext?.topChannel || marketContext?.topChannel || '',
  );
  prediction.caseFile = buildForecastCase(prediction);
  prediction.stateDerivation = {
    sourceStateId: stateUnit.id,
    sourceStateLabel: stateUnit.label,
    sourceStateKind: stateUnit.stateKind || '',
    bucketId: bucket.id,
    bucketLabel: bucket.label,
    channel: candidate.primaryChannel || bucketContext?.topChannel || marketContext?.topChannel || '',
    macroRegion: getMacroRegion(stateUnit?.regions || []) || '',
  };
  prediction.caseFile.stateDerivation = prediction.stateDerivation;
  return prediction;
}

function deriveStateDrivenForecasts({
  existingPredictions = [],
  stateUnits = [],
  worldSignals = null,
  marketTransmission = null,
  marketState = null,
  marketInputCoverage = null,
} = {}) {
  if (!Array.isArray(stateUnits) || stateUnits.length === 0) return [];

  const marketIndex = buildSituationMarketContextIndex(
    worldSignals,
    marketTransmission,
    marketState,
    stateUnits,
    marketInputCoverage,
  );
  const signalMap = new Map((worldSignals?.signals || []).map((signal) => [signal.id, signal]));
  const bucketMap = new Map((marketState?.buckets || []).map((bucket) => [bucket.id, bucket]));
  const existingDomainsByState = buildStateDomainCoverageIndex(existingPredictions);
  const derived = [];
  const fallbackByDomain = new Map();

  for (const stateUnit of stateUnits) {
    const marketContext = marketIndex?.bySituationId?.get(stateUnit.id) || null;
    if (!marketContext || !(marketContext.linkedBucketIds || []).length) continue;
    const existingDomains = existingDomainsByState.get(stateUnit.id) || new Set();
    const linkedSignalTypes = uniqueSortedStrings(
      (marketContext.linkedSignalIds || [])
        .map((signalId) => signalMap.get(signalId)?.type)
        .filter(Boolean),
    );
    const linkedBuckets = uniqueSortedStrings(marketContext.linkedBucketIds || [])
      .map((bucketId) => bucketMap.get(bucketId))
      .filter(Boolean)
      .sort((left, right) => (
        (right.id === marketContext.topBucketId ? 1 : 0) - (left.id === marketContext.topBucketId ? 1 : 0)
        || (right.pressureScore + right.confidence) - (left.pressureScore + left.confidence)
        || left.label.localeCompare(right.label)
      ));

    for (const domain of ['market', 'supply_chain']) {
      if (existingDomains.has(domain)) continue;
      let best = null;
      for (const bucket of linkedBuckets) {
        if (!getStateDerivedAllowedBuckets(domain).includes(bucket.id)) continue;
        const candidate = computeStateDerivedBucketCandidate(
          domain,
          stateUnit,
          bucket,
          marketContext,
          linkedSignalTypes,
          marketInputCoverage,
        );
        if (!candidate) continue;
        const record = {
          stateUnit,
          bucket,
          marketContext,
          candidate,
          prediction: buildStateDerivedForecast(stateUnit, domain, bucket, candidate, marketContext),
        };
        if (
          !best
          || record.candidate.score > best.candidate.score
          || (record.candidate.score === best.candidate.score && bucket.id === marketContext.topBucketId && best.bucket.id !== marketContext.topBucketId)
        ) {
          best = record;
        }
      }
      if (!best) continue;
      if (best.candidate.score >= best.candidate.minimumScore) {
        derived.push(best.prediction);
        existingDomains.add(domain);
        existingDomainsByState.set(stateUnit.id, existingDomains);
        continue;
      }
      const domainFallback = fallbackByDomain.get(domain);
      if (!domainFallback || best.candidate.score > domainFallback.candidate.score) {
        fallbackByDomain.set(domain, best);
      }
    }
  }

  for (const domain of ['market', 'supply_chain']) {
    const existingCount = existingPredictions.filter((pred) => pred.domain === domain).length;
    const derivedCount = derived.filter((pred) => pred.domain === domain).length;
    if (existingCount + derivedCount > 0) continue;
    const fallback = fallbackByDomain.get(domain);
    if (!fallback || fallback.candidate.score < fallback.candidate.fallbackScore) continue;
    fallback.prediction.stateDerivedBackfill = true;
    derived.push(fallback.prediction);
  }

  return derived
    .sort((a, b) => (Number(a.stateDerivedBackfill) - Number(b.stateDerivedBackfill))
      || (b.probability * b.confidence) - (a.probability * a.confidence)
      || a.title.localeCompare(b.title));
}

function detectPoliticalScenarios(inputs) {
  const predictions = [];
  const scores = extractCiiScores(inputs);
  const anomalies = Array.isArray(inputs.temporalAnomalies) ? inputs.temporalAnomalies : inputs.temporalAnomalies?.anomalies || [];
  const unrestEvents = Array.isArray(inputs.unrestEvents) ? inputs.unrestEvents : inputs.unrestEvents?.events || [];
  const unrestCounts = new Map();

  for (const event of unrestEvents) {
    const country = resolveCountryName(event.country || event.country_name || event.region || event.location || '');
    if (!country) continue;
    unrestCounts.set(country, (unrestCounts.get(country) || 0) + 1);
  }

  for (const c of scores) {
    if (!c.components) continue;
    const unrestComp = c.components.unrest ?? 0;
    const unrestCount = unrestCounts.get(c.name) || 0;
    if (unrestComp <= 50 && unrestCount < 3) continue;
    if (c.score >= 80) continue;

    const countryName = c.name.toLowerCase();
    const signals = [
      { type: 'unrest', value: `${c.name} unrest component: ${Math.max(unrestComp, unrestCount * 10)}`, weight: 0.4 },
    ];
    let sourceCount = 1;

    if (unrestCount > 0) {
      signals.push({ type: 'unrest_events', value: `${unrestCount} unrest events in ${c.name}`, weight: 0.3 });
      sourceCount++;
    }

    const protestAnomalies = anomalies.filter(a =>
      (a.type === 'protest' || a.type === 'unrest') &&
      (a.country || a.region || '').toLowerCase().includes(countryName),
    );
    if (protestAnomalies.length > 0) {
      const maxZ = Math.max(...protestAnomalies.map(a => a.zScore || a.z_score || 0));
      signals.push({ type: 'anomaly', value: `Protest anomaly z-score: ${maxZ.toFixed(1)}`, weight: 0.3 });
      sourceCount++;
    }

    const unrestNorm = normalize(Math.max(unrestComp, unrestCount * 10), 30, 100);
    const anomalyBoost = protestAnomalies.length > 0 ? 0.1 : 0;
    const eventBoost = unrestCount >= 5 ? 0.08 : unrestCount >= 3 ? 0.04 : 0;
    const prob = Math.min(0.8, unrestNorm * 0.6 + anomalyBoost + eventBoost);
    const confidence = Math.max(0.3, normalize(sourceCount, 0, 4));

    predictions.push(makePrediction(
      'political', c.name,
      `Political instability: ${c.name}`,
      prob, confidence, '30d', signals,
    ));
  }

  return predictions;
}

function detectMilitaryScenarios(inputs) {
  const predictions = [];
  const militaryInputs = getFreshMilitaryForecastInputs(inputs);
  const theaters = militaryInputs?.theaters || [];
  const anomalies = Array.isArray(inputs.temporalAnomalies) ? inputs.temporalAnomalies : inputs.temporalAnomalies?.anomalies || [];
  const surgeItems = Array.isArray(militaryInputs) ? militaryInputs : militaryInputs?.surges || [];
  const theatersById = new Map(theaters.map((theater) => [(theater?.id || theater?.theater), theater]).filter(([theaterId]) => !!theaterId));
  const surgesByTheater = new Map();

  for (const surge of surgeItems) {
    if (!surge?.theaterId) continue;
    const list = surgesByTheater.get(surge.theaterId) || [];
    list.push(surge);
    surgesByTheater.set(surge.theaterId, list);
  }

  const theaterIds = new Set([
    ...Array.from(theatersById.keys()),
    ...Array.from(surgesByTheater.keys()),
  ]);

  for (const theaterId of theaterIds) {
    const t = theatersById.get(theaterId);
    const theaterSurges = surgesByTheater.get(theaterId) || [];
    if (!theaterId) continue;
    const posture = t?.postureLevel || t?.posture || '';
    const highestSurge = selectPrimaryMilitarySurge(theaterId, theaterSurges);
    const surgeIsUsable = canPromoteMilitarySurge(posture, highestSurge);
    if (posture !== 'elevated' && posture !== 'critical' && !surgeIsUsable) continue;

    const region = THEATER_REGIONS[theaterId] || t?.name || theaterId;
    const theaterLabel = THEATER_LABELS[theaterId] || t?.name || theaterId;
    const signals = [];
    let sourceCount = 0;
    const actorScore = computeTheaterActorScore(theaterId, highestSurge);
    const persistent = !!highestSurge?.persistent || (highestSurge?.surgeMultiple || 0) >= 3.5;

    if (posture === 'elevated' || posture === 'critical') {
      signals.push({ type: 'theater', value: `${theaterLabel} posture: ${posture}`, weight: 0.45 });
      sourceCount++;
    }

    const milFlights = anomalies.filter(a =>
      (a.type === 'military_flights' || a.type === 'military') &&
      [region, theaterLabel, theaterId].some((part) => part && (a.region || a.theater || '').toLowerCase().includes(part.toLowerCase())),
    );
    if (milFlights.length > 0) {
      const maxZ = Math.max(...milFlights.map(a => a.zScore || a.z_score || 0));
      signals.push({ type: 'mil_flights', value: `Military flight anomaly z-score: ${maxZ.toFixed(1)}`, weight: 0.3 });
      sourceCount++;
    }

    if (highestSurge) {
      signals.push({
        type: 'mil_surge',
        value: `${highestSurge.surgeType} surge in ${theaterLabel}: ${highestSurge.currentCount} vs ${highestSurge.baselineCount} baseline (${highestSurge.surgeMultiple}x)`,
        weight: 0.4,
      });
      sourceCount++;
      if (highestSurge.dominantCountry) {
        signals.push({
          type: 'operator',
          value: `${highestSurge.dominantCountry} accounts for ${highestSurge.dominantCountryCount} flights in ${theaterLabel}`,
          weight: 0.2,
        });
        sourceCount++;
      }
      if (highestSurge.awacs > 0 || highestSurge.tankers > 0) {
        signals.push({
          type: 'support_aircraft',
          value: `${highestSurge.tankers} tankers and ${highestSurge.awacs} AWACS active in ${theaterLabel}`,
          weight: 0.15,
        });
        sourceCount++;
      }
      if (highestSurge.persistenceCount > 0) {
        signals.push({
          type: 'persistence',
          value: `${highestSurge.persistenceCount} prior run(s) in ${theaterLabel} were already above baseline`,
          weight: 0.18,
        });
        sourceCount++;
      }
      if (actorScore > 0) {
        signals.push({
          type: 'theater_actor_fit',
          value: `${highestSurge.dominantCountry || highestSurge.dominantOperator} aligns with expected actors in ${theaterLabel}`,
          weight: 0.16,
        });
        sourceCount++;
      }
    }

    if (t?.indicators && Array.isArray(t.indicators)) {
      const activeIndicators = t.indicators.filter(i => i.active || i.triggered);
      if (activeIndicators.length > 0) {
        signals.push({ type: 'indicators', value: `${activeIndicators.length} active posture indicators`, weight: 0.2 });
        sourceCount++;
      }
    }

    const baseLine = highestSurge
      ? highestSurge.surgeType === 'fighter'
        ? Math.min(0.72, 0.42 + Math.max(0, ((highestSurge.surgeMultiple || 1) - 1) * 0.1))
        : highestSurge.surgeType === 'airlift'
          ? Math.min(0.58, 0.32 + Math.max(0, ((highestSurge.surgeMultiple || 1) - 1) * 0.08))
          : Math.min(0.42, 0.2 + Math.max(0, ((highestSurge.surgeMultiple || 1) - 1) * 0.05))
      : posture === 'critical' ? 0.6 : 0.35;
    const flightBoost = milFlights.length > 0 ? 0.1 : 0;
    const postureBoost = posture === 'critical' ? 0.12 : posture === 'elevated' ? 0.06 : 0;
    const supportBoost = highestSurge && (highestSurge.awacs > 0 || highestSurge.tankers > 0) ? 0.05 : 0;
    const strikeBoost = (t?.activeOperations?.includes?.('strike_capable') || highestSurge?.strikeCapable) ? 0.06 : 0;
    const persistenceBoost = persistent ? 0.08 : 0;
    const genericPenalty = highestSurge?.surgeType === 'air_activity' && !persistent ? 0.12 : 0;
    const prob = Math.min(0.9, Math.max(0.05, baseLine + flightBoost + postureBoost + supportBoost + strikeBoost + persistenceBoost + actorScore - genericPenalty));
    const confidence = Math.max(0.3, normalize(sourceCount, 0, 4));
    const title = highestSurge
      ? buildMilitaryForecastTitle(theaterId, theaterLabel, highestSurge)
      : `Military posture escalation: ${region}`;

    predictions.push(makePrediction(
      'military', region,
      title,
      prob, confidence, '7d', signals,
    ));
  }

  return predictions;
}

function detectInfraScenarios(inputs) {
  const predictions = [];
  const outages = Array.isArray(inputs.outages) ? inputs.outages : inputs.outages?.outages || [];
  const cyber = Array.isArray(inputs.cyberThreats) ? inputs.cyberThreats : inputs.cyberThreats?.threats || [];
  const jamming = Array.isArray(inputs.gpsJamming) ? inputs.gpsJamming : inputs.gpsJamming?.zones || [];

  for (const o of outages) {
    const rawSev = (o.severity || o.type || '').toLowerCase();
    // Handle both plain strings and proto enums (SEVERITY_LEVEL_HIGH, SEVERITY_LEVEL_CRITICAL)
    const severity = rawSev.includes('critical') ? 'critical'
      : rawSev.includes('high') ? 'major'
      : rawSev.includes('total') ? 'total'
      : rawSev.includes('major') ? 'major'
      : rawSev;
    if (severity !== 'major' && severity !== 'total' && severity !== 'critical') continue;

    const country = resolveCountryName(o.country || o.region || o.name || '');
    if (!country) continue;

    const countryLower = country.toLowerCase();
    const signals = [
      { type: 'outage', value: `${country} ${severity} outage`, weight: 0.4 },
    ];
    let sourceCount = 1;

    const relatedCyber = cyber.filter(t =>
      (t.country || t.target || t.region || '').toLowerCase().includes(countryLower),
    );
    if (relatedCyber.length > 0) {
      signals.push({ type: 'cyber', value: `${relatedCyber.length} cyber threats targeting ${country}`, weight: 0.3 });
      sourceCount++;
    }

    const nearbyJam = jamming.filter(j =>
      (j.country || j.region || j.name || '').toLowerCase().includes(countryLower),
    );
    if (nearbyJam.length > 0) {
      signals.push({ type: 'gps_jamming', value: `GPS interference in ${country}`, weight: 0.2 });
      sourceCount++;
    }

    const cyberBoost = relatedCyber.length > 0 ? 0.15 : 0;
    const jamBoost = nearbyJam.length > 0 ? 0.05 : 0;
    const baseLine = severity === 'total' ? 0.55 : 0.4;
    const prob = Math.min(0.85, baseLine + cyberBoost + jamBoost);
    const confidence = Math.max(0.3, normalize(sourceCount, 0, 4));

    predictions.push(makePrediction(
      'infrastructure', country,
      `Infrastructure cascade risk: ${country}`,
      prob, confidence, '24h', signals,
    ));
  }

  return predictions;
}

// ── Phase 4: Standalone detectors ───────────────────────────
function detectUcdpConflictZones(inputs) {
  const predictions = [];
  const ucdp = Array.isArray(inputs.ucdpEvents) ? inputs.ucdpEvents : inputs.ucdpEvents?.events || [];
  if (ucdp.length === 0) return predictions;

  const byCountry = {};
  for (const e of ucdp) {
    const country = e.country || e.country_name || '';
    if (!country) continue;
    byCountry[country] = (byCountry[country] || 0) + 1;
  }

  for (const [country, count] of Object.entries(byCountry)) {
    if (count < 10) continue;
    predictions.push(makePrediction(
      'conflict', country,
      `Active armed conflict: ${country}`,
      Math.min(0.85, normalize(count, 5, 100) * 0.7),
      0.3, '30d',
      [{ type: 'ucdp', value: `${count} UCDP conflict events`, weight: 0.5 }],
    ));
  }
  return predictions;
}

function detectCyberScenarios(inputs) {
  const predictions = [];
  const threats = Array.isArray(inputs.cyberThreats) ? inputs.cyberThreats : inputs.cyberThreats?.threats || [];
  if (threats.length < CYBER_MIN_THREATS_PER_COUNTRY) return predictions;

  const byCountry = {};
  for (const t of threats) {
    const country = resolveCountryName(t.country || t.target || t.region || '');
    if (!country) continue;
    if (!byCountry[country]) byCountry[country] = [];
    byCountry[country].push(t);
  }

  const candidates = [];
  for (const [country, items] of Object.entries(byCountry)) {
    if (items.length < CYBER_MIN_THREATS_PER_COUNTRY) continue;
    const types = new Set(items.map(t => t.type || t.category || 'unknown'));
    const criticalCount = items.filter((t) => /ransomware|wiper|ddos|intrusion|exploit|botnet|malware/i.test(`${t.type || ''} ${t.category || ''}`)).length;
    const score = items.length + (types.size * CYBER_SCORE_TYPE_MULTIPLIER) + (criticalCount * CYBER_SCORE_CRITICAL_MULTIPLIER);
    const probability = Math.min(CYBER_PROB_MAX, (normalize(items.length, 4, 50) * CYBER_PROB_VOLUME_WEIGHT) + (normalize(types.size, 1, 6) * CYBER_PROB_TYPE_WEIGHT));
    candidates.push({
      country,
      items,
      types,
      score,
      probability,
      confidence: Math.max(0.32, normalize(items.length + criticalCount, 4, 25) * 0.55),
    });
  }
  candidates
    .sort((a, b) => b.score - a.score || b.probability - a.probability || a.country.localeCompare(b.country))
    .slice(0, CYBER_MAX_FORECASTS)
    .forEach((candidate) => {
      predictions.push(makePrediction(
        'cyber', candidate.country,
        `Cyber threat concentration: ${candidate.country}`,
        candidate.probability,
        candidate.confidence,
        '7d',
        [{ type: 'cyber', value: `${candidate.items.length} threats (${[...candidate.types].join(', ')})`, weight: 0.5 }],
      ));
    });

  return predictions;
}

const MARITIME_REGIONS = {
  'Eastern Mediterranean': { latRange: [33, 37], lonRange: [25, 37] },
  'Red Sea': { latRange: [11, 22], lonRange: [32, 54] },
  'Persian Gulf': { latRange: [20, 32], lonRange: [45, 60] },
  'Black Sea': { latRange: [40, 48], lonRange: [26, 42] },
  'Baltic Sea': { latRange: [52, 65], lonRange: [10, 32] },
};

function detectGpsJammingScenarios(inputs) {
  const predictions = [];
  const zones = Array.isArray(inputs.gpsJamming) ? inputs.gpsJamming
    : inputs.gpsJamming?.zones || inputs.gpsJamming?.hexes || [];
  if (zones.length === 0) return predictions;

  for (const [region, bounds] of Object.entries(MARITIME_REGIONS)) {
    const inRegion = zones.filter(h => {
      const lat = h.lat || h.latitude || 0;
      const lon = h.lon || h.longitude || 0;
      return lat >= bounds.latRange[0] && lat <= bounds.latRange[1]
          && lon >= bounds.lonRange[0] && lon <= bounds.lonRange[1];
    });
    if (inRegion.length < 3) continue;
    predictions.push(makePrediction(
      'supply_chain', region,
      `GPS interference in ${region} shipping zone`,
      Math.min(0.6, normalize(inRegion.length, 2, 30) * 0.5),
      0.3, '7d',
      [{ type: 'gps_jamming', value: `${inRegion.length} jamming hexes in ${region}`, weight: 0.5 }],
    ));
  }
  return predictions;
}

const MARKET_TAG_TO_REGION = {
  mena: 'Middle East', eu: 'Europe', asia: 'Asia-Pacific',
  america: 'Americas', latam: 'Latin America', africa: 'Africa', oceania: 'Oceania',
};

const DOMAIN_HINTS = {
  conflict: ['conflict', 'war', 'strike', 'attack', 'ceasefire', 'offensive', 'military'],
  market: ['market', 'oil', 'gas', 'trade', 'tariff', 'inflation', 'recession', 'price', 'shipping', 'semiconductor'],
  supply_chain: ['shipping', 'supply', 'chokepoint', 'port', 'transit', 'freight', 'logistics', 'gps'],
  political: ['election', 'government', 'parliament', 'protest', 'unrest', 'leadership', 'coalition'],
  military: ['military', 'force', 'deployment', 'exercise', 'missile', 'carrier', 'bomber', 'air defense'],
  cyber: ['cyber', 'malware', 'ransomware', 'intrusion', 'ddos', 'phishing', 'exploit', 'botnet'],
  infrastructure: ['outage', 'blackout', 'power', 'grid', 'pipeline', 'cyber', 'telecom', 'internet'],
};

const DOMAIN_ACTOR_BLUEPRINTS = {
  conflict: [
    { key: 'state_command', name: 'Regional command authority', category: 'state', influenceScore: 0.88 },
    { key: 'security_forces', name: 'Security forces', category: 'security', influenceScore: 0.82 },
    { key: 'external_power', name: 'External power broker', category: 'external', influenceScore: 0.74 },
    { key: 'energy_market', name: 'Energy market participants', category: 'market', influenceScore: 0.58 },
  ],
  market: [
    { key: 'commodity_traders', name: 'Commodity traders', category: 'market', influenceScore: 0.84 },
    { key: 'policy_officials', name: 'Policy officials', category: 'state', influenceScore: 0.72 },
    { key: 'large_importers', name: 'Large importers', category: 'commercial', influenceScore: 0.68 },
    { key: 'regional_producers', name: 'Regional producers', category: 'commercial', influenceScore: 0.62 },
  ],
  supply_chain: [
    { key: 'shipping_operators', name: 'Shipping operators', category: 'commercial', influenceScore: 0.84 },
    { key: 'port_authorities', name: 'Port authorities', category: 'infrastructure', influenceScore: 0.71 },
    { key: 'cargo_owners', name: 'Major cargo owners', category: 'commercial', influenceScore: 0.67 },
    { key: 'marine_insurers', name: 'Marine insurers', category: 'market', influenceScore: 0.54 },
  ],
  political: [
    { key: 'incumbent_leadership', name: 'Incumbent leadership', category: 'state', influenceScore: 0.86 },
    { key: 'opposition_networks', name: 'Opposition networks', category: 'political', influenceScore: 0.69 },
    { key: 'regional_diplomats', name: 'Regional diplomats', category: 'external', influenceScore: 0.57 },
    { key: 'civil_society', name: 'Civil society blocs', category: 'civic', influenceScore: 0.49 },
  ],
  military: [
    { key: 'defense_planners', name: 'Defense planners', category: 'security', influenceScore: 0.86 },
    { key: 'allied_observers', name: 'Allied observers', category: 'external', influenceScore: 0.68 },
    { key: 'commercial_carriers', name: 'Commercial carriers', category: 'commercial', influenceScore: 0.51 },
    { key: 'regional_command', name: 'Regional command posts', category: 'security', influenceScore: 0.74 },
  ],
  cyber: [
    { key: 'cert_teams', name: 'National CERT teams', category: 'security', influenceScore: 0.83 },
    { key: 'critical_it', name: 'Critical IT operators', category: 'infrastructure', influenceScore: 0.74 },
    { key: 'threat_actors', name: 'Threat actors', category: 'adversarial', influenceScore: 0.69 },
    { key: 'platform_defenders', name: 'Platform defenders', category: 'commercial', influenceScore: 0.58 },
  ],
  infrastructure: [
    { key: 'grid_operators', name: 'Grid operators', category: 'infrastructure', influenceScore: 0.83 },
    { key: 'civil_protection', name: 'Civil protection authorities', category: 'state', influenceScore: 0.72 },
    { key: 'critical_providers', name: 'Critical service providers', category: 'commercial', influenceScore: 0.64 },
    { key: 'cyber_responders', name: 'Incident response teams', category: 'security', influenceScore: 0.59 },
  ],
};

const SIGNAL_TRIGGER_TEMPLATES = {
  cii: (pred, signal) => `Watch for another deterioration in ${pred.region} risk indicators beyond ${signal.value}.`,
  cii_delta: (pred) => `A further sharp 24h deterioration in ${pred.region} risk metrics would strengthen the base case.`,
  conflict_events: (pred) => `A fresh cluster of reported conflict events in ${pred.region} would raise escalation pressure quickly.`,
  ucdp: (pred) => `A sustained increase in verified conflict-event counts would confirm the escalation path in ${pred.region}.`,
  theater: (pred) => `Any shift from elevated to critical theater posture in ${pred.region} would move this forecast higher.`,
  indicators: (pred) => `More active posture indicators in ${pred.region} would support an escalatory revision.`,
  mil_flights: () => 'Another spike in military flight anomalies would strengthen the near-term risk path.',
  chokepoint: (_pred, signal) => `${signal.value} persisting for another cycle would deepen downstream disruption risk.`,
  ais_gap: () => 'Further AIS gaps around the affected route would confirm operational disruption rather than noise.',
  gps_jamming: () => 'Wider GPS interference across adjacent zones would increase the chance of spillover effects.',
  unrest: (pred) => `A higher unrest signal in ${pred.region} would raise the probability of instability broadening.`,
  anomaly: () => 'A new anomaly spike above the current protest baseline would strengthen the forecast.',
  outage: (pred) => `A second major outage in ${pred.region} would turn a contained event into a cascade risk.`,
  cyber: (pred) => `Additional cyber incidents tied to ${pred.region} infrastructure would materially worsen the case.`,
  prediction_market: () => 'A market repricing of 8-10 points would be a meaningful confirmation or rejection signal.',
  news_corroboration: (pred) => `More directly matched reporting on ${pred.region} would improve confidence in the current path.`,
};

function tokenizeText(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(token => token.length >= 3);
}

function uniqueLowerTerms(terms) {
  return [...new Set((terms || [])
    .map(term => (term || '').toLowerCase().trim())
    .filter(Boolean))];
}

function countTermMatches(text, terms) {
  const lower = (text || '').toLowerCase();
  let hits = 0;
  let score = 0;
  for (const term of uniqueLowerTerms(terms)) {
    if (term.length < 3) continue;
    if (!lower.includes(term)) continue;
    hits += 1;
    score += term.length > 8 ? 4 : term.length > 5 ? 3 : 2;
  }
  return { hits, score };
}

function extractMeaningfulTokens(text, exclude = []) {
  const excluded = new Set(uniqueLowerTerms(exclude)
    .flatMap(term => term.split(/[^a-z0-9]+/g))
    .filter(Boolean));
  return [...new Set(tokenizeText(text).filter(token =>
    token.length >= 4
    && !TEXT_STOPWORDS.has(token)
    && !excluded.has(token)
  ))];
}

function buildExpectedRegionTags(regionTerms, region) {
  return new Set([
    ...uniqueLowerTerms(regionTerms).flatMap(term => tagRegions(term)),
    ...(REGION_KEYWORDS[region] || []),
  ]);
}

function getDomainTerms(domain) {
  return DOMAIN_HINTS[domain] || [];
}

function computeHeadlineRelevance(headline, terms, domain, options = {}) {
  const lower = headline.toLowerCase();
  const regionTerms = uniqueLowerTerms(terms);
  const { hits: regionHits, score: regionScore } = countTermMatches(lower, regionTerms);
  const expectedTags = options.expectedTags instanceof Set
    ? options.expectedTags
    : buildExpectedRegionTags(regionTerms, options.region);
  const headlineTags = tagRegions(headline);
  const tagOverlap = headlineTags.some(tag => expectedTags.has(tag));
  const tagMismatch = headlineTags.length > 0 && expectedTags.size > 0 && !tagOverlap;
  let score = regionScore + (tagOverlap ? 3 : 0) - (tagMismatch ? 4 : 0);
  for (const hint of getDomainTerms(domain)) {
    if (lower.includes(hint)) score += 1;
  }
  const titleTokens = options.titleTokens || [];
  for (const token of titleTokens) {
    if (lower.includes(token)) score += 2;
  }
  if (options.requireRegion && regionHits === 0 && !tagOverlap) return 0;
  if (options.requireSemantic) {
    const domainHits = getDomainTerms(domain).filter(hint => lower.includes(hint)).length;
    const titleHits = titleTokens.filter(token => lower.includes(token)).length;
    if (domainHits === 0 && titleHits === 0) return 0;
  }
  return Math.max(0, score);
}

function computeMarketMatchScore(pred, marketTitle, regionTerms, options = {}) {
  const lower = marketTitle.toLowerCase();
  const { hits: regionHits, score: regionScore } = countTermMatches(lower, regionTerms);
  const expectedTags = options.expectedTags instanceof Set
    ? options.expectedTags
    : buildExpectedRegionTags(regionTerms, pred.region);
  const marketTags = tagRegions(marketTitle);
  const tagOverlap = marketTags.some(tag => expectedTags.has(tag));
  const tagMismatch = marketTags.length > 0 && expectedTags.size > 0 && !tagOverlap;
  let score = regionScore + (tagOverlap ? 2 : 0) - (tagMismatch ? 5 : 0);
  let domainHits = 0;
  for (const hint of getDomainTerms(pred.domain)) {
    if (lower.includes(hint)) {
      domainHits += 1;
      score += 1;
    }
  }
  let titleHits = 0;
  const titleTokens = options.titleTokens || extractMeaningfulTokens(pred.title, regionTerms);
  for (const token of titleTokens) {
    if (lower.includes(token)) {
      titleHits += 1;
      score += 2;
    }
  }
  return {
    score: Math.max(0, score),
    regionHits,
    domainHits,
    titleHits,
    tagOverlap,
    tagMismatch,
  };
}

function detectFromPredictionMarkets(inputs) {
  const predictions = [];
  const markets = inputs.predictionMarkets?.geopolitical || [];

  for (const m of markets) {
    const yesPrice = (m.yesPrice || 50) / 100;
    if (yesPrice < 0.6 || yesPrice > 0.9) continue;
    const tags = tagRegions(m.title);
    if (tags.length === 0) continue;
    const region = MARKET_TAG_TO_REGION[tags[0]] || tags[0];

    const titleLower = m.title.toLowerCase();
    const domain = titleLower.match(/war|strike|military|attack/) ? 'conflict'
      : titleLower.match(/tariff|recession|economy|gdp/) ? 'market'
      : 'political';

    predictions.push(makePrediction(
      domain, region,
      m.title.slice(0, 100),
      yesPrice, 0.7, '30d',
      [{ type: 'prediction_market', value: `${m.source || 'Polymarket'}: ${Math.round(yesPrice * 100)}%`, weight: 0.8 }],
    ));
  }
  return predictions.slice(0, 5);
}

// ── Phase 4: Entity graph ───────────────────────────────────
let _entityGraph = null;
function loadEntityGraph() {
  if (_entityGraph) return _entityGraph;
  try {
    const graphPath = new URL('./data/entity-graph.json', import.meta.url);
    _entityGraph = JSON.parse(readFileSync(graphPath, 'utf8'));
    console.log(`  [Graph] Loaded ${Object.keys(_entityGraph.nodes).length} nodes`);
    return _entityGraph;
  } catch (err) {
    console.warn(`  [Graph] Failed: ${err.message}`);
    return { nodes: {}, edges: [], aliases: {} };
  }
}

function discoverGraphCascades(predictions, graph) {
  if (!graph?.nodes || !graph?.aliases) return;
  for (const pred of predictions) {
    const nodeId = graph.aliases[pred.region];
    if (!nodeId) continue;
    const node = graph.nodes[nodeId];
    if (!node?.links) continue;

    for (const linkedId of node.links) {
      const linked = graph.nodes[linkedId];
      if (!linked) continue;
      const linkedPred = predictions.find(p =>
        p !== pred && p.domain !== pred.domain && graph.aliases[p.region] === linkedId
      );
      if (!linkedPred) continue;

      const edge = graph.edges.find(e =>
        (e.from === nodeId && e.to === linkedId) || (e.from === linkedId && e.to === nodeId)
      );
      const coupling = (edge?.weight || 0.3) * 0.5;
      pred.cascades.push({
        domain: linkedPred.domain,
        effect: `graph: ${edge?.relation || 'linked'} via ${linked.name}`,
        probability: Math.round(Math.min(0.6, pred.probability * coupling) * 1000) / 1000,
      });
    }
  }
}

// ── Phase 3: Data-driven cascade rules ─────────────────────
const DEFAULT_CASCADE_RULES = [
  { from: 'conflict', to: 'supply_chain', coupling: 0.6, mechanism: 'chokepoint disruption', requiresChokepoint: true },
  { from: 'conflict', to: 'market', coupling: 0.5, mechanism: 'commodity price shock', requiresChokepoint: true },
  { from: 'political', to: 'conflict', coupling: 0.4, mechanism: 'instability escalation', minProbability: 0.6 },
  { from: 'military', to: 'conflict', coupling: 0.5, mechanism: 'force deployment', requiresCriticalPosture: true },
  { from: 'supply_chain', to: 'market', coupling: 0.4, mechanism: 'supply shortage pricing' },
];

const PREDICATE_EVALUATORS = {
  requiresChokepoint: (pred) => !!CHOKEPOINT_COMMODITIES[pred.region],
  requiresCriticalPosture: (pred) => pred.signals.some(s => s.type === 'theater' && s.value.includes('critical')),
  minProbability: (pred, val) => pred.probability >= val,
  requiresSeverity: (pred, val) => pred.signals.some(s => s.type === 'outage' && s.value.toLowerCase().includes(val)),
};

function evaluateRuleConditions(rule, pred) {
  for (const [key, val] of Object.entries(rule)) {
    if (['from', 'to', 'coupling', 'mechanism'].includes(key)) continue;
    const evaluator = PREDICATE_EVALUATORS[key];
    if (!evaluator) continue;
    if (!evaluator(pred, val)) return false;
  }
  return true;
}

function loadCascadeRules() {
  try {
    const rulesPath = new URL('./data/cascade-rules.json', import.meta.url);
    const raw = JSON.parse(readFileSync(rulesPath, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('cascade rules must be array');
    const KNOWN_FIELDS = new Set(['from', 'to', 'coupling', 'mechanism', ...Object.keys(PREDICATE_EVALUATORS)]);
    for (const r of raw) {
      if (!r.from || !r.to || typeof r.coupling !== 'number' || !r.mechanism) {
        throw new Error(`invalid rule: ${JSON.stringify(r)}`);
      }
      for (const key of Object.keys(r)) {
        if (!KNOWN_FIELDS.has(key)) throw new Error(`unknown predicate '${key}' in rule: ${r.mechanism}`);
      }
    }
    console.log(`  [Cascade] Loaded ${raw.length} rules from JSON`);
    return raw;
  } catch (err) {
    console.warn(`  [Cascade] Failed to load rules: ${err.message}, using defaults`);
    return DEFAULT_CASCADE_RULES;
  }
}

function resolveCascades(predictions, rules) {
  const seen = new Set();
  for (const rule of rules) {
    const sources = predictions.filter(p => p.domain === rule.from);
    for (const src of sources) {
      if (!evaluateRuleConditions(rule, src)) continue;
      const cascadeProb = Math.min(0.8, src.probability * rule.coupling);
      const key = `${src.id}:${rule.to}:${rule.mechanism}`;
      if (seen.has(key)) continue;
      seen.add(key);
      src.cascades.push({ domain: rule.to, effect: rule.mechanism, probability: +cascadeProb.toFixed(3) });
    }
  }
}

// ── Phase 3: Probability projections ───────────────────────
const PROJECTION_CURVES = {
  conflict:       { h24: 0.91, d7: 1.0, d30: 0.78 },
  market:         { h24: 1.0, d7: 0.58, d30: 0.42 },
  supply_chain:   { h24: 0.91, d7: 1.0, d30: 0.64 },
  political:      { h24: 0.83, d7: 0.87, d30: 1.0 },
  military:       { h24: 1.0, d7: 0.91, d30: 0.65 },
  cyber:          { h24: 1.0, d7: 0.78, d30: 0.4 },
  infrastructure: { h24: 1.0, d7: 0.5, d30: 0.25 },
};

function computeProjections(predictions) {
  for (const pred of predictions) {
    const curve = PROJECTION_CURVES[pred.domain] || { h24: 1, d7: 1, d30: 1 };
    const anchor = pred.timeHorizon === '24h' ? 'h24' : pred.timeHorizon === '30d' ? 'd30' : 'd7';
    const anchorMult = curve[anchor] || 1;
    const base = anchorMult > 0 ? pred.probability / anchorMult : pred.probability;
    pred.projections = {
      h24: Math.round(Math.min(0.95, Math.max(0.01, base * curve.h24)) * 1000) / 1000,
      d7:  Math.round(Math.min(0.95, Math.max(0.01, base * curve.d7)) * 1000) / 1000,
      d30: Math.round(Math.min(0.95, Math.max(0.01, base * curve.d30)) * 1000) / 1000,
    };
  }
}

function calibrateWithMarkets(predictions, markets) {
  if (!markets?.geopolitical) return;
  for (const pred of predictions) {
    const keywords = REGION_KEYWORDS[pred.region] || [];
    const regionTerms = [...new Set([...getSearchTermsForRegion(pred.region), pred.region])];
    const expectedTags = buildExpectedRegionTags(regionTerms, pred.region);
    const titleTokens = extractMeaningfulTokens(pred.title, regionTerms);
    if (keywords.length === 0 && regionTerms.length === 0) continue;
    const candidates = markets.geopolitical
      .map(m => {
        const mRegions = tagRegions(m.title);
        const sameMacroRegion = keywords.length > 0 && mRegions.some(r => keywords.includes(r));
        const match = computeMarketMatchScore(pred, m.title, regionTerms, { expectedTags, titleTokens });
        return { market: m, sameMacroRegion, ...match };
      })
      .filter(item => {
        if (item.tagMismatch && item.regionHits === 0) return false;
        const hasSpecificRegionSignal = item.regionHits > 0 || item.tagOverlap;
        const hasSemanticOverlap = item.titleHits > 0 || item.domainHits > 0;
        if (pred.domain === 'market') {
          return hasSpecificRegionSignal && item.titleHits > 0 && (item.domainHits > 0 || item.score >= 7);
        }
        return hasSpecificRegionSignal && (hasSemanticOverlap || item.score >= 6);
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.market.volume || 0) - (a.market.volume || 0);
      });
    const best = candidates[0];
    const match = best?.market || null;
    if (match) {
      const marketProb = (match.yesPrice || 50) / 100;
      pred.calibration = {
        marketTitle: match.title,
        marketPrice: +marketProb.toFixed(3),
        drift: +(pred.probability - marketProb).toFixed(3),
        source: match.source || 'polymarket',
      };
      pred.probability = +(0.4 * marketProb + 0.6 * pred.probability).toFixed(3);
    }
  }
}

async function readPriorPredictions() {
  try {
    const { url, token } = getRedisCredentials();
    return await redisGet(url, token, PRIOR_KEY);
  } catch { return null; }
}

function computeTrends(predictions, prior) {
  if (!prior?.predictions) {
    for (const p of predictions) { p.trend = 'stable'; p.priorProbability = p.probability; }
    return;
  }
  const priorMap = new Map(prior.predictions.map(p => [p.id, p]));
  for (const p of predictions) {
    const prev = priorMap.get(p.id);
    if (!prev) { p.trend = 'stable'; p.priorProbability = p.probability; continue; }
    p.priorProbability = prev.probability;
    const delta = p.probability - prev.probability;
    p.trend = delta > 0.05 ? 'rising' : delta < -0.05 ? 'falling' : 'stable';
  }
}

// ── Phase 2: News Context + Entity Matching ────────────────
let _countryCodes = null;
function loadCountryCodes() {
  if (_countryCodes) return _countryCodes;
  try {
    const codePath = new URL('./data/country-codes.json', import.meta.url);
    _countryCodes = JSON.parse(readFileSync(codePath, 'utf8'));
    return _countryCodes;
  } catch { return {}; }
}

const NEWS_MATCHABLE_TYPES = new Set(['country', 'theater']);

function getSearchTermsForRegion(region) {
  const terms = [region];
  const codes = loadCountryCodes();
  const graph = loadEntityGraph();

  // 1. Country codes JSON: resolve ISO codes to names + keywords
  const countryEntry = codes[region];
  if (countryEntry) {
    terms.push(countryEntry.name);
    terms.push(...countryEntry.keywords);
  }

  // 2. Reverse lookup: if region is a full name (or has parenthetical suffix like "Myanmar (Burma)")
  if (!countryEntry) {
    const regionLower = region.toLowerCase();
    const regionBase = region.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase(); // strip "(Zaire)", "(Burma)", etc.
    for (const [, entry] of Object.entries(codes)) {
      const nameLower = entry.name.toLowerCase();
      if (nameLower === regionLower || nameLower === regionBase || regionLower.includes(nameLower)) {
        terms.push(entry.name);
        terms.push(...entry.keywords);
        break;
      }
    }
  }

  // 3. Entity graph: add linked country/theater names (not commodities)
  const nodeId = graph.aliases?.[region];
  const node = nodeId ? graph.nodes?.[nodeId] : null;
  if (node) {
    if (node.name !== region) terms.push(node.name);
    for (const linkId of node.links || []) {
      const linked = graph.nodes?.[linkId];
      if (linked && NEWS_MATCHABLE_TYPES.has(linked.type) && linked.name.length > 2) {
        terms.push(linked.name);
      }
    }
  }

  // Dedupe and filter short terms
  return [...new Set(terms)].filter(t => t && t.length > 2);
}

function extractAllHeadlines(newsInsights, newsDigest) {
  const headlines = [];
  const seen = new Set();
  // 1. Digest has 300+ headlines across 16 categories
  if (newsDigest?.categories) {
    for (const bucket of Object.values(newsDigest.categories)) {
      for (const item of bucket?.items || []) {
        if (item?.title && !seen.has(item.title)) { seen.add(item.title); headlines.push(item.title); }
      }
    }
  }
  // 2. Fallback to topStories if digest is empty
  if (headlines.length === 0 && newsInsights?.topStories) {
    for (const s of newsInsights.topStories) {
      if (s?.primaryTitle && !seen.has(s.primaryTitle)) { seen.add(s.primaryTitle); headlines.push(s.primaryTitle); }
    }
  }
  return headlines;
}

const CRITICAL_NEWS_ROUTE_RE = /\b(hormuz|strait of hormuz|bab el[- ]mandeb|suez|red sea|black sea|baltic sea|kerch|shipping lane|shipping route|trade corridor|canal|port|terminal)\b/i;
const CRITICAL_NEWS_BLOCKAGE_RE = /\b(block(?:ade|ed|ing|s)?|clos(?:e|ed|ure|ing)|shut(?:ting)?|halt(?:ed|ing)?|suspend(?:ed|ing)?|interrupt(?:ed|ion)?|rerout(?:e|ed|ing)?|seiz(?:e|ed|ure)|interdict(?:ed|ion)?|mine(?:d|s)?)\b/i;
const CRITICAL_NEWS_ATTACK_RE = /\b(attack(?:ed|s)?|air ?strike(?:s)?|strike(?:s)?|struck|drone|missile|rocket|blast|explosion|fire|burn(?:ing)?|hit|damage(?:d)?|sabotage)\b/i;
const CRITICAL_NEWS_ENERGY_RE = /\b(oil|crude|gas|lng|liquefied natural gas|refiner(?:y|ies)|pipeline|terminal|export terminal|petrochemical|storage tank|tank farm|fuel depot|processing plant|tanker)\b/i;
const CRITICAL_NEWS_LNG_RE = /\b(lng|liquefied natural gas|ras laffan|north field|south pars|gas field|gas export|gas terminal)\b/i;
const CRITICAL_NEWS_REFINERY_RE = /\b(refiner(?:y|ies)|petrochemical|fuel depot|oil terminal|storage tank|tank farm|processing plant)\b/i;
const CRITICAL_NEWS_SANCTIONS_RE = /\b(sanction(?:s|ing|ed)?|embargo|export control|blacklist|freeze(?:d)? assets|price cap|trade ban|shipping ban)\b/i;
const CRITICAL_NEWS_ULTIMATUM_RE = /\b(ultimatum|deadline|final warning|48-hour|72-hour|must reopen|must withdraw|or face)\b/i;
const CRITICAL_NEWS_POWER_RE = /\b(power station|power plant|grid|substation|electricity|blackout)\b/i;
const CRITICAL_NEWS_SOURCE_TYPES = new Set(['critical_news', 'critical_news_llm', 'iran_events', 'sanctions_pressure', 'thermal_escalation']);
const CRITICAL_SIGNAL_LLM_MAX_ITEMS = 8;
const CRITICAL_SIGNAL_CACHE_TTL_SECONDS = 20 * 60;
const CRITICAL_SIGNAL_PRIMARY_KINDS = new Set([
  'route_blockage',
  'facility_attack',
  'export_disruption',
  'sanctions_escalation',
  'ultimatum_escalation',
  'power_disruption',
  'policy_intervention',
  'other',
]);
const CRITICAL_SIGNAL_IMPACT_HINTS = new Set([
  'shipping',
  'energy',
  'gas_lng',
  'refined_products',
  'sovereign',
  'infrastructure',
  'rates_policy',
]);
const CRITICAL_NEWS_GEO_HINTS = [
  { pattern: /\b(hormuz|strait of hormuz|persian gulf|gulf of oman|qatar|doha|ras laffan|south pars|north field|asaluyeh|bahrain|kuwait|uae|abu dhabi|dubai|fujairah|oman|saudi|riyadh|iraq|iran|israel|gaza|lebanon|syria|yemen)\b/i, region: 'Middle East', macroRegion: 'MENA' },
  { pattern: /\b(red sea|bab el[- ]mandeb|suez)\b/i, region: 'Red Sea', macroRegion: 'MENA' },
  { pattern: /\b(black sea|kerch|sevastopol)\b/i, region: 'Black Sea', macroRegion: 'EUROPE' },
  { pattern: /\b(baltic sea|baltic)\b/i, region: 'Baltic Sea', macroRegion: 'EUROPE' },
  { pattern: /\b(taiwan|south china sea|china|japan|korea|philippines)\b/i, region: 'South China Sea', macroRegion: 'EAST_ASIA' },
  { pattern: /\b(united states|u\.s\.|washington|new york)\b/i, region: 'United States', macroRegion: 'AMERICAS' },
];

function normalizeCriticalThreatLevel(value, text = '') {
  const lower = String(value || '').toLowerCase();
  if (lower.includes('critical')) return 'critical';
  if (lower.includes('high')) return 'high';
  if (lower.includes('elevated')) return 'elevated';
  if (lower.includes('moderate')) return 'moderate';
  if (/\b(killed|dead|casualties|massive|catastrophic)\b/i.test(text)) return 'critical';
  if (CRITICAL_NEWS_ATTACK_RE.test(text) || CRITICAL_NEWS_BLOCKAGE_RE.test(text) || CRITICAL_NEWS_SANCTIONS_RE.test(text)) return 'high';
  return 'moderate';
}

function getCriticalThreatWeight(level) {
  switch (level) {
    case 'critical': return 0.32;
    case 'high': return 0.24;
    case 'elevated': return 0.16;
    default: return 0.08;
  }
}

const CRITICAL_SIGNAL_SYSTEM_PROMPT = `You extract urgent world-state event frames for simulation input.

Return ONLY a JSON array.

Each item must be:
{
  "index": number,
  "primaryKind": "route_blockage" | "facility_attack" | "export_disruption" | "sanctions_escalation" | "ultimatum_escalation" | "power_disruption" | "policy_intervention" | "other",
  "impactHints": string[],
  "region": string,
  "macroRegion": string,
  "route": string,
  "facility": string,
  "commodity": string,
  "actor": string,
  "strength": number,
  "confidence": number,
  "evidence": string[],
  "summary": string
}

Rules:
- Only emit frames for urgent, state-changing items.
- Prefer omission over weak guesses.
- Keep strength and confidence between 0 and 1.
- Use impactHints only from: shipping, energy, gas_lng, refined_products, sovereign, infrastructure, rates_policy.
- Keep evidence concise and grounded in the input item.
- If the item is not materially state-changing, omit it.
- Do not add prose outside the JSON array.`;

function inferCriticalSignalGeo(text, fallbackRegion = '') {
  for (const hint of CRITICAL_NEWS_GEO_HINTS) {
    if (hint.pattern.test(text)) return { region: hint.region, macroRegion: hint.macroRegion };
  }
  const region = fallbackRegion || '';
  return { region, macroRegion: getMacroRegion([region]) || '' };
}

function extractNewsClusterItems(newsInsights, newsDigest) {
  const items = [];
  const seen = new Set();
  const pushItem = (item) => {
    const title = String(item?.title || item?.primaryTitle || '').trim();
    if (!title || seen.has(title)) return;
    seen.add(title);
    items.push({
      title,
      summary: String(item?.summary || item?.description || '').trim(),
      pubDate: item?.pubDate || item?.publishedAt || item?.date || newsInsights?.generatedAt || '',
      sourceCount: Number(item?.sourceCount || 1),
      isAlert: Boolean(item?.isAlert),
      threatLevel: normalizeCriticalThreatLevel(item?.threatLevel, title),
      sourceKey: item?.primaryLink || item?.link || title,
    });
  };

  for (const story of newsInsights?.topStories || []) pushItem(story);
  for (const bucket of Object.values(newsDigest?.categories || {})) {
    for (const item of bucket?.items || []) pushItem(item);
  }

  return items;
}

function buildCriticalSignalSupport(item, details = []) {
  return [
    item?.title || '',
    item?.sourceCount > 1 ? `${item.sourceCount} corroborating source(s)` : '',
    ...details,
  ].filter(Boolean).slice(0, 3);
}

function pushCriticalSignal(signals, type, sourceType, label, patch = {}) {
  signals.push(buildWorldSignal(type, sourceType, label, patch));
}

function addCriticalSignalsFromTextItem(signals, item, sourceType = 'critical_news', fallbackRegion = '') {
  const text = `${item?.title || ''} ${item?.summary || ''}`.trim();
  if (!text) return;

  const threatLevel = normalizeCriticalThreatLevel(item?.threatLevel, text);
  const threatWeight = getCriticalThreatWeight(threatLevel);
  const corroborationBoost = Math.min(0.12, Math.max(0, (Number(item?.sourceCount || 1) - 1) * 0.03));
  const alertBoost = item?.isAlert ? 0.06 : 0;
  const hasRoute = CRITICAL_NEWS_ROUTE_RE.test(text);
  const hasBlockage = CRITICAL_NEWS_BLOCKAGE_RE.test(text);
  const hasAttack = CRITICAL_NEWS_ATTACK_RE.test(text);
  const hasEnergy = CRITICAL_NEWS_ENERGY_RE.test(text);
  const hasLng = CRITICAL_NEWS_LNG_RE.test(text);
  const hasRefinery = CRITICAL_NEWS_REFINERY_RE.test(text);
  const hasSanctions = CRITICAL_NEWS_SANCTIONS_RE.test(text);
  const hasUltimatum = CRITICAL_NEWS_ULTIMATUM_RE.test(text);
  const hasPower = CRITICAL_NEWS_POWER_RE.test(text);
  const { region, macroRegion } = inferCriticalSignalGeo(text, fallbackRegion);
  const baseStrength = clampUnitInterval(0.34 + threatWeight + corroborationBoost + alertBoost);
  const baseConfidence = clampUnitInterval(0.52 + (threatWeight * 0.9) + corroborationBoost + (item?.isAlert ? 0.04 : 0));

  if (hasRoute && (hasBlockage || hasAttack || hasUltimatum)) {
    pushCriticalSignal(signals, 'shipping_cost_shock', sourceType, `${region || 'Critical route'} disruption pressure`, {
      sourceKey: `${sourceType}:${region || 'global'}:route_disruption`,
      region,
      macroRegion,
      strength: baseStrength + 0.1,
      confidence: baseConfidence,
      domains: ['supply_chain', 'market'],
      supportingEvidence: buildCriticalSignalSupport(item, ['Route disruption / closure terms are active']),
    });
    if (hasEnergy || /\b(hormuz|tanker|crude|oil|gulf)\b/i.test(text)) {
      pushCriticalSignal(signals, 'energy_supply_shock', sourceType, `${region || 'Critical route'} energy transit pressure`, {
        sourceKey: `${sourceType}:${region || 'global'}:route_energy`,
        region,
        macroRegion,
        strength: baseStrength + 0.12,
        confidence: baseConfidence + 0.02,
        domains: ['market', 'supply_chain'],
        supportingEvidence: buildCriticalSignalSupport(item, ['Energy transit exposure is directly referenced']),
      });
    }
  }

  if (hasAttack && hasEnergy) {
    pushCriticalSignal(signals, 'energy_supply_shock', sourceType, `${region || 'Critical asset'} energy infrastructure stress`, {
      sourceKey: `${sourceType}:${region || 'global'}:energy_asset`,
      region,
      macroRegion,
      strength: baseStrength + 0.14,
      confidence: baseConfidence + 0.04,
      domains: ['market', 'infrastructure'],
      supportingEvidence: buildCriticalSignalSupport(item, ['Energy facility / export infrastructure is under direct threat']),
    });
    if (hasLng) {
      pushCriticalSignal(signals, 'gas_supply_stress', sourceType, `${region || 'Critical asset'} LNG and gas export stress`, {
        sourceKey: `${sourceType}:${region || 'global'}:lng_export`,
        region,
        macroRegion,
        strength: baseStrength + 0.16,
        confidence: baseConfidence + 0.06,
        domains: ['market', 'supply_chain'],
        supportingEvidence: buildCriticalSignalSupport(item, ['Gas / LNG export capacity is directly implicated']),
      });
    }
    if (hasRefinery) {
      pushCriticalSignal(signals, 'commodity_repricing', sourceType, `${region || 'Critical asset'} refined-product repricing risk`, {
        sourceKey: `${sourceType}:${region || 'global'}:refinery_damage`,
        region,
        macroRegion,
        strength: baseStrength + 0.08,
        confidence: baseConfidence,
        domains: ['market'],
        supportingEvidence: buildCriticalSignalSupport(item, ['Refinery / storage / petrochemical damage is referenced']),
      });
    }
  }

  if (hasSanctions) {
    pushCriticalSignal(signals, 'sovereign_stress', sourceType, `${region || 'Targeted region'} sanctions pressure is intensifying`, {
      sourceKey: `${sourceType}:${region || 'global'}:sanctions_pressure`,
      region,
      macroRegion,
      strength: baseStrength,
      confidence: baseConfidence,
      domains: ['market', 'political'],
      supportingEvidence: buildCriticalSignalSupport(item, ['Sanctions / export-control pressure is directly referenced']),
    });
    if (hasEnergy) {
      pushCriticalSignal(signals, 'commodity_repricing', sourceType, `${region || 'Targeted region'} sanctions are feeding commodity repricing`, {
        sourceKey: `${sourceType}:${region || 'global'}:sanctions_commodity`,
        region,
        macroRegion,
        strength: baseStrength + 0.08,
        confidence: baseConfidence - 0.02,
        domains: ['market'],
        supportingEvidence: buildCriticalSignalSupport(item, ['Energy / commodity sanctions are directly implicated']),
      });
    }
  }

  if (hasUltimatum && (hasRoute || hasEnergy || hasSanctions)) {
    pushCriticalSignal(signals, 'sovereign_stress', sourceType, `${region || 'Flashpoint'} deadline pressure is escalating`, {
      sourceKey: `${sourceType}:${region || 'global'}:ultimatum`,
      region,
      macroRegion,
      strength: baseStrength,
      confidence: baseConfidence - 0.04,
      domains: ['market', 'political', 'conflict'],
      supportingEvidence: buildCriticalSignalSupport(item, ['Deadline / ultimatum language indicates an acute state change']),
    });
  }

  if (hasPower && (hasAttack || threatLevel === 'critical')) {
    pushCriticalSignal(signals, 'infrastructure_capacity_loss', sourceType, `${region || 'Critical grid'} infrastructure capacity is under pressure`, {
      sourceKey: `${sourceType}:${region || 'global'}:power_infra`,
      region,
      macroRegion,
      strength: baseStrength,
      confidence: baseConfidence - 0.02,
      domains: ['infrastructure', 'market'],
      supportingEvidence: buildCriticalSignalSupport(item, ['Grid / power infrastructure damage is referenced']),
    });
  }
}

function scoreCriticalNewsCandidate(item) {
  const text = `${item?.title || ''} ${item?.summary || ''}`.trim();
  const threatLevel = normalizeCriticalThreatLevel(item?.threatLevel, text);
  const threatWeight = getCriticalThreatWeight(threatLevel);
  const hasRoute = CRITICAL_NEWS_ROUTE_RE.test(text);
  const hasBlockage = CRITICAL_NEWS_BLOCKAGE_RE.test(text);
  const hasAttack = CRITICAL_NEWS_ATTACK_RE.test(text);
  const hasEnergy = CRITICAL_NEWS_ENERGY_RE.test(text);
  const hasLng = CRITICAL_NEWS_LNG_RE.test(text);
  const hasRefinery = CRITICAL_NEWS_REFINERY_RE.test(text);
  const hasSanctions = CRITICAL_NEWS_SANCTIONS_RE.test(text);
  const hasUltimatum = CRITICAL_NEWS_ULTIMATUM_RE.test(text);
  const hasPower = CRITICAL_NEWS_POWER_RE.test(text);
  const transmissionRelevant = hasRoute || hasEnergy || hasLng || hasRefinery || hasSanctions || hasUltimatum || hasPower;
  const { region, macroRegion } = inferCriticalSignalGeo(text, '');
  const tags = [];
  let score = 0.16 + threatWeight;

  if (item?.isAlert) score += 0.18;
  score += Math.min(0.16, Math.max(0, (Number(item?.sourceCount || 1) - 1) * 0.04));

  if (hasRoute) { score += 0.08; tags.push('route'); }
  if (hasBlockage) { score += 0.12; tags.push('blockage'); }
  if (hasAttack) { score += 0.12; tags.push('attack'); }
  if (hasEnergy) { score += 0.1; tags.push('energy'); }
  if (hasLng) { score += 0.08; tags.push('gas_lng'); }
  if (hasRefinery) { score += 0.06; tags.push('refinery'); }
  if (hasSanctions) { score += 0.08; tags.push('sanctions'); }
  if (hasUltimatum) { score += 0.08; tags.push('ultimatum'); }
  if (hasPower) { score += 0.06; tags.push('power'); }
  if (hasRoute && (hasBlockage || hasAttack || hasUltimatum)) score += 0.12;
  if (hasAttack && hasEnergy) score += 0.12;

  return {
    urgentScore: +clampUnitInterval(score).toFixed(3),
    regionHint: region,
    macroRegionHint: macroRegion,
    triageTags: uniqueSortedStrings(tags),
    isUrgent: transmissionRelevant && (
      clampUnitInterval(score) >= 0.58
      || (Boolean(item?.isAlert) && (hasRoute || hasEnergy || hasSanctions || hasPower || hasAttack))
    ),
  };
}

function selectUrgentCriticalNewsCandidates(inputs, limit = CRITICAL_SIGNAL_LLM_MAX_ITEMS) {
  return extractNewsClusterItems(inputs?.newsInsights, inputs?.newsDigest)
    .map((item, candidateIndex) => {
      const scored = scoreCriticalNewsCandidate(item);
      return {
        ...item,
        candidateIndex,
        urgentScore: scored.urgentScore,
        regionHint: scored.regionHint,
        macroRegionHint: scored.macroRegionHint,
        triageTags: scored.triageTags,
        isUrgent: scored.isUrgent,
      };
    })
    .filter((item) => item.isUrgent)
    .sort((a, b) =>
      b.urgentScore - a.urgentScore
      || Number(b.isAlert) - Number(a.isAlert)
      || (b.sourceCount || 0) - (a.sourceCount || 0)
      || a.title.localeCompare(b.title))
    .slice(0, limit);
}

function buildCriticalSignalCandidateHash(candidates = []) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(candidates.map((item) => ({
      i: item.candidateIndex,
      t: item.title,
      s: item.summary,
      tl: item.threatLevel,
      sc: item.sourceCount,
      a: !!item.isAlert,
      u: item.urgentScore,
      tags: item.triageTags || [],
    }))))
    .digest('hex')
    .slice(0, 16);
}

function buildCriticalSignalUserPrompt(candidates = []) {
  return `Urgent news candidates to classify into event frames:

${candidates.map((item) => {
  const parts = [
    `[${item.candidateIndex}] threat=${item.threatLevel} alert=${item.isAlert ? 'yes' : 'no'} sources=${item.sourceCount || 1} score=${item.urgentScore}`,
    item.regionHint ? `region_hint=${item.regionHint}` : '',
    item.triageTags?.length ? `tags=${item.triageTags.join(',')}` : '',
    `Title: ${sanitizeForPrompt(item.title)}`,
    item.summary ? `Summary: ${sanitizeForPrompt(item.summary)}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}).join('\n\n')}`;
}

function normalizeCriticalSignalImpactHints(hints) {
  const values = Array.isArray(hints) ? hints : [hints];
  const aliasMap = {
    gas: 'gas_lng',
    lng: 'gas_lng',
    gas_lng: 'gas_lng',
    refined: 'refined_products',
    refinery: 'refined_products',
    refined_products: 'refined_products',
    sovereign: 'sovereign',
    sovereign_risk: 'sovereign',
    infrastructure: 'infrastructure',
    infra: 'infrastructure',
    energy: 'energy',
    shipping: 'shipping',
    route: 'shipping',
    rates: 'rates_policy',
    policy: 'rates_policy',
    rates_policy: 'rates_policy',
  };
  return uniqueSortedStrings(
    values
      .map((value) => aliasMap[String(value || '').trim().toLowerCase()] || String(value || '').trim().toLowerCase())
      .filter((value) => CRITICAL_SIGNAL_IMPACT_HINTS.has(value))
  );
}

function validateCriticalSignalFrames(items, candidates = []) {
  if (!Array.isArray(items)) return [];
  const candidateMap = new Map(candidates.map((item) => [item.candidateIndex, item]));
  const seen = new Set();
  const valid = [];
  for (const item of items) {
    const index = Number(item?.index);
    if (!Number.isInteger(index) || !candidateMap.has(index) || seen.has(index)) continue;
    const primaryKind = String(item?.primaryKind || '').trim().toLowerCase();
    if (!CRITICAL_SIGNAL_PRIMARY_KINDS.has(primaryKind)) continue;
    const impactHints = normalizeCriticalSignalImpactHints(item?.impactHints);
    const strength = clampUnitInterval(Number(item?.strength ?? 0));
    const confidence = clampUnitInterval(Number(item?.confidence ?? 0));
    if ((strength <= 0 && confidence <= 0) || (impactHints.length === 0 && primaryKind === 'other')) continue;
    valid.push({
      index,
      primaryKind,
      impactHints,
      region: String(item?.region || '').trim(),
      macroRegion: String(item?.macroRegion || '').trim(),
      route: String(item?.route || '').trim(),
      facility: String(item?.facility || '').trim(),
      commodity: String(item?.commodity || '').trim(),
      actor: String(item?.actor || '').trim(),
      strength,
      confidence,
      evidence: Array.isArray(item?.evidence)
        ? item.evidence.map((entry) => sanitizeForPrompt(String(entry || ''))).filter(Boolean).slice(0, 3)
        : [],
      summary: sanitizeForPrompt(String(item?.summary || '')).slice(0, 220),
    });
    seen.add(index);
  }
  return valid;
}

function mapCriticalSignalFrameToSignals(frame, candidate) {
  const signals = [];
  const text = `${candidate?.title || ''} ${candidate?.summary || ''}`.trim();
  const inferredGeo = inferCriticalSignalGeo(text, candidate?.regionHint || '');
  const region = frame.region || candidate?.regionHint || inferredGeo.region || '';
  const macroRegion = frame.macroRegion || candidate?.macroRegionHint || inferredGeo.macroRegion || getMacroRegion([region]) || '';
  const baseStrength = clampUnitInterval(Number(frame.strength || candidate?.urgentScore || 0.6));
  const baseConfidence = clampUnitInterval(Number(frame.confidence || Math.max(0.58, candidate?.urgentScore || 0)));
  const impactHints = new Set(frame.impactHints || []);
  const commodity = `${frame.commodity || ''} ${text}`.toLowerCase();
  const routeLabel = frame.route || region || 'Critical route';
  const facilityLabel = frame.facility || region || 'Critical asset';
  const support = buildCriticalSignalSupport(candidate, mergeSignalLists(
    [frame.summary, ...frame.evidence],
    [frame.route || '', frame.facility || '', frame.commodity || '', frame.actor || ''],
    3,
  ));

  if (frame.primaryKind === 'route_blockage' || impactHints.has('shipping')) {
    pushCriticalSignal(signals, 'shipping_cost_shock', 'critical_news_llm', `${routeLabel} disruption pressure`, {
      sourceKey: `critical_news_llm:${candidate?.sourceKey || routeLabel}:route_disruption`,
      region,
      macroRegion,
      strength: baseStrength + 0.08,
      confidence: baseConfidence,
      domains: ['supply_chain', 'market'],
      supportingEvidence: support,
    });
  }

  if (
    impactHints.has('energy')
    || frame.primaryKind === 'facility_attack'
    || frame.primaryKind === 'export_disruption'
    || (frame.primaryKind === 'route_blockage' && /\b(oil|crude|tanker|gulf|energy)\b/i.test(commodity))
  ) {
    pushCriticalSignal(signals, 'energy_supply_shock', 'critical_news_llm', `${facilityLabel} energy infrastructure stress`, {
      sourceKey: `critical_news_llm:${candidate?.sourceKey || facilityLabel}:energy_asset`,
      region,
      macroRegion,
      strength: baseStrength + 0.12,
      confidence: baseConfidence + 0.04,
      domains: ['market', 'infrastructure'],
      supportingEvidence: support,
    });
  }

  if (impactHints.has('gas_lng') || /\b(lng|gas|north field|south pars|ras laffan)\b/i.test(commodity)) {
    pushCriticalSignal(signals, 'gas_supply_stress', 'critical_news_llm', `${facilityLabel} LNG and gas export stress`, {
      sourceKey: `critical_news_llm:${candidate?.sourceKey || facilityLabel}:lng_export`,
      region,
      macroRegion,
      strength: baseStrength + 0.14,
      confidence: baseConfidence + 0.05,
      domains: ['market', 'supply_chain'],
      supportingEvidence: support,
    });
  }

  if (impactHints.has('refined_products') || /\b(refinery|petrochemical|fuel depot|tank farm|storage tank)\b/i.test(commodity)) {
    pushCriticalSignal(signals, 'commodity_repricing', 'critical_news_llm', `${facilityLabel} refined-product repricing risk`, {
      sourceKey: `critical_news_llm:${candidate?.sourceKey || facilityLabel}:refinery_damage`,
      region,
      macroRegion,
      strength: baseStrength + 0.06,
      confidence: baseConfidence,
      domains: ['market'],
      supportingEvidence: support,
    });
  }

  if (
    frame.primaryKind === 'sanctions_escalation'
    || frame.primaryKind === 'ultimatum_escalation'
    || impactHints.has('sovereign')
  ) {
    const sovereignLabel = frame.primaryKind === 'ultimatum_escalation'
      ? `${region || 'Flashpoint'} deadline pressure is escalating`
      : `${region || 'Targeted region'} sanctions pressure is intensifying`;
    pushCriticalSignal(signals, 'sovereign_stress', 'critical_news_llm', sovereignLabel, {
      sourceKey: `critical_news_llm:${candidate?.sourceKey || region || 'global'}:sovereign`,
      region,
      macroRegion,
      strength: baseStrength,
      confidence: baseConfidence,
      domains: ['market', 'political', ...(frame.primaryKind === 'ultimatum_escalation' ? ['conflict'] : [])],
      supportingEvidence: support,
    });
  }

  if (frame.primaryKind === 'power_disruption' || impactHints.has('infrastructure')) {
    pushCriticalSignal(signals, 'infrastructure_capacity_loss', 'critical_news_llm', `${facilityLabel} infrastructure capacity is under pressure`, {
      sourceKey: `critical_news_llm:${candidate?.sourceKey || facilityLabel}:power_infra`,
      region,
      macroRegion,
      strength: baseStrength,
      confidence: baseConfidence - 0.02,
      domains: ['infrastructure', 'market'],
      supportingEvidence: support,
    });
  }

  if (frame.primaryKind === 'policy_intervention' || impactHints.has('rates_policy')) {
    pushCriticalSignal(signals, 'policy_rate_pressure', 'critical_news_llm', `${region || 'Policy center'} emergency policy pressure is building`, {
      sourceKey: `critical_news_llm:${candidate?.sourceKey || region || 'global'}:policy`,
      region,
      macroRegion,
      strength: baseStrength - 0.04,
      confidence: baseConfidence - 0.02,
      domains: ['market', 'political'],
      supportingEvidence: support,
    });
  }

  return signals;
}

function extractIranEventCriticalSignals(inputs) {
  const signals = [];
  const iranEvents = Array.isArray(inputs?.iranEvents) ? inputs.iranEvents : inputs?.iranEvents?.events || [];
  for (const event of iranEvents.slice(0, 40)) {
    if (!['high', 'critical'].includes(normalizeCriticalThreatLevel(event?.severity, event?.title))) continue;
    addCriticalSignalsFromTextItem(signals, {
      title: event?.title || '',
      summary: `${event?.category || ''} ${event?.locationName || ''}`.trim(),
      threatLevel: event?.severity || 'high',
      sourceCount: 1,
      isAlert: String(event?.severity || '').toLowerCase() === 'critical',
    }, 'iran_events', inferCriticalSignalGeo(String(event?.locationName || '')).region || 'Middle East');
  }
  return signals;
}

function extractSanctionsCountrySignals(inputs) {
  const signals = [];
  const sanctionsCountries = Array.isArray(inputs?.sanctionsPressure?.countries) ? inputs.sanctionsPressure.countries : [];
  for (const country of sanctionsCountries.slice(0, 10)) {
    if (Number(country?.newEntryCount || 0) <= 0 && Number(country?.entryCount || 0) < 8) continue;
    const region = country?.countryName || '';
    const macroRegion = getMacroRegion([region]) || '';
    pushCriticalSignal(signals, 'sovereign_stress', 'sanctions_pressure', `${region} sanctions pressure is rising`, {
      sourceKey: `sanctions_pressure:${country?.countryCode || region}:sovereign`,
      region,
      macroRegion,
      strength: normalizeSignalStrength(Math.max(Number(country?.newEntryCount || 0) * 0.18, Number(country?.entryCount || 0) * 0.05), 0.15, 1),
      confidence: clampUnitInterval(0.62 + Math.min(0.14, Number(country?.newEntryCount || 0) * 0.04)),
      domains: ['market', 'political'],
      supportingEvidence: [
        `${country?.entryCount || 0} listed entries`,
        `${country?.newEntryCount || 0} new designations`,
      ],
    });
    if (Number(country?.vesselCount || 0) > 0) {
      pushCriticalSignal(signals, 'shipping_cost_shock', 'sanctions_pressure', `${region} sanctions are tightening shipping pressure`, {
        sourceKey: `sanctions_pressure:${country?.countryCode || region}:shipping`,
        region,
        macroRegion,
        strength: normalizeSignalStrength(Number(country?.vesselCount || 0), 1, 6),
        confidence: 0.7,
        domains: ['market', 'supply_chain'],
        supportingEvidence: [`${country?.vesselCount || 0} vessel-linked designations`],
      });
    }
  }
  return signals;
}

function extractSanctionsEntrySignals(inputs) {
  const signals = [];
  const sanctionsEntries = Array.isArray(inputs?.sanctionsPressure?.entries) ? inputs.sanctionsPressure.entries : [];
  for (const entry of sanctionsEntries.slice(0, 12)) {
    if (!entry?.isNew) continue;
    addCriticalSignalsFromTextItem(signals, {
      title: entry?.name || '',
      summary: `${(entry?.programs || []).join(' ')} ${entry?.note || ''}`.trim(),
      threatLevel: 'high',
      sourceCount: 1,
      isAlert: false,
    }, 'sanctions_pressure', entry?.countryNames?.[0] || entry?.countryCodes?.[0] || '');
  }
  return signals;
}

function extractThermalCriticalSignals(inputs) {
  const signals = [];
  const thermalClusters = Array.isArray(inputs?.thermalEscalation?.clusters) ? inputs.thermalEscalation.clusters : [];
  for (const cluster of thermalClusters.slice(0, 12)) {
    const highRelevance = cluster?.strategicRelevance === 'THERMAL_RELEVANCE_HIGH';
    const acuteStatus = cluster?.status === 'THERMAL_STATUS_SPIKE' || cluster?.status === 'THERMAL_STATUS_PERSISTENT';
    if (!highRelevance || !acuteStatus || cluster?.context !== 'THERMAL_CONTEXT_CONFLICT_ADJACENT') continue;
    const region = cluster?.countryName || cluster?.regionLabel || '';
    const macroRegion = getMacroRegion([region]) || '';
    pushCriticalSignal(signals, 'infrastructure_capacity_loss', 'thermal_escalation', `${region || 'Conflict-adjacent'} thermal escalation is threatening infrastructure`, {
      sourceKey: `thermal_escalation:${cluster?.id || region}:infrastructure`,
      region,
      macroRegion,
      strength: normalizeSignalStrength(Math.max(Number(cluster?.totalFrp || 0), Number(cluster?.observationCount || 0) * 15), 60, 220),
      confidence: cluster?.confidence === 'THERMAL_CONFIDENCE_HIGH' ? 0.72 : 0.62,
      domains: ['infrastructure', 'conflict'],
      supportingEvidence: [
        `${cluster?.status || 'thermal escalation'} in ${region || cluster?.regionLabel || 'tracked area'}`,
        `${cluster?.observationCount || 0} observations with total FRP ${cluster?.totalFrp || 0}`,
      ],
    });
    if (/\b(qatar|iran|iraq|kuwait|saudi|united arab emirates|uae|oman|bahrain|libya)\b/i.test(region)) {
      pushCriticalSignal(signals, 'energy_supply_shock', 'thermal_escalation', `${region || 'Conflict-adjacent'} thermal escalation is threatening energy throughput`, {
        sourceKey: `thermal_escalation:${cluster?.id || region}:energy`,
        region,
        macroRegion,
        strength: normalizeSignalStrength(Math.max(Number(cluster?.totalFrp || 0), Number(cluster?.persistenceHours || 0) * 10), 80, 260),
        confidence: cluster?.confidence === 'THERMAL_CONFIDENCE_HIGH' ? 0.7 : 0.6,
        domains: ['market', 'infrastructure'],
        supportingEvidence: [`${region} is both conflict-adjacent and energy-sensitive`],
      });
    }
  }
  return signals;
}

function extractStructuredCriticalSignals(inputs) {
  return [
    ...extractIranEventCriticalSignals(inputs),
    ...extractSanctionsCountrySignals(inputs),
    ...extractSanctionsEntrySignals(inputs),
    ...extractThermalCriticalSignals(inputs),
  ];
}

function extractRegexCriticalNewsSignals(inputs, candidateItems = null) {
  const signals = [];
  const items = Array.isArray(candidateItems) ? candidateItems : extractNewsClusterItems(inputs?.newsInsights, inputs?.newsDigest);
  for (const item of items) {
    addCriticalSignalsFromTextItem(signals, item, 'critical_news');
  }
  return signals;
}

async function extractCriticalSignalBundle(inputs) {
  const structuredSignals = extractStructuredCriticalSignals(inputs);
  const candidates = selectUrgentCriticalNewsCandidates(inputs);
  const candidateSummary = candidates.map((item) => ({
    index: item.candidateIndex,
    title: item.title,
    threatLevel: item.threatLevel,
    sourceCount: item.sourceCount || 1,
    isAlert: !!item.isAlert,
    urgentScore: item.urgentScore,
    regionHint: item.regionHint || '',
    triageTags: item.triageTags || [],
  }));

  const bundle = {
    source: 'deterministic_only',
    provider: '',
    model: '',
    parseStage: '',
    rawPreview: '',
    failureReason: '',
    candidateCount: candidates.length,
    extractedFrameCount: 0,
    mappedSignalCount: 0,
    fallbackNewsSignalCount: 0,
    structuredSignalCount: structuredSignals.length,
    candidates: candidateSummary,
    signals: structuredSignals,
  };

  if (candidates.length === 0) return bundle;

  const { url, token } = getRedisCredentials();
  const cacheKey = `forecast:critical-signals:llm:${buildCriticalSignalCandidateHash(candidates)}`;
  const fallbackSignalsFromCandidates = (coveredIndexes = new Set()) =>
    extractRegexCriticalNewsSignals(inputs, candidates.filter((item) => !coveredIndexes.has(item.candidateIndex)));

  const applyFrames = (frames) => {
    const coveredIndexes = new Set();
    const llmSignals = [];
    for (const frame of frames) {
      const candidate = candidates.find((item) => item.candidateIndex === frame.index);
      if (!candidate) continue;
      coveredIndexes.add(frame.index);
      llmSignals.push(...mapCriticalSignalFrameToSignals(frame, candidate));
    }
    const fallbackSignals = fallbackSignalsFromCandidates(coveredIndexes);
    bundle.extractedFrameCount = frames.length;
    bundle.mappedSignalCount = llmSignals.length;
    bundle.fallbackNewsSignalCount = fallbackSignals.length;
    bundle.signals = [...llmSignals, ...fallbackSignals, ...structuredSignals];
  };

  const cached = await redisGet(url, token, cacheKey);
  if (Array.isArray(cached?.frames)) {
    const validFrames = validateCriticalSignalFrames(cached.frames, candidates);
    if (validFrames.length > 0) {
      bundle.source = 'cache';
      bundle.provider = 'cache';
      bundle.model = 'cache';
      bundle.parseStage = 'cache_frames';
      applyFrames(validFrames);
      return bundle;
    }
  }

  const llmOptions = {
    ...getForecastLlmCallOptions('critical_signals'),
    stage: 'critical_signals',
    maxTokens: 1200,
    temperature: 0.1,
  };
  const result = await callForecastLLM(
    CRITICAL_SIGNAL_SYSTEM_PROMPT,
    buildCriticalSignalUserPrompt(candidates),
    llmOptions,
  );

  if (!result) {
    bundle.failureReason = 'call_failed';
    const fallbackSignals = fallbackSignalsFromCandidates();
    bundle.fallbackNewsSignalCount = fallbackSignals.length;
    bundle.signals = [...fallbackSignals, ...structuredSignals];
    return bundle;
  }

  const parsed = extractStructuredLlmPayload(result.text);
  const validFrames = validateCriticalSignalFrames(parsed.items, candidates);
  bundle.source = 'live';
  bundle.provider = result.provider;
  bundle.model = result.model;
  bundle.parseStage = parsed.diagnostics?.stage || '';
  bundle.rawPreview = parsed.diagnostics?.preview || '';

  if (validFrames.length === 0) {
    bundle.failureReason = parsed.items == null ? 'parse_failed' : 'validation_failed';
    const fallbackSignals = fallbackSignalsFromCandidates();
    bundle.fallbackNewsSignalCount = fallbackSignals.length;
    bundle.signals = [...fallbackSignals, ...structuredSignals];
    return bundle;
  }

  applyFrames(validFrames);
  await redisSet(url, token, cacheKey, { frames: validFrames }, CRITICAL_SIGNAL_CACHE_TTL_SECONDS);
  return bundle;
}

function extractCriticalNewsSignals(inputs) {
  if (Array.isArray(inputs?.criticalSignalBundle?.signals)) return inputs.criticalSignalBundle.signals;
  return [
    ...extractRegexCriticalNewsSignals(inputs),
    ...extractStructuredCriticalSignals(inputs),
  ];
}

function attachNewsContext(predictions, newsInsights, newsDigest) {
  const allHeadlines = extractAllHeadlines(newsInsights, newsDigest);
  if (allHeadlines.length === 0) return;

  for (const pred of predictions) {
    const searchTerms = getSearchTermsForRegion(pred.region);
    const expectedTags = buildExpectedRegionTags(searchTerms, pred.region);
    const titleTokens = extractMeaningfulTokens(pred.title, searchTerms);
    const matched = allHeadlines
      .map(headline => ({
        headline,
        score: computeHeadlineRelevance(headline, searchTerms, pred.domain, {
          region: pred.region,
          expectedTags,
          titleTokens,
          requireRegion: true,
          requireSemantic: true,
        }),
      }))
      .filter(item => item.score >= 4)
      .sort((a, b) => b.score - a.score || a.headline.length - b.headline.length)
      .map(item => item.headline);

    pred.newsContext = matched.slice(0, 4);

    if (matched.length > 0) {
      pred.signals.push({
        type: 'news_corroboration',
        value: `${matched.length} headline(s) mention ${pred.region} or linked entities`,
        weight: 0.15,
      });
    }
  }
}

// ── Phase 2: Deterministic Confidence Model ────────────────
const SIGNAL_TO_SOURCE = {
  cii: 'cii', cii_delta: 'cii', unrest: 'cii',
  conflict_events: 'iran_events',
  ucdp: 'ucdp',
  theater: 'theater_posture', indicators: 'theater_posture',
  mil_flights: 'temporal_anomalies', anomaly: 'temporal_anomalies',
  chokepoint: 'chokepoints',
  ais_gap: 'temporal_anomalies',
  gps_jamming: 'gps_jamming',
  outage: 'outages',
  cyber: 'cyber_threats',
  prediction_market: 'prediction_markets',
  news_corroboration: 'news_insights',
};

function computeConfidence(predictions) {
  for (const pred of predictions) {
    const sources = new Set(pred.signals.map(s => SIGNAL_TO_SOURCE[s.type] || s.type));
    const sourceDiversity = normalize(sources.size, 1, 4);
    const calibrationAgreement = pred.calibration
      ? Math.max(0, 1 - Math.abs(pred.calibration.drift) * 3)
      : 0.5;
    const conf = 0.5 * sourceDiversity + 0.5 * calibrationAgreement;
    pred.confidence = Math.round(Math.max(0.2, Math.min(1, conf)) * 1000) / 1000;
  }
}

function roundPct(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function slugifyValue(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function buildCounterEvidence(pred) {
  const items = [];
  if (!pred.newsContext || pred.newsContext.length === 0) {
    items.push({ type: 'coverage_gap', summary: `No directly matched headlines are currently attached to ${pred.region}.`, weight: 0.2 });
  }
  if (pred.confidence < 0.45) {
    items.push({ type: 'confidence', summary: `Confidence is only ${roundPct(pred.confidence)}, implying thin source diversity or mixed calibration.`, weight: 0.25 });
  }
  if (pred.trend === 'falling') {
    items.push({ type: 'trend', summary: `The forecast is already trending down from its prior snapshot (${roundPct(pred.priorProbability)} to ${roundPct(pred.probability)}).`, weight: 0.35 });
  }
  if (pred.calibration) {
    const drift = pred.calibration.drift;
    if (Math.abs(drift) >= 0.08) {
      const direction = drift > 0 ? 'below' : 'above';
      items.push({
        type: 'market_divergence',
        summary: `${pred.calibration.source} pricing in "${pred.calibration.marketTitle}" sits ${direction} the internal estimate by ${Math.round(Math.abs(drift) * 100)} points.`,
        weight: Math.min(0.5, Math.abs(drift)),
      });
    }
  }
  return items.slice(0, 4);
}

function buildCaseTriggers(pred) {
  const triggers = [];
  for (const signal of pred.signals || []) {
    const template = SIGNAL_TRIGGER_TEMPLATES[signal.type];
    if (!template) continue;
    triggers.push(template(pred, signal));
    if (triggers.length >= 4) break;
  }
  if (pred.calibration) {
    triggers.push(`If prediction markets move decisively away from ${roundPct(pred.calibration.marketPrice)}, revisit the probability baseline.`);
  }
  return [...new Set(triggers)].slice(0, 4);
}

function buildForecastActors(pred) {
  const blueprints = DOMAIN_ACTOR_BLUEPRINTS[pred.domain] || [
    { key: 'regional_watchers', name: 'Regional watchers', category: 'general', influenceScore: 0.6 },
    { key: 'market_participants', name: 'Market participants', category: 'market', influenceScore: 0.52 },
    { key: 'external_observers', name: 'External observers', category: 'external', influenceScore: 0.48 },
  ];
  const topTrigger = buildCaseTriggers(pred)[0];
  const topSupport = pred.signals?.[0]?.value || pred.caseFile?.supportingEvidence?.[0]?.summary || pred.title;
  const drift = Math.abs(pred.calibration?.drift || 0);

  return blueprints.slice(0, 4).map((blueprint, index) => {
    const objectives = [];
    const constraints = [];
    const likelyActions = [];

    if (pred.domain === 'conflict' || pred.domain === 'military') {
      objectives.push(`Prevent the ${pred.region} situation from moving beyond the current ${pred.trend} path.`);
      objectives.push(`Preserve decision freedom if ${topSupport} hardens into a broader escalation signal.`);
      likelyActions.push(`Reposition attention and resources around ${pred.region} over the next ${pred.timeHorizon}.`);
    } else if (pred.domain === 'supply_chain') {
      objectives.push(`Keep critical flows through ${pred.region} functioning over the ${pred.timeHorizon}.`);
      objectives.push(`Reduce exposure if ${topSupport} persists into the next cycle.`);
      likelyActions.push(`Adjust routing and contingency plans around ${pred.region}.`);
    } else if (pred.domain === 'market') {
      objectives.push(`Price whether stress in ${pred.region} becomes durable over the ${pred.timeHorizon}.`);
      objectives.push(`Protect against repricing if ${topSupport} intensifies.`);
      likelyActions.push(`Rebalance positions if the probability path moves away from ${roundPct(pred.probability)}.`);
    } else if (pred.domain === 'cyber') {
      objectives.push(`Contain hostile cyber activity affecting ${pred.region} before it spills into core services.`);
      objectives.push(`Preserve resilience if ${topSupport} broadens into a sustained intrusion pattern.`);
      likelyActions.push(`Harden exposed systems and triage incident response in ${pred.region}.`);
    } else if (pred.domain === 'infrastructure') {
      objectives.push(`Contain service degradation in ${pred.region} before it becomes cross-system.`);
      objectives.push(`Maintain continuity if ${topSupport} spreads across adjacent systems.`);
      likelyActions.push(`Prioritize mitigation and continuity measures around the most exposed nodes.`);
    } else {
      objectives.push(`Manage the current ${pred.trend} trajectory in ${pred.region}.`);
      objectives.push(`Limit the chance that ${topSupport} becomes a wider destabilizing signal.`);
      likelyActions.push(`Shift messaging and posture as new evidence arrives.`);
    }

    if (topTrigger) likelyActions.push(topTrigger);
    if ((pred.cascades || []).length > 0) {
      likelyActions.push(`Monitor spillover into ${(pred.cascades || []).slice(0, 2).map(c => c.domain).join(' and ')}.`);
    }

    if (!pred.newsContext?.length) {
      constraints.push(`Public reporting directly tied to ${pred.region} is still thin.`);
    }
    if (drift >= 0.08 && pred.calibration?.marketTitle) {
      constraints.push(`Market pricing in "${pred.calibration.marketTitle}" is not fully aligned with the internal estimate.`);
    }
    if (pred.trend === 'falling') {
      constraints.push(`Recent momentum is softening from ${roundPct(pred.priorProbability)} to ${roundPct(pred.probability)}.`);
    }
    if (constraints.length === 0) {
      constraints.push(`Action remains bounded by the current ${roundPct(pred.confidence)} confidence level.`);
    }

    return {
      id: `${pred.id}:${slugifyValue(blueprint.key || blueprint.name || `actor_${index}`)}`,
      name: blueprint.name,
      category: blueprint.category,
      role: `${blueprint.name} is a primary ${blueprint.category} actor for the ${pred.domain} path in ${pred.region}.`,
      objectives: objectives.slice(0, 2),
      constraints: constraints.slice(0, 2),
      likelyActions: [...new Set(likelyActions)].slice(0, 3),
      influenceScore: +(blueprint.influenceScore || 0.5).toFixed(3),
    };
  });
}

function buildForecastWorldState(pred, actors = [], triggers = [], counterEvidence = []) {
  const leadSupport = pred.caseFile?.supportingEvidence?.[0]?.summary || pred.signals?.[0]?.value || pred.title;
  const summary = `${leadSupport} is setting the current ${pred.trend} baseline in ${pred.region}, with the forecast sitting near ${roundPct(pred.probability)} over the ${pred.timeHorizon}.`;

  const activePressures = [
    ...(pred.caseFile?.supportingEvidence || []).slice(0, 3).map(item => item.summary),
    ...(pred.cascades || []).slice(0, 1).map(cascade => `Spillover pressure into ${cascade.domain} via ${cascade.effect}.`),
  ].filter(Boolean).slice(0, 4);

  const stabilizers = [
    ...counterEvidence.slice(0, 2).map(item => item.summary),
    pred.trend === 'falling' ? `The observed trend is already easing from ${roundPct(pred.priorProbability)} to ${roundPct(pred.probability)}.` : '',
    pred.calibration && Math.abs(pred.calibration.drift || 0) < 0.05
      ? `Prediction-market pricing near ${roundPct(pred.calibration.marketPrice)} is not strongly disputing the internal estimate.`
      : '',
  ].filter(Boolean).slice(0, 3);

  const keyUnknowns = [
    ...triggers.slice(0, 2),
    actors[0]?.constraints?.[0] || '',
    !pred.newsContext?.length ? `Whether directly matched reporting on ${pred.region} appears in the next run.` : '',
  ].filter(Boolean).slice(0, 4);

  return {
    summary,
    activePressures,
    stabilizers,
    keyUnknowns,
  };
}

function branchTitle(kind) {
  if (kind === 'base') return 'Base Branch';
  if (kind === 'escalatory') return 'Escalatory Branch';
  return 'Contrarian Branch';
}

function branchShift(kind, pred, context = {}) {
  const pressureCount = context.worldState?.activePressures?.length || 0;
  const stabilizerCount = context.worldState?.stabilizers?.length || 0;
  const triggerCount = context.triggers?.length || 0;
  const cascadeFactor = Math.min(0.06, (pred.cascades?.length || 0) * 0.02);
  const driftFactor = Math.min(0.04, Math.abs(pred.calibration?.drift || 0) * 0.5);

  if (kind === 'escalatory') {
    return Math.min(0.22, 0.08 + (pressureCount * 0.02) + (triggerCount * 0.015) + cascadeFactor - (stabilizerCount * 0.01));
  }
  if (kind === 'contrarian') {
    return -Math.min(0.22, 0.08 + (stabilizerCount * 0.025) + driftFactor + (pred.trend === 'falling' ? 0.02 : 0));
  }

  const trendNudge = pred.trend === 'rising' ? 0.02 : pred.trend === 'falling' ? -0.02 : 0;
  return Math.max(-0.08, Math.min(0.08, trendNudge + ((pressureCount - stabilizerCount) * 0.01)));
}

function buildBranchRounds(kind, pred, context = {}) {
  const leadPressure = context.worldState?.activePressures?.[0] || pred.signals?.[0]?.value || pred.title;
  const leadTrigger = context.triggers?.[0] || `The next ${pred.domain} update in ${pred.region} becomes the key threshold.`;
  const leadStabilizer = context.worldState?.stabilizers?.[0] || context.counterEvidence?.[0]?.summary || `The current ${roundPct(pred.confidence)} confidence level keeps this path from becoming fully settled.`;
  const actors = context.actors || [];

  const round1 = {
    round: 1,
    focus: kind === 'contrarian' ? 'Constraint absorption' : 'Signal absorption',
    developments: [
      kind === 'contrarian'
        ? leadStabilizer
        : leadPressure,
    ].filter(Boolean),
    actorMoves: actors.slice(0, 2).map(actor => actor.likelyActions?.[0]).filter(Boolean),
    probabilityShift: +((branchShift(kind, pred, context)) / 3).toFixed(3),
  };

  const round2 = {
    round: 2,
    focus: 'Actor response',
    developments: [
      kind === 'escalatory'
        ? leadTrigger
        : kind === 'contrarian'
          ? `Actors slow the path if ${leadStabilizer.toLowerCase()}`
          : `Actors adapt to whether ${leadTrigger.toLowerCase()}`,
    ],
    actorMoves: actors.slice(0, 3).map(actor => actor.likelyActions?.[1] || actor.objectives?.[0]).filter(Boolean),
    probabilityShift: +((branchShift(kind, pred, context)) / 3).toFixed(3),
  };

  const round3 = {
    round: 3,
    focus: 'System effect',
    developments: [
      kind === 'escalatory' && (pred.cascades?.length || 0) > 0
        ? `Spillover becomes visible in ${(pred.cascades || []).slice(0, 2).map(c => c.domain).join(' and ')}.`
        : kind === 'contrarian'
          ? `The path cools if counter-pressure remains stronger than fresh escalation evidence.`
          : `The path settles near the current balance of pressure and restraint.`,
    ],
    actorMoves: actors.slice(0, 2).map(actor => actor.constraints?.[0]).filter(Boolean),
    probabilityShift: +(branchShift(kind, pred, context) - (((branchShift(kind, pred, context)) / 3) * 2)).toFixed(3),
  };

  return [round1, round2, round3];
}

function buildForecastBranches(pred, context = {}) {
  return ['base', 'escalatory', 'contrarian'].map(kind => {
    const shift = branchShift(kind, pred, context);
    const projectedProbability = clamp01((pred.probability || 0) + shift);
    const rounds = buildBranchRounds(kind, pred, context);
    const leadPressure = context.worldState?.activePressures?.[0] || pred.signals?.[0]?.value || pred.title;
    const leadStabilizer = context.worldState?.stabilizers?.[0] || context.counterEvidence?.[0]?.summary || `The current ${roundPct(pred.confidence)} confidence level still leaves room for reversal.`;
    const leadTrigger = context.triggers?.[0] || `The next evidence cycle in ${pred.region} becomes decisive.`;

    const summary = kind === 'escalatory'
      ? buildNarrativeSentence(
        leadTrigger,
        `If that threshold breaks, the path can move above the current ${roundPct(pred.probability)} baseline`,
      )
      : kind === 'contrarian'
        ? buildNarrativeSentence(
          leadStabilizer,
          `If that restraint persists, the forecast can move below the current ${roundPct(pred.probability)} baseline`,
        )
        : buildNarrativeSentence(
          leadPressure,
          `For now, the base case stays near ${roundPct(projectedProbability)} over the ${pred.timeHorizon}`,
        );

    const outcome = kind === 'escalatory'
      ? `Actors treat escalation as increasingly self-reinforcing, especially if cross-domain pressure appears.`
      : kind === 'contrarian'
        ? `Actors prioritize containment and the system drifts toward stabilization unless new hard signals emerge.`
        : `Actors absorb the current evidence mix without a decisive break toward either shock or relief.`;

    return {
      kind,
      title: branchTitle(kind),
      summary: summary.slice(0, 400),
      outcome: outcome.slice(0, 400),
      projectedProbability: +projectedProbability.toFixed(3),
      rounds,
    };
  });
}

function buildActorLenses(pred) {
  const actors = buildForecastActors(pred);
  const lenses = actors.map(actor => {
    const objective = actor.objectives?.[0] || actor.role;
    const action = actor.likelyActions?.[0] || `Track ${pred.region} closely over the ${pred.timeHorizon}.`;
    return `${actor.name}: ${objective} ${action}`;
  });
  if (pred.cascades?.length > 0) {
    lenses.push(`Cross-domain watchers will track spillover into ${pred.cascades.slice(0, 2).map(c => c.domain).join(' and ')} if this path hardens.`);
  }
  return lenses.slice(0, 4);
}

function buildForecastCase(pred) {
  const supportingEvidence = [];
  const rankedSignals = [...(pred.signals || [])].sort((a, b) => (b.weight || 0) - (a.weight || 0));

  for (const signal of rankedSignals.slice(0, 4)) {
    supportingEvidence.push({
      type: signal.type,
      summary: signal.value,
      weight: +(signal.weight || 0).toFixed(3),
    });
  }

  for (const headline of (pred.newsContext || []).slice(0, 2)) {
    supportingEvidence.push({
      type: 'headline',
      summary: headline,
      weight: 0.15,
    });
  }

  if (pred.calibration) {
    supportingEvidence.push({
      type: 'market_calibration',
      summary: `${pred.calibration.source} prices "${pred.calibration.marketTitle}" near ${roundPct(pred.calibration.marketPrice)}.`,
      weight: Math.min(0.5, Math.abs(pred.calibration.drift) + 0.2),
    });
  }

  for (const cascade of (pred.cascades || []).slice(0, 2)) {
    supportingEvidence.push({
      type: 'cascade',
      summary: `Potential spillover into ${cascade.domain} via ${cascade.effect} (${roundPct(cascade.probability)}).`,
      weight: +(cascade.probability || 0).toFixed(3),
    });
  }

  const counterEvidence = buildCounterEvidence(pred);
  const triggers = buildCaseTriggers(pred);
  const actors = buildForecastActors(pred);
  const actorLenses = actors.map(actor => {
    const objective = actor.objectives?.[0] || actor.role;
    const action = actor.likelyActions?.[0] || `Track ${pred.region} closely over the ${pred.timeHorizon}.`;
    return `${actor.name}: ${objective} ${action}`;
  }).slice(0, 4);
  const worldState = buildForecastWorldState(
    {
      ...pred,
      caseFile: {
        ...(pred.caseFile || {}),
        supportingEvidence: supportingEvidence.slice(0, 6),
      },
    },
    actors,
    triggers,
    counterEvidence,
  );
  const branches = buildForecastBranches(pred, {
    actors,
    triggers,
    counterEvidence,
    worldState,
  });

  pred.caseFile = {
    supportingEvidence: supportingEvidence.slice(0, 6),
    counterEvidence,
    triggers,
    actorLenses,
    baseCase: '',
    escalatoryCase: '',
    contrarianCase: '',
    changeSummary: '',
    changeItems: [],
    actors,
    worldState,
    branches,
  };

  return pred.caseFile;
}

function buildForecastCases(predictions) {
  for (const pred of predictions) buildForecastCase(pred);
}

function buildPriorForecastSnapshot(pred) {
  return {
    id: pred.id,
    probability: pred.probability,
    signals: (pred.signals || []).map(signal => signal.value),
    newsContext: pred.newsContext || [],
    calibration: pred.calibration
      ? {
          marketTitle: pred.calibration.marketTitle,
          marketPrice: pred.calibration.marketPrice,
        }
      : null,
  };
}

function buildHistoryForecastEntry(pred) {
  return {
    id: pred.id,
    domain: pred.domain,
    region: pred.region,
    title: pred.title,
    probability: pred.probability,
    confidence: pred.confidence,
    timeHorizon: pred.timeHorizon,
    trend: pred.trend,
    priorProbability: pred.priorProbability,
    signals: (pred.signals || []).slice(0, 6).map(signal => ({
      type: signal.type,
      value: signal.value,
      weight: signal.weight,
    })),
    newsContext: (pred.newsContext || []).slice(0, 4),
    calibration: pred.calibration
      ? {
          marketTitle: pred.calibration.marketTitle,
          marketPrice: pred.calibration.marketPrice,
          drift: pred.calibration.drift,
          source: pred.calibration.source,
        }
      : null,
    cascades: (pred.cascades || []).slice(0, 3).map(cascade => ({
      domain: cascade.domain,
      effect: cascade.effect,
      probability: cascade.probability,
    })),
  };
}

function buildHistorySnapshot(data, options = {}) {
  const maxForecasts = options.maxForecasts || HISTORY_MAX_FORECASTS;
  const predictions = Array.isArray(data?.predictions) ? data.predictions : [];
  return {
    generatedAt: data?.generatedAt || Date.now(),
    predictions: predictions.slice(0, maxForecasts).map(buildHistoryForecastEntry),
  };
}

async function appendHistorySnapshot(data, options = {}) {
  const key = options.key || HISTORY_KEY;
  const maxRuns = options.maxRuns || HISTORY_MAX_RUNS;
  const ttlSeconds = options.ttlSeconds || HISTORY_TTL_SECONDS;
  const snapshot = buildHistorySnapshot(data, options);
  const { url, token } = getRedisCredentials();

  await redisCommand(url, token, ['LPUSH', key, JSON.stringify(snapshot)]);
  await redisCommand(url, token, ['LTRIM', key, 0, maxRuns - 1]);
  await redisCommand(url, token, ['EXPIRE', key, ttlSeconds]);
  return snapshot;
}

function getTraceMaxForecasts(totalForecasts = 0) {
  const raw = process.env.FORECAST_TRACE_MAX_FORECASTS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(200, Math.floor(parsed));
  return totalForecasts > 0 ? totalForecasts : 50;
}

function getTraceCapLog(totalForecasts = 0) {
  return {
    raw: process.env.FORECAST_TRACE_MAX_FORECASTS || null,
    resolved: getTraceMaxForecasts(totalForecasts),
    totalForecasts,
  };
}

function applyTraceMeta(pred, patch) {
  pred.traceMeta = {
    ...(pred.traceMeta || {}),
    ...patch,
  };
}

function buildTraceRunPrefix(runId, generatedAt, basePrefix) {
  const iso = new Date(generatedAt || Date.now()).toISOString();
  const [datePart] = iso.split('T');
  const [year, month, day] = datePart.split('-');
  return `${basePrefix}/${year}/${month}/${day}/${runId}`;
}

function buildForecastTraceRecord(pred, rank, simulationByForecastId = null) {
  const caseFile = pred.caseFile || null;
  let worldState = caseFile?.worldState || null;
  if (worldState && simulationByForecastId) {
    const sim = simulationByForecastId.get(pred.id);
    if (sim) {
      const [r1, r2, r3] = sim.rounds || [];
      const simulationSummary = `${sim.label} moved through ${r1?.lead || 'initial interpretation'}, ${r2?.lead || 'interaction responses'}, and ${r3?.lead || 'regional effects'} before resolving to a ${describeSimulationPosture(sim.posture)} posture at ${roundPct(sim.postureScore)}.`;
      worldState = {
        ...worldState,
        situationId: sim.situationId,
        stateId: sim.situationId,
        stateLabel: sim.label,
        stateKind: sim.stateKind || '',
        sourceSituationIds: sim.sourceSituationIds || [],
        familyId: sim.familyId,
        familyLabel: sim.familyLabel,
        simulationSummary,
        simulationPosture: sim.posture,
        simulationPostureScore: sim.postureScore,
      };
    }
  }
  return {
    rank,
    id: pred.id,
    title: pred.title,
    domain: pred.domain,
    region: pred.region,
    probability: pred.probability,
    confidence: pred.confidence,
    trend: pred.trend,
    timeHorizon: pred.timeHorizon,
    priorProbability: pred.priorProbability,
    generationOrigin: pred.generationOrigin || 'legacy_detector',
    stateDerivedBackfill: !!pred.stateDerivedBackfill,
    feedSummary: pred.feedSummary || '',
    scenario: pred.scenario || '',
    projections: pred.projections || null,
    calibration: pred.calibration || null,
    cascades: pred.cascades || [],
    signals: pred.signals || [],
    newsContext: pred.newsContext || [],
    perspectives: pred.perspectives || null,
    caseFile: caseFile ? { ...caseFile, worldState } : null,
    readiness: scoreForecastReadiness(pred),
    analysisPriority: computeAnalysisPriority(pred),
    traceMeta: pred.traceMeta || {
      narrativeSource: 'fallback',
      branchSource: 'deterministic',
    },
  };
}

function slimForecastCaseForPublish(caseFile = null) {
  if (!caseFile) return null;
  return {
    supportingEvidence: (caseFile.supportingEvidence || []).slice(0, 4).map((item) => ({
      type: item.type || '',
      summary: item.summary || '',
      weight: Number(item.weight || 0),
    })),
    counterEvidence: (caseFile.counterEvidence || []).slice(0, 3).map((item) => ({
      type: item.type || '',
      summary: item.summary || '',
      weight: Number(item.weight || 0),
    })),
    triggers: (caseFile.triggers || []).slice(0, 3),
    actorLenses: (caseFile.actorLenses || []).slice(0, 3),
    baseCase: caseFile.baseCase || '',
    escalatoryCase: caseFile.escalatoryCase || '',
    contrarianCase: caseFile.contrarianCase || '',
    changeSummary: caseFile.changeSummary || '',
    changeItems: (caseFile.changeItems || []).slice(0, 4),
    actors: (caseFile.actors || []).slice(0, 4).map((actor) => ({
      id: actor.id || '',
      name: actor.name || '',
      category: actor.category || '',
      role: actor.role || '',
      objectives: (actor.objectives || []).slice(0, 2),
      constraints: (actor.constraints || []).slice(0, 2),
      likelyActions: (actor.likelyActions || []).slice(0, 2),
      influenceScore: Number(actor.influenceScore || 0),
    })),
    worldState: caseFile.worldState ? {
      summary: caseFile.worldState.summary || '',
      activePressures: (caseFile.worldState.activePressures || []).slice(0, 3),
      stabilizers: (caseFile.worldState.stabilizers || []).slice(0, 3),
      keyUnknowns: (caseFile.worldState.keyUnknowns || []).slice(0, 3),
    } : null,
    branches: (caseFile.branches || []).slice(0, 3).map((branch) => ({
      kind: branch.kind || '',
      title: branch.title || '',
      summary: branch.summary || '',
      outcome: branch.outcome || '',
      projectedProbability: Number(branch.projectedProbability || 0),
      rounds: (branch.rounds || []).slice(0, 3).map((round) => ({
        round: Number(round.round || 0),
        focus: round.focus || '',
        developments: (round.developments || []).slice(0, 2),
        actorMoves: (round.actorMoves || []).slice(0, 2),
        probabilityShift: Number(round.probabilityShift || 0),
      })),
    })),
  };
}

function buildPublishedForecastPayload(pred) {
  return {
    id: pred.id,
    domain: pred.domain,
    region: pred.region,
    generationOrigin: pred.generationOrigin || 'legacy_detector',
    stateDerivedBackfill: !!pred.stateDerivedBackfill,
    title: pred.title,
    scenario: pred.scenario || '',
    feedSummary: pred.feedSummary || '',
    probability: Number(pred.probability || 0),
    confidence: Number(pred.confidence || 0),
    timeHorizon: pred.timeHorizon || '',
    signals: (pred.signals || []).slice(0, 6).map((signal) => ({
      type: signal.type || '',
      value: signal.value || '',
      weight: Number(signal.weight || 0),
    })),
    cascades: (pred.cascades || []).slice(0, 3).map((cascade) => ({
      domain: cascade.domain || '',
      effect: cascade.effect || '',
      probability: Number(cascade.probability || 0),
    })),
    trend: pred.trend || '',
    priorProbability: pred.priorProbability == null ? 0 : Number(pred.priorProbability),
    calibration: pred.calibration ? {
      marketTitle: pred.calibration.marketTitle || '',
      marketPrice: Number(pred.calibration.marketPrice || 0),
      drift: Number(pred.calibration.drift || 0),
      source: pred.calibration.source || '',
    } : null,
    createdAt: Number(pred.createdAt || 0),
    updatedAt: Number(pred.updatedAt || 0),
    perspectives: pred.perspectives ? {
      strategic: pred.perspectives.strategic || '',
      regional: pred.perspectives.regional || '',
      contrarian: pred.perspectives.contrarian || '',
    } : null,
    projections: pred.projections ? {
      h24: Number(pred.projections.h24 || 0),
      d7: Number(pred.projections.d7 || 0),
      d30: Number(pred.projections.d30 || 0),
    } : null,
    caseFile: slimForecastCaseForPublish(pred.caseFile),
  };
}

function logCanonicalPayloadDiagnostics(predictions) {
  const entries = predictions.map((pred) => {
    const payload = buildPublishedForecastPayload(pred);
    return {
      id: pred.id,
      bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    };
  }).sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
  const totalBytes = entries.reduce((sum, item) => sum + item.bytes, 0);
  const avgBytes = entries.length ? Math.round(totalBytes / entries.length) : 0;
  console.log(`  [Publish] Canonical payload ${(totalBytes / 1024 / 1024).toFixed(2)}MB total (${avgBytes}B avg per forecast)`);
  if (totalBytes > CANONICAL_PAYLOAD_SOFT_LIMIT_BYTES) {
    const topHeaviest = entries.slice(0, 3).map((item) => `${item.id}:${(item.bytes / 1024).toFixed(1)}KB`).join(', ');
    console.warn(`  [Publish] Canonical payload above soft limit ${Math.round(CANONICAL_PAYLOAD_SOFT_LIMIT_BYTES / 1024 / 1024)}MB; heaviest forecasts: ${topHeaviest}`);
  }
}

function buildPublishedSeedPayload(data) {
  const predictions = Array.isArray(data?.predictions) ? data.predictions : [];
  logCanonicalPayloadDiagnostics(predictions);
  return {
    generatedAt: data?.generatedAt || Date.now(),
    predictions: predictions.map(buildPublishedForecastPayload),
  };
}

function buildForecastRunActorRegistry(predictions) {
  const actors = new Map();

  for (const pred of predictions) {
    const structuredActors = pred.caseFile?.actors || buildForecastActors(pred);
    for (const actor of structuredActors) {
      const key = actor.key || `${actor.name}:${actor.category}`;
      if (!actors.has(key)) {
        actors.set(key, {
          id: key,
          name: actor.name,
          category: actor.category || 'general',
          influenceScore: actor.influenceScore || 0,
          domains: new Set(),
          regions: new Set(),
          objectives: new Set(actor.objectives || []),
          constraints: new Set(actor.constraints || []),
          likelyActions: new Set(actor.likelyActions || []),
          forecastIds: new Set(),
        });
      }
      const entry = actors.get(key);
      entry.domains.add(pred.domain);
      entry.regions.add(pred.region);
      entry.forecastIds.add(pred.id);
      for (const value of actor.objectives || []) entry.objectives.add(value);
      for (const value of actor.constraints || []) entry.constraints.add(value);
      for (const value of actor.likelyActions || []) entry.likelyActions.add(value);
      entry.influenceScore = Math.max(entry.influenceScore, actor.influenceScore || 0);
    }
  }

  return [...actors.values()]
    .map((actor) => ({
      id: actor.id,
      name: actor.name,
      category: actor.category,
      influenceScore: +((actor.influenceScore || 0)).toFixed(3),
      domains: [...actor.domains].sort(),
      regions: [...actor.regions].sort(),
      objectives: [...actor.objectives].slice(0, 4),
      constraints: [...actor.constraints].slice(0, 4),
      likelyActions: [...actor.likelyActions].slice(0, 4),
      forecastIds: [...actor.forecastIds].slice(0, 8),
    }))
    .sort((a, b) => b.influenceScore - a.influenceScore || a.name.localeCompare(b.name));
}

function buildActorContinuitySummary(currentActors, priorWorldState = null) {
  const priorActors = Array.isArray(priorWorldState?.actorRegistry) ? priorWorldState.actorRegistry : [];
  const priorById = new Map(priorActors.map(actor => [actor.id, actor]));
  const currentById = new Map(currentActors.map(actor => [actor.id, actor]));

  const newlyActive = [];
  const strengthened = [];
  const weakened = [];

  for (const actor of currentActors) {
    const prev = priorById.get(actor.id);
    if (!prev) {
      newlyActive.push({
        id: actor.id,
        name: actor.name,
        influenceScore: actor.influenceScore,
        domains: actor.domains,
        regions: actor.regions,
      });
      continue;
    }

    const influenceDelta = +((actor.influenceScore || 0) - (prev.influenceScore || 0)).toFixed(3);
    const domainExpansion = actor.domains.filter(domain => !(prev.domains || []).includes(domain));
    const regionExpansion = actor.regions.filter(region => !(prev.regions || []).includes(region));
    const domainContraction = (prev.domains || []).filter(domain => !actor.domains.includes(domain));
    const regionContraction = (prev.regions || []).filter(region => !actor.regions.includes(region));

    if (influenceDelta >= 0.05 || domainExpansion.length > 0 || regionExpansion.length > 0) {
      strengthened.push({
        id: actor.id,
        name: actor.name,
        influenceDelta,
        addedDomains: domainExpansion.slice(0, 4),
        addedRegions: regionExpansion.slice(0, 4),
      });
    } else if (influenceDelta <= -0.05 || domainContraction.length > 0 || regionContraction.length > 0) {
      weakened.push({
        id: actor.id,
        name: actor.name,
        influenceDelta,
        removedDomains: domainContraction.slice(0, 4),
        removedRegions: regionContraction.slice(0, 4),
      });
    }
  }

  const noLongerActive = priorActors
    .filter(actor => !currentById.has(actor.id))
    .map(actor => ({
      id: actor.id,
      name: actor.name,
      influenceScore: actor.influenceScore || 0,
      domains: actor.domains || [],
      regions: actor.regions || [],
    }));

  const persistentCount = currentActors.filter(actor => priorById.has(actor.id)).length;

  return {
    priorActorCount: priorActors.length,
    currentActorCount: currentActors.length,
    persistentCount,
    newlyActiveCount: newlyActive.length,
    strengthenedCount: strengthened.length,
    weakenedCount: weakened.length,
    noLongerActiveCount: noLongerActive.length,
    newlyActivePreview: newlyActive.slice(0, 8),
    strengthenedPreview: strengthened
      .sort((a, b) => b.influenceDelta - a.influenceDelta || a.name.localeCompare(b.name))
      .slice(0, 8),
    weakenedPreview: weakened
      .sort((a, b) => a.influenceDelta - b.influenceDelta || a.name.localeCompare(b.name))
      .slice(0, 8),
    noLongerActivePreview: noLongerActive.slice(0, 8),
  };
}

function buildForecastBranchStates(predictions) {
  const branches = [];

  for (const pred of predictions) {
    const branchList = pred.caseFile?.branches || buildForecastBranches(pred, {
      actors: pred.caseFile?.actors || buildForecastActors(pred),
      triggers: pred.caseFile?.triggers || buildCaseTriggers(pred),
      counterEvidence: pred.caseFile?.counterEvidence || buildCounterEvidence(pred),
      worldState: pred.caseFile?.worldState || buildForecastWorldState(pred),
    });

    for (const branch of branchList) {
      branches.push({
        id: `${pred.id}:${branch.kind}`,
        forecastId: pred.id,
        forecastTitle: pred.title,
        kind: branch.kind,
        title: branch.title,
        domain: pred.domain,
        region: pred.region,
        projectedProbability: +(branch.projectedProbability || 0).toFixed(3),
        baselineProbability: +(pred.probability || 0).toFixed(3),
        probabilityDelta: +((branch.projectedProbability || 0) - (pred.probability || 0)).toFixed(3),
        summary: branch.summary,
        outcome: branch.outcome,
        roundCount: Array.isArray(branch.rounds) ? branch.rounds.length : 0,
        actorIds: (pred.caseFile?.actors || []).map(actor => actor.id).slice(0, 6),
        triggerSample: (pred.caseFile?.triggers || []).slice(0, 3),
        evidenceSample: (pred.caseFile?.supportingEvidence || []).slice(0, 2).map(item => item.summary),
        counterEvidenceSample: (pred.caseFile?.counterEvidence || []).slice(0, 2).map(item => item.summary),
      });
    }
  }

  return branches
    .sort((a, b) => b.projectedProbability - a.projectedProbability || a.id.localeCompare(b.id));
}

function buildBranchContinuitySummary(currentBranchStates, priorWorldState = null) {
  const priorBranchStates = Array.isArray(priorWorldState?.branchStates) ? priorWorldState.branchStates : [];
  const priorById = new Map(priorBranchStates.map(branch => [branch.id, branch]));
  const currentById = new Map(currentBranchStates.map(branch => [branch.id, branch]));

  const newBranches = [];
  const strengthened = [];
  const weakened = [];
  const stable = [];

  for (const branch of currentBranchStates) {
    const prev = priorById.get(branch.id);
    if (!prev) {
      newBranches.push({
        id: branch.id,
        forecastId: branch.forecastId,
        kind: branch.kind,
        title: branch.title,
        projectedProbability: branch.projectedProbability,
      });
      continue;
    }

    const delta = +((branch.projectedProbability || 0) - (prev.projectedProbability || 0)).toFixed(3);
    const actorDelta = branch.actorIds.filter(id => !(prev.actorIds || []).includes(id));
    const triggerDelta = branch.triggerSample.filter(item => !(prev.triggerSample || []).includes(item));

    const record = {
      id: branch.id,
      forecastId: branch.forecastId,
      kind: branch.kind,
      title: branch.title,
      projectedProbability: branch.projectedProbability,
      priorProjectedProbability: +(prev.projectedProbability || 0).toFixed(3),
      probabilityDelta: delta,
      newActorIds: actorDelta.slice(0, 4),
      newTriggers: triggerDelta.slice(0, 3),
    };

    if (delta >= 0.05 || actorDelta.length > 0 || triggerDelta.length > 0) {
      strengthened.push(record);
    } else if (delta <= -0.05) {
      weakened.push(record);
    } else {
      stable.push(record);
    }
  }

  const resolved = priorBranchStates
    .filter(branch => !currentById.has(branch.id))
    .map(branch => ({
      id: branch.id,
      forecastId: branch.forecastId,
      kind: branch.kind,
      title: branch.title,
      projectedProbability: +(branch.projectedProbability || 0).toFixed(3),
    }));

  return {
    priorBranchCount: priorBranchStates.length,
    currentBranchCount: currentBranchStates.length,
    persistentBranchCount: currentBranchStates.filter(branch => priorById.has(branch.id)).length,
    newBranchCount: newBranches.length,
    strengthenedBranchCount: strengthened.length,
    weakenedBranchCount: weakened.length,
    stableBranchCount: stable.length,
    resolvedBranchCount: resolved.length,
    newBranchPreview: newBranches.slice(0, 8),
    strengthenedBranchPreview: strengthened
      .sort((a, b) => b.probabilityDelta - a.probabilityDelta || a.id.localeCompare(b.id))
      .slice(0, 8),
    weakenedBranchPreview: weakened
      .sort((a, b) => a.probabilityDelta - b.probabilityDelta || a.id.localeCompare(b.id))
      .slice(0, 8),
    resolvedBranchPreview: resolved.slice(0, 8),
  };
}

function uniqueSortedStrings(values) {
  return Array.from(new Set((values || []).filter(Boolean).map((value) => String(value)))).sort((a, b) => a.localeCompare(b));
}

function normalizeSituationText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && token.length > 2 && !TEXT_STOPWORDS.has(token));
}

function formatSituationDomainLabel(domains = []) {
  const cleaned = uniqueSortedStrings((domains || []).map((value) => String(value || '').replace(/_/g, ' ').trim()).filter(Boolean));
  if (cleaned.length === 0) return 'cross-domain';
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return 'cross-domain';
}

function formatSituationLabel(cluster) {
  const leadRegion = pickDominantSituationValue(cluster._regionCounts, cluster.regions) || cluster.regions[0] || 'Cross-regional';
  const topDomains = pickDominantSituationValues(cluster._domainCounts, cluster.domains, 2);
  const domainLabel = formatSituationDomainLabel(topDomains.length ? topDomains : cluster.domains);
  return `${leadRegion} ${domainLabel} situation`;
}

function buildSituationReference(situation) {
  if (!situation) return 'broader regional situation';
  return (situation.label || 'broader regional situation').toLowerCase();
}

function hashSituationKey(parts) {
  return crypto.createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 10);
}

function incrementSituationCounts(target, values = []) {
  for (const value of values || []) {
    const key = String(value || '');
    if (!key) continue;
    target[key] = (target[key] || 0) + 1;
  }
}

function pickDominantSituationValue(counts = {}, fallback = []) {
  const entries = Object.entries(counts || {});
  if (!entries.length) return (fallback || [])[0] || '';
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0]?.[0] || (fallback || [])[0] || '';
}

function pickDominantSituationValues(counts = {}, fallback = [], maxValues = 2) {
  const entries = Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return (fallback || []).slice(0, maxValues);
  const leadCount = entries[0]?.[1] || 0;
  return entries
    .filter(([, count], index) => index === 0 || count >= Math.max(1, Math.ceil(leadCount * 0.5)))
    .slice(0, maxValues)
    .map(([value]) => value);
}

const FAMILY_GENERIC_TOKENS = new Set([
  'situation',
  'family',
  'pressure',
  'risk',
  'active',
  'broader',
  'regional',
  'global',
  'world',
  'forecast',
  'forecasts',
  'driver',
  'drivers',
  'impact',
  'effects',
  'effect',
  'outlook',
  'path',
  'paths',
  'signal',
  'signals',
  'repricing',
  'price',
  'pricing',
  'disruption',
  'disruptions',
  'conflict',
  'political',
  'market',
  'supply',
  'chain',
  'infrastructure',
  'cyber',
  'military',
]);

const REGION_LINK_NOISE_TOKENS = new Set([
  'north',
  'northern',
  'south',
  'southern',
  'east',
  'eastern',
  'west',
  'western',
  'central',
  'upper',
  'lower',
  'region',
  'regional',
  'area',
  'areas',
  'zone',
  'zones',
  'coast',
  'coastal',
]);

function filterSpecificSituationTokens(tokens = []) {
  return uniqueSortedStrings((tokens || []).filter((token) => (
    token
    && token.length >= 4
    && !FAMILY_GENERIC_TOKENS.has(token)
  )));
}

function extractRegionLinkTokens(values = []) {
  return uniqueSortedStrings((values || [])
    .flatMap((value) => normalizeSituationText(value))
    .filter((token) => token.length >= 3 && !REGION_LINK_NOISE_TOKENS.has(token)));
}

function buildSituationCandidate(prediction) {
  const regions = uniqueSortedStrings([prediction.region, ...(prediction.caseFile?.regions || [])]);
  const tokens = uniqueSortedStrings([
    ...normalizeSituationText(prediction.title),
    ...normalizeSituationText(prediction.feedSummary),
    ...(prediction.caseFile?.supportingEvidence || []).flatMap((item) => normalizeSituationText(item?.summary)),
    ...(prediction.signals || []).flatMap((signal) => normalizeSituationText(signal?.value)),
    ...(prediction.newsContext || []).flatMap((headline) => normalizeSituationText(headline)),
  ]).slice(0, 24);
  const specificTokens = filterSpecificSituationTokens(tokens).slice(0, 18);
  return {
    prediction,
    regions,
    macroRegions: getPredictionMacroRegions(prediction, regions),
    domains: uniqueSortedStrings([prediction.domain, ...(prediction.caseFile?.domains || [])]),
    actors: uniqueSortedStrings((prediction.caseFile?.actors || []).map((actor) => actor.name || actor.id).filter(Boolean)),
    branchKinds: uniqueSortedStrings((prediction.caseFile?.branches || []).map((branch) => branch.kind).filter(Boolean)),
    tokens,
    specificTokens,
    signalTypes: uniqueSortedStrings((prediction.signals || []).map((signal) => signal?.type).filter(Boolean)),
    marketBucketIds: getPredictionMarketBucketIds(prediction),
    transmissionChannels: getPredictionTransmissionChannels(prediction),
    sourceStateIds: getPredictionSourceStateIds(prediction),
  };
}

function computeSituationOverlap(candidate, cluster) {
  const overlapCount = (left, right) => left.filter((item) => right.includes(item)).length;
  return (
    overlapCount(candidate.regions, cluster.regions) * 4 +
    overlapCount(candidate.macroRegions, cluster.macroRegions || []) * 2.4 +
    overlapCount(candidate.domains, cluster.domains) * 2 +
    overlapCount(candidate.signalTypes, cluster.signalTypes) * 1.5 +
    overlapCount(candidate.marketBucketIds, cluster.marketBucketIds || []) * 2.4 +
    overlapCount(candidate.transmissionChannels, cluster.transmissionChannels || []) * 1.6 +
    overlapCount(candidate.sourceStateIds, cluster.sourceStateIds || []) * 6 +
    overlapCount(candidate.specificTokens, cluster.specificTokens || []) * 0.9 +
    overlapCount(candidate.tokens, cluster.tokens) * 0.35 +
    overlapCount(candidate.actors, cluster.actors) * 0.5 +
    overlapCount(candidate.branchKinds, cluster.branchKinds) * 0.25
  );
}

function shouldMergeSituationCandidate(candidate, cluster, score) {
  if (score < 3) return false;

  const regionOverlap = intersectCount(candidate.regions, cluster.regions);
  const actorOverlap = intersectCount(candidate.actors, cluster.actors);
  const domainOverlap = intersectCount(candidate.domains, cluster.domains);
  const branchOverlap = intersectCount(candidate.branchKinds, cluster.branchKinds);
  const tokenOverlap = intersectCount(candidate.tokens, cluster.tokens);
  const specificTokenOverlap = intersectCount(candidate.specificTokens, cluster.specificTokens || []);
  const signalOverlap = intersectCount(candidate.signalTypes, cluster.signalTypes);
  const macroOverlap = intersectCount(candidate.macroRegions, cluster.macroRegions || []);
  const bucketOverlap = intersectCount(candidate.marketBucketIds, cluster.marketBucketIds || []);
  const channelOverlap = intersectCount(candidate.transmissionChannels, cluster.transmissionChannels || []);
  const sourceStateOverlap = intersectCount(candidate.sourceStateIds, cluster.sourceStateIds || []);
  const dominantDomain = pickDominantSituationValue(cluster._domainCounts, cluster.domains);
  const candidateDomain = candidate.prediction?.domain || candidate.domains[0] || '';
  const sameDomain = domainOverlap > 0 && (!dominantDomain || dominantDomain === candidateDomain);
  const isRegionalLogistics = MARKET_CLUSTER_DOMAINS.has(candidateDomain) || isMarketLikeDomains(cluster.domains);

  if (isRegionalLogistics) {
    if (sourceStateOverlap > 0) return true;
    if (candidate.sourceStateIds.length > 0 && (cluster.sourceStateIds || []).length > 0 && sourceStateOverlap === 0) {
      return false;
    }
    if (regionOverlap === 0 && macroOverlap === 0) return false;
    if (bucketOverlap === 0) return false;
    if (regionOverlap > 0 && (channelOverlap > 0 || signalOverlap > 0 || specificTokenOverlap >= 1)) return true;
    if (macroOverlap > 0 && bucketOverlap > 0 && (channelOverlap > 0 || signalOverlap >= 2 || specificTokenOverlap >= 2)) return true;
    if (signalOverlap >= 2 && specificTokenOverlap >= 2 && channelOverlap > 0) return true;
    return false;
  }

  if (regionOverlap > 0) {
    if (signalOverlap > 0 || tokenOverlap >= 2 || sameDomain) return true;
    return false;
  }
  if (!sameDomain) return false;
  if (signalOverlap >= 2 && tokenOverlap >= 4) return true;
  if (signalOverlap >= 1 && tokenOverlap >= 5 && actorOverlap > 0) return true;
  if (branchOverlap > 0 && signalOverlap >= 2 && tokenOverlap >= 4) return true;
  return false;
}

function finalizeSituationCluster(cluster) {
  const avgProbability = cluster._probabilityTotal / Math.max(1, cluster.forecastCount);
  const avgConfidence = cluster._confidenceTotal / Math.max(1, cluster.forecastCount);
  const dominantRegion = pickDominantSituationValue(cluster._regionCounts, cluster.regions);
  const dominantDomain = pickDominantSituationValue(cluster._domainCounts, cluster.domains);
  const topSignals = Object.entries(cluster._signalCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([type, count]) => ({ type, count }));
  const stableKey = isMarketLikeDomains(cluster.domains)
    ? [
        ...(cluster.sourceStateIds || []).slice(0, 2),
        ...(cluster.marketBucketIds || []).slice(0, 2),
        ...(cluster.macroRegions || []).slice(0, 2),
        ...cluster.regions.slice(0, 1),
      ]
    : [
        ...cluster.regions.slice(0, 2),
        ...cluster.actors.slice(0, 2),
        ...cluster.domains.slice(0, 2),
      ];

  return {
    id: `sit-${hashSituationKey(stableKey)}`,
    stableKey,
    label: formatSituationLabel(cluster),
    forecastCount: cluster.forecastCount,
    forecastIds: cluster.forecastIds.slice(0, 12),
    dominantRegion,
    dominantDomain,
    regions: cluster.regions,
    domains: cluster.domains,
    actors: cluster.actors,
    branchKinds: cluster.branchKinds,
    macroRegions: cluster.macroRegions || [],
    marketBucketIds: cluster.marketBucketIds || [],
    transmissionChannels: cluster.transmissionChannels || [],
    sourceStateIds: cluster.sourceStateIds || [],
    specificTokens: cluster.specificTokens || [],
    avgProbability: +avgProbability.toFixed(3),
    avgConfidence: +avgConfidence.toFixed(3),
    topSignals,
    sampleTitles: cluster.sampleTitles.slice(0, 6),
  };
}

function computeSituationSimilarity(currentCluster, priorCluster) {
  const overlapCount = (left, right) => left.filter((item) => right.includes(item)).length;
  return (
    overlapCount(currentCluster.regions || [], priorCluster.regions || []) * 3 +
    overlapCount(currentCluster.actors || [], priorCluster.actors || []) * 2 +
    overlapCount(currentCluster.domains || [], priorCluster.domains || []) * 1.5 +
    overlapCount(currentCluster.branchKinds || [], priorCluster.branchKinds || []) * 1 +
    overlapCount(currentCluster.forecastIds || [], priorCluster.forecastIds || []) * 0.5
  );
}
function buildSituationClusters(predictions) {
  const clusters = [];

  for (const prediction of predictions) {
    const candidate = buildSituationCandidate(prediction);
    let bestCluster = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const score = computeSituationOverlap(candidate, cluster);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    if (!bestCluster || !shouldMergeSituationCandidate(candidate, bestCluster, bestScore)) {
      bestCluster = {
        regions: [],
        macroRegions: [],
        domains: [],
        actors: [],
        branchKinds: [],
        tokens: [],
        specificTokens: [],
        signalTypes: [],
        marketBucketIds: [],
        transmissionChannels: [],
        sourceStateIds: [],
        forecastIds: [],
        sampleTitles: [],
        forecastCount: 0,
        _probabilityTotal: 0,
        _confidenceTotal: 0,
        _signalCounts: {},
        _regionCounts: {},
        _domainCounts: {},
      };
      clusters.push(bestCluster);
    }

    bestCluster.regions = uniqueSortedStrings([...bestCluster.regions, ...candidate.regions]);
    bestCluster.macroRegions = uniqueSortedStrings([...bestCluster.macroRegions, ...candidate.macroRegions]);
    bestCluster.domains = uniqueSortedStrings([...bestCluster.domains, ...candidate.domains]);
    bestCluster.actors = uniqueSortedStrings([...bestCluster.actors, ...candidate.actors]);
    bestCluster.branchKinds = uniqueSortedStrings([...bestCluster.branchKinds, ...candidate.branchKinds]);
    bestCluster.tokens = uniqueSortedStrings([...bestCluster.tokens, ...candidate.tokens]).slice(0, 28);
    bestCluster.specificTokens = uniqueSortedStrings([...bestCluster.specificTokens, ...candidate.specificTokens]).slice(0, 20);
    bestCluster.signalTypes = uniqueSortedStrings([...bestCluster.signalTypes, ...candidate.signalTypes]);
    bestCluster.marketBucketIds = uniqueSortedStrings([...bestCluster.marketBucketIds, ...candidate.marketBucketIds]);
    bestCluster.transmissionChannels = uniqueSortedStrings([...bestCluster.transmissionChannels, ...candidate.transmissionChannels]);
    bestCluster.sourceStateIds = uniqueSortedStrings([...bestCluster.sourceStateIds, ...candidate.sourceStateIds]);
    bestCluster.forecastIds.push(prediction.id);
    bestCluster.sampleTitles.push(prediction.title);
    bestCluster.forecastCount += 1;
    bestCluster._probabilityTotal += Number(prediction.probability || 0);
    bestCluster._confidenceTotal += Number(prediction.confidence || 0);
    incrementSituationCounts(bestCluster._regionCounts, candidate.regions);
    incrementSituationCounts(bestCluster._domainCounts, candidate.domains);

    for (const signal of prediction.signals || []) {
      const type = signal?.type || 'unknown';
      bestCluster._signalCounts[type] = (bestCluster._signalCounts[type] || 0) + 1;
    }
  }

  return clusters
    .map(finalizeSituationCluster)
    .sort((a, b) => b.forecastCount - a.forecastCount || b.avgProbability - a.avgProbability);
}

function formatSituationFamilyLabel(family) {
  const regionEntries = Object.entries(family._regionCounts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const leadCount = regionEntries[0]?.[1] || 0;
  const secondCount = regionEntries[1]?.[1] || 0;
  const totalSituations = Math.max(1, family.situationIds?.length || 0);
  const hasClearLeadRegion = leadCount > 0 && leadCount >= Math.ceil(totalSituations * 0.5) && leadCount > secondCount;
  const leadRegion = hasClearLeadRegion
    ? (family.dominantRegion || family.regions?.[0] || 'Cross-regional')
    : 'Cross-regional';
  const archetypeLabelMap = {
    war_theater: 'war theater',
    political_instability: 'political instability',
    maritime_supply: 'maritime supply pressure',
    cyber_pressure: 'cyber pressure',
    infrastructure_fragility: 'infrastructure pressure',
    market_repricing: 'market repricing',
    mixed_regional: 'cross-domain pressure',
  };
  const archetypeLabel = archetypeLabelMap[family.archetype] || 'cross-domain pressure';
  return `${leadRegion} ${archetypeLabel} family`;
}

function inferSituationFamilyArchetype(input = {}) {
  const domains = uniqueSortedStrings([input.dominantDomain, ...(input.domains || [])].filter(Boolean));
  const signals = uniqueSortedStrings((input.signalTypes || []).filter(Boolean));
  const tokens = uniqueSortedStrings([...(input.tokens || []), ...(input.specificTokens || [])].filter(Boolean));
  const hasMaritimeSignal = signals.some((item) => ['chokepoint', 'gps_jamming'].includes(item));
  const hasStrongMaritimeToken = tokens.some((token) => ['shipping', 'freight', 'maritime', 'logistics', 'vessel', 'rerouting'].includes(token));
  const hasRouteToken = tokens.some((token) => ['port', 'corridor', 'transit', 'route', 'strait', 'sea'].includes(token));

  if (domains.includes('conflict') || domains.includes('military')) return 'war_theater';
  if (domains.includes('cyber')) return 'cyber_pressure';
  if (domains.includes('infrastructure')) return 'infrastructure_fragility';
  if (domains.includes('supply_chain') || hasMaritimeSignal || (hasStrongMaritimeToken && hasRouteToken)) {
    return 'maritime_supply';
  }
  if (domains.includes('political')) return 'political_instability';
  if (domains.includes('market')) return 'market_repricing';
  return 'mixed_regional';
}

function buildSituationFamilyCandidate(cluster) {
  const tokens = uniqueSortedStrings([
    ...normalizeSituationText(cluster.label),
    ...((cluster.sampleTitles || []).flatMap((title) => normalizeSituationText(title))),
  ]);
  return {
    cluster,
    regions: uniqueSortedStrings([cluster.dominantRegion, ...(cluster.regions || [])].filter(Boolean)),
    macroRegions: uniqueSortedStrings(cluster.macroRegions || []),
    domains: uniqueSortedStrings([cluster.dominantDomain, ...(cluster.domains || [])].filter(Boolean)),
    actors: uniqueSortedStrings(cluster.actors || []),
    tokens: tokens.filter((token) => !['situation', 'family', 'pressure'].includes(token)).slice(0, 28),
    specificTokens: filterSpecificSituationTokens(tokens).slice(0, 20),
    regionTokens: extractRegionLinkTokens([cluster.dominantRegion, ...(cluster.regions || [])]).slice(0, 8),
    signalTypes: uniqueSortedStrings((cluster.topSignals || []).map((signal) => signal.type).filter(Boolean)),
    marketBucketIds: uniqueSortedStrings(cluster.marketBucketIds || []),
    transmissionChannels: uniqueSortedStrings(cluster.transmissionChannels || []),
    sourceStateIds: uniqueSortedStrings(cluster.sourceStateIds || []),
    archetype: inferSituationFamilyArchetype({
      dominantDomain: cluster.dominantDomain,
      domains: cluster.domains,
      signalTypes: (cluster.topSignals || []).map((signal) => signal.type),
      tokens,
    }),
  };
}

function computeSituationFamilyOverlap(candidate, family) {
  return (
    intersectCount(candidate.regions, family.regions) * 4 +
    intersectCount(candidate.macroRegions, family.macroRegions || []) * 2.4 +
    intersectCount(candidate.actors, family.actors) * 2 +
    intersectCount(candidate.domains, family.domains) * 1.5 +
    intersectCount(candidate.signalTypes, family.signalTypes) * 1.2 +
    intersectCount(candidate.marketBucketIds, family.marketBucketIds || []) * 2.2 +
    intersectCount(candidate.transmissionChannels, family.transmissionChannels || []) * 1.5 +
    intersectCount(candidate.sourceStateIds, family.sourceStateIds || []) * 6 +
    intersectCount(candidate.specificTokens, family.specificTokens) * 1.1 +
    intersectCount(candidate.regionTokens, family.regionTokens) * 0.8 +
    intersectCount(candidate.tokens, family.tokens) * 0.25 +
    (candidate.archetype && family.archetype && candidate.archetype === family.archetype ? 1.4 : 0)
  );
}

function shouldMergeSituationFamilyCandidate(candidate, family, score) {
  if (score < 4.5) return false;

  const regionOverlap = intersectCount(candidate.regions, family.regions);
  const actorOverlap = intersectCount(candidate.actors, family.actors);
  const domainOverlap = intersectCount(candidate.domains, family.domains);
  const signalOverlap = intersectCount(candidate.signalTypes, family.signalTypes);
  const specificTokenOverlap = intersectCount(candidate.specificTokens, family.specificTokens);
  const regionTokenOverlap = intersectCount(candidate.regionTokens, family.regionTokens);
  const macroOverlap = intersectCount(candidate.macroRegions, family.macroRegions || []);
  const bucketOverlap = intersectCount(candidate.marketBucketIds, family.marketBucketIds || []);
  const channelOverlap = intersectCount(candidate.transmissionChannels, family.transmissionChannels || []);
  const sourceStateOverlap = intersectCount(candidate.sourceStateIds, family.sourceStateIds || []);
  const archetypeMatch = candidate.archetype && family.archetype && candidate.archetype === family.archetype;
  const marketLike = isMarketLikeDomains(candidate.domains) || isMarketLikeDomains(family.domains);

  if (marketLike) {
    if (sourceStateOverlap > 0) return true;
    if (candidate.sourceStateIds.length > 0 && (family.sourceStateIds || []).length > 0 && sourceStateOverlap === 0) return false;
    if (regionOverlap === 0 && macroOverlap === 0) return false;
    if (bucketOverlap === 0) return false;
    if (archetypeMatch && (channelOverlap > 0 || specificTokenOverlap > 0 || regionOverlap > 0)) return true;
    if (regionOverlap > 0 && signalOverlap > 0 && bucketOverlap > 0) return true;
    return false;
  }

  if (regionOverlap > 0 && archetypeMatch && (domainOverlap > 0 || signalOverlap > 0 || specificTokenOverlap > 0)) return true;
  if (actorOverlap > 0 && archetypeMatch && (domainOverlap > 0 || specificTokenOverlap > 0)) return true;
  if (regionOverlap > 0 && actorOverlap > 0 && (specificTokenOverlap > 0 || signalOverlap > 0)) return true;
  if (domainOverlap > 0 && archetypeMatch && signalOverlap >= 2 && specificTokenOverlap >= 2 && regionTokenOverlap > 0) return true;
  return false;
}

function finalizeSituationFamily(family) {
  const dominantRegion = pickDominantSituationValue(family._regionCounts, family.regions);
  const dominantDomain = pickDominantSituationValue(family._domainCounts, family.domains);
  const archetype = family.archetype || inferSituationFamilyArchetype({
    dominantDomain,
    domains: family.domains,
    signalTypes: family.signalTypes,
    tokens: family.tokens,
    specificTokens: family.specificTokens,
  });
  const stableKey = [
    archetype,
    ...family.regions.slice(0, 2),
    ...family.actors.slice(0, 2),
    ...family.domains.slice(0, 2),
  ];

  return {
    id: `fam-${hashSituationKey(stableKey)}`,
    label: formatSituationFamilyLabel({
      ...family,
      dominantRegion,
      dominantDomain,
      archetype,
    }),
    archetype,
    dominantRegion,
    dominantDomain,
    regions: family.regions,
    macroRegions: family.macroRegions || [],
    domains: family.domains,
    actors: family.actors,
    signalTypes: family.signalTypes,
    marketBucketIds: family.marketBucketIds || [],
    transmissionChannels: family.transmissionChannels || [],
    sourceStateIds: family.sourceStateIds || [],
    tokens: family.tokens,
    situationCount: family.situationIds.length,
    forecastCount: family.forecastCount,
    situationIds: family.situationIds,
    avgProbability: +(family._probabilityTotal / Math.max(1, family.situationIds.length)).toFixed(3),
  };
}

function buildSituationFamilies(situationClusters = []) {
  const families = [];
  const orderedClusters = [...(situationClusters || [])].sort((a, b) => (
    (a.dominantRegion || '').localeCompare(b.dominantRegion || '')
    || (a.dominantDomain || '').localeCompare(b.dominantDomain || '')
    || a.label.localeCompare(b.label)
    || a.id.localeCompare(b.id)
  ));

  for (const cluster of orderedClusters) {
    const candidate = buildSituationFamilyCandidate(cluster);
    let bestFamily = null;
    let bestScore = 0;

    for (const family of families) {
      const score = computeSituationFamilyOverlap(candidate, family);
      if (score > bestScore) {
        bestScore = score;
        bestFamily = family;
      }
    }

    if (!bestFamily || !shouldMergeSituationFamilyCandidate(candidate, bestFamily, bestScore)) {
      bestFamily = {
        regions: [],
        macroRegions: [],
        domains: [],
        actors: [],
        signalTypes: [],
        tokens: [],
        specificTokens: [],
        regionTokens: [],
        marketBucketIds: [],
        transmissionChannels: [],
        sourceStateIds: [],
        situationIds: [],
        forecastCount: 0,
        _probabilityTotal: 0,
        _regionCounts: {},
        _domainCounts: {},
        archetype: candidate.archetype,
      };
      families.push(bestFamily);
    }

    bestFamily.regions = uniqueSortedStrings([...bestFamily.regions, ...candidate.regions]);
    bestFamily.macroRegions = uniqueSortedStrings([...bestFamily.macroRegions, ...candidate.macroRegions]);
    bestFamily.domains = uniqueSortedStrings([...bestFamily.domains, ...candidate.domains]);
    bestFamily.actors = uniqueSortedStrings([...bestFamily.actors, ...candidate.actors]);
    bestFamily.signalTypes = uniqueSortedStrings([...bestFamily.signalTypes, ...candidate.signalTypes]);
    bestFamily.tokens = uniqueSortedStrings([...bestFamily.tokens, ...candidate.tokens]).slice(0, 32);
    bestFamily.specificTokens = uniqueSortedStrings([...bestFamily.specificTokens, ...(candidate.specificTokens || [])]).slice(0, 24);
    bestFamily.regionTokens = uniqueSortedStrings([...bestFamily.regionTokens, ...(candidate.regionTokens || [])]).slice(0, 12);
    bestFamily.marketBucketIds = uniqueSortedStrings([...bestFamily.marketBucketIds, ...(candidate.marketBucketIds || [])]);
    bestFamily.transmissionChannels = uniqueSortedStrings([...bestFamily.transmissionChannels, ...(candidate.transmissionChannels || [])]);
    bestFamily.sourceStateIds = uniqueSortedStrings([...bestFamily.sourceStateIds, ...(candidate.sourceStateIds || [])]);
    bestFamily.situationIds.push(cluster.id);
    bestFamily.forecastCount += cluster.forecastCount || 0;
    bestFamily._probabilityTotal += Number(cluster.avgProbability || 0);
    incrementSituationCounts(bestFamily._regionCounts, candidate.regions);
    incrementSituationCounts(bestFamily._domainCounts, candidate.domains);
    if (!bestFamily.archetype) bestFamily.archetype = candidate.archetype;
  }

  return families
    .map(finalizeSituationFamily)
    .sort((a, b) => b.forecastCount - a.forecastCount || b.avgProbability - a.avgProbability);
}

const SIMULATION_STATE_KIND_LABELS = {
  security_escalation: 'security escalation state',
  political_instability: 'political instability state',
  governance_pressure: 'governance pressure state',
  maritime_disruption: 'maritime disruption state',
  cyber_pressure: 'cyber pressure state',
  infrastructure_fragility: 'infrastructure fragility state',
  market_repricing: 'market repricing state',
  cross_domain_pressure: 'cross-domain pressure state',
};

const STATE_KIND_FALLBACK_DOMAINS = {
  security_escalation: 'conflict',
  political_instability: 'political',
  governance_pressure: 'political',
  maritime_disruption: 'supply_chain',
  cyber_pressure: 'cyber',
  infrastructure_fragility: 'infrastructure',
  market_repricing: 'market',
  cross_domain_pressure: '',
};

function classifySimulationStateKind(cluster, family = null) {
  const dominantDomain = family?.dominantDomain || cluster?.dominantDomain || cluster?.domains?.[0] || '';
  const archetype = family?.archetype || '';
  const signalTypes = uniqueSortedStrings((cluster?.topSignals || []).map((signal) => signal.type).filter(Boolean));

  if (archetype === 'war_theater' || ['conflict', 'military'].includes(dominantDomain)) return 'security_escalation';
  if (archetype === 'maritime_supply' || dominantDomain === 'supply_chain') return 'maritime_disruption';
  if (archetype === 'cyber_pressure' || dominantDomain === 'cyber') return 'cyber_pressure';
  if (archetype === 'infrastructure_fragility' || dominantDomain === 'infrastructure') return 'infrastructure_fragility';
  if (archetype === 'market_repricing' || dominantDomain === 'market') return 'market_repricing';
  if (archetype === 'political_instability' || dominantDomain === 'political') {
    if (signalTypes.some((type) => ['unrest', 'unrest_events', 'election', 'sanctions'].includes(type))) {
      return 'political_instability';
    }
    return 'governance_pressure';
  }
  return 'cross_domain_pressure';
}

function formatStateUnitLabel(unit) {
  const regionEntries = Object.entries(unit._regionCounts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const leadRegion = regionEntries[0]?.[0] || unit.dominantRegion || unit.regions?.[0] || 'Cross-regional';
  const label = SIMULATION_STATE_KIND_LABELS[unit.stateKind] || SIMULATION_STATE_KIND_LABELS.cross_domain_pressure;
  return `${leadRegion} ${label}`;
}

function buildStateUnitCandidate(cluster, family = null) {
  const tokens = uniqueSortedStrings([
    ...normalizeSituationText(cluster.label),
    ...((cluster.sampleTitles || []).flatMap((title) => normalizeSituationText(title))),
    ...normalizeSituationText(family?.label),
  ]);
  return {
    cluster,
    family,
    familyId: family?.id || '',
    familyLabel: family?.label || '',
    familyArchetype: family?.archetype || '',
    stateKind: classifySimulationStateKind(cluster, family),
    regions: uniqueSortedStrings([cluster.dominantRegion, ...(cluster.regions || [])].filter(Boolean)),
    macroRegions: uniqueSortedStrings([
      ...(cluster.macroRegions || []),
      ...(family?.macroRegions || []),
    ]),
    domains: uniqueSortedStrings([cluster.dominantDomain, ...(cluster.domains || [])].filter(Boolean)),
    actors: uniqueSortedStrings(cluster.actors || []),
    branchKinds: uniqueSortedStrings(cluster.branchKinds || []),
    signalTypes: uniqueSortedStrings((cluster.topSignals || []).map((signal) => signal.type).filter(Boolean)),
    marketBucketIds: uniqueSortedStrings([
      ...(cluster.marketBucketIds || []),
      ...(family?.marketBucketIds || []),
    ]),
    transmissionChannels: uniqueSortedStrings([
      ...(cluster.transmissionChannels || []),
      ...(family?.transmissionChannels || []),
    ]),
    sourceStateIds: uniqueSortedStrings([
      ...(cluster.sourceStateIds || []),
      ...(family?.sourceStateIds || []),
    ]),
    tokens: tokens.slice(0, 28),
    specificTokens: filterSpecificSituationTokens(tokens).slice(0, 20),
    sourceSituationIds: [cluster.id],
    forecastIds: cluster.forecastIds || [],
  };
}

function computeStateUnitOverlap(candidate, unit) {
  return (
    (candidate.familyId && unit.familyId && candidate.familyId === unit.familyId ? 4 : 0) +
    (candidate.stateKind && unit.stateKind && candidate.stateKind === unit.stateKind ? 2.5 : 0) +
    (candidate.familyArchetype && unit.familyArchetype && candidate.familyArchetype === unit.familyArchetype ? 1.5 : 0) +
    (intersectCount(candidate.regions, unit.regions) * 2.5) +
    (intersectCount(candidate.macroRegions, unit.macroRegions || []) * 2) +
    (intersectCount(candidate.actors, unit.actors) * 1.8) +
    (intersectCount(candidate.domains, unit.domains) * 1.3) +
    (intersectCount(candidate.signalTypes, unit.signalTypes) * 1.1) +
    (intersectCount(candidate.marketBucketIds, unit.marketBucketIds || []) * 2.4) +
    (intersectCount(candidate.transmissionChannels, unit.transmissionChannels || []) * 1.5) +
    (intersectCount(candidate.sourceStateIds, unit.sourceStateIds || []) * 6) +
    (intersectCount(candidate.specificTokens, unit.specificTokens) * 0.8) +
    (intersectCount(candidate.tokens, unit.tokens) * 0.25)
  );
}

function shouldMergeStateUnitCandidate(candidate, unit, score) {
  if (score < 5.5) return false;

  const sameFamily = candidate.familyId && unit.familyId && candidate.familyId === unit.familyId;
  const sameKind = candidate.stateKind === unit.stateKind;
  const regionOverlap = intersectCount(candidate.regions, unit.regions);
  const actorOverlap = intersectCount(candidate.actors, unit.actors);
  const domainOverlap = intersectCount(candidate.domains, unit.domains);
  const signalOverlap = intersectCount(candidate.signalTypes, unit.signalTypes);
  const specificTokenOverlap = intersectCount(candidate.specificTokens, unit.specificTokens);
  const macroOverlap = intersectCount(candidate.macroRegions, unit.macroRegions || []);
  const bucketOverlap = intersectCount(candidate.marketBucketIds, unit.marketBucketIds || []);
  const channelOverlap = intersectCount(candidate.transmissionChannels, unit.transmissionChannels || []);
  const sourceStateOverlap = intersectCount(candidate.sourceStateIds, unit.sourceStateIds || []);
  const marketLike = isMarketLikeDomains(candidate.domains) || isMarketLikeDomains(unit.domains);

  if (marketLike) {
    if (sourceStateOverlap > 0) return true;
    if (candidate.sourceStateIds.length > 0 && (unit.sourceStateIds || []).length > 0 && sourceStateOverlap === 0) return false;
    if (regionOverlap === 0 && macroOverlap === 0) return false;
    if (bucketOverlap === 0) return false;
    if (sameFamily && sameKind && (channelOverlap > 0 || signalOverlap > 0 || specificTokenOverlap > 0 || regionOverlap > 0)) return true;
    if (sameKind && macroOverlap > 0 && bucketOverlap > 0 && (channelOverlap > 0 || signalOverlap > 0 || specificTokenOverlap >= 2)) return true;
    return false;
  }

  if (sameFamily && sameKind && (signalOverlap > 0 || actorOverlap > 0 || regionOverlap > 0 || specificTokenOverlap > 0)) return true;
  if (!sameKind) return false;
  if (regionOverlap > 0 && (actorOverlap > 0 || signalOverlap > 0 || specificTokenOverlap >= 2)) return true;
  if (actorOverlap > 0 && domainOverlap > 0 && (signalOverlap > 0 || specificTokenOverlap >= 2)) return true;
  return false;
}

function finalizeStateUnit(unit) {
  const forecastCount = unit.forecastIds.length;
  const avgProbability = unit._probabilityTotal / Math.max(1, forecastCount);
  const avgConfidence = unit._confidenceTotal / Math.max(1, forecastCount);
  const dominantRegion = pickDominantSituationValue(unit._regionCounts, unit.regions);
  const dominantDomain = pickDominantSituationValue(
    unit._dominantDomainCounts,
    [STATE_KIND_FALLBACK_DOMAINS[unit.stateKind], ...unit.domains].filter(Boolean),
  );
  const topSignals = Object.entries(unit._signalCounts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([type, count]) => ({ type, count }));
  const stableKey = [
    unit.familyId || unit.stateKind,
    unit.stateKind,
    ...(unit.sourceStateIds || []).slice(0, 2),
    ...(unit.marketBucketIds || []).slice(0, 2),
    ...unit.regions.slice(0, 2),
    ...unit.actors.slice(0, 2),
    ...unit.domains.slice(0, 2),
  ];

  return {
    id: `state-${hashSituationKey(stableKey)}`,
    label: formatStateUnitLabel({
      ...unit,
      dominantRegion,
    }),
    stateKind: unit.stateKind,
    familyId: unit.familyId,
    familyLabel: unit.familyLabel,
    familyArchetype: unit.familyArchetype,
    dominantRegion,
    dominantDomain,
    regions: unit.regions,
    macroRegions: unit.macroRegions || [],
    domains: unit.domains,
    actors: unit.actors,
    branchKinds: unit.branchKinds,
    signalTypes: unit.signalTypes,
    marketBucketIds: unit.marketBucketIds || [],
    transmissionChannels: unit.transmissionChannels || [],
    sourceStateIds: unit.sourceStateIds || [],
    sourceSituationIds: unit.sourceSituationIds,
    situationIds: unit.sourceSituationIds,
    situationCount: unit.sourceSituationIds.length,
    forecastIds: unit.forecastIds.slice(0, 16),
    forecastCount,
    avgProbability: +avgProbability.toFixed(3),
    avgConfidence: +avgConfidence.toFixed(3),
    topSignals,
    sampleTitles: unit.sampleTitles.slice(0, 6),
  };
}

function buildCanonicalStateUnits(situationClusters = [], situationFamilies = []) {
  const familyIndex = buildSituationFamilyIndex(situationFamilies);
  const units = [];
  const orderedClusters = [...(situationClusters || [])].sort((a, b) => (
    (familyIndex.get(a.id)?.label || '').localeCompare(familyIndex.get(b.id)?.label || '')
    || (a.dominantRegion || '').localeCompare(b.dominantRegion || '')
    || (a.dominantDomain || '').localeCompare(b.dominantDomain || '')
    || a.label.localeCompare(b.label)
  ));

  for (const cluster of orderedClusters) {
    const family = familyIndex.get(cluster.id) || null;
    const candidate = buildStateUnitCandidate(cluster, family);
    let bestUnit = null;
    let bestScore = 0;

    for (const unit of units) {
      const score = computeStateUnitOverlap(candidate, unit);
      if (score > bestScore) {
        bestScore = score;
        bestUnit = unit;
      }
    }

    if (!bestUnit || !shouldMergeStateUnitCandidate(candidate, bestUnit, bestScore)) {
      bestUnit = {
        familyId: candidate.familyId,
        familyLabel: candidate.familyLabel,
        familyArchetype: candidate.familyArchetype,
        stateKind: candidate.stateKind,
        regions: [],
        macroRegions: [],
        domains: [],
        actors: [],
        branchKinds: [],
        signalTypes: [],
        marketBucketIds: [],
        transmissionChannels: [],
        sourceStateIds: [],
        tokens: [],
        specificTokens: [],
        sourceSituationIds: [],
        forecastIds: [],
        sampleTitles: [],
        _probabilityTotal: 0,
        _confidenceTotal: 0,
        _regionCounts: {},
        _domainCounts: {},
        _dominantDomainCounts: {},
        _signalCounts: {},
      };
      units.push(bestUnit);
    }

    bestUnit.regions = uniqueSortedStrings([...bestUnit.regions, ...candidate.regions]);
    bestUnit.macroRegions = uniqueSortedStrings([...bestUnit.macroRegions, ...candidate.macroRegions]);
    bestUnit.domains = uniqueSortedStrings([...bestUnit.domains, ...candidate.domains]);
    bestUnit.actors = uniqueSortedStrings([...bestUnit.actors, ...candidate.actors]);
    bestUnit.branchKinds = uniqueSortedStrings([...bestUnit.branchKinds, ...candidate.branchKinds]);
    bestUnit.signalTypes = uniqueSortedStrings([...bestUnit.signalTypes, ...candidate.signalTypes]);
    bestUnit.marketBucketIds = uniqueSortedStrings([...bestUnit.marketBucketIds, ...candidate.marketBucketIds]);
    bestUnit.transmissionChannels = uniqueSortedStrings([...bestUnit.transmissionChannels, ...candidate.transmissionChannels]);
    bestUnit.sourceStateIds = uniqueSortedStrings([...bestUnit.sourceStateIds, ...candidate.sourceStateIds]);
    bestUnit.tokens = uniqueSortedStrings([...bestUnit.tokens, ...candidate.tokens]).slice(0, 32);
    bestUnit.specificTokens = uniqueSortedStrings([...bestUnit.specificTokens, ...candidate.specificTokens]).slice(0, 24);
    bestUnit.sourceSituationIds = uniqueSortedStrings([...bestUnit.sourceSituationIds, ...candidate.sourceSituationIds]);
    bestUnit.forecastIds = uniqueSortedStrings([...bestUnit.forecastIds, ...candidate.forecastIds]);
    bestUnit.sampleTitles.push(...(cluster.sampleTitles || []));
    bestUnit._probabilityTotal += Number(cluster.avgProbability || 0) * Math.max(1, cluster.forecastCount || 1);
    bestUnit._confidenceTotal += Number(cluster.avgConfidence || 0) * Math.max(1, cluster.forecastCount || 1);
    incrementSituationCounts(bestUnit._regionCounts, candidate.regions);
    incrementSituationCounts(bestUnit._domainCounts, candidate.domains);
    incrementSituationCounts(
      bestUnit._dominantDomainCounts,
      candidate.cluster?.dominantDomain ? [candidate.cluster.dominantDomain] : candidate.domains,
    );
    for (const signal of cluster.topSignals || []) {
      const type = signal?.type || 'unknown';
      bestUnit._signalCounts[type] = (bestUnit._signalCounts[type] || 0) + Number(signal?.count || 0 || 1);
    }
  }

  return units
    .map(finalizeStateUnit)
    .sort((a, b) => b.forecastCount - a.forecastCount || b.avgProbability - a.avgProbability || a.label.localeCompare(b.label));
}

function buildSituationContinuitySummary(currentSituationClusters, priorWorldState = null) {
  const priorSituationClusters = Array.isArray(priorWorldState?.situationClusters) ? priorWorldState.situationClusters : [];
  const matchedPriorIds = new Set();
  const persistent = [];
  const newlyActive = [];
  const strengthened = [];
  const weakened = [];

  for (const cluster of currentSituationClusters) {
    let prev = priorSituationClusters.find((item) => item.id === cluster.id);
    if (!prev) {
      let bestMatch = null;
      let bestScore = 0;
      for (const priorCluster of priorSituationClusters) {
        if (matchedPriorIds.has(priorCluster.id)) continue;
        const score = computeSituationSimilarity(cluster, priorCluster);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = priorCluster;
        }
      }
      if (bestMatch && bestScore >= 4) prev = bestMatch;
    }
    if (!prev) {
      newlyActive.push(cluster);
      continue;
    }

    matchedPriorIds.add(prev.id);
    persistent.push(cluster);
    const probabilityDelta = +((cluster.avgProbability || 0) - (prev.avgProbability || 0)).toFixed(3);
    const countDelta = cluster.forecastCount - (prev.forecastCount || 0);
    const addedActors = cluster.actors.filter((actor) => !(prev.actors || []).includes(actor));
    const addedRegions = cluster.regions.filter((region) => !(prev.regions || []).includes(region));

    const record = {
      id: cluster.id,
      label: cluster.label,
      forecastCount: cluster.forecastCount,
      priorForecastCount: prev.forecastCount || 0,
      avgProbability: cluster.avgProbability,
      priorAvgProbability: +(prev.avgProbability || 0).toFixed(3),
      probabilityDelta,
      countDelta,
      addedActors: addedActors.slice(0, 4),
      addedRegions: addedRegions.slice(0, 4),
    };

    if (
      probabilityDelta >= 0.08 ||
      (countDelta >= 2 && probabilityDelta >= 0) ||
      ((addedActors.length > 0 || addedRegions.length > 0) && probabilityDelta >= 0)
    ) {
      strengthened.push(record);
    } else if (probabilityDelta <= -0.08 || countDelta <= -2) {
      weakened.push(record);
    }
  }

  const resolved = priorSituationClusters
    .filter((cluster) => !matchedPriorIds.has(cluster.id))
    .map((cluster) => ({
      id: cluster.id,
      label: cluster.label,
      forecastCount: cluster.forecastCount || 0,
      avgProbability: +(cluster.avgProbability || 0).toFixed(3),
    }));

  return {
    priorSituationCount: priorSituationClusters.length,
    currentSituationCount: currentSituationClusters.length,
    persistentSituationCount: persistent.length,
    newSituationCount: newlyActive.length,
    strengthenedSituationCount: strengthened.length,
    weakenedSituationCount: weakened.length,
    resolvedSituationCount: resolved.length,
    newSituationPreview: newlyActive.slice(0, 8),
    strengthenedSituationPreview: strengthened
      .sort((a, b) => b.probabilityDelta - a.probabilityDelta || b.countDelta - a.countDelta || a.id.localeCompare(b.id))
      .slice(0, 8),
    weakenedSituationPreview: weakened
      .sort((a, b) => a.probabilityDelta - b.probabilityDelta || a.countDelta - b.countDelta || a.id.localeCompare(b.id))
      .slice(0, 8),
    resolvedSituationPreview: resolved.slice(0, 8),
  };
}

function buildSituationSummary(situationClusters, situationContinuity) {
  const leading = situationClusters.slice(0, 4).map((cluster) => ({
    id: cluster.id,
    label: cluster.label,
    forecastCount: cluster.forecastCount,
    avgProbability: cluster.avgProbability,
    regions: cluster.regions,
    domains: cluster.domains,
  }));

  return {
    summary: situationClusters.length
      ? `${situationClusters.length} clustered situations are active, led by ${leading.map((cluster) => cluster.label).join(', ')}.`
      : 'No clustered situations are active in this run.',
    continuitySummary: `Situations: ${situationContinuity.newSituationCount} new, ${situationContinuity.strengthenedSituationCount} strengthened, ${situationContinuity.resolvedSituationCount} resolved.`,
    leading,
  };
}

function buildStateUnitSummary(stateUnits, stateContinuity) {
  const leading = (stateUnits || []).slice(0, 4).map((unit) => ({
    id: unit.id,
    label: unit.label,
    forecastCount: unit.forecastCount,
    situationCount: unit.situationCount,
    avgProbability: unit.avgProbability,
    stateKind: unit.stateKind,
    regions: unit.regions,
    domains: unit.domains,
  }));

  return {
    summary: stateUnits.length
      ? `${stateUnits.length} canonical state units are active, led by ${leading.map((unit) => unit.label).join(', ')}.`
      : 'No canonical state units are active in this run.',
    continuitySummary: `State units: ${stateContinuity.newSituationCount} new, ${stateContinuity.strengthenedSituationCount} strengthened, ${stateContinuity.resolvedSituationCount} resolved.`,
    leading,
  };
}

function clampUnitInterval(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function computeMarketBucketCoverageScore(bucketId, marketInputCoverage = {}) {
  const keys = MARKET_BUCKET_COVERAGE_KEYS[bucketId] || [];
  if (!keys.length) return 1;
  const available = keys.filter((key) => Number(marketInputCoverage?.[key] || 0) > 0).length;
  return +(available / keys.length).toFixed(3);
}

function computeCriticalBucketAlignment(bucketId, criticalSignalTypes = []) {
  const supportedTypes = MARKET_BUCKET_CRITICAL_SIGNAL_TYPES[bucketId] || [];
  if (!supportedTypes.length || !criticalSignalTypes.length) return 0;
  const overlap = supportedTypes.filter((type) => criticalSignalTypes.includes(type)).length;
  if (!overlap) return 0;
  return +clampUnitInterval((overlap / Math.min(4, supportedTypes.length)) + Math.min(0.16, criticalSignalTypes.length * 0.035)).toFixed(3);
}

function getMarketBucketAllowedChannels(bucketId, consequenceType = 'direct') {
  return consequenceType === 'adjacent'
    ? (MARKET_BUCKET_ADJACENT_CHANNELS[bucketId] || [])
    : (MARKET_BUCKET_ALLOWED_CHANNELS[bucketId] || []);
}

function isMarketBucketChannelAllowed(bucketId, channel, consequenceType = 'direct') {
  if (!channel) return false;
  const allowedChannels = getMarketBucketAllowedChannels(bucketId, consequenceType);
  return allowedChannels.length === 0 || allowedChannels.includes(channel);
}

function getPredictionDerivedStateMeta(prediction = {}) {
  return prediction.stateDerivation || prediction.caseFile?.stateDerivation || null;
}

function getPredictionMacroRegions(prediction = {}, regions = []) {
  const derived = getPredictionDerivedStateMeta(prediction);
  return uniqueSortedStrings([
    derived?.macroRegion || '',
    ...(regions || []).map((region) => getMacroRegion([region]) || ''),
  ].filter(Boolean));
}

function getPredictionMarketBucketIds(prediction = {}) {
  const derived = getPredictionDerivedStateMeta(prediction);
  return uniqueSortedStrings([
    derived?.bucketId || '',
    prediction.marketSelectionContext?.topBucketId || '',
    ...(prediction.marketSelectionContext?.linkedBucketIds || []),
  ].filter(Boolean));
}

function getPredictionTransmissionChannels(prediction = {}) {
  const derived = getPredictionDerivedStateMeta(prediction);
  return uniqueSortedStrings([
    derived?.channel || '',
    prediction.marketSelectionContext?.topChannel || '',
  ].filter(Boolean));
}

function getPredictionSourceStateIds(prediction = {}) {
  const derived = getPredictionDerivedStateMeta(prediction);
  return uniqueSortedStrings([
    derived?.sourceStateId || '',
    prediction.stateContext?.id || '',
  ].filter(Boolean));
}

function isMarketLikeDomains(domains = []) {
  return (domains || []).some((domain) => MARKET_CLUSTER_DOMAINS.has(domain));
}

function intersectAny(left = [], right = []) {
  return left.some((item) => right.includes(item));
}

function summarizeSituationPressure(cluster, actors, branches) {
  const signalWeight = Math.min(1, ((cluster.topSignals || []).reduce((sum, item) => sum + (item.count || 0), 0)) / 6);
  const actorWeight = Math.min(1, (actors.length || 0) / 4);
  const branchWeight = Math.min(1, (branches.length || 0) / 6);
  return clampUnitInterval(((cluster.avgProbability || 0) * 0.5) + (signalWeight * 0.2) + (actorWeight * 0.15) + (branchWeight * 0.15));
}

const SIMULATION_STATE_VERSION = 5;

const SIMULATION_DOMAIN_PROFILES = {
  conflict: {
    pressureBias: 0.12,
    stabilizationBias: 0.02,
    actionPressureMultiplier: 1.05,
    actionStabilizationMultiplier: 0.9,
    round3SpreadWeight: 0.18,
    postureBaseline: 0.18,
    finalPressureWeight: 0.34,
    deltaWeight: 0.46,
    escalatoryThreshold: 0.69,
    constrainedThreshold: 0.37,
  },
  military: {
    pressureBias: 0.14,
    stabilizationBias: 0.02,
    actionPressureMultiplier: 1.08,
    actionStabilizationMultiplier: 0.88,
    round3SpreadWeight: 0.16,
    postureBaseline: 0.18,
    finalPressureWeight: 0.35,
    deltaWeight: 0.47,
    escalatoryThreshold: 0.7,
    constrainedThreshold: 0.36,
  },
  political: {
    pressureBias: 0.06,
    stabilizationBias: 0.05,
    actionPressureMultiplier: 0.98,
    actionStabilizationMultiplier: 1,
    round3SpreadWeight: 0.14,
    postureBaseline: 0.16,
    finalPressureWeight: 0.33,
    deltaWeight: 0.42,
    escalatoryThreshold: 0.71,
    constrainedThreshold: 0.38,
  },
  market: {
    pressureBias: 0.03,
    stabilizationBias: 0.12,
    actionPressureMultiplier: 0.82,
    actionStabilizationMultiplier: 1.12,
    round3SpreadWeight: 0.1,
    postureBaseline: 0.18,
    finalPressureWeight: 0.38,
    deltaWeight: 0.3,
    escalatoryThreshold: 0.77,
    constrainedThreshold: 0.27,
  },
  supply_chain: {
    pressureBias: 0.04,
    stabilizationBias: 0.14,
    actionPressureMultiplier: 0.84,
    actionStabilizationMultiplier: 1.14,
    round3SpreadWeight: 0.08,
    postureBaseline: 0.18,
    finalPressureWeight: 0.38,
    deltaWeight: 0.3,
    escalatoryThreshold: 0.77,
    constrainedThreshold: 0.25,
  },
  infrastructure: {
    pressureBias: 0.02,
    stabilizationBias: 0.16,
    actionPressureMultiplier: 0.8,
    actionStabilizationMultiplier: 1.18,
    round3SpreadWeight: 0.08,
    postureBaseline: 0.08,
    finalPressureWeight: 0.27,
    deltaWeight: 0.28,
    escalatoryThreshold: 0.79,
    constrainedThreshold: 0.43,
  },
  cyber: {
    pressureBias: 0.08,
    stabilizationBias: 0.08,
    actionPressureMultiplier: 0.92,
    actionStabilizationMultiplier: 1.04,
    round3SpreadWeight: 0.1,
    postureBaseline: 0.12,
    finalPressureWeight: 0.3,
    deltaWeight: 0.34,
    escalatoryThreshold: 0.74,
    constrainedThreshold: 0.37,
  },
  default: {
    pressureBias: 0.05,
    stabilizationBias: 0.08,
    actionPressureMultiplier: 0.92,
    actionStabilizationMultiplier: 1.04,
    round3SpreadWeight: 0.1,
    postureBaseline: 0.12,
    finalPressureWeight: 0.3,
    deltaWeight: 0.34,
    escalatoryThreshold: 0.74,
    constrainedThreshold: 0.36,
  },
};

function getSimulationDomainProfile(dominantDomain) {
  return SIMULATION_DOMAIN_PROFILES[dominantDomain] || SIMULATION_DOMAIN_PROFILES.default;
}

const PRESSURE_ACTION_MARKERS = ['reposition', 'reprice', 'rebalance', 'retaliat', 'escalat', 'mobiliz', 'rerout', 'repris', 'spillover', 'price', 'shift messaging', 'shift posture'];
const STABILIZING_ACTION_MARKERS = ['prevent', 'preserve', 'contain', 'protect', 'reduce', 'maintain', 'harden', 'mitigation', 'continuity', 'de-escal', 'limit', 'triage'];
const GENERIC_ACTOR_CATEGORIES = new Set(['general', 'external', 'market', 'commercial', 'civic']);
const GENERIC_ACTOR_NAME_MARKERS = ['regional', 'participants', 'observers', 'operators', 'officials', 'watchers', 'forces', 'leadership', 'networks', 'authorities', 'teams', 'providers'];

function scoreActorSpecificity(actorLike = {}) {
  const actorName = String(actorLike.actorName || actorLike.name || '').toLowerCase();
  const actorId = String(actorLike.actorId || actorLike.id || '').toLowerCase();
  const category = String(actorLike.category || '').toLowerCase();
  const genericNameHitCount = GENERIC_ACTOR_NAME_MARKERS.filter((item) => actorName.includes(item)).length;
  let score = 0.55;

  if (actorId && !actorId.startsWith('shared-')) score += 0.1;
  if (category && !GENERIC_ACTOR_CATEGORIES.has(category)) score += 0.15;
  if (actorName && genericNameHitCount === 0) score += 0.15;
  if (actorName.split(/\s+/).length >= 3) score += 0.05;
  if (genericNameHitCount > 0) score -= Math.min(0.28, genericNameHitCount * 0.12);
  if (actorName.includes('command') || actorName.includes('desk') || actorName.includes('authority')) score -= 0.14;
  if (actorId.startsWith('shared-')) score -= 0.12;

  return clampUnitInterval(score);
}

function summarizeBranchDynamics(branches = []) {
  const escalatory = branches.filter((branch) => branch.kind === 'escalatory');
  const contrarian = branches.filter((branch) => branch.kind === 'contrarian');
  const base = branches.filter((branch) => branch.kind === 'base');
  const avgScore = (items, scorer) => items.length
    ? items.reduce((sum, item) => sum + scorer(item), 0) / items.length
    : 0;
  return {
    escalatoryWeight: clampUnitInterval(avgScore(escalatory, (branch) => (branch.projectedProbability || 0) + Math.max(0, branch.probabilityDelta || 0))),
    contrarianWeight: clampUnitInterval(avgScore(contrarian, (branch) => (branch.projectedProbability || 0) + Math.max(0, -(branch.probabilityDelta || 0)))),
    baseWeight: clampUnitInterval(avgScore(base, (branch) => branch.projectedProbability || 0)),
  };
}

function scoreActorAction(summary, stage, dominantDomain, actor) {
  const text = (summary || '').toLowerCase();
  const profile = getSimulationDomainProfile(dominantDomain);
  let pressureBias = 0.2;
  let stabilizationBias = 0.2;

  for (const marker of PRESSURE_ACTION_MARKERS) {
    if (text.includes(marker)) pressureBias += 0.18;
  }
  for (const marker of STABILIZING_ACTION_MARKERS) {
    if (text.includes(marker)) stabilizationBias += 0.18;
  }

  if (stage === 'round_1' && ['conflict', 'military', 'political', 'cyber'].includes(dominantDomain)) pressureBias += 0.12;
  if (stage === 'round_3') {
    stabilizationBias += 0.08;
  }
  pressureBias += profile.pressureBias || 0;
  stabilizationBias += profile.stabilizationBias || 0;

  const influence = clampUnitInterval(actor?.influenceScore || 0.5);
  const pressureContribution = +(influence * pressureBias * 0.6 * (profile.actionPressureMultiplier || 1)).toFixed(3);
  const stabilizationContribution = +(influence * stabilizationBias * 0.6 * (profile.actionStabilizationMultiplier || 1)).toFixed(3);
  let intent = 'mixed';
  if (pressureContribution > stabilizationContribution + 0.08) intent = 'pressure';
  else if (stabilizationContribution > pressureContribution + 0.08) intent = 'stabilizing';

  return {
    intent,
    pressureContribution,
    stabilizationContribution,
  };
}

function inferActionChannels(summary, intent, dominantDomain) {
  const text = String(summary || '').toLowerCase();
  const channels = new Set();

  if (dominantDomain === 'conflict' || dominantDomain === 'military') channels.add('security_escalation');
  if (dominantDomain === 'political') channels.add('political_pressure');
  if (dominantDomain === 'market') channels.add('market_repricing');
  if (dominantDomain === 'supply_chain') channels.add('logistics_disruption');
  if (dominantDomain === 'infrastructure') channels.add('service_disruption');
  if (dominantDomain === 'cyber') channels.add('cyber_disruption');
  if (intent === 'pressure') channels.add('regional_spillover');

  if (/(mobiliz|retaliat|escalat|strike|attack|deploy|coordination)/.test(text)) channels.add('security_escalation');
  if (/(sanction|policy|cabinet|election|messaging|posture)/.test(text)) channels.add('political_pressure');
  if (/(repric|price|commodity|oil|contract|risk premium)/.test(text)) channels.add('market_repricing');
  if (/(rerout|shipping|port|throughput|logistics|corridor|freight)/.test(text)) channels.add('logistics_disruption');
  if (/(outage|continuity|service|grid|facility|capacity|harden)/.test(text)) channels.add('service_disruption');
  if (/(cyber|network|gps|spoof|jam|malware|phish)/.test(text)) channels.add('cyber_disruption');
  if (/(spillover|regional|neighbor|broader)/.test(text)) channels.add('regional_spillover');
  if (intent === 'stabilizing') channels.add('containment');

  return [...channels];
}

function getTargetSensitivityChannels(domain) {
  const map = {
    conflict: ['security_escalation', 'political_pressure', 'regional_spillover'],
    military: ['security_escalation', 'political_pressure', 'regional_spillover'],
    political: ['political_pressure', 'security_escalation', 'regional_spillover'],
    market: ['market_repricing', 'logistics_disruption', 'political_pressure', 'regional_spillover', 'service_disruption'],
    supply_chain: ['logistics_disruption', 'service_disruption', 'security_escalation', 'regional_spillover'],
    infrastructure: ['service_disruption', 'cyber_disruption', 'security_escalation', 'regional_spillover'],
    cyber: ['cyber_disruption', 'service_disruption', 'political_pressure'],
  };
  return map[domain] || ['regional_spillover'];
}

function inferSystemEffectRelationFromChannel(channel, targetDomain) {
  const relationMap = {
    'security_escalation:conflict': 'regional escalation pressure',
    'security_escalation:market': 'risk repricing',
    'security_escalation:supply_chain': 'route disruption',
    'security_escalation:infrastructure': 'service disruption',
    'political_pressure:market': 'policy repricing',
    'political_pressure:conflict': 'escalation risk',
    'political_pressure:supply_chain': 'trade friction',
    'market_repricing:market': 'commodity pricing pressure',
    'logistics_disruption:market': 'cost pass-through',
    'logistics_disruption:supply_chain': 'logistics disruption',
    'service_disruption:market': 'capacity shock',
    'service_disruption:supply_chain': 'throughput disruption',
    'service_disruption:infrastructure': 'service degradation',
    'cyber_disruption:infrastructure': 'service degradation',
    'cyber_disruption:market': 'risk repricing',
    'regional_spillover:market': 'regional spillover',
    'regional_spillover:supply_chain': 'regional spillover',
    'regional_spillover:political': 'regional pressure transfer',
  };
  return relationMap[`${channel}:${targetDomain}`] || inferSystemEffectRelation('', targetDomain);
}

function compareTransmissionEdgePriority(left, right) {
  return (Number(right?.strength || 0) + Number(right?.confidence || 0)) - (Number(left?.strength || 0) + Number(left?.confidence || 0))
    || Number(right?.strength || 0) - Number(left?.strength || 0)
    || Number(right?.confidence || 0) - Number(left?.confidence || 0)
    || String(left?.channel || '').localeCompare(String(right?.channel || ''))
    || String(left?.sourceSituationId || '').localeCompare(String(right?.sourceSituationId || ''))
    || String(left?.edgeId || '').localeCompare(String(right?.edgeId || ''));
}

function buildActorRoundActions(stage, situation, actors = []) {
  return actors.slice(0, 6).map((actor) => {
    let summary = '';
    if (stage === 'round_1') {
      summary = actor.likelyActions?.[0] || actor.objectives?.[0] || `Adjust posture around ${situation.dominantRegion || situation.label}.`;
    } else if (stage === 'round_2') {
      summary = actor.likelyActions?.[1] || actor.objectives?.[1] || actor.likelyActions?.[0] || `Respond to the evolving ${situation.label}.`;
    } else {
      summary = actor.constraints?.[0]
        ? `Operate within ${actor.constraints[0]}`
        : actor.likelyActions?.[2] || actor.constraints?.[1] || `Manage spillover from ${situation.label}.`;
    }
    const effect = scoreActorAction(summary, stage, situation.dominantDomain || situation.domains?.[0] || '', actor);
    const channels = inferActionChannels(summary, effect.intent, situation.dominantDomain || situation.domains?.[0] || '');
    return {
      actorId: actor.id,
      actorName: actor.name,
      category: actor.category,
      actorSpecificity: scoreActorSpecificity(actor),
      summary,
      channels,
      ...effect,
    };
  });
}

function buildSimulationRound(stage, situation, context) {
  const { actors, branches, counterEvidence, supportiveEvidence, priorSimulation, marketContext } = context;
  const dominantDomain = situation.dominantDomain || situation.domains?.[0] || '';
  const profile = getSimulationDomainProfile(dominantDomain);
  const topSignalTypes = (situation.topSignals || []).slice(0, 3).map((item) => item.type);
  const branchKinds = uniqueSortedStrings(branches.map((branch) => branch.kind).filter(Boolean));
  const branchPressure = summarizeSituationPressure(situation, actors, branches);
  const branchDynamics = summarizeBranchDynamics(branches);
  const counterWeight = Math.min(1, (counterEvidence.length || 0) / 5);
  const supportWeight = Math.min(1, (supportiveEvidence.length || 0) / 5);
  const priorMomentum = clampUnitInterval(priorSimulation?.postureScore || 0.5);
  const actorActions = buildActorRoundActions(stage, situation, actors);
  const actionPressure = actorActions.reduce((sum, action) => sum + (action.pressureContribution || 0), 0);
  const actionStabilization = actorActions.reduce((sum, action) => sum + (action.stabilizationContribution || 0), 0);
  const effectChannels = pickTopCountEntries(summarizeTypeCounts(actorActions.flatMap((action) => action.channels || [])), 5);
  const domainSpread = Math.min(1, Math.max(0, ((situation.domains || []).length - 1) * 0.25));
  const marketConfirmation = Number(marketContext?.confirmationScore || 0);
  const marketContradiction = Number(marketContext?.contradictionScore || 0);
  const marketPressure = Number(marketContext?.topBucketPressure || 0);
  const marketEdgeStrength = Number(marketContext?.topTransmissionStrength || 0);
  const marketBias = MARKET_BUCKET_SIMULATION_BIAS[marketContext?.topBucketId || ''] || MARKET_BUCKET_SIMULATION_BIAS.sovereign_risk;
  const marketSupport = clampUnitInterval(
    (marketConfirmation * marketBias.confirmation) +
    (marketPressure * marketBias.pressure) +
    (marketEdgeStrength * marketBias.edge),
  );
  const marketResistance = clampUnitInterval(
    marketContradiction * marketBias.contradiction,
  );

  let pressureDelta = 0;
  let stabilizationDelta = 0;
  let lead = '';

  if (stage === 'round_1') {
    pressureDelta = clampUnitInterval(
      (branchPressure * 0.18) +
      (branchDynamics.escalatoryWeight * 0.24) +
      (supportWeight * 0.14) +
      (actionPressure * 0.28) +
      (priorMomentum * 0.08) +
      marketSupport
    );
    stabilizationDelta = clampUnitInterval(
      (counterWeight * 0.18) +
      (branchDynamics.contrarianWeight * 0.18) +
      (actionStabilization * 0.26) +
      marketResistance
    );
    lead = marketContext?.topBucketLabel
      ? `${marketContext.topBucketLabel} confirmation`
      : (topSignalTypes[0] || situation.domains[0] || 'signal interpretation');
  } else if (stage === 'round_2') {
    pressureDelta = clampUnitInterval(
      (branchPressure * 0.12) +
      (branchDynamics.escalatoryWeight * 0.24) +
      (actionPressure * 0.26) +
      (actors.length ? 0.08 : 0) +
      ((priorSimulation?.rounds?.[0]?.pressureDelta || 0) * 0.12) +
      (marketSupport * 1.12)
    );
    stabilizationDelta = clampUnitInterval(
      (counterWeight * 0.16) +
      (branchDynamics.contrarianWeight * 0.2) +
      (actionStabilization * 0.28) +
      ((priorSimulation?.rounds?.[0]?.stabilizationDelta || 0) * 0.12) +
      (marketResistance * 1.05)
    );
    lead = marketContext?.topChannel
      ? `${String(marketContext.topChannel).replace(/_/g, ' ')} transmission`
      : (branchKinds[0] || topSignalTypes[0] || 'interaction response');
  } else {
    pressureDelta = clampUnitInterval(
      (branchPressure * 0.08) +
      (branchDynamics.escalatoryWeight * 0.14) +
      (domainSpread * (profile.round3SpreadWeight || 0.1)) +
      (actionPressure * 0.18) +
      ((priorSimulation?.rounds?.[1]?.pressureDelta || 0) * 0.18) +
      (marketSupport * 0.96)
    );
    stabilizationDelta = clampUnitInterval(
      (counterWeight * 0.18) +
      (branchDynamics.contrarianWeight * 0.18) +
      (supportWeight * 0.08) +
      (actionStabilization * 0.24) +
      ((priorSimulation?.rounds?.[1]?.stabilizationDelta || 0) * 0.18) +
      (marketResistance * 0.96)
    );
    lead = marketContext?.topBucketLabel
      ? `${marketContext.topBucketLabel} spillover`
      : ((situation.domains || []).length > 1 ? `${formatSituationDomainLabel(situation.domains)} spillover` : `${situation.domains[0] || 'regional'} effects`);
  }

  const rawPressureDelta = pressureDelta;
  const rawStabilizationDelta = stabilizationDelta;
  const netPressure = +clampUnitInterval(
    ((situation.avgProbability || 0) * 0.78) +
    ((pressureDelta - stabilizationDelta) * 0.36)
  ).toFixed(3);
  const actionMix = summarizeTypeCounts(actorActions.map((action) => action.intent));
  return {
    stage,
    lead,
    signalTypes: topSignalTypes,
    branchKinds,
    actions: actorActions,
    actionMix,
    effectChannels,
    dominantDomain,
    rawPressureDelta: +rawPressureDelta.toFixed(3),
    rawStabilizationDelta: +rawStabilizationDelta.toFixed(3),
    pressureDelta: +pressureDelta.toFixed(3),
    stabilizationDelta: +stabilizationDelta.toFixed(3),
    netPressure,
    marketConfirmation: +marketConfirmation.toFixed(3),
    marketContradiction: +marketContradiction.toFixed(3),
    marketSupport: +marketSupport.toFixed(3),
    marketResistance: +marketResistance.toFixed(3),
    topMarketBucketId: marketContext?.topBucketId || '',
    topMarketBucketLabel: marketContext?.topBucketLabel || '',
  };
}

function summarizeSimulationOutcome(rounds = [], dominantDomain = '') {
  const profile = getSimulationDomainProfile(dominantDomain);
  const finalRound = rounds[rounds.length - 1] || null;
  const netPressureDelta = rounds.length
    ? +rounds.reduce((sum, round) => sum + ((round.pressureDelta || 0) - (round.stabilizationDelta || 0)), 0).toFixed(3)
    : 0;
  const totalPressure = rounds.length
    ? +rounds.reduce((sum, round) => sum + (round.pressureDelta || 0), 0).toFixed(3)
    : 0;
  const totalStabilization = rounds.length
    ? +rounds.reduce((sum, round) => sum + (round.stabilizationDelta || 0), 0).toFixed(3)
    : 0;
  const postureScore = Math.min(0.985, clampUnitInterval(
    (profile.postureBaseline || 0.12) +
    ((finalRound?.netPressure || 0) * (profile.finalPressureWeight || 0.3)) +
    (netPressureDelta * (profile.deltaWeight || 0.34))
  ));
  let posture = 'contested';
  if (postureScore >= (profile.escalatoryThreshold || 0.74)) posture = 'escalatory';
  else if (postureScore <= (profile.constrainedThreshold || 0.4)) posture = 'constrained';

  return {
    posture,
    postureScore: +postureScore.toFixed(3),
    netPressureDelta,
    totalPressure,
    totalStabilization,
  };
}

function inferSimulationActorRole(actor = {}) {
  const domains = new Set(actor.domains || []);
  const likelyActions = (actor.likelyActions || []).join(' ').toLowerCase();
  const name = String(actor.name || '').toLowerCase();

  if (domains.has('military') || /\bbrigade|army|navy|air force|command\b/.test(name)) return 'military_actor';
  if (domains.has('cyber') || likelyActions.includes('cyber')) return 'cyber_operator';
  if (domains.has('supply_chain') || likelyActions.includes('reroute') || likelyActions.includes('shipping')) return 'logistics_actor';
  if (domains.has('infrastructure') || likelyActions.includes('repair') || likelyActions.includes('harden')) return 'infrastructure_operator';
  if (domains.has('market') || likelyActions.includes('hedge') || likelyActions.includes('reprice')) return 'market_actor';
  if (domains.has('political') || likelyActions.includes('sanction') || likelyActions.includes('negotiate')) return 'political_actor';
  if (domains.has('conflict')) return 'state_actor';
  return 'general_actor';
}

function inferSimulationEnvironmentArchetype(simulation = {}) {
  const domain = simulation.dominantDomain || '';
  const topChannels = new Set((simulation.effectChannels || []).map((item) => item.type));
  if (domain === 'conflict' || domain === 'military') return 'security_theater';
  if (domain === 'supply_chain' || topChannels.has('logistics_disruption')) return 'logistics_corridor';
  if (domain === 'cyber' || topChannels.has('cyber_disruption')) return 'cyber_pressure_network';
  if (domain === 'infrastructure' || topChannels.has('service_disruption')) return 'infrastructure_fragility';
  if (domain === 'market' || topChannels.has('market_repricing')) return 'market_repricing_zone';
  if (domain === 'political' || topChannels.has('political_pressure')) return 'political_pressure_complex';
  return 'mixed_pressure_zone';
}

function buildSimulationEnvironmentSpec(_worldState, situationSimulations = [], priorWorldState = null) {
  const priorEnvironment = priorWorldState?.simulationState?.environmentSpec;
  const priorBySituation = new Map((priorEnvironment?.situations || []).map((item) => [item.situationId, item]));
  const situations = (situationSimulations || []).map((simulation) => {
    const actionCount = (simulation.actionPlan || []).reduce((sum, round) => sum + ((round.actions || []).length), 0);
    const triggerSignals = uniqueSortedStrings([
      ...(simulation.pressureSignals || []).map((signal) => signal.type || signal),
      ...(simulation.branchSeeds || []).map((branch) => branch.kind),
    ]).slice(0, 6);
    const propagationRules = uniqueSortedStrings([
      ...(simulation.effectChannels || []).map((item) => item.type),
      simulation.dominantDomain === 'conflict' ? 'security_escalation' : '',
      simulation.dominantDomain === 'supply_chain' ? 'logistics_pass_through' : '',
      simulation.dominantDomain === 'cyber' ? 'cyber_service_spillover' : '',
    ].filter(Boolean)).slice(0, 5);
    const actorRoles = summarizeTypeCounts((simulation.actorPostures || []).map((actor) => inferSimulationActorRole(actor)));
    const activityIntensity = +clampUnitInterval(
      ((simulation.postureScore || 0) * 0.42) +
      (Math.min(1, actionCount / 18) * 0.26) +
      (Math.min(1, (simulation.actorIds || []).length / 8) * 0.18) +
      (Math.min(1, triggerSignals.length / 6) * 0.14)
    ).toFixed(3);
    const prior = priorBySituation.get(simulation.situationId) || null;
    return {
      situationId: simulation.situationId,
      label: simulation.label,
      familyId: simulation.familyId,
      familyLabel: simulation.familyLabel,
      archetype: inferSimulationEnvironmentArchetype(simulation),
      dominantRegion: simulation.dominantRegion,
      dominantDomain: simulation.dominantDomain,
      regions: simulation.regions || [],
      actorRoles,
      actorCount: (simulation.actorIds || []).length,
      branchCount: (simulation.branchIds || []).length,
      triggerSignals,
      constraints: simulation.constraints || [],
      stabilizers: simulation.stabilizers || [],
      propagationRules,
      activityIntensity,
      continuityMode: prior ? 'persistent' : 'new',
      priorActivityIntensity: prior?.activityIntensity ?? null,
    };
  });

  const familyArchetypes = summarizeTypeCounts(situations.map((item) => item.archetype));
  const summary = situations.length
    ? `${situations.length} simulation environments were configured with ${Object.keys(familyArchetypes).length} archetype classes and ${pickTopCountEntries(familyArchetypes, 2).map((item) => item.type).join(', ') || 'mixed'} as the leading environment patterns.`
    : 'No simulation environments were configured.';

  return {
    version: SIMULATION_STATE_VERSION,
    summary,
    situations,
    familyArchetypes,
    globalTriggers: pickTopCountEntries(
      summarizeTypeCounts(situations.flatMap((item) => item.triggerSignals || [])),
      6,
    ),
  };
}

function buildSimulationMemoryMutations(_worldState, simulationState, priorWorldState = null) {
  const priorMemory = priorWorldState?.simulationState?.memoryMutations;
  const priorSituationMemory = new Map((priorMemory?.situations || []).map((item) => [item.situationId, item]));
  const priorActorMemory = new Map((priorMemory?.actors || []).map((item) => [item.actorId || item.actorName, item]));

  const situations = (simulationState?.situationSimulations || []).map((simulation) => {
    const prior = priorSituationMemory.get(simulation.situationId) || null;
    const persistentChannels = uniqueSortedStrings([
      ...(simulation.effectChannels || []).map((item) => item.type),
      ...((simulationState?.reportableInteractionLedger || [])
        .filter((item) => item.sourceSituationId === simulation.situationId || item.targetSituationId === simulation.situationId)
        .map((item) => item.strongestChannel)),
    ]).slice(0, 6);
    const pressureMemory = +clamp01((
      ((simulation.totalPressure || 0) * 0.45) +
      ((simulation.postureScore || 0) * 0.4) +
      (((simulation.rounds || []).reduce((sum, round) => sum + (round.netPressure || 0), 0) / Math.max((simulation.rounds || []).length, 1)) * 0.15)
    )).toFixed(3);
    const memoryDelta = +(pressureMemory - Number(prior?.pressureMemory || 0)).toFixed(3);
    const mutationType = !prior
      ? 'new_memory'
      : memoryDelta >= 0.08
        ? 'intensified'
        : memoryDelta <= -0.08
          ? 'relaxed'
          : 'stable';
    return {
      situationId: simulation.situationId,
      label: simulation.label,
      dominantRegion: simulation.dominantRegion,
      dominantDomain: simulation.dominantDomain,
      posture: simulation.posture,
      postureScore: simulation.postureScore,
      pressureMemory,
      memoryDelta,
      mutationType,
      persistentChannels,
      actorCount: (simulation.actorIds || []).length,
      branchCount: (simulation.branchIds || []).length,
    };
  });

  const actorGroups = new Map();
  for (const action of (simulationState?.actionLedger || [])) {
    const key = action.actorId || action.actorName;
    if (!key) continue;
    const group = actorGroups.get(key) || {
      actorId: action.actorId || '',
      actorName: action.actorName || '',
      roles: new Set(),
      channels: new Set(),
      situations: new Set(),
      actionCount: 0,
      pressure: 0,
      stabilization: 0,
    };
    group.roles.add(action.category || inferSimulationActorRole({ domains: [action.dominantDomain], likelyActions: [action.summary] }));
    for (const channel of action.channels || []) group.channels.add(channel);
    group.situations.add(action.situationId);
    group.actionCount += 1;
    group.pressure += Number(action.pressureContribution || 0);
    group.stabilization += Number(action.stabilizationContribution || 0);
    actorGroups.set(key, group);
  }

  const actors = [...actorGroups.values()].map((group) => {
    const prior = priorActorMemory.get(group.actorId || group.actorName) || null;
    const netPressure = +(group.pressure - group.stabilization).toFixed(3);
    const memoryDelta = +(netPressure - Number(prior?.netPressure || 0)).toFixed(3);
    return {
      actorId: group.actorId,
      actorName: group.actorName,
      actionCount: group.actionCount,
      netPressure,
      memoryDelta,
      roles: [...group.roles].sort(),
      channels: [...group.channels].sort(),
      situationCount: group.situations.size,
      mutationType: !prior ? 'new_actor_memory' : memoryDelta >= 0.08 ? 'strengthened_actor' : memoryDelta <= -0.08 ? 'softened_actor' : 'stable_actor',
    };
  }).sort((a, b) => Math.abs(b.netPressure) - Math.abs(a.netPressure) || b.actionCount - a.actionCount || a.actorName.localeCompare(b.actorName));

  const links = buildInteractionGroups(simulationState?.reportableInteractionLedger || []).map((group) => ({
    sourceSituationId: group.sourceSituationId,
    targetSituationId: group.targetSituationId,
    strongestChannel: group.strongestChannel,
    memoryStrength: +(((group.avgConfidence || 0) * 0.55) + clamp01((group.score || 0) / 10) * 0.45).toFixed(3),
    stageCount: group.stages?.size || 0,
    directLinkCount: group.directLinkCount || 0,
  })).sort((a, b) => b.memoryStrength - a.memoryStrength || b.stageCount - a.stageCount);

  const summary = situations.length
    ? `${situations.length} situation memories, ${actors.length} actor memories, and ${links.length} link memories were mutated from the latest simulation output.`
    : 'No simulation memory mutations were derived.';

  return {
    version: SIMULATION_STATE_VERSION,
    summary,
    situations,
    actors: actors.slice(0, 24),
    links: links.slice(0, 24),
  };
}

function buildSimulationCausalReplayChains(simulationState) {
  const simulationsById = new Map((simulationState?.situationSimulations || []).map((item) => [item.situationId, item]));
  const actionLedger = simulationState?.actionLedger || [];
  const interactionGroups = buildInteractionGroups(simulationState?.reportableInteractionLedger || []);
  const causalEdges = Array.isArray(simulationState?.causalGraph?.edges)
    ? simulationState.causalGraph.edges
    : [];
  const chains = [];

  for (const edge of causalEdges) {
    const source = simulationsById.get(edge.sourceSituationId);
    const target = simulationsById.get(edge.targetSituationId);
    const interactionGroup = interactionGroups.find((group) => (
      group.sourceSituationId === edge.sourceSituationId
      && group.targetSituationId === edge.targetSituationId
      && (group.strongestChannel === edge.primaryChannel || (edge.supportingChannels || []).includes(group.strongestChannel))
    )) || null;
    const trigger = (source?.pressureSignals || [])[0]?.type
      || source?.branchSeeds?.[0]?.kind
      || source?.dominantDomain
      || 'pressure';
    const leadAction = actionLedger.find((action) => (
      action.situationId === edge.sourceSituationId
      && (action.channels || []).some((channel) => (edge.supportingChannels || []).includes(channel))
    )) || actionLedger.find((action) => action.situationId === edge.sourceSituationId) || null;
    const stages = interactionGroup ? [...(interactionGroup.stages || [])].sort() : ['round_1', 'round_2', 'round_3'];
    chains.push({
      chainId: `chain-${hashSituationKey([edge.sourceSituationId, edge.targetSituationId, edge.effectClass])}`,
      kind: 'cross_situation_effect',
      sourceSituationId: edge.sourceSituationId,
      sourceLabel: edge.sourceLabel,
      targetSituationId: edge.targetSituationId,
      targetLabel: edge.targetLabel,
      trigger,
      stages,
      actionSummary: leadAction?.summary || '',
      interactionSummary: interactionGroup
        ? `${interactionGroup.sourceLabel} -> ${interactionGroup.targetLabel} via ${interactionGroup.strongestChannel.replace(/_/g, ' ')}`
        : '',
      outcomeSummary: edge.summary,
      confidence: edge.confidence || interactionGroup?.avgConfidence || 0,
      strongestChannel: edge.primaryChannel,
    });
  }

  for (const simulation of (simulationState?.situationSimulations || []).slice(0, 6)) {
    if (chains.some((item) => item.sourceSituationId === simulation.situationId && item.kind === 'situation_resolution')) continue;
    const trigger = (simulation.pressureSignals || [])[0]?.type
      || simulation.branchSeeds?.[0]?.kind
      || simulation.dominantDomain
      || 'pressure';
    const leadAction = actionLedger.find((action) => action.situationId === simulation.situationId) || null;
    chains.push({
      chainId: `chain-${hashSituationKey([simulation.situationId, simulation.posture, 'resolution'])}`,
      kind: 'situation_resolution',
      sourceSituationId: simulation.situationId,
      sourceLabel: simulation.label,
      targetSituationId: '',
      targetLabel: '',
      trigger,
      stages: (simulation.rounds || []).map((round) => round.stage),
      actionSummary: leadAction?.summary || '',
      interactionSummary: '',
      outcomeSummary: `${simulation.label} resolved to a ${simulation.posture} posture at ${roundPct(simulation.postureScore)}.`,
      confidence: simulation.postureScore || 0,
      strongestChannel: (simulation.effectChannels || [])[0]?.type || '',
    });
  }

  const summary = chains.length
    ? `${chains.length} causal replay chains are available to explain trigger-to-outcome transitions across situations and rounds.`
    : 'No causal replay chains are available.';

  return {
    version: SIMULATION_STATE_VERSION,
    summary,
    chains: chains
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || a.sourceLabel.localeCompare(b.sourceLabel))
      .slice(0, 12),
  };
}

function buildSimulationMarketConsequences(simulationState, marketState, options = {}) {
  const simulations = Array.isArray(simulationState?.situationSimulations) ? simulationState.situationSimulations : [];
  const bucketMap = new Map((marketState?.buckets || []).map((bucket) => [bucket.id, bucket]));
  const marketInputCoverage = options?.marketInputCoverage || null;
  const consequences = [];
  const blocked = [];

  for (const simulation of simulations) {
    const linkedBuckets = simulation.marketContext?.linkedBucketIds || [];
    const primaryBucketIds = linkedBuckets.slice(0, 2);
    for (const bucketId of primaryBucketIds) {
      const sourceBucketContext = simulation.marketContext?.bucketContexts?.[bucketId] || null;
      const candidateBucketIds = [
        bucketId,
        ...((MARKET_BUCKET_NEIGHBORS[bucketId] || []).slice(0, 2)),
      ];
      for (const [depth, candidateBucketId] of candidateBucketIds.entries()) {
        const bucket = bucketMap.get(candidateBucketId);
        if (!bucket) continue;
        const direct = depth === 0;
        const consequenceType = direct ? 'direct' : 'adjacent';
        const bucketContext = direct
          ? (simulation.marketContext?.bucketContexts?.[candidateBucketId] || sourceBucketContext)
          : sourceBucketContext;
        const channel = bucketContext?.topChannel || simulation.marketContext?.topChannel || 'derived_transmission';
        const supportingSignalTypes = uniqueSortedStrings([
          ...(bucketContext?.supportingSignalTypes || []),
          ...(simulation.marketContext?.criticalSignalTypes || []),
        ]);
        const channelAllowed = isMarketBucketChannelAllowed(candidateBucketId, channel, consequenceType);
        const bucketSupportSignalTypes = MARKET_BUCKET_CRITICAL_SIGNAL_TYPES[candidateBucketId]
          || MARKET_BUCKET_CONFIG.find((item) => item.id === candidateBucketId)?.signalTypes
          || [];
        const bucketSignalSupport = intersectCount(
          supportingSignalTypes,
          bucketSupportSignalTypes,
        );
        const criticalSignalLift = Number(simulation.marketContext?.criticalSignalLift || 0);
        const criticalSignalTypes = simulation.marketContext?.criticalSignalTypes || [];
        const criticalAlignment = computeCriticalBucketAlignment(candidateBucketId, criticalSignalTypes);
        const criticalLift = criticalSignalLift * criticalAlignment;
        const coverageScore = computeMarketBucketCoverageScore(candidateBucketId, marketInputCoverage);
        const effectiveMacroConfirmation = clampUnitInterval(
          Math.max(
            Number(bucket.macroConfirmation || 0),
            Math.min(0.24, criticalLift * (direct ? 0.6 : 0.32)),
          ),
        );
        const adjacencyPenalty = direct ? 0 : 0.18 + ((depth - 1) * 0.05);
        const strength = clampUnitInterval(
          ((simulation.marketContext?.confirmationScore || 0) * (direct ? 0.34 : 0.22)) +
          ((bucketContext?.topTransmissionStrength || simulation.marketContext?.topTransmissionStrength || 0) * (direct ? 0.24 : 0.18)) +
          ((bucket.pressureScore || 0) * (direct ? 0.28 : 0.24)) +
          ((simulation.postureScore || 0) * 0.14) +
          (criticalLift * (direct ? 0.16 : 0.08)) -
          adjacencyPenalty
        );
        if (strength < (direct ? 0.26 : 0.3)) continue;
        const confidence = clampUnitInterval(
          ((simulation.marketContext?.topTransmissionConfidence || 0) * 0.34) +
          ((bucket.confidence || 0) * 0.3) +
          (effectiveMacroConfirmation * (direct ? 0.18 : 0.22)) +
          ((simulation.avgConfidence || 0) * 0.12) +
          (criticalLift * (direct ? 0.12 : 0.06)) -
          (direct ? 0 : 0.05)
        );
        const reportableScore = clampUnitInterval(
          (strength * 0.4) +
          (confidence * 0.32) +
          (effectiveMacroConfirmation * 0.18) +
          (criticalLift * (direct ? 0.12 : 0.04)) +
          Math.min(0.08, (simulation.marketContext?.linkedBucketIds || []).length * 0.04) -
          (direct ? 0 : 0.06)
        );
        const consequence = {
          id: `mktc-${hashSituationKey([simulation.situationId, candidateBucketId, depth])}`,
          situationId: simulation.situationId,
          situationLabel: simulation.label,
          familyId: simulation.familyId,
          familyLabel: simulation.familyLabel,
          dominantDomain: simulation.dominantDomain,
          dominantRegion: simulation.dominantRegion,
          targetBucketId: bucket.id,
          targetBucketLabel: bucket.label,
          sourceBucketId: bucketId,
          consequenceType,
          channel,
          supportingSignalTypes,
          strength: +strength.toFixed(3),
          confidence: +confidence.toFixed(3),
          reportableScore: +reportableScore.toFixed(3),
          macroConfirmation: Number(bucket.macroConfirmation || 0),
          effectiveMacroConfirmation: +effectiveMacroConfirmation.toFixed(3),
          coverageScore,
          criticalAlignment: +criticalAlignment.toFixed(3),
          criticalSignalLift: +criticalSignalLift.toFixed(3),
          bucketSignalSupport,
          summary: direct
            ? `${simulation.label} is exerting ${roundPct(strength)} pressure on ${bucket.label} via ${String(channel || 'derived transmission').replace(/_/g, ' ')}.`
            : `${simulation.label} is spilling ${roundPct(strength)} follow-on pressure from ${bucketMap.get(bucketId)?.label || bucketId} into ${bucket.label}.`,
        };
        if (!channelAllowed || bucketSignalSupport === 0) {
          blocked.push({
            ...consequence,
            reason: !channelAllowed ? 'inadmissible_bucket_channel' : 'weak_bucket_signal_support',
          });
          continue;
        }
        consequences.push(consequence);
      }
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const item of consequences
    .sort((a, b) => (b.reportableScore || 0) - (a.reportableScore || 0) || (b.strength + b.confidence) - (a.strength + a.confidence) || a.situationLabel.localeCompare(b.situationLabel))) {
    const key = `${item.situationId}:${item.targetBucketId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  const internalItems = deduped.slice(0, 40);
  const reportableItems = [];
  const usedBuckets = new Map();
  const usedSituations = new Set();
  for (const item of internalItems) {
    const bucketCount = usedBuckets.get(item.targetBucketId) || 0;
    const criticalFloorRelief = item.consequenceType === 'direct' && CORE_MARKET_BUCKET_IDS.includes(item.targetBucketId)
      ? Math.min(0.08, (Number(item.criticalAlignment || 0) * Number(item.criticalSignalLift || 0)) * 0.14)
      : 0;
    const lowCoverageRelief = item.consequenceType === 'direct' && CORE_MARKET_BUCKET_IDS.includes(item.targetBucketId) && (item.coverageScore || 0) < 0.45
      ? 0.03
      : 0;
    const minScore = Math.max(
      0.34,
      (MARKET_BUCKET_REPORTABLE_SCORE_FLOORS[item.targetBucketId] || 0.52) - criticalFloorRelief - lowCoverageRelief,
    );
    if ((item.reportableScore || 0) < minScore) {
      blocked.push({ ...item, reason: 'low_reportable_score' });
      continue;
    }
    if (
      (item.effectiveMacroConfirmation || item.macroConfirmation || 0) < 0.14
      && (item.coverageScore || 0) >= 0.45
      && CORE_MARKET_BUCKET_IDS.includes(item.targetBucketId)
      && !(
        ['market', 'supply_chain'].includes(item.dominantDomain)
        && (item.strength || 0) >= 0.46
        && (item.confidence || 0) >= 0.46
      )
    ) {
      blocked.push({ ...item, reason: 'low_macro_confirmation' });
      continue;
    }
    if (item.targetBucketId === 'defense') {
      const defenseEligible = (
        item.channel === 'defense_repricing'
        || ((item.strength || 0) >= 0.58 && (item.confidence || 0) >= 0.5 && ['conflict', 'military'].includes(item.dominantDomain))
      );
      if (!defenseEligible) {
        blocked.push({ ...item, reason: 'weak_defense_confirmation' });
        continue;
      }
    }
    if (item.consequenceType === 'adjacent' && (item.reportableScore || 0) < (minScore + 0.06)) {
      blocked.push({ ...item, reason: 'adjacent_path_not_strong_enough' });
      continue;
    }
    if (usedSituations.has(item.situationId) && bucketCount >= 1) {
      blocked.push({ ...item, reason: 'situation_reportable_cap' });
      continue;
    }
    if (bucketCount >= (CORE_MARKET_BUCKET_IDS.includes(item.targetBucketId) ? 2 : 1)) {
      blocked.push({ ...item, reason: 'bucket_reportable_cap' });
      continue;
    }
    reportableItems.push(item);
    usedSituations.add(item.situationId);
    usedBuckets.set(item.targetBucketId, bucketCount + 1);
    if (reportableItems.length >= 6) break;
  }

  if (reportableItems.length === 0) {
    const fallback = internalItems.find((item) => (
      ['market', 'supply_chain'].includes(item.dominantDomain)
      && CORE_MARKET_BUCKET_IDS.includes(item.targetBucketId)
      && (item.reportableScore || 0) >= 0.3
      && (item.confidence || 0) >= 0.25
      && (
        (item.effectiveMacroConfirmation || item.macroConfirmation || 0) >= 0.1
        || ((item.criticalAlignment || 0) >= 0.35 && (item.criticalSignalLift || 0) >= 0.5)
        || (item.strength || 0) >= 0.46
        || (item.consequenceType === 'direct' && (item.reportableScore || 0) >= 0.3)
      )
    ));
    if (fallback) reportableItems.push(fallback);
  }

  return {
    summary: reportableItems.length
      ? `${reportableItems.length} reportable market consequences were selected from ${internalItems.length} active situation-to-market transmission paths.`
      : 'No market consequences were derived from the current transmission graph.',
    internalCount: internalItems.length,
    reportableCount: reportableItems.length,
    blockedCount: blocked.length,
    blockedSummary: {
      byReason: summarizeTypeCounts(blocked.map((item) => item.reason)),
      preview: blocked.slice(0, 6).map((item) => ({
        situationLabel: item.situationLabel,
        targetBucketLabel: item.targetBucketLabel,
        channel: item.channel,
        reason: item.reason,
        reportableScore: item.reportableScore,
      })),
    },
    internalItems,
    blocked,
    items: reportableItems,
  };
}

function buildSituationSimulationState(worldState, priorWorldState = null) {
  const actorRegistry = Array.isArray(worldState?.actorRegistry) ? worldState.actorRegistry : [];
  const branchStates = Array.isArray(worldState?.branchStates) ? worldState.branchStates : [];
  const supporting = Array.isArray(worldState?.evidenceLedger?.supporting) ? worldState.evidenceLedger.supporting : [];
  const counter = Array.isArray(worldState?.evidenceLedger?.counter) ? worldState.evidenceLedger.counter : [];
  const familyIndex = buildSituationFamilyIndex(worldState?.situationFamilies || []);
  const simulationSources = Array.isArray(worldState?.stateUnits) && worldState.stateUnits.length
    ? worldState.stateUnits
    : (worldState?.situationClusters || []);
  const marketContextIndex = buildSituationMarketContextIndex(
    worldState?.worldSignals,
    worldState?.marketTransmission,
    worldState?.marketState,
    simulationSources,
    worldState?.marketInputCoverage,
  );
  const priorSimulationState = priorWorldState?.simulationState;
  const compatiblePriorSimulations = priorSimulationState?.version === SIMULATION_STATE_VERSION
    ? (priorSimulationState?.situationSimulations || [])
    : [];
  const priorSimulations = new Map(compatiblePriorSimulations.map((item) => [item.situationId, item]));

  const situationSimulations = simulationSources.map((source) => {
    const sourceSituationIds = uniqueSortedStrings(source.sourceSituationIds || source.situationIds || [source.id]);
    const forecastIds = source.forecastIds || [];
    const actors = actorRegistry.filter((actor) => intersectAny(actor.forecastIds || [], forecastIds));
    const branches = branchStates.filter((branch) => forecastIds.includes(branch.forecastId));
    const supportingEvidence = supporting.filter((item) => forecastIds.includes(item.forecastId)).slice(0, 8);
    const counterEvidence = counter.filter((item) => forecastIds.includes(item.forecastId)).slice(0, 8);
    const priorSimulation = priorSimulations.get(source.id) || null;
    const family = source.familyId
      ? { id: source.familyId, label: source.familyLabel || '' }
      : (familyIndex.get(source.id) || null);
    const marketContext = marketContextIndex.bySituationId.get(source.id) || null;
    const rounds = [
      buildSimulationRound('round_1', source, { actors, branches, counterEvidence, supportiveEvidence: supportingEvidence, priorSimulation, marketContext }),
      buildSimulationRound('round_2', source, { actors, branches, counterEvidence, supportiveEvidence: supportingEvidence, priorSimulation, marketContext }),
      buildSimulationRound('round_3', source, { actors, branches, counterEvidence, supportiveEvidence: supportingEvidence, priorSimulation, marketContext }),
    ];
    const outcome = summarizeSimulationOutcome(rounds, source.dominantDomain || source.domains?.[0] || '');
    const effectChannelWeights = {};
    for (const round of rounds) {
      for (const item of round.effectChannels || []) {
        effectChannelWeights[item.type] = (effectChannelWeights[item.type] || 0) + (item.count || 0);
      }
    }
    const effectChannelCounts = pickTopCountEntries(effectChannelWeights, 6);

    return {
      situationId: source.id,
      sourceSituationIds,
      stateKind: source.stateKind || '',
      familyId: family?.id || '',
      familyLabel: source.familyLabel || family?.label || '',
      label: source.label,
      dominantRegion: source.dominantRegion || source.regions?.[0] || '',
      dominantDomain: source.dominantDomain || source.domains?.[0] || '',
      avgProbability: Number(source.avgProbability || 0),
      avgConfidence: Number(source.avgConfidence || 0),
      regions: source.regions || [],
      domains: source.domains || [],
      forecastIds: forecastIds.slice(0, 12),
      actorIds: actors.map((actor) => actor.id).slice(0, 8),
      branchIds: branches.map((branch) => branch.id).slice(0, 10),
      pressureSignals: (source.topSignals || []).slice(0, 5),
      stabilizers: uniqueSortedStrings(counterEvidence.map((item) => item.type).filter(Boolean)).slice(0, 5),
      constraints: uniqueSortedStrings([
        ...actors.flatMap((actor) => actor.constraints || []),
        ...counterEvidence.map((item) => item.summary || item.type).filter(Boolean),
      ]).slice(0, 6),
      actorPostures: actors.slice(0, 6).map((actor) => ({
        id: actor.id,
        name: actor.name,
        influenceScore: actor.influenceScore,
        domains: actor.domains,
        regions: actor.regions,
        likelyActions: (actor.likelyActions || []).slice(0, 3),
      })),
      branchSeeds: branches.slice(0, 6).map((branch) => ({
        id: branch.id,
        kind: branch.kind,
        title: branch.title,
        projectedProbability: branch.projectedProbability,
        probabilityDelta: branch.probabilityDelta,
      })),
      marketContext,
      effectChannels: effectChannelCounts,
      actionPlan: rounds.map((round) => ({
        stage: round.stage,
        actions: (round.actions || []).map((action) => ({
          actorId: action.actorId,
          actorName: action.actorName,
          summary: action.summary,
          intent: action.intent,
          channels: action.channels || [],
          pressureContribution: action.pressureContribution,
          stabilizationContribution: action.stabilizationContribution,
        })),
      })),
      rounds,
      ...outcome,
    };
  });

  const actionLedger = buildSimulationActionLedger(situationSimulations);
  const interactionLedger = buildSimulationInteractionLedger(actionLedger, situationSimulations);
  const reportableInteractionLedger = buildReportableInteractionLedger(interactionLedger, situationSimulations);
  const blockedInteractions = Array.isArray(reportableInteractionLedger.blocked) ? reportableInteractionLedger.blocked : [];
  const replayTimeline = buildSimulationReplayTimeline(situationSimulations, actionLedger, interactionLedger);
  const internalEffects = buildCrossSituationEffects({
    situationSimulations,
    interactionLedger,
    reportableInteractionLedger,
  }, {
    mode: 'internal',
  });
  const reportableEffects = buildCrossSituationEffects({
    situationSimulations,
    interactionLedger,
    reportableInteractionLedger,
  }, {
    mode: 'reportable',
  });
  const blockedEffects = Array.isArray(reportableEffects.blocked) ? reportableEffects.blocked : [];
  const environmentSpec = buildSimulationEnvironmentSpec(worldState, situationSimulations, priorWorldState);
  const memoryMutations = buildSimulationMemoryMutations(worldState, {
    situationSimulations,
    actionLedger,
    interactionLedger,
    reportableInteractionLedger,
    reportableEffects,
  }, priorWorldState);
  const causalGraph = buildSimulationCausalGraph({
    situationSimulations,
    reportableInteractionLedger,
    reportableEffects,
    memoryMutations,
  }, priorWorldState);
  const causalReplay = buildSimulationCausalReplayChains({
    situationSimulations,
    actionLedger,
    reportableInteractionLedger,
    reportableEffects,
    causalGraph,
  });
  const marketConsequences = buildSimulationMarketConsequences({
    situationSimulations,
  }, worldState?.marketState, {
    marketInputCoverage: worldState?.marketInputCoverage,
  });

  const postureCounts = summarizeTypeCounts(situationSimulations.map((item) => item.posture));
  const summary = situationSimulations.length
    ? `${situationSimulations.length} simulation units were derived from canonical state units and advanced through 3 deterministic rounds, producing ${postureCounts.escalatory || 0} escalatory, ${postureCounts.contested || 0} contested, and ${postureCounts.constrained || 0} constrained paths.`
    : 'No simulation units were derived from the current run.';

  const roundTransitions = ['round_1', 'round_2', 'round_3'].map((stage) => {
    const roundSlice = situationSimulations.map((item) => item.rounds.find((round) => round.stage === stage)).filter(Boolean);
    const avgNetPressure = roundSlice.length
      ? +(roundSlice.reduce((sum, round) => sum + (round.netPressure || 0), 0) / roundSlice.length).toFixed(3)
      : 0;
    return {
      stage,
      situationCount: roundSlice.length,
      avgNetPressure,
      leadSignals: pickTopCountEntries(summarizeTypeCounts(roundSlice.flatMap((round) => round.signalTypes || [])), 4),
      leadActions: uniqueSortedStrings(roundSlice.flatMap((round) => (round.actions || []).map((action) => action.summary).filter(Boolean))).slice(0, 6),
    };
  });

  return {
    version: SIMULATION_STATE_VERSION,
    summary,
    totalSituationSimulations: situationSimulations.length,
    totalRounds: roundTransitions.length,
    postureCounts,
    roundTransitions,
    actionLedger,
    interactionLedger,
    reportableInteractionLedger,
    blockedInteractionSummary: summarizeBlockedInteractions(blockedInteractions),
    internalEffects,
    reportableEffects,
    blockedEffects,
    blockedEffectSummary: summarizeBlockedEffects(blockedEffects),
    replayTimeline,
    environmentSpec,
    memoryMutations,
    causalGraph,
    causalReplay,
    marketConsequences,
    situationSimulations,
  };
}

function buildSimulationActionLedger(situationSimulations = []) {
  const stageOrder = new Map([
    ['round_1', 1],
    ['round_2', 2],
    ['round_3', 3],
  ]);
  const ledger = [];
  let ordinal = 0;

  for (const simulation of situationSimulations || []) {
    for (const round of (simulation.rounds || [])) {
      for (const action of (round.actions || [])) {
        ordinal += 1;
        ledger.push({
          id: `simact-${hashSituationKey([
            simulation.situationId,
            round.stage,
            action.actorId || action.actorName || String(ordinal),
            String(ordinal),
          ])}`,
          ordinal,
          stage: round.stage,
          stageOrder: stageOrder.get(round.stage) || 0,
          situationId: simulation.situationId,
          situationLabel: simulation.label,
          familyId: simulation.familyId,
          familyLabel: simulation.familyLabel,
          dominantDomain: simulation.dominantDomain,
          dominantRegion: simulation.dominantRegion,
          regions: simulation.regions || [],
          actorId: action.actorId || '',
          actorName: action.actorName || '',
          category: action.category || '',
          actorSpecificity: Number(action.actorSpecificity || 0),
          summary: action.summary || '',
          intent: action.intent || 'mixed',
          channels: action.channels || [],
          pressureContribution: Number(action.pressureContribution || 0),
          stabilizationContribution: Number(action.stabilizationContribution || 0),
          posture: simulation.posture,
          postureScore: simulation.postureScore,
        });
      }
    }
  }

  return ledger;
}

function buildSimulationInteractionLedger(actionLedger = [], situationSimulations = []) {
  const simulationsById = new Map((situationSimulations || []).map((item) => [item.situationId, item]));
  const ledger = [];
  const stageGroups = new Map();

  for (const action of actionLedger || []) {
    const group = stageGroups.get(action.stage) || [];
    group.push(action);
    stageGroups.set(action.stage, group);
  }

  function pickInteractionChannel(sharedChannels, sourceSimulation, targetSimulation) {
    const targetSensitivity = new Set(getTargetSensitivityChannels(targetSimulation?.dominantDomain));
    const sourceChannelWeights = new Map(
      (sourceSimulation?.effectChannels || []).map((item) => [item.type, Number(item.count || 0)])
    );
    return uniqueSortedStrings(sharedChannels)
      .map((channel) => ({
        channel,
        usable: targetSensitivity.has(channel) ? 1 : 0,
        weight: sourceChannelWeights.get(channel) || 0,
      }))
      .sort((a, b) => b.usable - a.usable || b.weight - a.weight || a.channel.localeCompare(b.channel))[0]?.channel || '';
  }

  function pushInteraction(source, target, stage) {
    if (source.situationId === target.situationId) return;

    const sourceSpecificity = scoreActorSpecificity(source);
    const targetSpecificity = scoreActorSpecificity(target);
    const avgSpecificity = (sourceSpecificity + targetSpecificity) / 2;
    const sharedActor = source.actorId && target.actorId && source.actorId === target.actorId
      && avgSpecificity >= 0.75;
    const sharedChannels = uniqueSortedStrings((source.channels || []).filter((channel) => (target.channels || []).includes(channel)));
    const familyLink = source.familyId && target.familyId && source.familyId === target.familyId;
    const regionLink = intersectCount(source.regions || [], target.regions || []) > 0;
    const sameIntent = source.intent === target.intent;
    const opposingIntent = (
      (source.intent === 'pressure' && target.intent === 'stabilizing')
      || (source.intent === 'stabilizing' && target.intent === 'pressure')
    );

    const score = (sharedActor ? 4 : 0)
      + (sharedChannels.length * 2)
      + (familyLink ? 1 : 0)
      + (regionLink ? 1.5 : 0)
      + (sameIntent ? 0.5 : 0)
      + (opposingIntent ? 0.75 : 0)
      + (avgSpecificity * 1.25);
    if (score < 3) return;

    let interactionType = 'coupling';
    if (sharedActor) interactionType = 'actor_carryover';
    else if (opposingIntent) interactionType = 'constraint';
    else if (sameIntent && sharedChannels.length > 0) interactionType = 'reinforcement';
    else if (sharedChannels.length > 0) interactionType = 'spillover';

    const sourceSimulation = simulationsById.get(source.situationId) || null;
    const targetSimulation = simulationsById.get(target.situationId) || null;
    const strongestChannel = pickInteractionChannel(sharedChannels, sourceSimulation, targetSimulation);

    ledger.push({
      id: `simint-${hashSituationKey([
        stage,
        source.situationId,
        target.situationId,
        strongestChannel || interactionType,
        source.actorId || source.actorName || '',
        target.actorId || target.actorName || '',
      ])}`,
      stage,
      sourceSituationId: source.situationId,
      sourceLabel: source.situationLabel,
      sourceFamilyId: source.familyId,
      sourceFamilyLabel: source.familyLabel,
      sourceActorId: source.actorId,
      sourceActorName: source.actorName,
      sourceIntent: source.intent,
      sourceDomain: source.dominantDomain,
      targetSituationId: target.situationId,
      targetLabel: target.situationLabel,
      targetFamilyId: target.familyId,
      targetFamilyLabel: target.familyLabel,
      targetActorId: target.actorId,
      targetActorName: target.actorName,
      targetIntent: target.intent,
      targetDomain: target.dominantDomain,
      interactionType,
      strongestChannel,
      sharedChannels,
      sharedActor,
      familyLink,
      regionLink,
      actorSpecificity: +avgSpecificity.toFixed(3),
      directLinkCount: (sharedActor ? 1 : 0) + (regionLink ? 1 : 0) + (sharedChannels.length > 0 ? 1 : 0),
      score: +score.toFixed(3),
      confidence: +((
        (sharedActor ? 0.38 : 0) +
        (regionLink ? 0.22 : 0) +
        Math.min(0.26, sharedChannels.length * 0.12) +
        (familyLink ? 0.06 : 0) +
        (avgSpecificity * 0.22)
      )).toFixed(3),
      summary: `${source.actorName || 'An actor'} in ${source.situationLabel} ${interactionType.replace(/_/g, ' ')} with ${target.actorName || 'another actor'} in ${target.situationLabel} during ${stage.replace('_', ' ')}.`,
      sourcePosture: sourceSimulation?.posture || '',
      sourcePostureScore: sourceSimulation?.postureScore || 0,
      targetPosture: targetSimulation?.posture || '',
      targetPostureScore: targetSimulation?.postureScore || 0,
    });
  }

  for (const [stage, actions] of stageGroups.entries()) {
    for (let i = 0; i < actions.length; i++) {
      for (let j = i + 1; j < actions.length; j++) {
        const source = actions[i];
        const target = actions[j];
        pushInteraction(source, target, stage);
        pushInteraction(target, source, stage);
      }
    }
  }

  return ledger
    .sort((a, b) => b.score - a.score || a.stage.localeCompare(b.stage) || a.sourceLabel.localeCompare(b.sourceLabel))
    .slice(0, 80);
}

function buildSimulationReplayTimeline(situationSimulations = [], actionLedger = [], interactionLedger = []) {
  const stages = ['round_1', 'round_2', 'round_3'];
  return stages.map((stage) => {
    const roundSlice = (situationSimulations || [])
      .map((item) => item.rounds.find((round) => round.stage === stage))
      .filter(Boolean);
    const actions = (actionLedger || []).filter((item) => item.stage === stage);
    const interactions = (interactionLedger || []).filter((item) => item.stage === stage);
    const postureMix = summarizeTypeCounts(
      (situationSimulations || [])
        .filter((item) => item.rounds.some((round) => round.stage === stage))
        .map((item) => item.posture)
    );
    return {
      stage,
      situationCount: roundSlice.length,
      actionCount: actions.length,
      interactionCount: interactions.length,
      avgNetPressure: roundSlice.length
        ? +(roundSlice.reduce((sum, round) => sum + (round.netPressure || 0), 0) / roundSlice.length).toFixed(3)
        : 0,
      postureMix,
      leadSignals: pickTopCountEntries(summarizeTypeCounts(roundSlice.flatMap((round) => round.signalTypes || [])), 4),
      leadChannels: pickTopCountEntries(summarizeTypeCounts(actions.flatMap((action) => action.channels || [])), 5),
      leadActions: uniqueSortedStrings(actions.map((action) => action.summary).filter(Boolean)).slice(0, 6),
      leadInteractions: (interactions || []).slice(0, 5).map((item) => ({
        sourceLabel: item.sourceLabel,
        targetLabel: item.targetLabel,
        interactionType: item.interactionType,
        strongestChannel: item.strongestChannel,
        score: item.score,
      })),
    };
  });
}

function buildReportableInteractionLedger(interactionLedger = [], situationSimulations = []) {
  const simulationIndex = new Map((situationSimulations || []).map((item) => [item.situationId, item]));
  const reportable = [];
  const blocked = [];

  for (const item of (interactionLedger || [])) {
    const source = simulationIndex.get(item.sourceSituationId);
    const target = simulationIndex.get(item.targetSituationId);
    if (!source || !target || !item.strongestChannel) continue;
    const directOverlap = (
      intersectCount(source.regions || [], target.regions || []) > 0
      || intersectCount(source.actorIds || [], target.actorIds || []) > 0
    );
    const specificity = Number(item.actorSpecificity || 0);
    const confidence = Number(item.confidence || 0);
    const score = Number(item.score || 0);
    const politicalChannel = item.strongestChannel === 'political_pressure';
    const sharedActor = Boolean(item.sharedActor) || intersectCount(source.actorIds || [], target.actorIds || []) > 0;
    const regionLink = Boolean(item.regionLink) || intersectCount(source.regions || [], target.regions || []) > 0;
    const crossTheater = isCrossTheaterPair(source.regions || [], target.regions || []);
    const bucketOverlap = intersectCount(source.marketContext?.linkedBucketIds || [], target.marketContext?.linkedBucketIds || []);
    const macroSupport = Math.max(
      Number(source.marketContext?.confirmationScore || 0),
      Number(target.marketContext?.confirmationScore || 0),
    );
    const purelyPoliticalPair = source.dominantDomain === 'political' && target.dominantDomain === 'political';

    if (item.interactionType === 'actor_carryover' && specificity < 0.62) {
      blocked.push({ ...item, reason: 'low_actor_specificity' });
      continue;
    }
    if (politicalChannel) {
      if (!regionLink && !sharedActor) {
        blocked.push({ ...item, reason: 'generic_political_link' });
        continue;
      }
      if (crossTheater) {
        const structuralPoliticalCarryover = purelyPoliticalPair
          && sharedActor
          && specificity >= 0.82
          && confidence >= 0.7
          && score >= 5.4;
        if (!structuralPoliticalCarryover) {
          if (!sharedActor || specificity < 0.88 || confidence < 0.72 || score < 5.7) {
            blocked.push({ ...item, reason: 'cross_theater_political_carryover' });
            continue;
          }
          if (!regionLink && macroSupport < 0.5 && bucketOverlap === 0) {
            blocked.push({ ...item, reason: 'low_macro_confirmation' });
            continue;
          }
          if (!regionLink && specificity < 0.9) {
            blocked.push({ ...item, reason: 'low_actor_specificity' });
            continue;
          }
        }
      } else {
        if (!regionLink && (!sharedActor || specificity < 0.82 || confidence < 0.68 || score < 5.4)) {
          blocked.push({ ...item, reason: 'political_without_strong_carryover' });
          continue;
        }
        if (regionLink && confidence < 0.62 && score < 4.9) {
          blocked.push({ ...item, reason: 'low_confidence' });
          continue;
        }
      }
    }
    if (confidence >= 0.72 && score >= 5) {
      reportable.push(item);
      continue;
    }
    if (directOverlap && confidence >= 0.58 && score >= 4.5) {
      reportable.push(item);
      continue;
    }
    if (sharedActor && specificity >= 0.7 && confidence >= 0.56) {
      reportable.push(item);
      continue;
    }
    blocked.push({ ...item, reason: directOverlap ? 'low_confidence' : 'score_below_threshold' });
  }

  const ordered = reportable
    .sort((a, b) => b.confidence - a.confidence || b.score - a.score || a.sourceLabel.localeCompare(b.sourceLabel));
  ordered.blocked = blocked;
  ordered.blockedSummary = summarizeBlockedInteractions(blocked);
  return ordered;
}

function summarizeBlockedInteractions(blockedInteractions = []) {
  return {
    totalBlocked: blockedInteractions.length,
    byReason: summarizeTypeCounts((blockedInteractions || []).map((item) => item.reason)),
    preview: blockedInteractions
      .slice()
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || (b.score || 0) - (a.score || 0))
      .slice(0, 6)
      .map((item) => ({
        sourceLabel: item.sourceLabel,
        targetLabel: item.targetLabel,
        channel: item.strongestChannel || item.channel,
        interactionType: item.interactionType || '',
        reason: item.reason,
        confidence: item.confidence,
        score: item.score,
      })),
  };
}

function buildInteractionGroups(interactions = []) {
  const groups = new Map();

  for (const interaction of interactions || []) {
    if (!interaction?.strongestChannel) continue;
    const key = [
      interaction.sourceSituationId,
      interaction.targetSituationId,
      interaction.strongestChannel,
    ].join(':');
    const group = groups.get(key) || {
      sourceSituationId: interaction.sourceSituationId,
      targetSituationId: interaction.targetSituationId,
      strongestChannel: interaction.strongestChannel,
      sourceLabel: interaction.sourceLabel,
      targetLabel: interaction.targetLabel,
      sourceFamilyId: interaction.sourceFamilyId,
      sourceFamilyLabel: interaction.sourceFamilyLabel,
      targetFamilyId: interaction.targetFamilyId,
      targetFamilyLabel: interaction.targetFamilyLabel,
      score: 0,
      stages: new Set(),
      sourceActors: new Set(),
      targetActors: new Set(),
      interactionTypes: new Set(),
      confidenceTotal: 0,
      confidenceCount: 0,
      actorSpecificityTotal: 0,
      actorSpecificityCount: 0,
      directLinkCount: 0,
      sharedActor: false,
      regionLink: false,
    };
    group.score += Number(interaction.score || 0);
    group.stages.add(interaction.stage);
    if (interaction.sourceActorName) group.sourceActors.add(interaction.sourceActorName);
    if (interaction.targetActorName) group.targetActors.add(interaction.targetActorName);
    if (interaction.interactionType) group.interactionTypes.add(interaction.interactionType);
    if (Number.isFinite(Number(interaction.confidence))) {
      group.confidenceTotal += Number(interaction.confidence || 0);
      group.confidenceCount += 1;
    }
    if (Number.isFinite(Number(interaction.actorSpecificity))) {
      group.actorSpecificityTotal += Number(interaction.actorSpecificity || 0);
      group.actorSpecificityCount += 1;
    }
    group.directLinkCount = Math.max(group.directLinkCount, Number(interaction.directLinkCount || 0));
    group.sharedActor = group.sharedActor || Boolean(interaction.sharedActor);
    group.regionLink = group.regionLink || Boolean(interaction.regionLink);
    groups.set(key, group);
  }

  // Internal grouping helper for report/effect synthesis. We intentionally keep
  // Sets on the grouped object because downstream callers use `.size` and do not
  // serialize this structure directly.
  return [...groups.values()].map((group) => ({
    ...group,
    avgConfidence: group.confidenceCount
      ? +(group.confidenceTotal / group.confidenceCount).toFixed(3)
      : 0,
    avgActorSpecificity: group.actorSpecificityCount
      ? +(group.actorSpecificityTotal / group.actorSpecificityCount).toFixed(3)
      : 0,
  }));
}

function buildCausalGraphKey(sourceSituationId, targetSituationId, effectClass) {
  return `${sourceSituationId}:${targetSituationId}:${effectClass}`;
}

function buildSimulationCausalGraph(simulationState, priorWorldState = null) {
  const simulations = Array.isArray(simulationState?.situationSimulations) ? simulationState.situationSimulations : [];
  const reportableEffects = Array.isArray(simulationState?.reportableEffects) ? simulationState.reportableEffects : [];
  const groupedInteractions = buildInteractionGroups(simulationState?.reportableInteractionLedger || []);
  const linkMemory = new Map(
    (simulationState?.memoryMutations?.links || []).map((item) => [
      `${item.sourceSituationId}:${item.targetSituationId}:${item.strongestChannel}`,
      item,
    ]),
  );
  const priorCausalGraph = priorWorldState?.simulationState?.causalGraph?.version === SIMULATION_STATE_VERSION
    ? priorWorldState.simulationState.causalGraph
    : null;
  const priorEdges = new Map((priorCausalGraph?.edges || []).map((edge) => [buildCausalGraphKey(edge.sourceSituationId, edge.targetSituationId, edge.effectClass), edge]));
  const groupedEdges = new Map();

  for (const effect of reportableEffects) {
    const key = buildCausalGraphKey(effect.sourceSituationId, effect.targetSituationId, effect.effectClass);
    const interactionMatches = groupedInteractions.filter((group) => (
      group.sourceSituationId === effect.sourceSituationId
      && group.targetSituationId === effect.targetSituationId
      && (group.strongestChannel === effect.channel
        || inferSystemEffectRelationFromChannel(group.strongestChannel, simulations.find((item) => item.situationId === effect.targetSituationId)?.dominantDomain) === effect.relation)
    ));
    const entry = groupedEdges.get(key) || {
      edgeId: `edge-${hashSituationKey([effect.sourceSituationId, effect.targetSituationId, effect.effectClass])}`,
      sourceSituationId: effect.sourceSituationId,
      sourceLabel: effect.sourceLabel,
      sourceFamilyId: effect.sourceFamilyId || '',
      sourceFamilyLabel: effect.sourceFamilyLabel || '',
      targetSituationId: effect.targetSituationId,
      targetLabel: effect.targetLabel,
      targetFamilyId: effect.targetFamilyId || '',
      targetFamilyLabel: effect.targetFamilyLabel || '',
      effectClass: effect.effectClass,
      relations: new Set(),
      channels: new Set(),
      supportingChannels: new Set(),
      stages: new Set(),
      confidence: 0,
      score: 0,
      memorySupport: 0,
      directLinkCount: 0,
      sourcePosture: simulations.find((item) => item.situationId === effect.sourceSituationId)?.posture || '',
      sourcePostureScore: simulations.find((item) => item.situationId === effect.sourceSituationId)?.postureScore || 0,
      continuityStatus: 'new',
      continuityDelta: 0,
    };
    entry.relations.add(effect.relation);
    if (effect.channel) entry.channels.add(effect.channel);
    entry.confidence = Math.max(entry.confidence, Number(effect.confidence || 0));
    entry.score = Math.max(entry.score, Number(effect.score || 0));
    for (const match of interactionMatches) {
      entry.supportingChannels.add(match.strongestChannel);
      for (const stage of match.stages || []) entry.stages.add(stage);
      entry.directLinkCount = Math.max(entry.directLinkCount, Number(match.directLinkCount || 0));
      const memory = linkMemory.get(`${match.sourceSituationId}:${match.targetSituationId}:${match.strongestChannel}`);
      entry.memorySupport = Math.max(entry.memorySupport, Number(memory?.memoryStrength || 0));
    }
    groupedEdges.set(key, entry);
  }

  const edges = [...groupedEdges.values()].map((edge) => {
    const channels = uniqueSortedStrings([...(edge.channels || []), ...(edge.supportingChannels || [])]);
    const primaryChannel = channels
      .slice()
      .sort((left, right) => {
        const leftPriority = EFFECT_CLASS_PRIORITY[classifyEffectClass(left)] || 0;
        const rightPriority = EFFECT_CLASS_PRIORITY[classifyEffectClass(right)] || 0;
        return rightPriority - leftPriority || left.localeCompare(right);
      })[0] || '';
    const prior = priorEdges.get(buildCausalGraphKey(edge.sourceSituationId, edge.targetSituationId, edge.effectClass)) || null;
    const continuityDelta = prior
      ? +(((edge.confidence + (edge.memorySupport * 0.35)) - ((prior.confidence || 0) + ((prior.memorySupport || 0) * 0.35))).toFixed(3))
      : +(edge.confidence + (edge.memorySupport * 0.35)).toFixed(3);
    const continuityStatus = !prior
      ? 'new'
      : continuityDelta >= 0.06
        ? 'strengthening'
        : continuityDelta <= -0.06
          ? 'weakening'
          : 'persistent';
    return {
      edgeId: edge.edgeId,
      sourceSituationId: edge.sourceSituationId,
      sourceLabel: edge.sourceLabel,
      sourceFamilyId: edge.sourceFamilyId,
      sourceFamilyLabel: edge.sourceFamilyLabel,
      targetSituationId: edge.targetSituationId,
      targetLabel: edge.targetLabel,
      targetFamilyId: edge.targetFamilyId,
      targetFamilyLabel: edge.targetFamilyLabel,
      effectClass: edge.effectClass,
      primaryChannel,
      channel: primaryChannel,
      supportingChannels: channels,
      relation: [...edge.relations][0] || '',
      supportingRelations: uniqueSortedStrings([...edge.relations]),
      confidence: +edge.confidence.toFixed(3),
      score: +edge.score.toFixed(3),
      memorySupport: +edge.memorySupport.toFixed(3),
      directLinkCount: edge.directLinkCount,
      stageCount: edge.stages.size,
      stages: [...edge.stages].sort(),
      sourcePosture: edge.sourcePosture,
      sourcePostureScore: edge.sourcePostureScore,
      continuityStatus,
      continuityDelta,
      summary: `${edge.sourceLabel} is likely to feed ${[...edge.relations][0] || 'spillover pressure'} into ${edge.targetLabel}, reinforced by ${edge.stages.size || 1} stage(s), ${channels.join(', ') || 'mixed channels'}, ${(edge.confidence * 100).toFixed(0)}% effect confidence, and ${Math.round(edge.memorySupport * 100)}% memory support.`,
    };
  }).sort((a, b) => (
    b.confidence - a.confidence
    || b.memorySupport - a.memorySupport
    || b.score - a.score
    || a.sourceLabel.localeCompare(b.sourceLabel)
    || a.targetLabel.localeCompare(b.targetLabel)
  ));

  const resolvedEdges = (priorCausalGraph?.edges || [])
    .filter((prior) => !groupedEdges.has(buildCausalGraphKey(prior.sourceSituationId, prior.targetSituationId, prior.effectClass)))
    .slice(0, 12)
    .map((edge) => ({
      edgeId: edge.edgeId,
      sourceSituationId: edge.sourceSituationId,
      sourceLabel: edge.sourceLabel,
      targetSituationId: edge.targetSituationId,
      targetLabel: edge.targetLabel,
      effectClass: edge.effectClass,
      primaryChannel: edge.primaryChannel,
      continuityStatus: 'resolved',
      confidence: edge.confidence,
      memorySupport: edge.memorySupport || 0,
    }));

  const continuityCounts = summarizeTypeCounts(edges.map((edge) => edge.continuityStatus));
  continuityCounts.resolved = resolvedEdges.length;
  const summary = edges.length
    ? `${edges.length} canonical causal edges were synthesized from reportable effects, with ${continuityCounts.new || 0} new, ${continuityCounts.persistent || 0} persistent, ${continuityCounts.strengthening || 0} strengthening, ${continuityCounts.weakening || 0} weakening, and ${continuityCounts.resolved || 0} resolved edges against prior simulation memory.`
    : 'No canonical causal edges were synthesized from the current simulation output.';

  return {
    version: SIMULATION_STATE_VERSION,
    summary,
    continuityCounts,
    edges: edges.slice(0, 12),
    resolvedEdges,
  };
}

function computeReportableEffectConfidence(group, source, target, strongestChannelWeight) {
  const structuralSharedActor = group.sharedActor || intersectCount(source?.actorIds || [], target?.actorIds || []) > 0;
  const structuralRegionLink = group.regionLink || intersectCount(source?.regions || [], target?.regions || []) > 0;
  const structuralDirectLinkCount = Math.max(
    Number(group.directLinkCount || 0),
    (structuralSharedActor ? 1 : 0) + (structuralRegionLink ? 1 : 0) + (strongestChannelWeight > 0 ? 1 : 0),
  );
  const normalizedScore = clamp01(Number(group.score || 0) / 8);
  const directLinkScore = clamp01(structuralDirectLinkCount / 3);
  const stageScore = clamp01((group.stages?.size || 0) / 3);
  const avgConfidence = clamp01(group.confidenceCount ? Number(group.avgConfidence || 0) : Math.max(normalizedScore * 0.9, directLinkScore * 0.8));
  const actorSpecificity = clamp01(group.actorSpecificityCount ? Number(group.avgActorSpecificity || 0) : (structuralSharedActor ? 0.78 : 0.62));
  const channelWeight = clamp01(Number(strongestChannelWeight || 0) / 3);
  // Weight hierarchy is deliberate:
  // - interaction score and observed confidence dominate
  // - direct structural linkage is next
  // - stage diversity adds supporting context
  // - actor specificity helps separate named/credible carryover from generic links
  // - channel weight is informative but secondary
  let confidence = (
    normalizedScore * 0.28 +
    directLinkScore * 0.2 +
    stageScore * 0.14 +
    avgConfidence * 0.2 +
    actorSpecificity * 0.1 +
    channelWeight * 0.08
  );
  if (structuralSharedActor) confidence += 0.04;
  if (structuralRegionLink) confidence += 0.05;
  if (group.strongestChannel === 'political_pressure' && !structuralRegionLink) confidence -= 0.14;
  if (group.strongestChannel === 'political_pressure' && !structuralSharedActor) confidence -= 0.1;
  if ((source?.dominantDomain || '') === 'political' && (target?.dominantDomain || '') !== 'political') confidence -= 0.05;
  return +clamp01(confidence).toFixed(3);
}

function describeSimulationPosture(posture) {
  if (posture === 'escalatory') return 'escalatory';
  if (posture === 'constrained') return 'constrained';
  return 'contested';
}

function buildSituationOutcomeSummaries(simulationState) {
  const simulations = Array.isArray(simulationState?.situationSimulations) ? simulationState.situationSimulations : [];
  return simulations
    .slice()
    .sort((a, b) => (b.postureScore || 0) - (a.postureScore || 0) || a.label.localeCompare(b.label))
    .map((item) => {
      const [r1, r2, r3] = item.rounds || [];
      return {
        situationId: item.situationId,
        label: item.label,
        posture: item.posture,
        postureScore: item.postureScore,
        summary: `${item.label} moved through ${r1?.lead || 'initial interpretation'}, ${r2?.lead || 'interaction responses'}, and ${r3?.lead || 'regional effects'} before resolving to a ${describeSimulationPosture(item.posture)} posture at ${roundPct(item.postureScore)}.`,
        rounds: (item.rounds || []).map((round) => ({
          stage: round.stage,
          lead: round.lead,
          netPressure: round.netPressure,
          actions: (round.actions || []).map((action) => action.summary),
        })),
      };
    });
}

function buildSimulationReportInputs(worldState) {
  const simulations = Array.isArray(worldState?.simulationState?.situationSimulations)
    ? worldState.simulationState.situationSimulations
    : [];
  const reportInputs = simulations.map((item) => ({
    situationId: item.situationId,
    stateKind: item.stateKind || '',
    sourceSituationIds: item.sourceSituationIds || [],
    familyId: item.familyId,
    familyLabel: item.familyLabel,
    label: item.label,
    posture: item.posture,
    postureScore: item.postureScore,
    dominantRegion: item.dominantRegion,
    dominantDomain: item.dominantDomain,
    actorCount: (item.actorIds || []).length,
    branchCount: (item.branchIds || []).length,
    actionCount: (item.actionPlan || []).reduce((sum, round) => sum + ((round.actions || []).length), 0),
    pressureSignals: (item.pressureSignals || []).map((signal) => signal.type),
    effectChannels: (item.effectChannels || []).map((item) => item.type),
    stabilizers: item.stabilizers || [],
    constraints: item.constraints || [],
      rounds: (item.rounds || []).map((round) => ({
        stage: round.stage,
        lead: round.lead,
        netPressure: round.netPressure,
        pressureDelta: round.pressureDelta,
        stabilizationDelta: round.stabilizationDelta,
        actionMix: round.actionMix || {},
        actions: (round.actions || []).map((action) => action.summary),
      })),
    }));

  return {
    summary: reportInputs.length
      ? `${reportInputs.length} simulation report inputs are available from round-based canonical state evolution.`
      : 'No simulation report inputs are available.',
    inputs: reportInputs,
  };
}

function inferSystemEffectRelation(sourceDomain, targetDomain) {
  const key = `${sourceDomain}->${targetDomain}`;
  const relationMap = {
    'conflict->market': 'commodity pricing pressure',
    'conflict->supply_chain': 'logistics disruption',
    'conflict->infrastructure': 'service disruption',
    'political->market': 'policy repricing',
    'political->conflict': 'escalation risk',
    'political->supply_chain': 'trade friction',
    'cyber->infrastructure': 'service degradation',
    'cyber->market': 'risk repricing',
    'infrastructure->market': 'capacity shock',
    'infrastructure->supply_chain': 'throughput disruption',
    'supply_chain->market': 'cost pass-through',
  };
  return relationMap[key] || '';
}

const MACRO_REGION_MAP = {
  'Israel': 'MENA', 'Iran': 'MENA', 'Syria': 'MENA', 'Iraq': 'MENA', 'Lebanon': 'MENA',
  'Gaza': 'MENA', 'Egypt': 'MENA', 'Saudi Arabia': 'MENA', 'Yemen': 'MENA', 'Jordan': 'MENA',
  'Turkey': 'MENA', 'Libya': 'MENA', 'Middle East': 'MENA', 'Persian Gulf': 'MENA',
  'Red Sea': 'MENA', 'Strait of Hormuz': 'MENA', 'Eastern Mediterranean': 'MENA',
  'Taiwan': 'EAST_ASIA', 'China': 'EAST_ASIA', 'Japan': 'EAST_ASIA', 'South Korea': 'EAST_ASIA',
  'North Korea': 'EAST_ASIA', 'Western Pacific': 'EAST_ASIA', 'South China Sea': 'EAST_ASIA',
  'United States': 'AMERICAS', 'Brazil': 'AMERICAS', 'Mexico': 'AMERICAS', 'Cuba': 'AMERICAS',
  'Canada': 'AMERICAS', 'Colombia': 'AMERICAS', 'Venezuela': 'AMERICAS', 'Argentina': 'AMERICAS',
  'Peru': 'AMERICAS', 'Chile': 'AMERICAS',
  'Russia': 'EUROPE', 'Ukraine': 'EUROPE', 'Germany': 'EUROPE', 'France': 'EUROPE',
  'United Kingdom': 'EUROPE', 'Poland': 'EUROPE', 'Estonia': 'EUROPE', 'Latvia': 'EUROPE',
  'Lithuania': 'EUROPE', 'Baltic Sea': 'EUROPE', 'Black Sea': 'EUROPE',
  'Kerch Strait': 'EUROPE', 'Sweden': 'EUROPE', 'Finland': 'EUROPE', 'Norway': 'EUROPE',
  'Romania': 'EUROPE', 'Bulgaria': 'EUROPE',
  'India': 'SOUTH_ASIA', 'Pakistan': 'SOUTH_ASIA', 'Afghanistan': 'SOUTH_ASIA',
  'Bangladesh': 'SOUTH_ASIA', 'Myanmar': 'SOUTH_ASIA',
  'Congo': 'AFRICA', 'Sudan': 'AFRICA', 'Ethiopia': 'AFRICA', 'Nigeria': 'AFRICA',
  'Somalia': 'AFRICA', 'Mali': 'AFRICA', 'Mozambique': 'AFRICA', 'Sahel': 'AFRICA',
};

const CROSS_THEATER_EXEMPT_CHANNELS = new Set(['cyber_disruption', 'market_repricing']);
const CROSS_THEATER_ACTOR_SPECIFICITY_MIN = 0.90;
const EFFECT_CLASS_PRIORITY = {
  security_spillover: 5,
  cyber_spillover: 4,
  logistics_spillover: 4,
  market_spillover: 3,
  political_spillover: 2,
  general_spillover: 1,
};

function getMacroRegion(regions = []) {
  for (const region of regions) {
    if (MACRO_REGION_MAP[region]) return MACRO_REGION_MAP[region];
  }
  return null;
}

function isCrossTheaterPair(sourceRegions, targetRegions) {
  const src = getMacroRegion(sourceRegions);
  const tgt = getMacroRegion(targetRegions);
  return !!(src && tgt && src !== tgt);
}

function classifyEffectClass(channel, relation = '') {
  if (channel === 'security_escalation') return 'security_spillover';
  if (channel === 'cyber_disruption') return 'cyber_spillover';
  if (channel === 'logistics_disruption' || channel === 'service_disruption') return 'logistics_spillover';
  if (channel === 'market_repricing') return 'market_spillover';
  if (channel === 'political_pressure' || relation === 'regional pressure transfer') return 'political_spillover';
  return 'general_spillover';
}

function getEffectClassThreshold(effectClass, context = {}) {
  const { crossTheater = false, sameMacroRegion = false, directStructuralLink = false } = context;
  if (effectClass === 'political_spillover') {
    if (crossTheater) return 0.74;
    if (sameMacroRegion) return 0.62;
    return 0.66;
  }
  if (effectClass === 'security_spillover') {
    if (sameMacroRegion && directStructuralLink) return 0.46;
    return crossTheater ? 0.6 : 0.52;
  }
  if (effectClass === 'cyber_spillover') {
    return crossTheater ? 0.54 : 0.5;
  }
  if (effectClass === 'logistics_spillover') {
    return crossTheater ? 0.56 : 0.5;
  }
  if (effectClass === 'market_spillover') {
    return crossTheater ? 0.58 : 0.52;
  }
  return crossTheater ? 0.58 : 0.5;
}

function getEffectClassScoreThreshold(effectClass, context = {}) {
  const { crossTheater = false, sameMacroRegion = false, repeatedStages = 1 } = context;
  if (effectClass === 'political_spillover') return crossTheater ? 5.4 : 4.8;
  if (effectClass === 'security_spillover') return sameMacroRegion && repeatedStages >= 2 ? 4.2 : 4.8;
  if (effectClass === 'cyber_spillover') return repeatedStages >= 2 ? 4.2 : 4.8;
  if (effectClass === 'logistics_spillover') return repeatedStages >= 2 ? 4.2 : 4.8;
  return crossTheater ? 5 : 4.8;
}

function summarizeBlockedEffects(blockedEffects = []) {
  const reasonCounts = summarizeTypeCounts((blockedEffects || []).map((item) => item.reason));
  return {
    totalBlocked: blockedEffects.length,
    byReason: reasonCounts,
    preview: blockedEffects
      .slice()
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || (b.score || 0) - (a.score || 0))
      .slice(0, 6)
      .map((item) => ({
        sourceLabel: item.sourceLabel,
        targetLabel: item.targetLabel,
        channel: item.channel,
        effectClass: item.effectClass,
        reason: item.reason,
        confidence: item.confidence,
        score: item.score,
      })),
  };
}

function canEmitCrossSituationEffect(source, strongestChannel, strongestChannelWeight, hasDirectStructuralLink = false) {
  if (!strongestChannel) return false;
  const profile = getSimulationDomainProfile(source?.dominantDomain || '');
  const constrainedThreshold = profile.constrainedThreshold ?? 0.36;
  if ((source?.posture || '') === 'constrained') return false;
  if ((source?.postureScore || 0) <= constrainedThreshold) return false;
  if (
    (source?.posture || '') === 'contested'
    && (source?.postureScore || 0) < Math.max(constrainedThreshold + 0.08, 0.46)
    && strongestChannelWeight < 2
    && !hasDirectStructuralLink
  ) return false;
  if ((source?.posture || '') !== 'escalatory' && (source?.totalPressure || 0) <= (source?.totalStabilization || 0)) return false;
  return true;
}

function buildInteractionWatchlist(interactions = []) {
  const groupedPairs = new Map();
  for (const item of buildInteractionGroups(interactions)) {
    const key = `${item.sourceSituationId}:${item.targetSituationId}`;
    const pair = groupedPairs.get(key) || {
      sourceLabel: item.sourceLabel,
      targetLabel: item.targetLabel,
      channels: new Set(),
      stages: new Set(),
      interactionTypes: new Set(),
      confidence: 0,
      actorCount: 0,
      score: 0,
    };
    pair.channels.add(item.strongestChannel);
    for (const stage of item.stages || []) pair.stages.add(stage);
    for (const type of item.interactionTypes || []) pair.interactionTypes.add(type);
    pair.confidence = Math.max(pair.confidence, Number(item.avgConfidence || 0));
    pair.actorCount = Math.max(pair.actorCount, item.sourceActors.size + item.targetActors.size);
    pair.score = Math.max(pair.score, Number(item.score || 0));
    groupedPairs.set(key, pair);
  }
  return [...groupedPairs.values()]
    .sort((a, b) => b.confidence - a.confidence || b.score - a.score || a.sourceLabel.localeCompare(b.sourceLabel))
    .slice(0, 6)
    .map((item) => ({
      type: `interaction_${[...item.interactionTypes][0] || 'coupling'}`,
      label: `${item.sourceLabel} -> ${item.targetLabel}`,
      summary: `${item.sourceLabel} interacted with ${item.targetLabel} across ${item.stages.size} round(s) via ${uniqueSortedStrings([...item.channels]).map((channel) => channel.replace(/_/g, ' ')).join(', ')}, with ${(item.confidence * 100).toFixed(0)}% report confidence and ${item.actorCount} named actors involved.`,
    }));
}

function buildCrossSituationEffects(simulationState, options = {}) {
  const mode = options.mode || 'reportable';
  const simulations = Array.isArray(simulationState?.situationSimulations) ? simulationState.situationSimulations : [];
  const interactions = mode === 'reportable'
    ? (
      Array.isArray(simulationState?.reportableInteractionLedger)
        ? simulationState.reportableInteractionLedger
        : (Array.isArray(simulationState?.interactionLedger) ? simulationState.interactionLedger : [])
    )
    : (Array.isArray(simulationState?.interactionLedger) ? simulationState.interactionLedger : []);
  const simulationIndex = new Map(simulations.map((item) => [item.situationId, item]));
  const interactionGroups = buildInteractionGroups(interactions);
  const blockedEffects = [];

  if (interactionGroups.length > 0) {
    const effects = [];
    for (const group of interactionGroups) {
      const source = simulationIndex.get(group.sourceSituationId);
      const target = simulationIndex.get(group.targetSituationId);
      if (!source || !target) continue;
      const targetSensitivity = getTargetSensitivityChannels(target.dominantDomain);
      if (!targetSensitivity.includes(group.strongestChannel)) continue;
      const relation = inferSystemEffectRelationFromChannel(group.strongestChannel, target.dominantDomain);
      if (!relation) continue;
      const strongestChannelWeight = (source.effectChannels || []).find((item) => item.type === group.strongestChannel)?.count || 0;
      const hasRegionLink = group.regionLink || intersectCount(source.regions || [], target.regions || []) > 0;
      const hasSharedActor = group.sharedActor || intersectCount(source.actorIds || [], target.actorIds || []) > 0;
      const hasDirectStructuralLink = hasRegionLink || hasSharedActor;
      const sourceMacro = getMacroRegion(source.regions || []);
      const targetMacro = getMacroRegion(target.regions || []);
      const crossTheater = !!(sourceMacro && targetMacro && sourceMacro !== targetMacro);
      const sameMacroRegion = !!(sourceMacro && targetMacro && sourceMacro === targetMacro);
      const repeatedStages = group.stages?.size || 0;
      const effectClass = classifyEffectClass(group.strongestChannel, relation);

      if (!canEmitCrossSituationEffect(source, group.strongestChannel, strongestChannelWeight, hasDirectStructuralLink)) {
        blockedEffects.push({
          sourceSituationId: source.situationId,
          sourceLabel: source.label,
          targetSituationId: target.situationId,
          targetLabel: target.label,
          channel: group.strongestChannel,
          effectClass,
          reason: 'source_posture_gate',
          confidence: 0,
          score: Number(group.score || 0),
        });
        continue;
      }
      if (strongestChannelWeight < 2 && !hasDirectStructuralLink) {
        blockedEffects.push({
          sourceSituationId: source.situationId,
          sourceLabel: source.label,
          targetSituationId: target.situationId,
          targetLabel: target.label,
          channel: group.strongestChannel,
          effectClass,
          reason: 'weak_channel_without_structure',
          confidence: 0,
          score: Number(group.score || 0),
        });
        continue;
      }
      if (
        crossTheater
        && !CROSS_THEATER_EXEMPT_CHANNELS.has(group.strongestChannel)
        && (!hasSharedActor || Number(group.avgActorSpecificity || 0) < CROSS_THEATER_ACTOR_SPECIFICITY_MIN)
      ) {
        blockedEffects.push({
          sourceSituationId: source.situationId,
          sourceLabel: source.label,
          targetSituationId: target.situationId,
          targetLabel: target.label,
          channel: group.strongestChannel,
          effectClass,
          reason: 'cross_theater_generic_actor',
          confidence: Number(group.avgConfidence || 0),
          score: Number(group.score || 0),
        });
        continue;
      }
      const confidence = computeReportableEffectConfidence(group, source, target, strongestChannelWeight);
      if (
        effectClass === 'political_spillover'
        && !hasRegionLink
        && (!hasSharedActor || confidence < 0.72 || repeatedStages < 2)
      ) {
        blockedEffects.push({
          sourceSituationId: source.situationId,
          sourceLabel: source.label,
          targetSituationId: target.situationId,
          targetLabel: target.label,
          channel: group.strongestChannel,
          effectClass,
          reason: 'political_without_strong_carryover',
          confidence,
          score: Number(group.score || 0),
        });
        continue;
      }

      const score = +(
        group.score
        + (repeatedStages * 0.5)
        + (group.interactionTypes.has('actor_carryover') ? 1.5 : 0)
        + (sameMacroRegion && effectClass === 'security_spillover' ? 0.5 : 0)
        + (repeatedStages >= 2 && ['cyber_spillover', 'logistics_spillover'].includes(effectClass) ? 0.4 : 0)
      ).toFixed(3);
      const scoreThreshold = getEffectClassScoreThreshold(effectClass, {
        crossTheater,
        sameMacroRegion,
        repeatedStages,
      });
      if (score < scoreThreshold) {
        blockedEffects.push({
          sourceSituationId: source.situationId,
          sourceLabel: source.label,
          targetSituationId: target.situationId,
          targetLabel: target.label,
          channel: group.strongestChannel,
          effectClass,
          reason: 'score_below_threshold',
          confidence,
          score,
        });
        continue;
      }

      const confidenceThreshold = mode === 'internal'
        ? Math.max(0.4, getEffectClassThreshold(effectClass, {
          crossTheater,
          sameMacroRegion,
          directStructuralLink: hasDirectStructuralLink,
        }) - 0.08)
        : getEffectClassThreshold(effectClass, {
          crossTheater,
          sameMacroRegion,
          directStructuralLink: hasDirectStructuralLink,
        });
      if (confidence < confidenceThreshold) {
        blockedEffects.push({
          sourceSituationId: source.situationId,
          sourceLabel: source.label,
          targetSituationId: target.situationId,
          targetLabel: target.label,
          channel: group.strongestChannel,
          effectClass,
          reason: 'confidence_below_threshold',
          confidence,
          score,
        });
        continue;
      }

      effects.push({
        sourceSituationId: source.situationId,
        sourceLabel: source.label,
        sourceFamilyId: source.familyId,
        sourceFamilyLabel: source.familyLabel,
        targetSituationId: target.situationId,
        targetLabel: target.label,
        targetFamilyId: target.familyId,
        targetFamilyLabel: target.familyLabel,
        channel: group.strongestChannel,
        effectClass,
        relation,
        score,
        confidence,
        summary: `${source.label} is likely to feed ${relation} into ${target.label}, reinforced by ${repeatedStages} round(s) of ${group.strongestChannel.replace(/_/g, ' ')} interactions, ${(confidence * 100).toFixed(0)}% effect confidence, and a ${describeSimulationPosture(source.posture)} posture at ${roundPct(source.postureScore)}.`,
      });
    }
    const sorted = effects
      .sort((a, b) => b.confidence - a.confidence || b.score - a.score || a.sourceLabel.localeCompare(b.sourceLabel) || a.targetLabel.localeCompare(b.targetLabel))
      .slice(0, mode === 'internal' ? 10 : 6);
    sorted.blocked = blockedEffects;
    return sorted;
  }

  if (mode === 'reportable') {
    const empty = [];
    empty.blocked = blockedEffects;
    return empty;
  }

  const effects = [];

  for (let i = 0; i < simulations.length; i++) {
    const source = simulations[i];
    for (let j = 0; j < simulations.length; j++) {
      if (i === j) continue;
      const target = simulations[j];
      const regionOverlap = intersectCount(source.regions || [], target.regions || []);
      const actorOverlap = intersectCount(source.actorIds || [], target.actorIds || []);
      const familyLink = source.familyId && target.familyId && source.familyId === target.familyId;
      const labelTokenOverlap = intersectCount(
        normalizeSituationText(source.label).filter((token) => !['situation', 'conflict', 'political', 'market', 'supply', 'chain', 'infrastructure', 'cyber'].includes(token)),
        normalizeSituationText(target.label).filter((token) => !['situation', 'conflict', 'political', 'market', 'supply', 'chain', 'infrastructure', 'cyber'].includes(token)),
      );
      const sourceChannels = (source.effectChannels || []).map((item) => item.type);
      const targetSensitivity = getTargetSensitivityChannels(target.dominantDomain);
      const channelOverlap = intersectCount(sourceChannels, targetSensitivity);
      const hasDirectObservableLink = regionOverlap > 0 || actorOverlap > 0 || labelTokenOverlap > 0;
      if (channelOverlap === 0) continue;
      if (!hasDirectObservableLink) continue;

      const strongestChannelEntry = (source.effectChannels || [])
        .slice()
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
        .find((item) => targetSensitivity.includes(item.type))
        || null;
      const strongestChannel = strongestChannelEntry?.type || '';
      const strongestChannelWeight = strongestChannelEntry?.count || 0;
      const hasDirectStructuralLink = regionOverlap > 0 || actorOverlap > 0;
      const sourceMacro = getMacroRegion(source.regions || []);
      const targetMacro = getMacroRegion(target.regions || []);
      const crossTheater = !!(sourceMacro && targetMacro && sourceMacro !== targetMacro);
      if (!canEmitCrossSituationEffect(source, strongestChannel, strongestChannelWeight, hasDirectStructuralLink)) continue;
      const relation = inferSystemEffectRelationFromChannel(strongestChannel, target.dominantDomain);
      if (!relation) continue;
      const effectClass = classifyEffectClass(strongestChannel, relation);
      if (mode === 'reportable' && !hasDirectStructuralLink) continue;
      if (
        crossTheater
        && !CROSS_THEATER_EXEMPT_CHANNELS.has(strongestChannel)
        && actorOverlap === 0
      ) continue;
      if (strongestChannelWeight < 2 && actorOverlap === 0 && regionOverlap === 0) continue;

      const fallbackConfidence = +clamp01(
        ((source.postureScore || 0) * 0.32) +
        (channelOverlap * 0.16) +
        (regionOverlap > 0 ? 0.18 : 0) +
        (actorOverlap > 0 ? 0.22 : 0) +
        (strongestChannelWeight >= 2 ? 0.08 : 0.04)
      ).toFixed(3);
      const confidenceThreshold = mode === 'internal'
        ? Math.max(0.4, getEffectClassThreshold(effectClass, {
          crossTheater,
          sameMacroRegion: !crossTheater && !!(sourceMacro && targetMacro),
          directStructuralLink: hasDirectStructuralLink,
        }) - 0.08)
        : getEffectClassThreshold(effectClass, {
          crossTheater,
          sameMacroRegion: !crossTheater && !!(sourceMacro && targetMacro),
          directStructuralLink: hasDirectStructuralLink,
        });
      const fallbackThreshold = (
        mode === 'reportable'
        && effectClass === 'political_spillover'
        && hasDirectStructuralLink
      )
        ? Math.max(0.5, confidenceThreshold - 0.08)
        : confidenceThreshold;
      if (fallbackConfidence < fallbackThreshold) continue;

      const score = (source.posture === 'escalatory' ? 2 : source.posture === 'contested' ? 1 : 0)
        + (channelOverlap * 2.5)
        + (familyLink ? 0.5 : 0)
        + (regionOverlap * 2)
        + (actorOverlap * 1.5)
        + (labelTokenOverlap * 0.5);
      if (score < 4) continue;

      effects.push({
        sourceSituationId: source.situationId,
        sourceLabel: source.label,
        sourceFamilyId: source.familyId,
        sourceFamilyLabel: source.familyLabel,
        targetSituationId: target.situationId,
        targetLabel: target.label,
        targetFamilyId: target.familyId,
        targetFamilyLabel: target.familyLabel,
        channel: strongestChannel,
        effectClass,
        relation,
        score: +score.toFixed(3),
        confidence: fallbackConfidence,
        summary: `${source.label} is likely to feed ${relation} into ${target.label}, driven by ${strongestChannel.replace(/_/g, ' ')} and a ${describeSimulationPosture(source.posture)} posture at ${roundPct(source.postureScore)}.`,
      });
    }
  }

  return effects
    .sort((a, b) => b.score - a.score || a.sourceLabel.localeCompare(b.sourceLabel) || a.targetLabel.localeCompare(b.targetLabel))
    .slice(0, 8);
}

function attachSituationContext(predictions, situationClusters = buildSituationClusters(predictions)) {
  const situationIndex = buildSituationForecastIndex(situationClusters);
  for (const pred of predictions) {
    const cluster = situationIndex.get(pred.id);
    if (!cluster) continue;
    const situationContext = {
      id: cluster.id,
      label: cluster.label,
      forecastCount: cluster.forecastCount,
      regions: cluster.regions,
      domains: cluster.domains,
      actors: cluster.actors,
      branchKinds: cluster.branchKinds,
      avgProbability: cluster.avgProbability,
      avgConfidence: cluster.avgConfidence,
      topSignals: cluster.topSignals,
      sampleTitles: cluster.sampleTitles,
    };
    pred.situationContext = situationContext;
    pred.caseFile = pred.caseFile || buildForecastCase(pred);
    // Keep caseFile access convenient for prompt/fallback builders, but treat
    // pred.situationContext as the canonical per-forecast reference.
    pred.caseFile.situationContext = situationContext;
  }
  return situationClusters;
}

function buildStateUnitForecastIndex(stateUnits = []) {
  const index = new Map();
  for (const unit of stateUnits || []) {
    for (const forecastId of unit.forecastIds || []) {
      if (index.has(forecastId)) continue;
      index.set(forecastId, unit);
    }
  }
  return index;
}

function attachStateContext(predictions, stateUnits = []) {
  const stateIndex = buildStateUnitForecastIndex(stateUnits);
  for (const pred of predictions || []) {
    const unit = stateIndex.get(pred.id);
    if (!unit) continue;
    const stateContext = {
      id: unit.id,
      label: unit.label,
      stateKind: unit.stateKind,
      familyId: unit.familyId,
      familyLabel: unit.familyLabel,
      familyArchetype: unit.familyArchetype,
      dominantRegion: unit.dominantRegion,
      dominantDomain: unit.dominantDomain,
      regions: unit.regions,
      domains: unit.domains,
      actors: unit.actors,
      branchKinds: unit.branchKinds,
      forecastCount: unit.forecastCount,
      situationCount: unit.situationCount,
      situationIds: unit.situationIds,
      avgProbability: unit.avgProbability,
      avgConfidence: unit.avgConfidence,
      topSignals: unit.topSignals,
      sampleTitles: unit.sampleTitles,
    };
    pred.stateContext = stateContext;
    pred.caseFile = pred.caseFile || buildForecastCase(pred);
    pred.caseFile.stateContext = stateContext;
  }
  return stateUnits;
}

function buildSituationFamilyIndex(situationFamilies) {
  const index = new Map();
  for (const family of situationFamilies || []) {
    for (const situationId of family.situationIds || []) {
      if (index.has(situationId)) continue;
      index.set(situationId, family);
    }
  }
  return index;
}

function attachSituationFamilyContext(predictions, situationFamilies = []) {
  const familyIndex = buildSituationFamilyIndex(situationFamilies);
  for (const pred of predictions || []) {
    const family = familyIndex.get(pred.situationContext?.id || '');
    if (!family) continue;
    const familyContext = {
      id: family.id,
      label: family.label,
      dominantRegion: family.dominantRegion,
      dominantDomain: family.dominantDomain,
      situationCount: family.situationCount,
      forecastCount: family.forecastCount,
      regions: family.regions,
      domains: family.domains,
      situationIds: family.situationIds,
    };
    pred.familyContext = familyContext;
    pred.caseFile = pred.caseFile || buildForecastCase(pred);
    pred.caseFile.familyContext = familyContext;
  }
  return situationFamilies;
}

function buildSituationForecastIndex(situationClusters) {
  const index = new Map();
  for (const cluster of situationClusters || []) {
    for (const forecastId of cluster.forecastIds || []) {
      if (index.has(forecastId)) continue;
      index.set(forecastId, cluster);
    }
  }
  return index;
}

function projectSituationClusters(situationClusters, predictions) {
  if (!Array.isArray(situationClusters) || !situationClusters.length) return [];
  const predictionById = new Map((predictions || []).map((pred) => [pred.id, pred]));
  const projected = [];

  for (const cluster of situationClusters) {
    const clusterPredictions = (cluster?.forecastIds || [])
      .map((forecastId) => predictionById.get(forecastId))
      .filter(Boolean);
    if (!clusterPredictions.length) continue;

    const regionCounts = {};
    const domainCounts = {};
    const signalCounts = {};
    let probabilityTotal = 0;
    let confidenceTotal = 0;

    for (const prediction of clusterPredictions) {
      probabilityTotal += Number(prediction.probability || 0);
      confidenceTotal += Number(prediction.confidence || 0);
      incrementSituationCounts(regionCounts, [prediction.region].filter(Boolean));
      incrementSituationCounts(domainCounts, [prediction.domain].filter(Boolean));
      for (const signal of prediction.signals || []) {
        const type = signal?.type || 'unknown';
        signalCounts[type] = (signalCounts[type] || 0) + 1;
      }
    }

    const topSignals = Object.entries(signalCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([type, count]) => ({ type, count }));
    const avgProbability = clusterPredictions.length ? probabilityTotal / clusterPredictions.length : 0;
    const avgConfidence = clusterPredictions.length ? confidenceTotal / clusterPredictions.length : 0;
    const dominantRegion = pickDominantSituationValue(regionCounts, cluster.regions || []);
    const dominantDomain = pickDominantSituationValue(domainCounts, cluster.domains || []);

    projected.push({
      ...cluster,
      label: formatSituationLabel({
        regions: cluster.regions || [],
        domains: cluster.domains || [],
        dominantRegion,
        dominantDomain,
      }),
      forecastCount: clusterPredictions.length,
      forecastIds: clusterPredictions.map((prediction) => prediction.id).slice(0, 12),
      avgProbability: +avgProbability.toFixed(3),
      avgConfidence: +avgConfidence.toFixed(3),
      topSignals,
      sampleTitles: clusterPredictions.map((prediction) => prediction.title).slice(0, 6),
      dominantRegion,
      dominantDomain,
    });
  }

  return projected.sort((a, b) => b.forecastCount - a.forecastCount || b.avgProbability - a.avgProbability);
}

function summarizeWorldStateHistory(priorWorldStates = []) {
  return priorWorldStates
    .filter(Boolean)
    .slice(0, WORLD_STATE_HISTORY_LIMIT)
    .map((state) => ({
      generatedAt: state.generatedAt,
      generatedAtIso: state.generatedAtIso,
      summary: state.summary,
      domainCount: Array.isArray(state.domainStates) ? state.domainStates.length : 0,
      regionCount: Array.isArray(state.regionalStates) ? state.regionalStates.length : 0,
      situationCount: Array.isArray(state.situationClusters) ? state.situationClusters.length : 0,
      actorCount: Array.isArray(state.actorRegistry) ? state.actorRegistry.length : 0,
      branchCount: Array.isArray(state.branchStates) ? state.branchStates.length : 0,
    }));
}

function buildReportContinuity(current, priorWorldStates = []) {
  const history = summarizeWorldStateHistory(priorWorldStates);

  const persistentPressures = [];
  const emergingPressures = [];
  const fadingPressures = [];
  const repeatedStrengthening = [];
  const matchedLatestPriorIds = new Set();

  for (const cluster of current.situationClusters || []) {
    const priorMatches = [];
    for (const state of priorWorldStates.filter(Boolean)) {
      const candidates = Array.isArray(state.situationClusters) ? state.situationClusters : [];
      let match = candidates.find((item) => item.id === cluster.id) || null;
      if (!match) {
        let bestMatch = null;
        let bestScore = 0;
        for (const candidate of candidates) {
          const score = computeSituationSimilarity(cluster, candidate);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = candidate;
          }
        }
        if (bestMatch && bestScore >= 4) match = bestMatch;
      }
      if (!match) continue;
      priorMatches.push({
        id: match.id,
        label: match.label,
        generatedAt: state.generatedAt || 0,
        avgProbability: Number(match.avgProbability || 0),
        forecastCount: Number(match.forecastCount || 0),
      });
      if (state === priorWorldStates[0]) matchedLatestPriorIds.add(match.id);
    }

    if (priorMatches.length === 0) {
      emergingPressures.push({
        id: cluster.id,
        label: cluster.label,
        forecastCount: cluster.forecastCount,
        avgProbability: cluster.avgProbability,
      });
      continue;
    }

    persistentPressures.push({
      id: cluster.id,
      label: cluster.label,
      appearances: priorMatches.length + 1,
      forecastCount: cluster.forecastCount,
      avgProbability: cluster.avgProbability,
    });

    // priorMatches is ordered most-recent-first (mirrors priorWorldStates order from LRANGE)
    const lastMatch = priorMatches[0];
    const earliestMatch = priorMatches[priorMatches.length - 1];
    // Repeated strengthening should reflect a monotonic strengthening path,
    // not a V-shaped recovery after a weaker intermediate run.
    if (
      (lastMatch?.avgProbability || 0) >= (earliestMatch?.avgProbability || 0) &&
      cluster.avgProbability >= (lastMatch?.avgProbability || 0) &&
      cluster.forecastCount >= (lastMatch?.forecastCount || 0)
    ) {
      repeatedStrengthening.push({
        id: cluster.id,
        label: cluster.label,
        avgProbability: cluster.avgProbability,
        priorAvgProbability: lastMatch?.avgProbability || 0,
        appearances: priorMatches.length + 1,
      });
    }
  }

  const latestPriorState = priorWorldStates[0] || null;
  for (const cluster of latestPriorState?.situationClusters || []) {
    if (matchedLatestPriorIds.has(cluster.id)) continue;
    fadingPressures.push({
      id: cluster.id,
      label: cluster.label,
      forecastCount: cluster.forecastCount || 0,
      avgProbability: cluster.avgProbability || 0,
    });
  }

  const summary = history.length
    ? `Across the last ${history.length + 1} runs, ${persistentPressures.length} situations persisted, ${emergingPressures.length} emerged, and ${fadingPressures.length} faded from the latest prior snapshot.`
    : 'No prior world-state history is available yet for report continuity.';

  return {
    history,
    summary,
    persistentPressureCount: persistentPressures.length,
    emergingPressureCount: emergingPressures.length,
    fadingPressureCount: fadingPressures.length,
    repeatedStrengtheningCount: repeatedStrengthening.length,
    persistentPressurePreview: persistentPressures.slice(0, 8),
    emergingPressurePreview: emergingPressures.slice(0, 8),
    fadingPressurePreview: fadingPressures.slice(0, 8),
    repeatedStrengtheningPreview: repeatedStrengthening
      .sort((a, b) => b.appearances - a.appearances || b.avgProbability - a.avgProbability || a.id.localeCompare(b.id))
      .slice(0, 8),
  };
}

function buildWorldStateReport(worldState) {
  const leadDomains = (worldState.domainStates || [])
    .slice(0, 3)
    .map(item => `${item.domain} (${item.forecastCount})`);
  const leadRegions = (worldState.regionalStates || [])
    .slice(0, 4)
    .map(item => ({
      region: item.region,
      summary: `${item.forecastCount} forecasts with ${Math.round((item.avgProbability || 0) * 100)}% average probability and ${Math.round((item.avgConfidence || 0) * 100)}% average confidence.`,
      domainMix: item.domainMix,
    }));

  const actorWatchlist = [
    ...(worldState.actorContinuity?.newlyActivePreview || []).map(actor => ({
      type: 'new_actor',
      name: actor.name,
      summary: `${actor.name} is newly active across ${actor.domains.join(', ')} in ${actor.regions.join(', ')}.`,
    })),
    ...(worldState.actorContinuity?.strengthenedPreview || []).map(actor => ({
      type: 'strengthened_actor',
      name: actor.name,
      summary: `${actor.name} strengthened by ${Math.round((actor.influenceDelta || 0) * 100)} points${actor.addedRegions?.length ? ` with new regional exposure in ${actor.addedRegions.join(', ')}` : ''}.`,
    })),
  ].slice(0, 6);

  const branchWatchlist = [
    ...(worldState.branchContinuity?.strengthenedBranchPreview || []).map(branch => ({
      type: 'strengthened_branch',
      title: branch.title,
      summary: `${branch.title} in ${branch.kind} moved from ${roundPct(branch.priorProjectedProbability)} to ${roundPct(branch.projectedProbability)}.`,
    })),
    ...(worldState.branchContinuity?.newBranchPreview || []).map(branch => ({
      type: 'new_branch',
      title: branch.title,
      summary: `${branch.title} is newly active with a projected probability near ${roundPct(branch.projectedProbability)}.`,
    })),
    ...(worldState.branchContinuity?.resolvedBranchPreview || []).map(branch => ({
      type: 'resolved_branch',
      title: branch.title,
      summary: `${branch.title} is no longer active in the current run.`,
    })),
  ].slice(0, 6);

  const situationWatchlist = [
    ...(worldState.situationContinuity?.strengthenedSituationPreview || []).map((situation) => ({
      type: 'strengthened_situation',
      label: situation.label,
      summary: `${situation.label} strengthened from ${roundPct(situation.priorAvgProbability)} to ${roundPct(situation.avgProbability)} across ${situation.forecastCount} forecasts.`,
    })),
    ...(worldState.situationContinuity?.newSituationPreview || []).map((situation) => ({
      type: 'new_situation',
      label: situation.label,
      summary: `${situation.label} is newly active across ${situation.forecastCount} forecasts.`,
    })),
    ...(worldState.situationContinuity?.resolvedSituationPreview || []).map((situation) => ({
      type: 'resolved_situation',
      label: situation.label,
      summary: `${situation.label} is no longer active in the current run.`,
    })),
  ].slice(0, 6);

  const continuityWatchlist = [
    ...(worldState.reportContinuity?.repeatedStrengtheningPreview || []).map((situation) => ({
      type: 'persistent_strengthening',
      label: situation.label,
      summary: `${situation.label} has strengthened across ${situation.appearances} runs, from ${roundPct(situation.priorAvgProbability)} to ${roundPct(situation.avgProbability)}.`,
    })),
    ...(worldState.reportContinuity?.emergingPressurePreview || []).map((situation) => ({
      type: 'emerging_pressure',
      label: situation.label,
      summary: `${situation.label} is a newly emerging situation in the current run.`,
    })),
    ...(worldState.reportContinuity?.fadingPressurePreview || []).map((situation) => ({
      type: 'fading_pressure',
      label: situation.label,
      summary: `${situation.label} has faded versus the latest prior world-state snapshot.`,
    })),
  ].slice(0, 6);

  const continuitySummary = `Actors: ${worldState.actorContinuity?.newlyActiveCount || 0} new, ${worldState.actorContinuity?.strengthenedCount || 0} strengthened. Branches: ${worldState.branchContinuity?.newBranchCount || 0} new, ${worldState.branchContinuity?.strengthenedBranchCount || 0} strengthened, ${worldState.branchContinuity?.resolvedBranchCount || 0} resolved. Situations: ${worldState.situationContinuity?.newSituationCount || 0} new, ${worldState.situationContinuity?.strengthenedSituationCount || 0} strengthened, ${worldState.situationContinuity?.resolvedSituationCount || 0} resolved.`;

  const simulationSummary = worldState.simulationState?.summary || 'No simulation-state summary is available.';
  const simulationReportInputs = buildSimulationReportInputs(worldState);
  const simulationOutcomeSummaries = buildSituationOutcomeSummaries(worldState.simulationState);
  const reportableInteractionLedger = Array.isArray(worldState.simulationState?.reportableInteractionLedger)
    ? worldState.simulationState.reportableInteractionLedger
    : [];
  const blockedInteractionSummary = worldState.simulationState?.blockedInteractionSummary || summarizeBlockedInteractions([]);
  const crossSituationEffects = Array.isArray(worldState.simulationState?.causalGraph?.edges)
    ? worldState.simulationState.causalGraph.edges
    : (Array.isArray(worldState.simulationState?.reportableEffects)
        ? worldState.simulationState.reportableEffects
        : buildCrossSituationEffects(worldState.simulationState, { mode: 'reportable' }));
  const interactionLedger = reportableInteractionLedger;
  const replayTimeline = Array.isArray(worldState.simulationState?.replayTimeline) ? worldState.simulationState.replayTimeline : [];
  const simulationWatchlist = (worldState.simulationState?.situationSimulations || [])
    .slice()
    .sort((a, b) => (b.postureScore || 0) - (a.postureScore || 0) || a.label.localeCompare(b.label))
    .slice(0, 6)
    .map((item) => ({
      type: `${item.posture}_simulation`,
      label: item.label,
      summary: `${item.label} resolved to a ${item.posture} posture after 3 rounds, with ${Math.round((item.postureScore || 0) * 100)}% final pressure and ${item.actorIds.length} active actors.`,
    }));
  const interactionWatchlist = interactionLedger.length
    ? buildInteractionWatchlist(interactionLedger)
    : (blockedInteractionSummary.preview || []).slice(0, 4).map((item) => ({
      type: `blocked_interaction_${item.reason}`,
      label: `${item.sourceLabel} -> ${item.targetLabel}`,
      summary: `${item.sourceLabel} did not promote into a reportable interaction with ${item.targetLabel} via ${String(item.channel || 'mixed').replace(/_/g, ' ')} because of ${String(item.reason || 'quality gating').replace(/_/g, ' ')}, despite ${(Number(item.confidence || 0) * 100).toFixed(0)}% candidate confidence.`,
    }));
  const replayWatchlist = replayTimeline
    .slice()
    .map((round) => ({
      type: `replay_${round.stage}`,
      label: round.stage.replace('_', ' '),
      summary: `${round.stage.replace('_', ' ')} carried ${round.actionCount} actions, ${round.interactionCount} cross-situation interactions, and ${round.situationCount} active situations at ${Math.round((round.avgNetPressure || 0) * 100)}% average net pressure.`,
    }));
  const environmentWatchlist = (worldState.simulationState?.environmentSpec?.situations || [])
    .slice()
    .sort((a, b) => (b.activityIntensity || 0) - (a.activityIntensity || 0) || a.label.localeCompare(b.label))
    .slice(0, 6)
    .map((item) => ({
      type: `environment_${item.archetype}`,
      label: item.label,
      summary: `${item.label} is configured as a ${item.archetype.replace(/_/g, ' ')} with ${Math.round((item.activityIntensity || 0) * 100)}% activity intensity and ${item.actorCount} active actors.`,
    }));
  const memoryWatchlist = (worldState.simulationState?.memoryMutations?.situations || [])
    .slice()
    .sort((a, b) => Math.abs(b.memoryDelta || 0) - Math.abs(a.memoryDelta || 0) || a.label.localeCompare(b.label))
    .slice(0, 6)
    .map((item) => ({
      type: `memory_${item.mutationType}`,
      label: item.label,
      summary: `${item.label} shows a ${item.mutationType.replace(/_/g, ' ')} memory shift of ${Math.round(Math.abs(item.memoryDelta || 0) * 100)} points, with ${Math.round(clamp01(item.pressureMemory || 0) * 100)}% retained pressure memory.`,
    }));
  const causalReplayWatchlist = (worldState.simulationState?.causalReplay?.chains || [])
    .slice(0, 6)
    .map((chain) => ({
      type: `causal_${chain.kind}`,
      label: chain.targetLabel ? `${chain.sourceLabel} -> ${chain.targetLabel}` : chain.sourceLabel,
      summary: chain.targetLabel
        ? `${chain.sourceLabel} flowed into ${chain.targetLabel} through ${chain.stages.length} stage(s), triggered by ${String(chain.trigger || 'pressure').replace(/_/g, ' ')}, ending in ${chain.outcomeSummary}`
        : `${chain.sourceLabel} moved through ${chain.stages.length} stage(s), triggered by ${String(chain.trigger || 'pressure').replace(/_/g, ' ')}, ending in ${chain.outcomeSummary}`,
    }));
  const causalEdgeWatchlist = (worldState.simulationState?.causalGraph?.edges || [])
    .slice(0, 6)
    .map((edge) => ({
      type: `causal_edge_${edge.continuityStatus}`,
      label: `${edge.sourceLabel} -> ${edge.targetLabel}`,
      summary: `${edge.sourceLabel} now carries a ${String(edge.continuityStatus || 'new').replace(/_/g, ' ')} ${String(edge.effectClass || 'causal').replace(/_/g, ' ')} edge into ${edge.targetLabel}, led by ${String(edge.primaryChannel || 'mixed').replace(/_/g, ' ')} at ${(Number(edge.confidence || 0) * 100).toFixed(0)}% confidence and ${(Number(edge.memorySupport || 0) * 100).toFixed(0)}% memory support.`,
    }));
  const blockedEffectWatchlist = (worldState.simulationState?.blockedEffectSummary?.preview || []).slice(0, 4).map((item) => ({
    type: `blocked_effect_${item.reason}`,
    label: `${item.sourceLabel} -> ${item.targetLabel}`,
    summary: `${item.sourceLabel} did not promote into ${item.targetLabel} via ${String(item.channel || '').replace(/_/g, ' ')} because of ${item.reason.replace(/_/g, ' ')}, despite ${(Number(item.confidence || 0) * 100).toFixed(0)}% candidate confidence.`,
  }));
  const effectWatchlist = crossSituationEffects.length
    ? crossSituationEffects.slice(0, 6).map((item) => ({
      type: `effect_${item.effectClass || 'spillover'}`,
      label: `${item.sourceLabel} -> ${item.targetLabel}`,
      summary: item.summary,
    }))
    : blockedEffectWatchlist;
  const marketBuckets = Array.isArray(worldState.marketState?.buckets) ? worldState.marketState.buckets : [];
  const transmissionEdges = Array.isArray(worldState.marketTransmission?.edges) ? worldState.marketTransmission.edges : [];
  const marketConsequences = Array.isArray(worldState.simulationState?.marketConsequences?.items)
    ? worldState.simulationState.marketConsequences.items
    : [];
  const marketWatchlist = marketBuckets
    .slice()
    .sort((a, b) => (b.pressureScore || 0) - (a.pressureScore || 0) || a.label.localeCompare(b.label))
    .slice(0, 6)
    .map((bucket) => ({
      type: `market_bucket_${bucket.id}`,
      label: bucket.label,
      summary: `${bucket.label} is ${bucket.direction} at ${roundPct(bucket.pressureScore || 0)} pressure with ${bucket.topSignals.length} leading signals and ${bucket.topSituations.length} linked situations.`,
    }));
  const transmissionWatchlist = transmissionEdges
    .slice()
    .sort((a, b) => (b.strength + b.confidence) - (a.strength + a.confidence) || a.sourceLabel.localeCompare(b.sourceLabel))
    .slice(0, 6)
    .map((edge) => ({
      type: `market_transmission_${edge.targetBucketId}`,
      label: `${edge.sourceLabel} -> ${edge.targetLabel}`,
      summary: `${edge.sourceLabel} is feeding ${edge.targetLabel} via ${String(edge.channel || 'derived_transmission').replace(/_/g, ' ')} at ${(edge.confidence * 100).toFixed(0)}% confidence.`,
    }));
  const marketConsequenceWatchlist = marketConsequences
    .slice(0, 6)
    .map((item) => ({
      type: `market_consequence_${item.targetBucketId}`,
      label: `${item.situationLabel} -> ${item.targetBucketLabel}`,
      summary: item.summary,
    }));
  const blockedMarketConsequenceWatchlist = (worldState.simulationState?.marketConsequences?.blockedSummary?.preview || [])
    .slice(0, 4)
    .map((item) => ({
      type: `blocked_market_consequence_${item.reason}`,
      label: `${item.situationLabel} -> ${item.targetBucketLabel}`,
      summary: `${item.situationLabel} did not promote into ${item.targetBucketLabel} because of ${String(item.reason || 'quality gating').replace(/_/g, ' ')}, despite ${(Number(item.reportableScore || 0) * 100).toFixed(0)}% reportable score.`,
    }));

  const familyWatchlist = (worldState.situationFamilies || [])
    .slice(0, 6)
    .map((family) => ({
      type: 'situation_family',
      label: family.label,
      summary: `${family.label} currently groups ${family.situationCount} situations across ${family.forecastCount} forecasts.`,
    }));

  const summary = `${worldState.summary} The leading domains in this run are ${leadDomains.join(', ') || 'none'}, the main continuity changes are captured through ${worldState.actorContinuity?.newlyActiveCount || 0} newly active actors and ${worldState.branchContinuity?.strengthenedBranchCount || 0} strengthened branches, the situation layer currently carries ${worldState.situationClusters?.length || 0} active clusters inside ${worldState.situationFamilies?.length || 0} broader families, the market layer carries ${marketBuckets.length} active buckets, ${transmissionEdges.length} transmission edges, and ${marketConsequences.length} explicit market consequences, and the simulation layer reports ${worldState.simulationState?.totalSituationSimulations || 0} executable units with ${(worldState.simulationState?.actionLedger || []).length} logged actions and ${reportableInteractionLedger.length} reportable interaction links, ${worldState.simulationState?.internalEffects?.length || 0} internal effects, ${crossSituationEffects.length} cross-situation system effects, ${(worldState.simulationState?.memoryMutations?.situations || []).length} mutated situation memories, and ${(worldState.simulationState?.causalReplay?.chains || []).length} causal replay chains in the report view.`;

  return {
    summary,
    continuitySummary,
    simulationSummary,
    marketSummary: worldState.marketState?.summary || '',
    simulationInputSummary: simulationReportInputs.summary,
    simulationEnvironmentSummary: worldState.simulationState?.environmentSpec?.summary || '',
    memoryMutationSummary: worldState.simulationState?.memoryMutations?.summary || '',
    causalReplaySummary: worldState.simulationState?.causalReplay?.summary || '',
    domainOverview: {
      leadDomains,
      activeDomainCount: worldState.domainStates?.length || 0,
      activeRegionCount: worldState.regionalStates?.length || 0,
    },
    regionalHotspots: leadRegions,
    actorWatchlist,
    branchWatchlist,
    situationWatchlist,
    familyWatchlist,
    marketWatchlist,
    transmissionWatchlist,
    marketConsequenceWatchlist,
    blockedMarketConsequenceWatchlist,
    continuityWatchlist,
    simulationWatchlist,
    interactionWatchlist,
    blockedInteractionSummary,
    replayWatchlist,
    environmentWatchlist,
    memoryWatchlist,
    causalReplayWatchlist,
    causalEdgeWatchlist,
    effectWatchlist,
    blockedEffectWatchlist,
    simulationOutcomeSummaries,
    crossSituationEffects,
    causalReplayChains: worldState.simulationState?.causalReplay?.chains || [],
    replayTimeline,
    blockedEffectSummary: worldState.simulationState?.blockedEffectSummary || summarizeBlockedEffects([]),
    keyUncertainties: (worldState.uncertainties || []).slice(0, 6).map(item => item.summary || item),
  };
}

function buildForecastDomainStates(predictions) {
  const states = new Map();

  for (const pred of predictions) {
    if (!states.has(pred.domain)) {
      states.set(pred.domain, {
        domain: pred.domain,
        forecastCount: 0,
        highlightedCount: 0,
        totalProbability: 0,
        totalConfidence: 0,
        totalReadiness: 0,
        regions: new Map(),
        signals: [],
        forecastIds: [],
      });
    }
    const entry = states.get(pred.domain);
    const readiness = pred.readiness?.overall ?? scoreForecastReadiness(pred).overall;
    entry.forecastCount++;
    if ((pred.probability || 0) >= PANEL_MIN_PROBABILITY) entry.highlightedCount++;
    entry.totalProbability += pred.probability || 0;
    entry.totalConfidence += pred.confidence || 0;
    entry.totalReadiness += readiness;
    entry.regions.set(pred.region, (entry.regions.get(pred.region) || 0) + 1);
    entry.forecastIds.push(pred.id);
    entry.signals.push(...(pred.signals || []).map(signal => signal.type));
  }

  return [...states.values()]
    .map((entry) => ({
      domain: entry.domain,
      forecastCount: entry.forecastCount,
      highlightedCount: entry.highlightedCount,
      avgProbability: +(entry.totalProbability / entry.forecastCount).toFixed(3),
      avgConfidence: +(entry.totalConfidence / entry.forecastCount).toFixed(3),
      avgReadiness: +(entry.totalReadiness / entry.forecastCount).toFixed(3),
      topRegions: [...entry.regions.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 4)
        .map(([region, count]) => ({ region, count })),
      topSignals: pickTopCountEntries(summarizeTypeCounts(entry.signals), 5),
      forecastIds: entry.forecastIds.slice(0, 10),
    }))
    .sort((a, b) => b.forecastCount - a.forecastCount || a.domain.localeCompare(b.domain));
}

function buildForecastRegionalStates(predictions) {
  const states = new Map();

  for (const pred of predictions) {
    if (!states.has(pred.region)) {
      states.set(pred.region, {
        region: pred.region,
        forecastCount: 0,
        domains: new Map(),
        totalProbability: 0,
        totalConfidence: 0,
      });
    }
    const entry = states.get(pred.region);
    entry.forecastCount++;
    entry.totalProbability += pred.probability || 0;
    entry.totalConfidence += pred.confidence || 0;
    entry.domains.set(pred.domain, (entry.domains.get(pred.domain) || 0) + 1);
  }

  return [...states.values()]
    .map((entry) => ({
      region: entry.region,
      forecastCount: entry.forecastCount,
      avgProbability: +(entry.totalProbability / entry.forecastCount).toFixed(3),
      avgConfidence: +(entry.totalConfidence / entry.forecastCount).toFixed(3),
      domainMix: Object.fromEntries(
        [...entry.domains.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      ),
    }))
    .sort((a, b) => b.forecastCount - a.forecastCount || a.region.localeCompare(b.region))
    .slice(0, 15);
}

function buildForecastEvidenceLedger(predictions) {
  const supporting = [];
  const counter = [];

  for (const pred of predictions) {
    for (const item of pred.caseFile?.supportingEvidence || []) {
      supporting.push({
        forecastId: pred.id,
        domain: pred.domain,
        region: pred.region,
        summary: item.summary,
      });
    }
    for (const item of pred.caseFile?.counterEvidence || []) {
      counter.push({
        forecastId: pred.id,
        domain: pred.domain,
        region: pred.region,
        type: item.type,
        summary: item.summary,
      });
    }
  }

  return {
    supporting: supporting.slice(0, 25),
    counter: counter.slice(0, 25),
  };
}

function buildForecastRunContinuity(predictions) {
  let newForecasts = 0;
  let risingForecasts = 0;
  let fallingForecasts = 0;
  let stableForecasts = 0;
  const changed = [];

  for (const pred of predictions) {
    if (pred.priorProbability == null || pred.caseFile?.changeSummary?.startsWith('This forecast is new')) {
      newForecasts++;
    }
    if (pred.trend === 'rising') risingForecasts++;
    else if (pred.trend === 'falling') fallingForecasts++;
    else stableForecasts++;

    const delta = Math.abs((pred.probability || 0) - (pred.priorProbability ?? pred.probability ?? 0));
    changed.push({
      id: pred.id,
      title: pred.title,
      region: pred.region,
      domain: pred.domain,
      trend: pred.trend,
      delta: +delta.toFixed(3),
      summary: pred.caseFile?.changeSummary || '',
    });
  }

  return {
    newForecasts,
    risingForecasts,
    fallingForecasts,
    stableForecasts,
    materiallyChanged: changed
      .filter((item) => item.delta >= 0.05 || item.summary.startsWith('This forecast is new'))
      .sort((a, b) => b.delta - a.delta || a.title.localeCompare(b.title))
      .slice(0, 8),
  };
}

function createStableHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function extractQuoteItems(payload) {
  return Array.isArray(payload?.quotes) ? payload.quotes : [];
}

function extractSectorItems(payload) {
  return Array.isArray(payload?.sectors) ? payload.sectors : [];
}

function extractEtfItems(payload) {
  return Array.isArray(payload?.etfs) ? payload.etfs : [];
}

function extractRateItems(payload) {
  if (Array.isArray(payload?.rates)) return payload.rates;
  if (Array.isArray(payload?.policy?.rates)) return payload.policy.rates;
  if (Array.isArray(payload?.exchange?.rates)) return payload.exchange.rates;
  return Array.isArray(payload?.rates) ? payload.rates : [];
}

function extractShippingIndices(payload) {
  return Array.isArray(payload?.indices) ? payload.indices : [];
}

function extractCorrelationCards(payload) {
  if (Array.isArray(payload?.cards)) return payload.cards;
  if (Array.isArray(payload?.items)) return payload.items;
  if (payload && typeof payload === 'object') {
    const grouped = Object.values(payload)
      .filter((value) => Array.isArray(value))
      .flat();
    if (grouped.length > 0) return grouped;
  }
  return [];
}

function classifyEnergyQuote(quote) {
  const text = `${quote?.symbol || ''} ${quote?.name || ''}`.toLowerCase();
  if (/bz=f|brent/.test(text)) return 'brent';
  if (/cl=f|wti/.test(text)) return 'wti';
  if (/ng=f|natural gas|natgas|lng/.test(text)) return 'gas';
  if (/gc=f|gold|xau/.test(text)) return 'gold';
  if (/oil|crude|gas|energy/.test(text)) return 'energy_generic';
  return '';
}

function normalizeQuotePrice(quote) {
  const price = Number(quote?.price ?? quote?.last ?? quote?.value);
  return Number.isFinite(price) ? price : null;
}

function getEnergyQuoteMap(...quoteGroups) {
  const quoteMap = new Map();
  for (const group of quoteGroups) {
    for (const quote of group || []) {
      const kind = classifyEnergyQuote(quote);
      if (!kind) continue;
      const price = normalizeQuotePrice(quote);
      const change = Number(quote?.change ?? 0);
      quoteMap.set(kind, {
        symbol: quote?.symbol || quote?.name || kind,
        name: quote?.name || quote?.symbol || kind,
        price,
        change: Number.isFinite(change) ? change : 0,
      });
    }
  }
  return quoteMap;
}

function extractFredSeriesMap(payload) {
  return payload && typeof payload === 'object' ? payload : {};
}

function extractFredObservations(series) {
  return Array.isArray(series?.observations) ? series.observations : [];
}

function getFredLatestObservation(series) {
  const observations = extractFredObservations(series);
  return observations.length ? observations[observations.length - 1] : null;
}

function getFredLatestValue(series) {
  const latest = getFredLatestObservation(series);
  return Number.isFinite(Number(latest?.value)) ? Number(latest.value) : null;
}

function getFredLookbackValue(series, steps = 1) {
  const observations = extractFredObservations(series);
  if (observations.length <= steps) return null;
  const value = Number(observations[observations.length - 1 - steps]?.value);
  return Number.isFinite(value) ? value : null;
}

function getFredRelativeChange(series, steps = 1) {
  const latest = getFredLatestValue(series);
  const prior = getFredLookbackValue(series, steps);
  if (!Number.isFinite(latest) || !Number.isFinite(prior) || prior === 0) return null;
  return ((latest - prior) / Math.abs(prior)) * 100;
}

function getFredAbsoluteChange(series, steps = 1) {
  const latest = getFredLatestValue(series);
  const prior = getFredLookbackValue(series, steps);
  if (!Number.isFinite(latest) || !Number.isFinite(prior)) return null;
  return latest - prior;
}

function normalizeSignalStrength(value, min = 0, max = 1) {
  return +Math.max(0, Math.min(1, normalize(value, min, max))).toFixed(3);
}

function mergeSignalLists(primary = [], secondary = [], limit = 3) {
  const merged = [];
  const seen = new Set();
  for (const item of [...primary, ...secondary]) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
    if (merged.length >= limit) break;
  }
  return merged;
}

function buildWorldSignal(type, sourceType, label, patch = {}) {
  return {
    id: `sig-${createStableHash(`${type}:${sourceType}:${label}:${patch.region || ''}:${patch.sourceKey || ''}`)}`,
    type,
    sourceType,
    sourceKey: patch.sourceKey || '',
    label,
    region: patch.region || '',
    macroRegion: patch.macroRegion || getMacroRegion([patch.region || '']) || '',
    countries: uniqueSortedStrings(patch.countries || []),
    actors: uniqueSortedStrings(patch.actors || []),
    domains: uniqueSortedStrings(patch.domains || []),
    strength: normalizeSignalStrength(patch.strength ?? 0, 0, 1),
    confidence: normalizeSignalStrength(patch.confidence ?? 0, 0, 1),
    supportingEvidence: (patch.supportingEvidence || []).slice(0, 3),
  };
}

function summarizeWorldSignals(signals = []) {
  const typeCounts = summarizeTypeCounts(signals.map((item) => item.type));
  const regionCounts = summarizeTypeCounts(signals.map((item) => item.region).filter(Boolean));
  const leadTypes = pickTopCountEntries(typeCounts, 4).map((item) => item.type.replace(/_/g, ' '));
  const leadRegions = pickTopCountEntries(regionCounts, 3).map((item) => item.type);
  return `${signals.length} normalized world signals are currently active, led by ${leadTypes.join(', ') || 'none'} across ${leadRegions.join(', ') || 'global'} contexts.`;
}

function buildWorldSignals(inputs, predictions = [], _situationClusters = []) {
  const signals = [];
  const criticalSignalBundle = inputs?.criticalSignalBundle || null;
  const criticalNewsSignals = extractCriticalNewsSignals(inputs);
  const chokepoints = inputs?.chokepoints?.routes || inputs?.chokepoints?.chokepoints || [];
  const shippingIndices = extractShippingIndices(inputs?.shippingRates);
  const commodityQuotes = extractQuoteItems(inputs?.commodityQuotes);
  const marketQuotes = extractQuoteItems(inputs?.marketQuotes);
  const sectorItems = extractSectorItems(inputs?.sectorSummary);
  const gulfQuotes = extractQuoteItems(inputs?.gulfQuotes);
  const etfItems = extractEtfItems(inputs?.etfFlows);
  const cryptoQuotes = extractQuoteItems(inputs?.cryptoQuotes);
  const stablecoins = Array.isArray(inputs?.stablecoinMarkets?.stablecoins) ? inputs.stablecoinMarkets.stablecoins : [];
  const bisExchange = extractRateItems(inputs?.bisExchangeRates);
  const bisPolicy = extractRateItems(inputs?.bisPolicyRates);
  const correlationCards = extractCorrelationCards(inputs?.correlationCards);
  const fredSeries = extractFredSeriesMap(inputs?.fredSeries);
  const energyQuotes = getEnergyQuoteMap(commodityQuotes, gulfQuotes);

  signals.push(...criticalNewsSignals);

  for (const cp of chokepoints) {
    const region = resolveChokepointMarketRegion(cp) || cp.region || cp.name || '';
    const commodity = CHOKEPOINT_COMMODITIES[region];
    const riskScore = Number(cp.riskScore || cp.disruptionScore || (cp.riskLevel === 'critical' ? 85 : 70));
    if (riskScore < 60) continue;
    signals.push(buildWorldSignal('shipping_cost_shock', 'chokepoint', `${cp.name || region} disruption pressure`, {
      sourceKey: cp.id || cp.name || region,
      region,
      strength: normalize(riskScore, 55, 100),
      confidence: commodity ? 0.72 : 0.64,
      domains: ['supply_chain', 'market'],
      supportingEvidence: [`${cp.name || region} risk score ${riskScore}`],
    }));
    if (commodity && /oil|gas|energy/i.test(commodity.commodity)) {
      signals.push(buildWorldSignal('energy_supply_shock', 'chokepoint', `${cp.name || region} energy exposure`, {
        sourceKey: cp.id || cp.name || region,
        region,
        strength: normalize(riskScore * commodity.sensitivity, 35, 85),
        confidence: 0.76,
        domains: ['market', 'supply_chain'],
        supportingEvidence: [`${commodity.commodity} sensitivity ${commodity.sensitivity}`],
      }));
    }
    if (commodity) {
      signals.push(buildWorldSignal('commodity_repricing', 'chokepoint', `${commodity.commodity} repricing risk from ${cp.name || region}`, {
        sourceKey: cp.id || cp.name || region,
        region,
        strength: normalize(riskScore * commodity.sensitivity, 30, 90),
        confidence: 0.68,
        domains: ['market'],
        supportingEvidence: [`${commodity.commodity} exposure through ${cp.name || region}`],
      }));
    }
  }

  for (const index of shippingIndices) {
    const changePct = Math.abs(Number(index.changePct || 0));
    if (!index.spikeAlert && changePct < 5) continue;
    signals.push(buildWorldSignal('shipping_cost_shock', 'shipping_rates', `${index.name} freight repricing`, {
      sourceKey: index.indexId || index.name,
      region: /baltic/i.test(index.name) ? 'Northern Europe' : 'Global',
      strength: normalize(changePct, 4, 25),
      confidence: index.spikeAlert ? 0.82 : 0.7,
      domains: ['supply_chain', 'market'],
      supportingEvidence: [`${index.name} ${Number(index.changePct || 0).toFixed(1)}%`],
    }));
  }

  for (const quote of commodityQuotes) {
    const energyClass = classifyEnergyQuote(quote);
    const change = Math.abs(Number(quote.change || 0));
    const minMove = energyClass === 'gold' ? 1.2 : 1.8;
    if (change < minMove) continue;
    const isEnergy = Boolean(energyClass) && energyClass !== 'gold';
    const type = isEnergy ? 'energy_supply_shock' : 'commodity_repricing';
    signals.push(buildWorldSignal(type, 'commodity_quotes', `${quote.name || quote.symbol} moved ${Number(quote.change || 0).toFixed(1)}%`, {
      sourceKey: quote.symbol || quote.name,
      region: isEnergy ? 'Middle East' : 'Global',
      strength: normalize(change, 1.5, 7),
      confidence: 0.66,
      domains: ['market'],
      supportingEvidence: [`${quote.symbol || quote.name} price ${quote.price || 0}`],
    }));
    if (energyClass === 'gas') {
      signals.push(buildWorldSignal('gas_supply_stress', 'commodity_quotes', `${quote.name || quote.symbol} is signalling gas-market stress`, {
        sourceKey: quote.symbol || quote.name,
        region: 'Global',
        strength: normalize(change, 1.8, 9),
        confidence: 0.68,
        domains: ['market', 'supply_chain'],
        supportingEvidence: [`${quote.symbol || quote.name} moved ${Number(quote.change || 0).toFixed(1)}%`],
      }));
    }
    if (energyClass === 'gold' && Number(quote.change || 0) >= 1.2) {
      signals.push(buildWorldSignal('safe_haven_bid', 'commodity_quotes', `${quote.name || quote.symbol} is catching a safe-haven bid`, {
        sourceKey: quote.symbol || quote.name,
        region: 'Global',
        strength: normalize(Number(quote.change || 0), 1.2, 4.5),
        confidence: 0.58,
        domains: ['market', 'political'],
        supportingEvidence: [`${quote.name || quote.symbol} rose ${Number(quote.change || 0).toFixed(1)}%`],
      }));
    }
  }

  const negativeStocks = marketQuotes.filter((quote) => Number(quote.change || 0) <= -1.5).length;
  if (negativeStocks >= 4) {
    signals.push(buildWorldSignal('risk_off_rotation', 'market_quotes', 'Broad equity risk-off rotation', {
      sourceKey: 'market:stocks-bootstrap:v1',
      region: 'Global',
      strength: normalize(negativeStocks, 4, 12),
      confidence: 0.64,
      domains: ['market'],
      supportingEvidence: [`${negativeStocks} stock benchmarks fell more than 1.5%`],
    }));
  }

  const energySector = sectorItems.find((item) => /xle|energy/i.test(`${item.symbol || ''} ${item.name || ''}`));
  if (energySector && Number(energySector.change || 0) >= 1.5) {
    signals.push(buildWorldSignal('commodity_repricing', 'sector_summary', 'Energy sector repricing', {
      sourceKey: energySector.symbol || energySector.name,
      region: 'Global',
      strength: normalize(Math.abs(Number(energySector.change || 0)), 1.5, 5),
      confidence: 0.58,
      domains: ['market'],
      supportingEvidence: [`${energySector.symbol || energySector.name} ${Number(energySector.change || 0).toFixed(1)}%`],
    }));
  }

  const defenseSector = sectorItems.find((item) => /ita|xar|defen|aerospace/i.test(`${item.symbol || ''} ${item.name || ''}`));
  if (defenseSector && Number(defenseSector.change || 0) >= 1.2) {
    signals.push(buildWorldSignal('defense_repricing', 'sector_summary', 'Defense sector repricing', {
      sourceKey: defenseSector.symbol || defenseSector.name,
      region: 'Global',
      strength: normalize(Math.abs(Number(defenseSector.change || 0)), 1.2, 4.5),
      confidence: 0.62,
      domains: ['market', 'conflict'],
      supportingEvidence: [`${defenseSector.symbol || defenseSector.name} ${Number(defenseSector.change || 0).toFixed(1)}%`],
    }));
  }

  for (const quote of gulfQuotes) {
    const energyClass = classifyEnergyQuote(quote);
    if ((quote.type === 'oil' || energyClass === 'wti' || energyClass === 'brent' || energyClass === 'energy_generic') && Math.abs(Number(quote.change || 0)) >= 1.5) {
      signals.push(buildWorldSignal('energy_supply_shock', 'gulf_quotes', `${quote.name} moved ${Number(quote.change || 0).toFixed(1)}%`, {
        sourceKey: quote.symbol || quote.name,
        region: 'Middle East',
        strength: normalize(Math.abs(Number(quote.change || 0)), 1.5, 6),
        confidence: 0.68,
        domains: ['market'],
        supportingEvidence: [`${quote.name} ${Number(quote.change || 0).toFixed(1)}%`],
      }));
    }
    if ((quote.type === 'gas' || energyClass === 'gas') && Math.abs(Number(quote.change || 0)) >= 1.8) {
      signals.push(buildWorldSignal('gas_supply_stress', 'gulf_quotes', `${quote.name} moved ${Number(quote.change || 0).toFixed(1)}%`, {
        sourceKey: quote.symbol || quote.name,
        region: 'Middle East',
        strength: normalize(Math.abs(Number(quote.change || 0)), 1.8, 8),
        confidence: 0.7,
        domains: ['market', 'supply_chain'],
        supportingEvidence: [`${quote.name} ${Number(quote.change || 0).toFixed(1)}%`],
      }));
    }
  }

  const wtiQuote = energyQuotes.get('wti');
  const brentQuote = energyQuotes.get('brent');
  if (Number.isFinite(wtiQuote?.price) && Number.isFinite(brentQuote?.price)) {
    const spread = Number(brentQuote.price) - Number(wtiQuote.price);
    if (spread >= 3) {
      signals.push(buildWorldSignal('global_crude_spread_stress', 'commodity_quotes', `Brent-WTI spread widened to ${spread.toFixed(1)}`, {
        sourceKey: 'brent_wti_spread',
        region: 'Global',
        strength: normalizeSignalStrength(spread, 3, 12),
        confidence: 0.78,
        domains: ['market', 'supply_chain'],
        supportingEvidence: [
          `${brentQuote.name} ${Number(brentQuote.price).toFixed(1)}`,
          `${wtiQuote.name} ${Number(wtiQuote.price).toFixed(1)}`,
        ],
      }));
    }
  }

  const totalEtfFlow = Number(inputs?.etfFlows?.summary?.totalEstFlow || 0);
  if (Math.abs(totalEtfFlow) > 100_000_000) {
    signals.push(buildWorldSignal('risk_off_rotation', 'etf_flows', totalEtfFlow > 0 ? 'ETF inflow impulse' : 'ETF outflow impulse', {
      sourceKey: 'market:etf-flows:v1',
      region: 'Global',
      strength: normalize(Math.abs(totalEtfFlow), 100_000_000, 1_000_000_000),
      confidence: 0.56,
      domains: ['market'],
      supportingEvidence: [`Net estimated ETF flow ${Math.round(totalEtfFlow / 1_000_000)}m`],
    }));
  }
  if (etfItems.filter((item) => item.direction === 'outflow').length >= 5) {
    signals.push(buildWorldSignal('risk_off_rotation', 'etf_flows', 'ETF outflow breadth', {
      sourceKey: 'market:etf-flows:v1',
      region: 'Global',
      strength: normalize(etfItems.filter((item) => item.direction === 'outflow').length, 4, 10),
      confidence: 0.54,
      domains: ['market', 'crypto'],
      supportingEvidence: ['Broad ETF outflow bias across tracked products'],
    }));
  }

  const cryptoWeakness = cryptoQuotes.filter((item) => Number(item.change || 0) <= -3.5).length;
  if (cryptoWeakness >= 2) {
    signals.push(buildWorldSignal('risk_off_rotation', 'crypto_quotes', 'Crypto risk reduction', {
      sourceKey: 'market:crypto:v1',
      region: 'Global',
      strength: normalize(cryptoWeakness, 2, 6),
      confidence: 0.52,
      domains: ['market', 'cyber'],
      supportingEvidence: [`${cryptoWeakness} tracked crypto assets fell more than 3.5%`],
    }));
  }

  if (stablecoins.some((coin) => Number(coin.deviation || 0) >= 0.5 || /warning|depegged/i.test(coin.pegStatus || ''))) {
    const stressed = stablecoins.filter((coin) => Number(coin.deviation || 0) >= 0.5 || /warning|depegged/i.test(coin.pegStatus || ''));
    signals.push(buildWorldSignal('fx_stress', 'stablecoins', 'Stablecoin peg stress', {
      sourceKey: 'market:stablecoins:v1',
      region: 'Global',
      strength: normalize(Math.max(...stressed.map((coin) => Number(coin.deviation || 0))), 0.5, 3),
      confidence: 0.62,
      domains: ['market', 'cyber'],
      supportingEvidence: stressed.slice(0, 2).map((coin) => `${coin.symbol} deviation ${coin.deviation}%`),
    }));
  }

  for (const rate of bisExchange) {
    const realChange = Math.abs(Number(rate.realChange || 0));
    if (realChange < 2) continue;
    signals.push(buildWorldSignal('fx_stress', 'bis_exchange', `${rate.countryName} exchange-rate stress`, {
      sourceKey: rate.countryCode || rate.countryName,
      region: rate.countryName || '',
      strength: normalize(realChange, 2, 8),
      confidence: 0.7,
      domains: ['market', 'political'],
      supportingEvidence: [`Real EER change ${Number(rate.realChange || 0).toFixed(1)}`],
    }));
  }

  for (const rate of bisPolicy) {
    const delta = Math.abs(Number(rate.rate || 0) - Number(rate.previousRate || 0));
    if (delta < 0.25) continue;
    signals.push(buildWorldSignal('policy_rate_pressure', 'bis_policy', `${rate.countryName} policy-rate shift`, {
      sourceKey: rate.countryCode || rate.countryName,
      region: rate.countryName || '',
      strength: normalize(delta, 0.25, 1.5),
      confidence: 0.72,
      domains: ['market', 'political'],
      supportingEvidence: [`Policy rate moved ${delta.toFixed(2)} points`],
    }));
  }

  const economicCards = correlationCards.filter((item) => /economic|market|sanctions/i.test(`${item.domain || ''} ${item.title || ''}`));
  if (economicCards.length > 0) {
    signals.push(buildWorldSignal('risk_off_rotation', 'correlation_cards', 'Economic stress correlations are active', {
      sourceKey: 'correlation:cards-bootstrap:v1',
      region: 'Global',
      strength: normalize(economicCards.length, 1, 6),
      confidence: 0.48,
      domains: ['market'],
      supportingEvidence: economicCards.slice(0, 2).map((item) => item.title || item.summary || item.label || 'economic correlation'),
    }));
  }

  const vixSeries = fredSeries.VIXCLS;
  const vixLatest = getFredLatestValue(vixSeries);
  if (Number.isFinite(vixLatest) && vixLatest >= 18) {
    signals.push(buildWorldSignal('volatility_shock', 'fred', `VIX moved to ${vixLatest.toFixed(1)}`, {
      sourceKey: 'VIXCLS',
      region: 'Global',
      strength: normalizeSignalStrength(vixLatest, 17, 36),
      confidence: 0.74,
      domains: ['market'],
      supportingEvidence: [`VIX latest ${vixLatest.toFixed(1)}`],
    }));
  }

  const curveSeries = fredSeries.T10Y2Y;
  const curveLatest = getFredLatestValue(curveSeries);
  if (Number.isFinite(curveLatest) && curveLatest <= 0.4) {
    signals.push(buildWorldSignal('yield_curve_stress', 'fred', `Yield-curve stress at ${curveLatest.toFixed(2)}`, {
      sourceKey: 'T10Y2Y',
      region: 'United States',
      macroRegion: 'Americas',
      strength: normalizeSignalStrength(0.45 - curveLatest, 0.05, 1.25),
      confidence: 0.72,
      domains: ['market', 'political'],
      supportingEvidence: [`10Y-2Y spread ${curveLatest.toFixed(2)}`],
    }));
  }

  const fedFundsSeries = fredSeries.FEDFUNDS;
  const fedFundsLatest = getFredLatestValue(fedFundsSeries);
  if (Number.isFinite(fedFundsLatest) && fedFundsLatest >= 3.25) {
    signals.push(buildWorldSignal('policy_rate_pressure', 'fred', `Fed policy remains restrictive at ${fedFundsLatest.toFixed(2)}%`, {
      sourceKey: 'FEDFUNDS',
      region: 'United States',
      macroRegion: 'Americas',
      strength: normalizeSignalStrength(fedFundsLatest, 3.25, 6),
      confidence: 0.74,
      domains: ['market', 'political'],
      supportingEvidence: [`Fed funds ${fedFundsLatest.toFixed(2)}%`],
    }));
  }

  const dgs10Series = fredSeries.DGS10;
  const dgs10Latest = getFredLatestValue(dgs10Series);
  if (Number.isFinite(dgs10Latest) && dgs10Latest >= 4) {
    signals.push(buildWorldSignal('policy_rate_pressure', 'fred', `10Y Treasury yield at ${dgs10Latest.toFixed(2)}%`, {
      sourceKey: 'DGS10',
      region: 'United States',
      macroRegion: 'Americas',
      strength: normalizeSignalStrength(dgs10Latest, 4, 5.5),
      confidence: 0.68,
      domains: ['market'],
      supportingEvidence: [`10Y Treasury ${dgs10Latest.toFixed(2)}%`],
    }));
  }

  const cpiSeries = fredSeries.CPIAUCSL;
  const cpiYoY = getFredRelativeChange(cpiSeries, 12);
  if (Number.isFinite(cpiYoY) && cpiYoY >= 2.4) {
    signals.push(buildWorldSignal('inflation_impulse', 'fred', `Consumer inflation is running near ${cpiYoY.toFixed(1)}% year-on-year`, {
      sourceKey: 'CPIAUCSL',
      region: 'United States',
      macroRegion: 'Americas',
      strength: normalizeSignalStrength(cpiYoY, 2.4, 6.5),
      confidence: 0.76,
      domains: ['market', 'political'],
      supportingEvidence: [`CPI year-on-year ${cpiYoY.toFixed(1)}%`],
    }));
  }

  const unemploymentSeries = fredSeries.UNRATE;
  const unemploymentLatest = getFredLatestValue(unemploymentSeries);
  const unemploymentDelta = getFredAbsoluteChange(unemploymentSeries, 3);
  if ((Number.isFinite(unemploymentLatest) && unemploymentLatest >= 4.1) || (Number.isFinite(unemploymentDelta) && unemploymentDelta >= 0.2)) {
    signals.push(buildWorldSignal('labor_softness', 'fred', `Labor-market softness at ${Number(unemploymentLatest || 0).toFixed(1)}% unemployment`, {
      sourceKey: 'UNRATE',
      region: 'United States',
      macroRegion: 'Americas',
      strength: normalizeSignalStrength(Math.max(Number(unemploymentLatest || 0), (Number(unemploymentDelta || 0) * 10)), 4, 6.2),
      confidence: 0.66,
      domains: ['market', 'political'],
      supportingEvidence: [
        `Unemployment ${Number(unemploymentLatest || 0).toFixed(1)}%`,
        Number.isFinite(unemploymentDelta) ? `3-month change ${unemploymentDelta.toFixed(1)} points` : '',
      ].filter(Boolean),
    }));
  }

  const walclSeries = fredSeries.WALCL;
  const walclChange = getFredRelativeChange(walclSeries, 13);
  if (Number.isFinite(walclChange) && Math.abs(walclChange) >= 1.5) {
    const liquidityType = walclChange > 0 ? 'liquidity_expansion' : 'liquidity_withdrawal';
    signals.push(buildWorldSignal(liquidityType, 'fred', walclChange > 0 ? 'Fed balance sheet expansion' : 'Fed balance sheet contraction', {
      sourceKey: 'WALCL',
      region: 'United States',
      macroRegion: 'Americas',
      strength: normalizeSignalStrength(Math.abs(walclChange), 1.5, 8),
      confidence: 0.66,
      domains: ['market'],
      supportingEvidence: [`WALCL 13-week change ${walclChange.toFixed(1)}%`],
    }));
  }

  const m2Series = fredSeries.M2SL;
  const m2Change = getFredRelativeChange(m2Series, 6);
  if (Number.isFinite(m2Change) && Math.abs(m2Change) >= 1.5) {
    const liquidityType = m2Change > 0 ? 'liquidity_expansion' : 'liquidity_withdrawal';
    signals.push(buildWorldSignal(liquidityType, 'fred', m2Change > 0 ? 'Money supply expansion' : 'Money supply contraction', {
      sourceKey: 'M2SL',
      region: 'United States',
      macroRegion: 'Americas',
      strength: normalizeSignalStrength(Math.abs(m2Change), 1.5, 8),
      confidence: 0.6,
      domains: ['market'],
      supportingEvidence: [`M2 6-month change ${m2Change.toFixed(1)}%`],
    }));
  }

  const oilSeries = fredSeries.DCOILWTICO;
  const oilLatest = getFredLatestValue(oilSeries);
  const oilChange = getFredRelativeChange(oilSeries, 20);
  if ((Number.isFinite(oilLatest) && oilLatest >= 80) || (Number.isFinite(oilChange) && oilChange >= 8)) {
    signals.push(buildWorldSignal('oil_macro_shock', 'fred', `WTI oil pressure at ${Number(oilLatest || 0).toFixed(1)}`, {
      sourceKey: 'DCOILWTICO',
      region: 'Middle East',
      macroRegion: 'EMEA',
      strength: normalizeSignalStrength(Math.max(Number(oilLatest || 0), Math.abs(Number(oilChange || 0)) * 4), 75, 110),
      confidence: 0.8,
      domains: ['market', 'supply_chain'],
      supportingEvidence: [
        Number.isFinite(oilLatest) ? `WTI ${oilLatest.toFixed(1)}` : '',
        Number.isFinite(oilChange) ? `20-session change ${oilChange.toFixed(1)}%` : '',
      ].filter(Boolean),
    }));
    signals.push(buildWorldSignal('energy_supply_shock', 'fred', `WTI crude is reinforcing energy stress at ${Number(oilLatest || 0).toFixed(1)}`, {
      sourceKey: 'DCOILWTICO',
      region: 'Middle East',
      macroRegion: 'EMEA',
      strength: normalizeSignalStrength(Math.max(Number(oilLatest || 0), Math.abs(Number(oilChange || 0)) * 4), 75, 110),
      confidence: 0.72,
      domains: ['market', 'supply_chain'],
      supportingEvidence: [`WTI is confirming energy transmission pressure`],
    }));
  }

  if (wtiQuote && Number.isFinite(oilLatest) && Number.isFinite(wtiQuote.price)) {
    const oilDivergence = Math.abs(Number(wtiQuote.price) - Number(oilLatest));
    if (oilDivergence >= 2.5) {
      signals.push(buildWorldSignal('oil_macro_shock', 'cross_market_confirmation', `Spot and FRED WTI diverged by ${oilDivergence.toFixed(1)}`, {
        sourceKey: 'wti_spot_fred_divergence',
        region: 'Global',
        strength: normalizeSignalStrength(oilDivergence, 2.5, 10),
        confidence: 0.62,
        domains: ['market'],
        supportingEvidence: [
          `Spot WTI ${Number(wtiQuote.price).toFixed(1)}`,
          `FRED WTI ${oilLatest.toFixed(1)}`,
        ],
      }));
    }
  }

  const gdpSeries = fredSeries.GDP;
  const gdpChange = getFredRelativeChange(gdpSeries, 1);
  if (Number.isFinite(gdpChange) && gdpChange <= 0.2) {
    signals.push(buildWorldSignal('sovereign_stress', 'fred', 'Growth is slowing into sovereign-risk conditions', {
      sourceKey: 'GDP',
      region: 'United States',
      macroRegion: 'Americas',
      strength: normalizeSignalStrength(0.25 - gdpChange, 0.05, 1.5),
      confidence: 0.58,
      domains: ['market', 'political'],
      supportingEvidence: [`Quarterly GDP change ${gdpChange.toFixed(2)}%`],
    }));
  }

  for (const pred of predictions) {
    if ((pred.domain === 'conflict' || pred.domain === 'military') && (pred.probability || 0) >= 0.55) {
      signals.push(buildWorldSignal('security_escalation', 'forecast', pred.title, {
        sourceKey: pred.id,
        region: pred.region,
        strength: pred.probability || 0,
        confidence: pred.confidence || 0,
        domains: [pred.domain],
        supportingEvidence: (pred.signals || []).slice(0, 2).map((item) => item.value),
      }));
    }
    if (pred.domain === 'cyber' && (pred.probability || 0) >= 0.45) {
      signals.push(buildWorldSignal('cyber_cost_repricing', 'forecast', pred.title, {
        sourceKey: pred.id,
        region: pred.region,
        strength: pred.probability || 0,
        confidence: pred.confidence || 0,
        domains: [pred.domain, 'market'],
        supportingEvidence: (pred.signals || []).slice(0, 2).map((item) => item.value),
      }));
    }
    if (pred.domain === 'infrastructure' && (pred.probability || 0) >= 0.45) {
      signals.push(buildWorldSignal('infrastructure_capacity_loss', 'forecast', pred.title, {
        sourceKey: pred.id,
        region: pred.region,
        strength: pred.probability || 0,
        confidence: pred.confidence || 0,
        domains: [pred.domain, 'market'],
        supportingEvidence: (pred.signals || []).slice(0, 2).map((item) => item.value),
      }));
    }
  }

  const dedupedSignals = [];
  const dedupedSignalIndex = new Map();
  for (const signal of signals) {
    const key = CRITICAL_NEWS_SOURCE_TYPES.has(signal.sourceType)
      ? `${signal.type}:${signal.region}:${signal.label}`
      : `${signal.type}:${signal.sourceKey}:${signal.region}:${signal.label}`;
    const existingIndex = dedupedSignalIndex.get(key);
    if (existingIndex != null) {
      const existing = dedupedSignals[existingIndex];
      existing.strength = Math.max(existing.strength, signal.strength);
      existing.confidence = Math.max(existing.confidence, signal.confidence);
      existing.countries = uniqueSortedStrings([...(existing.countries || []), ...(signal.countries || [])]);
      existing.actors = uniqueSortedStrings([...(existing.actors || []), ...(signal.actors || [])]);
      existing.domains = uniqueSortedStrings([...(existing.domains || []), ...(signal.domains || [])]);
      existing.supportingEvidence = mergeSignalLists(existing.supportingEvidence, signal.supportingEvidence, 3);
      continue;
    }
    dedupedSignalIndex.set(key, dedupedSignals.length);
    dedupedSignals.push(signal);
  }

  const criticalSignals = dedupedSignals
    .filter((signal) => CRITICAL_NEWS_SOURCE_TYPES.has(signal.sourceType))
    .sort((a, b) => (b.strength + b.confidence) - (a.strength + a.confidence) || a.label.localeCompare(b.label));
  const signalTypeCounts = summarizeTypeCounts(dedupedSignals.map((item) => item.type));
  return {
    summary: summarizeWorldSignals(dedupedSignals),
    typeCounts: signalTypeCounts,
    criticalSignalCount: criticalSignals.length,
    criticalSignals: criticalSignals.slice(0, 16),
    criticalExtraction: criticalSignalBundle ? {
      source: criticalSignalBundle.source || 'deterministic_only',
      provider: criticalSignalBundle.provider || '',
      model: criticalSignalBundle.model || '',
      parseStage: criticalSignalBundle.parseStage || '',
      failureReason: criticalSignalBundle.failureReason || '',
      candidateCount: Number(criticalSignalBundle.candidateCount || 0),
      extractedFrameCount: Number(criticalSignalBundle.extractedFrameCount || 0),
      mappedSignalCount: Number(criticalSignalBundle.mappedSignalCount || 0),
      fallbackNewsSignalCount: Number(criticalSignalBundle.fallbackNewsSignalCount || 0),
      structuredSignalCount: Number(criticalSignalBundle.structuredSignalCount || 0),
      rawPreview: criticalSignalBundle.rawPreview || '',
      candidates: Array.isArray(criticalSignalBundle.candidates) ? criticalSignalBundle.candidates.slice(0, 8) : [],
    } : null,
    signals: dedupedSignals
      .sort((a, b) => (b.strength + b.confidence) - (a.strength + a.confidence) || a.label.localeCompare(b.label))
      .slice(0, 80),
  };
}

function inferSituationMarketBuckets(situation) {
  const buckets = new Set();
  const domains = uniqueSortedStrings([situation?.dominantDomain, ...(situation?.domains || [])].filter(Boolean));
  const region = situation?.dominantRegion || situation?.regions?.[0] || '';
  const label = (situation?.label || '').toLowerCase();

  if (domains.includes('conflict') || domains.includes('military')) {
    buckets.add('sovereign_risk');
    buckets.add('defense');
    if (/middle east|red sea|black sea|eastern mediterranean|israel|gaza/i.test(region)) buckets.add('energy');
    if (/red sea|black sea|eastern mediterranean|south china sea|western pacific/i.test(region)) buckets.add('freight');
  }
  if (domains.includes('supply_chain')) {
    buckets.add('freight');
    buckets.add('rates_inflation');
    if (/middle east|red sea|black sea/i.test(region) || /oil|gas|grain|shipping|freight/i.test(label)) buckets.add('energy');
    if (/western pacific|south china sea|taiwan/i.test(region) || /semiconductor|chip/i.test(label)) buckets.add('semis');
  }
  if (domains.includes('political')) {
    buckets.add('sovereign_risk');
    buckets.add('fx_stress');
  }
  if (domains.includes('cyber')) {
    buckets.add('semis');
    buckets.add('crypto_stablecoins');
  }
  if (domains.includes('infrastructure')) {
    buckets.add('rates_inflation');
    if (/power|grid|pipeline|energy/i.test(label)) buckets.add('energy');
  }
  if (domains.includes('market')) {
    if (/oil|gas|energy|crude/i.test(label)) buckets.add('energy');
    if (/shipping|freight|port|strait|canal/i.test(label)) buckets.add('freight');
    if (/fx|currency|exchange/i.test(label)) buckets.add('fx_stress');
    if (/inflation|rates|yield|pricing/i.test(label)) buckets.add('rates_inflation');
    if (buckets.size === 0) buckets.add('sovereign_risk');
  }

  return [...buckets];
}

function buildMarketTransmissionGraph(worldSignals, situationClusters = []) {
  const signals = Array.isArray(worldSignals?.signals) ? worldSignals.signals : [];
  const edges = [];

  for (const situation of situationClusters) {
    const bucketIds = inferSituationMarketBuckets(situation);
    if (bucketIds.length === 0) continue;
    const regionSet = new Set(uniqueSortedStrings([situation.dominantRegion, ...(situation.regions || [])].filter(Boolean)));
    const supportingSignals = signals.filter((signal) =>
      (signal.region && regionSet.has(signal.region))
      || (signal.macroRegion && signal.macroRegion === getMacroRegion([...regionSet]))
      || intersectCount(signal.domains || [], situation.domains || []) > 0
    );

    for (const bucketId of bucketIds) {
      const bucketConfig = MARKET_BUCKET_CONFIG.find((item) => item.id === bucketId);
      const bucketSignals = supportingSignals.filter((signal) => bucketConfig?.signalTypes.includes(signal.type));
      const baseStrength = Number(situation.avgProbability || 0) * 0.55
        + Math.min(0.3, (bucketSignals.length || 0) * 0.06)
        + (intersectCount(situation.domains || [], ['market', 'supply_chain']) > 0 ? 0.05 : 0);
      edges.push({
        edgeId: `tx-${createStableHash(`${situation.id}:${bucketId}`)}`,
        sourceSituationId: situation.id,
        sourceLabel: situation.label,
        targetBucketId: bucketId,
        targetLabel: bucketConfig?.label || bucketId,
        channel: bucketSignals[0]?.type || 'derived_transmission',
        strength: normalizeSignalStrength(baseStrength, 0, 1),
        confidence: normalizeSignalStrength((situation.avgConfidence || 0) * 0.6 + Math.min(0.35, bucketSignals.length * 0.08), 0, 1),
        supportingSignalIds: bucketSignals.slice(0, 4).map((signal) => signal.id),
        supportingSignals: bucketSignals.slice(0, 3).map((signal) => signal.label),
        summary: `${situation.label} is feeding ${bucketConfig?.label || bucketId} pressure through ${(bucketSignals[0]?.type || 'derived transmission').replace(/_/g, ' ')}.`,
      });
    }
  }

  return {
    summary: `${edges.length} situation-to-market transmission edges are currently active across ${MARKET_BUCKET_CONFIG.length} tracked market buckets.`,
    edges: edges
      .sort((a, b) => (b.strength + b.confidence) - (a.strength + a.confidence) || a.sourceLabel.localeCompare(b.sourceLabel))
      .slice(0, 80),
  };
}

function buildMarketState(worldSignals, transmissionGraph) {
  const signals = Array.isArray(worldSignals?.signals) ? worldSignals.signals : [];
  const transmissionEdges = Array.isArray(transmissionGraph?.edges) ? transmissionGraph.edges : [];
  const buckets = MARKET_BUCKET_CONFIG.map((config) => {
    const bucketSignals = signals.filter((signal) => config.signalTypes.includes(signal.type));
    const bucketEdges = transmissionEdges.filter((edge) => edge.targetBucketId === config.id);
    const weightedSignals = bucketSignals.map((signal) => ({
      ...signal,
      bucketWeight: Number(config.signalWeights?.[signal.type] || 1),
    }));
    const macroSignals = weightedSignals.filter((signal) => signal.sourceType === 'fred' || signal.sourceType === 'bis_policy' || signal.sourceType === 'bis_exchange');
    const pressureNumerator = weightedSignals.reduce((sum, signal) => sum + (signal.strength * signal.bucketWeight), 0)
      + bucketEdges.reduce((sum, edge) => sum + (edge.strength * Number(config.edgeWeight || 1)), 0);
    const confidenceNumerator = weightedSignals.reduce((sum, signal) => sum + (signal.confidence * signal.bucketWeight), 0)
      + bucketEdges.reduce((sum, edge) => sum + (edge.confidence * Number(config.edgeWeight || 1)), 0);
    const divisor = Math.max(
      1,
      weightedSignals.reduce((sum, signal) => sum + signal.bucketWeight, 0) + (bucketEdges.length * Number(config.edgeWeight || 1)),
    );
    const macroConfirmation = macroSignals.length
      ? clampUnitInterval(macroSignals.reduce((sum, signal) => sum + signal.strength, 0) / macroSignals.length)
      : 0;
    const calibration = MARKET_BUCKET_STATE_CALIBRATION[config.id] || {};
    const defenseSignalConfirmation = config.id === 'defense' && bucketSignals.length
      ? clampUnitInterval(
        bucketSignals
          .filter((signal) => signal.type === 'defense_repricing')
          .reduce((sum, signal) => sum + Number(signal.strength || 0), 0),
      )
      : 0;
    const edgeDensity = bucketEdges.length
      ? clampUnitInterval(bucketEdges.reduce((sum, edge) => sum + Number(edge.strength || 0), 0) / bucketEdges.length)
      : 0;
    const calibratedPressure = (pressureNumerator / divisor)
      + (macroConfirmation * Number(calibration.macroLift || 0))
      + (edgeDensity * Number(calibration.edgeLift || 0))
      + (defenseSignalConfirmation * 0.12)
      - (!defenseSignalConfirmation && config.id === 'defense' ? Number(calibration.dampener || 0) : 0);
    const calibratedConfidence = (confidenceNumerator / divisor)
      + Math.min(0.08, macroSignals.length * 0.02)
      + (edgeDensity * Number(calibration.confidenceLift || 0))
      + (defenseSignalConfirmation * 0.08)
      - (!defenseSignalConfirmation && config.id === 'defense' ? 0.04 : 0);
    const pressureScore = +clampUnitInterval(calibratedPressure).toFixed(3);
    const confidence = +clampUnitInterval(calibratedConfidence).toFixed(3);
    return {
      id: config.id,
      label: config.label,
      pressureScore,
      confidence,
      macroConfirmation: +macroConfirmation.toFixed(3),
      defenseConfirmation: +defenseSignalConfirmation.toFixed(3),
      direction: pressureScore >= 0.6 ? 'elevated' : pressureScore >= 0.4 ? 'active' : 'contained',
      topSignals: weightedSignals
        .slice()
        .sort((a, b) => ((b.strength * b.bucketWeight) + b.confidence) - ((a.strength * a.bucketWeight) + a.confidence) || a.label.localeCompare(b.label))
        .slice(0, 3)
        .map((signal) => ({
        id: signal.id,
        type: signal.type,
        label: signal.label,
        strength: signal.strength,
        bucketWeight: signal.bucketWeight,
      })),
      topSituations: bucketEdges
        .slice()
        .sort((a, b) => ((b.strength + b.confidence) * Number(config.edgeWeight || 1)) - ((a.strength + a.confidence) * Number(config.edgeWeight || 1)) || a.sourceLabel.localeCompare(b.sourceLabel))
        .slice(0, 3)
        .map((edge) => ({
        situationId: edge.sourceSituationId,
        label: edge.sourceLabel,
        strength: edge.strength,
      })),
      summary: `${config.label} pressure is ${pressureScore >= 0.6 ? 'elevated' : pressureScore >= 0.4 ? 'active' : 'contained'}, led by ${weightedSignals[0]?.label || bucketEdges[0]?.sourceLabel || 'no major driver'}${macroSignals.length ? ` with ${roundPct(macroConfirmation)} macro confirmation` : ''}${config.id === 'defense' && defenseSignalConfirmation > 0 ? ` and ${roundPct(defenseSignalConfirmation)} defense confirmation` : ''}.`,
    };
  }).filter((bucket) => bucket.pressureScore > 0 || bucket.topSignals.length > 0 || bucket.topSituations.length > 0);

  const topBucket = buckets
    .slice()
    .sort((a, b) => b.pressureScore - a.pressureScore || b.confidence - a.confidence || a.label.localeCompare(b.label))[0];
  return {
    summary: `${buckets.length} market-state buckets are active, led by ${topBucket ? `${topBucket.label} at ${roundPct(topBucket.pressureScore)}` : 'no significant market pressure'}.`,
    buckets,
    topBucketId: topBucket?.id || '',
    topBucketLabel: topBucket?.label || '',
  };
}

function buildSituationMarketContextIndex(worldSignals, marketTransmission, marketState, sourceItems = [], marketInputCoverage = null) {
  const signals = Array.isArray(worldSignals?.signals) ? worldSignals.signals : [];
  const edges = Array.isArray(marketTransmission?.edges) ? marketTransmission.edges : [];
  const bucketMap = new Map((marketState?.buckets || []).map((bucket) => [bucket.id, bucket]));
  const contexts = new Map();

  for (const source of sourceItems || []) {
    const sourceSituationIds = uniqueSortedStrings([
      ...(source?.sourceSituationIds || source?.situationIds || []),
      source?.id,
    ].filter(Boolean));
    const situationEdges = edges.filter((edge) => sourceSituationIds.includes(edge.sourceSituationId));
    const bucketContexts = {};
    for (const bucketId of uniqueSortedStrings(situationEdges.map((edge) => edge.targetBucketId))) {
      const bucket = bucketMap.get(bucketId);
      if (!bucket) continue;
      const bucketEdges = situationEdges.filter((edge) => edge.targetBucketId === bucketId);
      const supportingSignalIds = uniqueSortedStrings(bucketEdges.flatMap((edge) => edge.supportingSignalIds || []));
      const supportingSignals = supportingSignalIds
        .map((signalId) => signals.find((signal) => signal.id === signalId))
        .filter(Boolean);
      const topEdge = bucketEdges
        .slice()
        .sort(compareTransmissionEdgePriority)[0] || null;
      bucketContexts[bucketId] = {
        bucketId,
        bucketLabel: bucket.label,
        edgeCount: bucketEdges.length,
        topChannel: topEdge?.channel || '',
        topTransmissionStrength: Number(topEdge?.strength || 0),
        topTransmissionConfidence: Number(topEdge?.confidence || 0),
        supportingSignalIds,
        supportingSignalTypes: uniqueSortedStrings(supportingSignals.map((signal) => signal.type)),
      };
    }
    const linkedBuckets = uniqueSortedStrings(situationEdges.map((edge) => edge.targetBucketId))
      .map((bucketId) => bucketMap.get(bucketId))
      .filter(Boolean)
      .sort((left, right) => {
        const leftContext = bucketContexts[left.id] || {};
        const rightContext = bucketContexts[right.id] || {};
        return (right.pressureScore + right.confidence + Number(rightContext.topTransmissionStrength || 0)) - (left.pressureScore + left.confidence + Number(leftContext.topTransmissionStrength || 0))
          || left.label.localeCompare(right.label);
      });
    const linkedSignalIds = uniqueSortedStrings(situationEdges.flatMap((edge) => edge.supportingSignalIds || []));
    const linkedSignals = linkedSignalIds
      .map((signalId) => signals.find((signal) => signal.id === signalId))
      .filter(Boolean);
    const criticalSignals = linkedSignals.filter((signal) => CRITICAL_NEWS_SOURCE_TYPES.has(signal.sourceType));
    const avgEdgeStrength = situationEdges.length
      ? situationEdges.reduce((sum, edge) => sum + Number(edge.strength || 0), 0) / situationEdges.length
      : 0;
    const avgEdgeConfidence = situationEdges.length
      ? situationEdges.reduce((sum, edge) => sum + Number(edge.confidence || 0), 0) / situationEdges.length
      : 0;
    const avgBucketPressure = linkedBuckets.length
      ? linkedBuckets.reduce((sum, bucket) => sum + Number(bucket.pressureScore || 0), 0) / linkedBuckets.length
      : 0;
    const alignedSignalStrength = linkedSignals.length
      ? linkedSignals.reduce((sum, signal) => sum + Number(signal.strength || 0), 0) / linkedSignals.length
      : 0;
    const criticalSignalStrength = criticalSignals.length
      ? criticalSignals.reduce((sum, signal) => sum + ((Number(signal.strength || 0) * 0.62) + (Number(signal.confidence || 0) * 0.38)), 0) / criticalSignals.length
      : 0;
    const criticalSignalLift = clampUnitInterval(
      (criticalSignalStrength * 0.78) +
      Math.min(0.18, criticalSignals.length * 0.05),
    );
    const confirmationScore = clampUnitInterval(
      (avgEdgeStrength * 0.28) +
      (avgEdgeConfidence * 0.22) +
      (avgBucketPressure * 0.3) +
      (alignedSignalStrength * 0.12) +
      Math.min(0.08, linkedSignals.length * 0.02) +
      (criticalSignalLift * 0.12)
    );
    const contradictionScore = clampUnitInterval(
      (linkedBuckets.length === 0 && ['market', 'supply_chain', 'conflict', 'political', 'military'].includes(source.dominantDomain || '') ? 0.18 : 0) +
      (linkedBuckets.length > 0 && avgBucketPressure < 0.22 ? 0.08 : 0) +
      (linkedSignals.length === 0 && situationEdges.length > 0 ? 0.05 : 0) -
      Math.min(0.06, criticalSignalLift * 0.05)
    );
    const topBucket = linkedBuckets
      .slice()
      .sort((a, b) => (b.pressureScore + b.confidence) - (a.pressureScore + a.confidence) || a.label.localeCompare(b.label))[0];
    const topEdge = situationEdges
      .slice()
      .sort(compareTransmissionEdgePriority)[0];
    const topBucketCoverageScore = topBucket ? computeMarketBucketCoverageScore(topBucket.id, marketInputCoverage) : 0;

    contexts.set(source.id, {
      situationId: source.id,
      sourceSituationIds,
      linkedBucketIds: linkedBuckets.map((bucket) => bucket.id),
      linkedBuckets: linkedBuckets.map((bucket) => ({
        id: bucket.id,
        label: bucket.label,
        pressureScore: bucket.pressureScore,
        confidence: bucket.confidence,
      })),
      bucketContexts,
      linkedSignalIds,
      transmissionEdgeCount: situationEdges.length,
      confirmationScore: +confirmationScore.toFixed(3),
      contradictionScore: +contradictionScore.toFixed(3),
      criticalSignalCount: criticalSignals.length,
      criticalSignalLift: +criticalSignalLift.toFixed(3),
      criticalSignalTypes: uniqueSortedStrings(criticalSignals.map((signal) => signal.type)),
      topBucketId: topBucket?.id || '',
      topBucketLabel: topBucket?.label || '',
      topBucketPressure: Number(topBucket?.pressureScore || 0),
      topBucketCoverageScore,
      topChannel: (topBucket ? bucketContexts[topBucket.id]?.topChannel : '') || topEdge?.channel || '',
      topTransmissionStrength: Number(topEdge?.strength || 0),
      topTransmissionConfidence: Number(topEdge?.confidence || 0),
      consequenceSummary: topBucket
        ? `${source.label} is transmitting into ${topBucket.label} through ${String(bucketContexts[topBucket.id]?.topChannel || topEdge?.channel || 'derived_transmission').replace(/_/g, ' ')} with ${roundPct(topBucket.pressureScore || 0)} pressure.`
        : '',
    });
  }

  return {
    bySituationId: contexts,
    summary: `${contexts.size} state-aware market contexts were derived from active transmission edges and market buckets.`,
  };
}

function attachMarketSelectionContext(predictions = [], marketIndex = null) {
  const bySituationId = marketIndex?.bySituationId || new Map();
  for (const pred of predictions || []) {
    const situationId = pred?.stateContext?.id || pred?.situationContext?.id || '';
    const context = bySituationId.get(situationId) || null;
    pred.marketSelectionContext = context ? {
      situationId,
      confirmationScore: Number(context.confirmationScore || 0),
      contradictionScore: Number(context.contradictionScore || 0),
      linkedBucketIds: context.linkedBucketIds || [],
      topBucketId: context.topBucketId || '',
      topBucketLabel: context.topBucketLabel || '',
      topBucketPressure: Number(context.topBucketPressure || 0),
      topBucketCoverageScore: Number(context.topBucketCoverageScore || 0),
      topChannel: context.topChannel || '',
      transmissionEdgeCount: Number(context.transmissionEdgeCount || 0),
      topTransmissionStrength: Number(context.topTransmissionStrength || 0),
      topTransmissionConfidence: Number(context.topTransmissionConfidence || 0),
      criticalSignalCount: Number(context.criticalSignalCount || 0),
      criticalSignalLift: Number(context.criticalSignalLift || 0),
      criticalSignalTypes: context.criticalSignalTypes || [],
      consequenceSummary: context.consequenceSummary || '',
    } : null;
  }
}

function summarizeMarketInputCoverage(inputs = {}) {
  const coverage = {
    stocks: extractQuoteItems(inputs.marketQuotes).length,
    commodities: extractQuoteItems(inputs.commodityQuotes).length,
    sectors: extractSectorItems(inputs.sectorSummary).length,
    gulfQuotes: extractQuoteItems(inputs.gulfQuotes).length,
    etfFlows: extractEtfItems(inputs.etfFlows).length,
    crypto: extractQuoteItems(inputs.cryptoQuotes).length,
    stablecoins: Array.isArray(inputs?.stablecoinMarkets?.stablecoins) ? inputs.stablecoinMarkets.stablecoins.length : 0,
    bisExchange: extractRateItems(inputs.bisExchangeRates).length,
    bisPolicy: extractRateItems(inputs.bisPolicyRates).length,
    shippingRates: extractShippingIndices(inputs.shippingRates).length,
    correlationCards: extractCorrelationCards(inputs.correlationCards).length,
    fredSeries: Object.keys(extractFredSeriesMap(inputs.fredSeries)).length,
    militaryTheaters: Array.isArray(inputs?.militaryForecastInputs?.theaters) ? inputs.militaryForecastInputs.theaters.length : 0,
  };
  coverage.loadedSourceCount = Object.values(coverage).filter((count) => count > 0).length;
  return coverage;
}

function buildForecastRunWorldState(data) {
  const generatedAt = data?.generatedAt || Date.now();
  const predictions = Array.isArray(data?.predictions) ? data.predictions : [];
  const inputs = data?.inputs || {};
  const priorWorldState = data?.priorWorldState || null;
  const domainStates = buildForecastDomainStates(predictions);
  const regionalStates = buildForecastRegionalStates(predictions);
  const actorRegistry = buildForecastRunActorRegistry(predictions);
  const actorContinuity = buildActorContinuitySummary(actorRegistry, priorWorldState);
  const branchStates = buildForecastBranchStates(predictions);
  const branchContinuity = buildBranchContinuitySummary(branchStates, priorWorldState);
  const situationClusters = data?.situationClusters || buildSituationClusters(predictions);
  const situationFamilies = data?.situationFamilies || buildSituationFamilies(situationClusters);
  const stateUnits = data?.stateUnits || buildCanonicalStateUnits(situationClusters, situationFamilies);
  const situationContinuity = buildSituationContinuitySummary(situationClusters, priorWorldState);
  const situationSummary = buildSituationSummary(situationClusters, situationContinuity);
  const stateContinuity = buildSituationContinuitySummary(stateUnits, {
    situationClusters: Array.isArray(priorWorldState?.stateUnits) ? priorWorldState.stateUnits : [],
  });
  const stateSummary = buildStateUnitSummary(stateUnits, stateContinuity);
  const marketInputCoverage = summarizeMarketInputCoverage(inputs);
  const reportContinuity = buildReportContinuity({
    situationClusters,
  }, data?.priorWorldStates || []);
  const continuity = buildForecastRunContinuity(predictions);
  const evidenceLedger = buildForecastEvidenceLedger(predictions);
  const worldSignals = buildWorldSignals(inputs, predictions, situationClusters);
  const marketTransmission = buildMarketTransmissionGraph(worldSignals, situationClusters);
  const marketState = buildMarketState(worldSignals, marketTransmission);
  const activeDomains = domainStates.filter((item) => item.forecastCount > 0).map((item) => item.domain);
  const summary = `${predictions.length} active forecasts are spanning ${activeDomains.length} domains, ${regionalStates.length} key regions, ${situationClusters.length} clustered situations compressed into ${stateUnits.length} canonical state units, and ${situationFamilies.length} broader situation families in this run, with ${continuity.newForecasts} new forecasts, ${continuity.materiallyChanged.length} materially changed paths, ${actorContinuity.newlyActiveCount} newly active actors, ${branchContinuity.strengthenedBranchCount} strengthened branches, and ${marketState.buckets.length} active market-state buckets.`;
  const worldState = {
    version: 1,
    generatedAt,
    generatedAtIso: new Date(generatedAt).toISOString(),
    summary,
    domainStates,
    regionalStates,
    actorRegistry,
    actorContinuity,
    branchStates,
    branchContinuity,
    situationClusters,
    situationFamilies,
    situationContinuity,
    situationSummary,
    stateUnits,
    stateContinuity,
    stateSummary,
    reportContinuity,
    continuity,
    evidenceLedger,
    worldSignals,
    marketState,
    marketTransmission,
    marketInputCoverage,
    uncertainties: evidenceLedger.counter.slice(0, 10),
  };
  worldState.simulationState = buildSituationSimulationState(worldState, priorWorldState);
  worldState.report = buildWorldStateReport(worldState);
  return worldState;
}

function summarizeWorldStateSurface(worldState) {
  if (!worldState) return null;
  return {
    forecastCount: Array.isArray(worldState.branchStates) ? new Set(worldState.branchStates.map((branch) => branch.forecastId)).size : 0,
    domainCount: worldState.domainStates?.length || 0,
    regionCount: worldState.regionalStates?.length || 0,
    situationCount: worldState.situationClusters?.length || 0,
    stateUnitCount: worldState.stateUnits?.length || 0,
    familyCount: worldState.situationFamilies?.length || 0,
    worldSignalCount: worldState.worldSignals?.signals?.length || 0,
    criticalSignalCount: worldState.worldSignals?.criticalSignalCount || 0,
    criticalSignalCandidateCount: worldState.worldSignals?.criticalExtraction?.candidateCount || 0,
    criticalSignalFrameCount: worldState.worldSignals?.criticalExtraction?.extractedFrameCount || 0,
    marketBucketCount: worldState.marketState?.buckets?.length || 0,
    transmissionEdgeCount: worldState.marketTransmission?.edges?.length || 0,
    marketConsequenceCount: worldState.simulationState?.marketConsequences?.items?.length || 0,
    blockedMarketConsequenceCount: worldState.simulationState?.marketConsequences?.blockedCount || 0,
    simulationSituationCount: worldState.simulationState?.totalSituationSimulations || 0,
    simulationActionCount: worldState.simulationState?.actionLedger?.length || 0,
    simulationInteractionCount: worldState.simulationState?.interactionLedger?.length || 0,
    reportableInteractionCount: worldState.simulationState?.reportableInteractionLedger?.length || 0,
    internalEffectCount: worldState.simulationState?.internalEffects?.length || 0,
    simulationEffectCount: worldState.report?.crossSituationEffects?.length || 0,
    blockedEffectCount: worldState.simulationState?.blockedEffects?.length || 0,
    simulationEnvironmentCount: worldState.simulationState?.environmentSpec?.situations?.length || 0,
    memoryMutationCount: worldState.simulationState?.memoryMutations?.situations?.length || 0,
    causalReplayCount: worldState.simulationState?.causalReplay?.chains?.length || 0,
  };
}

function summarizeTypeCounts(items) {
  const counts = new Map();
  for (const item of items) {
    if (!item) continue;
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
}

function pickTopCountEntries(countMap, limit = 5) {
  return Object.entries(countMap)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([type, count]) => ({ type, count }));
}

function summarizeForecastPopulation(predictions) {
  const domainCounts = Object.fromEntries(FORECAST_DOMAINS.map(domain => [domain, 0]));
  const highlightedDomainCounts = Object.fromEntries(FORECAST_DOMAINS.map(domain => [domain, 0]));
  const legacyDetectorDomainCounts = Object.fromEntries(FORECAST_DOMAINS.map(domain => [domain, 0]));
  const stateDerivedDomainCounts = Object.fromEntries(FORECAST_DOMAINS.map(domain => [domain, 0]));
  const generationOriginCounts = {};
  let stateDerivedBackfillCount = 0;

  for (const pred of predictions) {
    domainCounts[pred.domain] = (domainCounts[pred.domain] || 0) + 1;
    if ((pred.probability || 0) >= PANEL_MIN_PROBABILITY) {
      highlightedDomainCounts[pred.domain] = (highlightedDomainCounts[pred.domain] || 0) + 1;
    }
    const origin = pred.generationOrigin || 'legacy_detector';
    generationOriginCounts[origin] = (generationOriginCounts[origin] || 0) + 1;
    if (origin === 'state_derived') {
      stateDerivedDomainCounts[pred.domain] = (stateDerivedDomainCounts[pred.domain] || 0) + 1;
      if (pred.stateDerivedBackfill) stateDerivedBackfillCount++;
    } else {
      legacyDetectorDomainCounts[pred.domain] = (legacyDetectorDomainCounts[pred.domain] || 0) + 1;
    }
  }

  return {
    forecastCount: predictions.length,
    domainCounts,
    highlightedDomainCounts,
    legacyDetectorDomainCounts,
    stateDerivedDomainCounts,
    generationOriginCounts: summarizeTypeCounts(Object.entries(generationOriginCounts).flatMap(([origin, count]) => Array(count).fill(origin))),
    stateDerivedBackfillCount,
    quietDomains: FORECAST_DOMAINS.filter(domain => (domainCounts[domain] || 0) === 0),
  };
}

function summarizeForecastTraceQuality(predictions, tracedPredictions, enrichmentMeta = null, publishTelemetry = null, candidatePredictions = null) {
  const fullRun = summarizeForecastPopulation(predictions);
  const traced = summarizeForecastPopulation(tracedPredictions);

  const narrativeSourceCounts = summarizeTypeCounts(
    tracedPredictions.map(item => item.traceMeta?.narrativeSource || 'fallback')
  );

  const promotionSignalCounts = summarizeTypeCounts(
    tracedPredictions.flatMap(item => (item.signals || []).slice(0, 3).map(signal => signal.type))
  );

  const suppressionSignalCounts = summarizeTypeCounts(
    tracedPredictions.flatMap(item => (item.caseFile?.counterEvidence || []).map(counter => counter.type))
  );

  const readinessValues = tracedPredictions.map(item => item.readiness?.overall || 0);
  const avgReadiness = readinessValues.length
    ? +(readinessValues.reduce((sum, value) => sum + value, 0) / readinessValues.length).toFixed(3)
    : 0;
  const avgProbability = tracedPredictions.length
    ? +(tracedPredictions.reduce((sum, item) => sum + (item.probability || 0), 0) / tracedPredictions.length).toFixed(3)
    : 0;
  const avgConfidence = tracedPredictions.length
    ? +(tracedPredictions.reduce((sum, item) => sum + (item.confidence || 0), 0) / tracedPredictions.length).toFixed(3)
    : 0;

  const fallbackCount = narrativeSourceCounts.fallback || 0;
  const llmCombinedCount =
    (narrativeSourceCounts.llm_combined || 0) +
    (narrativeSourceCounts.llm_combined_cache || 0);
  const llmScenarioCount =
    (narrativeSourceCounts.llm_scenario || 0) +
    (narrativeSourceCounts.llm_scenario_cache || 0);
  const enrichedCount = tracedPredictions.length - fallbackCount;

  return {
    fullRun,
    traced: {
      ...traced,
      narrativeSourceCounts,
      fallbackCount,
      fallbackRate: tracedPredictions.length ? +(fallbackCount / tracedPredictions.length).toFixed(3) : 0,
      enrichedCount,
      enrichedRate: tracedPredictions.length ? +(enrichedCount / tracedPredictions.length).toFixed(3) : 0,
      llmCombinedCount,
      llmScenarioCount,
      avgReadiness,
      avgProbability,
      avgConfidence,
      topPromotionSignals: pickTopCountEntries(promotionSignalCounts, 5),
      topSuppressionSignals: pickTopCountEntries(suppressionSignalCounts, 5),
    },
    candidateRun: Array.isArray(candidatePredictions) && candidatePredictions.length > predictions.length
      ? summarizeForecastPopulation(candidatePredictions)
      : null,
    enrichment: enrichmentMeta,
    publish: publishTelemetry,
  };
}

function buildForecastTraceArtifacts(data, context = {}, config = {}) {
  const generatedAt = data?.generatedAt || Date.now();
  const predictions = Array.isArray(data?.predictions) ? data.predictions : [];
  const fullRunPredictions = Array.isArray(data?.fullRunPredictions) ? data.fullRunPredictions : predictions;
  const maxForecasts = config.maxForecasts || getTraceMaxForecasts(predictions.length);
  const worldState = buildForecastRunWorldState({
    generatedAt,
    predictions,
    inputs: data?.inputs || {},
    priorWorldState: data?.priorWorldState || null,
    priorWorldStates: data?.priorWorldStates || [],
    situationClusters: data?.situationClusters || undefined,
    situationFamilies: data?.situationFamilies || undefined,
    stateUnits: data?.stateUnits || undefined,
    publishTelemetry: data?.publishTelemetry || null,
  });
  const simulationByForecastId = new Map();
  for (const sim of (worldState.simulationState?.situationSimulations || [])) {
    for (const forecastId of (sim.forecastIds || [])) {
      simulationByForecastId.set(forecastId, sim);
    }
  }
  const tracedPredictions = predictions.slice(0, maxForecasts).map((pred, index) => buildForecastTraceRecord(pred, index + 1, simulationByForecastId));
  const quality = summarizeForecastTraceQuality(
    predictions,
    tracedPredictions,
    data?.enrichmentMeta || null,
    data?.publishTelemetry || null,
    fullRunPredictions
  );
  const candidateWorldState = fullRunPredictions !== predictions || data?.fullRunSituationClusters
    ? buildForecastRunWorldState({
      generatedAt,
      predictions: fullRunPredictions,
      inputs: data?.inputs || {},
      priorWorldState: data?.priorWorldState || null,
      priorWorldStates: data?.priorWorldStates || [],
      situationClusters: data?.fullRunSituationClusters || undefined,
      situationFamilies: data?.fullRunSituationFamilies || undefined,
      publishTelemetry: data?.publishTelemetry || null,
    })
    : null;
  const prefix = buildTraceRunPrefix(
    context.runId || `run_${generatedAt}`,
    generatedAt,
    config.basePrefix || 'seed-data/forecast-traces'
  );
  const manifestKey = `${prefix}/manifest.json`;
  const summaryKey = `${prefix}/summary.json`;
  const worldStateKey = `${prefix}/world-state.json`;
  const forecastKeys = tracedPredictions.map(item => ({
    id: item.id,
    title: item.title,
    key: `${prefix}/forecasts/${item.id}.json`,
  }));

  const manifest = {
    version: 1,
    runId: context.runId || '',
    generatedAt,
    generatedAtIso: new Date(generatedAt).toISOString(),
    canonicalKey: CANONICAL_KEY,
    forecastCount: predictions.length,
    tracedForecastCount: tracedPredictions.length,
    triggerContext: data?.triggerContext || null,
    manifestKey,
    summaryKey,
    worldStateKey,
    forecastKeys,
  };

  const summary = {
    runId: manifest.runId,
    generatedAt: manifest.generatedAt,
    generatedAtIso: manifest.generatedAtIso,
    forecastCount: manifest.forecastCount,
    tracedForecastCount: manifest.tracedForecastCount,
    triggerContext: manifest.triggerContext,
    quality,
    worldStateSummary: {
      scope: 'published',
      summary: worldState.summary,
      reportSummary: worldState.report?.summary || '',
      reportContinuitySummary: worldState.reportContinuity?.summary || '',
      simulationSummary: worldState.simulationState?.summary || '',
      marketSummary: worldState.marketState?.summary || '',
      simulationInputSummary: worldState.report?.simulationInputSummary || '',
      domainCount: worldState.domainStates.length,
      regionCount: worldState.regionalStates.length,
      situationCount: worldState.situationClusters.length,
      familyCount: worldState.situationFamilies?.length || 0,
      worldSignalCount: worldState.worldSignals?.signals?.length || 0,
      criticalSignalCount: worldState.worldSignals?.criticalSignalCount || 0,
      criticalSignalSource: worldState.worldSignals?.criticalExtraction?.source || '',
      criticalSignalCandidateCount: worldState.worldSignals?.criticalExtraction?.candidateCount || 0,
      criticalSignalFrameCount: worldState.worldSignals?.criticalExtraction?.extractedFrameCount || 0,
      criticalSignalFallbackCount: worldState.worldSignals?.criticalExtraction?.fallbackNewsSignalCount || 0,
      criticalSignalFailureReason: worldState.worldSignals?.criticalExtraction?.failureReason || '',
      marketBucketCount: worldState.marketState?.buckets?.length || 0,
      transmissionEdgeCount: worldState.marketTransmission?.edges?.length || 0,
      marketConsequenceCount: worldState.simulationState?.marketConsequences?.items?.length || 0,
      blockedMarketConsequenceCount: worldState.simulationState?.marketConsequences?.blockedCount || 0,
      topMarketBucket: worldState.marketState?.topBucketLabel || '',
      simulationSituationCount: worldState.simulationState?.totalSituationSimulations || 0,
      simulationRoundCount: worldState.simulationState?.totalRounds || 0,
      simulationActionCount: worldState.simulationState?.actionLedger?.length || 0,
      simulationInteractionCount: worldState.simulationState?.interactionLedger?.length || 0,
      reportableInteractionCount: worldState.simulationState?.reportableInteractionLedger?.length || 0,
      internalEffectCount: worldState.simulationState?.internalEffects?.length || 0,
      simulationEffectCount: worldState.report?.crossSituationEffects?.length || 0,
      blockedEffectCount: worldState.simulationState?.blockedEffects?.length || 0,
      blockedMarketConsequenceReasons: worldState.simulationState?.marketConsequences?.blockedSummary?.byReason || {},
      simulationEnvironmentSummary: worldState.simulationState?.environmentSpec?.summary || '',
      simulationEnvironmentCount: worldState.simulationState?.environmentSpec?.situations?.length || 0,
      memoryMutationSummary: worldState.simulationState?.memoryMutations?.summary || '',
      memoryMutationCount: worldState.simulationState?.memoryMutations?.situations?.length || 0,
      causalReplaySummary: worldState.simulationState?.causalReplay?.summary || '',
      causalReplayCount: worldState.simulationState?.causalReplay?.chains?.length || 0,
      persistentSituations: worldState.situationContinuity.persistentSituationCount,
      newSituations: worldState.situationContinuity.newSituationCount,
      strengthenedSituations: worldState.situationContinuity.strengthenedSituationCount,
      weakenedSituations: worldState.situationContinuity.weakenedSituationCount,
      resolvedSituations: worldState.situationContinuity.resolvedSituationCount,
      historyRuns: worldState.reportContinuity?.history?.length || 0,
      persistentPressures: worldState.reportContinuity?.persistentPressureCount || 0,
      emergingPressures: worldState.reportContinuity?.emergingPressureCount || 0,
      fadingPressures: worldState.reportContinuity?.fadingPressureCount || 0,
      repeatedStrengthening: worldState.reportContinuity?.repeatedStrengtheningCount || 0,
      actorCount: worldState.actorRegistry.length,
      persistentActorCount: worldState.actorContinuity.persistentCount,
      newlyActiveActors: worldState.actorContinuity.newlyActiveCount,
      strengthenedActors: worldState.actorContinuity.strengthenedCount,
      weakenedActors: worldState.actorContinuity.weakenedCount,
      noLongerActiveActors: worldState.actorContinuity.noLongerActiveCount,
      branchCount: worldState.branchStates.length,
      persistentBranches: worldState.branchContinuity.persistentBranchCount,
      newBranches: worldState.branchContinuity.newBranchCount,
      strengthenedBranches: worldState.branchContinuity.strengthenedBranchCount,
      weakenedBranches: worldState.branchContinuity.weakenedBranchCount,
      resolvedBranches: worldState.branchContinuity.resolvedBranchCount,
      escalatorySimulations: worldState.simulationState?.postureCounts?.escalatory || 0,
      contestedSimulations: worldState.simulationState?.postureCounts?.contested || 0,
      constrainedSimulations: worldState.simulationState?.postureCounts?.constrained || 0,
      blockedEffectReasons: worldState.simulationState?.blockedEffectSummary?.byReason || {},
      newForecasts: worldState.continuity.newForecasts,
      materiallyChanged: worldState.continuity.materiallyChanged.length,
      candidateStateSummary: summarizeWorldStateSurface(candidateWorldState),
      marketInputCoverage: summarizeMarketInputCoverage(data?.inputs || {}),
    },
    topForecasts: tracedPredictions.map(item => ({
      rank: item.rank,
      id: item.id,
      title: item.title,
      domain: item.domain,
      region: item.region,
      probability: item.probability,
      confidence: item.confidence,
      trend: item.trend,
      analysisPriority: item.analysisPriority,
      readiness: item.readiness,
      narrativeSource: item.traceMeta?.narrativeSource || 'fallback',
      llmCached: !!item.traceMeta?.llmCached,
    })),
  };

  return {
    prefix,
    manifestKey,
    summaryKey,
    manifest,
    summary,
    worldStateKey,
    worldState,
    forecasts: tracedPredictions.map(item => ({
      key: `${prefix}/forecasts/${item.id}.json`,
      payload: item,
    })),
  };
}

async function writeForecastTracePointer(pointer) {
  const { url, token } = getRedisCredentials();
  await redisCommand(url, token, ['SET', TRACE_LATEST_KEY, JSON.stringify(pointer), 'EX', TRACE_REDIS_TTL_SECONDS]);
  await redisCommand(url, token, ['LPUSH', TRACE_RUNS_KEY, JSON.stringify(pointer)]);
  await redisCommand(url, token, ['LTRIM', TRACE_RUNS_KEY, 0, TRACE_RUNS_MAX - 1]);
  await redisCommand(url, token, ['EXPIRE', TRACE_RUNS_KEY, TRACE_REDIS_TTL_SECONDS]);
}

async function readPreviousForecastWorldState(storageConfig) {
  try {
    const { url, token } = getRedisCredentials();
    const pointer = await redisGet(url, token, TRACE_LATEST_KEY);
    if (!pointer?.worldStateKey) return null;
    return await getR2JsonObject(storageConfig, pointer.worldStateKey);
  } catch (err) {
    console.warn(`  [Trace] Prior world state read failed: ${err.message}`);
    return null;
  }
}

// Returns world states ordered most-recent-first (LPUSH prepends, LRANGE 0 N reads from head).
// Callers that rely on priorMatches[0] being the most recent must not reorder this array.
async function readForecastWorldStateHistory(storageConfig, limit = WORLD_STATE_HISTORY_LIMIT) {
  try {
    const { url, token } = getRedisCredentials();
    const resp = await redisCommand(url, token, ['LRANGE', TRACE_RUNS_KEY, 0, Math.max(0, limit - 1)]);
    const rawPointers = Array.isArray(resp?.result) ? resp.result : [];
    const pointers = rawPointers
      .map((value) => {
        try { return JSON.parse(value); } catch { return null; }
      })
      .filter((item) => item?.worldStateKey);
    const seen = new Set();
    const keys = [];
    for (const pointer of pointers) {
      if (seen.has(pointer.worldStateKey)) continue;
      seen.add(pointer.worldStateKey);
      keys.push(pointer.worldStateKey);
      if (keys.length >= limit) break;
    }
    const states = await Promise.all(keys.map((key) => getR2JsonObject(storageConfig, key).catch(() => null)));
    return states.filter(Boolean);
  } catch (err) {
    console.warn(`  [Trace] World-state history read failed: ${err.message}`);
    return [];
  }
}

async function writeForecastTraceArtifacts(data, context = {}) {
  const storageConfig = resolveR2StorageConfig();
  if (!storageConfig) return null;
  const predictionCount = Array.isArray(data?.predictions) ? data.predictions.length : 0;
  const traceCap = getTraceCapLog(predictionCount);
  console.log(`  [Trace] Storage mode=${storageConfig.mode} bucket=${storageConfig.bucket} prefix=${storageConfig.basePrefix}`);
  console.log(`  Trace cap: raw=${traceCap.raw ?? 'default'} resolved=${traceCap.resolved} total=${traceCap.totalForecasts}`);

  // Keep TRACE_LATEST_KEY as a fallback because writeForecastTracePointer() updates
  // the latest pointer and history list in separate Redis calls. If SET succeeds
  // but LPUSH/LTRIM fails or the history list is stale, continuity should still
  // see the most recent prior world state.
  const [priorWorldStates, priorWorldStateFallback] = data?.priorWorldStates?.length || data?.priorWorldState
    ? [data.priorWorldStates || [], data.priorWorldState || null]
    : await Promise.all([
      readForecastWorldStateHistory(storageConfig, WORLD_STATE_HISTORY_LIMIT),
      readPreviousForecastWorldState(storageConfig),
    ]);
  const priorWorldState = data?.priorWorldState || (priorWorldStates[0] ?? priorWorldStateFallback);
  const artifacts = buildForecastTraceArtifacts({
    ...data,
    priorWorldState,
    priorWorldStates,
  }, context, {
    basePrefix: storageConfig.basePrefix,
    maxForecasts: getTraceMaxForecasts(predictionCount),
  });

  await putR2JsonObject(storageConfig, artifacts.manifestKey, artifacts.manifest, {
    runid: String(artifacts.manifest.runId || ''),
    kind: 'manifest',
  });
  await putR2JsonObject(storageConfig, artifacts.summaryKey, artifacts.summary, {
    runid: String(artifacts.manifest.runId || ''),
    kind: 'summary',
  });
  await putR2JsonObject(storageConfig, artifacts.worldStateKey, artifacts.worldState, {
    runid: String(artifacts.manifest.runId || ''),
    kind: 'world_state',
  });
  await Promise.all(
    artifacts.forecasts.map((item, index) => putR2JsonObject(storageConfig, item.key, item.payload, {
      runid: String(artifacts.manifest.runId || ''),
      kind: 'forecast',
      rank: String(index + 1),
    })),
  );

  const pointer = {
    runId: artifacts.manifest.runId,
    generatedAt: artifacts.manifest.generatedAt,
    generatedAtIso: artifacts.manifest.generatedAtIso,
    bucket: storageConfig.bucket,
    prefix: artifacts.prefix,
    manifestKey: artifacts.manifestKey,
    summaryKey: artifacts.summaryKey,
    worldStateKey: artifacts.worldStateKey,
    forecastCount: artifacts.manifest.forecastCount,
    tracedForecastCount: artifacts.manifest.tracedForecastCount,
    triggerContext: artifacts.manifest.triggerContext,
    quality: artifacts.summary.quality,
    worldStateSummary: artifacts.summary.worldStateSummary,
  };
  await writeForecastTracePointer(pointer);
  return pointer;
}

function buildChangeItems(pred, prev) {
  const items = [];
  if (!prev) {
    items.push(`New forecast surfaced in this run at ${roundPct(pred.probability)} over the ${pred.timeHorizon}.`);
    if (pred.caseFile?.supportingEvidence?.[0]?.summary) {
      items.push(`Lead evidence: ${pred.caseFile.supportingEvidence[0].summary}`);
    }
    if (pred.calibration?.marketTitle) {
      items.push(`Initial market check: ${pred.calibration.marketTitle} at ${roundPct(pred.calibration.marketPrice)}.`);
    }
    return items.slice(0, 4);
  }

  const previousSignals = new Set(prev.signals || []);
  const newSignals = (pred.signals || [])
    .map(signal => signal.value)
    .filter(value => !previousSignals.has(value));
  for (const signal of newSignals.slice(0, 2)) {
    items.push(`New signal: ${signal}`);
  }

  const previousHeadlines = new Set(prev.newsContext || []);
  const newHeadlines = (pred.newsContext || []).filter(headline => !previousHeadlines.has(headline));
  for (const headline of newHeadlines.slice(0, 2)) {
    items.push(`New reporting: ${headline}`);
  }

  if (pred.calibration) {
    const prevMarket = prev.calibration;
    if (!prevMarket || prevMarket.marketTitle !== pred.calibration.marketTitle) {
      items.push(`New market anchor: ${pred.calibration.marketTitle} at ${roundPct(pred.calibration.marketPrice)}.`);
    } else if (Math.abs((pred.calibration.marketPrice || 0) - (prevMarket.marketPrice || 0)) >= 0.05) {
      items.push(`Market moved from ${roundPct(prevMarket.marketPrice)} to ${roundPct(pred.calibration.marketPrice)} in ${pred.calibration.marketTitle}.`);
    }
  }

  if (items.length === 0) {
    if (Math.abs(pred.probability - (prev.probability || pred.priorProbability || pred.probability)) < 0.05) {
      items.push('Evidence mix is broadly unchanged from the prior snapshot.');
    } else if (pred.caseFile?.counterEvidence?.[0]?.summary) {
      items.push(`Counter-pressure: ${pred.caseFile.counterEvidence[0].summary}`);
    }
  }

  return items.slice(0, 4);
}

function buildChangeSummary(pred, prev, changeItems) {
  if (!prev) {
    return `This forecast is new in the current run, entering at ${roundPct(pred.probability)} with a ${pred.trend} trajectory.`;
  }

  const delta = pred.probability - prev.probability;
  const movement = Math.abs(delta);
  const lead = movement >= 0.05
    ? `Probability ${delta > 0 ? 'rose' : 'fell'} from ${roundPct(prev.probability)} to ${roundPct(pred.probability)} since the prior run.`
    : `Probability is holding near ${roundPct(pred.probability)} versus ${roundPct(prev.probability)} in the prior run.`;

  const follow = changeItems[0]
    ? changeItems[0]
    : pred.trend === 'rising'
      ? 'The evidence mix is leaning more supportive than in the last snapshot.'
      : pred.trend === 'falling'
        ? 'The latest snapshot is showing more restraint than the previous run.'
        : 'The evidence mix remains broadly similar to the previous run.';

  return `${lead} ${follow}`.slice(0, 500);
}

function annotateForecastChanges(predictions, prior) {
  const priorMap = new Map((prior?.predictions || []).map(item => [item.id, item]));
  for (const pred of predictions) {
    if (!pred.caseFile) buildForecastCase(pred);
    const prev = priorMap.get(pred.id);
    const changeItems = buildChangeItems(pred, prev);
    pred.caseFile.changeItems = changeItems;
    pred.caseFile.changeSummary = buildChangeSummary(pred, prev, changeItems);
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value || 0));
}

function scoreForecastReadiness(pred) {
  const supportCount = pred.caseFile?.supportingEvidence?.length || 0;
  const counterCount = pred.caseFile?.counterEvidence?.length || 0;
  const triggerCount = pred.caseFile?.triggers?.length || 0;
  const actorCount = pred.caseFile?.actorLenses?.length || 0;
  const headlineCount = pred.newsContext?.length || 0;
  const sourceCount = new Set((pred.signals || []).map(s => SIGNAL_TO_SOURCE[s.type] || s.type)).size;

  const evidenceScore = clamp01((normalize(supportCount, 0, 6) * 0.55) + (normalize(sourceCount, 1, 4) * 0.45));
  const groundingScore = clamp01(
    (headlineCount > 0 ? Math.min(1, headlineCount / 2) * 0.35 : 0) +
    (pred.calibration ? 0.3 : 0) +
    (triggerCount > 0 ? Math.min(1, triggerCount / 3) * 0.35 : 0)
  );
  const alternativeScore = clamp01(
    ((pred.caseFile?.baseCase || supportCount > 0) ? 1 : 0) * (1 / 3) +
    ((pred.caseFile?.escalatoryCase || triggerCount > 0 || (pred.cascades?.length || 0) > 0) ? 1 : 0) * (1 / 3) +
    ((pred.caseFile?.contrarianCase || counterCount > 0 || pred.trend === 'falling') ? 1 : 0) * (1 / 3)
  );
  const actorScore = actorCount > 0 ? Math.min(1, actorCount / 3) : 0;
  const driftPenalty = pred.calibration ? Math.min(0.18, Math.abs(pred.calibration.drift || 0) * 0.6) : 0;
  const overall = clamp01(
    evidenceScore * 0.4 +
    groundingScore * 0.25 +
    alternativeScore * 0.2 +
    actorScore * 0.15 -
    driftPenalty
  );

  return {
    evidenceScore: +evidenceScore.toFixed(3),
    groundingScore: +groundingScore.toFixed(3),
    alternativeScore: +alternativeScore.toFixed(3),
    actorScore: +actorScore.toFixed(3),
    overall: +overall.toFixed(3),
  };
}

function computeAnalysisPriority(pred) {
  const readiness = scoreForecastReadiness(pred);
  const baseScore = (pred.probability || 0) * (pred.confidence || 0);
  const counterEvidenceTypes = new Set((pred.caseFile?.counterEvidence || []).map(item => item.type));
  const hasNewsCorroboration = (pred.signals || []).some(signal => signal.type === 'news_corroboration');
  const readinessMultiplier = 0.78 + (readiness.overall * 0.5);
  const groundingBonus = readiness.groundingScore * 0.025;
  const evidenceBonus = readiness.evidenceScore * 0.02;
  const corroborationBonus = hasNewsCorroboration ? 0.018 : 0;
  const calibrationBonus = pred.calibration ? 0.012 : 0;
  const priorityDomainBonus = ENRICHMENT_PRIORITY_DOMAINS.includes(pred.domain) && readiness.overall >= 0.45 ? 0.012 : 0;
  const trendBonus = pred.trend === 'rising' ? 0.015 : pred.trend === 'falling' ? -0.005 : 0;
  // penalties
  const lowGroundingPenalty = readiness.groundingScore < 0.2 ? 0.02 : 0;
  const lowEvidencePenalty = readiness.evidenceScore < 0.25 ? 0.015 : 0;
  const coveragePenalty = counterEvidenceTypes.has('coverage_gap') ? 0.015 : 0;
  const confidencePenalty = counterEvidenceTypes.has('confidence') ? 0.012 : 0;
  const cyberThinSignalPenalty = pred.domain === 'cyber' && counterEvidenceTypes.has('coverage_gap') ? 0.01 : 0;
  return +(
    (baseScore * readinessMultiplier) +
    groundingBonus +
    evidenceBonus +
    corroborationBonus +
    calibrationBonus +
    priorityDomainBonus +
    trendBonus -
    lowGroundingPenalty -
    lowEvidencePenalty -
    coveragePenalty -
    confidencePenalty -
    cyberThinSignalPenalty
  ).toFixed(6);
}

function rankForecastsForAnalysis(predictions) {
  const priorities = new Map(predictions.map((p) => [
    p,
    typeof p.analysisPriority === 'number' ? p.analysisPriority : computeAnalysisPriority(p),
  ]));
  predictions.sort((a, b) => {
    const delta = priorities.get(b) - priorities.get(a);
    if (Math.abs(delta) > 1e-6) return delta;
    return (b.probability * b.confidence) - (a.probability * a.confidence);
  });
}

function prepareForecastMetrics(predictions) {
  for (const pred of predictions) {
    pred.readiness = pred.readiness || scoreForecastReadiness(pred);
    pred.analysisPriority = typeof pred.analysisPriority === 'number'
      ? pred.analysisPriority
      : computeAnalysisPriority(pred);
  }
}

function intersectCount(left = [], right = []) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  let count = 0;
  for (const item of left) {
    if (rightSet.has(item)) count++;
  }
  return count;
}

function getForecastSituationTokens(pred) {
  return uniqueSortedStrings([
    ...extractMeaningfulTokens(pred.title, [pred.region]),
    ...extractMeaningfulTokens(pred.feedSummary, [pred.region]),
    ...(pred.caseFile?.supportingEvidence || []).flatMap((item) => extractMeaningfulTokens(item.summary, [pred.region])),
  ]).slice(0, 12);
}

function getForecastSelectionStateContext(pred) {
  return pred?.stateContext || pred?.situationContext || null;
}

function computeSituationDuplicateScore(current, kept) {
  const currentActors = uniqueSortedStrings((current.caseFile?.actors || []).map((actor) => actor.name || actor.id));
  const keptActors = uniqueSortedStrings((kept.caseFile?.actors || []).map((actor) => actor.name || actor.id));
  const currentBranches = uniqueSortedStrings((current.caseFile?.branches || []).map((branch) => branch.kind));
  const keptBranches = uniqueSortedStrings((kept.caseFile?.branches || []).map((branch) => branch.kind));
  const currentState = getForecastSelectionStateContext(current);
  const keptState = getForecastSelectionStateContext(kept);
  const currentSignals = uniqueSortedStrings((currentState?.topSignals || []).map((signal) => signal.type));
  const keptSignals = uniqueSortedStrings((keptState?.topSignals || []).map((signal) => signal.type));
  const currentTokens = current.publishTokens || getForecastSituationTokens(current);
  const keptTokens = kept.publishTokens || getForecastSituationTokens(kept);

  let score = 0;
  if ((currentState?.id || '') && currentState?.id === keptState?.id) score += 2.75;
  if ((currentState?.familyId || '') && currentState?.familyId === keptState?.familyId) score += 0.45;
  if ((currentState?.dominantRegion || current.region || '') === (keptState?.dominantRegion || kept.region || '')) score += 1.5;
  score += intersectCount(currentActors, keptActors) * 1.4;
  score += intersectCount(currentBranches, keptBranches) * 0.75;
  score += intersectCount(currentSignals, keptSignals) * 0.5;
  score += intersectCount(currentTokens, keptTokens) * 0.35;
  return +score.toFixed(3);
}

function shouldSuppressAsSituationDuplicate(current, kept, duplicateScore) {
  const currentState = getForecastSelectionStateContext(current);
  const keptState = getForecastSelectionStateContext(kept);
  const currentSignals = uniqueSortedStrings((currentState?.topSignals || []).map((signal) => signal.type));
  const keptSignals = uniqueSortedStrings((keptState?.topSignals || []).map((signal) => signal.type));
  const currentTokens = current.publishTokens || getForecastSituationTokens(current);
  const keptTokens = kept.publishTokens || getForecastSituationTokens(kept);
  const sameRegion = (currentState?.dominantRegion || current.region || '') === (keptState?.dominantRegion || kept.region || '');
  const tokenOverlap = intersectCount(currentTokens, keptTokens);
  const signalOverlap = intersectCount(currentSignals, keptSignals);

  if (duplicateScore < DUPLICATE_SCORE_THRESHOLD) return false;
  if (sameRegion) return true;
  if (tokenOverlap >= 4) return true;
  if (signalOverlap >= 2) return true;
  return false;
}

function summarizePublishFiltering(predictions) {
  // Must be called after filterPublishedForecasts() has populated pred.publishDiagnostics.
  const reasonCounts = summarizeTypeCounts(
    predictions
      .map((pred) => pred.publishDiagnostics?.reason)
      .filter(Boolean),
  );
  const situationCounts = summarizeTypeCounts(
    predictions
      .map((pred) => pred.situationContext?.id)
      .filter(Boolean),
  );
  const familyCounts = summarizeTypeCounts(
    predictions
      .map((pred) => pred.familyContext?.id)
      .filter(Boolean),
  );
  const cappedSituationIds = new Set(
    predictions
      .filter((pred) => pred.publishDiagnostics?.reason === 'situation_cap' && pred.publishDiagnostics?.situationId)
      .map((pred) => pred.publishDiagnostics.situationId),
  );
  const cappedFamilyIds = new Set(
    predictions
      .filter((pred) => pred.publishDiagnostics?.reason === 'situation_family_cap' && pred.publishDiagnostics?.familyId)
      .map((pred) => pred.publishDiagnostics.familyId),
  );

  return {
    suppressedFamilySelection: reasonCounts.family_selection || 0,
    suppressedWeakFallback: reasonCounts.weak_fallback || 0,
    suppressedSituationOverlap: reasonCounts.situation_overlap || 0,
    suppressedSituationCap: reasonCounts.situation_cap || 0,
    suppressedSituationDomainCap: reasonCounts.situation_domain_cap || 0,
    suppressedSituationFamilyCap: reasonCounts.situation_family_cap || 0,
    suppressedTotal: Object.values(reasonCounts).reduce((sum, count) => sum + count, 0),
    reasonCounts,
    situationClusterCount: Object.keys(situationCounts).length,
    familyClusterCount: Object.keys(familyCounts).length,
    maxForecastsPerSituation: Math.max(0, ...Object.values(situationCounts)),
    maxForecastsPerFamily: Math.max(0, ...Object.values(familyCounts)),
    multiForecastSituations: Object.values(situationCounts).filter((count) => count > 1).length,
    multiForecastFamilies: Object.values(familyCounts).filter((count) => count > 1).length,
    cappedSituations: cappedSituationIds.size,
    cappedFamilies: cappedFamilyIds.size,
  };
}

function getPublishSelectionTarget(predictions = []) {
  const familyCount = new Set(predictions.map((pred) => pred.familyContext?.id).filter(Boolean)).size;
  const stateCount = new Set(predictions.map((pred) => getForecastSelectionStateContext(pred)?.id).filter(Boolean)).size;
  const dynamicTarget = Math.ceil((familyCount * 1.4) + Math.min(4, stateCount * 0.22));
  return Math.max(
    Math.min(predictions.length, MIN_TARGET_PUBLISHED_FORECASTS),
    Math.min(predictions.length, MAX_TARGET_PUBLISHED_FORECASTS, dynamicTarget || MIN_TARGET_PUBLISHED_FORECASTS),
  );
}

function buildPublishSelectionMemoryIndex(priorWorldState = null) {
  const situationMemory = priorWorldState?.simulationState?.memoryMutations?.situations || [];
  const causalEdges = priorWorldState?.simulationState?.causalGraph?.edges || [];
  const bySituationLabel = new Map();
  const byRegionDomain = new Map();
  const edgeCounts = new Map();

  for (const item of situationMemory) {
    const labelKey = String(item.label || '').trim().toLowerCase();
    if (labelKey && !bySituationLabel.has(labelKey)) bySituationLabel.set(labelKey, item);
    const regionKey = String(item.dominantRegion || '').trim().toLowerCase();
    const domainKey = item.dominantDomain || '';
    if (regionKey && domainKey) {
      const regionDomainKey = `${regionKey}:${domainKey}`;
      if (!byRegionDomain.has(regionDomainKey)) byRegionDomain.set(regionDomainKey, item);
    }
  }

  for (const edge of causalEdges) {
    edgeCounts.set(edge.sourceSituationId, (edgeCounts.get(edge.sourceSituationId) || 0) + 1);
    edgeCounts.set(edge.targetSituationId, (edgeCounts.get(edge.targetSituationId) || 0) + 1);
  }

  return { bySituationLabel, byRegionDomain, edgeCounts };
}

function getPublishSelectionMemoryHint(pred, memoryIndex = null) {
  if (!memoryIndex) return null;
  const stateContext = getForecastSelectionStateContext(pred);
  const labelKey = String(stateContext?.label || '').trim().toLowerCase();
  const direct = labelKey ? memoryIndex.bySituationLabel.get(labelKey) : null;
  if (direct) {
    return {
      memory: direct,
      edgeCount: memoryIndex.edgeCounts.get(direct.situationId) || 0,
      matchedBy: 'label',
    };
  }
  const regionDomainKey = `${String(stateContext?.dominantRegion || pred?.region || stateContext?.regions?.[0] || '').trim().toLowerCase()}:${stateContext?.dominantDomain || pred?.domain || ''}`;
  const fallback = regionDomainKey ? memoryIndex.byRegionDomain.get(regionDomainKey) : null;
  if (!fallback) return null;
  return {
    memory: fallback,
    edgeCount: memoryIndex.edgeCounts.get(fallback.situationId) || 0,
    matchedBy: 'region_domain',
  };
}

function computePublishSelectionScore(pred, memoryIndex = null) {
  const readiness = pred?.readiness?.overall ?? scoreForecastReadiness(pred).overall;
  const priority = typeof pred?.analysisPriority === 'number' ? pred.analysisPriority : computeAnalysisPriority(pred);
  const narrativeSource = pred?.traceMeta?.narrativeSource || 'fallback';
  const stateContext = getForecastSelectionStateContext(pred);
  const familyBreadth = Math.min(1, ((pred.familyContext?.forecastCount || 1) - 1) / 6);
  const situationBreadth = Math.min(1, ((stateContext?.forecastCount || 1) - 1) / 6);
  const signalBreadth = Math.min(1, ((stateContext?.topSignals || []).length || 0) / 4);
  const domainLift = ['market', 'military', 'supply_chain', 'infrastructure'].includes(pred.domain) ? 0.02 : 0;
  const enrichedLift = narrativeSource.startsWith('llm_') ? 0.025 : 0;
  const memoryHint = getPublishSelectionMemoryHint(pred, memoryIndex);
  const pressureMemory = Number(memoryHint?.memory?.pressureMemory || 0);
  const memoryDelta = Number(memoryHint?.memory?.memoryDelta || 0);
  const edgeLift = Math.min(0.03, (Number(memoryHint?.edgeCount || 0) * 0.01));
  const memoryLift = memoryHint
    ? (
      (Math.min(0.08, pressureMemory * 0.07))
      + (memoryDelta > 0 ? Math.min(0.06, memoryDelta * 0.28) : Math.max(-0.03, memoryDelta * 0.14))
      + edgeLift
    )
    : 0;
  const marketConfirmation = Number(pred.marketSelectionContext?.confirmationScore || 0);
  const marketContradiction = Number(pred.marketSelectionContext?.contradictionScore || 0);
  const criticalSignalLift = Number(pred.marketSelectionContext?.criticalSignalLift || 0);
  const criticalSignalCount = Number(pred.marketSelectionContext?.criticalSignalCount || 0);
  const topBucketId = pred.marketSelectionContext?.topBucketId || '';
  const marketTransmissionLift = Math.min(0.07,
    (marketConfirmation * 0.06) +
    Math.min(0.02, Number(pred.marketSelectionContext?.transmissionEdgeCount || 0) * 0.005) +
    Math.min(0.02, Number(pred.marketSelectionContext?.topBucketPressure || 0) * 0.03)
  );
  const criticalLift = Math.min(0.05,
    (criticalSignalLift * 0.035) +
    Math.min(0.015, criticalSignalCount * 0.004),
  );
  const marketPenalty = Math.min(0.04, marketContradiction * 0.05);
  const coreBucketLift = CORE_MARKET_BUCKET_IDS.includes(topBucketId)
    ? Math.min(0.035, (marketConfirmation * 0.025) + (Number(pred.marketSelectionContext?.topBucketPressure || 0) * 0.02))
    : 0;
  const defensePenalty = topBucketId === 'defense' && pred.marketSelectionContext?.topChannel !== 'defense_repricing'
    ? 0.018
    : 0;
  pred.publishSelectionMemory = memoryHint ? {
    matchedBy: memoryHint.matchedBy,
    situationId: memoryHint.memory?.situationId || '',
    pressureMemory,
    memoryDelta,
    edgeCount: memoryHint.edgeCount || 0,
  } : null;
  pred.publishSelectionMarket = pred.marketSelectionContext ? {
    confirmationScore: marketConfirmation,
    contradictionScore: marketContradiction,
    criticalSignalLift,
    criticalSignalCount,
    topBucketId: pred.marketSelectionContext.topBucketId || '',
    topBucketLabel: pred.marketSelectionContext.topBucketLabel || '',
    transmissionEdgeCount: pred.marketSelectionContext.transmissionEdgeCount || 0,
  } : null;
  return +(
    (priority * 0.55) +
    (readiness * 0.2) +
    ((pred.probability || 0) * 0.15) +
    ((pred.confidence || 0) * 0.07) +
    (familyBreadth * 0.015) +
    (situationBreadth * 0.01) +
    (signalBreadth * 0.01) +
    domainLift +
    enrichedLift +
    memoryLift +
    marketTransmissionLift +
    criticalLift -
    marketPenalty +
    coreBucketLift -
    defensePenalty
  ).toFixed(6);
}

function isHighLeverageStateFollowOn(pred) {
  const marketConfirmation = Number(pred.marketSelectionContext?.confirmationScore || 0);
  const criticalSignalLift = Number(pred.marketSelectionContext?.criticalSignalLift || 0);
  const transmissionEdgeCount = Number(pred.marketSelectionContext?.transmissionEdgeCount || 0);
  const topBucketId = pred.marketSelectionContext?.topBucketId || '';
  const pressureMemory = Number(pred.publishSelectionMemory?.pressureMemory || 0);
  const coreBucket = CORE_MARKET_BUCKET_IDS.includes(topBucketId);

  if (pressureMemory >= 0.72) return true;
  if (coreBucket && ['market', 'supply_chain', 'military', 'infrastructure'].includes(pred.domain)) {
    if (marketConfirmation >= 0.56 || criticalSignalLift >= 0.54) return true;
  }
  if (transmissionEdgeCount >= 2 && (marketConfirmation >= 0.52 || criticalSignalLift >= 0.48)) return true;
  return false;
}

function selectPublishedForecastPool(predictions, options = {}) {
  const eligible = (predictions || []).filter((pred) => (pred?.probability || 0) > (options.minProbability ?? PUBLISH_MIN_PROBABILITY));
  const targetCount = options.targetCount ?? getPublishSelectionTarget(eligible);
  const memoryIndex = options.memoryIndex || null;
  const selected = [];
  const selectedIds = new Set();
  const familyCounts = new Map();
  const familyDomainCounts = new Map();
  const situationCounts = new Map();
  const domainCounts = new Map();

  for (const pred of predictions || []) pred.publishSelectionScore = computePublishSelectionScore(pred, memoryIndex);

  const ranked = eligible
    .slice()
    .sort((a, b) => (b.publishSelectionScore || 0) - (a.publishSelectionScore || 0)
      || (b.analysisPriority || 0) - (a.analysisPriority || 0)
      || (b.probability || 0) - (a.probability || 0));

  const familyBuckets = new Map();
  for (const pred of ranked) {
    const familyId = pred.familyContext?.id || `solo:${getForecastSelectionStateContext(pred)?.id || pred.id}`;
    if (!familyBuckets.has(familyId)) familyBuckets.set(familyId, []);
    familyBuckets.get(familyId).push(pred);
  }

  const orderedFamilyIds = [...familyBuckets.keys()].sort((leftId, rightId) => {
    const left = familyBuckets.get(leftId) || [];
    const right = familyBuckets.get(rightId) || [];
    const leftTop = left[0];
    const rightTop = right[0];
    const leftScore = (leftTop?.publishSelectionScore || 0) + Math.min(0.05, ((leftTop?.familyContext?.forecastCount || 1) - 1) * 0.005);
    const rightScore = (rightTop?.publishSelectionScore || 0) + Math.min(0.05, ((rightTop?.familyContext?.forecastCount || 1) - 1) * 0.005);
    return rightScore - leftScore || leftId.localeCompare(rightId);
  });

  function canSelect(pred, mode = 'fill') {
    if (!pred || selectedIds.has(pred.id)) return false;
    const familyId = pred.familyContext?.id || `solo:${getForecastSelectionStateContext(pred)?.id || pred.id}`;
    const familyTotal = familyCounts.get(familyId) || 0;
    const familyDomainKey = `${familyId}:${pred.domain}`;
    const familyDomainTotal = familyDomainCounts.get(familyDomainKey) || 0;
    const situationId = getForecastSelectionStateContext(pred)?.id || pred.id;
    const situationTotal = situationCounts.get(situationId) || 0;
    if (familyTotal >= Math.min(MAX_PUBLISHED_FORECASTS_PER_FAMILY, MAX_PRESELECTED_FORECASTS_PER_FAMILY)) return false;
    if (familyDomainTotal >= MAX_PUBLISHED_FORECASTS_PER_FAMILY_DOMAIN) return false;
    if (situationTotal >= MAX_PRESELECTED_FORECASTS_PER_SITUATION) return false;
    if ((mode === 'state_anchor' || mode === 'diversity') && situationTotal >= 1) return false;
    if (mode === 'fill' && situationTotal >= 1 && !isHighLeverageStateFollowOn(pred)) return false;
    if (mode === 'diversity') {
      const domainTotal = domainCounts.get(pred.domain) || 0;
      if (domainTotal >= 2 && !['market', 'military', 'supply_chain', 'infrastructure'].includes(pred.domain)) return false;
    }
    return true;
  }

  function take(pred) {
    const familyId = pred.familyContext?.id || `solo:${getForecastSelectionStateContext(pred)?.id || pred.id}`;
    const familyDomainKey = `${familyId}:${pred.domain}`;
    const situationId = getForecastSelectionStateContext(pred)?.id || pred.id;
    selected.push(pred);
    selectedIds.add(pred.id);
    familyCounts.set(familyId, (familyCounts.get(familyId) || 0) + 1);
    familyDomainCounts.set(familyDomainKey, (familyDomainCounts.get(familyDomainKey) || 0) + 1);
    situationCounts.set(situationId, (situationCounts.get(situationId) || 0) + 1);
    domainCounts.set(pred.domain, (domainCounts.get(pred.domain) || 0) + 1);
  }

  const memoryAnchors = ranked.filter((pred) => (
    Number(pred.publishSelectionMemory?.pressureMemory || 0) >= 0.55
    || Number(pred.publishSelectionMemory?.edgeCount || 0) >= 1
  ));
  const stateAnchorMap = new Map();
  for (const pred of ranked) {
    const stateId = getForecastSelectionStateContext(pred)?.id || pred.id;
    if (!stateAnchorMap.has(stateId)) stateAnchorMap.set(stateId, pred);
  }
  const stateAnchors = [...stateAnchorMap.values()]
    .sort((a, b) => (b.publishSelectionScore || 0) - (a.publishSelectionScore || 0)
      || (b.analysisPriority || 0) - (a.analysisPriority || 0)
      || (b.probability || 0) - (a.probability || 0));
  const marketAnchors = ranked.filter((pred) => (
    Number(pred.marketSelectionContext?.confirmationScore || 0) >= 0.5
    || Number(pred.marketSelectionContext?.criticalSignalLift || 0) >= 0.52
    || (
      Number(pred.marketSelectionContext?.topBucketPressure || 0) >= 0.5
      && Number(pred.marketSelectionContext?.transmissionEdgeCount || 0) >= 1
    )
  ));
  const transmissionAnchors = ranked.filter((pred) => (
    CORE_MARKET_BUCKET_IDS.includes(pred.marketSelectionContext?.topBucketId || '')
    && (
      Number(pred.marketSelectionContext?.confirmationScore || 0) >= 0.46
      || Number(pred.marketSelectionContext?.criticalSignalLift || 0) >= 0.5
      || (
        Number(pred.marketSelectionContext?.topTransmissionStrength || 0) >= 0.48
        && Number(pred.marketSelectionContext?.topBucketPressure || 0) >= 0.42
      )
    )
  ));
  for (const pred of stateAnchors) {
    if (selected.length >= Math.min(targetCount, stateAnchors.length)) break;
    if (canSelect(pred, 'state_anchor')) take(pred);
  }
  // These anchor passes intentionally stay in state-anchor mode, so once a state is already
  // represented they only help with uncovered states or state-less fallback forecasts.
  for (const pred of transmissionAnchors) {
    if (selected.length >= Math.min(targetCount, 2)) break;
    if (canSelect(pred, 'state_anchor')) take(pred);
  }
  for (const pred of marketAnchors) {
    if (selected.length >= Math.min(targetCount, 2)) break;
    if (canSelect(pred, 'state_anchor')) take(pred);
  }
  for (const pred of memoryAnchors) {
    if (selected.length >= Math.min(targetCount, 2)) break;
    if (canSelect(pred, 'state_anchor')) take(pred);
  }

  for (const familyId of orderedFamilyIds) {
    if (selected.length >= targetCount) break;
    const bucket = familyBuckets.get(familyId) || [];
    const choice = bucket.find((pred) => canSelect(pred, 'diversity'));
    if (choice) take(choice);
  }

  for (const familyId of orderedFamilyIds) {
    if (selected.length >= targetCount) break;
    const bucket = familyBuckets.get(familyId) || [];
    const selectedDomains = new Set(selected.filter((pred) => (pred.familyContext?.id || `solo:${getForecastSelectionStateContext(pred)?.id || pred.id}`) === familyId).map((pred) => pred.domain));
    const choice = bucket.find((pred) => !selectedDomains.has(pred.domain) && canSelect(pred, 'diversity'));
    if (choice) take(choice);
  }

  for (const pred of memoryAnchors) {
    if (selected.length >= targetCount) break;
    if (canSelect(pred, 'fill')) take(pred);
  }

  for (const pred of transmissionAnchors) {
    if (selected.length >= targetCount) break;
    if (canSelect(pred, 'fill')) take(pred);
  }

  for (const pred of marketAnchors) {
    if (selected.length >= targetCount) break;
    if (canSelect(pred, 'fill')) take(pred);
  }

  for (const pred of ranked) {
    if (selected.length >= targetCount) break;
    if (canSelect(pred, 'fill')) take(pred);
  }

  // Backfill is weaker than fill: it can take a second same-state forecast without the
  // leverage gate, but it still respects the hard per-state cap.
  for (const pred of ranked) {
    if (selected.length >= targetCount) break;
    if (canSelect(pred, 'backfill')) take(pred);
  }

  // Domain guarantee: data-driven detectors (military) structurally can't match LLM-enriched
  // readiness scores, so they get buried in ranking. If no military forecast was selected
  // and we have room below the hard cap, inject the best-scoring eligible one.
  if (selected.length < MAX_TARGET_PUBLISHED_FORECASTS) {
    for (const guaranteedDomain of ['military']) {
      if (selected.some((p) => p.domain === guaranteedDomain)) continue;
      const candidate = ranked.find((p) => p.domain === guaranteedDomain && canSelect(p, 'fill'));
      if (candidate) take(candidate);
    }
  }

  const deferredCandidates = ranked.filter((pred) => !selectedIds.has(pred.id));
  if (deferredCandidates.length > 0) {
    console.log(`  [filterPublished] Deferred ${deferredCandidates.length} forecast(s) in family selection`);
  }

  const result = selected
    .slice()
    .sort((a, b) => (b.analysisPriority || 0) - (a.analysisPriority || 0)
      || (b.publishSelectionScore || 0) - (a.publishSelectionScore || 0)
      || (b.probability || 0) - (a.probability || 0));
  result.deferredCandidates = deferredCandidates;
  result.targetCount = targetCount;
  return result;
}

function buildPublishedForecastArtifacts(candidatePool, fullRunSituationClusters) {
  const filteredPredictions = filterPublishedForecasts(candidatePool);
  const filteredSituationClusters = projectSituationClusters(fullRunSituationClusters, filteredPredictions);
  attachSituationContext(filteredPredictions, filteredSituationClusters);
  const filteredSituationFamilies = attachSituationFamilyContext(filteredPredictions, buildSituationFamilies(filteredSituationClusters));
  const filteredStateUnits = attachStateContext(
    filteredPredictions,
    buildCanonicalStateUnits(filteredSituationClusters, filteredSituationFamilies),
  );
  const publishedPredictions = applySituationFamilyCaps(filteredPredictions, filteredSituationFamilies);
  const publishedSituationClusters = projectSituationClusters(fullRunSituationClusters, publishedPredictions);
  attachSituationContext(publishedPredictions, publishedSituationClusters);
  const publishedSituationFamilies = attachSituationFamilyContext(publishedPredictions, buildSituationFamilies(publishedSituationClusters));
  const publishedStateUnits = attachStateContext(
    publishedPredictions,
    buildCanonicalStateUnits(publishedSituationClusters, publishedSituationFamilies),
  );
  refreshPublishedNarratives(publishedPredictions);
  return {
    filteredPredictions,
    filteredSituationClusters,
    filteredSituationFamilies,
    filteredStateUnits,
    publishedPredictions,
    publishedSituationClusters,
    publishedSituationFamilies,
    publishedStateUnits,
  };
}

function markDeferredFamilySelection(predictions, selectedPool) {
  const selectedIds = new Set((selectedPool || []).map((pred) => pred.id));
  for (const pred of predictions || []) {
    if ((pred?.probability || 0) <= PUBLISH_MIN_PROBABILITY) continue;
    if (selectedIds.has(pred.id)) continue;
    if (pred.publishDiagnostics?.reason) continue;
    pred.publishDiagnostics = {
      reason: 'family_selection',
      familyId: pred.familyContext?.id || '',
      situationId: getForecastSelectionStateContext(pred)?.id || '',
      targetCount: selectedPool?.targetCount || 0,
    };
  }
}

function filterPublishedForecasts(predictions, minProbability = PUBLISH_MIN_PROBABILITY) {
  let weakFallbackCount = 0;
  let overlapSuppressedCount = 0;
  let situationCapSuppressedCount = 0;
  let situationDomainCapSuppressedCount = 0;
  const kept = [];

  for (const pred of predictions) {
    pred.publishDiagnostics = null;
    pred.publishTokens = pred.publishTokens || getForecastSituationTokens(pred);
    if ((pred?.probability || 0) <= minProbability) continue;
    const narrativeSource = pred?.traceMeta?.narrativeSource || 'fallback';
    const readiness = pred?.readiness?.overall ?? scoreForecastReadiness(pred).overall;
    const priority = typeof pred?.analysisPriority === 'number' ? pred.analysisPriority : computeAnalysisPriority(pred);
    const counterEvidenceTypes = new Set((pred?.caseFile?.counterEvidence || []).map(item => item.type));
    if (narrativeSource === 'fallback') {
      const weakFallback = (
        readiness < 0.4 &&
        priority < 0.08 &&
        (pred?.confidence || 0) < 0.45 &&
        (pred?.probability || 0) < 0.12 &&
        counterEvidenceTypes.has('coverage_gap') &&
        counterEvidenceTypes.has('confidence')
      );
      if (weakFallback) {
        weakFallbackCount++;
        pred.publishDiagnostics = { reason: 'weak_fallback' };
        continue;
      }
    }

    const bestDuplicate = kept.find((item) => {
      if (item.domain !== pred.domain) return false;
      if (item.familyContext?.id && pred.familyContext?.id && item.familyContext.id !== pred.familyContext.id) return false;
      const duplicateScore = computeSituationDuplicateScore(pred, item);
      if (!shouldSuppressAsSituationDuplicate(pred, item, duplicateScore)) return false;

      const priorityGap = (item.analysisPriority || 0) - priority;
      const confidenceGap = (item.confidence || 0) - (pred.confidence || 0);
      const readinessGap = (item.readiness?.overall || 0) - readiness;
      const probabilityGap = (item.probability || 0) - (pred.probability || 0);

      return (
        priorityGap >= 0.02 ||
        confidenceGap >= 0.08 ||
        readinessGap >= 0.08 ||
        probabilityGap >= 0.08
      );
    });

    if (bestDuplicate) {
      overlapSuppressedCount++;
      pred.publishDiagnostics = {
        reason: 'situation_overlap',
        keptForecastId: bestDuplicate.id,
        situationId: getForecastSelectionStateContext(pred)?.id || '',
      };
      continue;
    }

    kept.push(pred);
  }
  const published = [];
  const situationCounts = new Map();
  const situationDomainCounts = new Map();
  for (const pred of kept) {
    const situationId = getForecastSelectionStateContext(pred)?.id || '';
    if (!situationId) {
      published.push(pred);
      continue;
    }
    const totalCount = situationCounts.get(situationId) || 0;
    const domainKey = `${situationId}:${pred.domain}`;
    const domainCount = situationDomainCounts.get(domainKey) || 0;

    if (domainCount >= MAX_PUBLISHED_FORECASTS_PER_SITUATION_DOMAIN) {
      situationDomainCapSuppressedCount++;
      pred.publishDiagnostics = {
        reason: 'situation_domain_cap',
        situationId,
        domain: pred.domain,
        cap: MAX_PUBLISHED_FORECASTS_PER_SITUATION_DOMAIN,
      };
      continue;
    }
    if (totalCount >= MAX_PUBLISHED_FORECASTS_PER_SITUATION) {
      situationCapSuppressedCount++;
      pred.publishDiagnostics = {
        reason: 'situation_cap',
        situationId,
        cap: MAX_PUBLISHED_FORECASTS_PER_SITUATION,
      };
      continue;
    }

    published.push(pred);
    situationCounts.set(situationId, totalCount + 1);
    situationDomainCounts.set(domainKey, domainCount + 1);
  }
  if (weakFallbackCount > 0) {
    console.log(`  [filterPublished] Suppressed ${weakFallbackCount} weak fallback forecast(s)`);
  }
  if (overlapSuppressedCount > 0) {
    console.log(`  [filterPublished] Suppressed ${overlapSuppressedCount} situation-overlap forecast(s)`);
  }
  if (situationDomainCapSuppressedCount > 0) {
    console.log(`  [filterPublished] Suppressed ${situationDomainCapSuppressedCount} situation-domain-cap forecast(s)`);
  }
  if (situationCapSuppressedCount > 0) {
    console.log(`  [filterPublished] Suppressed ${situationCapSuppressedCount} situation-cap forecast(s)`);
  }
  return published;
}

function applySituationFamilyCaps(predictions, situationFamilies = []) {
  let familyCapSuppressedCount = 0;
  const published = [];
  const familyCounts = new Map();
  const familyDomainCounts = new Map();
  const familyIndex = buildSituationFamilyIndex(situationFamilies);

  for (const pred of predictions || []) {
    const family = familyIndex.get(pred.situationContext?.id || '');
    if (!family) {
      published.push(pred);
      continue;
    }
    const familyId = family.id;
    const familyTotalCount = familyCounts.get(familyId) || 0;
    const familyDomainKey = `${familyId}:${pred.domain}`;
    const familyDomainCount = familyDomainCounts.get(familyDomainKey) || 0;

    if (familyDomainCount >= MAX_PUBLISHED_FORECASTS_PER_FAMILY_DOMAIN) {
      familyCapSuppressedCount++;
      pred.publishDiagnostics = {
        reason: 'situation_family_cap',
        situationId: pred.situationContext?.id || '',
        familyId,
        domain: pred.domain,
        cap: MAX_PUBLISHED_FORECASTS_PER_FAMILY_DOMAIN,
      };
      continue;
    }
    if (familyTotalCount >= MAX_PUBLISHED_FORECASTS_PER_FAMILY) {
      familyCapSuppressedCount++;
      pred.publishDiagnostics = {
        reason: 'situation_family_cap',
        situationId: pred.situationContext?.id || '',
        familyId,
        cap: MAX_PUBLISHED_FORECASTS_PER_FAMILY,
      };
      continue;
    }

    published.push(pred);
    familyCounts.set(familyId, familyTotalCount + 1);
    familyDomainCounts.set(familyDomainKey, familyDomainCount + 1);
  }

  if (familyCapSuppressedCount > 0) {
    console.log(`  [filterPublished] Suppressed ${familyCapSuppressedCount} situation-family-cap forecast(s)`);
  }

  return published;
}

function selectForecastsForEnrichment(predictions, options = {}) {
  const maxCombined = options.maxCombined ?? ENRICHMENT_COMBINED_MAX;
  const maxScenario = options.maxScenario ?? ENRICHMENT_SCENARIO_MAX;
  const maxPerDomain = options.maxPerDomain ?? ENRICHMENT_MAX_PER_DOMAIN;
  const minReadiness = options.minReadiness ?? ENRICHMENT_MIN_READINESS;
  const maxTotal = maxCombined + maxScenario;

  const ranked = predictions
    .map((pred, index) => ({
      pred,
      index,
      readiness: scoreForecastReadiness(pred),
      analysisPriority: computeAnalysisPriority(pred),
    }))
    .filter(item => item.readiness.overall >= minReadiness)
    .sort((a, b) => {
      if (b.analysisPriority !== a.analysisPriority) return b.analysisPriority - a.analysisPriority;
      return (b.pred.probability * b.pred.confidence) - (a.pred.probability * a.pred.confidence);
    });

  const selectedDomains = new Map();
  const selectedIds = new Set();
  const combined = [];
  const scenarioOnly = [];
  const reservedScenarioDomains = [];
  let droppedByDomainCap = 0;

  function trySelect(target, item) {
    if (!item || selectedIds.has(item.pred.id)) return false;
    const currentCount = selectedDomains.get(item.pred.domain) || 0;
    if (currentCount >= maxPerDomain) {
      droppedByDomainCap++;
      return false;
    }
    target.push(item);
    selectedIds.add(item.pred.id);
    selectedDomains.set(item.pred.domain, currentCount + 1);
    return true;
  }

  for (const item of ranked) {
    if (combined.length >= maxCombined) break;
    trySelect(combined, item);
  }

  for (const domain of ENRICHMENT_PRIORITY_DOMAINS) {
    if (scenarioOnly.length >= maxScenario) break;
    const candidate = ranked.find(item => item.pred.domain === domain && !selectedIds.has(item.pred.id));
    if (candidate && trySelect(scenarioOnly, candidate)) reservedScenarioDomains.push(domain);
  }

  for (const item of ranked) {
    if ((combined.length + scenarioOnly.length) >= maxTotal || scenarioOnly.length >= maxScenario) break;
    trySelect(scenarioOnly, item);
  }

  return {
    combined: combined.map(item => item.pred),
    scenarioOnly: scenarioOnly.map(item => item.pred),
    telemetry: {
      candidateCount: predictions.length,
      readinessEligibleCount: ranked.length,
      selectedCombinedCount: combined.length,
      selectedScenarioCount: scenarioOnly.length,
      reservedScenarioDomains,
      droppedByDomainCap,
      selectedDomainCounts: Object.fromEntries(selectedDomains),
    },
  };
}

// ── Phase 2: LLM Scenario Enrichment ───────────────────────
const FORECAST_LLM_PROVIDERS = [
  { name: 'groq', envKey: 'GROQ_API_KEY', apiUrl: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.1-8b-instant', timeout: 20_000 },
  { name: 'openrouter', envKey: 'OPENROUTER_API_KEY', apiUrl: 'https://openrouter.ai/api/v1/chat/completions', model: 'google/gemini-2.5-flash', timeout: 25_000 },
];
const FORECAST_LLM_PROVIDER_NAMES = new Set(FORECAST_LLM_PROVIDERS.map(provider => provider.name));

function parseForecastProviderOrder(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const seen = new Set();
  const providers = [];
  for (const item of raw.split(',')) {
    const provider = item.trim().toLowerCase();
    if (!FORECAST_LLM_PROVIDER_NAMES.has(provider) || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers.length > 0 ? providers : null;
}

function getForecastLlmCallOptions(stage = 'default') {
  const defaultProviderOrder = FORECAST_LLM_PROVIDERS.map(provider => provider.name);
  const globalProviderOrder = parseForecastProviderOrder(process.env.FORECAST_LLM_PROVIDER_ORDER);
  const combinedProviderOrder = parseForecastProviderOrder(process.env.FORECAST_LLM_COMBINED_PROVIDER_ORDER);
  const criticalProviderOrder = parseForecastProviderOrder(process.env.FORECAST_LLM_CRITICAL_PROVIDER_ORDER);
  const providerOrder = stage === 'combined'
    ? (combinedProviderOrder || globalProviderOrder || defaultProviderOrder)
    : stage === 'critical_signals'
      ? (criticalProviderOrder || globalProviderOrder || defaultProviderOrder)
      : (globalProviderOrder || defaultProviderOrder);

  const openrouterModel = stage === 'combined'
    ? (process.env.FORECAST_LLM_COMBINED_MODEL_OPENROUTER || process.env.FORECAST_LLM_MODEL_OPENROUTER)
    : stage === 'critical_signals'
      ? (process.env.FORECAST_LLM_CRITICAL_MODEL_OPENROUTER || process.env.FORECAST_LLM_MODEL_OPENROUTER)
      : process.env.FORECAST_LLM_MODEL_OPENROUTER;

  return {
    providerOrder,
    modelOverrides: openrouterModel ? { openrouter: openrouterModel } : {},
  };
}

function resolveForecastLlmProviders(options = {}) {
  const requestedOrder = Array.isArray(options.providerOrder) && options.providerOrder.length > 0
    ? options.providerOrder
    : FORECAST_LLM_PROVIDERS.map(provider => provider.name);

  const seen = new Set();
  const providers = [];
  for (const providerName of requestedOrder) {
    if (seen.has(providerName)) continue;
    const provider = FORECAST_LLM_PROVIDERS.find(item => item.name === providerName);
    if (!provider) continue;
    seen.add(providerName);
    providers.push({
      ...provider,
      model: options.modelOverrides?.[provider.name] || provider.model,
    });
  }
  return providers.length > 0 ? providers : FORECAST_LLM_PROVIDERS;
}

function summarizeForecastLlmOptions(options = {}) {
  return {
    providerOrder: Array.isArray(options.providerOrder) ? options.providerOrder : [],
    modelOverrides: options.modelOverrides || {},
  };
}

const SCENARIO_SYSTEM_PROMPT = `You are a senior geopolitical intelligence analyst writing scenario briefs.

RULES:
- Write four fields for each prediction:
  - scenario: 1-2 sentence executive summary of the base case
  - baseCase: 2 sentences on the most likely path
  - escalatoryCase: 1-2 sentences on what would push risk materially higher
  - contrarianCase: 1-2 sentences on what would stall or reverse the path
- Every field MUST cite at least one concrete signal, headline, market cue, or trigger from the provided case file.
- Do NOT use your own knowledge. Base everything on the provided evidence only.
- Keep each field under 90 words.

Respond with ONLY a JSON array: [{"index": 0, "scenario": "...", "baseCase": "...", "escalatoryCase": "...", "contrarianCase": "..."}, ...]`;

// Phase 3: Combined scenario + perspectives prompt for top-2 predictions
const COMBINED_SYSTEM_PROMPT = `You are a senior geopolitical intelligence analyst. For each prediction:

1. Write a SCENARIO (1-2 sentences, evidence-grounded, citing signal values)
2. Write 3 CASES (1-2 sentences each):
   - BASE_CASE: the most likely path
   - ESCALATORY_CASE: what would push risk higher
   - CONTRARIAN_CASE: what would stall or reverse the path
3. Write 3 PERSPECTIVES (1-2 sentences each):
   - STRATEGIC: Neutral analysis of what signals indicate
   - REGIONAL: What this means for actors in the affected region
   - CONTRARIAN: What factors could prevent or reverse this outcome, grounded in the counter-evidence

RULES:
- Every field MUST cite a specific signal value, headline, market cue, or trigger from the case file
- Base everything on provided data, not your knowledge
- Do NOT use hedging without a data point

Output JSON array:
[{"index": 0, "scenario": "...", "baseCase": "...", "escalatoryCase": "...", "contrarianCase": "...", "strategic": "...", "regional": "...", "contrarian": "..."}, ...]`;

function validatePerspectives(items, predictions) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => {
    if (typeof item.index !== 'number' || item.index < 0 || item.index >= predictions.length) return false;
    for (const key of ['strategic', 'regional', 'contrarian']) {
      if (typeof item[key] !== 'string') return false;
      item[key] = sanitizeForPrompt(item[key]).slice(0, 300);
      if (item[key].length < 20) return false;
    }
    return true;
  });
}

function validateCaseNarratives(items, predictions) {
  if (!Array.isArray(items)) return [];
  return items.flatMap(item => {
    if (typeof item.index !== 'number' || item.index < 0 || item.index >= predictions.length) return [];
    const normalized = { index: item.index };
    let validCount = 0;
    for (const key of ['baseCase', 'escalatoryCase', 'contrarianCase']) {
      if (typeof item[key] !== 'string') continue;
      const sanitized = sanitizeForPrompt(item[key]).slice(0, 500);
      if (sanitized.length < 20) continue;
      normalized[key] = sanitized;
      validCount += 1;
    }
    return validCount > 0 ? [normalized] : [];
  });
}

function sanitizeForPrompt(text) {
  return (text || '').replace(/[\n\r]/g, ' ').replace(/[<>{}\x00-\x1f]/g, '').slice(0, 200).trim();
}

function extractStructuredLlmPayload(text) {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
    .replace(/```json\s*/gi, '```')
    .trim();
  const candidates = [];
  const fencedBlocks = [...cleaned.matchAll(/```([\s\S]*?)```/g)].map((match) => match[1].trim());
  candidates.push(...fencedBlocks);
  candidates.push(cleaned);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const direct = tryParseStructuredCandidate(trimmed);
    if (direct.items) return { items: direct.items, diagnostics: { stage: direct.stage, preview: sanitizeForPrompt(trimmed).slice(0, 220) } };
    const firstArray = extractFirstJsonArray(trimmed);
    if (firstArray) {
      const arrayParsed = tryParseStructuredCandidate(firstArray);
      if (arrayParsed.items) return { items: arrayParsed.items, diagnostics: { stage: arrayParsed.stage, preview: sanitizeForPrompt(firstArray).slice(0, 220) } };
    }
  }
  return {
    items: null,
    diagnostics: {
      stage: 'no_json_array',
      preview: sanitizeForPrompt(cleaned).slice(0, 220),
    },
  };
}

function extractFirstJsonArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function tryParseStructuredCandidate(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) return { items: parsed, stage: 'direct_array' };
    if (Array.isArray(parsed?.items)) return { items: parsed.items, stage: 'object_items' };
    if (Array.isArray(parsed?.scenarios)) return { items: parsed.scenarios, stage: 'object_scenarios' };
    if (Array.isArray(parsed?.predictions)) return { items: parsed.predictions, stage: 'object_predictions' };
  } catch {
    const bracketIdx = candidate.indexOf('[');
    if (bracketIdx !== -1) {
      const partial = candidate.slice(bracketIdx);
      for (const suffix of ['"}]', '}]', '"]', ']']) {
        try {
          const repaired = JSON.parse(partial + suffix);
          if (Array.isArray(repaired)) return { items: repaired, stage: 'repaired_array' };
        } catch {
          // continue
        }
      }
    }
  }
  return { items: null, stage: 'unparsed' };
}

function parseLLMScenarios(text) {
  return extractStructuredLlmPayload(text).items;
}

function hasEvidenceReference(text, candidate) {
  const normalized = sanitizeForPrompt(candidate).toLowerCase();
  if (!normalized) return false;
  if (text.includes(normalized)) return true;
  return tokenizeText(normalized).some(token => token.length > 3 && text.includes(token));
}

function buildScenarioEvidenceCandidates(pred) {
  return [
    pred.title || '',
    pred.region || '',
    pred.feedSummary || '',
    ...pred.signals.flatMap(sig => [sig.type, sig.value]),
    ...(pred.newsContext || []),
    pred.calibration?.marketTitle || '',
    pred.calibration ? roundPct(pred.calibration.marketPrice) : '',
    pred.stateContext?.label || '',
    ...(pred.stateContext?.sampleTitles || []),
    pred.situationContext?.label || '',
    pred.familyContext?.label || '',
    ...(pred.caseFile?.supportingEvidence || []).map(item => item.summary || ''),
    ...(pred.caseFile?.counterEvidence || []).map(item => item.summary || ''),
    ...(pred.caseFile?.triggers || []),
    pred.caseFile?.worldState?.summary || '',
    ...(pred.caseFile?.worldState?.activePressures || []),
    ...(pred.caseFile?.branches || []).flatMap((branch) => [branch.summary || '', branch.outcome || '']),
  ].filter(Boolean);
}

function validateScenarios(scenarios, predictions) {
  if (!Array.isArray(scenarios)) return [];
  return scenarios.filter(s => {
    if (!s || typeof s.scenario !== 'string' || s.scenario.length < 30) return false;
    if (typeof s.index !== 'number' || s.index < 0 || s.index >= predictions.length) return false;
    const pred = predictions[s.index];
    const scenarioLower = s.scenario.toLowerCase();
    const evidenceCandidates = buildScenarioEvidenceCandidates(pred);
    const hasEvidenceRef = evidenceCandidates.some(candidate => hasEvidenceReference(scenarioLower, candidate));
    if (!hasEvidenceRef) {
      console.warn(`  [LLM] Scenario ${s.index} rejected: no evidence reference`);
      return false;
    }
    s.scenario = sanitizeForPrompt(s.scenario).slice(0, 500);
    return true;
  });
}

function getEnrichmentFailureReason({ result, raw, scenarios = 0, perspectives = 0, cases = 0 }) {
  if (!result) return 'call_failed';
  if (raw == null) return 'parse_failed';
  if (Array.isArray(raw) && raw.length === 0) return 'empty_output';
  if ((scenarios + perspectives + cases) === 0) return 'validation_failed';
  return '';
}

async function callForecastLLM(systemPrompt, userPrompt, options = {}) {
  const stage = options.stage || 'default';
  const providers = resolveForecastLlmProviders(options);
  const requestedOrder = Array.isArray(options.providerOrder) && options.providerOrder.length > 0
    ? options.providerOrder.join(',')
    : providers.map(provider => provider.name).join(',');
  console.log(`  [LLM:${stage}] providerOrder=${requestedOrder} modelOverrides=${JSON.stringify(options.modelOverrides || {})}`);

  for (const provider of providers) {
    const apiKey = process.env[provider.envKey];
    if (!apiKey) continue;
    try {
      const resp = await fetch(provider.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': CHROME_UA,
          ...(provider.name === 'openrouter' ? { 'HTTP-Referer': 'https://worldmonitor.app', 'X-Title': 'World Monitor' } : {}),
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: options.maxTokens || 1500,
          temperature: options.temperature ?? 0.3,
        }),
        signal: AbortSignal.timeout(provider.timeout),
      });
      if (!resp.ok) {
        console.warn(`  [LLM:${stage}] ${provider.name} HTTP ${resp.status}`);
        continue;
      }
      const json = await resp.json();
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text || text.length < 20) continue;
      const model = json.model || provider.model;
      console.log(`  [LLM:${stage}] ${provider.name} success model=${model}`);
      return { text, model, provider: provider.name };
    } catch (err) {
      console.warn(`  [LLM:${stage}] ${provider.name} ${err.message}`);
    }
  }
  return null;
}

async function redisSet(url, token, key, data, ttlSeconds) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, JSON.stringify(data), 'EX', ttlSeconds]),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) { console.warn(`  [Redis] Cache write failed for ${key}: ${err.message}`); }
}

function buildCacheHash(preds) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(preds.map(p => ({
      id: p.id, d: p.domain, r: p.region, p: p.probability,
      s: p.signals.map(s => s.value).join(','),
      c: p.calibration?.drift,
      n: (p.newsContext || []).join(','),
      t: p.trend,
      j: p.projections ? `${p.projections.h24}|${p.projections.d7}|${p.projections.d30}` : '',
      g: (p.cascades || []).map(cascade => `${cascade.domain}:${cascade.effect}:${cascade.probability}`).join(','),
    }))))
    .digest('hex').slice(0, 16);
}

function buildUserPrompt(preds) {
  const predsText = preds.map((p, i) => {
    const sigs = p.signals.map(s => `[SIGNAL] ${sanitizeForPrompt(s.value)}`).join('\n');
    const cal = p.calibration ? `\n[CALIBRATION] ${sanitizeForPrompt(p.calibration.marketTitle)} at ${Math.round(p.calibration.marketPrice * 100)}%` : '';
    const projections = p.projections
      ? `\n[PROJECTIONS] 24h ${Math.round(p.projections.h24 * 100)}% | 7d ${Math.round(p.projections.d7 * 100)}% | 30d ${Math.round(p.projections.d30 * 100)}%`
      : '';
    const cascades = (p.cascades || []).length > 0
      ? `\n[CASCADES] ${p.cascades.map(c => `${sanitizeForPrompt(c.domain)} via ${sanitizeForPrompt(c.effect)} (${Math.round(c.probability * 100)}%)`).join('; ')}`
      : '';
    const headlines = (p.newsContext || []).slice(0, 3).map(h => `- ${sanitizeForPrompt(h)}`).join('\n');
    const news = headlines ? `\n[HEADLINES]\n${headlines}` : '\n[HEADLINES]\n- No directly matched headlines';
    const caseFile = p.caseFile || {};
    const support = (caseFile.supportingEvidence || [])
      .slice(0, 4)
      .map(item => `- ${sanitizeForPrompt(item.summary)} (${Math.round((item.weight || 0) * 100)}%)`)
      .join('\n');
    const counter = (caseFile.counterEvidence || [])
      .slice(0, 3)
      .map(item => `- ${sanitizeForPrompt(item.summary)}`)
      .join('\n');
    const triggers = (caseFile.triggers || []).slice(0, 3).map(item => `- ${sanitizeForPrompt(item)}`).join('\n');
    const actors = (caseFile.actors || [])
      .slice(0, 3)
      .map(actor => `- ${sanitizeForPrompt(actor.name)} [${sanitizeForPrompt(actor.category)}]: ${sanitizeForPrompt(actor.role)} | objective: ${sanitizeForPrompt(actor.objectives?.[0] || '')} | likely action: ${sanitizeForPrompt(actor.likelyActions?.[0] || '')}`)
      .join('\n');
    const worldSummary = caseFile.worldState?.summary ? sanitizeForPrompt(caseFile.worldState.summary) : '';
    const worldPressures = (caseFile.worldState?.activePressures || []).slice(0, 3).map(item => `- ${sanitizeForPrompt(item)}`).join('\n');
    const worldStabilizers = (caseFile.worldState?.stabilizers || []).slice(0, 2).map(item => `- ${sanitizeForPrompt(item)}`).join('\n');
    const worldUnknowns = (caseFile.worldState?.keyUnknowns || []).slice(0, 3).map(item => `- ${sanitizeForPrompt(item)}`).join('\n');
    const branches = (caseFile.branches || [])
      .slice(0, 3)
      .map(branch => `- ${sanitizeForPrompt(branch.kind)}: ${sanitizeForPrompt(branch.summary)} | outcome: ${sanitizeForPrompt(branch.outcome)} | projected: ${Math.round((branch.projectedProbability || 0) * 100)}%`)
      .join('\n');
    const caseSections = `${support ? `\n[SUPPORTING_EVIDENCE]\n${support}` : ''}${counter ? `\n[COUNTER_EVIDENCE]\n${counter}` : ''}${triggers ? `\n[TRIGGERS]\n${triggers}` : ''}${actors ? `\n[ACTORS]\n${actors}` : ''}${worldSummary ? `\n[WORLD_STATE]\n- ${worldSummary}` : ''}${worldPressures ? `\n[ACTIVE_PRESSURES]\n${worldPressures}` : ''}${worldStabilizers ? `\n[STABILIZERS]\n${worldStabilizers}` : ''}${worldUnknowns ? `\n[KEY_UNKNOWNS]\n${worldUnknowns}` : ''}${branches ? `\n[SIMULATED_BRANCHES]\n${branches}` : ''}`;
    return `[${i}] "${sanitizeForPrompt(p.title)}" (${p.domain}, ${p.region})\nProbability: ${Math.round(p.probability * 100)}% | Confidence: ${Math.round(p.confidence * 100)}% | Trend: ${p.trend} | Horizon: ${p.timeHorizon}\n${sigs}${cal}${projections}${cascades}${news}${caseSections}`;
  }).join('\n\n');
  return `Predictions to analyze:\n\n${predsText}`;
}

function buildFallbackBaseCase(pred) {
  const situation = pred.caseFile?.situationContext || pred.situationContext;
  const support = pred.caseFile?.supportingEvidence?.[0]?.summary || pred.signals?.[0]?.value || pred.title;
  const secondary = pred.caseFile?.supportingEvidence?.[1]?.summary || pred.signals?.[1]?.value;
  // Situation-aware path takes priority so the situation label always appears in the narrative
  if (situation?.forecastCount > 1) {
    const lead = `${support} is a leading signal inside ${buildSituationReference(situation)} across ${situation.forecastCount} related forecasts`;
    const follow = secondary
      ? `${secondary} keeps the base case near ${roundPct(pred.probability)} over the ${pred.timeHorizon}`
      : `The base case stays near ${roundPct(pred.probability)} over the ${pred.timeHorizon}, with ${pred.trend} momentum`;
    return buildNarrativeSentence(lead, follow).slice(0, 500);
  }
  const branch = pred.caseFile?.branches?.find(item => item.kind === 'base');
  if (branch?.summary && branch?.outcome) {
    return buildNarrativeSentence(branch.summary, branch.outcome).slice(0, 500);
  }
  const lead = `${support} is the clearest active driver behind this ${pred.domain} forecast in ${pred.region}.`;
  const follow = secondary
    ? `${secondary} keeps the base case near ${roundPct(pred.probability)} over the ${pred.timeHorizon}`
    : `The base case stays near ${roundPct(pred.probability)} over the ${pred.timeHorizon}, with ${pred.trend} momentum`;
  return buildNarrativeSentence(lead, follow).slice(0, 500);
}

function buildFallbackEscalatoryCase(pred) {
  const branch = pred.caseFile?.branches?.find(item => item.kind === 'escalatory');
  if (branch?.summary && branch?.outcome) {
    return buildNarrativeSentence(branch.summary, branch.outcome).slice(0, 500);
  }
  const trigger = pred.caseFile?.triggers?.[0];
  const cascade = pred.cascades?.[0];
  const firstSignal = pred.signals?.[0]?.value || pred.title;
  const escalation = trigger
    ? `${trigger} That would likely push the forecast above its current ${roundPct(pred.probability)} baseline.`
    : `${firstSignal} intensifying further would move this forecast above its current ${roundPct(pred.probability)} baseline.`;
  const spillover = cascade
    ? `The first spillover risk would likely appear in ${cascade.domain} via ${cascade.effect}.`
    : `The next move higher would depend on the current ${pred.trend} trajectory hardening into a clearer signal cluster.`;
  return buildNarrativeSentence(escalation, spillover).slice(0, 500);
}

function buildFallbackContrarianCase(pred) {
  const branch = pred.caseFile?.branches?.find(item => item.kind === 'contrarian');
  if (branch?.summary && branch?.outcome) {
    return buildNarrativeSentence(branch.summary, branch.outcome).slice(0, 500);
  }
  const counter = pred.caseFile?.counterEvidence?.[0]?.summary;
  const calibration = pred.calibration
    ? `A move in "${pred.calibration.marketTitle}" away from the current ${roundPct(pred.calibration.marketPrice)} market signal would challenge the existing baseline.`
    : 'A failure to add corroborating evidence across sources would challenge the current baseline.';
  return buildNarrativeSentence(
    counter || calibration,
    pred.trend === 'falling'
      ? 'The already falling trend is the main stabilizing clue.'
      : 'The base case still needs further confirmation to stay durable.',
  ).slice(0, 500);
}

function buildFallbackScenario(pred) {
  const baseCase = pred.caseFile?.baseCase || buildFallbackBaseCase(pred);
  return baseCase.slice(0, 500);
}

function buildFeedSummary(pred) {
  const lead = pred.caseFile?.baseCase || pred.scenario || buildFallbackScenario(pred);
  const compact = lead.replace(/\s+/g, ' ').trim();
  if (compact) return compact.slice(0, 500);
  return `Base case for ${pred.title} remains live at ${roundPct(pred.probability)} over the ${pred.timeHorizon}.`;
}

function buildFallbackPerspectives(pred) {
  const firstSignal = pred.caseFile?.supportingEvidence?.[0]?.summary || pred.signals?.[0]?.value || pred.title;
  const contrarian = pred.caseFile?.contrarianCase || buildFallbackContrarianCase(pred);
  return {
    strategic: `${firstSignal} is setting the strategic baseline, and the current ${Math.round(pred.probability * 100)}% probability implies a live but not settled risk path.`,
    regional: `For actors in ${pred.region}, the practical implication is continued sensitivity to short-term triggers over the ${pred.timeHorizon}, especially if the current ${pred.trend} trend persists.`,
    contrarian,
  };
}

function populateFallbackNarratives(predictions) {
  let fallbackCount = 0;
  for (const pred of predictions) {
    if (!pred.caseFile) buildForecastCase(pred);
    if (!pred.caseFile.baseCase) pred.caseFile.baseCase = buildFallbackBaseCase(pred);
    if (!pred.caseFile.escalatoryCase) pred.caseFile.escalatoryCase = buildFallbackEscalatoryCase(pred);
    if (!pred.caseFile.contrarianCase) pred.caseFile.contrarianCase = buildFallbackContrarianCase(pred);
    if (!pred.caseFile.changeItems?.length || !pred.caseFile.changeSummary) {
      const fallbackItems = buildChangeItems(pred, null);
      pred.caseFile.changeItems = fallbackItems;
      pred.caseFile.changeSummary = buildChangeSummary(pred, null, fallbackItems);
    }
    if (!pred.scenario) pred.scenario = buildFallbackScenario(pred);
    if (!pred.feedSummary) pred.feedSummary = buildFeedSummary(pred);
    if (!pred.perspectives) pred.perspectives = buildFallbackPerspectives(pred);
    if (!pred.traceMeta) {
      applyTraceMeta(pred, {
        narrativeSource: 'fallback',
        llmCached: false,
        llmProvider: '',
        llmModel: '',
        branchSource: 'deterministic',
      });
      fallbackCount++;
    }
  }
  if (fallbackCount > 0) {
    console.log(`  [fallbackNarratives] Applied fallback narratives to ${fallbackCount} forecast(s)`);
  }
}

function refreshPublishedNarratives(predictions) {
  for (const pred of predictions || []) {
    if (!pred.caseFile) buildForecastCase(pred);
    pred.caseFile.baseCase = buildFallbackBaseCase(pred);
    pred.caseFile.escalatoryCase = buildFallbackEscalatoryCase(pred);
    pred.caseFile.contrarianCase = buildFallbackContrarianCase(pred);
    if ((pred?.traceMeta?.narrativeSource || 'fallback') === 'fallback') {
      pred.scenario = buildFallbackScenario(pred);
      pred.perspectives = buildFallbackPerspectives(pred);
    }
    pred.feedSummary = buildFeedSummary(pred);
  }
}

function applyLlmTraceMeta(predictions, indexes, source, provider, model, cached = false) {
  for (const index of indexes || []) {
    if (typeof index !== 'number' || index < 0 || index >= predictions.length) continue;
    applyTraceMeta(predictions[index], {
      narrativeSource: source,
      llmCached: cached,
      llmProvider: provider,
      llmModel: model,
      branchSource: 'deterministic',
    });
  }
}

async function recoverScenarioNarratives(predictions, llmOptions = {}, stage = 'scenario_recovery') {
  if (!Array.isArray(predictions) || predictions.length === 0) return null;
  const result = await callForecastLLM(SCENARIO_SYSTEM_PROMPT, buildUserPrompt(predictions), { ...llmOptions, stage });
  if (!result) return null;
  const parsed = extractStructuredLlmPayload(result.text);
  const raw = parsed.items;
  const validScenarios = validateScenarios(raw, predictions);
  const validCases = validateCaseNarratives(raw, predictions);
  return {
    result,
    parsed,
    raw,
    validScenarios,
    validCases,
  };
}

async function enrichScenariosWithLLM(predictions) {
  if (predictions.length === 0) return null;
  const { url, token } = getRedisCredentials();
  const enrichmentTargets = selectForecastsForEnrichment(predictions);
  const combinedLlmOptions = getForecastLlmCallOptions('combined');
  const scenarioLlmOptions = getForecastLlmCallOptions('scenario');
  const enrichmentMeta = {
    selection: enrichmentTargets.telemetry,
    combined: {
      requested: enrichmentTargets.combined.length,
      source: 'none',
      provider: '',
      model: '',
      scenarios: 0,
      perspectives: 0,
      cases: 0,
      rawItemCount: 0,
      parseStage: '',
      rawPreview: '',
      failureReason: '',
      succeeded: false,
    },
    scenario: {
      requested: enrichmentTargets.scenarioOnly.length,
      source: 'none',
      provider: '',
      model: '',
      scenarios: 0,
      cases: 0,
      rawItemCount: 0,
      parseStage: '',
      rawPreview: '',
      failureReason: '',
      succeeded: false,
    },
  };

  // Higher-quality top forecasts get richer scenario + perspective treatment.
  const topWithPerspectives = enrichmentTargets.combined;
  const scenarioOnly = enrichmentTargets.scenarioOnly;
  console.log(`  [LLM] selected combined=${topWithPerspectives.length} scenario=${scenarioOnly.length}`);

  // Call 1: Combined scenario + perspectives for top-2
  if (topWithPerspectives.length > 0) {
    const hash = buildCacheHash(topWithPerspectives);
    const cacheKey = `forecast:llm-combined:${hash}`;
    console.log(`  [LLM:combined] start selected=${topWithPerspectives.length} cacheKey=${cacheKey}`);
    const cached = await redisGet(url, token, cacheKey);

    if (cached?.items) {
      console.log(`  [LLM:combined] cache hit items=${cached.items.length}`);
      enrichmentMeta.combined.source = 'cache';
      enrichmentMeta.combined.succeeded = true;
      enrichmentMeta.combined.provider = 'cache';
      enrichmentMeta.combined.model = 'cache';
      enrichmentMeta.combined.scenarios = cached.items.filter(item => item.scenario).length;
      enrichmentMeta.combined.perspectives = cached.items.filter(item => item.strategic || item.regional || item.contrarian).length;
      enrichmentMeta.combined.cases = cached.items.filter(item => item.baseCase || item.escalatoryCase || item.contrarianCase).length;
      enrichmentMeta.combined.rawItemCount = cached.items.length;
      const touchedCombinedIndexes = new Set();
      for (const item of cached.items) {
        if (item.index >= 0 && item.index < topWithPerspectives.length) {
          if (item.scenario) topWithPerspectives[item.index].scenario = item.scenario;
          if (item.strategic || item.regional || item.contrarian) {
            topWithPerspectives[item.index].perspectives = {
              strategic: item.strategic || '',
              regional: item.regional || '',
              contrarian: item.contrarian || '',
            };
          }
          if (item.baseCase || item.escalatoryCase || item.contrarianCase) {
            topWithPerspectives[item.index].caseFile = {
              ...(topWithPerspectives[item.index].caseFile || buildForecastCase(topWithPerspectives[item.index])),
              baseCase: item.baseCase || topWithPerspectives[item.index].caseFile?.baseCase || '',
              escalatoryCase: item.escalatoryCase || topWithPerspectives[item.index].caseFile?.escalatoryCase || '',
              contrarianCase: item.contrarianCase || topWithPerspectives[item.index].caseFile?.contrarianCase || '',
            };
          }
          if (item.scenario || item.strategic || item.regional || item.contrarian || item.baseCase || item.escalatoryCase || item.contrarianCase) {
            touchedCombinedIndexes.add(item.index);
          }
        }
      }
      applyLlmTraceMeta(topWithPerspectives, [...touchedCombinedIndexes], 'llm_combined_cache', 'cache', 'cache', true);
      console.log(JSON.stringify({ event: 'llm_combined', cached: true, count: cached.items.length, hash }));
    } else {
      console.log('  [LLM:combined] cache miss');
      const t0 = Date.now();
      console.log('  [LLM:combined] invoking provider');
      const result = await callForecastLLM(COMBINED_SYSTEM_PROMPT, buildUserPrompt(topWithPerspectives), { ...combinedLlmOptions, stage: 'combined' });
      if (result) {
        const parsed = extractStructuredLlmPayload(result.text);
        const raw = parsed.items;
        let failureResult = result;
        let failureRaw = raw;
        let validScenarios = validateScenarios(raw, topWithPerspectives);
        const validPerspectives = validatePerspectives(raw, topWithPerspectives);
        let validCases = validateCaseNarratives(raw, topWithPerspectives);
        enrichmentMeta.combined.source = 'live';
        enrichmentMeta.combined.provider = result.provider;
        enrichmentMeta.combined.model = result.model;
        enrichmentMeta.combined.rawItemCount = Array.isArray(raw) ? raw.length : 0;
        enrichmentMeta.combined.parseStage = parsed.diagnostics?.stage || '';
        enrichmentMeta.combined.rawPreview = parsed.diagnostics?.preview || '';
        if (validScenarios.length === 0 && validCases.length === 0) {
          const recovery = await recoverScenarioNarratives(topWithPerspectives, scenarioLlmOptions, 'combined_recovery');
          if (recovery && (recovery.validScenarios.length > 0 || recovery.validCases.length > 0)) {
            failureResult = recovery.result;
            failureRaw = recovery.raw;
            validScenarios = recovery.validScenarios;
            validCases = recovery.validCases;
            enrichmentMeta.combined.provider = recovery.result.provider;
            enrichmentMeta.combined.model = recovery.result.model;
            enrichmentMeta.combined.parseStage = `recovered_${recovery.parsed.diagnostics?.stage || 'unknown'}`;
            enrichmentMeta.combined.rawPreview = recovery.parsed.diagnostics?.preview || enrichmentMeta.combined.rawPreview;
          }
        }

        for (const s of validScenarios) topWithPerspectives[s.index].scenario = s.scenario;
        for (const p of validPerspectives) {
          topWithPerspectives[p.index].perspectives = { strategic: p.strategic, regional: p.regional, contrarian: p.contrarian };
        }
        for (const c of validCases) {
          topWithPerspectives[c.index].caseFile = {
            ...(topWithPerspectives[c.index].caseFile || buildForecastCase(topWithPerspectives[c.index])),
            baseCase: c.baseCase || topWithPerspectives[c.index].caseFile?.baseCase || '',
            escalatoryCase: c.escalatoryCase || topWithPerspectives[c.index].caseFile?.escalatoryCase || '',
            contrarianCase: c.contrarianCase || topWithPerspectives[c.index].caseFile?.contrarianCase || '',
          };
        }
        const touchedCombinedIndexes = new Set([
          ...validScenarios.map((item) => item.index),
          ...validPerspectives.map((item) => item.index),
          ...validCases.map((item) => item.index),
        ]);
        applyLlmTraceMeta(topWithPerspectives, [...touchedCombinedIndexes], 'llm_combined', enrichmentMeta.combined.provider, enrichmentMeta.combined.model, false);

        enrichmentMeta.combined.scenarios = validScenarios.length;
        enrichmentMeta.combined.perspectives = validPerspectives.length;
        enrichmentMeta.combined.cases = validCases.length;
        enrichmentMeta.combined.succeeded = touchedCombinedIndexes.size > 0;
        enrichmentMeta.combined.failureReason = getEnrichmentFailureReason({
          result: failureResult,
          raw: failureRaw,
          scenarios: validScenarios.length,
          perspectives: validPerspectives.length,
          cases: validCases.length,
        });

        // Cache only validated items (not raw) to prevent persisting invalid LLM output
        const items = [];
        for (const index of [...touchedCombinedIndexes].sort((a, b) => a - b)) {
          const s = validScenarios.find((item) => item.index === index);
          const entry = { index };
          if (s?.scenario) entry.scenario = s.scenario;
          const p = validPerspectives.find(vp => vp.index === index);
          if (p) { entry.strategic = p.strategic; entry.regional = p.regional; entry.contrarian = p.contrarian; }
          const c = validCases.find(vc => vc.index === index);
          if (c) {
            if (c.baseCase) entry.baseCase = c.baseCase;
            if (c.escalatoryCase) entry.escalatoryCase = c.escalatoryCase;
            if (c.contrarianCase) entry.contrarianCase = c.contrarianCase;
          }
          items.push(entry);
        }

        console.log(JSON.stringify({
          event: 'llm_combined', provider: result.provider, model: result.model,
          hash, count: topWithPerspectives.length,
          rawItems: Array.isArray(raw) ? raw.length : 0,
          parseStage: enrichmentMeta.combined.parseStage || '',
          scenarios: validScenarios.length, perspectives: validPerspectives.length, cases: validCases.length,
          failureReason: enrichmentMeta.combined.failureReason || '',
          latencyMs: Math.round(Date.now() - t0), cached: false,
        }));

        if (items.length > 0) await redisSet(url, token, cacheKey, { items }, 3600);
      } else {
        enrichmentMeta.combined.failureReason = 'call_failed';
        console.warn('  [LLM:combined] call failed');
      }
    }
  } else {
    console.log('  [LLM:combined] skipped selected=0');
  }

  // Call 2: Scenario-only for predictions 3-4
  if (scenarioOnly.length > 0) {
    const hash = buildCacheHash(scenarioOnly);
    const cacheKey = `forecast:llm-scenarios:${hash}`;
    console.log(`  [LLM:scenario] start selected=${scenarioOnly.length} cacheKey=${cacheKey}`);
    const cached = await redisGet(url, token, cacheKey);

    if (cached?.scenarios) {
      console.log(`  [LLM:scenario] cache hit items=${cached.scenarios.length}`);
      enrichmentMeta.scenario.source = 'cache';
      enrichmentMeta.scenario.succeeded = true;
      enrichmentMeta.scenario.provider = 'cache';
      enrichmentMeta.scenario.model = 'cache';
      enrichmentMeta.scenario.scenarios = cached.scenarios.filter(item => item.scenario).length;
      enrichmentMeta.scenario.cases = cached.scenarios.filter(item => item.baseCase || item.escalatoryCase || item.contrarianCase).length;
      enrichmentMeta.scenario.rawItemCount = cached.scenarios.length;
      const touchedScenarioIndexes = new Set();
      for (const s of cached.scenarios) {
        if (s.index >= 0 && s.index < scenarioOnly.length && s.scenario) scenarioOnly[s.index].scenario = s.scenario;
        if (s.index >= 0 && s.index < scenarioOnly.length && (s.baseCase || s.escalatoryCase || s.contrarianCase)) {
          scenarioOnly[s.index].caseFile = {
            ...(scenarioOnly[s.index].caseFile || buildForecastCase(scenarioOnly[s.index])),
            baseCase: s.baseCase || scenarioOnly[s.index].caseFile?.baseCase || '',
            escalatoryCase: s.escalatoryCase || scenarioOnly[s.index].caseFile?.escalatoryCase || '',
            contrarianCase: s.contrarianCase || scenarioOnly[s.index].caseFile?.contrarianCase || '',
          };
        }
        if (s.index >= 0 && s.index < scenarioOnly.length && (s.scenario || s.baseCase || s.escalatoryCase || s.contrarianCase)) {
          touchedScenarioIndexes.add(s.index);
        }
      }
      applyLlmTraceMeta(scenarioOnly, [...touchedScenarioIndexes], 'llm_scenario_cache', 'cache', 'cache', true);
      console.log(JSON.stringify({ event: 'llm_scenario', cached: true, count: cached.scenarios.length, hash }));
    } else {
      console.log('  [LLM:scenario] cache miss');
      const t0 = Date.now();
      console.log('  [LLM:scenario] invoking provider');
      const result = await callForecastLLM(SCENARIO_SYSTEM_PROMPT, buildUserPrompt(scenarioOnly), { ...scenarioLlmOptions, stage: 'scenario' });
      if (result) {
        const parsed = extractStructuredLlmPayload(result.text);
        const raw = parsed.items;
        const valid = validateScenarios(raw, scenarioOnly);
        const validCases = validateCaseNarratives(raw, scenarioOnly);
        enrichmentMeta.scenario.source = 'live';
        enrichmentMeta.scenario.provider = result.provider;
        enrichmentMeta.scenario.model = result.model;
        enrichmentMeta.scenario.rawItemCount = Array.isArray(raw) ? raw.length : 0;
        enrichmentMeta.scenario.parseStage = parsed.diagnostics?.stage || '';
        enrichmentMeta.scenario.rawPreview = parsed.diagnostics?.preview || '';
        enrichmentMeta.scenario.scenarios = valid.length;
        enrichmentMeta.scenario.cases = validCases.length;
        enrichmentMeta.scenario.succeeded = valid.length > 0 || validCases.length > 0;
        enrichmentMeta.scenario.failureReason = getEnrichmentFailureReason({
          result,
          raw,
          scenarios: valid.length,
          cases: validCases.length,
        });
        for (const s of valid) scenarioOnly[s.index].scenario = s.scenario;
        for (const c of validCases) {
          scenarioOnly[c.index].caseFile = {
            ...(scenarioOnly[c.index].caseFile || buildForecastCase(scenarioOnly[c.index])),
            baseCase: c.baseCase || scenarioOnly[c.index].caseFile?.baseCase || '',
            escalatoryCase: c.escalatoryCase || scenarioOnly[c.index].caseFile?.escalatoryCase || '',
            contrarianCase: c.contrarianCase || scenarioOnly[c.index].caseFile?.contrarianCase || '',
          };
        }
        const touchedScenarioIndexes = new Set([
          ...valid.map((item) => item.index),
          ...validCases.map((item) => item.index),
        ]);
        applyLlmTraceMeta(scenarioOnly, [...touchedScenarioIndexes], 'llm_scenario', result.provider, result.model, false);

        console.log(JSON.stringify({
          event: 'llm_scenario', provider: result.provider, model: result.model,
          hash, count: scenarioOnly.length, rawItems: Array.isArray(raw) ? raw.length : 0, parseStage: enrichmentMeta.scenario.parseStage || '', scenarios: valid.length, cases: validCases.length,
          failureReason: enrichmentMeta.scenario.failureReason || '',
          latencyMs: Math.round(Date.now() - t0), cached: false,
        }));

        if (valid.length > 0 || validCases.length > 0) {
          const scenarios = [];
          const seen = new Set();
          for (const s of valid) {
            const item = { index: s.index, scenario: s.scenario };
            const c = validCases.find(vc => vc.index === s.index);
            if (c) {
              if (c.baseCase) item.baseCase = c.baseCase;
              if (c.escalatoryCase) item.escalatoryCase = c.escalatoryCase;
              if (c.contrarianCase) item.contrarianCase = c.contrarianCase;
            }
            scenarios.push(item);
            seen.add(s.index);
          }
          for (const c of validCases) {
            if (seen.has(c.index)) continue;
            scenarios.push({
              index: c.index,
              scenario: '',
              ...(c.baseCase ? { baseCase: c.baseCase } : {}),
              ...(c.escalatoryCase ? { escalatoryCase: c.escalatoryCase } : {}),
              ...(c.contrarianCase ? { contrarianCase: c.contrarianCase } : {}),
            });
          }
          await redisSet(url, token, cacheKey, { scenarios }, 3600);
        }
      } else {
        enrichmentMeta.scenario.failureReason = 'call_failed';
        console.warn('  [LLM:scenario] call failed');
      }
    }
  } else {
    console.log('  [LLM:scenario] skipped selected=0');
  }

  return enrichmentMeta;
}

// ── Main pipeline ──────────────────────────────────────────
async function fetchForecasts() {
  await warmPingChokepoints();
  const traceStorageConfig = resolveR2StorageConfig();
  const [priorWorldStates, priorWorldStateFallback] = traceStorageConfig
    ? await Promise.all([
      readForecastWorldStateHistory(traceStorageConfig, WORLD_STATE_HISTORY_LIMIT),
      readPreviousForecastWorldState(traceStorageConfig),
    ])
    : [[], null];
  const priorWorldState = priorWorldStates[0] ?? priorWorldStateFallback;
  const publishSelectionMemoryIndex = buildPublishSelectionMemoryIndex(priorWorldState);

  console.log('  Reading input data from Redis...');
  const inputs = await readInputKeys();
  console.log('  Extracting urgent critical event frames...');
  inputs.criticalSignalBundle = await extractCriticalSignalBundle(inputs);
  console.log(`  [CriticalSignals] source=${inputs.criticalSignalBundle.source} candidates=${inputs.criticalSignalBundle.candidateCount} frames=${inputs.criticalSignalBundle.extractedFrameCount} fallbackNewsSignals=${inputs.criticalSignalBundle.fallbackNewsSignalCount} structuredSignals=${inputs.criticalSignalBundle.structuredSignalCount}`);
  const prior = await readPriorPredictions();

  console.log('  Running domain detectors...');
  const predictions = [
    ...detectConflictScenarios(inputs),
    ...detectMarketScenarios(inputs),
    ...detectSupplyChainScenarios(inputs),
    ...detectPoliticalScenarios(inputs),
    ...detectMilitaryScenarios(inputs),
    ...detectInfraScenarios(inputs),
    ...detectUcdpConflictZones(inputs),
    ...detectCyberScenarios(inputs),
    ...detectGpsJammingScenarios(inputs),
    ...detectFromPredictionMarkets(inputs),
  ];

  console.log(`  Generated ${predictions.length} predictions`);
  {
    const traceCap = getTraceCapLog(predictions.length);
    console.log(`  Forecast trace config: raw=${traceCap.raw ?? 'default'} resolved=${traceCap.resolved} total=${traceCap.totalForecasts}`);
  }

  attachNewsContext(predictions, inputs.newsInsights, inputs.newsDigest);
  calibrateWithMarkets(predictions, inputs.predictionMarkets);
  computeConfidence(predictions);
  computeProjections(predictions);
  const cascadeRules = loadCascadeRules();
  resolveCascades(predictions, cascadeRules);
  discoverGraphCascades(predictions, loadEntityGraph());
  computeTrends(predictions, prior);
  buildForecastCases(predictions);
  annotateForecastChanges(predictions, prior);
  let fullRunPredictions = predictions.slice();
  let fullRunSituationClusters = attachSituationContext(predictions);
  let fullRunSituationFamilies = attachSituationFamilyContext(predictions, buildSituationFamilies(fullRunSituationClusters));
  let fullRunStateUnits = attachStateContext(
    predictions,
    buildCanonicalStateUnits(fullRunSituationClusters, fullRunSituationFamilies),
  );
  let selectionWorldSignals = buildWorldSignals(inputs, predictions, fullRunSituationClusters);
  let selectionMarketTransmission = buildMarketTransmissionGraph(selectionWorldSignals, fullRunSituationClusters);
  let selectionMarketState = buildMarketState(selectionWorldSignals, selectionMarketTransmission);
  const selectionMarketInputCoverage = summarizeMarketInputCoverage(inputs);
  const stateDerivedPredictions = deriveStateDrivenForecasts({
    existingPredictions: predictions,
    stateUnits: fullRunStateUnits,
    worldSignals: selectionWorldSignals,
    marketTransmission: selectionMarketTransmission,
    marketState: selectionMarketState,
    marketInputCoverage: selectionMarketInputCoverage,
  });
  if (stateDerivedPredictions.length > 0) {
    const stateDerivedDomainCounts = summarizeTypeCounts(stateDerivedPredictions.map((pred) => pred.domain));
    console.log(`  [stateDerived] Added ${stateDerivedPredictions.length} forecast(s) from canonical state units (${Object.entries(stateDerivedDomainCounts).map(([domain, count]) => `${domain}:${count}`).join(', ')})`);
    attachNewsContext(stateDerivedPredictions, inputs.newsInsights, inputs.newsDigest);
    calibrateWithMarkets(stateDerivedPredictions, inputs.predictionMarkets);
    computeConfidence(stateDerivedPredictions);
    computeProjections(stateDerivedPredictions);
    resolveCascades(stateDerivedPredictions, cascadeRules);
    discoverGraphCascades(stateDerivedPredictions, loadEntityGraph());
    computeTrends(stateDerivedPredictions, prior);
    buildForecastCases(stateDerivedPredictions);
    annotateForecastChanges(stateDerivedPredictions, prior);
    predictions.push(...stateDerivedPredictions);
    fullRunPredictions = predictions.slice();
    fullRunSituationClusters = attachSituationContext(predictions);
    fullRunSituationFamilies = attachSituationFamilyContext(predictions, buildSituationFamilies(fullRunSituationClusters));
    fullRunStateUnits = attachStateContext(
      predictions,
      buildCanonicalStateUnits(fullRunSituationClusters, fullRunSituationFamilies),
    );
    selectionWorldSignals = buildWorldSignals(inputs, predictions, fullRunSituationClusters);
    selectionMarketTransmission = buildMarketTransmissionGraph(selectionWorldSignals, fullRunSituationClusters);
    selectionMarketState = buildMarketState(selectionWorldSignals, selectionMarketTransmission);
  }
  const marketSelectionIndex = buildSituationMarketContextIndex(
    selectionWorldSignals,
    selectionMarketTransmission,
    selectionMarketState,
    fullRunStateUnits,
    selectionMarketInputCoverage,
  );
  attachMarketSelectionContext(predictions, marketSelectionIndex);
  prepareForecastMetrics(predictions);

  rankForecastsForAnalysis(predictions);

  const enrichmentMeta = await enrichScenariosWithLLM(predictions);
  populateFallbackNarratives(predictions);

  const publishSelectionPool = selectPublishedForecastPool(predictions, {
    memoryIndex: publishSelectionMemoryIndex,
  });
  const finalSelectionPool = [...publishSelectionPool];
  finalSelectionPool.targetCount = publishSelectionPool.targetCount || finalSelectionPool.length;
  const deferredCandidates = [...(publishSelectionPool.deferredCandidates || [])];
  let publishArtifacts = buildPublishedForecastArtifacts(finalSelectionPool, fullRunSituationClusters);
  while (publishArtifacts.publishedPredictions.length < (finalSelectionPool.targetCount || 0) && deferredCandidates.length > 0) {
    finalSelectionPool.push(deferredCandidates.shift());
    publishArtifacts = buildPublishedForecastArtifacts(finalSelectionPool, fullRunSituationClusters);
  }
  markDeferredFamilySelection(predictions, finalSelectionPool);
  const initiallyPublishedPredictions = publishArtifacts.filteredPredictions;
  const initiallyPublishedSituationClusters = publishArtifacts.filteredSituationClusters;
  const initiallyPublishedSituationFamilies = publishArtifacts.filteredSituationFamilies;
  const publishedPredictions = publishArtifacts.publishedPredictions;
  const publishTelemetry = summarizePublishFiltering(predictions);
  const publishedSituationClusters = publishArtifacts.publishedSituationClusters;
  const publishedSituationFamilies = publishArtifacts.publishedSituationFamilies;
  const publishedStateUnits = publishArtifacts.publishedStateUnits;
  if (publishedPredictions.length !== predictions.length) {
    console.log(`  Filtered ${predictions.length - publishedPredictions.length} forecasts at publish floor > ${PUBLISH_MIN_PROBABILITY}`);
  }

  return {
    predictions: publishedPredictions,
    fullRunPredictions,
    inputs,
    generatedAt: Date.now(),
    enrichmentMeta,
    publishTelemetry,
    publishSelectionPool,
    situationClusters: publishedSituationClusters,
    situationFamilies: publishedSituationFamilies,
    stateUnits: publishedStateUnits,
    fullRunSituationClusters,
    fullRunSituationFamilies,
    fullRunStateUnits,
    priorWorldState,
    priorWorldStates,
  };
}

async function readForecastRefreshRequest() {
  try {
    const { url, token } = getRedisCredentials();
    const request = await redisGet(url, token, FORECAST_REFRESH_REQUEST_KEY);
    return request && typeof request === 'object' ? request : null;
  } catch (err) {
    console.warn(`  [Trigger] Refresh request read failed: ${err.message}`);
    return null;
  }
}

async function clearForecastRefreshRequest() {
  try {
    const { url, token } = getRedisCredentials();
    await redisDel(url, token, FORECAST_REFRESH_REQUEST_KEY);
  } catch (err) {
    console.warn(`  [Trigger] Refresh request clear failed: ${err.message}`);
  }
}

function sameForecastRefreshRequest(left, right) {
  if (!left || !right) return false;
  return (left.requestedAt || 0) === (right.requestedAt || 0)
    && (left.requester || '') === (right.requester || '')
    && (left.requesterRunId || '') === (right.requesterRunId || '')
    && (left.sourceVersion || '') === (right.sourceVersion || '');
}

async function clearForecastRefreshRequestIfUnchanged(consumedRequest) {
  if (!consumedRequest) return;
  try {
    const current = await readForecastRefreshRequest();
    if (!sameForecastRefreshRequest(current, consumedRequest)) {
      console.log('  [Trigger] Leaving newer refresh request queued');
      return;
    }
    await clearForecastRefreshRequest();
  } catch (err) {
    console.warn(`  [Trigger] Conditional refresh request clear failed: ${err.message}`);
  }
}

function buildForecastTriggerContext(request = null) {
  const triggerSource = request?.requestedBy || 'forecast_cron';
  return {
    triggerSource,
    triggerRequest: request
      ? {
          requestedAt: request.requestedAt || 0,
          requestedAtIso: request.requestedAtIso || '',
          requester: request.requester || '',
          requesterRunId: request.requesterRunId || '',
          sourceVersion: request.sourceVersion || '',
        }
      : null,
    triggerService: 'seed-forecasts',
    deployRevision: getDeployRevision(),
  };
}

if (_isDirectRun) {
  const refreshRequest = await readForecastRefreshRequest();
  const triggerContext = buildForecastTriggerContext(refreshRequest);
  console.log(`  [Trigger] source=${triggerContext.triggerSource}${triggerContext.triggerRequest?.requester ? ` requester=${triggerContext.triggerRequest.requester}` : ''}`);

  await runSeed('forecast', 'predictions', CANONICAL_KEY, async () => {
    const data = await fetchForecasts();
    return {
      ...data,
      triggerContext,
    };
  }, {
    ttlSeconds: TTL_SECONDS,
    lockTtlMs: 180_000,
    validateFn: (data) => Array.isArray(data?.predictions) && data.predictions.length > 0,
    publishTransform: buildPublishedSeedPayload,
    afterPublish: async (data, meta) => {
      if (triggerContext.triggerRequest) {
        await clearForecastRefreshRequestIfUnchanged(triggerContext.triggerRequest);
      }
      try {
        const snapshot = await appendHistorySnapshot(data);
        console.log(`  History appended: ${snapshot.predictions.length} forecasts -> ${HISTORY_KEY}`);
      } catch (err) {
        console.warn(`  [History] Append failed: ${err.message}`);
      }

      try {
        console.log('  [Trace] Starting R2 export...');
        const pointer = await writeForecastTraceArtifacts(data, { runId: meta?.runId || `${Date.now()}` });
        if (pointer) {
          console.log(`  [Trace] Written: ${pointer.summaryKey} (${pointer.tracedForecastCount} forecasts)`);
        } else {
          console.log('  [Trace] Skipped: R2 storage not configured');
        }
      } catch (err) {
        console.warn(`  [Trace] Export failed: ${err.message}`);
        if (err.stack) console.warn(`  [Trace] Stack: ${err.stack.split('\n').slice(0, 3).join(' | ')}`);
      }
    },
    extraKeys: [
      {
        key: PRIOR_KEY,
        transform: (data) => ({
          predictions: data.predictions.map(buildPriorForecastSnapshot),
        }),
        ttl: 7200,
      },
    ],
  });
}

export {
  CANONICAL_KEY,
  PRIOR_KEY,
  HISTORY_KEY,
  HISTORY_MAX_RUNS,
  HISTORY_MAX_FORECASTS,
  TRACE_LATEST_KEY,
  TRACE_RUNS_KEY,
  forecastId,
  normalize,
  makePrediction,
  normalizeCiiEntry,
  extractCiiScores,
  resolveCascades,
  calibrateWithMarkets,
  computeTrends,
  detectConflictScenarios,
  detectMarketScenarios,
  detectSupplyChainScenarios,
  detectPoliticalScenarios,
  detectMilitaryScenarios,
  detectInfraScenarios,
  attachNewsContext,
  computeConfidence,
  sanitizeForPrompt,
  parseLLMScenarios,
  validateScenarios,
  validatePerspectives,
  validateCaseNarratives,
  computeProjections,
  computeHeadlineRelevance,
  computeMarketMatchScore,
  buildUserPrompt,
  buildForecastCase,
  buildForecastCases,
  buildPriorForecastSnapshot,
  buildHistoryForecastEntry,
  buildHistorySnapshot,
  appendHistorySnapshot,
  buildPublishedForecastPayload,
  buildPublishedSeedPayload,
  getTraceMaxForecasts,
  buildTraceRunPrefix,
  buildForecastTraceRecord,
  buildForecastTraceArtifacts,
  writeForecastTraceArtifacts,
  buildChangeItems,
  buildChangeSummary,
  annotateForecastChanges,
  buildCounterEvidence,
  buildCaseTriggers,
  buildForecastActors,
  buildForecastWorldState,
  buildForecastRunWorldState,
  buildForecastBranches,
  buildActorLenses,
  scoreForecastReadiness,
  computeAnalysisPriority,
  rankForecastsForAnalysis,
  selectPublishedForecastPool,
  buildPublishedForecastArtifacts,
  filterPublishedForecasts,
  applySituationFamilyCaps,
  summarizePublishFiltering,
  selectForecastsForEnrichment,
  parseForecastProviderOrder,
  getForecastLlmCallOptions,
  resolveForecastLlmProviders,
  buildFallbackScenario,
  buildFallbackBaseCase,
  buildFallbackEscalatoryCase,
  buildFallbackContrarianCase,
  buildFeedSummary,
  buildFallbackPerspectives,
  populateFallbackNarratives,
  buildCrossSituationEffects,
  buildSimulationMarketConsequences,
  buildReportableInteractionLedger,
  buildInteractionWatchlist,
  isCrossTheaterPair,
  getMacroRegion,
  attachSituationContext,
  projectSituationClusters,
  refreshPublishedNarratives,
  loadCascadeRules,
  evaluateRuleConditions,
  SIGNAL_TO_SOURCE,
  PREDICATE_EVALUATORS,
  DEFAULT_CASCADE_RULES,
  PROJECTION_CURVES,
  normalizeChokepoints,
  normalizeGpsJamming,
  deriveStateDrivenForecasts,
  detectUcdpConflictZones,
  detectCyberScenarios,
  detectGpsJammingScenarios,
  detectFromPredictionMarkets,
  getFreshMilitaryForecastInputs,
  loadEntityGraph,
  discoverGraphCascades,
  MARITIME_REGIONS,
  MARKET_TAG_TO_REGION,
  resolveCountryName,
  loadCountryCodes,
  getSearchTermsForRegion,
  extractAllHeadlines,
  extractNewsClusterItems,
  selectUrgentCriticalNewsCandidates,
  validateCriticalSignalFrames,
  mapCriticalSignalFrameToSignals,
  extractCriticalSignalBundle,
  extractCriticalNewsSignals,
};
