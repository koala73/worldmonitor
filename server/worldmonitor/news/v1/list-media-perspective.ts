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
import { countryMentionTerms, localizedCountryNames, mentionsCountry, mentionsLocalizedCountry } from '../../../../shared/country-mention.js';
import { publisherFamilyFor } from '../../../../shared/publisher-families.js';
import { isVerifiableArticleUrl } from '../../../../shared/article-url.js';
import { UN_M49_REGION_IDS, unM49RegionCountries } from '../../../_shared/un-m49-regions';
import { INTEL_SOURCES, VARIANT_FEEDS } from './_feeds';
import { FUTURE_DATE_TOLERANCE_MS, resolveMaxAgeMs, rssFeedCacheKey } from './_rss-cache';

export const MEDIA_PERSPECTIVE_CACHE_PREFIX = 'news:media-perspective:v2';
const CACHE_TTL_SECONDS = 300;
const PARTIAL_CACHE_TTL_SECONDS = 60;
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

/**
 * One entry per subject and window: the unfiltered grouping. Outlet-country
 * and audience filters run on serve, so caller-chosen filter combinations
 * never mint keys (at most ~250 subjects x 4 windows).
 */
export function mediaPerspectiveCacheKey(query: Pick<Query, 'subject' | 'windowHours'>): string {
  return [MEDIA_PERSPECTIVE_CACHE_PREFIX, query.subject, query.windowHours].join(':');
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
    framing: '',
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
    framing: { favorable: 0, neutral: 0, critical: 0, hostile: 0, unlabeled: items.length, method: '', model: '', promptVersion: '' },
    headlines: selectHeadlines(items),
  };
}

interface CatalogFeed {
  name: string;
  keys: string[];
}

/** Every catalog feed once, with the cache key of each variant that lists it (full first). */
function catalogFeeds(): CatalogFeed[] {
  const byUrl = new Map<string, CatalogFeed>();
  const add = (variant: string, feed: { name: string; url: string }) => {
    const key = rssFeedCacheKey(variant, feed.url);
    const known = byUrl.get(feed.url);
    if (!known) byUrl.set(feed.url, { name: feed.name, keys: [key] });
    else if (!known.keys.includes(key)) known.keys.push(key);
  };
  const variants = ['full', ...Object.keys(VARIANT_FEEDS).filter(variant => variant !== 'full')];
  for (const variant of variants) {
    for (const feed of Object.values(VARIANT_FEEDS[variant] ?? {}).flat()) add(variant, feed);
  }
  for (const feed of INTEL_SOURCES) add('full', feed);
  return [...byUrl.values()];
}

/** A cached parse; a fetch that failed is cached as `items: []` with `attempt.failure` set. */
function healthyEntry(value: unknown): { items: unknown[]; countryItems?: unknown[] } | null {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) return null;
  const attempt = 'attempt' in value ? value.attempt : null;
  if (attempt && typeof attempt === 'object' && 'failure' in attempt && attempt.failure) return null;
  return value as { items: unknown[]; countryItems?: unknown[] };
}

function cachedLinks(response: ListMediaPerspectiveResponse): string[] {
  return response.groups.flatMap(group => group.headlines.map(headline => headline.link));
}

