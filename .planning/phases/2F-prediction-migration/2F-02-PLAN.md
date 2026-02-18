---
phase: 2F-prediction-migration
plan: 02
type: execute
wave: 2
depends_on: ["2F-01"]
files_modified:
  - src/services/prediction/index.ts
  - src/services/index.ts
  - src/App.ts
  - src/components/PredictionPanel.ts
  - src/components/CountryBriefPage.ts
  - src/components/CountryIntelModal.ts
  - src/services/correlation.ts
  - src/services/analysis-worker.ts
  - src/utils/export.ts
  - src/types/index.ts
  - api/polymarket.js
  - src/services/polymarket.ts
autonomous: true
requirements: [DOMAIN-02, SERVER-02]

must_haves:
  truths:
    - "fetchPredictions() returns prediction markets with yesPrice in 0-100 scale"
    - "fetchCountryMarkets(country) returns country-specific markets with correct variant matching"
    - "Multi-strategy fetch chain works: direct browser -> Tauri -> Railway -> sebuf client -> production fallback"
    - "Tag-based event aggregation preserves deduplication, keyword filtering, volume thresholds"
    - "CountryIntelModal displays correct percentage (not 6500%)"
    - "App.ts search modal displays correct percentage (not 6500%)"
    - "App.ts snapshot restore computes noPrice correctly (100 - yesPrice, not 1 - yesPrice)"
    - "Legacy api/polymarket.js and src/services/polymarket.ts are deleted"
    - "PredictionMarket type removed from src/types/index.ts"
    - "All consumers import PredictionMarket from @/services/prediction"
  artifacts:
    - path: "src/services/prediction/index.ts"
      provides: "Complex service module with multi-strategy fetch, tag aggregation, country markets"
      exports: ["fetchPredictions", "fetchCountryMarkets", "PredictionMarket"]
    - path: "src/services/index.ts"
      provides: "Barrel export updated from polymarket to prediction"
      contains: "export * from './prediction'"
  key_links:
    - from: "src/services/prediction/index.ts"
      to: "src/generated/client/worldmonitor/prediction/v1/service_client.ts"
      via: "PredictionServiceClient as strategy 4 in polyFetch"
      pattern: "PredictionServiceClient"
    - from: "src/App.ts"
      to: "src/services/prediction/index.ts"
      via: "imports fetchPredictions and fetchCountryMarkets"
      pattern: "from '@/services/prediction'"
    - from: "src/components/PredictionPanel.ts"
      to: "src/services/prediction/index.ts"
      via: "imports PredictionMarket type"
      pattern: "from '@/services/prediction'"
---

<objective>
Create the prediction service module preserving all multi-strategy fetch logic, tag-based event aggregation, keyword filtering, country market matching, and circuit breaker. Rewire all 9 consumer files. Fix 3 existing yesPrice bugs. Delete legacy endpoint and service.

Purpose: Complete the prediction domain migration to sebuf. The service module is COMPLEX -- unlike prior thin port/adapters (climate, wildfires), this module preserves the entire multi-strategy fetch chain, tag-based aggregation, and country market logic. The generated PredictionServiceClient replaces the old `/api/polymarket` Vercel endpoint as strategy 4 in the fetch chain.

Output: Working prediction service module at `src/services/prediction/index.ts`, all consumers rewired, 3 yesPrice bugs fixed, legacy files deleted.
</objective>

<execution_context>
@/Users/sebastienmelki/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastienmelki/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/2F-prediction-migration/2F-RESEARCH.md
@.planning/phases/2F-prediction-migration/2F-01-SUMMARY.md

# Legacy service being replaced (source of truth for all business logic)
@src/services/polymarket.ts

# Generated client (used as strategy 4 in multi-strategy fetch)
@src/generated/client/worldmonitor/prediction/v1/service_client.ts

# Reference: prior service module patterns
@src/services/climate/index.ts
@src/services/wildfires/index.ts

# Consumers to rewire
@src/App.ts
@src/components/PredictionPanel.ts
@src/components/CountryBriefPage.ts
@src/components/CountryIntelModal.ts
@src/services/correlation.ts
@src/services/analysis-worker.ts
@src/utils/export.ts

