# Phase 3: Legacy Edge Function Migration - Context

**Gathered:** 2026-02-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Migrate remaining `api/*.js` legacy edge functions into sebuf domain RPCs. No behavior changes — pure RPC consolidation and cleanup. Non-JSON endpoints stay as Vercel edge functions. Shared utilities cleaned up as their importers are migrated.

</domain>

<decisions>
## Implementation Decisions

### Summarization consolidation
- Claude decides RPC structure (single RPC with provider param vs multiple RPCs)
- Fallback chain stays client-side — client tries each provider RPC in sequence, same as today
- Browser T5 stays client-only as final fallback after all server RPCs fail
- No behavior changes to Ollama base URL handling or any provider config — exact same logic, just moved to sebuf handler

### Non-JSON endpoint handling
- Leave as-is in `api/` root — they're standalone Vercel edge functions, they work fine
- Add a header comment to each: `// Non-sebuf: returns XML/HTML, stays as standalone Vercel function`
- `version.js` stays as standalone edge function (returns JSON but too simple to be worth migrating)
- Files affected: `rss-proxy.js`, `fwdstart.js`, `story.js`, `og-story.js`, `download.js`, `version.js`

### Shared utility teardown
- `_ip-rate-limit.js` — delete immediately (zero importers, dead code)
- `_cors.js` — keep forever (non-JSON files still need it)
- `_upstash-cache.js` — delete after step 8 (temporal-baseline migration removes its last importer)

### Overarching principle
- **No behavior changes anywhere** — this is purely consolidating existing logic into sebuf RPCs and cleaning up
- Same fallback chains, same error handling, same caching, same everything
- Just different transport (sebuf RPC instead of raw fetch to Vercel edge function)

### Claude's Discretion
- Summarization RPC structure (single vs multiple RPCs)
- Proto message design for macro-signals, tech-events, temporal-baseline
- Migration order within the remaining steps

</decisions>

<specifics>
## Specific Ideas

- "Don't change any behavior, we're just consolidating RPCs in sebuf and cleaning up"
- Pattern is well-established from 17 prior domain migrations — same mechanical process

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-legacy-edge-function-migration*
*Context gathered: 2026-02-20*
