/**
 * NOAA Office of Response and Restoration — IncidentNews
 * Oil spill and chemical release incident tracker.
 * https://incidentnews.noaa.gov/api/incidents?format=json&page=1&per_page=50
 *
 * Free, no authentication, CORS-enabled.
 */

export type SpillType = 'oil' | 'chemical' | 'vessel' | 'pipeline' | 'facility' | 'other';

export interface OilSpillIncident {
  id: string;
  name: string;
  description: string;
  type: SpillType;
  location: string;
  state: string;
  country: string;
  lat: number | null;
  lon: number | null;
  openDate: Date;
  closeDate: Date | null;
  isOpen: boolean;
  pollutant: string;
  quantity: string | null; // e.g. "50,000 gallons"
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const NOAA_INCIDENTS_URL =
  'https://incidentnews.noaa.gov/api/incidents?format=json&page=1&per_page=50';

const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
let cache: { items: OilSpillIncident[]; fetchedAt: number } | null = null;

interface NoaaIncident {
  id?: number | string;
  name?: string;
  description?: string;
  open_date?: string;
  close_date?: string | null;
  state?: string;
  country?: string;
  lat?: number | string | null;
  lon?: number | string | null;
  pollutants?: string[] | null;
  quantity?: string | null;
  region_affected?: string;
  url?: string;
}

interface NoaaResponse {
  objects?: NoaaIncident[];
}

function detectSpillType(name: string, description: string): SpillType {
  const text = (name + ' ' + description).toLowerCase();

  if (/\b(ship|vessel|tanker|barge|tug|freighter|cargo|coast guard)\b/.test(text)) return 'vessel';
  if (/\b(pipeline|pipe\s*line|rupture|pipe\s*break|transmission\s*line)\b/.test(text)) return 'pipeline';
  if (/\b(chemical|hazmat|haz\s*mat|toxic|chlorine|ammonia|acid|solvent)\b/.test(text)) return 'chemical';
  if (/\b(facility|refinery|plant|terminal|depot|warehouse|storage\s*tank)\b/.test(text)) return 'facility';
  if (/\b(oil|petroleum|crude|diesel|fuel|gasoline|kerosene|bunker|lubricant)\b/.test(text)) return 'oil';

  return 'other';
}

function isLargeSpill(quantity: string | null, description: string): boolean {
  if (!quantity && !description) return false;
  const text = ((quantity ?? '') + ' ' + description).toLowerCase();

  if (/million\s*gall/.test(text)) return true;

  const gallonsMatch = /([0-9,]+)\s*gall/.exec(text);
  if (gallonsMatch) {
    const gallons = Number.parseInt((gallonsMatch[1] ?? '0').replace(/,/g, ''), 10);
    if (!isNaN(gallons) && gallons > 10_000) return true;
  }

  return false;
}

function computeSeverity(
  incident: NoaaIncident,
  type: SpillType,
  isOpen: boolean,
  quantity: string | null,
): OilSpillIncident['severity'] {
  const description = incident.description ?? '';
  const large = isLargeSpill(quantity, description);

  if (large && isOpen) return 'critical';
  if (isOpen && (type === 'chemical')) return 'critical';
  if (isOpen && (type === 'pipeline' || type === 'facility')) return 'high';
  if (isOpen) return 'medium';
  return 'low';
}

const SEVERITY_ORDER: OilSpillIncident['severity'][] = ['critical', 'high', 'medium', 'low'];

function severityRank(s: OilSpillIncident['severity']): number {
  return SEVERITY_ORDER.indexOf(s);
}

export async function fetchOilSpills(): Promise<OilSpillIncident[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.items;
  }

  let raw: NoaaIncident[] = [];
  try {
    const res = await fetch(NOAA_INCIDENTS_URL, { signal: AbortSignal.timeout(12_000) });
    if (res.ok) {
      const json = (await res.json()) as NoaaResponse;
      raw = json.objects ?? [];
    }
  } catch {
    return cache?.items ?? [];
  }

  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 3_600_000;
  const fourteenDaysMs = 14 * 24 * 3_600_000;

  const incidents: OilSpillIncident[] = [];

  for (const obj of raw) {
    const name = obj.name ?? '';
    const description = obj.description ?? '';
    const openDate = obj.open_date ? new Date(obj.open_date) : new Date();
    const closeDate = obj.close_date ? new Date(obj.close_date) : null;
    const isOpen = closeDate === null || closeDate.getTime() > now;

    // Recency filter
    if (isOpen) {
      if (now - openDate.getTime() > ninetyDaysMs) continue;
    } else {
      if (closeDate && now - closeDate.getTime() > fourteenDaysMs) continue;
    }

    const type = detectSpillType(name, description);
    const quantity = obj.quantity ?? null;
    const severity = computeSeverity(obj, type, isOpen, quantity);

    const pollutants = Array.isArray(obj.pollutants) ? obj.pollutants.join(', ') : (obj.pollutants ?? '');

    const lat =
      obj.lat !== null && obj.lat !== undefined && obj.lat !== ''
        ? Number.parseFloat(String(obj.lat))
        : null;
    const lon =
      obj.lon !== null && obj.lon !== undefined && obj.lon !== ''
        ? Number.parseFloat(String(obj.lon))
        : null;

    incidents.push({
      id: `noaa-spill-${obj.id ?? name.replace(/\W/g, '').slice(0, 16)}`,
      name,
      description: description.slice(0, 500),
      type,
      location: obj.region_affected ?? '',
      state: obj.state ?? '',
      country: obj.country ?? 'US',
      lat: lat !== null && !isNaN(lat) ? lat : null,
      lon: lon !== null && !isNaN(lon) ? lon : null,
      openDate,
      closeDate,
      isOpen,
      pollutant: pollutants,
      quantity,
      url: obj.url ?? `https://incidentnews.noaa.gov/incident/${obj.id}`,
      severity,
    });
  }

  // Sort: open first, then by severity, then by openDate desc
  incidents.sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
    const sr = severityRank(a.severity) - severityRank(b.severity);
    if (sr !== 0) return sr;
    return b.openDate.getTime() - a.openDate.getTime();
  });

  const limited = incidents.slice(0, 40);
  cache = { items: limited, fetchedAt: Date.now() };
  return limited;
}

export function spillSeverityClass(severity: OilSpillIncident['severity']): string {
  return (
    {
      critical: 'eq-row eq-major',
      high: 'eq-row eq-strong',
      medium: 'eq-row eq-moderate',
      low: 'eq-row',
    }[severity] ?? 'eq-row'
  );
}

export function spillTypeLabel(type: SpillType): string {
  return (
    {
      oil: 'Oil Spill',
      chemical: 'Chemical Release',
      vessel: 'Vessel Incident',
      pipeline: 'Pipeline Failure',
      facility: 'Facility Incident',
      other: 'Environmental Incident',
    }[type] ?? 'Environmental Incident'
  );
}
