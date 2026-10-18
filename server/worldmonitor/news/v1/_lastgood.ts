/**
 * Durable last-good digest serving (#7084).
 *
 * The ordinary digest cache answers the happy path; when a rebuild is
 * rejected (zero-item result → negative sentinel) or the build throws, a
 * cold isolate previously had nothing durable to serve — the browser's own
 * six-hour last-good value masked the gap for humans, but programmatic
 * consumers and cold isolates did not have an accepted snapshot.
 *
 * This module owns the pure last-good policy: which key, when an accepted
 * snapshot may replace a live one, when a snapshot is still servable, and
 * how a revocation filters items. The structural acceptance rule is shared
 * with seed-insights; all I/O lives in the callers.
 */

import {
  countDigestItems,
  isAcceptableDigest,
  type DigestLike,
} from '../../../../scripts/shared/digest-acceptance.mjs';

export { countDigestItems, isAcceptableDigest, type DigestLike };

/** Redis TTL for the accepted snapshot. Six hours, per the contract. */
export const LASTGOOD_TTL_S = 6 * 60 * 60;

/** Same contract in ms, enforced on read even if a key's TTL drifted. */
export const LASTGOOD_MAX_AGE_MS = LASTGOOD_TTL_S * 1000;

/**
 * Depth floor for replacing a live snapshot: a candidate needs at least this
 * percentage of the richest item count accepted in the window (see
 * AcceptedSnapshotMeta.peakItemCount). Healthy builds drift by a few percent
 * (observed 294 -> 289, 212 -> 210, 173 -> 171); the collapse this gate exists
 * to stop is an order of magnitude (one item per category). A strict `<` here
 * froze the live `full` digest for ~6h on 2026-09-19: every fresh 289-item build
 * lost to a 294-item incumbent. MIRRORED as a literal in
 * shared/digest-lastgood-publish-script.mjs and docker/redis-rest-proxy.mjs;
 * tests/digest-lastgood.test.mts pins all three to this value.
 */
export const LASTGOOD_MIN_ITEM_PCT = 80;

/** Redis TTL for the latest-attempt metadata (outlives the snapshot on
 *  purpose so an operator can still see the last failure after the
 *  snapshot expired). */
export const ATTEMPT_META_TTL_S = 25 * 60 * 60;

/** Closed vocabulary for why stale content is being served.
 *  `empty-rebuild` / `build-error` are failed latest attempts.
 *  `gate-held` is a successful rebuild the acceptance gate refused to
 *  publish: the incumbent stays live. Neither failure value means that
 *  (#8361): recovering a leftover attempt row made degraded responses
 *  report a build-error from up to 25 hours earlier. Empty when fresh. */
export type StaleReason = 'empty-rebuild' | 'build-error' | 'gate-held';

export function isStaleReason(value: unknown): value is StaleReason {
  return value === 'empty-rebuild' || value === 'build-error' || value === 'gate-held';
}

/** Closed vocabulary for the durable-fallback outcome of one request. */
export type ServingOutcome = 'fresh' | 'stale' | 'isolate-fallback' | 'expired' | 'unavailable';

export function lastGoodKey(variant: string, lang: string): string {
  return `news:digest:lastgood:v1:${variant}:${lang}`;
}

// There is deliberately no counts-only sibling key. One existed and was never
// read: the gate cannot use publication-time counts, because it has to
// re-measure BOTH bodies against the CURRENT revocation set (a URL revoked
// after publication must not keep inflating the incumbent's richness and veto
// its own repair). That forces the body read the sibling was meant to avoid,
// so the sibling was pure write amplification — an extra SET and 6h of TTL on
// data nothing consumed.

export function attemptMetaKey(variant: string, lang: string): string {
  return `news:digest:attempt:v1:${variant}:${lang}`;
}

/**
 * Revocation lives in server/_shared/digest-revocations.ts and is re-exported
 * here so existing importers keep working. It moved because the suppression
 * set is a property of the digest CONTENT, not of this endpoint: several
 * handlers read `news:digest:v1:*` directly, and a filter that lived only in
 * the digest handler let a revoked URL keep reaching users through
 * get-country-intel-brief and the chat analyst.
 *
 * OPERATOR RUNBOOK — revoking a URL:
 *   1. SADD news:digest:revoked-urls:v1 <url>
 *      Suppression happens on read, so this alone removes the item from every
 *      Redis-served path immediately: fresh build, digest cache hit, durable
 *      snapshot, and warm-isolate replay.
 *   2. PURGE THE CDN for /api/news/v1/list-feed-digest.
 *      The endpoint is the gateway's `slow` tier (s-maxage=1800,
 *      CDN-Cache-Control s-maxage=3600), so copies already in shared caches
 *      survive step 1. Once a revocation is live the handler stops feeding
 *      shared caches, but it cannot evict what is already stored.
 *   3. Optional, to force an immediate rebuild rather than waiting out the
 *      900s digest TTL:
 *        DEL news:digest:v1:<variant>:<lang>
 *        DEL news:digest:lastgood:v1:<variant>:<lang>
 *      Note v1 — `news:digest:v1:` is the real cache key (built in
 *      list-feed-digest.ts). An earlier version of this comment said v2; that
 *      DEL silently matched nothing and read as "my forced rebuild did
 *      nothing".
 */
