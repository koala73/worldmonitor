import countryNames from '../../../../shared/country-names.json';
import iso2ToIso3Json from '../../../../shared/iso2-to-iso3.json';
import wgiIndicatorKeys from '../../../../shared/wgi-indicator-keys.json';
import { normalizeCountryToken } from '../../../_shared/country-token';
import { getCachedEnvelopeJson, getCachedJson, readCachedJson } from '../../../_shared/redis';
import { unwrapEnvelope } from '../../../_shared/seed-envelope';
import { classifyDimensionFreshness, readFreshnessMap, resolveSeedMetaKey } from './_dimension-freshness';
import { getLanguageCoverageFactor } from './_language-coverage';
import { MACRO_FISCAL_INDICATOR_WEIGHTS } from './_macro-fiscal-weights';
import { isInRankableUniverse } from './_rankable-universe';
import {
  failedDimensionsFromDatasets,
  readFailedDatasets,
  readStandaloneSourceFailureDimensions,
  STANDALONE_SOURCE_META_MAX_STALE_MIN,
} from './_source-failure';
import {
  applyCanadaNationalOverlay,
  RESILIENCE_BOC_VALET_KEY,
  RESILIENCE_STATCAN_WDS_KEY,
  statcanOverlayUsed,
} from './_canada-national-overlay';

export type ResilienceDimensionId =
  | 'macroFiscal'
  | 'currencyExternal'
  | 'tradePolicy'
  | 'financialSystemExposure'  // plan 2026-04-25-004 Phase 2: structural sanctions vulnerability via BIS CBS + WB IDS + FATF
  | 'cyberDigital'
  | 'logisticsSupply'
  | 'infrastructure'
  | 'energy'
  | 'governanceInstitutional'
  | 'socialCohesion'
  | 'borderSecurity'
  | 'informationCognitive'
  | 'education'             // female upper-secondary attainment (WB SE.SEC.CUAT.UP.FE.ZS)
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

export interface WeightedMetric {
  score: number | null;
  weight: number;
  // A known malformed reading can preserve its design weight with a
  // conservative fallback instead of letting weightedBlend renormalize the
  // missing weight onto unrelated survivors. Genuine absence leaves this
  // unset and keeps the existing coverage-weighted drop behavior.
  fallbackScore?: number;
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
  // #3787 follow-up: design-time weight, used as the coverage-computation
  // denominator share when the runtime `weight` has been attenuated by a
  // confidence factor (e.g. langFactor in scoreInformationCognitive). Without
  // this, attenuating `weight` shrinks the coverage denominator alongside the
  // numerator and the dimension reports a HIGHER coverage for sparse-coverage
  // countries — the inverse of the intended semantic. Omit when `weight` is
  // already the nominal design-time value (default = weight).
  nominalWeight?: number;
}

function hasFiniteMetricScore(metric: WeightedMetric): metric is WeightedMetric & { score: number } {
  return Number.isFinite(metric.score);
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
//     Currently emitted by sovereignFiscalBuffer when the sovereign-wealth
//     manifest is present and the country has no applicable SWF entry.
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
  // #6459 — financialSystemExposure Component 1 for jurisdictions that the
  // World Bank country catalog explicitly classifies as outside its borrower
  // programs (`lendingType=LNX`). That means no reported short-term external
  // commercial debt to roll over, so the slot is
  // `not-applicable` rather than an unknown; 0.3 certainty keeps the
  // dimension's coverage honest about the reading being inferred. Before this
  // entry the slot was dropped and its 0.35 weight renormalized onto the
  // punitive cross-border-claims leg. See `resolveNonDrsDebtImputation`.
  finSysExposureNonDrsShortTermDebt: { score: 75, certaintyCoverage: 0.3, imputationClass: 'not-applicable' },
  // Plan 2026-04-26-001 §U2 — gated GPI-only impute for socialCohesion.
  // This entry fires ONLY when the dimension is operating in degraded
  // GPI-only mode (i.e. country is absent from the displacement registry).
  // It pulls tiny peaceful states (TV, PW, NR, MC) down from a near-perfect
  // GPI-only score. Zero-unrest rows in that same GPI-only mode now use
  // curated_list_absent (50/0.3) because unrest:events:v1 is not
  // comprehensive; countries WITH observed displacement and zero unrest
  // events still use `unhcrDisplacement.score` (85).
  socialCohesionGpiOnlyDisplacement: { score: 70, certaintyCoverage: 0.6, imputationClass: 'stable-absence' },
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
  status?: string;
}

interface CyberThreat {
  country?: string;
  severity?: string;
  firstSeenAt?: number | string;
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
export const RESILIENCE_IMF_LABOR_KEY = 'economic:imf:labor:v1';
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
const RESILIENCE_WB_EXTERNAL_DEBT_SCHEMA_VERSION = 2;
const RESILIENCE_BIS_LBS_KEY = 'economic:bis-lbs:v1';
const RESILIENCE_FATF_LISTING_KEY = 'economic:fatf-listing:v1';
const RESILIENCE_CYBER_KEY = 'cyber:threats:v2';
const RESILIENCE_OUTAGES_KEY = 'infra:outages:v1';
const RESILIENCE_GPS_KEY = 'intelligence:gpsjam:v2';
// Issue #3971: bound the severity weight any one cyber discovery day can
// contribute before `normalizeLowerBetter(weightedCount, 0, 25)`. Issue #4008
// later made firstSeenAt stable enough for #4009's discovery-day smoothing: a
// one-day burst now decays by age, while sustained multi-day pressure can still
// reach the cap. Exported so tests pin behaviour to constants, not literals.
export const CYBER_SNAPSHOT_WEIGHT_CAP = 8;
export const CYBER_DISCOVERY_HALF_LIFE_DAYS = 1;
const RESILIENCE_UNREST_KEY = 'unrest:events:v1';
const RESILIENCE_UCDP_KEY = 'conflict:ucdp-events:v1';
const RESILIENCE_DISPLACEMENT_PREFIX = 'displacement:summary:v1';
const RESILIENCE_SOCIAL_VELOCITY_KEY = 'intelligence:social:reddit:v1';
const RESILIENCE_NEWS_THREAT_SUMMARY_KEY = 'news:threat:summary:v1';
const RESILIENCE_ENERGY_PRICES_KEY = 'economic:energy:v1:all';
const RESILIENCE_ENERGY_MIX_KEY_PREFIX = 'energy:mix:v1:';

async function readDisplacementSummaryWithFallback(
  reader: ResilienceSeedReader,
): Promise<unknown | null> {
  const currentYear = new Date().getFullYear();
  const current = await reader(`${RESILIENCE_DISPLACEMENT_PREFIX}:${currentYear}`);
  if (current != null) return current;
  return reader(`${RESILIENCE_DISPLACEMENT_PREFIX}:${currentYear - 1}`);
}

const RESILIENCE_RECOVERY_FISCAL_SPACE_KEY = 'resilience:recovery:fiscal-space:v1';
const RESILIENCE_RECOVERY_RESERVE_ADEQUACY_KEY = 'resilience:recovery:reserve-adequacy:v1';
const RESILIENCE_RECOVERY_EXTERNAL_DEBT_KEY = 'resilience:recovery:external-debt:v1';
const RESILIENCE_RECOVERY_IMPORT_HHI_KEY = 'resilience:recovery:import-hhi:v1';
// Re-export-share map (Comtrade-backed, written by
// scripts/seed-recovery-reexport-share.mjs from PR #3385). Per-country
// shape: { reexportShareOfImports: number ∈ [0,1), year, ... }. Today
// covers AE + PA — the two designated re-export hubs. Consumed by
// scoreSovereignFiscalBuffer's seeder (net-imports denominator, PR
// #3380) AND by scoreLiquidReserveAdequacy here at score time so both
// reserve-buffer dimensions use the same hub-corrected denominator.
// Countries absent from the map score against the raw WB
// FI.RES.TOTL.MO value (status-quo behaviour for non-hubs).
const RESILIENCE_RECOVERY_REEXPORT_SHARE_KEY = 'resilience:recovery:reexport-share:v1';
// PR 2 §3.4 — new SWF seed populated by scripts/seed-sovereign-wealth.mjs
// (landed in #3305, wired into the resilience-recovery Railway bundle in
// #3319). Per-country shape: { funds: [...], totalEffectiveMonths,
// annualImports, expectedFunds, matchedFunds, completeness }. Countries
// not in the manifest are absent from the payload; scorer Path 3 treats
// that as structurally not-applicable, distinct from the missing-seed
// IMPUTE fallback below.
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
// production proves these seeds are present and healthy, the repo
// default remains legacy. If an operator flips v2 while any required
// seed is absent, scoreEnergy fails closed with
// ResilienceConfigurationError instead of silently emitting imputed
// energy scores.
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
  // 0.5 mirrors the financialSystemExposure precedent for a new dimension:
  // it caps education at ~11% of the social-governance domain rather than the
  // ~20% an equal-weight entry would take. Deliberately conservative for a
  // first ship; raising it later is a separate, evidenced decision.
  education: 0.5,
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
  education: 'social-governance',
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
  'education',
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
  // Attainment of the 25+ population is a structural stock, not a live shock
  // signal — it moves on a survey cadence, not a news cycle.
  education: 'baseline',
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

export function roundScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(clamp(value, 0, 100));
}

function roundCoverage(value: number): number {
  return Number(clamp(value, 0, 1).toFixed(2));
}