/** The unfiltered grouping for one subject and window. */
async function buildAll(query: Query, now: number): Promise<{ response: ListMediaPerspectiveResponse; revocationsReadable: boolean }> {
  const feeds = catalogFeeds();
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
  const [cached, revoked] = await Promise.all([getCachedJsonBatch(feeds.flatMap(feed => feed.keys)), readRevokedUrlSet()]);
  if (!revoked.readable) return { response, revocationsReadable: false };

  const cutoff = now - Math.min(query.windowHours * 3600_000, resolveMaxAgeMs());
  const terms = countryMentionTerms(query.subject);
  const localized = new Map<string, string[]>();
  const mentionsSubject = (title: string, language: string) => {
    if (mentionsCountry(title, terms)) return true;
    if (language === 'en') return false;
    let names = localized.get(language);
    if (!names) {
      names = localizedCountryNames(query.subject, language);
      localized.set(language, names);
    }
    return mentionsLocalizedCountry(title, names, language);
  };
  const grouped = new Map<string, { homeCountry: string; audience: string; items: MediaPerspectiveHeadline[]; links: Set<string> }>();
  const unattributed = new Set<string>();
  for (const feed of feeds) {
    const entry = feed.keys.map(key => healthyEntry(cached.get(key))).find(value => value !== null);
    if (!entry) continue;
    response.feedCached++;
    const values = Array.isArray(entry.countryItems) ? [...entry.items, ...entry.countryItems] : entry.items;
    for (const value of values) {
      const row = rowFromCache(value, feed.name, now, cutoff, revoked.urls);
      if (!row) continue;
      const profile = getOutletProfile(row.publisher);
      const language = profile?.language || row.lang || 'en';
      if (!mentionsSubject(row.title, language)) continue;
      if (!isAttributable(profile)) {
        unattributed.add(row.link);
        continue;
      }
      // Duplicates collapse within a group only: the same article syndicated
      // to an international and a domestic edition belongs in both.
      const groupKey = `${profile.country}:${profile.audience}`;
      let group = grouped.get(groupKey);
      if (!group) {
        group = { homeCountry: profile.country, audience: profile.audience, items: [], links: new Set() };
        grouped.set(groupKey, group);
      }
      if (group.links.has(row.link)) continue;
      group.links.add(row.link);
      group.items.push(headlineFor(row, profile));
    }
  }

  response.unattributedCount = unattributed.size;
  response.groups = [...grouped.values()]
    .map(group => buildGroup(group.homeCountry, group.audience, group.items))
    .sort((a, b) => b.headlineCount - a.headlineCount
      || a.homeCountry.localeCompare(b.homeCountry) || a.audience.localeCompare(b.audience));
  response.state = response.feedCached === feeds.length ? 'complete' : response.feedCached > 0 ? 'partial' : 'unavailable';
  return { response, revocationsReadable: true };
}

function applyFilters(all: ListMediaPerspectiveResponse, query: Query): ListMediaPerspectiveResponse {
  const requested = new Set(query.outletCountries);
  const groups = all.groups.filter(group => (requested.size === 0 || requested.has(group.homeCountry))
    && (!query.audience || group.audience === query.audience));
  const covered = new Set(groups.map(group => group.homeCountry));
  return { ...all, groups, noCoverageCountries: query.outletCountries.filter(code => !covered.has(code)) };
}

export async function listMediaPerspective(
  ctx: ServerContext,
  req: ListMediaPerspectiveRequest,
): Promise<ListMediaPerspectiveResponse> {
  const query = canonicalQuery(req);
  const cacheKey = mediaPerspectiveCacheKey(query);
  const hit = await getCachedJson(cacheKey) as ListMediaPerspectiveResponse | null;
  if (hit && typeof hit === 'object' && (hit.state === 'complete' || hit.state === 'partial') && Array.isArray(hit.groups)) {
    // Revocation is a serve-time control: a hit is served only while none of
    // its links has been withdrawn since it was cached; otherwise rebuild.
    const revoked = await readRevokedUrlSet();
    if (revoked.readable && !cachedLinks(hit).some(link => revoked.urls.has(link))) {
      if (hit.state === 'partial') markNoCacheResponse(ctx.request);
      return applyFilters(hit, query);
    }
  }

  const { response, revocationsReadable } = await buildAll(query, Date.now());
  if (!revocationsReadable || response.state === 'unavailable') {
    markNoCacheResponse(ctx.request);
    return applyFilters(response, query);
  }
  // A partial build is cached briefly so repeated queries during a feed
  // outage do not rescan the whole catalog; it still says it is partial.
  await setCachedJson(cacheKey, response, response.state === 'complete' ? CACHE_TTL_SECONDS : PARTIAL_CACHE_TTL_SECONDS);
  if (response.state !== 'complete') markNoCacheResponse(ctx.request);
  return applyFilters(response, query);
}
