# Country Resilience Audit - 2026-06-04

Current-state audit note for Country Resilience Index follow-up after PRs
#4077 through #4086. This file replaces the stale local round-7 audit framing
that was based on `origin/main@6d33a9b8a`; the requested
`docs/internal/country-resilience-audit-2026-06-04.md` did not exist on current
`origin/main`, so this note records the verified repo truth instead of
carrying those findings forward as open work.

## Source State

- Branch inspected: `origin/main` at `eae7068f5` (`Surface social velocity seed
  failures (#4084)`), with PRs #4077 through #4086 present in the recent log.
- Methodology source: `docs/methodology/country-resilience-index.mdx`.
- Open acceptance runbook: `docs/methodology/energy-v2-flag-flip-runbook.md`.
- Snapshot directory inspected: `docs/snapshots/`.

## Closed Stale Findings

These findings are closed in the current repo state and should not be listed as
open audit work.

Label crosswalk: `DA-*` covers the methodology/data-audit P-number findings,
`PT-*` covers the parity-test P-number findings, `FE-*` covers the
frontend/widget P-number findings, and `R7-ACCEPT` keeps the runbook label.

### DA-1 through DA-5

The DA rows reviewed in this pass now match the active scorer and registry
expectations for the listed items:

- Health & Public Service lists five active indicators:
  `uhcIndex`, `measlesCoverage`, `hospitalBeds`, `physiciansPer1k`, and
  `healthExpPerCapitaUsd`.
- Infrastructure includes `broadband`.
- `unrestEvents` is documented with `10 - 0` goalposts.
- `ucdpConflict` is documented with `15 - 0` goalposts.
- `trend` is documented as `rising`, `stable`, or `falling`.

This does not assert full methodology parity across all audit P-numbers;
inflation-band P3-2 and AQUASTAT P3-5 remain outside this note until their
dedicated fixes land.

Evidence files:

- `docs/methodology/country-resilience-index.mdx`
- `tests/helpers/resilience-scorer-doc-parity-specs.mts`
- `tests/resilience-doc-parity.test.mts`
- `tests/resilience-indicator-registry.test.mts`

Verification commands:

```bash
rg -n "broadband|unrestEvents|ucdpConflict|healthExpPerCapitaUsd|rising|stable|falling" \
  docs/methodology/country-resilience-index.mdx

npx tsx --test \
  tests/resilience-doc-parity.test.mts \
  tests/resilience-indicator-registry.test.mts
```

### PT-1 and PT-2

The scorer, methodology documentation, and indicator registry parity checks are
now shared through `tests/helpers/resilience-scorer-doc-parity-specs.mts`.
Those specs are consumed by both the doc parity and registry tests, so PT-1 and
PT-2 are no longer open audit gaps.

Evidence files:

- `tests/helpers/resilience-scorer-doc-parity-specs.mts`
- `tests/resilience-doc-parity.test.mts`
- `tests/resilience-indicator-registry.test.mts`

Verification command:

```bash
npx tsx --test \
  tests/resilience-doc-parity.test.mts \
  tests/resilience-indicator-registry.test.mts
```

### FE-1 through FE-4

The country deep-dive resilience widget lazy-load path is now guarded and
tested:

- `CountryDeepDivePanel` loads `ResilienceWidget` through
  `import("@/components/ResilienceWidget").then(...).catch(renderFallback)`.
- The fallback uses the i18n key `countryBrief.resilienceScoreUnavailable`,
  not a hardcoded user-facing string.
- Lazy-load failure telemetry is captured through Sentry breadcrumbs and
  exceptions.
- Import rejection, constructor throw, and `getElement()` throw cases are
  covered in `tests/resilience-country-brief.test.mjs`.
- The auth-refresh loop guard normalizes malformed server `countryCode` values,
  covered in `tests/resilience-widget.test.mts`.

Evidence files:

- `src/components/CountryDeepDivePanel.ts`
- `src/components/ResilienceWidget.ts`
- `tests/resilience-country-brief.test.mjs`
- `tests/resilience-widget.test.mts`

Verification command:

```bash
npx tsx --test \
  tests/resilience-country-brief.test.mjs \
  tests/resilience-widget.test.mts
```

## Current Runtime Evidence

Public runtime evidence remains healthy for the CRI energy-v2 surface, but this
is audit context only. It is not a substitute for committed post-flip acceptance
artifacts.

Command run on 2026-06-04:

```bash
node --input-type=module -e 'const ua="Mozilla/5.0"; const base="https://www.worldmonitor.app"; const read=async (p)=>(await fetch(base+p,{headers:{"user-agent":ua,accept:"application/json"}})).json(); const [manifest,health]=await Promise.all([read("/api/resilience/v1/get-runtime-manifest"),read("/api/health")]); console.log(JSON.stringify({formulaTag:manifest.formulaTag,constructEnergy:manifest.constructVersions?.energy,rankingCache:manifest.rankingCache,intervals:manifest.intervals,healthStatus:health.status,energyV2SeedChecks:{lowCarbonGeneration:health.checks?.lowCarbonGeneration?.status,fossilElectricityShare:health.checks?.fossilElectricityShare?.status,powerLosses:health.checks?.powerLosses?.status,resilienceIntervals:health.checks?.resilienceIntervals?.status}},null,2));'
```

Observed result:

- `formulaTag: "pc"`
- `constructEnergy: "v2"`
- `rankingCache.count == rankingCache.scored == rankingCache.total == 196`
- `intervals.available: true`
- `/api/health` overall status was `DEGRADED` due to unrelated checks.
- `lowCarbonGeneration`, `fossilElectricityShare`, `powerLosses`, and
  `resilienceIntervals` were all `OK`.

## Remaining Validated Open Work

### R7-ACCEPT: Real Post-Flip Acceptance Artifacts Missing

Status: open.

The repo still lacks committed real post-flip acceptance artifacts:

```bash
find docs/snapshots -maxdepth 1 -name 'resilience-ranking-live-post-pr1-*.json' -print
find docs/snapshots -maxdepth 1 -name 'resilience-energy-v2-acceptance-*.json' -print
```

Both commands returned no files on current `origin/main`.

Required evidence:

- `docs/snapshots/resilience-ranking-live-post-pr1-{date}.json`
- `docs/snapshots/resilience-energy-v2-acceptance-{date}.json`

Do not synthesize these files. `scripts/freeze-resilience-ranking.mjs` verifies
score anchors through `/api/resilience/v1/get-resilience-score`, which requires
`WORLDMONITOR_API_KEY`. The operator path and exact commands are documented in
`docs/methodology/energy-v2-flag-flip-runbook.md`.

Acceptance is closed only after those real artifacts are captured with
production credentials, committed under `docs/snapshots/`, and accepted by the
artifact schema tests.

Verification command after artifacts are captured:

```bash
npx tsx --test tests/resilience-validation-artifacts-schema.test.mts
```

## Audit Conclusion

DA-1 through DA-5, PT-1 through PT-2, and FE-1 through FE-4 are closed stale
findings in current `origin/main`. The only validated open Country Resilience
audit item from this pass is R7-ACCEPT: the missing real post-flip ranking and
energy-v2 acceptance artifacts in `docs/snapshots/`.