# Files to clean up
@src/types/index.ts
@src/services/index.ts
@api/polymarket.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create prediction service module and rewire all consumers</name>
  <files>
    src/services/prediction/index.ts
    src/services/index.ts
    src/App.ts
    src/components/PredictionPanel.ts
    src/components/CountryBriefPage.ts
    src/components/CountryIntelModal.ts
    src/services/correlation.ts
    src/services/analysis-worker.ts
    src/utils/export.ts
  </files>
  <action>
**Step 1: Create `src/services/prediction/index.ts`**

This is the most complex service module in the migration series. It is NOT a thin port/adapter -- it preserves ALL business logic from `src/services/polymarket.ts` with one key modification: strategy 4 in the multi-strategy fetch chain uses the generated `PredictionServiceClient` instead of the old `/api/polymarket` Vercel endpoint.

Structure the file as follows (preserving all logic from `src/services/polymarket.ts`):

**Imports:**
```typescript
import { PredictionServiceClient } from '@/generated/client/worldmonitor/prediction/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { SITE_VARIANT } from '@/config';
import { isDesktopRuntime } from '@/services/runtime';
import { tryInvokeTauri } from '@/services/tauri-bridge';
```

**Consumer-friendly type (re-export, matches legacy shape):**
```typescript
export interface PredictionMarket {
  title: string;
  yesPrice: number;     // 0-100 scale (legacy compat)
  volume?: number;
  url?: string;
}
```

**Internal Gamma API interfaces** (copy from legacy polymarket.ts):
- `PolymarketMarket` with question, outcomes, outcomePrices, volume, volumeNum, closed, slug
- `PolymarketEvent` with id, title, slug, volume, liquidity, markets, tags, closed

**Internal constants and state** (copy from legacy exactly):
- `GAMMA_API = 'https://gamma-api.polymarket.com'`
- `RAILWAY_POLY_URL` derivation from `import.meta.env.VITE_WS_RELAY_URL`
- `breaker = createCircuitBreaker<PredictionMarket[]>({ name: 'Polymarket' })`
- `directFetchWorks`, `directFetchProbe`, `loggedDirectFetchBlocked` state
- `logDirectFetchBlockedOnce()` helper
- `probeDirectFetchCapability()` function (exactly as legacy)

**`polyFetch` function -- MODIFIED strategy 4:**

Copy the entire `polyFetch` function from legacy with ONE change. Replace the old Vercel proxy strategy:
```typescript
// OLD (strategy 4): Vercel edge function
try {
  const resp = await fetch(`/api/polymarket?${proxyQs}`);
  ...
} catch { /* local proxy failed */ }
```

With the sebuf client strategy:
```typescript
// NEW (strategy 4): sebuf handler via generated client
try {
  const resp = await client.listPredictionMarkets({
    category: params.tag_slug ?? '',
    query: '',
    pagination: { pageSize: parseInt(params.limit ?? '50', 10), cursor: '' },
  });
  if (resp.markets && resp.markets.length > 0) {
    // Convert proto PredictionMarket[] to Gamma-compatible Response
    // so downstream parsing works uniformly
    const gammaData = resp.markets.map(m => ({
      question: m.title,
      outcomePrices: JSON.stringify([String(m.yesPrice), String(1 - m.yesPrice)]),
      volumeNum: m.volume,
      slug: m.id,
    }));
    return new Response(JSON.stringify(endpoint === 'events'
      ? [{ id: 'sebuf', title: gammaData[0]?.question, slug: '', volume: 0, markets: gammaData }]
      : gammaData
    ), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
} catch { /* sebuf handler failed (Cloudflare expected) */ }
```

Note: The proto `yesPrice` is 0-1 scale. The `parseMarketPrice` function will parse `outcomePrices` and multiply by 100, resulting in the correct 0-100 scale output.

Instantiate the client at module level:
```typescript
const client = new PredictionServiceClient('');
```

