# Phase 2F: Prediction Migration - Research

**Researched:** 2026-02-18
**Domain:** Polymarket/Gamma API prediction markets, PredictionService handler, multi-strategy fetch, frontend consumer adaptation
**Confidence:** HIGH

## Summary

Phase 2F migrates the prediction/Polymarket domain to sebuf. This is the fourth domain migration following seismology (2C), wildfires (2D), and climate (2E), and benefits from thoroughly established patterns. However, this domain has **unique complexity** that distinguishes it from all prior migrations:

1. **The handler is fundamentally limited**: The Gamma API is behind Cloudflare JA3 fingerprint detection that blocks server-side TLS connections. The handler (running on Vercel Edge) will almost certainly fail to reach Gamma API directly, and must gracefully return an empty response. The existing `api/polymarket.js` already does this -- tries the fetch, returns `[]` on failure.

2. **Most business logic lives client-side**: Unlike seismology/climate/wildfires where the handler does the real work (fetching upstream API, transforming data), the Polymarket handler is a thin proxy that likely fails. The rich business logic -- tag-based event aggregation, keyword filtering, country market matching, volume thresholds, circuit breaker, multi-strategy fetch fallback (direct browser -> Tauri -> Railway -> Vercel proxy -> production) -- all lives in the client-side service (`src/services/polymarket.ts`).

3. **Proto model is RICHER than legacy**: The proto `PredictionMarket` has 7 fields (id, title, yes_price, volume, url, closes_at, category) while the legacy TypeScript type has only 4 (title, yesPrice, volume?, url?). The proto uses 0-1 scale for yes_price while legacy uses 0-100 scale. This is the first migration where the proto is richer.

**Primary recommendation:** Follow the established 2-plan pattern (Plan 01: handler + gateway, Plan 02: service module + consumer rewiring + legacy deletion). The handler is TRIVIALLY simple (proxy Gamma API, return empty on Cloudflare block). The service module is COMPLEX -- it must preserve all the multi-strategy fetch logic, tag-based aggregation, keyword filtering, country market matching, and circuit breaker currently in `src/services/polymarket.ts`. The service module calls the generated client as its FIRST strategy (which goes through the sebuf handler), but retains all fallback strategies. The service module also maps between the proto's richer 0-1 scale model and the legacy 0-100 scale that consumers expect.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DOMAIN-02 | Markets domain proto (Polymarket predictions) with service RPCs and HTTP annotations | Proto already defined at `proto/worldmonitor/prediction/v1/` with `PredictionMarket` message (7 fields), `ListPredictionMarkets` RPC, HTTP annotation at `/api/prediction/v1/list-prediction-markets`. No proto changes needed. |
| SERVER-02 | Handler implementation that proxies upstream external API and returns proto-typed responses | Handler must proxy Gamma API (`https://gamma-api.polymarket.com`), validate query params, support both `/events` and `/markets` endpoints via category/query request fields, and gracefully return empty on Cloudflare block. Pattern established by prior handlers but with graceful degradation twist. |
</phase_requirements>

## Current State

### Proto: `PredictionService`
Single RPC `ListPredictionMarkets`:
- Request: `pagination`, `category` (optional filter), `query` (optional search)
- Response: `markets: PredictionMarket[]`, `pagination`
- `PredictionMarket`: `id`, `title`, `yes_price (double, 0.0-1.0)`, `volume (double, USD)`, `url`, `closes_at (int64 millis)`, `category`
- Route: `POST /api/prediction/v1/list-prediction-markets`

**No proto enhancement needed.** The proto model is already richer than the legacy type:

| Proto field | Legacy field | Notes |
|---|---|---|
| `id: string` | (none) | New field, Gamma event/market slug |
| `title: string` | `title: string` | Exact match |
| `yesPrice: number` (0-1) | `yesPrice: number` (0-100) | **SCALE DIFFERENCE**: proto is 0-1, legacy is 0-100 |
| `volume: number` | `volume?: number` | Required in proto, optional in legacy |
| `url: string` | `url?: string` | Required in proto, optional in legacy |
| `closesAt: number` | (none) | New field, market close time in epoch ms |
| `category: string` | (none) | New field, e.g. "Politics" |

