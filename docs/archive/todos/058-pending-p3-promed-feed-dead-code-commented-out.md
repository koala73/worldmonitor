---
status: complete
priority: p3
issue_id: "058"
tags: [code-review, quality, seeding, disease-outbreaks, cleanup, pr-2375]
dependencies: []
---

## Problem Statement

`scripts/seed-disease-outbreaks.mjs` contains commented-out code for a ProMED feed integration (`PROMED_FEED`). This dead code was never activated and adds noise to the file. If ProMED integration is planned, it should be tracked as a separate task; otherwise it should be removed.

## Findings

- **File:** `scripts/seed-disease-outbreaks.mjs` — commented-out `PROMED_FEED` URL constant and associated fetch/parse logic
- **No associated todo or feature flag** — ambiguous whether this is planned work or abandoned exploration
- **Impact:** Adds ~10-15 lines of dead code; new contributors may be confused about whether ProMED is partially integrated

## Proposed Solutions

**Option A: Remove the commented-out code (Recommended)**

Delete all `PROMED_FEED` references. If ProMED integration is desired, create a separate feature task.

- **Effort:** Trivial
- **Risk:** None — commented code has no runtime effect

**Option B: Add a TODO comment with issue reference**

Replace with: `// TODO(#ISSUE): ProMED feed integration — https://promedmail.org/rss/`

- **Effort:** Trivial
- **Risk:** None

## Acceptance Criteria

- [ ] No commented-out `PROMED_FEED` code in `seed-disease-outbreaks.mjs`
- [ ] If ProMED integration is wanted, a separate issue/todo exists for it

## Work Log

- 2026-03-27: Identified by simplicity-reviewer agent during PR #2375 review.
