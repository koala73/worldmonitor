---
title: Deduping redundant work removes the recovery that redundancy was accidentally providing
module: data-loader
date: 2026-07-30
problem_type: design_pattern
component: frontend
severity: high
applies_when:
  - "Adding a skip-gate, cache key, or signature so an expensive load stops repeating"
  - "The work being deduped was previously unconditional, so it re-ran on many unrelated triggers"
  - "The load has failure modes that produce an EMPTY-but-successful-looking result"
  - "Consumers of the load can arrive AFTER it completes (lazy mounts, deferred hydration)"
tags:
  - deduplication
  - idempotence
  - cache-invalidation
  - silent-skip
  - recovery-path
  - review-checklist
related_components:
  - panel_system
  - testing_framework
---

## Context

`#5376`: a default anonymous dashboard load issued 20 `/api/rss-proxy` requests and **two** `list-feed-digest` requests. The second half was pure waste — `loadAllData()`'s task list carried an unconditional `news` task, and its drain loop re-runs the whole list when a second call arrives while the first is in flight, which boot guarantees.

The fix looked obvious: news is the one hydration task that is not viewport-gated, so gate it on a signature of the resolved work-list and skip triggers that change nothing. That is correct, and it removed the duplicate load.

It also removed four things nobody had noticed the duplicate was doing. Adversarial review of the gate found all four, and they are the same defect wearing different clothes: **the redundant work had been an accidental recovery mechanism, and the gate was keyed on too little to know when recovery was still needed.**

| What the duplicate load was silently providing | How the gate broke it |
|---|---|
| Retry after a failed digest | The signature was recorded even when the load landed **nothing**, so an outage looked "already loaded" and every retry was suppressed until the 20-minute refresh |
| Retry after a *degraded* digest | HTTP 200 with an empty `categories` map is non-null, so a null check called it success while every panel rendered empty |
| Picking up a source toggled off in settings | Nothing in the toggle path reloads news; the signature covered categories but not `ctx.disabledSources`, which the load also filters on |
| Clearing the skeleton on a late-mounting panel | A panel that mounts after the load is backfilled from cache, but the backfill skipped a cached `[]` — the second load used to re-render it |

## Guidance

When you dedupe work that was previously unconditional, do three things before shipping.

**1. Enumerate what the redundancy was providing.** List every reason the work ran repeatedly, not just the one you are eliminating. The question is not "why is this running twice?" but "what would break if it ran exactly once?" Retry-on-failure, late-consumer refresh, and pickup-of-external-state are the three that recur.

**2. Key the gate on every input the work reads, not just the one that motivated it.** A signature that covers less than the work's real inputs turns "a change the gate cannot see" into "a change the user cannot get."

```ts
// Not enough — the load ALSO filters each category's feeds by ctx.disabledSources
export function newsWorkListSignature(categories: readonly { key: string }[]): string {
  return [...new Set(categories.map(c => c.key))].sort().join('|');
}

// Covers both inputs; separate arrays so a category key can't combine with a
// source name to spoof a different pair.
export function newsWorkListSignature(
  categories: readonly { key: string }[],
  disabledSources: Iterable<string>,   // REQUIRED — no empty default
): string {
  return JSON.stringify([
    [...new Set(categories.map(c => c.key))].sort(),
    [...new Set(disabledSources)].sort(),
  ]);
}
```

Make the added parameter **required**, with no default. A defaulted `disabledSources = []` lets a future caller silently rebuild the blind signature you just fixed, and that failure is invisible at runtime.

**3. Record the "done" marker only when the work actually produced something to protect.** The marker means "I already have this" — so an empty or failed run must not set it. The subtlety is that "failed" has more shapes than an exception:

```ts
// Not enough: a 200 carrying an empty `categories` map is non-null.
const landed = digest !== null || items.length > 0;

// Coverage, not nullness. Measured over PRESET categories only, so one
// succeeding custom category can't mask an outage for all the others.
const digestCategories = newsPass.finalDigest?.categories ?? {};
const digestCovered = categories.some(({ key, isCustom }) => !isCustom && key in digestCategories);
const anyItemsCollected = collectedNews.length > 0;
const noCategoriesToLoad = categories.length === 0;
const landed = digestCovered || anyItemsCollected || noCategoriesToLoad;
if (landed) this.loadedNewsSignature = newsWorkListSignature(categories, disabledAtLoadStart);
```

Snapshot mutable inputs at work *start*, not at record time — `ctx.disabledSources` is mutated in place, so reading it after the awaits records the post-toggle set for a load that used the pre-toggle one.

## Why This Matters

A skip-gate is a **silent-skip mechanism**: when it removes the work, nothing errors, nothing logs, and every test that asserts "we didn't do the redundant thing" passes. The failure mode is indistinguishable from success on every axis except the one nobody is watching — whether the user has data.

The asymmetry is what makes this worth a checklist. Getting the gate slightly too *loose* costs one extra request. Getting it slightly too *tight* strands the UI until the next scheduled refresh — here, up to 20 minutes, longer while the tab is hidden because the refresh loop pauses on hidden. Bias the predicate toward doing the work.

The late-consumer case generalizes past caching. Anywhere a producer writes to a shared store and a consumer may attach later, the attach-time backfill has to handle the empty value, because "empty" is a real result and not an absence:

```ts
// Skips a cached [] — the panel keeps the skeleton its constructor installed
if (existingItems?.length) { render(existingItems); }

// Presence, not length
if (existingItems) { render(existingItems); }   // render([]) shows the empty state
```

## When to Apply

Reach for this checklist when a change makes previously-unconditional work conditional — a new cache key, an `if (alreadyLoaded) return`, an ETag, a dirty flag, a debounce that drops trailing calls. It applies most sharply when **the work talks to the network** (failures produce empty successes) and when **its consumers mount lazily** (late arrivals depended on the repeat).

It does *not* apply to deduping pure computation with no failure mode and no late consumers — memoizing a formatter has none of these hazards.

## Examples

The regression guard is the acceptance criterion as a test, and each case exists because a specific defect was reproduced first. `e2e/dashboard-news-request-budget.spec.ts` asserts both directions — the budget is held, *and* recovery still happens:

```ts
// The gate holds
expect(log.digestUrls.length).toBe(1);
expect(log.rssProxyUrls).toEqual([]);

// ...and a load that landed nothing is still retried, then settles
await installNewsRequestAccounting(page, { failDigestTimes: 1 });
expect(log.digestUrls.length).toBeGreaterThanOrEqual(2);
```

Two traps worth copying from that spec:

- **Fail only the first N attempts, not all of them.** The data loader's own circuit breaker opens after 2 consecutive failures and then serves from cache with no network request — an always-failing stub stops producing observable attempts and hides whether a retry happened at all.
- **Prove your trigger fired.** The settle assertion originally scrolled with `page.mouse.wheel` and passed. A positive control showed it never scrolled: this dashboard sets `overflow: hidden` on html and body, so the document does not scroll and window-level scroll events never fire. "No new request" was indistinguishable from "no trigger fired." It now resizes and asserts the event was delivered before concluding anything.

Mutation-verify each guard: restore the original defect and confirm the case fails. All four here were confirmed to fail on revert.

## Related

- PR #5878 — the fix and its five-case guard
- #5876 — the `overflow: hidden` scroll discovery, surfaced by the positive control above
- #5877 — a degraded 200 digest is persisted as last-good, the cross-page-load version of the same empty-success hazard
- `docs/solutions/best-practices/checks-must-fail-closed-when-they-lose-their-target.md` — sibling lesson on guards that pass when they stop measuring anything
