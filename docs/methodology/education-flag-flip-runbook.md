# Education dimension flag-flip runbook

> **PRE-DEPLOY IMPLEMENTATION READY (#6460 / PR #6473).** The proposed code
> defaults `RESILIENCE_EDUCATION_ENABLED` to `true`, promotes the indicator to
> `tier='core'`, and rotates cache generations to score `v27` / ranking `v27` /
> history `v21` / intervals `v10`. The explicit `false` rollback remains dark
> through the triple-zero discriminator. This document does not claim that PR
> #6473 is merged, deployed, or accepted in production. Completion still needs
> the first post-deploy refresh and one genuine post-flip artifact from step 5.
>
> One deviation from the procedure as written, recorded rather than waived: the
> flip is expressed as a **code default** rather than a production env var. See
> "Why the default and not an env var" in the pre-deploy validation section.

Operational procedure for activating the `education` dimension of the Country
Resilience Index — moving `RESILIENCE_EDUCATION_ENABLED` from off (shipped
default) to on.

**A flag flip is a publication event, not a config change.** It adds a fifth
core-bearing dimension to the social-governance domain, which moves every other
dimension in that domain from a 1/4 to a 1/5 gate share, and it changes the
published score and ranking for 196 countries. Treat it with the same rigor as
the code change.

## Why this document exists

This repo has the failure mode on record, twice:

- `financialSystemExposure` shipped on 2026-04-25 with its seeders, bundle
  registration, and health wiring all in place. Its flag still defaults to
  `false`. A fully-built dimension has contributed nothing since.
- Energy v2 *was* flipped, but `docs/internal/country-resilience-audit-2026-06-04.md`
  records that its acceptance artifacts were never committed. That item is still
  open.

Shipping dark is only half the work. This runbook is the other half.

## Pre-flip checklist

All must be green before flipping:

1. **Seeder provisioned and publishing.** The Railway `seed-bundle-macro`
   service includes `Education-Attainment` and has completed at least one clean
   run in production:
   ```bash
   redis-cli --url $REDIS_URL GET seed-meta:resilience:education-attainment
   # fetchedAt within the last 8 days, rankableRecordCount >= 180
   ```
   The validation floor in the seeder is 150, deliberately lower than the
   measured 181 so a transient World Bank dip does not poison seed-meta. The
   flip gate is the stricter **180** — a payload between 150 and 180 is healthy
   enough to retain as last-good data, but both health surfaces report
   `COVERAGE_PARTIAL` and the active scorer fails closed until rankable coverage
   recovers. Total `recordCount` includes territories and cannot prove this gate.

   **180 is not a round number, it is a CI invariant.**
   `tests/resilience-indicator-tiering.test.mts` sets `CORE_MIN_COVERAGE = 180`
   and fails any `tier: 'core'` indicator below it. Flipping on a payload of
   176–179 would pass a laxer runbook check and then fail CI inside the
   publication PR. The gate and the invariant must be the same number.

2. **Register the health probe, then confirm it green.** ✅ **Done and accepted in #6452**
   (2026-08-11). The probe was deliberately **not** registered in the scaffold PR,
   because `scripts/check-health-probe-cutovers.mts` requires a new strict probe to
   carry machine-readable pre-seed evidence, or an acknowledgement expiring by the
   producer's first scheduled run within 24 hours — neither is obtainable before the
   seeder has ever run, and the second would require knowing the merge time in advance.

   The order was: seeder ships → `seed-bundle-macro` publishes once → add the
   `educationAttainment` entry on the **pre-seed evidence** path, citing the Railway
   service, `probeKey`, a real `compactHealthStatus: OK`, and an HTTPS reference →
   then confirm `/api/health` reports OK.

   Post-deploy acceptance proved all three conditions on production:

   ```
   checks.educationAttainment = { "status": "OK", "records": 189,
                                  "seedAgeMin": 338, "maxStaleMin": 11520 }
   summary = { "total": 261, ..., "crit": 0 }
   ```

   **Keep these three conditions as the standard for the next probe** — the deployed SHA
   carries the registration, the probed-key total moved to its new value, and the probe
   itself reports `OK`. Two traps sit on that check, and they fail in **opposite**
   directions, so neither one covers the other:

   - **A stale CDN read looks like a failure that is not real.** `/api/health?compact=1`
     served the *old* `total: 259` for several minutes after the deploy had completed; a
     cache-busted request returned `260` with `x-vercel-cache: MISS`. Use the endpoint's
     own registry size as the deploy signal rather than the Vercel commit status, and
     bust the cache — otherwise you read a pre-deploy snapshot and conclude a landed
     registration never landed.
   - **A compact-only read looks like a pass that is not real.** The compact surface
     carries `problems`, not a per-check map, so a probe is absent from it both when it
     is healthy *and when it was never registered at all*. Confirming `OK` from absence
     would green-light a probe that does not exist. Read the explicit
     `checks.<probe>.status` on the operator surface.

   **The publish did not happen on its own.** Railway refused the #6450 merge commit
   because its post-merge check suite was red on two unrelated tests, so the service
   kept running an image with no education script, and the reconciler that would
   normally compensate is dormant pending #6378. The service had to be deployed to a
   green head by hand before any tick could publish. Budget for that check rather than
   assuming a merged seeder is a running seeder — and note that a `seed-meta` key can
   be present and fresh without the Railway producer ever having run, so verify
   provenance by sibling co-movement plus
   `git cat-file -e <runningSha>:scripts/seed-education-attainment.mjs`.

   Registration touches **five** sites, not the two the old text listed — both halves
   of the probe, the sequencing test that asserts it is absent, and both bridging
   allowlist entries:

   - `STANDALONE_KEYS.educationAttainment` and `SEED_META.educationAttainment`
     (`api/health.js`); registering only the latter leaves no canonical data key to probe
   - `education health-probe rollout sequencing` (`tests/resilience-source-failure.test.mts`),
     inverted from "not yet registered" to "registered on both halves"
   - `KNOWN_SEEDS_NOT_IN_HEALTH` (`tests/resilience-dimension-freshness.test.mts`)
   - `TRACKED_STANDALONE_META_KEYS_NOT_IN_HEALTH` (`tests/resilience-source-failure.test.mts`)

   Two gates also move with it: `EXCLUDED_FROM_MCP` in
   `tests/mcp-bootstrap-parity.test.mjs` needs the new canonical key, and the probed-key
   total in `docs/{,zh/}api-platform.mdx` and `docs/{,zh/}health-endpoints.mdx` goes
   259 → 260.

3. **Registry tier promoted.** Change the `femaleUpperSecondaryAttainment` entry
   in `_indicator-registry.ts` from `tier: 'experimental'` to `tier: 'core'`.
   Until this happens the indicator is excluded from both the weight-sum
   invariant and the coverage-influence gate, so neither is actually exercising
   it.

   **Know which floor actually binds.** Two different gates apply, and the
   looser one is the one that looks reassuring:

   - `tests/resilience-coverage-influence-gate.test.mts` — 137-country floor,
     but it only flags indicators whose nominal weight also exceeds 5%.
     Education's nominal weight is `1.0 x 1/5 x 0.19 = 3.8%`, under the cap, so
     **this gate passes at any coverage, including zero.** It provides no
     assurance here.
   - `tests/resilience-indicator-tiering.test.mts` — `CORE_MIN_COVERAGE = 180`,
     a hard floor on every `core` indicator. **This is the binding constraint.**

   Measured coverage is 181, so promotion clears the binding floor by **one
   country**. That margin is thin by design of the data, not by choice: if the
   World Bank drops two reporters before the flip, promotion fails CI. Re-measure
   immediately before promoting rather than trusting the 181 recorded here.

4. **EXTRACTION_RULES implemented.** `scripts/compare-resilience-current-vs-proposed.mjs`
   currently carries `femaleUpperSecondaryAttainment` as `not-implemented`.
   **This must be implemented before the flip.** With the dim dark it extracts
   nothing and that is correct; once education carries real weight, a
   `not-implemented` row means gate-9 effective-vs-nominal influence evidence
   silently omits it — a green acceptance verdict computed over a formula the
   harness cannot see. Wire `resilience:education-attainment:v1` into the bulk
   payload load and extract `countries[iso2].value`.

5. **Cache prefixes — the scaffold is score-invariant; rotate at flip.**

   The scaffold rotates score `v25`→`v26` so cached score payloads gain the
   serialized education row, and ranking `v25`→`v26` so the ranking generation
   is rebuilt from the current score namespace. It deliberately keeps history
   at `v20` and intervals at `v9` because the flag-dark triple-zero row is
   excluded from the domain, pillar, server-confidence, and widget-confidence
   denominators. Tests assert identical flag-off pillar score and coverage.

   The exclusion is narrow: only the `education` triple-zero flag-dark shape is
   skipped by `averageDomainDimensionCoverage`. A real education outage carries
   observed or imputed weight and remains in the denominator, so the invariant
   cannot hide a source failure.

   **At flip, rotate all numeric generations**: score `v26`→`v27`, ranking
   `v26`→`v27`, history `v20`→`v21`, and intervals `v9`→`v10`. The flip
   changes scores, and mixing pre- and post-flip history points or sensitivity
   bands would manufacture false trends and stale `rankStable` verdicts.

   **DONE 2026-08-11** — 39 replacements across 21 code and test files. The grep
   below now names the CURRENT generation, so a future rotation starts from
   truth rather than from this flip's already-rotated values:
   ```bash
   grep -rln "resilience:score:v28\|resilience:ranking:v28\|resilience:history:v22\|resilience:intervals:v11" \
     --include='*.mjs' --include='*.ts' --include='*.js' --include='*.mts' \
     --include='*.mdx' --include='*.md' . | grep -v node_modules
   ```
   Expect hits in the two methodology `.mdx` cache-key tables and their prose, plus the current finance activation references.
   The historical bump-chain paragraph and
   `docs/solutions/conventions/verification-grep-must-cover-every-file-type-it-claims.md`
   deliberately retain OLD generations — they are history, not live references,
   so do not rewrite them.
   **The `.mdx`/`.md` includes are load-bearing — do not drop them.** An earlier
   version of this runbook omitted them, and the v25→v26 rotation consequently
   missed the cache-key table in `docs/zh/methodology/country-resilience-index.mdx`
   while the verification grep returned zero hits and read as proof of
   completeness. A verification step that cannot see the surface it is verifying
   is worse than no verification step. Both locales carry the key table, and the
   zh doc is hand-maintained — `scripts/generate-public-product-facts.mjs` does
   not regenerate it, so it will not self-heal.

   Missing one is worse than not rotating: `benchmark-resilience-external.mjs`,
   `validate-resilience-correlation.mjs`, and `backtest-resilience-outcomes.mjs`
   produce the acceptance evidence, so a stale prefix there reads an abandoned
   namespace and returns a green verdict with no signal.

6. **Ship the coverage-drop warning and active floor.** The 150 validation floor does not catch a
   partial fetch: 161 countries clears it while silently moving ~20 onto the
   `unmonitored` imputation. The seeder remains warn-not-fail so a legitimate
   World Bank revision cannot overwrite seed-meta with an error, but it writes
   numeric `rankableRecordCount`. Both health surfaces enforce 180, and the
   active scorer accepts only current meta that proves the same floor (with the
   prior `countrySet` field as a transition fallback). Both health surfaces also
   count usable rankable records in the canonical payload, so stale metadata
   cannot conceal a partial publish. The set-diff warning remains useful because
   it names which reporters changed. Build all parts before flipping, not after.

7. **Split the active gate from rollback coverage semantics.** Remove
   `'education'` from `FLAG_GATED_DARK_DIMENSIONS` in
   `tests/resilience-release-gate.test.mts`, so the default-on release fixture
   must carry real education coverage. Keep it in
   `RESILIENCE_FLAG_DARK_WHEN_ZERO_COVERAGE` and the client mirror: those sets
   exclude only the explicit false rollback's triple-zero shape. Active rows
   and source failures carry observed or imputed weight and remain counted.

## Acceptance gates

Same gates as the energy v2 flip (`docs/methodology/energy-v2-flag-flip-runbook.md`):

| Gate | Threshold |
|---|---|
| `gate-1-spearman` | Spearman vs baseline ≥ 0.85 |
| `gate-2-country-drift` | max country drift ≤ 15 points |
| `gate-6-cohort-median` | cohort median shift ≤ 10 points |
| `gate-7-matched-pair` | every matched pair holds its expected direction |
| `gate-9-effective-influence-baseline` | ≥ 80% of Core indicators measurable |

Expect real movement, and size it before deciding. Two effects compound: the
new dimension's own signal, and the 20% nominal-influence reduction every other
social-governance dimension takes when the domain goes from four core-bearing
dimensions to five. The six WGI governance indicators are the largest single
loser. If drift exceeds the gate, the question is whether the dimension weight
(0.5) is too high, not whether to waive the gate.

## Flip procedure

Two actors. The implementer prepares and runs everything that does not need
production credentials; the repo owner executes the toggle and captures the
artifacts, because `scripts/freeze-resilience-ranking.mjs` verifies score
anchors through an endpoint requiring `WORLDMONITOR_API_KEY`.

1. **Capture a pre-flip baseline** (owner):
   ```bash
   API_BASE=https://www.worldmonitor.app \
     WORLDMONITOR_API_KEY=<pro-api-key> \
     RESILIENCE_RANKING_OUTPUT_BASENAME=resilience-ranking-live-pre-education-$(date -u +%F).json \
     node scripts/freeze-resilience-ranking.mjs
   ```

2. **Dry-run the acceptance gates** against production-seeded data with the flag
   locally on. Every gate must pass. If one fails, STOP and debug — do not waive.

3. **Land the promotion PR**: tier `experimental`→`core`, EXTRACTION_RULES
   implemented, cache prefixes bumped, active release gate enforced, and
   triple-zero rollback coverage semantics retained.

4. **Flip the flag** (owner): set `RESILIENCE_EDUCATION_ENABLED=true` in
   production and deploy.

5. **Capture the post-flip artifact** (owner), after the first post-deploy
   ranking refresh completes. Commit
   `docs/snapshots/resilience-education-acceptance-{date}.json` reporting
   `acceptanceGates.verdict == "PASS"`.

   If the harness exits non-zero, **do not commit a synthetic artifact.** Attach
   the gate output to the tracking issue and leave the flag off.

6. **Update the methodology doc**: move the Education section's "ships flag-gated
   dark" language to describe the active construct, and add a changelog entry.

## Rollback

Set `RESILIENCE_EDUCATION_ENABLED=false` and redeploy. Do **not** roll the cache
prefixes backward — let the new prefix accumulate flag-off scores. The scorer
returns the empty-data shape regardless of prefix, so rolling back creates a
second cache migration for no benefit. Capture a rollback snapshot for the
post-mortem.

Score, ranking, and interval payloads carry `_educationState` metadata, and
history members carry the same state in their suffix. Readers reject the active
state after rollback, so a `false` deployment cannot reuse active scores,
rankings, sensitivity bands, or trend points while the new state warms.
The interval publisher also refuses generations below 180 records. An accepted
generation replaces the full rankable-country keyspace atomically, deleting
omitted keys so old-state intervals cannot survive a partial refresh. It also
requires the `US` interval used by public and seed health as the fixed data
probe; a generation cannot advance metadata while that probe is absent.

## Pre-deploy validation — 2026-08-11

### Why the default and not an env var

Energy v2 and `financialSystemExposure` both keep a `?? 'false'` code default
and flip through the production environment. Education uses a code default
because activation changes the committed methodology and CI coverage contract
together. The explicit rollback remains safe without removing `education` from
`RESILIENCE_FLAG_DARK_WHEN_ZERO_COVERAGE`: the set excludes only the unique
`coverage=0`, `observedWeight=0`, `imputedWeight=0` placeholder. Active rows and
source failures carry weight and remain visible in coverage calculations.

Keeping the default at `false` would therefore have required the env var in
**both** the CI workflow and Vercel, splitting "is education on" across two
config surfaces that can silently disagree. The default is now `true` and the
env var is the rollback kill switch — the same rollback story, inverted in which
direction needs the explicit setting.

### Measured acceptance

Harness: `scripts/dry-run-resilience-education-flip.mjs` (read-only, CI-guarded,
196 countries against production seeds, one shared read cache across both passes
so baseline and proposed see byte-identical inputs).

| Gate | Threshold | Measured (pillar-combined) |
|---|---|---|
| `gate-1-spearman` | >= 0.85 | 1.00 |
| `gate-2-country-drift` | &lt;= 15 | 3.45 (VU) |
| `gate-6-cohort-median` | &lt;= 10 | −1.08 (fragile-states) |
| `gate-7-matched-pair` | all hold | 9/9 hold after audited `in-vs-za` rebaseline; gap 1.77, min 1 |
| `gate-9-effective-influence` | >= 80% Core | 92.16% (47/51) |

Education pairs post-flip: `pt-vs-uz` 5.84 (min 3), `es-vs-by` 9.01 (min 3),
`ch-vs-tm` 28.28 (min 5). Southern-Europe cohort: PT −0.55, ES −0.29, IT −0.29,
MT −0.43, GR +0.12 — inside the ~1.5-point taste bound.

### Matched-pair rebaseline and weight fallback

The pre-agreed fallback (halve 0.5 → 0.25 if a flip causes a gate failure) was
measured and was not applied. The 2026-08-11 flag-off audit already put
`in-vs-za` below its old 3-point floor at 2.54; education moved it to 1.77. The
threshold, not the education scorer, was stale. #6466 rebaselines the pair to a
1-point positive floor, matching other deliberately narrow whole-index peers.
This is not a current-value waiver: the measured proposal keeps 0.77 points of
headroom, and a near-tie or inversion still fails. The rationale and measured
baseline/proposal are pinned in `tests/resilience-cohort-config.test.mts`.

A fresh read-only rerun on 2026-08-12 was correctly rejected before verdict
because unrelated `socialCohesion` and `stateContinuity` source-failure states
made the absolute matched-pair gate invalid. No new acceptance artifact was
created from that degraded run. Re-run after source health recovers; step 5
remains the authoritative post-deploy completion gate.

### A trap this runbook did not anticipate

Step 1 says to confirm the seeder is publishing via `seed-meta` freshness. **A
fresh `seed-meta` key is not proof its Railway producer ran.** This exact key was
hand-primed by a local run at 05:32:23Z on 2026-08-11 and read as a satisfied
precondition; the genuine bundle publish came later, at 08:03:25Z. Worse, the
primed key *suppressed* the real producer, because `_bundle-runner.mjs` skips a
section when `elapsed < intervalMs * 0.8` — 5.6 days at a 7-day interval.

Prove a publish three ways instead: sibling parity across the bundle's other
members, `git cat-file -e <runningSha>:scripts/<seeder>.mjs` against the
service's running commit, and a TTL cross-check that dates the write
independently of the payload's own claims.
