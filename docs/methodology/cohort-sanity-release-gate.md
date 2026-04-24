# Cohort-sanity release gate

Operational procedure for the resilience cohort-sanity audit. This is a
**release gate**, not a merge gate. The audit tells release review what
to look at before publishing a ranking; it does not block a PR from
merging.

## What this exists to catch

A composite resilience score can be mathematically correct yet produce
rankings that contradict first-principles domain judgment — usually
because ONE input has a coverage gap, a saturated goalpost, or a
denominator that's structurally wrong for one sub-class of entities
(re-export hubs, single-sector states, SWF-parked-reserve designs).

Cohort-sanity is the test the codebase can't run on its own. It says:
"given these cohorts, does the ranking match the construct each
cohort is defined to probe?" Not "does country A rank above country
B" — see the anti-pattern section below.

Relevant background in the repository:

- `docs/plans/2026-04-24-002-fix-resilience-cohort-ranking-structural-audit-plan.md` —
  the audit plan that motivates this gate.
- Skill `cohort-ranking-sanity-surfaces-hidden-data-gaps` — the general
  diagnostic protocol (data bug / methodology bug / construct limitation
  / value judgment), including the anti-pattern note on rank-targeted
  acceptance criteria.
- `tests/resilience-construct-invariants.test.mts` — formula-level
  invariants with synthetic inputs. These test the SCORING MATH; they
  don't flip to fail on a live-ranking change.

## Artifacts

1. **`scripts/audit-resilience-cohorts.mjs`** — emits a structured
   Markdown report with:
   - Full top-N ranking table
   - Per-cohort per-dimension breakdown (GCC, OECD-nuclear, ASEAN trade
     hubs, LatAm-petro, African-fragile, post-Soviet, stressed-debt,
     re-export hubs, SWF-heavy exporters, fragile-floor)
   - Contribution decomposition: for each country, each dim's
     `score × coverage × dimWeight × domainWeight` contribution to
     overall
   - Flagged patterns: saturated dims, low-coverage outliers, identical
     scores across cohort members
   - Top-N movers vs a baseline snapshot

2. **`tests/resilience-construct-invariants.test.mts`** — formula-level
   anchor-value assertions. Part of `npm run test:data`. Failing means
   the scorer formula drifted; investigate before editing the test.

3. **`docs/snapshots/resilience-ranking-live-pre-cohort-audit-YYYY-MM-DD.json`** —
   the baseline snapshot for movers comparison. Refresh before each
   methodology change.

## When to run

- **Pre-publication**: any time the published ranking is about to
  change externally (site, API consumers, newsletter, partner feed).
- **Every merge touching a scorer file** in `server/worldmonitor/resilience/v1/_dimension-scorers.ts`,
  `server/worldmonitor/resilience/v1/_shared.ts`, or a scorer-feeding
  seeder in `scripts/seed-recovery-*.mjs`, `scripts/seed-bundle-resilience-*.mjs`.
- **Before activating a feature flag** that alters the scorer
  (`RESILIENCE_ENERGY_V2_ENABLED`, `RESILIENCE_PILLAR_COMBINE_ENABLED`,
  `RESILIENCE_SCHEMA_V2_ENABLED`).
- **After a cache-prefix bump** (`resilience:score:vN`,
  `resilience:ranking:vN`, `resilience:history:vN`) — once the new
  prefix has warmed up, rerun the audit so the movers table reflects
  the new values and nothing else.

## How to run

```bash
# Online (hits the live API; requires WORLDMONITOR_API_KEY)
WORLDMONITOR_API_KEY=wm_xxx \
API_BASE=https://api.worldmonitor.app \
BASELINE=docs/snapshots/resilience-ranking-live-pre-cohort-audit-2026-04-24.json \
OUT=/tmp/cohort-audit-$(date +%Y-%m-%d).md \
node scripts/audit-resilience-cohorts.mjs

# Offline (fixture mode — for CI / dry-run / regression comparison)
FIXTURE=tests/fixtures/resilience-audit-fixture.json \
OUT=/tmp/cohort-audit-fixture.md \
node scripts/audit-resilience-cohorts.mjs
```

