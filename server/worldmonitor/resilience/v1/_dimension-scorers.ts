import countryNames from '../../../../shared/country-names.json';
import iso2ToIso3Json from '../../../../shared/iso2-to-iso3.json';
import { normalizeCountryToken } from '../../../_shared/country-token';
import { getCachedJson } from '../../../_shared/redis';
import { classifyDimensionFreshness, readFreshnessMap, resolveSeedMetaKey } from './_dimension-freshness';
import { getLanguageCoverageFactor } from './_language-coverage';
import { failedDimensionsFromDatasets, readFailedDatasets } from './_source-failure';

export type ResilienceDimensionId =
  | 'macroFiscal'
  | 'currencyExternal'
  | 'tradePolicy'
  | 'financialSystemExposure'  // plan 2026-04-25-004 Phase 2: structural sanctions vulnerability via BIS LBS + WB IDS + FATF
  | 'cyberDigital'
  | 'logisticsSupply'
  | 'infrastructure'
  | 'energy'
  | 'governanceInstitutional'
  | 'socialCohesion'
  | 'borderSecurity'
  | 'informationCognitive'
  | 'healthPublicService'
  | 'foodWater'
  | 'fiscalSpace'
  | 'reserveAdequacy'      // RETIRED in PR 2 §3.4: replaced by
                            // liquidReserveAdequacy + sovereignFiscalBuffer
                            // (see RESILIENCE_RETIRED_DIMENSIONS below).
  | 'externalDebtCoverage'
  | 'importConcentration'
  | 'stateContinuity'
  | 'fuelStockDays'
  | 'liquidReserveAdequacy'    // PR 2 §3.4: WB FI.RES.TOTL.MO, anchors 1..12 months
  | 'sovereignFiscalBuffer';   // PR 2 §3.4: SWF haircut with saturating transform

export type ResilienceDomainId =
  | 'economic'
  | 'infrastructure'
  | 'energy'
  | 'social-governance'
  | 'health-food'
  | 'recovery';

export interface ResilienceDimensionScore {
  score: number;
  coverage: number;
  observedWeight: number;
  imputedWeight: number;
  // T1.7 schema pass: the dominant imputation class when the dimension is
  // fully imputed (observedWeight === 0 && imputedWeight > 0), null when the
  // dimension has any observed data or no data at all.
  imputationClass: ImputationClass | null;
  // T1.5 propagation pass: freshness aggregated across the dimension's
  // constituent signals. Individual scorers return the zero value
  // (`{ lastObservedAtMs: 0, staleness: '' }`); `scoreAllDimensions`
  // decorates the real value in using `classifyDimensionFreshness`.
  // See server/worldmonitor/resilience/v1/_dimension-freshness.ts.
  freshness: { lastObservedAtMs: number; staleness: '' | 'fresh' | 'aging' | 'stale' };
}

export type ResilienceSeedReader = (key: string) => Promise<unknown | null>;

interface WeightedMetric {
  score: number | null;
  weight: number;
  // When a sub-metric is imputed (absence is a typed signal, not a gap), certaintyCoverage
  // expresses how confident we are in the imputation: 1.0 = real data, 0 = fully absent.
  // Omit for real data (auto: 1.0 if score != null, 0 if null).
  certaintyCoverage?: number;
  // True only for synthetic absence-based scores (IMPUTATION/IMPUTE constants).
  // Proxy data with certaintyCoverage < 1 (e.g. IMF inflation fallback) is still
  // observed real data and should NOT set this flag.
  imputed?: boolean;
  // T1.7 schema pass: populated only when imputed=true so weightedBlend can
  // aggregate a dominant class at the dimension level.
  imputationClass?: ImputationClass;
}

// Four-class imputation taxonomy (Phase 1 T1.7 of the country-resilience
// reference-grade upgrade plan, docs/internal/country-resilience-upgrade-plan.md).
//
// Every absence-based imputation is tagged with one of these classes so
// downstream consumers (widget confidence bar, benchmark per-family gates,
// methodology changelog) can distinguish:
//   - stable-absence: the source publishes globally and the country is not
//     listed, which means the tracked phenomenon is not happening (e.g.,
//     no IPC Phase 3+ = no food crisis; no UCDP event = no conflict).
//     Score is a strong positive with high certainty.
//   - unmonitored: the source is a curated list that may not cover every
//     country. Absence is ambiguous; we penalize conservatively with
//     low certainty.
//   - source-failure: the upstream API was unavailable at seed time.
//     Should be rare and transient; detected from seed-meta failedDatasets.
//     (Not currently represented in the tables below; reserved for the
//     runtime path that consults seed-meta and injects this class when a
//     dataset is in failedDatasets. Wired in T1.9.)
//   - not-applicable: the dimension is structurally N/A for this country
//     (e.g., a landlocked country has no maritime exposure). Score is
//     neutral with high certainty since the absence is by definition.
//     (Reserved for future dimensions that need structural N/A handling;
//     no current scorer branches on it.)
//
// This is the foundation-only slice of T1.7. It lands the type, tags the
// existing imputation tables, and is covered by tests that assert every
// entry carries a class and the class matches its semantic family. The
// schema-level propagation (imputationBreakdown field on the response and
// widget rendering of per-dimension imputation icons) is deliberately
// deferred to T1.5 / T1.6 so each task has a bounded, reviewable PR.
export type ImputationClass =
  | 'stable-absence'
  | 'unmonitored'
  | 'source-failure'
  | 'not-applicable';

export interface ImputationEntry {
  score: number;
  certaintyCoverage: number;
  imputationClass: ImputationClass;
}

