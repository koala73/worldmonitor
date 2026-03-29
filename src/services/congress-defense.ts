// US Congressional defense activity — HASC/SASC news, defense bills, military votes
// RSS feeds through /api/rss-proxy

export type CongressDefenseType =
  | 'ndaa' | 'authorization' | 'appropriation' | 'sanction-bill'
  | 'hearing' | 'vote' | 'statement' | 'general';

export interface CongressDefenseItem {
  id: string;
  title: string;
  description: string;
  chamber: 'House' | 'Senate' | 'Both' | 'Unknown';
  itemType: CongressDefenseType;
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  keywords: string[];
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface Cache {
  items: CongressDefenseItem[];
  ts: number;
}

let _cache: Cache | null = null;

const FEED_URLS = [
  'https://armedservices.house.gov/rss.xml',
  'https://www.armed-services.senate.gov/rss/news',
  'https://www.govtrack.us/congress/bills/browse?terms=defense&format=rss',
  'https://www.govtrack.us/congress/bills/browse?terms=military+authorization&format=rss',
  'https://www.congress.gov/rss/most-recent-bills.xml',
] as const;

function proxyUrl(feedUrl: string): string {
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

const RELEVANCE_TERMS = [
  'defense', 'military', 'armed forces', 'ndaa', 'pentagon', 'weapon',
  'army', 'navy', 'air force', 'marine', 'nuclear', 'missile', 'security',
  'nato', 'ukraine', 'taiwan', 'israel', 'sanction', 'intelligence',
  'cia', 'nsa', 'dod', 'department of defense',
];

function isRelevant(title: string, description: string): boolean {
  const text = (title + ' ' + description).toLowerCase();
  return RELEVANCE_TERMS.some(t => text.includes(t));
}

function detectItemType(title: string, description: string): CongressDefenseType {
  const text = (title + ' ' + description).toLowerCase();

  if (/\bndaa\b|national defense authorization/.test(text)) return 'ndaa';
  if (/authorization for use of military force|\baumf\b/.test(text)) return 'authorization';
  if (/appropriation|supplemental funding|emergency funding|defense budget/.test(text)) return 'appropriation';
  if (/sanctions bill|sanctions legislation/.test(text)) return 'sanction-bill';
  if (/\bhearing\b|testimony|subcommittee|markup/.test(text)) return 'hearing';
  if (/\bvote\b|\bpassed\b|\bfailed\b|\bamendment\b/.test(text)) return 'vote';
  if (/\bstatement\b|\bcondemns\b|\burges\b|\bcalls on\b/.test(text)) return 'statement';
  return 'general';
}

function detectChamber(feedUrl: string): 'House' | 'Senate' | 'Both' | 'Unknown' {
  if (feedUrl.includes('armedservices.house.gov')) return 'House';
  if (feedUrl.includes('armed-services.senate.gov')) return 'Senate';
  return 'Unknown';
}

const DEFENSE_KEYWORDS = [
  'Ukraine', 'Taiwan', 'China', 'Russia', 'NATO', 'nuclear', 'hypersonic',
  'F-35', 'carrier', 'cyber', 'space force', 'AUMF', 'sanctions', 'aid package',
  'lethal aid', 'intelligence sharing', 'missile defense', 'missile', 'submarine',
  'HIMARS', 'Patriot', 'Javelin', 'Stinger', 'drone', 'UAV', 'NDAA',
  'defense budget', 'appropriation', 'Pentagon', 'DoD', 'AUMF', 'NATO alliance',
  'adversary', 'deterrence', 'counterterrorism', 'Iran', 'North Korea',
];

function extractKeywords(title: string, description: string): string[] {
  const text = title + ' ' + description;
  const found: string[] = [];
  for (const kw of DEFENSE_KEYWORDS) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    if (new RegExp(escaped, 'i').test(text)) found.push(kw);
  }
  return [...new Set(found)].slice(0, 10);
}

function detectSeverity(
  itemType: CongressDefenseType,
  title: string,
  description: string,
): 'critical' | 'high' | 'medium' | 'low' {
  if (itemType === 'authorization') return 'critical'; // AUMF is critical
  if (itemType === 'ndaa' || itemType === 'appropriation') return 'high';
  if (itemType === 'sanction-bill') {
    const text = (title + ' ' + description).toLowerCase();
    if (/russia|china|iran|north korea|dprk/.test(text)) return 'high';
    return 'medium';
  }
  if (itemType === 'hearing') return 'medium';
  if (itemType === 'vote') return 'medium';
  if (itemType === 'statement') return 'low';
  return 'low';
}

// Simple hash for deduplication by title
function titleHash(title: string): string {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
  return normalized;
}

interface ParsedItem {
  title: string;
  description: string;
  link: string;
  pubDateStr: string;
  guid: string;
}

function parseXmlItems(xmlText: string): ParsedItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return [];

  return [...doc.querySelectorAll('item')].map(item => ({
    title: item.querySelector('title')?.textContent?.trim() ?? '',
    description: stripHtml(item.querySelector('description')?.textContent ?? '').trim(),
    link: item.querySelector('link')?.textContent?.trim() ?? '',
    pubDateStr: item.querySelector('pubDate')?.textContent?.trim() ?? '',
    guid: item.querySelector('guid')?.textContent?.trim() ?? '',
  }));
}

async function fetchFeed(feedUrl: string): Promise<CongressDefenseItem[]> {
  try {
    const res = await fetch(proxyUrl(feedUrl), {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) return [];

    const text = await res.text();
    const rawItems = parseXmlItems(text);
    const chamber = detectChamber(feedUrl);
    const results: CongressDefenseItem[] = [];

    for (const raw of rawItems) {
      if (!isRelevant(raw.title, raw.description)) continue;

      const pubDate = raw.pubDateStr ? new Date(raw.pubDateStr) : new Date();
      if (isNaN(pubDate.getTime())) continue;

      const itemType = detectItemType(raw.title, raw.description);
      const keywords = extractKeywords(raw.title, raw.description);
      const severity = detectSeverity(itemType, raw.title, raw.description);
      const guid = raw.guid || raw.link;

      results.push({
        id: `cd-${(guid.split('/').pop() ?? titleHash(raw.title)).slice(0, 40)}`,
        title: raw.title,
        description: raw.description.slice(0, 500),
        chamber,
        itemType,
        pubDate,
        url: raw.link,
        severity,
        keywords,
      });
    }

    return results;
  } catch {
    return [];
  }
}

const SEVERITY_ORDER: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function fetchCongressDefense(): Promise<CongressDefenseItem[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.items;

  const results = await Promise.allSettled(FEED_URLS.map(url => fetchFeed(url)));

  const combined: CongressDefenseItem[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') combined.push(...result.value);
  }

  // Filter: last 14 days
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recent = combined.filter(item => item.pubDate.getTime() >= cutoff);

  // Deduplicate by title hash
  const seen = new Set<string>();
  const deduped: CongressDefenseItem[] = [];
  for (const item of recent) {
    const hash = titleHash(item.title);
    if (!seen.has(hash)) {
      seen.add(hash);
      deduped.push(item);
    }
  }

  // Sort by severity then date desc (newest first)
  deduped.sort((a, b) => {
    const diff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (diff !== 0) return diff;
    return b.pubDate.getTime() - a.pubDate.getTime();
  });

  const items = deduped.slice(0, 40);
  _cache = { items, ts: Date.now() };
  return items;
}

export function congressSeverityClass(severity: CongressDefenseItem['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high:     'eq-row eq-strong',
    medium:   'eq-row eq-moderate',
    low:      'eq-row',
  }[severity] ?? 'eq-row';
}
