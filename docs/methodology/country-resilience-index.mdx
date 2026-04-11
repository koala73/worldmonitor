# WorldMonitor Country Resilience Index — Methodology

## Overview

The WorldMonitor Country Resilience Index scores 222 countries on a 0-100 scale across 5 domains and 13 dimensions. It combines structural baseline indicators (governance quality, health infrastructure, fiscal capacity) with real-time stress signals (cyber threats, conflict events, shipping disruption) to produce a single resilience score updated every 6 hours.

Data is sourced from official and authoritative providers: World Bank, IMF, WHO, WTO, OFAC, UNHCR, UCDP, BIS, IEA, FAO, Reporters Sans Frontieres, and the Institute for Economics and Peace, among others.

## Domains and Weights

The index is organized into 5 domains. Each domain weight reflects its relative contribution to overall national resilience.

| Domain | ID | Weight | Dimensions |
|---|---|---|---|
| Economic | `economic` | 0.22 | Macro-Fiscal, Currency & External, Trade & Sanctions |
| Infrastructure | `infrastructure` | 0.20 | Cyber & Digital, Logistics & Supply, Infrastructure |
| Energy | `energy` | 0.15 | Energy |
| Social & Governance | `social-governance` | 0.25 | Governance, Social Cohesion, Border Security, Information |
| Health & Food | `health-food` | 0.18 | Health & Public Service, Food & Water |

Weights sum to 1.00.

## Dimensions and Indicators

Each dimension is scored from 0-100 using a weighted blend of its sub-metrics. Below is the complete indicator registry.

### Economic Domain (weight 0.22)

#### Macro-Fiscal

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| govRevenuePct | Government revenue as % of GDP (IMF GGR_G01_GDP_PT) | Higher is better | 5 - 45 | 0.50 | IMF | Annual |
| debtGrowthRate | Annual debt growth rate | Lower is better | 20 - 0 | 0.20 | National debt data | Annual |
| currentAccountPct | Current account balance as % of GDP (IMF) | Higher is better | -20 - 20 | 0.30 | IMF | Annual |

#### Currency & External

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| fxVolatility | Annualized BIS real effective exchange rate volatility | Lower is better | 50 - 0 | 0.60 | BIS | Monthly |
| fxDeviation | Absolute deviation of BIS real EER from equilibrium (100) | Lower is better | 35 - 0 | 0.25 | BIS | Monthly |
| fxReservesAdequacy | Total reserves in months of imports (World Bank FI.RES.TOTL.MO) | Higher is better | 1 - 12 | 0.15 | World Bank | Annual |

For non-BIS countries (~160 countries), a fallback chain applies: (1) IMF inflation + World Bank reserves proxy, (2) IMF inflation alone, (3) reserves alone, (4) conservative imputation (score 50, certainty 0.3).

#### Trade & Sanctions

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| sanctionCount | OFAC sanctions entity count; piecewise normalization | Lower is better | 200 - 0 | 0.45 | OFAC | Daily |
| tradeRestrictions | WTO trade restrictions count (IN_FORCE weighted 3x) | Lower is better | 30 - 0 | 0.15 | WTO | Weekly |
| tradeBarriers | WTO trade barrier notifications count | Lower is better | 40 - 0 | 0.15 | WTO | Weekly |
| appliedTariffRate | Applied tariff rate, weighted mean, all products (World Bank TM.TAX.MRCH.WM.AR.ZS) | Lower is better | 20 - 0 | 0.25 | World Bank | Annual |

Sanctions use piecewise normalization: 0 entities = score 100, 1-10 = 90-75, 11-50 = 75-50, 51-200 = 50-25, 201+ tapers toward 0.

### Infrastructure Domain (weight 0.20)

#### Cyber & Digital

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| cyberThreats | Severity-weighted cyber threat count (critical 3x, high 2x, medium 1x, low 0.5x) | Lower is better | 25 - 0 | 0.45 | Cyber threat feeds | Daily |
| internetOutages | Internet outage penalty (total 4x, major 2x, partial 1x) | Lower is better | 20 - 0 | 0.35 | Outage monitoring | Realtime |
| gpsJamming | GPS jamming hex penalty (high 3x, medium 1x) | Lower is better | 20 - 0 | 0.20 | GPSJam | Daily |

