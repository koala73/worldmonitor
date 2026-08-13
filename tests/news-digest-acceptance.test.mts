import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  countDigestCategories,
  DigestPersistenceQueue,
  digestCacheKey,
  evaluateFetchedDigest,
  getScopedDigest,
  retainRicherScopedDigest,
  type CachedDigestSummary,
} from '../src/app/news-digest-acceptance';

// src/app/data-loader.ts `persistedDigestMaxAgeMs`.
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function evaluate(
  fetchedCategoryCount: number,
  cached: CachedDigestSummary | null = null,
  cacheMaxAgeMs = CACHE_MAX_AGE_MS,
) {
  return evaluateFetchedDigest({ fetchedCategoryCount, cached, cacheMaxAgeMs });
}

describe('countDigestCategories', () => {
  it('counts a category the digest covers even when its bucket is empty', () => {
    // Coverage is presence, not item count — `landed` in data-loader.ts measures
    // it the same way (`key in digestCategories`), so an authoritative empty
    // bucket has to count here too or the two disagree about the same digest.
    assert.equal(countDigestCategories({ categories: { politics: { items: [] } } }), 1);
  });

  it('reports zero for the degraded-200 shape and for a missing map', () => {
    assert.equal(countDigestCategories({ categories: {} }), 0);
    assert.equal(countDigestCategories({}), 0);
    assert.equal(countDigestCategories({ categories: null }), 0);
    assert.equal(countDigestCategories(null), 0);
    assert.equal(countDigestCategories(undefined), 0);
  });
});

describe('evaluateFetchedDigest: the degraded 200', () => {
  it('rejects a digest carrying no categories outright', () => {
    // The bug: a 200 with `categories: {}` was accepted, remembered as
    // lastGoodDigest, and written to digest:last-good for 6 hours (#5877).
    const decision = evaluate(0);
    assert.equal(decision.accept, false);
    assert.equal(decision.persist, false);
    assert.equal(decision.rejectReason, 'no-categories');
  });

  it('rejects a no-category digest even when nothing is cached to protect', () => {
    // Rejection is about the response, not about having a better fallback: an
    // empty digest is still an outage on a first-ever page load, and accepting
    // it would seed the cache with the outage.
    const decision = evaluate(0, null);
    assert.equal(decision.accept, false);
    assert.equal(decision.persist, false);
  });

  it('rejects a no-category digest even when the cached entry is also empty', () => {
    const decision = evaluate(0, { categoryCount: 0, ageMs: 1_000 });
    assert.equal(decision.accept, false);
    assert.equal(decision.persist, false);
    assert.equal(decision.rejectReason, 'no-categories');
  });

  it('does not persist a zero-coverage body over a richer last-good (#6624)', () => {
    // A CBC 403 that was mis-converted to HTTP 200 + empty categories is
    // the poison shape. Coverage, not status, decides persist: zero
    // categories must not overwrite a live digest:last-good entry.
    const decision = evaluate(0, { categoryCount: 12, ageMs: 60_000 });
    assert.equal(decision.accept, false);
    assert.equal(decision.persist, false);
    assert.equal(decision.rejectReason, 'no-categories');
  });

  it('accepts and persists a single-category digest', () => {
    // The floor is one covered category, not a coverage ratio. Anything above
    // zero is real data for the categories it names.
    const decision = evaluate(1);
    assert.equal(decision.accept, true);
    assert.equal(decision.persist, true);
    assert.equal(decision.rejectReason, null);
    assert.equal(decision.skipPersistReason, null);
  });
});

