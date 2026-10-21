---
status: complete
priority: p3
issue_id: "033"
tags: [code-review, bug, finance-panels]
dependencies: []
---

# ALLOWED_SERIES Missing BAMLC0A0CM and SOFR (Pre-existing)

## Problem Statement

`scripts/seed-economy.mjs` seeds `BAMLC0A0CM` (IG OAS) and `SOFR` into Redis, but neither series appears in `ALLOWED_SERIES` in `server/worldmonitor/economic/v1/get-fred-series-batch.ts`. Any RPC request for these series silently returns empty data.

## Findings

- `seed-economy.mjs` line 20: includes `'BAMLC0A0CM', 'SOFR'` in FRED_SERIES
- `get-fred-series-batch.ts` ALLOWED_SERIES: does NOT include these two series
- Result: data is written to Redis but unreachable via the public RPC
- Pre-existing bug, not introduced by PR #2258 but visible because the file was touched

## Proposed Solutions

### Option A: Add to ALLOWED_SERIES

```typescript
'BAMLC0A0CM', // IG OAS spread
'SOFR',       // Secured Overnight Financing Rate
```

One-line fix. No other changes needed.

- **Effort**: Minimal
- **Risk**: None — just allowlisting existing seeded data

## Acceptance Criteria

- [ ] `getFredSeriesBatch({ seriesIds: ['BAMLC0A0CM', 'SOFR'] })` returns data
- [ ] No changes to seed scripts needed

## Work Log

- 2026-03-26: Identified by architecture review of PR #2258 (pre-existing gap)
