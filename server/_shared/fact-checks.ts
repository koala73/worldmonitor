/**
 * Published fact-checks for a claim (#9094).
 *
 * WorldMonitor does not rate claims (#6419). This module finds ratings that
 * accredited fact-checkers have already published and returns them for
 * citation, the way a wire report is quoted: "Rated False by PolitiFact on
 * 3 Oct", with the fact-checker, date and link. The rating text is passed
 * through exactly as the fact-checker wrote it; nothing here maps it onto a
 * scale, combines ratings, or feeds them into the coverage verdict.
 *
 * Uniform application: every rule below reads only the claim text, the
 * fact-check's own fields and the IFCN allowlist. There is no list of people,
 * parties, topics or countries, and no threshold varies by them
 * (tests/fact-checks.test.mts checks this).
 */
import FACT_CHECKERS from '../../shared/fact-checkers.json';
import { claimOverlap, claimTokens } from './claim-match';

/** Google Fact Check Tools API, claims:search (v1alpha1). */
export const FACT_CHECK_SEARCH_URL = 'https://factchecktools.googleapis.com/v1alpha1/claims:search';

/** Server-side key for the Fact Check Tools API. Never sent to the browser. */
export const FACT_CHECK_API_KEY_ENV = 'GOOGLE_FACT_CHECK_API_KEY';

/** Owner decision (#9094): English fact-checks only, for now. */
export const FACT_CHECK_LANGUAGE = 'en';

/**
 * A fact-check is shown only when its reviewed claim and the user's claim
 * each carry this share of the other's content words. Both directions, so a
 * short claim cannot match a long, different one that happens to contain it.
 */
export const FACT_CHECK_MATCH_MIN_SCORE = 0.6;

/** ...and they share at least this many content words. */
export const FACT_CHECK_MATCH_MIN_SHARED = 3;

/** Fact-checks returned per claim, newest first. */
export const FACT_CHECK_MAX_RESULTS = 10;

/** Claims requested from the API per search; matching then keeps the strong ones. */
export const FACT_CHECK_SEARCH_PAGE_SIZE = 20;

/** Shown above every fact-check: the match is to a similar claim, never "this claim". */
export const FACT_CHECK_LABEL = 'A published fact-check of a similar claim';

/** Shown with every fact-check list, found or not. */
export const FACT_CHECK_CAVEAT = 'Ratings are the fact-checkers\' own, quoted with attribution from IFCN-verified signatories. WorldMonitor does not rate claims, and a rating never changes the coverage result above.';

/**
 * Longest rating and rated claim accepted. Text is never cut: a longer one is
 * dropped, because a cut rating is no longer the fact-checker's words and a
 * cut claim would be matched on its opening alone.
 */
const RATING_MAX_CHARS = 200;
const REVIEWED_CLAIM_MAX_CHARS = 1000;
const TITLE_MAX_CHARS = 200;

/** IFCN-verified fact-checker domains (shared/fact-checkers.json). */
export const FACT_CHECKER_DOMAINS: ReadonlySet<string> = new Set(
  (FACT_CHECKERS as { domains: string[] }).domains.map(normalizeHost),
);

/** The IFCN snapshot the allowlist was copied from. */
export const FACT_CHECKER_SNAPSHOT: string = (FACT_CHECKERS as { snapshot: string }).snapshot;

