export type AlliedCountry = 'UK' | 'NATO' | 'Australia' | 'Canada' | 'EU' | 'IISS' | 'Other';

export interface AlliedMilitaryItem {
  id: string;
  title: string;
  description: string;
  country: AlliedCountry;
  category: 'operation' | 'exercise' | 'procurement' | 'diplomatic' | 'advisory' | 'general';
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  region: string;
}

interface AlliedFeed {
  country: AlliedCountry;
  url: string;
  isAtom?: boolean;
}

const FEEDS: AlliedFeed[] = [
  { country: 'UK',        url: 'https://www.gov.uk/search/news-and-communications.atom?organisations%5B%5D=ministry-of-defence', isAtom: true },
  { country: 'NATO',      url: 'https://www.nato.int/cps/en/natolive/news_rss.htm' },
  { country: 'Australia', url: 'https://www.minister.defence.gov.au/rss.xml' },
  { country: 'Canada',    url: 'https://www.canada.ca/en/department-national-defence/news.atom', isAtom: true },
  { country: 'EU',        url: 'https://www.eeas.europa.eu/eeas/rss_en' },
  { country: 'IISS',      url: 'https://www.iiss.org/rss' },
  { country: 'Other',     url: 'https://www.janes.com/defence-news/rss' },
];

const CACHE_TTL_MS = 15 * 60 * 1000;

interface Cache {
  items: AlliedMilitaryItem[];
  ts: number;
}

let _cache: Cache | null = null;

function proxyFeedUrl(feedUrl: string): string {
  return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const MILITARY_KEYWORDS = /military|defen[cs]e|troops|navy|army|air force|missile|nato|alliance|security|combat|weapon|aircraft|vessel|strike|conflict|war|deploy|sanction/i;

function detectCategory(text: string): AlliedMilitaryItem['category'] {
  const t = text.toLowerCase();
  if (/contract|purchase|procure|acquire|f-35|submarine|frigate|tank/.test(t)) return 'procurement';
  if (/summit|treaty|agreement|bilateral|minister|ambassador/.test(t)) return 'diplomatic';
  if (/exercise|training|drill|maneuver/.test(t)) return 'exercise';
  if (/deploy|redeploy|positioned|forward|operation|mission/.test(t)) return 'operation';
  if (/warning|alert|threat|escalat/.test(t)) return 'advisory';
  return 'general';
}

function detectSeverity(category: AlliedMilitaryItem['category'], text: string): AlliedMilitaryItem['severity'] {
  const t = text.toLowerCase();
  if (/\bwar\b|invasion|attack|conflict escalat/.test(t)) return 'critical';
  switch (category) {
    case 'operation':
    case 'advisory': {
      return /combat|strike|attack|conflict/.test(t) ? 'high' : 'medium';
    }
    case 'exercise': {
      return 'medium';
    }
    case 'procurement':
    case 'diplomatic':
    case 'general':
    default: {
      return 'low';
    }
  }
}

function detectRegion(text: string): string {
  const t = text.toLowerCase();
  if (/iraq|syria|iran|yemen|gaza|lebanon|jordan|kuwait|qatar|bahrain/.test(t)) return 'Middle East';
  if (/china|taiwan|korea|japan|philippines|australia|pacific|indo-pacific/.test(t)) return 'Indo-Pacific';
  if (/ukraine|russia|nato|europe|baltic|poland/.test(t)) return 'Europe';
  if (/africa|somalia|sahel|sudan|mali|niger/.test(t)) return 'Africa';
  if (/venezuela|haiti|caribbean|south america|mexico/.test(t)) return 'Americas';
  return 'Global';
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\W/g, '');
}

function parseFeed(xmlText: string, feed: AlliedFeed): AlliedMilitaryItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return [];

  // Auto-detect format: try RSS items first, fall back to Atom entries
  let items = [...doc.querySelectorAll('item')];
  const isAtom = items.length === 0 || feed.isAtom === true;
  if (isAtom) items = [...doc.querySelectorAll('entry')];

  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;

  return items.flatMap((item): AlliedMilitaryItem[] => {
    const titleRaw = item.querySelector('title')?.textContent?.trim() ?? '';

    let link = '';
    if (isAtom) {
      const linkEl = item.querySelector('link[href]');
      link = linkEl?.getAttribute('href') ?? '';
      if (!link) link = item.querySelector('link')?.textContent?.trim() ?? '';
    } else {
      link = item.querySelector('link')?.textContent?.trim() ?? '';
    }

    const descRaw = isAtom
      ? (item.querySelector('summary')?.textContent ?? item.querySelector('content')?.textContent ?? '')
      : (item.querySelector('description')?.textContent ?? '');

    const pubDateStr = isAtom
      ? (item.querySelector('updated')?.textContent ?? item.querySelector('published')?.textContent ?? '')
      : (item.querySelector('pubDate')?.textContent ?? '');

    const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
    if (Number.isNaN(pubDate.getTime()) || pubDate.getTime() < cutoff) return [];

    const title       = stripHtml(titleRaw);
    const description = stripHtml(descRaw);
    const combined    = `${title} ${description}`;

    // Relevance filter: must mention at least one military keyword
    if (!MILITARY_KEYWORDS.test(combined)) return [];

    const category = detectCategory(combined);
    const severity = detectSeverity(category, combined);
    const region   = detectRegion(combined);
    const id       = `${feed.country}-${link || title}-${pubDate.getTime()}`;

    return [{
      id,
      title,
      description,
      country: feed.country,
      category,
      pubDate,
      url: link,
      severity,
      region,
    }];
  });
}

export async function fetchAlliedMilitary(): Promise<AlliedMilitaryItem[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.items;

  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const res = await fetch(proxyFeedUrl(feed.url), {
        signal: AbortSignal.timeout(12_000),
        headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      });
      if (!res.ok) return [] as AlliedMilitaryItem[];
      const text = await res.text();
      return parseFeed(text, feed);
    }),
  );

  const all: AlliedMilitaryItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  // Deduplicate by normalized title
  const seen = new Set<string>();
  const deduped = all.filter(item => {
    const key = normalizeTitle(item.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by pubDate desc
  deduped.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  const items = deduped.slice(0, 50);
  _cache = { items, ts: Date.now() };
  return items;
}

export function alliedSeverityClass(severity: AlliedMilitaryItem['severity']): string {
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
