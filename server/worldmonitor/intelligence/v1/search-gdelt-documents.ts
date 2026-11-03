import type {
  GdeltArticle,
  ServerContext,
  SearchGdeltDocumentsRequest,
  SearchGdeltDocumentsResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getLargeRawJson, logCacheReadError, readCachedJson } from '../../../_shared/redis';
import { normalizeGdeltTopicSnapshot } from '../../../../shared/intelligence-snapshots.js';
import { readRevokedUrlSet } from '../../../_shared/digest-revocations';
import { countryMentionTerms, mentionsCountry } from '../../../../shared/country-mention.js';

const SEEDED_KEY = 'intelligence:gdelt-intel:v1';
// Mirrors GDELT_BULK_COUNTRY_ARTICLES_KEY in scripts/_gdelt-bulk-contract.mjs;
// tests/search-gdelt-documents-country.test.mjs pins the two literals equal.
const COUNTRY_ARTICLES_KEY = 'gdelt:bulk:country-articles:v1';

// All GDELT ingestion happens in the Railway bulk materializer
// (scripts/seed-gdelt-bulk-materializer.mjs, #5843). This handler reads
// pre-seeded topic data from Redis only (gold standard: Vercel reads,
// Railway writes).
//
// Two query forms:
//   - free text        matched against the six seeded intel topics;
//   - `country:<ISO2>` the materializer's rolling per-country index (#7748),
//                      the grounding pool the crawlable country pages top up
//                      their "Recent developments" from when the news digest
//                      never names the country. The operator form follows the
//                      DOC API's own `sourcecountry:`/`sourcelang:` grammar.
//                      A row is served only when its TITLE names the country
//                      by the shared matcher: the index is keyed on GKG
//                      locations, and a location mention alone is how
//                      Togo's page once carried a UN world-map vote.
//                      Three error strings, kept distinct because the freeze
//                      treats them differently: `seed-unavailable` (the index
//                      key is missing — a run-wide condition), and the two
//                      transient reads `index-read-failed` and
//                      `revocations-unavailable` (that one request's failure).

interface CountryIndexRow {
  title?: unknown;
  url?: unknown;
  source?: unknown;
  date?: unknown;
  tone?: unknown;
}

export interface SeededCountryIndex {
  byCountry?: Record<string, CountryIndexRow[]>;
}

const COUNTRY_QUERY_RE = /^country:([a-z]{2})$/i;
const DEFAULT_MAX_RECORDS = 10;
const MAX_RECORDS_CAP = 20;

/** ISO-2 code from a `country:XX` query, or null for every other query. */
export function parseCountryQuery(query: unknown): string | null {
  if (typeof query !== 'string') return null;
  const code = query.trim().match(COUNTRY_QUERY_RE)?.[1];
  return code ? code.toUpperCase() : null;
}

function boundedMaxRecords(maxRecords: number): number {
  return Math.min(maxRecords > 0 ? maxRecords : DEFAULT_MAX_RECORDS, MAX_RECORDS_CAP);
}

function normalizeArticleUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

/**
 * Publishable rows for one country from the seeded index, in index order
 * (primary mentions first, newest first). Revoked URLs are dropped like every
 * other digest-derived surface (#7084); the title must name the country.
 */
export function selectCountryArticles(
  index: SeededCountryIndex | null | undefined,
  countryCode: string,
  { revokedUrls = new Set<string>(), maxRecords = DEFAULT_MAX_RECORDS }: { revokedUrls?: ReadonlySet<string>; maxRecords?: number } = {},
): GdeltArticle[] {
  const code = String(countryCode || '').trim().toUpperCase();
  const rows = index?.byCountry && typeof index.byCountry === 'object' ? index.byCountry[code] : null;
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const terms = countryMentionTerms(code);
  const limit = boundedMaxRecords(maxRecords);
  const out: GdeltArticle[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (out.length >= limit) break;
    const title = typeof row?.title === 'string' ? row.title.replace(/\s+/g, ' ').trim() : '';
    const url = normalizeArticleUrl(row?.url);
    if (!title || !url || seen.has(url) || revokedUrls.has(url)) continue;
    if (!mentionsCountry(title, terms)) continue;
    seen.add(url);
    const tone = typeof row?.tone === 'number' && Number.isFinite(row.tone) ? row.tone : 0;
    out.push({
      title,
      url,
      source: typeof row?.source === 'string' && row.source.trim() ? row.source.trim() : new URL(url).hostname,
      date: typeof row?.date === 'string' ? row.date : '',
      image: '',
      language: 'English',
      tone,
    });
  }
  return out;
}