**Production fallback (strategy 5)** -- keep pointing to old URL for now:
```typescript
return fetch(`https://worldmonitor.app/api/polymarket?${proxyQs}`);
```

**All remaining business logic** -- copy EXACTLY from legacy `polymarket.ts`:
- `GEOPOLITICAL_TAGS`, `TECH_TAGS` arrays
- `EXCLUDE_KEYWORDS` array and `isExcluded()` function
- `parseMarketPrice()` function (returns 0-100)
- `buildMarketUrl()` function
- `fetchEventsByTag()` function
- `fetchTopMarkets()` function
- `fetchPredictions()` function (with breaker, tag fanout, dedup, volume threshold, signal filter, limit 15)
- `COUNTRY_TAG_MAP` record
- `getCountryVariants()` function
- `fetchCountryMarkets()` function

**Drop `getPolymarketStatus()`** -- dead code (exported but never imported anywhere, confirmed by grep).

**Exports:**
```typescript
export { PredictionMarket }; // type (already exported via interface above)
export { fetchPredictions };
export { fetchCountryMarkets };
```

**Step 2: Update barrel export in `src/services/index.ts`**

Change line 4 from:
```typescript
export * from './polymarket';
```
to:
```typescript
export * from './prediction';
```

**Step 3: Rewire App.ts imports**

1. Remove the direct polymarket import (line 16):
```typescript
// DELETE: import { fetchCountryMarkets } from '@/services/polymarket';
```

2. Remove `PredictionMarket` from the `@/types` import (line 103). Change:
```typescript
import type { PredictionMarket, MarketData, ClusteredEvent } from '@/types';
```
to:
```typescript
import type { MarketData, ClusteredEvent } from '@/types';
```

3. Add import from prediction service:
```typescript
import type { PredictionMarket } from '@/services/prediction';
import { fetchCountryMarkets } from '@/services/prediction';
```

Note: `fetchPredictions` is already imported via the barrel `@/services` (which now re-exports from `./prediction`), so no change needed for that.

4. **Fix bug on line 1560** (search modal -- yesPrice is already 0-100):
Change: `subtitle: \`\${(p.yesPrice * 100).toFixed(0)}% probability\``
To: `subtitle: \`\${Math.round(p.yesPrice)}% probability\``

5. **Fix bug on line 1655** (snapshot restore -- yesPrice is 0-100):
Change: `noPrice: 1 - p.yesPrice,`
To: `noPrice: 100 - p.yesPrice,`

**Step 4: Rewire PredictionPanel.ts import**

Change line 2:
```typescript
import type { PredictionMarket } from '@/types';
```
to:
```typescript
import type { PredictionMarket } from '@/services/prediction';
```

**Step 5: Rewire CountryBriefPage.ts import**

Change line 5:
```typescript
import type { PredictionMarket, NewsItem } from '@/types';
```
to:
```typescript
import type { NewsItem } from '@/types';
import type { PredictionMarket } from '@/services/prediction';
```

**Step 6: Rewire CountryIntelModal.ts import**

Change line 9:
```typescript
import type { PredictionMarket } from '@/types';
```
to:
```typescript
import type { PredictionMarket } from '@/services/prediction';
```

**Fix bug on line 236** (yesPrice is already 0-100):
Change: `\${(market.yesPrice * 100).toFixed(1)}%`
To: `\${market.yesPrice.toFixed(1)}%`

**Step 7: Rewire correlation.ts import**

Change line 6:
```typescript
import type { ClusteredEvent, PredictionMarket, MarketData } from '@/types';
```
to:
```typescript
import type { ClusteredEvent, MarketData } from '@/types';
import type { PredictionMarket } from '@/services/prediction';
```

**Step 8: Rewire analysis-worker.ts import**

Change line 6:
```typescript
import type { NewsItem, ClusteredEvent, PredictionMarket, MarketData } from '@/types';
```
to:
```typescript
import type { NewsItem, ClusteredEvent, MarketData } from '@/types';
import type { PredictionMarket } from '@/services/prediction';
```

**Step 9: Rewire export.ts import**

Change line 1:
```typescript
import type { NewsItem, ClusteredEvent, MarketData, PredictionMarket } from '@/types';
```
to:
```typescript
import type { NewsItem, ClusteredEvent, MarketData } from '@/types';
import type { PredictionMarket } from '@/services/prediction';
```