describe('evaluateFetchedDigest: the partial digest', () => {
  it('uses a shrunken digest but leaves a richer live cached entry alone', () => {
    // The asymmetry is the point: the response is real data for the 2 categories
    // it covers, so this load uses it — but the 12-category entry is what the
    // NEXT page load falls back to when the digest is unreachable, and trading
    // it down is a strict loss.
    const decision = evaluate(2, { categoryCount: 12, ageMs: 60_000 });
    assert.equal(decision.accept, true);
    assert.equal(decision.persist, false);
    assert.equal(decision.skipPersistReason, 'fewer-categories-than-cached');
  });

  it('persists a digest with the same coverage as the cached entry', () => {
    // Equal coverage is the steady state — refusing here would freeze
    // digest:last-good at its first write and let it age out for no reason.
    const decision = evaluate(12, { categoryCount: 12, ageMs: 60_000 });
    assert.equal(decision.persist, true);
    assert.equal(decision.skipPersistReason, null);
  });

  it('persists a digest that covers more than the cached entry', () => {
    const decision = evaluate(12, { categoryCount: 2, ageMs: 60_000 });
    assert.equal(decision.persist, true);
  });

  it('persists a shrunken digest once the richer cached entry has expired', () => {
    // An expired entry has nothing left to protect: loadPersistedDigest drops it
    // past the max age, so letting it keep vetoing writes would leave a
    // legitimately shrunken digest permanently unable to refresh an entry
    // nobody can be served. The veto is bounded at one max-age window.
    const decision = evaluate(2, { categoryCount: 12, ageMs: CACHE_MAX_AGE_MS + 1 });
    assert.equal(decision.accept, true);
    assert.equal(decision.persist, true);
    assert.equal(decision.skipPersistReason, null);
  });

  it('treats an entry exactly at the max age as still live, matching the reader', () => {
    // loadPersistedDigest expires on `age > max`, so `age === max` is still
    // served — the two boundaries have to agree or the entry being protected
    // is not the entry being served.
    const decision = evaluate(2, { categoryCount: 12, ageMs: CACHE_MAX_AGE_MS });
    assert.equal(decision.persist, false);
    assert.equal(decision.skipPersistReason, 'fewer-categories-than-cached');
  });

  it('treats an entry under ordinary clock skew as live rather than expired', () => {
    // A small negative age means the entry was written by a clock slightly ahead
    // of this one (another tab, another device). It is the freshest thing
    // available, not the stalest, so the veto has to read it as live.
    const decision = evaluate(2, { categoryCount: 12, ageMs: -60_000 });
    assert.equal(decision.persist, false);
  });

  it('lets a smaller digest replace a wildly future-dated entry', () => {
    // A device whose clock ran a month ahead when it wrote, then corrected,
    // leaves an entry dated 30 days in the future. Without a lower bound it
    // would read as live for that whole month, refusing every smaller-but-real
    // digest while loadPersistedDigest kept serving news that is genuinely
    // ancient. Letting it be replaced repairs the timestamp along with it.
    const decision = evaluate(2, { categoryCount: 12, ageMs: -30 * 24 * 60 * 60 * 1000 });
    assert.equal(decision.persist, true);
    assert.equal(decision.skipPersistReason, null);
  });

  it('treats an entry exactly at the future boundary as still live', () => {
    // Symmetric with the expiry boundary: the window is [-max, +max], and both
    // endpoints are inside it.
    const decision = evaluate(2, { categoryCount: 12, ageMs: -CACHE_MAX_AGE_MS });
    assert.equal(decision.persist, false);
    assert.equal(decision.skipPersistReason, 'fewer-categories-than-cached');
  });

  it('persists when nothing is cached, including when the read failed', () => {
    // readPersistedDigestSummary reports null for both "no entry" and "read
    // threw", so a broken storage layer degrades to the unconditional write
    // rather than silently suppressing every persist from then on.
    const decision = evaluate(2, null);
    assert.equal(decision.persist, true);
  });

  it('persists over a cached entry that has no categories at all', () => {
    // A cache poisoned before this guard existed must not be able to defend
    // itself: 0 is never greater than a fetched count that cleared the floor.
    const decision = evaluate(1, { categoryCount: 0, ageMs: 60_000 });
    assert.equal(decision.persist, true);
  });
});