// Absence of a data source is a typed signal, not an unknown gap.
// Each value is { score, certaintyCoverage, imputationClass } applied when
// the source is absent.
export const IMPUTATION = {
  // Country not in IPC/UNHCR/UCDP because it's stable, not because data is missing.
  // Absence = strong positive signal.
  crisis_monitoring_absent: { score: 85, certaintyCoverage: 0.7, imputationClass: 'stable-absence' },
  // Country not in BIS/WTO curated list. Data exists but country wasn't selected.
  // Absence = neutral-to-negative (unknown, penalized conservatively).
  curated_list_absent: { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
} as const satisfies Record<string, ImputationEntry>;

// Per-metric overrides where the generic imputation table values differ.
// Every override carries its own imputationClass tag so the class is
// preserved at every call site, not inferred from naming.
export const IMPUTE = {
  ipcFood:           { score: 88, certaintyCoverage: 0.7, imputationClass: 'stable-absence' },  // crisis_monitoring_absent, food-specific
  wtoData:           { score: 60, certaintyCoverage: 0.4, imputationClass: 'unmonitored' },      // curated_list_absent, trade-specific
  bisEer:            IMPUTATION.curated_list_absent,
  bisCredit:         IMPUTATION.curated_list_absent,
  unhcrDisplacement: { score: 85, certaintyCoverage: 0.6, imputationClass: 'stable-absence' },  // crisis_monitoring_absent, displacement-specific
  recoveryFiscalSpace:     { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
  // recoveryReserveAdequacy removed in PR 2 §3.4 — the retired
  // scoreReserveAdequacy stub no longer reads from IMPUTE (it hardcodes
  // coverage=0 / imputationClass=null per the retirement pattern). The
  // replacement dimension's IMPUTE entry lives at
  // `recoveryLiquidReserveAdequacy` below.
  recoveryExternalDebt:    { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
  recoveryImportHhi:       { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
  recoveryStateContinuity: { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
  recoveryFuelStocks:      { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
  // PR 2 §3.4 — same source as the retired reserveAdequacy
  // (WB FI.RES.TOTL.MO) but the new dim re-anchors 1..12 months instead
  // of 1..18. Fallback coverage identical because the upstream source
  // has not changed.
  recoveryLiquidReserveAdequacy: { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
  // PR 2 §3.4 — used when the sovereign-wealth seed key is absent
  // entirely (Railway cron has not fired yet on a fresh deploy).
  // Countries NOT in the manifest but payload present are handled
  // separately by the scorer as "no SWF → score 0, coverage 0,
  // imputationClass 'not-applicable'" (dim-not-applicable, plan
  // 2026-04-26-001 §U3 — reframed from the original "substantive
  // absence" decision in plan 2026-04-25-001 §3.4 because the
  // deliberate penalty over-fired for advanced economies that hold
  // reserves through Treasury / central-bank channels).
  recoverySovereignFiscalBuffer: { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
  // Plan 2026-04-26-001 §U2 — gated GPI-only impute for socialCohesion.
  // These two entries fire ONLY when the dim is operating in degraded
  // GPI-only mode (i.e. country is absent from the displacement registry).
  // Both score lower than the GPI-norm output for low-violence countries,
  // pulling the blend down so tiny peaceful states (TV, PW, NR, MC) don't
  // ride GPI-only to a near-perfect dim score. For countries WITH observed
  // displacement and zero unrest events, unrest is imputed at
  // `unhcrDisplacement.score` (85) instead — preserving Iceland/Norway
  // scoring (peaceful + fully-monitored should NOT regress).
  socialCohesionGpiOnlyDisplacement: { score: 70, certaintyCoverage: 0.6, imputationClass: 'stable-absence' },
  socialCohesionGpiOnlyUnrest:       { score: 70, certaintyCoverage: 0.5, imputationClass: 'stable-absence' },
} as const satisfies Record<string, ImputationEntry>;

interface StaticIndicatorValue {
  value?: number;
  year?: number | null;
}

interface ResilienceStaticCountryRecord {
  wgi?: { indicators?: Record<string, StaticIndicatorValue> } | null;
  infrastructure?: { indicators?: Record<string, StaticIndicatorValue> } | null;
  gpi?: { score?: number; rank?: number; year?: number | null } | null;
  rsf?: { score?: number; rank?: number; year?: number | null } | null;
  who?: { indicators?: Record<string, { value?: number; year?: number | null }> } | null;
  fao?: { peopleInCrisis?: number; phase?: string | null; year?: number | null } | null;
  aquastat?: { value?: number; indicator?: string | null; year?: number | null } | null;
  iea?: { energyImportDependency?: { value?: number; year?: number | null; source?: string } | null } | null;
  tradeToGdp?: { tradeToGdpPct?: number; year?: number | null; source?: string } | null;
  fxReservesMonths?: { months?: number; year?: number | null; source?: string } | null;
  appliedTariffRate?: { value?: number; year?: number | null; source?: string } | null;
}

interface ImfMacroEntry {
  inflationPct?: number | null;
  currentAccountPct?: number | null;
  govRevenuePct?: number | null;
  year?: number | null;
}

// BisExchangeRate interface removed in PR 3 §3.5: only the
// now-removed getCountryBisExchangeRates() + scoreCurrencyExternal's
// BIS path used it.

interface NationalDebtEntry {
  iso3?: string;
  debtToGdp?: number;
  annualGrowth?: number;
}

interface TradeRestriction {
  reportingCountry?: string;
  affectedCountry?: string;
  status?: string;
}

interface TradeBarrier {
  notifyingCountry?: string;
}

interface CyberThreat {
  country?: string;
  severity?: string;
}

interface InternetOutage {
  country?: string;
  countryCode?: string;
  country_code?: string;
  severity?: string;
}

interface GpsJamHex {
  region?: string;
  country?: string;
  countryCode?: string;
  level?: string;
}

interface UnrestEvent {
  country?: string;
  severity?: string;
  fatalities?: number;
}

interface UcdpEvent {
  country?: string;
  deathsBest?: number;
  violenceType?: string;
}

interface CountryDisplacement {
  code?: string;
  totalDisplaced?: number;
  hostTotal?: number;
}

interface SocialVelocityPost {
  title?: string;
  velocityScore?: number;
}

const RESILIENCE_STATIC_PREFIX = 'resilience:static:';
const RESILIENCE_SHIPPING_STRESS_KEY = 'supply_chain:shipping_stress:v1';
const RESILIENCE_TRANSIT_SUMMARIES_KEY = 'supply_chain:transit-summaries:v1';
// RESILIENCE_BIS_EXCHANGE_KEY removed in PR 3 §3.5: scoreCurrencyExternal
// no longer reads BIS EER. fxVolatility / fxDeviation indicators remain
// registered as tier='experimental' for drill-down panels; those panels
// read BIS directly via their own handlers, not via this scorer.
const RESILIENCE_BIS_DSR_KEY = 'economic:bis:dsr:v1';
const RESILIENCE_NATIONAL_DEBT_KEY = 'economic:national-debt:v1';
const RESILIENCE_IMF_MACRO_KEY = 'economic:imf:macro:v2';
const RESILIENCE_IMF_LABOR_KEY = 'economic:imf:labor:v1';
// RETIRED in plan 2026-04-25-004 Phase 1: the `RESILIENCE_SANCTIONS_KEY`
// constant ('sanctions:country-counts:v1') is no longer read by any scorer
// in this module — scoreTradePolicy dropped the OFAC component. The seed
// key is still WRITTEN by scripts/seed-sanctions-pressure.mjs and consumed
// by country-brief generation + ad-hoc analysis; only the resilience
// scorer's binding was removed. Removing the constant entirely (rather
// than retaining it as documentation) avoids a TS6133 unused-local error.
// If Phase 2's financialSystemExposure re-introduces a sanctions signal,
// re-add the constant there with the appropriate scope.
const RESILIENCE_TRADE_RESTRICTIONS_KEY = 'trade:restrictions:v1:tariff-overview:50';
const RESILIENCE_TRADE_BARRIERS_KEY = 'trade:barriers:v1:tariff-gap:50';
// plan 2026-04-25-004 Phase 2: financialSystemExposure component seed keys.
const RESILIENCE_WB_EXTERNAL_DEBT_KEY = 'economic:wb-external-debt:v1';
const RESILIENCE_BIS_LBS_KEY = 'economic:bis-lbs:v1';
const RESILIENCE_FATF_LISTING_KEY = 'economic:fatf-listing:v1';
const RESILIENCE_CYBER_KEY = 'cyber:threats:v2';
const RESILIENCE_OUTAGES_KEY = 'infra:outages:v1';
const RESILIENCE_GPS_KEY = 'intelligence:gpsjam:v2';
const RESILIENCE_UNREST_KEY = 'unrest:events:v1';
const RESILIENCE_UCDP_KEY = 'conflict:ucdp-events:v1';
const RESILIENCE_DISPLACEMENT_PREFIX = 'displacement:summary:v1';
const RESILIENCE_SOCIAL_VELOCITY_KEY = 'intelligence:social:reddit:v1';
const RESILIENCE_NEWS_THREAT_SUMMARY_KEY = 'news:threat:summary:v1';
const RESILIENCE_ENERGY_PRICES_KEY = 'economic:energy:v1:all';
const RESILIENCE_ENERGY_MIX_KEY_PREFIX = 'energy:mix:v1:';

const RESILIENCE_RECOVERY_FISCAL_SPACE_KEY = 'resilience:recovery:fiscal-space:v1';
const RESILIENCE_RECOVERY_RESERVE_ADEQUACY_KEY = 'resilience:recovery:reserve-adequacy:v1';
const RESILIENCE_RECOVERY_EXTERNAL_DEBT_KEY = 'resilience:recovery:external-debt:v1';
const RESILIENCE_RECOVERY_IMPORT_HHI_KEY = 'resilience:recovery:import-hhi:v1';
// PR 2 §3.4 — new SWF seed populated by scripts/seed-sovereign-wealth.mjs
// (landed in #3305, wired into the resilience-recovery Railway bundle in
// #3319). Per-country shape: { funds: [...], totalEffectiveMonths,
// annualImports, expectedFunds, matchedFunds, completeness }. Countries
// not in the manifest are absent from the payload (substantive "no SWF"
// signal, distinct from the IMPUTE fallback below).
const RESILIENCE_RECOVERY_SOVEREIGN_WEALTH_KEY = 'resilience:recovery:sovereign-wealth:v1';
// RESILIENCE_RECOVERY_FUEL_STOCKS_KEY removed in PR 3: scoreFuelStockDays
// no longer reads any source key. If a new globally-comparable
// recovery-fuel concept lands in a future PR, add a new key with an
// explicit semantic (e.g. resilience:fuel-import-volatility:v1) rather
// than resurrecting this one.

// PR 1 energy-construct v2 seed keys (plan §3.1–§3.3). Written by
// scripts/seed-low-carbon-generation.mjs, scripts/seed-fossil-
// electricity-share.mjs, scripts/seed-power-reliability.mjs.
// Read by scoreEnergy only when isEnergyV2Enabled() is true; until
// the seeders land, the keys are absent and the v2 scorer path
// degrades gracefully (returns null per sub-indicator, which the
// weightedBlend handles via the normal coverage/imputation path).
//
// Shape (all three): { updatedAt: ISO, countries: { [ISO2]: { value: number, year: number | null } } }
// Values are percent (0-100). Composites like importedFossilDependence
// are computed at score time, not pre-aggregated in the seed.
const RESILIENCE_LOW_CARBON_GEN_KEY = 'resilience:low-carbon-generation:v1';
const RESILIENCE_FOSSIL_ELEC_SHARE_KEY = 'resilience:fossil-electricity-share:v1';
const RESILIENCE_POWER_LOSSES_KEY = 'resilience:power-losses:v1';
// reserveMarginPct is DEFERRED per plan §3.1 open-question: IEA
// electricity-balance coverage is sparse outside OECD+G20 and the
// indicator may ship at `tier='unmonitored'` with weight 0.05 if it
// ships at all. Neither scorer v2 nor any consumer reads a
// `resilience:reserve-margin:v1` key today. When the seeder lands:
//   1. Reintroduce a `RESILIENCE_RESERVE_MARGIN_KEY` constant here,
//   2. Split 0.10 out of scoreEnergyV2's powerLossesPct weight and
//      add reserveMargin at 0.10,
//   3. Add the indicator back to INDICATOR_REGISTRY + EXTRACTION_RULES.
// Until then the key name is a reservation in comment form only; the
// typecheck refuses to ship a declared-but-unread constant.

// EU country set for `euGasStorageStress` in the v2 energy construct.
// GIE AGSI+ covers EU member states + a few neighbours; non-EU
// countries get weight 0 on this signal (not null) so the denominator
// re-normalises correctly per plan §3.5. Kept local to this file to
// match the GIE coverage observed at seed time. EFTA members (NO, CH,
// IS) + UK are included because GIE publishes their storage too.
const EU_GAS_STORAGE_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
  'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
  'NO', 'CH', 'IS', 'GB', // EFTA + UK
]);

// Local flag reader for the PR 1 v2 energy construct. The canonical
// definition lives in _shared.ts#isEnergyV2Enabled with full comments;
// this private duplicate avoids a circular import (_shared.ts already
// imports from this module). Both readers consult the SAME env var so
// the contract is a single source of truth.
function isEnergyV2EnabledLocal(): boolean {
  return (process.env.RESILIENCE_ENERGY_V2_ENABLED ?? 'false').toLowerCase() === 'true';
}

/**
 * Thrown by the v2 energy dispatch when `RESILIENCE_ENERGY_V2_ENABLED=true`
 * but one or more of the required Redis seeds
 * (`resilience:low-carbon-generation:v1`, `resilience:fossil-electricity-share:v1`,
 * `resilience:power-losses:v1`) is absent. Fail-closed surfaces the
 * misconfiguration via the source-failure path instead of silently
 * producing IMPUTE scores that look computed. See
 * `docs/plans/2026-04-24-001-fix-resilience-v2-fail-closed-on-missing-seeds-plan.md`.
 */
export class ResilienceConfigurationError extends Error {
  readonly missingKeys: readonly string[];
  constructor(message: string, missingKeys: readonly string[]) {
    super(message);
    this.name = 'ResilienceConfigurationError';
    this.missingKeys = missingKeys;
  }
}

const COUNTRY_NAME_ALIASES = new Map<string, Set<string>>();
for (const [name, iso2] of Object.entries(countryNames as Record<string, string>)) {
  const code = String(iso2 || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) continue;
  const current = COUNTRY_NAME_ALIASES.get(code) ?? new Set<string>();
  current.add(normalizeCountryToken(name));
  COUNTRY_NAME_ALIASES.set(code, current);
}

const ISO2_TO_ISO3: Record<string, string> = iso2ToIso3Json;

const RESILIENCE_DOMAIN_WEIGHTS: Record<ResilienceDomainId, number> = {
  economic: 0.17,
  infrastructure: 0.15,
  energy: 0.11,
  'social-governance': 0.19,
  'health-food': 0.13,
  recovery: 0.25,
};

// Per-dimension weight multipliers applied inside the coverage-weighted
// mean when aggregating a domain. Defaults to 1.0 (every dim gets the
// same nominal share, and the coverage-weighted mean's share-denominator
// reflects how much real data each dim contributes).
//
// PR 2 §3.4 — `liquidReserveAdequacy` and `sovereignFiscalBuffer` each
// carry 0.5 so they sit at ~10% of the recovery-domain score instead of
// the equal-share 1/6 (~16.7%) the old reserveAdequacy dim implicitly
// claimed. The plan's target: "liquidReserveAdequacy ~0.10;
// sovereignFiscalBuffer ~0.10; other recovery dimensions absorb
// residual." Math check with all 6 active recovery dims at coverage=1:
//   (1.0×4 + 0.5×2) = 5.0 total weighted coverage
//   new-dim share    = 0.5 / 5.0 = 0.10 ✓
//   other-dim share  = 1.0 / 5.0 = 0.20 (the residual-absorbed weight)
//
// Retired dims have coverage=0 and so contribute 0 to the numerator /
// denominator regardless of their weight entry; setting them to 1.0
// here is fine and keeps the map uniform.
export const RESILIENCE_DIMENSION_WEIGHTS: Record<ResilienceDimensionId, number> = {
  macroFiscal: 1.0,
  currencyExternal: 1.0,
  tradePolicy: 0.5,                  // plan 2026-04-25-004 Phase 2: split economic-domain weight with financialSystemExposure
  financialSystemExposure: 0.5,      // plan 2026-04-25-004 Phase 2: structural sanctions vulnerability
  cyberDigital: 1.0,
  logisticsSupply: 1.0,
  infrastructure: 1.0,
  energy: 1.0,
  governanceInstitutional: 1.0,
  socialCohesion: 1.0,
  borderSecurity: 1.0,
  informationCognitive: 1.0,
  healthPublicService: 1.0,
  foodWater: 1.0,
  fiscalSpace: 1.0,
  reserveAdequacy: 1.0,          // retired; coverage=0 neutralizes the weight
  externalDebtCoverage: 1.0,
  importConcentration: 1.0,
  stateContinuity: 1.0,
  fuelStockDays: 1.0,             // retired; coverage=0 neutralizes the weight
  liquidReserveAdequacy: 0.5,     // PR 2 §3.4 target ~10% recovery share
  sovereignFiscalBuffer: 0.5,     // PR 2 §3.4 target ~10% recovery share
};

export const RESILIENCE_DIMENSION_DOMAINS: Record<ResilienceDimensionId, ResilienceDomainId> = {
  macroFiscal: 'economic',
  currencyExternal: 'economic',
  tradePolicy: 'economic',
  financialSystemExposure: 'economic',
  cyberDigital: 'infrastructure',
  logisticsSupply: 'infrastructure',
  infrastructure: 'infrastructure',
  energy: 'energy',
  governanceInstitutional: 'social-governance',
  socialCohesion: 'social-governance',
  borderSecurity: 'social-governance',
  informationCognitive: 'social-governance',
  healthPublicService: 'health-food',
  foodWater: 'health-food',
  fiscalSpace: 'recovery',
  reserveAdequacy: 'recovery',
  externalDebtCoverage: 'recovery',
  importConcentration: 'recovery',
  stateContinuity: 'recovery',
  fuelStockDays: 'recovery',
  liquidReserveAdequacy: 'recovery',
  sovereignFiscalBuffer: 'recovery',
};

export const RESILIENCE_DIMENSION_ORDER: ResilienceDimensionId[] = [
  'macroFiscal',
  'currencyExternal',
  'tradePolicy',
  'financialSystemExposure',
  'cyberDigital',
  'logisticsSupply',
  'infrastructure',
  'energy',
  'governanceInstitutional',
  'socialCohesion',
  'borderSecurity',
  'informationCognitive',
  'healthPublicService',
  'foodWater',
  'fiscalSpace',
  'reserveAdequacy',       // retired in PR 2 §3.4 — kept in order for structural continuity
  'externalDebtCoverage',
  'importConcentration',
  'stateContinuity',
  'fuelStockDays',          // retired in PR 3 §3.5
  'liquidReserveAdequacy',  // new in PR 2 §3.4 — replaces reserveAdequacy
  'sovereignFiscalBuffer',  // new in PR 2 §3.4 — SWF haircut dimension
];

export const RESILIENCE_DOMAIN_ORDER: ResilienceDomainId[] = [
  'economic',
  'infrastructure',
  'energy',
  'social-governance',
  'health-food',
  'recovery',
];

export type ResilienceDimensionType = 'baseline' | 'stress' | 'mixed';

export const RESILIENCE_DIMENSION_TYPES: Record<ResilienceDimensionId, ResilienceDimensionType> = {
  macroFiscal: 'baseline',
  currencyExternal: 'stress',
  tradePolicy: 'stress',
  financialSystemExposure: 'stress',
  cyberDigital: 'stress',
  logisticsSupply: 'mixed',
  infrastructure: 'baseline',
  energy: 'mixed',
  governanceInstitutional: 'baseline',
  socialCohesion: 'baseline',
  borderSecurity: 'stress',
  informationCognitive: 'stress',
  healthPublicService: 'baseline',
  foodWater: 'mixed',
  fiscalSpace: 'baseline',
  reserveAdequacy: 'baseline',
  externalDebtCoverage: 'baseline',
  importConcentration: 'baseline',
  stateContinuity: 'baseline',
  fuelStockDays: 'mixed',
  liquidReserveAdequacy: 'baseline',
  sovereignFiscalBuffer: 'baseline',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(clamp(value, 0, 100));
}

function roundCoverage(value: number): number {
  return Number(clamp(value, 0, 1).toFixed(2));
}

function safeNum(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeLowerBetter(value: number, best: number, worst: number): number {
  if (worst <= best) return 50;
  const ratio = (worst - value) / (worst - best);
  return roundScore(ratio * 100);
}

function normalizeHigherBetter(value: number, worst: number, best: number): number {
  if (best <= worst) return 50;
  const ratio = (value - worst) / (best - worst);
  return roundScore(ratio * 100);
}

// U-shaped band normalization. Used by `financialSystemExposure` Component 2
// (BIS LBS cross-border claims as % of GDP). Both extremes are bad — too
// little integration suggests financial isolation (sanctions-target
// jurisdictions; thin correspondent-banking access), too much suggests
// over-exposure to Western-bank pulls (Iceland-2008 territory). The score
// peaks in the "healthy diversified financial system" middle band.
//
// Plan 2026-04-25-004 Phase 2 § Component 2 score shape — re-anchored
// for piecewise-CONTINUOUS transitions per Greptile P1 catch (PR #3407
// review 2026-04-25). Original draft had a 30-point cliff at the 25%
// boundary (sweet spot ended at 100, over-exposed started at 70) and a
// 5-point jump at 5%. Cliffs in piecewise-linear scorers cause ranking
// instability for countries near band edges — a 24.9% reading scores
// dramatically different than 25.1%. Endpoints now share values across
// adjacent segments so the function is monotone-then-monotone with no
// discontinuities:
//
//   0% ≤ value < 5%      → 60-75  (low integration; slope +3/pct)
//   5% ≤ value ≤ 25%     → 75-100 (sweet spot; slope +1.25/pct)
//   25% < value ≤ 60%    → 100-30 (over-exposed; slope −2/pct)
//   value > 60%           → 30 → 0 at 120% (Iceland-2008; slope −0.5/pct, clamped)
function normalizeBandLowerBetter(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 50;
  if (value < 5) {
    // Low integration: 0% → 60, 5% → 75 (continuous to sweet-spot start).
    return roundScore(60 + (value / 5) * 15);
  }
  if (value <= 25) {
    // Sweet spot: 5% → 75, 25% → 100.
    return roundScore(75 + ((value - 5) / 20) * 25);
  }
  if (value <= 60) {
    // Over-exposed: 25% → 100 (continuous from sweet-spot peak), 60% → 30.
    return roundScore(100 - ((value - 25) / 35) * 70);
  }
  // Iceland-2008 territory: 60% → 30 (continuous), drops 0.5pt per pct; clamped 0.
  return roundScore(Math.max(0, 30 - (value - 60) * 0.5));
}

// `normalizeSanctionCount` retired in plan 2026-04-25-004 Phase 1. The
// piecewise scale (0=100, 1-10=90-75, 11-50=75-50, 51-200=50-25, 201+=25→0)
// only normalized the dropped OFAC `sanctionCount` component. Removed
// rather than retained-but-unused to avoid TS6133 unused-local errors.
// The historical anchors are preserved in the deleted test file
// `tests/resilience-sanctions-field-mapping.test.mts` (see git history).

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// stddev() removed in PR 3 §3.5: its only caller was scoreCurrencyExternal's
// BIS-volatility path which is now retired. Re-introduce if a future
// scorer genuinely needs a series-volatility computation.

// T1.7 schema pass: tie-break order when multiple imputed metrics share
// weight. Earlier classes in this list win on ties. stable-absence expresses
// the most actionable signal, so it ranks first.
const IMPUTATION_CLASS_TIE_BREAK: readonly ImputationClass[] = [
  'stable-absence',
  'unmonitored',
  'source-failure',
  'not-applicable',
];

function weightedBlend(metrics: WeightedMetric[]): ResilienceDimensionScore {
  const totalWeight = metrics.reduce((sum, metric) => sum + metric.weight, 0);
  const available = metrics.filter((metric) => metric.score != null);
  const availableWeight = available.reduce((sum, metric) => sum + metric.weight, 0);

  if (!availableWeight || !totalWeight) {
    return { score: 0, coverage: 0, observedWeight: 0, imputedWeight: 0, imputationClass: null, freshness: { lastObservedAtMs: 0, staleness: '' } };
  }

  const weightedScore = available.reduce((sum, metric) => sum + (metric.score || 0) * metric.weight, 0) / availableWeight;

  // Coverage: weighted average of certainty per metric.
  // Real data → 1.0; imputed (certaintyCoverage set) → partial; absent (null, no imputation) → 0.
  const weightedCertainty = metrics.reduce((sum, metric) => {
    const certainty = metric.certaintyCoverage ?? (metric.score != null ? 1 : 0);
    return sum + metric.weight * certainty;
  }, 0) / totalWeight;

  // Track provenance: observed (real data) vs imputed weight.
  // Metrics with imputed=true → imputed (synthetic absence-based scores).
  // All other non-null metrics → observed (including proxy data with certaintyCoverage < 1).
  // Metrics with null score → neither (excluded from both).
  let observedWeight = 0;
  let imputedWeight = 0;
  const classWeights = new Map<ImputationClass, number>();
  for (const metric of metrics) {
    if (metric.score == null) continue;
    if (metric.imputed === true) {
      imputedWeight += metric.weight;
      if (metric.imputationClass) {
        classWeights.set(metric.imputationClass, (classWeights.get(metric.imputationClass) ?? 0) + metric.weight);
      }
    } else {
      observedWeight += metric.weight;
    }
  }

  // T1.7 schema pass: report the dominant imputation class only when the
  // dimension is fully imputed. Any observed data at all wins over every
  // imputation class, so imputationClass is null whenever observedWeight > 0.
  let imputationClass: ImputationClass | null = null;
  if (observedWeight === 0 && imputedWeight > 0 && classWeights.size > 0) {
    let bestWeight = -Infinity;
    let bestClass: ImputationClass | null = null;
    for (const candidate of IMPUTATION_CLASS_TIE_BREAK) {
      const weight = classWeights.get(candidate);
      if (weight == null) continue;
      if (weight > bestWeight) {
        bestWeight = weight;
        bestClass = candidate;
      }
    }
    imputationClass = bestClass;
  }

  return {
    score: roundScore(weightedScore),
    coverage: roundCoverage(weightedCertainty),
    observedWeight: Number(observedWeight.toFixed(4)),
    imputedWeight: Number(imputedWeight.toFixed(4)),
    imputationClass,
    freshness: { lastObservedAtMs: 0, staleness: '' },
  };
}

function extractMetric<T>(value: T | null | undefined, scorer: (item: T) => number | null): number | null {
  if (!value) return null;
  return scorer(value);
}

function getCountryAliases(countryCode: string): Set<string> {
  const code = countryCode.toUpperCase();
  const aliases = new Set<string>([normalizeCountryToken(code)]);
  const iso3 = ISO2_TO_ISO3[code];
  if (iso3) aliases.add(normalizeCountryToken(iso3));
  for (const alias of COUNTRY_NAME_ALIASES.get(code) ?? []) aliases.add(alias);
  return aliases;
}

function matchesCountryIdentifier(value: unknown, countryCode: string): boolean {
  const normalized = normalizeCountryToken(value);
  if (!normalized) return false;
  return getCountryAliases(countryCode).has(normalized);
}

const AMBIGUOUS_ALIASES = new Set([
  'guinea', 'congo', 'niger', 'samoa', 'sudan', 'korea', 'virgin', 'georgia', 'dominica',
]);

function matchesCountryText(value: unknown, countryCode: string): boolean {
  const normalized = normalizeCountryToken(value);
  if (!normalized) return false;
  for (const alias of COUNTRY_NAME_ALIASES.get(countryCode.toUpperCase()) ?? []) {
    if (AMBIGUOUS_ALIASES.has(alias)) continue;
    if (` ${normalized} `.includes(` ${alias} `)) return true;
  }
  return false;
}

// dateToSortableNumber() removed in PR 3 §3.5: only the now-removed
// getCountryBisExchangeRates() used it.

async function defaultSeedReader(key: string): Promise<unknown | null> {
  return getCachedJson(key, true);
}

export function createMemoizedSeedReader(reader: ResilienceSeedReader = defaultSeedReader): ResilienceSeedReader {
  const cache = new Map<string, Promise<unknown | null>>();
  return async (key: string) => {
    if (!cache.has(key)) {
      const p = Promise.resolve(reader(key));
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    return cache.get(key)!;
  };
}

async function readStaticCountry(countryCode: string, reader: ResilienceSeedReader): Promise<ResilienceStaticCountryRecord | null> {
  const raw = await reader(`${RESILIENCE_STATIC_PREFIX}${countryCode.toUpperCase()}`);
  return raw && typeof raw === 'object' ? (raw as ResilienceStaticCountryRecord) : null;
}

function getStaticIndicatorValue(
  record: ResilienceStaticCountryRecord | null,
  datasetField: 'wgi' | 'infrastructure' | 'who',
  indicatorKey: string,
): number | null {
  const dataset = record?.[datasetField];
  const value = safeNum(dataset?.indicators?.[indicatorKey]?.value);
  return value == null ? null : value;
}

function getStaticWgiValues(record: ResilienceStaticCountryRecord | null): number[] {
  const indicators = record?.wgi?.indicators ?? {};
  return Object.values(indicators)
    .map((entry) => safeNum(entry?.value))
    .filter((value): value is number => value != null);
}

function getImfMacroEntry(raw: unknown, countryCode: string): ImfMacroEntry | null {
  const countries = (raw as { countries?: Record<string, ImfMacroEntry> } | null)?.countries;
  if (!countries || typeof countries !== 'object') return null;
  return (countries[countryCode] as ImfMacroEntry | undefined) ?? null;
}

interface ImfLaborEntry {
  unemploymentPct?: number | null;
  populationMillions?: number | null;
  year?: number | null;
}

function getImfLaborEntry(raw: unknown, countryCode: string): ImfLaborEntry | null {
  const countries = (raw as { countries?: Record<string, ImfLaborEntry> } | null)?.countries;
  if (!countries || typeof countries !== 'object') return null;
  return (countries[countryCode] as ImfLaborEntry | undefined) ?? null;
}

/**
 * Plan 2026-04-26-002 §U6 — robust population-in-millions reader for the
 * per-capita normalization in scoreSocialCohesion + scoreBorderSecurity.
 *
 * Always returns a number ≥ 0.5 (the plan's tiny-state floor).
 *
 * Defensive raw-persons detection: the historical IMF labor seed stored
 * the LP indicator's raw-persons value in a field misleadingly named
 * `populationMillions` (e.g. US ≈ 342_594_000 instead of 342.6). The
 * seeder is fixed in the same PR, but cached payloads from prior cron
 * runs may still carry raw persons until the next refresh. Any value
 * >= 10_000 is impossible as "millions" (China = ~1430 millions = the
 * realistic ceiling), so treat it as raw persons and divide by 1e6.
 * The threshold is INCLUSIVE: live cache currently has TV's value at
 * exactly 10_000 (Tuvalu's actual headcount), and a `> 10_000` check
 * would let it through as "10000M" instead of converting to 0.01M.
 * The IMF labor bundle is 30-day gated; without inclusive comparison
 * a microstate is mis-handled until the next bundle refresh.
 *
 * Once the cache cycles to post-fix values (everything in the 0.01-1500
 * range), this branch becomes a no-op.
 */
function readPopulationMillions(imfLaborRaw: unknown, countryCode: string): number {
  const raw = safeNum(getImfLaborEntry(imfLaborRaw, countryCode)?.populationMillions);
  if (raw == null) return 0.5;
  const millions = raw >= 10_000 ? raw / 1_000_000 : raw;
  return Math.max(millions, 0.5);
}

// getCountryBisExchangeRates() removed in PR 3 §3.5: only scoreCurrencyExternal
// called it, and that scorer no longer reads BIS EER. Drill-down panels
// that want BIS series read it via their own dedicated handler.

function getLatestDebtEntry(raw: unknown, countryCode: string): NationalDebtEntry | null {
  const iso3 = ISO2_TO_ISO3[countryCode.toUpperCase()];
  const entries: NationalDebtEntry[] = Array.isArray((raw as { entries?: unknown[] } | null)?.entries)
    ? ((raw as { entries?: NationalDebtEntry[] }).entries ?? [])
    : [];
  if (!entries.length) return null;
  if (iso3) {
    const matched = entries.find((entry) => matchesCountryIdentifier(entry.iso3, iso3));
    if (matched) return matched;
  }
  return null;
}

export function countTradeRestrictions(raw: unknown, countryCode: string): number {
  const restrictions: TradeRestriction[] = Array.isArray((raw as { restrictions?: unknown[] } | null)?.restrictions)
    ? ((raw as { restrictions?: TradeRestriction[] }).restrictions ?? [])
    : [];
  return restrictions.reduce((count, item) => {
    const matches = matchesCountryIdentifier(item.reportingCountry, countryCode)
      || matchesCountryIdentifier(item.affectedCountry, countryCode);
    if (!matches) return count;
    return count + (String(item.status || '').toUpperCase() === 'IN_FORCE' ? 3 : 1);
  }, 0);
}

export function countTradeBarriers(raw: unknown, countryCode: string): number {
  const barriers: TradeBarrier[] = Array.isArray((raw as { barriers?: unknown[] } | null)?.barriers)
    ? ((raw as { barriers?: TradeBarrier[] }).barriers ?? [])
    : [];
  return barriers.reduce((count, item) => count + (matchesCountryIdentifier(item.notifyingCountry, countryCode) ? 1 : 0), 0);
}

function isInWtoReporterSet(raw: unknown, countryCode: string): boolean {
  const reporters = (raw as { _reporterCountries?: string[] } | null)?._reporterCountries;
  if (!Array.isArray(reporters) || reporters.length === 0) return true;
  return reporters.includes(countryCode);
}

export function summarizeOutages(raw: unknown, countryCode: string): { total: number; major: number; partial: number } {
  const outages: InternetOutage[] = Array.isArray((raw as { outages?: unknown[] } | null)?.outages)
    ? ((raw as { outages?: InternetOutage[] }).outages ?? [])
    : [];
  return outages.reduce((summary, item) => {
    const matches = matchesCountryIdentifier(item.countryCode, countryCode)
      || matchesCountryIdentifier(item.country_code, countryCode)
      || matchesCountryIdentifier(item.country, countryCode)
      || matchesCountryText(item.country, countryCode);
    if (!matches) return summary;
    const severity = String(item.severity || '').toUpperCase();
    if (severity.includes('TOTAL') || severity === 'NATIONWIDE') summary.total += 1;
    else if (severity.includes('MAJOR') || severity === 'REGIONAL') summary.major += 1;
    else summary.partial += 1;
    return summary;
  }, { total: 0, major: 0, partial: 0 });
}

export function summarizeGps(raw: unknown, countryCode: string): { high: number; medium: number } {
  const hexes: GpsJamHex[] = Array.isArray((raw as { hexes?: unknown[] } | null)?.hexes)
    ? ((raw as { hexes?: GpsJamHex[] }).hexes ?? [])
    : [];
  return hexes.reduce((summary, item) => {
    const matches = matchesCountryIdentifier(item.country, countryCode)
      || matchesCountryIdentifier(item.countryCode, countryCode)
      || matchesCountryText(item.region, countryCode);
    if (!matches) return summary;
    const level = String(item.level || '').toLowerCase();
    if (level === 'high') summary.high += 1;
    else if (level === 'medium') summary.medium += 1;
    return summary;
  }, { high: 0, medium: 0 });
}

export function summarizeCyber(raw: unknown, countryCode: string): { weightedCount: number } {
  const threats: CyberThreat[] = Array.isArray((raw as { threats?: unknown[] } | null)?.threats)
    ? ((raw as { threats?: CyberThreat[] }).threats ?? [])
    : [];
  const SEVERITY_WEIGHT: Record<string, number> = {
    CRITICALITY_LEVEL_CRITICAL: 3,
    CRITICALITY_LEVEL_HIGH: 2,
    CRITICALITY_LEVEL_MEDIUM: 1,
    CRITICALITY_LEVEL_LOW: 0.5,
  };

  return {
    weightedCount: threats.reduce((sum, threat) => {
      if (!matchesCountryIdentifier(threat.country, countryCode)) return sum;
      return sum + (SEVERITY_WEIGHT[String(threat.severity || '')] ?? 1);
    }, 0),
  };
}

export function summarizeUnrest(raw: unknown, countryCode: string): { unrestCount: number; fatalities: number } {
  const events: UnrestEvent[] = Array.isArray((raw as { events?: unknown[] } | null)?.events)
    ? ((raw as { events?: UnrestEvent[] }).events ?? [])
    : [];
  return events.reduce<{ unrestCount: number; fatalities: number }>((summary, item) => {
    if (!matchesCountryText(item.country, countryCode) && !matchesCountryIdentifier(item.country, countryCode)) return summary;
    const severity = String(item.severity || '').toUpperCase();
    const severityWeight = severity.includes('HIGH') ? 2 : severity.includes('MEDIUM') ? 1.2 : 1;
    summary.unrestCount += severityWeight;
    summary.fatalities += safeNum(item.fatalities) ?? 0;
    return summary;
  }, { unrestCount: 0, fatalities: 0 });
}

export function summarizeUcdp(raw: unknown, countryCode: string): { eventCount: number; deaths: number; typeWeight: number } {
  const events: UcdpEvent[] = Array.isArray((raw as { events?: unknown[] } | null)?.events)
    ? ((raw as { events?: UcdpEvent[] }).events ?? [])
    : [];
  return events.reduce((summary, item) => {
    if (!matchesCountryText(item.country, countryCode) && !matchesCountryIdentifier(item.country, countryCode)) return summary;
    summary.eventCount += 1;
    summary.deaths += safeNum(item.deathsBest) ?? 0;
    const violenceType = String(item.violenceType || '');
    summary.typeWeight += violenceType === 'UCDP_VIOLENCE_TYPE_STATE_BASED' ? 2 : violenceType === 'UCDP_VIOLENCE_TYPE_ONE_SIDED' ? 1.5 : 1;
    return summary;
  }, { eventCount: 0, deaths: 0, typeWeight: 0 });
}

export function getCountryDisplacement(raw: unknown, countryCode: string): CountryDisplacement | null {
  const summary = (raw as { summary?: { countries?: CountryDisplacement[] } } | null)?.summary;
  const countries = Array.isArray(summary?.countries) ? summary.countries : [];
  return countries.find((entry) => matchesCountryIdentifier(entry.code, countryCode)) ?? null;
}

export function summarizeSocialVelocity(raw: unknown, countryCode: string): number {
  const posts: SocialVelocityPost[] = Array.isArray((raw as { posts?: unknown[] } | null)?.posts)
    ? ((raw as { posts?: SocialVelocityPost[] }).posts ?? [])
    : [];
  return posts.reduce((sum, post) => sum + (matchesCountryText(post.title, countryCode) ? (safeNum(post.velocityScore) ?? 0) : 0), 0);
}

export function getThreatSummaryScore(raw: unknown, countryCode: string): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const byCountry = (raw as Record<string, unknown>).byCountry ?? raw; // backward-compat: old payload was a flat ISO2 map
  const counts = (byCountry as Record<string, Record<string, number>>)?.[countryCode.toUpperCase()];
  if (!counts) return null;
  const score = (safeNum(counts.critical) ?? 0) * 4
    + (safeNum(counts.high) ?? 0) * 2
    + (safeNum(counts.medium) ?? 0)
    + (safeNum(counts.low) ?? 0) * 0.5;
  return score > 0 ? score : null;
}

function getTransitDisruptionScore(raw: unknown): number | null {
  const summaries = (raw as { summaries?: Record<string, { disruptionPct?: number; incidentCount7d?: number }> } | null)?.summaries;
  if (!summaries || typeof summaries !== 'object') return null;
  const values = Object.values(summaries)
    .map((entry) => {
      const disruption = safeNum(entry?.disruptionPct) ?? 0;
      const incidents = safeNum(entry?.incidentCount7d) ?? 0;
      return disruption + incidents * 0.5;
    })
    .filter((value) => value > 0);
  return mean(values);
}

function getShippingStressScore(raw: unknown): number | null {
  return safeNum((raw as { stressScore?: number } | null)?.stressScore);
}

function getEnergyPriceStress(raw: unknown): number | null {
  const prices: Array<{ change?: number }> = Array.isArray((raw as { prices?: Array<{ change?: number }> } | null)?.prices)
    ? ((raw as { prices?: Array<{ change?: number }> }).prices ?? [])
    : [];
  const values = prices
    .map((entry) => Math.abs(safeNum(entry.change) ?? 0))
    .filter((value) => value > 0);
  return mean(values);
}

function scoreAquastatValue(record: ResilienceStaticCountryRecord | null): number | null {
  const value = safeNum(record?.aquastat?.value);
  const indicator = normalizeCountryToken(record?.aquastat?.indicator);
  if (value == null) return null;
  if (indicator.includes('stress') || indicator.includes('withdrawal') || indicator.includes('dependency')) {
    return normalizeLowerBetter(value, 0, 100);
  }
  if (indicator.includes('availability') || indicator.includes('renewable') || indicator.includes('access')) {
    return value <= 100
      ? normalizeHigherBetter(value, 0, 100)
      : normalizeHigherBetter(value, 0, 5000);
  }
  console.warn(`[Resilience] AQUASTAT indicator "${record?.aquastat?.indicator}" did not match known keywords, using value-range heuristic`);
  return value <= 100
    ? normalizeHigherBetter(value, 0, 100)
    : normalizeLowerBetter(value, 0, 5000);
}

// BIS household debt service ratio for a specific country. Returns the most
// recent DSR (% income) from seed-bis-extended, or null when the country is
// outside the curated BIS sample.
function getBisDsrEntry(
  raw: unknown,
  countryCode: string,
): { dsrPct: number; date: string } | null {
  const entries = (raw as { entries?: Array<{ countryCode: string; dsrPct: number; date: string }> } | null)?.entries;
  if (!Array.isArray(entries)) return null;
  const hit = entries.find(e => e?.countryCode === countryCode);
  return hit && typeof hit.dsrPct === 'number'
    ? { dsrPct: hit.dsrPct, date: hit.date ?? '' }
    : null;
}

export async function scoreMacroFiscal(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [debtRaw, imfMacroRaw, imfLaborRaw, bisDsrRaw] = await Promise.all([
    reader(RESILIENCE_NATIONAL_DEBT_KEY),
    reader(RESILIENCE_IMF_MACRO_KEY),
    reader(RESILIENCE_IMF_LABOR_KEY),
    reader(RESILIENCE_BIS_DSR_KEY),
  ]);
  const debtEntry = getLatestDebtEntry(debtRaw, countryCode);
  const imfEntry = getImfMacroEntry(imfMacroRaw, countryCode);
  const laborEntry = getImfLaborEntry(imfLaborRaw, countryCode);
  const dsrEntry = getBisDsrEntry(bisDsrRaw, countryCode);

  return weightedBlend([
    // Government revenue/GDP: fiscal capacity — how much the state can actually mobilise.
    // Replaces raw debt/GDP which HIPC debt relief and credit exclusion invert for fragile
    // states (Somalia 5% debt ≠ fiscal prudence; it reflects that no one will lend to them).
    // Anchor: 5% (Somalia, war-torn states) → 0, 45% (OECD median) → 100.
    imfMacroRaw == null
      ? { score: null, weight: 0.4 }
      : { score: imfEntry?.govRevenuePct == null ? null : normalizeHigherBetter(imfEntry.govRevenuePct, 5, 45), weight: 0.4 },
    // Debt growth rate: rapid debt accumulation = fiscal stress even at moderate levels.
    { score: extractMetric(debtEntry, (entry) => normalizeLowerBetter(Math.max(0, safeNum(entry.annualGrowth) ?? 0), 0, 20)), weight: 0.2 },
    // Current account balance: external position — deficit = more vulnerable to FX shocks.
    imfMacroRaw == null
      ? { score: null, weight: 0.2 }
      : { score: imfEntry?.currentAccountPct == null ? null : normalizeHigherBetter(Math.max(-20, Math.min(imfEntry.currentAccountPct, 20)), -20, 20), weight: 0.2 },
    imfLaborRaw == null
      ? { score: null, weight: 0.15 }
      : { score: laborEntry?.unemploymentPct == null ? null : normalizeLowerBetter(Math.max(3, Math.min(laborEntry.unemploymentPct, 25)), 3, 25), weight: 0.15 },
    bisDsrRaw == null || dsrEntry == null
      ? { score: null, weight: 0.05 }
      : { score: normalizeLowerBetter(Math.max(0, Math.min(dsrEntry.dsrPct, 20)), 0, 20), weight: 0.05 },
  ]);
}

function getFxReservesMonths(staticRecord: ResilienceStaticCountryRecord | null): number | null {
  return safeNum(staticRecord?.fxReservesMonths?.months);
}

function scoreFxReserves(months: number): number {
  return normalizeHigherBetter(Math.min(months, 12), 1, 12);
}

// PR 3 §3.5 point 3: retire the BIS-dependent primary path. BIS EER
// covers ~64 economies — a core signal that's null for ~150 countries
// is structurally wrong for a world-ranking score. The scorer now
// uses only global-coverage inputs:
//   - inflationStability: IMF `inflationPct` (CPI, ~185 countries)
//   - fxReservesAdequacy: WB `FI.RES.TOTL.MO` (~160 countries)
// BIS `realChange` / `realEer` are still read for drill-down panels
// via the fxVolatility / fxDeviation registry entries (now re-tagged
// `tier='experimental'` so they're excluded from the Core coverage
// gate), but the SCORER path ignores them entirely. A country that
// used to take the "BIS primary" branch now takes the same path as
// a non-BIS country, producing consistent per-country-reproducibility
// regardless of whether BIS tracks them.
//
// Weight split in the core blend:
//   inflationStability 0.6 | fxReservesAdequacy 0.4
// Mirrors the pre-existing "fallback when no BIS" blend weights.
export async function scoreCurrencyExternal(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [imfMacroRaw, staticRecord] = await Promise.all([
    reader(RESILIENCE_IMF_MACRO_KEY),
    readStaticCountry(countryCode, reader),
  ]);

  const imfEntry = getImfMacroEntry(imfMacroRaw, countryCode);
  const hasInflation = imfMacroRaw != null && imfEntry?.inflationPct != null;
  const inflationScore = hasInflation
    ? normalizeLowerBetter(Math.min(imfEntry!.inflationPct!, 50), 0, 50)
    : null;

  const reservesMonths = getFxReservesMonths(staticRecord);
  const reservesScore = reservesMonths != null ? scoreFxReserves(reservesMonths) : null;

  if (hasInflation && reservesScore != null) {
    const blended = inflationScore! * 0.6 + reservesScore * 0.4;
    return {
      score: roundScore(blended),
      coverage: 0.85,
      observedWeight: 1,
      imputedWeight: 0,
      imputationClass: null,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }
  if (hasInflation) {
    return {
      score: inflationScore!,
      coverage: 0.55,
      observedWeight: 1,
      imputedWeight: 0,
      imputationClass: null,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }
  if (reservesScore != null) {
    return {
      score: reservesScore,
      coverage: 0.4,
      observedWeight: 1,
      imputedWeight: 0,
      imputationClass: null,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }

  // Neither global-coverage source present. True structural absence;
  // keep the curated_list_absent → unmonitored taxonomy so the
  // aggregation pass can still re-tag as source-failure on adapter
  // outage. (IMPUTE.bisEer is the existing entry; we keep its
  // identity/name for snapshot continuity but the semantics now read
  // as "no IMF + no WB reserves" rather than "no BIS".)
  return {
    score: IMPUTE.bisEer.score,
    coverage: IMPUTE.bisEer.certaintyCoverage,
    observedWeight: 0,
    imputedWeight: 1,
    imputationClass: IMPUTE.bisEer.imputationClass,
    freshness: { lastObservedAtMs: 0, staleness: '' },
  };
}

// Renamed from scoreTradeSanctions in plan 2026-04-25-004 Phase 1 (Ship 1).
// The OFAC-domicile-count component (sanctions:country-counts:v1, was weight
// 0.45) was DROPPED — domicile-of-designated-entities is a corporate-finance
// liability metric, not a country-resilience indicator. The remaining 3
// trade-policy components are reweighted to total 1.0:
//   WTO restrictions count → 0.30 (was 0.15)
//   WTO barriers count     → 0.30 (was 0.15)
//   applied tariff rate    → 0.40 (was 0.25)
// The `sanctions:country-counts:v1` seed key is no longer read by this
// module; only `scripts/seed-sanctions-pressure.mjs` continues to WRITE it
// for country-brief generation and ad-hoc analysis. The retired
// `RESILIENCE_SANCTIONS_KEY` constant and `normalizeSanctionCount` helper
// were removed in this PR (see retire-tag at lines ~263 and ~542).
// Phase 2 (Ship 2) adds the `financialSystemExposure` dim built from
// BIS LBS + WB IDS + FATF status — a structural-exposure construct that
// does not rely on the OFAC count.
export async function scoreTradePolicy(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [restrictionsRaw, barriersRaw, staticRecord] = await Promise.all([
    reader(RESILIENCE_TRADE_RESTRICTIONS_KEY),
    reader(RESILIENCE_TRADE_BARRIERS_KEY),
    readStaticCountry(countryCode, reader),
  ]);

  const restrictionCount = countTradeRestrictions(restrictionsRaw, countryCode);
  const barrierCount = countTradeBarriers(barriersRaw, countryCode);

  const inRestrictionsReporterSet = isInWtoReporterSet(restrictionsRaw, countryCode);
  const inBarriersReporterSet = isInWtoReporterSet(barriersRaw, countryCode);

  // WB TM.TAX.MRCH.WM.AR.ZS: Tariff rate, applied, weighted mean, all products (%).
  // 0% = perfect free trade (score 100), 20%+ = heavily restricted (score 0).
  const tariffRate = safeNum(staticRecord?.appliedTariffRate?.value);

  return weightedBlend([
    restrictionsRaw == null
      ? { score: null, weight: 0.30 }
      : !inRestrictionsReporterSet
        ? { score: IMPUTE.wtoData.score, weight: 0.30, certaintyCoverage: IMPUTE.wtoData.certaintyCoverage, imputed: true, imputationClass: IMPUTE.wtoData.imputationClass }
        : { score: normalizeLowerBetter(restrictionCount, 0, 30), weight: 0.30 },
    barriersRaw == null
      ? { score: null, weight: 0.30 }
      : !inBarriersReporterSet
        ? { score: IMPUTE.wtoData.score, weight: 0.30, certaintyCoverage: IMPUTE.wtoData.certaintyCoverage, imputed: true, imputationClass: IMPUTE.wtoData.imputationClass }
        : { score: normalizeLowerBetter(barrierCount, 0, 40), weight: 0.30 },
    { score: tariffRate == null ? null : normalizeLowerBetter(tariffRate, 0, 20), weight: 0.40 },
  ]);
}

// plan 2026-04-25-004 Phase 2: structural sanctions vulnerability via 4
// composite signals. Replaces the structural-exposure half of the dropped
// OFAC-domicile component (Phase 1 §What changes) with audited cross-
// border banking + AML/CFT data that doesn't conflate transit-hub
// corporate domicile with host-country risk.
//
// Components (weights total 1.0):
//   short_term_external_debt_pct_gni     0.35 (WB IDS — lowerBetter; goalpost worst=15% best=0%)
//   bis_lbs_xborder_us_eu_uk_pct_gdp     0.30 (BIS LBS by-parent — U-shape band)
//   fatf_listing_status                   0.20 (FATF — discrete: black=0, gray=30, compliant=100)
//   financial_center_redundancy           0.15 (BIS LBS by-parent count — higherBetter; goalpost worst=1 best=10)
//
// Flag-gated rollout. `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED` defaults off
// so the dim ships dark until the 3 component seeders (seed-bis-lbs,
// seed-fatf-listing, seed-wb-external-debt) are populating Redis in
// production. When the flag is OFF, the scorer returns the empty-data
// shape (score=0, coverage=0) and contributes no signal to the headline
// score — matches the energy v2 rollout pattern from
// `docs/plans/2026-04-24-001-fix-resilience-v2-fail-closed-on-missing-seeds-plan.md`.
//
// Fail-closed preflight (when flag is ON): all 3 required seed
// envelopes (component 4 shares the BIS LBS seed) MUST be reachable.
// Missing seed-meta indicates a Railway bundle/cron failure and is
// surfaced as `source-failure` via
// `ResilienceConfigurationError(message, missingKeys)` — caught at
// `scoreAllDimensions` and routed to the imputationClass='source-failure'
// path. Per-country data gaps are distinct: per-component reads return
// `null` and the slot drops out of the weighted blend.
function isFinSysExposureEnabledLocal(): boolean {
  return (process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED ?? 'false').toLowerCase() === 'true';
}

export async function scoreFinancialSystemExposure(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  if (!isFinSysExposureEnabledLocal()) {
    // Flag off — emit empty-data shape. Matches `weightedBlend([])` semantics.
    return {
      score: 0,
      coverage: 0,
      observedWeight: 0,
      imputedWeight: 0,
      imputationClass: null,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }

  // Preflight: verify the 3 required seed envelopes are published.
  // `runSeed` (scripts/_seed-utils.mjs) STRIPS the trailing :v\d+ from the
  // data key when it writes seed-meta — so `economic:wb-external-debt:v1`
  // gets a freshness key of `seed-meta:economic:wb-external-debt`, NOT
  // `seed-meta:economic:wb-external-debt:v1`. Use `resolveSeedMetaKey`
  // (the canonical helper from _dimension-freshness.ts) so the preflight
  // matches what the seeder actually writes; inlining the regex would
  // re-introduce the same writer/reader drift this helper exists to prevent.
  // The api/health.js + api/seed-health.js registries use the same
  // unversioned form (`seed-meta:economic:wb-external-debt`).
  const requiredSeedKeys = [
    RESILIENCE_WB_EXTERNAL_DEBT_KEY,
    RESILIENCE_BIS_LBS_KEY,
    RESILIENCE_FATF_LISTING_KEY,
  ] as const;
  const missing: string[] = [];
  for (const key of requiredSeedKeys) {
    const meta = await reader(resolveSeedMetaKey(key));
    if (!meta) missing.push(key);
  }
  if (missing.length > 0) {
    throw new ResilienceConfigurationError(
      `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=true but required seed-meta absent for: ${missing.join(', ')}. ` +
        'Provision the macro bundle component seeders (seed-bis-lbs, seed-fatf-listing, ' +
        'seed-wb-external-debt) and confirm Redis populates BEFORE flipping the flag. ' +
        'Or set RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=false to keep the dim dark. ' +
        'See plan 2026-04-25-004 §Fail-closed preflight.',
      missing,
    );
  }

  // Per-component reads. Each returns null on per-country data gap; the
  // weightedBlend drops null-score slots from the blend denominator.
  const [debtRaw, bisRaw, fatfRaw] = await Promise.all([
    reader(RESILIENCE_WB_EXTERNAL_DEBT_KEY),
    reader(RESILIENCE_BIS_LBS_KEY),
    reader(RESILIENCE_FATF_LISTING_KEY),
  ]);

  // Component 1: short-term external debt as % of GNI. WB IDS coverage is
  // ~125 LMICs; HIC fall through to per-component-null and the blend
  // covers the gap via the BIS LBS structural-exposure component.
  // Payload shape: { countries: { [iso2]: { value: number, year: number } } }.
  const debtPct = readWbExternalDebtPct(debtRaw, countryCode);

  // Component 2 + 4 share the BIS LBS payload. Component 2: sum of
  // by-parent claims for the enumerated Western parents as % of GDP.
  // Component 4: count of distinct by-parent reporters with non-trivial
  // claims (>1% of GDP).
  // Payload shape: { countries: { [iso2]: { totalXborderPctGdp: number,
  //   parentCount: number, parents: { [parentIso2]: number } } } }.
  const bisCountry = readBisLbsCountry(bisRaw, countryCode);

  // Component 3: FATF listing status. Discrete classification.
  // Payload shape: { listings: { [iso2]: 'black' | 'gray' | 'compliant' },
  //   publicationDate: string }.
  const fatfStatus = readFatfStatus(fatfRaw, countryCode);

  return weightedBlend([
    {
      score: debtPct == null ? null : normalizeLowerBetter(debtPct, 0, 15),
      weight: 0.35,
    },
    {
      score: bisCountry?.totalXborderPctGdp == null
        ? null
        : normalizeBandLowerBetter(bisCountry.totalXborderPctGdp),
      weight: 0.30,
    },
    {
      score: fatfStatus == null ? null : fatfStatusToScore(fatfStatus),
      weight: 0.20,
    },
    {
      score: bisCountry?.parentCount == null
        ? null
        : normalizeHigherBetter(bisCountry.parentCount, 1, 10),
      weight: 0.15,
    },
  ]);
}

// Small payload accessors for scoreFinancialSystemExposure. Defensive
// against unexpected shapes; return null on any deviation.

function readWbExternalDebtPct(raw: unknown, countryCode: string): number | null {
  if (raw == null || typeof raw !== 'object') return null;
  const countries = (raw as { countries?: Record<string, unknown> }).countries;
  if (!countries || typeof countries !== 'object') return null;
  const entry = countries[countryCode];
  if (!entry || typeof entry !== 'object') return null;
  return safeNum((entry as { value?: unknown }).value);
}

interface BisLbsCountry {
  totalXborderPctGdp: number | null;
  parentCount: number | null;
}

function readBisLbsCountry(raw: unknown, countryCode: string): BisLbsCountry | null {
  if (raw == null || typeof raw !== 'object') return null;
  const countries = (raw as { countries?: Record<string, unknown> }).countries;
  if (!countries || typeof countries !== 'object') return null;
  const entry = countries[countryCode];
  if (!entry || typeof entry !== 'object') return null;
  return {
    totalXborderPctGdp: safeNum((entry as { totalXborderPctGdp?: unknown }).totalXborderPctGdp),
    parentCount: safeNum((entry as { parentCount?: unknown }).parentCount),
  };
}

type FatfStatus = 'black' | 'gray' | 'compliant';

function readFatfStatus(raw: unknown, countryCode: string): FatfStatus | null {
  if (raw == null || typeof raw !== 'object') return null;
  const listings = (raw as { listings?: Record<string, unknown> }).listings;
  if (!listings || typeof listings !== 'object') return null;
  // Defense-in-depth (Greptile P2 catch, PR #3407 review 2026-04-25):
  // an empty `listings` dict that bypassed the seeder's validate()
  // would otherwise default every country to 'compliant' (score 100)
  // and silently mask a parser regression. Return null instead so the
  // FATF slot drops out of the weighted blend — coverage shrinks
  // visibly rather than the dim looking healthy with all-100s. The
  // seeder's >=1 black + >=12 grey gate normally prevents this from
  // reaching production, but defense-in-depth costs nothing.
  if (Object.keys(listings).length === 0) return null;
  const status = listings[countryCode];
  if (status === 'black' || status === 'gray' || status === 'compliant') return status;
  // Unknown country = compliant (FATF only enumerates non-compliant
  // jurisdictions; absence from both lists means compliant).
  return 'compliant';
}

function fatfStatusToScore(status: FatfStatus): number {
  switch (status) {
    case 'black': return 0;
    case 'gray': return 30;
    case 'compliant': return 100;
  }
}

export async function scoreCyberDigital(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [cyberRaw, outagesRaw, gpsRaw] = await Promise.all([
    reader(RESILIENCE_CYBER_KEY),
    reader(RESILIENCE_OUTAGES_KEY),
    reader(RESILIENCE_GPS_KEY),
  ]);
  const cyber = summarizeCyber(cyberRaw, countryCode);
  const outages = summarizeOutages(outagesRaw, countryCode);
  const gps = summarizeGps(gpsRaw, countryCode);
  const outagePenalty = outages.total * 4 + outages.major * 2 + outages.partial;
  const gpsPenalty = gps.high * 3 + gps.medium;

  return weightedBlend([
    { score: cyberRaw != null && cyber.weightedCount > 0 ? normalizeLowerBetter(cyber.weightedCount, 0, 25) : null, weight: 0.45 },
    { score: outagesRaw != null && outagePenalty > 0 ? normalizeLowerBetter(outagePenalty, 0, 20) : null, weight: 0.35 },
    { score: gpsRaw != null && gpsPenalty > 0 ? normalizeLowerBetter(gpsPenalty, 0, 20) : null, weight: 0.2 },
  ]);
}

export async function scoreLogisticsSupply(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [staticRecord, shippingStressRaw, transitSummariesRaw] = await Promise.all([
    readStaticCountry(countryCode, reader),
    reader(RESILIENCE_SHIPPING_STRESS_KEY),
    reader(RESILIENCE_TRANSIT_SUMMARIES_KEY),
  ]);

  const roadsPaved = getStaticIndicatorValue(staticRecord, 'infrastructure', 'IS.ROD.PAVE.ZS');
  const shippingStress = getShippingStressScore(shippingStressRaw);
  const transitStress = getTransitDisruptionScore(transitSummariesRaw);

  const tradeToGdp = safeNum(staticRecord?.tradeToGdp?.tradeToGdpPct);
  // Plan 2026-04-26-001 §U1: removed the prior `0.5` default fallback
  // for missing `tradeToGdp`. The `100 * (1 - tradeExposure)` neutralizer
  // below intentionally suppresses global-stress penalties for closed
  // economies, but the 0.5 default extended that suppression to countries
  // with NO observed trade-to-GDP at all (tiny island states),
  // inflating their shipping/transit components to ~75. Now: missing
  // tradeToGdp drops the exposure-weighted components entirely (cov derate)
  // rather than imputing them at an "average openness" assumption.
  const tradeExposure = tradeToGdp != null ? Math.min(tradeToGdp / 50, 1.0) : null;

  const shippingScore = shippingStress == null ? null : normalizeLowerBetter(shippingStress, 0, 100);
  const transitScore = transitStress == null ? null : normalizeLowerBetter(transitStress, 0, 30);

  return weightedBlend([
    { score: roadsPaved == null ? null : normalizeHigherBetter(roadsPaved, 0, 100), weight: 0.5 },
    { score: shippingScore == null || tradeExposure == null ? null : shippingScore * tradeExposure + 100 * (1 - tradeExposure), weight: 0.25 },
    { score: transitScore == null || tradeExposure == null ? null : transitScore * tradeExposure + 100 * (1 - tradeExposure), weight: 0.25 },
  ]);
}

export async function scoreInfrastructure(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [staticRecord, outagesRaw] = await Promise.all([
    readStaticCountry(countryCode, reader),
    reader(RESILIENCE_OUTAGES_KEY),
  ]);
  const electricityAccess = getStaticIndicatorValue(staticRecord, 'infrastructure', 'EG.ELC.ACCS.ZS');
  const roadsPaved = getStaticIndicatorValue(staticRecord, 'infrastructure', 'IS.ROD.PAVE.ZS');
  const broadband = getStaticIndicatorValue(staticRecord, 'infrastructure', 'IT.NET.BBND.P2');
  const outages = summarizeOutages(outagesRaw, countryCode);
  const outagePenalty = outages.total * 4 + outages.major * 2 + outages.partial;

  return weightedBlend([
    { score: electricityAccess == null ? null : normalizeHigherBetter(electricityAccess, 40, 100), weight: 0.3 },
    { score: roadsPaved == null ? null : normalizeHigherBetter(roadsPaved, 0, 100), weight: 0.3 },
    { score: outagesRaw != null && outagePenalty > 0 ? normalizeLowerBetter(outagePenalty, 0, 20) : null, weight: 0.25 },
    { score: broadband == null ? null : normalizeHigherBetter(broadband, 0, 40), weight: 0.15 },
  ]);
}

// Legacy energy scorer. Default path. Kept intact for one release
// cycle so flipping `RESILIENCE_ENERGY_V2_ENABLED=false` reverts to
// byte-identical scoring behaviour for every country in the published
// snapshot.
async function scoreEnergyLegacy(
  countryCode: string,
  reader: ResilienceSeedReader,
): Promise<ResilienceDimensionScore> {
  const [staticRecord, energyPricesRaw, energyMixRaw, storageRaw] = await Promise.all([
    readStaticCountry(countryCode, reader),
    reader(RESILIENCE_ENERGY_PRICES_KEY),
    reader(`${RESILIENCE_ENERGY_MIX_KEY_PREFIX}${countryCode}`),
    reader(`energy:gas-storage:v1:${countryCode}`),
  ]);

  const mix = energyMixRaw != null && typeof energyMixRaw === 'object'
    ? (energyMixRaw as Record<string, unknown>)
    : null;

  const dependency             = safeNum(staticRecord?.iea?.energyImportDependency?.value);
  const gasShare               = mix && typeof mix.gasShare === 'number' ? mix.gasShare : null;
  const coalShare              = mix && typeof mix.coalShare === 'number' ? mix.coalShare : null;
  const renewShare             = mix && typeof mix.renewShare === 'number' ? mix.renewShare : null;
  const energyStress           = getEnergyPriceStress(energyPricesRaw);
  // EG.USE.ELEC.KH.PC: per-capita electricity consumption (kWh/year).
  // Very low consumption signals grid collapse (blackouts, crisis), not efficiency.
  // Countries absent from Eurostat (non-EU) have no IEA import-dependency figure, so
  // this metric becomes the primary indicator of actual energy infrastructure health.
  const electricityConsumption = getStaticIndicatorValue(staticRecord, 'infrastructure', 'EG.USE.ELEC.KH.PC');

  const storageFillPct = storageRaw != null && typeof storageRaw === 'object'
    ? (() => {
        const raw = (storageRaw as Record<string, unknown>).fillPct;
        return raw != null ? safeNum(raw) : null;
      })()
    : null;
  const storageStress = storageFillPct != null
    ? Math.min(1, Math.max(0, (80 - storageFillPct) / 80))
    : null;

  const energyExposure = staticRecord == null ? null : (dependency != null ? Math.min(Math.max(dependency / 60, 0), 1.0) : 0.5);
  const energyStressScore = energyStress == null ? null : normalizeLowerBetter(energyStress, 0, 25);
  const exposedEnergyStress = energyStressScore == null || energyExposure == null
    ? null
    : energyStressScore * energyExposure + 100 * (1 - energyExposure);

  return weightedBlend([
    { score: dependency             == null ? null : normalizeLowerBetter(dependency, 0, 100),              weight: 0.25 },
    { score: gasShare               == null ? null : normalizeLowerBetter(gasShare, 0, 100),                weight: 0.12 },
    { score: coalShare              == null ? null : normalizeLowerBetter(coalShare, 0, 100),               weight: 0.08 },
    { score: renewShare             == null ? null : normalizeHigherBetter(renewShare, 0, 100),             weight: 0.05 },
    { score: storageStress          == null ? null : normalizeLowerBetter(storageStress * 100, 0, 100),     weight: 0.10 },
    { score: exposedEnergyStress,                                                                           weight: 0.10 },
    { score: electricityConsumption == null ? null : normalizeHigherBetter(electricityConsumption, 200, 8000), weight: 0.30 },
  ]);
}

// PR 1 v2 energy scorer under Option B (power-system security framing).
// Activated when RESILIENCE_ENERGY_V2_ENABLED=true. Reads from the
// PR 1 seed keys (low-carbon generation, fossil-electricity share,
// power losses, reserve margin). Missing inputs degrade gracefully —
// `weightedBlend` handles null scores per the normal coverage/
// imputation path, and the v2 indicators ship `tier: 'experimental'`
// in the registry so the Core coverage gate doesn't fire while
// seeders are being provisioned.
//
// Composite construction:
//   importedFossilDependence = fossilElectricityShare × max(netImports, 0) / 100
//     where fossilElectricityShare is `resilience:fossil-electricity-share:v1`
//     and netImports is the legacy `iea.energyImportDependency.value`
//     (EG.IMP.CONS.ZS) read from the existing static seed; we reuse
//     rather than re-seed per plan §3.2.
//
// euGasStorageStress: per plan §3.5 point 2, the signal is renamed
// and scoped to EU members only. Non-EU countries contribute `null`
// (not 0) so the weighted blend re-normalises without penalising
// them for a regional-only signal.
async function scoreEnergyV2(
  countryCode: string,
  reader: ResilienceSeedReader,
): Promise<ResilienceDimensionScore> {
  // reserveMarginPct is DEFERRED per plan §3.1 (IEA coverage too sparse;
  // open-question whether the indicator ships at all). Its 0.10 weight
  // is absorbed into powerLossesPct (→ 0.20) so the v2 blend remains
  // grid-integrity-weighted. When a reserve-margin seeder eventually
  // lands, split 0.10 back out of powerLosses and add reserveMargin
  // here at 0.10. The Redis key RESILIENCE_RESERVE_MARGIN_KEY stays
  // reserved in this file for that commit.
  const [
    staticRecord, energyPricesRaw, storageRaw,
    fossilShareRaw, lowCarbonRaw, powerLossesRaw,
  ] = await Promise.all([
    readStaticCountry(countryCode, reader),
    reader(RESILIENCE_ENERGY_PRICES_KEY),
    reader(`energy:gas-storage:v1:${countryCode}`),
    reader(RESILIENCE_FOSSIL_ELEC_SHARE_KEY),
    reader(RESILIENCE_LOW_CARBON_GEN_KEY),
    reader(RESILIENCE_POWER_LOSSES_KEY),
  ]);

  // Per-country value lookup on the bulk-payload shape emitted by the
  // three PR 1 seeders: { countries: { [ISO2]: { value, year } } }.
  const bulkValue = (raw: unknown): number | null => {
    const entry = (raw as { countries?: Record<string, { value?: number }> } | null)
      ?.countries?.[countryCode];
    return typeof entry?.value === 'number' ? entry.value : null;
  };

  const fossilElectricityShare = bulkValue(fossilShareRaw);
  const lowCarbonGenerationShare = bulkValue(lowCarbonRaw);
  const powerLosses = bulkValue(powerLossesRaw);
  const netImports = safeNum(staticRecord?.iea?.energyImportDependency?.value);

  // importedFossilDependence composite. `max(netImports, 0)` collapses
  // net-exporter cases (negative EG.IMP.CONS.ZS) to zero per plan §3.2.
  // Division by 100 keeps the product in the [0, 100] range expected
  // by normalizeLowerBetter.
  const importedFossilDependence = fossilElectricityShare != null && netImports != null
    ? fossilElectricityShare * Math.max(netImports, 0) / 100
    : null;

  // euGasStorageStress — same transform as legacy storageStress, but
  // null outside the EU so non-EU countries don't get penalised for a
  // regional-only signal.
  const storageFillPct = storageRaw != null && typeof storageRaw === 'object'
    ? (() => {
        const raw = (storageRaw as Record<string, unknown>).fillPct;
        return raw != null ? safeNum(raw) : null;
      })()
    : null;
  const euStorageStress = EU_GAS_STORAGE_COUNTRIES.has(countryCode) && storageFillPct != null
    ? Math.min(1, Math.max(0, (80 - storageFillPct) / 80))
    : null;

  // energyPriceStress retains its exposure-modulated form but weights
  // to 0.15 under v2. Exposure is now derived from fossil share of
  // electricity generation (Option B framing) rather than overall
  // energy import dependency.
  const energyStress = getEnergyPriceStress(energyPricesRaw);
  const energyStressScore = energyStress == null ? null : normalizeLowerBetter(energyStress, 0, 25);
  const exposure = fossilElectricityShare != null
    ? Math.min(Math.max(fossilElectricityShare / 60, 0), 1.0)
    : 0.5;
  const exposedEnergyStress = energyStressScore == null
    ? null
    : energyStressScore * exposure + 100 * (1 - exposure);

  return weightedBlend([
    { score: importedFossilDependence == null ? null : normalizeLowerBetter(importedFossilDependence, 0, 100), weight: 0.35 },
    { score: lowCarbonGenerationShare == null ? null : normalizeHigherBetter(lowCarbonGenerationShare, 0, 80),  weight: 0.20 },
    { score: powerLosses              == null ? null : normalizeLowerBetter(powerLosses, 3, 25),                weight: 0.20 },
    { score: euStorageStress          == null ? null : normalizeLowerBetter(euStorageStress * 100, 0, 100),     weight: 0.10 },
    { score: exposedEnergyStress,                                                                                weight: 0.15 },
  ]);
}

export async function scoreEnergy(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  if (!isEnergyV2EnabledLocal()) {
    return scoreEnergyLegacy(countryCode, reader);
  }

  // Flag is ON — preflight the required seeds before routing to v2.
  // A null from any of these would let scoreEnergyV2 score every country
  // via the IMPUTE fallback with no signal to the operator (weightedBlend
  // silently collapses null indicators to the imputation path). Fail-closed:
  // throw ResilienceConfigurationError, caught at scoreAllDimensions and
  // surfaced as imputationClass='source-failure' on the energy dimension.
  // See docs/plans/2026-04-24-001-fix-resilience-v2-fail-closed-on-missing-seeds-plan.md.
  const [fossilShareRaw, lowCarbonRaw, powerLossesRaw] = await Promise.all([
    reader(RESILIENCE_FOSSIL_ELEC_SHARE_KEY),
    reader(RESILIENCE_LOW_CARBON_GEN_KEY),
    reader(RESILIENCE_POWER_LOSSES_KEY),
  ]);
  const missing: string[] = [];
  if (fossilShareRaw == null) missing.push(RESILIENCE_FOSSIL_ELEC_SHARE_KEY);
  if (lowCarbonRaw == null) missing.push(RESILIENCE_LOW_CARBON_GEN_KEY);
  if (powerLossesRaw == null) missing.push(RESILIENCE_POWER_LOSSES_KEY);
  if (missing.length > 0) {
    throw new ResilienceConfigurationError(
      `RESILIENCE_ENERGY_V2_ENABLED=true but required v2 energy seeds are absent: ${missing.join(', ')}. ` +
        `Provision seed-bundle-resilience-energy-v2 on Railway and confirm seeds populate BEFORE flipping the flag. ` +
        'Or set RESILIENCE_ENERGY_V2_ENABLED=false to revert to the legacy energy construct.',
      missing,
    );
  }

  return scoreEnergyV2(countryCode, reader);
}

export async function scoreGovernanceInstitutional(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const staticRecord = await readStaticCountry(countryCode, reader);
  const wgiScores = getStaticWgiValues(staticRecord).map((value) => normalizeHigherBetter(value, -2.5, 2.5));
  return weightedBlend(wgiScores.map((score) => ({ score, weight: 1 })));
}

export async function scoreSocialCohesion(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [staticRecord, displacementRaw, unrestRaw, imfLaborRaw] = await Promise.all([
    readStaticCountry(countryCode, reader),
    reader(`${RESILIENCE_DISPLACEMENT_PREFIX}:${new Date().getFullYear()}`),
    reader(RESILIENCE_UNREST_KEY),
    reader(RESILIENCE_IMF_LABOR_KEY),
  ]);
  const gpiScore = safeNum(staticRecord?.gpi?.score);
  const displacement = getCountryDisplacement(displacementRaw, countryCode);
  const unrest = summarizeUnrest(unrestRaw, countryCode);
  const displacementMetric = safeNum(displacement?.totalDisplaced);
  // Plan 2026-04-26-002 §U6 — per-capita normalization. Event counts are
  // divided by max(populationMillions, 0.5) so 0 events on TV (12k pop)
  // does not score above 5 events on Yemen (33M pop). The 0.5-million
  // floor protects against divide-by-zero/inflation for tiny states
  // (Tuvalu/Nauru/Palau ≈ 0.01M-0.02M); the floor's effect is to anchor
  // micro-state per-capita rates at "as-if 500k population" rather than
  // amplifying single events into towering rates. Goalposts re-anchored
  // 0..10 events/M; Iceland ≈ 0 events/M, Yemen ≈ 6 events/M, Lebanon
  // outliers ≈ 10 events/M (calibrated empirically against the live
  // unrest:events:v1 distribution).
  const popDenominator = readPopulationMillions(imfLaborRaw, countryCode);
  const unrestMetric = (unrest.unrestCount + Math.sqrt(unrest.fatalities)) / popDenominator;

  // GPI empirical range: 1.1 (Iceland) – 3.4 (Yemen 2024). Anchor worst=3.6 (slightly
  // above observed max) so the worst-peace countries score near 0, not 20.
  // The old anchor of 4.0 gave Yemen (3.4) a score of 20 instead of ~8.
  const gpiRow: WeightedMetric = {
    score: gpiScore == null ? null : normalizeLowerBetter(gpiScore, 1.0, 3.6),
    weight: 0.55,
  };

  // Plan 2026-04-26-001 §U2: gated impute logic for displacement and unrest.
  //
  //   if displacementRaw is null:                  // seed outage
  //     drop displacement weight
  //   elif country not in displacement registry:   // GPI-only mode
  //     impute displacement at 70/0.6
  //     if unrestRaw present and zero unrest:
  //       impute unrest at 70/0.5  (gated to GPI-only mode)
  //   elif displacement metric exists:             // happy path
  //     score directly
  //     if unrest count == 0:
  //       impute unrest at unhcrDisplacement.score (85)  // peaceful + observed
  //
  // Rationale: tiny states with no observed displacement/unrest were
  // collapsing to GPI-only and inflating to ~95. Lower impute values in
  // GPI-only mode pull the blend down. Countries WITH observed displacement
  // and zero unrest events keep the historical "stable-absence ≈ 85" anchor
  // so Iceland/Norway don't regress.
  let displacementRow: WeightedMetric;
  let unrestRow: WeightedMetric;

  if (displacementRaw == null) {
    // Seed outage — drop displacement weight (NOT imputed).
    displacementRow = { score: null, weight: 0.25 };
  } else if (displacementMetric == null) {
    // Country not in registry → GPI-only mode. Impute at lower-than-GPI
    // value to pull the blend down for tiny peaceful states.
    displacementRow = {
      score: IMPUTE.socialCohesionGpiOnlyDisplacement.score,
      weight: 0.25,
      certaintyCoverage: IMPUTE.socialCohesionGpiOnlyDisplacement.certaintyCoverage,
      imputed: true,
      imputationClass: IMPUTE.socialCohesionGpiOnlyDisplacement.imputationClass,
    };
  } else {
    // Happy path: country observed in displacement registry.
    displacementRow = {
      score: normalizeLowerBetter(Math.log10(Math.max(1, displacementMetric)), 0, 7),
      weight: 0.25,
    };
  }

  if (unrestRaw == null) {
    // Seed outage — drop unrest weight (NOT imputed).
    unrestRow = { score: null, weight: 0.2 };
  } else if (unrest.unrestCount === 0 && unrest.fatalities === 0) {
    // Zero unrest events. Three sub-cases — distinguished by displacement state:
    //   (a) Displacement OUTAGE (displacementRaw == null) → impute at 85
    //       (`unhcrDisplacement.score`). Outage is NOT a country-level absence
    //       signal, so we must NOT pull the blend down via the GPI-only impute.
    //       This mirrors the principle in scoreBorderSecurity: outage drops weight
    //       on the affected metric ONLY, not on sibling metrics.
    //   (b) GPI-only mode (displacementRaw present but country absent from
    //       registry) → impute at 70 (`socialCohesionGpiOnlyUnrest.score`) to
    //       pull the blend down for tiny peaceful states (TV/PW/NR).
    //   (c) Happy path (displacement observed) → impute at 85
    //       (`unhcrDisplacement.score`) so peaceful + fully-monitored
    //       countries (Iceland, Norway) don't regress.
    //
    // The GPI-only branch is gated on `displacementRaw != null`. Cases (a)
    // and (c) collapse to the same 85/0.6 impute because both represent
    // "we have no signal that displacement is unusual" — only case (b) is the
    // intentional cohort de-rate.
    if (displacementRaw != null && displacementMetric == null) {
      // Plan 2026-04-26-002 §U5 — non-comprehensive source fallback.
      // The unrest:events:v1 source is non-comprehensive (event-scraping
      // feed, English-biased, ACLED-style coverage gaps), so per the
      // plan, absence of unrest data does NOT impute at the stable-
      // absence anchor (70/0.5). It falls back to unmonitored (50/0.3),
      // pulling the GPI-only blend down for tiny peaceful states (TV/PW/
      // NR/MC) that previously rode the 70 anchor to a near-perfect dim
      // score; comprehensive-source countries are unaffected.
      //
      // The §U5 contract is enforced by the registry assertion in
      // tests/resilience-source-comprehensive-flag.test.mts (unrestEvents
      // pinned `comprehensive: false`); IF a future PR ever flips that
      // flag, the pinning test fires and the contributor must also
      // restore the higher-anchor IMPUTE here. Inlining (rather than
      // wrapping in `isIndicatorComprehensive('unrestEvents') ? ...`)
      // keeps the code path active and tested instead of relying on a
      // dead-by-construction conditional.
      unrestRow = {
        score: IMPUTATION.curated_list_absent.score,
        weight: 0.2,
        certaintyCoverage: IMPUTATION.curated_list_absent.certaintyCoverage,
        imputed: true,
        imputationClass: IMPUTATION.curated_list_absent.imputationClass,
      };
    } else {
      unrestRow = {
        score: IMPUTE.unhcrDisplacement.score,
        weight: 0.2,
        certaintyCoverage: IMPUTE.unhcrDisplacement.certaintyCoverage,
        imputed: true,
        imputationClass: IMPUTE.unhcrDisplacement.imputationClass,
      };
    }
  } else {
    // Observed unrest events — score directly. Plan §U6 per-capita
    // anchor: 10 events/M = "worst" (Lebanon-class), 0 events/M = "best"
    // (Iceland). Was 0..20 in raw event-count units before §U6.
    unrestRow = {
      score: normalizeLowerBetter(unrestMetric, 0, 10),
      weight: 0.2,
    };
  }

  return weightedBlend([gpiRow, displacementRow, unrestRow]);
}

export async function scoreBorderSecurity(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [ucdpRaw, displacementRaw, imfLaborRaw] = await Promise.all([
    reader(RESILIENCE_UCDP_KEY),
    reader(`${RESILIENCE_DISPLACEMENT_PREFIX}:${new Date().getFullYear()}`),
    reader(RESILIENCE_IMF_LABOR_KEY),
  ]);
  const ucdp = summarizeUcdp(ucdpRaw, countryCode);
  const displacement = getCountryDisplacement(displacementRaw, countryCode);
  // Plan 2026-04-26-002 §U6 — UCDP per-capita event normalization, same
  // pattern as scoreSocialCohesion above. eventCount and deaths are
  // population-normalized so 0 events on TV doesn't ride above 5 events
  // on Yemen. typeWeight is dimensionless (severity tag, not a count) so
  // it stays as-is. Goalposts re-anchored 0..15 events/M (slightly higher
  // ceiling than socialCohesion because UCDP eventCount * 2 multiplier
  // already lifts the metric magnitude).
  const popDenominator = readPopulationMillions(imfLaborRaw, countryCode);
  // Plan §U6 review fix: typeWeight is event-count-scaled (incremented
  // per-event in summarizeUcdp:907), not a per-event severity tag, so it
  // must scale per-capita too. Pre-fix the unnormalized typeWeight could
  // dominate the per-capita metric for high-event countries (US/IN type
  // peaceful but high-volume), defeating §U6's intended scaling.
  const conflictMetric = (ucdp.eventCount * 2 + ucdp.typeWeight + Math.sqrt(ucdp.deaths)) / popDenominator;
  const displacementMetric = safeNum(displacement?.hostTotal) ?? safeNum(displacement?.totalDisplaced);

  return weightedBlend([
    { score: ucdpRaw != null ? normalizeLowerBetter(conflictMetric, 0, 15) : null, weight: 0.65 },
    // Not in UNHCR displacement registry → crisis_monitoring_absent (country is not a
    // significant refugee source or host). Only impute if source was loaded; null source
    // means seed outage, not country absence.
    displacementRaw == null
      ? { score: null, weight: 0.35 }
      : displacementMetric == null
        ? { score: IMPUTE.unhcrDisplacement.score, weight: 0.35, certaintyCoverage: IMPUTE.unhcrDisplacement.certaintyCoverage, imputed: true, imputationClass: IMPUTE.unhcrDisplacement.imputationClass }
        : { score: normalizeLowerBetter(Math.log10(Math.max(1, displacementMetric)), 0, 7), weight: 0.35 },
  ]);
}

export async function scoreInformationCognitive(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [staticRecord, socialVelocityRaw, threatSummaryRaw] = await Promise.all([
    readStaticCountry(countryCode, reader),
    reader(RESILIENCE_SOCIAL_VELOCITY_KEY),
    reader(RESILIENCE_NEWS_THREAT_SUMMARY_KEY),
  ]);
  const rsfScore = safeNum(staticRecord?.rsf?.score);
  const velocity = summarizeSocialVelocity(socialVelocityRaw, countryCode);
  const threatScore = getThreatSummaryScore(threatSummaryRaw, countryCode);

  const langFactor = getLanguageCoverageFactor(countryCode);
  const adjustedVelocity = velocity > 0 ? Math.min(velocity / Math.max(langFactor, 0.1), 1000) : 0;
  const adjustedThreat = threatScore != null ? Math.min(threatScore / Math.max(langFactor, 0.1), 100) : null;

  return weightedBlend([
    { score: rsfScore == null ? null : normalizeLowerBetter(rsfScore, 0, 100), weight: 0.55 },
    { score: adjustedVelocity > 0 ? normalizeLowerBetter(Math.log10(adjustedVelocity + 1), 0, 3) : null, weight: 0.15 },
    { score: adjustedThreat == null ? null : normalizeLowerBetter(adjustedThreat, 0, 20), weight: 0.3 },
  ]);
}

export async function scoreHealthPublicService(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const staticRecord = await readStaticCountry(countryCode, reader);
  const hospitalBeds = getStaticIndicatorValue(staticRecord, 'who', 'hospitalBeds');
  const uhcIndex = getStaticIndicatorValue(staticRecord, 'who', 'uhcIndex');
  const measlesCoverage = getStaticIndicatorValue(staticRecord, 'who', 'measlesCoverage');
  const physiciansPer1k = getStaticIndicatorValue(staticRecord, 'who', 'physiciansPer1k');
  const healthExpPerCapitaUsd = getStaticIndicatorValue(staticRecord, 'who', 'healthExpPerCapitaUsd');

  return weightedBlend([
    { score: uhcIndex == null ? null : normalizeHigherBetter(uhcIndex, 40, 90), weight: 0.35 },
    { score: measlesCoverage == null ? null : normalizeHigherBetter(measlesCoverage, 50, 99), weight: 0.25 },
    { score: hospitalBeds == null ? null : normalizeHigherBetter(hospitalBeds, 0, 8), weight: 0.10 },
    { score: physiciansPer1k == null ? null : normalizeHigherBetter(physiciansPer1k, 0, 5), weight: 0.15 },
    { score: healthExpPerCapitaUsd == null ? null : normalizeHigherBetter(healthExpPerCapitaUsd, 20, 3000), weight: 0.15 },
  ]);
}

export async function scoreFoodWater(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const staticRecord = await readStaticCountry(countryCode, reader);
  const fao = staticRecord?.fao ?? null;
  const aquastatScore = scoreAquastatValue(staticRecord);

  // IPC/HDX only tracks countries IN active food crisis. Absence means the country is not
  // a monitored crisis case → crisis_monitoring_absent → positive signal.
  // But only impute if the static bundle was loaded (seeder wrote fao: null explicitly).
  // A missing resilience:static:{ISO2} key means the seeder never ran — not crisis-free.
  if (fao == null) {
    return weightedBlend([
      staticRecord == null
        ? { score: null, weight: 0.6 }
        : { score: IMPUTE.ipcFood.score, weight: 0.6, certaintyCoverage: IMPUTE.ipcFood.certaintyCoverage, imputed: true, imputationClass: IMPUTE.ipcFood.imputationClass },
      { score: aquastatScore, weight: 0.4 },
    ]);
  }

  const peopleInCrisis = safeNum(fao.peopleInCrisis);
  const phase = safeNum(String(fao.phase || '').match(/\d+/)?.[0]);

  return weightedBlend([
    {
      score: peopleInCrisis == null
        ? null
        : normalizeLowerBetter(Math.log10(Math.max(1, peopleInCrisis)), 0, 7),
      weight: 0.45,
    },
    { score: phase == null ? null : normalizeLowerBetter(phase, 1, 5), weight: 0.15 },
    { score: aquastatScore, weight: 0.4 },
  ]);
}

interface RecoveryFiscalSpaceCountry {
  govRevenuePct?: number | null;
  fiscalBalancePct?: number | null;
  debtToGdpPct?: number | null;
  year?: number | null;
}

interface RecoveryReserveAdequacyCountry {
  reserveMonths?: number | null;
  year?: number | null;
}

interface RecoveryExternalDebtCountry {
  debtToReservesRatio?: number | null;
  year?: number | null;
}

interface RecoveryImportHhiCountry {
  hhi?: number | null;
  year?: number | null;
}

// RecoveryFuelStocksCountry interface removed in PR 3 — scoreFuelStockDays
// no longer reads any payload. Do NOT re-add the type as a reservation;
// the tsc noUnusedLocals rule rejects unused locals. When a new
// recovery-fuel concept lands, introduce a fresh interface with a
// different name + the actual shape it needs.

function getRecoveryCountryEntry<T>(raw: unknown, countryCode: string): T | null {
  const countries = (raw as { countries?: Record<string, T> } | null)?.countries;
  if (!countries || typeof countries !== 'object') return null;
  return (countries[countryCode.toUpperCase()] as T | undefined) ?? null;
}

export async function scoreFiscalSpace(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const raw = await reader(RESILIENCE_RECOVERY_FISCAL_SPACE_KEY);
  const entry = getRecoveryCountryEntry<RecoveryFiscalSpaceCountry>(raw, countryCode);
  if (!entry) {
    return {
      score: IMPUTE.recoveryFiscalSpace.score,
      coverage: IMPUTE.recoveryFiscalSpace.certaintyCoverage,
      observedWeight: 0,
      imputedWeight: 1,
      imputationClass: IMPUTE.recoveryFiscalSpace.imputationClass,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }

  return weightedBlend([
    { score: entry.govRevenuePct == null ? null : normalizeHigherBetter(entry.govRevenuePct, 5, 45), weight: 0.4 },
    { score: entry.fiscalBalancePct == null ? null : normalizeHigherBetter(entry.fiscalBalancePct, -15, 5), weight: 0.3 },
    { score: entry.debtToGdpPct == null ? null : normalizeLowerBetter(entry.debtToGdpPct, 0, 150), weight: 0.3 },
  ]);
}

// RETIRED in PR 2 §3.4. Superseded by `scoreLiquidReserveAdequacy` +
// `scoreSovereignFiscalBuffer`. The split was the only honest treatment
// of the construct: the previous dimension blended "central-bank reserves
// in months of imports" with an implicit assumption that sovereign wealth
// funds weren't state-deployable buffers, which systematically under-ranked
// Norway / Gulf oil states / Singapore. The new two-dimension shape
// separates the liquid-reserve signal from the SWF haircut signal.
//
// Shape mirrors scoreFuelStockDays (PR 3 §3.5 retirement):
// coverage=0 + imputationClass=null so the confidence/coverage averages
// filter it out via RESILIENCE_RETIRED_DIMENSIONS. Kept in the scorer
// map for structural continuity; a future PR can remove the dimension
// entirely once the cached response shape has bumped.
export async function scoreReserveAdequacy(
  _countryCode: string,
  _reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  return {
    score: 50,
    coverage: 0,
    observedWeight: 0,
    imputedWeight: 0,
    imputationClass: null,
    freshness: { lastObservedAtMs: 0, staleness: '' },
  };
}

// PR 2 §3.4 — new dimension replacing the liquid-reserves half of the
// retired `reserveAdequacy`. Same source (World Bank `FI.RES.TOTL.MO`
// total reserves in months of imports) but re-anchored to 1..12 months
// instead of 1..18. The tighter ceiling is per the plan: "Anchors 1–12
// months." A country at 12+ months clamps at 100; a country at 1 month
// clamps at 0. Twelve months = ballpark IMF "full reserve adequacy"
// benchmark for a diversified emerging-market importer.
export async function scoreLiquidReserveAdequacy(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const raw = await reader(RESILIENCE_RECOVERY_RESERVE_ADEQUACY_KEY);
  const entry = getRecoveryCountryEntry<RecoveryReserveAdequacyCountry>(raw, countryCode);
  if (!entry || entry.reserveMonths == null) {
    return {
      score: IMPUTE.recoveryLiquidReserveAdequacy.score,
      coverage: IMPUTE.recoveryLiquidReserveAdequacy.certaintyCoverage,
      observedWeight: 0,
      imputedWeight: 1,
      imputationClass: IMPUTE.recoveryLiquidReserveAdequacy.imputationClass,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }
  return weightedBlend([
    { score: normalizeHigherBetter(Math.min(entry.reserveMonths, 12), 1, 12), weight: 1.0 },
  ]);
}

// PR 2 §3.4 — new SWF haircut dimension. Reads per-country SWF records
// from `resilience:recovery:sovereign-wealth:v1` (produced by
// scripts/seed-sovereign-wealth.mjs). Composite:
//   effectiveMonths = rawSwfMonths × access × liquidity × transparency
// pre-computed in the seed payload as `totalEffectiveMonths` (sum
// across a country's manifest funds). Score:
//   score = 100 × (1 − exp(−effectiveMonths / 12))
// The exponential saturation prevents Norway-type outliers (effective
// months in the 100s) from dominating the recovery pillar out of
// proportion to their marginal resilience benefit.
//
// Three code paths:
//   1. Seed key absent entirely (Railway cron hasn't fired on fresh
//      deploy) → IMPUTE fallback, score 50 / coverage 0.3 / unmonitored.
//   2. Seed key present, country in payload → saturating score. Coverage
//      is derated by `completeness` so a partial-scrape on a multi-fund
//      country (AE = ADIA + Mubadala, SG = GIC + Temasek) shows up
//      as lower confidence rather than a silently-understated total.
//   3. Seed key present, country NOT in payload → the country has no
//      sovereign wealth fund in the manifest. Plan 2026-04-26-001 §U3:
//      reframed from "substantive absence (score 0, FULL coverage 1.0)"
//      to "dim-not-applicable (score 0, ZERO coverage,
//      imputationClass 'not-applicable')". The original framing pinned
//      every non-SWF country at score 0 with full weight, dragging the
//      recovery domain down for advanced economies (DE, JP, FR, IT, UK,
//      US) that hold reserves through Treasury / central-bank channels
//      rather than dedicated SWFs. Now the row contributes 0 weight to
//      the recovery-domain coverage-weighted mean so it's effectively
//      excluded; the dim is also excluded from
//      `computeLowConfidence` / `computeOverallCoverage` via the
//      `RESILIENCE_NOT_APPLICABLE_WHEN_ZERO_COVERAGE` set so non-SWF
//      countries don't get falsely flagged as low-confidence.
interface RecoverySovereignWealthCountry {
  totalEffectiveMonths?: number | null;
  completeness?: number | null;
  annualImports?: number | null;
}
interface RecoverySovereignWealthPayload {
  countries?: Record<string, RecoverySovereignWealthCountry>;
}

export async function scoreSovereignFiscalBuffer(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const raw = await reader(RESILIENCE_RECOVERY_SOVEREIGN_WEALTH_KEY);
  const payload = raw as RecoverySovereignWealthPayload | null | undefined;
  // Path 1 — seed key absent entirely. IMPUTE.
  if (!payload || typeof payload !== 'object' || !payload.countries || typeof payload.countries !== 'object') {
    return {
      score: IMPUTE.recoverySovereignFiscalBuffer.score,
      coverage: IMPUTE.recoverySovereignFiscalBuffer.certaintyCoverage,
      observedWeight: 0,
      imputedWeight: 1,
      imputationClass: IMPUTE.recoverySovereignFiscalBuffer.imputationClass,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }
  const entry = payload.countries[countryCode.toUpperCase()] ?? null;
  // Path 3 — seed present, country not in manifest → no SWF.
  // Plan 2026-04-26-001 §U3 (+ review fixup): reframed from
  // "substantive absence (score 0, full coverage 1.0,
  // imputationClass null)" to "dim-not-applicable (score 0, ZERO
  // coverage, imputationClass 'not-applicable')". The original
  // framing penalized advanced economies (DE, JP, FR, IT) that hold
  // reserves through Treasury / central-bank channels rather than
  // dedicated SWFs. The recovery domain's coverage-weighted mean now
  // re-normalizes around the remaining recovery dims because this
  // row contributes 0 weight. Score remains numeric (zero) per the
  // ResilienceDimensionScore.score:number contract and the
  // release-gate Number.isFinite check; coverage:0 is what removes
  // the dim from the mean. The 'not-applicable' tag is the proto's
  // existing 4-class taxonomy member (alongside stable-absence /
  // unmonitored / source-failure) — emitting it here is what the
  // proto comment at imputation_class describes as the "structurally
  // not applicable to this country" sentinel and is what allows
  // client surfaces to mirror the server's exclusion symmetrically.
  if (!entry) {
    return {
      score: 0,
      coverage: 0,
      observedWeight: 0,
      imputedWeight: 0,
      imputationClass: 'not-applicable',
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }
  // Path 2 — country has SWF(s). Saturating transform on totalEffectiveMonths.
  const em = typeof entry.totalEffectiveMonths === 'number' && Number.isFinite(entry.totalEffectiveMonths)
    ? Math.max(0, entry.totalEffectiveMonths)
    : 0;
  const score = 100 * (1 - Math.exp(-em / 12));
  const completeness = typeof entry.completeness === 'number' && Number.isFinite(entry.completeness)
    ? Math.max(0, Math.min(1, entry.completeness))
    : 1.0;
  return weightedBlend([
    // certaintyCoverage = completeness so partial-scrapes derate confidence
    // without zeroing the observed weight. The country is still a real
    // observation — just with fewer of its manifest funds resolved.
    { score, weight: 1.0, certaintyCoverage: completeness },
  ]);
}

export async function scoreExternalDebtCoverage(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const raw = await reader(RESILIENCE_RECOVERY_EXTERNAL_DEBT_KEY);
  const entry = getRecoveryCountryEntry<RecoveryExternalDebtCountry>(raw, countryCode);
  if (!entry || entry.debtToReservesRatio == null) {
    return {
      score: IMPUTE.recoveryExternalDebt.score,
      coverage: IMPUTE.recoveryExternalDebt.certaintyCoverage,
      observedWeight: 0,
      imputedWeight: 1,
      imputationClass: IMPUTE.recoveryExternalDebt.imputationClass,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }
  // PR 3 §3.5 point 3: goalpost re-anchored on Greenspan-Guidotti.
  // Ratio 1.0 (short-term debt matches reserves) = score 50; ratio 2.0
  // = score 0 (acute rollover-shock exposure). See registry entry
  // recoveryDebtToReserves for the construct rationale.
  return weightedBlend([
    { score: normalizeLowerBetter(entry.debtToReservesRatio, 0, 2), weight: 1.0 },
  ]);
}

export async function scoreImportConcentration(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const raw = await reader(RESILIENCE_RECOVERY_IMPORT_HHI_KEY);
  const entry = getRecoveryCountryEntry<RecoveryImportHhiCountry>(raw, countryCode);
  if (!entry || entry.hhi == null) {
    return {
      score: IMPUTE.recoveryImportHhi.score,
      coverage: IMPUTE.recoveryImportHhi.certaintyCoverage,
      observedWeight: 0,
      imputedWeight: 1,
      imputationClass: IMPUTE.recoveryImportHhi.imputationClass,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }
  return weightedBlend([
    // HHI is on a 0..1 scale (0 = perfectly diversified, 1 = single partner).
    // Multiply by 10000 to convert to the traditional 0..10000 HHI scale,
    // then normalize against the 0..5000 goalpost range (where 5000+ = max concentration).
    { score: normalizeLowerBetter(entry.hhi * 10000, 0, 5000), weight: 1.0 },
  ]);
}

export async function scoreStateContinuity(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [staticRecord, ucdpRaw, displacementRaw] = await Promise.all([
    readStaticCountry(countryCode, reader),
    reader(RESILIENCE_UCDP_KEY),
    reader(`${RESILIENCE_DISPLACEMENT_PREFIX}:${new Date().getFullYear()}`),
  ]);

  const wgiValues = getStaticWgiValues(staticRecord);
  const wgiMean = mean(wgiValues);

  const ucdpSummary = summarizeUcdp(ucdpRaw, countryCode);
  const ucdpRawScore = ucdpSummary.eventCount * 2 + ucdpSummary.typeWeight + Math.sqrt(ucdpSummary.deaths);

  const displacement = getCountryDisplacement(displacementRaw, countryCode);
  const totalDisplaced = safeNum(displacement?.totalDisplaced);

  if (wgiMean == null && ucdpSummary.eventCount === 0 && totalDisplaced == null) {
    return {
      score: IMPUTE.recoveryStateContinuity.score,
      coverage: IMPUTE.recoveryStateContinuity.certaintyCoverage,
      observedWeight: 0,
      imputedWeight: 1,
      imputationClass: IMPUTE.recoveryStateContinuity.imputationClass,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }

  return weightedBlend([
    { score: wgiMean == null ? null : normalizeHigherBetter(wgiMean, -2.5, 2.5), weight: 0.5 },
    { score: normalizeLowerBetter(ucdpRawScore, 0, 30), weight: 0.3 },
    {
      score: totalDisplaced == null
        ? null
        : normalizeLowerBetter(Math.log10(Math.max(1, totalDisplaced)), 0, 7),
      weight: 0.2,
    },
  ]);
}

// PR 3 §3.5 point 1: retired permanently from the core score. IEA
// emergency-stockholding rules are defined in days of NET IMPORTS
// and do not bind net exporters by design; the net-importer vs net-
// exporter framings are incomparable, so no global resilience signal
// can be built from this data. Published coverage for the IEA/EIA
// connector sat at 100% imputed at 50 for every country in the
// pre-repair probe (`fuelStockDays` was `source-failure` for every
// ISO in the April 2026 freeze snapshot).
//
// Returning `coverage: 0` + `observedWeight: 0` drops the dimension
// from the `recovery` domain's coverage-weighted mean entirely; the
// remaining recovery dimensions pick up its share of the domain
// weight via auto-redistribution (no explicit weight transfer needed
// — `coverageWeightedMean` in `_shared.ts` already does this).
//
// Does NOT return in PR 4. A new globally-comparable recovery-fuel
// concept (e.g. fuel-import-volatility or strategic-buffer-ratio
// with a unified net-importer/net-exporter definition) could replace
// this scorer in a future PR, but that is out of scope for the
// first-publication repair.
//
// The dimension `fuelStockDays` remains in `RESILIENCE_DIMENSION_ORDER`
// for structural continuity (tests, pillar membership, registry
// shape); retiring the dimension entirely is a PR 4 structural-audit
// concern. The `recoveryFuelStockDays` indicator is re-tagged as
// `tier: 'experimental'` in the registry so the Core coverage gate
// does not consider it active.
// Authoritative registry of dimensions retired from the core score.
// Retired dimensions still appear in `RESILIENCE_DIMENSION_ORDER` for
// structural continuity (tests, pillar membership, registry shape) and
// their scorers still run (returning coverage=0). This set exists so
// downstream confidence/coverage averages (`computeLowConfidence`,
// `computeOverallCoverage`, the widget's `formatResilienceConfidence`)
// can explicitly exclude retired dims — distinct from coverage=0
// dimensions that reflect genuine data sparsity, which must still drag
// the confidence reading down so sparse-data countries stay flagged as
// low-confidence. See `tests/resilience-confidence-averaging.test.mts`
// for the exact semantic this set enables.
//
// Client-side mirror: `RESILIENCE_RETIRED_DIMENSION_IDS` in
// `src/components/resilience-widget-utils.ts`. Kept in lockstep via
// `tests/resilience-retired-dimensions-parity.test.mts`.
export const RESILIENCE_RETIRED_DIMENSIONS: ReadonlySet<ResilienceDimensionId> = new Set([
  'fuelStockDays',
  // PR 2 §3.4 — reserveAdequacy is retired; replaced by the split
  // { liquidReserveAdequacy, sovereignFiscalBuffer }. The legacy
  // scorer returns coverage=0 / imputationClass=null (same shape as
  // scoreFuelStockDays post-retirement) so it's filtered from the
  // confidence/coverage averages via this registry. Kept in
  // RESILIENCE_DIMENSION_ORDER for structural continuity (tests,
  // cached payload shape, registry membership).
  'reserveAdequacy',
]);

// Plan 2026-04-26-001 §U3 — dimensions that are "not-applicable" for
// some countries. When such a dim emits coverage=0, it means
// "construct doesn't apply" rather than "sparse data" — and so it
// should be excluded from the user-facing confidence / coverage means
// for those countries (otherwise advanced economies without SWFs
// would look low-confidence purely because we deliberately don't
// score the SWF construct for them).
//
// Distinction from RESILIENCE_RETIRED_DIMENSIONS: a retired dim is
// excluded for ALL countries (the construct is gone). A
// not-applicable dim is excluded ONLY when its coverage is 0 (i.e.
// the country doesn't carry the construct); when the country DOES
// carry it (positive coverage), the dim contributes normally.
export const RESILIENCE_NOT_APPLICABLE_WHEN_ZERO_COVERAGE: ReadonlySet<ResilienceDimensionId> = new Set([
  'sovereignFiscalBuffer',
]);

// Plan 2026-04-26-001 §U3 (+ review fixup): single-source-of-truth helper
// for the "exclude this dim from user-facing confidence/coverage means"
// decision. Used by `_shared.ts:computeLowConfidence` and
// `computeOverallCoverage` so future construct-decision additions to
// either set update both readers in lockstep — avoiding the
// multi-site-grep trap documented in memory
// `default-value-multi-site-grep-audit`.
//
// **The Path-3 discriminator is `coverage===0 && observedWeight===0 &&
// imputedWeight===0`, NOT just `coverage===0`.** A real SWF country
// can produce `coverage=0` if `weightedBlend` derates `certaintyCoverage`
// to 0 (e.g. `completeness=0` on the manifest entry — Path 2) while
// `observedWeight` stays at 1.0. That case is a DATA OUTAGE on a
// country that DOES carry the construct, not a not-applicable case;
// it MUST drag down user-facing confidence so an operator notices.
// The triple-zero check is the unique fingerprint of the Path-3
// "no manifest entry" return shape.
export function isExcludedFromConfidenceMean(
  dimension: { id: string; coverage: number; observedWeight?: number; imputedWeight?: number },
): boolean {
  const id = dimension.id as ResilienceDimensionId;
  if (RESILIENCE_RETIRED_DIMENSIONS.has(id)) return true;
  if (
    RESILIENCE_NOT_APPLICABLE_WHEN_ZERO_COVERAGE.has(id) &&
    dimension.coverage === 0 &&
    (dimension.observedWeight ?? 0) === 0 &&
    (dimension.imputedWeight ?? 0) === 0
  ) {
    return true;
  }
  return false;
}

export async function scoreFuelStockDays(
  _countryCode: string,
  _reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  // imputationClass is `null` (not 'source-failure') because the dimension
  // is retired by design, not failing at runtime. 'source-failure' renders
  // as "Source down: upstream seeder failed" with a `!` icon in the widget
  // (see IMPUTATION_CLASS_LABELS in src/components/resilience-widget-utils.ts);
  // surfacing that label for every country would manufacture a false outage
  // signal for a deliberate construct retirement. The dimension is excluded
  // from confidence/coverage averages via the `RESILIENCE_RETIRED_DIMENSIONS`
  // registry filter in `computeLowConfidence`, `computeOverallCoverage`, and
  // the widget's `formatResilienceConfidence`. The filter is registry-keyed
  // (not `coverage === 0`) so genuinely sparse-data countries still surface
  // as low-confidence from non-retired coverage=0 dims.
  return {
    score: 50,
    coverage: 0,
    observedWeight: 0,
    imputedWeight: 0,
    imputationClass: null,
    freshness: { lastObservedAtMs: 0, staleness: '' },
  };
}

export const RESILIENCE_DIMENSION_SCORERS: Record<
ResilienceDimensionId,
(countryCode: string, reader?: ResilienceSeedReader) => Promise<ResilienceDimensionScore>
> = {
  macroFiscal: scoreMacroFiscal,
  currencyExternal: scoreCurrencyExternal,
  tradePolicy: scoreTradePolicy,
  financialSystemExposure: scoreFinancialSystemExposure,
  cyberDigital: scoreCyberDigital,
  logisticsSupply: scoreLogisticsSupply,
  infrastructure: scoreInfrastructure,
  energy: scoreEnergy,
  governanceInstitutional: scoreGovernanceInstitutional,
  socialCohesion: scoreSocialCohesion,
  borderSecurity: scoreBorderSecurity,
  informationCognitive: scoreInformationCognitive,
  healthPublicService: scoreHealthPublicService,
  foodWater: scoreFoodWater,
  fiscalSpace: scoreFiscalSpace,
  reserveAdequacy: scoreReserveAdequacy,
  externalDebtCoverage: scoreExternalDebtCoverage,
  importConcentration: scoreImportConcentration,
  stateContinuity: scoreStateContinuity,
  fuelStockDays: scoreFuelStockDays,
  liquidReserveAdequacy: scoreLiquidReserveAdequacy,
  sovereignFiscalBuffer: scoreSovereignFiscalBuffer,
};

export async function scoreAllDimensions(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<Record<ResilienceDimensionId, ResilienceDimensionScore>> {
  const memoizedReader = createMemoizedSeedReader(reader);
  const [entries, freshnessMap, failedDatasets] = await Promise.all([
    Promise.all(
      RESILIENCE_DIMENSION_ORDER.map(async (dimensionId) => {
        try {
          const score = await RESILIENCE_DIMENSION_SCORERS[dimensionId](countryCode, memoizedReader);
          return [dimensionId, score] as const;
        } catch (err) {
          // ResilienceConfigurationError (e.g. v2 energy flag flipped without
          // seeds) surfaces here. Fail-closed per dimension, not per country:
          // the country keeps scoring other dims normally, and this dim
          // carries imputationClass='source-failure' + coverage=0 so the
          // consumer sees the gap explicitly. The T1.7 decoration pass below
          // reads this shape and leaves it alone; no double-tagging.
          if (err instanceof ResilienceConfigurationError) {
            console.warn(
              `[Resilience] configuration-error dim=${dimensionId} country=${countryCode} missing=${err.missingKeys.join(',')} — routing to source-failure`,
            );
            // Match weightedBlend's empty-data shape (score=0 NOT null
            // because the type declares score: number; coverage=0 marks
            // "no data") + explicit source-failure tag so the T1.7
            // decoration pass downstream recognises this as misconfiguration
            // rather than IMPUTE. Freshness decorated by the caller
            // alongside the other scores.
            const sourceFailureScore: ResilienceDimensionScore = {
              score: 0,
              coverage: 0,
              observedWeight: 0,
              imputedWeight: 1,
              imputationClass: 'source-failure',
              freshness: { lastObservedAtMs: 0, staleness: '' },
            };
            return [dimensionId, sourceFailureScore] as const;
          }
          // Any other error is a bug, not misconfiguration — let it surface.
          throw err;
        }
      }),
    ),
    // T1.5 propagation pass: aggregate freshness at the caller level so
    // the dimension scorers stay mechanical. We share the memoized
    // reader so each `seed-meta:<key>` read lands in the same cache as
    // the scorers' source reads (though seed-meta keys don't overlap
    // with the scorer keys in practice, the shared reader is cheap).
    readFreshnessMap(memoizedReader),
    readFailedDatasets(memoizedReader),
  ]);
  const scores = Object.fromEntries(entries) as Record<ResilienceDimensionId, ResilienceDimensionScore>;

  // T1.5 freshness decoration pass. Attach dimension-level freshness
  // derived from the aggregated seed-meta map. Runs before the T1.7
  // source-failure pass because source-failure only touches
  // imputationClass and does not interact with freshness.
  for (const dimensionId of RESILIENCE_DIMENSION_ORDER) {
    scores[dimensionId] = {
      ...scores[dimensionId],
      freshness: classifyDimensionFreshness(dimensionId, freshnessMap),
    };
  }

  // T1.7 source-failure wiring. When the resilience-static seed reports
  // failed adapter fetches in its meta, any dimension that consumes that
  // adapter AND is already imputed (observedWeight === 0, imputationClass
  // non-null) gets re-tagged from the table default (stable-absence /
  // unmonitored) to source-failure. Real-data dimensions are untouched:
  // a seed adapter failing does not invalidate a country that was served
  // from the prior-snapshot recovery path.
  if (failedDatasets.length > 0) {
    const affected = failedDimensionsFromDatasets(failedDatasets);
    if (affected.size > 0) {
      // Single info log per request so ops can see which adapters went
      // down without having to dump Redis. The country code is included
      // because scoreAllDimensions runs per-country; a flood of these
      // during a failed-seed window is the expected signal.
      console.info(
        `[Resilience] source-failure decoration country=${countryCode} failedDatasets=${failedDatasets.join(',')} affectedDimensions=${[...affected].join(',')}`,
      );
      for (const dimId of affected) {
        const current = scores[dimId];
        // Only re-tag imputed dimensions. Dimensions with any observed
        // weight keep their existing null class (which is the correct
        // semantics: the seed failing did not prevent us from producing
        // a real-data score for this country).
        if (current != null && current.imputationClass != null) {
          scores[dimId] = { ...current, imputationClass: 'source-failure' };
        }
      }
    }
  }

  return scores;
}

export function getResilienceDomainWeight(domainId: ResilienceDomainId): number {
  return RESILIENCE_DOMAIN_WEIGHTS[domainId];
}
