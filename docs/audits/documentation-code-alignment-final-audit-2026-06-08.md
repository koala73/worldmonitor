# Documentation-Code Alignment Final Audit (2026-06-08)

## Purpose

This audit checks whether the merged code and documentation describe the same
WorldMonitor product, API surface, MCP server, CII/CRI index methodology,
news/digest/briefing pipeline, and related public claims.

The goal is not only to remove stale text. The stronger standard is that
reader-visible documentation must name the actual source of truth, describe the
algorithmic choices that materially affect output, disclose provenance and bias
controls, and have parity tests where drift would be dangerous.

## Baseline

- Audit branch:
  `codex/final-doc-alignment-audit-20260608`
- Audit worktree:
  `/Users/eliehabib/tmp/worldmonitor-final-doc-alignment-20260608`
- Base commit:
  `49fef27b07ae09940a7e2fbf09426a27cac27405`
- Base source:
  `origin/main`, fetched and audited after the prior documentation-fix PRs were
  merged.
- Original checkout:
  `/Users/eliehabib/Documents/GitHub/worldmonitor` was dirty and was not
  modified by this audit.

Merged PRs verified on `main` before this audit:

| PR | Merge commit | Main status |
| --- | --- | --- |
| #4208 | `f2420f1828231c9b661cf2931cc01926edd9371d` | Merged |
| #4209 | `fadbce11cf0c687ca68724301a499382fd4200f1` | Merged |
| #4212 | `6f6757944b92f6050de60e157b6205edef72546e` | Merged |
| #4213 | `49fef27b07ae09940a7e2fbf09426a27cac27405` | Merged |
| #4214 | `1341a733b03ed21e7d36d5af58e6a7cff966f1ee` | Merged |
| #4215 | `f4ef60c8590a6b500cf5094ce538494b0c5cc012` | Merged |
| #4216 | `e965b43e07af869fd17eda6034a3c2e57b2fba06` | Merged |
| #4217 | `cb5e6f96422838026776215941bd969c912f5a6c` | Merged |
| #4218 | `e06c9cba50e94b311542bde8b7249a438ad81403` | Merged |

The earlier planning file
`docs/internal/documentation-alignment-remaining-work-2026-06-07.md` is not
present on this merged `main`. This audit therefore validates by live source,
documentation, and parity-test anchors rather than by that removed internal
checklist.

## Verdict

No blocking undocumented algorithms were found after this pass in the CII, CRI,
MCP, API, news, digest, briefing, forecast, scenario, chokepoint, or market
methodology surfaces reviewed.

The remaining material gap found in this final pass was outside the core method
pages: public LLM summaries, press/SEO pages, and older review docs still
contained stale product and CII claims. Those surfaces are now aligned with the
server-authoritative methodology and guarded by an expanded CII drift test.

## Scope Reviewed

- CII and Strategic Risk methodology, scorer code, seed health, cached API
  behavior, public docs, and LLM-facing summaries.
- CRI methodology, dimension scorers, pillar aggregation, runtime manifest,
  imputation and coverage policy, and release gates.
- MCP public docs, server card, protocol negotiation, quota/accounting behavior,
  resources, prompts, tool metadata, JMESPath docs, and API parity.
- News, digest, and briefing methodology, feed inventory, classifier behavior,
  scoring, corroboration, story tracking, cooldown, notification, signed URLs,
  and issue-slot semantics.
- REST/OpenAPI/proto surfaces, API auth, generated docs, and source-of-truth
  routing.
- Forecast, scenario, chokepoint, and market methodology docs and parity tests.
- Public product summaries, LLM files, press kit, community guide, architecture
  docs, agent entry-point docs, and SEO pre-rendered homepage content.

## Evidence Matrix

