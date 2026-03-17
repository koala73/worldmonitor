/**
 * NOAA Hazard Mapping System (HMS) daily smoke polygons
 * KML source: https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/SMOKE_YYYYMMDD.kml
 * Routed through /api/rss-proxy for CORS.
 */

export type SmokeDensity = 'Light' | 'Medium' | 'Heavy';

export interface SmokePolygon {
  id: string;
  density: SmokeDensity;
  coordinates: [number, number][][]; // [lon, lat] rings
  centroid?: [number, number];
  date: string; // YYYYMMDD
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface WildfireSmokeReport {
  polygons: SmokePolygon[];
  date: string;
  heavyCount: number;
  mediumCount: number;
  lightCount: number;
  fetchedAt: Date;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
let cache: { report: WildfireSmokeReport; fetchedAt: number } | null = null;

function yyyymmdd(d: Date): string {
  const y = d.getFullYear().toString();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return y + m + day;
}

function buildKmlUrl(dateStr: string): string {
  return `https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/SMOKE_${dateStr}.kml`;
}

function densitySeverity(density: SmokeDensity): SmokePolygon['severity'] {
  if (density === 'Heavy') return 'critical';
  if (density === 'Medium') return 'high';
  return 'medium'; // Light
}

function parseDensity(name: string): SmokeDensity | null {
  const n = name.trim();
  if (n === 'Heavy') return 'Heavy';
  if (n === 'Medium') return 'Medium';
  if (n === 'Light') return 'Light';
  return null;
}

function parseCoordinateString(coordStr: string): [number, number][] {
  const points: [number, number][] = [];
  const entries = coordStr.trim().split(/\s+/);
  for (const entry of entries) {
    const parts = entry.split(',');
    if (parts.length < 2) continue;
    const lon = parseFloat(parts[0] ?? 'NaN');
    const lat = parseFloat(parts[1] ?? 'NaN');
    if (!isNaN(lon) && !isNaN(lat)) {
      points.push([lon, lat]);
    }
  }
  return points;
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

async function fetchKml(dateStr: string): Promise<SmokePolygon[] | null> {
  const kmlUrl = buildKmlUrl(dateStr);
  const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(kmlUrl)}`;
  try {
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.length < 100) return null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return null;

    const placemarks = Array.from(doc.querySelectorAll('Placemark'));
    if (placemarks.length === 0) return null;

    const heavy: SmokePolygon[] = [];
    const medium: SmokePolygon[] = [];
    const light: SmokePolygon[] = [];

    for (let i = 0; i < placemarks.length; i++) {
      const el = placemarks[i];
      if (!el) continue;
      const nameEl = el.querySelector('name');
      const name = nameEl?.textContent?.trim() ?? '';
      const density = parseDensity(name);
      if (!density) continue;

      const coordEl = el.querySelector('coordinates');
      const coordStr = coordEl?.textContent ?? '';
      const ring = parseCoordinateString(coordStr);
      if (ring.length < 3) continue;

      const coordinates: [number, number][][] = [ring];
      const polygon: SmokePolygon = {
        id: `hms-smoke-${dateStr}-${i}`,
        density,
        coordinates,
        centroid: computeCentroid(coordinates),
        date: dateStr,
        severity: densitySeverity(density),
      };

      if (density === 'Heavy') heavy.push(polygon);
      else if (density === 'Medium') medium.push(polygon);
      else light.push(polygon);
    }

    // Limit to 200 polygons: Heavy first, then Medium, then Light
    const combined = [...heavy, ...medium, ...light].slice(0, 200);
    return combined;
  } catch {
    return null;
  }
}

export async function fetchWildfireSmoke(): Promise<WildfireSmokeReport> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.report;
  }

  const today = new Date();
  const todayStr = yyyymmdd(today);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yyyymmdd(yesterday);

  let polygons: SmokePolygon[] | null = await fetchKml(todayStr);
  let dateUsed = todayStr;

  if (!polygons || polygons.length === 0) {
    polygons = await fetchKml(yesterdayStr);
    dateUsed = yesterdayStr;
  }

  if (!polygons) polygons = [];

  const report: WildfireSmokeReport = {
    polygons,
    date: dateUsed,
    heavyCount: polygons.filter(p => p.density === 'Heavy').length,
    mediumCount: polygons.filter(p => p.density === 'Medium').length,
    lightCount: polygons.filter(p => p.density === 'Light').length,
    fetchedAt: new Date(),
  };

  cache = { report, fetchedAt: Date.now() };
  return report;
}

export function smokePolygonClass(density: SmokeDensity): string {
  return (
    {
      Heavy: 'eq-row eq-major',
      Medium: 'eq-row eq-strong',
      Light: 'eq-row eq-moderate',
    }[density] ?? 'eq-row'
  );
}
