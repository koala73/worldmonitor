/**
 * OpenSens DAMD — TypeScript data models
 * All assumptions are explicit and editable via the Settings panel.
 */

// ---------------------------------------------------------------------------
// Node Templates
// ---------------------------------------------------------------------------

export type NodeTier = 'standard' | 'pro' | 'premium';

export interface ComputeMetrics {
  /** CPU cores (total across cluster) */
  cpuCores: number;
  /** RAM in GB (total across cluster) */
  ramGb: number;
  /** GPU / accelerator TFLOPS (FP16) — 0 for CPU-only */
  gpuTflops: number;
  /** Storage in TB */
  storageTb: number;
  /** Inference throughput proxy (tokens/sec for a 7B model, 4-bit quant) */
  tokensPerSec7b: number;
}

export interface CapexRange {
  /** Lower bound USD */
  low: number;
  /** Upper bound USD */
  high: number;
  /** Currency (default USD) */
  currency: string;
}

export interface NodeTemplate {
  /** Unique machine-readable identifier */
  id: string;
  /** Human-readable display name */
  name: string;
  tier: NodeTier;
  /** Typical node count in this cluster template */
  nodeCount: { min: number; max: number; default: number };
  /** Power in watts */
  idle_w: number;
  typical_w: number;
  peak_w: number;
  /** Power Use Effectiveness multiplier (default 1.25 for small enclosure) */
  pue: number;
  compute: ComputeMetrics;
  /** Hardware acquisition cost */
  capex: CapexRange;
  /** Explicit human-readable assumptions */
  notes: string[];
  /** Last updated ISO timestamp */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Candidate Site
// ---------------------------------------------------------------------------

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface RangeEstimate {
  p10: number;
  p50: number;
  p90: number;
  unit: string;
  confidence: ConfidenceLevel;
  source: string;
  lastUpdatedAt: string;
}

export interface PvEstimate {
  /** kWh/day per kWp installed (annual average) */
  kwhPerDayPerKwp: RangeEstimate;
  /** User-selected / default PV system size in kWp */
  systemKwp: number;
  /** Tilt angle degrees from horizontal */
  tiltDeg: number;
  /** Azimuth (0=N, 90=E, 180=S, 270=W) */
  azimuthDeg: number;
  /** Estimated shading factor 0–1 (1 = no shading) */
  shadingFactor: number;
}

export interface WindEstimate {
  /** Probability that wind contributes meaningfully (>50 W average) */
  viabilityScore: number;
  /** Estimated average power output in watts */
  avgOutputW: RangeEstimate;
  /** Hub-height wind speed used m/s */
  windSpeedMps: number;
  /** Urban derating factor applied (typically 0.5–0.7) */
  urbanDerate: number;
  /** Pre-screening only — not a site-specific measurement */
  disclaimer: string;
}

export interface AirQualityEstimate {
  /** AQI (US EPA standard) */
  aqi: number;
  /** PM2.5 µg/m³ */
  pm25: number;
  /** Soiling risk proxy (panel degradation) 0–1 */
  soilingRisk: number;
  trend: 'improving' | 'stable' | 'worsening';
  source: string;
  lastUpdatedAt: string;
}

export interface ConnectivityOption {
  provider: 'starlink' | 'local-isp' | 'custom';
  label: string;
  /** Monthly cost USD */
  monthlyCostUsd: number;
  /** Average download Mbps */
  downloadMbps: number;
  /** Average latency ms */
  latencyMs: number;
  /** Power overhead in watts (Starlink dish ~75–100 W) */
  powerOverheadW: number;
  /** Reliability estimate 0–1 */
  reliability: number;
  notes: string[];
}

export interface DemandProxies {
  /** People per km² */
  populationDensity: number;
  /** 0–1 normalized nighttime light intensity (VIIRS) */
  nighttimeLightIndex: number;
  /** Estimated businesses per km² (OSM proxy) */
  businessDensityProxy: number;
  /** Composite demand score 0–100 */
  demandScore: number;
  notes: string[];
}

export interface FiberRoute {
  /** Distance in meters (road-network routing result) */
  routeDistanceM: number;
  /** Straight-line fallback distance meters */
  haversineM: number;
  /** Slack factor applied (default 1.1) */
  slackFactor: number;
  /** Estimated fiber length meters = routeDistanceM * slackFactor */
  estimatedFiberM: number;
  /** Cost per meter USD (user-editable) */
  costPerMeterUsd: number;
  /** Total estimated fiber capex USD */
  fiberCapexUsd: number;
  /** Routing source used */
  routingSource: 'osrm' | 'graphhopper' | 'haversine-fallback';
}

export interface BessAutonomy {
  /** Total BESS capacity kWh */
  totalKwh: number;
  /** Li-ion share kWh */
  liIonKwh: number;
  /** Flow battery share kWh */
  flowKwh: number;
  /** IT load in watts (from selected NodeTemplate) */
  itLoadW: number;
  /** Effective load with PUE */
  effectiveLoadW: number;
  /** Autonomy at 100% SoC in hours */
  autonomyHours: number;
  /** Autonomy at 80% DoD limit in hours */
  autonomyDodHours: number;
  /** Throttle recommendation if solar insufficient */
  throttleSchedule: ThrottleSchedule[];
}

export interface ThrottleSchedule {
  /** Hour 0–23 UTC */
  hourUtc: number;
  /** Fraction of peak load to run 0–1 */
  loadFraction: number;
  reason: string;
}

export interface RoiScenario {
  label: 'conservative' | 'moderate' | 'aggressive';
  /** Annual revenue USD */
  annualRevenueUsd: number;
  /** Annual opex USD */
  annualOpexUsd: number;
  /** Total capex USD */
  totalCapexUsd: number;
  /** Simple payback period in years */
  paybackYears: number;
  /** 5-year NPV at 10% discount rate */
  npv5y: number;
  /** IRR estimate (null if negative) */
  irr: number | null;
  /** Confidence score 0–1 */
  confidence: number;
  /** Missing data flags */
  dataCompletenessFlags: string[];
  assumptions: Record<string, number | string | boolean>;
}

export interface CandidateSite {
  id: string;
  lat: number;
  lon: number;
  /** Country ISO-2 */
  countryCode: string;
  /** Optional place name */
  placeName?: string;
  /** Estimated rooftop area m² (from building footprint proxy or user input) */
  roofAreaM2?: number;
  /** PV system size range in kWp that fits on the roof */
  pvKwpRange: { min: number; max: number };
  /** Whether small-wind installation is structurally feasible (pre-screen only) */
  windPossible: boolean;
  pv?: PvEstimate;
  wind?: WindEstimate;
  air?: AirQualityEstimate;
  connectivity?: ConnectivityOption[];
  demand?: DemandProxies;
  fiber?: FiberRoute;
  bess?: BessAutonomy;
  roi?: RoiScenario[];
  /** Overall suitability score 0–100 */
  siteScore: number;
  /** Rank within search radius (1 = best) */
  rank?: number;
  /** ISO timestamp of last full data refresh */
  lastRefreshedAt: string;
}

// ---------------------------------------------------------------------------
// OSINT Connector Framework
// ---------------------------------------------------------------------------

export type SourceTier = 'official-api' | 'public-feed' | 'gated-opt-in';

export interface ConnectorRateLimit {
  /** Requests per window */
  requests: number;
  /** Window in seconds */
  windowSec: number;
}

export interface OsintSignal {
  /** Connector that produced this signal */
  connectorId: string;
  /** Geographic bounding box [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  /** ISO-2 country code(s) this signal covers */
  countries: string[];
  /** Count of underlying posts/events */
  eventCount: number;
  /** Keyword trend bins */
  keywordCounts: Record<string, number>;
  /** Sentiment distribution */
  sentiment: { positive: number; neutral: number; negative: number };
  /** Signal timestamp (bucket start) */
  bucketStartIso: string;
  /** Source credibility score 0–1 */
  credibility: number;
}

export interface OsintConnector {
  id: string;
  name: string;
  sourceTier: SourceTier;
  /** Requires explicit user opt-in and API key */
  requiresOptIn: boolean;
  rateLimit: ConnectorRateLimit;
  /** ISO timestamp of next allowed fetch */
  nextAllowedAt?: string;
}

// ---------------------------------------------------------------------------
// API Response envelopes
// ---------------------------------------------------------------------------

export interface ApiMeta {
  source: string;
  cachedAt: string;
  ttlSeconds: number;
  confidence: ConfidenceLevel;
  warnings: string[];
}

export interface WeatherResponse {
  meta: ApiMeta;
  lat: number;
  lon: number;
  timezone: string;
  hourly: {
    time: string[];
    temperature_2m: number[];
    relative_humidity_2m: number[];
    wind_speed_10m: number[];
    global_tilted_irradiance: number[];
    direct_normal_irradiance: number[];
    diffuse_radiation: number[];
    precipitation: number[];
    cloud_cover: number[];
  };
  daily_summary: {
    date: string;
    temp_avg: number;
    humidity_avg: number;
    wind_avg_mps: number;
    ghi_kwh: number;
    ghi_p10: number;
    ghi_p90: number;
  }[];
}

export interface PvResponse {
  meta: ApiMeta;
  lat: number;
  lon: number;
  /** Coarse bucket key for cache hit identification */
  bucketKey: string;
  systemKwp: number;
  tiltDeg: number;
  azimuthDeg: number;
  /** Annual average kWh/day for the full system */
  kwhPerDay: { p10: number; p50: number; p90: number };
  /** Monthly breakdown kWh/month */
  monthly: { month: number; kwhEstimate: number }[];
  /** Performance ratio assumed */
  performanceRatio: number;
  assumptions: Record<string, number | string>;
}

export interface WindResponse {
  meta: ApiMeta;
  lat: number;
  lon: number;
  windSpeedMps: number;
  hubHeightM: number;
  roughnessLength: number;
  urbanDerate: number;
  viabilityScore: number;
  avgOutputW: { p10: number; p50: number; p90: number };
  disclaimer: string;
}

export interface AirResponse {
  meta: ApiMeta;
  lat: number;
  lon: number;
  aqi: number;
  pm25: number;
  pm10: number;
  no2: number;
  soilingRiskProxy: number;
  trend: 'improving' | 'stable' | 'worsening';
}

export interface ConnectivityResponse {
  meta: ApiMeta;
  lat: number;
  lon: number;
  countryCode: string;
  options: ConnectivityOption[];
  recommendation: {
    provider: string;
    reason: string;
    objective: 'cost' | 'latency' | 'reliability';
  };
}

export interface RoutingResponse {
  meta: ApiMeta;
  hubLat: number;
  hubLon: number;
  sites: Array<{
    siteId: string;
    lat: number;
    lon: number;
    routeDistanceM: number;
    slackFactor: number;
    estimatedFiberM: number;
    fiberCapexUsd: number;
    routingSource: 'osrm' | 'graphhopper' | 'haversine-fallback';
    rank: number;
  }>;
}

export interface RoiResponse {
  meta: ApiMeta;
  siteId: string;
  templateId: string;
  scenarios: RoiScenario[];
  /** Overall data completeness 0–1 */
  completeness: number;
}