| Area | Source of truth | Documentation | Guard rails | Result |
| --- | --- | --- | --- | --- |
| CII scorer | `server/worldmonitor/intelligence/v1/get-risk-scores.ts`, `shared/cii-weights.ts`, `server/worldmonitor/intelligence/v1/_risk-config.ts` | `docs/methodology/cii-risk-scores.mdx`, `docs/country-instability-index.mdx`, `docs/algorithms.mdx` | `tests/cii-docs-drift.test.mts`, `tests/cii-scoring.test.mts`, `tests/frontend-cii-source-of-truth.test.mts` | Aligned |
| CII provenance and fallback | Cached risk-score handler, seed metadata, advisory fallback logic | CII methodology page and API docs describe server authority, advisory fallback, movement windows, and `methodology_version` | `tests/cached-risk-scores.test.mts`, `tests/seed-health-risk-scores.test.mjs` | Aligned |
| CII public summaries | LLM and press surfaces, README, homepage SEO copy | `public/llms.txt`, `public/llms-full.txt`, `docs/PRESS_KIT.md`, `README.md`, `index.html` | Expanded CII docs-drift test blocks stale CII and product-count claims | Fixed in this audit |
| Strategic Risk rollup | Frontend Strategic Risk panel and server CII response contract | `docs/strategic-risk.mdx` and CII methodology describe top-country server rollup semantics | CII drift/source-of-truth tests | Aligned |
| CRI scorer | `server/worldmonitor/resilience/v1/_dimension-scorers.ts`, `_shared.ts`, `_pillar-membership.ts` | `docs/methodology/country-resilience-index.mdx` | `tests/resilience-doc-parity.test.mts`, `tests/resilience-methodology-lint.test.mts`, `tests/resilience-release-gate.test.mts` | Aligned |
| CRI manifest and coverage | Runtime manifest handler, score export, source-failure paths | CRI methodology documents rankable universe, active and retired dimensions, imputation, coverage, and release-gate posture | `tests/resilience-runtime-manifest.test.mts`, `tests/resilience-source-failure.test.mts`, `tests/resilience-coverage-influence-gate.test.mts` | Aligned |
| News digest and briefing | `server/worldmonitor/news/v1/*`, digest cooldown libs, brief share/sign routes, feed inventory | `docs/methodology/news-digest-and-briefing.mdx` | `tests/news-digest-methodology-parity.test.mjs`, `tests/brief-url-sign.test.mjs`, `tests/brief-share-url.test.mts`, `tests/brief-edge-route-smoke.test.mjs` | Aligned |
| MCP | `api/mcp/*`, `public/.well-known/mcp/server-card.json` | `docs/mcp-server.mdx`, `docs/mcp-quickstart.mdx`, `docs/mcp-jmespath.mdx`, `docs/mcp-error-catalog.mdx` | MCP capability, resource, protocol, JMESPath, and reference-doc tests | Aligned |
| REST/OpenAPI/proto | `proto/`, `server/worldmonitor/*`, generated docs under `docs/api/` | API reference, endpoint guide, auth docs, source-specific methodology pages | Proto freshness workflow, API parity tests, sidecar/API tests | Aligned for reviewed surfaces |
| Forecast/scenario/chokepoint/markets | Forecast integrity, scenario docs, chokepoint seed docs, market methodology contracts | Relevant methodology docs and API descriptions | Forecast provenance, scenario parity, chokepoint, and market contract tests | Aligned for reviewed surfaces |
| Platform counts and variants | Variant configs, generated stats, feed inventory, locale files, layer registry | LLM files, press kit, community guide, architecture docs, homepage SEO copy | Expanded CII docs-drift test and stale-claim sweep | Fixed in this audit |

## Algorithm And Bias Posture

### CII

CII is now documented as a WorldMonitor editorial risk index, not as an
academic or third-party neutral benchmark. The docs disclose the v8 component
formula, the baseline/event mix, capped boosts and floors, advisory fallback
behavior, movement windows, methodology version, country coverage, and
provenance fields.

The important cleanup in this audit was to remove public references that still
described an old country universe, an obsolete component shortcut, or
browser-only authority. Public summaries now match the server-authoritative CII
v8 implementation for 31 Tier-1 countries.

### CRI

CRI is documented as a 196-country public resilience construct with schema
version, formula tag, domains, dimensions, pillars, imputation policy, coverage
rules, retired dimensions, and runtime manifest behavior. The methodology avoids
presenting the score as a general wealth ranking, and the docs disclose where
coverage, imputation, or source failure can affect confidence.

The reviewed tests enforce formula/docs parity, runtime manifest shape, release
gates, pillar aggregation, source-failure handling, and coverage influence.

### News, Digest, And Briefing

