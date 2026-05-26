# SWF classification rubric (haircut factors for sovereignFiscalBuffer)

Central rubric for classifying sovereign wealth funds under the
resilience `sovereignFiscalBuffer` dimension. Supports
`scripts/shared/swf-classification-manifest.yaml`.

Every fund in the manifest has three coefficients in its
`classification:` block:

```yaml
classification:
  access:       0..1
  liquidity:    0..1
  transparency: 0..1
```

These multiply together to form the haircut the scorer applies when
computing effective SWF months of reserve coverage:

```
effectiveMonths = rawSwfMonths × access × liquidity × transparency
score           = 100 × (1 − exp(−effectiveMonths / 12))
```

This doc defines **what each coefficient value means** with named
tiers + concrete precedents, so:

1. Every rating in the manifest is defensible by pointing to a
   tier + precedent.
2. Future manifest PRs that add or revise ratings have an explicit
   benchmark to evaluate against.
3. A reviewer can audit the manifest without re-deriving the
   rubric from first principles each time.

**Scope boundary.** This is a methodology doc, not a ground-truth
table. The coefficient values live in the manifest YAML; the
rubric here explains the semantic tiers those values live on.
Revising a fund's rating is a manifest-YAML edit cited against a
tier here, not a rubric edit.

---

## Axis 1 — Access

"How directly can the state deploy fund assets into budget support
during a fiscal shock?"

Operationalized as a combination of legal mechanism (is there a
withdrawal rule?), political clarity (who authorizes deployment?),
and historical precedent (has deployment actually happened?).
Deployment SPEED (weeks vs months vs years) is the core signal.

| Tier | Value | Meaning | Concrete precedents |
|---|---|---|---|
| Nil access | **0.1** | Sanctions, asset freeze, or political paralysis makes deployment effectively impossible within a crisis window | Russia NWF (post-2022 asset freeze), Libya LIA (sanctions + frozen assets), Iran NDFI (sanctions + access concerns). Currently deferred from v1 for this reason. |
| Statutorily-gated long-horizon | **0.20** | Withdrawals require statutory supermajority / bicameral-equivalent action; gate has been crossed in extreme cases (single, capped draw under emergency law) but NOT for ordinary stabilization. Distinct from "Intergenerational savings" (0.3) because the gate is *statutory* rather than ruler-discretionary — Council-of-Ministers + parliamentary or constitutional thresholds replace head-of-state direction. | KIA Future Generations Fund (Decree 106 of 1976; Council-of-Ministers + Emir decree required; gate crossed once during COVID for a small capped draw). Phase 1B addition (Plan 2026-04-25-001). |
| Intergenerational savings | **0.3** | Pure long-horizon wealth-preservation mandate; no explicit stabilization rule; withdrawal requires ruler / head-of-state / parliamentary discretion with no codified trigger | ADIA (Abu Dhabi, intergenerational mandate, ruler-discretionary); Brunei BIA (deferred candidate) |
| Hybrid / constrained | **0.5** | Mandate mixes strategic + savings + partial stabilization; deployment is mechanically possible but constrained by strategic allocation locked to policy objectives (Vision 2030, industrial policy, geopolitical holdings) | PIF (Saudi Arabia, Vision 2030-locked), QIA (Qatar, long-horizon wealth-management with amiri-decree deployment), Mubadala (UAE, strategic + financial hybrid), Ireland ISIF (strategic-development mandate) |
| Explicit stabilization with rule | **0.7** | Legislated or rule-based mechanism for fiscal support during specific shock classes, with historical precedent of actual deployment | KIA General Reserve Fund (legislated finance of budget shortfalls from oil-revenue swings). NO GPFG is BORDERLINE — has a fiscal rule capping withdrawal at ~3% expected real return, which is an access MECHANISM but also an access CONSTRAINT (see below). NOTE: GIC is discussed in the alignment table below as a candidate for this tier based on its NIRC framework, but the current manifest rates it 0.6 — so it's a 0.7 *candidate*, not a 0.7 *precedent*. |
| Pure automatic stabilization | **0.9** | Deployment triggers automatically when a named macro signal crosses a threshold; stabilization is the primary mandate; political authorization is post-hoc or symbolic | Chile ESSF (deploys when copper revenue falls below a rule-based target); deferred v1 candidate |

