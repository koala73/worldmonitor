/**
 * NOAA Storm Prediction Center (SPC) Convective Outlooks + Iowa State LSR Storm Reports
 * SPC Day 1 GeoJSON: https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson
 * SPC Day 2 GeoJSON: https://www.spc.noaa.gov/products/outlook/day2otlk_cat.nolyr.geojson
 * Iowa State LSR:    https://mesonet.agron.iastate.edu/api/1/lsrs.geojson?inc_ts=1&hours=24
 */

export type ConvectiveRisk = 'TSTM' | 'MRGL' | 'SLGT' | 'ENH' | 'MDT' | 'HIGH';

export interface ConvectiveOutlook {
  id: string;
  day: 1 | 2;
  risk: ConvectiveRisk;
  label: string;
  coordinates: [number, number][][]; // polygon rings
  centroid?: [number, number];
  validTime: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface StormReport {
  id: string;
  type: 'tornado' | 'hail' | 'wind' | 'flooding' | 'other';
  magnitude: string;
  location: string;
  county: string;
  state: string;
  lat: number;
  lon: number;
  reportedAt: Date;
  remarks: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface SpcSummary {
  outlooks: ConvectiveOutlook[];
  reports: StormReport[];
  fetchedAt: Date;
  maxRisk: ConvectiveRisk | null;
}

const SPC_DAY1_URL = 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson';
const SPC_DAY2_URL = 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.nolyr.geojson';
const LSR_URL = 'https://mesonet.agron.iastate.edu/api/1/lsrs.geojson?inc_ts=1&hours=24';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

let outlooksCache: { items: ConvectiveOutlook[]; fetchedAt: number } | null = null;
let reportsCache: { items: StormReport[]; fetchedAt: number } | null = null;

// Risk rank for ordering/severity
const RISK_RANK: Record<ConvectiveRisk, number> = {
  TSTM: 1,
  MRGL: 2,
  SLGT: 3,
  ENH: 4,
  MDT: 5,
  HIGH: 6,
};

const VALID_RISKS = new Set<string>(['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH']);

function riskSeverity(risk: ConvectiveRisk): ConvectiveOutlook['severity'] {
  if (risk === 'HIGH' || risk === 'MDT') return 'critical';
  if (risk === 'ENH') return 'high';
  if (risk === 'SLGT') return 'medium';
  return 'low'; // MRGL, TSTM
}

function computeCentroid(rings: [number, number][][]): [number, number] | undefined {
  const ring = rings[0];
  if (!ring || ring.length === 0) return undefined;
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of ring) {
    sumLon += lon;
    sumLat += lat;
  }
  return [sumLon / ring.length, sumLat / ring.length];
}

function extractRings(geometry: { type: string; coordinates: unknown }): [number, number][][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    return (geometry.coordinates as [number, number][][]) ?? [];
  }
  if (geometry.type === 'MultiPolygon') {
    const polys = (geometry.coordinates as [number, number][][][]) ?? [];
    // Flatten to array of rings
    return polys.flat();
  }
  return [];
}

async function fetchOutlookDay(day: 1 | 2): Promise<ConvectiveOutlook[]> {
  const url = day === 1 ? SPC_DAY1_URL : SPC_DAY2_URL;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const json = await res.json() as {
      features?: {
        properties?: { DN?: string; LABEL?: string; LABEL2?: string; VALID?: string; EXPIRE?: string };
        geometry?: { type: string; coordinates: unknown };
      }[];
    };
    const features = json.features ?? [];
    const results: ConvectiveOutlook[] = [];
    for (const [i, f] of features.entries()) {
      if (!f) continue;
      const props = f.properties ?? {};
      const dn = (props.DN ?? '').trim().toUpperCase();
      if (!VALID_RISKS.has(dn)) continue;
      const risk = dn as ConvectiveRisk;
      const coordinates = extractRings(f.geometry as { type: string; coordinates: unknown });
      if (coordinates.length === 0) continue;
      results.push({
        id: `spc-d${day}-${risk}-${i}`,
        day,
        risk,
        label: convectiveRiskLabel(risk),
        coordinates,
        centroid: computeCentroid(coordinates),
        validTime: props.VALID ?? props.EXPIRE ?? '',
        severity: riskSeverity(risk),
      });
    }
    return results;
  } catch {
    return [];
  }
}