The news methodology now names the important editorial and algorithmic controls:
feed inventory, source tiers, energy fallback feeds, RSS freshness/date gates,
classifier behavior, score inputs, corroboration rules, story tracking,
cooldown, dedupe, notification semantics, LLM usage caps, and signed briefing
URL issue-slot behavior.

The docs explicitly separate automated pipeline behavior from human editorial
review. The project does not claim a normal human review queue where the code
does not implement one.

### MCP And API

MCP documentation now matches the public server card and implementation for
tool, prompt, and resource counts; method limits; protocol negotiation;
API-key versus Pro/OAuth behavior; per-minute and daily accounting; and
capability metadata. In particular, resource reads are documented as
quota-consuming, while resource discovery remains metadata-only for daily
accounting.

REST/API docs are reviewed against proto/gateway/handler source-of-truth
patterns. Where runtime state can be live, fallback, absent, or degraded, the
documentation should preserve those distinctions rather than collapsing them
into a single success/failure claim.

## Fixed In This Audit

### Public and LLM surfaces contained stale methodology and product claims

Several public-facing files had escaped the earlier focused docs fixes. They
still described stale product counts, incomplete variant coverage, browser-only
authority for intelligence analysis, and an obsolete CII summary. These files
are high-risk because they are the easiest surfaces for search engines, LLMs,
press readers, and first-time contributors to ingest.

Updated files:

- `README.md`
- `public/llms.txt`
- `public/llms-full.txt`
- `docs/PRESS_KIT.md`
- `docs/COMMUNITY-PROMOTION-GUIDE.md`
- `docs/architecture.mdx`
- `docs/ai-intelligence.mdx`
- `docs/Docs_To_Review/ARCHITECTURE.md`
- `docs/Docs_To_Review/DATA_MODEL.md`
- `docs/Docs_To_Review/PANELS.md`
- `docs/Docs_To_Review/TODO_Performance.md`
- `docs/Docs_To_Review/todo_docs.md`
- `index.html`
- `AGENTS.md`
- `tests/cii-docs-drift.test.mts`

Corrections made:

- CII now means Country Instability Index consistently in current public docs.
- CII public summary now matches CII v8 and the 31-country Tier-1 universe.
- CRI is added to LLM and press surfaces as a distinct 196-country resilience
  index.
- Product summaries now use six variants, including Energy Monitor.
- The agent/developer entry point now includes the `energy` variant.
- Public count claims now align to 500+ feeds, 56 map layer types, and
  24 locales where those counts are used.
- Public architecture copy now distinguishes browser-side local ML from
  server-authoritative APIs for CII, CRI, briefs, forecasts, MCP, and cached
  operational data.
- A stale public LLM blog label was changed to count-free wording so it no
  longer publishes an obsolete language count.
- The CII docs-drift test now guards the public LLM and press surfaces against
  stale CII, CRI, variant, layer, feed, and language-count claims.

## No Remaining Blocking Findings

After this pass, the reviewed current documentation has no known blocking gap
where a material algorithm, scoring method, quota behavior, or source-of-truth
decision is undocumented or contradicted by code.

The project is in substantially better shape than a normal docs cleanup: the
core methodologies are canonical, parity tests cover the high-risk drift points,
and public summary surfaces now avoid implying undocumented neutrality,
browser-only computation, or stale platform scope.

## Validation Plan

The focused validation bundle for this audit covers the surfaces most likely to
drift from documentation:

```bash
npx tsx --test \
  tests/cii-docs-drift.test.mts \
  tests/cii-scoring.test.mts \
  tests/frontend-cii-source-of-truth.test.mts \
  tests/cached-risk-scores.test.mts \
  tests/seed-health-risk-scores.test.mjs \
  tests/resilience-doc-parity.test.mts \
  tests/resilience-methodology-lint.test.mts \
  tests/resilience-runtime-manifest.test.mts \
  tests/resilience-coverage-influence-gate.test.mts \
  tests/resilience-release-gate.test.mts \
  tests/resilience-source-failure.test.mts \
  tests/resilience-pillar-aggregation.test.mts \
  tests/news-digest-methodology-parity.test.mjs \
  tests/brief-url-sign.test.mjs \
  tests/brief-share-url.test.mts \
  tests/brief-edge-route-smoke.test.mjs \
  tests/mcp-capability-parity.test.mjs \
  tests/mcp-resources.test.mjs \
  tests/mcp-api-parity.test.mjs \
  tests/mcp-jmespath-doc-parity.test.mjs \
  tests/mcp-protocol-version.test.mjs \
  tests/mcp-tools-list-compression.test.mjs \
  tests/mcp-tools-reference-docs.test.mjs \
  tests/forecast-integrity-provenance.test.mjs \
  tests/agent-skills-index.test.mjs \
  tests/chokepoint-flows-seed.test.mjs \
  tests/market-methodology-doc-contracts.test.mjs \
  tests/chokepoint-scenario-doc-parity.test.mjs
```

