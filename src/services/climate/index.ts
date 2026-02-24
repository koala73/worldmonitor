import {
  ClimateServiceClient,
  type ClimateAnomaly as ProtoClimateAnomaly,
  type AnomalySeverity as ProtoAnomalySeverity,
  type AnomalyType as ProtoAnomalyType,
  type ListClimateAnomaliesResponse,
} from '@/generated/client/worldmonitor/climate/v1/service_client';
import { createCircuitBreaker } from '@/utils';

// Re-export consumer-friendly type matching legacy shape exactly.
// Consumers import this type from '@/services/climate' and see the same
// lat/lon/severity/type fields they always used. The proto -> legacy
// mapping happens internally in toDisplayAnomaly().
export interface ClimateAnomaly {
  zone: string;
  lat: number;
  lon: number;
  tempDelta: number;
  precipDelta: number;
  severity: 'normal' | 'moderate' | 'extreme';
  type: 'warm' | 'cold' | 'wet' | 'dry' | 'mixed';
  period: string;
}

export interface ClimateFetchResult {
  ok: boolean;
  anomalies: ClimateAnomaly[];
}

const client = new ClimateServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListClimateAnomaliesResponse>({ name: 'Climate Anomalies' });

const emptyClimateFallback: ListClimateAnomaliesResponse = { anomalies: [] };

export async function fetchClimateAnomalies(): Promise<ClimateFetchResult> {
  const response = await breaker.execute(async () => {
    return client.listClimateAnomalies({ minSeverity: 'ANOMALY_SEVERITY_UNSPECIFIED' });
  }, emptyClimateFallback);
  const anomalies = (response.anomalies ?? [])
    .map(toDisplayAnomaly)
    .filter(a => a.severity !== 'normal');
  return { ok: true, anomalies };
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
