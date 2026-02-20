# Phase 4: v1 Milestone Cleanup - Research

**Researched:** 2026-02-20
**Domain:** Documentation fixes, retroactive verification, code cleanup, circuit breaker coverage
**Confidence:** HIGH

## Summary

Phase 4 closes all gaps identified in `.planning/v1-MILESTONE-AUDIT.md`. The work spans four distinct areas: (1) documentation staleness fixes in ROADMAP.md and the `.continue-here.md` marker, (2) a retroactive VERIFICATION.md for Phase 2L (maritime migration) which was the only unverified phase, (3) code cleanup of stale metadata in `desktop-readiness.ts` and missing re-exports in the service barrel, and (4) adding circuit breakers to the 6 remaining domains that lack them.

All four areas are mechanical -- no new libraries, no architectural changes, no proto modifications. The circuit breaker work is the most substantive: it requires wrapping sebuf client calls in 4 service modules (seismology, wildfire, climate, maritime) and understanding the re-export nature of 2 others (news, intelligence). The orphaned test file (`api/ollama-summarize.test.mjs`) was already deleted in commit `b277460`, so that item is resolved.

**Primary recommendation:** Execute as 2 plans -- Plan 01 for documentation/verification/cleanup (pure file edits, no code logic), Plan 02 for circuit breaker coverage (code changes requiring TypeScript compilation verification).

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CLIENT-03 | Generated clients support custom fetch function injection for circuit breaker wrapping | Circuit breaker pattern fully documented below. 6 domains need coverage: seismology, wildfire, climate, maritime (direct client users), news and intelligence (re-export wrappers). Pattern: `createCircuitBreaker<ResponseType>({ name })` + `breaker.execute(() => client.rpc({}), fallback)`. See Code Examples section. |
| DOMAIN-03 | Cyber domain proto with service RPCs and HTTP annotations | Already implemented and checked `[x]` in REQUIREMENTS.md. Audit found a documentation gap -- VERIFICATION.md/SUMMARY.md never formally claimed this requirement. Resolution: note in Phase 4 docs that DOMAIN-03 was satisfied by Phase 2M-2S bulk migration; no code work needed. |
| DOMAIN-06 | Infrastructure domain proto (Cloudflare Radar outages, PizzINT, NGA maritime warnings) with service RPCs and HTTP annotations | Already fully implemented. Phase 2L VERIFICATION.md is the missing artifact. Resolution: create retroactive 2L-VERIFICATION.md based on existing 2L-01-SUMMARY.md and 2L-02-SUMMARY.md evidence. |
</phase_requirements>

## Standard Stack

### Core

No new libraries needed. Phase 4 uses only existing project utilities.

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@/utils/circuit-breaker` | (project local) | `createCircuitBreaker<T>()` factory + `CircuitBreaker.execute()` | Already used by 11/17 domains; established pattern |

### Supporting

None -- no new dependencies.

### Alternatives Considered

None -- this is a cleanup phase using established patterns only.

**Installation:**
```bash
# No installation needed
```

## Architecture Patterns

### Recommended Project Structure

No structural changes. All modifications are to existing files.

### Pattern 1: Circuit Breaker Wrapping of Sebuf Client Calls

**What:** Wrap `client.rpcMethod({})` calls inside `breaker.execute(fn, defaultValue)` to get automatic failure tracking, cooldown, and cached fallback.
**When to use:** Every service module that calls a sebuf client RPC.
**Example (from `src/services/cyber/index.ts`):**

```typescript
import { createCircuitBreaker } from '@/utils';
import { CyberServiceClient, type ListCyberThreatsResponse } from '@/generated/client/worldmonitor/cyber/v1/service_client';

const client = new CyberServiceClient('', { fetch: fetch.bind(globalThis) });
const breaker = createCircuitBreaker<ListCyberThreatsResponse>({ name: 'Cyber Threats' });
const emptyFallback: ListCyberThreatsResponse = { threats: [], pagination: undefined };

