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

/**
 * Metadata sibling of the accepted snapshot. Holds only the few numbers the
 * replacement decision needs, so publishing does not have to GET (and
 * deserialize) the ~126KB snapshot body just to compare two counts. Written
 * with the same TTL as the body so the pair expires together.
 */
export function lastGoodMetaKey(variant: string, lang: string): string {
  return `news:digest:lastgood-meta:v1:${variant}:${lang}`;
}

export function attemptMetaKey(variant: string, lang: string): string {
  return `news:digest:attempt:v1:${variant}:${lang}`;
}

/**
 * Versioned, narrow revocation set: exact item URLs suppressed at SERVE time
 * on every path — fresh build, digest cache hit, durable snapshot, and
 * warm-isolate replay. Applying it only inside buildDigest meant a cache hit
 * replayed the pre-revocation body for up to the digest TTL, so "takes effect
 * immediately" was not true of the most common path.
 *
 * Operator invalidation:
 *   SADD news:digest:revoked-urls:v1 <url>
 * That alone is now sufficient — suppression happens on read, so no key
 * deletion is required. Deleting news:digest:v2:<variant>:<lang> and
 * news:digest:lastgood:v1:<variant>:<lang> additionally forces a rebuild, but
 * the URL stops being served either way.
 *
 * Matching is exact string equality on `item.link`; normalize the URL the way
 * the feed emits it (scheme, trailing slash, and query string all count).
 */
export const REVOKED_URLS_KEY = 'news:digest:revoked-urls:v1';

/** Key-cardinality clamp: variant/lang are request-supplied — only write
 *  scope keys for known variants and well-formed 2-letter languages. */
export function isEligibleScope(variant: string, lang: string): boolean {
  return /^[a-z]{2}$/.test(lang) && /^[a-z0-9-]+$/.test(variant);
}

export interface AcceptedSnapshotMeta {
  /**
   * Epoch ms this snapshot's CONTENT was generated (its `generatedAt`), not
   * the moment it was written. The six-hour window is a claim about how old
   * the news is, so it has to be anchored to the content clock — a write
   * clock would slide forward on every republish of unchanged content.
   */
  acceptedAt: number;
  /** category count at acceptance — the breadth "richness" signal. */
  categoryCount: number;
  /**
   * Total item count at acceptance — the depth "richness" signal. Breadth
   * alone let a one-item-per-category digest displace a live snapshot with
   * the same categories and hundreds of items.
   */
  itemCount: number;
}

/**
 * The stored snapshot: metadata plus the body it describes. Generic over the
 * body so the caller keeps its concrete response type — this module only ever
 * needs the structural `DigestLike` view of it.
 */
export interface AcceptedSnapshot<T extends DigestLike = DigestLike> extends AcceptedSnapshotMeta {
  data: T;
}

/**
 * Parse metadata read back from Redis. The store is external, so a cast is a
 * fiction — validate the two numbers the replacement decision depends on.
 * A malformed row must read as "no snapshot" (replaceable), never as a
 * snapshot with NaN fields, which compares false in both directions and
 * would wedge the key unreplaceable until its TTL expired.
 */
export function parseAcceptedMeta(value: unknown): AcceptedSnapshotMeta | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.acceptedAt !== 'number' || !Number.isFinite(v.acceptedAt)) return null;
  if (typeof v.categoryCount !== 'number' || !Number.isFinite(v.categoryCount)) return null;
  // itemCount is newer than the first shipped shape; treat a missing value as
  // 0 so an older row is always replaceable rather than permanently richer.
  const itemCount = typeof v.itemCount === 'number' && Number.isFinite(v.itemCount) ? v.itemCount : 0;
  return { acceptedAt: v.acceptedAt, categoryCount: v.categoryCount, itemCount };
}

/** Parse a full snapshot (metadata + body) read back from Redis. */
export function parseAcceptedSnapshot<T extends DigestLike = DigestLike>(
  value: unknown,
): AcceptedSnapshot<T> | null {
  const meta = parseAcceptedMeta(value);
  if (!meta) return null;
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return null;
  return { ...meta, data: data as T };
}

/** Result of reading the revocation set: an empty set is not the same as a failed read. */
export interface RevocationRead {
  urls: Set<string>;
  /** False when the set could not be read at all — suppression is fail-open but not silent. */
  readable: boolean;
}

export interface DigestLike {
  categories?: Record<string, { items?: unknown[] }>;
}

/** Total items across every category bucket. */
export function countDigestItems(data: DigestLike): number {
  // `b?.` matters: this runs over bodies read back from Redis, where a bucket
  // can be null/malformed. A throw here propagates out of the servability
  // gate and can abort EVERY fallback tier for the request.
  return Object.values(data.categories ?? {}).reduce((sum, b) => sum + (b?.items?.length ?? 0), 0);
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
  candidate: { categoryCount: number; itemCount: number },
  nowMs: number,
): { replace: boolean; reason: string } {
  if (!current) return { replace: true, reason: 'no-accepted-snapshot' };
  const expired = nowMs - current.acceptedAt > LASTGOOD_MAX_AGE_MS;
  if (expired) return { replace: true, reason: 'current-expired' };
  // "Materially narrower" is two-dimensional: a candidate must not regress on
  // breadth (categories) OR depth (items). Comparing categories alone let a
  // digest with one item per category replace a live one holding hundreds.
  if (candidate.categoryCount < current.categoryCount) {
    return { replace: false, reason: `narrower-categories:${candidate.categoryCount}<${current.categoryCount}` };
  }
  if (candidate.itemCount < current.itemCount) {
    return { replace: false, reason: `narrower-items:${candidate.itemCount}<${current.itemCount}` };
  }
  return { replace: true, reason: 'not-narrower' };
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
  // `item?.` matters: replayed bodies come from Redis, and a malformed items
  // array can carry null entries. Keep them (they carry no link to revoke)
  // rather than throwing out of the whole serving tier.
  const kept = items.filter((item) => !item?.link || !revokedUrls.has(item.link));
  return { kept, dropped: items.length - kept.length };
}
