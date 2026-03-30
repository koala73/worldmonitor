import { XMLParser } from 'fast-xml-parser';

export type WinterWeatherHazardType = 'snow' | 'ice';
export type WinterWeatherThreshold = '4in' | '8in' | '12in' | '0.25in';
export type WinterWeatherProbabilityTier = 'slight' | 'moderate' | 'high';

export interface WinterWeatherOutlook {
  id: string;
  day: 1 | 2 | 3;
  hazardType: WinterWeatherHazardType;
  threshold: WinterWeatherThreshold;
  probabilityTier: WinterWeatherProbabilityTier;
  probabilityPercent: 10 | 40 | 70;
  headline: string;
  issuedAt: Date;
  startsAt: Date;
  endsAt: Date;
  coordinates: [number, number][][];
  centroid?: [number, number];
  severity: 'critical' | 'high' | 'medium' | 'low';
  sourceUrl: string;
}

interface WinterWeatherProductDescriptor {
  hazardType: WinterWeatherHazardType;
  threshold: WinterWeatherThreshold;
  sourceUrl: string;
}

interface ParsedKmlDocument {
  kml?: {
    Document?: {
      description?: string;
      Folder?: unknown;
    };
  };
}

interface ParsedKmlFolder {
  name?: string;
  description?: string;
  TimeSpan?: {
    begin?: string;
    end?: string;
  };
  Folder?: ParsedKmlFolder | ParsedKmlFolder[];
  Placemark?: ParsedKmlPlacemark | ParsedKmlPlacemark[];
}

interface ParsedKmlPlacemark {
  name?: string;
  styleUrl?: string;
  MultiGeometry?: {
    Polygon?: ParsedKmlPolygon | ParsedKmlPolygon[];
  };
}

interface ParsedKmlPolygon {
  outerBoundaryIs?: {
    LinearRing?: {
      coordinates?: string;
    };
  };
}

const PRODUCT_DESCRIPTORS: WinterWeatherProductDescriptor[] = [
  {
    hazardType: 'snow',
    threshold: '4in',
    sourceUrl: 'https://www.wpc.ncep.noaa.gov/kml/winwx/HPC_Day1-3_psnow_gt_04_latest.kml',
  },
  {
    hazardType: 'snow',
    threshold: '8in',
    sourceUrl: 'https://www.wpc.ncep.noaa.gov/kml/winwx/HPC_Day1-3_psnow_gt_08_latest.kml',
  },
  {
    hazardType: 'snow',
    threshold: '12in',
    sourceUrl: 'https://www.wpc.ncep.noaa.gov/kml/winwx/HPC_Day1-3_psnow_gt_12_latest.kml',
  },
  {
    hazardType: 'ice',
    threshold: '0.25in',
    sourceUrl: 'https://www.wpc.ncep.noaa.gov/kml/winwx/HPC_Day1-3_picez_gt_25_latest.kml',
  },
];

const XML_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
const CACHE_TTL_MS = 30 * 60 * 1000;
const SEVERITY_ORDER: Record<WinterWeatherOutlook['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const THRESHOLD_ORDER: Record<WinterWeatherThreshold, number> = {
  '12in': 0,
  '8in': 1,
  '4in': 2,
  '0.25in': 3,
};
const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
let cache: { data: WinterWeatherOutlook[]; fetchedAt: number } | null = null;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function parseCoordinates(raw: string | undefined): [number, number][] {
  if (!raw) return [];
  return raw
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(','))
    .map(([lon, lat]) => [Number.parseFloat(lon ?? ''), Number.parseFloat(lat ?? '')] as [number, number])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
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

function styleToProbability(styleUrl: string | undefined, name: string | undefined): {
  tier: WinterWeatherProbabilityTier;
  percent: 10 | 40 | 70;
} | null {
  const normalized = `${styleUrl ?? ''} ${name ?? ''}`.toLowerCase();
  if (normalized.includes('poly_high') || normalized.includes('high')) {
    return { tier: 'high', percent: 70 };
  }
  if (normalized.includes('poly_mod') || normalized.includes('moderate')) {
    return { tier: 'moderate', percent: 40 };
  }
  if (normalized.includes('poly_slight') || normalized.includes('slight')) {
    return { tier: 'slight', percent: 10 };
  }
  return null;
}

