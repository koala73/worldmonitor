# Documentation Alignment Audit Protocol

This protocol is required for any broad documentation-vs-code alignment pass.
It prevents a single reviewer from treating public prose as the only source of
truth while source comments, generated contracts, examples, Redis writers, and
tests drift underneath it.

## Required Audit Council

Every audit must assign the following roles. One person or agent may hold more
than one role only when the final Adversarial Verifier is independent.

| Role | Responsibility | Required evidence |
|---|---|---|
| Audit Captain | Owns scope, base branch, claim ledger, thread coordination, and final reconciliation. Cannot self-approve closure. | Scope statement, base commit, linked repair threads or PRs, final reconciliation. |
| Claim Cartographer | Inventories every documented claim by type and publishing surface. | Completed claim ledger with source-of-truth and surface list for each claim. |
| Runtime Truth Reviewer | Validates formulas, thresholds, enums, response shapes, UI labels, and source comments against implementation. | Source anchors and commands proving the runtime behavior. |
| Data Pipeline / Redis Reviewer | Enumerates all writers and readers for documented Redis keys. | Writer/reader matrix, seed-meta health checks, and mismatched writer semantics if any. |
| Generated Contract Reviewer | Checks proto comments, generated OpenAPI YAML/JSON, bundled OpenAPI, and public API docs. | Proto/OpenAPI anchors and regeneration or freshness evidence. |
| Executable Examples Reviewer | Treats fixture-backed examples and JSON snippets as executable contracts. | Recomputed examples or a documented reason an example is illustrative only. |
| Bias / Methodology Reviewer | Reviews scoring, source tiering, fallback rules, uncertainty, imputation, and planned-state language. | Methodology notes showing observed/fallback/imputed/planned states are separated. |
| Adversarial Verifier | Re-runs the audit against the fix branch after repairs. Looks for duplicate root causes, stale tests, generated-doc drift, and "documented elsewhere" overclaims. | Independent verifier signoff and residual-risk list. |

## Claim Types

The Claim Cartographer must classify each claim as one or more of:

- API shape
- enum or literal token
- threshold, formula, or weight
- Redis key or cache contract
- data-source cadence or source identity
- generated contract
- executable example output
- UI label or display band
- source/comment contract
- fallback, degraded, imputed, or planned-state semantics

## Publishing Surfaces

For each claim, the ledger must list every surface that publishes or implies it:

- runtime code
- seeders, workers, relays, and other Redis writers
- API handlers and route header comments
- proto definitions
- generated OpenAPI service specs and bundled OpenAPI
- public docs
- internal docs
- examples and fixtures
- tests
- `public/llms-full.txt`
- `AGENTS.md`
- dashboard UI labels and locale keys

## Required Signoff Order

1. Audit Captain records scope, base commit, and known dirty worktrees.
2. Claim Cartographer builds the ledger before repairs start.
3. Specialist reviewers add evidence and mark each claim aligned, drifted, or
   intentionally illustrative.
4. Repair agents fix drift and add guardrails.
5. Adversarial Verifier re-runs the audit on the fix branch.
6. Audit Captain may publish "fully aligned" only when every required role has
   evidence, every drift row has a disposition, and residual risks are explicit.

## Non-Negotiable Guardrails

- A parity test is evidence only when it derives expected behavior from the
  current source of truth. Tests that encode old assumptions must be treated as
  claims to validate, not as ground truth.
- Any documented Redis key requires an all-writer/all-reader inventory. If a key
  has multiple writers, they must share validation and discovery semantics or
  the docs must disclose the difference.
- Generated API docs must be regenerated from proto comments. Do not hand-edit
  generated OpenAPI as the source of truth.
- Fixture-backed examples must be recomputed or explicitly marked illustrative.
- Planned or roadmap features must not appear in current-state Redis key,
  response-shape, or API-contract tables.
