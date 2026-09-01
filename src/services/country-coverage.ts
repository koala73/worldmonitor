import type { EventCategory, NewsItem, ThreatLevel } from '@/types';
import { rssProxyUrl } from '@/utils';
import { isDesktopRuntime } from './runtime';
import { effectivePubDateMs } from './feed-date';
import { BRIEF_ONLY_RSS_FETCH_POLICY, fetchFeed } from './rss';
import {
  clusterCountryTimelineIncidents,
  type CountryTimelineIncident,
} from './country-timeline-events';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_QUERY = 'protest OR demonstration OR riot OR conflict OR attack OR military OR earthquake OR flood OR wildfire';

export type CountryCoverageEvent = CountryTimelineIncident;

export interface CountryCoverage {
  headlines: NewsItem[];
  timelineEvents: CountryCoverageEvent[];
}

const TIMELINE_LANES: Partial<Record<EventCategory, CountryCoverageEvent['lane']>> = {
  protest: 'protest',
  conflict: 'conflict',
  terrorism: 'conflict',
  disaster: 'natural',
  environmental: 'natural',
  military: 'military',
};

function timelineSeverity(level: ThreatLevel | undefined): CountryCoverageEvent['severity'] {
  if (level === 'critical' || level === 'high' || level === 'medium') return level;
  return 'low';
}

function googleNewsFeedUrl(query: string): string {
  const feedUrl = new URL('https://news.google.com/rss/search');
  feedUrl.searchParams.set('q', query);
  feedUrl.searchParams.set('hl', 'en-US');
  feedUrl.searchParams.set('gl', 'US');
  feedUrl.searchParams.set('ceid', 'US:en');
  if (isDesktopRuntime()) {
    return `/api/rss-proxy?${new URLSearchParams({ url: feedUrl.toString() }).toString()}`;
  }
  return rssProxyUrl(feedUrl.toString());
}

function normalizeGoogleNewsItem(item: NewsItem): NewsItem {
  const publisherSeparator = item.title.lastIndexOf(' - ');
  if (publisherSeparator === -1) return item;
  return {
    ...item,
    title: item.title.slice(0, publisherSeparator).trim(),
    source: item.title.slice(publisherSeparator + 3).trim(),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('The operation was aborted.', 'AbortError');
}

export async function fetchCountryCoverage(
  country: string,
  searchTerms: string[] = [],
  options: { signal?: AbortSignal } = {},
): Promise<CountryCoverage> {
  throwIfAborted(options.signal);
  const uniqueTerms = new Map<string, string>();
  for (const rawTerm of [country, ...searchTerms]) {
    const term = rawTerm.trim();
    if (term.length > 2 && !uniqueTerms.has(term.toLowerCase())) {
      uniqueTerms.set(term.toLowerCase(), term);
    }
  }
  const eventTerms = [...uniqueTerms.values()]
    .slice(0, 6)
    .map(term => `"${term.replace(/"/g, '')}"`)
    .join(' OR ');

  const feedOptions = {
    policy: BRIEF_ONLY_RSS_FETCH_POLICY,
    signal: options.signal,
  };
  const [headlineItems, eventItems] = await Promise.all([
    fetchFeed({
      name: `Country coverage: ${country}`,
      url: googleNewsFeedUrl(`"${country}" when:7d`),
    }, feedOptions),
    fetchFeed({
      name: `Country events: ${country}`,
      url: googleNewsFeedUrl(`(${eventTerms}) (${EVENT_QUERY}) when:7d`),
    }, feedOptions),
  ]);
  throwIfAborted(options.signal);
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const headlines = headlineItems
    .filter(item => effectivePubDateMs(item) >= cutoff)
    .map(normalizeGoogleNewsItem);
  const timelineEvents = clusterCountryTimelineIncidents(
    eventItems
      .filter(item => effectivePubDateMs(item) >= cutoff)
      .map(normalizeGoogleNewsItem)
      .flatMap<CountryCoverageEvent>((item) => {
        const lane = item.threat ? TIMELINE_LANES[item.threat.category] : undefined;
        if (!lane) return [];
        return [{
          timestamp: effectivePubDateMs(item),
          lane,
          label: item.title,
          severity: timelineSeverity(item.threat?.level),
        }];
      }),
  );

  return { headlines, timelineEvents };
}