### Generated Code (already exists)
- Server: `src/generated/server/worldmonitor/prediction/v1/service_server.ts`
  - `PredictionServiceHandler` interface with `listPredictionMarkets(ctx, req): Promise<ListPredictionMarketsResponse>`
  - `createPredictionServiceRoutes(handler, options)` for gateway mounting
- Client: `src/generated/client/worldmonitor/prediction/v1/service_client.ts`
  - `PredictionServiceClient` class with `listPredictionMarkets(req): Promise<ListPredictionMarketsResponse>`

### Legacy Endpoint: `api/polymarket.js`
Vercel Edge function with:
- **Gamma API proxy**: `https://gamma-api.polymarket.com`
- **Two endpoints**: `events` (with tag_slug param) and `markets` (default)
- **Query param validation**: `closed` (boolean), `order` (allowlist: volume/liquidity/startDate/endDate/spread), `ascending` (boolean), `limit` (1-100, default 50), `tag` (sanitized slug)
- **Cloudflare handling**: Tries fetch, returns `[]` on ANY failure with 200 status
- **Caching**: `Cache-Control: public, max-age=120, s-maxage=120, stale-while-revalidate=60`
- **CORS**: Uses shared `_cors.js` helper

### Legacy Frontend Service: `src/services/polymarket.ts`
This is the most complex service module being migrated. Exports:
- `fetchPredictions()` -> `PredictionMarket[]` (main data fetch with circuit breaker)
- `fetchCountryMarkets(country)` -> `PredictionMarket[]` (country-specific market filtering)
- `getPolymarketStatus()` -> string (**DEAD CODE** -- exported but never imported anywhere)

**Internal complexity:**
- **Multi-strategy fetch** (`polyFetch`): 5 fallback strategies:
  1. Direct browser fetch to Gamma API (passes Cloudflare JA3 in browser context)
  2. Tauri native TLS (desktop app, bypasses Cloudflare)
  3. Railway relay proxy (different IP/TLS fingerprint)
  4. Vercel edge function (`/api/polymarket`)
  5. Production fallback (`https://worldmonitor.app/api/polymarket`)
- **Direct fetch probing**: One-time probe to test if direct browser fetch works, then caches result
- **Circuit breaker**: Via `createCircuitBreaker<PredictionMarket[]>({ name: 'Polymarket' })`
- **Tag-based event aggregation**: Fetches events by tag across GEOPOLITICAL_TAGS or TECH_TAGS (depends on SITE_VARIANT), deduplicates by event ID
- **Excluded keywords**: Filters out sports, entertainment, celebrity markets (NBA, NFL, Oscar, Grammy, etc.)
- **Volume threshold**: Requires eventVolume >= 1000 USD
- **Signal filtering**: Filters markets where |yesPrice - 50| > 5 OR volume > 50000
- **Fallback to top markets**: If tag queries yield < 15 results, fetches top markets directly
- **Country markets**: 40-country tag map with variant matching (e.g., "Russia" -> ["russian", "moscow", "kremlin", "putin"])
- **yesPrice scale**: Returns 0-100 (via `parseFloat(prices[0]) * 100`)

### Legacy Type: `src/types/index.ts`
```typescript
export interface PredictionMarket {
  title: string;
  yesPrice: number;     // 0-100 scale
  volume?: number;
  url?: string;
}
```

### Consumers (13 files import PredictionMarket)

**Direct polymarket.ts consumers:**

| Consumer | Import source | Fields accessed | Notes |
|---|---|---|---|
| **App.ts** | `@/services` (barrel), `@/services/polymarket` | `title`, `yesPrice`, `volume`, `url` | Calls `fetchPredictions()`, `fetchCountryMarkets()`. Also passes to search modal, snapshot save/restore, correlation analysis |
| **PredictionPanel.ts** | `@/types` | `title`, `yesPrice` (0-100), `volume`, `url` | `Math.round(p.yesPrice)` -- treats as 0-100 |
| **CountryBriefPage.ts** | `@/types` | `title`, `yesPrice` (0-100), `volume`, `url` | `Math.round(m.yesPrice)` -- treats as 0-100 |
| **CountryIntelModal.ts** | `@/types` | `title`, `yesPrice`, `url` | `(market.yesPrice * 100).toFixed(1)%` -- **BUG**: multiplies 0-100 by 100, showing 5000% |
| **correlation.ts** | `@/types` | `title`, `yesPrice`, `volume` | Passes to `analyzeCorrelationsCore` |
| **analysis-worker.ts** | `@/types` | Passes through to analysis-core | Worker bridge |
| **analysis-core.ts** | Own `PredictionMarketCore` | `title`, `yesPrice`, `volume` | Internal interface, not from `@/types` |
| **export.ts** | `@/types` | Full object for JSON/CSV export | Serializes as-is |
| **story-data.ts** | Inline type | `title`, `yesPrice` | `Array<{ title: string; yesPrice: number }>` |