function normalizeHost(host: string): string {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/**
 * The allowlisted domain a fact-check URL belongs to, or null. The link's own
 * host decides, not the publisher name the feed reports, so a rating is only
 * shown with a link that really goes to an IFCN signatory's site (the domain
 * itself or a subdomain of it, such as factcheck.afp.com under afp.com).
 */
export function factCheckerDomainFor(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = normalizeHost(parsed.hostname);
  if (FACT_CHECKER_DOMAINS.has(host)) return host;
  for (let dot = host.indexOf('.'); dot !== -1; dot = host.indexOf('.', dot + 1)) {
    const parent = host.slice(dot + 1);
    if (FACT_CHECKER_DOMAINS.has(parent)) return parent;
  }
  return null;
}

/**
 * True when a fact-checked claim is about the same thing as the user's claim:
 * the strong-match rule above, on content words only.
 */
export function isStrongFactCheckMatch(claim: string, reviewedClaim: string): boolean {
  const forward = claimOverlap(claim, reviewedClaim);
  if (forward.score < FACT_CHECK_MATCH_MIN_SCORE || forward.shared < FACT_CHECK_MATCH_MIN_SHARED) return false;
  return claimOverlap(reviewedClaim, claim).score >= FACT_CHECK_MATCH_MIN_SCORE;
}

/** A claim can only match strongly when it has enough content words; shorter ones skip the API call. */
export function claimCanMatchFactChecks(claim: string): boolean {
  return new Set(claimTokens(claim)).size >= FACT_CHECK_MATCH_MIN_SHARED;
}

/** The fields of a claims:search result this module reads. */
export type FactCheckApiClaim = {
  readonly text?: string;
  readonly claimReview?: ReadonlyArray<{
    readonly publisher?: { readonly name?: string; readonly site?: string };
    readonly url?: string;
    readonly title?: string;
    readonly reviewDate?: string;
    readonly textualRating?: string;
    readonly languageCode?: string;
  }>;
};

export type FactCheck = {
  /** The fact-checker's name as it publishes it, or its domain when the feed gives none. */
  readonly publisher: string;
  /** The IFCN-allowlisted domain the link belongs to. */
  readonly site: string;
  /** The fact-checker's own rating, verbatim ("False", "Mostly false", "Four Pinocchios"). */
  readonly rating: string;
  /** When the fact-check was published (ISO 8601). */
  readonly reviewedAt: string;
  readonly url: string;
  /** The fact-check article's headline; empty when the feed gives none. */
  readonly title: string;
  /** The claim the fact-checker rated, which is similar to, not the same as, the claim checked. */
  readonly claimReviewed: string;
};

/** The text with whitespace collapsed, or '' when it is longer than max (never cut). */
function whole(text: unknown, max: number): string {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return value.length <= max ? value : '';
}

function clip(text: unknown, max: number): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * The fact-checks to cite for a claim, from claims:search results: strong
 * matches only, IFCN-allowlisted links only, English only, each with a rating
 * and a publication date. Disagreeing ratings are all kept, newest first, with
 * no tie-breaking. Old ratings are kept too (sorted last), because the date is
 * always shown with them.
 */
export function selectFactChecks(claim: string, apiClaims: readonly FactCheckApiClaim[]): FactCheck[] {
  const seen = new Set<string>();
  const out: FactCheck[] = [];
  // The input is a cache read, so any shape is possible; a malformed entry selects nothing.
  for (const apiClaim of Array.isArray(apiClaims) ? apiClaims : []) {
    const claimReviewed = whole(apiClaim?.text, REVIEWED_CLAIM_MAX_CHARS);
    if (!claimReviewed || !isStrongFactCheckMatch(claim, claimReviewed)) continue;
    for (const review of Array.isArray(apiClaim.claimReview) ? apiClaim.claimReview : []) {
      const url = whole(review?.url, 2048);
      const site = factCheckerDomainFor(url);
      if (!site || seen.has(url)) continue;
      const language = clip(review.languageCode, 16).toLowerCase();
      if (language && language !== FACT_CHECK_LANGUAGE && !language.startsWith(`${FACT_CHECK_LANGUAGE}-`)) continue;
      const rating = whole(review.textualRating, RATING_MAX_CHARS);
      const reviewedMs = Date.parse(clip(review.reviewDate, 64));
      // Every rating shown names its date (#9094 acceptance), so one without
      // a valid date is not shown.
      if (!rating || !Number.isFinite(reviewedMs)) continue;
      seen.add(url);
      out.push({
        publisher: whole(review.publisher?.name, 120) || site,
        site,
        rating,
        reviewedAt: new Date(reviewedMs).toISOString(),
        url,
        title: clip(review.title, TITLE_MAX_CHARS),
        claimReviewed,
      });
    }
  }
  return out
    .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt) || a.site.localeCompare(b.site))
    .slice(0, FACT_CHECK_MAX_RESULTS);
}

/** The claims:search request for a claim (the key is added by the caller). */
export function factCheckSearchUrl(claim: string, apiKey: string): string {
  const params = new URLSearchParams({
    query: claim,
    languageCode: FACT_CHECK_LANGUAGE,
    pageSize: String(FACT_CHECK_SEARCH_PAGE_SIZE),
    key: apiKey,
  });
  return `${FACT_CHECK_SEARCH_URL}?${params}`;
}

/**
 * The fields of each result this module reads, so a cache entry holds no more
 * than selectFactChecks needs.
 */
export function compactApiClaims(body: unknown): FactCheckApiClaim[] {
  const claims = (body as { claims?: unknown })?.claims;
  if (!Array.isArray(claims)) return [];
  return claims.slice(0, FACT_CHECK_SEARCH_PAGE_SIZE).map((raw: FactCheckApiClaim) => ({
    text: whole(raw?.text, REVIEWED_CLAIM_MAX_CHARS),
    claimReview: (Array.isArray(raw?.claimReview) ? raw.claimReview : []).slice(0, 10).map((review) => ({
      publisher: { name: whole(review?.publisher?.name, 120), site: whole(review?.publisher?.site, 253) },
      url: whole(review?.url, 2048),
      title: clip(review?.title, TITLE_MAX_CHARS),
      reviewDate: clip(review?.reviewDate, 64),
      textualRating: whole(review?.textualRating, RATING_MAX_CHARS),
      languageCode: clip(review?.languageCode, 16),
    })),
  }));
}
