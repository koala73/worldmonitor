---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, performance, deep-forecast]
---

# `extractNewsClusterItems` called once per candidate — should be hoisted outside the map

## Problem Statement

`filterNewsHeadlinesByState` calls `extractNewsClusterItems(newsInsights, newsDigest)` on every candidate. `selectImpactExpansionCandidates` maps over ALL stateUnits (not just the top N) before filtering. If stateUnits has 50+ entries, `extractNewsClusterItems` (which iterates all topStories + all digest categories, ~200+ items) runs 50+ times against the same data. At scale, this is 50 * 200 * 4 regexes = 40,000+ regex evaluations per seed run that can be reduced to 200 * 4 with one hoist.

## Findings

- `seed-forecasts.mjs:3321` — `extractNewsClusterItems(newsInsights, newsDigest)` called inside `filterNewsHeadlinesByState`
- `seed-forecasts.mjs:3460-3469` — `.map()` over ALL `stateUnits` before `.filter(Boolean).slice(0, limit)`
- Each `stateUnit` → `buildImpactExpansionCandidate` → `filterNewsHeadlinesByState` → `extractNewsClusterItems`
- Same `newsInsights`/`newsDigest` objects passed to every call

## Proposed Solutions

### Option A: Hoist extraction into `selectImpactExpansionCandidates` (Recommended)

```javascript
const preExtractedNewsItems = (newsInsights || newsDigest)
  ? extractNewsClusterItems(newsInsights, newsDigest)
  : [];
// Pass to buildImpactExpansionCandidate as preExtractedNewsItems
// filterNewsHeadlinesByState accepts optional preExtractedItems param
```
Effort: Small | Risk: Low

### Option B: Memoize `extractNewsClusterItems` with a WeakMap key

- Key on `[newsInsights, newsDigest]` pair
- Effort: Medium | Risk: Low (WeakMap needs stable object references)

## Acceptance Criteria

- [ ] `extractNewsClusterItems` called at most once per seeding run regardless of stateUnit count
- [ ] All T-news tests still pass

## Technical Details

- File: `scripts/seed-forecasts.mjs:3321` and `3460`
- Functions: `filterNewsHeadlinesByState`, `selectImpactExpansionCandidates`

## Work Log

- 2026-03-24: Found by compound-engineering:review:performance-oracle in PR #2178 review
