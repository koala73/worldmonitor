/**
 * PHMSA Pipeline Safety Incidents and Advisories
 * Sources: PHMSA and DOT RSS feeds via rss-proxy
 */

export type PipelineType =
  | 'gas-transmission'
  | 'gas-distribution'
  | 'hazardous-liquid'
  | 'lng'
  | 'other';

export type PipelineIncidentCause =
  | 'corrosion'
  | 'excavation-damage'
  | 'natural-force'
  | 'equipment-failure'
  | 'incorrect-operation'
  | 'other-outside-force'
  | 'unknown';

export interface PipelineIncident {
  id: string;
  title: string;
  description: string;
  pipelineType: PipelineType;
  cause: PipelineIncidentCause;
  state: string;
  location: string;
  pubDate: Date;
  url: string;
  fatalities: number;
  injuries: number;
  evacuations: number;
  propertyDamageK: number | null; // thousands of dollars
  ignition: boolean;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const PHMSA_FEEDS = [
  'https://www.phmsa.dot.gov/news/rss',
  'https://www.transportation.gov/briefing-room/pipeline-safety/rss',
  'https://www.phmsa.dot.gov/news/safety-advisories/rss',
];

const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
let cache: { data: PipelineIncident[]; ts: number } | null = null;

const RELEVANCE_KEYWORDS = [
  'pipeline',
  'gas leak',
  'rupture',
  'incident',
  'explosion',
  'spill',
  'PHMSA',
  'DOT',
  'emergency order',
  'advisory',
];

function rssProxyUrl(feedUrl: string): string {
  return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
}

function detectPipelineType(text: string): PipelineType {
  const lower = text.toLowerCase();
  if (lower.includes('lng') || lower.includes('liquefied natural gas')) return 'lng';
  if (
    lower.includes('gas transmission') ||
    lower.includes('natural gas') ||
    lower.includes('interstate pipeline')
  ) {
    return 'gas-transmission';
  }
  if (
    lower.includes('gas distribution') ||
    lower.includes('local distribution') ||
    lower.includes('service line')
  ) {
    return 'gas-distribution';
  }
  if (
    lower.includes('hazardous liquid') ||
    lower.includes('crude oil') ||
    lower.includes('petroleum') ||
    lower.includes('refined product')
  ) {
    return 'hazardous-liquid';
  }
  return 'other';
}

function detectCause(text: string): PipelineIncidentCause {
  const lower = text.toLowerCase();
  if (lower.includes('corrosion') || lower.includes('rust') || lower.includes('deteriorat')) {
    return 'corrosion';
  }
  if (
    lower.includes('excavation') ||
    lower.includes('dig-in') ||
    lower.includes('third-party') ||
    lower.includes('struck by')
  ) {
    return 'excavation-damage';
  }
  if (
    lower.includes('flood') ||
    lower.includes('earthquake') ||
    lower.includes('landslide') ||
    lower.includes('erosion') ||
    lower.includes('weather')
  ) {
    return 'natural-force';
  }
  if (
    lower.includes('valve') ||
    lower.includes('weld') ||
    lower.includes('fitting') ||
    lower.includes('material failure') ||
    lower.includes('mechanical')
  ) {
    return 'equipment-failure';
  }
  if (
    lower.includes('operator error') ||
    lower.includes('human error') ||
    lower.includes('incorrect')
  ) {
    return 'incorrect-operation';
  }
  return 'unknown';
}

function extractNumber(text: string, pattern: RegExp): number {
  const m = text.match(pattern);
  return m?.[1] ? Number.parseInt(m[1], 10) : 0;
}

function detectIgnition(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('fire') ||
    lower.includes('explosion') ||
    lower.includes('ignite') ||
    lower.includes('flame')
  );
}

function extractState(text: string): string {
  // Look for US state abbreviations in context
  const m = /\b([A-Z]{2})\b/.exec(text);
  return m?.[1] ? m[1] : '';
}

