/**
 * Adversary and rival nation defense/military news feeds.
 *
 * Sources: Russian MoD, Chinese PLA Daily, TASS, Xinhua, RT.
 * TASS/RT/Xinhua are general news agencies — additional military keyword
 * filter applied. All fetched through /api/rss-proxy.
 *
 * Keeps last 7 days. Deduplicated by normalized title. Limit 50.
 * Cache TTL: 15 minutes.
 */

export type MilNewsSource = 'Russia-MoD' | 'China-PLA' | 'TASS' | 'Xinhua' | 'RT' | 'Other';

export interface ForeignMilNewsItem {
  id: string;
  title: string;
  description: string;
  source: MilNewsSource;
  country: 'Russia' | 'China' | 'Other';
  category: 'exercise' | 'deployment' | 'weapon-test' | 'operation' | 'warning' | 'diplomatic' | 'general';
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

interface FeedConfig {
  url: string;
  source: MilNewsSource;
  country: ForeignMilNewsItem['country'];
  /** General news agencies that need the extra military keyword filter */
  requiresMilFilter: boolean;
}

const FEEDS: FeedConfig[] = [
  { url: 'https://eng.mil.ru/en/news/rss.htm',                      source: 'Russia-MoD', country: 'Russia', requiresMilFilter: false },
  { url: 'https://english.chinamil.com.cn/rss/pladailynews.xml',    source: 'China-PLA',  country: 'China',  requiresMilFilter: false },
  { url: 'https://tass.com/rss/v2.xml',                             source: 'TASS',       country: 'Russia', requiresMilFilter: true  },
  { url: 'https://www.xinhuanet.com/english/rss/militarynews.xml',  source: 'Xinhua',     country: 'China',  requiresMilFilter: true  },
  { url: 'https://www.rt.com/rss/news/',                            source: 'RT',         country: 'Russia', requiresMilFilter: true  },
];

const CACHE_TTL_MS = 15 * 60 * 1000;

interface MilCache {
  items: ForeignMilNewsItem[];
  fetchedAt: number;
}

let _cache: MilCache | null = null;

const MILITARY_KEYWORDS = /military|army|navy|air force|missile|nuclear|weapon|exercise|drill|troops|soldier|combat|submarine|warship|hypersonic|strategic|defense|deterrence|conflict|operation|deploy|patrol/i;

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

function detectCategory(title: string, description: string): ForeignMilNewsItem['category'] {
  const combined = (title + ' ' + description).toLowerCase();

  if (/\btest\b|launch test|icbm test|hypersonic test|nuclear test/.test(combined)) return 'weapon-test';
  if (/exercise|drill|maneuver|wargame/.test(combined)) return 'exercise';
  if (/deploy|deployment|naval group|carrier group|troops to|forces to/.test(combined)) return 'deployment';
  if (/\boperation\b|combat mission|strike|destroy|eliminate/.test(combined)) return 'operation';
  if (/warning|threat|respond to|consequences|red line|ultimatum/.test(combined)) return 'warning';
  if (/summit|agreement|bilateral|alliance|partner/.test(combined)) return 'diplomatic';
  return 'general';
}

function detectSeverity(
  category: ForeignMilNewsItem['category'],
  title: string,
  description: string,
): ForeignMilNewsItem['severity'] {
  const combined = title + ' ' + description;

  if (/nuclear/i.test(combined)) return 'critical';
  if (category === 'weapon-test') return 'critical';
  if (category === 'operation' || category === 'warning') return 'high';
  if (category === 'deployment') return 'medium';
  return 'low';
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
}

interface ParsedRawItem {
  title: string;
  description: string;
  link: string;
  pubDateStr: string;
}

function parseRssAndAtom(doc: Document): ParsedRawItem[] {
  const results: ParsedRawItem[] = [];

  // RSS <item>
  for (const item of Array.from(doc.querySelectorAll('item'))) {
    const title = item.querySelector('title')?.textContent?.trim() ?? '';
    const description = stripHtml(item.querySelector('description')?.textContent ?? '');
    const link = item.querySelector('link')?.textContent?.trim() ?? '';
    const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';
    results.push({ title, description, link, pubDateStr });
  }

  // Atom <entry>
  for (const entry of Array.from(doc.querySelectorAll('entry'))) {
    const title = entry.querySelector('title')?.textContent?.trim() ?? '';
    const rawContent = entry.querySelector('content')?.textContent
      ?? entry.querySelector('summary')?.textContent
      ?? '';
    const description = stripHtml(rawContent);
    const linkEl = entry.querySelector('link[rel="alternate"], link');
    const link = linkEl?.getAttribute('href') ?? entry.querySelector('link')?.textContent?.trim() ?? '';
    const pubDateStr = entry.querySelector('published')?.textContent?.trim()
      ?? entry.querySelector('updated')?.textContent?.trim()
      ?? '';
    results.push({ title, description, link, pubDateStr });
  }

  return results;
}

async function fetchFeedItems(config: FeedConfig): Promise<ForeignMilNewsItem[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(config.url)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const rawItems = parseRssAndAtom(doc);
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const items: ForeignMilNewsItem[] = [];

    for (const raw of rawItems) {
      const combined = raw.title + ' ' + raw.description;

      // All items must pass military keyword check
      if (!MILITARY_KEYWORDS.test(combined)) continue;

      const pubDate = raw.pubDateStr ? new Date(raw.pubDateStr) : new Date();
      if (Number.isNaN(pubDate.getTime()) || pubDate.getTime() < cutoff) continue;

      const category = detectCategory(raw.title, raw.description);
      const severity = detectSeverity(category, raw.title, raw.description);
      const normTitle = normalizeTitle(raw.title);

      items.push({
        id: `fmn-${config.source.toLowerCase()}-${normTitle}`,
        title: raw.title,
        description: raw.description.slice(0, 400),
        source: config.source,
        country: config.country,
        category,
        pubDate,
        url: raw.link,
        severity,
      });
    }

    return items;
  } catch {
    return [];
  }
}

const SEVERITY_ORDER: Record<ForeignMilNewsItem['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function fetchForeignMilNews(): Promise<ForeignMilNewsItem[]> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.items;
  }

  const results = await Promise.allSettled(
    FEEDS.map(config => fetchFeedItems(config)),
  );

  const combined: ForeignMilNewsItem[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      combined.push(...result.value);
    }
  }

  // Deduplicate by normalized title (across sources)
  const seen = new Set<string>();
  const deduped: ForeignMilNewsItem[] = [];
  for (const item of combined) {
    const key = normalizeTitle(item.title);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }

  // Sort by severity then date desc
  deduped.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.pubDate.getTime() - a.pubDate.getTime();
  });

  const items = deduped.slice(0, 50);
  _cache = { items, fetchedAt: Date.now() };
  return items;
}

export function foreignMilSeverityClass(severity: ForeignMilNewsItem['severity']): string {
  switch (severity) {
    case 'critical': return 'text-red-500';
    case 'high':     return 'text-orange-500';
    case 'medium':   return 'text-yellow-500';
    default:         return 'text-gray-400';
  }
}