export async function fetchCyberThreats(): Promise<CyberThreat[]> {
  const resp = await breaker.execute(async () => {
    return client.listCyberThreats({ /* params */ });
  }, emptyFallback);
  return resp.threats.map(toCyberThreat);
}
```

### Pattern 2: Re-Export Wrapper Modules (news, intelligence)

**What:** Some domain service modules (`news/index.ts`, `intelligence/index.ts`) are pure re-export wrappers that delegate to legacy service files. They do not directly call sebuf clients.
**When to use:** Understanding where circuit breakers already exist vs. where they need adding.
**Key insight:** `news/index.ts` re-exports from `../rss` and `../summarization` -- neither calls a sebuf client (RSS parsing is client-side DOMParser, summarization calls `NewsServiceClient` but through the legacy `summarization.ts` file). `intelligence/index.ts` re-exports from `../pizzint` (has breakers), `../cached-risk-scores` (no sebuf client), `../threat-classifier` (no sebuf client), `../gdelt-intel` (calls `IntelligenceServiceClient` directly).

### Pattern 3: Retroactive VERIFICATION.md

**What:** A VERIFICATION.md that documents observable truths after the fact, using SUMMARY.md evidence and code inspection rather than live execution.
**When to use:** Phase 2L maritime migration -- the only unverified phase.
**Key format elements:** Follows exact format of other VERIFICATION.md files (see 2K-VERIFICATION.md as template): YAML frontmatter with `phase`, `verified`, `status`, `score`; sections for Observable Truths, Required Artifacts, Key Link Verification, Requirements Coverage.

### Anti-Patterns to Avoid

- **Adding circuit breakers to re-export wrapper modules that don't directly call sebuf clients:** `news/index.ts` and `intelligence/index.ts` are wrappers. The breakers should be added to the underlying service files that actually make RPC calls (e.g., `summarization.ts` for news, `gdelt-intel.ts` for intelligence).
- **Breaking existing try/catch patterns:** `earthquakes.ts`, `wildfires/index.ts`, and `climate/index.ts` already have try/catch with graceful degradation. Replace the try/catch with `breaker.execute()` which provides the same behavior plus caching and cooldown.
- **Modifying the `maritime/index.ts` polling architecture:** Maritime's AIS polling is complex (hybrid fetch with proto RPC + raw relay). Circuit breaker wrapping should be at the `fetchSnapshotPayload` or `pollSnapshot` level for the proto RPC path only, not around the entire polling mechanism.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Failure tracking + cooldown + cache | Custom try/catch counters | `createCircuitBreaker` from `@/utils` | Already handles max failures, cooldown timer, cache TTL, offline mode detection |

**Key insight:** The existing `CircuitBreaker.execute()` method handles the entire retry/fallback lifecycle. All 11 existing domain implementations use it identically.

## Common Pitfalls

### Pitfall 1: Type Mismatch in Circuit Breaker Generic

**What goes wrong:** `createCircuitBreaker<T>` requires `T` to match the RPC response type, and the `defaultValue` in `execute(fn, defaultValue)` must also match `T`.
**Why it happens:** Easy to use the wrong type (e.g., the mapped consumer type instead of the raw proto response type).
**How to avoid:** Use the imported RPC response type (e.g., `ListClimateAnomaliesResponse`) as the generic parameter, not the consumer-facing type (e.g., `ClimateAnomaly[]`).
**Warning signs:** TypeScript compilation error on `breaker.execute()` call.

### Pitfall 2: Maritime Hybrid Fetch Complexity

**What goes wrong:** Wrapping the entire maritime `pollSnapshot` in a circuit breaker would break the candidate reports path (raw relay) which doesn't go through the proto client.
**Why it happens:** Maritime has a unique hybrid architecture where proto RPC is used for one path and raw HTTP for another.
**How to avoid:** Only wrap the proto RPC call (`client.getVesselSnapshot({})`) inside the circuit breaker, not the raw relay fetch. The `fetchSnapshotPayload` function already has the branching logic.
**Warning signs:** Military vessel tracking (candidate reports) stops working when proto RPC is on cooldown.

### Pitfall 3: Service Barrel Export Collisions

**What goes wrong:** Adding `export * from './wildfires'` to `src/services/index.ts` could cause name collisions with other exports.
**Why it happens:** Wildfire, climate, displacement, etc. may export types or functions with common names.
**How to avoid:** Check for naming collisions before adding re-exports. If collisions exist, use named exports instead of `export *`. Note: the audit says this is "non-blocking; consumers use direct imports" so barrel additions are cosmetic.
**Warning signs:** TypeScript "Duplicate identifier" or "Module has already exported member" errors.

### Pitfall 4: Stale .continue-here.md Confusion

**What goes wrong:** The `.continue-here.md` in Phase 3 directory shows `task: 3, total_tasks: 10, status: in_progress` but all 10 steps are complete.
**Why it happens:** The file was not updated when Phase 3 completed.
**How to avoid:** Either delete it or update it to reflect completion. Since it is a navigation artifact for session continuity, deleting is cleaner.

## Code Examples

Verified patterns from the existing codebase:

### Adding Circuit Breaker to seismology (earthquakes.ts)

Current code (no breaker):
```typescript
// src/services/earthquakes.ts
import { SeismologyServiceClient, type Earthquake } from '@/generated/client/worldmonitor/seismology/v1/service_client';