function safeNum(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function sqrtCount(value: number): number {
  return Math.sqrt(Math.max(0, Number.isFinite(value) ? value : 0));
}

export function normalizeLowerBetter(value: number, best: number, worst: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  if (worst <= best) return 50;
  const ratio = (worst - value) / (worst - best);
  return roundScore(ratio * 100);
}

export function normalizeHigherBetter(value: number, worst: number, best: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  if (best <= worst) return 50;
  const ratio = (value - worst) / (best - worst);
  return roundScore(ratio * 100);
}

// Education attainment transform (female upper-secondary, 25+).
// See the "Education" section of docs/methodology/country-resilience-index.mdx
// for the construct.
//
// Two segments with a slope drop at the bend. Decreasing slope is concave,
// which is what the construct contract asks for on a development-adjacent
// indicator — the score must stop paying for attainment past the point where
// it stops buying shock absorption.
//
// It is deliberately NOT a log or logistic squash. The measured distribution
// does not saturate: median 50.0 across the 181 covered countries, near-uniform
// deciles, only 1.7% above 95% (adult literacy, by contrast, puts 42% there).
// Squashing would erase discrimination in the 20-80 band that holds two-thirds
// of the universe. The bend affects 22 of 181 countries.
//
// Goalposts are fixed 0 and 100, never observed min/max. Eight of the top ten
// are post-Soviet states reporting near-universal legacy completion, so an
// observed-max anchor would let Turkmenistan define a perfect score; a
// percentile lower anchor would tie 18 Sahel and Horn countries at the floor,
// which is exactly the band this series was chosen to resolve.
export const EDUCATION_BEND = 85;
export const EDUCATION_BEND_SCORE = 92;

export function normalizeEducationAttainment(value: unknown): number | null {
  // `value == null` must be checked before coercion: Number(null) === 0 is
  // finite, and 0 is a plausible reading here, so a null would silently score
  // an unsurveyed country as the worst on earth instead of dropping its slot.
  if (value == null) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;

  const pct = clamp(numeric, 0, 100);
  if (pct <= EDUCATION_BEND) {
    // Linear across the band where countries actually sit.
    return roundScore((pct / EDUCATION_BEND) * EDUCATION_BEND_SCORE);
  }
  // Shallower slope above the bend: the remaining 15 points of attainment buy
  // only the remaining 8 points of score.
  const topBandFraction = (pct - EDUCATION_BEND) / (100 - EDUCATION_BEND);
  return roundScore(EDUCATION_BEND_SCORE + topBandFraction * (100 - EDUCATION_BEND_SCORE));
}

export function scoreInflationStability(inflationPct: number): number {
  if (!Number.isFinite(inflationPct)) return 0;
  if (inflationPct >= 1 && inflationPct <= 3) return 100;
  if (inflationPct <= -5) return 0;
  if (inflationPct < 1) return normalizeHigherBetter(inflationPct, -5, 1);
  return normalizeLowerBetter(Math.min(inflationPct, 50), 3, 50);
}

// U-shaped band normalization. Used by `financialSystemExposure` Component 2
// (BIS CBS cross-border claims as % of GDP). Both extremes are bad — too
// little integration suggests financial isolation (sanctions-target
// jurisdictions; thin correspondent-banking access), too much suggests
// over-exposure to Western-bank pulls (Iceland-2008 territory). The score
// peaks in the "healthy diversified financial system" middle band.
//
// Plan 2026-04-25-004 Phase 2 § Component 2 score shape — re-anchored
// for piecewise-CONTINUOUS transitions per Greptile P1 catch (PR #3407
// review 2026-04-25). The original draft had a 30-point cliff at the 25%
// boundary (sweet spot ended at 100, over-exposed started at 70) and a
// 5-point jump at 5%. Cliffs in piecewise-linear scorers cause ranking
// instability for countries near band edges — a 24.9% reading scores
// dramatically different than 25.1%. Endpoints share values across
// adjacent segments so the function is monotone-then-monotone with no
// discontinuities.
//
// #6459 re-anchoring — the ASYMMETRY was inverting the ranking. The
// original band floored ZERO cross-border integration at 60 while decaying
// over-integration all the way to 0 at 120% of GDP. 0% claims is the
// signature of a sanctions-severed banking system, so the shape scored
// severance above integration by construction: Russia's 1.45% of GDP took
// 64 while Luxembourg's 1041% took 0. The two legs are now sized so that
// isolation is the worse extreme:
//
//   0% ≤ value < 5%      → 30-75  (isolation → low integration; slope +9/pct)
//   5% ≤ value ≤ 25%     → 75-100 (sweet spot; slope +1.25/pct, unchanged)
//   25% < value ≤ 60%    → 100-45 (over-exposed; slope −1.571/pct)
//   value > 60%          → 45 → 35 at 80%, then flat (Iceland-2008 floor)
//
// The invariants, which `tests/resilience-financial-system-exposure.test.mts`
// pins directly rather than inferring from sample points:
//   - the isolation floor (value 0) is ≤ 40 and strictly below every
//     sweet-spot value, so severance can never out-score integration;
//   - the over-exposure leg floors at 35 — above the isolation floor,
//     because an over-banked entrepôt still has working correspondent
//     access that a severed state does not;
//   - every segment boundary is continuous.
//
// Exported for direct testing. The whole lesson of #6459 is that a
// calibration claim nobody can execute is not a calibration claim, and these
// invariants are not observable through the blended dimension score: any
// fixture that varies the band also moves the debt-slot imputation, so a
// test driven through `scoreFinancialSystemExposure` alone measures the
// blend rather than the band shape.
export const FIN_SYS_BAND_ISOLATION_FLOOR = 30;
export const FIN_SYS_BAND_OVEREXPOSED_FLOOR = 35;
// The band SCORE at which the premium region begins — the value
// `normalizeBandLowerBetter` returns, not a claims percentage. The band reaches
// it twice: rising off the low-integration leg at 5% of GDP and falling back
// through it on the over-exposure descent near 40.6%. Everything SCORING at or
// below it is a pure level reading the diversity conditioning must not touch;
// everything above is premium, on either leg.
export const FIN_SYS_BAND_PREMIUM_FLOOR = 75;

export function normalizeBandLowerBetter(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 50;
  if (value < 5) {
    // Isolation → low integration: 0% → 30, 5% → 75 (continuous to sweet spot).
    return roundScore(FIN_SYS_BAND_ISOLATION_FLOOR + (value / 5) * (75 - FIN_SYS_BAND_ISOLATION_FLOOR));
  }
  if (value <= 25) {
    // Sweet spot: 5% → 75, 25% → 100.
    return roundScore(75 + ((value - 5) / 20) * 25);
  }
  if (value <= 60) {
    // Over-exposed: 25% → 100 (continuous from sweet-spot peak), 60% → 45.
    return roundScore(100 - ((value - 25) / 35) * 55);
  }
  // Iceland-2008 territory: 60% → 45 (continuous), drops 0.5pt per pct down
  // to the over-exposure floor at 80% and stays there. It does NOT decay to
  // 0: an entrepôt balance sheet is a different failure mode from severance,
  // and letting it fall below the isolation floor is what inverted the band.
  return roundScore(Math.max(FIN_SYS_BAND_OVEREXPOSED_FLOOR, 45 - (value - 60) * 0.5));
}

// The band's premium region (raw band > 75, i.e. claims in (5.4%, 40.59%] of
// GDP — the ROUNDED band's actual crossings, since 75.5 is where it rounds
// above 75; the unrounded 5%/40.9% figures pull in two countries that round to
// exactly 75 and earn no premium, per the derivation in
// docs/methodology/financial-system-exposure.md) is documented as "healthy
// DIVERSIFIED financial system" —
// but `normalizeBandLowerBetter` reads only the integration LEVEL. On the
// 2026-08-12 production payload, 29 of the 77 premium-region countries held
// that premium through ≤ 2 reporting parents: Bosnia took a 90 band on ONE
// parent, Albania a 91 on two (its parents map is dominated by one Austrian
// and one Italian group). Moderate integration through two doors is not a
// diversified system — it is the 1997-Thailand / 2011-Greek-deleveraging
// withdrawal channel, and the construct's own Component 4 scores that same
// fact 11/100. Level and breadth are not independent: the level's meaning
// flips with concentration, which is the same cross-component insight behind
// `isMarketAccessConstrainedDebtSignal` (#6461).
//
// So the premium above the 75 low-integration boundary is scaled by the
// construct's OWN redundancy transform — `normalizeHigherBetter(parents,
// 1, 10)`, verbatim the Component 4 scale, no new constants. Everything at
// or below 75 (both floors, the isolation leg, the deep over-exposure legs)
// is untouched, so every #6459 band invariant survives:
//
//   conditioned = min(band, 75) + max(0, band − 75) × redundancy/100
//
//   - parents ≥ 10 → full premium (identical to the raw band everywhere);
//   - parents ≤ 1  → no premium (band caps at the 75 boundary value);
//   - continuous in claims for any fixed parent count (a scaled continuous
//     premium added to a continuous base), monotone in parents;
//   - a non-finite or absent `parentCount` earns NO premium: absence of
//     diversity evidence is not diversity. Non-finite is handled explicitly
//     rather than left to arithmetic — `normalizeHigherBetter` returns NaN for
//     it, and `roundScore(NaN)` is 0, which would put a premium-region country
//     BELOW the isolation floor and invert the very ranking this function
//     exists to fix. The sibling `normalizeBandLowerBetter` neutralises
//     malformed input the same way.
//
// Capping the band is necessary but not sufficient to make a `parentCount`
// parse regression fail closed. The reader marks a present-but-invalid count
// as malformed, and the blend retains that slot with a conservative fallback
// score of zero. A genuinely absent count remains null without a fallback, so
// it keeps the existing absence and coverage semantics.
//
// This distinction matters because `weightedBlend` otherwise renormalises a
// missing Component 4 slot onto the survivors. For a country whose debt and
// FATF legs read high, that can raise the published score. The generic blend
// now supports an explicit fallback for this known-corrupt-input case; the
// conditioning function only supplies the bounded band value and its signal.
//
// Known conservative edge: parentCount counts only parents above 1% of GDP,
// so a country integrated through many sub-threshold parents forfeits a
// premium its true breadth might merit. No production row currently has
// premium-region claims with parentCount 0. The forfeit is bounded by the
// premium itself: ≤ 25 points of band, and ≤ 7.5 of dimension ONLY while all
// four slots resolve. `weightedBlend` renormalises the band's 0.30 onto the
// surviving weight, so the dimension cost grows as siblings drop — 8.8 points
// at coverage 0.85 (Component 4 gone), 11.5 at 0.65 (debt gone), 15 at 0.50.
// It reaches ~14 band points at the worst arithmetically reachable case — 16
// enumerated reporting parents each sitting just under the 1%-of-GDP counting
// threshold, summing to ~16% of GDP for a raw band of 89.
export function normalizeDiversityConditionedBand(
  claimsPctGdp: number,
  parentCount: number | null,
): number {
  const raw = normalizeBandLowerBetter(claimsPctGdp);
  if (raw <= FIN_SYS_BAND_PREMIUM_FLOOR) return raw;
  const redundancy = parentCount != null && Number.isFinite(parentCount)
    ? normalizeHigherBetter(parentCount, 1, 10)
    : 0;
  return roundScore(
    FIN_SYS_BAND_PREMIUM_FLOOR + (raw - FIN_SYS_BAND_PREMIUM_FLOOR) * (redundancy / 100),
  );
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

const MINUTE_MS = 60 * 1000;
const WGI_INDICATOR_KEYS: readonly string[] = wgiIndicatorKeys;

export function weightedBlend(metrics: WeightedMetric[]): ResilienceDimensionScore {
  const totalWeight = metrics.reduce((sum, metric) => sum + metric.weight, 0);
  const available = metrics.filter(hasFiniteMetricScore);
  const availableWeight = available.reduce((sum, metric) => sum + metric.weight, 0);
  const fallback = metrics.filter((metric) => !hasFiniteMetricScore(metric) && Number.isFinite(metric.fallbackScore));
  const fallbackWeight = fallback.reduce((sum, metric) => sum + metric.weight, 0);
  const scoringWeight = availableWeight + fallbackWeight;

  if (!scoringWeight || !totalWeight) {
    return { score: 0, coverage: 0, observedWeight: 0, imputedWeight: 0, imputationClass: null, freshness: { lastObservedAtMs: 0, staleness: '' } };
  }

  // A malformed slot with an explicit fallback keeps its weight in the
  // denominator. This prevents a low leg from disappearing and raising the
  // published score, while ordinary absence still renormalizes as before.
  const weightedScore = (
    available.reduce((sum, metric) => sum + metric.score * metric.weight, 0)
    + fallback.reduce((sum, metric) => sum + (metric.fallbackScore ?? 0) * metric.weight, 0)
  ) / scoringWeight;

  // Coverage: weighted average of certainty per metric, computed against the
  // NOMINAL design-time weight rather than the runtime weight. Real data → 1.0;
  // imputed (certaintyCoverage set) → partial; absent (null, no imputation) → 0.
  //
  // The nominalWeight vs weight split matters whenever a caller attenuates
  // `weight` by a confidence factor (e.g. scoreInformationCognitive scales
  // velocity/threat sub-indicator weights by langFactor). If coverage were
  // computed against the attenuated weights, the denominator would shrink
  // alongside the numerator and sparse-coverage countries would report a
  // HIGHER coverage than primary-coverage ones — the inverse of the intended
  // semantic (#3787). Using nominalWeight keeps coverage as a stable
  // measurement of "what fraction of designed signal we observed", independent
  // of the confidence weighting applied to the score.
  const totalNominalWeight = metrics.reduce((sum, metric) => sum + (metric.nominalWeight ?? metric.weight), 0);
  const weightedCertainty = metrics.reduce((sum, metric) => {
    const certainty = metric.certaintyCoverage ?? (hasFiniteMetricScore(metric) ? 1 : 0);
    const nominalWeight = metric.nominalWeight ?? metric.weight;
    return sum + nominalWeight * certainty;
  }, 0) / totalNominalWeight;

  // Track provenance: observed (real data) vs imputed weight.
  // Metrics with imputed=true → imputed (synthetic absence-based scores).
  // All other non-null metrics → observed (including proxy data with certaintyCoverage < 1).
  // Metrics with null score → neither (excluded from both).
  let observedWeight = 0;
  let imputedWeight = 0;
  const classWeights = new Map<ImputationClass, number>();
  for (const metric of metrics) {
    if (!hasFiniteMetricScore(metric)) continue;
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

function isSeedMetaPreflightUnhealthy(sourceKey: string, meta: unknown, nowMs = Date.now()): boolean {
  if (!meta || typeof meta !== 'object') return true;
  const status = (meta as { status?: unknown }).status;
  if (Object.prototype.hasOwnProperty.call(meta, 'status') && status !== 'ok') return true;
  const fetchedAt = Number((meta as { fetchedAt?: unknown }).fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return true;
  const maxStaleMin = STANDALONE_SOURCE_META_MAX_STALE_MIN[resolveSeedMetaKey(sourceKey)];
  return typeof maxStaleMin === 'number' && (nowMs - fetchedAt) > maxStaleMin * MINUTE_MS;
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

// Per-alias disambiguation. The previous AMBIGUOUS_ALIASES blocklist
// silently zeroed Reddit velocity for any country whose only alias was
// ambiguous (Niger, Georgia, Guinea, Samoa, Sudan, Dominica — see #3744).
// Replaced with predicates that accept the match only when surrounding
// context rules out the colliding token. Aliases not listed here are
// matched unconditionally.
//
// Markers preferred over name forms because COUNTRY_NAME_ALIASES is built
// from shared/country-names.json and may not contain every directional
// variant.
const GEORGIA_COUNTRY_MARKERS = [
  'tbilisi', 'georgian', 'abkhazia', 'ossetia', 'caucasus',
  'saakashvili', 'ivanishvili', 'batumi', 'kutaisi',
];

type DisambiguationPredicate = (paddedInput: string) => boolean;

const DISAMBIGUATION_RULES = new Map<string, DisambiguationPredicate>([
  ['niger', (s) => hasBareToken(s, 'niger', {
    notFollowedBy: ['river', 'delta', 'state', 'basin'],
  })],
  ['sudan', (s) => hasBareToken(s, 'sudan', { notPrecededBy: ['south'] })],
  ['samoa', (s) => hasBareToken(s, 'samoa', { notPrecededBy: ['american'] })],
  ['guinea', (s) => hasBareToken(s, 'guinea', {
    notPrecededBy: ['equatorial', 'new'],
    notFollowedBy: ['bissau'],
  })],
  ['congo', (s) => hasBareToken(s, 'congo', {
    notPrecededBy: ['dr', 'drc', 'democratic', 'kinshasa'],
    notFollowedBy: ['kinshasa', 'dem'],
  })],
  ['georgia', (s) => GEORGIA_COUNTRY_MARKERS.some((m) => s.includes(` ${m} `))],
]);

function hasBareToken(
  paddedInput: string,
  token: string,
  opts: { notPrecededBy?: string[]; notFollowedBy?: string[] },
): boolean {
  const target = ` ${token} `;
  let idx = paddedInput.indexOf(target);
  while (idx !== -1) {
    let ok = true;
    if (opts.notPrecededBy) {
      const beforeStart = paddedInput.lastIndexOf(' ', idx - 1);
      const beforeWord = paddedInput.slice(beforeStart + 1, idx);
      if (opts.notPrecededBy.includes(beforeWord)) ok = false;
    }
    if (ok && opts.notFollowedBy) {
      const afterStart = idx + target.length - 1;
      const afterEnd = paddedInput.indexOf(' ', afterStart + 1);
      const afterWord = paddedInput.slice(afterStart + 1, afterEnd === -1 ? paddedInput.length : afterEnd);
      if (opts.notFollowedBy.includes(afterWord)) ok = false;
    }
    if (ok) return true;
    idx = paddedInput.indexOf(target, idx + 1);
  }
  return false;
}

export function matchesCountryText(value: unknown, countryCode: string): boolean {
  const normalized = normalizeCountryToken(value);
  if (!normalized) return false;
  const padded = ` ${normalized} `;
  for (const alias of COUNTRY_NAME_ALIASES.get(countryCode.toUpperCase()) ?? []) {
    if (!padded.includes(` ${alias} `)) continue;
    const rule = DISAMBIGUATION_RULES.get(alias);
    if (rule && !rule(padded)) continue;
    return true;
  }
  return false;
}

// dateToSortableNumber() removed in PR 3 §3.5: only the now-removed
// getCountryBisExchangeRates() used it.

// `seed-meta:` reads gate FAIL-CLOSED preflights, so for them a read ERROR and
// a genuine MISS must not be the same answer. `getCachedJson` collapses both to
// `null` (see `readCachedJson`, which does distinguish them), and a preflight
// reading that `null` declares the producer dead.
//
// #6484: within 25 minutes of the education activation deploying, that turned a
// 1500 ms Upstash timeout under the concurrent ranking warm into
// `source-failure` for 196/196 countries — published, and cached for six hours,
// while the seeder was healthy and the payload was present.
//
// Retrying only the ERROR case keeps the alarm honest: a genuinely absent
// seed-meta still returns `null` on the first read and still fails closed,
// which is the signal that a Railway bundle is not publishing.
const SEED_META_READ_ATTEMPTS = 3;
const SEED_META_RETRY_BASE_MS = 120;

function isSeedMetaKey(key: string): boolean {
  return key.startsWith('seed-meta:');
}

async function readSeedMetaResilient(key: string): Promise<unknown | null> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < SEED_META_READ_ATTEMPTS; attempt++) {
    const read = await readCachedJson(key, true);
    if (read.status === 'hit') return read.value;
    // A genuine miss is information, not a failure — return it immediately so
    // a dead producer still fails closed on the first attempt.
    if (read.status === 'miss') return null;
    lastError = read.error;
    if (attempt < SEED_META_READ_ATTEMPTS - 1) {
      await new Promise((resolve) => { setTimeout(resolve, SEED_META_RETRY_BASE_MS * 2 ** attempt); });
    }
  }
  // Still failing after retries. Return null so behaviour matches today's
  // fail-closed path rather than introducing a new throwing mode under load,
  // but say so — an operator seeing source-failure needs to know whether the
  // producer is dead or Redis was unreachable.
  console.warn(
    `[Resilience] seed-meta read failed after ${SEED_META_READ_ATTEMPTS} attempts key=${key} `
    + `error=${lastError instanceof Error ? lastError.message : String(lastError)} — `
    + 'downstream preflights will fail closed; this is a READ failure, not proof the producer is dead',
  );
  return null;
}

async function defaultSeedReader(key: string): Promise<unknown | null> {
  if (isSeedMetaKey(key)) return readSeedMetaResilient(key);
  // Preserve the contract envelope for WB debt so its numeric schemaVersion
  // remains available to the fail-closed scorer. Other seed readers retain
  // the established bare-data behavior.
  return key === RESILIENCE_WB_EXTERNAL_DEBT_KEY
    ? getCachedEnvelopeJson(key, true)
    : getCachedJson(key, true);
}

interface MemoizedSeedReaderOptions {
  retryJoinedSeedMetaNull?: boolean;
}

export function createMemoizedSeedReader(
  reader: ResilienceSeedReader = defaultSeedReader,
  options: MemoizedSeedReaderOptions = {},
): ResilienceSeedReader {
  const cache = new Map<string, Promise<unknown | null>>();
  const seedMetaRecoveryReads = new Map<string, Promise<unknown | null>>();
  return async (key: string) => {
    let pendingRead = cache.get(key);
    const joinedExistingRead = pendingRead != null;
    if (!pendingRead) {
      pendingRead = Promise.resolve(reader(key));
      cache.set(key, pendingRead);
      pendingRead.catch(() => {
        if (cache.get(key) === pendingRead) cache.delete(key);
      });
      // Do NOT retain a null seed-meta result. This memo is shared across every
      // country in a ranking build, so caching one unresolved read propagates it
      // to all 196 — the #6484 amplifier.
      if (isSeedMetaKey(key)) {
        pendingRead.then((value) => {
          if (value == null && cache.get(key) === pendingRead) cache.delete(key);
        }, () => {});
      }
    }
    const value = await pendingRead;
    // #6510: eviction after resolution is too late for callers that already
    // joined the same in-flight promise. If its retries exhaust, let only the
    // creator observe that fail-closed null; joined countries share one recovery
    // read instead of turning one transient failure into either a batch-wide
    // outage or a 195-request retry herd. A genuine missing producer costs one
    // extra read for the batch and stays fail-closed for every caller.
    if (options.retryJoinedSeedMetaNull && joinedExistingRead && isSeedMetaKey(key) && value == null) {
      let recoveryRead = seedMetaRecoveryReads.get(key);
      if (!recoveryRead) {
        recoveryRead = Promise.resolve(reader(key));
        seedMetaRecoveryReads.set(key, recoveryRead);
        cache.set(key, recoveryRead);
        recoveryRead.then((recoveredValue) => {
          if (seedMetaRecoveryReads.get(key) === recoveryRead) seedMetaRecoveryReads.delete(key);
          if (recoveredValue == null && cache.get(key) === recoveryRead) cache.delete(key);
        }, () => {
          if (seedMetaRecoveryReads.get(key) === recoveryRead) seedMetaRecoveryReads.delete(key);
          if (cache.get(key) === recoveryRead) cache.delete(key);
        });
      }
      return recoveryRead;
    }
    return value;
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
  return WGI_INDICATOR_KEYS
    .map((key) => safeNum(indicators[key]?.value))
    .filter((value): value is number => value != null);
}

function getStaticWgiRows(record: ResilienceStaticCountryRecord | null): WeightedMetric[] {
  const indicators = record?.wgi?.indicators ?? {};
  return WGI_INDICATOR_KEYS.map((key) => {
    const value = safeNum(indicators[key]?.value);
    return {
      score: value == null ? null : normalizeHigherBetter(value, -2.5, 2.5),
      weight: 1,
    };
  });
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

/**
 * Plan 2026-04-26-002 §U7 (PR 6) — population reader for the headline-
 * eligible gate. Differs from `readPopulationMillions` in two ways:
 *
 *   1. Returns `null` when no IMF labor entry exists for the country
 *      (instead of the §U6 0.5M default). The gate's "population >= 200k"
 *      branch needs to distinguish "country with known small population"
 *      from "country with unknown population"; defaulting to 0.5M (above
 *      the 200k threshold) would incorrectly admit every unknown-pop
 *      country to the headline ranking.
 *
 *   2. Does NOT apply the §U6 0.5M tiny-state floor. The §U6 floor is
 *      a per-capita-math safety device (prevent /0 and amplification);
 *      the headline gate needs the REAL population to decide eligibility.
 *      Tuvalu's actual headcount of ~10k is below 200k → not eligible
 *      via the population branch (it can still pass via the coverage>=0.85
 *      branch if data quality is high enough).
 *
 * Defensive raw-persons detection mirrors `readPopulationMillions`
 * (>= 10_000 is impossible as "millions" → divide by 1e6).
 */
export function readCountryPopulationMillionsForGate(
  imfLaborRaw: unknown,
  countryCode: string,
): number | null {
  const raw = safeNum(getImfLaborEntry(imfLaborRaw, countryCode)?.populationMillions);
  if (raw == null) return null;
  return raw >= 10_000 ? raw / 1_000_000 : raw;
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
  // Current WTO seeds emit at most one latest restriction row per reporter,
  // but legacy affected-country rows may accumulate above the 0..2 goalpost;
  // normalizeLowerBetter clamps that overflow to the worst score.
  return restrictions.reduce((count, item) => {
    const matches = matchesCountryIdentifier(item.reportingCountry, countryCode)
      || matchesCountryIdentifier(item.affectedCountry, countryCode);
    if (!matches) return count;
    return count + tradePolicyStatusSeverity(item.status);
  }, 0);
}

export function countTradeBarriers(raw: unknown, countryCode: string): number {
  const barriers: TradeBarrier[] = Array.isArray((raw as { barriers?: unknown[] } | null)?.barriers)
    ? ((raw as { barriers?: TradeBarrier[] }).barriers ?? [])
    : [];
  return barriers.reduce((count, item) => {
    if (!matchesCountryIdentifier(item.notifyingCountry, countryCode)) return count;
    return count + tradePolicyStatusSeverity(item.status);
  }, 0);
}

function tradePolicyStatusSeverity(status: unknown): number {
  const normalized = String(status ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (normalized === 'LOW') return 0;
  if (normalized === 'MODERATE' || normalized === 'MEDIUM' || normalized === 'PLANNED') return 1;
  if (normalized === 'HIGH' || normalized === 'IN_FORCE') return 2;
  if (normalized !== '') {
    console.warn(`[Resilience] tradePolicyStatusSeverity: unrecognized status "${status}", defaulting to moderate`);
  }
  return 1;
}

function isInWtoReporterSet(raw: unknown, countryCode: string): boolean {
  const reporters = (raw as { _reporterCountries?: string[] } | null)?._reporterCountries;
  if (!Array.isArray(reporters) || reporters.length === 0) return true;
  return reporters.includes(countryCode);
}

function hasArrayField(raw: unknown, field: string): boolean {
  return raw != null && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>)[field]);
}

function hasNonEmptyArrayField(raw: unknown, field: string): boolean {
  return hasArrayField(raw, field) && ((raw as Record<string, unknown>)[field] as unknown[]).length > 0;
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

const DAY_MS = 24 * 60 * 60 * 1000;
// Lower than any WorldMonitor-sourced firstSeenAt; smaller numbers are usually
// Unix seconds and should fall back to the current bucket.
const MIN_FIRST_SEEN_EPOCH_MS = 1e11;

interface CyberDiscoveryOptions {
  nowMs?: number;
}

function readEpochMs(value: unknown): number | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const numeric = typeof value === 'number' ? value : trimmed.length > 0 ? Number(trimmed) : NaN;
  if (Number.isFinite(numeric)) {
    return numeric >= MIN_FIRST_SEEN_EPOCH_MS ? numeric : null;
  }
  if (trimmed.length === 0) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed >= MIN_FIRST_SEEN_EPOCH_MS ? parsed : null;
}

function cyberDiscoveryAgeDays(firstSeenAt: unknown, nowMs: number): number {
  const firstSeenMs = readEpochMs(firstSeenAt);
  if (firstSeenMs == null || !Number.isFinite(nowMs) || nowMs <= 0) return 0;
  return Math.max(0, Math.floor((nowMs - firstSeenMs) / DAY_MS));
}

function cyberDiscoveryDecay(ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  return 2 ** (-ageDays / CYBER_DISCOVERY_HALF_LIFE_DAYS);
}

export function summarizeCyber(
  raw: unknown,
  countryCode: string,
  options: CyberDiscoveryOptions = {},
): { weightedCount: number } {
  const threats: CyberThreat[] = Array.isArray((raw as { threats?: unknown[] } | null)?.threats)
    ? ((raw as { threats?: CyberThreat[] }).threats ?? [])
    : [];
  const SEVERITY_WEIGHT: Record<string, number> = {
    CRITICALITY_LEVEL_CRITICAL: 3,
    CRITICALITY_LEVEL_HIGH: 2,
    CRITICALITY_LEVEL_MEDIUM: 1,
    CRITICALITY_LEVEL_LOW: 0.5,
  };

  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const weightsByAgeDay = new Map<number, number>();
  for (const threat of threats) {
    if (!matchesCountryIdentifier(threat.country, countryCode)) continue;
    const ageDays = cyberDiscoveryAgeDays(threat.firstSeenAt, nowMs);
    const severityWeight = SEVERITY_WEIGHT[String(threat.severity || '')] ?? 1;
    weightsByAgeDay.set(ageDays, (weightsByAgeDay.get(ageDays) ?? 0) + severityWeight);
  }

  let decayedWeight = 0;
  for (const [ageDays, weight] of weightsByAgeDay) {
    decayedWeight += Math.min(weight, CYBER_SNAPSHOT_WEIGHT_CAP) * cyberDiscoveryDecay(ageDays);
  }

  return { weightedCount: Math.min(decayedWeight, CYBER_SNAPSHOT_WEIGHT_CAP) };
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
  const [debtRaw, imfMacroRaw, imfLaborRaw, bisDsrRaw, bocRaw, statcanRaw] = await Promise.all([
    reader(RESILIENCE_NATIONAL_DEBT_KEY),
    reader(RESILIENCE_IMF_MACRO_KEY),
    reader(RESILIENCE_IMF_LABOR_KEY),
    reader(RESILIENCE_BIS_DSR_KEY),
    countryCode === 'CA' ? reader(RESILIENCE_BOC_VALET_KEY) : Promise.resolve(null),
    countryCode === 'CA' ? reader(RESILIENCE_STATCAN_WDS_KEY) : Promise.resolve(null),
  ]);
  const debtEntry = getLatestDebtEntry(debtRaw, countryCode);
  const overlay = applyCanadaNationalOverlay(
    countryCode,
    getImfMacroEntry(imfMacroRaw, countryCode),
    getImfLaborEntry(imfLaborRaw, countryCode),
    { boc: bocRaw as never, statcan: statcanRaw as never },
  );
  const imfEntry = overlay.imfEntry;
  const laborEntry = overlay.laborEntry;
  const dsrEntry = getBisDsrEntry(bisDsrRaw, countryCode);

  return weightedBlend([
    // Government revenue/GDP: fiscal capacity — how much the state can actually mobilise.
    // Replaces raw debt/GDP which HIPC debt relief and credit exclusion invert for fragile
    // states (Somalia 5% debt ≠ fiscal prudence; it reflects that no one will lend to them).
    // Anchor: 5% (Somalia, war-torn states) → 0, 45% (OECD median) → 100.
    imfMacroRaw == null
      ? { score: null, weight: MACRO_FISCAL_INDICATOR_WEIGHTS.govRevenuePct }
      : {
          score: imfEntry?.govRevenuePct == null ? null : normalizeHigherBetter(imfEntry.govRevenuePct, 5, 45),
          weight: MACRO_FISCAL_INDICATOR_WEIGHTS.govRevenuePct,
        },
    // Debt growth rate: rapid debt accumulation = fiscal stress even at moderate levels.
    {
      score: extractMetric(debtEntry, (entry) => normalizeLowerBetter(Math.max(0, safeNum(entry.annualGrowth) ?? 0), 0, 20)),
      weight: MACRO_FISCAL_INDICATOR_WEIGHTS.debtGrowthRate,
    },
    // Current account balance: external position — deficit = more vulnerable to FX shocks.
    imfMacroRaw == null
      ? { score: null, weight: MACRO_FISCAL_INDICATOR_WEIGHTS.currentAccountPct }
      : {
          score: imfEntry?.currentAccountPct == null ? null : normalizeHigherBetter(Math.max(-20, Math.min(imfEntry.currentAccountPct, 20)), -20, 20),
          weight: MACRO_FISCAL_INDICATOR_WEIGHTS.currentAccountPct,
        },
    imfLaborRaw == null && !overlay.usedStatcanUnemployment
      ? { score: null, weight: MACRO_FISCAL_INDICATOR_WEIGHTS.unemploymentPct }
      : {
          score: laborEntry?.unemploymentPct == null ? null : normalizeLowerBetter(Math.max(3, Math.min(laborEntry.unemploymentPct, 25)), 3, 25),
          weight: MACRO_FISCAL_INDICATOR_WEIGHTS.unemploymentPct,
        },
    bisDsrRaw == null || dsrEntry == null
      ? { score: null, weight: MACRO_FISCAL_INDICATOR_WEIGHTS.householdDebtService }
      : {
          score: normalizeLowerBetter(Math.max(0, Math.min(dsrEntry.dsrPct, 20)), 0, 20),
          weight: MACRO_FISCAL_INDICATOR_WEIGHTS.householdDebtService,
        },
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
  const [imfMacroRaw, staticRecord, bocRaw, statcanRaw] = await Promise.all([
    reader(RESILIENCE_IMF_MACRO_KEY),
    readStaticCountry(countryCode, reader),
    countryCode === 'CA' ? reader(RESILIENCE_BOC_VALET_KEY) : Promise.resolve(null),
    countryCode === 'CA' ? reader(RESILIENCE_STATCAN_WDS_KEY) : Promise.resolve(null),
  ]);

  const overlay = applyCanadaNationalOverlay(
    countryCode,
    getImfMacroEntry(imfMacroRaw, countryCode),
    null,
    { boc: bocRaw as never, statcan: statcanRaw as never },
  );
  const imfEntry = overlay.imfEntry;
  const inflationPct = safeNum(imfEntry?.inflationPct);
  // StatCan CPI must score even when the IMF macro envelope is missing.
  const hasInflation = inflationPct != null;
  const inflationScore = hasInflation
    ? scoreInflationStability(inflationPct!)
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
//   WTO restriction severity → 0.30 (was 0.15)
//   WTO barrier severity     → 0.30 (was 0.15)
//   applied tariff rate    → 0.40 (was 0.25)
// The `sanctions:country-counts:v1` seed key is no longer read by this
// module; only `scripts/seed-sanctions-pressure.mjs` continues to WRITE it
// for country-brief generation and ad-hoc analysis. The retired
// `RESILIENCE_SANCTIONS_KEY` constant and `normalizeSanctionCount` helper
// were removed in this PR (see retire-tag at lines ~263 and ~542).
// Phase 2 (Ship 2) adds the `financialSystemExposure` dim built from
// BIS CBS + WB IDS + FATF status — a structural-exposure construct that
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
        : { score: normalizeLowerBetter(restrictionCount, 0, 2), weight: 0.30 },
    barriersRaw == null
      ? { score: null, weight: 0.30 }
      : !inBarriersReporterSet
        ? { score: IMPUTE.wtoData.score, weight: 0.30, certaintyCoverage: IMPUTE.wtoData.certaintyCoverage, imputed: true, imputationClass: IMPUTE.wtoData.imputationClass }
        : { score: normalizeLowerBetter(barrierCount, 0, 2), weight: 0.30 },
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
//   short_term_external_debt_pct_gni     0.35 (WB IDS — lowerBetter; goalpost worst=15% best=0%;
//                                              non-DRS jurisdictions impute — see resolveNonDrsDebtImputation)
//   bis_lbs_xborder_us_eu_uk_pct_gdp     0.30 (BIS CBS by-parent — asymmetric U-shape band;
//                                              premium above 75 scaled by parent redundancy —
//                                              see normalizeDiversityConditionedBand)
//   fatf_listing_status                   0.20 (FATF — discrete: black=0, gray=55, compliant=100)
//   financial_center_redundancy           0.15 (BIS CBS by-parent count — higherBetter; goalpost worst=1 best=10)
//
// ...then capped at 15 for comprehensively embargoed jurisdictions (#6459 —
// see FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO). The cap is not a component:
// three of the four graded components read financial severance as strength,
// so the signal cannot be carried by reweighting them.
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
// envelopes (component 4 shares the retained economic:bis-lbs CBS seed) MUST be reachable.
// Missing seed-meta indicates a Railway bundle/cron failure and is
// surfaced as `source-failure` via
// `ResilienceConfigurationError(message, missingKeys)` — caught at
// `scoreAllDimensions` and routed to the imputationClass='source-failure'
// path. Per-country data gaps are distinct: per-component reads return
// `null` and the slot drops out of the weighted blend.
function isFinSysExposureEnabledLocal(): boolean {
  return (process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED ?? 'false').toLowerCase() === 'true';
}

const RESILIENCE_EDUCATION_KEY = 'resilience:education-attainment:v1';
export const EDUCATION_ACTIVATION_MIN_COUNTRIES = 180;

function readEducationRankableRecordCount(meta: unknown): number | null {
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const numeric = Number((meta as { rankableRecordCount?: unknown }).rankableRecordCount);
  if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;

  // Transition support for seed-meta written before rankableRecordCount was
  // added. The prior seeder already persisted the exact rankable country set,
  // so it can prove the same floor without waiting for the next weekly publish.
  const rawCountrySet = (meta as { countrySet?: unknown }).countrySet;
  if (typeof rawCountrySet !== 'string' || rawCountrySet.length === 0) return null;
  const codes = rawCountrySet.split(',').map((code) => code.trim());
  if (codes.some((code) => !/^[A-Z]{2}$/.test(code) || !isInRankableUniverse(code))) return null;
  return new Set(codes).size;
}

// #6460 activation contract. The default is `true`, so the promotion PR is the
// flip rather than a config change that has to land separately.
//
// Why the default and not a production env var, unlike energy v2 and
// financialSystemExposure: education is the first dimension whose activation is
// CI-COUPLED to its own flag. The active release gate removes `education` from
// its fixture allow-list, while `RESILIENCE_FLAG_DARK_WHEN_ZERO_COVERAGE`
// retains the dimension for the explicit false rollback. That runtime helper
// keys on the unique triple-zero shape, so active observations and source
// failures remain counted. A default of `false` would require the env var in
// BOTH CI and Vercel, splitting "is education on" across two config surfaces.
//
// `RESILIENCE_EDUCATION_ENABLED=false` in the production environment remains
// the rollback kill switch — identical to the previous rollback story, just
// inverted in which direction needs the explicit setting. See
// `docs/methodology/education-flag-flip-runbook.md` § Rollback.
export function isEducationEnabled(): boolean {
  return (process.env.RESILIENCE_EDUCATION_ENABLED ?? 'true').toLowerCase() === 'true';
}

// Certainty ladder for a stale-but-present observation. Attainment of the 25+
// population is a slow-moving stock, so a 2015 reading still carries real
// information in a way a 2015 unemployment rate would not — reduce certainty
// rather than dropping the country.
//
// Deliberately NOT a drop rule. 39 of the 181 covered countries have an
// observation older than 5 years, including JP, CN, NZ, and KZ, so a 5-year
// drop would cut major economies for survey cadence alone. Only 5 countries
// (FM, NI, CG, MR, SB) are past 10 years, and two of those sit in the low band
// this series was chosen to resolve.
export function educationObservationCertainty(observationYear: number, nowYear: number): number {
  if (!Number.isFinite(observationYear) || !Number.isFinite(nowYear)) return 0.6;
  const age = nowYear - observationYear;
  if (age <= 5) return 1.0;
  if (age <= 10) return 0.8;
  return 0.6;
}

export async function scoreEducation(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  if (!isEducationEnabled()) {
    // Flag off — empty-data shape, contributes zero weight to the domain mean.
    // imputationClass stays null: a dark dimension is a deliberate construct
    // state, not an outage, and tagging it `source-failure` would render a
    // false "Source down" badge on every country in the widget.
    return {
      score: 0,
      coverage: 0,
      observedWeight: 0,
      imputedWeight: 0,
      imputationClass: null,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }

  // Fail-closed preflight. A missing envelope means the Railway bundle is not
  // publishing, which is an operator problem — surface it as source-failure
  // rather than silently imputing every country to the midpoint.
  const meta = await reader(resolveSeedMetaKey(RESILIENCE_EDUCATION_KEY));
  if (isSeedMetaPreflightUnhealthy(RESILIENCE_EDUCATION_KEY, meta)) {
    throw new ResilienceConfigurationError(
      `RESILIENCE_EDUCATION_ENABLED=true but required seed-meta absent or unhealthy for: ${RESILIENCE_EDUCATION_KEY}. ` +
        'Provision the macro bundle component seeder (seed-education-attainment) and confirm Redis ' +
        'populates BEFORE flipping the flag. Or set RESILIENCE_EDUCATION_ENABLED=false to keep the dim dark. ' +
        'See docs/methodology/education-flag-flip-runbook.md.',
      [RESILIENCE_EDUCATION_KEY],
    );
  }

  const rankableRecordCount = readEducationRankableRecordCount(meta);
  if (rankableRecordCount == null || rankableRecordCount < EDUCATION_ACTIVATION_MIN_COUNTRIES) {
    throw new ResilienceConfigurationError(
      `RESILIENCE_EDUCATION_ENABLED=true but ${RESILIENCE_EDUCATION_KEY} rankable coverage is ` +
        `${rankableRecordCount ?? 'unproven'}/${EDUCATION_ACTIVATION_MIN_COUNTRIES}. ` +
        'Wait for a healthy education seed above the activation floor, or set RESILIENCE_EDUCATION_ENABLED=false to roll back.',
      [RESILIENCE_EDUCATION_KEY],
    );
  }

  const raw = await reader(RESILIENCE_EDUCATION_KEY);
  const countries = raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { countries?: unknown }).countries
    : null;
  if (
    countries == null ||
    typeof countries !== 'object' ||
    Array.isArray(countries)
  ) {
    throw new ResilienceConfigurationError(
      `RESILIENCE_EDUCATION_ENABLED=true but the ${RESILIENCE_EDUCATION_KEY} data payload is missing, malformed, or empty. ` +
        'Confirm the education seeder wrote a non-empty countries envelope, or set RESILIENCE_EDUCATION_ENABLED=false to roll back.',
      [RESILIENCE_EDUCATION_KEY],
    );
  }
  const record = readEducationAttainment(raw, countryCode);

  if (Object.prototype.hasOwnProperty.call(countries, countryCode) && record == null) {
    throw new ResilienceConfigurationError(
      `RESILIENCE_EDUCATION_ENABLED=true but ${RESILIENCE_EDUCATION_KEY} has a malformed record for ${countryCode}. ` +
        'Confirm the education seeder wrote finite value/year fields in the expected range, or set RESILIENCE_EDUCATION_ENABLED=false to roll back.',
      [RESILIENCE_EDUCATION_KEY],
    );
  }

  let usableRankableRecordCount = 0;
  for (const country in countries) {
    if (
      Object.prototype.hasOwnProperty.call(countries, country) &&
      Object.prototype.hasOwnProperty.call(ISO2_TO_ISO3, country) &&
      isInRankableUniverse(country) &&
      readEducationAttainment(raw, country) != null
    ) {
      usableRankableRecordCount += 1;
    }
  }
  if (usableRankableRecordCount < EDUCATION_ACTIVATION_MIN_COUNTRIES) {
    throw new ResilienceConfigurationError(
      `RESILIENCE_EDUCATION_ENABLED=true but the ${RESILIENCE_EDUCATION_KEY} data payload has usable rankable coverage ` +
        `${usableRankableRecordCount}/${EDUCATION_ACTIVATION_MIN_COUNTRIES}. ` +
        'Confirm the education seeder wrote enough finite value/year records, or set RESILIENCE_EDUCATION_ENABLED=false to roll back.',
      [RESILIENCE_EDUCATION_KEY],
    );
  }

  if (record == null) {
    // Country absent from the envelope. This is `unmonitored`, NOT
    // `stable-absence`: the World Bank does not survey everywhere, so absence
    // means "not measured", not "the phenomenon is not happening". Treating it
    // as stable-absence would hand DPRK and Syria a score near 85.
    return weightedBlend([
      {
        score: IMPUTATION.curated_list_absent.score,
        weight: 1.0,
        certaintyCoverage: IMPUTATION.curated_list_absent.certaintyCoverage,
        imputed: true,
        imputationClass: IMPUTATION.curated_list_absent.imputationClass,
      },
    ]);
  }

  const nowYear = new Date().getUTCFullYear();
  return weightedBlend([
    {
      score: normalizeEducationAttainment(record.value),
      weight: 1.0,
      // Observed data at reduced certainty when the survey is old. NOT
      // `imputed` — this is a real reading, just an aging one, and flagging it
      // imputed would misreport the dimension's provenance.
      certaintyCoverage: educationObservationCertainty(record.year, nowYear),
    },
  ]);
}

// Payload accessor. Shape: { countries: { [iso2]: { value, year } } }.
// Defensive against unexpected shapes; returns null on any deviation.
function readEducationAttainment(
  raw: unknown,
  countryCode: string,
): { value: number; year: number } | null {
  if (raw == null || typeof raw !== 'object') return null;
  const countries = (raw as { countries?: Record<string, unknown> }).countries;
  if (countries == null || typeof countries !== 'object') return null;
  const entry = countries[countryCode];
  if (entry == null || typeof entry !== 'object') return null;

  // Reject nullish BEFORE coercion. `safeNum` runs Number() first, and
  // Number(null) === 0 is finite — so a `value: null` in the envelope would
  // resolve to a real 0% attainment scored at full coverage, publishing "worst
  // on earth, fully observed" for a country we simply have no reading for. Same
  // trap the seeder and the transform each guard on the write side; this is the
  // read side of it. `year: null` would likewise become year 0 and silently
  // derate a fresh observation into the >10-year certainty bucket.
  //
  // The current seeder cannot emit either (it skips nulls before publishing),
  // so this is defense in depth — but the sibling energy envelopes are typed
  // `year: number | null`, so a future producer plausibly can.
  const rawValue = (entry as { value?: unknown }).value;
  const rawYear = (entry as { year?: unknown }).year;
  if (rawValue == null || rawYear == null) return null;

  const value = safeNum(rawValue);
  const year = safeNum(rawYear);
  if (value == null || year == null) return null;
  // Percentage of population; anything outside 0..100 is upstream corruption,
  // matching the range check the seeder enforces on write.
  if (value < 0 || value > 100) return null;
  // World Bank observation years are whole Gregorian years. Keep this read
  // contract aligned with the seeder and the Edge health payload probe so a
  // record cannot count as healthy while the scorer interprets a corrupt year.
  if (!Number.isSafeInteger(year) || year < 1900 || year > 2200) return null;
  return { value, year };
}

// #6459 — comprehensive-embargo cap.
//
// The construct's question is "how vulnerable is this financial system to
// coordinated action by major Western banking jurisdictions?". For a
// jurisdiction already under a comprehensive or government-wide blocking
// programme that vulnerability is not a forecast, it is realized in full:
// correspondent relationships are gone, reserves are immobilised, messaging
// access is revoked. Yet three of the four components read that severance as
// strength — thin short-term external debt (no market access), low
// cross-border claims (nobody lends), and FATF-compliant-by-absence (FATF
// enumerates AML/CFT deficiencies, not sanctions).
//
// A band retune alone cannot fix this. With the band leg at 0 and the
// redundancy leg at 0, Russia still holds 0.35x80 (debt) + 0.20x100 (FATF)
// = 48, more than double the methodology doc's < 20 activation anchor. The
// signal has to enter the construct as its own input.
//
// This is NOT the "transit-hub exclusion list" rejected as Alternative 2 in
// the methodology doc. That list would have been an editorial carve-out of
// jurisdictions the construct scored inconveniently. This list IS the
// construct's subject, and its membership is externally defined by published
// US OFAC and EU Council programmes rather than drawn by us.
//
// Membership criterion: a comprehensive/territory-wide embargo, or a
// government-wide blocking programme that severs the sovereign from Western
// correspondent clearing. Individual-entity designations, sectoral measures
// and arms embargoes do NOT qualify — those are ordinary policy friction and
// belong in the graded components.
export const FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO: ReadonlySet<string> = new Set([
  'RU', // EO 14024 + G7 reserve immobilisation + SWIFT exclusion of major banks (2022–)
  'BY', // EO 14038 + EU Reg. 765/2006 as amended; SWIFT exclusion (2022–)
  'IR', // 31 CFR 560 Iranian Transactions and Sanctions Regulations (comprehensive)
  'KP', // 31 CFR 510 North Korea Sanctions Regulations (comprehensive)
  'CU', // 31 CFR 515 Cuban Assets Control Regulations (comprehensive, 1963–)
  'MM', // EO 14014 Burma blocking programme + EU Reg. 2013/184
  'VE', // EO 13884 blocks all property of the Government of Venezuela
  'LY', // EO 13566 blocks all property of the Government of Libya; UNSCR 1970/1973
]);

// Static policy state must expire rather than age silently. OFAC revoked the
// comprehensive Syria programme effective 2025-07-01
// (https://ofac.treasury.gov/recent-actions/20250630), but the first #6459 list
// still included SY in August 2026. Tests enforce this review window so
// every entry is re-checked against current primary sources before the policy
// can drift for another release cycle.
export const FIN_SYS_EXPOSURE_EMBARGO_POLICY_REVIEWED_ON = '2026-08-11';
export const FIN_SYS_EXPOSURE_EMBARGO_POLICY_MAX_AGE_DAYS = 120;

// Cap, not a floor-to-zero: the graded components still order jurisdictions
// WITHIN the embargoed set (DPRK's FATF black listing keeps it at 0, below
// Russia's 15), and a country that already scores below the cap is untouched.
// 15 sits deliberately below the methodology doc's < 20 activation anchor so
// the anchor has headroom rather than passing by exactly zero margin.
export const FIN_SYS_EXPOSURE_EMBARGO_SCORE_CAP = 15;

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

  const normalizedCountryCode = countryCode.toUpperCase();
  const isComprehensiveEmbargo = FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO.has(normalizedCountryCode);

  // Preflight: verify the 3 required seed envelopes are published and fresh.
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
  const unhealthy: string[] = [];
  for (const key of requiredSeedKeys) {
    const meta = await reader(resolveSeedMetaKey(key));
    if (isSeedMetaPreflightUnhealthy(key, meta)) unhealthy.push(key);
  }
  if (unhealthy.length > 0) {
    throw new ResilienceConfigurationError(
      `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=true but required seed-meta absent or unhealthy for: ${unhealthy.join(', ')}. ` +
        'Provision the macro bundle component seeders (seed-bis-lbs, seed-fatf-listing, ' +
        'seed-wb-external-debt) and confirm Redis populates BEFORE flipping the flag. ' +
        'Or set RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=false to keep the dim dark. ' +
        'See plan 2026-04-25-004 §Fail-closed preflight.',
      unhealthy,
    );
  }

  // Per-component reads. Each returns null on per-country data gap; the
  // weightedBlend drops null-score slots from the blend denominator.
  const [debtRaw, bisRaw, fatfRaw] = await Promise.all([
    reader(RESILIENCE_WB_EXTERNAL_DEBT_KEY),
    reader(RESILIENCE_BIS_LBS_KEY),
    reader(RESILIENCE_FATF_LISTING_KEY),
  ]);

  // Seed-meta can remain healthy while the subsequent Redis data read misses,
  // times out, or returns malformed JSON. Without this envelope check that
  // source-level failure is indistinguishable from a country outside DRS and
  // can be converted into the positive score-75 imputation below.
  const debtEnvelope = readWbExternalDebtEnvelope(debtRaw);
  if (debtEnvelope == null) {
    throw new ResilienceConfigurationError(
      `RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=true requires ${RESILIENCE_WB_EXTERNAL_DEBT_KEY} schema v2 with valid countries and nonDrsCountryCodes after a healthy seed-meta preflight. ` +
        'Re-run seed-wb-external-debt and confirm the published envelope schema before scoring.',
      [RESILIENCE_WB_EXTERNAL_DEBT_KEY],
    );
  }

  // Component 1: short-term external debt as % of GNI. WB IDS coverage is
  // ~125 borrowers. Countries explicitly classified by World Bank as outside
  // its lending scope can receive the guarded non-DRS imputation below.
  // Payload shape: { countries: { [iso2]: { value, year } },
  //   nonDrsCountryCodes: string[] }.
  const debtPct = readWbExternalDebtPct(debtEnvelope, countryCode);

  // Component 2 + 4 share the retained economic:bis-lbs payload, sourced
  // from BIS CBS (WS_CBS_PUB). Component 2: sum of by-parent foreign
  // claims for the enumerated Western parents as % of GDP.
  // Component 4: count of distinct by-parent reporters with non-trivial
  // claims (>1% of GDP).
  // Payload shape: { countries: { [iso2]: { totalXborderPctGdp: number,
  //   parentCount: number, parents: { [parentIso2]: number } } } }.
  const bisCountry = readBisLbsCountry(bisRaw, countryCode);

  // Component 3: FATF listing status. Discrete classification. Preserve
  // whether `compliant` was explicitly published or inferred from absence so
  // a data-desert country cannot turn list absence into a perfect score.
  // Payload shape: { listings: { [iso2]: 'black' | 'gray' | 'compliant' },
  //   publicationDate: string }.
  const fatfObservation = readFatfStatus(fatfRaw, countryCode);

  // #6459 Component 1 slot. WB International Debt Statistics is the output of
  // the Debtor Reporting System, whose membership is World Bank BORROWERS —
  // 119 countries in the 2026-08-11 production payload. Non-borrowing
  // jurisdictions are absent by design, not by data gap.
  //
  // Dropping the slot for them was the defect: `weightedBlend` renormalizes
  // onto the surviving slots, so the 0.35 weight redistributed onto a
  // denominator of 0.65 and the punitive band leg alone went from 30% to 46%
  // of the score. Luxembourg was scored almost entirely on "your banks are too
  // integrated", with no offsetting credit for having no rollover risk at all.
  //
  // Imputing at 75 with certaintyCoverage 0.3 keeps the weight where the
  // design put it while being explicit that the reading is inferred:
  // `not-applicable` is the right class because non-participation in the DRS
  // means there is no reported short-term external commercial debt to roll
  // over, which is a mild positive rather than an unknown.
  const nonDrsDebtImputation = resolveNonDrsDebtImputation(
    debtPct,
    bisCountry,
    debtEnvelope.nonDrsCountryCodes.has(normalizedCountryCode),
  );

  const marketAccessConstrainedDebt = isMarketAccessConstrainedDebtSignal(debtPct, bisCountry);
  const fatfIsOnlyResolvingComponent = debtPct == null
    && nonDrsDebtImputation == null
    && bisCountry?.totalXborderPctGdp == null
    && bisCountry?.parentCount == null;
  const dropFatfCompliantByAbsence = fatfObservation?.assignedByAbsence === true
    && fatfIsOnlyResolvingComponent
    // CU is intentionally preserved: the comprehensive-embargo cap is an
    // external construct signal, and its non-zero observed FATF slot keeps the
    // executable sanctions anchor from passing vacuously at zero coverage.
    && !isComprehensiveEmbargo;

  const blended = weightedBlend([
    {
      score: debtPct != null
        ? normalizeLowerBetter(debtPct, 0, 15)
        : (nonDrsDebtImputation?.score ?? null),
      // #6461: a tiny debt stock is not full-strength evidence of low
      // rollover vulnerability when the same country has near-zero BIS
      // claims and no foreign reporting parents. Those three observed signals
      // together proxy market-access constraint using data already in the
      // construct. Retain the reading at low confidence instead of deleting it
      // or introducing a new editorial country list.
      weight: marketAccessConstrainedDebt
        ? FIN_SYS_SHORT_TERM_DEBT_WEIGHT * FIN_SYS_MARKET_ACCESS_CONSTRAINED_DEBT_CERTAINTY
        : FIN_SYS_SHORT_TERM_DEBT_WEIGHT,
      nominalWeight: FIN_SYS_SHORT_TERM_DEBT_WEIGHT,
      certaintyCoverage: marketAccessConstrainedDebt
        ? FIN_SYS_MARKET_ACCESS_CONSTRAINED_DEBT_CERTAINTY
        : nonDrsDebtImputation?.certaintyCoverage,
      imputed: nonDrsDebtImputation != null ? true : undefined,
      imputationClass: nonDrsDebtImputation?.imputationClass,
    },
    {
      // Diversity-conditioned: the sweet-spot premium is earned only in
      // proportion to demonstrated parent breadth (see
      // `normalizeDiversityConditionedBand`). Passing `parentCount` from the
      // same BIS row keeps level and breadth reads consistent per country.
      // A missing count caps the premium here. A malformed claims field is
      // also retained as a conservative zero fallback by weightedBlend so a
      // parser regression cannot free this slot's weight onto unrelated legs.
      //
      // This slot now has TWO designed inputs (level and breadth), so it can
      // resolve only half-observed. `certaintyCoverage` says which: a withheld
      // premium is a substituted floor, not a redundancy-scaled reading, and
      // reporting it at full certainty would claim evidence that never arrived.
      // The sibling debt slot already draws exactly this distinction via
      // `nonDrsDebtImputation` / #6461. Only `certaintyCoverage` is set, never
      // `imputed`/`imputationClass`: the score is a conservative bound taken
      // from the observed level, not a value inferred from an absence model,
      // and it must not enter the imputed-weight accounting as if it were.
      score: bisCountry?.totalXborderPctGdp == null
        ? null
        : normalizeDiversityConditionedBand(bisCountry.totalXborderPctGdp, bisCountry.parentCount),
      weight: FIN_SYS_BAND_WEIGHT,
      fallbackScore: bisCountry?.totalXborderPctGdpMalformed ? 0 : undefined,
      certaintyCoverage: resolveFinSysBandCertainty(bisCountry),
    },
    {
      score: fatfObservation == null || dropFatfCompliantByAbsence
        ? null
        : fatfStatusToScore(fatfObservation.status),
      weight: FIN_SYS_FATF_WEIGHT,
    },
    {
      score: bisCountry?.parentCount == null
        ? null
        : normalizeHigherBetter(bisCountry.parentCount, 1, 10),
      weight: FIN_SYS_REDUNDANCY_WEIGHT,
      fallbackScore: bisCountry?.parentCountMalformed ? 0 : undefined,
      // A count computed over an incomplete reporting-parent set is an
      // undercount, not an observation — same reasoning as the band slot.
      certaintyCoverage: bisCountry != null && !bisCountry.parentSetComplete
        ? FIN_SYS_BIS_DEGRADED_PARENT_SET_CERTAINTY
        : undefined,
    },
  ]);

  // #6459 comprehensive-embargo cap. Applied POST-blend so it constrains the
  // published score without distorting the component provenance: coverage,
  // observedWeight, imputedWeight and imputationClass all still describe what
  // was actually read. An operator inspecting a capped country still sees
  // which components resolved.
  if (
    isComprehensiveEmbargo
    && blended.score > FIN_SYS_EXPOSURE_EMBARGO_SCORE_CAP
  ) {
    return { ...blended, score: FIN_SYS_EXPOSURE_EMBARGO_SCORE_CAP };
  }
  return blended;
}

// #6459 — decides whether an absent WB IDS row is "not applicable" (the
// jurisdiction does not report to the Debtor Reporting System) or a genuine
// data gap.
//
// DISCRIMINATOR: the WB seeder publishes `nonDrsCountryCodes` from the World
// Bank country catalog's `lendingType=LNX` classification. The imputation
// requires both that explicit non-borrower signal and a valid BIS row. A
// borrower missing from a partial IDS payload therefore stays null/drop, and
// a country in neither source remains a genuine data desert.
function resolveNonDrsDebtImputation(
  debtPct: number | null,
  bisCountry: BisLbsCountry | null,
  confirmedNonDrsCountry: boolean,
): ImputationEntry | null {
  if (debtPct != null) return null;
  // Per-country absence is not enough: accepted WB payloads may omit an
  // otherwise eligible borrower. Only the seeder's World Bank lending-type
  // metadata can confirm that the country is outside the DRS borrower scope.
  if (!confirmedNonDrsCountry) return null;
  // A BIS row whose every field failed to parse is a corrupt entry, not
  // evidence the jurisdiction participates in cross-border banking — do not
  // let it trigger the imputation.
  if (bisCountry == null) return null;
  if (bisCountry.totalXborderPctGdp == null && bisCountry.parentCount == null) return null;
  return IMPUTE.finSysExposureNonDrsShortTermDebt;
}

// Small payload accessors for scoreFinancialSystemExposure. Defensive
// against unexpected shapes; return null on any deviation.
interface WbExternalDebtEnvelope {
  countries: Record<string, unknown>;
  nonDrsCountryCodes: ReadonlySet<string>;
}

function readWbExternalDebtEnvelope(raw: unknown): WbExternalDebtEnvelope | null {
  if (raw == null || typeof raw !== 'object') return null;
  const unwrapped = unwrapEnvelope(raw);
  const schemaVersion = unwrapped._seed?.schemaVersion
    ?? (raw as { schemaVersion?: unknown }).schemaVersion;
  if (
    typeof schemaVersion !== 'number'
    || !Number.isInteger(schemaVersion)
    || schemaVersion < RESILIENCE_WB_EXTERNAL_DEBT_SCHEMA_VERSION
  ) return null;
  const payload = unwrapped.data;
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const countries = (payload as { countries?: Record<string, unknown> }).countries;
  if (!countries || typeof countries !== 'object' || Array.isArray(countries) || Object.keys(countries).length === 0) {
    return null;
  }

  const rawNonDrsCountryCodes = (payload as { nonDrsCountryCodes?: unknown }).nonDrsCountryCodes;
  // Match the producer's fail-closed floor so an empty or truncated cohort
  // cannot preserve the schema shape while silently disabling imputation.
  if (!Array.isArray(rawNonDrsCountryCodes) || rawNonDrsCountryCodes.length < 40) return null;

  const nonDrsCountryCodes = new Set<string>();
  for (const code of rawNonDrsCountryCodes) {
    if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code) || nonDrsCountryCodes.has(code)) return null;
    nonDrsCountryCodes.add(code);
  }

  return {
    countries,
    // The active scorer requires schema v2. Accepting the former v1 shape here
    // silently disables the non-DRS imputation for every eligible country.
    nonDrsCountryCodes,
  };
}

function readWbExternalDebtPct(envelope: WbExternalDebtEnvelope, countryCode: string): number | null {
  const entry = envelope.countries[countryCode];
  if (!entry || typeof entry !== 'object') return null;
  return safeNum((entry as { value?: unknown }).value);
}

interface BisLbsCountry {
  totalXborderPctGdp: number | null;
  parentCount: number | null;
  // True when the field was present but failed the reader's type/range
  // contract. A genuinely absent field remains distinguishable and keeps the
  // scorer's existing coverage-weighted absence behavior.
  totalXborderPctGdpMalformed: boolean;
  parentCountMalformed: boolean;
  /**
   * False when the seed envelope reports that the BIS collection ran with an
   * incomplete reporting-parent set (`successfulParents < parentCountries`).
   * `seed-bis-lbs.mjs` tolerates up to 4 of its 16 parent fetches failing with
   * only a `console.warn` (`MIN_SUCCESSFUL_PARENTS`), and a missing parent feed
   * silently lowers `parentCount` for every country it would have covered. That
   * used to move only Component 4 (weight 0.15); since the band premium is
   * conditioned on the same count it now moves Component 2 (0.30) as well, so
   * the incompleteness has to reach the blend as reduced certainty instead of
   * passing as an observed reading. True when the envelope does not report the
   * ratio at all — absence of the field is not evidence of degradation.
   */
  parentSetComplete: boolean;
}

// #6461 market-access proxy. Reuse the construct's existing component
// boundaries instead of adding an unverified source: <=1% short-term debt is
// structurally tiny, <5% BIS claims is below the healthy integration band, and
// zero reporting parents means no independent foreign-bank route clears the
// redundancy floor. All three must hold, so ordinary low-debt borrowers keep
// full weight when either banking signal shows real market access.
// Component weights, total 1.0. Exported and named rather than inline literals
// so the calibration tests can blend against the SAME numbers production uses.
// A test that restates `0.35` / `0.30` in its own arithmetic silently diverges
// the moment a weight is retuned, and the divergence shows up as a wrong
// baseline rather than as a failure.
export const FIN_SYS_SHORT_TERM_DEBT_WEIGHT = 0.35;
export const FIN_SYS_BAND_WEIGHT = 0.30;
export const FIN_SYS_FATF_WEIGHT = 0.20;
export const FIN_SYS_REDUNDANCY_WEIGHT = 0.15;
// Component 4's goalposts, shared with the band premium's redundancy scale, and
// Component 1's (short-term external debt, % of GNI; lowerBetter).
//
// These are re-exported for the calibration mirror but MUST stay numeric
// literals at their call sites: `tests/helpers/resilience-scorer-doc-parity-specs.mts`
// parses this file's source text and asserts the normalizer anchors are literals
// so it can cross-check them against the methodology doc's goalposts. Naming
// them at the call site makes that gate fail closed ("anchors must be numeric
// literals"), which is the gate working as intended — the doc/code parity check
// cannot resolve an identifier.
export const FIN_SYS_REDUNDANCY_WORST_PARENTS = 1;
export const FIN_SYS_REDUNDANCY_BEST_PARENTS = 10;
export const FIN_SYS_DEBT_BEST_PCT_GNI = 0;
export const FIN_SYS_DEBT_WORST_PCT_GNI = 15;
export const FIN_SYS_MARKET_ACCESS_CONSTRAINED_DEBT_CERTAINTY = 0.3;
export const FIN_SYS_MARKET_ACCESS_LOW_DEBT_PCT_GNI_MAX = 1;
export const FIN_SYS_MARKET_ACCESS_LOW_CLAIMS_PCT_GDP_MAX = 5;

// Certainty for the band slot when its integration LEVEL resolved but parent
// BREADTH did not, so `normalizeDiversityConditionedBand` had to withhold the
// premium for absence of evidence. One of the slot's two designed inputs was
// observed, hence 0.5 — the fraction of the slot's evidence that arrived, on
// the same "retain the reading at reduced confidence" principle as #6461's
// market-access attenuation rather than a tuned constant.
export const FIN_SYS_BAND_BREADTH_UNOBSERVED_CERTAINTY = 0.5;

// Certainty for BOTH BIS-derived slots when the seed envelope reports an
// incomplete reporting-parent collection. The count is then an undercount of
// unknown size, so neither the redundancy reading nor the premium it scales is
// a full observation.
export const FIN_SYS_BIS_DEGRADED_PARENT_SET_CERTAINTY = 0.5;

/**
 * Certainty for the diversity-conditioned band slot.
 *
 * Two independent reasons the slot can be less than fully observed, and they
 * can co-occur, so the lower one wins rather than compounding:
 *   - breadth never resolved (`parentCount == null`) AND the raw band sits in
 *     the premium region, so the withheld premium actually cost the score
 *     something. Below the premium floor the conditioning is a no-op and the
 *     band is a pure level reading, fully observed.
 *   - the collection ran with an incomplete parent set, so any count it did
 *     produce is an undercount.
 *
 * Note the deliberate `null` vs `0` distinction: `parentCount === 0` is an
 * OBSERVATION (no parent clears the 1%-of-GDP counting threshold) and keeps
 * full certainty; `null` is an absence.
 */
function resolveFinSysBandCertainty(bisCountry: BisLbsCountry | null): number | undefined {
  if (bisCountry == null || bisCountry.totalXborderPctGdp == null) return undefined;
  const reductions: number[] = [];
  if (
    bisCountry.parentCount == null
    && normalizeBandLowerBetter(bisCountry.totalXborderPctGdp) > FIN_SYS_BAND_PREMIUM_FLOOR
  ) {
    reductions.push(FIN_SYS_BAND_BREADTH_UNOBSERVED_CERTAINTY);
  }
  if (!bisCountry.parentSetComplete) {
    reductions.push(FIN_SYS_BIS_DEGRADED_PARENT_SET_CERTAINTY);
  }
  return reductions.length === 0 ? undefined : Math.min(...reductions);
}

function isMarketAccessConstrainedDebtSignal(
  debtPct: number | null,
  bisCountry: BisLbsCountry | null,
): boolean {
  if (debtPct == null || debtPct < 0 || debtPct > FIN_SYS_MARKET_ACCESS_LOW_DEBT_PCT_GNI_MAX) return false;
  const claims = bisCountry?.totalXborderPctGdp;
  const parents = bisCountry?.parentCount;
  return claims != null
    && claims >= 0
    && claims < FIN_SYS_MARKET_ACCESS_LOW_CLAIMS_PCT_GDP_MAX
    && parents === 0;
}

// Upper bound on a plausible `parentCount`: the BIS CBS seeder counts parents
// from an enumerated list (`PARENT_COUNTRIES` in `scripts/seed-bis-lbs.mjs`, 16
// entries), so no country can legitimately report more. Used only when the
// envelope does not carry `parentCountries` to derive the bound from.
const FIN_SYS_BIS_REPORTING_PARENTS_MAX = 16;

/**
 * A `parentCount` the BIS seeder could actually have produced: it is
 * `Object.values(parents).filter(...).length` over an enumerated list, so a
 * legitimate value is a non-negative integer no larger than that list.
 *
 * The type, finiteness, integer, and range checks reject malformed or
 * impossible values. `readBisLbsCountry` keeps the nullable result for the
 * conditioning arithmetic, and separately records when a non-null raw field
 * failed these checks so the blend can retain its design weight with a
 * conservative fallback.
 *
 * An implausible value is therefore treated as absent for diversity evidence,
 * but not as an ordinary missing slot when it was present in the payload.
 * Genuine absence remains distinguishable and keeps the existing
 * coverage-weighted absence semantics.
 */
function readPlausibleParentCount(rawParentCount: unknown, maxParents: number): number | null {
  if (typeof rawParentCount !== 'number') return null;
  const numeric = safeNum(rawParentCount);
  if (numeric == null || !Number.isInteger(numeric) || numeric < 0 || numeric > maxParents) return null;
  return numeric;
}

function readBisLbsCountry(raw: unknown, countryCode: string): BisLbsCountry | null {
  if (raw == null || typeof raw !== 'object') return null;
  const countries = (raw as { countries?: Record<string, unknown> }).countries;
  if (!countries || typeof countries !== 'object') return null;
  const entry = countries[countryCode];
  if (!entry || typeof entry !== 'object') return null;
  const rawClaims = (entry as { totalXborderPctGdp?: unknown }).totalXborderPctGdp;
  const rawParentCount = (entry as { parentCount?: unknown }).parentCount;

  // Collection completeness is an envelope-level fact, not a per-country one:
  // the seeder publishes `successfulParents` alongside the `parentCountries`
  // list it attempted. Absent or malformed → assume complete, so a payload
  // predating the fields is not retroactively marked degraded.
  const rawParentCountries = (raw as { parentCountries?: unknown }).parentCountries;
  const attemptedParents = Array.isArray(rawParentCountries) && rawParentCountries.length > 0
    ? rawParentCountries.length
    : FIN_SYS_BIS_REPORTING_PARENTS_MAX;
  const rawSuccessfulParents = (raw as { successfulParents?: unknown }).successfulParents;
  const parentSetComplete = typeof rawSuccessfulParents === 'number'
    && Number.isFinite(rawSuccessfulParents)
    ? rawSuccessfulParents >= attemptedParents
    : true;

  const totalXborderPctGdp = typeof rawClaims === 'number' && rawClaims >= 0
    ? safeNum(rawClaims)
    : null;
  const parentCount = readPlausibleParentCount(rawParentCount, attemptedParents);

  return {
    // `safeNum(null)` and `safeNum('')` are numeric zero by design. These
    // fields use zero as a real financial-isolation signal, so require a raw
    // number rather than manufacturing an observed zero from malformed data.
    totalXborderPctGdp,
    parentCount,
    totalXborderPctGdpMalformed: rawClaims != null && totalXborderPctGdp == null,
    parentCountMalformed: rawParentCount != null && parentCount == null,
    parentSetComplete,
  };
}

type FatfStatus = 'black' | 'gray' | 'compliant';

interface FatfObservation {
  status: FatfStatus;
  assignedByAbsence: boolean;
}

function readFatfStatus(raw: unknown, countryCode: string): FatfObservation | null {
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
  if (status === 'black' || status === 'gray' || status === 'compliant') {
    return { status, assignedByAbsence: false };
  }
  // Unknown country = compliant (FATF only enumerates non-compliant
  // jurisdictions; absence from both lists means compliant).
  return { status: 'compliant', assignedByAbsence: true };
}

// #6459: gray rescaled 30 → 55. FATF grey-listing means "increased
// monitoring under an agreed action plan" — a jurisdiction actively
// remediating with FATF, not one a step away from the call-for-action
// black list. At 30 the gap to black (0) was 30 points and the gap to
// compliant (100) was 70, which put ordinary grey-listed economies closer
// to Iran and DPRK than to their actual peers. 55 keeps grey clearly
// penalised while leaving black as the distinct, much worse state.
//
// `compliant` stays at 100 for countries with other observed financial-system
// components. #6461 drops it only when it was assigned by absence and is the
// sole resolving component; listed gray/black jurisdictions remain real
// observations, and the comprehensive-embargo cap remains authoritative for
// its externally defined cohort.
const FATF_GRAY_SCORE = 55;

export function fatfStatusToScore(status: FatfStatus): number {
  switch (status) {
    case 'black': return 0;
    case 'gray': return FATF_GRAY_SCORE;
    case 'compliant': return 100;
  }
}

export async function scoreCyberDigital(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
  options?: CyberDiscoveryOptions,
): Promise<ResilienceDimensionScore> {
  const [cyberRaw, outagesRaw, gpsRaw] = await Promise.all([
    reader(RESILIENCE_CYBER_KEY),
    reader(RESILIENCE_OUTAGES_KEY),
    reader(RESILIENCE_GPS_KEY),
  ]);
  const cyber = summarizeCyber(cyberRaw, countryCode, options);
  const outages = summarizeOutages(outagesRaw, countryCode);
  const gps = summarizeGps(gpsRaw, countryCode);
  const outagePenalty = outages.total * 4 + outages.major * 2 + outages.partial;
  const gpsPenalty = gps.high * 3 + gps.medium;

  return weightedBlend([
    { score: hasNonEmptyArrayField(cyberRaw, 'threats') ? normalizeLowerBetter(cyber.weightedCount, 0, 25) : null, weight: 0.45 },
    { score: hasNonEmptyArrayField(outagesRaw, 'outages') ? normalizeLowerBetter(outagePenalty, 0, 20) : null, weight: 0.35 },
    { score: hasNonEmptyArrayField(gpsRaw, 'hexes') ? normalizeLowerBetter(gpsPenalty, 0, 20) : null, weight: 0.2 },
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
    { score: hasNonEmptyArrayField(outagesRaw, 'outages') ? normalizeLowerBetter(outagePenalty, 0, 20) : null, weight: 0.25 },
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
  // Net-import shares can exceed 100, so the product can also exceed
  // 100; normalizeLowerBetter(importedFossilDependence, 0, 100) clamps
  // those extreme importer cases at the worst anchor.
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
  return weightedBlend(getStaticWgiRows(staticRecord));
}

export async function scoreSocialCohesion(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [staticRecord, displacementRaw, unrestRaw, imfLaborRaw] = await Promise.all([
    readStaticCountry(countryCode, reader),
    readDisplacementSummaryWithFallback(reader),
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
  const unrestMetric = (unrest.unrestCount + sqrtCount(unrest.fatalities)) / popDenominator;

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
  //       impute unrest at curated_list_absent (50/0.3) because the
  //       unrest feed is non-comprehensive
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
    //       registry) → impute at curated_list_absent (50/0.3) to pull
    //       the blend down for tiny peaceful states (TV/PW/NR/MC).
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

// #3737 — despite the legacy `scoreBorderSecurity` / `borderSecurity` name,
// this scorer measures UCDP armed-conflict event intensity and UNHCR
// refugee displacement. It does NOT measure border-control infrastructure,
// customs throughput, or cross-border-crime enforcement.
//
// The user-facing label is "Conflict" / "Conflict & Displacement" in the
// widget and methodology docs respectively. The internal identifier is
// retained as `borderSecurity` because the proto enum, Redis cache prefixes,
// snapshot fixtures, and dozens of downstream tests are keyed on it — a
// rename would cascade through ~100 files for a string the user never sees.
//
// If/when this dimension is replaced with genuine border-control indicators
// (UNODC cross-border crime, FRONTEX/WCO data, CBP seizure stats), introduce
// the new dimension under a fresh id and migrate cleanly.
export async function scoreBorderSecurity(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [ucdpRaw, displacementRaw, imfLaborRaw] = await Promise.all([
    reader(RESILIENCE_UCDP_KEY),
    readDisplacementSummaryWithFallback(reader),
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
  const conflictMetric = (ucdp.eventCount * 2 + ucdp.typeWeight + sqrtCount(ucdp.deaths)) / popDenominator;
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

  // Language-coverage adjustment (fixes #3736).
  //
  // The previous implementation divided raw velocity + threatScore by
  // `langFactor` (range 0.2..1.0), which AMPLIFIED signal for countries with
  // sparse English-language news coverage by up to 5x. Effect: a small uptick
  // in coverage-poor countries scored worse than a substantial signal in
  // coverage-rich ones — exactly the inverse of what the data justifies.
  //
  // Correct framing: sparse English coverage means LOW CONFIDENCE in the
  // observable velocity/threat sub-signals, not a higher inferred underlying
  // signal. Apply `langFactor` to the WEIGHT of those sub-indicators, not to
  // the signal value itself. Raw signals flow through unchanged; coverage-poor
  // countries lean more heavily on the static RSF press-freedom indicator
  // (which IS coverage-independent and the most reliable annual signal).
  //
  // #3787 follow-up: the velocity/threat sub-indicators also pass `nominalWeight`
  // so that `weightedBlend` computes the dimension's `coverage` field against
  // the un-attenuated design-time weights (0.15 + 0.30 + 0.55 = 1.0). Without
  // this, attenuating `weight` would shrink the coverage denominator alongside
  // the numerator, and a minimal-coverage country reporting the same data shape
  // as a primary-coverage country would inadvertently report a HIGHER coverage
  // value — the inverse of the intended semantic. With nominalWeight, coverage
  // stays a stable measurement of "what fraction of designed signal we observed"
  // independent of the confidence-weighting applied to the score.
  const langFactor = getLanguageCoverageFactor(countryCode);

  return weightedBlend([
    { score: rsfScore == null ? null : normalizeLowerBetter(rsfScore, 0, 100), weight: 0.55 },
    { score: velocity > 0 ? normalizeLowerBetter(Math.log10(velocity + 1), 0, 3) : null, weight: 0.15 * langFactor, nominalWeight: 0.15 },
    { score: threatScore == null ? null : normalizeLowerBetter(threatScore, 0, 20), weight: 0.30 * langFactor, nominalWeight: 0.30 },
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
  // Gap-indicator fields (schemaVersion 2). Only populated when all 5
  // formula inputs share a common WEO year per latestCommonYear() in the
  // seeder. Otherwise null; the scorer's weightedBlend redistributes.
  primaryBalancePct?: number | null;
  realGdpGrowthPct?: number | null;
  inflationPct?: number | null;
  debtSustainabilityGapPct?: number | null;
  gapYear?: number | null;
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

const IMPORT_HHI_FULL_CONFIDENCE_MAX_SOURCE_AGE_YEARS = 4;
const IMPORT_HHI_MIN_STALE_CERTAINTY_COVERAGE = 0.3;

export function computeImportHhiCertaintyCoverage(
  sourceYear: number | null | undefined,
  nowYear = new Date().getFullYear(),
): number {
  if (!Number.isFinite(sourceYear) || !Number.isFinite(nowYear)) {
    return IMPORT_HHI_MIN_STALE_CERTAINTY_COVERAGE;
  }
  const ageYears = Math.trunc(nowYear) - Math.trunc(sourceYear as number);
  if (ageYears <= IMPORT_HHI_FULL_CONFIDENCE_MAX_SOURCE_AGE_YEARS) return 1;
  const staleYears = ageYears - IMPORT_HHI_FULL_CONFIDENCE_MAX_SOURCE_AGE_YEARS;
  return Math.max(
    IMPORT_HHI_MIN_STALE_CERTAINTY_COVERAGE,
    Number((1 - staleYears * 0.2).toFixed(2)),
  );
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

  // Weight rebalance + new indicator (debtSustainabilityGap) per
  // docs/archive/plans/add-debt-sustainability-gap-indicator.md. The gap (pb − pb*)
  // is the most informative single fiscal signal — it integrates pb, r,
  // g, and d with their interaction term — and earns the largest slice.
  // The other three are co-signals confirming the direction.
  //   sum = 0.25 + 0.20 + 0.20 + 0.35 = 1.0
  return weightedBlend([
    { score: entry.govRevenuePct == null ? null : normalizeHigherBetter(entry.govRevenuePct, 5, 45), weight: 0.25 },
    { score: entry.fiscalBalancePct == null ? null : normalizeHigherBetter(entry.fiscalBalancePct, -15, 5), weight: 0.20 },
    { score: entry.debtToGdpPct == null ? null : normalizeLowerBetter(entry.debtToGdpPct, 0, 150), weight: 0.20 },
    { score: entry.debtSustainabilityGapPct == null ? null : normalizeHigherBetter(entry.debtSustainabilityGapPct, -5, 3), weight: 0.35 },
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
// Re-export adjustment for the reserves-in-months denominator. Mirrors
// the `computeNetImports` correction that PR #3380 + #3385 wired into
// `scoreSovereignFiscalBuffer` via the SWF seeder. Reserves-in-months
// (WB FI.RES.TOTL.MO) is computed at WB source against gross imports;
// for re-export hubs (AE ≈35% re-export share, PA similar) the gross
// figure double-counts goods that flow through the territory without
// settling as domestic consumption, artificially shortening the
// implied buffer runway. Multiplying months by 1/(1-share) is the
// algebraic inverse of dividing the denominator by (1-share) — yields
// the same adjusted-months a custom reserves/(net-imports/12) calc
// would produce, without re-fetching raw FI.RES.TOTL.CD + raw
// BM.GSR.GNFS.CD series. Returns null for non-hub countries and for
// any malformed share value (defensive: clamp to [0, 1)).
async function readReexportShareForCountry(
  countryCode: string,
  reader: ResilienceSeedReader,
): Promise<number | null> {
  const raw = await reader(RESILIENCE_RECOVERY_REEXPORT_SHARE_KEY);
  const payload = raw as { countries?: Record<string, { reexportShareOfImports?: number | null } | undefined> } | null | undefined;
  const share = payload?.countries?.[countryCode]?.reexportShareOfImports;
  if (typeof share !== 'number' || !Number.isFinite(share)) return null;
  if (share < 0 || share >= 1) return null;
  return share;
}

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
  const reexportShare = await readReexportShareForCountry(countryCode, reader);
  const adjustedMonths = reexportShare !== null
    ? entry.reserveMonths / (1 - reexportShare)
    : entry.reserveMonths;
  return weightedBlend([
    { score: normalizeHigherBetter(Math.min(adjustedMonths, 12), 1, 12), weight: 1.0 },
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
    //
    // The seeder's normal 4-year Comtrade window remains full-confidence:
    // many late reporters publish 1-3 years behind. Older fallback vintages
    // still carry a real HHI signal, but coverage is derated so stale source
    // years reduce certainty instead of looking equivalent to current data.
    {
      score: normalizeLowerBetter(entry.hhi * 10000, 0, 5000),
      weight: 1.0,
      certaintyCoverage: computeImportHhiCertaintyCoverage(entry.year),
    },
  ]);
}

export async function scoreStateContinuity(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [staticRecord, ucdpRaw, displacementRaw] = await Promise.all([
    readStaticCountry(countryCode, reader),
    reader(RESILIENCE_UCDP_KEY),
    readDisplacementSummaryWithFallback(reader),
  ]);

  const wgiValues = getStaticWgiValues(staticRecord);
  const wgiMean = mean(wgiValues);

  const ucdpSummary = summarizeUcdp(ucdpRaw, countryCode);
  const ucdpRawScore = ucdpSummary.eventCount * 2 + ucdpSummary.typeWeight + sqrtCount(ucdpSummary.deaths);

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
// A dimension that is dark behind a feature flag is a deliberate construct
// state, not a data gap, so it must not drag down user-facing confidence and
// coverage while it waits for its seeder rollout.
//
// This is load-bearing, not cosmetic. `headlineEligible` gates public ranking
// inclusion on `overallCoverage >= 0.65`, and the coverage mean is taken across
// dimensions — so every dark dimension pulls every country's coverage down. With
// `education` counted, the US happy-path build fell below the threshold and
// dropped out of the headline ranking entirely.
//
// RECONCILIATION, updated 2026-08-13 for the finance activation (#6511). The
// prior note here said the two dark dimensions "should be reconciled together
// when either flag flips". Education flipped on 2026-08-11 and
// `financialSystemExposure` is now live in production through its owner-set
// environment flag. Keep finance OUT of this exclusion set:
//
//   - Adding it would change `overallCoverage` for every country, and
//     `headlineEligible` gates public ranking inclusion on `>= 0.65`. That is a
//     published-number change for all 196 countries and needs its own
//     measurement and its own cache-generation reasoning — it cannot ride along
//     with a different dimension's activation.
//   - #6459's retuned construct has now completed its separate activation phase;
//     active observations and source failures must remain visible in confidence
//     and headline eligibility. The code default remains false for CI and for
//     the explicit production rollback path, but production runs with the
//     owner-controlled flag on.
//
// Education remains in this set after activation for its explicit false
// rollback. The triple-zero discriminator below means active observations and
// source failures automatically rejoin the confidence and pillar means.
export const RESILIENCE_FLAG_DARK_WHEN_ZERO_COVERAGE: ReadonlySet<ResilienceDimensionId> = new Set([
  'education',
]);

export function isFlagDarkDimension(
  dimension: { id: string; coverage: number; observedWeight?: number; imputedWeight?: number },
): boolean {
  const id = dimension.id as ResilienceDimensionId;
  return RESILIENCE_FLAG_DARK_WHEN_ZERO_COVERAGE.has(id)
    && dimension.coverage === 0
    && (dimension.observedWeight ?? 0) === 0
    && (dimension.imputedWeight ?? 0) === 0;
}

export function isExcludedFromConfidenceMean(
  dimension: { id: string; coverage: number; observedWeight?: number; imputedWeight?: number },
): boolean {
  const id = dimension.id as ResilienceDimensionId;
  if (RESILIENCE_RETIRED_DIMENSIONS.has(id)) return true;
  // Same triple-zero fingerprint as the not-applicable path below: a dark dim
  // emits score=0/coverage=0/observedWeight=0/imputedWeight=0. Once the flag
  // flips the dim carries real coverage and rejoins the mean automatically.
  if (isFlagDarkDimension(dimension)) return true;
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
  education: scoreEducation,
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
  const statcanUsed = countryCode === 'CA'
    ? statcanOverlayUsed(await memoizedReader(RESILIENCE_STATCAN_WDS_KEY))
    : undefined;
  const [entries, freshnessMap, failedDatasets, standaloneFailures] = await Promise.all([
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
    readStandaloneSourceFailureDimensions(memoizedReader, undefined, countryCode, statcanUsed),
  ]);
  const scores = Object.fromEntries(entries) as Record<ResilienceDimensionId, ResilienceDimensionScore>;

  // T1.5 freshness decoration pass. Attach dimension-level freshness
  // derived from the aggregated seed-meta map. Runs before the T1.7
  // source-failure pass because source-failure only touches
  // imputationClass and does not interact with freshness.
  // CA inflation/unemployment that consumed StatCan must stamp StatCan
  // seed-meta, not the IMF registry key the overlay replaced.
  for (const dimensionId of RESILIENCE_DIMENSION_ORDER) {
    scores[dimensionId] = {
      ...scores[dimensionId],
      freshness: classifyDimensionFreshness(dimensionId, freshnessMap, undefined, countryCode, statcanUsed),
    };
  }

  // T1.7 source-failure wiring. Static adapter failures come from
  // seed-meta:resilience:static.failedDatasets; standalone seeders come
  // from their own seed-meta status/freshness via the registry meta-key
  // resolver. Any affected dimension that is already fully imputed gets
  // re-tagged from the table default (stable-absence / unmonitored) to
  // source-failure. Real-data and not-applicable dimensions are untouched:
  // a seed failing does not invalidate a country that was served from prior
  // snapshot data or a structural non-applicability path.
  const affected = failedDimensionsFromDatasets(failedDatasets, countryCode);
  for (const dimId of standaloneFailures.dimensions) {
    affected.add(dimId);
  }
  if (affected.size > 0) {
    // Single info log per request so ops can see which sources went down
    // without having to dump Redis. The country code is included because
    // scoreAllDimensions runs per-country; a flood of these during a failed
    // seed window is the expected signal.
    console.info(
      `[Resilience] source-failure decoration country=${countryCode} failedDatasets=${failedDatasets.join(',')} failedMetaKeys=${standaloneFailures.failedMetaKeys.join(',')} affectedDimensions=${[...affected].join(',')}`,
    );
    for (const dimId of affected) {
      const current = scores[dimId];
      // Only re-tag fully imputed dimensions. Dimensions with any observed
      // weight keep their existing null class, and structural
      // not-applicable paths keep imputedWeight=0.
      if (
        current != null
        && current.imputationClass != null
        && current.observedWeight === 0
        && current.imputedWeight > 0
      ) {
        scores[dimId] = { ...current, imputationClass: 'source-failure' };
      }
    }
  }

  return scores;
}

export function getResilienceDomainWeight(domainId: ResilienceDomainId): number {
  return RESILIENCE_DOMAIN_WEIGHTS[domainId];
}