#### Logistics & Supply

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| roadsPavedLogistics | Paved roads as % of total road network (World Bank IS.ROD.PAVE.ZS) | Higher is better | 0 - 100 | 0.50 | World Bank | Annual |
| shippingStress | Global shipping stress score | Lower is better | 100 - 0 | 0.25 | Supply-chain monitor | Daily |
| transitDisruption | Mean transit corridor disruption | Lower is better | 30 - 0 | 0.25 | Transit summaries | Daily |

#### Infrastructure

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| electricityAccess | Access to electricity, % of population (World Bank EG.ELC.ACCS.ZS) | Higher is better | 40 - 100 | 0.40 | World Bank | Annual |
| roadsPavedInfra | Paved roads as % of total road network (World Bank IS.ROD.PAVE.ZS) | Higher is better | 0 - 100 | 0.35 | World Bank | Annual |
| infraOutages | Internet outage penalty (shared source with Cyber & Digital) | Lower is better | 20 - 0 | 0.25 | Outage monitoring | Realtime |

### Energy Domain (weight 0.15)

#### Energy

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| energyImportDependency | IEA energy import dependency (% of supply from imports) | Lower is better | 100 - 0 | 0.25 | IEA | Annual |
| gasShare | Natural gas share of energy mix | Lower is better | 100 - 0 | 0.12 | Energy mix data | Annual |
| coalShare | Coal share of energy mix | Lower is better | 100 - 0 | 0.08 | Energy mix data | Annual |
| renewShare | Renewable energy share of energy mix | Higher is better | 0 - 100 | 0.05 | Energy mix data | Annual |
| gasStorageStress | Gas storage fill stress: (80 - fillPct) / 80, clamped [0,1] | Lower is better | 100 - 0 | 0.10 | GIE AGSI+ | Daily |
| energyPriceStress | Mean absolute energy price change across commodities | Lower is better | 25 - 0 | 0.10 | Energy prices | Daily |
| electricityConsumption | Per-capita electricity consumption (kWh/year, World Bank EG.USE.ELEC.KH.PC) | Higher is better | 200 - 8000 | 0.30 | World Bank | Annual |

### Social & Governance Domain (weight 0.25)

#### Governance

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| wgiVoiceAccountability | World Bank WGI: Voice and Accountability | Higher is better | -2.5 - 2.5 | 1/6 | World Bank WGI | Annual |
| wgiPoliticalStability | World Bank WGI: Political Stability | Higher is better | -2.5 - 2.5 | 1/6 | World Bank WGI | Annual |
| wgiGovernmentEffectiveness | World Bank WGI: Government Effectiveness | Higher is better | -2.5 - 2.5 | 1/6 | World Bank WGI | Annual |
| wgiRegulatoryQuality | World Bank WGI: Regulatory Quality | Higher is better | -2.5 - 2.5 | 1/6 | World Bank WGI | Annual |
| wgiRuleOfLaw | World Bank WGI: Rule of Law | Higher is better | -2.5 - 2.5 | 1/6 | World Bank WGI | Annual |
| wgiControlOfCorruption | World Bank WGI: Control of Corruption | Higher is better | -2.5 - 2.5 | 1/6 | World Bank WGI | Annual |

All six WGI indicators are equally weighted.

#### Social Cohesion

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| gpiScore | Global Peace Index score | Lower is better | 3.6 - 1.0 | 0.55 | IEP | Annual |
| displacementTotal | UNHCR total displaced persons (log10 scale) | Lower is better | 7 - 0 | 0.25 | UNHCR | Annual |
| unrestEvents | Severity-weighted unrest events + sqrt(fatalities) | Lower is better | 20 - 0 | 0.20 | Unrest monitoring | Realtime |

#### Border Security

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| ucdpConflict | UCDP armed conflict: eventCount*2 + typeWeight + sqrt(deaths) | Lower is better | 30 - 0 | 0.65 | UCDP | Realtime |
| displacementHosted | UNHCR hosted displaced persons (log10 scale) | Lower is better | 7 - 0 | 0.35 | UNHCR | Annual |