### Edge case — fiscal-rule caps

A fiscal rule like Norway's ~3%-of-expected-real-return withdrawal
cap creates an ambiguous access signal:

- **Positive direction**: the rule makes access PREDICTABLE and
  mechanically available for budget support every year, without
  political negotiation.
- **Negative direction**: the rule CAPS how much can be tapped,
  so in a severe shock the fund cannot be liquidated beyond the
  rule. The mechanism protects the savings against panic but
  rate-limits the stabilization function.

**Rubric treatment**: fiscal-rule-capped funds sit at the 0.5-0.7
boundary. Norway's GPFG at 0.6 (current manifest value) is
defensible as "between hybrid-constrained and rule-based
stabilization."

### Edge case — state holding companies

Temasek-style state-holding-company assets can be deployed for
fiscal support only via DIVIDEND FLOW, not via primary-asset
liquidation (which would disrupt portfolio companies). This
mechanism is slow (dividends are typically annual) and bounded
(can't exceed portfolio earnings in a shock year). Rubric
treatment: 0.3-0.4 tier, NOT the 0.5 hybrid tier — the
mechanical deployment path is materially slower than QIA's
amiri-decree route.

---

## Axis 2 — Liquidity

"What share of the fund's AUM is in listed public markets and
thus liquidatable within days/weeks without fire-sale discount?"

Operationalized as (public equities + listed fixed income +
cash) ÷ total AUM, per the fund's most recent published asset
mix. When the disclosure is a range (ADIA publishes 55-70%, not
an exact ratio), the rubric uses the **upper-bound** of the
range — the fund's own public statement is that it COULD be up
to that figure, and haircut factors are designed to reward
disclosed LIQUIDITY CAPACITY, not the conservative worst case.
ADIA's 70% upper bound lands in the 0.7 tier (65-85%); if
future ADIA disclosures tighten the range so the upper bound
drops below 65%, the rubric directs the rating to 0.5.

| Tier | Value | Meaning | Concrete precedents |
|---|---|---|---|
| Illiquid-strategic dominant | **0.1** | Primarily domestic strategic holdings + policy banks + political stakes; < 30% public-market. No v1 fund sits here; reserved for future outliers | — (aspirational floor) |
| Private + illiquid majority | **0.3** | 30-50% public-market; majority in private equity, real estate, infrastructure, or strategic holdings | PIF (estimated ~40% public, dominated by Aramco + domestic megaprojects). Current manifest values PIF liquidity = 0.4 — AT BOUNDARY, defensible under either 0.3 or 0.5 tier |
| Mid-liquid mix | **0.5** | 50-65% public-market with material private sleeve | Mubadala (~50/50 per 2024 annual report); Temasek (~50% listed, ~50% unlisted per Temasek Review 2025); QIA (~60% public) — note current manifest QIA = 0.6, at the boundary of 0.5 and 0.7 tiers |
| Majority public | **0.7** | 65-85% public-market with modest private allocation | ADIA (55-70% public-market range per 2024 review, balance in alternatives + real assets) |
| Predominantly liquid | **0.9** | 85-95% public-market with modest cash + short-duration sleeves | KIA (~75-85% listed equities + fixed income — boundary 0.7/0.9, current manifest = 0.8); GIC (~90% public per 2024/25 annual report) |
| Fully liquid | **1.0** | 100% listed public markets — equities + fixed income + listed real estate. No private at all | GPFG (NBIM 2025 — 100% listed, no private markets) |

### Edge case — listed real estate

GPFG's listed real estate counts toward its liquidity score; PIF's
direct real estate holdings do NOT. The distinction matters for
boundary calls (0.7 vs 0.9): listed = liquidatable daily;
directly-owned = months to sell at disclosed valuations.

---

## Axis 3 — Transparency

"How well-documented is the fund's governance + financials?"

Operationalized as the Linaburg-Maduell (LM) Transparency Index
score, normalized against IFSWF membership status and the
granularity of the fund's annual reporting.

The LM index is a 10-point scale (1 = lowest, 10 = highest). IFSWF
membership is binary (member / observer / non-member). Annual-report
granularity gates tier promotion independently of LM/IFSWF.

| Tier | Value | Meaning | LM benchmark | Concrete precedents |
|---|---|---|---|---|
| Opaque | **0.1** | No public AUM, no governance reporting, no LM score | LM ≤ 1 | Deferred candidates: BIA (Brunei) if LM pins at the floor post-audit |
| Partial disclosure | **0.3** | Governance structure published but AUM undisclosed; no asset-mix disclosure; LM 2-4 | LM 2-4 | PIF (audited financials but line-item allocation limited; IFSWF observer not full member; LM ~4 per current manifest) |
| Asset-class disclosed | **0.5** | Audited AUM or published ranges, asset-class-level mix, partial IFSWF engagement | LM 5-6 | ADIA (annual review with asset-class ranges, partial IFSWF engagement, LM=6). QIA (limited public disclosure, IFSWF full member with audited filings, LM=5) — QIA currently manifest=0.4 may be marginally under-rated. KIA (LM=6, partial IFSWF engagement) currently manifest=0.4 — arguably under-rated |
| Audited AUM + returns | **0.7** | Audited AUM, asset-mix breakdown, benchmark-relative returns disclosed, IFSWF full member | LM 7-8 | GIC (asset-class breakdown + 20-year rolling returns, IFSWF full member, LM=8). Mubadala (audited AUM + asset-mix, IFSWF member, LM=10) — Mubadala LM=10 argues for 0.9 tier; current manifest=0.6 may be under-rated |
| Holdings-level | **0.9** | Full asset-class + top-holdings disclosure; regular updates; IFSWF full compliance | LM 9-10 | Temasek (audited NPV + benchmarked returns + top-20 holdings + LM=10, current manifest=0.9 ✓) |
| Full holdings-level daily | **1.0** | Daily returns disclosed, holdings-level reporting, full IFSWF compliance | LM=10 | GPFG (NBIM full audited AUM, daily returns, holdings-level reporting, LM=10, IFSWF full compliance) |

### Edge case — LM score vs disclosure depth

The LM index measures 10 governance signals (publication of
financials, independent audit, public objectives, etc.). A fund
can score LM=10 under the index while still publishing only
RANGED asset-mix rather than exact holdings (Mubadala, Temasek).
The rubric distinguishes these cases: LM=10 + holdings-level
disclosure → 0.9-1.0 tier; LM=10 + asset-class-only disclosure →
0.7-0.8 tier. Mubadala's current manifest 0.6 under-rates the
LM=10 signal against the rubric.

### Edge case — sealed filings

KIA files detailed financials to the Kuwaiti National Assembly
but the filings are SEALED from public disclosure. Under the
rubric this sits at the 0.5 tier (asset-class disclosed + IFSWF
engagement) rather than the 0.3 tier (no AUM), because the AUM
is audited and disclosed to the oversight body — just not
publicly. Current manifest = 0.4 is at the 0.3/0.5 boundary.

---

## Current manifest × rubric alignment (informational, not PR-changes)

Reviewing each of the 8 current manifest values against the
rubric tiers. **This PR does NOT edit the manifest.** The
column "Rubric tier" shows where the rating falls under this
rubric; "Manifest value" is the current YAML value; "Aligned?"
flags whether the rating fits the rubric or looks off.

| Fund | Axis | Manifest value | Rubric tier | Aligned? | Notes |
|---|---|---:|---|---|---|
| GPFG (NO) | access | 0.6 | Rule-constrained stabilization (between 0.5 and 0.7) | ✓ | Fiscal rule caps withdrawal — justifies boundary rating |
| GPFG (NO) | liquidity | 1.0 | Fully liquid | ✓ | NBIM 2025 confirms 100% listed |
| GPFG (NO) | transparency | 1.0 | Full holdings-level daily | ✓ | LM=10 + full IFSWF compliance |
| ADIA (AE) | access | 0.3 | Intergenerational savings | ✓ | No explicit stabilization mandate; ruler-discretionary |
| ADIA (AE) | liquidity | 0.7 | Majority public | ✓ | 55-70% public-market per 2024 review |
| ADIA (AE) | transparency | 0.5 | Asset-class disclosed | ✓ | LM=6; IFSWF partial engagement |
| Mubadala (AE) | access | 0.4 | Hybrid/constrained — below 0.5 tier | ⚠ | Current 0.4 is slightly under the 0.5 tier midpoint; 2024 ADQ merger arguably strengthens case for 0.5 |
| Mubadala (AE) | liquidity | 0.5 | Mid-liquid mix | ✓ | ~50/50 per 2024 report |
| Mubadala (AE) | transparency | 0.6 | Between 0.5 and 0.7 | ⚠ | LM=10 + IFSWF member argues for 0.7 (audited AUM + mix + returns); currently under-rated |
| PIF (SA) | access | 0.4 | Hybrid/constrained — below 0.5 tier | ⚠ | 0.5 tier fits the hybrid-mandate description; 0.4 is conservative. Arguable either way |
| PIF (SA) | liquidity | 0.4 | At 0.3/0.5 boundary | ⚠ | ~40% public-market sits at the top of 0.3 tier rather than middle of 0.5; 0.3 may be more honest |
| PIF (SA) | transparency | 0.3 | Partial disclosure | ✓ | LM ~4 + IFSWF observer-only |
| KIA (KW) | access | 0.7 | Explicit stabilization with rule | ✓ | General Reserve Fund's legislated budget-financing mandate is the canonical 0.7 example |
| KIA (KW) | liquidity | 0.8 | Between 0.7 and 0.9 | ✓ | 75-85% listed; defensible boundary rating |
| KIA (KW) | transparency | 0.4 | At 0.3/0.5 boundary | ⚠ | LM=6 + IFSWF partial-engagement argues for 0.5; current 0.4 is at the boundary; 0.5 may be slightly more accurate |
| QIA (QA) | access | 0.4 | Hybrid/constrained — below 0.5 tier | ⚠ | Long-horizon wealth management with amiri-decree deployment. 0.5 fits the hybrid tier; 0.4 is conservative |
| QIA (QA) | liquidity | 0.6 | Between 0.5 and 0.7 | ✓ | ~60% public-market sits at the tier boundary |
| QIA (QA) | transparency | 0.4 | At 0.3/0.5 boundary | ⚠ | LM=5 + IFSWF full member with audited filings argues for 0.5; current 0.4 is at the boundary |
| GIC (SG) | access | 0.6 | Rule-mechanism with NIRC | ⚠ | NIRC framework is explicit fiscal-contribution — arguably 0.7 tier (rule-based stabilization with historical precedent); current 0.6 is conservative |
| GIC (SG) | liquidity | 0.9 | Predominantly liquid | ✓ | ~90% public per 2024/25 report |
| GIC (SG) | transparency | 0.8 | Audited AUM + returns | ✓ | Asset-class + 20-year rolling returns; LM=8 |
| Temasek (SG) | access | 0.4 | State holding company — dividend-flow only | ✓ | Mechanical deployment is dividend-bound; 0.3-0.4 tier fits |
| Temasek (SG) | liquidity | 0.5 | Mid-liquid mix | ✓ | ~50% listed per 2025 Review |
| Temasek (SG) | transparency | 0.9 | Holdings-level | ✓ | Top-20 exposures + LM=10 |

**Summary of rubric-flagged ratings** — 8 coefficients across 5 funds
(Mubadala ×2, PIF ×2, KIA ×1, QIA ×2, GIC ×1) out of 24 total
(8 funds × 3 axes):

- Mubadala access 0.4 (arguably 0.5); transparency 0.6 (arguably 0.7)
- PIF access 0.4 (arguably 0.5); liquidity 0.4 (arguably 0.3)
- KIA transparency 0.4 (arguably 0.5)
- QIA access 0.4 (arguably 0.5); transparency 0.4 (arguably 0.5)
- GIC access 0.6 (arguably 0.7)

**None of these changes are made in this PR.** The flags are
informational — a future manifest-edit PR (PR 4b per the plan)
should evaluate each flag, cite the rubric tier, and either
confirm the current rating with a stronger rationale or revise
it to match the tier.

### Directional impact of the flagged ratings (if revised upward)

- Mubadala 0.4 → 0.5 on access, 0.6 → 0.7 on transparency: the
  access × transparency product moves from 0.24 to 0.35 (+46%).
  Combined with unchanged liquidity 0.5: haircut multiplier
  0.12 → 0.175. UAE gains material SWF-months.
- PIF access 0.4 → 0.5: modest lift. PIF liquidity 0.4 → 0.3:
  modest dampening. Net: small.
- KIA transparency 0.4 → 0.5: haircut multiplier 0.7×0.8×0.4
  = 0.224 → 0.7×0.8×0.5 = 0.28 (+25%). KW already top-quartile.
- QIA access 0.4 → 0.5 + transparency 0.4 → 0.5: QIA haircut
  0.096 → 0.15 (+56%). Material lift for QA.
- GIC access 0.6 → 0.7: haircut 0.432 → 0.504 (+17%). SG lift.

The directional impact analysis is INFORMATIONAL and should NOT
be treated as a decision to revise. Per the plan's anti-pattern
note, rubric flags shouldn't be motivated by a target ranking
outcome. A future manifest PR should revise ratings because the
rubric + cited precedents support the change, not because the
resulting ranking looks better.

---

## How to use this rubric

### When adding a new fund to the manifest

1. Locate each axis value on the tier table.
2. Cite the tier PLUS at least one concrete precedent (annual
   report page, LM index page, IFSWF profile URL).
3. If the fund sits between two tiers, pick the lower tier and
   explain the boundary rating in the YAML `rationale:` block.
4. PR review checks: does the rationale's cited evidence actually
   land the fund at the claimed tier?

### When revising an existing fund

1. Cite what EVIDENCE changed: new annual report, LM score
   revision, IFSWF membership change, mandate amendment.
2. Map the new evidence to a tier per this rubric.
3. Update BOTH the coefficient AND the `rationale:` text in the
   same PR.
4. For PRs that shift multiple coefficients: run the cohort-
   sanity audit (see `docs/methodology/cohort-sanity-release-gate.md`)
   and publish the contribution-decomposition table for the
   affected countries.

### When the rubric itself needs revising

Out of scope for a manifest PR. A rubric revision requires:

1. A separate methodology-decision PR citing the construct gap
   the revision fixes (e.g., "the current rubric doesn't handle
   state holding companies well — add a dedicated tier").
2. Re-evaluation of every existing fund under the new rubric
   (the rubric and the manifest must stay in lockstep).
3. Cohort-sanity audit snapshot before/after.

## References

- Manifest: `scripts/shared/swf-classification-manifest.yaml`
- Scorer: `server/worldmonitor/resilience/v1/_dimension-scorers.ts`
  line 1654 (`scoreSovereignFiscalBuffer`)
- Saturating transform: `score = 100 × (1 − exp(−effectiveMonths / 12))`
- Linaburg-Maduell Transparency Index methodology:
  https://www.swfinstitute.org/research/linaburg-maduell-transparency-index
- IFSWF member directory: https://www.ifswf.org/members
- Santiago Principles self-assessments: https://www.ifswf.org/santiago-principles
- Plan reference:
  `docs/plans/2026-04-24-002-fix-resilience-cohort-ranking-structural-audit-plan.md`
  §PR 4
