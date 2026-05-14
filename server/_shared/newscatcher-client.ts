/**
 * Newscatcher News API v3 client.
 *
 * Endpoints we use:
 *   • POST /api/latest_headlines — fresh news in a time window. Best fit
 *                                  for the live-news cron.
 *   • POST /api/search           — keyword search. Used for the conflict
 *                                  archive's manual seed.
 *
 * Auth: `x-api-token` header. Token comes from env NEWSCATCHER_API_TOKEN.
 *
 * Key features we lean on:
 *   • `clustering_enabled` groups same-story articles across outlets —
 *     each cluster becomes one feed item with sources[] filled from the
 *     cluster's members.
 *   • `include_nlp_data` adds an `nlp` block with summary, sentiment,
 *     theme, and named entities (persons/locations/orgs/misc).
 *   • `nlp.summary` is provided by the API — license-safe to ship to
 *     clients verbatim. We never substitute an LLM rewrite (same rule
 *     as for worldnews and webz).
 *
 * The client returns `null` on any failure — callers (crons) treat null
 * as "skip this run, accumulator keeps the last good payload."
 */

const API_BASE = 'https://v3-api.newscatcherapi.com';
const DEFAULT_TIMEOUT_MS = 12_000;       // Newscatcher's NLP enrichment can be slower

let backoffUntilMs = 0;
let lastBackoffReason: 'rate-limit' | 'quota-exhausted' | null = null;

/** In-flight coalescing — concurrent identical requests share one upstream
 *  call. Keyed by `${endpoint}::${stableBodyJSON}`. */
const inflight = new Map<string, Promise<unknown>>();

function getToken(): string | null {
  const t = process.env.NEWSCATCHER_API_TOKEN;
  if (!t) {
    console.warn('[newscatcher] NEWSCATCHER_API_TOKEN env var is not set — all calls will be skipped');
    return null;
  }
  return t;
}

// ─────────────────────────────────────────────────────────────────────────
// Response shapes — only the fields we actually consume.
// ─────────────────────────────────────────────────────────────────────────

export interface NewscatcherNerEntity {
  entity_name: string;
  count?: number;
}

export interface NewscatcherNlp {
  summary?: string;             // multi-paragraph; license-safe to ship
  /** One or more comma-separated theme strings (e.g. "Crime, Politics"). */
  theme?: string;
  /**
   * Object form `{ title, content }` with floats in [-1, 1]. Some older
   * payloads may use a single string ("positive" / "negative") instead —
   * union covers both shapes defensively.
   */
  sentiment?: { title: number; content: number } | string;
  /** Top-level scalars; observed as null in live responses — sentiment
   *  actually lives inside `sentiment.title` / `sentiment.content`. */
  title_sentiment?: number | null;
  content_sentiment?: number | null;
  ner_PER?: NewscatcherNerEntity[];
  ner_LOC?: NewscatcherNerEntity[];
  ner_ORG?: NewscatcherNerEntity[];
  ner_MISC?: NewscatcherNerEntity[];
  iptc_tags_name?: string[];
}

export interface NewscatcherArticle {
  id: string;                   // 32-char hex
  title: string;
  link: string;
  published_date: string;       // "YYYY-MM-DD HH:MM:SS" — assumed UTC
  updated_date?: string;
  language?: string;            // ISO 639-1, e.g. "en"
  country?: string;             // ISO 3166-1 alpha-2 (source country, not story location)
  name_source?: string;         // outlet name, e.g. "Inquirer.net"
  domain_url?: string;
  full_domain_url?: string;
  authors?: string[];
  author?: string;
  media?: string;               // image URL
  description?: string;
  content?: string;             // full body
  word_count?: number;
  is_headline?: boolean;
  is_opinion?: boolean;
  paid_content?: boolean;
  rank?: number;
  rights?: string | null;
  score?: number;
  nlp?: NewscatcherNlp;
}

export interface NewscatcherCluster {
  cluster_id: string;
  cluster_size: number;
  articles: NewscatcherArticle[];
}

/** Response when `clustering_enabled=true`. */
export interface NewscatcherClusteredResponse {
  status: string;
  total_hits: number;
  page: number;
  total_pages: number;
  page_size: number;
  clusters_count: number;
  clusters: NewscatcherCluster[];
  user_input?: unknown;
}

