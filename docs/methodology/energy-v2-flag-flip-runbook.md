# PR 1 energy-v2 flag-flip runbook

Operational procedure for graduating the v2 energy construct from flag-off
(default shipped in PR #3289) to flag-on. Production is now post-flip; keep
the historical procedure for rollback/audit context and use the closeout
section below to finish the acceptance artifact gap.

## Post-flip closeout status

2026-06-02 live audit evidence:

- `https://www.worldmonitor.app/api/resilience/v1/get-runtime-manifest`
  returned HTTP 200 with `formulaTag: "pc"` and
  `constructVersions.energy: "v2"` when requested with a browser-like
  user agent.
- `https://www.worldmonitor.app/api/health` returned HTTP 200. The overall
  health status was `DEGRADED` due to unrelated checks, but all three
  energy v2 seed checks were green: `lowCarbonGeneration`,
  `fossilElectricityShare`, and `powerLosses`.

The post-flip ranking and acceptance snapshots are still not committed in
`docs/snapshots/`. They cannot be generated from an unauthenticated shell:
`scripts/freeze-resilience-ranking.mjs` verifies score anchors through
`/api/resilience/v1/get-resilience-score`, which returns `401 Pro
authentication required` without `WORLDMONITOR_API_KEY`. The dedicated
energy-v2 acceptance generator now exists at
`scripts/capture-resilience-energy-v2-acceptance.mjs`, but it requires a real
post-flip PR1 ranking snapshot before it will write
`resilience-energy-v2-acceptance-*`. Do not use
`scripts/compare-resilience-current-vs-proposed.mjs` for the acceptance
artifact: that script compares the legacy six-domain aggregate against the
pillar-combined formula and is not an energy-v2 post-flip acceptance harness.

2026-06-04 R7-ACCEPT adjudication update:

- Public runtime evidence remains post-flip: `/api/resilience/v1/get-runtime-manifest`
  returned HTTP 200 with `formulaTag: "pc"`, `constructVersions.energy: "v2"`,
  `rankingCache.count == rankingCache.scored == rankingCache.total == 196`, and
  `intervals.available: true`.
- `/api/health` returned HTTP 200 with overall status `DEGRADED` due to
  unrelated checks, while the energy-v2 seed checks remained `OK` for
  `lowCarbonGeneration`, `fossilElectricityShare`, and `powerLosses`.
- Credentialed live ranking evidence later on 2026-06-04 showed the stale
  whole-index anchors explicitly: `DE 62.35 > FR 59.93` and
  `CH 75.88 > SG 56.74`. Those directions are consistent with the active
  pillar-combined CRI, where France's energy-dimension advantage and
  Singapore's SWF buffer are real but do not dominate the six-domain
  whole-index score.
- The matched-pair configuration now encodes the current whole-index anchors as
  `de-vs-fr` and `ch-vs-sg`. If a future audit needs to test the PR 1 energy
  mechanism directly, use credentialed sampled score-endpoint
  `domains[].dimensions[]` evidence for the `energy` dimension rather than
  reversing the overall-score pair direction.

### What can be verified without secrets

The public runtime state can be rechecked without credentials, but that is not
enough to create either acceptance artifact:

```bash
node --input-type=module -e 'const ua="Mozilla/5.0"; const base="https://www.worldmonitor.app"; const read=async (p)=>(await fetch(base+p,{headers:{"user-agent":ua,accept:"application/json"}})).json(); const [manifest,health]=await Promise.all([read("/api/resilience/v1/get-runtime-manifest"),read("/api/health")]); console.log(JSON.stringify({formulaTag:manifest.formulaTag,constructEnergy:manifest.constructVersions?.energy,rankingCache:manifest.rankingCache,energyV2SeedChecks:{lowCarbonGeneration:health.checks?.lowCarbonGeneration?.status,fossilElectricityShare:health.checks?.fossilElectricityShare?.status,powerLosses:health.checks?.powerLosses?.status}},null,2));'
```

Expected public evidence after the flip:

- manifest: `formulaTag == "pc"`, `constructVersions.energy == "v2"`,
  and `rankingCache.count == rankingCache.scored == rankingCache.total == 196`
- health: `lowCarbonGeneration`, `fossilElectricityShare`, and `powerLosses`
  are `OK`

The ranking and formula-anchor endpoints still require Pro/API auth:

```bash
API_BASE=https://www.worldmonitor.app \
  RESILIENCE_RANKING_REFRESH=false \
  node scripts/freeze-resilience-ranking.mjs
# Expected without WORLDMONITOR_API_KEY:
# HTTP 401 from /api/resilience/v1/get-resilience-score?... Pro authentication required
```

Treat the public manifest/health check as audit context only. Do not rename it
into a ranking snapshot and do not use it as acceptance evidence.

### Required operator artifact capture

Run from the repo root with production credentials:

```bash
export API_BASE=https://www.worldmonitor.app
export WORLDMONITOR_API_KEY=<pro-api-key>
export CAPTURE_DATE=$(date -u +%Y-%m-%d)
export RESILIENCE_RANKING_OUTPUT_BASENAME=resilience-ranking-live-post-pr1-${CAPTURE_DATE}.json
# Defaults to FR,DE,SG,CH,NO,CA,AE,BH; set explicitly only to override.
export RESILIENCE_ENERGY_V2_SAMPLE_COUNTRIES=FR,DE,SG,CH,NO,CA,AE,BH

node scripts/freeze-resilience-ranking.mjs

jq '.formulaVerification.declaredFormula' \
  "docs/snapshots/resilience-ranking-live-post-pr1-${CAPTURE_DATE}.json"

node --import tsx/esm scripts/capture-resilience-energy-v2-acceptance.mjs

git add \
  docs/snapshots/resilience-ranking-live-post-pr1-*.json \
  docs/snapshots/resilience-energy-v2-acceptance-*.json
```

Commit the ranking artifact only if the snapshot verifies the declared
formula. The matching `resilience-energy-v2-acceptance-{date}.json` artifact
is written by `scripts/capture-resilience-energy-v2-acceptance.mjs` only after
it can read a real `resilience-ranking-live-post-pr1-{date}.json`, compare it
against the prior ranking baseline using the PR 1 gates (Spearman, country
drift, cohort median, matched-pair directions, and effective influence), and
verify the live manifest/health state above. If the script exits non-zero, do
not commit a synthetic acceptance JSON; attach the emitted gate details to the
resilience closeout issue.

### Energy-v2 acceptance artifact contract

The committed JSON must be named
`docs/snapshots/resilience-energy-v2-acceptance-{date}.json`, must be written
by `scripts/capture-resilience-energy-v2-acceptance.mjs`, and must not be the
output of `scripts/compare-resilience-current-vs-proposed.mjs`. The minimum
machine-checkable shape is:

```json
{
  "artifactType": "resilience-energy-v2-post-flip-acceptance",
  "generatedAt": "2026-06-02T00:00:00.000Z",
  "capturedAt": "2026-06-02",
  "runtime": {
    "manifest": {
      "formulaTag": "pc",
      "constructVersions": { "energy": "v2" },
      "rankingCache": { "count": 196, "scored": 196, "total": 196 }
    },
    "health": {
      "energyV2SeedChecks": {
        "lowCarbonGeneration": "OK",
        "fossilElectricityShare": "OK",
        "powerLosses": "OK"
      }
    }
  },
  "baseline": {
    "rankingSnapshot": "docs/snapshots/resilience-ranking-live-pre-pr1-flip-YYYY-MM-DD.json"
  },
  "postFlip": {
    "rankingSnapshot": "docs/snapshots/resilience-ranking-live-post-pr1-YYYY-MM-DD.json"
  },
  "acceptanceGates": {
    "verdict": "PASS",
    "results": [
      { "id": "gate-1-spearman", "status": "pass" },
      { "id": "gate-2-country-drift", "status": "pass" },
      { "id": "gate-6-cohort-median", "status": "pass" },
      { "id": "gate-7-matched-pair", "status": "pass" },
      { "id": "gate-9-effective-influence-baseline", "status": "pass" }
    ]
  }
}
```

If the credentialed ranking snapshot is unavailable or the dedicated
acceptance harness exits non-zero, attach this exact closeout status to the
resilience issue instead of committing placeholder JSON:

```text
Energy v2 is live: manifest formulaTag=pc, constructVersions.energy=v2,
rankingCache=196/196, and health is OK for lowCarbonGeneration,
fossilElectricityShare, and powerLosses.

Artifact status: BLOCKED. docs/snapshots/resilience-ranking-live-post-pr1-*.json
requires WORLDMONITOR_API_KEY because freeze-resilience-ranking verifies score
anchors through get-resilience-score. docs/snapshots/resilience-energy-v2-acceptance-*.json
is also blocked until scripts/capture-resilience-energy-v2-acceptance.mjs can
read that ranking snapshot and return PASS. No synthetic snapshots committed.
```

Follow the original gated procedure below for future rollback/replay drills.

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
4. **Acceptance-gate rerun with flag-off.** Use the dedicated energy-v2
   acceptance harness. Do not use
   `scripts/compare-resilience-current-vs-proposed.mjs` for this step; that
   script validates pillar-combine activation, not energy-v2 acceptance.

## Flip procedure

1. **Capture a pre-flip snapshot.**
   ```bash
   API_BASE=<flag-off-deployment-url> \
     WORLDMONITOR_API_KEY=<pro-api-key> \
     node scripts/freeze-resilience-ranking.mjs
   mv "docs/snapshots/resilience-ranking-$(date +%Y-%m-%d).json" \
     "docs/snapshots/resilience-ranking-live-pre-pr1-flip-$(date +%Y-%m-%d).json"
   git add docs/snapshots/resilience-ranking-live-pre-pr1-flip-*.json
   git commit -m "chore(resilience): pre-PR-1-flip baseline snapshot"
   ```
2. **Dry-run the flag flip locally.**
   Run the dedicated energy-v2 acceptance harness against production-seeded
   data. Every gate must be `pass`. If any is `fail`, STOP and debug before
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
   After deploy, verify the public runtime manifest reports the derived
   construct state without exposing the raw env flag:
   ```bash
   curl -s https://worldmonitor.app/api/resilience/v1/get-runtime-manifest \
     | jq '.constructVersions.energy'
   # Expected: "v2"
   ```

5. **Capture the post-flip snapshot** immediately after the first
   post-deploy ranking refresh completes (check via
   `GET resilience:ranking:v11` in Redis):
   ```bash
   CAPTURE_DATE=$(date -u +%Y-%m-%d)
   API_BASE=https://www.worldmonitor.app \
     WORLDMONITOR_API_KEY=<pro-api-key> \
     RESILIENCE_RANKING_OUTPUT_BASENAME=resilience-ranking-live-post-pr1-${CAPTURE_DATE}.json \
     node scripts/freeze-resilience-ranking.mjs
   jq '.formulaVerification.declaredFormula' \
     "docs/snapshots/resilience-ranking-live-post-pr1-${CAPTURE_DATE}.json"
   git add docs/snapshots/resilience-ranking-live-post-pr1-*.json
   git commit -m "chore(resilience): post-PR-1 snapshot"
   ```

   Capture the matching acceptance verdict in the same closeout batch:
   ```bash
   API_BASE=https://www.worldmonitor.app \
     WORLDMONITOR_API_KEY=<pro-api-key> \
     node --import tsx/esm scripts/capture-resilience-energy-v2-acceptance.mjs
   ```

   Do not use `scripts/compare-resilience-current-vs-proposed.mjs` here; it
   validates pillar-combine activation, not energy-v2 acceptance. The closeout
   artifact should be written as
   `docs/snapshots/resilience-energy-v2-acceptance-{date}.json`, report
   `.acceptanceGates.verdict == "PASS"`, and be committed with the post-flip
   ranking snapshot.

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

The energy-v2 flag flip uses the PR 1 acceptance-gate names below. The
checked-in `scripts/compare-resilience-current-vs-proposed.mjs` script does not
generate this verdict because it validates pillar-combine activation, not
energy-v2 acceptance. Use this table as the contract for the dedicated
energy-v2 harness and the eventual
`docs/snapshots/resilience-energy-v2-acceptance-{date}.json` artifact:

| Verdict | Meaning | Action |
|---|---|---|
| `PASS` | All gates pass | Proceed with flag flip |
| `CONDITIONAL` | Some gates skipped (baseline missing, etc.) | Fix missing inputs before flipping |
| `BLOCK` | At least one gate failed | Do NOT flip; investigate failure |

Stash the full `acceptanceGates` block in PR comments or the closeout issue
when the flip evidence is recorded.
