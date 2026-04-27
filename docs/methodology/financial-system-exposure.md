# Financial System Exposure — construct definition

**Status**: Active (added in plan 2026-04-25-004 Phase 2 — Ship 2)
**Dimension ID**: `financialSystemExposure`
**Domain**: `economic` (weight 0.50 within domain)
**Type**: `stress`
**Rollout**: Flag-gated dark behind `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED` until component seeders are populating in production.

## Question answered

**How vulnerable is country X's financial system to coordinated action by major Western banking jurisdictions, AML/CFT enforcement bodies, and short-term external-debt rollover risk?**

This dimension replaces the structural-exposure half of the dropped OFAC-domicile component (Ship 1) with a four-component composite built from audited cross-border banking + AML/CFT data. Where the OFAC count conflated transit-hub corporate domicile with host-country risk (penalizing financial centers like UAE, Singapore, Hong Kong for shell-entity behavior), this dimension uses sources that measure actual sovereign vulnerability.

## Composition

```
financialSystemExposure = weightedBlend([
  { signal: short_term_external_debt_pct_gni,  weight: 0.35 },
  { signal: bis_lbs_xborder_us_eu_uk_pct_gdp,  weight: 0.30 },
  { signal: fatf_listing_status,                weight: 0.20 },
  { signal: financial_center_redundancy,        weight: 0.15 },
])
```

Components 2 + 4 share the BIS CBS payload (`economic:bis-lbs:v1` — Redis key name retained for historical continuity even though the upstream dataflow is now CBS, not LBS); no separate seeder for redundancy.

### Component 1: `short_term_external_debt_pct_gni` (weight 0.35)

**Source**: World Bank International Debt Statistics (IDS).

**Composition**:
```
shortTermDebtPctGni = (DT.DOD.DSTC.CD / NY.GNP.MKTP.CD) × 100
```
Where:

- `DT.DOD.DSTC.CD` — Short-term external debt stocks (current US$)
- `NY.GNP.MKTP.CD` — GNI (current US$)

**Correction note (post-PR #3407 activation audit, 2026-04-25)**: the original draft used `DT.DOD.DSTC.IR.ZS` × `DT.DOD.DECT.GN.ZS` / 100, but `DT.DOD.DSTC.IR.ZS` is "% of total **reserves**" (NOT "% of total external debt"), so the composed result was mathematically meaningless — Argentina, Turkey, and other countries with thin reserves but moderate debt scored above 100% on the intermediate ratio. Caught by activation-time Redis audit. The fix: use absolute USD values for both numerator and denominator and divide directly.

**Why GNI, not GDP**: WB IDS publishes external-debt ratios against GNI by convention. Cross-conversion to GDP requires the `NY.GDP.MKTP.CD` × `NY.GNP.MKTP.CD` ratio, which is generally close to 1 but not identical. Stay with GNI to avoid introducing a conversion error for a signal that doesn't have a high-precision USD component anyway.

**Why not USD-only**: WB IDS does not publish currency-composition breakdowns in its public dataset. The IMF's Currency Composition of Official Foreign Exchange Reserves (COFER) is reserves-only, not external debt. To get USD-component external debt would require proprietary BIS Triennial Survey data (paid, not in the project's budget). Accepting "all foreign-currency short-term external debt" is materially-correct because USD comprises 60-65% of global foreign-currency external debt (BIS 2024 estimates) and this proportion is stable enough that the resulting score is monotone in USD-component exposure.

**Score shape**: `normalizeLowerBetter(value, 0, 15)` — IMF Article IV external-financing-vulnerability threshold is canonically 15% of GNI.

**Coverage**: ~125-190 LMICs (low- and middle-income countries) depending on the year. HIC fall through to Component 2 (BIS CBS) which has ~200-country coverage.

**Cadence**: monthly cron (WB IDS publishes annually; the cadence is for refresh-once-they-publish detection).

**Seed key**: `economic:wb-external-debt:v1`. **Seeder**: `scripts/seed-wb-external-debt.mjs`.

### Component 2: `bis_lbs_xborder_us_eu_uk_pct_gdp` (weight 0.30)

**Source**: BIS Consolidated Banking Statistics by-parent view (`WS_CBS_PUB`).