const client = new SeismologyServiceClient('', { fetch: fetch.bind(globalThis) });

export async function fetchEarthquakes(): Promise<Earthquake[]> {
  const response = await client.listEarthquakes({ minMagnitude: 0 });
  return response.earthquakes;
}
```

Target pattern (with breaker):
```typescript
import { SeismologyServiceClient, type Earthquake, type ListEarthquakesResponse } from '@/generated/client/worldmonitor/seismology/v1/service_client';
import { createCircuitBreaker } from '@/utils';

const client = new SeismologyServiceClient('', { fetch: fetch.bind(globalThis) });
const breaker = createCircuitBreaker<ListEarthquakesResponse>({ name: 'Seismology' });
const emptyFallback: ListEarthquakesResponse = { earthquakes: [] };

export async function fetchEarthquakes(): Promise<Earthquake[]> {
  const response = await breaker.execute(async () => {
    return client.listEarthquakes({ minMagnitude: 0 });
  }, emptyFallback);
  return response.earthquakes;
}
```

### Adding Circuit Breaker to wildfire (wildfires/index.ts)

Current code has try/catch with console.warn fallback. Replace with:
```typescript
import { createCircuitBreaker } from '@/utils';
import { type ListFireDetectionsResponse } from '@/generated/client/worldmonitor/wildfire/v1/service_client';

const breaker = createCircuitBreaker<ListFireDetectionsResponse>({ name: 'Wildfires' });
const emptyFallback: ListFireDetectionsResponse = { fireDetections: [] };

export async function fetchAllFires(_days?: number): Promise<FetchResult> {
  const response = await breaker.execute(async () => {
    return client.listFireDetections({});
  }, emptyFallback);
  const detections = response.fireDetections;
  // ... rest of logic
}
```

### Adding Circuit Breaker to climate (climate/index.ts)

Current code has try/catch. Replace with:
```typescript
import { createCircuitBreaker } from '@/utils';
import { type ListClimateAnomaliesResponse } from '@/generated/client/worldmonitor/climate/v1/service_client';

const breaker = createCircuitBreaker<ListClimateAnomaliesResponse>({ name: 'Climate Anomalies' });
const emptyFallback: ListClimateAnomaliesResponse = { anomalies: [] };

export async function fetchClimateAnomalies(): Promise<ClimateFetchResult> {
  const response = await breaker.execute(async () => {
    return client.listClimateAnomalies({ minSeverity: 'ANOMALY_SEVERITY_UNSPECIFIED' });
  }, emptyFallback);
  const anomalies = (response.anomalies ?? []).map(toDisplayAnomaly).filter(a => a.severity !== 'normal');
  return { ok: true, anomalies };
}
```

Note: The `ok: false` return from the old catch block should map to the breaker's `emptyFallback` path. The `ok` field may need special handling -- when breaker returns cached data, `ok` should be `true`; when it returns fallback, `ok` depends on whether cached data exists.

### Maritime Circuit Breaker (special case)

Maritime's `fetchSnapshotPayload` already has a try/catch on the proto RPC with raw relay fallback. Add breaker around just the proto path:
```typescript
const snapshotBreaker = createCircuitBreaker<GetVesselSnapshotResponse>({ name: 'Maritime Snapshot' });

