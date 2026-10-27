import type {
  ListMediaPerspectiveRequest,
  ListMediaPerspectiveResponse,
  MediaPerspectiveGroup,
  MediaPerspectiveHeadline,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { getCachedJson, getCachedJsonBatch, setCachedJson } from '../../../_shared/redis';
import { readRevokedUrlSet } from '../../../_shared/digest-revocations';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { declaredSourceTier } from '../../../_shared/source-tiers';
import { getOutletProfile, INTERNATIONAL_HOME, OUTLET_AUDIENCES, type OutletProfile } from '../../../_shared/outlet-profile';
import { getSourcePropagandaRisk } from '../../../../shared/source-provenance';
import { countryMentionTerms, mentionsCountry } from '../../../../shared/country-mention.js';
import { publisherFamilyFor } from '../../../../shared/publisher-families.js';
import { isVerifiableArticleUrl } from '../../../../shared/article-url.js';
import { UN_M49_REGION_IDS, unM49RegionCountries } from '../../../_shared/un-m49-regions';
import { INTEL_SOURCES, VARIANT_FEEDS } from './_feeds';
import { FUTURE_DATE_TOLERANCE_MS, resolveMaxAgeMs, rssFeedCacheKey } from './_rss-cache';

export const MEDIA_PERSPECTIVE_CACHE_PREFIX = 'news:media-perspective:v1';
const CACHE_TTL_SECONDS = 300;
const WINDOW_HOURS = [24, 48, 72, 96] as const;
const DEFAULT_WINDOW_HOURS = 72;
const GROUP_HEADLINE_LIMIT = 20;
const OUTLET_COUNTRY_LIMIT = 30;
const COUNTRY_CODE = /^(?:[A-Z]{2})$/;

interface Query {
  subject: string;
  outletCountries: string[];
  audience: string;
  windowHours: number;
}

function canonicalQuery(req: ListMediaPerspectiveRequest): Query {
  const subject = req.subjectCountry.trim().toUpperCase();
  if (!COUNTRY_CODE.test(subject) || subject === INTERNATIONAL_HOME) {
    throw new ValidationError([{ field: 'subject_country', description: 'Use an ISO 3166-1 alpha-2 country code' }]);
  }
  const listed = [...new Set(req.outletCountries.map(code => code.trim().toUpperCase()).filter(Boolean))];
  const invalid = listed.find(code => !COUNTRY_CODE.test(code) && code !== INTERNATIONAL_HOME);
  if (invalid !== undefined || listed.length > OUTLET_COUNTRY_LIMIT) {
    throw new ValidationError([{ field: 'outlet_countries', description: `Use at most ${OUTLET_COUNTRY_LIMIT} ISO 3166-1 alpha-2 codes (or INTL)` }]);
  }
  const regionCountries = req.outletRegions.map(region => unM49RegionCountries(region.trim().toLowerCase()));
  if (regionCountries.some(countries => countries === null)) {
    throw new ValidationError([{ field: 'outlet_regions', description: `Use UN M49 region slugs: ${UN_M49_REGION_IDS.join(', ')}` }]);
  }
  // The key carries the expanded country list, so regions and their spelled-out countries share one entry.
  const outletCountries = [...new Set([...listed, ...regionCountries.flatMap(countries => countries ?? [])])].sort();
  const audience = req.audience.trim().toLowerCase();
  if (audience && !(OUTLET_AUDIENCES as readonly string[]).includes(audience)) {
    throw new ValidationError([{ field: 'audience', description: `Use one of ${OUTLET_AUDIENCES.join(', ')}` }]);
  }
  const windowHours = req.windowHours || DEFAULT_WINDOW_HOURS;
  if (!(WINDOW_HOURS as readonly number[]).includes(windowHours)) {
    throw new ValidationError([{ field: 'window_hours', description: `Use one of ${WINDOW_HOURS.join(', ')}` }]);
  }
  return { subject, outletCountries, audience, windowHours };
}

export function mediaPerspectiveCacheKey(query: Query): string {
  return [
    MEDIA_PERSPECTIVE_CACHE_PREFIX,
    query.subject,
    query.outletCountries.join(',') || '*',
    query.audience || '*',
    query.windowHours,
  ].join(':');
}

interface Row {
  publisher: string;
  title: string;
  link: string;
  publishedAt: number;
  lang: string | null;
}

function rowFromCache(value: unknown, source: string, now: number, cutoff: number, revoked: ReadonlySet<string>): Row | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.source !== source || typeof row.title !== 'string' || typeof row.link !== 'string') return null;
  const publisher = row.originPublisherTrusted === true
    ? (typeof row.originPublisher === 'string' ? row.originPublisher.trim() : '')
    : source;
  if (!publisher || publisher.length > 200) return null;
  const title = row.title.replace(/\s+/g, ' ').trim();
  if (!title || title.length > 1000 || row.link.length > 2048) return null;
  if (typeof row.publishedAt !== 'number' || !Number.isFinite(row.publishedAt)
    || row.publishedAt < cutoff || row.publishedAt > now + FUTURE_DATE_TOLERANCE_MS) return null;
  try {
    const url = new URL(row.link);
    if (!isVerifiableArticleUrl(url.href) || url.username || url.password || revoked.has(row.link) || revoked.has(url.href)) return null;
    const lang = typeof row.lang === 'string' && /^[a-z]{2}$/.test(row.lang) ? row.lang : null;
    return { publisher, title, link: url.href, publishedAt: row.publishedAt, lang };
  } catch {
    return null;
  }
}

/** A multi-publisher search (a Google News topic query) has no single home country to group under. */
function isAttributable(profile: OutletProfile | null): profile is OutletProfile {
  return profile !== null && !(profile.country === INTERNATIONAL_HOME && profile.ownershipClass === 'unreviewed');
}

