# PR 1 energy-v2 flag-flip runbook

Operational procedure for graduating the v2 energy construct from flag-off
(default shipped in PR #3289) to flag-on. Follow this runbook in order;
each step is gated by the previous step's success.

## Pre-flip checklist

All must be green before flipping `RESILIENCE_ENERGY_V2_ENABLED=true`:

1. **Seeders provisioned and green.** Railway cron service
   `seed-bundle-resilience-energy-v2` deployed, cron schedule
   `0 6 * * 1` (Monday 06:00 UTC, weekly). First clean run has landed
   for all three keys:
   ```bash
   redis-cli --url $REDIS_URL GET seed-meta:resilience:low-carbon-generation
   redis-cli --url $REDIS_URL GET seed-meta:resilience:fossil-electricity-share
   redis-cli --url $REDIS_URL GET seed-meta:resilience:power-losses
   # fetchedAt within the last 8 days, recordCount >= 150 for each
   ```
2. **Health endpoint green for all three keys.** `/api/health` reports
   `HEALTHY` with the three keys in the `lowCarbonGeneration`,
   `fossilElectricityShare`, `powerLosses` slots. If any shows
   `EMPTY_DATA` or `STALE_SEED`, the flag cannot flip.
3. **Health-registry state (no code change needed at flip time).** Per
   plan `2026-04-24-001` the three v2 seed labels are already STRICT
   `SEED_META` entries — NOT in `ON_DEMAND_KEYS`. `/api/health` reports
   CRIT on absent/stale data from the moment the Railway bundle is
   provisioned. No "graduation" step is required at flag-flip time;
   this transitional posture was removed before the flag-flip activation
   path to keep the scorer and health layers in fail-closed lockstep
   (scorer throws `ResilienceConfigurationError` → source-failure;
   health reports CRIT; both surface the gap independently).
4. **Acceptance-gate rerun with flag-off.** Baseline Spearman vs the
   PR 0 freeze must remain 1.0000:
   ```bash
   node --import tsx/esm scripts/compare-resilience-current-vs-proposed.mjs \
     > /tmp/pre-flip-flag-off.json
   jq '.acceptanceGates.verdict' /tmp/pre-flip-flag-off.json
   # Expected: "PASS" (or "CONDITIONAL" if baseline is missing; confirm
   # baseline file exists in docs/snapshots/ and re-run).
   ```

## Flip procedure

1. **Capture a pre-flip snapshot.**
   ```bash
   RESILIENCE_ENERGY_V2_ENABLED=false \
     node --import tsx/esm scripts/freeze-resilience-ranking.mjs \
     --label "live-pre-pr1-flip-$(date +%Y-%m-%d)" \
     --output docs/snapshots/
   git add docs/snapshots/resilience-ranking-live-pre-pr1-flip-*.json
   git commit -m "chore(resilience): pre-PR-1-flip baseline snapshot"
   ```
2. **Dry-run the flag flip locally.**
   ```bash
   RESILIENCE_ENERGY_V2_ENABLED=true \
     node --import tsx/esm scripts/compare-resilience-current-vs-proposed.mjs \
     > /tmp/flag-on-dry-run.json
   jq '.acceptanceGates' /tmp/flag-on-dry-run.json
   ```
   Every gate must be `pass`. If any is `fail`, STOP and debug before
   proceeding. Check in order:
   - `gate-1-spearman`: Spearman vs baseline ≥ 0.85
   - `gate-2-country-drift`: max country drift ≤ 15 points
   - `gate-6-cohort-median`: cohort median shift ≤ 10 points
   - `gate-7-matched-pair`: every matched pair holds expected direction
   - `gate-9-effective-influence-baseline`: ≥ 80% Core indicators measurable

3. **Bump the score-cache prefix.** Add a new commit to this branch
   bumping `RESILIENCE_SCORE_CACHE_PREFIX` from `v10` to `v11` in
   `server/worldmonitor/resilience/v1/_shared.ts`. This guarantees the
   flag flip does not serve pre-flip cached scores from the 6h TTL
   window. Without this bump, the next 6h of readers would see stale
   d6-formula scores even with the flag on.

4. **Flip the flag in production.**
   ```bash
   vercel env add RESILIENCE_ENERGY_V2_ENABLED production
   # Enter: true
   # (or via Vercel dashboard → Settings → Environment Variables)
   vercel deploy --prod
   ```

5. **Capture the post-flip snapshot** immediately after the first
   post-deploy ranking refresh completes (check via
   `GET resilience:ranking:v11` in Redis):
   ```bash
   node --import tsx/esm scripts/freeze-resilience-ranking.mjs \
     --label "live-post-pr1-$(date +%Y-%m-%d)" \
     --output docs/snapshots/
   git add docs/snapshots/resilience-ranking-live-post-pr1-*.json
   git commit -m "chore(resilience): post-PR-1 snapshot"
   ```

6. **Update construct-contract language.** In
   `docs/methodology/country-resilience-index.mdx`, move items 1, 2,
   and 3 of the "Known construct limitations" list from "landing in
   PR 1" to "landed in PR 1 vYYYY-MM-DD." Flip the energy domain
   section to describe v2 as the default construct, with the legacy
   construct recast as the emergency-rollback path.

## Rollback procedure

If any acceptance gate fails post-flip or a reviewer flags a regression:

1. **Flip the flag back.**
   ```bash
   vercel env rm RESILIENCE_ENERGY_V2_ENABLED production
   # OR
   vercel env add RESILIENCE_ENERGY_V2_ENABLED production  # enter: false
   vercel deploy --prod
   ```
2. **Do NOT bump the cache prefix back to v10.** Let the v11 prefix
   accumulate flag-off scores. The legacy scorer produces d6-formula
   scores regardless of the prefix version, so rolling the prefix
   backward is unnecessary and creates a second cache-key migration.
3. **Capture a rollback snapshot** for post-mortem.

## Acceptance-gate verdict reference

Generated by `scripts/compare-resilience-current-vs-proposed.mjs`:

| Verdict | Meaning | Action |
|---|---|---|
| `PASS` | All gates pass | Proceed with flag flip |
| `CONDITIONAL` | Some gates skipped (baseline missing, etc.) | Fix missing inputs before flipping |
| `BLOCK` | At least one gate failed | Do NOT flip; investigate failure |

The verdict is computed on every invocation of the compare script.
Stash the full `acceptanceGates` block in PR comments when the flip
happens.
