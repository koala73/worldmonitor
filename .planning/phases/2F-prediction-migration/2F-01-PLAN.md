---
phase: 2F-prediction-migration
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - api/server/worldmonitor/prediction/v1/handler.ts
  - api/[[...path]].ts
autonomous: true
requirements: [DOMAIN-02, SERVER-02]

must_haves:
  truths:
    - "POST /api/prediction/v1/list-prediction-markets returns a valid JSON response with markets array"
    - "Handler gracefully returns empty markets array on Gamma API failure (Cloudflare block expected)"
    - "Handler maps Gamma API events/markets to proto PredictionMarket shape with yesPrice in 0-1 scale"
    - "Sidecar bundle compiles without errors"
  artifacts:
    - path: "api/server/worldmonitor/prediction/v1/handler.ts"
      provides: "PredictionServiceHandler proxying Gamma API with graceful degradation"
      exports: ["predictionHandler"]
    - path: "api/[[...path]].ts"
      provides: "Gateway with prediction routes mounted"
      contains: "createPredictionServiceRoutes"
  key_links:
    - from: "api/server/worldmonitor/prediction/v1/handler.ts"
      to: "src/generated/server/worldmonitor/prediction/v1/service_server.ts"
      via: "implements PredictionServiceHandler interface"
      pattern: "PredictionServiceHandler"
    - from: "api/[[...path]].ts"
      to: "api/server/worldmonitor/prediction/v1/handler.ts"
      via: "imports predictionHandler and mounts routes"
      pattern: "createPredictionServiceRoutes.*predictionHandler"
---

<objective>
Implement the PredictionServiceHandler that proxies the Gamma API for Polymarket prediction markets, and wire it into the catch-all gateway.

Purpose: Provide the sebuf server-side endpoint for prediction markets. Unlike prior handlers (seismology, wildfire, climate) which reliably reach their upstream APIs, this handler is a "best effort" proxy because Gamma API uses Cloudflare JA3 fingerprint detection that blocks server-side TLS connections. The handler tries the fetch and gracefully returns empty on failure -- identical to the existing `api/polymarket.js` behavior.

Output: Working prediction handler at `api/server/worldmonitor/prediction/v1/handler.ts`, gateway updated, sidecar rebuilt.
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

# Reference: existing handler pattern
@api/server/worldmonitor/climate/v1/handler.ts
@api/server/worldmonitor/seismology/v1/handler.ts

# Generated server interface (handler must implement this)
@src/generated/server/worldmonitor/prediction/v1/service_server.ts

# Legacy endpoint being replaced (reference for Gamma API params and Cloudflare handling)
@api/polymarket.js

# Gateway to wire into
@api/[[...path]].ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement prediction handler with Gamma API proxy and graceful degradation</name>
  <files>api/server/worldmonitor/prediction/v1/handler.ts</files>
  <action>
Create `api/server/worldmonitor/prediction/v1/handler.ts` that implements the generated `PredictionServiceHandler` interface.

Import types from the generated server file:
```typescript
import type {
  PredictionServiceHandler,
  ServerContext,
  ListPredictionMarketsRequest,
  ListPredictionMarketsResponse,
  PredictionMarket,
} from '../../../../../src/generated/server/worldmonitor/prediction/v1/service_server';
```

Constants:
- `GAMMA_BASE = 'https://gamma-api.polymarket.com'`
- `FETCH_TIMEOUT = 8000` (8 seconds, matching legacy)

Handler logic for `listPredictionMarkets(_ctx, req)`:

1. **Determine endpoint**: If `req.category` is non-empty, use `events` endpoint with `tag_slug` param. Otherwise use `markets` endpoint.

2. **Build query params**:
   - `closed=false`
   - `order=volume`
   - `ascending=false`
   - `limit` from `req.pagination?.pageSize` or default 50 (clamp 1-100)
   - If events endpoint: `tag_slug` from `req.category`

3. **Fetch with timeout**: Use AbortController with 8s timeout. Set `Accept: application/json` header.

