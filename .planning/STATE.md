# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-22)

**Core value:** Every piece of content on the dashboard makes the viewer feel genuinely better about humanity
**Current focus:** Phase 2 complete - Curated Content Pipeline

## Current Position

Phase: 2 of 9 (Curated Content Pipeline) -- COMPLETE
Plan: 2 of 2 in current phase (02-02 complete)
Status: Phase Complete
Last activity: 2026-02-22 -- Completed 02-02-PLAN.md (Content Category Classifier)

Progress: [#####.....] 56%

## Performance Metrics

**Velocity:**
- Total plans completed: 5
- Average duration: 25 min
- Total execution time: 2.1 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 3 | 120 min | 40 min |
| 02 | 2 | 6 min | 3 min |

**Recent Trend:**
- Last 5 plans: 2m, 113m, 3m, 3m
- Trend: Phase 2 consistently fast -- config + classifier work, no complex debugging

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Curated feeds before ML filtering -- research confirms sentiment false positives (sarcasm, ironic headlines) make ML-only gating unreliable. Curated sources are primary, ML is supplement.
- [Roadmap]: Only 2 new npm deps needed (papaparse, canvas-confetti) -- everything else uses existing infrastructure.
- [Roadmap]: WHO GHO API may be deprecated -- use World Bank as primary for health indicators to de-risk.
- [01-01]: Favicon paths handled via regex replacement in htmlVariantPlugin -- single index.html source of truth.
- [01-01]: Google Fonts loaded unconditionally (minimal overhead, CSS scoping prevents visual impact on non-happy variants).
- [01-01]: Hostname-based variant detection extended to all variants (tech, finance, happy) in inline script.
- [01-02]: Semantic colors use celebration/nature metaphors: gold=critical, sage=growth, blue=hope, pink=kindness.
- [01-02]: Dark mode uses deep navy (#1A2332) base, never pure black.
- [01-02]: --panel-radius introduced as CSS variable (14px) for downstream panel rounding in Plan 03.
- [01-03]: CSS @layer base introduced to control cascade -- happy-theme overrides sit outside @layer so they always win over :root defaults.
- [01-03]: data-variant attribute set on <html> from SITE_VARIANT enables pure-CSS variant scoping without runtime JS.
- [01-03]: Self-hosted MapLibre style JSONs with CARTO CDN tile sources -- pattern for per-variant basemaps.
- [02-01]: 8 feeds from 4 verified positive sources (GNN, Positive.News, Reasons to be Cheerful, Optimist Daily) -- unverified sources excluded.
- [02-01]: GDELT tone_filter appended server-side to query string, sort param replaces hardcoded 'date' -- backward compatible with empty defaults.
- [02-01]: Existing fetchGdeltArticles() passes empty toneFilter/sort to satisfy generated type requirements without changing behavior.
- [02-02]: Priority-ordered keyword tuples (Array<[string, category]>) guarantee evaluation order -- specific keywords checked before generic.
- [02-02]: Default category is 'humanity-kindness' for curated positive sources that don't match any keyword.
- [02-02]: Source-based pre-mapping for GNN category feeds (fast path) before keyword scan (slow path).

### Pending Todos

None yet.

### Blockers/Concerns

- MEDIUM risk: Sentiment threshold (0.85) is a hypothesis -- needs experimentation during Phase 3.
- LOW risk: Positive.News RSS added in 02-01 (URL verified). Future Crunch excluded (unverified RSS URL).
- LOW risk: @huggingface/transformers v4 preview dropped Feb 2026 -- do NOT use, stick with existing v2/v3 stable.

## Session Continuity

Last session: 2026-02-22
Stopped at: Completed 02-02-PLAN.md (Content Category Classifier) -- Phase 2 COMPLETE
Resume file: .planning/phases/02-curated-content-pipeline/02-02-SUMMARY.md
