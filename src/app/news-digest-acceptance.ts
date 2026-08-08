/**
 * Whether a freshly fetched news digest is good enough to become "last good".
 *
 * `tryFetchDigest` used to treat any HTTP 200 with parseable JSON as a good
 * digest: it counted the categories, logged the count, and then ignored it. A
 * degraded response carrying `categories: {}` was written to both the in-memory
 * `lastGoodDigest` and the `digest:last-good` persistent entry — the very
 * fallback that exists to survive degradation — where it kept being served for
 * `persistedDigestMaxAgeMs` (6 hours) or until a healthy 200 replaced it. It
 * also reset the circuit breaker, so a server emitting empty-but-200 digests
 * never tripped it (#5877).
 *
 * The decision lives here rather than inline in the fetch path so it can be
 * tested against every shape without standing up a DataLoaderManager: a
 * source-text guard over the fetch path would go green with the bug restored
 * verbatim in a neighbouring branch.
 */

/** The only part of a digest this decision reads. */
export interface DigestCategoryCarrier {
  categories?: Record<string, unknown> | null;
}

/** What the `digest:last-good` entry currently holds, as the decision sees it. */
export interface CachedDigestSummary {
  /** Categories in the cached digest. */
  categoryCount: number;
  /** `Date.now() - envelope.updatedAt`. Negative when the entry is future-dated. */
  ageMs: number;
}

export interface DigestAcceptanceInput {
  fetchedCategoryCount: number;
  /** `null` when nothing is cached or the entry could not be read. */
  cached: CachedDigestSummary | null;
  /** `persistedDigestMaxAgeMs` — must match what the reader treats as expired. */
  cacheMaxAgeMs: number;
}

export interface DigestAcceptance {
  /** False means: do not use, remember, or persist this response at all. */
  accept: boolean;
  /** False means: use it for this load, but leave `digest:last-good` alone. */
  persist: boolean;
  rejectReason: 'no-categories' | null;
  skipPersistReason: 'fewer-categories-than-cached' | null;
}

export interface ScopedDigest<T extends DigestCategoryCarrier> {
  key: string;
  data: T;
}

export interface DigestPersistenceEnvelope<T> {
  data: T;
  updatedAt: number;
}

export interface DigestPersistenceQueueOptions<T extends DigestCategoryCarrier> {
  cacheMaxAgeMs: number;
  read: (key: string) => Promise<DigestPersistenceEnvelope<T> | null>;
  write: (key: string, data: T) => Promise<void>;
  now?: () => number;
  onSkipPersist?: (fetchedCategoryCount: number, cachedCategoryCount: number) => void;
}

/** Categories a digest covers. Presence, not item count — an empty bucket is still coverage. */
export function countDigestCategories(digest: DigestCategoryCarrier | null | undefined): number {
  return Object.keys(digest?.categories ?? {}).length;
}

/** The persistent and in-memory scope shared by a digest request. */
export function digestCacheKey(variant: string, language: string): string {
  return `digest:last-good:${variant}:${language}`;
}

/** Return a retained digest only when it belongs to the exact request scope. */
export function getScopedDigest<T extends DigestCategoryCarrier>(
  retained: ScopedDigest<T> | null,
  key: string,
): T | null {
  return retained?.key === key ? retained.data : null;
}

/**
 * Retain the widest accepted digest for a scope.
 *
 * A partial response is still returned to the current load by the caller, but
 * it cannot trade down the richer in-memory fallback used by a later failure.
 */
export function retainRicherScopedDigest<T extends DigestCategoryCarrier>(
  retained: ScopedDigest<T> | null,
  key: string,
  fetched: T,
): ScopedDigest<T> {
  if (
    retained?.key === key
    && countDigestCategories(retained.data) > countDigestCategories(fetched)
  ) {
    return retained;
  }
  return { key, data: fetched };
}