// Inside fetchSnapshotPayload, when !includeCandidates:
const response = await snapshotBreaker.execute(async () => {
  return client.getVesselSnapshot({});
}, { snapshot: undefined });
```

## State of the Art

No technology evolution relevant to this phase. All work uses existing patterns.

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual try/catch per service | `createCircuitBreaker` with execute() | Phase 2I (2026-02-19) | Standardized failure handling across domains |

## Existing State of Each Audit Gap

### Already Resolved (before Phase 4)

| Gap | Resolution | Evidence |
|-----|-----------|----------|
| DOMAIN-03 checkbox not `[x]` | Fixed in REQUIREMENTS.md | Line 22: `- [x] **DOMAIN-03**` |
| MIGRATE-01-05 checkboxes not `[x]` | Fixed in REQUIREMENTS.md | Lines 40-44: all marked `[x]` with superseded notes |
| ROADMAP.md Phase 3 `2/5 plans complete` status | Already reads `5/5 plans complete` | ROADMAP.md line 196-198 |
| Coverage count in REQUIREMENTS.md | Already updated | Lines 126-131: correct counts |
| Orphaned `api/ollama-summarize.test.mjs` | Already deleted | Commit `b277460` |

### Still Open (Phase 4 scope)

| Gap | Audit Section | Current State | Required Action |
|-----|--------------|---------------|-----------------|
| Phase 3 heading says "IN PROGRESS" | ROADMAP.md line 193 | `### Phase 3: Legacy Edge Function Migration (IN PROGRESS)` | Change to `(COMPLETE)` |
| Plans 03-05 checkboxes still `[ ]` | ROADMAP.md lines 203-205 | `- [ ] 03-03-PLAN.md`, `- [ ] 03-04-PLAN.md`, `- [ ] 03-05-PLAN.md` | Change to `[x]` |
| `.continue-here.md` stale | Phase 3 directory | Shows `task: 3, total_tasks: 10, status: in_progress` | Delete file or update to complete |
| Phase 2L VERIFICATION.md missing | 2L-maritime-migration directory | Has RESEARCH, 2 PLANs, 2 SUMMARYs but no VERIFICATION | Create retroactive 2L-VERIFICATION.md |
| `desktop-readiness.ts` stale metadata | Lines 72-74, 113-114 | References `src/services/conflicts.ts` (deleted), `src/services/outages.ts` (deleted), `api/acled-conflict.js` (deleted), `api/opensky.js` (deleted), `src/services/markets.ts` (deleted), `src/services/polymarket.ts` (deleted) | Update to current file paths |
| Service barrel missing 8 re-exports | `src/services/index.ts` | Missing: climate, conflict, displacement, research, intelligence, news, military, wildfires | Add re-exports (non-blocking; consumers use direct imports) |
| CLIENT-03 circuit breakers | 6 domains | seismology (earthquakes.ts), wildfire (wildfires/index.ts), climate (climate/index.ts), maritime (maritime/index.ts) need direct breakers. news and intelligence are re-export wrappers -- their underlying files need evaluation. | Add `createCircuitBreaker` to 4 direct-client modules + evaluate underlying files for news/intelligence |

### News Domain Breaker Analysis

`src/services/news/index.ts` is a pure re-export wrapper. It re-exports:
- `../rss` -- client-side DOMParser RSS parsing (no sebuf client, no breaker needed)
- `../summarization` -- calls `NewsServiceClient.summarizeArticle()` but through browser-side code with its own fallback chain (Groq -> OpenRouter -> browser T5). The summarization module already has provider fallback logic. A circuit breaker could wrap the entire summarization call, but the existing fallback chain already provides resilience. **Recommendation:** Add a breaker around the sebuf client call in `summarization.ts` where it calls `NewsServiceClient.summarizeArticle()`.

