/**
 * The fact-check lookup behind SearchFactChecks and verify_claim (#9094): one
 * implementation, so the /verify page and MCP agents get the same answer.
 * verify_claim calls it in-process rather than through the public endpoint,
 * so an agent's check is not a second billed downstream request.
 */
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../api/_sentry-edge.js';
import { cachedFetchJson } from './redis';
import { sha256Hex } from './hash';
import { CLAIM_MAX_CHARS } from './claim-match';
import {
  FACT_CHECK_API_KEY_ENV,
  claimCanMatchFactChecks,
  compactApiClaims,
  factCheckSearchUrl,
  selectFactChecks,
  type FactCheck,
  type FactCheckApiClaim,
} from './fact-checks';

const SEARCH_TIMEOUT_MS = 5_000;
/** Published fact-checks rarely change; a day keeps the free API quota for new claims. */
const SEARCH_CACHE_TTL_S = 24 * 60 * 60;
const USER_AGENT = 'worldmonitor-server/1.0 (fact-checks; +https://www.worldmonitor.app/verify)';

export type FactCheckLookupState = 'ok' | 'unavailable' | 'not-configured';

export type FactCheckLookup = {
  readonly state: FactCheckLookupState;
  readonly factChecks: FactCheck[];
};

type CachedSearch = { claims: FactCheckApiClaim[] };

/** The exact claims:search query for a claim: whitespace collapsed, capped. */
export function factCheckQuery(rawClaim: string): string {
  return String(rawClaim ?? '').replace(/\s+/g, ' ').trim().slice(0, CLAIM_MAX_CHARS);
}

/** The cache identity of a search: the query sent upstream, so every word that changes the search changes the key. */
export async function factCheckCacheKey(query: string): Promise<string> {
  return `factcheck:search:v2:${await sha256Hex(query)}`;
}

/**
 * Published fact-checks for a claim. The upstream answer is cached under the
 * exact query sent; matching and the allowlist run on every read, so changing
 * them needs no cache bump. Never throws: a failed search is `unavailable` and is never
 * cached as "none"; no key is `not-configured`.
 */
export async function lookupFactChecks(rawClaim: string): Promise<FactCheckLookup> {
  const claim = factCheckQuery(rawClaim);
  // Too few content words to match anything strongly: nothing to look up.
  if (!claimCanMatchFactChecks(claim)) return { state: 'ok', factChecks: [] };

  const apiKey = process.env[FACT_CHECK_API_KEY_ENV];
  if (!apiKey) return { state: 'not-configured', factChecks: [] };

  let cached: CachedSearch | null;
  try {
    const cacheKey = await factCheckCacheKey(claim);
    cached = await cachedFetchJson<CachedSearch>(cacheKey, SEARCH_CACHE_TTL_S, async () => {
      const res = await globalThis.fetch(factCheckSearchUrl(claim, apiKey), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`fact-check search HTTP ${res.status}`);
      return { claims: compactApiClaims(await res.json()) };
    });
  } catch (err) {
    console.warn('[fact-checks] search failed:', err instanceof Error ? err.message : String(err));
    captureSilentError(err, {
      tags: { surface: 'server', component: 'fact-checks', stage: 'search' },
      fingerprint: ['fact-checks', 'search'],
      level: 'warning',
    });
    cached = null;
  }
  if (!cached) return { state: 'unavailable', factChecks: [] };
  return { state: 'ok', factChecks: selectFactChecks(claim, cached.claims) };
}
