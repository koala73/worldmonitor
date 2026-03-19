import { getRpcBaseUrl } from '@/services/rpc-client';
import { getHydratedData } from '@/services/bootstrap';
import { createCircuitBreaker } from '@/utils';
import {
  ThermalServiceClient,
  type ThermalConfidence as ProtoThermalConfidence,
  type ThermalContext as ProtoThermalContext,
  type ThermalEscalationCluster as ProtoThermalEscalationCluster,
  type ThermalStatus as ProtoThermalStatus,
  type ThermalStrategicRelevance as ProtoThermalStrategicRelevance,
} from '@/generated/client/worldmonitor/thermal/v1/service_client';

export type ThermalStatus = 'normal' | 'elevated' | 'spike' | 'persistent';
export type ThermalContext =
  | 'wildland'
  | 'urban_edge'
  | 'industrial'
  | 'energy_adjacent'
  | 'conflict_adjacent'
  | 'logistics_adjacent'
  | 'mixed';
export type ThermalConfidence = 'low' | 'medium' | 'high';
export type ThermalStrategicRelevance = 'low' | 'medium' | 'high';

export interface ThermalEscalationCluster {
  id: string;
  countryCode: string;
  countryName: string;
  regionLabel: string;
  lat: number;
  lon: number;
  observationCount: number;
  uniqueSourceCount: number;
  maxBrightness: number;
  avgBrightness: number;
  maxFrp: number;
  totalFrp: number;
  nightDetectionShare: number;
  baselineExpectedCount: number;
  baselineExpectedFrp: number;
  countDelta: number;
  frpDelta: number;
  zScore: number;
  persistenceHours: number;
  status: ThermalStatus;
  context: ThermalContext;
  confidence: ThermalConfidence;
  strategicRelevance: ThermalStrategicRelevance;
  nearbyAssets: string[];
  narrativeFlags: string[];
  firstDetectedAt: Date;
  lastDetectedAt: Date;
}

export interface ThermalEscalationWatch {
  fetchedAt: Date;
  observationWindowHours: number;
  sourceVersion: string;
  clusters: ThermalEscalationCluster[];
  summary: {
    clusterCount: number;
    elevatedCount: number;
    spikeCount: number;
    persistentCount: number;
    conflictAdjacentCount: number;
    highRelevanceCount: number;
  };
}

const client = new ThermalServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ThermalEscalationWatch>({
  name: 'Thermal Escalation',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});

const emptyResult: ThermalEscalationWatch = {
  fetchedAt: new Date(0),
  observationWindowHours: 24,
  sourceVersion: 'thermal-escalation-v1',
  clusters: [],
  summary: {
    clusterCount: 0,
    elevatedCount: 0,
    spikeCount: 0,
    persistentCount: 0,
    conflictAdjacentCount: 0,
    highRelevanceCount: 0,
  },
};

interface HydratedThermalData {
  fetchedAt?: string;
  observationWindowHours?: number;
  sourceVersion?: string;
  clusters?: ProtoThermalEscalationCluster[];
  summary?: {
    clusterCount?: number;
    elevatedCount?: number;
    spikeCount?: number;
    persistentCount?: number;
    conflictAdjacentCount?: number;
    highRelevanceCount?: number;
  };
}

export async function fetchThermalEscalations(maxItems = 12): Promise<ThermalEscalationWatch> {
  const hydrated = getHydratedData('thermalEscalation') as HydratedThermalData | undefined;
  if (hydrated?.clusters?.length) {
    const sliced = (hydrated.clusters ?? []).slice(0, maxItems).map(toCluster);
    return {
      fetchedAt: hydrated.fetchedAt ? new Date(hydrated.fetchedAt) : new Date(0),
      observationWindowHours: hydrated.observationWindowHours ?? 24,
      sourceVersion: hydrated.sourceVersion || 'thermal-escalation-v1',
      clusters: sliced,
      summary: {
        clusterCount: sliced.length,
        elevatedCount: sliced.filter(c => c.status === 'elevated').length,
        spikeCount: sliced.filter(c => c.status === 'spike').length,
        persistentCount: sliced.filter(c => c.status === 'persistent').length,
        conflictAdjacentCount: sliced.filter(c => c.context === 'conflict_adjacent').length,
        highRelevanceCount: sliced.filter(c => c.strategicRelevance === 'high').length,
      },
    };
  }
  return breaker.execute(async () => {
    const response = await client.listThermalEscalations(
      { maxItems },
      { signal: AbortSignal.timeout(15_000) },
    );
    return {
      fetchedAt: response.fetchedAt ? new Date(response.fetchedAt) : new Date(0),
      observationWindowHours: response.observationWindowHours ?? 24,
      sourceVersion: response.sourceVersion || 'thermal-escalation-v1',
      clusters: (response.clusters ?? []).map(toCluster),
      summary: {
        clusterCount: response.summary?.clusterCount ?? 0,
        elevatedCount: response.summary?.elevatedCount ?? 0,
        spikeCount: response.summary?.spikeCount ?? 0,
        persistentCount: response.summary?.persistentCount ?? 0,
        conflictAdjacentCount: response.summary?.conflictAdjacentCount ?? 0,
        highRelevanceCount: response.summary?.highRelevanceCount ?? 0,
      },
    };
  }, emptyResult);
}

