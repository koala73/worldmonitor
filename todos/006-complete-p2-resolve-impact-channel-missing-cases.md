---
status: pending
priority: p2
issue_id: "006"
tags: [code-review, deep-forecast, signal-routing]
---

# `resolveImpactChannel` missing `safe_haven_bid` and `global_crude_spread_stress` mappings

## Problem Statement

`resolveImpactChannel` maps `safe.haven` to `risk_off_rotation`, but `safe_haven_bid` is a distinct channel in the `sovereign_risk` bucket. Routing it to `risk_off_rotation` sends sovereign-risk hypotheses to a broader, less specific bucket. `global_crude_spread_stress` (used in `energy` and `rates_inflation`) has no matching branch and falls through to `commodity_repricing` (freight/energy), misclassifying grade-spread events.

## Findings

- `seed-forecasts.mjs:319` — `safe.haven` → `risk_off_rotation` (should be `safe_haven_bid`)
- `MARKET_BUCKET_ALLOWED_CHANNELS.sovereign_risk` includes `safe_haven_bid` — not `risk_off_rotation`
- `global_crude_spread_stress` appears in `energy` and `rates_inflation` buckets — no handler in `resolveImpactChannel`
- Both are reachable LLM outputs

## Proposed Solutions

### Option A: Add explicit branches (Recommended)

```javascript
if (/safe.haven|safe haven bid/.test(m)) return 'safe_haven_bid';
if (/crude.spread|brent.wti|grade.spread/.test(m)) return 'global_crude_spread_stress';
```
Effort: Small | Risk: Low

### Option B: Build a lookup table from MARKET_BUCKET_ALLOWED_CHANNELS

- Generate a flat `channelKeywords → channel` map from the registry
- More maintainable, self-updating
- Effort: Medium | Risk: Low

## Acceptance Criteria

- [ ] `resolveImpactChannel('safe haven bid flight to quality')` returns `'safe_haven_bid'`
- [ ] `resolveImpactChannel('global crude spread stress Brent WTI')` returns `'global_crude_spread_stress'`
- [ ] New unit tests for both cases
- [ ] `resolveImpactChannel` test file created or appended to forecast tests

## Technical Details

- File: `scripts/seed-forecasts.mjs:298-335` (`resolveImpactChannel`)
- Missing from MARKET_BUCKET_ALLOWED_CHANNELS coverage

## Work Log

- 2026-03-24: Found by kieran-typescript-reviewer in PR #2178 review
