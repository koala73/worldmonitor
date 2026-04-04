import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  ClimateServiceClient,
  type ClimateAnomaly as ProtoClimateAnomaly,
  type Co2DataPoint as ProtoCo2DataPoint,
  type Co2Monitoring as ProtoCo2Monitoring,
  type AnomalySeverity as ProtoAnomalySeverity,
  type AnomalyType as ProtoAnomalyType,
  type GetCo2MonitoringResponse,
  type GetOceanIceDataResponse,
  type ListClimateAnomaliesResponse,
} from '@/generated/client/worldmonitor/climate/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import {
  normalizeHydratedOceanIce,
  toDisplayOceanIceData,
  type OceanIceIndicators,
  type OceanIceSeedSnakeShape,
} from './ocean-ice';

// Re-export consumer-friendly type matching legacy shape exactly.
// Consumers import this type from '@/services/climate' and see the same
// lat/lon/severity/type fields they always used. The proto -> legacy
// mapping happens internally in toDisplayAnomaly().
export interface ClimateAnomaly {
  /**
   * A named geographic region or label where the anomaly is occurring
   * (e.g., "Northern Europe", "Southeast Asia").
   */
  zone: string;
  lat: number;
  lon: number;
  /**
   * The temperature deviation from the historical average, measured in degrees Celsius (°C).
   */
  tempDelta: number;
  /**
   * The precipitation deviation from the historical average, measured in millimeters.
   */
  precipDelta: number;
  severity: 'normal' | 'moderate' | 'extreme';
  type: 'warm' | 'cold' | 'wet' | 'dry' | 'mixed';
  period: string;
}

export interface ClimateFetchResult {
  ok: boolean;
  anomalies: ClimateAnomaly[];
}

export interface Co2DataPoint {
  month: string;
  ppm: number;
  // Year-over-year delta vs the same calendar month, in ppm.
  anomaly: number;
}

export interface Co2Monitoring {
  currentPpm: number;
  yearAgoPpm: number;
  annualGrowthRate: number;
  preIndustrialBaseline: number;
  monthlyAverage: number;
  trend12m: Co2DataPoint[];
  methanePpb: number;
  nitrousOxidePpb: number;
  measuredAt?: Date;
  station: string;
}

export type { OceanIceIndicators, OceanIceTrendPoint } from './ocean-ice';

const client = new ClimateServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListClimateAnomaliesResponse>({ name: 'Climate Anomalies', cacheTtlMs: 20 * 60 * 1000, persistCache: true });
const co2Breaker = createCircuitBreaker<GetCo2MonitoringResponse>({ name: 'CO2 Monitoring', cacheTtlMs: 6 * 60 * 60 * 1000, persistCache: true });
const oceanIceBreaker = createCircuitBreaker<GetOceanIceDataResponse>({ name: 'Ocean Ice', cacheTtlMs: 26 * 60 * 60 * 1000, persistCache: true });

const emptyClimateFallback: ListClimateAnomaliesResponse = { anomalies: [] };
const emptyCo2Fallback: GetCo2MonitoringResponse = {};
const emptyOceanIceFallback: GetOceanIceDataResponse = {};

export async function fetchClimateAnomalies(): Promise<ClimateFetchResult> {
  const hydrated = getHydratedData('climateAnomalies') as ListClimateAnomaliesResponse | undefined;
  if (hydrated && (hydrated.anomalies ?? []).length > 0) {
    const anomalies = hydrated.anomalies.map(toDisplayAnomaly).filter(a => a.severity !== 'normal');
    if (anomalies.length > 0) return { ok: true, anomalies };
  }

  const response = await breaker.execute(async () => {
    return client.listClimateAnomalies({ minSeverity: 'ANOMALY_SEVERITY_UNSPECIFIED', pageSize: 0, cursor: '' });
  }, emptyClimateFallback, { shouldCache: (r) => r.anomalies.length > 0 });
  const anomalies = (response.anomalies ?? [])
    .map(toDisplayAnomaly)
    .filter(a => a.severity !== 'normal');
  return { ok: true, anomalies };
}

