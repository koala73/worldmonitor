# Education dimension flag-flip runbook

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
   # fetchedAt within the last 8 days, recordCount >= 175
   ```
   The validation floor in the seeder is 150, deliberately lower than the
   measured 181 so a transient World Bank dip does not poison seed-meta. The
   flip gate is the stricter 175 — a payload between 150 and 175 is healthy
   enough to publish but not healthy enough to activate on.

2. **Health green.** `/api/health` reports OK for `educationAttainment`. The key
   is registered STRICT SEED_META, so it reports CRIT (not WARN) while the
   bundle is unprovisioned. That alarm is intended.

3. **Registry tier promoted.** Change the `femaleUpperSecondaryAttainment` entry
   in `_indicator-registry.ts` from `tier: 'experimental'` to `tier: 'core'`.
   Until this happens the indicator is excluded from both the weight-sum
   invariant and the coverage-influence gate, so neither is actually exercising
   it. Measured coverage is 181 against a 137 floor, so the gate passes with
   44 countries of headroom.

4. **EXTRACTION_RULES implemented.** `scripts/compare-resilience-current-vs-proposed.mjs`
   currently carries `femaleUpperSecondaryAttainment` as `not-implemented`.
   **This must be implemented before the flip.** With the dim dark it extracts
   nothing and that is correct; once education carries real weight, a
   `not-implemented` row means gate-9 effective-vs-nominal influence evidence
   silently omits it — a green acceptance verdict computed over a formula the
   harness cannot see. Wire `resilience:education-attainment:v1` into the bulk
   payload load and extract `countries[iso2].value`.

5. **Cache prefixes bumped in lockstep.** This was deliberately NOT done in the
   scaffold PR, because while dark the dimension changes no published score:
   the coverage-weighted mean drops a `coverage=0` dimension, and the dark dim
   is excluded from the confidence mean, so overall score, coverage, and
   `imputationShare` are all identical to pre-change. At flip that stops being
   true and the rotation becomes mandatory — adding a dimension shifts every
   country's baseline, and mixing pre- and post-change points inside the 30-day
   rolling window manufactures false trends.

   Nine files carry these literals and eight hand-copy them:
   ```bash
   grep -rln "resilience:score:v25\|resilience:ranking:v25\|resilience:history:v20" \
     --include='*.mjs' --include='*.ts' --include='*.js' --include='*.mts' . | grep -v node_modules
   ```
   Bump score `v25`→`v26`, ranking `v25`→`v26`, history `v20`→`v21` in every
   hit, then re-run the grep against the new values to confirm none was missed.
   Leaving one behind is worse than not bumping: `benchmark-resilience-external.mjs`,
   `validate-resilience-correlation.mjs`, and `backtest-resilience-outcomes.mjs`
   produce the acceptance evidence, so a stale prefix there reads an abandoned
   namespace and returns a green verdict with no signal.

6. **Remove the dark allow-list entry.** Drop `'education'` from
   `FLAG_GATED_DARK_DIMENSIONS` in `tests/resilience-release-gate.test.mts` and
   from `RESILIENCE_FLAG_DARK_WHEN_ZERO_COVERAGE` in `_dimension-scorers.ts`.
   Leaving them in place would keep a live dimension excluded from the
   confidence mean, understating real coverage gaps.

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
   implemented, cache prefixes bumped, dark allow-list entries removed.

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