export {
  REVOKED_URLS_KEY,
  filterRevokedUrls,
  type RevocationRead,
} from '../../../_shared/digest-revocations';

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
  /**
   * Richest item count accepted inside the current six-hour window, and the
   * content clock of the body that set it. The depth floor is anchored here
   * rather than to `itemCount`: anchored to the last accepted body, successive
   * 20% steps compound (100 -> 80 -> 64 -> ...) and consume the very snapshot
   * that exists to survive a degradation. Absent on rows written before this
   * field existed; the row's own count then stands in.
   */
  peakItemCount?: number;
  peakAt?: number;
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
  const meta: AcceptedSnapshotMeta = { acceptedAt: v.acceptedAt, categoryCount: v.categoryCount, itemCount };
  if (typeof v.peakItemCount === 'number' && Number.isFinite(v.peakItemCount)
    && typeof v.peakAt === 'number' && Number.isFinite(v.peakAt)) {
    meta.peakItemCount = v.peakItemCount;
    meta.peakAt = v.peakAt;
  }
  return meta;
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

function isInsideWindow(clockMs: number, nowMs: number): boolean {
  const ageMs = nowMs - clockMs;
  return ageMs >= 0 && ageMs <= LASTGOOD_MAX_AGE_MS;
}

/**
 * The item count the depth floor is measured against, and the clock of the
 * body that set it. `measuredItems` is the incumbent re-measured under the
 * CURRENT revocation set. A stored peak only counts while it is inside the
 * window AND the incumbent still measures what it measured at publication:
 * once revocations shrank it, a publication-time peak would veto its repair.
 */
function livePeak(
  current: AcceptedSnapshotMeta,
  measuredItems: number,
  nowMs: number,
): { peakItemCount: number; peakAt: number } {
  const { peakItemCount, peakAt } = current;
  if (peakItemCount !== undefined && peakAt !== undefined
    && isInsideWindow(peakAt, nowMs)
    && current.itemCount === measuredItems
    && peakItemCount > measuredItems) {
    return { peakItemCount, peakAt };
  }
  return { peakItemCount: measuredItems, peakAt: current.acceptedAt };
}

/** The peak to store with an ACCEPTED candidate. Mirror of the Lua's carriedPeak. */
export function nextPeak(
  current: AcceptedSnapshotMeta | null,
  candidateItems: number,
  candidateAcceptedAt: number,
  nowMs: number,
  measuredCurrentItems?: number,
): { peakItemCount: number; peakAt: number } {
  if (current && isInsideWindow(current.acceptedAt, nowMs)) {
    const peak = livePeak(current, measuredCurrentItems ?? current.itemCount, nowMs);
    if (peak.peakItemCount > candidateItems) return peak;
  }
  return { peakItemCount: candidateItems, peakAt: candidateAcceptedAt };
}

/**
 * Replacement policy. A candidate ALWAYS serves the request that built it,
 * but it may only replace a still-live accepted snapshot when it is not
 * materially narrower: no fewer categories, and at least
 * LASTGOOD_MIN_ITEM_PCT of the richest item count accepted in the window.
 * An expired snapshot can never veto a valid candidate.
 *
 * `measuredCurrentItems` is the incumbent BODY re-measured under the current
 * revocation set, which is what the Lua twin compares. Omit it only when there
 * is no body to measure (the canonical comparison passes fresh counts already).
 */
export function shouldReplaceAccepted(
  current: AcceptedSnapshotMeta | null,
  candidate: { categoryCount: number; itemCount: number },
  nowMs: number,
  measuredCurrentItems?: number,
): { replace: boolean; reason: string } {
  if (!current) return { replace: true, reason: 'no-accepted-snapshot' };
  const ageMs = nowMs - current.acceptedAt;
  // A FUTURE acceptedAt is corrupt, not live — classifyStaleSnapshot already
  // refuses to SERVE such a row, so letting it VETO here would wedge an
  // unservable snapshot in place until its TTL expired. Same rule as the
  // serve path: anything not provably inside the window cannot veto.
  if (!(ageMs >= 0)) return { replace: true, reason: 'current-corrupt-future' };
  if (ageMs > LASTGOOD_MAX_AGE_MS) return { replace: true, reason: 'current-expired' };
  // "Materially narrower" is two-dimensional: a candidate must not regress on
  // breadth (categories) OR depth (items). Comparing categories alone let a
  // digest with one item per category replace a live one holding hundreds.
  // Breadth is strict: losing a whole category is never drift. Depth has a
  // floor (LASTGOOD_MIN_ITEM_PCT), in integer arithmetic so the Lua twin
  // decides identically.
  if (candidate.categoryCount < current.categoryCount) {
    return { replace: false, reason: `narrower-categories:${candidate.categoryCount}<${current.categoryCount}` };
  }
  const anchor = livePeak(current, measuredCurrentItems ?? current.itemCount, nowMs).peakItemCount;
  if (candidate.itemCount * 100 < anchor * LASTGOOD_MIN_ITEM_PCT) {
    return { replace: false, reason: `narrower-items:${candidate.itemCount}<${LASTGOOD_MIN_ITEM_PCT}%of${anchor}` };
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

// filterRevokedUrls now lives in server/_shared/digest-revocations.ts and is
// re-exported at the top of this file — see the operator runbook there.
