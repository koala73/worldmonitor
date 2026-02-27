import { proxyUrl } from '@/utils';
import { getPersistentCache, setPersistentCache } from './persistent-cache';
import { dataFreshness } from './data-freshness';

export interface SecurityAdvisory {
  title: string;
  link: string;
  pubDate: Date;
  source: string;
  sourceCountry: string;
  level?: 'do-not-travel' | 'reconsider' | 'caution' | 'normal' | 'info';
  country?: string;
}

export interface SecurityAdvisoriesFetchResult {
  ok: boolean;
  advisories: SecurityAdvisory[];
  cachedAt?: string;
}

interface AdvisoryFeed {
  name: string;
  sourceCountry: string;
  url: string;
  parseLevel?: (title: string) => SecurityAdvisory['level'];
}

const US_LEVEL_RE = /Level (\d)/i;

function parseUsLevel(title: string): SecurityAdvisory['level'] {
  const m = title.match(US_LEVEL_RE);
  if (!m) return 'info';
  switch (m[1]) {
    case '4': return 'do-not-travel';
    case '3': return 'reconsider';
    case '2': return 'caution';
    case '1': return 'normal';
    default: return 'info';
  }
}

function parseAuLevel(title: string): SecurityAdvisory['level'] {
  const lower = title.toLowerCase();
  if (lower.includes('do not travel')) return 'do-not-travel';
  if (lower.includes('reconsider')) return 'reconsider';
  if (lower.includes('exercise a high degree of caution') || lower.includes('high degree')) return 'caution';
  return 'info';
}

const ADVISORY_FEEDS: AdvisoryFeed[] = [
  // United States (State Dept)
  {
    name: 'US State Dept',
    sourceCountry: 'US',
    url: 'https://travel.state.gov/_res/rss/TAsTWs.xml',
    parseLevel: parseUsLevel,
  },
  // Australia (DFAT Smartraveller) — all destinations
  {
    name: 'AU Smartraveller',
    sourceCountry: 'AU',
    url: 'https://www.smartraveller.gov.au/countries/documents/index.rss',
    parseLevel: parseAuLevel,
  },
  // Australia — Do Not Travel specifically
  {
    name: 'AU DNT',
    sourceCountry: 'AU',
    url: 'https://www.smartraveller.gov.au/countries/documents/do-not-travel.rss',
    parseLevel: () => 'do-not-travel',
  },
  // Australia — Reconsider
  {
    name: 'AU Reconsider',
    sourceCountry: 'AU',
    url: 'https://www.smartraveller.gov.au/countries/documents/reconsider-your-need-to-travel.rss',
    parseLevel: () => 'reconsider',
  },
  // New Zealand MFAT
  {
    name: 'NZ MFAT',
    sourceCountry: 'NZ',
    url: 'https://www.safetravel.govt.nz/news/feed',
    parseLevel: parseAuLevel,
  },
  // UK FCDO — GOV.UK travel advice atom feed
  {
    name: 'UK FCDO',
    sourceCountry: 'UK',
    url: 'https://www.gov.uk/foreign-travel-advice.atom',
  },
];

const CACHE_KEY = 'security-advisories';
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
let lastFetch = 0;
let cachedResult: SecurityAdvisory[] | null = null;

function parseFeedXml(
  text: string,
  feed: AdvisoryFeed,
): SecurityAdvisory[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) return [];

  // Try RSS items first, then Atom entries
  let items = doc.querySelectorAll('item');
  const isAtom = items.length === 0;
  if (isAtom) items = doc.querySelectorAll('entry');

  return Array.from(items).slice(0, 15).map(item => {
    const title = item.querySelector('title')?.textContent?.trim() || '';
    let link = '';
    if (isAtom) {
      const linkEl = item.querySelector('link[href]');
      link = linkEl?.getAttribute('href') || '';
    } else {
      link = item.querySelector('link')?.textContent?.trim() || '';
    }

    const pubDateStr = isAtom
      ? (item.querySelector('updated')?.textContent || item.querySelector('published')?.textContent || '')
      : (item.querySelector('pubDate')?.textContent || '');
    const parsed = pubDateStr ? new Date(pubDateStr) : new Date();
    const pubDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

    const level = feed.parseLevel ? feed.parseLevel(title) : 'info';

    return {
      title,
      link,
      pubDate,
      source: feed.name,
      sourceCountry: feed.sourceCountry,
      level,
    };
  });
}

function toSerializable(items: SecurityAdvisory[]): Array<Omit<SecurityAdvisory, 'pubDate'> & { pubDate: string }> {
  return items.map(item => ({ ...item, pubDate: item.pubDate.toISOString() }));
}

function fromSerializable(items: Array<Omit<SecurityAdvisory, 'pubDate'> & { pubDate: string }>): SecurityAdvisory[] {
  return items.map(item => ({ ...item, pubDate: new Date(item.pubDate) }));
}

export async function fetchSecurityAdvisories(
  signal?: AbortSignal,
): Promise<SecurityAdvisoriesFetchResult> {
  const now = Date.now();

  // Return in-memory cache if fresh
  if (cachedResult && now - lastFetch < CACHE_TTL) {
    return { ok: true, advisories: cachedResult };
  }

  const allAdvisories: SecurityAdvisory[] = [];
  const feedResults = await Promise.allSettled(
    ADVISORY_FEEDS.map(async (feed) => {
      try {
        const response = await fetch(proxyUrl(feed.url), signal ? { signal } : undefined);
        if (!response.ok) {
          console.warn(`[SecurityAdvisories] ${feed.name} HTTP ${response.status}`);
          return [];
        }
        const text = await response.text();
        return parseFeedXml(text, feed);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        console.warn(`[SecurityAdvisories] ${feed.name} failed:`, e);
        return [];
      }
    }),
  );

  for (const result of feedResults) {
    if (result.status === 'fulfilled') {
      allAdvisories.push(...result.value);
    }
  }

  // Deduplicate by title (AU feeds can overlap)
  const seen = new Set<string>();
  const deduped = allAdvisories.filter(a => {
    const key = a.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by date descending
  deduped.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  // Cache
  cachedResult = deduped;
  lastFetch = now;
  void setPersistentCache(CACHE_KEY, toSerializable(deduped));

  if (deduped.length > 0) {
    dataFreshness.recordUpdate('security_advisories', deduped.length);
  }

  return { ok: true, advisories: deduped };
}

export async function loadCachedAdvisories(): Promise<SecurityAdvisory[] | null> {
  const entry = await getPersistentCache<Array<Omit<SecurityAdvisory, 'pubDate'> & { pubDate: string }>>(CACHE_KEY);
  if (!entry?.data?.length) return null;
  return fromSerializable(entry.data);
}
