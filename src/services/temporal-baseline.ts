import type { TemporalAnomaly as TemporalAnomalyProto } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { getHydratedData } from '@/services/bootstrap';
import { InfrastructureServiceClient } from '@/services/generated-rpc-clients';
import { getAnomalySeverity } from '../../shared/analysis-temporal-severity';

export type TemporalEventType =
  | 'military_flights'
  | 'vessels'
  | 'protests'
  | 'news'
  | 'ais_gaps'
  | 'satellite_fires';

export interface TemporalAnomaly {
  type: TemporalEventType;
  region: string;
  currentCount: number;
  expectedCount: number;
  zScore: number;
  message: string;
  severity: 'medium' | 'high' | 'critical';
}

const client = new InfrastructureServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

const getSeverity = getAnomalySeverity;

function mapServerAnomaly(a: TemporalAnomalyProto): TemporalAnomaly {
  return {
    type: a.type as TemporalEventType,
    region: a.region,
    currentCount: a.currentCount,
    expectedCount: a.expectedCount,
    zScore: a.zScore,
    severity: getSeverity(a.zScore),
    message: a.message,
  };
}

export function consumeServerAnomalies(): { anomalies: TemporalAnomaly[]; trackedTypes: string[] } {
  const raw = getHydratedData('temporalAnomalies') as {
    anomalies?: TemporalAnomalyProto[];
    trackedTypes?: string[];
    computedAt?: string;
  } | undefined;

  if (!raw?.anomalies) return { anomalies: [], trackedTypes: [] };
  return {
    anomalies: raw.anomalies.map(mapServerAnomaly),
    trackedTypes: raw.trackedTypes ?? [],
  };
}

export async function fetchLiveAnomalies(): Promise<{ anomalies: TemporalAnomaly[]; trackedTypes: string[] }> {
  try {
    const resp = await client.listTemporalAnomalies({});
    return {
      anomalies: (resp.anomalies ?? []).map(mapServerAnomaly),
      trackedTypes: resp.trackedTypes ?? [],
    };
  } catch (e) {
    console.warn('[TemporalBaseline] Live fetch failed:', e);
    return { anomalies: [], trackedTypes: [] };
  }
}
