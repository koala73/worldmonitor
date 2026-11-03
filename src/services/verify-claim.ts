/**
 * The /verify page's data path (#9092): the fresh headlines that share the
 * claim's words, then the same evidence card the verify_claim MCP tool
 * returns, built in the browser. Nothing here grades a claim; see
 * server/_shared/claim-match.ts.
 *
 * Deliberately standalone: this is a separate Vite entry, and every module it
 * shares with the dashboard becomes a shared chunk in the dashboard's build.
 * So the read and the item mapping are inlined here rather than reached
 * through runtime.ts and public-rpc-fetch.ts.
 */
import type { NewsItemCore } from '../../shared/news-clustering-core.js';
import type { FactCheck } from '../../server/_shared/fact-checks';
import { CLAIM_MAX_CHARS, buildClaimCard, type ClaimCard, type ClaimCardHeadline } from '../../server/_shared/claim-match';

export { CLAIM_MAX_CHARS, type ClaimCard, type ClaimCardHeadline };

/**
 * Searches every fresh headline in the full-variant feed caches, not only the
 * ~280 the dashboard digest serves. Public and same-origin: the page is web-only.
 */
export const CLAIM_HEADLINES_URL = '/api/news/v1/search-claim-headlines';

const CLAIM_HEADLINES_TIMEOUT_MS = 15_000;

export type ClaimSearch = {
  /** The headlines worth clustering for the claim; empty for an empty claim. */
  readonly items: NewsItemCore[];
  readonly searched: number;
  readonly feeds: number;
  readonly readAt: string;
};

type ClaimHeadlineBody = {
  source?: unknown;
  title?: unknown;
  link?: unknown;
  publishedAt?: unknown;
};

export type ClaimSearchBody = {
  headlines?: ClaimHeadlineBody[];
  searchedHeadlines?: unknown;
  searchedFeeds?: unknown;
  state?: unknown;
  readAt?: unknown;
};

function toItem(raw: ClaimHeadlineBody): NewsItemCore | null {
  if (typeof raw.title !== 'string' || !raw.title || typeof raw.source !== 'string' || !raw.source) return null;
  return {
    source: raw.source,
    title: raw.title,
    link: typeof raw.link === 'string' ? raw.link : '',
    pubDate: new Date(Number(raw.publishedAt) || 0),
    isAlert: false,
  };
}

const count = (value: unknown): number => (Number.isInteger(value) && Number(value) > 0 ? Number(value) : 0);

/** Null when the search did not run: state unavailable, or nothing searched. */
export function claimSearchFromBody(body: ClaimSearchBody): ClaimSearch | null {
  const searched = count(body.searchedHeadlines);
  if (body.state === 'unavailable' || searched === 0) return null;
  return {
    items: (body.headlines ?? []).flatMap((raw) => {
      const item = raw ? toItem(raw) : null;
      return item ? [item] : [];
    }),
    searched,
    feeds: count(body.searchedFeeds),
    readAt: typeof body.readAt === 'string' ? body.readAt : '',
  };
}

/** The claim search; an empty claim returns only the counts. */
export async function fetchClaimSearch(claim: string, signal?: AbortSignal): Promise<ClaimSearch> {
  const res = await globalThis.fetch(`${CLAIM_HEADLINES_URL}?claim=${encodeURIComponent(normalizeClaim(claim))}`, {
    credentials: 'omit',
    signal: signal ?? AbortSignal.timeout(CLAIM_HEADLINES_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const search = claimSearchFromBody(await res.json() as ClaimSearchBody);
  if (!search) throw new Error('claim search is unavailable');
  return search;
}

/** The claim as the card checks it: trimmed and capped, as the MCP tool does. */
export function normalizeClaim(text: string): string {
  return String(text || '').trim().slice(0, CLAIM_MAX_CHARS);
}

export function checkClaim(text: string, search: ClaimSearch): ClaimCard {
  return buildClaimCard(normalizeClaim(text), search.items, search.searched);
}

export type { FactCheck };

/** Published fact-checks for a claim (#9094): ok means the lookup ran; anything else means it did not. */
export type FactCheckResult = {
  readonly state: 'ok' | 'unavailable' | 'not-configured';
  readonly factChecks: FactCheck[];
  readonly caveat: string;
};

export const FACT_CHECKS_URL = '/api/news/v1/search-fact-checks';
const FACT_CHECKS_TIMEOUT_MS = 10_000;

function isFactCheck(value: unknown): value is FactCheck {
  const v = value as Record<string, unknown> | null;
  return !!v && ['publisher', 'site', 'rating', 'reviewedAt', 'url', 'title', 'claimReviewed']
    .every((field) => typeof v[field] === 'string');
}

/** Never throws: a failed lookup is `unavailable`, which the page shows as "could not be checked", never as none found. */
export async function fetchFactChecks(claim: string, signal?: AbortSignal): Promise<FactCheckResult> {
  try {
    const res = await globalThis.fetch(`${FACT_CHECKS_URL}?claim=${encodeURIComponent(normalizeClaim(claim))}`, {
      credentials: 'omit',
      signal: signal ?? AbortSignal.timeout(FACT_CHECKS_TIMEOUT_MS),
    });
    if (!res.ok) return { state: 'unavailable', factChecks: [], caveat: '' };
    const body = await res.json() as { state?: unknown; factChecks?: unknown; caveat?: unknown };
    const state = body.state === 'ok' || body.state === 'not-configured' ? body.state : 'unavailable';
    return {
      state,
      factChecks: state === 'ok' && Array.isArray(body.factChecks) ? body.factChecks.filter(isFactCheck) : [],
      caveat: typeof body.caveat === 'string' ? body.caveat : '',
    };
  } catch {
    return { state: 'unavailable', factChecks: [], caveat: '' };
  }
}
