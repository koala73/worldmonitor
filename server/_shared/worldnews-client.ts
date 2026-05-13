/**
 * World News API client — paid licensed feed used by the new live-news v3
 * and conflict-archive v2 endpoints.
 *
 * Endpoints we use:
 *   • topNews        — clustered top stories (multi-source per cluster).
 *                      Replaces RSS aggregation + LLM dedup. One call →
 *                      ~10 clusters × ~1-10 articles, each cluster becomes
 *                      a canonical item with sources[].
 *   • searchNews     — keyword search with date/country/source filters.
 *                      Used for the conflict-archive feed and topic
 *                      backfill.
 *   • retrieveNews   — fetch by article id (warming full text on cache
 *                      miss).
 *   • geoCoordinates — place name → lat/lng. Optional fallback for the
 *                      enrichment cron when an LLM-extracted location
 *                      needs geocoding.
 *
 * Auth: `api-key` query param (header form is not documented).
 *
 * Quota (verified from worldnewsapi.com/pricing):
 *   • Free:        50 pts/day,  1 req/sec, 1 concurrent.
 *   • Reporter:    500 pts/day, 2 req/sec, 5 concurrent.   ($39/mo)
 *   • Journalist:  5000 pts/day,10 req/sec, 10 concurrent. ($379/mo)
 *
 * Cost: 1 point per request + 0.01 points per result returned.
 * `number=100` therefore costs ~2 points.
 *
 * Error codes:
 *   • 402 — daily quota exhausted (resets at UTC midnight).
 *   • 429 — rate limit (per-second cap).
 *
 * The client returns `null` on any failure rather than throwing —
 * callers (crons, mostly) should treat null as "skip this run, accumulator
 * keeps the last good payload."
 */

const API_BASE = 'https://api.worldnewsapi.com';
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Shared back-off state — if we get 429 or 402, every subsequent call
 * skips until the timestamp elapses. Module-level because the isolate
 * persists across requests for the warm-cache window.
 */
let backoffUntilMs = 0;
let lastBackoffReason: 'rate-limit' | 'quota-exhausted' | null = null;

/**
 * In-flight coalescing — concurrent identical requests share one upstream
 * call. Keyed by the full request URL (api-key included since it's a
 * query param, but the same key string is reused).
 */
const inflight = new Map<string, Promise<unknown>>();

function getApiKey(): string | null {
  const key = process.env.WORLDNEWS_API_KEY;
  if (!key) {
    console.warn('[worldnews] WORLDNEWS_API_KEY env var is not set — all calls will be skipped');
    return null;
  }
  return key;
}

/**
 * Build a query string with stable key ordering and skip undefined values.
 */
function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const usp = new URLSearchParams();
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  return usp.toString();
}

/**
 * Low-level GET. Handles auth, back-off, 429/402, timeout, JSON parse,
 * quota-header logging, and in-flight coalescing.
 *
 * Returns `null` on any failure. Callers don't get to see the error type
 * (already logged here); they just decide whether to fall back to a cached
 * value or skip a cron tick.
 */
