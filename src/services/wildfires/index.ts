import { getRpcBaseUrl } from '@/services/rpc-client';
import type { FireDetection, FireConfidence, ListFireDetectionsResponse } from '@/generated/client/worldmonitor/wildfire/v1/service_client';
import { createCircuitBreaker } from '@/utils/circuit-breaker';
import { getHydratedData } from '@/services/bootstrap';
import { WildfireServiceClient } from '@/services/generated-rpc-clients';
import { resolveFireDetectionTotalCount } from './payload';

export type { FireDetection };
export { resolveFireDetectionTotalCount } from './payload';

// -- Types --

export interface FireRegionStats {
  region: string;
  fires: FireDetection[];
  fireCount: number;
  totalFrp: number;
  highIntensityCount: number;
  possibleExplosionCount: number;
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
  /** Detection time in epoch milliseconds, for the popup of a satellite detection. */
  detected_at?: number;
  satellite?: string;
  /** `firms` for satellite detections; agency-reported fires name their agency. */
  source?: string;
}

// -- Client --

const client = new WildfireServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListFireDetectionsResponse>({ name: 'Wildfires', cacheTtlMs: 30 * 60 * 1000, persistCache: true });

const emptyFallback: ListFireDetectionsResponse = { fireDetections: [], fetchedAt: 0, dataAvailable: false };

const MAX_FIRE_AGE_MS = 6 * 60 * 60 * 1000;

function hasCurrentFireData(response: ListFireDetectionsResponse): boolean {
  const now = Date.now();
  return response.dataAvailable === true
    && Array.isArray(response.fireDetections)
    && response.fireDetections.length > 0
    && Number.isFinite(response.fetchedAt)
    && response.fetchedAt > 0
    && response.fetchedAt <= now
    && now - response.fetchedAt <= MAX_FIRE_AGE_MS;
}

// -- Public API --

export async function fetchAllFires(_days?: number): Promise<FetchResult> {
  const hydrated = getHydratedData('wildfires') as ListFireDetectionsResponse | undefined;
  let response: ListFireDetectionsResponse;
  if (hydrated && hasCurrentFireData(hydrated)) {
    breaker.recordSuccess(hydrated);
    response = hydrated;
  } else {
    response = await breaker.execute(async () => {
      return client.listFireDetections(
        { start: 0, end: 0, pageSize: 0, cursor: '', neLat: 0, neLon: 0, swLat: 0, swLon: 0 },
        { signal: AbortSignal.timeout(20_000) },
      );
    }, emptyFallback, { shouldCache: hasCurrentFireData });
  }
  if (!hasCurrentFireData(response)) {
    return { regions: {}, totalCount: 0, skipped: true, reason: Array.isArray(response.fireDetections) && response.fireDetections.length > 0 ? 'stale_data' : 'no_data' };
  }

  const detections = response.fireDetections;
  const regions: Record<string, FireDetection[]> = {};
  for (const d of detections) {
    const r = d.region || 'Unknown';
    (regions[r] ??= []).push(d);
  }

  return { regions, totalCount: resolveFireDetectionTotalCount(response) };
}

export interface AgencyFireReportStats {
  region: string;
  fireCount: number;
  oldestDatedAt: number;
  newestDatedAt: number;
}

export interface FireSummary {
  /** FIRMS thermal detections from the last 24 hours, by region. */
  regions: FireRegionStats[];
  /** Agency-reported fires (CWFIS, BC Wildfire Service), dated by the agency's report or ignition date, not by an observation. */
  agencyReports: AgencyFireReportStats[];
  /** Satellites and agencies that produced the rows, as reported by each detection. */
  sources: string[];
  shownCount: number;
}

// Absent source means FIRMS, for rows written before agency feeds were merged in.
function isAgencyReport(f: FireDetection): boolean {
  return Boolean(f.source) && f.source !== 'firms';
}

export function summarizeFires(regions: Record<string, FireDetection[]>): FireSummary {
  const thermal: FireRegionStats[] = [];
  const agencyReports: AgencyFireReportStats[] = [];
  const satellites = new Set<string>();
  const agencies = new Set<string>();
  let shownCount = 0;

  for (const [region, all] of Object.entries(regions)) {
    shownCount += all.length;
    const fires = all.filter(f => !isAgencyReport(f));
    const reports = all.filter(isAgencyReport);
    for (const f of fires) if (f.satellite) satellites.add(f.satellite);
    for (const f of reports) agencies.add(f.satellite || f.source || '');
    if (fires.length > 0) {
      thermal.push({
        region,
        fires,
        fireCount: fires.length,
        totalFrp: fires.reduce((sum, f) => sum + (f.frp || 0), 0),
        highIntensityCount: fires.filter(f => f.brightness > 360 && f.confidence === 'FIRE_CONFIDENCE_HIGH').length,
        possibleExplosionCount: fires.filter(f => f.possibleExplosion).length,
      });
    }
    const dates = reports.map(f => f.detectedAt).filter(at => Number.isFinite(at) && at > 0);
    if (reports.length > 0) {
      agencyReports.push({
        region,
        fireCount: reports.length,
        oldestDatedAt: dates.length ? Math.min(...dates) : 0,
        newestDatedAt: dates.length ? Math.max(...dates) : 0,
      });
    }
  }

  const firmsLabel = satellites.size > 0
    ? [`NASA FIRMS (VIIRS ${[...new Set([...satellites].map(firmsSatelliteName))].sort().join(', ')})`]
    : [];
  return {
    regions: thermal.sort((a, b) => b.fireCount - a.fireCount),
    agencyReports: agencyReports.sort((a, b) => b.fireCount - a.fireCount),
    sources: [...firmsLabel, ...[...agencies].filter(Boolean).sort()],
    shownCount,
  };
}

// FIRMS CSV `satellite` codes, plus the FIRMS source names some rows carry instead.
const FIRMS_SATELLITE_NAMES: Record<string, string> = {
  N: 'SNPP',
  VIIRS_SNPP_NRT: 'SNPP',
  N20: 'NOAA-20',
  VIIRS_NOAA20_NRT: 'NOAA-20',
  N21: 'NOAA-21',
  VIIRS_NOAA21_NRT: 'NOAA-21',
};

function firmsSatelliteName(code: string): string {
  return FIRMS_SATELLITE_NAMES[code] ?? code;
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

export function toMapFires(fires: Array<Pick<FireDetection, 'location' | 'brightness' | 'frp' | 'confidence' | 'region' | 'detectedAt' | 'dayNight'> & Partial<Pick<FireDetection, 'satellite' | 'source'>>>): MapFire[] {
  // A detection with no position cannot be placed; defaulting it to 0°, 0° drew a fire off West Africa.
  return fires.filter(f => f.location != null).map(f => ({
    lat: f.location!.latitude,
    lon: f.location!.longitude,
    brightness: f.brightness,
    frp: f.frp,
    confidence: confidenceToNumber(f.confidence),
    region: f.region,
    acq_date: new Date(f.detectedAt).toISOString().slice(0, 10),
    daynight: f.dayNight,
    detected_at: f.detectedAt,
    satellite: f.satellite,
    source: f.source,
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
