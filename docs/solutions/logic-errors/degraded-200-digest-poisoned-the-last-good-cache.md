---
title: A degraded 200 poisoned the last-good cache it was supposed to fall back to
date: 2026-07-30
category: logic-errors
module: News digest loader
problem_type: logic_error
component: frontend_stimulus
symptoms:
  - Every preset news category rendered empty while the server had a good digest one request away
  - The empty dashboard survived reloads, not just the page load that caused it
  - The digest circuit breaker never tripped against a server emitting empty-but-200 responses
root_cause: missing_validation
resolution_type: code_fix
severity: high
tags: [news-digest, last-good, degraded-response, cache-poisoning, compare-and-swap, circuit-breaker]
---

# A degraded 200 poisoned the last-good cache it was supposed to fall back to

## Problem

`DataLoaderManager.tryFetchDigest` treated any HTTP 200 with parseable JSON as a good news digest. It computed the response's category count, logged it, and then ignored it — so a degraded response carrying `categories: {}` was written to both the in-memory `lastGoodDigest` and the `digest:last-good` persistent entry, where it kept being served for `persistedDigestMaxAgeMs` (6 hours).

One degraded response therefore poisoned the fallback that exists to survive degradation.

## Symptoms

- `[News] Digest fetched: 0 categories` in the console, immediately followed by a normal load.
- Every preset category rendered empty (per-feed RSS fallback is off on web by default), even though a healthy digest was one request away.
- Reloading did not help: the poisoned entry outlived the page load that stored it. `#5376`'s `landed` check bounds the symptom *within* a page load; it cannot touch a bad cache entry.
- The circuit breaker stayed closed, because the accept path reset it — a server stuck emitting empty-but-200 digests never tripped it.

## What Didn't Work

