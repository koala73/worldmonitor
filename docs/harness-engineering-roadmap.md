# Harness Engineering Readiness Roadmap

> Based on [Harness Engineering: Leveraging Codex in an Agent-First World](https://openai.com/index/harness-engineering/) (OpenAI, Feb 2026)
>
> **Last updated**: 2026-03-14
>
> **Current readiness**: ~25%

---

## Pillar Assessment

| # | Pillar | Status | Score |
|---|--------|--------|-------|
| 1 | Repo knowledge as system of record | Good | 7/10 |
| 2 | Enforced architecture | Good | 6/10 |
| 3 | Application legibility (agent observability) | Weak | 2/10 |
| 4 | Agent-to-agent review loops | None | 0/10 |
| 5 | Self-healing / garbage collection | None | 0/10 |
| 6 | Full feature loops | None | 0/10 |
| 7 | Doc linters / gardening | Partial | 4/10 |

---

## Pillar 1: Repo Knowledge as System of Record

**Principle**: `AGENTS.md` is a table of contents, not the encyclopedia. Progressive disclosure. Anything outside the repo does not exist.

### Done

- [x] `AGENTS.md` at repo root (table of contents, progressive disclosure)
- [x] `ARCHITECTURE.md` at repo root (system reference with source-file refs, ownership rule)
- [x] `docs/architecture.mdx` renamed to "Design Philosophy" (why decisions were made)
- [x] Legacy `docs/Docs_To_Review/ARCHITECTURE.md` deprecated with banner
- [x] Cross-references between all architecture docs
- [x] Proto contract system with CI freshness checks
- [x] Comprehensive Mintlify docs site with API reference

### Remaining

- [ ] Create `docs/design-docs/` directory with `index.md`
- [ ] Create `docs/exec-plans/active/` and `docs/exec-plans/completed/`
- [ ] Create `docs/product-specs/` with `index.md`
- [ ] Migrate relevant `.claude/memory/` entries into repo-visible docs (conventions that apply to all contributors, not just Claude)
- [ ] Add `docs/generated/` for auto-generated reference docs (e.g., db-schema, cache-key inventory)

---

## Pillar 2: Enforced Architecture

**Principle**: Documentation alone cannot maintain coherence. Custom linters enforce dependency direction, naming, file size, structured logging. Lint errors include remediation instructions for agents.

### Done

- [x] TypeScript strict mode (`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`)
- [x] `tsc --noEmit` in CI and pre-push hook
- [x] Edge function self-containment check (esbuild bundle + import guardrail test)
- [x] Proto breaking-change detection (`buf breaking`)
- [x] Markdown linting in CI

### Remaining

- [x] **P0**: Add JS/TS linter (Biome 2.4.7) — `biome.json`, `npm run lint`, CI workflow `lint-code.yml`, ~120 files auto-fixed
- [x] **P0**: Architectural boundary lint — `scripts/lint-boundaries.mjs`, `npm run lint:boundaries`, CI enforced. Fixed 12 violations (moved types to proper layers). 3 pragmatic exceptions with boundary-ignore comments
- [ ] Encode `.claude/memory/` conventions as lint rules:
  - Ban `fetch.bind(globalThis)` (use deferred lambda)
  - Require `cachedFetchJson()` in new RPC handlers
  - Require `seed-meta:<key>` write in seed scripts
  - Require `User-Agent` header in server-side fetch
  - Require cache key includes request-varying params
- [ ] File size limits with warnings
- [ ] Structured logging enforcement in API handlers

---

## Pillar 3: Application Legibility (Agent Observability)

**Principle**: Agents must be able to launch the app, navigate UI, capture screenshots, inspect DOM, and query logs/metrics/traces.

### Done

- [x] Sentry error tracking in browser
- [x] `api/health.js` with per-key freshness monitoring
- [x] `api/seed-health.js` for seed loop monitoring
- [x] Playwright E2E test infrastructure (config, specs, visual regression)
- [x] Circuit breaker instrumentation

### Remaining

- [ ] **P1**: Expand Playwright E2E harness for agent-driven validation (launch app, navigate, screenshot, assert)
- [ ] **P1**: Add structured JSON logging to API handlers (request ID, latency, error context)
- [ ] Expose logs in a queryable format (even `grep` on Railway logs is a start)
- [ ] Add performance budgets (startup time, critical path latency) as testable assertions
- [ ] Wire Chrome DevTools Protocol for agent DOM inspection (desktop)

---

## Pillar 4: Agent-to-Agent Review Loops

**Principle**: Agent reviews its own work locally. Additional agents review. Feedback loops run until reviews pass. Humans sometimes review PRs.

### Done

- [x] Pre-push hook runs automated checks (typecheck, edge bundle, markdown lint)
- [x] CI runs typecheck on all PRs

### Remaining

- [ ] **P2**: Configure agent PR review in CI (check for architectural violations, convention adherence, test coverage)
- [ ] Start with advisory comments, not blocking
- [ ] Add self-review step: agent runs tests + lint before opening PR
- [ ] Multi-agent review: different agents check different aspects (security, performance, conventions)

---

## Pillar 5: Self-Healing / Garbage Collection

**Principle**: Background agents scan for violations and open refactoring PRs. Technical debt becomes incremental maintenance instead of large refactors.

### Done

- [x] "Golden principles" partially encoded in `AGENTS.md` (key patterns, critical conventions)

### Remaining

- [ ] **P3**: Create convention violation scanner (dead code, banned patterns, missing seed-meta, cache key issues)
- [ ] Background agent opens small refactoring PRs
- [ ] Track tech debt in `docs/exec-plans/tech-debt-tracker.md`
- [ ] Define "golden principles" document with shared utilities, data shape validation rules, anti-patterns

---

## Pillar 6: Full Feature Loops

**Principle**: Given a prompt, agent can validate repo state, reproduce bug, record video, implement fix, validate fix, open PR, address feedback, merge.

### Done

- [x] Agents can open PRs via `gh`
- [x] Agents can run tests via `npm run test:data`
- [x] Git worktree support for isolated work

### Remaining

- [ ] **P4**: Agent bug reproduction harness (receive bug report, reproduce, record screenshot/video)
- [ ] Agent self-merge pipeline for low-risk PRs (requires P0-P2 as safety net)
- [ ] Agent escalation protocol (when to ask human vs. proceed)
- [ ] Build failure auto-repair (agent detects CI failure, fixes, re-pushes)

---

## Pillar 7: Doc Linters / Gardening

**Principle**: Dedicated linters validate documentation freshness, cross-links, structure. Background agent runs doc gardening tasks.

### Done

- [x] `markdownlint-cli2` in CI and pre-push
- [x] MDX lint for Mintlify compatibility
- [x] Ownership rule in `ARCHITECTURE.md` ("update in same PR")

### Remaining

- [ ] **P3**: Doc freshness linter (detect stale dates, broken internal links, orphaned docs)
- [ ] Cross-link validator (ensure all doc references resolve)
- [ ] Doc gardening agent (background task to fix stale docs, update counts, verify source-file refs)

---

## Implementation Order

```
Phase 1 (P0) — Foundation          ← START HERE
├── Add Biome/ESLint linter
├── Add tests to CI
└── Architectural boundary rules

Phase 2 (P1) — Agent Observability
├── Expand Playwright harness
├── Structured logging
└── Encode memory conventions as lint rules

Phase 3 (P2) — Review Loops
├── Automated PR review agent
└── Golden patterns doc

Phase 4 (P3) — Self-Healing
├── Convention violation scanner
├── Doc freshness linter
└── Tech debt tracker

Phase 5 (P4) — Full Autonomy
├── Bug reproduction harness
├── Self-merge pipeline
└── Progressive disclosure doc tree
```

---

## Progress Log

| Date | Change | Pillar |
|------|--------|--------|
| 2026-03-14 | Created `AGENTS.md` (table of contents) | 1 |
| 2026-03-14 | Created `ARCHITECTURE.md` (system reference, Codex-approved) | 1 |
| 2026-03-14 | Renamed `docs/architecture.mdx` to "Design Philosophy", added cross-references | 1 |
| 2026-03-14 | Deprecated legacy `docs/Docs_To_Review/ARCHITECTURE.md` | 1 |
| 2026-03-14 | Added Biome 2.4.7 linter: `biome.json`, `npm run lint`, CI workflow, ~120 files auto-fixed | 2 |
| 2026-03-14 | Fixed all 9 failing test files (1005 tests, 0 failures), added CI workflow `test.yml` | 2 |
| 2026-03-14 | Architectural boundary lint: `lint-boundaries.mjs`, fixed 12 violations, 3 pragmatic exceptions, CI enforced | 2 |
