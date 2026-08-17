# Financial System Exposure Flag-Flip Runbook

This is the retroactive closeout runbook for `financialSystemExposure` activation tracked in #6511.

## Current state

- `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=true` is live in Vercel production as of 2026-08-12.
- The code default remains `false`. CI and an operator rollback therefore use the flag-off, empty-data shape.
- #6461 is already closed by #6515. Do not reopen or reprioritize it.
- The committed acceptance artifact is the required production evidence. A dry run, a code diff, or a healthy CI result is not a substitute for that artifact.

## Preflight

Run these checks from a clean checkout with the production Upstash credentials available through the normal ignored environment files. Do not print credential values.

1. Confirm the three required seed envelopes and their `seed-meta` records are present and fresh:

   ```text
   seed-meta:economic:wb-external-debt
   seed-meta:economic:bis-lbs
   seed-meta:economic:fatf-listing
   ```

2. Confirm the health endpoint reports the three inputs as healthy. A missing, malformed, empty, or stale envelope is a stop condition.
3. Run the directional calibration gates for the sanctions cohort and the #6461 residual cases:

   ```bash
   node --import tsx/esm --test \
     tests/resilience-financial-system-exposure-calibration.test.mts \
     tests/resilience-financial-system-exposure.test.mts
   ```

4. Confirm the source tree is clean. The capture records the exact harness commit and refuses to write an artifact from a dirty tracked tree.

## Cache rotation

The activation changes the formula and must not share numeric caches with the education-only state. Rotate all four current generations:

| Cache family | Before | Current |
|---|---:|---:|
| Score | `v27` | `v28` |
| Ranking | `v27` | `v28` |
| History | `v21` | `v22` |
| Intervals | `v10` | `v11` |

Verify every claimed file type, including both Markdown locales:

```bash
grep -rln "resilience:score:v27\|resilience:ranking:v27\|resilience:history:v21\|resilience:intervals:v10" \
  --include='*.mjs' --include='*.ts' --include='*.js' --include='*.mts' \
  --include='*.mdx' --include='*.md' . | grep -v node_modules
```

This command is a review aid. Historical bump chains and historical snapshots may retain old generations. The live code, health mirrors, tests, and current methodology tables must use `v28`, `v22`, and `v11`. The zh methodology table is hand-maintained.

## Read-only production acceptance capture

After the cache-rotation commit is pushed or otherwise fixed in a clean checkout, run:

```bash
CAPTURE_DATE="$(date -u +%F)"
FIN_SYS_ACCEPTANCE_OUTPUT="docs/snapshots/resilience-financial-system-exposure-acceptance-${CAPTURE_DATE}.json" \
  node --import tsx/esm scripts/dry-run-resilience-financial-system-exposure-flip.mjs
```

The harness reads the full sovereign universe and the required production Redis payloads once, then scores a flag-off counterfactual and a flag-on arm from the same inputs. It does not write Redis. It writes the artifact only when all required reads resolve and the acceptance gates pass:

- Spearman rank correlation is at least `0.85`.
- At least `60%` of countries have absolute overall movement below `3` points.
- No non-sanctions country moves by more than `12` overall points.

The artifact must include the harness commit, source-input digest, resolved Redis key count, current cache namespaces, per-country rows, representative countries, headline-eligibility changes, and any finance source-failure rows. Record broader source-health caveats from the capture logs in the closeout documentation; do not infer all-source health from a passing score gate.

If credentials are unavailable, a required Redis read is unresolved, or a gate fails, stop. Do not retry a claimed capture, fill missing rows, mix a different cohort, or commit a synthetic artifact. Record the blocker in the issue or release notes and keep the flag rollback available.

Validate the committed result:

```bash
node --import tsx/esm --test tests/resilience-financial-system-exposure-activation.test.mts
jq '{artifactType, measuredAt, universeSize, cacheNamespaces, acceptanceGates, productionState, representativeCountries}' \
  "docs/snapshots/resilience-financial-system-exposure-acceptance-${CAPTURE_DATE}.json"
```

## Rollback

If the preflight, health, directional, or acceptance gate fails after activation:

1. Set `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=false` in the production environment.
2. Do not rotate the namespaces backward. The code's flag-off path ignores the finance dimension while the `v28` namespaces remain isolated.
3. Repair the seed data or scorer defect, rerun the focused gates, and make a new read-only capture. Do not reuse the failed artifact.

## Closeout

Update [the construct methodology](./financial-system-exposure.md) with the artifact filename and measured gate values. Confirm the current health view and cache generations. Keep #6461 unchanged because #6515 already closed it. This runbook closes the operational protocol; it does not authorize a production merge or a flag change beyond the stated operator action.