- **Reading the count without acting on it.** `const catCount = Object.keys(data.categories ?? {}).length` followed by `console.info(...)` looks like validation and is not. The value that would have caught the outage was already in hand and was thrown away.
- **A non-null check on the response.** `categories: {}` is non-null and well-formed, so any "did we get a digest?" test passes. Coverage, not nullness, is what makes a digest a digest.
- **A guard in `loadPersistedDigest` that refused to *serve* a zero-category entry.** Written first as a migration path for already-poisoned caches, then removed: an empty-`categories` digest and `null` take identical downstream paths (`data-loader.ts:1317` gates on `category in digest.categories`; `:1410` gates on the fallback flag), so the guard had **no observable effect**. An untestable branch kept as a "second net" is the failure mode, not the safe choice — see [prove-a-guard-can-fail](#prevention).

## Solution

The degraded response has two shapes and they need different answers.

**Zero categories is rejected outright.** Throwing routes it into the existing catch, which is the whole point — the breaker counts it, `lastGoodDigest` keeps the real digest it had, and the persisted entry is untouched:

```ts
const catCount = countDigestCategories(data);
if (catCount === 0) throw new Error('digest returned 0 categories');
```

**Fewer categories than the cache already holds is used but not persisted.** The response is real data for the categories it names, so the load uses it; overwriting a richer `digest:last-good` is a strict loss for the *next* page load, which is the one that reads this entry when the digest is unreachable.

The decision lives in a pure module (`src/app/news-digest-acceptance.ts`) rather than inline, so it can be tested against every shape without standing up a `DataLoaderManager`:

```ts
export function evaluateFetchedDigest({ fetchedCategoryCount, cached, cacheMaxAgeMs }) {
  if (fetchedCategoryCount <= 0) {
    return { accept: false, persist: false, rejectReason: 'no-categories', skipPersistReason: null };
  }
  if (cached && isCachedEntryLive(cached, cacheMaxAgeMs) && cached.categoryCount > fetchedCategoryCount) {
    return { accept: true, persist: false, rejectReason: null, skipPersistReason: 'fewer-categories-than-cached' };
  }
  return { accept: true, persist: true, rejectReason: null, skipPersistReason: null };
}
```

Two adjacent defects the coverage guard turned out to depend on, both surfaced by an adversarial cross-model review pass:

1. **The compare-and-swap was not atomic.** `persistDigest` reads the cached entry, decides, then writes — over a store with no conditional write. Two overlapping fetches (`loadAllData`'s news task and `RefreshScheduler`'s news loop both reach `loadNews()`) could each read the old entry, each decide to persist, and let the *smaller* one land last: exactly the downgrade the guard exists to prevent. Serializing the read-decide-write behind a per-instance promise chain closes it within the tab.

2. **The cache key was not scoped like the request.** The digest is fetched per `variant` and `lang`; the entry was stored under one global `digest:last-good`. Harmless while every success overwrote unconditionally — not harmless once *coverage* decides, because a wider digest from another variant would veto persisting the current one's for 6 hours. Scoping the key to `digest:last-good:<variant>:<lang>` fixes it, and doubles as the migration: every entry written under the old key becomes unreachable, so already-poisoned caches retire on deploy rather than needing to be detected.

Fix opened in [#5883](https://github.com/koala73/worldmonitor/pull/5883) (closes [#5877](https://github.com/koala73/worldmonitor/issues/5877)); CI green, unmerged as of this writing.

## Why This Works

The failure path was already correct — it counted against the breaker, preserved `lastGoodDigest`, and left the persistent entry alone. The bug was that a degraded 200 never reached it. Throwing does not add new recovery machinery; it routes an outage into the recovery that already existed.

The asymmetry between the two shapes is the load-bearing part. A zero-category digest carries no information, so nothing is lost by rejecting it. A partial digest carries real information for the categories it names, so rejecting it outright would discard usable data — but *persisting* it is a different decision from *using* it, and only the persist decision trades away the fallback. Splitting "accept" from "persist" is what lets both answers be right at once.

The partial-digest veto is bounded rather than permanent: it only applies while the cached entry is still servable. Once it ages past `persistedDigestMaxAgeMs` it stops being served and stops vetoing, so a legitimately shrunken digest (a category genuinely retired server-side) becomes the entry within one max-age window. The liveness window is bounded on *both* sides for the same reason — a device whose clock ran ahead when it wrote leaves an entry dated arbitrarily far in the future, and a one-sided `age > max` test would read it as live for as long as the skew lasted.

## Prevention

**A computed-then-logged value is an unenforced guard.** When a diagnostic computes exactly the quantity that would detect a failure and then only logs it, that is a validation gap wearing a log line. Grep for the pattern: a `const` used solely inside a `console.*` call, on a path that then commits to something irreversible.

**Reject degraded data at the boundary that makes it durable.** Same shape as [rejecting degraded China macro snapshots at the seed publish boundary](reject-degraded-china-macro-seed-publication.md): the readiness decision has to be repeated at the point where a bad value becomes sticky. Here the sticky boundary is a 6-hour client cache rather than a server publish; the principle is identical.

**Distinguish "use it" from "remember it."** A response can be good enough for the current render and not good enough to become the fallback. Collapsing the two into one accept/reject decision forces a wrong answer for partial data in one direction or the other.

**A coverage-comparison guard implies a compare-and-swap.** The moment a write becomes conditional on the current value, the read-decide-write needs serializing — a store with no atomic conditional write will otherwise let two concurrent writers each observe the pre-write state and pick the loser. Ask "who else can call this concurrently?" before shipping the comparison.

**A conditional write implies the key is scoped like the thing it compares.** An unscoped key is survivable while writes are unconditional (last writer wins, and the last writer is current). It stops being survivable the moment coverage decides, because entries from different scopes get compared against each other.

**Prove a guard can fail before keeping it.** Both halves of this fix were mutation-tested end to end, and the test that pinned the outcome did not pin the mechanism:

| Mutant | Result |
|---|---|
| Delete the zero-category throw | Reds only because the test asserts on the accept log — the cache assertion alone still passed, since the coverage guard declined the write anyway |
| Neuter the coverage guard (`if (false)`) | Reds the partial-digest test |
| Revert the module wholesale | Reds the empty-200 test |

The first row is the lesson: with the throw deleted, the cache survived *for the wrong reason*, so a cache-only assertion would have called a broken build green. Watching the accept log and the fallback warning separately is what distinguishes "rejected" from "accepted but happened not to be written."

The same discipline is what retired the `loadPersistedDigest` serve guard. There was no mutant that could red it, because there was no observable behavior behind it.

**Assert on storage when the defect outlives the page load.** The e2e tests read the `digest:last-good` IndexedDB envelope directly rather than asserting on rendered panels — panels only show what the *current* load did, and the whole point of this defect was that the poisoned entry survived into the next one. Match by key prefix, not the exact key, so a scoping change does not red the spec for the wrong reason.