describe('scoped in-memory last-good digest', () => {
  const richer = { categories: { politics: {}, intel: {} } };
  const partial = { categories: { politics: {} } };

  it('uses a partial response without replacing the richer retained fallback', () => {
    const key = digestCacheKey('full', 'en');
    const retained = retainRicherScopedDigest(null, key, richer);
    const afterPartial = retainRicherScopedDigest(retained, key, partial);

    assert.equal(afterPartial, retained);
    assert.equal(getScopedDigest(afterPartial, key), richer);
    assert.equal(partial.categories.politics != null, true);
  });

  it('never returns a retained digest from another language scope', () => {
    const englishKey = digestCacheKey('full', 'en');
    const frenchKey = digestCacheKey('full', 'fr');
    const retained = retainRicherScopedDigest(null, englishKey, richer);

    assert.equal(getScopedDigest(retained, frenchKey), null);
    assert.equal(englishKey, 'digest:last-good:full:en');
    assert.equal(frenchKey, 'digest:last-good:full:fr');
  });
});

describe('DigestPersistenceQueue', () => {
  type Digest = { categories: Record<string, unknown> };
  const rich: Digest = { categories: { politics: {}, intel: {} } };
  const small: Digest = { categories: { politics: {} } };

  it('serializes compare-and-write operations so a later partial digest cannot win', async () => {
    let stored: { data: Digest; updatedAt: number } | null = null;
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    const writes: number[] = [];
    const queue = new DigestPersistenceQueue<Digest>({
      cacheMaxAgeMs: CACHE_MAX_AGE_MS,
      now: () => 10_000,
      read: async () => stored,
      write: async (_key, data) => {
        writes.push(countDigestCategories(data));
        if (writes.length === 1) await firstWriteBlocked;
        stored = { data, updatedAt: 10_000 };
      },
    });

    queue.enqueue('digest:last-good:full:en', rich);
    queue.enqueue('digest:last-good:full:en', small);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes, [2], 'the second transaction must wait for the first write');

    releaseFirstWrite();
    await queue.whenIdle();
    assert.deepEqual(writes, [2]);
    assert.equal(countDigestCategories(stored?.data), 2);
  });

  it('allows a richer digest queued after a partial one to replace it', async () => {
    let stored: { data: Digest; updatedAt: number } | null = null;
    const writes: number[] = [];
    const queue = new DigestPersistenceQueue<Digest>({
      cacheMaxAgeMs: CACHE_MAX_AGE_MS,
      now: () => 10_000,
      read: async () => stored,
      write: async (_key, data) => {
        writes.push(countDigestCategories(data));
        stored = { data, updatedAt: 10_000 };
      },
    });

    queue.enqueue('digest:last-good:full:en', small);
    queue.enqueue('digest:last-good:full:en', rich);
    await queue.whenIdle();

    assert.deepEqual(writes, [1, 2]);
    assert.equal(countDigestCategories(stored?.data), 2);
  });

  it('fails open when the real cache read rejects and still attempts the write', async () => {
    let writes = 0;
    const queue = new DigestPersistenceQueue<Digest>({
      cacheMaxAgeMs: CACHE_MAX_AGE_MS,
      read: async () => { throw new Error('IndexedDB unavailable'); },
      write: async () => { writes += 1; },
    });

    queue.enqueue('digest:last-good:full:en', small);
    await queue.whenIdle();
    assert.equal(writes, 1);
  });

  it('recovers after a write rejection so later queued persistence still runs', async () => {
    let attempts = 0;
    const queue = new DigestPersistenceQueue<Digest>({
      cacheMaxAgeMs: CACHE_MAX_AGE_MS,
      read: async () => null,
      write: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('quota failure');
      },
    });

    queue.enqueue('digest:last-good:full:en', small);
    queue.enqueue('digest:last-good:full:en', rich);
    await queue.whenIdle();
    assert.equal(attempts, 2);
  });
});
