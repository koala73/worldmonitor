/**
 * IAEA (International Atomic Energy Agency) nuclear safety news
 * Free RSS feed — no authentication required
 * https://www.iaea.org/newscenter/news/rss
 *
 * Covers global nuclear and radiological events: reactor incidents,
 * radiological emergencies, INES-rated events, safety alerts.
 * Complements the US-only NRC nuclear service with global coverage.
 */

export interface IaeaEvent {
  id: string;
  title: string;
  description: string;
  pubDate: Date;
  url: string;
  category: 'reactor' | 'radiological' | 'waste' | 'safeguards' | 'safety' | 'general';
  severity: 'critical' | 'high' | 'medium' | 'low';
  country: string;
}

const IAEA_NEWS_RSS = 'https://www.iaea.org/newscenter/news/rss';
const IAEA_PRESSRELEASE_RSS = 'https://www.iaea.org/newscenter/pressreleases/rss';
const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { events: IaeaEvent[]; fetchedAt: number } | null = null;

function rssProxyUrl(feedUrl: string): string {
  return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
}

const NUCLEAR_SAFETY_KEYWORDS = [
  'nuclear', 'radiolog', 'reactor', 'radiation', 'radioactive', 'ines',
  'incident', 'emergency', 'accident', 'contamination', 'leak', 'release',
  'fuel', 'waste', 'spent fuel', 'criticality', 'safeguards', 'enrichment',
  'weapons', 'dirty bomb', 'radiological dispersal', 'orphan source',
];

function isRelevantEvent(title: string, description: string): boolean {
  const text = (title + ' ' + description).toLowerCase();
  return NUCLEAR_SAFETY_KEYWORDS.some(k => text.includes(k));
}

function detectCategory(title: string, description: string): IaeaEvent['category'] {
  const text = (title + ' ' + description).toLowerCase();
  if (text.includes('reactor') || text.includes('power plant') || text.includes('nuclear plant')) return 'reactor';
  if (text.includes('radiolog') || text.includes('radioactive') || text.includes('contamination') || text.includes('orphan')) return 'radiological';
  if (text.includes('waste') || text.includes('spent fuel') || text.includes('disposal')) return 'waste';
  if (text.includes('safeguard') || text.includes('weapons') || text.includes('enrich') || text.includes('proliferat')) return 'safeguards';
  if (text.includes('safety') || text.includes('ines') || text.includes('incident')) return 'safety';
  return 'general';
}

function scoreSeverity(title: string, description: string): IaeaEvent['severity'] {
  const text = (title + ' ' + description).toLowerCase();
  if (/\b(meltdown|explosion|ines level [4-7]|level [4-7]|major accident|emergency|radiological emergency|weapons|dirty bomb)\b/.test(text)) return 'critical';
  if (/\b(incident|ines|leak|release|contamination|accident|shutdown|scram|significant)\b/.test(text)) return 'high';
  if (/\b(warning|alert|concern|safety|inspection|violation)\b/.test(text)) return 'medium';
  return 'low';
}

function extractCountry(title: string, description: string): string {
  const text = title + ' ' + description;
  const parenMatch = /\(([A-Z][a-zA-Z\s]+)\)/.exec(text);
  if (parenMatch?.[1]) return parenMatch[1].trim();
  const inMatch = /\bin\s+([A-Z][a-zA-Z\s]+?)(?:\s*[-–,.]|\s*$)/.exec(text);
  if (inMatch?.[1]) return inMatch[1].trim();
  return 'Unknown';
}

async function fetchFeed(feedUrl: string): Promise<IaeaEvent[]> {
  try {
    const res = await fetch(rssProxyUrl(feedUrl), { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const items = doc.querySelectorAll('item');
    const events: IaeaEvent[] = [];

    for (const item of items) {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const description = (item.querySelector('description')?.textContent ?? '').replace(/<[^>]+>/g, '').trim();
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';

      if (!isRelevantEvent(title, description)) continue;

      events.push({
        id: `iaea-${link.split('/').pop() ?? title.slice(0, 20).replace(/\W/g, '-')}`,
        title,
        description: description.slice(0, 500),
        pubDate: pubDateStr ? new Date(pubDateStr) : new Date(),
        url: link,
        category: detectCategory(title, description),
        severity: scoreSeverity(title, description),
        country: extractCountry(title, description),
      });
    }

    return events;
  } catch {
    return [];
  }
}

export async function fetchIaeaEvents(): Promise<IaeaEvent[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.events;

  const [newsResult, prResult] = await Promise.allSettled([
    fetchFeed(IAEA_NEWS_RSS),
    fetchFeed(IAEA_PRESSRELEASE_RSS),
  ]);

  const combined = [
    ...(newsResult.status === 'fulfilled' ? newsResult.value : []),
    ...(prResult.status === 'fulfilled' ? prResult.value : []),
  ];

  // Dedupe by URL
  const seen = new Set<string>();
  const deduped: IaeaEvent[] = [];
  for (const e of combined.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())) {
    if (!seen.has(e.url)) {
      seen.add(e.url);
      deduped.push(e);
    }
  }

  // Keep last 30 days
  const recent = deduped
    .filter(e => Date.now() - e.pubDate.getTime() < 30 * 24 * 3_600_000)
    .slice(0, 40);

  cache = { events: recent, fetchedAt: Date.now() };
  return recent;
}

export function iaeaSeverityClass(severity: IaeaEvent['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high: 'eq-row eq-strong',
    medium: 'eq-row eq-moderate',
    low: 'eq-row',
  }[severity] ?? 'eq-row';
}
