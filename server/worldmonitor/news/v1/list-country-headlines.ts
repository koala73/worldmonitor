import type {
  CountryHeadline,
  ListCountryHeadlinesRequest,
  ListCountryHeadlinesResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { getCachedJsonBatch } from '../../../_shared/redis';
import { readRevokedUrlSet } from '../../../_shared/digest-revocations';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { countryMentionTerms, mentionsCountry } from '../../../../shared/country-mention.js';
import { publisherFamilyFor } from '../../../../shared/publisher-families.js';
import { isVerifiableArticleUrl } from '../../../../shared/article-url.js';
import { INTEL_SOURCES, isServerFeedReachableForLanguage, VARIANT_FEEDS } from './_feeds';
import { FUTURE_DATE_TOLERANCE_MS, resolveMaxAgeMs, rssFeedCacheKey } from './_rss-cache';

const HEADLINE_LIMIT = 5;

function headlineFromCache(value: unknown, source: string, now: number, cutoff: number, revoked: ReadonlySet<string>): CountryHeadline | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.source !== source || typeof row.title !== 'string' || typeof row.link !== 'string') return null;
  const publisher = row.originPublisherTrusted === true
    ? (typeof row.originPublisher === 'string' ? row.originPublisher.trim() : '')
    : source;
  if (!publisher || publisher.length > 200) return null;
  const title = row.title.replace(/\s+/g, ' ').trim();
  if (!title || title.length > 1000 || title.includes('**') || row.link.length > 2048) return null;
  if (typeof row.publishedAt !== 'number' || !Number.isFinite(row.publishedAt)
    || row.publishedAt <= 0 || row.publishedAt < cutoff || row.publishedAt > now + FUTURE_DATE_TOLERANCE_MS) return null;
  try {
    const url = new URL(row.link);
    if (!isVerifiableArticleUrl(url.href) || url.username || url.password || revoked.has(row.link) || revoked.has(url.href)) return null;
    return { source: publisher, title, link: url.href, publishedAt: row.publishedAt };
  } catch {
    return null;
  }
}

export async function listCountryHeadlines(
  ctx: ServerContext,
  req: ListCountryHeadlinesRequest,
): Promise<ListCountryHeadlinesResponse> {
  const codes = [...new Set(req.countryCodes.map(code => code.trim().toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code)))].slice(0, 250);
  const feeds = [...Object.values(VARIANT_FEEDS.full ?? {}).flat(), ...INTEL_SOURCES]
    .filter(feed => isServerFeedReachableForLanguage(feed, 'en'));
  const now = Date.now();
  const response: ListCountryHeadlinesResponse = {
    countries: {}, state: 'unavailable', feedTotal: feeds.length, feedCached: 0, readAt: new Date(now).toISOString(),
  };
  if (codes.length === 0) return response;
  const keys = [...new Set(feeds.map(feed => rssFeedCacheKey('full', feed.url)))];
  const [cached, revoked] = await Promise.all([getCachedJsonBatch(keys), readRevokedUrlSet()]);
  if (!revoked.readable) {
    markNoCacheResponse(ctx.request);
    return response;
  }
  const cutoff = now - resolveMaxAgeMs();
  const items: CountryHeadline[] = [];
  const seen = new Set<string>();
  for (const feed of feeds) {
    const entry = cached.get(rssFeedCacheKey('full', feed.url));
    if (!entry || typeof entry !== 'object' || !('items' in entry) || !Array.isArray(entry.items)) continue;
    response.feedCached++;
    const rows = 'countryItems' in entry && Array.isArray(entry.countryItems)
      ? [...entry.items, ...entry.countryItems] : entry.items;
    for (const value of rows) {
      const item = headlineFromCache(value, feed.name, now, cutoff, revoked.urls);
      if (!item || seen.has(item.link)) continue;
      seen.add(item.link);
      items.push(item);
    }
  }
  items.sort((a, b) => b.publishedAt - a.publishedAt || a.link.localeCompare(b.link));
  for (const code of codes) {
    const terms = countryMentionTerms(code);
    const matches = items.filter(item => mentionsCountry(item.title, terms));
    const families = new Set<string>();
    const first: CountryHeadline[] = [];
    const rest: CountryHeadline[] = [];
    for (const item of matches) {
      const family = publisherFamilyFor(item.source);
      if (families.has(family)) rest.push(item);
      else {
        families.add(family);
        first.push(item);
      }
    }
    const selected = [...first, ...rest].slice(0, HEADLINE_LIMIT);
    if (selected.length) response.countries[code] = { items: selected };
  }
  response.state = response.feedCached === feeds.length ? 'complete' : response.feedCached > 0 ? 'partial' : 'unavailable';
  if (response.state !== 'complete') markNoCacheResponse(ctx.request);
  return response;
}
