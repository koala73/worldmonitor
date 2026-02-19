# Phase 3: Legacy Edge Function Migration - Research

**Researched:** 2026-02-20
**Domain:** Sebuf RPC consolidation of remaining Vercel edge functions
**Confidence:** HIGH

## Summary

Phase 3 migrates the remaining `api/*.js` Vercel edge functions into sebuf domain RPC handlers, then tags non-migratable files and cleans up shared utilities. This is a mechanical consolidation: every legacy endpoint already has a target domain handler, and 17 prior migrations have established a rock-solid pattern. The work involves (1) adding new RPCs to existing domain protos, (2) implementing handler methods in existing handler.ts files, (3) rewiring client-side consumers from `fetch('/api/...')` to sebuf client calls, and (4) deleting the legacy `.js` files.

The hardest part is proto message design for three endpoints that have complex response shapes: macro-signals (7 nested signal objects with sparklines), tech-events (ICS+RSS parsing, 500-city geocoding, curated events), and temporal-baseline (Welford's algorithm with Redis-backed baselines). The summarization migration requires a design decision on RPC structure. The wingbits migration (step 3) is already 90% done -- the handler exists with all 3 RPCs implemented, the client (`src/services/wingbits.ts`) is already wired to the sebuf client, and the legacy files are git-deleted but need the deletion committed.

**Primary recommendation:** Follow the established mechanical pattern from prior migrations. For each step: add proto RPC(s) -> regenerate -> implement handler method -> rewire client service -> delete legacy file. Proto message design for the three complex endpoints should closely mirror their existing JSON response shapes to avoid behavior changes.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Summarization consolidation: Claude decides RPC structure (single RPC with provider param vs multiple RPCs). Fallback chain stays client-side. Browser T5 stays client-only. No behavior changes to Ollama base URL handling.
- Non-JSON endpoint handling: Leave as-is in `api/` root. Add header comment `// Non-sebuf: returns XML/HTML, stays as standalone Vercel function`. Files: `rss-proxy.js`, `fwdstart.js`, `story.js`, `og-story.js`, `download.js`, `version.js`.
- Shared utility teardown: `_ip-rate-limit.js` delete immediately. `_cors.js` keep forever. `_upstash-cache.js` delete after temporal-baseline migration.
- No behavior changes anywhere -- purely consolidating existing logic into sebuf RPCs.

### Claude's Discretion
- Summarization RPC structure (single vs multiple RPCs)
- Proto message design for macro-signals, tech-events, temporal-baseline
- Migration order within the remaining steps

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CLEAN-02 | Legacy api/*.js Vercel edge functions removed after catch-all handler covers their functionality | Each migration step deletes the legacy .js file(s) after the sebuf handler covers the functionality. Already partially satisfied (17 domains migrated). This phase completes it for the remaining 6 migratable endpoints. |
| DOMAIN-03 | Cyber domain proto with service RPCs and HTTP annotations | Cyber domain handler already exists and is complete. No action needed in Phase 3 -- this requirement was already satisfied in Phase 2M-2S. |
| DOMAIN-04 | Economic domain proto (FRED, World Bank, EIA) with service RPCs | Economic handler exists with 3 RPCs. Phase 3 adds a 4th RPC (GetMacroSignals) to this domain for the macro-signals endpoint. Proto enhancement + handler implementation needed. |
| DOMAIN-09 | News domain proto (RSS feed aggregation, summarization) | News handler exists with 2 RPCs (ListNewsItems stub, SummarizeHeadlines stub). Phase 3 replaces the SummarizeHeadlines stub with a real implementation covering Ollama/Groq/OpenRouter providers. The RPC structure (single vs. multiple) is at Claude's discretion. |
| DOMAIN-10 | Proto messages match existing TypeScript interfaces in src/types/index.ts | New proto messages for macro-signals, tech-events, and temporal-baseline must mirror the existing JSON response shapes from the legacy endpoints. Verified by comparing legacy response structures with proto designs. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| sebuf (buf + protoc-gen-ts-*) | project toolchain | Proto codegen for TypeScript client/server | Already configured -- `cd proto && buf generate` |
| Upstash Redis REST | inline fetch | Server-side caching in edge handlers | Established pattern in all handlers needing cache |
| fast-xml-parser | already in project | ICS/RSS/XML parsing in edge runtime | Used in research handler (arXiv), needed for tech-events ICS |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None new | - | - | No new dependencies needed -- all libraries already in project |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Inline Upstash fetch | @upstash/redis SDK | SDK can't be used in edge runtime handlers (dynamic import). Inline fetch is the established pattern. |
| Single SummarizeArticle RPC | Per-provider RPCs (SummarizeWithGroq, etc.) | Per-provider would require 3 RPCs; single RPC with provider param is cleaner and matches the shared handler factory pattern. Recommend single RPC. |

## Architecture Patterns

### Recommended Project Structure
```
proto/worldmonitor/{domain}/v1/
  service.proto              # Add new RPC definitions
  {new_rpc_name}.proto       # New request/response messages
api/server/worldmonitor/{domain}/v1/
  handler.ts                 # Add new RPC handler methods
src/services/
  {service-module}.ts        # Rewire from fetch('/api/...') to sebuf client
api/
  {legacy-file}.js           # DELETE after migration
```

### Pattern 1: Handler RPC Implementation (established in all 17 domains)
**What:** Each handler exports an object implementing the generated `XxxServiceHandler` interface. Each RPC method receives `(ctx: ServerContext, req: XxxRequest): Promise<XxxResponse>`.
**When to use:** Every new RPC in this phase.
**Example:**
```typescript
// Source: api/server/worldmonitor/economic/v1/handler.ts (existing)
declare const process: { env: Record<string, string | undefined> };

import type {
  EconomicServiceHandler,
  ServerContext,
  GetMacroSignalsRequest,
  GetMacroSignalsResponse,
} from '../../../../../src/generated/server/worldmonitor/economic/v1/service_server';

export const economicHandler: EconomicServiceHandler = {
  // ... existing RPCs ...
  async getMacroSignals(
    _ctx: ServerContext,
    _req: GetMacroSignalsRequest,
  ): Promise<GetMacroSignalsResponse> {
    // Port logic from api/macro-signals.js
  },
};
```

### Pattern 2: Client Service Rewiring (established in all migrated services)
**What:** Client-side service module switches from `fetch('/api/...')` to using the generated sebuf client.
**When to use:** Every client consumer in this phase.
**Example:**
```typescript
// Source: src/services/wingbits.ts (already migrated)
import { MilitaryServiceClient } from '@/generated/client/worldmonitor/military/v1/service_client';
const client = new MilitaryServiceClient('', { fetch: fetch.bind(globalThis) });

// Instead of: fetch('/api/wingbits/details/' + icao24)
// Now: client.getAircraftDetails({ icao24 })
```

### Pattern 3: Upstash Redis Inline Helpers (when handler needs caching)
**What:** Two functions `getCachedJson(key)` and `setCachedJson(key, value, ttl)` using raw fetch to Upstash REST API.
**When to use:** Handlers that need server-side caching (summarization, macro-signals, temporal-baseline).
**Example:**
```typescript
// Source: api/server/worldmonitor/intelligence/v1/handler.ts (existing)
async function getCachedJson(key: string): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result?: string };
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}
```

### Anti-Patterns to Avoid
- **Importing `_upstash-cache.js` from handlers:** Never import the legacy shared module. Always use inline Upstash helpers (the handlers are TypeScript, the shared module is JS with dynamic `@upstash/redis` import).
- **Importing `_cors.js` from handlers:** CORS is handled by the catch-all gateway (`api/[[...path]].ts`). Handlers never touch CORS.
- **Changing behavior during migration:** Every migrated RPC must produce identical JSON structure to the legacy endpoint it replaces. No "improvements" -- this phase is purely mechanical.
- **Using `@upstash/redis` SDK in handlers:** The SDK uses dynamic import which fails in some edge environments. Inline REST fetch is the established pattern.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Redis caching in handlers | Custom Redis abstraction | Inline `getCachedJson`/`setCachedJson` fetch helpers | Identical pattern in 5 existing handlers -- copy and paste |
| CORS handling | Per-handler CORS | Gateway CORS in `api/[[...path]].ts` | Already handled by the catch-all |
| Proto codegen | Manual TypeScript types | `cd proto && buf generate` | Generates client + server + OpenAPI from .proto files |
| City geocoding (tech-events) | External geocoding API | Embedded `CITY_COORDS` static lookup table | Already 500+ cities in the legacy file, works offline |

**Key insight:** Every pattern needed for this phase is already established in the codebase. The only "new" work is proto message design for three complex endpoints.

## Common Pitfalls

### Pitfall 1: Proto Time Fields Must Use int64 with INT64_ENCODING_NUMBER
**What goes wrong:** Time fields defined as `google.protobuf.Timestamp` or `int64` without the encoding annotation get serialized as strings in TypeScript.
**Why it happens:** Default protobuf int64 encoding in JS is string-based.
**How to avoid:** Every time field must use `int64` with `[(sebuf.ts.field_encoding) = INT64_ENCODING_NUMBER]` annotation, per project convention.
**Warning signs:** Client code receives `string` where `number` was expected for timestamps.

### Pitfall 2: Inline Upstash Helpers Must Be Duplicated Per Handler
**What goes wrong:** Trying to share inline Upstash helpers across handlers via import creates a shared state module that complicates bundling.
**Why it happens:** Each handler file is independently compiled for edge deployment; shared TypeScript modules in `api/server/` are fine, but the Upstash helpers are trivial enough to inline.
**How to avoid:** Copy the `getCachedJson`/`setCachedJson` helper pattern into each handler that needs caching. The intelligence, military, and news handlers already do this.
**Warning signs:** Import errors during Vercel deployment.

### Pitfall 3: Summarization Needs Upstash mget for Cache
**What goes wrong:** The legacy `_summarize-handler.js` uses `getCachedJson` and `setCachedJson` from `_upstash-cache.js` which wraps `@upstash/redis`. The sebuf handler must replicate this using inline REST fetch, not the SDK.
**Why it happens:** The SDK import chain (`@upstash/redis`) behaves differently in handler TypeScript vs. legacy JS.
**How to avoid:** Use the inline Upstash REST helpers (established in 5 handlers). For `hashString`, port the hash function from `_upstash-cache.js` into the handler.
**Warning signs:** Cache misses where legacy had hits, or import failures.

### Pitfall 4: Temporal Baseline Needs Redis mget
**What goes wrong:** `temporal-baseline.js` uses `mget` from `_upstash-cache.js` for batch key reads. The inline Upstash helpers in existing handlers only have `get`/`set`.
**Why it happens:** Temporal baseline does batch reads of multiple baseline keys in a single POST update.
**How to avoid:** Add an inline `mgetJson` helper using the Upstash REST `mget` endpoint: `POST ${url}` with body `["MGET", key1, key2, ...]`.
**Warning signs:** Temporal baseline POST handler returning wrong/missing baseline data.

### Pitfall 5: Tech Events File is 35KB with 500-City Lookup
**What goes wrong:** Naively copying the entire `CITY_COORDS` object into the proto message bloats the proto definition.
**Why it happens:** The city geocoding is a static lookup table, not API data.
**How to avoid:** Keep `CITY_COORDS` as a TypeScript constant inside the handler (like `MILITARY_HEX_LIST` is imported in the military handler). The proto only carries the resolved coordinates in the response, not the lookup table.
**Warning signs:** Unnecessarily large proto file or slow code generation.

### Pitfall 6: Summarization Client Must Continue Sending to Individual Provider Endpoints
**What goes wrong:** If summarization is consolidated into a single RPC, the client fallback chain (Ollama -> Groq -> OpenRouter -> Browser T5) breaks because the chain relies on knowing which provider failed to try the next one.
**Why it happens:** The client needs per-provider error handling to implement the fallback chain.
**How to avoid:** Recommend a single `SummarizeArticle` RPC with a `provider` field in the request. The handler selects which upstream to call based on the provider field. The client calls the same RPC 3 times with different provider values, preserving the same fallback chain logic. Alternatively, keep 3 separate RPCs (one per provider).
**Warning signs:** All summarization attempts fail because a single RPC tried only one provider without fallback.

## Code Examples

Verified patterns from the existing codebase:

### New Proto RPC Definition
```protobuf
// Source: proto/worldmonitor/economic/v1/service.proto (add to existing)
import "worldmonitor/economic/v1/get_macro_signals.proto";

// In service EconomicService block:
rpc GetMacroSignals(GetMacroSignalsRequest) returns (GetMacroSignalsResponse) {
  option (sebuf.http.config) = {path: "/get-macro-signals"};
}
```

### New Proto Message File
```protobuf
// Source: proto/worldmonitor/economic/v1/get_macro_signals.proto (new file)
syntax = "proto3";
package worldmonitor.economic.v1;

import "sebuf/ts/options.proto";

message GetMacroSignalsRequest {}

message GetMacroSignalsResponse {
  int64 timestamp = 1 [(sebuf.ts.field_encoding) = INT64_ENCODING_NUMBER];
  string verdict = 2;
  int32 bullish_count = 3;
  int32 total_count = 4;
  MacroSignals signals = 5;
  MacroMeta meta = 6;
  bool unavailable = 7;
}
// ... nested message types matching JSON response shape
```

### Client Constructor Pattern
```typescript
// Source: src/services/wingbits.ts (established pattern)
import { MilitaryServiceClient } from '@/generated/client/worldmonitor/military/v1/service_client';
const client = new MilitaryServiceClient('', { fetch: fetch.bind(globalThis) });
```

### Handler Registration (already done -- no changes needed)
```typescript
// Source: api/[[...path]].ts (all 17 services already registered)
// No changes needed -- handler objects are imported and route tables created
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Standalone `api/*.js` edge functions | Sebuf RPC handlers in `api/server/` | Phase 2B (2026-02-18) | All new RPCs go in handler.ts files, not standalone .js files |
| `_cors.js` in every handler | Gateway CORS in `api/[[...path]].ts` | Phase 2B (2026-02-18) | Handlers never touch CORS headers |
| `_upstash-cache.js` shared module | Inline Upstash REST helpers per handler | Phase 2B (2026-02-18) | No shared state, each handler self-contained |
| `fetch('/api/xxx')` from client | Generated sebuf client RPC calls | Phase 2C (2026-02-18) | Type-safe client calls with generated types |

**Deprecated/outdated:**
- `_ip-rate-limit.js`: Zero importers, dead code. Delete immediately.
- `_upstash-cache.js`: Only 2 importers remain (`_summarize-handler.js`, `temporal-baseline.js`). Delete after both are migrated.
- `api/wingbits/` directory: Already git-deleted, handler + client wiring complete. Just needs the deletion committed.

## Detailed Migration Analysis

### Step 3: Wingbits (ALREADY DONE)
**Legacy files:** `api/wingbits/[[...path]].js`, `api/wingbits/details/[icao24].js`, `api/wingbits/details/batch.js` (all 3 already git-deleted)
**Target:** military domain (3 RPCs: GetAircraftDetails, GetAircraftDetailsBatch, GetWingbitsStatus)
**Status:** Proto defined, handler implemented, client wired. Files deleted in working tree. Just needs commit.
**Effort:** TRIVIAL -- verify and commit the deletion.

### Step 4: GDELT Doc Search
**Legacy file:** `api/gdelt-doc.js` (68 lines)
**Target:** intelligence domain -- new RPC `SearchGdeltDocuments`
**Consumer:** `src/services/gdelt-intel.ts` -- calls `/api/gdelt-doc?query=...&maxrecords=...&timespan=...`
**Logic:** Simple proxy to `https://api.gdeltproject.org/api/v2/doc/doc` with query params, maps response to article objects.
**Proto needed:** New `search_gdelt_documents.proto` with SearchGdeltDocumentsRequest (query, max_records, timespan) and SearchGdeltDocumentsResponse (articles array).
**Effort:** LOW -- simple proxy, no caching, no auth, straightforward mapping.

### Step 5: Summarization (3 provider files + shared handler)
**Legacy files:** `api/groq-summarize.js`, `api/ollama-summarize.js`, `api/openrouter-summarize.js`, `api/_summarize-handler.js` (4 files, ~330 lines total)
**Target:** news domain -- enhance existing `SummarizeHeadlines` RPC or add new `SummarizeArticle` RPC
**Consumer:** `src/services/summarization.ts` -- calls `/api/{provider}-summarize` with POST body `{headlines, mode, geoContext, variant, lang}`
**Logic:** Shared handler factory with provider-specific credentials. Redis caching via `_upstash-cache.js`. Headline deduplication, prompt building with 4 modes (brief, analysis, translate, default), think-token stripping.
**Design decision (Claude's discretion):** RECOMMEND a single `SummarizeArticle` RPC with a `provider` field. The handler selects provider credentials based on the field value. Client calls the same RPC 3 times with `provider: 'ollama'`, then `provider: 'groq'`, then `provider: 'openrouter'`. This preserves the exact fallback chain behavior. The existing `SummarizeHeadlines` RPC has wrong message shape (just `max_headlines` and `topic`) -- either redesign it or add a new RPC.
**Proto needed:** New or enhanced proto with request fields: `provider`, `headlines[]`, `mode`, `geo_context`, `variant`, `lang`. Response: `summary`, `model`, `provider`, `cached`, `tokens`, `fallback`, `skipped`, `reason`.
**Effort:** MEDIUM -- complex prompt logic, Redis caching, multiple modes. But all logic is a direct port.

### Step 6: Macro Signals (HIGH effort)
**Legacy file:** `api/macro-signals.js` (284 lines)
**Target:** economic domain -- new RPC `GetMacroSignals`
**Consumer:** `src/components/MacroSignalsPanel.ts` -- calls `/api/macro-signals`
**Logic:** Parallel fetches from 6 upstream APIs (Yahoo Finance x4, Fear&Greed, Mempool hashrate). Computes 7 signals (liquidity, flow structure, macro regime, technical trend, hash rate, mining cost, fear&greed) with sparklines. In-memory cache (5min TTL). Overall BUY/CASH verdict.
**Proto needed:** Complex nested messages: `GetMacroSignalsResponse` with `signals` object containing 7 sub-messages, each with status enum, numeric values, sparkline arrays.
**Effort:** HIGH -- complex response shape with many nested objects and sparkline arrays. But the logic is a direct port with no changes.

### Step 7: Tech Events (HIGH effort)
**Legacy file:** `api/tech-events.js` (737 lines, mostly the CITY_COORDS table)
**Target:** research domain -- new RPC `ListTechEvents`
**Consumer:** `src/components/TechEventsPanel.ts` + `src/App.ts` -- calls `/api/tech-events?days=180&limit=100`
**Logic:** Fetches Techmeme ICS calendar + dev.events RSS in parallel. Parses ICS and RSS into structured events. Merges with curated events. Geocodes locations via 500-city lookup table. Filters by type, mappable, days, limit.
**Proto needed:** `ListTechEventsRequest` (type, mappable, limit, days). `ListTechEventsResponse` (events array, count, conference_count, mappable_count). `TechEvent` message with coords sub-message.
**Effort:** HIGH -- large file due to city lookup table. The ICS parser and RSS parser are non-trivial. But all logic is a direct port. The CITY_COORDS table becomes a constant inside the handler.

### Step 8: Temporal Baseline
**Legacy file:** `api/temporal-baseline.js` (177 lines)
**Target:** infrastructure domain -- new RPCs `GetTemporalBaseline` (GET) and `RecordBaselineSnapshot` (POST)
**Consumer:** `src/services/temporal-baseline.ts` -- calls GET `/api/temporal-baseline?type=...&region=...&count=...` and POST `/api/temporal-baseline` with `{updates: [...]}`.
**Logic:** Welford's online algorithm for anomaly detection. Reads/writes Redis baselines keyed by type+region+weekday+month. Uses `getCachedJson`, `setCachedJson`, `mget` from `_upstash-cache.js`.
**Proto needed:** Two RPCs with separate request/response messages. GET: check anomaly. POST: batch update baselines.
**Effort:** MEDIUM -- straightforward logic but needs inline `mget` helper and careful Welford implementation port.

### Step 9: Non-JSON Endpoints
**Files:** `rss-proxy.js`, `fwdstart.js`, `story.js`, `og-story.js`, `download.js`, `version.js`
**Action:** Add header comment to each file. No migration needed.
**Effort:** TRIVIAL.

### Step 10: Cleanup
**Actions:**
1. Delete `_ip-rate-limit.js` (zero importers, confirmed dead)
2. Delete `_upstash-cache.js` (after step 8 removes last importer)
3. Delete `_summarize-handler.js` and `_summarize-handler.test.mjs` (after step 5)
4. Update `desktop-readiness.ts` to remove references to migrated legacy endpoints
5. Sync with main
**Effort:** LOW.

## Summarization RPC Design Recommendation

**Recommended approach: Single `SummarizeArticle` RPC with provider parameter**

Rationale:
1. The legacy system has 3 thin endpoint files (groq-summarize.js, ollama-summarize.js, openrouter-summarize.js) that are all wrappers around `_summarize-handler.js::createSummarizeHandler()`.
2. The shared handler factory already parameterizes behavior by provider config (API URL, model, headers).
3. A single RPC with a `provider` request field maps cleanly to this architecture.
4. The client fallback chain calls the RPC 3 times with different provider values, preserving identical behavior.
5. The existing `SummarizeHeadlines` RPC in the proto has a different request shape (`max_headlines`, `topic`) that doesn't match the legacy API. Either redesign it or add a new RPC.

**Recommended proto:**
```protobuf
message SummarizeArticleRequest {
  string provider = 1;       // "ollama", "groq", "openrouter"
  repeated string headlines = 2;
  string mode = 3;            // "brief", "analysis", "translate", default
  string geo_context = 4;
  string variant = 5;         // "full", "tech", or target language for translate
  string lang = 6;            // output language code
}

message SummarizeArticleResponse {
  string summary = 1;
  string model = 2;
  string provider = 3;
  bool cached = 4;
  int32 tokens = 5;
  bool fallback = 6;
  bool skipped = 7;
  string reason = 8;
  string error = 9;
}
```

## Open Questions

1. **SummarizeHeadlines RPC redesign vs new RPC**
   - What we know: The existing `SummarizeHeadlines` RPC in `news/v1` has request fields `max_headlines` and `topic`, which don't match the legacy API's `headlines[]`, `mode`, `geoContext`, `variant`, `lang`.
   - What's unclear: Whether to replace/redesign the existing stub RPC or add a new `SummarizeArticle` RPC alongside it.
   - Recommendation: Add a new `SummarizeArticle` RPC. The existing `SummarizeHeadlines` can remain as a stub or be repurposed later. Adding is safer than breaking existing generated code.

2. **Macro-signals in-memory cache behavior**
   - What we know: The legacy `macro-signals.js` uses module-level `let cachedResponse` (in-memory 5min cache). Edge functions on Vercel are stateless -- this cache is per-instance and short-lived.
   - What's unclear: Whether the sebuf handler should replicate this in-memory cache or switch to Redis.
   - Recommendation: Replicate the in-memory cache exactly (no behavior changes). It works the same way in both edge and sidecar modes.

3. **Tech-events CITY_COORDS placement**
   - What we know: The 500-city lookup table is a large constant (~400 lines). It needs to be accessible from the handler.
   - What's unclear: Whether to inline it in the handler or put it in a separate data file.
   - Recommendation: Put it in a separate `api/data/city-coords.ts` file and import it, similar to how `api/data/military-hex-db.js` is imported in the military handler. This keeps the handler file manageable.

## Sources

### Primary (HIGH confidence)
- Codebase analysis: All 17 existing handlers in `api/server/worldmonitor/*/v1/handler.ts`
- Codebase analysis: All 6 remaining migratable legacy files in `api/`
- Codebase analysis: All client-side consumers in `src/services/` and `src/components/`
- Codebase analysis: All proto definitions in `proto/worldmonitor/*/v1/`
- Codebase analysis: Gateway registration in `api/[[...path]].ts`
- Codebase analysis: Shared utilities `_cors.js`, `_upstash-cache.js`, `_ip-rate-limit.js`

### Secondary (MEDIUM confidence)
- CONTEXT.md decisions from /gsd:discuss-phase session

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all libraries already in project, no new dependencies
- Architecture: HIGH - 17 prior migrations establish identical pattern, no ambiguity
- Pitfalls: HIGH - all pitfalls derived from direct codebase analysis of existing handlers and legacy files
- Proto design: MEDIUM - macro-signals, tech-events, and temporal-baseline require careful message design to mirror complex JSON shapes

**Research date:** 2026-02-20
**Valid until:** 2026-03-22 (stable -- internal codebase migration, no external dependency changes)