Markdown validation should cover every edited Markdown/MDX surface and this
audit report:

```bash
npx markdownlint-cli2 \
  README.md \
  docs/PRESS_KIT.md \
  docs/COMMUNITY-PROMOTION-GUIDE.md \
  docs/architecture.mdx \
  docs/ai-intelligence.mdx \
  docs/Docs_To_Review/ARCHITECTURE.md \
  docs/Docs_To_Review/DATA_MODEL.md \
  docs/Docs_To_Review/PANELS.md \
  docs/Docs_To_Review/TODO_Performance.md \
  docs/Docs_To_Review/todo_docs.md \
  docs/audits/documentation-code-alignment-final-audit-2026-06-08.md
```

A stale-claim sweep should also be run against current public docs, excluding
historical changelog context and this audit narrative.

## Validation Results

The first focused validation run found one remaining public-count drift:
`public/llms.txt` still used a historical blog title with an obsolete language
count. That label is now count-free, and the targeted CII drift guard passed.

June 8 final focused suite (historical audit result):

```text
npx tsx --test ...focused bundle...
tests 488
suites 61
pass 488
fail 0
cancelled 0
skipped 0
todo 0
```

June 9 rerun addendum:

The same focused bundle was rerun from `origin/main` at
`1fd6ce88d83ca3832cedaf0cabe8e2d685ab7829` after
`npm run worktree:bootstrap:test-only`. The rerun preserved the 61-suite shape
but picked up six additional assertions from current `main`; it passed with no
failures.

```text
npm_config_cache=/tmp/worldmonitor-npm-cache npx tsx --test ...focused bundle...
tests 494
suites 61
pass 494
fail 0
cancelled 0
skipped 0
todo 0
```

Targeted CII public-surface guard:

```text
npx tsx --test tests/cii-docs-drift.test.mts
tests 7
suites 1
pass 7
fail 0
```

Markdown lint:

```text
npx markdownlint-cli2 ...edited docs...
Summary: 0 error(s)
```

Stale public-claim sweep:

```text
docs/changelog.mdx:131:- Pro landing page localization — 21 languages (#1187)
```

The remaining match is historical changelog context, not a current product or
methodology claim.

## Residual Risks

- This audit validates source, docs, tests, and local behavior. It does not
  prove production secrets, Cloudflare/Vercel/Railway state, or live third-party
  data availability.
- Historical changelog entries can preserve old counts because they describe
  past releases. Those should not be treated as current product claims.
- The removed internal planning checklist is not available on merged `main`;
  source files and parity tests are now the canonical evidence trail.
- Archive and review-only documents under `docs/Docs_To_Review/` were updated
  where they still looked like current architecture notes, but historical
  context should remain historical rather than rewritten into a false record.
- Counts such as feeds, layers, locales, and source groups can drift over time.
  The highest-risk public summaries now have a guard, but future count changes
  should update both generated stats and public docs in the same PR.

## Ship Readiness Checklist

- CII formula, coverage, provenance, fallback, and public summaries are
  documented and guarded.
- CRI formula, universe, dimensions, pillars, imputation, coverage, and runtime
  manifest are documented and guarded.
- News/digest/briefing methodology names automated scoring, classifier,
  freshness, cooldown, dedupe, LLM, URL, and bias controls.
- MCP docs match tool/resource/prompt metadata, protocol negotiation, quota
  semantics, and API-key versus OAuth behavior.
- Public LLM, press, README, community, architecture, and SEO surfaces no longer
  contradict the canonical methodology pages.
- Remaining uncertainty is framed as operational or historical, not as an
  undocumented algorithmic blocker.
