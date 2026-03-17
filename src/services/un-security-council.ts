/**
 * UN Security Council resolutions, press statements, and peace/security news.
 *
 * Three RSS/Atom feeds through /api/rss-proxy. Filters for Security Council
 * relevance, classifies item type, and detects affected region.
 *
 * Keeps last 14 days. Limit 50, sorted by severity then date desc.
 * Cache TTL: 20 minutes.
 */

export type UnScItemType =
  | 'resolution' | 'presidential-statement' | 'press-statement'
  | 'meeting' | 'briefing' | 'sanctions' | 'general';

export interface UnScItem {
  id: string;
  title: string;
  description: string;
  itemType: UnScItemType;
  region: string;
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const FEED_URLS = [
  'https://news.un.org/feed/subscribe/en/news/topic/peace-and-security/feed/rss.xml',
  'https://www.un.org/press/en/rss.xml',
  'https://www.un.org/securitycouncil/sites/www.un.org.securitycouncil/files/rss.xml',
];

const CACHE_TTL_MS = 20 * 60 * 1000;

interface UnScCache {
  items: UnScItem[];
  fetchedAt: number;
}

let _cache: UnScCache | null = null;

// Relevance: must mention one of these OR come from securitycouncil URL
const RELEVANCE_PATTERN = /security council|chapter vii|ceasefire|cease.fire|resolution|sanctions|peacekeeping|veto|emergency session/i;

const CONFLICT_REGIONS = [
  'Syria', 'Libya', 'Yemen', 'Sudan', 'South Sudan', 'DRC', 'Congo',
  'Somalia', 'Mali', 'Sahel', 'Ukraine', 'Gaza', 'Lebanon', 'Iran',
  'North Korea', 'Kosovo', 'Haiti', 'Myanmar', 'Afghanistan', 'Iraq',
  'Ethiopia', 'Tigray', 'Darfur', 'Central African Republic', 'CAR',
  'Burkina Faso', 'Niger', 'Chad', 'Mozambique', 'Colombia', 'Venezuela',
  'Palestine', 'Israel', 'West Bank', 'Bosnia', 'Moldova', 'Georgia',
  'Azerbaijan', 'Armenia', 'Nagorno-Karabakh', 'Taiwan', 'Korean Peninsula',
  'Sahara', 'Sri Lanka', 'Pakistan', 'Nigeria', 'Cameroon', 'Zimbabwe',
  'Western Sahara', 'Eritrea', 'Burundi',
];

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

function detectItemType(title: string, description: string): UnScItemType {
  const combined = title + ' ' + description;
  const lc = combined.toLowerCase();

  if (/resolution/.test(lc) && /s\/res\/\d+/i.test(combined)) return 'resolution';
  if (/presidential statement|prst\b/.test(lc)) return 'presidential-statement';
  if (/press statement|sc\/\d{5}/.test(lc)) return 'press-statement';
  if (/sanction|asset freeze|arms embargo|travel ban/.test(lc)) return 'sanctions';
  if (/briefing|informed the council|brief the council/.test(lc)) return 'briefing';
  if (/meeting|session|convene|called/.test(lc)) return 'meeting';
  return 'general';
}

function detectRegion(title: string, description: string): string {
  const combined = title + ' ' + description;
  for (const region of CONFLICT_REGIONS) {
    const re = new RegExp(`\\b${region}\\b`, 'i');
    if (re.test(combined)) return region;
  }
  return 'Global';
}

function detectSeverity(
  itemType: UnScItemType,
  title: string,
  description: string,
): UnScItem['severity'] {
  const combined = (title + ' ' + description).toLowerCase();

  if (
    /emergency session/.test(combined) ||
    (/meeting|session/.test(combined) && /chapter vii|threat to (?:international )?peace/.test(combined))
  ) {
    return 'critical';
  }

  if (itemType === 'resolution' || itemType === 'sanctions') return 'high';
  if (itemType === 'presidential-statement' || itemType === 'press-statement') return 'medium';
  if (itemType === 'briefing' || itemType === 'meeting') return 'medium';
  return 'low';
}

function normalizeId(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
}

interface ParsedItem {
  title: string;
  description: string;
  link: string;
  pubDateStr: string;
  sourceUrl: string;
}

function parseItems(doc: Document, sourceUrl: string): ParsedItem[] {
  const results: ParsedItem[] = [];

  // RSS <item>
  for (const item of Array.from(doc.querySelectorAll('item'))) {
    const title = item.querySelector('title')?.textContent?.trim() ?? '';
    const description = stripHtml(item.querySelector('description')?.textContent ?? '');
    const link = item.querySelector('link')?.textContent?.trim() ?? '';
    const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';
    results.push({ title, description, link, pubDateStr, sourceUrl });
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
    results.push({ title, description, link, pubDateStr, sourceUrl });
  }

  return results;
}

async function fetchFeedItems(feedUrl: string): Promise<UnScItem[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const rawItems = parseItems(doc, feedUrl);
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const items: UnScItem[] = [];

    for (const raw of rawItems) {
      const combined = raw.title + ' ' + raw.description;
      const fromScUrl = raw.sourceUrl.includes('securitycouncil');

      if (!fromScUrl && !RELEVANCE_PATTERN.test(combined)) continue;

      const pubDate = raw.pubDateStr ? new Date(raw.pubDateStr) : new Date();
      if (Number.isNaN(pubDate.getTime()) || pubDate.getTime() < cutoff) continue;

      const itemType = detectItemType(raw.title, raw.description);
      const region = detectRegion(raw.title, raw.description);
      const severity = detectSeverity(itemType, raw.title, raw.description);

      items.push({
        id: `unsc-${normalizeId(raw.title)}`,
        title: raw.title,
        description: raw.description.slice(0, 400),
        itemType,
        region,
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

const SEVERITY_ORDER: Record<UnScItem['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function fetchUnSecurityCouncil(): Promise<UnScItem[]> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.items;
  }

  const results = await Promise.allSettled(
    FEED_URLS.map(url => fetchFeedItems(url)),
  );

  const combined: UnScItem[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      combined.push(...result.value);
    }
  }

  // Deduplicate by title hash
  const seen = new Set<string>();
  const deduped: UnScItem[] = [];
  for (const item of combined) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
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

export function unScSeverityClass(severity: UnScItem['severity']): string {
  switch (severity) {
    case 'critical': return 'text-red-500';
    case 'high':     return 'text-orange-500';
    case 'medium':   return 'text-yellow-500';
    default:         return 'text-gray-400';
  }
}
