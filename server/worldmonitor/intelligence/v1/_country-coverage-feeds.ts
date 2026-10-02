/**
 * The coverage half of GetCountryCoverage (#7526): the same two Google News
 * queries the country panel runs, parsed and labelled the same way.
 *
 * Every rule here is a deliberate mirror of `src/services/country-coverage.ts`.
 * The panel and this module must produce the same incident set for the same
 * snapshot, so the query strings, the term cap, the publisher-suffix split, the
 * classifier, the lane map and the severity floor are all read from one place
 * or reproduced verbatim with a comment saying which line they mirror.
 *
 * The one thing NOT mirrored is the transport: the browser goes through the RSS
 * proxy, the server fetches through `fetchAndParseRss` (direct, then relay).
 * Both end at the same Google News URL and both cap a feed at 5 items.
 */

import {
  fetchAndParseRss,
  type ParsedItem,
  type ParseResult,
} from '../../news/v1/list-feed-digest';
import type { ServerFeed } from '../../news/v1/_feeds';
import { classifyByKeyword } from '../../../../shared/threat-keyword-classifier';
import type { EventCategory, ThreatLevel } from '../../../../shared/threat-keyword-classifier';
import { clusterCountryTimelineIncidents } from '../../../../shared/country-timeline-events';
import type {
  CountryTimelineIncident,
  CountryTimelineLane,
  CountryTimelineSeverity,
} from '../../../../shared/country-timeline-events';
import { firstMentionPosition, isCountryHeadline } from '../../../../shared/country-headline-match';

/** Mirrors EVENT_QUERY in src/services/country-coverage.ts. */
const EVENT_QUERY =
  'protest OR demonstration OR riot OR conflict OR attack OR military OR earthquake OR flood OR wildfire';

/**
 * The panel classifies with SITE_VARIANT, which is 'full' for the app that owns
 * the country panel. The tech variant has no country panel, so pinning 'full'
 * here cannot diverge from a variant a user could actually be looking at.
 */
const CLASSIFIER_VARIANT = 'full';

/** Mirrors TIMELINE_LANES in src/services/country-coverage.ts. */
const TIMELINE_LANES: Partial<Record<EventCategory, CountryTimelineLane>> = {
  protest: 'protest',
  conflict: 'conflict',
  terrorism: 'conflict',
  disaster: 'natural',
  environmental: 'natural',
  military: 'military',
};

/** Mirrors timelineSeverity in src/services/country-coverage.ts. */
function timelineSeverity(level: ThreatLevel | undefined): CountryTimelineSeverity {
  if (level === 'critical' || level === 'high' || level === 'medium') return level;
  return 'low';
}

/** Mirrors googleNewsFeedUrl in src/services/country-coverage.ts, minus the proxy. */
function googleNewsFeedUrl(query: string): string {
  const feedUrl = new URL('https://news.google.com/rss/search');
  feedUrl.searchParams.set('q', query);
  feedUrl.searchParams.set('hl', 'en-US');
  feedUrl.searchParams.set('gl', 'US');
  feedUrl.searchParams.set('ceid', 'US:en');
  return feedUrl.toString();
}

/**
 * Mirrors the term reduction in fetchCountryCoverage: country first, then the
 * search terms, de-duplicated case-insensitively, terms of 3+ characters only,
 * capped at 6, each quoted with any embedded quote stripped.
 */
export function buildEventQueryTerms(country: string, searchTerms: readonly string[]): string {
  const uniqueTerms = new Map<string, string>();
  for (const rawTerm of [country, ...searchTerms]) {
    const term = rawTerm.trim();
    if (term.length > 2 && !uniqueTerms.has(term.toLowerCase())) {
      uniqueTerms.set(term.toLowerCase(), term);
    }
  }
  return [...uniqueTerms.values()]
    .slice(0, 6)
    .map(term => `"${term.replace(/"/g, '')}"`)
    .join(' OR ');
}

export function countryHeadlineFeed(country: string): ServerFeed {
  return {
    name: `Country coverage: ${country}`,
    url: googleNewsFeedUrl(`"${country}" when:7d`),
  };
}

export function countryEventFeed(country: string, searchTerms: readonly string[]): ServerFeed {
  return {
    name: `Country events: ${country}`,
    url: googleNewsFeedUrl(`(${buildEventQueryTerms(country, searchTerms)}) (${EVENT_QUERY}) when:7d`),
  };
}