**yesPrice scale inconsistency (EXISTING BUG):**
- Legacy `polymarket.ts` returns `yesPrice` in 0-100 scale (e.g., 65 means 65%)
- `PredictionPanel` and `CountryBriefPage` correctly treat it as 0-100 (`Math.round(p.yesPrice)`)
- `CountryIntelModal` incorrectly does `market.yesPrice * 100` (showing e.g., 6500% instead of 65%)
- `App.ts` search modal does `p.yesPrice * 100` (same bug)
- `App.ts` snapshot restore does `noPrice: 1 - p.yesPrice` (expecting 0-1 scale, gets 0-100)
- Proto `yes_price` is documented as "0.0 to 1.0, representing probability"

**Decision required:** The service module must decide whether to:
1. **Keep legacy 0-100 scale** in the consumer-facing type (minimizes consumer changes)
2. **Switch to proto 0-1 scale** (fixes existing bugs, matches proto definition, but requires fixing all consumers)

**Recommendation: Keep 0-100 scale** in the service module's exported type for this phase. The scale change affects many consumers and risks introducing display bugs. Fix `CountryIntelModal` and snapshot restore bugs as part of this phase since they are clearly broken regardless. A scale change can be done in a future cleanup phase.

### Gamma API Response Shape (from legacy code)

**PolymarketMarket** (from `/markets` endpoint):
```typescript
interface PolymarketMarket {
  question: string;        // Market question text
  outcomes?: string;       // JSON string e.g. '["Yes","No"]'
  outcomePrices?: string;  // JSON string e.g. '["0.65","0.35"]'
  volume?: string;         // String volume
  volumeNum?: number;      // Numeric volume
  closed?: boolean;
  slug?: string;           // Market URL slug
}
```

**PolymarketEvent** (from `/events` endpoint):
```typescript
interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  volume?: number;
  liquidity?: number;
  markets?: PolymarketMarket[];
  tags?: Array<{ slug: string }>;
  closed?: boolean;
}
```

## Handler Design

### Critical Constraint: Cloudflare JA3 Blocking

The Gamma API is behind Cloudflare's JA3 TLS fingerprint detection. Server-side environments (Vercel Edge, Node.js, Railway) are blocked. Only browser-originated requests and native Tauri TLS pass through.

**Handler strategy**: Try the fetch, return empty array on failure. This is identical to the existing `api/polymarket.js` behavior.

```typescript
// Handler pseudo-code
export const predictionHandler: PredictionServiceHandler = {
  async listPredictionMarkets(_ctx, req): Promise<ListPredictionMarketsResponse> {
    // Build Gamma API URL from request params
    // Try fetch with timeout
    // On success: parse response, map to proto PredictionMarket[], return
    // On failure: return { markets: [], pagination: undefined }
  },
};
```

### Handler Implementation Details

