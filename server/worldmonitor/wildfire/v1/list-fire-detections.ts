/**
 * ListFireDetections RPC -- reads seeded wildfire data from Railway seed cache.
 * All external NASA FIRMS API calls happen in seed-wildfires.mjs on Railway.
 */

import type {
  WildfireServiceHandler,
  ServerContext,
  ListFireDetectionsRequest,
  ListFireDetectionsResponse,
} from '../../../../src/generated/server/worldmonitor/wildfire/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'wildfire:fires:v1';
const SEED_META_KEY = 'seed-meta:wildfire:fires';
export const WILDFIRE_DASHBOARD_DETECTION_LIMIT = 500;

interface SeedMeta {
  fetchedAt?: number;
}

type FireDetection = ListFireDetectionsResponse['fireDetections'][number];

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function confidenceRank(confidence: FireDetection['confidence']): number {
  switch (confidence) {
    case 'FIRE_CONFIDENCE_HIGH': return 3;
    case 'FIRE_CONFIDENCE_NOMINAL': return 2;
    case 'FIRE_CONFIDENCE_LOW': return 1;
    default: return 0;
  }
}

function compareFireDetectionsForDashboard(a: FireDetection, b: FireDetection): number {
  return Number(Boolean(b.possibleExplosion)) - Number(Boolean(a.possibleExplosion))
    || confidenceRank(b.confidence) - confidenceRank(a.confidence)
    || numeric(b.brightness) - numeric(a.brightness)
    || numeric(b.frp) - numeric(a.frp)
    || numeric(b.detectedAt) - numeric(a.detectedAt);
}

export function limitFireDetectionsForDashboard(
  detections: FireDetection[],
  limit = WILDFIRE_DASHBOARD_DETECTION_LIMIT,
): FireDetection[] {
  if (detections.length <= limit) return detections;
  return [...detections].sort(compareFireDetectionsForDashboard).slice(0, limit);
}

export const listFireDetections: WildfireServiceHandler['listFireDetections'] = async (
  _ctx: ServerContext,
  _req: ListFireDetectionsRequest,
): Promise<ListFireDetectionsResponse> => {
  try {
    const [result, meta] = await Promise.all([
      getCachedJson(SEED_CACHE_KEY, true) as Promise<Partial<ListFireDetectionsResponse> | null>,
      getCachedJson(SEED_META_KEY, true) as Promise<SeedMeta | null>,
    ]);
    if (!result) return { fireDetections: [], pagination: undefined, fetchedAt: 0, dataAvailable: false };
    const rawDetections = result.fireDetections ?? [];
    const fireDetections = limitFireDetectionsForDashboard(rawDetections);
    const capped = fireDetections.length < rawDetections.length;

    return {
      fireDetections,
      pagination: capped ? { nextCursor: '', totalCount: rawDetections.length } : result.pagination,
      fetchedAt: Number(result.fetchedAt || meta?.fetchedAt || 0),
      dataAvailable: true,
    };
  } catch {
    return { fireDetections: [], pagination: undefined, fetchedAt: 0, dataAvailable: false };
  }
};
