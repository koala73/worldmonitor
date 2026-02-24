import {
  WildfireServiceClient,
  type FireDetection,
  type FireConfidence,
  type ListFireDetectionsResponse,
} from '@/generated/client/worldmonitor/wildfire/v1/service_client';
import { createCircuitBreaker } from '@/utils';

export type { FireDetection };

// -- Types --

export interface FireRegionStats {
  region: string;
  fires: FireDetection[];
  fireCount: number;
  totalFrp: number;
  highIntensityCount: number;
}

export interface FetchResult {
  regions: Record<string, FireDetection[]>;
  totalCount: number;
  skipped?: boolean;
  reason?: string;
}

export interface MapFire {
  lat: number;
  lon: number;
  brightness: number;
  frp: number;
  confidence: number;
  region: string;
  acq_date: string;
  daynight: string;
}

// -- Client --

const client = new WildfireServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListFireDetectionsResponse>({ name: 'Wildfires' });

const emptyFallback: ListFireDetectionsResponse = { fireDetections: [] };

// -- Public API --

export async function fetchAllFires(_days?: number): Promise<FetchResult> {
  const response = await breaker.execute(async () => {
    return client.listFireDetections({});
  }, emptyFallback);
  const detections = response.fireDetections;

  if (detections.length === 0) {
    return { regions: {}, totalCount: 0, skipped: true, reason: 'NASA_FIRMS_API_KEY not configured' };
  }

  const regions: Record<string, FireDetection[]> = {};
  for (const d of detections) {
    const r = d.region || 'Unknown';
    (regions[r] ??= []).push(d);
  }

  return { regions, totalCount: detections.length };
}

export function computeRegionStats(regions: Record<string, FireDetection[]>): FireRegionStats[] {
  const stats: FireRegionStats[] = [];

  for (const [region, fires] of Object.entries(regions)) {
    const highIntensity = fires.filter(
      f => f.brightness > 360 && f.confidence === 'FIRE_CONFIDENCE_HIGH',
    );
    stats.push({
      region,
      fires,
      fireCount: fires.length,
      totalFrp: fires.reduce((sum, f) => sum + (f.frp || 0), 0),
      highIntensityCount: highIntensity.length,
    });
  }

  return stats.sort((a, b) => b.fireCount - a.fireCount);
}

export function flattenFires(regions: Record<string, FireDetection[]>): FireDetection[] {
  const all: FireDetection[] = [];
  for (const fires of Object.values(regions)) {
    for (const f of fires) {
      all.push(f);
    }
  }
  return all;
}

export function toMapFires(fires: FireDetection[]): MapFire[] {
  return fires.map(f => ({
    lat: f.location?.latitude ?? 0,
    lon: f.location?.longitude ?? 0,
    brightness: f.brightness,
    frp: f.frp,
    confidence: confidenceToNumber(f.confidence),
    region: f.region,
    acq_date: new Date(f.detectedAt).toISOString().slice(0, 10),
    daynight: f.dayNight,
  }));
}

function confidenceToNumber(c: FireConfidence): number {
  switch (c) {
    case 'FIRE_CONFIDENCE_HIGH': return 95;
    case 'FIRE_CONFIDENCE_NOMINAL': return 50;
    case 'FIRE_CONFIDENCE_LOW': return 20;
    default: return 0;
  }
}