function parseIssuedAt(description: string | undefined): Date {
  const normalized = (description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const match = /Issued:\s*(\d{2})(\d{2})Z\s+\w+\s+([A-Z]{3})\s+(\d{1,2}),\s+(\d{4})/i.exec(normalized);
  if (!match) return new Date();
  const month = MONTHS[(match[3] ?? '').toLowerCase()];
  if (month == null) return new Date();
  const issuedAt = new Date(Date.UTC(
    Number.parseInt(match[5] ?? '', 10),
    month,
    Number.parseInt(match[4] ?? '', 10),
    Number.parseInt(match[1] ?? '', 10),
    Number.parseInt(match[2] ?? '', 10),
  ));
  return Number.isFinite(issuedAt.getTime()) ? issuedAt : new Date();
}

function parseDay(folderName: string | undefined): 1 | 2 | 3 | null {
  const match = /Day\s+([123])\b/i.exec(folderName ?? '');
  if (!match) return null;
  const day = Number.parseInt(match[1] ?? '', 10);
  return day === 1 || day === 2 || day === 3 ? day : null;
}

function parseDate(raw: string | undefined): Date {
  if (!raw) return new Date();
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function describeThreshold(descriptor: WinterWeatherProductDescriptor): string {
  if (descriptor.hazardType === 'ice') return '0.25 inch';
  return descriptor.threshold.replace('in', ' inches');
}

function toSeverity(
  descriptor: WinterWeatherProductDescriptor,
  day: 1 | 2 | 3,
  probabilityPercent: 10 | 40 | 70,
): WinterWeatherOutlook['severity'] {
  if (descriptor.hazardType === 'ice') {
    if (probabilityPercent >= 70) return 'critical';
    if (probabilityPercent >= 40) return day === 1 ? 'critical' : 'high';
    return day === 1 ? 'high' : 'medium';
  }

  if (descriptor.threshold === '12in') {
    if (probabilityPercent >= 40) return 'critical';
    return 'high';
  }

  if (descriptor.threshold === '8in') {
    if (probabilityPercent >= 70) return 'critical';
    if (probabilityPercent >= 40) return 'high';
    return day === 1 ? 'high' : 'medium';
  }

  if (probabilityPercent >= 70) return day === 1 ? 'high' : 'medium';
  if (probabilityPercent >= 40) return 'medium';
  return 'low';
}

function extractPolygons(placemark: ParsedKmlPlacemark): [number, number][][] {
  return asArray(placemark.MultiGeometry?.Polygon)
    .map((polygon) => parseCoordinates(polygon.outerBoundaryIs?.LinearRing?.coordinates))
    .filter((ring) => ring.length >= 4);
}

export function parseWpcWinterWeatherKml(
  xml: string,
  descriptor: WinterWeatherProductDescriptor,
): WinterWeatherOutlook[] {
  const parsed = XML_PARSER.parse(xml) as ParsedKmlDocument;
  const document = parsed.kml?.Document;
  const issuedAt = parseIssuedAt(document?.description);
  const wrapperFolder = asArray(document?.Folder as ParsedKmlFolder | ParsedKmlFolder[])[0];
  const dayFolders = asArray(wrapperFolder?.Folder);
  const outlooks: WinterWeatherOutlook[] = [];

  for (const folder of dayFolders) {
    const day = parseDay(folder.name);
    if (!day) continue;

    const startsAt = parseDate(folder.TimeSpan?.begin);
    const endsAt = parseDate(folder.TimeSpan?.end);
    for (const placemark of asArray(folder.Placemark)) {
      const probability = styleToProbability(placemark.styleUrl, placemark.name);
      if (!probability) continue;
      const coordinates = extractPolygons(placemark);
      if (coordinates.length === 0) continue;

      outlooks.push({
        id: `wpc-winter-${descriptor.hazardType}-${descriptor.threshold}-day${day}-${probability.percent}`,
        day,
        hazardType: descriptor.hazardType,
        threshold: descriptor.threshold,
        probabilityTier: probability.tier,
        probabilityPercent: probability.percent,
        headline: `WPC Day ${day} ${descriptor.hazardType} > ${describeThreshold(descriptor)} probability`,
        issuedAt,
        startsAt,
        endsAt,
        coordinates,
        centroid: computeCentroid(coordinates),
        severity: toSeverity(descriptor, day, probability.percent),
        sourceUrl: descriptor.sourceUrl,
      });
    }
  }

  return outlooks;
}

async function fetchProduct(descriptor: WinterWeatherProductDescriptor): Promise<WinterWeatherOutlook[]> {
  try {
    const response = await fetch(descriptor.sourceUrl, {
      headers: { Accept: 'application/vnd.google-earth.kml+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return [];
    const xml = await response.text();
    return parseWpcWinterWeatherKml(xml, descriptor);
  } catch {
    return [];
  }
}

export async function fetchWinterWeatherOutlooks(): Promise<WinterWeatherOutlook[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.data;

  const results = await Promise.allSettled(PRODUCT_DESCRIPTORS.map((descriptor) => fetchProduct(descriptor)));
  const data = results
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .sort((left, right) => {
      const severityDiff = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
      if (severityDiff !== 0) return severityDiff;
      const dayDiff = left.day - right.day;
      if (dayDiff !== 0) return dayDiff;
      const thresholdDiff = THRESHOLD_ORDER[left.threshold] - THRESHOLD_ORDER[right.threshold];
      if (thresholdDiff !== 0) return thresholdDiff;
      return right.probabilityPercent - left.probabilityPercent;
    });

  cache = { data, fetchedAt: Date.now() };
  return data;
}