function computeSeverity(
  fatalities: number,
  injuries: number,
  evacuations: number,
  ignition: boolean,
  title: string,
): PipelineIncident['severity'] {
  if (fatalities > 0 || ignition) return 'critical';
  if (injuries > 0 || evacuations > 0) return 'high';
  const lower = title.toLowerCase();
  if (lower.includes('advisory') || lower.includes('safety order') || lower.includes('emergency')) {
    return 'medium';
  }
  return 'low';
}

function isRelevant(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return RELEVANCE_KEYWORDS.some((kw) => text.toLowerCase().includes(kw.toLowerCase()));
}

function titleHash(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = ((h << 5) - h + title.charCodeAt(i)) | 0;
  }
  return `phmsa-${Math.abs(h)}`;
}

function parseFeedXml(text: string, _feedUrl: string): PipelineIncident[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) return [];

  let items = doc.querySelectorAll('item');
  const isAtom = items.length === 0;
  if (isAtom) items = doc.querySelectorAll('entry');

  const results: PipelineIncident[] = [];

  [...items].forEach((item) => {
    const title = item.querySelector('title')?.textContent?.trim() ?? '';
    const description =
      item.querySelector('description')?.textContent?.trim() ??
      item.querySelector('summary')?.textContent?.trim() ??
      '';
    let url = '';
    url = isAtom ? item.querySelector('link[href]')?.getAttribute('href') ?? '' : item.querySelector('link')?.textContent?.trim() ?? '';

    const pubDateStr = isAtom
      ? (item.querySelector('updated')?.textContent ?? item.querySelector('published')?.textContent ?? '')
      : (item.querySelector('pubDate')?.textContent ?? '');
    const parsed = pubDateStr ? new Date(pubDateStr) : new Date();
    const pubDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

    if (!isRelevant(title, description)) return;

    const combined = `${title} ${description}`;
    const pipelineType = detectPipelineType(combined);
    const cause = detectCause(combined);
    const fatalities = extractNumber(combined, /(\d+)\s*(?:fatali|death|dead)/i);
    const injuries = extractNumber(combined, /(\d+)\s*(?:injur|wound)/i);
    const evacuations = extractNumber(combined, /(\d+)\s*(?:evacuat)/i);
    const ignition = detectIgnition(combined);
    const severity = computeSeverity(fatalities, injuries, evacuations, ignition, title);
    const state = extractState(combined);

    results.push({
      id: titleHash(title),
      title,
      description,
      pipelineType,
      cause,
      state,
      location: state,
      pubDate,
      url,
      fatalities,
      injuries,
      evacuations,
      propertyDamageK: null,
      ignition,
      severity,
    });
  });

  return results;
}

export async function fetchPipelineIncidents(): Promise<PipelineIncident[]> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.data;

  const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000);

  const results = await Promise.allSettled(
    PHMSA_FEEDS.map(async (feedUrl) => {
      const res = await fetch(rssProxyUrl(feedUrl), {
        signal: AbortSignal.timeout(12_000),
        headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      });
      if (!res.ok) return [] as PipelineIncident[];
      const text = await res.text();
      return parseFeedXml(text, feedUrl);
    }),
  );

  const all: PipelineIncident[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  // Deduplicate by id (title hash)
  const seen = new Set<string>();
  const deduped = all.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  const severityOrder: Record<PipelineIncident['severity'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  const filtered = deduped
    .filter((a) => a.pubDate >= sixtyDaysAgo)
    .sort((a, b) => {
      const sd = severityOrder[a.severity] - severityOrder[b.severity];
      if (sd !== 0) return sd;
      return b.pubDate.getTime() - a.pubDate.getTime();
    })
    .slice(0, 30);

  cache = { data: filtered, ts: now };
  return filtered;
}

export function pipelineSeverityClass(severity: PipelineIncident['severity']): string {
  switch (severity) {
    case 'critical': {
      return 'eq-row eq-major';
    }
    case 'high': {
      return 'eq-row eq-strong';
    }
    case 'medium': {
      return 'eq-row eq-moderate';
    }
    case 'low': {
      return 'eq-row';
    }
    default: {
      return 'eq-row';
    }
  }
}
