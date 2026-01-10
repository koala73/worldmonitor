import type { SocialUnrestEvent, ProtestSeverity } from '@/types';
import { PROTEST_FEEDS, PROTEST_LOCATIONS } from '@/config';
import { fetchCategoryFeeds } from './rss';
import { generateId } from '@/utils';

const SEVERITY_KEYWORDS: Record<ProtestSeverity, string[]> = {
  high: ['clash', 'riot', 'violence', 'deadly', 'shooting', 'arson', 'killed', 'looting'],
  medium: ['strike', 'march', 'blockade', 'shutdown', 'rally', 'protest'],
  low: ['demonstration', 'sit-in', 'petition', 'walkout'],
};

const TAG_KEYWORDS: Record<string, string[]> = {
  labor: ['strike', 'union', 'walkout', 'wage'],
  fuel: ['fuel', 'gas', 'petrol', 'diesel'],
  transport: ['transport', 'metro', 'rail', 'bus', 'airport', 'port'],
  politics: ['election', 'opposition', 'government', 'parliament'],
  inflation: ['inflation', 'cost of living', 'prices'],
  education: ['student', 'tuition', 'campus'],
  security: ['police', 'security forces', 'military'],
};

function pickSeverity(title: string): ProtestSeverity {
  const lower = title.toLowerCase();
  if (SEVERITY_KEYWORDS.high.some((kw) => lower.includes(kw))) return 'high';
  if (SEVERITY_KEYWORDS.medium.some((kw) => lower.includes(kw))) return 'medium';
  return 'low';
}

function extractTags(title: string): string[] {
  const lower = title.toLowerCase();
  return Object.entries(TAG_KEYWORDS)
    .filter(([, keywords]) => keywords.some((kw) => lower.includes(kw)))
    .map(([tag]) => tag);
}

function matchLocation(title: string) {
  const lower = title.toLowerCase();
  return PROTEST_LOCATIONS.find((location) =>
    location.keywords.some((kw) => lower.includes(kw.toLowerCase()))
  );
}

export async function fetchProtestEvents(): Promise<SocialUnrestEvent[]> {
  const items = await fetchCategoryFeeds(PROTEST_FEEDS);
  const events: SocialUnrestEvent[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const location = matchLocation(item.title);
    if (!location) continue;

    const key = `${location.id}:${item.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    events.push({
      id: generateId(),
      title: item.title,
      city: location.city,
      country: location.country,
      lat: location.lat,
      lon: location.lon,
      time: item.pubDate,
      severity: pickSeverity(item.title),
      sources: [item.source],
      tags: extractTags(item.title),
      relatedHotspots: location.relatedHotspots,
    });
  }

  return events;
}