/** Response when clustering is OFF (flat articles list). */
export interface NewscatcherFlatResponse {
  status: string;
  total_hits: number;
  page: number;
  total_pages: number;
  page_size: number;
  articles: NewscatcherArticle[];
  user_input?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface LatestHeadlinesParams {
  /** Time window — e.g. "1h", "24h", "7d". Required by the endpoint. */
  when: string;
  /** Comma-separated ISO 639-1 codes, e.g. "en" or "en,es". */
  lang?: string;
  /** Comma-separated ISO 3166-1 alpha-2 codes, e.g. "US,GB,AU,CA". */
  countries?: string;
  /** Comma-separated theme names; one of 16 fixed strings. */
  theme?: string;
  /** Same shape — themes to exclude. */
  not_theme?: string;
  /** Required for the NLP block (summary, ner_LOC, etc.). */
  include_nlp_data?: boolean;
  /** Cluster same-story articles together. Strongly recommended. */
  clustering_enabled?: boolean;
  /** 0.6 broad, 0.7 default, 0.8-0.9 tight. */
  clustering_threshold?: number;
  /** Default 10, max 1000. Set ≥ expected total hits for tight clustering. */
  page_size?: number;
}

/**
 * `/api/search` accepts most of the latest_headlines params EXCEPT `when`
 * — that one only exists on `/api/latest_headlines` and returns 403
 * Invalid Parameter on search. Search uses `from_` / `to_` instead.
 */
export interface SearchParams extends Omit<LatestHeadlinesParams, 'when'> {
  /** Lucene-ish boolean query, required. */
  q: string;
  /** "title", "content", "title_content", "title_content_translated". */
  search_in?: string;
  /** Earliest publish date — `YYYY-MM-DD` or full ISO 8601. */
  from_?: string;
  /** Latest publish date — same format. */
  to_?: string;
}

/**
 * Fetch fresh headlines from `/api/latest_headlines`. When
 * `clustering_enabled` is true the response is a `NewscatcherClusteredResponse`;
 * otherwise a `NewscatcherFlatResponse`. Callers know which they asked for.
 */
export function latestHeadlines(params: LatestHeadlinesParams): Promise<NewscatcherClusteredResponse | NewscatcherFlatResponse | null> {
  return post<NewscatcherClusteredResponse | NewscatcherFlatResponse>(
    '/api/latest_headlines',
    params as unknown as Record<string, unknown>,
  );
}

/**
 * Run a keyword search. Same response shape variants as `latestHeadlines`.
 */
export function searchNews(params: SearchParams): Promise<NewscatcherClusteredResponse | NewscatcherFlatResponse | null> {
  return post<NewscatcherClusteredResponse | NewscatcherFlatResponse>(
    '/api/search',
    params as unknown as Record<string, unknown>,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers — mappers from Newscatcher → our wire shape.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Bare hostname for an article. Prefers the explicit `domain_url` (which
 * Newscatcher returns minus the `www.`), falls back to URL parsing.
 */
export function deriveSource(article: NewscatcherArticle): string {
  const d = article.domain_url?.trim();
  if (d) return d.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  try {
    return new URL(article.link).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Parse Newscatcher's "YYYY-MM-DD HH:MM:SS" datestring → ms epoch.
 * Assumes UTC (the API treats these as UTC even though no `Z` suffix).
 */
export function parsePublishDate(s: string | undefined): number | null {
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Pick the named location with the highest mention count as the article's
 * initial `locationName`. Returns null if NLP didn't surface any locations.
 * The enrichment cron may overwrite with a more precise place later.
 */
export function deriveLocationName(article: NewscatcherArticle): string | null {
  const locs = article.nlp?.ner_LOC ?? [];
  if (locs.length === 0) return null;
  const top = [...locs].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
  const name = top?.entity_name?.trim();
  return name && name.length > 0 ? name : null;
}

/**
 * Use the API's NLP summary verbatim — license-safe. If absent (rare),
 * return null rather than fabricating one.
 */
export function deriveSummary(article: NewscatcherArticle, maxLen = 500): string | null {
  const s = article.nlp?.summary?.trim();
  if (s && s.length > 0) return s.slice(0, maxLen);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Low-level POST.
// ─────────────────────────────────────────────────────────────────────────

async function post<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  if (backoffUntilMs > Date.now()) {
    console.warn(
      `[newscatcher] ${path} skipped — ${lastBackoffReason} back-off until ${new Date(backoffUntilMs).toISOString()}`,
    );
    return null;
  }

  const token = getToken();
  if (!token) return null;

  // Stable cache key for coalescing — sort body keys so semantically
  // equivalent calls hash the same string.
  const sortedBody = Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)),
  );
  const bodyJson = JSON.stringify(sortedBody);
  const cacheKey = `${path}::${bodyJson}`;

  const existing = inflight.get(cacheKey) as Promise<T | null> | undefined;
  if (existing) return existing;

  const promise = (async (): Promise<T | null> => {
    try {
      const resp = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-api-token': token,
        },
        body: bodyJson,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      if (resp.status === 429) {
        const retryAfter = Number(resp.headers.get('retry-after')) || 5;
        backoffUntilMs = Date.now() + retryAfter * 1000;
        lastBackoffReason = 'rate-limit';
        console.warn(`[newscatcher] ${path} → 429, backing off ${retryAfter}s`);
        return null;
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.warn(`[newscatcher] ${path} → HTTP ${resp.status} ${text.slice(0, 200)}`);
        if (resp.status === 401 || resp.status === 402 || resp.status === 403) {
          // Auth / quota errors — back off for the rest of the UTC day so
          // we don't burn budget retrying a doomed call every cron tick.
          const now = new Date();
          backoffUntilMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0);
          lastBackoffReason = 'quota-exhausted';
        }
        return null;
      }

      return (await resp.json()) as T;
    } catch (err) {
      console.warn(`[newscatcher] ${path} failed:`, err instanceof Error ? err.message : err);
      return null;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, promise);
  return promise;
}

/**
 * Type guard — narrows a non-null response to the clustered shape.
 */
export function isClusteredResponse(
  r: NewscatcherClusteredResponse | NewscatcherFlatResponse,
): r is NewscatcherClusteredResponse {
  return 'clusters' in r && Array.isArray((r as NewscatcherClusteredResponse).clusters);
}