/**
 * A cached entry only outranks a fresh response while it is still servable.
 *
 * `loadPersistedDigest` drops an entry once it is older than
 * `persistedDigestMaxAgeMs`, so an expired one has nothing left to protect —
 * letting it veto writes would leave a shrunken-but-real digest permanently
 * unable to refresh the entry it already outlives. The upper boundary matches
 * the reader exactly: expired is `age > max`, so `age === max` is still live.
 *
 * The window is bounded on BOTH sides, which the reader's one-sided age check
 * is not. A device whose clock ran ahead when it wrote, then corrected, leaves
 * an entry dated arbitrarily far in the future: a lower-bound-free rule would
 * read it as live for as long as the skew lasts, so every smaller-but-real
 * digest would be refused for weeks and the reader would keep serving news that
 * is genuinely ancient. Treating a wildly future-dated entry as not-live lets
 * the next successful fetch replace it — which repairs the bad timestamp too.
 * Ordinary sub-max-age skew (another tab, another device) still counts as live.
 */
function isCachedEntryLive(cached: CachedDigestSummary, cacheMaxAgeMs: number): boolean {
  return cached.ageMs <= cacheMaxAgeMs && cached.ageMs >= -cacheMaxAgeMs;
}

/**
 * Two independent verdicts, because a degraded digest has two shapes.
 *
 * **Zero categories** is not a digest at all: every preset category renders
 * empty behind it (`newsPerFeedFallback` is off on web), so it is rejected
 * outright. The caller throws, which routes it into the same failure path as a
 * non-200 — the breaker counts it, `lastGoodDigest` keeps whatever real digest
 * it had, and the persisted entry is untouched.
 *
 * **Fewer categories than the cache already has** is a judgment call, and the
 * safe reading is asymmetric: the response is real data for the categories it
 * does cover, so this load uses it — but it must not overwrite a richer
 * `digest:last-good`, which is what later page loads fall back to when the
 * digest is unreachable. Trading a 12-category fallback for a 2-category one is
 * a strict loss, and it is bounded rather than permanent: once the cached entry
 * ages past `cacheMaxAgeMs` it stops being servable and stops vetoing writes,
 * so a legitimately shrunken digest becomes the entry within one max-age
 * window.
 */
export function evaluateFetchedDigest({
  fetchedCategoryCount,
  cached,
  cacheMaxAgeMs,
}: DigestAcceptanceInput): DigestAcceptance {
  if (fetchedCategoryCount <= 0) {
    return { accept: false, persist: false, rejectReason: 'no-categories', skipPersistReason: null };
  }

  if (cached && isCachedEntryLive(cached, cacheMaxAgeMs) && cached.categoryCount > fetchedCategoryCount) {
    return {
      accept: true,
      persist: false,
      rejectReason: null,
      skipPersistReason: 'fewer-categories-than-cached',
    };
  }

  return { accept: true, persist: true, rejectReason: null, skipPersistReason: null };
}

/**
 * Serialize the cache read/decision/write transaction within this tab.
 *
 * IndexedDB has no conditional write primitive at this abstraction layer. A
 * queue keeps overlapping loads from both reading the same old value and then
 * letting the smaller response land last. Read failures deliberately fail open
 * to the write, and every transaction absorbs its own failure so one rejected
 * write cannot poison the queue for later loads.
 */
export class DigestPersistenceQueue<T extends DigestCategoryCarrier> {
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: DigestPersistenceQueueOptions<T>) {
    this.now = options.now ?? Date.now;
  }

  enqueue(key: string, data: T): void {
    this.chain = this.chain
      .then(async () => {
        let cached: DigestPersistenceEnvelope<T> | null = null;
        try {
          cached = await this.options.read(key);
        } catch {
          // Preserve the existing liveness contract: a storage read failure
          // must not suppress all future writes.
        }

        const fetchedCategoryCount = countDigestCategories(data);
        const cachedSummary = cached
          ? {
              categoryCount: countDigestCategories(cached.data),
              ageMs: this.now() - cached.updatedAt,
            }
          : null;
        const decision = evaluateFetchedDigest({
          fetchedCategoryCount,
          cached: cachedSummary,
          cacheMaxAgeMs: this.options.cacheMaxAgeMs,
        });
        if (!decision.persist) {
          this.options.onSkipPersist?.(
            fetchedCategoryCount,
            cachedSummary?.categoryCount ?? 0,
          );
          return;
        }
        await this.options.write(key, data);
      })
      .catch(() => {});
  }

  whenIdle(): Promise<void> {
    return this.chain;
  }
}
