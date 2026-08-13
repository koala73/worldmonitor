# Financial System Exposure — construct definition

**Status**: Active in production (activated 2026-08-12; added in plan 2026-04-25-004 Phase 2 — Ship 2; recalibrated in #6459 and #6461; activation protocol tracked in #6511)
**Dimension ID**: `financialSystemExposure`
**Domain**: `economic` (weight 0.50 within domain)
**Type**: `stress`
**Rollout**: `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=true` is live in Vercel production. The code default remains `false` for CI and rollback; see the [flag-flip runbook](./financial-system-exposure-flag-flip-runbook.md).

## Question answered

**How vulnerable is country X's financial system to coordinated action by major Western banking jurisdictions, AML/CFT enforcement bodies, and short-term external-debt rollover risk?**

This dimension replaces the structural-exposure half of the dropped OFAC-domicile component (Ship 1) with a four-component composite built from audited cross-border banking + AML/CFT data. Where the OFAC count conflated transit-hub corporate domicile with host-country risk (penalizing financial centers like UAE, Singapore, Hong Kong for shell-entity behavior), this dimension uses sources that measure actual sovereign vulnerability.

## Composition

```
financialSystemExposure = min(
  weightedBlend([
    { signal: short_term_external_debt_pct_gni,  weight: 0.35 },
    { signal: bis_lbs_xborder_us_eu_uk_pct_gdp,  weight: 0.30 },
    { signal: fatf_listing_status,                weight: 0.20 },
    { signal: financial_center_redundancy,        weight: 0.15 },
  ]),
  comprehensive_embargo(country) ? 15 : 100,
)
```

Components 2 + 4 share the BIS CBS payload (`economic:bis-lbs:v1` — Redis key name retained for historical continuity even though the upstream dataflow is now CBS, not LBS); no separate seeder for redundancy.

The `min(...)` cap is the comprehensive-embargo term added in #6459; see [§ Comprehensive-embargo cap](#comprehensive-embargo-cap) for why the signal cannot be carried by the four graded components.

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

**Coverage**: ~119-190 World Bank borrower economies depending on the year — 119 in the 2026-08-11 production payload.

**Absence handling (#6459)**: IDS is the published output of the World Bank **Debtor Reporting System**, whose membership is World Bank *borrowers*. The seeder also reads the World Bank country catalog and records countries with `lendingType=LNX` as explicitly outside the Bank's borrower programs.

The original construct dropped the slot for them. That was the single largest contributor to the inversion: `weightedBlend` renormalizes onto the surviving slots, so the 0.35 weight redistributed onto a denominator of 0.65 and the punitive cross-border-claims leg alone went from 30% to 46% of the score. Luxembourg was scored almost entirely on "your banks are too integrated", with no offsetting credit for having no rollover risk at all.

| Country state | Component 1 slot |
|---|---|
| DRS row present; market-access proxy does not fire | `normalizeLowerBetter(value, 0, 15)`, full 0.35 weight, coverage 1.0 |
| DRS row present; debt ≤1% GNI, BIS claims &lt;5% GDP, and zero reporting parents | same observed score at 30% certainty: runtime weight 0.105, nominal weight 0.35, `certaintyCoverage 0.3` |
| No DRS row, `lendingType=LNX`, **and** present in BIS CBS | imputed score **75**, `certaintyCoverage 0.3`, `imputed: true`, `imputationClass: 'not-applicable'` |
| Borrower missing its DRS row | slot drops out of the blend (possible partial payload) |
| Absent from both DRS and BIS CBS | slot drops out of the blend (genuine data gap) |

**Market-access constraint attenuation (#6461).** A near-zero short-term debt ratio is not full-strength evidence of low rollover vulnerability when the country has little commercial market access from which to borrow. The scorer uses a three-signal intersection already present in the construct: debt ≤1% of GNI, BIS cross-border claims below the 5% healthy-integration boundary, and zero independent foreign reporting parents. Only when all three hold does the debt leg retain 30% of its score weight and coverage certainty. If any signal clears its boundary, the observed debt ratio keeps full weight. This avoids an editorial country list and makes the rule self-expiring when market access appears in the source data.

The low-claims and zero-parent signals must be observed numeric values. A missing or malformed BIS field is unknown, so it drops its own slot and does not trigger debt attenuation.

On the 2026-08-11 production-shaped fixture, Chad moves from **67 at coverage 1.0** to **56 at coverage 0.76**. Its raw 0.14% debt observation still exists, but it no longer dominates the dimension while BIS reports claims at 1.11% of GDP and zero foreign parents.

**Why `not-applicable` and not `unmonitored`**: non-participation in the DRS means there is no reported short-term external commercial debt to roll over. That is a mild positive, not an unknown, so the class that describes it is "the indicator does not apply here".

**Discriminator**: the World Bank country catalog's `lendingType=LNX` classification is the explicit non-borrower signal. A missing DRS row is never enough by itself, because an accepted annual payload can still omit an eligible borrower. The imputation also requires a valid BIS CBS row. Payload schema v1 did not carry `nonDrsCountryCodes`; the active scorer now fails closed unless this schema-v2 field contains at least 40 valid unique codes, matching the seeder's producer contract.

This typed LNX/BIS imputation counts as a resolving component for FATF singleton handling. It is explicit `not-applicable` evidence with score 75 and partial certainty, not three-source absence, and therefore cannot produce a perfect 100-point dimension through the imputed-debt path.

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

**Score shape**: **asymmetric** U-shaped band-normalization (`normalizeBandLowerBetter`). Both extremes are bad — too little integration suggests financial isolation (sanctions-target jurisdictions; thin correspondent-banking access); too much suggests over-exposure to Western-bank pulls (Iceland-2008 territory). The score peaks in the "healthy diversified financial system" middle band:

| Cross-border claims (% GDP) | Score |
|---|---|
| 0% (isolation floor) | 30 |
| 0-5% (low integration) | 30-75 (linear) |
| 5-25% (sweet spot) | 75-100 (linear) |
| 25-60% (over-exposed) | 100-45 (linear) |
| 60-80% (Iceland-2008 territory) | 45-35 (linear) |
| > 80% | 35 (flat over-exposure floor) |

**Asymmetry is the point, and it was wrong until #6459.** The original band floored 0% claims at **60** and decayed over-integration through 30 at 60% of GDP to a clamped **0** from 120%. Zero cross-border integration is the signature of a sanctions-severed banking system, so that shape scored severance above integration by construction: on the 2026-08-11 production payload Russia's 1.45%-of-GDP claims took 64 while Luxembourg's 1041.64% took 0.

Three invariants now hold, and `tests/resilience-financial-system-exposure.test.mts` asserts them against `normalizeBandLowerBetter` directly rather than inferring them from sampled dimension scores:

1. The isolation floor (value 0) is ≤ 40 and **strictly below every other reading of the band**, densely sampled from 0.5% to 5000% of GDP.
2. The over-exposure leg floors at 35 — above the isolation floor, because an over-banked entrepôt still has working correspondent access that a severed state does not.
3. Every segment boundary is continuous, including the new 80% floor knee (the PR #3407 Greptile P1 lesson: cliffs in piecewise-linear scorers destabilize rankings at band edges).

**Diversity-conditioned premium (the Albania residue).** The table above is the RAW band; what the blend consumes is `normalizeDiversityConditionedBand`, which scales the premium **above the 75 low-integration boundary** by Component 4's own redundancy transform:

```
conditioned = min(band, 75) + max(0, band − 75) × normalizeHigherBetter(parentCount, 1, 10) / 100
```

The sweet spot's label is "healthy **diversified** financial system", but the raw band reads only the integration level. After the #6459 retune, 29 of the 77 premium-region countries on the 2026-08-12 production payload held that premium through ≤ 2 reporting parents — Bosnia took a 90 band on ONE parent; Albania took 91 on claims routed almost entirely through one Austrian and one Italian banking group, and out-scored Singapore and the United Kingdom on the full dimension. Moderate integration through two doors is a withdrawal channel (Thailand 1997; the 2011-2015 Greek-bank deleveraging in the western Balkans), not a cushion, and the construct's own Component 4 scores the same fact 11/100. Conditioning the premium on demonstrated parent breadth closes that gap with **no new constants or sources**: the scale is verbatim Component 4's, the same reuse discipline as the #6461 market-access proxy.

Everything at or below 75 is untouched — the isolation floor, the over-exposure floor, and the deep over-exposure legs keep the exact #6459 shape, so all three invariants above survive unchanged. Additional conditioning invariants pinned by the same test file: parents ≥ 10 earns the full raw premium; parents ≤ 1, a non-finite count, or a BIS row whose `parentCount` failed to parse earns none — absence of diversity evidence is not diversity; the conditioned band is monotone in parents and remains continuous in claims at every segment boundary.

**Known conservative edge.** `parentCount` counts only parents holding **more than** 1% of host GDP, so a country integrated through many sub-threshold parents forfeits a premium its true breadth might merit. The forfeit is bounded by the premium itself: ≤ 25 band points, and ≤ 7.5 dimension points **only while all four slots resolve**. `weightedBlend` renormalises the band's 0.30 onto the surviving weight, so the dimension cost grows as siblings drop — 8.8 points at coverage 0.85 (Component 4 absent), 11.5 at 0.65 (debt slot absent), 15 at 0.50. The worst arithmetically reachable case is ~14 band points: all 16 enumerated reporting parents sitting just under the counting threshold sums to ~16% of GDP — a raw band of 89 scored at the 75 floor. No production row currently has premium-region claims with `parentCount` 0, so this is a bound on the transform, not an observed effect. If a future BIS payload does produce one, the fix is a breadth measure over the full parent-share distribution (effective parent count or an HHI over `parents`), not a lower threshold.

**Reproducing the concentration statistic.** The "29 of 77" figure above is the empirical justification for conditioning at all, so it must be re-derivable rather than taken on trust — BIS republishes quarterly and the ratio will move. Against a live payload:

```bash
# How many premium-region countries hold that premium through <= 2 parents?
redis-cli GET 'economic:bis-lbs:v1' | jq '
  (.data // .).countries
  | to_entries
  | map(select(.value.totalXborderPctGdp != null and .value.parentCount != null))
  # Premium region = the band ROUNDS above 75, so raw band >= 75.5 — which the
  # two legs reach at 5.4% and 40.59% of GDP. Using the unrounded 5%/40.9%
  # crossings instead pulls in 2 countries whose band rounds to exactly 75 and
  # earns no premium, which is what makes this read 79/31 rather than 77/29.
  | map(select(.value.totalXborderPctGdp >= 5.4 and .value.totalXborderPctGdp <= 40.59))
  | {premium_region: length,
     concentrated: map(select(.value.parentCount <= 2)) | length,
     single_parent: map(select(.value.parentCount <= 1)) | length}'
# 2026-08-12: { "premium_region": 77, "concentrated": 29, "single_parent": 11 }
```

If `concentrated` ever falls near zero, the conditioning has stopped doing work and the construct is worth re-examining — not because the transform broke, but because the concentration it corrects for would have disappeared from the data.

**What the conditioning does not fix.** A `parentCount` that fails to parse caps the premium here but also nulls the Component 4 slot, and `weightedBlend` renormalises the freed weight onto the surviving legs — which *raises* the score when those legs read high (Albania: 70 → 80). That inflation is a property of the blend and predates this change; the same measurement against the raw band is 75 → 86, so conditioning strictly reduces it (+10 against +11). Tracked as issue #6528; the scorer cannot close it, because a component slot has no way to hold weight the blend has already freed. What the scorer *can* do, and now does, is report the shortfall: when the level resolves but breadth does not, the band slot carries a reduced `certaintyCoverage`, so the published coverage says the band was a substituted floor rather than a redundancy-scaled reading.

A negative or non-finite reading is upstream corruption, not isolation, and falls back to a neutral 50 rather than to the isolation floor — a parser regression must not read as a sanctions verdict.

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
| Grey list (increased monitoring) | 55 | Typically 15-25 jurisdictions; rotates as countries clear FATF action plans |
| Compliant | 100 | Default for any jurisdiction not appearing on either list |

**Grey rescaled 30 → 55 in #6459.** Grey-listing means "increased monitoring under an agreed action plan" — a jurisdiction actively remediating with FATF, not one a step away from the call-for-action black list. At 30 the gap to black was 30 points and the gap to compliant 70, which placed ordinary remediating economies closer to Iran and DPRK than to their actual peers. On the 2026-06-01 plenary list that included Monaco, whose FATF slot is its **only** resolving component in production (no BIS CBS row, no DRS row), so the mis-scaling propagated directly to its dimension score.

**Compliant-by-absence singleton handling (#6461).** FATF enumerates AML/CFT deficiencies, not sanctions exposure, so an unlisted jurisdiction receives `compliant` by absence. That 100-point slot remains valid when another financial-system component resolves; dropping it globally would penalise roughly 170 ordinary unlisted jurisdictions. For a non-embargoed country where it is the **only** resolving component, however, the scorer drops the slot: absence from WB IDS, BIS CBS, and both FATF lists carries no positive information. A listed gray or black jurisdiction keeps its real observation. The comprehensive-embargo cohort also keeps non-zero observed provenance because the external cap is the construct signal and the executable sanctions anchor rejects a vacuous coverage-0 pass.

The current seeder publishes only black and gray records. The scorer also accepts an explicit `compliant` record as observed provenance, rather than confusing a future explicit assessment with list absence; changing that payload contract requires its own calibration gate.

**Coverage**: the source classifies the global universe by enumeration plus absence. Scorer coverage is conditional: a non-embargoed compliant-by-absence singleton contributes zero coverage, while listed jurisdictions and countries with another resolving component retain the 0.20 slot.

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

## Comprehensive-embargo cap

**Added in #6459. Not a component — a post-blend cap.**

The construct's question is "how vulnerable is country X's financial system to coordinated action by major Western banking jurisdictions?". For a jurisdiction already under a comprehensive or government-wide blocking programme, that vulnerability is not a forecast — it is realized in full: correspondent relationships are gone, reserves are immobilised, messaging access is revoked.

Three of the four graded components read that severance as **strength**:

- Component 1 — thin short-term external debt, because there is no market access to borrow from.
- Component 2 — low cross-border claims, because nobody lends.
- Component 3 — `compliant`, because FATF assesses AML/CFT deficiency, not sanctions.

**A band retune alone cannot fix this, and the arithmetic is worth stating so nobody re-litigates it.** With the band leg at 0 and the redundancy leg at 0, Russia still holds `0.35 × 80` (debt) + `0.20 × 100` (FATF) = **48** — more than double the < 20 activation anchor. The signal has to enter the construct as its own input.

```
FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO  (server/worldmonitor/resilience/v1/_dimension-scorers.ts)
  RU  EO 14024 + G7 reserve immobilisation + SWIFT exclusion of major banks (2022–)
  BY  EO 14038 + EU Reg. 765/2006 as amended; SWIFT exclusion (2022–)
  IR  31 CFR 560 Iranian Transactions and Sanctions Regulations (comprehensive)
  KP  31 CFR 510 North Korea Sanctions Regulations (comprehensive)
  CU  31 CFR 515 Cuban Assets Control Regulations (comprehensive, 1963–)
  MM  EO 14014 Burma blocking programme + EU Reg. 2013/184
  VE  EO 13884 blocks all property of the Government of Venezuela
  LY  EO 13566 blocks all property of the Government of Libya; UNSCR 1970/1973
```

**Membership criterion**: a comprehensive/territory-wide embargo, **or** a government-wide blocking programme that severs the sovereign from Western correspondent clearing. Individual-entity designations, sectoral measures and arms embargoes do **not** qualify — those are ordinary policy friction and belong in the graded components.

**Cap, not assignment.** The value is `min(blendedScore, 15)`. A country already below 15 keeps its lower score, so the graded components still order jurisdictions *within* the embargoed set: DPRK's FATF black listing holds it at 0, below Russia's 15. 15 sits deliberately below the < 20 activation anchor so the anchor has headroom rather than passing by exactly zero margin.

**Applied post-blend, so provenance is untouched.** `coverage`, `observedWeight`, `imputedWeight` and `imputationClass` continue to describe what was actually read. An operator inspecting a capped country still sees which components resolved; the cap does not disguise a construct verdict as a data outage.

**This is not the rejected "transit-hub exclusion list"** ([Alternative 2](#alternative-2--transit-hub-exclusion-list)). That would have been an editorial carve-out of jurisdictions the construct scored inconveniently. This list *is* the construct's subject, and its membership is externally defined by published US OFAC and EU Council programmes rather than drawn by us.

**Maintenance**: the list is static and must be reviewed when a programme is materially lifted or imposed. It was last reviewed on **2026-08-11** and has a maximum review age of **120 days**, enforced in CI. Syria was removed during that review because [OFAC revoked the comprehensive Syria sanctions program effective 2025-07-01](https://ofac.treasury.gov/recent-actions/20250630). A jurisdiction leaving the list re-enters the graded components on its own merits; tests require the runtime set, calibration cohort, and this code block to remain identical.

## Fail-closed preflight

The dim implements the same fail-closed pattern as `scoreEnergy` v2. When `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=true`, the scorer preflights all 3 required seed envelopes:

```
seed-meta:economic:wb-external-debt
seed-meta:economic:bis-lbs
seed-meta:economic:fatf-listing
```

Missing envelopes throw `ResilienceConfigurationError(message, missingKeys)` (two-arg form; `missingKeys` carries the absent seed keys). The same fail-closed behavior applies when healthy seed metadata is followed by an absent, malformed, or empty World Bank data envelope. The `scoreAllDimensions` catch path reads `err.missingKeys`, joins them for the source-failure log, and routes the dim to `imputationClass='source-failure'` with `score=0, coverage=0`. Per-country data gaps inside an otherwise-published envelope are distinct: per-component reads return null and the slot drops out of the weighted blend unless World Bank metadata explicitly confirms the non-DRS case above.

When `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED` is unset or false (the code default), the scorer returns the empty-data shape (no preflight, no throw, `imputationClass=null`). The dim drops out of the coverage-weighted economic-domain mean. Production sets the owner-controlled flag to `true`; setting it to `false` is the documented rollback and keeps CI's flag-off posture fail-closed.

## Methodology invariants

- **No double-counting with `tradePolicy`**: the OFAC-domicile-count signal does NOT feed either dim. Pinned by an integration test that mutates `sanctions:country-counts:v1` and asserts neither dim moves.
- **No double-counting with `liquidReserveAdequacy`**: both touch external-debt signals but measure different ratios (coverage vs absolute exposure). Liquid reserve adequacy uses WB FI.RES.TOTL.MO (months-of-imports cushion); financial-system exposure uses WB IDS short-term external debt as % of GNI (debt-rollover vulnerability). They move semi-independently.
- **Source provenance**: every component cites at least one primary-source URL in its seed payload's `sources:` array.

## Sanctions-isolated jurisdiction sanity check

The construct is calibrated such that countries with comprehensive financial sanctions and weak banking infrastructure score very low on this dim. The cohort sanity-check anchor:

- **Russia, Iran, DPRK, Cuba, Venezuela, Belarus, Libya, Myanmar** must score < 20 on `financialSystemExposure`. If they don't, the construct is mis-calibrated and the production flag must be rolled back before further activation work.

**This anchor is executable (#6459). It was prose for three and a half months and nothing evaluated it, which is how an unsatisfiable construct sat merged and dark.** It now runs in CI:

| Gate | Where |
|---|---|
| Sanctions cohort < 20, all eight | `tests/resilience-financial-system-exposure-calibration.test.mts` |
| Cohort membership == this doc's list | same file — the cohort cannot be trimmed to make the gate pass |
| Cohort members carry non-zero coverage | same file — a coverage-0 pass would clear `< 20` while proving nothing |
| Dimension-level direction: LU > BY, SG > MM, CH > RU, US > CU (minGap 10) | same file, via `FIN_SYS_EXPOSURE_MATCHED_PAIRS` |
| Inversion probe, pinned values | `tests/resilience-financial-system-exposure.test.mts` |

Cohort membership lives in `tests/helpers/resilience-cohorts.mts` as `sanctions-isolated`; the gates run through the real `scoreFinancialSystemExposure` against the three component seed payloads pinned verbatim from production on 2026-08-11 (`tests/helpers/resilience-finsys-fixtures.mts`).

**Why the pre-existing gates missed the inversion.** Spearman-vs-baseline and max-country-drift are *magnitude* gates: they bound how far the ranking moves, not who moves which way. The 2026-08-11 full-universe measurement returned Spearman 0.99612 and max drift 8.61 — both comfortably passing — while the dimension's ranking was completely inverted. A complete direction flip inside a ~3%-of-headline dimension is invisible to both. Only directional gates (cohort thresholds, matched pairs) catch this class.

**Dimension-level pairs are deliberately separate from `MATCHED_PAIRS`**, which feeds whole-index acceptance gate #7. A whole-index pair compares overall scores and cannot see a defect confined to one dimension.

### Resolved absence-as-strength cases (#6461)

The #6459 cap fixed the *embargoed* case of "absence reads as strength". #6461 resolves the two non-embargoed shapes measured against the 2026-08-11 production payload. The directional gates live in `tests/resilience-financial-system-exposure-calibration.test.mts` and run through the real scorer.

**1. No-market-access low-income countries.** The observed debt leg is attenuated to 30% certainty only when its tiny ratio coincides with near-zero BIS claims and zero reporting parents. Chad's dimension score is now 56 rather than 67, with coverage reduced from 1.0 to 0.76. Boundary controls prove that debt above 1% GNI, claims at or above 5% GDP, or at least one reporting parent preserves full confidence.

**2. FATF-compliant-by-absence as the only resolving slot.** Seven scorable jurisdictions have neither a DRS row nor a BIS CBS row. Listed MC, SS, YE, and KP retain real FATF observations; embargoed CU retains the provenance constrained by its external cap. **Eritrea and Taiwan** now drop the inferred FATF slot and publish dimension score/coverage **0/0**, rather than **100/0.2**. Taiwan's reporting-politics absence and Eritrea's data desert therefore do not become resilience signals.

The gate observes the pre-fix failures directly: ER/TW returned coverage 0.2, and Chad returned 67. Negative controls preserve FATF-only listed jurisdictions, the embargo cohort's non-zero coverage, ordinary low-debt borrowers with market access, and explicit compliant records.

## Bounded-movement gate

When the flag flips on, every country's `financialSystemExposure` score moves from 0 (flag-off baseline) to its actual value, which propagates into the headline overall score via the economic-domain mean. The bounded-movement gate (per plan §Phase 2 Acceptance criteria):

- At least 60% of countries should have |Δ| < 3 points overall
- No country moves > 12 points overall except the explicitly-predicted set above (sanctions-isolated jurisdictions where the new dim correctly adds penalty)

**#6461 full-universe measurement (2026-08-12, 196 scorable countries, flag OFF → flag ON):** Spearman **0.99789**; **196/196 (100%)** move by less than 3 points; maximum absolute movement **2.35**; no country moves more than 12. ER and TW remain `headlineEligible=false` in both arms and resolve the dimension at 0/0. Chad moves +0.87 overall, resolves at 56/0.76, and remains eligible. The only eligibility change is Venezuela, false → true, from activation of its capped 15/0.65 observed dimension rather than from the two #6461 residual rules.

Production already runs with the flag enabled, as tracked in #6511, so the OFF arm is a counterfactual baseline rather than the current deployment state. The cache-generation rotation and activation-protocol reconciliation are recorded below and in the runbook; this historical measurement predates that closeout artifact.

This live measurement was **degraded** by a WGI source-failure state that affected the same governance-related dimensions in both arms. The paired movement result is still a genuine same-run flag comparison, but it is not an undegraded production-health snapshot; do not use it to claim WGI health or final post-deploy acceptance.

**#6519 schema-v1 → schema-v2 activation (2026-08-12, 196 scorable countries):** the fail-closed WB IDS seeder published 119 debt rows and 72 unique `lendingType=LNX` codes. The subsequent production ranking refresh moved **48** of the 71 countries with a missing IDS row and a valid BIS row from coverage 0.65 to 0.76 with `imputedWeight=0.35`. The other 23 are not confirmed `LNX` and correctly remain unknown; row absence alone cannot trigger the imputation. Across the full ranking, Spearman was **0.99997**, **196/196 (100%)** moved by less than 3 points, the maximum absolute movement was **0.35**, no country moved more than 12, and headline eligibility did not change. The committed capture is [`resilience-financial-system-exposure-non-drs-activation-2026-08-12.json`](../snapshots/resilience-financial-system-exposure-non-drs-activation-2026-08-12.json).

The debt slot uses the `not-applicable` imputation class. The published dimension-level `imputationClass` remains `null` because `weightedBlend` reports a class only for a fully imputed dimension; the same result contains observed BIS and FATF inputs. `imputedWeight=0.35` is the published proof that the debt slot activated.

### Post-flip production acceptance (#6511)

The committed artifact [`resilience-financial-system-exposure-acceptance-2026-08-13.json`](../snapshots/resilience-financial-system-exposure-acceptance-2026-08-13.json) is the closeout evidence for the live activation. The read-only harness runs the full sovereign universe twice against the same production Upstash snapshot: a flag-off counterfactual and the flag-on production formula. It records the harness commit, source-input digest, resolved Redis key count, active cache namespaces, per-country score rows, representative countries, and the acceptance gates. It does not write Redis or create an artifact when a required read is unresolved.

The acceptance thresholds are **Spearman ≥ 0.85**, **at least 60% of countries with |Δ| < 3 overall**, and **no non-sanctions country with |Δ| > 12 overall**. The artifact records the measured values and any headline-eligibility changes. A source-failure state is retained as a caveat; it is not silently treated as healthy coverage.

**Measured acceptance (2026-08-13, 196 countries):** Spearman **0.9983**; **196/196 (100%)** moved by less than 3 overall points; maximum absolute movement **2.23**; no non-sanctions country moved by more than 12; headline eligibility changed for **0** countries. Representative finance scores after activation are US **84** at coverage 0.76, PT **66** at 0.76, MC **55** at 0.20, RU **15** at 1.0, TD **56** at 0.76, and VE **15** at 0.65. The capture resolved **650** Redis keys and used score/ranking `v28`, history `v22`, and intervals `v11`. The same run emitted the known static WGI source-failure diagnostics; treat this as a paired finance activation measurement, not a claim that every upstream source was healthy.

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

The active non-DRS path also requires the WB debt contract envelope to be schema v2. The scorer preserves this canonical envelope long enough to enforce numeric `_seed.schemaVersion >= 2`, then validates at least 40 valid unique entries in `data.nonDrsCountryCodes`. A schema-v1 payload is now a fail-closed configuration error instead of silently disabling the imputation for every eligible country.

## Alternatives considered (and rejected)

### Alternative 1 — Patch `normalizeSanctionCount` only

Tweak the piecewise scale to be less aggressive. **Rejected**: doesn't address the underlying construct error. The OFAC count's fundamental conflation of transit-hub corporate domicile with host-country risk would persist.

### Alternative 2 — Transit-hub exclusion list

Exclude Dubai/Singapore/Hong Kong/Cyprus free-zone-domiciled designations from each host country's count. **Rejected**: bandaid on the wrong construct; the hub list is arbitrary and any line-drawing exercise becomes politically charged.

> **Not to be confused with the #6459 comprehensive-embargo cap.** The distinction is which way the list points and who draws it. This alternative would have *removed* inconvenient jurisdictions from a component so their scores improved, on a line we drew ourselves. The embargo list *is* the construct's subject — the realized form of the vulnerability the dimension measures — and its membership comes from published US OFAC and EU Council programmes.

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

- Phase 1 (rename + drop OFAC): [`known-limitations.md § tradeSanctions → tradePolicy`](./known-limitations.md#tradesanctions--tradepolicy-ofac-domicile-component-dropped-ship-1-2026-04-25)
- Scorer: `server/worldmonitor/resilience/v1/_dimension-scorers.ts` (`scoreFinancialSystemExposure`)
- Indicator registry: `server/worldmonitor/resilience/v1/_indicator-registry.ts` (4 entries with dimension `financialSystemExposure`)
- Seeders: `scripts/seed-{wb-external-debt,bis-lbs,fatf-listing}.mjs`
- Tests: `tests/resilience-financial-system-exposure.test.mts`, `tests/seed-{wb-external-debt,bis-lbs,fatf-listing}.test.mjs`
- Bundle: `scripts/seed-bundle-macro.mjs` (Option A per Codex R1 #5)

## Changelog

### 2026-08-11 — #6459 construct recalibration (still flag-dark)

A flag test on 2026-08-11 showed the construct's ranking was **inverted**: financially deep jurisdictions fell and financially isolated or sanctioned ones rose. Four defects, all fixed in one PR, plus the gates that make the defect class visible:

| Change | Effect |
|---|---|
| Cross-border-claims band re-anchored asymmetrically (isolation floor 60 → 30; over-exposure floor 0 → 35) | Severance stops out-scoring integration |
| FATF grey rescaled 30 → 55 | Remediating jurisdictions stop scoring near-blacklist |
| Comprehensive-embargo cap at 15 added as a new input | Closes compliant-by-absence and no-market-access reading as strength |
| Explicit World Bank `lendingType=LNX` non-DRS slot imputed at 75 / `not-applicable` instead of dropped | Stops the 0.35 weight renormalizing onto the punitive band leg without converting missing borrower rows into strength |
| Sanctions cohort, dimension-level matched pairs, and the inversion probe committed as CI gates | The activation anchor is executable instead of prose |
| Syria removed from the static cap; policy review age and code/doc/cohort parity enforced | Revoked sanctions cannot persist silently as scorer policy |

Measured effect on the 2026-08-11 production payloads (dimension score, before → after):

| | RU | BY | IR | KP | CU | VE | LY | MM | LU | SG | CH | US | MC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before | 68 | 48 | 52 | 0 | 100 | 45 | 59 | 54 | 54 | 54 | 80 | 89 | 30 |
| after | 15 | 15 | 15 | 0 | 15 | 15 | 15 | 15 | 72 | 72 | 81 | 85 | 55 |

The dimension is live behind `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED` in production. The code default remains flag-off for CI and rollback. The cache rotation, read-only acceptance capture, and operator closeout are defined in [the activation runbook](./financial-system-exposure-flag-flip-runbook.md). #6461 is already closed by #6515, so no reprioritization mutation is required.