async function get<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T | null> {
  if (backoffUntilMs > Date.now()) {
    console.warn(
      `[worldnews] ${path} skipped — ${lastBackoffReason} back-off until ${new Date(backoffUntilMs).toISOString()}`,
    );
    return null;
  }

  const apiKey = getApiKey();
  if (!apiKey) return null;

  const qs = buildQuery({ ...params, 'api-key': apiKey });
  const url = `${API_BASE}${path}?${qs}`;
  // Coalesce concurrent identical calls — important for top-news where
  // multiple cron triggers in dev / rapid-redeploy can race.
  const existing = inflight.get(url) as Promise<T | null> | undefined;
  if (existing) return existing;

  const promise = (async (): Promise<T | null> => {
    try {
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      // Quota headers come back on every response (including errors).
      // We log them once per call so the cron log shows the running cost.
      const used = resp.headers.get('x-api-quota-used');
      const left = resp.headers.get('x-api-quota-left');
      const request = resp.headers.get('x-api-quota-request');
      if (used || left) {
        console.log(`[worldnews] ${path} quota: used=${used} left=${left} req=${request}`);
      }

      // 402 — daily quota exhausted. Back off until next UTC midnight.
      if (resp.status === 402) {
        const now = new Date();
        const tomorrowUtcMidnight = Date.UTC(
          now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0,
        );
        backoffUntilMs = tomorrowUtcMidnight;
        lastBackoffReason = 'quota-exhausted';
        console.warn(`[worldnews] ${path} → 402 quota exhausted, backing off until ${new Date(backoffUntilMs).toISOString()}`);
        return null;
      }

      // 429 — rate limit (Free=1/s, Reporter=2/s, Journalist=10/s). The
      // docs don't promise a Retry-After header, so we use a fixed 5 s
      // back-off — long enough for the per-second window to drain.
      if (resp.status === 429) {
        const retryAfter = Number(resp.headers.get('retry-after')) || 5;
        backoffUntilMs = Date.now() + retryAfter * 1000;
        lastBackoffReason = 'rate-limit';
        console.warn(`[worldnews] ${path} → 429 rate-limited, backing off ${retryAfter}s`);
        return null;
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.warn(`[worldnews] ${path} → HTTP ${resp.status} ${body.slice(0, 200)}`);
        return null;
      }

      return (await resp.json()) as T;
    } catch (err) {
      console.warn(`[worldnews] ${path} failed:`, err instanceof Error ? err.message : err);
      return null;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, promise);
  return promise;
}

// ─────────────────────────────────────────────────────────────────────────
// Response shapes (only fields we actually consume)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Per-article shape returned by search-news and top-news. Fields marked
 * "always" appear on every article tested with the live API; "often"
 * means present on most but not all (we treat missing as null/empty).
 *
 * `text` is the full article body — can be tens of KB. Strip before
 * persisting to Redis to keep accumulator size sane.
 */
export interface WorldNewsArticle {
  id: number;                  // always — stable across calls
  title: string;               // always
  url: string;                 // always — full canonical URL
  publish_date: string;        // always — "YYYY-MM-DD HH:MM:SS" (UTC)
  language: string;            // always — ISO 639-1
  source_country: string;      // always — ISO 3166-1 alpha-2 (sometimes upper, sometimes lower)
  authors: string[];           // always — may be empty
  author?: string | null;      // often
  text?: string;               // always but huge — caller should drop before caching
  summary?: string;            // often — short outlet-provided summary
  image?: string | null;       // often
  video?: string | null;       // rarely
  category?: string;           // often — taxonomy is unreliable, don't depend on it
  sentiment?: number;          // often — -1..+1
}

export interface SearchNewsResponse {
  offset: number;
  number: number;
  available: number;
  news: WorldNewsArticle[];
}

export interface TopNewsCluster {
  /** Articles in the cluster, sorted by the API. First entry = canonical. */
  news: WorldNewsArticle[];
}

export interface TopNewsResponse {
  top_news: TopNewsCluster[];
  language: string;
  country: string;
}

export interface RetrieveNewsResponse {
  news: WorldNewsArticle[];
}

export interface GeoCoordinatesResponse {
  latitude: number;
  longitude: number;
  city: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface SearchNewsParams {
  /** Free-text query — at least one filter is required by the API. */
  text?: string;
  /** ISO 2-letter language code, e.g. `en`. */
  language?: string;
  /** Comma-separated ISO country codes, e.g. `us,gb`. */
  sourceCountries?: string;
  /** `lat,lng,radius-km` — radius is capped at 100 km by the API. */
  locationFilter?: string;
  /** Comma-separated category names. */
  categories?: string;
  /** Comma-separated outlet URLs to whitelist, e.g. `https://reuters.com`. */
  newsSources?: string;
  /** ISO date or `YYYY-MM-DD HH:MM:SS`. */
  earliestPublishDate?: string;
  /** ISO date or `YYYY-MM-DD HH:MM:SS`. */
  latestPublishDate?: string;
  /** Sort field, e.g. `publish-time`. */
  sort?: string;
  /** `ASC` or `DESC`. */
  sortDirection?: 'ASC' | 'DESC';
  /** Pagination — default 0. */
  offset?: number;
  /** Page size — default 10, max 100. Each result costs 0.01 pts. */
  number?: number;
}

export function searchNews(params: SearchNewsParams): Promise<SearchNewsResponse | null> {
  return get<SearchNewsResponse>('/search-news', {
    text: params.text,
    language: params.language,
    'source-countries': params.sourceCountries,
    'location-filter': params.locationFilter,
    categories: params.categories,
    'news-sources': params.newsSources,
    'earliest-publish-date': params.earliestPublishDate,
    'latest-publish-date': params.latestPublishDate,
    sort: params.sort,
    'sort-direction': params.sortDirection,
    offset: params.offset,
    number: params.number,
  });
}

export interface TopNewsParams {
  /** ISO 2-letter country code, e.g. `us`. Required. */
  sourceCountry: string;
  /** ISO 2-letter language code, e.g. `en`. Required. */
  language: string;
  /** If true, returns only headlines (no body text) — cheaper payloads. */
  headlinesOnly?: boolean;
  /** Optional date for historical top-news; defaults to "now". */
  date?: string;
}

export function topNews(params: TopNewsParams): Promise<TopNewsResponse | null> {
  return get<TopNewsResponse>('/top-news', {
    'source-country': params.sourceCountry,
    language: params.language,
    'headlines-only': params.headlinesOnly,
    date: params.date,
  });
}

export function retrieveNews(ids: number[]): Promise<RetrieveNewsResponse | null> {
  if (ids.length === 0) return Promise.resolve({ news: [] });
  return get<RetrieveNewsResponse>('/retrieve-news', {
    ids: ids.join(','),
  });
}

export function geoCoordinates(location: string): Promise<GeoCoordinatesResponse | null> {
  return get<GeoCoordinatesResponse>('/geo-coordinates', { location });
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers — used by the crons that map the response into our wire shape
// ─────────────────────────────────────────────────────────────────────────

/**
 * Domain extracted from an article URL — the iOS `NewsItem.source`
 * convention is the bare host, e.g. `reuters.com`. Strips the leading
 * `www.` for consistency.
 *
 * Returns empty string on a malformed URL — callers should drop those
 * items rather than ship a sourceless wire item.
 */
export function deriveSource(articleUrl: string): string {
  try {
    return new URL(articleUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Parse the API's `publish_date` field ("YYYY-MM-DD HH:MM:SS" in UTC) to
 * a millisecond epoch. The wire format on our side is ms since epoch
 * (matches iOS `NewsItem.publishedAt`).
 *
 * Returns `null` if unparseable so callers can decide to skip the item.
 */
export function parsePublishDate(s: string | undefined): number | null {
  if (!s) return null;
  // Append Z so the JS parser treats the bare timestamp as UTC.
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
