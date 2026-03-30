/**
 * WPC Excessive Rainfall Outlooks
 * Official GeoJSON feed:
 * https://www.wpc.ncep.noaa.gov/exper/eromap/geojson/Day1_Latest.geojson
 */

export type ExcessiveRainfallRisk = 'marginal' | 'slight' | 'moderate' | 'high';

export interface ExcessiveRainfallOutlook {
  id: string;
  day: 1 | 2 | 3;
  riskLevel: ExcessiveRainfallRisk;
  riskText: string;
  headline: string;
  validTime: string;
  issuedAt: Date;
  startsAt: Date;
  endsAt: Date;
  coordinates: [number, number][][];
  centroid?: [number, number];
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const DAY_URLS: Record<1 | 2 | 3, string> = {
  1: 'https://www.wpc.ncep.noaa.gov/exper/eromap/geojson/Day1_Latest.geojson',
  2: 'https://www.wpc.ncep.noaa.gov/exper/eromap/geojson/Day2_Latest.geojson',
  3: 'https://www.wpc.ncep.noaa.gov/exper/eromap/geojson/Day3_Latest.geojson',
};

const CACHE_TTL_MS = 30 * 60 * 1000;
let cache: { data: ExcessiveRainfallOutlook[]; fetchedAt: number } | null = null;

interface WpcFeatureProperties {
  dn?: number;
  PRODUCT?: string;
  VALID_TIME?: string;
  OUTLOOK?: string;
  ISSUE_TIME?: string;
  START_TIME?: string;
  END_TIME?: string;
}

interface WpcFeature {
  properties?: WpcFeatureProperties;
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
}

interface WpcResponse {
  features?: WpcFeature[];
}

const RISK_BY_DN: Record<number, ExcessiveRainfallRisk | null> = {
  0: null,
  1: 'marginal',
  2: 'slight',
  3: 'moderate',
  4: 'high',
};

function toSeverity(risk: ExcessiveRainfallRisk): ExcessiveRainfallOutlook['severity'] {
  switch (risk) {
    case 'high':
      return 'critical';
    case 'moderate':
      return 'high';
    case 'slight':
      return 'medium';
    default:
      return 'low';
  }
}

function riskLabel(risk: ExcessiveRainfallRisk): string {
  switch (risk) {
    case 'high':
      return 'High';
    case 'moderate':
      return 'Moderate';
    case 'slight':
      return 'Slight';
    case 'marginal':
      return 'Marginal';
  }
}

function safeDate(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function extractCoordinates(geometry: WpcFeature['geometry']): [number, number][][] {
  if (!geometry?.type || !geometry.coordinates) return [];
  if (geometry.type === 'Polygon') {
    return (geometry.coordinates as [number, number][][]) ?? [];
  }
  if (geometry.type === 'MultiPolygon') {
    return ((geometry.coordinates as [number, number][][][]) ?? []).flat();
  }
  return [];
}

function computeCentroid(coordinates: [number, number][][]): [number, number] | undefined {
  const ring = coordinates[0];
  if (!ring || ring.length === 0) return undefined;
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of ring) {
    sumLon += lon;
    sumLat += lat;
  }
  return [sumLon / ring.length, sumLat / ring.length];
}

async function fetchDay(day: 1 | 2 | 3): Promise<ExcessiveRainfallOutlook[]> {
  try {
    const res = await fetch(DAY_URLS[day], {
      headers: { Accept: 'application/geo+json, application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];

    const json = await res.json() as WpcResponse;
    const features = json.features ?? [];
    const outlooks: ExcessiveRainfallOutlook[] = [];

    features.forEach((feature, index) => {
      const properties = feature.properties ?? {};
      const riskLevel = RISK_BY_DN[properties.dn ?? 0] ?? null;
      if (!riskLevel) return;

      const coordinates = extractCoordinates(feature.geometry);
      if (coordinates.length === 0) return;

      const label = riskLabel(riskLevel);
      outlooks.push({
        id: `wpc-ero-d${day}-${riskLevel}-${index}`,
        day,
        riskLevel,
        riskText: label,
        headline: `${label} excessive rainfall risk`,
        validTime: properties.VALID_TIME ?? '',
        issuedAt: safeDate(properties.ISSUE_TIME),
        startsAt: safeDate(properties.START_TIME),
        endsAt: safeDate(properties.END_TIME),
        coordinates,
        centroid: computeCentroid(coordinates),
        severity: toSeverity(riskLevel),
      });
    });

    return outlooks;
  } catch {
    return [];
  }
}

const SEVERITY_ORDER: Record<ExcessiveRainfallOutlook['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function fetchExcessiveRainfallOutlooks(): Promise<ExcessiveRainfallOutlook[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.data;

  const results = await Promise.allSettled([
    fetchDay(1),
    fetchDay(2),
    fetchDay(3),
  ]);

  const data = results
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .sort((left, right) => {
      const severityDiff = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
      if (severityDiff !== 0) return severityDiff;
      return left.day - right.day;
    });

  cache = { data, fetchedAt: Date.now() };
  return data;
}
