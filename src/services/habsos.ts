/**
 * NOAA Harmful Algal Bloom (HAB) observations — HABSOS network
 * Primary: HABSOS ESRI Feature Service
 * Fallback: NOAA NCCOS HAB bulletin RSS
 */

export type HabSpecies =
  | 'Karenia'
  | 'Alexandrium'
  | 'Pseudo-nitzschia'
  | 'Microcystis'
  | 'Dinoflagellate'
  | 'Unknown';

export type HabRegion =
  | 'Gulf of Mexico'
  | 'Pacific Coast'
  | 'Atlantic Coast'
  | 'Great Lakes'
  | 'Chesapeake Bay'
  | 'Other';

export interface HabObservation {
  id: string;
  description: string;
  species: HabSpecies;
  region: HabRegion;
  state: string;
  lat: number | null;
  lon: number | null;
  cellCount: number | null;
  sampleDate: Date;
  affectedArea: string;
  impacts: string[];
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
let cache: { data: HabObservation[]; ts: number } | null = null;

const ESRI_URL =
  'https://habsos.noaa.gov/arcgis/rest/services/HABSOS/Conditions/FeatureServer/0/query' +
  '?where=1%3D1&outFields=*&f=json&resultRecordCount=50&orderByFields=SAMPLE_DATE+DESC';

const RSS_FALLBACK_URL =
  'https://coastalscience.noaa.gov/research/coastal-ecology/habs/rss/';

interface EsriAttributes {
  SAMPLE_DATE?: number | string | null;
  STATE?: string | null;
  DESCRIPTION?: string | null;
  CELLCOUNT?: number | null;
  CELLCOUNT_QC?: string | null;
  X?: number | null;
  Y?: number | null;
  HAB_DETAILS?: string | null;
  AFFECTED_AREA?: string | null;
  ADDITIONAL_NOTES?: string | null;
  GENUS?: string | null;
  SPECIES?: string | null;
  OBJECTID?: number | null;
}

interface EsriFeature {
  attributes: EsriAttributes;
}

interface EsriResponse {
  features?: EsriFeature[];
}

function detectSpecies(genus: string | null | undefined, text: string): HabSpecies {
  const g = (genus ?? '').toLowerCase();
  const t = text.toLowerCase();
  if (g.includes('karenia') || t.includes('karenia') || t.includes('red tide')) return 'Karenia';
  if (g.includes('alexandrium') || t.includes('alexandrium') || t.includes('saxitoxin')) return 'Alexandrium';
  if (
    g.includes('pseudo-nitzschia') ||
    g.includes('pseudonitzschia') ||
    t.includes('pseudo-nitzschia') ||
    t.includes('domoic acid')
  )
    return 'Pseudo-nitzschia';
  if (g.includes('microcystis') || t.includes('microcystis') || t.includes('cyanobacteria')) return 'Microcystis';
  if (t.includes('dinoflagellate')) return 'Dinoflagellate';
  return 'Unknown';
}

const GULF_STATES = new Set(['FL', 'AL', 'MS', 'LA', 'TX']);
const PACIFIC_STATES = new Set(['WA', 'OR', 'CA']);
const ATLANTIC_STATES = new Set(['ME', 'NH', 'MA', 'RI', 'CT', 'NY', 'NJ', 'DE', 'MD', 'VA', 'NC', 'SC', 'GA']);
const GREAT_LAKES_STATES = new Set(['MI', 'WI', 'MN', 'IL', 'IN', 'OH', 'PA']);
const CHESAPEAKE_STATES = new Set(['MD', 'VA']);

function detectRegion(state: string): HabRegion {
  const s = (state ?? '').toUpperCase().trim();
  if (GULF_STATES.has(s)) return 'Gulf of Mexico';
  if (PACIFIC_STATES.has(s)) return 'Pacific Coast';
  if (CHESAPEAKE_STATES.has(s)) return 'Chesapeake Bay';
  if (ATLANTIC_STATES.has(s)) return 'Atlantic Coast';
  if (GREAT_LAKES_STATES.has(s)) return 'Great Lakes';
  return 'Other';
}

function extractImpacts(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  if (lower.includes('beach closure') || lower.includes('beach closed')) found.push('Beach closure');
  if (lower.includes('fish kill') || lower.includes('fish die')) found.push('Fish kill');
  if (lower.includes('shellfish')) found.push('Shellfish harvest closure');
  if (lower.includes('water advisory') || lower.includes('do not swim') || lower.includes('swimming advisory'))
    found.push('Water advisory');
  if (lower.includes('toxic')) found.push('Toxic bloom confirmed');
  if (lower.includes('respiratory') || lower.includes('cough') || lower.includes('breathing'))
    found.push('Respiratory irritation');
  return found;
}

function computeHabSeverity(
  species: HabSpecies,
  cellCount: number | null,
  impacts: string[],
): HabObservation['severity'] {
  const highRiskSpecies =
    species === 'Karenia' || species === 'Alexandrium' || species === 'Pseudo-nitzschia';
  if (highRiskSpecies && cellCount !== null && cellCount > 100_000) return 'critical';
  if (impacts.length > 0) return 'high';
  if (species !== 'Unknown') return 'medium';
  return 'low';
}

function parseEsriDate(raw: number | string | null | undefined): Date {
  if (raw === null || raw === undefined) return new Date();
  if (typeof raw === 'number') return new Date(raw);
  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function fromEsriFeatures(features: EsriFeature[]): HabObservation[] {
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const results: HabObservation[] = [];

  for (const feature of features) {
    const a = feature.attributes ?? {};
    const sampleDate = parseEsriDate(a.SAMPLE_DATE);
    if (sampleDate.getTime() < cutoff) continue;

    const state = (a.STATE ?? '').toUpperCase().trim();
    const description = a.DESCRIPTION ?? '';
    const details = a.HAB_DETAILS ?? '';
    const notes = a.ADDITIONAL_NOTES ?? '';
    const combinedText = [description, details, notes].join(' ');

    const species = detectSpecies(a.GENUS, combinedText);
    const region = detectRegion(state);
    const impacts = extractImpacts(combinedText);
    const cellCount =
      a.CELLCOUNT !== null && a.CELLCOUNT !== undefined ? Number(a.CELLCOUNT) : null;
    const severity = computeHabSeverity(species, cellCount, impacts);

    results.push({
      id: `habsos-${a.OBJECTID ?? Math.random().toString(36).slice(2)}`,
      description: description || details || 'HAB observation',
      species,
      region,
      state,
      lat: a.Y ?? null,
      lon: a.X ?? null,
      cellCount: cellCount !== null && !isNaN(cellCount) ? cellCount : null,
      sampleDate,
      affectedArea: a.AFFECTED_AREA ?? '',
      impacts,
      severity,
    });
  }

  return results;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractText(xml: string, tag: string): string {
  const cdataRe = new RegExp(String.raw`<${tag}[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/${tag}>`, 'i');
  const plainRe = new RegExp(String.raw`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return (cdataMatch[1] ?? '').trim();
  const plainMatch = xml.match(plainRe);
  if (plainMatch) return stripHtml(plainMatch[1] ?? '').trim();
  return '';
}

function fromRssFallback(xmlText: string): HabObservation[] {
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const results: HabObservation[] = [];
  let idx = 0;

  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xmlText)) !== null) {
    const block = match[1] ?? '';
    const title = extractText(block, 'title');
    const description = extractText(block, 'description');
    extractText(block, 'link'); // consume link field (not used directly)
    const pubDateStr = extractText(block, 'pubDate');

    const sampleDate = pubDateStr ? new Date(pubDateStr) : new Date();
    if (isNaN(sampleDate.getTime()) || sampleDate.getTime() < cutoff) continue;

    const combinedText = title + ' ' + description;
    const species = detectSpecies(null, combinedText);
    const impacts = extractImpacts(combinedText);
    const severity = computeHabSeverity(species, null, impacts);

    // Try to detect state from title/description
    const stateMatch = /\b([A-Z]{2})\b/.exec(combinedText);
    const state = stateMatch ? (stateMatch[1] ?? '') : '';
    const region = state ? detectRegion(state) : 'Other';

    results.push({
      id: `habsos-rss-${idx++}-${sampleDate.getTime()}`,
      description: title || description || 'HAB bulletin',
      species,
      region,
      state,
      lat: null,
      lon: null,
      cellCount: null,
      sampleDate,
      affectedArea: '',
      impacts,
      severity,
    });
  }

  return results;
}

const SEVERITY_ORDER: Record<HabObservation['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function fetchHabObservations(): Promise<HabObservation[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data;

  let observations: HabObservation[] = [];

  // Try ESRI Feature Service first
  try {
    const res = await fetch(ESRI_URL, { signal: AbortSignal.timeout(12_000) });
    if (res.ok) {
      const json: EsriResponse = await res.json();
      if (Array.isArray(json.features) && json.features.length > 0) {
        observations = fromEsriFeatures(json.features);
      }
    }
  } catch {
    // fall through to RSS
  }

  // Fallback to RSS if ESRI returned nothing
  if (observations.length === 0) {
    try {
      const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(RSS_FALLBACK_URL)}`;
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12_000) });
      if (res.ok) {
        const xmlText = await res.text();
        observations = fromRssFallback(xmlText);
      }
    } catch {
      return cache?.data ?? [];
    }
  }

  if (observations.length === 0) return cache?.data ?? [];

  observations.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return b.sampleDate.getTime() - a.sampleDate.getTime();
  });

  const data = observations.slice(0, 40);
  cache = { data, ts: Date.now() };
  return data;
}

export function habSeverityClass(severity: HabObservation['severity']): string {
  switch (severity) {
    case 'critical': { return 'eq-row eq-major';
    }
    case 'high': { return 'eq-row eq-strong';
    }
    case 'medium': { return 'eq-row eq-moderate';
    }
    case 'low': { return 'eq-row';
    }
  }
}

export function habRegionLabel(region: HabRegion): string {
  return region;
}