#### Information & Cognitive

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| rsfPressFreedom | RSF press freedom score | Higher is better | 0 - 100 | 0.55 | RSF | Annual |
| socialVelocity | Reddit social velocity (log10(velocity+1)) | Lower is better | 3 - 0 | 0.15 | Reddit intelligence | Realtime |
| newsThreatScore | AI news threat severity (critical 4x, high 2x, medium 1x, low 0.5x) | Lower is better | 20 - 0 | 0.30 | News threat analysis | Daily |

### Health & Food Domain (weight 0.18)

#### Health & Public Service

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| uhcIndex | WHO Universal Health Coverage service coverage index | Higher is better | 40 - 90 | 0.45 | WHO | Annual |
| measlesCoverage | Measles immunization coverage among 1-year-olds (%) | Higher is better | 50 - 99 | 0.35 | WHO | Annual |
| hospitalBeds | Hospital beds per 1,000 people | Higher is better | 0 - 8 | 0.20 | WHO | Annual |

#### Food & Water

| Indicator | Description | Direction | Goalposts (worst-best) | Weight | Source | Cadence |
|---|---|---|---|---|---|---|
| ipcPeopleInCrisis | IPC/FAO people in food crisis (log10 scale) | Lower is better | 7 - 0 | 0.45 | FAO/IPC | Annual |
| ipcPhase | IPC food crisis phase (1-5) | Lower is better | 5 - 1 | 0.15 | FAO/IPC | Annual |
| aquastatWaterStress | FAO AQUASTAT water stress/withdrawal/dependency (%) | Lower is better | 100 - 0 | 0.25 | FAO AQUASTAT | Annual |
| aquastatWaterAvailability | FAO AQUASTAT water availability (m3/capita) | Higher is better | 0 - 5000 | 0.15 | FAO AQUASTAT | Annual |

## Normalization

All indicators are normalized to a 0-100 scale using **goalpost scaling** (also called min-max normalization with domain-specific anchors).

For "higher is better" indicators:

```
score = clamp((value - worst) / (best - worst) * 100, 0, 100)
```

For "lower is better" indicators:

```
score = clamp((worst - value) / (worst - best) * 100, 0, 100)
```

Goalposts are hand-picked based on empirical data ranges (not percentile-derived). A score of 100 means the country meets or exceeds the "best" goalpost; 0 means it meets or exceeds the "worst" goalpost.

**Exception:** Sanctions use piecewise normalization to capture the non-linear impact of sanctions counts (the first few sanctions matter more than additional ones in already-sanctioned countries).

## Scoring Formula

### Dimension Score

Each dimension score is the **weighted blend** of its sub-metric scores:

```
dimensionScore = sum(metricScore_i * metricWeight_i) / sum(metricWeight_i)
```

Only metrics with available data participate in the blend. Missing metrics are excluded from both the numerator and denominator, so the score reflects what is known rather than penalizing for absent data.

### Domain Score

Each domain score is the **coverage-weighted mean** of its dimensions:

```
domainScore = sum(dimensionScore_i * dimensionCoverage_i) / sum(dimensionCoverage_i)
```

Coverage weighting ensures that dimensions with sparse data (low coverage) contribute proportionally less, preventing a low-coverage dimension from dragging the domain average down.

### Overall Score

The overall score is a **domain-weighted sum**:

```
overallScore = sum(domainScore_i * domainWeight_i)
```

Each domain's weight is defined in the configuration. The weights sum to 1.0, so the overall score is a straightforward weighted average of domain scores.
| Food & Water | Mixed |

### Resilience Level Classification

| Score Range | Level |
|---|---|
| 70-100 | High |
| 40-69 | Medium |
| 0-39 | Low |

## Missing Data Handling

### Coverage Tracking

Each dimension carries a `coverage` value (0.0-1.0) representing the weighted certainty of its data. Real observed data contributes certainty 1.0. Imputed data contributes partial certainty. Absent data contributes 0.

```
coverage = sum(metricWeight_i * certainty_i) / sum(metricWeight_i)
```

### Imputation Taxonomy

When data is absent, the system distinguishes between two cases:

1. **Absence as signal** (`absenceSignal`): The country is not in a crisis-monitoring dataset (IPC food crisis, UNHCR displacement, UCDP conflict) because it is stable. Absence is a strong positive signal. These receive high imputed scores (85-88) with moderate certainty (0.6-0.7).

