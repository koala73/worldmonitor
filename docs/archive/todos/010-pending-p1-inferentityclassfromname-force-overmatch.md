---
status: pending
priority: p1
issue_id: "010"
tags: [code-review, deep-forecast, simulation-package, correctness]
---

# `inferEntityClassFromName` — `|force|` overmatch misclassifies commercial entities as `military_or_security_actor`

## Problem Statement

`inferEntityClassFromName` contains `|force|` as a standalone regex alternative. This matches any entity name containing "force" as a substring — including commercial names like "Salesforce", "Workforce Solutions", "Task Force [commodity]". Such entities are silently classified as `military_or_security_actor` and this misclassification is written verbatim into the `simulation-package.json` R2 artifact, which is consumed by downstream LLMs.

## Findings

- `scripts/seed-forecasts.mjs` — `inferEntityClassFromName`, first regex branch:
  ```javascript
  if (/military|army|navy|air force|guard|force|houthi|irgc|revolutionary|armed/.test(s)) return 'military_or_security_actor';
  ```
- `|force|` without word boundaries matches "Salesforce", "Workforce", "Task Force Oil Logistics", etc.
- `air force` (with space) already works correctly — the space is a literal match. The standalone `|force|` is redundant and dangerous.
- Misclassified entity class propagates into exported `simulation-package.json` with no log or warning.

## Proposed Solutions

### Option A: Add word boundaries and explicit "air force" (Recommended)

```javascript
if (/\b(military|army|navy|air\s+force|national\s+guard|houthi|irgc|revolutionary\s+guard|armed\s+forces?)\b/.test(s)) return 'military_or_security_actor';
```
Effort: Tiny | Risk: Low

### Option B: Remove `force` entirely, rely on other terms

Remove `|force|` and `|guard|` (too broad) and add the specific IRGC/Houthi terms already present.
Effort: Tiny | Risk: Low

## Acceptance Criteria

- [ ] `inferEntityClassFromName('Salesforce Inc')` returns `'exporter_or_importer'` or `'market_participant'`, NOT `'military_or_security_actor'`
- [ ] `inferEntityClassFromName('US Air Force')` still returns `'military_or_security_actor'`
- [ ] `inferEntityClassFromName('Houthi armed forces')` still returns `'military_or_security_actor'`
- [ ] New unit tests for all three cases

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `inferEntityClassFromName` function

## Work Log

- 2026-03-24: Found by compound-engineering:review:kieran-typescript-reviewer in PR #2204 review
