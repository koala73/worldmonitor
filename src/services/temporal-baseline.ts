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
let snapshotAvailable = false;
let lastKnownGood: { anomalies: TemporalAnomaly[]; trackedTypes: string[] } | null = null;

export function hasTemporalBaselineSnapshot(): boolean {
  return snapshotAvailable;
}

function isValidComputedAt(computedAt?: string): boolean {
  return Boolean(computedAt && Number.isFinite(Date.parse(computedAt)));
}

function rememberSnapshot(
  anomalies: TemporalAnomaly[],
  trackedTypes: string[],
  computedAt?: string,
): boolean {
  if (!isValidComputedAt(computedAt)) return false;
  snapshotAvailable = true;
  lastKnownGood = { anomalies, trackedTypes };
  return true;
}

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

  if (!raw?.anomalies) {
    if (!isValidComputedAt(raw?.computedAt)) {
      snapshotAvailable = false;
      lastKnownGood = null;
    }
    return { anomalies: [], trackedTypes: raw?.trackedTypes ?? [] };
  }

  const result = {
    anomalies: raw.anomalies.map(mapServerAnomaly),
    trackedTypes: raw.trackedTypes ?? [],
  };
  if (!rememberSnapshot(result.anomalies, result.trackedTypes, raw.computedAt)) {
    snapshotAvailable = false;
    lastKnownGood = null;
  }
  return result;
}

export async function fetchLiveAnomalies(): Promise<{ anomalies: TemporalAnomaly[]; trackedTypes: string[] }> {
  try {
    const resp = await client.listTemporalAnomalies({});
    const result = {
      anomalies: (resp.anomalies ?? []).map(mapServerAnomaly),
      trackedTypes: resp.trackedTypes ?? [],
    };
    if (!rememberSnapshot(result.anomalies, result.trackedTypes, resp.computedAt)) {
      // Soft-miss (empty/invalid computedAt) must not wipe a prior good snapshot.
      // Mirror the catch path: keep lastKnownGood available when present.
      if (lastKnownGood) {
        snapshotAvailable = true;
        return lastKnownGood;
      }
      snapshotAvailable = false;
      return { anomalies: [], trackedTypes: [] };
    }
    return result;
  } catch (e) {
    console.warn('[TemporalBaseline] Live fetch failed:', e);
    if (lastKnownGood) {
      snapshotAvailable = true;
      return lastKnownGood;
    }
    snapshotAvailable = false;
    return { anomalies: [], trackedTypes: [] };
  }
}