2. **Conservative imputation** (`conservative`): The country is not in a curated dataset (BIS exchange rates, WTO trade data) because it was not selected for coverage. Absence is neutral-to-unknown. These receive middling scores (50-60) with low certainty (0.3-0.4).

| Imputation Context | Score | Certainty | Rationale |
|---|---|---|---|
| Crisis monitoring absent (general) | 85 | 0.7 | Stable countries are not tracked by crisis monitors |
| IPC food crisis absent | 88 | 0.7 | No food crisis data = likely food-secure |
| UNHCR displacement absent | 85 | 0.6 | Low displacement = no crisis |
| BIS exchange rate absent | 50 | 0.3 | Not in curated set; unknown, penalized conservatively |
| WTO trade data absent | 60 | 0.4 | Not in curated reporter set; moderately penalized |

### Low Confidence Flag

A score is flagged as `lowConfidence` when either:

- Average dimension coverage falls below **0.55**, or
- Imputation share (imputed weight / total weight) exceeds **0.40**.

### Grey-Out Threshold

Countries with overall coverage below **0.40** are greyed out in the UI and excluded from rankings. Their scores are too data-sparse to be meaningful.

### Imputation Share

The API response includes `imputationShare` (0.0-1.0), representing the fraction of total indicator weight that came from imputed (synthetic) data rather than observed data. This allows consumers to assess data provenance.

## Data Sources

| Source | Indicators | Cadence | Scope |
|---|---|---|---|
| IMF (WEO/IFS) | Government revenue, current account, inflation | Annual | Global |
| World Bank (WDI) | Electricity access, paved roads, reserves, tariffs, electricity consumption | Annual | Global |
| World Bank (WGI) | 6 governance indicators | Annual | Global |
| BIS | Real effective exchange rates | Monthly | ~60 countries |
| OFAC | Sanctions entity counts | Daily | Global |
| WTO | Trade restrictions, trade barriers | Weekly | ~50 reporters |
| WHO | UHC index, measles coverage, hospital beds | Annual | Global |
| FAO (IPC) | People in food crisis, crisis phase | Annual | Affected countries |
| FAO (AQUASTAT) | Water stress, water availability | Annual | Global |
| IEA | Energy import dependency | Annual | Global |
| IEP | Global Peace Index | Annual | Global |
| RSF | Press freedom score | Annual | Global |
| UNHCR | Displaced persons, hosted refugees | Annual | Affected countries |
| UCDP | Armed conflict events, fatalities | Realtime | Global |
| Cyber threat feeds | Severity-weighted cyber threats | Daily | Global |
| Outage monitoring | Internet outages | Realtime | Global |
| GPSJam | GPS jamming incidents | Daily | Global |
| Supply-chain monitor | Shipping stress, transit disruption | Daily | Global |
| Unrest monitoring | Severity-weighted civil unrest events | Realtime | Global |
| Reddit intelligence | Social velocity scores | Realtime | Global |
| News threat analysis | AI-scored news threat severity | Daily | Global |
| Energy mix data | Gas, coal, renewable shares | Annual | Global |
| GIE AGSI+ | Gas storage fill levels | Daily | European countries |
| Energy prices | Commodity price changes | Daily | Global |
| National debt data | Debt-to-GDP growth rate | Annual | Global |

## Supplementary Fields

The API response includes additional context fields that are informational and not part of the primary ranking:

- **baselineScore**: Coverage-weighted mean of baseline and mixed dimensions. Reflects structural capacity (governance, health, infrastructure, fiscal strength). Informational only, not used in `overallScore`.
- **stressScore**: Coverage-weighted mean of stress and mixed dimensions. Reflects current threat environment (cyber, conflict, sanctions, supply disruption). Informational only, not used in `overallScore`.
- **trend**: Direction of score movement over the last 30 days (`improving`, `stable`, or `declining`), based on daily score history.
- **change30d**: Numeric score change over 30 days.
- **imputationShare**: Fraction of indicator weight from imputed (synthetic) data.
- **lowConfidence**: Boolean flag when data coverage or imputation thresholds are breached.

## Versioning

Cache keys include a versioned suffix that is bumped on formula changes. This invalidates stale caches and ensures all scores reflect the updated methodology. Score cache TTL is 6 hours.