> **Correction (post-PR #3407 activation audit, 2026-04-25)**: the original draft used `WS_LBS_D_PUB` (Locational Banking Statistics) on the assumption it publishes a per-counterparty breakdown. It does not — `WS_LBS_D_PUB` only exposes counterparty as the aggregate `5J`. CBS (`WS_CBS_PUB`) is the actual dataflow that publishes by-parent foreign claims with a counterparty-country breakdown. The Redis key (`economic:bis-lbs:v1`), seeder filename, and Component-2 contract semantics are unchanged; only the upstream dataflow + dimension shape changed.

**SDMX key shape** (11 dimensions, dimension order discovered via probe of the live BIS API):
```
Q.S.<L_REP_CTY>.4B.F.C.A.A.TO1.A.<L_CP_COUNTRY>
```

| Position | Dimension | Value |
|---|---|---|
| 1 | FREQ | `Q` (quarterly) |
| 2 | L_MEASURE | `S` (stocks at end-period) |
| 3 | **L_REP_CTY** | parent country — **VARIED** across the 16 enumerated Western parents |
| 4 | CBS_BANK_TYPE | `4B` (consolidated banks) |
| 5 | CBS_BASIS | `F` (foreign claims, ultimate-risk basis) |
| 6 | L_POSITION | `C` (claims) |
| 7 | L_INSTR | `A` (all instruments) |
| 8 | REM_MATURITY | `A` (all maturities) |
| 9 | CURR_TYPE_BOOK | `TO1` (all currencies) |
| 10 | L_CP_SECTOR | `A` (all counterparty sectors) |
| 11 | **L_CP_COUNTRY** | counterparty country — **EMPTY** (returns all counterparties as separate series; verified by probe to expand correctly in CBS, unlike LBS where it collapses to the `5J` aggregate) |

The resilience question ("how exposed is country X's financial system to actions by banks whose parent is in US/UK/EU/etc.?") maps to CBS's by-parent foreign-claims view (`CBS_BASIS=F`). CBS uses `L_REP_CTY` to mean "country of the consolidated banking parent" — which is what we vary. The earlier LBS draft confusingly conflated LBS's `L_PARENT_CTY` (a separate dimension that exists but is only published in aggregate) with CBS's parent semantics.

**Parent enumeration** (per Codex R4 P1 #2 — principle survives the dataflow swap): `US`, `GB`, `DE`, `FR`, `IT`, `NL`, `ES`, `BE`, `AT`, `IE`, `LU`, `CH`, `JP`, `CA`, `AU`, `SG`. CBS uses the same `CL_BIS_IF_REF_AREA` codelist as LBS, so ISO 3166-1 alpha-2 codes pass directly.

**ISO mapping**: ISO2 codes used directly. BIS-defined aggregate codes that appear in CBS counterparty values (`5J`, `5A`, `5M`, `1C`, `1E`, `1W`, `2Z`, `3P`, `4F`, etc.) are filtered out at the iteration boundary so they don't inflate claim sums.

**GDP denominator**: World Bank `NY.GDP.MKTP.CD` (current USD), matched to the same reference year as the CBS quarter.

**Score shape**: U-shaped band-normalization (`normalizeBandLowerBetter`). Both extremes are bad — too little integration suggests financial isolation (sanctions-target jurisdictions; thin correspondent-banking access); too much suggests over-exposure to Western-bank pulls (Iceland-2008 territory). The score peaks in the "healthy diversified financial system" middle band:

| Cross-border claims (% GDP) | Score |
|---|---|
| 0% | 60 |
| < 5% (low integration) | 60-70 (linear) |
| 5-25% (sweet spot) | 75-100 (linear) |
| 25-60% (over-exposed) | 70-30 (linear) |
| > 60% (Iceland-2008 territory) | < 30, clamped 0 |

**Coverage**: ~200 jurisdictions; effectively complete for the manifest.

**Cadence**: weekly cron. BIS CBS publishes quarterly; weekly catches the publication 2-3 weeks after each quarter-end with low overhead.

**Seed key**: `economic:bis-lbs:v1` (key name retained for historical continuity even though the dataflow is now CBS — the scorer-side contract is unchanged). **Seeder**: `scripts/seed-bis-lbs.mjs`.

### Component 3: `fatf_listing_status` (weight 0.20)

**Source**: FATF official "Black and Grey Lists" page (`https://www.fatf-gafi.org/en/countries/black-and-grey-lists.html`).

This page is a STABLE entry point that links to the current publication. Each FATF plenary (3× per year) publishes a new listing document. The seeder follows the linked publication URL dynamically rather than hardcoding country names — hardcoding would silently miss new updates.

**Score shape** (discrete):
| FATF status | Score | Notes |
|---|---|---|
| Black list (call for action) | 0 | DPRK has been on every list since 2011; Iran since 2020; Myanmar since 2022 |
| Grey list (increased monitoring) | 30 | Typically 15-25 jurisdictions; rotates as countries clear FATF action plans |
| Compliant | 100 | Default for any jurisdiction not appearing on either list |

**Coverage**: 100% — FATF only enumerates non-compliant jurisdictions; every other country defaults to "compliant".

**Cadence**: monthly cron.

**Seed key**: `economic:fatf-listing:v1`. **Seeder**: `scripts/seed-fatf-listing.mjs`.

**Robustness**: parser tests with HTML fixtures. On parse failure, validate rejects the seed and the seed-meta `fetchedAt` doesn't refresh — the previous valid payload stays alive under its 90-day cache TTL. This is the "fall back to last-known list" behavior called for in the plan.

### Component 4: `financial_center_redundancy` (weight 0.15)

**Question answered**: How many independent USD-clearing routes remain if one major counterparty pulls correspondent relationships?

**Source**: BIS CBS by-parent series (shares the same seed payload as Component 2). For each counterparty country, count the distinct reporting-parent banks with non-trivial cross-border claims (>1% of host country GDP).

**Self-exclusion rule**: claims where the counterparty equals the parent (e.g., Singapore banks on Singapore counterparties, Switzerland banks on Switzerland counterparties) are filtered out before computing `parentCount`. This is domestic banking, not foreign-bank redundancy — Component 4 measures "how many INDEPENDENT FOREIGN USD-clearing routes remain." Without this filter, hub jurisdictions in `PARENT_COUNTRIES` (SG, CH) would have inflated `parentCount` because their own domestic loan books would count as fallback routes. Caught during the 2026-04-25 activation audit.

**Score shape**: `normalizeHigherBetter(parentCount, worst=1, best=10)`.

**Important**: this directly REWARDS countries with multi-counterparty financial centers (UAE, Singapore, HK), inverting the hub-of-trade penalty in the OFAC-domicile construct. This is the component that explicitly balances against the Component 2 over-exposure penalty.

**Coverage**: derived from BIS CBS — same ~200 jurisdictions.

## Fail-closed preflight

The dim implements the same fail-closed pattern as `scoreEnergy` v2 (plan [`2026-04-24-001`](./../plans/2026-04-24-001-fix-resilience-v2-fail-closed-on-missing-seeds-plan.md)). When `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=true`, the scorer preflights all 3 required seed envelopes:

```
seed-meta:economic:wb-external-debt:v1
seed-meta:economic:bis-lbs:v1
seed-meta:economic:fatf-listing:v1
```

Missing envelopes throw `ResilienceConfigurationError(message, missingKeys)` (two-arg form; `missingKeys` carries the absent seed keys). The `scoreAllDimensions` catch path reads `err.missingKeys`, joins them for the source-failure log, and routes the dim to `imputationClass='source-failure'` with `score=0, coverage=0`. Per-country data gaps inside an otherwise-published envelope are distinct: per-component reads return null and the slot drops out of the weighted blend.

When `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED` is unset or false (default), the scorer returns the empty-data shape (no preflight, no throw, `imputationClass=null`). The dim drops out of the coverage-weighted economic-domain mean. This is the staged-rollout posture: the dim ships dark until seeders are populating in production, then ops flip the flag.

## Methodology invariants

- **No double-counting with `tradePolicy`**: the OFAC-domicile-count signal does NOT feed either dim. Pinned by an integration test that mutates `sanctions:country-counts:v1` and asserts neither dim moves.
- **No double-counting with `liquidReserveAdequacy`**: both touch external-debt signals but measure different ratios (coverage vs absolute exposure). Liquid reserve adequacy uses WB FI.RES.TOTL.MO (months-of-imports cushion); financial-system exposure uses WB IDS short-term external debt as % of GNI (debt-rollover vulnerability). They move semi-independently.
- **Source provenance**: every component cites at least one primary-source URL in its seed payload's `sources:` array.

## Sanctions-isolated jurisdiction sanity check

The construct is calibrated such that countries with comprehensive financial sanctions and weak banking infrastructure score very low on this dim. The cohort sanity-check anchor (gates the construct at activation time):

- **Russia, Iran, DPRK, Cuba, Venezuela, Belarus, Libya, Myanmar** must score < 20 on `financialSystemExposure` after the flag flips on with seeders populated. If they don't, the construct is mis-calibrated and must be retuned before production rollout.

## Bounded-movement gate

When the flag flips on, every country's `financialSystemExposure` score moves from 0 (flag-off baseline) to its actual value, which propagates into the headline overall score via the economic-domain mean. The bounded-movement gate (per plan §Phase 2 Acceptance criteria):

- At least 60% of countries should have |Δ| < 3 points overall
- No country moves > 12 points overall except the explicitly-predicted set above (sanctions-isolated jurisdictions where the new dim correctly adds penalty)

## Data sources and licensing

| Component | Source | License |
|---|---|---|
| Component 1 (WB IDS short-term debt) | World Bank International Debt Statistics | CC-BY-4.0 (open-data) |
| Component 2 (BIS CBS cross-border foreign claims) | BIS Consolidated Banking Statistics — `WS_CBS_PUB` SDMX dataflow | [BIS terms of use](https://www.bis.org/terms_conditions.htm) — non-commercial, attribution required |
| Component 3 (FATF listing status) | FATF "Black and Grey Lists" web publications | Open (no machine-readable license terms posted; FATF publications are public-domain by convention) |
| Component 4 (BIS CBS by-parent count) | BIS CBS — same seed as Component 2 | Same as Component 2 |

The BIS-derived indicators (Components 2 + 4) are tagged `non-commercial` / `enrichment` in `_indicator-registry.ts` per the existing BIS classification convention. The dimension itself is `core` (it contributes to the headline score) per Codex R1 #8 — a `core` dim with `enrichment` constituent indicators is permissible because the indicator-registry lint accepts the configuration.

## Common operational footguns

### `WS_LBS_D_PUB` does NOT publish a counterparty breakdown — use `WS_CBS_PUB` instead

The most expensive lesson from this construct's activation audit. The plan called for "BIS Locational Banking Statistics by-parent" data, but `WS_LBS_D_PUB`'s public API only exposes counterparty as the aggregate `5J` — a single series per parent representing total claims on ALL counterparties combined. Per-counterparty breakdowns require `WS_CBS_PUB` (Consolidated Banking Statistics), which has a different dimension order (11 dims, not 12) and different parent semantics (CBS uses `L_REP_CTY` for parent country; LBS has a separate `L_PARENT_CTY` dim that exists only as an aggregate). **Rule**: when an SDMX query returns 200 OK with a single series whose counterparty value is `5J` despite an empty L_CP_COUNTRY position, that's the smoking gun — switch dataflows.

### BIS `4F` is NOT a valid parent-country aggregate

Codex Round 4 caught this: BIS publishes `4F` as a counterparty-country legacy code (Euro area), but the parent-country codelist (`CL_BIS_IF_REF_AREA`) only accepts ISO 3166-1 alpha-2 country codes plus the BIS-defined parent aggregates `5J` (all parents) and `5M` (emerging markets). Querying `L_PARENT_CTY=4F` (LBS) or `L_REP_CTY=4F` (CBS) returns an empty SDMX result silently — a fresh seed-meta with zero claims looks plausible but produces 0% exposure for every counterparty. **Rule**: enumerate the individual euro-area parent ISO2 codes (DE, FR, IT, NL, ES, BE, AT, IE, LU) instead. The seeder's `PARENT_COUNTRIES` list pins this.

### BIS `L_CP_COUNTRY` uses ISO 3166-1, not M49

Codex Round 4 also caught this: BIS country dimensions follow the `CL_BIS_IF_REF_AREA` codelist, which is ISO 3166-1 alpha-2 for country members (`BR`, `US`, `GB`, etc.). No M49 numeric mapping is required — pass ISO2 codes directly to the SDMX key. The seeder uses `iso3-to-iso2.json` only for the GDP denominator (WB API returns ISO3).

### `DT.DOD.DSTC.IR.ZS` is "% of total reserves", NOT "% of total external debt"

Caught by activation-time audit on PR #3407. The original WB IDS composition was `DT.DOD.DSTC.IR.ZS / 100 × DT.DOD.DECT.GN.ZS`, intended to produce "short-term external debt as % of GNI." But `DT.DOD.DSTC.IR.ZS` is short-term debt as a share of **international reserves**, not total external debt. Argentina, Turkey, Sri Lanka all had values >100% on the intermediate `shortTermPctOfTotalDebt` ratio because their short-term debt exceeds their reserves. The composed result was mathematically meaningless. **Rule**: the only safe way to compute "X as % of GNI" from WB IDS is to divide the absolute USD values directly: `(DT.DOD.DSTC.CD / NY.GNP.MKTP.CD) × 100`. Don't compose ratio indicators that share an unstated denominator.

### Smoke test before flipping `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=true`

After running the 3 seeders manually but BEFORE flipping the flag in Vercel:

```bash
# Confirm seed envelopes published
redis-cli GET 'seed-meta:economic:wb-external-debt' | jq '.fetchedAt, .recordCount'
redis-cli GET 'seed-meta:economic:bis-lbs'          | jq '.fetchedAt, .recordCount'
redis-cli GET 'seed-meta:economic:fatf-listing'     | jq '.fetchedAt, .recordCount'

# Confirm BIS LBS payload is non-empty for a major economy
redis-cli GET 'economic:bis-lbs:v1' | jq '.countries.BR'
# Expected: { totalXborderPctGdp: <number>, parentCount: <2..16>, parents: {...}, gdpYear: <year> }
```

If any of these return null or empty, **do NOT flip the flag** — flipping with absent envelopes throws `ResilienceConfigurationError` on every `/api/resilience/*` request and stamps every country's `financialSystemExposure` as `imputationClass='source-failure'`. The fix is recoverable (flip the flag back OFF, fix the seeder, re-run, retry) but produces user-visible Sentry noise during the gap.

## Alternatives considered (and rejected)

### Alternative 1 — Patch `normalizeSanctionCount` only

Tweak the piecewise scale to be less aggressive. **Rejected**: doesn't address the underlying construct error. The OFAC count's fundamental conflation of transit-hub corporate domicile with host-country risk would persist.

### Alternative 2 — Transit-hub exclusion list

Exclude Dubai/Singapore/Hong Kong/Cyprus free-zone-domiciled designations from each host country's count. **Rejected**: bandaid on the wrong construct; the hub list is arbitrary and any line-drawing exercise becomes politically charged.

### Alternative 3 — Single-dim formula rewrite (don't split)

Keep `tradeSanctions` as one dim, just rewrite the 0.45 sanctions component formula to be the new `financialSystemExposure` composite. **Rejected**: makes the dim measure two semantically-different things (trade-policy openness AND structural financial vulnerability); future audits have to disentangle them.

### Alternative 4 — Drop the dim entirely

**Rejected**: trade-policy openness IS a real signal; just not the OFAC-domicile component. The Phase 1 Ship 1 split keeps the trade-policy signal intact in `tradePolicy` while the new `financialSystemExposure` carries the structural-vulnerability signal.

### Alternative 5 — `tradeSanctions` as compat-with-coverage-0 for one cycle

Keep `tradeSanctions` as a retired/compat dimension at coverage=0; add `tradePolicy` and `financialSystemExposure` incrementally. **Adopted in modified form** as the two-ship structure. The two-ship structure preserves the rename + drop in Phase 1 (Ship 1), then adds the new dim in Phase 2 (Ship 2) — the staged approach that Codex R1 #9 specifically recommended.

## Future considerations

- **Phase 3 — OFAC enforcement-action seeder**: a structured per-country enforcement-action time-series (action date, fine USD, target sector). Add `ofac_active_enforcement_24m` back to the dim at weight ~0.10 with proportional reweighting. Requires new structured seeder; out of scope for v1.
- **Phase 4 — Geopolitical-bloc weighting**: countries with explicit US-aligned defense treaties (NATO, MNNA) get a small access bonus.
- **Phase 5 — USD currency-composition true-up**: source actual USD-denominated short-term external debt from BIS Triennial Survey (paid data). Until then, Component 1 measures all-foreign-currency short-term external debt as % of GNI.

## References

- Plan: [`docs/plans/2026-04-25-004-feat-financial-system-exposure-construct-plan.md`](../plans/2026-04-25-004-feat-financial-system-exposure-construct-plan.md)
- Phase 1 (rename + drop OFAC): [`known-limitations.md § tradeSanctions → tradePolicy`](./known-limitations.md#tradesanctions--tradepolicy-ofac-domicile-component-dropped-ship-1-2026-04-25)
- Energy v2 fail-closed precedent: [`docs/plans/2026-04-24-001-fix-resilience-v2-fail-closed-on-missing-seeds-plan.md`](../plans/2026-04-24-001-fix-resilience-v2-fail-closed-on-missing-seeds-plan.md)
- Scorer: `server/worldmonitor/resilience/v1/_dimension-scorers.ts` (`scoreFinancialSystemExposure`)
- Indicator registry: `server/worldmonitor/resilience/v1/_indicator-registry.ts` (4 entries with dimension `financialSystemExposure`)
- Seeders: `scripts/seed-{wb-external-debt,bis-lbs,fatf-listing}.mjs`
- Tests: `tests/resilience-financial-system-exposure.test.mts`, `tests/seed-{wb-external-debt,bis-lbs,fatf-listing}.test.mjs`
- Bundle: `scripts/seed-bundle-macro.mjs` (Option A per Codex R1 #5)