Recommended environment variables:

| Var | Default | Notes |
|---|---|---|
| `API_BASE` | (required unless FIXTURE set) | e.g. `https://api.worldmonitor.app` |
| `WORLDMONITOR_API_KEY` | (required unless FIXTURE set) | resilience RPCs are in `PREMIUM_RPC_PATHS` |
| `FIXTURE` | (empty) | JSON fixture with `{ ranking, scores }` shape — skips all network calls |
| `BASELINE` | (empty) | Path to a frozen ranking JSON for movers comparison |
| `OUT` | (stdout) | Path for the Markdown report |
| `TOP_N` | 60 | Rows to render in the full-ranking table |
| `MOVERS_N` | 30 | Rows to render in the movers table |
| `CONCURRENCY` | 6 | Parallel score-endpoint fetches |
| `STRICT` | unset | `1` = fail-closed. Report still writes, then exit 3 on fetch failures/missing members, exit 4 on formula-mode drift, exit 0 otherwise. Recommended for release-gate automation. |
| `CONTRIB_TOLERANCE` | 1.5 | Points of drift tolerated between `Σ contributions` and `overallScore` before formula-mode drift is declared. |

### Fail-closed semantics

The audit is fail-closed on two axes. Both are implemented in
`scripts/audit-resilience-cohorts.mjs` and documented here so that a
release-gate operator cannot shortcut them by reading only the
rendered tables.

1. **Fetch failures / missing cohort members.** When a per-country score
   fetch fails (HTTP 4xx/5xx, timeout, DNS), the country is NOT silently
   dropped. The failure is recorded in the run's `failures` map, banner'd
   as a ⛔ block at the top of the report, and rendered in a dedicated
   "Fetch failures / missing members" section that is ALWAYS present
   (even when empty, so an operator learns to look for it). Fixture mode
   uses the same mechanism for cohort members absent from the fixture.

2. **Formula-mode mismatch (`RESILIENCE_PILLAR_COMBINE_ENABLED`).** The
   contribution decomposition is a domain-weighted roll-up that is ONLY
   mathematically valid when `overallScore` is computed via the legacy
   `sum(domain.score * domain.weight)` path. Once pillar combine is on,
   `overallScore = penalizedPillarScore(pillars)` — a non-linear
   function of the dim scores — and the decomposition rows no longer
   sum to overall. The harness detects this by taking any country with:

   - `sum(domain.weight)` within 0.05 of 1.0 (complete response)
   - every dim at `coverage ≥ 0.9` (stable share math)

   and checking `|Σ contributions - overallScore| ≤ CONTRIB_TOLERANCE`.
   If more than 50% of ≥ 3 eligible countries drift beyond the
   tolerance, a ⛔ blocker banner fires at report top AND a
   "Formula-mode diagnostic" section prints the first three offenders
   with their Σ vs overall numbers. Until the harness grows a
   pillar-aware decomposition, the contribution tables under pillar
   mode must be treated as *"legacy-formula reference only"*.

### Formula mode

The operator guide for what to do when the formula-mode banner fires:

- **If the banner is a false positive** (e.g. scorer changed a dim
  weight and the audit mirror in `scripts/audit-resilience-cohorts.mjs`
  `DIM_WEIGHTS` is stale): update the mirror, re-run. This is the
  `production-logic-mirror-silent-divergence` pattern — the mirror
  must move with the scorer.
- **If pillar combine actually activated:** stop using the
  contribution-decomposition tables for this release gate. Fall back
  to the per-dimension score table + the construct invariants test +
  movers review. File a follow-up to grow the harness a pillar-aware
  decomposition before the next methodology PR under pillar mode.
