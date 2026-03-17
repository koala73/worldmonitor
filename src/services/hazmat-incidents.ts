/**
 * Chemical, biological, radiological and hazardous material incidents
 *
 * Sources:
 *  - PHMSA (Pipeline and Hazardous Materials Safety Administration):
 *    Real-time incident reports for pipeline/hazmat releases
 *    https://www.phmsa.dot.gov/data-and-statistics/pipeline/incidents-data
 *  - EPA Environmental Justice / Emergency Response news (RSS via rss-proxy)
 *    https://www.epa.gov/rss/epa-emergency-response-removals.xml
 *  - CSB (Chemical Safety Board) incident list:
 *    https://www.csb.gov/investigations/rss/ — RSS of investigation reports
 *
 * All sources are US-focused; international coverage comes from GDACS
 * and the IAEA/NRC nuclear services.
 */

export interface HazmatIncident {
  id: string;
  title: string;
  description: string;
  location: string;
  state: string;
  lat: number | null;
  lon: number | null;
  chemical: string;
  incidentType: 'pipeline' | 'rail' | 'highway' | 'facility' | 'chemical' | 'biological' | 'unknown';
  source: 'PHMSA' | 'EPA' | 'CSB' | 'NRC';
  reportedAt: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// EPA Emergency Response removals RSS
const EPA_EMERGENCY_RSS = 'https://www.epa.gov/rss/epa-newsroom.xml';
// CSB investigation reports RSS
const CSB_RSS = 'https://www.csb.gov/investigations/rss/';
// PHMSA has a data portal but no real-time RSS; use their news RSS
const PHMSA_RSS = 'https://www.phmsa.dot.gov/rss.xml';

const CACHE_TTL_MS = 20 * 60 * 1000;
let cache: { incidents: HazmatIncident[]; fetchedAt: number } | null = null;

const HAZMAT_KEYWORDS = [
  'hazmat', 'hazardous', 'chemical', 'toxic', 'spill', 'release', 'leak',
  'explosion', 'fire', 'pipeline', 'derailment', 'train', 'tanker',
  'chlorine', 'ammonia', 'hydrogen', 'methane', 'propane', 'sulfur',
  'acid', 'contamination', 'evacuation', 'shelter in place',
  'biological', 'pathogen', 'remediation', 'cleanup', 'superfund',
];

function isHazmatEvent(title: string, description: string): boolean {
  const text = (title + ' ' + description).toLowerCase();
  return HAZMAT_KEYWORDS.some(k => text.includes(k));
}

function detectChemical(title: string, description: string): string {
  const text = title + ' ' + description;
  const chemicals = [
    'chlorine', 'ammonia', 'hydrogen sulfide', 'benzene', 'methane',
    'propane', 'butane', 'sulfuric acid', 'hydrochloric acid', 'nitric acid',
    'phosphine', 'vinyl chloride', 'ethylene oxide', 'formaldehyde',
    'anhydrous ammonia', 'natural gas', 'crude oil', 'LNG', 'LPG',
  ];
  for (const c of chemicals) {
    if (text.toLowerCase().includes(c.toLowerCase())) return c;
  }
  return 'Unknown substance';
}

function detectIncidentType(title: string, description: string): HazmatIncident['incidentType'] {
  const text = (title + ' ' + description).toLowerCase();
  if (text.includes('pipeline') || text.includes('pipe')) return 'pipeline';
  if (text.includes('train') || text.includes('rail') || text.includes('derailment')) return 'rail';
  if (text.includes('truck') || text.includes('highway') || text.includes('motor carrier')) return 'highway';
  if (text.includes('plant') || text.includes('facility') || text.includes('factory')) return 'facility';
  if (text.includes('biological') || text.includes('pathogen')) return 'biological';
  if (text.includes('chemical')) return 'chemical';
  return 'unknown';
}

function scoreSeverity(title: string, description: string): HazmatIncident['severity'] {
  const text = (title + ' ' + description).toLowerCase();
  if (/\b(explosion|mass casualty|fatality|deaths?|killed|evacuation)\b/.test(text)) return 'critical';
  if (/\b(spill|release|leak|fire|injury|injuries|contamination|shelter)\b/.test(text)) return 'high';
  if (/\b(investigation|incident|report|response|cleanup|remediation)\b/.test(text)) return 'medium';
  return 'low';
}

function extractState(text: string): string {
  const stateMatch = text.match(/\b([A-Z]{2})\b(?=\s*\d{5}|,\s+USA?|,\s+United States)/);
  if (stateMatch?.[1]) return stateMatch[1];
  const states = [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado',
    'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho',
    'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana',
    'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
    'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
    'New Hampshire', 'New Jersey', 'New Mexico', 'New York',
    'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
    'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
    'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
    'West Virginia', 'Wisconsin', 'Wyoming',
  ];
  for (const s of states) {
    if (text.includes(s)) return s;
  }
  return '';
}

async function fetchRss(feedUrl: string, source: HazmatIncident['source']): Promise<HazmatIncident[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const items = doc.querySelectorAll('item');
    const incidents: HazmatIncident[] = [];

    for (const item of Array.from(items)) {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const description = (item.querySelector('description')?.textContent ?? '').replace(/<[^>]+>/g, '').trim();
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';

      if (!isHazmatEvent(title, description)) continue;

      const fullText = title + ' ' + description;
      incidents.push({
        id: `hazmat-${source.toLowerCase()}-${title.replace(/\W/g, '').slice(0, 20)}`,
        title,
        description: description.slice(0, 400),
        location: '',
        state: extractState(fullText),
        lat: null,
        lon: null,
        chemical: detectChemical(title, description),
        incidentType: detectIncidentType(title, description),
        source,
        reportedAt: pubDateStr ? new Date(pubDateStr) : new Date(),
        url: link,
        severity: scoreSeverity(title, description),
      });
    }

    return incidents;
  } catch {
    return [];
  }
}

export async function fetchHazmatIncidents(): Promise<HazmatIncident[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.incidents;

  const [epaResult, csbResult, phmsaResult] = await Promise.allSettled([
    fetchRss(EPA_EMERGENCY_RSS, 'EPA'),
    fetchRss(CSB_RSS, 'CSB'),
    fetchRss(PHMSA_RSS, 'PHMSA'),
  ]);

  const combined = [
    ...(epaResult.status === 'fulfilled' ? epaResult.value : []),
    ...(csbResult.status === 'fulfilled' ? csbResult.value : []),
    ...(phmsaResult.status === 'fulfilled' ? phmsaResult.value : []),
  ];

  // Dedupe by title
  const seen = new Set<string>();
  const deduped: HazmatIncident[] = [];
  for (const i of combined.sort((a, b) => b.reportedAt.getTime() - a.reportedAt.getTime())) {
    const key = i.title.toLowerCase().replace(/\W/g, '').slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(i);
    }
  }

  const recent = deduped
    .filter(i => Date.now() - i.reportedAt.getTime() < 30 * 24 * 3600_000)
    .slice(0, 50);

  cache = { incidents: recent, fetchedAt: Date.now() };
  return recent;
}

export function hazmatSeverityClass(severity: HazmatIncident['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high: 'eq-row eq-strong',
    medium: 'eq-row eq-moderate',
    low: 'eq-row',
  }[severity] ?? 'eq-row';
}