// The index is ~250 countries x 10 rows; read it on the pipeline deadline
// (getLargeRawJson) rather than getCachedJson's short GET deadline, and keep
// a read failure distinguishable from a miss: a timeout answered as
// `seed-unavailable` would settle the freeze's whole run as index-less.
async function readCountryIndex(): Promise<{ index: SeededCountryIndex | null; failed: boolean }> {
  try {
    return { index: (await getLargeRawJson(COUNTRY_ARTICLES_KEY)) as SeededCountryIndex | null, failed: false };
  } catch {
    return { index: null, failed: true };
  }
}

async function searchCountryArticles(
  query: string,
  countryCode: string,
  maxRecords: number,
): Promise<SearchGdeltDocumentsResponse> {
  const [{ index, failed }, revoked] = await Promise.all([
    readCountryIndex(),
    readRevokedUrlSet(),
  ]);
  if (failed) {
    return { articles: [], query, error: 'index-read-failed' };
  }
  if (!index || typeof index !== 'object' || !index.byCountry || typeof index.byCountry !== 'object') {
    // Distinct signal: the index is missing/expired, not "no articles for
    // this country". The freeze records it once and stops asking.
    return { articles: [], query, error: 'seed-unavailable' };
  }
  // Fail CLOSED on an unreadable suppression set, like the digest and the
  // brief grounding: rows served here reach prerendered pages.
  if (!revoked.readable) {
    return { articles: [], query, error: 'revocations-unavailable' };
  }
  return {
    articles: selectCountryArticles(index, countryCode, { revokedUrls: revoked.urls, maxRecords }),
    query,
    error: '',
  };
}

export async function searchGdeltDocuments(
  _ctx: ServerContext,
  req: SearchGdeltDocumentsRequest,
): Promise<SearchGdeltDocumentsResponse> {
  if (!req.query || req.query.length < 2) {
    return { articles: [], query: req.query || '', error: 'Query parameter required' };
  }

  try {
    const countryCode = parseCountryQuery(req.query);
    if (countryCode) {
      return await searchCountryArticles(req.query, countryCode, req.maxRecords);
    }

    const read = await readCachedJson(SEEDED_KEY, true);
    if (read.status === 'error') {
      logCacheReadError(SEEDED_KEY, read.error);
      return { articles: [], query: req.query, error: 'seed-read-failed' };
    }
    // Invalid articles are dropped per topic (the seeder can write an empty
    // title); only a missing, malformed or all-invalid snapshot is unavailable.
    const seeded = read.status === 'hit' ? normalizeGdeltTopicSnapshot(read.value) : null;
    if (!seeded) {
      // Distinct signal: seed is missing/expired/malformed, not "no articles matched".
      return { articles: [], query: req.query, error: 'seed-unavailable' };
    }

    const queryLower = req.query.toLowerCase();
    const match = seeded.topics.find(t =>
      queryLower.includes(t.id) || t.articles.some(a => a.title.toLowerCase().includes(queryLower.slice(0, 20)))
    );

    if (!match) {
      return { articles: [], query: req.query, error: '' };
    }

    const maxRecords = boundedMaxRecords(req.maxRecords);
    return {
      articles: match.articles.slice(0, maxRecords),
      query: req.query,
      error: '',
    };
  } catch {
    return { articles: [], query: req.query, error: 'seed-read-failed' };
  }
}
