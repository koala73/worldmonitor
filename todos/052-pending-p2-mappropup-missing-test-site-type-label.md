---
status: pending
priority: p2
issue_id: "052"
tags: [code-review, bug, frontend, nuclear, map, pr-2375]
dependencies: []
---

## Problem Statement

`src/config/geo.ts` adds nuclear test sites with `type: 'test-site'` to `NUCLEAR_FACILITIES`, but the MapPopup component's `typeLabels` map does not include a `'test-site'` entry. When the popup renders for a test site marker, it falls through to a raw string display, showing `'TEST-SITE'` instead of a human-readable label like `'Nuclear Test Site'`.

## Findings

- **File:** `src/config/geo.ts` — 5 nuclear test sites added with `type: 'test-site'`
- **File:** MapPopup component (likely `src/components/MapPopup.ts` or similar) — `typeLabels` object missing `'test-site'` key
- **Impact:** Nuclear test site map markers show raw `'TEST-SITE'` string in popup header — unprofessional, confusing to users

## Proposed Solutions

**Option A: Add 'test-site' to typeLabels (Recommended)**

```typescript
const typeLabels: Record<string, string> = {
  // ... existing entries ...
  'test-site': 'Nuclear Test Site',
};
```

- **Effort:** Trivial (one line)
- **Risk:** None

**Option B: Add fallback label formatting**

If typeLabels misses a key, format the raw type string (e.g., `'test-site'` → `'Test Site'`) as a fallback.

- **Effort:** Small
- **Risk:** Very low — better defensive coding but still worth adding the explicit label

## Acceptance Criteria

- [ ] Nuclear test site popups display 'Nuclear Test Site' (or equivalent human-readable label)
- [ ] No raw type string ('TEST-SITE') visible in any popup

## Work Log

- 2026-03-27: Identified by code-review agents during PR #2375 review.
