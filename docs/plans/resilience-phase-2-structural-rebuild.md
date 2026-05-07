# Resilience Phase 2: Structural Rebuild

Phase 2 of the Country Resilience Index reference-grade upgrade. Rebuilds the top-level shape from five flat domains into three pillars with partly non-compensatory aggregation, adds recovery capacity pillar, and ships a full validation suite.

Parent plan: `docs/internal/country-resilience-upgrade-plan.md`

## PR Status Tracking

| Task | Title | PR | Status |
|---|---|---|---|
| T2.1 | Three-pillar schema + schemaVersion v2.0 feature flag | #2977 | Completed |
| T2.2a | Signal tiering registry (Core/Enrichment/Experimental) | #2979 | Completed |
| T2.2b | Recovery capacity pillar (6 dimensions, 5 seeders) | #2987 | Completed |
| T2.3 | Three-pillar aggregation with penalized weighted mean | #2990 | Completed |
| T2.4 | Cross-index benchmark (INFORM, ND-GAIN, WRI, FSI) | #2985 | Completed |
| T2.5 | Outcome backtest framework (7 event families) | #2986 | Completed |
| T2.6/T2.8 | Sensitivity suite v2 + ceiling-effect detection | #2991 | Completed |
| T2.7 | Railway cron for weekly validation suite | #2988 | Completed |
| T2.9 | Language/source-density normalization (informationCognitive) | #2992 | Completed |
| Closeout | Phase 2 scorecard + v2.0 changelog + flag flip | This PR | Completed |