### Intelligence Domain Breaker Analysis

`src/services/intelligence/index.ts` re-exports from:
- `../pizzint` -- already has 2 breakers (`PizzINT` and `GDELT Tensions`)
- `../cached-risk-scores` -- fetches from `/api/risk-scores` (not a sebuf endpoint, still a legacy edge function)
- `../threat-classifier` -- pure computation, no network calls
- `../gdelt-intel` -- calls `IntelligenceServiceClient.searchGdeltDocuments()` directly without a breaker

**Recommendation:** Add a circuit breaker to `src/services/gdelt-intel.ts` around the `IntelligenceServiceClient.searchGdeltDocuments()` call. The other intelligence sub-modules either already have breakers or don't make network calls.

## Open Questions

1. **Maritime circuit breaker granularity**
   - What we know: Maritime has hybrid fetch (proto RPC for snapshot, raw relay for candidates). The proto RPC path is the one needing a breaker.
   - What's unclear: Should the breaker wrap just `client.getVesselSnapshot({})` or the entire non-candidate branch of `fetchSnapshotPayload`? The current code already falls through to raw relay on proto failure.
   - Recommendation: Wrap only `client.getVesselSnapshot({})`. The existing fallback to raw relay is a feature, not a bug -- the breaker should track proto RPC failures independently.

2. **Service barrel re-export safety**
   - What we know: 8 domain directories are missing from `src/services/index.ts`. Consumers use direct path imports.
   - What's unclear: Could adding `export *` for all 8 cause name collisions?
   - Recommendation: Check for collisions before adding. If any exist, use named exports. This is cosmetic -- the audit calls it "non-blocking."

3. **Summarization circuit breaker scope**
   - What we know: `summarization.ts` has a multi-provider fallback chain (Groq -> OpenRouter -> browser T5).
   - What's unclear: Should the breaker wrap the entire chain or just the sebuf RPC call? The sebuf RPC (`NewsServiceClient.summarizeArticle()`) is one provider path among several.
   - Recommendation: Research `summarization.ts` further during planning. If the sebuf RPC is the primary path, wrap it. If it's one of several equal paths, the existing provider fallback may already provide sufficient resilience.

## Sources

### Primary (HIGH confidence)

All findings are from direct codebase inspection:

- `.planning/v1-MILESTONE-AUDIT.md` -- definitive gap list
- `.planning/REQUIREMENTS.md` -- current requirement status
- `.planning/ROADMAP.md` -- current phase status (lines 193-206 for Phase 3 issues)
- `src/utils/circuit-breaker.ts` -- `createCircuitBreaker` API and `execute()` pattern
- `src/services/cyber/index.ts` -- reference circuit breaker implementation
- `src/services/earthquakes.ts` -- seismology module (no breaker)
- `src/services/wildfires/index.ts` -- wildfire module (no breaker)
- `src/services/climate/index.ts` -- climate module (no breaker)
- `src/services/maritime/index.ts` -- maritime module (no breaker, complex hybrid)
- `src/services/news/index.ts` -- news re-export wrapper
- `src/services/intelligence/index.ts` -- intelligence re-export wrapper
- `src/services/index.ts` -- service barrel (missing 8 re-exports)
- `src/services/desktop-readiness.ts` -- stale metadata (6 deleted file paths)
- `.planning/phases/3-sebuf-legacy-migration/.continue-here.md` -- stale status marker
- `.planning/phases/2L-maritime-migration/` -- missing VERIFICATION.md (has 2 SUMMARYs)
- `.planning/phases/2K-conflict-migration/2K-VERIFICATION.md` -- template for retroactive verification

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new libraries; uses only existing `createCircuitBreaker` from `@/utils`
- Architecture: HIGH -- all patterns already established by 11 domains; Phase 4 replicates them
- Pitfalls: HIGH -- identified from direct code inspection of all 6 affected modules
- Documentation gaps: HIGH -- verified each audit item against current file state; 5 of 9 already resolved

**Research date:** 2026-02-20
**Valid until:** 2026-03-20 (stable -- no external dependencies)
