import type { ResilienceDimensionId } from './_dimension-scorers.ts';

// Phase 2 T2.2a signal tiering. See docs/internal/country-resilience-upgrade-plan.md
// section "Signal tiering (Core / Enrichment / Experimental)".
export type IndicatorTier = 'core' | 'enrichment' | 'experimental';

// Phase 2 T2.2a license audit field. The values come from the parent plan's
// licensing audit workstream (Phase 2 A9). New entries that have not yet been
// audited use 'unknown' as a placeholder; the linter test reports the count
// without failing so the audit can chase them.
export type IndicatorLicense =
  | 'public-domain' // WGI, WHO GHO, FRED, UN Comtrade (openly usable)
  | 'open-data' // ND-GAIN, World Bank Open Data, IMF Open Data (CC-BY or similar)
  | 'open-attribution' // GDELT, RSF Index, OWID (attribution required)
  | 'research-only' // UCDP (Uppsala), ACLED (academic/press), INFORM-Global (CC-BY-NC)
  | 'non-commercial' // FSI, BIS EER, GPI/IEP (free with carve-out)
  | 'proprietary' // Bloomberg, S&P Global Platts (not used in Core)
  | 'unknown'; // placeholder for any indicator still awaiting license audit

export type IndicatorSpec = {
  id: string;
  dimension: ResilienceDimensionId;
  description: string;
  direction: 'higherBetter' | 'lowerBetter';
  goalposts: { worst: number; best: number };
  weight: number;
  sourceKey: string;
  scope: 'global' | 'curated';
  cadence: 'realtime' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';
  imputation?: { type: 'absenceSignal' | 'conservative'; score: number; certainty: number };
  // Phase 2 T2.2a additions (REQUIRED on every entry):
  tier: IndicatorTier; // Core = moves the public overall score, Enrichment = drill-down only, Experimental = internal
  coverage: number; // expected country count; the tier linter enforces Core >= 180
  license: IndicatorLicense; // source license category for the audit trail
  // Plan 2026-04-26-002 §U5 (combined PR 3+4+5) — source-comprehensiveness flag.
  // True when the upstream source enumerates ALL UN-member countries
  // (or as close as the underlying universe allows): IPC, UNHCR, UCDP,
  // FATF listings, WHO global indicators, IMF WEO, WB annual statistical
  // series. False when the source is an event-scraping feed, English-
  // biased, a curated subset (BIS LBS by-parent reporters list, WTO
  // tariff-overview top-50 reporters, IEA OECD-only series), or a
  // real-time signal whose absence does not encode "stable absence."
  // Used by IMPUTE callers in _dimension-scorers.ts: when reaching for
  // a stable-absence anchor (85/0.6 or 88/0.7), if the underlying source
  // is non-comprehensive, fall back to `unmonitored` (50/0.3) instead.
  // Conservative default: when in doubt, mark `false` (the lower-confidence
  // impute is the safer error-mode per the plan §risk-mitigation row).
  comprehensive: boolean;
};