/**
 * Mirrors normalizeGoogleNewsItem: Google News appends " - Publisher" to every
 * title. Split on the LAST occurrence so a headline that itself contains " - "
 * keeps its own dash.
 */
export function splitGoogleNewsTitle(rawTitle: string): { title: string; source: string } {
  const publisherSeparator = rawTitle.lastIndexOf(' - ');
  if (publisherSeparator === -1) return { title: rawTitle, source: '' };
  return {
    title: rawTitle.slice(0, publisherSeparator).trim(),
    source: rawTitle.slice(publisherSeparator + 3).trim(),
  };
}

export interface CoverageHeadline {
  title: string;
  url: string;
  source: string;
  publishedAtMs: number;
}

export interface CoverageFetch {
  headlines: CoverageHeadline[];
  incidents: CountryTimelineIncident[];
  /** Raw parse results, so the caller can report per-feed status. */
  headlineResult: ParseResult;
  eventResult: ParseResult;
}

/**
 * Turn one parsed coverage article into a timeline incident, exactly as the
 * panel does: the threat is classified from the RAW title (rss.ts classifies
 * before normalization) while the label is the NORMALIZED title
 * (country-coverage.ts labels after it). Articles whose category has no lane
 * are dropped.
 */
function toIncident(item: ParsedItem): CountryTimelineIncident | null {
  const threat = classifyByKeyword(item.title, CLASSIFIER_VARIANT);
  const lane = TIMELINE_LANES[threat.category];
  if (!lane) return null;
  return {
    timestamp: item.publishedAt,
    lane,
    label: splitGoogleNewsTitle(item.title).title,
    severity: timelineSeverity(threat.level),
  };
}

/**
 * Fetch both country feeds and reduce them to the panel's pre-clustering state.
 *
 * `cutoffMs` applies the caller's window. The upstream query is pinned to
 * `when:7d`, so a narrower window only ever removes items here — it never asks
 * Google for more.
 */
export async function fetchCountryCoverageFeeds(
  country: string,
  code: string,
  searchTerms: readonly string[],
  cutoffMs: number,
  signal: AbortSignal,
  // Injectable so a test can drive the real pipeline — cutoff, country gate,
  // classifier, lane map, clustering — without a network. An ESM namespace is
  // read-only, so this cannot be stubbed from the outside.
  fetchFeed: typeof fetchAndParseRss = fetchAndParseRss,
): Promise<CoverageFetch> {
  const [headlineResult, eventResult] = await Promise.all([
    fetchFeed(countryHeadlineFeed(country), CLASSIFIER_VARIANT, signal),
    fetchFeed(countryEventFeed(country, searchTerms), CLASSIFIER_VARIANT, signal),
  ]);

  const headlines: CoverageHeadline[] = [];
  for (const item of headlineResult.items) {
    if (item.publishedAt < cutoffMs) continue;
    const { title, source } = splitGoogleNewsTitle(item.title);
    // The panel filters the lazy headline list with isCountryHeadline so a
    // story that merely name-drops the country cannot replace the eager list.
    if (!isCountryHeadline(title, country, code)) continue;
    headlines.push({
      title,
      url: item.link,
      source: source || item.originPublisher || item.source,
      publishedAtMs: item.publishedAt,
    });
  }
  headlines.sort((a, b) => b.publishedAtMs - a.publishedAtMs);

  const parsed: CountryTimelineIncident[] = [];
  for (const item of eventResult.items) {
    if (item.publishedAt < cutoffMs) continue;
    const incident = toIncident(item);
    if (incident) parsed.push(incident);
  }

  // ORDER IS LOAD-BEARING: cluster FIRST, then drop clusters whose label does
  // not mention the country. The panel runs it in exactly this order —
  // fetchCountryCoverage clusters (country-coverage.ts) and country-intel.ts
  // filters the clustered result with hasCountryTerm afterwards.
  //
  // Filtering first would change the answer, not just the order. A cluster is
  // represented by its EARLIEST member, so when two outlets carry one incident
  // and only the later headline names the country, filtering first keeps that
  // later headline as its own incident while the panel drops the whole cluster
  // (its representative never mentions the country). Same snapshot, different
  // timeline.
  const incidents = clusterCountryTimelineIncidents(parsed)
    .filter(incident => firstMentionPosition(incident.label, searchTerms) !== Infinity);

  return { headlines, incidents, headlineResult, eventResult };
}
