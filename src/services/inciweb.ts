/**
 * InciWeb — National Interagency Incident Management System
 * RSS feed — no authentication required
 * https://inciweb.wildfire.gov/feeds/rss/incidents/
 *
 * InciWeb is operated by the US Forest Service and provides the authoritative
 * source for wildfire incident information as reported by fire management teams:
 *  - Official incident name and number
 *  - Containment percentage (from incident commanders, not satellites)
 *  - Acres burned (official ground truth)
 *  - Evacuation orders and warnings
 *  - Resources deployed (personnel, aircraft, engines)
 *  - Cause (lightning, human, under investigation)
 *
 * Complements VIIRS/MODIS satellite heat detection with human-operated data.
 * VIIRS shows where fire pixels are; InciWeb shows the human response.
 */

export interface IncidentReport {
  id: string;
  name: string;
  state: string;
  county: string;
  cause: 'Lightning' | 'Human' | 'Under Investigation' | 'Unknown';
  acresBurned: number | null;
  percentContained: number | null;
  evacuationOrders: boolean;
  evacuationWarnings: boolean;
  personnel: number | null;
  engines: number | null;
  helicopters: number | null;
  discoveryDate: Date | null;
  updatedAt: Date;
  url: string;
  lat: number | null;
  lon: number | null;
  incidentType: 'Wildfire' | 'Prescribed Fire' | 'Complex' | 'Other';
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// InciWeb RSS — active incidents
const INCIWEB_RSS = 'https://inciweb.wildfire.gov/feeds/rss/incidents/';
// Incidents with evacuations (higher priority)
const INCIWEB_EVAC_RSS = 'https://inciweb.wildfire.gov/feeds/rss/incidents/?evac=1';

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { incidents: IncidentReport[]; fetchedAt: number } | null = null;

function detectCause(text: string): IncidentReport['cause'] {
  const t = text.toLowerCase();
  if (t.includes('lightning')) return 'Lightning';
  if (t.includes('human') || t.includes('arson') || t.includes('campfire') || t.includes('equipment')) return 'Human';
  if (t.includes('under investigation')) return 'Under Investigation';
  return 'Unknown';
}

function detectIncidentType(title: string, description: string): IncidentReport['incidentType'] {
  const text = (title + description).toLowerCase();
  if (text.includes('prescribed')) return 'Prescribed Fire';
  if (text.includes('complex')) return 'Complex';
  if (text.includes('fire')) return 'Wildfire';
  return 'Other';
}

function extractNumber(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const num = Number.parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(num)) return num;
    }
  }
  return null;
}

function scoreSeverity(
  acres: number | null,
  contained: number | null,
  hasEvacOrders: boolean
): IncidentReport['severity'] {
  if (hasEvacOrders) return 'critical';
  if (acres !== null && acres > 100_000 && (contained === null || contained < 50)) return 'critical';
  if (acres !== null && acres > 10_000 && (contained === null || contained < 30)) return 'high';
  if (acres !== null && acres > 1000) return 'medium';
  return 'low';
}

function extractState(text: string): string {
  const match = /\b([A-Z]{2})\b(?=\s*,|\s*$)|(?:in|near|,)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/.exec(text);
  if (match?.[1]) return match[1];
  return '';
}

function parseIncidentItem(item: Element, index: number): IncidentReport {
  const title = item.querySelector('title')?.textContent?.trim() ?? '';
  const description = (item.querySelector('description')?.textContent ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const link = item.querySelector('link')?.textContent?.trim() ?? '';
  const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';
  const guid = item.querySelector('guid')?.textContent?.trim() ?? '';

  const fullText = title + ' ' + description;

  const acresBurned = extractNumber(fullText, [
    /(\d[\d,]*(?:\.\d+)?)\s*(?:acres?|ac)\s*(?:burned|total|involved)/i,
    /total\s+(?:size|area)[:\s]+(\d[\d,]*(?:\.\d+)?)/i,
    /(\d[\d,]*)\s+acres?/i,
  ]);

  const percentContained = extractNumber(fullText, [
    /(\d+(?:\.\d+)?)\s*%?\s*contained/i,
    /containment[:\s]+(\d+(?:\.\d+)?)\s*%?/i,
  ]);

  const personnel = extractNumber(fullText, [
    /(\d[\d,]*)\s+(?:personnel|people|firefighters|assigned)/i,
  ]);

  const engines = extractNumber(fullText, [
    /(\d+)\s+engines?/i,
  ]);

  const helicopters = extractNumber(fullText, [
    /(\d+)\s+helicopter/i,
    /(\d+)\s+aircraft/i,
  ]);

  const evacuationOrders = /evacuation order/i.test(fullText);
  const evacuationWarnings = /evacuation warning/i.test(fullText);

  // Extract coordinates from description if present (some RSS items include them)
  const latMatch = /lat(?:itude)?[:\s]+(-?\d+\.\d+)/i.exec(fullText);
  const lonMatch = /lon(?:g(?:itude)?)?[:\s]+(-?\d+\.\d+)/i.exec(fullText);

  const updatedAt = pubDateStr ? new Date(pubDateStr) : new Date();

  return {
    id: `inciweb-${guid.split('/').filter(Boolean).pop() ?? `${index}-${title.replace(/\W/g, '').slice(0, 15)}`}`,
    name: title.replace(/\s+(?:Incident|Fire|Complex)\s*/i, ' $& ').trim(),
    state: extractState(fullText),
    county: '',
    cause: detectCause(fullText),
    acresBurned,
    percentContained,
    evacuationOrders,
    evacuationWarnings,
    personnel,
    engines,
    helicopters,
    discoveryDate: null,
    updatedAt,
    url: link,
    lat: latMatch?.[1] ? Number.parseFloat(latMatch[1]) : null,
    lon: lonMatch?.[1] ? Number.parseFloat(lonMatch[1]) : null,
    incidentType: detectIncidentType(title, description),
    severity: scoreSeverity(acresBurned, percentContained, evacuationOrders),
  };
}

async function fetchFeed(url: string): Promise<IncidentReport[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    return [...doc.querySelectorAll('item')].map((item, i) => parseIncidentItem(item, i));
  } catch {
    return [];
  }
}

export async function fetchInciwebIncidents(): Promise<IncidentReport[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.incidents;

  const [mainResult, evacResult] = await Promise.allSettled([
    fetchFeed(INCIWEB_RSS),
    fetchFeed(INCIWEB_EVAC_RSS),
  ]);

  const main = mainResult.status === 'fulfilled' ? mainResult.value : [];
  const evac = evacResult.status === 'fulfilled' ? evacResult.value : [];

  // Merge, dedupe by URL, evac items take priority
  const byId = new Map<string, IncidentReport>();
  for (const i of [...evac, ...main]) {
    if (!byId.has(i.id)) byId.set(i.id, i);
  }

  const incidents = [...byId.values()].sort((a, b) => {
    const sOrder: Record<IncidentReport['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return sOrder[a.severity] - sOrder[b.severity] || (b.acresBurned ?? 0) - (a.acresBurned ?? 0);
  });

  cache = { incidents: incidents.slice(0, 80), fetchedAt: Date.now() };
  return cache.incidents;
}

export function containmentBar(pct: number | null): string {
  if (pct === null) return '?%';
  return `${Math.round(pct)}%`;
}

export function inciwebSeverityClass(severity: IncidentReport['severity']): string {
  return { critical: 'eq-row eq-major', high: 'eq-row eq-strong', medium: 'eq-row eq-moderate', low: 'eq-row' }[severity] ?? 'eq-row';
}