export const INDICATOR_REGISTRY: IndicatorSpec[] = [
  // ── macroFiscal (4 sub-metrics) ───────────────────────────────────────────
  {
    id: 'govRevenuePct',
    dimension: 'macroFiscal',
    description: 'Government revenue as % of GDP (IMF GGR_G01_GDP_PT); fiscal capacity proxy',
    direction: 'higherBetter',
    goalposts: { worst: 5, best: 45 },
    weight: 0.4,
    sourceKey: 'economic:imf:macro:v2',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 212,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'debtGrowthRate',
    dimension: 'macroFiscal',
    description: 'Annual debt growth rate; rapid accumulation signals fiscal stress',
    direction: 'lowerBetter',
    goalposts: { worst: 20, best: 0 },
    weight: 0.2,
    sourceKey: 'economic:national-debt:v1',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 190,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'currentAccountPct',
    dimension: 'macroFiscal',
    description: 'Current account balance as % of GDP (IMF); external position vulnerability',
    direction: 'higherBetter',
    goalposts: { worst: -20, best: 20 },
    weight: 0.2,
    sourceKey: 'economic:imf:macro:v2',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 190,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'unemploymentPct',
    dimension: 'macroFiscal',
    description: 'Unemployment rate (IMF WEO LUR); higher = labor-market slack & lower fiscal absorption capacity',
    direction: 'lowerBetter',
    goalposts: { worst: 25, best: 3 },
    weight: 0.15,
    sourceKey: 'economic:imf:labor:v1',
    scope: 'global',
    cadence: 'annual',
    tier: 'enrichment',
    coverage: 150,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'householdDebtService',
    dimension: 'macroFiscal',
    description: 'BIS household debt service ratio (% income, quarterly). DSR > 10% precedes banking crises (Drehmann 2011). Lower is safer; goalposts anchor 20% → 0, 0% → 100.',
    direction: 'lowerBetter',
    goalposts: { worst: 20, best: 0 },
    weight: 0.05,
    sourceKey: 'economic:bis:dsr:v1',
    scope: 'curated',
    cadence: 'quarterly',
    imputation: { type: 'conservative', score: 60, certainty: 0.3 },
    tier: 'enrichment',
    coverage: 40,
    license: 'non-commercial',
    comprehensive: false,
  },

  // ── currencyExternal ─────────────────────────────────────────────────────
  // PR 3 §3.5 point 3 rebalanced the dimension's core scoring:
  //   - BIS-dependent signals (fxVolatility, fxDeviation) moved to
  //     tier='experimental'. BIS EER covers ~64 economies, which is too
  //     narrow for a world-ranking Core signal. They remain in the registry
  //     for drill-down / enrichment panels but scoreCurrencyExternal no
  //     longer reads them.
  //   - Core scoring is now: inflationStability (IMF CPI, ~185 countries)
  //     at weight 0.6, fxReservesAdequacy (WB FI.RES.TOTL.MO, ~188 countries)
  //     at weight 0.4. Both are global-coverage, so every country gets the
  //     same construct regardless of BIS membership.
  {
    id: 'inflationStability',
    dimension: 'currencyExternal',
    description: 'IMF CPI inflation (lower is better). Global-coverage primary signal for currency stability. Core input to scoreCurrencyExternal under PR 3 §3.5. A future PR may upgrade this to a 5-year inflation-volatility computation once the seeder tracks the series; headline inflation is a reasonable first-cut for stability ranking.',
    direction: 'lowerBetter',
    goalposts: { worst: 50, best: 0 },
    weight: 0.6,
    sourceKey: 'economic:imf:macro:v2',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 185,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'fxReservesAdequacy',
    dimension: 'currencyExternal',
    description: 'Total reserves in months of imports (World Bank FI.RES.TOTL.MO). Global-coverage core signal for currency stability; paired with inflationStability in scoreCurrencyExternal after PR 3 §3.5 rebalancing.',
    direction: 'higherBetter',
    goalposts: { worst: 1, best: 12 },
    weight: 0.4,
    sourceKey: 'resilience:static:*',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 188,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'fxVolatility',
    dimension: 'currencyExternal',
    description: 'Annualized BIS real effective exchange rate volatility (std-dev of monthly changes * sqrt(12)). Enrichment-only for the ~64 BIS-tracked economies after PR 3 §3.5 — NOT read by scoreCurrencyExternal. Available via drill-down panels only.',
    direction: 'lowerBetter',
    goalposts: { worst: 50, best: 0 },
    weight: 0.6,
    sourceKey: 'economic:bis:eer:v1',
    scope: 'curated',
    cadence: 'monthly',
    imputation: { type: 'conservative', score: 50, certainty: 0.3 },
    tier: 'experimental',
    coverage: 60,
    license: 'non-commercial',
    comprehensive: false,
  },
  {
    id: 'fxDeviation',
    dimension: 'currencyExternal',
    description: 'Absolute deviation of latest BIS real EER from 100 (equilibrium index). Enrichment-only for the ~64 BIS-tracked economies after PR 3 §3.5 — NOT read by scoreCurrencyExternal. Available via drill-down panels only.',
    direction: 'lowerBetter',
    goalposts: { worst: 35, best: 0 },
    weight: 0.25,
    sourceKey: 'economic:bis:eer:v1',
    scope: 'curated',
    cadence: 'monthly',
    imputation: { type: 'conservative', score: 50, certainty: 0.3 },
    tier: 'experimental',
    coverage: 60,
    license: 'non-commercial',
    comprehensive: false,
  },

  // ── tradePolicy (3 sub-metrics) ───────────────────────────────────────────
  // Renamed from tradeSanctions in plan 2026-04-25-004 Phase 1 (Ship 1).
  // The OFAC `sanctionCount` indicator binding (was weight 0.45) is DROPPED;
  // domicile-of-designated-entities is a corporate-finance liability metric,
  // not a country-resilience indicator. Remaining 3 components reweighted
  // to total 1.0 (0.30 / 0.30 / 0.40).
  {
    id: 'tradeRestrictions',
    dimension: 'tradePolicy',
    description: 'WTO trade restrictions count (IN_FORCE weighted 3x); curated reporter set',
    direction: 'lowerBetter',
    goalposts: { worst: 30, best: 0 },
    weight: 0.30,
    sourceKey: 'trade:restrictions:v1:tariff-overview:50',
    scope: 'curated',
    cadence: 'weekly',
    imputation: { type: 'conservative', score: 60, certainty: 0.4 },
    // WTO tariff-overview reporter set is the curated top-50 reporters; below
    // the Core 180 gate so the signal sits in Enrichment until a wider seeder
    // ships in a future PR.
    tier: 'enrichment',
    coverage: 50,
    license: 'open-data',
    comprehensive: false,
  },
  {
    id: 'tradeBarriers',
    dimension: 'tradePolicy',
    description: 'WTO trade barrier notifications count; curated reporter set',
    direction: 'lowerBetter',
    goalposts: { worst: 40, best: 0 },
    weight: 0.30,
    sourceKey: 'trade:barriers:v1:tariff-gap:50',
    scope: 'curated',
    cadence: 'weekly',
    imputation: { type: 'conservative', score: 60, certainty: 0.4 },
    tier: 'enrichment',
    coverage: 50,
    license: 'open-data',
    comprehensive: false,
  },
  {
    id: 'appliedTariffRate',
    dimension: 'tradePolicy',
    description: 'World Bank applied tariff rate, weighted mean, all products (TM.TAX.MRCH.WM.AR.ZS); 0%=free trade, 20%+=heavily restricted',
    direction: 'lowerBetter',
    goalposts: { worst: 20, best: 0 },
    weight: 0.40,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 188,
    license: 'open-data',
    comprehensive: true,
  },

  // ── financialSystemExposure (4 sub-metrics) ───────────────────────────────
  // plan 2026-04-25-004 Phase 2: structural sanctions vulnerability built
  // from BIS Locational Banking Statistics + WB IDS short-term external
  // debt + FATF AML/CFT listing status. Replaces the dropped OFAC-domicile
  // signal (Phase 1) with audited cross-border banking + AML/CFT data
  // that doesn't conflate transit-hub corporate domicile with host-country
  // risk. Components 2 + 4 share the BIS LBS payload (no separate seed).
  // Dim is 'core' (contributes to headline score) but BIS-derived
  // indicators are 'enrichment' / 'non-commercial' per Codex R1 #8 to
  // match the existing BIS classification convention.
  {
    id: 'shortTermExternalDebtPctGni',
    dimension: 'financialSystemExposure',
    description: 'Short-term external debt as % of GNI (WB IDS DT.DOD.DSTC.IR.ZS × DT.DOD.DECT.GN.ZS); IMF Article IV vulnerability threshold is 15% GNI',
    direction: 'lowerBetter',
    goalposts: { worst: 15, best: 0 },
    weight: 0.35,
    sourceKey: 'economic:wb-external-debt:v1',
    scope: 'global',
    cadence: 'annual',
    imputation: { type: 'conservative', score: 50, certainty: 0.3 },
    // WB IDS publishes for ~125 LMICs only; HIC fall through to BIS LBS structural-exposure component.
    // Tagged 'enrichment' (not 'core') because the lint test enforces
    // core indicators must have coverage >= 180; LMIC-only is below
    // that gate by definition. Component carries weight 0.35 inside the
    // dim regardless of tier — the tier is a documentation classification.
    tier: 'enrichment',
    coverage: 125,
    license: 'open-data',
    // §U5 review fix: comprehensive=false. WB IDS coverage is the LMIC
    // subset (~125 countries), NOT the universe. HIC absence from this
    // source is NOT a stable-absence signal — those countries fall through
    // to the BIS LBS structural-exposure component instead. Marking
    // comprehensive=true would let any future IMPUTE caller treat HIC
    // absence as the high stable-absence anchor (85+), which would
    // misrepresent HIC financial-system exposure.
    comprehensive: false,
  },
  {
    id: 'bisLbsXborderPctGdp',
    dimension: 'financialSystemExposure',
    description: 'BIS LBS sum of by-parent cross-border claims (US/UK/major-EU/CH/JP/CA/AU/SG) as % of GDP; U-shape band — both isolation (<5%) and over-exposure (>60%) score low',
    direction: 'lowerBetter', // U-shape is "lowerBetter" in semantic sense (concentrated exposure penalized)
    // NOTE (Greptile P2 catch, PR #3407 review): goalposts here are
    // DOCUMENTATION-ONLY for the over-exposed branch. The actual scorer
    // uses `normalizeBandLowerBetter` (a U-shape, not a linear lowerBetter
    // mapping), which peaks at 25% and penalizes both extremes. A linear
    // `{worst, best}` cannot represent a U-shape; we set goalposts to the
    // peak (best=25) and the over-exposed worst-anchor (worst=60). Tooling
    // / lints that read these values to compute "expected" component
    // scores must consult `normalizeBandLowerBetter` directly, not assume
    // these are the inputs to a generic linear normalizer.
    goalposts: { worst: 60, best: 25 },
    weight: 0.30,
    sourceKey: 'economic:bis-lbs:v1',
    scope: 'global',
    cadence: 'quarterly',
    tier: 'enrichment',
    coverage: 200,
    license: 'non-commercial', // BIS terms of use; redistributed under attribution
    comprehensive: false,
  },
  {
    id: 'fatfListingStatus',
    dimension: 'financialSystemExposure',
    description: 'FATF AML/CFT listing status — black list (call for action) → 0, gray list (increased monitoring) → 30, compliant → 100',
    direction: 'higherBetter',
    goalposts: { worst: 0, best: 100 },
    weight: 0.20,
    sourceKey: 'economic:fatf-listing:v1',
    scope: 'global',
    cadence: 'monthly',
    tier: 'core',
    coverage: 200,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'financialCenterRedundancy',
    dimension: 'financialSystemExposure',
    description: 'Count of distinct BIS LBS by-parent reporters with non-trivial (>1% GDP) cross-border claims on the country; rewards multi-counterparty financial centers, balances Component 2 over-exposure penalty',
    direction: 'higherBetter',
    goalposts: { worst: 1, best: 10 },
    weight: 0.15,
    sourceKey: 'economic:bis-lbs:v1', // shares BIS LBS seed with Component 2
    scope: 'global',
    cadence: 'quarterly',
    tier: 'enrichment',
    coverage: 200,
    license: 'non-commercial',
    comprehensive: false,
  },

  // ── cyberDigital (3 sub-metrics) ──────────────────────────────────────────
  {
    id: 'cyberThreats',
    dimension: 'cyberDigital',
    description: 'Severity-weighted cyber threat count (critical=3x, high=2x, medium=1x, low=0.5x)',
    direction: 'lowerBetter',
    goalposts: { worst: 25, best: 0 },
    weight: 0.45,
    sourceKey: 'cyber:threats:v2',
    scope: 'global',
    cadence: 'daily',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: false,
  },
  {
    id: 'internetOutages',
    dimension: 'cyberDigital',
    description: 'Internet outage penalty (total=4x, major=2x, partial=1x)',
    direction: 'lowerBetter',
    goalposts: { worst: 20, best: 0 },
    weight: 0.35,
    sourceKey: 'infra:outages:v1',
    scope: 'global',
    cadence: 'realtime',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: false,
  },
  {
    id: 'gpsJamming',
    dimension: 'cyberDigital',
    description: 'GPS jamming hex penalty (high=3x, medium=1x)',
    direction: 'lowerBetter',
    goalposts: { worst: 20, best: 0 },
    weight: 0.2,
    sourceKey: 'intelligence:gpsjam:v2',
    scope: 'global',
    cadence: 'daily',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: false,
  },

  // ── logisticsSupply (3 sub-metrics) ───────────────────────────────────────
  {
    id: 'roadsPavedLogistics',
    dimension: 'logisticsSupply',
    description: 'Paved roads as % of total road network (World Bank IS.ROD.PAVE.ZS)',
    direction: 'higherBetter',
    goalposts: { worst: 0, best: 100 },
    weight: 0.5,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 188,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'shippingStress',
    dimension: 'logisticsSupply',
    description: 'Global shipping stress score from supply-chain monitor',
    direction: 'lowerBetter',
    goalposts: { worst: 100, best: 0 },
    weight: 0.25,
    sourceKey: 'supply_chain:shipping_stress:v1',
    scope: 'global',
    cadence: 'daily',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: false,
  },
  {
    id: 'transitDisruption',
    dimension: 'logisticsSupply',
    description: 'Mean transit corridor disruption (disruptionPct + incidentCount7d * 0.5)',
    direction: 'lowerBetter',
    goalposts: { worst: 30, best: 0 },
    weight: 0.25,
    sourceKey: 'supply_chain:transit-summaries:v1',
    scope: 'global',
    cadence: 'daily',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: false,
  },

  // ── infrastructure (3 sub-metrics) ────────────────────────────────────────
  {
    id: 'electricityAccess',
    dimension: 'infrastructure',
    description: 'Access to electricity as % of population (World Bank EG.ELC.ACCS.ZS)',
    direction: 'higherBetter',
    goalposts: { worst: 40, best: 100 },
    weight: 0.4,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 217,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'roadsPavedInfra',
    dimension: 'infrastructure',
    description: 'Paved roads as % of total road network (World Bank IS.ROD.PAVE.ZS)',
    direction: 'higherBetter',
    goalposts: { worst: 0, best: 100 },
    weight: 0.35,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 188,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'infraOutages',
    dimension: 'infrastructure',
    description: 'Internet outage penalty (total=4x, major=2x, partial=1x); shared source with cyberDigital',
    direction: 'lowerBetter',
    goalposts: { worst: 20, best: 0 },
    weight: 0.25,
    sourceKey: 'infra:outages:v1',
    scope: 'global',
    cadence: 'realtime',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: false,
  },

  // ── energy (7 sub-metrics) ────────────────────────────────────────────────
  {
    id: 'energyImportDependency',
    dimension: 'energy',
    description: 'IEA energy import dependency (% of total energy supply from imports)',
    direction: 'lowerBetter',
    goalposts: { worst: 100, best: 0 },
    weight: 0.25,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 188,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'gasShare',
    dimension: 'energy',
    description: 'Natural gas share of energy mix (%); high share = single-source vulnerability',
    direction: 'lowerBetter',
    goalposts: { worst: 100, best: 0 },
    weight: 0.12,
    sourceKey: 'energy:mix:v1:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: true,
  },
  {
    id: 'coalShare',
    dimension: 'energy',
    description: 'Coal share of energy mix (%); high share = transition risk and pollution',
    direction: 'lowerBetter',
    goalposts: { worst: 100, best: 0 },
    weight: 0.08,
    sourceKey: 'energy:mix:v1:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: true,
  },
  {
    id: 'renewShare',
    dimension: 'energy',
    description: 'Renewable energy share of energy mix (%); diversification and resilience',
    direction: 'higherBetter',
    goalposts: { worst: 0, best: 100 },
    weight: 0.05,
    sourceKey: 'energy:mix:v1:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: true,
  },
  {
    id: 'gasStorageStress',
    dimension: 'energy',
    description: 'Gas storage fill stress: (80 - fillPct) / 80 clamped to [0,1], scaled to 0-100',
    direction: 'lowerBetter',
    goalposts: { worst: 100, best: 0 },
    weight: 0.1,
    sourceKey: 'energy:gas-storage:v1:{ISO2}',
    scope: 'global',
    cadence: 'daily',
    // GIE AGSI+ covers EU + a few neighbours; below the Core 180 gate so the
    // signal lives in Enrichment until a wider gas-storage feed lands.
    tier: 'enrichment',
    coverage: 38,
    license: 'open-attribution',
    comprehensive: false,
  },
  {
    id: 'energyPriceStress',
    dimension: 'energy',
    description: 'Mean absolute energy price change across commodities',
    direction: 'lowerBetter',
    goalposts: { worst: 25, best: 0 },
    weight: 0.1,
    sourceKey: 'economic:energy:v1:all',
    scope: 'global',
    cadence: 'daily',
    tier: 'core',
    coverage: 195,
    license: 'public-domain',
    comprehensive: true,
  },
  {
    id: 'electricityConsumption',
    dimension: 'energy',
    description: 'Per-capita electricity consumption (kWh/year, World Bank EG.USE.ELEC.KH.PC); low = grid collapse',
    direction: 'higherBetter',
    goalposts: { worst: 200, best: 8000 },
    weight: 0.3,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 217,
    license: 'open-data',
    comprehensive: true,
  },

  // ── PR 1 energy-construct v2 (tier='experimental' until RESILIENCE_ENERGY_V2_ENABLED ──
  // flips default-on and seeders land). Indicators are registered so
  // the per-indicator harness in scripts/compare-resilience-current-vs-
  // proposed.mjs can begin tracking them, but the 'experimental' tier
  // keeps them OUT of the Core coverage gate (>=180 countries required
  // per Phase 2 A4) until seed coverage is confirmed at flag-flip.
  {
    id: 'importedFossilDependence',
    dimension: 'energy',
    description: 'Composite: fossil share of electricity (EG.ELC.FOSL.ZS) × max(net energy imports % of primary energy use, 0) / 100. Lower is better. Replaces gasShare + coalShare + dependency under the Option B (power-system security) framing.',
    direction: 'lowerBetter',
    goalposts: { worst: 100, best: 0 },
    weight: 0.35,
    sourceKey: 'resilience:fossil-electricity-share:v1',
    scope: 'global',
    cadence: 'annual',
    imputation: { type: 'conservative', score: 50, certainty: 0.3 },
    tier: 'experimental',
    coverage: 190,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'lowCarbonGenerationShare',
    dimension: 'energy',
    description: 'Low-carbon share of electricity generation: nuclear + renewables-ex-hydro + hydroelectric (World Bank EG.ELC.NUCL.ZS + EG.ELC.RNEW.ZS + EG.ELC.HYRO.ZS). Hydro is summed separately because WB RNEW explicitly excludes hydroelectric — omitting HYRO would collapse this indicator to ~0 for Norway (~95% hydro), Paraguay (~99%), Brazil (~65%), Canada (~60%). Absorbs the legacy renewShare and adds nuclear + hydro credit.',
    direction: 'higherBetter',
    goalposts: { worst: 0, best: 80 },
    weight: 0.2,
    sourceKey: 'resilience:low-carbon-generation:v1',
    scope: 'global',
    cadence: 'annual',
    imputation: { type: 'conservative', score: 30, certainty: 0.3 },
    tier: 'experimental',
    coverage: 190,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'powerLossesPct',
    dimension: 'energy',
    description: 'Electric power transmission + distribution losses (World Bank EG.ELC.LOSS.ZS). Direct grid-integrity measure. Weight is 0.20 in PR 1 — it temporarily absorbs the deferred reserveMarginPct slot (plan §3.1 open-question); when the IEA electricity-balance seeder lands, split 0.10 back out and restore reserveMarginPct at 0.10. Keep this field in lockstep with scoreEnergyV2 in _dimension-scorers.ts, because the PR 0 compare harness copies spec.weight into nominalWeight for gate-9 reporting.',
    direction: 'lowerBetter',
    goalposts: { worst: 25, best: 3 },
    weight: 0.2,
    sourceKey: 'resilience:power-losses:v1',
    scope: 'global',
    cadence: 'annual',
    imputation: { type: 'conservative', score: 50, certainty: 0.3 },
    tier: 'experimental',
    coverage: 188,
    license: 'open-data',
    comprehensive: true,
  },
  // reserveMarginPct is DEFERRED per plan §3.1 open-question: IEA
  // electricity-balance data is sparse outside OECD+G20 and the
  // indicator will likely ship as tier='unmonitored' with weight 0.05
  // if it lands at all. Registering the indicator before a seeder
  // exists would orphan its sourceKey in the seed-meta coverage
  // test. The v2 scorer still READS from resilience:reserve-margin:v1
  // (key reserved in _dimension-scorers.ts) so the scorer shape
  // stays stable for the commit that provides data. Add the registry
  // entry in that follow-up commit.

  // ── governanceInstitutional (6 sub-metrics, equal weight) ─────────────────
  {
    id: 'wgiVoiceAccountability',
    dimension: 'governanceInstitutional',
    description: 'World Bank WGI: Voice and Accountability (-2.5 to +2.5)',
    direction: 'higherBetter',
    goalposts: { worst: -2.5, best: 2.5 },
    weight: 1 / 6,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 214,
    license: 'public-domain',
    comprehensive: true,
  },
  {
    id: 'wgiPoliticalStability',
    dimension: 'governanceInstitutional',
    description: 'World Bank WGI: Political Stability and Absence of Violence (-2.5 to +2.5)',
    direction: 'higherBetter',
    goalposts: { worst: -2.5, best: 2.5 },
    weight: 1 / 6,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 214,
    license: 'public-domain',
    comprehensive: true,
  },
  {
    id: 'wgiGovernmentEffectiveness',
    dimension: 'governanceInstitutional',
    description: 'World Bank WGI: Government Effectiveness (-2.5 to +2.5)',
    direction: 'higherBetter',
    goalposts: { worst: -2.5, best: 2.5 },
    weight: 1 / 6,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 214,
    license: 'public-domain',
    comprehensive: true,
  },
  {
    id: 'wgiRegulatoryQuality',
    dimension: 'governanceInstitutional',
    description: 'World Bank WGI: Regulatory Quality (-2.5 to +2.5)',
    direction: 'higherBetter',
    goalposts: { worst: -2.5, best: 2.5 },
    weight: 1 / 6,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 214,
    license: 'public-domain',
    comprehensive: true,
  },
  {
    id: 'wgiRuleOfLaw',
    dimension: 'governanceInstitutional',
    description: 'World Bank WGI: Rule of Law (-2.5 to +2.5)',
    direction: 'higherBetter',
    goalposts: { worst: -2.5, best: 2.5 },
    weight: 1 / 6,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 214,
    license: 'public-domain',
    comprehensive: true,
  },
  {
    id: 'wgiControlOfCorruption',
    dimension: 'governanceInstitutional',
    description: 'World Bank WGI: Control of Corruption (-2.5 to +2.5)',
    direction: 'higherBetter',
    goalposts: { worst: -2.5, best: 2.5 },
    weight: 1 / 6,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 214,
    license: 'public-domain',
    comprehensive: true,
  },

  // ── socialCohesion (3 sub-metrics) ────────────────────────────────────────
  {
    id: 'gpiScore',
    dimension: 'socialCohesion',
    description: 'Global Peace Index score; empirical range 1.1 (Iceland) to 3.4 (Yemen 2024)',
    direction: 'lowerBetter',
    goalposts: { worst: 3.6, best: 1.0 },
    weight: 0.55,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    // GPI/IEP covers 163 economies, below the Phase 2 A4 Core gate of 180.
    // Demoted to Enrichment so the overall public score is not driven by a
    // signal that misses ~30 countries; PR 4 (T2.3) aggregation will respect
    // this. The license is also non-commercial (IEP carve-out), which would
    // independently disqualify Core. See parent plan, "Signal tiering" section.
    tier: 'enrichment',
    coverage: 163,
    license: 'non-commercial',
    comprehensive: true,
  },
  {
    id: 'displacementTotal',
    dimension: 'socialCohesion',
    description: 'UNHCR total displaced persons (log10 scale); absent = null (excluded from blend, no imputation)',
    direction: 'lowerBetter',
    goalposts: { worst: 7, best: 0 },
    weight: 0.25,
    sourceKey: 'displacement:summary:v1:{year}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 200,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'unrestEvents',
    dimension: 'socialCohesion',
    description: 'Unrest event count (severity-weighted) + sqrt(fatalities)',
    direction: 'lowerBetter',
    goalposts: { worst: 20, best: 0 },
    weight: 0.2,
    sourceKey: 'unrest:events:v1',
    scope: 'global',
    cadence: 'realtime',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: false,
  },

  // ── borderSecurity (2 sub-metrics) ────────────────────────────────────────
  {
    id: 'ucdpConflict',
    dimension: 'borderSecurity',
    description: 'UCDP armed conflict metric: eventCount*2 + typeWeight + sqrt(deaths)',
    direction: 'lowerBetter',
    goalposts: { worst: 30, best: 0 },
    weight: 0.65,
    sourceKey: 'conflict:ucdp-events:v1',
    scope: 'global',
    cadence: 'realtime',
    // UCDP is global (193 countries) but the license is research-only
    // (Uppsala). The parent plan keeps UCDP Core; the linter allowlist
    // KNOWN_EXCEPTIONS in tests/resilience-indicator-tiering.test.mts holds
    // the carve-out until Phase 2 A9 licensing review resolves it.
    tier: 'core',
    coverage: 193,
    license: 'research-only',
    comprehensive: true,
  },
  {
    id: 'displacementHosted',
    dimension: 'borderSecurity',
    description: 'UNHCR hosted/total displaced persons (log10 scale); refugee pressure proxy',
    direction: 'lowerBetter',
    goalposts: { worst: 7, best: 0 },
    weight: 0.35,
    sourceKey: 'displacement:summary:v1:{year}',
    scope: 'global',
    cadence: 'annual',
    imputation: { type: 'absenceSignal', score: 85, certainty: 0.6 },
    tier: 'core',
    coverage: 200,
    license: 'open-data',
    comprehensive: true,
  },

  // ── informationCognitive (3 sub-metrics) ──────────────────────────────────
  // Promoted back to Core in T2.9 after language / source-density
  // normalization landed (getLanguageCoverageFactor in _language-coverage.ts).
  // Social velocity and news threat scores are now adjusted by the
  // English-language coverage factor before normalization.
  {
    id: 'rsfPressFreedom',
    dimension: 'informationCognitive',
    description: 'Reporters Sans Frontieres press freedom score (0-100)',
    direction: 'higherBetter',
    goalposts: { worst: 0, best: 100 },
    weight: 0.55,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 180,
    license: 'open-attribution',
    comprehensive: true,
  },
  {
    id: 'socialVelocity',
    dimension: 'informationCognitive',
    description: 'Reddit social velocity score (log10(velocity+1)); language-normalized viral narrative stress',
    direction: 'lowerBetter',
    goalposts: { worst: 3, best: 0 },
    weight: 0.15,
    sourceKey: 'intelligence:social:reddit:v1',
    scope: 'global',
    cadence: 'realtime',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: false,
  },
  {
    id: 'newsThreatScore',
    dimension: 'informationCognitive',
    description: 'AI news threat summary (critical=4x, high=2x, medium=1x, low=0.5x); language-normalized',
    direction: 'lowerBetter',
    goalposts: { worst: 20, best: 0 },
    weight: 0.3,
    sourceKey: 'news:threat:summary:v1',
    scope: 'global',
    cadence: 'daily',
    tier: 'core',
    coverage: 195,
    license: 'open-attribution',
    comprehensive: false,
  },

  // ── healthPublicService (3 sub-metrics) ───────────────────────────────────
  {
    id: 'uhcIndex',
    dimension: 'healthPublicService',
    description: 'WHO Universal Health Coverage service coverage index (0-100)',
    direction: 'higherBetter',
    goalposts: { worst: 40, best: 90 },
    weight: 0.45,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 194,
    license: 'public-domain',
    comprehensive: true,
  },
  {
    id: 'measlesCoverage',
    dimension: 'healthPublicService',
    description: 'WHO measles immunization coverage among 1-year-olds (%)',
    direction: 'higherBetter',
    goalposts: { worst: 50, best: 99 },
    weight: 0.35,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 194,
    license: 'public-domain',
    comprehensive: true,
  },
  {
    id: 'hospitalBeds',
    dimension: 'healthPublicService',
    description: 'WHO hospital beds per 1,000 people',
    direction: 'higherBetter',
    goalposts: { worst: 0, best: 8 },
    weight: 0.2,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 194,
    license: 'public-domain',
    comprehensive: true,
  },

  // ── foodWater (3 sub-metrics) ─────────────────────────────────────────────
  {
    id: 'ipcPeopleInCrisis',
    dimension: 'foodWater',
    description: 'IPC/FAO people in food crisis (log10 scale)',
    direction: 'lowerBetter',
    goalposts: { worst: 7, best: 0 },
    weight: 0.45,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    imputation: { type: 'absenceSignal', score: 88, certainty: 0.7 },
    // IPC measured coverage is ~52 crisis-tracked countries; absence is a
    // strong positive signal (stable-absence imputation, score 88), so the
    // effective country coverage is global. Stays Core per the parent plan.
    tier: 'core',
    coverage: 195,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'ipcPhase',
    dimension: 'foodWater',
    description: 'IPC food crisis phase (1-5 scale)',
    direction: 'lowerBetter',
    goalposts: { worst: 5, best: 1 },
    weight: 0.15,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    imputation: { type: 'absenceSignal', score: 88, certainty: 0.7 },
    tier: 'core',
    coverage: 195,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'aquastatWaterStress',
    dimension: 'foodWater',
    description: 'FAO AQUASTAT stress/withdrawal/dependency indicators (% scale 0-100)',
    direction: 'lowerBetter',
    goalposts: { worst: 100, best: 0 },
    weight: 0.25,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 188,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'aquastatWaterAvailability',
    dimension: 'foodWater',
    description: 'FAO AQUASTAT availability/renewable/access indicators (0-100 % or 0-5000 m3/capita)',
    direction: 'higherBetter',
    goalposts: { worst: 0, best: 5000 },
    weight: 0.15,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 188,
    license: 'open-data',
    comprehensive: true,
  },

  // ── fiscalSpace (3 sub-metrics) ──────────────────────────────────────────
  {
    id: 'recoveryGovRevenue',
    dimension: 'fiscalSpace',
    description: 'Government revenue as % of GDP (IMF GGR_G01_GDP_PT); fiscal mobilization capacity for recovery',
    direction: 'higherBetter',
    goalposts: { worst: 5, best: 45 },
    weight: 0.4,
    sourceKey: 'resilience:recovery:fiscal-space:v1',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 190,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'recoveryFiscalBalance',
    dimension: 'fiscalSpace',
    description: 'General government net lending/borrowing as % of GDP (IMF GGXCNL_G01_GDP_PT); deficit signals reduced recovery firepower',
    direction: 'higherBetter',
    goalposts: { worst: -15, best: 5 },
    weight: 0.3,
    sourceKey: 'resilience:recovery:fiscal-space:v1',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 190,
    license: 'open-data',
    comprehensive: true,
  },
  {
    id: 'recoveryDebtToGdp',
    dimension: 'fiscalSpace',
    description: 'General government gross debt as % of GDP (IMF GGXWDG_NGDP_PT); high debt limits recovery borrowing capacity',
    direction: 'lowerBetter',
    goalposts: { worst: 150, best: 0 },
    weight: 0.3,
    sourceKey: 'resilience:recovery:fiscal-space:v1',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 190,
    license: 'open-data',
    comprehensive: true,
  },

  // ── reserveAdequacy (RETIRED in PR 2 §3.4) ───────────────────────────────
  // Replaced by liquidReserveAdequacy + sovereignFiscalBuffer. The legacy
  // indicator is kept in the registry at tier='experimental' so drill-
  // down views that consult the registry by dimension still see
  // something structural; it does not contribute to the core score.
  {
    id: 'recoveryReserveMonths',
    dimension: 'reserveAdequacy',
    description: 'RETIRED in PR 2 §3.4. Legacy total-reserves-in-months-of-imports (WB FI.RES.TOTL.MO) at the 1..18 anchor. Does not contribute to the score — scoreReserveAdequacy returns coverage=0 + imputationClass=null. Superseded by recoveryLiquidReserveMonths (same source, re-anchored 1..12) + the new sovereign-wealth indicator.',
    direction: 'higherBetter',
    goalposts: { worst: 1, best: 18 },
    weight: 1.0,
    sourceKey: 'resilience:recovery:reserve-adequacy:v1',
    scope: 'global',
    cadence: 'annual',
    tier: 'experimental',
    coverage: 188,
    license: 'open-data',
    comprehensive: true,
  },

  // ── liquidReserveAdequacy (1 sub-metric) ─────────────────────────────────
  // PR 2 §3.4 replacement for the liquid-reserves half of the retired
  // reserveAdequacy. Same source (WB FI.RES.TOTL.MO) but re-anchored
  // 1..12 months instead of 1..18. Twelve months ≈ IMF "full reserve
  // adequacy" ballpark for a diversified emerging-market importer.
  {
    id: 'recoveryLiquidReserveMonths',
    dimension: 'liquidReserveAdequacy',
    description: 'Total reserves in months of imports (World Bank FI.RES.TOTL.MO), re-anchored 1..12 per plan §3.4. Immediate-liquidity buffer against short external shocks, measured at central-bank reserves only — sovereign-wealth assets are scored separately in sovereignFiscalBuffer.',
    direction: 'higherBetter',
    goalposts: { worst: 1, best: 12 },
    weight: 1.0,
    sourceKey: 'resilience:recovery:reserve-adequacy:v1',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 188,
    license: 'open-data',
    comprehensive: true,
  },

  // ── sovereignFiscalBuffer (1 sub-metric) ─────────────────────────────────
  // PR 2 §3.4 — scored on the SWF haircut manifest. Payload produced by
  // scripts/seed-sovereign-wealth.mjs (landed in #3305, wired into
  // Railway cron in #3319). Per-country totalEffectiveMonths is the sum
  // across a country's manifest funds of (aum / annualImports × 12) ×
  // (access × liquidity × transparency). Scorer applies a saturating
  // transform: score = 100 × (1 − exp(−effectiveMonths / 12)) to prevent
  // Norway-type outliers from dominating the recovery pillar.
  //
  // Coverage for the registry entry is the current manifest size (8
  // funds across NO / AE / SA / KW / QA / SG). Countries NOT in the
  // manifest score 0 with full coverage (substantive "no SWF" signal,
  // not imputation) — this is by design per plan §3.4 "What happens to
  // no-SWF countries."
  {
    id: 'recoverySovereignWealthEffectiveMonths',
    dimension: 'sovereignFiscalBuffer',
    description: 'Sovereign-wealth fiscal-buffer signal per plan §3.4. Seeded from Wikipedia SWF list + per-fund article infoboxes (CC-BY-SA), haircut by the classification manifest (scripts/shared/swf-classification-manifest.yaml): effectiveMonths = rawSwfMonths × access × liquidity × transparency, summed across a country\'s manifest funds. Scorer applies a saturating transform score = 100 × (1 − exp(−effectiveMonths / 12)).',
    direction: 'higherBetter',
    goalposts: { worst: 0, best: 60 },
    weight: 1.0,
    sourceKey: 'resilience:recovery:sovereign-wealth:v1',
    scope: 'global',
    cadence: 'quarterly',
    // tier='experimental' because the manifest ships with 8 funds (< the
    // 180-country core-tier threshold / 137-country §3.6 gate). Non-SWF
    // countries are scored as dim-not-applicable (score 0, coverage 0,
    // imputationClass 'not-applicable') per plan 2026-04-26-001 §U3 —
    // reframed from the original "substantive absence" decision in plan
    // 2026-04-25-001 §3.4. The §3.6 coverage-and-influence gate counts
    // upstream-data coverage, which is 8. Graduating to 'core' requires
    // expanding the manifest past 137 entries, which is a follow-up PR
    // after external data partners are identified.
    tier: 'experimental',
    coverage: 8,
    license: 'open-data',
    comprehensive: false,
  },

  // ── externalDebtCoverage (1 sub-metric) ──────────────────────────────────
  {
    id: 'recoveryDebtToReserves',
    dimension: 'externalDebtCoverage',
    description: 'Short-term external debt to reserves ratio (World Bank DT.DOD.DSTC.CD / FI.RES.TOTL.CD); Greenspan-Guidotti rule treats ratio≥1 as reserve inadequacy, ratio≥2 as acute rollover-shock exposure',
    direction: 'lowerBetter',
    // PR 3 §3.5 point 3: re-goalposted from (0..5) to (0..2). Old goalpost
    // saturated at 100 across the full 9-country probe including stressed
    // states. New anchor: ratio=1.0 (Greenspan-Guidotti reserve-adequacy
    // threshold) maps to score 50; ratio=2.0 (double the threshold, acute
    // distress) maps to 0. Ratios above 2.0 clamp to 0 — consistent with
    // "beyond this point the precise value stops mattering, the country
    // is already in a rollover-crisis regime."
    goalposts: { worst: 2, best: 0 },
    weight: 1.0,
    sourceKey: 'resilience:recovery:external-debt:v1',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 185,
    license: 'open-data',
    comprehensive: true,
  },

  // ── importConcentration (1 sub-metric) ───────────────────────────────────
  {
    id: 'recoveryImportHhi',
    dimension: 'importConcentration',
    description: 'Herfindahl-Hirschman Index of import partner concentration (UN Comtrade HS2 bilateral); higher HHI = more dependent on fewer partners = slower recovery if a key partner is disrupted',
    direction: 'lowerBetter',
    goalposts: { worst: 5000, best: 0 },
    weight: 1.0,
    sourceKey: 'resilience:recovery:import-hhi:v1',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 190,
    license: 'public-domain',
    comprehensive: true,
  },

  // ── stateContinuity (3 sub-metrics, derived from existing keys) ──────────
  {
    id: 'recoveryWgiContinuity',
    dimension: 'stateContinuity',
    description: 'Mean WGI score as institutional durability proxy; higher governance = better state continuity under shock',
    direction: 'higherBetter',
    goalposts: { worst: -2.5, best: 2.5 },
    weight: 0.5,
    sourceKey: 'resilience:static:{ISO2}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 214,
    license: 'public-domain',
    comprehensive: true,
  },
  {
    id: 'recoveryConflictPressure',
    dimension: 'stateContinuity',
    description: 'UCDP conflict metric inverted to state continuity; active conflict directly undermines state continuity',
    direction: 'lowerBetter',
    goalposts: { worst: 30, best: 0 },
    weight: 0.3,
    sourceKey: 'conflict:ucdp-events:v1',
    scope: 'global',
    cadence: 'realtime',
    tier: 'core',
    coverage: 193,
    license: 'research-only',
    comprehensive: true,
  },
  {
    id: 'recoveryDisplacementVelocity',
    dimension: 'stateContinuity',
    description: 'UNHCR displacement as state continuity signal; mass displacement signals state function breakdown',
    direction: 'lowerBetter',
    goalposts: { worst: 7, best: 0 },
    weight: 0.2,
    sourceKey: 'displacement:summary:v1:{year}',
    scope: 'global',
    cadence: 'annual',
    tier: 'core',
    coverage: 200,
    license: 'open-data',
    comprehensive: true,
  },

  // ── fuelStockDays (1 sub-metric) ─────────────────────────────────────────
  // PR 3 §3.5 point 1: RETIRED from the core score. IEA emergency-
  // stockholding is defined in days of NET IMPORTS; the net-importer
  // vs net-exporter framings are incomparable, so no global resilience
  // signal can be built from this data. scoreFuelStockDays now returns
  // coverage=0 + imputationClass=null for every country (filtered out
  // of confidence/coverage averages via the RESILIENCE_RETIRED_DIMENSIONS
  // registry in _dimension-scorers.ts). imputationClass is deliberately
  // `null` rather than 'source-failure' — a retirement is structural,
  // not a runtime outage, and surfacing 'source-failure' would manufacture
  // a false "Source down" label in the widget for every country. The
  // registry entry stays at tier='experimental' so the Core coverage
  // gate treats it as out-of-score; the dimension itself remains
  // registered for structural continuity (PR 4 structural-audit may
  // remove it entirely).
  {
    id: 'recoveryFuelStockDays',
    dimension: 'fuelStockDays',
    description: 'RETIRED in PR 3. Legacy days-of-fuel-stock-cover (IEA Oil Stocks / EIA Weekly Petroleum Status). Does not contribute to the score — scoreFuelStockDays returns coverage=0 + imputationClass=null, and the dimension is excluded from confidence/coverage averages via the RESILIENCE_RETIRED_DIMENSIONS registry. Kept in the registry as tier=experimental for structural continuity; a globally-comparable recovery-fuel concept could replace this in a future PR.',
    direction: 'higherBetter',
    goalposts: { worst: 0, best: 120 },
    weight: 1.0,
    sourceKey: 'resilience:recovery:fuel-stocks:v1',
    scope: 'global',
    cadence: 'monthly',
    tier: 'experimental',
    coverage: 45,
    license: 'open-data',
    comprehensive: false,
  },
];

// Plan 2026-04-26-002 §U5 helpers — registry-driven check used by IMPUTE
// callers in _dimension-scorers.ts. Keeping this lookup here (rather than
// inlining .find() at every scorer) makes the comprehensiveness contract
// auditable (one source of truth for the rule "absence on a non-
// comprehensive source falls back to unmonitored").

const INDICATOR_BY_ID: ReadonlyMap<string, IndicatorSpec> = new Map(
  INDICATOR_REGISTRY.map((spec) => [spec.id, spec]),
);

/**
 * Returns true when the upstream source for the given indicator id
 * enumerates ALL UN-member countries (or as close as the underlying
 * universe allows). Returns false for non-comprehensive sources (event
 * feeds, curated subsets, regional registries).
 *
 * Conservative default for unknown ids: false — matches the plan's
 * "when in doubt, mark `comprehensive: false`" risk-mitigation rule.
 * Returning false for an unknown id means a stable-absence IMPUTE caller
 * falls back to `unmonitored` (50/0.3), which is the safer error mode.
 */
export function isIndicatorComprehensive(indicatorId: string): boolean {
  const spec = INDICATOR_BY_ID.get(indicatorId);
  return spec?.comprehensive ?? false;
}
