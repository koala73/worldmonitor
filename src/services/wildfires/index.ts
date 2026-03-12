import {
  WildfireServiceClient,
  type FireDetection,
  type FireConfidence,
  type ListFireDetectionsResponse,
} from '@/generated/client/worldmonitor/wildfire/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import { getApiBaseUrl } from '@/services/runtime';

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

// Sidecar fire shape returned by /api/nasa-firms
interface SidecarFire {
  lat: number;
  lon: number;
  brightness: number;
  frp: number;
  confidence: FireConfidence;
  region: string;
  acq_date: string;
  daynight: string;
}

// -- Client (upstream cloud API fallback) --

const client = new WildfireServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListFireDetectionsResponse>({ name: 'Wildfires', cacheTtlMs: 30 * 60 * 1000, persistCache: true });

const emptyFallback: ListFireDetectionsResponse = { fireDetections: [] };

// Simple in-memory cache for the sidecar results (30 min)
let _sidecarCache: { fires: SidecarFire[]; ts: number } | null = null;
const SIDECAR_CACHE_MS = 30 * 60 * 1000;

async function fetchFromSidecar(): Promise<SidecarFire[] | null> {
  if (_sidecarCache && Date.now() - _sidecarCache.ts < SIDECAR_CACHE_MS) {
    return _sidecarCache.fires;
  }
  try {
    const base = getApiBaseUrl();
    const resp = await fetch(`${base}/api/nasa-firms`);
    if (!resp.ok) return null;
    const data = await resp.json() as { fires?: SidecarFire[]; error?: string };
    if (!Array.isArray(data.fires) || data.fires.length === 0) return null;
    _sidecarCache = { fires: data.fires, ts: Date.now() };
    return data.fires;
  } catch {
    return null;
  }
}

function sidecarToDetection(f: SidecarFire): FireDetection {
  return {
    location: { latitude: f.lat, longitude: f.lon },
    brightness: f.brightness,
    frp: f.frp,
    confidence: f.confidence,
    region: f.region,
    detectedAt: f.acq_date ? new Date(f.acq_date).toISOString() : new Date().toISOString(),
    dayNight: f.daynight,
  } as unknown as FireDetection;
}

// -- Public API --

export async function fetchAllFires(_days?: number): Promise<FetchResult> {
  // 1. Try sidecar route (uses stored NASA_FIRMS_API_KEY directly)
  const sidecarFires = await fetchFromSidecar();
  if (sidecarFires && sidecarFires.length > 0) {
    const regions: Record<string, FireDetection[]> = {};
    for (const f of sidecarFires) {
      const r = f.region || 'Unknown';
      (regions[r] ??= []).push(sidecarToDetection(f));
    }
    return { regions, totalCount: sidecarFires.length };
  }

  // 2. Fall back to upstream cloud API
  const hydrated = getHydratedData('wildfires') as ListFireDetectionsResponse | undefined;
  const response = hydrated ?? await breaker.execute(async () => {
    return client.listFireDetections({ start: 0, end: 0, pageSize: 0, cursor: '', neLat: 0, neLon: 0, swLat: 0, swLon: 0 });
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