export async function fetchCo2Monitoring(): Promise<Co2Monitoring | null> {
  const hydrated = getHydratedData('co2Monitoring') as GetCo2MonitoringResponse | undefined;
  if (hydrated?.monitoring) {
    return toDisplayCo2Monitoring(hydrated.monitoring);
  }

  const response = await co2Breaker.execute(async () => {
    return client.getCo2Monitoring({});
  }, emptyCo2Fallback, { shouldCache: (result) => Boolean(result.monitoring?.currentPpm) });

  return response.monitoring ? toDisplayCo2Monitoring(response.monitoring) : null;
}

export async function fetchOceanIceData(): Promise<OceanIceIndicators | null> {
  const hydrated = getHydratedData('oceanIce') as GetOceanIceDataResponse | OceanIceSeedSnakeShape | undefined;
  const hydratedProto = normalizeHydratedOceanIce(hydrated);
  if (hydratedProto) {
    return toDisplayOceanIceData(hydratedProto);
  }

  const response = await oceanIceBreaker.execute(async () => {
    return client.getOceanIceData({});
  }, emptyOceanIceFallback, { shouldCache: (result) => Boolean(result.data) });

  return response.data ? toDisplayOceanIceData(response.data) : null;
}

// Presentation helpers (used by ClimateAnomalyPanel)
export function getSeverityIcon(anomaly: ClimateAnomaly): string {
  switch (anomaly.type) {
    case 'warm': return '\u{1F321}\u{FE0F}';   // thermometer
    case 'cold': return '\u{2744}\u{FE0F}';     // snowflake
    case 'wet': return '\u{1F327}\u{FE0F}';     // rain
    case 'dry': return '\u{2600}\u{FE0F}';      // sun
    case 'mixed': return '\u{26A1}';             // lightning
    default: return '\u{1F321}\u{FE0F}';         // thermometer
  }
}

export function formatDelta(value: number, unit: string): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}${unit}`;
}

// Internal: Map proto ClimateAnomaly -> consumer-friendly shape
function toDisplayAnomaly(proto: ProtoClimateAnomaly): ClimateAnomaly {
  return {
    zone: proto.zone,
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    tempDelta: proto.tempDelta,
    precipDelta: proto.precipDelta,
    severity: mapSeverity(proto.severity),
    type: mapType(proto.type),
    period: proto.period,
  };
}

function toDisplayCo2Monitoring(proto: ProtoCo2Monitoring): Co2Monitoring {
  const measuredAt = Number(proto.measuredAt);
  return {
    currentPpm: proto.currentPpm,
    yearAgoPpm: proto.yearAgoPpm,
    annualGrowthRate: proto.annualGrowthRate,
    preIndustrialBaseline: proto.preIndustrialBaseline,
    monthlyAverage: proto.monthlyAverage,
    trend12m: (proto.trend12m ?? []).map(toDisplayCo2Point),
    methanePpb: proto.methanePpb,
    nitrousOxidePpb: proto.nitrousOxidePpb,
    measuredAt: Number.isFinite(measuredAt) && measuredAt > 0 ? new Date(measuredAt) : undefined,
    station: proto.station,
  };
}

function toDisplayCo2Point(proto: ProtoCo2DataPoint): Co2DataPoint {
  return {
    month: proto.month,
    ppm: proto.ppm,
    anomaly: proto.anomaly,
  };
}

function mapSeverity(s: ProtoAnomalySeverity): ClimateAnomaly['severity'] {
  switch (s) {
    case 'ANOMALY_SEVERITY_EXTREME': return 'extreme';
    case 'ANOMALY_SEVERITY_MODERATE': return 'moderate';
    default: return 'normal';
  }
}

function mapType(t: ProtoAnomalyType): ClimateAnomaly['type'] {
  switch (t) {
    case 'ANOMALY_TYPE_WARM': return 'warm';
    case 'ANOMALY_TYPE_COLD': return 'cold';
    case 'ANOMALY_TYPE_WET': return 'wet';
    case 'ANOMALY_TYPE_DRY': return 'dry';
    case 'ANOMALY_TYPE_MIXED': return 'mixed';
    default: return 'warm';
  }
}
