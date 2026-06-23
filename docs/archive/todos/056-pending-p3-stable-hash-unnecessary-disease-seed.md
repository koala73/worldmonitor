---
status: pending
priority: p3
issue_id: "056"
tags: [code-review, quality, seeding, disease-outbreaks, simplicity, pr-2375]
dependencies: []
---

## Problem Statement

`scripts/seed-disease-outbreaks.mjs` implements a custom `stableHash` function (djb2 variant) to generate IDs for disease outbreak items. Since WHO DON RSS items each have a unique `<link>` URL (the WHO article URL), using the URL directly as the item ID — or a simple truncation of it — would be stable, readable, and require no custom hashing code.

## Findings

- **File:** `scripts/seed-disease-outbreaks.mjs` — `stableHash(title + pubDate)` used to generate item IDs
- **Each WHO DON item has:** a unique `<link>` field (e.g., `https://www.who.int/emergencies/disease-outbreak-news/item/...`)
- **The WHO item URL slug is already a stable unique identifier** — no hash needed
- **Impact:** Custom hash function adds ~10 lines of unnecessary code; URL-based IDs would be human-readable in Redis and easier to debug

## Proposed Solutions

**Option A: Use WHO item URL slug as ID (Recommended)**

```javascript
// Instead of: id: stableHash(title + pubDate)
// Use: id: link.split('/').pop() || stableHash(title)
const id = item.link?.split('/item/')[1]?.replace(/[^a-z0-9-]/gi, '') || stableHash(title);
```

- **Effort:** Trivial
- **Risk:** Very low — IDs are stable as long as WHO URL structure doesn't change (they have been stable for years)

**Option B: Remove stableHash, use title + pubDate substring**

Generate IDs from a truncated, URL-encoded version of the title + date without a hash function.

- **Effort:** Trivial
- **Risk:** Very low

## Acceptance Criteria

- [ ] `stableHash` function removed or replaced with simpler ID generation
- [ ] Item IDs remain stable across re-runs (same item → same ID)

## Work Log

- 2026-03-27: Identified by simplicity-reviewer agent during PR #2375 review.