- **Exit codes under `STRICT=1`:** `3` = fetch/missing, `4` = formula
  mode, `0` = all clear. These are distinct so automation can
  differentiate "the infra is broken" from "the code path is no
  longer decomposable."

## How to read the report

The report surfaces five categories of signal. **Treat each as a
prompt for investigation, not a merge gate.**

### 1. Per-cohort per-dimension table

Read across rows. If one country has `IMPUTED` / `unmonitored` /
`coverage < 0.5` where peers have full coverage, that's a seed-level
gap — probably a late-reporter window or a missing manifest entry.
Fix the seed, not the score.

### 2. Contribution decomposition

Each cell shows how many overall-score points that dimension
contributes to that country. If the row sum doesn't match overall
score (not within ~0.5 points), the scorer is using a composition
formula the audit script doesn't understand — investigate
`_shared.ts`'s `coverageWeightedMean` + `penalizedPillarScore`
branches and update the decomposition accordingly.

### 3. Flagged patterns

- **Saturated-high**: every cohort member scores > 95 on a dim. The
  dim contributes zero discrimination within that cohort — either the
  construct genuinely doesn't apply (acceptable; document in
  `known-limitations.md`), or the goalpost is too generous (re-anchor).
- **Saturated-low**: every member scores < 5. Same question in reverse;
  often a seed failure rather than a construct issue.
- **Identical scores**: all ≥ 3 cohort members hit the same non-trivial
  value. Usually a regional-default leak or a missing-data imputation
  class returning the same number.
- **Coverage outlier**: one country is `coverage < 0.5` while peers
  are ≥ 0.9. This is almost always the ranking-inversion smoking gun.

### 4. Top-N movers vs baseline

Expected movers post-methodology-PR are construct-consistent: a
re-export-hub PR should move re-export hubs, not SWF-heavy exporters.
Surprise movers trigger investigation before publication.

### 5. Anchor invariants

Run `npx tsx --test tests/resilience-construct-invariants.test.mts`.
An anchor drift > 1 point on `score(ratio=1.0)=50` or
`score(em=12)≈63` means someone silently re-goalposted or rewrote a
saturating transform. This is a bug until proven otherwise.

## Anti-pattern: rank-targeted acceptance criteria

**Never put "ENTITY A > ENTITY B" as a merge gate in this workflow.**
Once a review commits to producing a specific ranking, every construct
/ manifest / goalpost knob becomes a lever to tune toward that
outcome — even subconsciously — and the methodology loses its
construct integrity.

Use instead:

- **Construct monotonicity tests** — synthetic inputs, not country
  identity: `score(HHI=0.05) > score(HHI=0.20)`,
  `score(ratio=1.0) = 50 ± 1`. These fail when the MATH breaks, not
  when the RANKING changes.
- **Out-of-sample cohort behaviour** — define a cohort the fix is
  SUPPOSED to move proportionally (re-export hubs, SWF-heavy
  exporters, stressed states). Acceptance: cohort behaviour matches
  the construct change, not a target position.
- **Top-N movers review** — movers should be cohort members the
  construct predicts; surprises trigger investigation.
- **Honest "outcome may not resolve"** — if the original sanity-
  failure (the ranking inversion that triggered the audit) is not
  guaranteed to resolve under the in-scope fixes, say so explicitly.
  A plan that acknowledges "the inversion may persist after all
  fixes, because the dominant driver is out of scope" is stronger
  than one that over-promises.

If a release reviewer asks "will this make A rank above B", the
correct answer is: *"A will move by the amount the construct
predicts. Where it ends up relative to B is an outcome."*

## Follow-ups

- Every novel gap identified by the audit should land as a section in
  `docs/methodology/known-limitations.md` so future reviewers see the
  diagnosis trail.
- If a gap is fixed in a PR, the audit report from that PR's
  post-merge run should be attached to the PR as an artifact.