**Step 10: Verify type check passes**

Run `npx tsc --noEmit` to confirm all consumer rewiring is correct and no type errors exist.
  </action>
  <verify>npx tsc --noEmit</verify>
  <done>Service module at src/services/prediction/index.ts exports fetchPredictions, fetchCountryMarkets, and PredictionMarket type. All 7 consumer files import PredictionMarket from @/services/prediction. Barrel export updated. 3 yesPrice bugs fixed (CountryIntelModal, App.ts search, App.ts snapshot). Type check passes with zero errors.</done>
</task>

<task type="auto">
  <name>Task 2: Delete legacy endpoint, remove dead type, and rebuild</name>
  <files>
    api/polymarket.js
    src/services/polymarket.ts
    src/types/index.ts
  </files>
  <action>
**Step 1: Delete legacy endpoint**

```bash
rm api/polymarket.js
```

This file is fully replaced by the sebuf handler at `api/server/worldmonitor/prediction/v1/handler.ts` (Plan 2F-01).

**Step 2: Delete legacy service**

```bash
rm src/services/polymarket.ts
```

This file is fully replaced by `src/services/prediction/index.ts` (Task 1 of this plan).

**Step 3: Remove PredictionMarket from types/index.ts**

Remove the `PredictionMarket` interface (lines 611-616) from `src/types/index.ts`:
```typescript
// DELETE these lines:
export interface PredictionMarket {
  title: string;
  yesPrice: number;
  volume?: number;
  url?: string;
}
```

Before removing, verify no file still imports PredictionMarket from `@/types`:
```bash
grep -r "PredictionMarket.*from.*@/types" src/
```
This should return zero results after Task 1's rewiring.

**Step 4: Verify nothing is broken**

```bash
npx tsc --noEmit
```

**Step 5: Rebuild sidecar bundle** (gateway unchanged but full build validates everything):

```bash
npm run build:sidecar-sebuf
```
  </action>
  <verify>npx tsc --noEmit && npm run build:sidecar-sebuf</verify>
  <done>Legacy api/polymarket.js deleted. Legacy src/services/polymarket.ts deleted. PredictionMarket interface removed from src/types/index.ts. No file imports PredictionMarket from @/types. Type check passes. Sidecar bundle compiles.</done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` passes (all consumer rewiring correct, no type errors)
2. `npm run build:sidecar-sebuf` succeeds
3. `grep -r "PredictionMarket" src/types/index.ts` returns zero results
4. `grep -r "from.*@/types.*PredictionMarket\|PredictionMarket.*from.*@/types" src/` returns zero results
5. `grep -r "polymarket" src/services/index.ts` returns zero results (barrel updated)
6. `ls api/polymarket.js` returns "no such file" (deleted)
7. `ls src/services/polymarket.ts` returns "no such file" (deleted)
8. `ls src/services/prediction/index.ts` confirms service module exists
9. CountryIntelModal line 236 no longer has `* 100` (bug fixed)
10. App.ts line 1560 no longer has `* 100` (bug fixed)
11. App.ts line 1655 uses `100 - p.yesPrice` not `1 - p.yesPrice` (bug fixed)
</verification>

<success_criteria>
- Service module preserves ALL business logic: multi-strategy fetch, tag aggregation, keyword exclusion, volume threshold, signal filter, country markets, circuit breaker
- Strategy 4 in polyFetch uses PredictionServiceClient instead of old /api/polymarket
- yesPrice consistently 0-100 for all consumers regardless of data source (direct Gamma, Tauri, Railway, sebuf client, production)
- 3 yesPrice bugs fixed: CountryIntelModal (was * 100), App.ts search (was * 100), App.ts snapshot (was 1 - yesPrice)
- getPolymarketStatus dead code NOT carried over
- All 7 consumer files import PredictionMarket from @/services/prediction
- Legacy files deleted (api/polymarket.js, src/services/polymarket.ts)
- PredictionMarket removed from src/types/index.ts
- Barrel export updated from polymarket to prediction
- Full type check passes
</success_criteria>

<output>
After completion, create `.planning/phases/2F-prediction-migration/2F-02-SUMMARY.md`
</output>