export async function fetchSpcOutlooks(): Promise<ConvectiveOutlook[]> {
  if (outlooksCache && Date.now() - outlooksCache.fetchedAt < CACHE_TTL_MS) {
    return outlooksCache.items;
  }

  const [day1Result, day2Result] = await Promise.allSettled([
    fetchOutlookDay(1),
    fetchOutlookDay(2),
  ]);

  const items: ConvectiveOutlook[] = [
    ...(day1Result.status === 'fulfilled' ? day1Result.value : []),
    ...(day2Result.status === 'fulfilled' ? day2Result.value : []),
  ];

  // Sort by severity descending
  items.sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk]);

  outlooksCache = { items, fetchedAt: Date.now() };
  return items;
}

function lsrTypeName(typeCode: string): StormReport['type'] {
  const c = typeCode.trim().toUpperCase();
  if (c === 'T' || c === 'TO') return 'tornado';
  if (c === 'H' || c === 'G' || c === 'GH') return 'hail';
  if (c === 'W' || c === 'DS' || c === 'WS') return 'wind';
  if (c === 'F' || c === 'FL' || c === 'IB' || c === 'IS') return 'flooding';
  return 'other';
}

function lsrSeverity(type: StormReport['type'], _magnitude: string): StormReport['severity'] {
  if (type === 'tornado') return 'critical';
  if (type === 'flooding') return 'high';
  if (type === 'hail' || type === 'wind') return 'medium';
  return 'low';
}

export async function fetchStormReports(): Promise<StormReport[]> {
  if (reportsCache && Date.now() - reportsCache.fetchedAt < CACHE_TTL_MS) {
    return reportsCache.items;
  }

  try {
    const res = await fetch(LSR_URL, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return reportsCache?.items ?? [];
    const json = await res.json() as {
      features?: {
        properties?: {
          type?: string;
          magnitude?: string | number;
          city?: string;
          county?: string;
          state?: string;
          valid?: string;
          remark?: string;
        };
        geometry?: { coordinates?: [number, number] };
      }[];
    };
    const features = json.features ?? [];
    const items: StormReport[] = [];
    for (const [i, f] of features.entries()) {
      if (!f) continue;
      const props = f.properties ?? {};
      const coords = f.geometry?.coordinates;
      if (!coords) continue;
      const [lon, lat] = coords;
      const typeCode = props.type ?? '';
      const type = lsrTypeName(typeCode);
      const magnitude = props.magnitude !== null && props.magnitude !== undefined
        ? String(props.magnitude)
        : '';
      const reportedAt = props.valid ? new Date(props.valid) : new Date();
      items.push({
        id: `lsr-${i}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
        type,
        magnitude,
        location: props.city ?? '',
        county: props.county ?? '',
        state: props.state ?? '',
        lat,
        lon,
        reportedAt,
        remarks: props.remark ?? '',
        severity: lsrSeverity(type, magnitude),
      });
    }

    // Sort: critical first
    const sOrder: Record<StormReport['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
    items.sort((a, b) => sOrder[a.severity] - sOrder[b.severity]);

    reportsCache = { items, fetchedAt: Date.now() };
    return items;
  } catch {
    return reportsCache?.items ?? [];
  }
}

export async function fetchSpcSummary(): Promise<SpcSummary> {
  const [outlooks, reports] = await Promise.all([
    fetchSpcOutlooks(),
    fetchStormReports(),
  ]);

  let maxRisk: ConvectiveRisk | null = null;
  for (const o of outlooks) {
    if (maxRisk === null || RISK_RANK[o.risk] > RISK_RANK[maxRisk]) {
      maxRisk = o.risk;
    }
  }

  return {
    outlooks,
    reports,
    fetchedAt: new Date(),
    maxRisk,
  };
}

export function convectiveRiskLabel(risk: ConvectiveRisk): string {
  const labels: Record<ConvectiveRisk, string> = {
    TSTM: 'Thunderstorm',
    MRGL: 'Marginal',
    SLGT: 'Slight',
    ENH: 'Enhanced',
    MDT: 'Moderate',
    HIGH: 'High',
  };
  return labels[risk] ?? risk;
}

export function spcSeverityClass(severity: string): string {
  return (
    {
      critical: 'eq-row eq-major',
      high: 'eq-row eq-strong',
      medium: 'eq-row eq-moderate',
      low: 'eq-row',
    }[severity] ?? 'eq-row'
  );
}