4. **Parse response**:
   - For `events` endpoint: response is `PolymarketEvent[]`. For each event, extract top market by volume. Map to proto `PredictionMarket`:
     - `id`: `event.id` or `''`
     - `title`: top market's `question` or `event.title`
     - `yesPrice`: parse `outcomePrices` JSON string, take first float value (0-1 scale). Default 0.5 if unparseable.
     - `volume`: `event.volume` or 0
     - `url`: `https://polymarket.com/event/${event.slug}`
     - `closesAt`: 0 (Gamma doesn't expose end dates in simple endpoint)
     - `category`: `req.category` or `''`
   - For `markets` endpoint: response is `PolymarketMarket[]`. Map each:
     - `id`: `market.slug` or `''`
     - `title`: `market.question`
     - `yesPrice`: parse `outcomePrices` same as above (0-1 scale)
     - `volume`: `market.volumeNum` or parse `market.volume` string, or 0
     - `url`: `https://polymarket.com/market/${market.slug}`
     - `closesAt`: 0
     - `category`: `''`
   - If `req.query` is non-empty, filter results by case-insensitive title match.

5. **Graceful degradation**: Wrap entire fetch/parse in try/catch. On ANY failure (Cloudflare expected), return `{ markets: [], pagination: undefined }` with no error logging noise. This is expected behavior, not an error.

6. Return `{ markets, pagination: undefined }`.

Define internal interfaces `GammaMarket` and `GammaEvent` locally in the handler file (do NOT import from polymarket.ts):
```typescript
interface GammaMarket {
  question: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  volumeNum?: number;
  closed?: boolean;
  slug?: string;
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  volume?: number;
  markets?: GammaMarket[];
  closed?: boolean;
}
```

Add a local `parseYesPrice(market: GammaMarket): number` helper that returns 0-1 scale (NOT 0-100):
```typescript
function parseYesPrice(market: GammaMarket): number {
  try {
    const pricesStr = market.outcomePrices;
    if (pricesStr) {
      const prices: string[] = JSON.parse(pricesStr);
      if (prices.length >= 1) {
        const parsed = parseFloat(prices[0]!);
        if (!isNaN(parsed)) return parsed; // 0-1 scale for proto
      }
    }
  } catch { /* keep default */ }
  return 0.5;
}
```

NOTE: The proto `yesPrice` is defined as 0.0-1.0 (probability). The legacy handler returns raw JSON from Gamma API which consumers then parse with `* 100`. This handler maps to proto scale (0-1). The service module (Plan 02) will handle the 0-1 -> 0-100 conversion for consumer compatibility.

Export: `export const predictionHandler: PredictionServiceHandler = { ... };`

Verify: `npx tsc -p tsconfig.api.json --noEmit` passes.
  </action>
  <verify>npx tsc -p tsconfig.api.json --noEmit</verify>
  <done>Handler file exists at api/server/worldmonitor/prediction/v1/handler.ts, implements PredictionServiceHandler, proxies Gamma API with 8s timeout, maps to proto PredictionMarket shape with 0-1 yesPrice scale, returns empty markets array on any failure. Type check passes.</done>
</task>

<task type="auto">
  <name>Task 2: Wire prediction routes into gateway and rebuild sidecar bundle</name>
  <files>api/[[...path]].ts</files>
  <action>
Update `api/[[...path]].ts` to mount prediction routes:

1. Add imports after the existing climate imports:
```typescript
import { createPredictionServiceRoutes } from '../src/generated/server/worldmonitor/prediction/v1/service_server';
import { predictionHandler } from './server/worldmonitor/prediction/v1/handler';
```

2. Add to `allRoutes` array:
```typescript
...createPredictionServiceRoutes(predictionHandler, serverOptions),
```

3. Rebuild sidecar bundle:
```bash
npm run build:sidecar-sebuf
```

4. Verify the full type check:
```bash
npx tsc -p tsconfig.api.json --noEmit
```
  </action>
  <verify>npx tsc -p tsconfig.api.json --noEmit && npm run build:sidecar-sebuf</verify>
  <done>Gateway imports prediction handler and mounts routes. Sidecar bundle compiles successfully. POST /api/prediction/v1/list-prediction-markets is routable through the catch-all gateway.</done>
</task>

</tasks>

<verification>
1. `npx tsc -p tsconfig.api.json --noEmit` passes (handler + gateway type-safe)
2. `npm run build:sidecar-sebuf` succeeds (sidecar bundle includes prediction routes)
3. Handler file exists at `api/server/worldmonitor/prediction/v1/handler.ts`
4. Gateway `api/[[...path]].ts` includes `createPredictionServiceRoutes`
</verification>

<success_criteria>
- Prediction handler implements PredictionServiceHandler interface
- Handler proxies Gamma API with 8s timeout, maps events/markets to proto shape
- Handler returns empty markets array on ANY failure (Cloudflare graceful degradation)
- yesPrice is in 0-1 proto scale (NOT 0-100 legacy scale)
- Gateway mounts prediction routes alongside seismology, wildfire, climate
- Sidecar bundle compiles with prediction routes included
- All type checks pass
</success_criteria>

<output>
After completion, create `.planning/phases/2F-prediction-migration/2F-01-SUMMARY.md`
</output>
