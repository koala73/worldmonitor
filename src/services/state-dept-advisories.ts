/**
 * US State Department country-level travel advisories.
 * RSS feeds through /api/rss-proxy
 *
 * Advisory levels:
 *   Level 1 – Exercise Normal Precautions
 *   Level 2 – Exercise Increased Caution
 *   Level 3 – Reconsider Travel
 *   Level 4 – Do Not Travel
 *
 * Only Level 2+ are returned. Deduplicates by country (keeps highest level).
 * Sorted: Level 4 → Level 3 → Level 2. Limit 100. Cache TTL 60 minutes.
 */

export type AdvisoryLevel = 1 | 2 | 3 | 4;

export interface TravelAdvisory {
  id: string;
  country: string;
  level: AdvisoryLevel;
  levelLabel: string;
  summary: string;
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const ADVISORY_RSS_URLS = [
  'https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html/_jcr_content/traveladvisories.html',
  'https://travel.state.gov/content/travel/en/traveladvisories.rss.xml',
];

const CACHE_TTL_MS = 60 * 60 * 1000;

interface AdvisoryCache {
  advisories: TravelAdvisory[];
  fetchedAt: number;
}

let _cache: AdvisoryCache | null = null;

const LEVEL_LABELS: Record<AdvisoryLevel, string> = {
  1: 'Exercise Normal Precautions',
  2: 'Exercise Increased Caution',
  3: 'Reconsider Travel',
  4: 'Do Not Travel',
};

const SEVERITY_MAP: Record<AdvisoryLevel, TravelAdvisory['severity']> = {
  1: 'low',
  2: 'medium',
  3: 'high',
  4: 'critical',
};

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseAdvisoryTitle(title: string): { country: string; level: AdvisoryLevel } | null {
  // Matches: "Chad - Level 3: Reconsider Travel" or with en-dash
  const match = /^(.+?)\s*[-\u2013\u2014]\s*Level\s*(\d)/i.exec(title);
  if (!match) return null;
  const country = match[1]!.trim();
  const levelNum = Number.parseInt(match[2]!, 10);
  if (levelNum < 1 || levelNum > 4) return null;
  return { country, level: levelNum as AdvisoryLevel };
}

async function fetchFeedAdvisories(feedUrl: string): Promise<TravelAdvisory[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const items = [...doc.querySelectorAll('item')];
    const advisories: TravelAdvisory[] = [];

    for (const item of items) {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const parsed = parseAdvisoryTitle(title);
      if (!parsed) continue;

      const { country, level } = parsed;

      // Skip Level 1
      if (level < 2) continue;

      const rawDescription = item.querySelector('description')?.textContent ?? '';
      const summary = stripHtml(rawDescription).slice(0, 300);
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';
      const guid = item.querySelector('guid')?.textContent?.trim() ?? link;

      advisories.push({
        id: `state-advisory-${guid.split('/').pop() ?? country.toLowerCase().replace(/\s+/g, '-')}`,
        country,
        level,
        levelLabel: LEVEL_LABELS[level],
        summary,
        pubDate: pubDateStr ? new Date(pubDateStr) : new Date(),
        url: link,
        severity: SEVERITY_MAP[level],
      });
    }

    return advisories;
  } catch {
    return [];
  }
}

export async function fetchTravelAdvisories(): Promise<TravelAdvisory[]> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.advisories;
  }

  const results = await Promise.allSettled(
    ADVISORY_RSS_URLS.map(url => fetchFeedAdvisories(url)),
  );

  const combined: TravelAdvisory[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      combined.push(...result.value);
    }
  }

  // Deduplicate by country — keep highest level
  const byCountry = new Map<string, TravelAdvisory>();
  for (const advisory of combined) {
    const key = advisory.country.toLowerCase();
    const existing = byCountry.get(key);
    if (!existing || advisory.level > existing.level) {
      byCountry.set(key, advisory);
    }
  }

  // Sort: Level 4 first, then 3, then 2
  const sorted = [...byCountry.values()].sort((a, b) => b.level - a.level);

  const advisories = sorted.slice(0, 100);
  _cache = { advisories, fetchedAt: Date.now() };
  return advisories;
}

export function advisorySeverityClass(severity: TravelAdvisory['severity']): string {
  switch (severity) {
    case 'critical': { return 'text-red-500';
    }
    case 'high': {     return 'text-orange-500';
    }
    case 'medium': {   return 'text-yellow-500';
    }
    default: {         return 'text-gray-400';
    }
  }
}

export function advisoryLevelLabel(level: AdvisoryLevel): string {
  return LEVEL_LABELS[level];
}
