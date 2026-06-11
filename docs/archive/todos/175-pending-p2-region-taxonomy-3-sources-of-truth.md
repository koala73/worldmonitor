---
status: pending
priority: p2
issue_id: 175
tags: [code-review, phase-0, regional-intelligence, dry, taxonomy]
dependencies: []
---

# Region taxonomy has 3 independent sources of truth (PR #2942 should import REGIONS from geography.js)

## Problem Statement

PR #2940 ships `shared/geography.js` with `REGIONS` and `forecastLabel` fields. PR #2942 ships `ForecastPanel.ts:10-19` with a hardcoded `FORECAST_REGIONS` constant duplicating the same labels. Plus `api/mcp.ts:556` enumerates DIFFERENT region examples ("Asia Pacific" not "East Asia"), breaking agent-native parity. Plus `scripts/seed-forecasts.mjs` writes `f.region` strings via `MACRO_REGION_MAP` that are a fourth implicit source.

Adding a region requires editing 3-4 files. They will drift.

## Findings

- `src/components/ForecastPanel.ts:10-19` — hardcoded `FORECAST_REGIONS` constant.
- `shared/geography.js:46-124` — canonical `REGIONS` with `forecastLabel` field.
- `api/mcp.ts:556-577` — generate_forecasts tool description enumerates "Asia Pacific" etc. (different from geography).
- `scripts/seed-forecasts.mjs` — `MACRO_REGION_MAP` as implicit fourth source.

## Proposed Solutions

### Option 1: ForecastPanel.ts imports REGIONS from shared/geography

Derive `FORECAST_REGIONS` via `REGIONS.map(r => ({ id: r.id, label: r.forecastLabel }))`. Update `api/mcp.ts` to enumerate the same labels (also via import from geography).

**Pros:** Zero new files; uses the module already designated as canonical; straight deletion of duplicates.
**Cons:** Minor — TS consumers need to deal with a `.js` import, but that's already a pattern elsewhere.
**Effort:** Small.
**Risk:** Low.

### Option 2: Extract a shared/forecast-regions.ts module

Create a dedicated `shared/forecast-regions.ts` module exporting the canonical list. ForecastPanel + MCP both import.

**Pros:** Explicit module for this concern.
**Cons:** Creates a second layer of indirection when geography.js is already the intended source of truth.
**Effort:** Small.
**Risk:** Low.

## Recommended Action

Option 1 — `geography.js` is already the canonical source; the panel and MCP description should consume it directly. Delete `FORECAST_REGIONS` and the ad-hoc MCP examples.

## Technical Details

`shared/geography.js` already has the `forecastLabel` field on every `REGIONS` entry specifically for this use case (added in PR #2940). The panel duplication in #2942 defeats the purpose. The MCP description drift ("Asia Pacific" vs "East Asia") is an agent-native correctness bug — MCP clients generate structured calls against the documented examples, so mismatched labels become unresolvable filters at runtime.

The `scripts/seed-forecasts.mjs` `MACRO_REGION_MAP` is a fourth source but its job is ISO2 → region mapping, not label authority. It should still derive its region IDs from `REGIONS`.

## Acceptance Criteria

- [ ] `ForecastPanel.ts` imports `REGIONS` from `shared/geography.js`.
- [ ] `api/mcp.ts` `generate_forecasts` tool description enumerates exactly the same labels.
- [ ] Adding a region in `geography.js` automatically updates UI pills and MCP description.
- [ ] `MACRO_REGION_MAP` in `seed-forecasts.mjs` references `REGIONS` for the region IDs.

## Work Log

## Resources

- PR #2940
- PR #2942
- Spec: `docs/internal/pro-regional-intelligence-upgrade.md`