The handler should:
1. Determine endpoint (`events` or `markets`) based on request `category` field (if category is set, use events with tag_slug; otherwise use markets)
2. Build query params: `closed=false`, `order=volume`, `ascending=false`, `limit` from pagination pageSize
3. If category is provided, set `tag_slug` from category
4. If query is provided, filter results by title match (Gamma API doesn't have a native search param for events)
5. Fetch with 8s timeout (matching legacy)
6. Parse response, map Gamma objects to proto `PredictionMarket`
7. Map fields:
   - `id`: event.id or market.slug
   - `title`: market.question or event.title
   - `yesPrice`: `parseFloat(outcomePrices[0])` -- keep as 0-1 for proto
   - `volume`: event.volume or market.volumeNum
   - `url`: `https://polymarket.com/event/${event.slug}`
   - `closesAt`: 0 (Gamma doesn't expose end dates in the simple endpoint)
   - `category`: from tag_slug or empty string
8. Return empty on ANY failure (Cloudflare expected)

### Key Insight: Handler is a "Best Effort" Proxy

Unlike seismology (USGS always works), wildfires (NASA FIRMS works with API key), and climate (Open-Meteo always works), the Polymarket handler is expected to fail most of the time due to Cloudflare. The real data flow in production is:

```
Client browser
  -> Direct to Gamma API (works in browser, bypasses Cloudflare)
  -> Tauri native TLS (desktop app)
  -> Railway relay
  -> Sebuf handler (Vercel Edge, usually blocked by Cloudflare)
  -> Production fallback
```

The handler is the 4th fallback strategy, replacing the old `/api/polymarket` Vercel endpoint. It should behave identically: try fetch, return empty on failure.

## Service Module Design

### Architecture Decision: COMPLEX Module (unlike prior thin port/adapters)

This is the MOST COMPLEX service module in the migration series. Unlike seismology/climate (thin port/adapters that just call the client), the prediction service module must preserve:

1. **Multi-strategy fetch** with probe-and-cache pattern
2. **Tag-based event aggregation** across multiple tags
3. **Keyword exclusion filtering**
4. **Volume thresholds and signal filtering**
5. **Country-specific market matching** with variant matching
6. **Circuit breaker** wrapper
7. **SITE_VARIANT-based** tag selection

### Service Module File Structure

```
src/services/prediction/
  index.ts          # Main module: exports fetchPredictions, fetchCountryMarkets, PredictionMarket type
```

Use the directory pattern (`src/services/prediction/index.ts`) matching the wildfires/climate convention from Phase 2E-02 decision.

### What the Service Module Exports

```typescript
// Re-export consumer-friendly type (matches legacy shape)
export interface PredictionMarket {
  title: string;
  yesPrice: number;     // 0-100 scale (legacy compat)
  volume?: number;
  url?: string;
}

// Main fetch (public API)
export async function fetchPredictions(): Promise<PredictionMarket[]>;

// Country-specific markets (public API)
export async function fetchCountryMarkets(country: string): Promise<PredictionMarket[]>;
```

### Internal Architecture: Multi-Strategy `polyFetch`

The service module's internal `polyFetch` function uses the generated `PredictionServiceClient` as ONE of its strategies, replacing the old `/api/polymarket` Vercel endpoint call:

**Old strategy chain:**
1. Direct browser -> Gamma API
2. Tauri native TLS
3. Railway relay
4. `/api/polymarket` (Vercel Edge) <-- old endpoint
5. `https://worldmonitor.app/api/polymarket` (production)

**New strategy chain:**
1. Direct browser -> Gamma API
2. Tauri native TLS
3. Railway relay
4. `PredictionServiceClient.listPredictionMarkets()` <-- sebuf handler (replaces old Vercel endpoint)
5. `https://worldmonitor.app/api/polymarket` (production fallback -- keep for now, can remove later)

The sebuf handler at strategy 4 does the same thing the old Vercel endpoint did: proxies Gamma API, returns empty on failure. The client-side fetch through the generated client just hits `POST /api/prediction/v1/list-prediction-markets` instead of `GET /api/polymarket?...`.

**Key difference from prior migrations:** Prior migrations replaced the entire legacy service with a thin client call. This migration wraps the client call as ONE strategy within the existing multi-strategy architecture.

### yesPrice Scale Mapping

The handler returns `yesPrice` in 0-1 scale (proto definition). The service module has two code paths:

1. **Via generated client** (strategy 4): Client returns proto `PredictionMarket` with `yesPrice` in 0-1 scale. Service module maps to 0-100: `protoMarket.yesPrice * 100`.

2. **Via direct Gamma API** (strategy 1-3, 5): Raw Gamma response has `outcomePrices: '["0.65","0.35"]'`. Existing `parseMarketPrice()` already converts to 0-100.

Both paths output consistent 0-100 scale to consumers.

### Business Logic Preservation

All business logic from the legacy `src/services/polymarket.ts` must be preserved in the new `src/services/prediction/index.ts`:

| Logic | Location | Action |
|---|---|---|
| `GEOPOLITICAL_TAGS` / `TECH_TAGS` | polyFetch callers | Preserve as-is |
| `EXCLUDE_KEYWORDS` + `isExcluded()` | `fetchPredictions`, `fetchCountryMarkets` | Preserve as-is |
| `parseMarketPrice()` | Direct Gamma response parsing | Preserve as-is |
| `buildMarketUrl()` | Market URL construction | Preserve as-is |
| `probeDirectFetchCapability()` | Direct fetch probe | Preserve as-is |
| `polyFetch()` | Multi-strategy fetch | Modify: replace Vercel proxy call with generated client call |
| `fetchEventsByTag()` | Tag-based event fetch | Preserve, adapts to use polyFetch |
| `fetchTopMarkets()` | Fallback market fetch | Preserve, adapts to use polyFetch |
| Circuit breaker | `fetchPredictions` wrapper | Preserve as-is |
| `COUNTRY_TAG_MAP` | Country market mapping | Preserve as-is |
| `getCountryVariants()` | Country name variants | Preserve as-is |
| Volume threshold (>= 1000) | `fetchPredictions` | Preserve as-is |
| Signal filter (|yesPrice-50| > 5) | `fetchPredictions` | Preserve as-is |
| Limit to 15 results | `fetchPredictions` | Preserve as-is |
| SITE_VARIANT branching | Tag selection | Preserve as-is |

### getPolymarketStatus: Dead Code

`getPolymarketStatus()` is exported by `src/services/polymarket.ts` but never imported anywhere. It is also re-exported via `src/services/index.ts` barrel but no consumer uses it. **Drop it during migration.**

## Consumer Adaptation

### Import Path Changes

All consumers currently import `PredictionMarket` from `@/types`. After migration, they import from `@/services/prediction`:

| Consumer | Old import | New import |
|---|---|---|
| **App.ts** | `import type { PredictionMarket } from '@/types'` + `import { fetchPredictions } from '@/services'` + `import { fetchCountryMarkets } from '@/services/polymarket'` | `import type { PredictionMarket } from '@/services/prediction'` + `import { fetchPredictions, fetchCountryMarkets } from '@/services/prediction'` |
| **PredictionPanel.ts** | `import type { PredictionMarket } from '@/types'` | `import type { PredictionMarket } from '@/services/prediction'` |
| **CountryBriefPage.ts** | `import type { PredictionMarket } from '@/types'` | `import type { PredictionMarket } from '@/services/prediction'` |
| **CountryIntelModal.ts** | `import type { PredictionMarket } from '@/types'` | `import type { PredictionMarket } from '@/services/prediction'` |
| **correlation.ts** | `import type { PredictionMarket } from '@/types'` | `import type { PredictionMarket } from '@/services/prediction'` |
| **analysis-worker.ts** | `import type { PredictionMarket } from '@/types'` | `import type { PredictionMarket } from '@/services/prediction'` |
| **export.ts** | `import type { PredictionMarket } from '@/types'` | `import type { PredictionMarket } from '@/services/prediction'` |

**story-data.ts** uses an inline type `Array<{ title: string; yesPrice: number }>` -- no import change needed.

**analysis-core.ts** uses its own `PredictionMarketCore` interface -- no import change needed.

### Barrel Export Update

`src/services/index.ts` currently has `export * from './polymarket'`. This changes to `export * from './prediction'`.

### CountryIntelModal Bug Fix

Line 236 in `CountryIntelModal.ts`: `(market.yesPrice * 100).toFixed(1)%` -- since legacy yesPrice is already 0-100, this shows 6500% instead of 65%. Fix to `market.yesPrice.toFixed(1)%`.

### App.ts Search Modal Bug Fix

Line 1560 in `App.ts`: `${(p.yesPrice * 100).toFixed(0)}% probability` -- same bug. Fix to `${p.yesPrice.toFixed(0)}% probability`.

### App.ts Snapshot Restore Bug Fix

Line 1655 in `App.ts`: `noPrice: 1 - p.yesPrice` -- expects 0-1, gets 0-100. Fix to `noPrice: 100 - p.yesPrice` (or remove this field if unused).

## Gateway Integration

`api/[[...path]].ts`:
- Import `createPredictionServiceRoutes` from generated server
- Import `predictionHandler` from handler
- Add to `allRoutes` array

Handler file: `api/server/worldmonitor/prediction/v1/handler.ts`

Also rebuild sidecar bundle (`npm run build:sidecar-sebuf`).

## Cleanup

Delete:
- `api/polymarket.js` -- replaced by handler in the catch-all gateway
- `src/services/polymarket.ts` -- replaced by `src/services/prediction/index.ts`

Remove `PredictionMarket` from `src/types/index.ts` -- verify with grep that no file still imports it from `@/types` after rewiring.

Remove `export * from './polymarket'` from `src/services/index.ts` -- replaced by `export * from './prediction'`.

Keep for now:
- Production fallback URL in service module (`https://worldmonitor.app/api/polymarket`) -- this still works and provides a safety net. Can be removed in a future cleanup phase.

## Architecture Patterns

### Established Migration Pattern (from 2C/2D/2E)

Each domain migration has two plans:
1. **Plan 01: Handler + gateway wiring**
   - Implement handler at `api/server/worldmonitor/prediction/v1/handler.ts`
   - Wire into `api/[[...path]].ts` gateway
   - Rebuild sidecar bundle
2. **Plan 02: Service module + consumer rewiring + legacy deletion**
   - Create service module at `src/services/prediction/index.ts`
   - Rewire all consumers to import from service module
   - Delete legacy endpoint and legacy service
   - Update barrel exports

### Handler Pattern (Graceful Degradation)
```typescript
// api/server/worldmonitor/prediction/v1/handler.ts
import type {
  PredictionServiceHandler,
  ServerContext,
  ListPredictionMarketsRequest,
  ListPredictionMarketsResponse,
  PredictionMarket,
} from '../../../../../src/generated/server/worldmonitor/prediction/v1/service_server';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

export const predictionHandler: PredictionServiceHandler = {
  async listPredictionMarkets(
    _ctx: ServerContext,
    req: ListPredictionMarketsRequest,
  ): Promise<ListPredictionMarketsResponse> {
    // Build Gamma API params
    // Try fetch with timeout
    // Map response to proto PredictionMarket[]
    // Return empty on ANY failure (Cloudflare expected)
    return { markets: [], pagination: undefined };
  },
};
```

### Service Module Pattern (Complex with Multi-Strategy Fetch)
```typescript
// src/services/prediction/index.ts
import {
  PredictionServiceClient,
  type PredictionMarket as ProtoPredictionMarket,
} from '@/generated/client/worldmonitor/prediction/v1/service_client';

// Consumer-friendly type (legacy shape, 0-100 scale)
export interface PredictionMarket {
  title: string;
  yesPrice: number;  // 0-100
  volume?: number;
  url?: string;
}

const client = new PredictionServiceClient('');

// Strategy 4: via sebuf handler
async function fetchViaSebuf(): Promise<ProtoPredictionMarket[]> {
  const resp = await client.listPredictionMarkets({ category: '', query: '' });
  return resp.markets;
}

// Full multi-strategy polyFetch preserved with fetchViaSebuf replacing old /api/polymarket call
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Proto type generation | Manual TS interfaces | Generated `service_server.ts` and `service_client.ts` | Already generated, type-safe |
| HTTP routing | Express/custom router | `createPredictionServiceRoutes` from generated server | Consistent with other domains |
| Error handling | Custom error responses | `mapErrorToResponse` via `serverOptions.onError` | Gateway-wide error handling |
| Circuit breaker | Custom retry logic | Existing `createCircuitBreaker` from `@/utils` | Already used by legacy service |
| TLS fingerprint bypass | Custom Cloudflare bypass | Multi-strategy fallback chain | JA3 detection cannot be bypassed server-side |

**Key insight:** The Cloudflare JA3 blocking is not something to solve at the handler level. It's an infrastructure-level constraint that the multi-strategy client-side fetch handles correctly. The handler is a thin proxy that sometimes works and sometimes doesn't.

## Common Pitfalls

### Pitfall 1: yesPrice Scale Mismatch
**What goes wrong:** Proto defines `yes_price` as 0-1 (probability). Legacy consumers expect 0-100 (percentage). Mixing scales causes markets to show "0.65%" instead of "65%", or "6500%" instead of "65%".
**Why it happens:** Proto and legacy use different conventions for the same conceptual field.
**How to avoid:** Service module ALWAYS outputs 0-100 scale to consumers. When data comes through the generated client (0-1 scale), multiply by 100. When data comes from direct Gamma fetch, existing `parseMarketPrice()` already outputs 0-100.
**Warning signs:** Markets showing tiny percentages (< 1%) or impossibly large percentages (> 100%).

### Pitfall 2: Handler Expected to Fail
**What goes wrong:** Treating handler errors as bugs when they're expected behavior (Cloudflare blocks server-side TLS).
**Why it happens:** Prior handlers (seismology, wildfire, climate) always succeed from Vercel Edge. Polymarket is different.
**How to avoid:** Handler returns `{ markets: [], pagination: undefined }` on ANY error with no error logging noise. Service module treats empty handler response as "try next strategy" not "API is down".
**Warning signs:** Excessive error logging in production, false alerts about API being down.

### Pitfall 3: Multi-Strategy Fetch Order Matters
**What goes wrong:** Reordering fetch strategies or removing fallbacks breaks production data flow.
**Why it happens:** Direct browser fetch is the primary path (works in browser, fast). Tauri is desktop-only. Railway is a backup. Handler is another backup. Production is last resort.
**How to avoid:** Preserve exact strategy order. The `directFetchWorks` probe-and-cache pattern prevents repeated failures.
**Warning signs:** Data loading extremely slowly (hitting multiple failed strategies before finding one that works).

### Pitfall 4: Tag Fanout Race Conditions
**What goes wrong:** `fetchPredictions()` fans out 8-11 tag queries in parallel via `Promise.all(tags.map(tag => fetchEventsByTag(tag, 20)))`. If the probe hasn't completed, each tag query could independently probe and fail.
**Why it happens:** The direct fetch probe is meant to run once before the fanout.
**How to avoid:** The existing code probes once in `polyFetch` before the tag fanout (`directFetchWorks === null && await probeDirectFetchCapability()`). Preserve this pattern.
**Warning signs:** Burst of "Direct fetch blocked" log messages instead of a single one.

### Pitfall 5: Forgetting to Rebuild Sidecar
**What goes wrong:** Tauri desktop app doesn't see the new prediction handler because sidecar bundle is stale.
**Why it happens:** Gateway update requires rebuilding `api/[[...path]].js` via `build-sidecar-sebuf.mjs`.
**How to avoid:** Run `npm run build:sidecar-sebuf` after modifying `api/[[...path]].ts`.
**Warning signs:** Desktop app works for other domains but prediction handler returns 404.

### Pitfall 6: CountryIntelModal Already Buggy
**What goes wrong:** Fixing the `yesPrice * 100` bug in CountryIntelModal while also changing the scale would double-fix it (0-1 * 100 = correct, but if service module outputs 0-100 AND you fix the * 100, it becomes just yesPrice which is 0-100 = correct).
**Why it happens:** The bug exists in current production code.
**How to avoid:** Fix CountryIntelModal and App.ts search modal to NOT multiply by 100 (since service module keeps 0-100 scale). Verify each consumer's expected scale before and after.
**Warning signs:** Any percentage display outside the 0-100 range.

## Key Differences from Prior Migrations

| Aspect | Seismology (2C) | Wildfires (2D) | Climate (2E) | **Prediction (2F)** |
|--------|----------------|----------------|--------------|---------------------|
| API authentication | None | NASA API key | None | None (but Cloudflare blocks) |
| Handler reliability | Always works | Works with key | Always works | **Usually fails** (Cloudflare) |
| Business logic in handler | Simple JSON map | CSV parse + map | Baseline comparison | **Thin proxy, returns empty** |
| Service module complexity | Thin port/adapter | Some business logic | Thin port/adapter | **COMPLEX: multi-strategy, aggregation, filtering** |
| Shape mismatch | lat/lon -> location | lat/lon -> location | lat/lon -> location + enums | **Scale: 0-100 vs 0-1** |
| Proto vs legacy richness | Proto matches legacy | Proto richer | Proto matches legacy | **Proto RICHER than legacy** |
| Consumer count | 7 files | 5 files | 6 files | **9 files** |
| Proto changes needed | INT64 annotation | Added fields | None | **None** |
| Existing bugs found | None | None | None | **yesPrice scale bugs in 3 places** |

## Open Questions

1. **Production fallback URL retention**
   - What we know: The legacy service has `https://worldmonitor.app/api/polymarket` as final fallback. After migration, `api/polymarket.js` is deleted but the production URL still resolves to it until next deployment.
   - What's unclear: Should we keep the production fallback in the new service module? If production deploys, the old endpoint disappears.
   - Recommendation: Keep the production fallback pointing to the NEW sebuf endpoint URL (`https://worldmonitor.app/api/prediction/v1/list-prediction-markets`) instead of the old one. Or remove production fallback entirely since it's unlikely to help (same Cloudflare block). The 4 strategies before it (direct, Tauri, Railway, sebuf handler) cover all cases. **Decision for planner.**

2. **`noPrice` field in snapshot restore**
   - What we know: App.ts line 1655 computes `noPrice: 1 - p.yesPrice`. This field is not in the `PredictionMarket` interface.
   - What's unclear: Where does `noPrice` come from? It's assigned to the prediction object but `PredictionMarket` type doesn't have `noPrice`, `volume24h`, or `liquidity`. The object is typed as `PredictionMarket` via `this.latestPredictions = predictions`.
   - Recommendation: Investigate if TypeScript allows these extra fields (likely yes since `predictions` is an inferred type). These extra fields may be dead code. Fix the `1 - p.yesPrice` to `100 - p.yesPrice` for correctness regardless.

3. **Gamma API `endDate`/`closesAt` field**
   - What we know: Proto has `closes_at` (int64 millis). Gamma API events may have `endDate` or similar field, but the legacy code doesn't extract it.
   - What's unclear: Does the Gamma API actually return close/end dates in the events endpoint?
   - Recommendation: Set `closesAt: 0` in handler (proto says "Zero if no expiry"). If Gamma API does return end dates, it can be added later.

## Sources

### Primary (HIGH confidence)
- `proto/worldmonitor/prediction/v1/service.proto` -- Service definition with HTTP annotations
- `proto/worldmonitor/prediction/v1/prediction_market.proto` -- PredictionMarket message (7 fields)
- `proto/worldmonitor/prediction/v1/list_prediction_markets.proto` -- Request/Response messages
- `src/generated/server/worldmonitor/prediction/v1/service_server.ts` -- Generated handler interface
- `src/generated/client/worldmonitor/prediction/v1/service_client.ts` -- Generated client class
- `api/polymarket.js` -- Legacy Vercel Edge endpoint (complete source examined)
- `src/services/polymarket.ts` -- Legacy frontend service (complete source, 448 lines examined)
- `src/types/index.ts:611-616` -- Legacy PredictionMarket type definition
- `api/[[...path]].ts` -- Catch-all gateway (needs prediction handler mounted)
- `api/server/worldmonitor/climate/v1/handler.ts` -- Reference handler implementation
- `api/server/worldmonitor/seismology/v1/handler.ts` -- Reference handler implementation
- `src/services/climate/index.ts` -- Reference service module (port/adapter)
- `src/services/wildfires/index.ts` -- Reference service module (port/adapter)
- All 9 consumer files examined for field access patterns and import paths
- `.planning/phases/2E-climate-migration/2E-RESEARCH.md` -- Prior phase research

### Secondary (MEDIUM confidence)
- [Polymarket Gamma API documentation](https://docs.polymarket.com/developers/gamma-markets-api/overview) -- API structure overview (field-level detail not available in docs)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries/patterns already established in 2C/2D/2E, no new dependencies
- Architecture: HIGH -- handler pattern established, service module complexity fully understood from reading complete 448-line legacy source
- Pitfalls: HIGH -- all consumer field access patterns verified by reading source code, yesPrice scale inconsistency documented with exact line numbers, Cloudflare constraint well-understood from legacy code comments and multi-strategy design

**Research date:** 2026-02-18
**Valid until:** 2026-03-18 (stable domain, no external library changes expected)
