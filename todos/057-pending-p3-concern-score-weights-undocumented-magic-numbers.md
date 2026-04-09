---
status: pending
priority: p3
issue_id: "057"
tags: [code-review, quality, seeding, disease-outbreaks, maintainability, pr-2375]
dependencies: []
---

## Problem Statement

The disease outbreak concern score calculation in `scripts/seed-disease-outbreaks.mjs` uses magic number weights (0.6, 0.25, 0.15) with no explanation of their origin or rationale. Future maintainers cannot know whether these are tuned values, arbitrary guesses, or domain-informed weights — making them impossible to adjust confidently.

## Findings

- **File:** `scripts/seed-disease-outbreaks.mjs` — concern score formula: `score = severity * 0.6 + spread * 0.25 + alertLevel * 0.15` (or similar)
- **No comment** explaining why these specific weights were chosen
- **Impact:** Low immediate risk, but maintainers tuning outbreak scoring will cargo-cult the values or blindly change them

## Proposed Solutions

**Option A: Add inline comment documenting the rationale**

```javascript
// Severity weighted highest (0.6) as it drives treatment urgency;
// geographic spread (0.25) secondary; alert level (0.15) is a lagging indicator
const concernScore = severity * 0.6 + spread * 0.25 + alertLevel * 0.15;
```

- **Effort:** Trivial (2-line comment)
- **Risk:** None

**Option B: Extract as named constants**

```javascript
const SEVERITY_WEIGHT = 0.6;  // primary driver: mortality/transmissibility
const SPREAD_WEIGHT = 0.25;   // geographic footprint
const ALERT_WEIGHT = 0.15;    // WHO/national alert level (lags reality)
```

- **Effort:** Trivial
- **Risk:** None — improves readability significantly

## Acceptance Criteria

- [ ] Concern score weights documented with rationale (comment or named constants)

## Work Log

- 2026-03-27: Identified by simplicity-reviewer agent during PR #2375 review.
