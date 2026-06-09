# Documentation Alignment Claim Ledger

**Audit:** `<name>`  
**Base branch/commit:** `<branch> @ <sha>`  
**Audit Captain:** `<name/thread>`  
**Date:** `<YYYY-MM-DD>`

## Claim Ledger

| ID | Claim | Type | Source of truth | Publishing surfaces | Reviewer role | Status | Evidence |
|---|---|---|---|---|---|---|---|
| CLAIM-001 | `<short claim>` | `<API shape / Redis key / formula / example / etc.>` | `<file:function or proto field>` | `<docs, proto, OpenAPI, tests, route comments, etc.>` | `<role>` | `<aligned / drifted / illustrative / planned>` | `<commands, anchors, notes>` |

## Required Surface Checklist

- [ ] runtime code checked
- [ ] seeders/workers/relays checked
- [ ] Redis writers/readers enumerated when keys are documented
- [ ] API handlers and route comments checked
- [ ] proto comments checked
- [ ] generated OpenAPI YAML/JSON checked
- [ ] bundled OpenAPI checked when public API contract is involved
- [ ] public docs checked
- [ ] internal docs checked
- [ ] examples and fixtures recomputed where applicable
- [ ] tests validated against source of truth
- [ ] `public/llms-full.txt` checked when public claims/counts are involved
- [ ] `AGENTS.md` checked when contributor-facing claims are involved

## Residual Risks

| ID | Risk | Why accepted | Owner | Follow-up |
|---|---|---|---|---|
| RISK-001 | `<risk>` | `<reason>` | `<owner>` | `<issue/PR/thread>` |
