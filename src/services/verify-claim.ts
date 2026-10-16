/**
 * The /verify page's data path (#9092): one public digest read, then the same
 * evidence card the verify_claim MCP tool returns, built in the browser.
 * Nothing here grades a claim; see server/_shared/claim-match.ts.
 *
 * Deliberately standalone: this is a separate Vite entry, and every module it
 * shares with the dashboard becomes a shared chunk in the dashboard's build.
 * So the digest read and the item mapping are inlined here rather than reached
 * through runtime.ts, public-rpc-fetch.ts and news-digest-items.ts.
 */
import type { NewsItemCore } from '../../shared/news-clustering-core.js';
import type { FactCheck } from '../../server/_shared/fact-checks';
import { CLAIM_MAX_CHARS, buildClaimCard, type ClaimCard, type ClaimCardHeadline } from '../../server/_shared/claim-match';

export { CLAIM_MAX_CHARS, type ClaimCard, type ClaimCardHeadline };

/**
 * The widest digest, in English, on its public CDN cache key (`public=1`; see
 * isPublicSharedRpcRequest). The page is web-only, so the path is same-origin.
 */
export const VERIFY_DIGEST_URL = '/api/news/v1/list-feed-digest?variant=full&lang=en&public=1';

const VERIFY_DIGEST_TIMEOUT_MS = 15_000;

export type ClaimDigest = {
  readonly items: NewsItemCore[];
  readonly publishers: number;
  readonly generatedAt: string;
  readonly stale: boolean;
};

type DigestItem = {
  source?: unknown;
  title?: unknown;
  link?: unknown;
  publishedAt?: unknown;
  isAlert?: unknown;
  credibilityScore?: unknown;
  corroborationCount?: unknown;
};

export type DigestBody = {
  categories?: Record<string, { items?: DigestItem[] } | undefined>;
  generatedAt?: unknown;
  coverage?: { servedStale?: unknown };
};

function toItem(raw: DigestItem): NewsItemCore | null {
  if (typeof raw.title !== 'string' || !raw.title || typeof raw.source !== 'string' || !raw.source) return null;
  const credibility = Number(raw.credibilityScore);
  const corroboration = Number(raw.corroborationCount);
  return {
    source: raw.source,
    title: raw.title,
    link: typeof raw.link === 'string' ? raw.link : '',
    pubDate: new Date(Number(raw.publishedAt) || 0),
    isAlert: raw.isAlert === true,
    ...(raw.credibilityScore != null && Number.isFinite(credibility) ? { credibilityScore: credibility } : {}),
    ...(Number.isFinite(corroboration) && corroboration >= 1 ? { corroborationCount: Math.floor(corroboration) } : {}),
  };
}

/** Digest items, deduplicated by link (one story often sits in several categories). */
export function claimDigestFromBody(body: DigestBody): ClaimDigest {
  const seen = new Set<string>();
  const items: NewsItemCore[] = [];
  for (const group of Object.values(body.categories ?? {})) {
    for (const raw of group?.items ?? []) {
      const item = raw ? toItem(raw) : null;
      if (!item) continue;
      const key = item.link || `${item.source}|${item.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return {
    items,
    publishers: new Set(items.map((item) => item.source)).size,
    generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : '',
    stale: body.coverage?.servedStale === true,
  };
}

export async function fetchClaimDigest(signal?: AbortSignal): Promise<ClaimDigest> {
  const res = await globalThis.fetch(VERIFY_DIGEST_URL, {
    credentials: 'omit',
    signal: signal ?? AbortSignal.timeout(VERIFY_DIGEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const digest = claimDigestFromBody(await res.json() as DigestBody);
  if (digest.items.length === 0) throw new Error('digest returned no headlines');
  return digest;
}

/** The claim as the card checks it: trimmed and capped, as the MCP tool does. */
export function normalizeClaim(text: string): string {
  return String(text || '').trim().slice(0, CLAIM_MAX_CHARS);
}

export function checkClaim(text: string, digest: ClaimDigest): ClaimCard {
  return buildClaimCard(normalizeClaim(text), digest.items);
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
