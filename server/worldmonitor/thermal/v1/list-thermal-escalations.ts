import type {
  ListThermalEscalationsRequest,
  ListThermalEscalationsResponse,
  ThermalServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/thermal/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'thermal:escalation:v1';
const DEFAULT_MAX_ITEMS = 12;
const MAX_ITEMS_LIMIT = 25;

async function readSeededThermalWatch(): Promise<ListThermalEscalationsResponse | null> {
  try {
    return await getCachedJson(REDIS_CACHE_KEY, true) as ListThermalEscalationsResponse | null;
  } catch {
    return null;
  }
}

function clampMaxItems(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_ITEMS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_ITEMS_LIMIT);
}

const emptyResponse: ListThermalEscalationsResponse = {
  fetchedAt: '',
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

export const listThermalEscalations: ThermalServiceHandler['listThermalEscalations'] = async (
  _ctx: ServerContext,
  req: ListThermalEscalationsRequest,
): Promise<ListThermalEscalationsResponse> => {
  const seeded = await readSeededThermalWatch();
  if (!seeded) return emptyResponse;

  const maxItems = clampMaxItems(req.maxItems ?? 0);
  const sliced = (seeded.clusters ?? []).slice(0, maxItems);

  const summary = {
    clusterCount: sliced.length,
    elevatedCount: sliced.filter(c => c.status === 'THERMAL_STATUS_ELEVATED').length,
    spikeCount: sliced.filter(c => c.status === 'THERMAL_STATUS_SPIKE').length,
    persistentCount: sliced.filter(c => c.status === 'THERMAL_STATUS_PERSISTENT').length,
    conflictAdjacentCount: sliced.filter(c => c.context === 'THERMAL_CONTEXT_CONFLICT_ADJACENT').length,
    highRelevanceCount: sliced.filter(c => c.strategicRelevance === 'THERMAL_RELEVANCE_HIGH').length,
  };

  return {
    ...seeded,
    clusters: sliced,
    summary,
  };
};