function headlineFor(row: Row, profile: OutletProfile): MediaPerspectiveHeadline {
  const risk = getSourcePropagandaRisk(row.publisher);
  const titleLanguage = profile.language || row.lang || 'en';
  return {
    title: row.title,
    englishTitle: titleLanguage === 'en' ? row.title : '',
    titleLanguage,
    outlet: row.publisher,
    publisherFamily: publisherFamilyFor(row.publisher),
    tier: declaredSourceTier(row.publisher) ?? 0,
    ownershipClass: profile.ownershipClass,
    stateAffiliated: risk.stateAffiliated ?? '',
    propagandaRisk: risk.risk,
    framing: undefined,
    publishedAt: row.publishedAt,
    link: row.link,
  };
}

/** Newest first, with one headline per publisher family before any family repeats. */
function selectHeadlines(items: MediaPerspectiveHeadline[]): MediaPerspectiveHeadline[] {
  const families = new Set<string>();
  const first: MediaPerspectiveHeadline[] = [];
  const rest: MediaPerspectiveHeadline[] = [];
  for (const item of items) {
    if (families.has(item.publisherFamily)) rest.push(item);
    else {
      families.add(item.publisherFamily);
      first.push(item);
    }
  }
  return [...first, ...rest].slice(0, GROUP_HEADLINE_LIMIT);
}

function buildGroup(homeCountry: string, audience: string, items: MediaPerspectiveHeadline[]): MediaPerspectiveGroup {
  items.sort((a, b) => b.publishedAt - a.publishedAt || a.link.localeCompare(b.link));
  return {
    homeCountry,
    audience,
    outletCount: new Set(items.map(item => item.publisherFamily)).size,
    headlineCount: items.length,
    framing: { favorable: 0, neutral: 0, critical: 0, hostile: 0, unlabeled: items.length, method: '' },
    headlines: selectHeadlines(items),
  };
}

export async function listMediaPerspective(
  ctx: ServerContext,
  req: ListMediaPerspectiveRequest,
): Promise<ListMediaPerspectiveResponse> {
  const query = canonicalQuery(req);
  const cacheKey = mediaPerspectiveCacheKey(query);
  const hit = await getCachedJson(cacheKey);
  if (hit && typeof hit === 'object' && (hit as ListMediaPerspectiveResponse).state === 'complete') {
    return hit as ListMediaPerspectiveResponse;
  }

  // Every catalog feed, whatever its language: non-English domestic outlets are
  // the point of this view, so the English-digest reachability filter that
  // list-country-headlines applies does not belong here.
  const feeds = [...Object.values(VARIANT_FEEDS.full ?? {}).flat(), ...INTEL_SOURCES];
  const now = Date.now();
  const response: ListMediaPerspectiveResponse = {
    subjectCountry: query.subject,
    windowHours: query.windowHours,
    groups: [],
    noCoverageCountries: [],
    unattributedCount: 0,
    state: 'unavailable',
    feedTotal: feeds.length,
    feedCached: 0,
    readAt: new Date(now).toISOString(),
  };
  const keys = [...new Set(feeds.map(feed => rssFeedCacheKey('full', feed.url)))];
  const [cached, revoked] = await Promise.all([getCachedJsonBatch(keys), readRevokedUrlSet()]);
  if (!revoked.readable) {
    markNoCacheResponse(ctx.request);
    return response;
  }

  const cutoff = now - Math.min(query.windowHours * 3600_000, resolveMaxAgeMs());
  const terms = countryMentionTerms(query.subject);
  const requested = new Set(query.outletCountries);
  const grouped = new Map<string, { homeCountry: string; audience: string; items: MediaPerspectiveHeadline[] }>();
  const seen = new Set<string>();
  for (const feed of feeds) {
    const entry = cached.get(rssFeedCacheKey('full', feed.url));
    if (!entry || typeof entry !== 'object' || !('items' in entry) || !Array.isArray(entry.items)) continue;
    response.feedCached++;
    const values = 'countryItems' in entry && Array.isArray(entry.countryItems)
      ? [...entry.items, ...entry.countryItems] : entry.items;
    for (const value of values) {
      const row = rowFromCache(value, feed.name, now, cutoff, revoked.urls);
      if (!row || seen.has(row.link) || !mentionsCountry(row.title, terms)) continue;
      seen.add(row.link);
      const profile = getOutletProfile(row.publisher);
      if (!isAttributable(profile)) {
        response.unattributedCount++;
        continue;
      }
      if (requested.size > 0 && !requested.has(profile.country)) continue;
      if (query.audience && profile.audience !== query.audience) continue;
      const groupKey = `${profile.country}:${profile.audience}`;
      let group = grouped.get(groupKey);
      if (!group) {
        group = { homeCountry: profile.country, audience: profile.audience, items: [] };
        grouped.set(groupKey, group);
      }
      group.items.push(headlineFor(row, profile));
    }
  }

  response.groups = [...grouped.values()]
    .map(group => buildGroup(group.homeCountry, group.audience, group.items))
    .sort((a, b) => b.headlineCount - a.headlineCount
      || a.homeCountry.localeCompare(b.homeCountry) || a.audience.localeCompare(b.audience));
  const covered = new Set(response.groups.map(group => group.homeCountry));
  response.noCoverageCountries = query.outletCountries.filter(code => !covered.has(code));
  response.state = response.feedCached === feeds.length ? 'complete' : response.feedCached > 0 ? 'partial' : 'unavailable';
  if (response.state === 'complete') await setCachedJson(cacheKey, response, CACHE_TTL_SECONDS);
  else markNoCacheResponse(ctx.request);
  return response;
}