function toCluster(cluster: ProtoThermalEscalationCluster): ThermalEscalationCluster {
  return {
    id: cluster.id,
    countryCode: cluster.countryCode,
    countryName: cluster.countryName,
    regionLabel: cluster.regionLabel,
    lat: cluster.centroid?.latitude ?? 0,
    lon: cluster.centroid?.longitude ?? 0,
    observationCount: cluster.observationCount ?? 0,
    uniqueSourceCount: cluster.uniqueSourceCount ?? 0,
    maxBrightness: cluster.maxBrightness ?? 0,
    avgBrightness: cluster.avgBrightness ?? 0,
    maxFrp: cluster.maxFrp ?? 0,
    totalFrp: cluster.totalFrp ?? 0,
    nightDetectionShare: cluster.nightDetectionShare ?? 0,
    baselineExpectedCount: cluster.baselineExpectedCount ?? 0,
    baselineExpectedFrp: cluster.baselineExpectedFrp ?? 0,
    countDelta: cluster.countDelta ?? 0,
    frpDelta: cluster.frpDelta ?? 0,
    zScore: cluster.zScore ?? 0,
    persistenceHours: cluster.persistenceHours ?? 0,
    status: mapStatus(cluster.status),
    context: mapContext(cluster.context),
    confidence: mapConfidence(cluster.confidence),
    strategicRelevance: mapRelevance(cluster.strategicRelevance),
    nearbyAssets: cluster.nearbyAssets ?? [],
    narrativeFlags: cluster.narrativeFlags ?? [],
    firstDetectedAt: new Date(cluster.firstDetectedAt),
    lastDetectedAt: new Date(cluster.lastDetectedAt),
  };
}

function mapStatus(status: ProtoThermalStatus): ThermalStatus {
  switch (status) {
    case 'THERMAL_STATUS_PERSISTENT':
      return 'persistent';
    case 'THERMAL_STATUS_SPIKE':
      return 'spike';
    case 'THERMAL_STATUS_ELEVATED':
      return 'elevated';
    default:
      return 'normal';
  }
}

function mapContext(context: ProtoThermalContext): ThermalContext {
  switch (context) {
    case 'THERMAL_CONTEXT_URBAN_EDGE':
      return 'urban_edge';
    case 'THERMAL_CONTEXT_INDUSTRIAL':
      return 'industrial';
    case 'THERMAL_CONTEXT_ENERGY_ADJACENT':
      return 'energy_adjacent';
    case 'THERMAL_CONTEXT_CONFLICT_ADJACENT':
      return 'conflict_adjacent';
    case 'THERMAL_CONTEXT_LOGISTICS_ADJACENT':
      return 'logistics_adjacent';
    case 'THERMAL_CONTEXT_MIXED':
      return 'mixed';
    default:
      return 'wildland';
  }
}

function mapConfidence(confidence: ProtoThermalConfidence): ThermalConfidence {
  switch (confidence) {
    case 'THERMAL_CONFIDENCE_HIGH':
      return 'high';
    case 'THERMAL_CONFIDENCE_MEDIUM':
      return 'medium';
    default:
      return 'low';
  }
}

function mapRelevance(relevance: ProtoThermalStrategicRelevance): ThermalStrategicRelevance {
  switch (relevance) {
    case 'THERMAL_RELEVANCE_HIGH':
      return 'high';
    case 'THERMAL_RELEVANCE_MEDIUM':
      return 'medium';
    default:
      return 'low';
  }
}
