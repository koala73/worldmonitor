/**
 * Durable last-good digest serving (#7084).
 *
 * The ordinary digest cache answers the happy path; when a rebuild is
 * rejected (zero-item result → negative sentinel) or the build throws, a
 * cold isolate previously had nothing durable to serve — the browser's own
 * six-hour last-good value masked the gap for humans, but programmatic
 * consumers and cold isolates did not have an accepted snapshot.
 *
 * This module owns the pure policy: which key, when a candidate is
 * accepted, when an accepted snapshot may replace a live one, when a
 * snapshot is still servable, and how a revocation filters items. All I/O
 * lives in the caller.
 */

/** Redis TTL for the accepted snapshot. Six hours, per the contract. */
export const LASTGOOD_TTL_S = 6 * 60 * 60;

/** Same contract in ms, enforced on read even if a key's TTL drifted. */
export const LASTGOOD_MAX_AGE_MS = LASTGOOD_TTL_S * 1000;

/** Redis TTL for the latest-attempt metadata (outlives the snapshot on
 *  purpose so an operator can still see the last failure after the
 *  snapshot expired). */
export const ATTEMPT_META_TTL_S = 25 * 60 * 60;

/** Closed vocabulary for why stale content is being served. */
export type StaleReason = 'empty-rebuild' | 'build-error';

/** Closed vocabulary for the durable-fallback outcome of one request. */
export type ServingOutcome = 'fresh' | 'stale' | 'isolate-fallback' | 'expired' | 'unavailable';

export function lastGoodKey(variant: string, lang: string): string {
  return `news:digest:lastgood:v1:${variant}:${lang}`;
}

export function attemptMetaKey(variant: string, lang: string): string {
  return `news:digest:attempt:v1:${variant}:${lang}`;
}

/** Versioned, narrow revocation set: exact item URLs suppressed from BOTH
 *  fresh and stale serialization. Operator invalidation = SADD the URL and
 *  DEL the affected last-good key(s). */
export const REVOKED_URLS_KEY = 'news:digest:revoked-urls:v1';

/** Key-cardinality clamp: variant/lang are request-supplied — only write
 *  scope keys for known variants and well-formed 2-letter languages. */
export function isEligibleScope(variant: string, lang: string): boolean {
  return /^[a-z]{2}$/.test(lang) && /^[a-z0-9-]+$/.test(variant);
}

export interface AcceptedSnapshotMeta {
  /** epoch ms when this snapshot was accepted. */
  acceptedAt: number;
  /** category count at acceptance — the "richness" signal. */
  categoryCount: number;
}

export interface DigestLike {
  categories?: Record<string, { items?: unknown[] }>;
}

/** Total items across every category bucket. */
export function countDigestItems(data: DigestLike): number {
  return Object.values(data.categories ?? {}).reduce((sum, b) => sum + (b.items?.length ?? 0), 0);
}

/** Structural acceptance: at least one category AND at least one item. */
export function isAcceptableDigest(data: DigestLike | null | undefined): boolean {
  if (!data || typeof data !== 'object') return false;
  const categories = data.categories;
  if (!categories || typeof categories !== 'object') return false;
  const catCount = Object.keys(categories).length;
  return catCount >= 1 && countDigestItems(data) >= 1;
}

/**
 * Replacement policy. A candidate ALWAYS serves the request that built it,
 * but it may only replace a still-live accepted snapshot when it is not
 * materially narrower (fewer categories). An expired snapshot can never
 * veto a valid candidate.
 */
export function shouldReplaceAccepted(
  current: AcceptedSnapshotMeta | null,
  candidate: { categoryCount: number },
  nowMs: number,
): { replace: boolean; reason: string } {
  if (!current) return { replace: true, reason: 'no-accepted-snapshot' };
  const expired = nowMs - current.acceptedAt > LASTGOOD_MAX_AGE_MS;
  if (expired) return { replace: true, reason: 'current-expired' };
  if (candidate.categoryCount >= current.categoryCount) return { replace: true, reason: 'not-narrower' };
  return { replace: false, reason: `narrower-than-live:${candidate.categoryCount}<${current.categoryCount}` };
}

/**
 * Serving policy for a snapshot read back from Redis: servable only when
 * structurally valid and inside the six-hour contract. Age is computed
 * from the stored acceptedAt so a drifted TTL cannot stretch the window.
 */
export function classifyStaleSnapshot(
  snapshot: { acceptedAt: number; data: DigestLike } | null | undefined,
  nowMs: number,
): { serve: boolean; outcome: ServingOutcome; ageSeconds: number } {
  if (!snapshot || typeof snapshot !== 'object') {
    return { serve: false, outcome: 'unavailable', ageSeconds: 0 };
  }
  const ageMs = nowMs - snapshot.acceptedAt;
  if (!(ageMs >= 0) || ageMs > LASTGOOD_MAX_AGE_MS) {
    return { serve: false, outcome: 'expired', ageSeconds: Math.max(0, Math.round(ageMs / 1000)) };
  }
  if (!isAcceptableDigest(snapshot.data)) {
    return { serve: false, outcome: 'unavailable', ageSeconds: Math.round(ageMs / 1000) };
  }
  return { serve: true, outcome: 'stale', ageSeconds: Math.round(ageMs / 1000) };
}

/** Filter items by the revocation set. Shared by fresh and stale paths so
 *  a revoked URL disappears from both immediately. */
export function filterRevokedUrls<T extends { link?: string }>(
  items: readonly T[],
  revokedUrls: ReadonlySet<string>,
): { kept: T[]; dropped: number } {
  if (revokedUrls.size === 0) return { kept: [...items], dropped: 0 };
  const kept = items.filter((item) => !item.link || !revokedUrls.has(item.link));
  return { kept, dropped: items.length - kept.length };
}
