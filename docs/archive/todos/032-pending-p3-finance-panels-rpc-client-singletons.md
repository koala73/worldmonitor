---
status: complete
priority: p3
issue_id: "032"
tags: [code-review, performance, finance-panels]
dependencies: []
---

# Finance Panels: RPC Client Constructed on Every fetchData() Call

## Problem Statement

All 6 new finance panels (MacroTilesPanel, YieldCurvePanel, FSIPanel, EarningsCalendarPanel, EconomicCalendarPanel, CotPositioningPanel) plus `_collectRegimeContext` and `_collectYieldCurveContext` in data-loader.ts construct a new `EconomicServiceClient` or `MarketServiceClient` on every `fetchData()` call via dynamic imports.

## Findings

```typescript
// Re-runs on every fetchData() call:
const { EconomicServiceClient } = await import('@/generated/client/...');
const { getRpcBaseUrl } = await import('@/services/rpc-client');
const client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: ... });
```

While Vite caches module resolution, a new client object is constructed each call. The fetch lambda `(...args) => globalThis.fetch(...args)` is also recreated each time. On retry or multiple panel opens in the same session, this is unnecessary work.

## Proposed Solutions

### Option A: Module-level lazy singleton per panel

```typescript
let _client: EconomicServiceClient | null = null;
function getClient(): EconomicServiceClient {
  if (!_client) {
    const { getRpcBaseUrl } = require('@/services/rpc-client'); // sync after module load
    _client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
  }
  return _client;
}
```

- **Effort**: Small per panel
- **Risk**: Low — clients are stateless

### Option B: Shared RPC client factory in a separate module

A `getRpcClients()` helper that lazily initializes and caches both service clients.

- **Effort**: Medium
- **Risk**: Low

## Acceptance Criteria

- [ ] Each panel's service client is created at most once per panel instance
- [ ] fetch lambda still uses deferred `globalThis.fetch` (not bound at construction)

## Work Log

- 2026-03-26: Identified by performance review of PR #2258
