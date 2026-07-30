---
status: complete
priority: p1
issue_id: "050"
tags: [code-review, bug, seeding, disease-outbreaks, proto, pr-2375]
dependencies: []
---

## Problem Statement

The `DiseaseOutbreakItem` proto message has a `location` field (field 3) that is never populated by the seed script. `scripts/seed-disease-outbreaks.mjs` parses WHO DON RSS feed items and builds outbreak objects, but the `location` property is always set to an empty string. The frontend panel and any downstream consumers that display location will always show blank.

## Findings

- **File:** `proto/worldmonitor/health/v1/list_disease_outbreaks.proto` — `DiseaseOutbreakItem` has `string location = 3`
- **File:** `scripts/seed-disease-outbreaks.mjs:84-93` — Outbreak object construction never assigns a `location` value; the field is omitted or set to `''`
- **WHO DON RSS format:** Location is often embedded in the item `<title>` (e.g., "Avian influenza A(H5N1) – **Cambodia**") or `<description>` — not a dedicated field, requires extraction
- **Impact:** All disease outbreak cards show no location. Users cannot see which country/region the outbreak affects — a critical piece of context for a geopolitical monitoring app

## Proposed Solutions

**Option A: Extract location from title via regex (Recommended)**

Most WHO DON titles follow the pattern `<Disease> – <Country>` or `<Disease> in <Country>`. Extract the country portion:

```javascript
function extractLocation(title) {
  // "Avian influenza A(H5N1) – Cambodia" → "Cambodia"
  const dashMatch = title.match(/[–—-]\s*([^–—]+)$/);
  if (dashMatch) return dashMatch[1].trim();
  const inMatch = title.match(/\bin\s+([A-Z][^,]+)/);
  if (inMatch) return inMatch[1].trim();
  return '';
}
```

- **Effort:** Small (add helper + populate field)
- **Risk:** Low — regex may miss edge cases but degrades gracefully to empty string

**Option B: Parse `<georss:point>` or `<dc:subject>` from WHO RSS**

Some WHO feeds include geographic metadata in extended RSS fields. Parse these if present.

- **Effort:** Medium (check actual feed structure, add XML parsing for extra namespaces)
- **Risk:** Low — feed structure may not consistently include these fields

**Option C: Leave empty for now, document as known gap**

Add a comment in the seed and a note in the panel that location is not yet populated.

- **Effort:** Minimal
- **Risk:** Low — but leaves a blank field in production

## Acceptance Criteria

- [ ] `location` field populated for at least 80% of disease outbreak items
- [ ] Empty string is acceptable fallback when location cannot be determined
- [ ] Panel displays location correctly when populated

## Work Log

- 2026-03-27: Identified by code-review agents during PR #2375 review.
