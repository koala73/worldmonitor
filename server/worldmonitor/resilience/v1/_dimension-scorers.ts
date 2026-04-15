import countryNames from '../../../../shared/country-names.json';
import iso2ToIso3Json from '../../../../shared/iso2-to-iso3.json';
import { normalizeCountryToken } from '../../../_shared/country-token';
import { getCachedJson } from '../../../_shared/redis';
import { classifyDimensionFreshness, readFreshnessMap } from './_dimension-freshness';
import { getLanguageCoverageFactor } from './_language-coverage';
import { failedDimensionsFromDatasets, readFailedDatasets } from './_source-failure';

export type ResilienceDimensionId =
  | 'macroFiscal'
  | 'currencyExternal'
  | 'tradeSanctions'
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
  | 'reserveAdequacy'
  | 'externalDebtCoverage'
  | 'importConcentration'
  | 'stateContinuity'
  | 'fuelStockDays';

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
  recoveryReserveAdequacy: { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
  recoveryExternalDebt:    { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
  recoveryImportHhi:       { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
  recoveryStateContinuity: { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
  recoveryFuelStocks:      { score: 50, certaintyCoverage: 0.3, imputationClass: 'unmonitored' },
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

interface BisExchangeRate {
  countryCode?: string;
  realEer?: number;
  realChange?: number;
  date?: string;
}

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
const RESILIENCE_BIS_EXCHANGE_KEY = 'economic:bis:eer:v1';
const RESILIENCE_BIS_DSR_KEY = 'economic:bis:dsr:v1';
const RESILIENCE_NATIONAL_DEBT_KEY = 'economic:national-debt:v1';
const RESILIENCE_IMF_MACRO_KEY = 'economic:imf:macro:v2';
const RESILIENCE_IMF_LABOR_KEY = 'economic:imf:labor:v1';
const RESILIENCE_SANCTIONS_KEY = 'sanctions:country-counts:v1';
const RESILIENCE_TRADE_RESTRICTIONS_KEY = 'trade:restrictions:v1:tariff-overview:50';
const RESILIENCE_TRADE_BARRIERS_KEY = 'trade:barriers:v1:tariff-gap:50';
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
const RESILIENCE_RECOVERY_FUEL_STOCKS_KEY = 'resilience:recovery:fuel-stocks:v1';

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

export const RESILIENCE_DIMENSION_DOMAINS: Record<ResilienceDimensionId, ResilienceDomainId> = {
  macroFiscal: 'economic',
  currencyExternal: 'economic',
  tradeSanctions: 'economic',
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
};

export const RESILIENCE_DIMENSION_ORDER: ResilienceDimensionId[] = [
  'macroFiscal',
  'currencyExternal',
  'tradeSanctions',
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
  'reserveAdequacy',
  'externalDebtCoverage',
  'importConcentration',
  'stateContinuity',
  'fuelStockDays',
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
  tradeSanctions: 'stress',
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

// Piecewise scale: 0=100, 1-10=90-75, 11-50=75-50, 51-200=50-25, 201+=25→0
function normalizeSanctionCount(count: number): number {
  if (count === 0) return 100;
  if (count <= 10) return roundScore(90 - (count - 1) * (15 / 9));
  if (count <= 50) return roundScore(75 - (count - 10) * (25 / 40));
  if (count <= 200) return roundScore(50 - (count - 50) * (25 / 150));
  return roundScore(Math.max(0, 25 - (count - 200) * 0.1));
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values);
  if (avg == null) return null;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

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

function dateToSortableNumber(value: unknown): number {
  if (typeof value === 'string') {
    const compact = value.replace(/[^0-9]/g, '');
    const numeric = Number(compact);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

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

function getCountryBisExchangeRates(raw: unknown, countryCode: string): BisExchangeRate[] {
  const rates: BisExchangeRate[] = Array.isArray((raw as { rates?: unknown[] } | null)?.rates)
    ? ((raw as { rates?: BisExchangeRate[] }).rates ?? [])
    : [];
  return rates
    .filter((entry) => matchesCountryIdentifier(entry.countryCode, countryCode))
    .sort((left, right) => dateToSortableNumber(left.date) - dateToSortableNumber(right.date));
}

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

function countTradeRestrictions(raw: unknown, countryCode: string): number {
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

function countTradeBarriers(raw: unknown, countryCode: string): number {
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

function summarizeOutages(raw: unknown, countryCode: string): { total: number; major: number; partial: number } {
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

function summarizeGps(raw: unknown, countryCode: string): { high: number; medium: number } {
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

function summarizeCyber(raw: unknown, countryCode: string): { weightedCount: number } {
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

function summarizeUnrest(raw: unknown, countryCode: string): { unrestCount: number; fatalities: number } {
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

function summarizeUcdp(raw: unknown, countryCode: string): { eventCount: number; deaths: number; typeWeight: number } {
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

function getCountryDisplacement(raw: unknown, countryCode: string): CountryDisplacement | null {
  const summary = (raw as { summary?: { countries?: CountryDisplacement[] } } | null)?.summary;
  const countries = Array.isArray(summary?.countries) ? summary.countries : [];
  return countries.find((entry) => matchesCountryIdentifier(entry.code, countryCode)) ?? null;
}

function summarizeSocialVelocity(raw: unknown, countryCode: string): number {
  const posts: SocialVelocityPost[] = Array.isArray((raw as { posts?: unknown[] } | null)?.posts)
    ? ((raw as { posts?: SocialVelocityPost[] }).posts ?? [])
    : [];
  return posts.reduce((sum, post) => sum + (matchesCountryText(post.title, countryCode) ? (safeNum(post.velocityScore) ?? 0) : 0), 0);
}

function getThreatSummaryScore(raw: unknown, countryCode: string): number | null {
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

export async function scoreCurrencyExternal(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [bisExchangeRaw, imfMacroRaw, staticRecord] = await Promise.all([
    reader(RESILIENCE_BIS_EXCHANGE_KEY),
    reader(RESILIENCE_IMF_MACRO_KEY),
    readStaticCountry(countryCode, reader),
  ]);
  const countryRates = getCountryBisExchangeRates(bisExchangeRaw, countryCode);
  const latest = countryRates[countryRates.length - 1] ?? null;
  const volSource = countryRates
    .map((entry) => safeNum(entry.realChange))
    .filter((value): value is number => value != null)
    .slice(-12);
  const vol = volSource.length >= 2
    ? (stddev(volSource) ?? 0) * Math.sqrt(12)
    : volSource.length === 1
      ? Math.abs(volSource[0]!) * Math.sqrt(12)
      : null;

  const reservesMonths = getFxReservesMonths(staticRecord);
  const reservesScore = reservesMonths != null ? scoreFxReserves(reservesMonths) : null;

  // Country not in BIS EER (curated ~40 economies), or BIS seed is down entirely.
  // Use IMF CPI inflation + WB FX reserves as currency stability proxies.
  // Inflation covers ~185 countries, reserves ~160 countries via World Bank FI.RES.TOTL.MO.
  if (countryRates.length === 0) {
    const imfEntry = getImfMacroEntry(imfMacroRaw, countryCode);
    const hasInflation = imfMacroRaw != null && imfEntry?.inflationPct != null;
    const hasReserves = reservesScore != null;

    if (hasInflation && hasReserves) {
      const inflScore = normalizeLowerBetter(Math.min(imfEntry!.inflationPct!, 50), 0, 50);
      const blended = inflScore * 0.6 + reservesScore * 0.4;
      const coverage = bisExchangeRaw != null ? 0.55 : 0.45;
      return { score: roundScore(blended), coverage, observedWeight: 1, imputedWeight: 0, imputationClass: null, freshness: { lastObservedAtMs: 0, staleness: '' } };
    }
    if (hasInflation) {
      const coverage = bisExchangeRaw != null ? 0.45 : 0.35;
      return { score: normalizeLowerBetter(Math.min(imfEntry!.inflationPct!, 50), 0, 50), coverage, observedWeight: 1, imputedWeight: 0, imputationClass: null, freshness: { lastObservedAtMs: 0, staleness: '' } };
    }
    if (hasReserves) {
      const coverage = bisExchangeRaw != null ? 0.4 : 0.3;
      return { score: reservesScore, coverage, observedWeight: 1, imputedWeight: 0, imputationClass: null, freshness: { lastObservedAtMs: 0, staleness: '' } };
    }
    // No BIS EER, no IMF inflation fallback, no WB reserves fallback.
    // This is true structural absence: the country isn't covered by any
    // currency-stability source we track. Tag with curated_list_absent
    // (= 'unmonitored') so the taxonomy is the single source of truth
    // and the aggregation pass can still re-tag it as 'source-failure'
    // when the underlying adapter fails. The prior absence-based branch
    // returned { score: 50, imputationClass: null } which silently
    // bypassed the taxonomy; replaced in T1.7 source-failure wiring.
    return {
      score: IMPUTE.bisEer.score,
      coverage: IMPUTE.bisEer.certaintyCoverage,
      observedWeight: 0,
      imputedWeight: 1,
      imputationClass: IMPUTE.bisEer.imputationClass,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }

  // BIS EER data present: volatility + deviation are primary, reserves supplementary.
  return weightedBlend([
    { score: vol == null ? null : normalizeLowerBetter(vol, 0, 50), weight: 0.6 },
    { score: latest == null ? null : normalizeLowerBetter(Math.abs((safeNum(latest.realEer) ?? 100) - 100), 0, 35), weight: 0.25 },
    { score: reservesScore, weight: 0.15 },
  ]);
}

export async function scoreTradeSanctions(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [sanctionsRaw, restrictionsRaw, barriersRaw, staticRecord] = await Promise.all([
    reader(RESILIENCE_SANCTIONS_KEY),
    reader(RESILIENCE_TRADE_RESTRICTIONS_KEY),
    reader(RESILIENCE_TRADE_BARRIERS_KEY),
    readStaticCountry(countryCode, reader),
  ]);

  // sanctions:country-counts:v1 is a plain ISO2→entryCount map covering ALL countries.
  const sanctionsCounts = sanctionsRaw as Record<string, number> | null;
  const sanctionCount = sanctionsCounts != null ? (sanctionsCounts[countryCode] ?? 0) : null;
  const restrictionCount = countTradeRestrictions(restrictionsRaw, countryCode);
  const barrierCount = countTradeBarriers(barriersRaw, countryCode);

  const inRestrictionsReporterSet = isInWtoReporterSet(restrictionsRaw, countryCode);
  const inBarriersReporterSet = isInWtoReporterSet(barriersRaw, countryCode);

  // WB TM.TAX.MRCH.WM.AR.ZS: Tariff rate, applied, weighted mean, all products (%).
  // 0% = perfect free trade (score 100), 20%+ = heavily restricted (score 0).
  const tariffRate = safeNum(staticRecord?.appliedTariffRate?.value);

  return weightedBlend([
    sanctionsRaw == null
      ? { score: null, weight: 0.45 }
      : { score: normalizeSanctionCount(sanctionCount ?? 0), weight: 0.45 },
    restrictionsRaw == null
      ? { score: null, weight: 0.15 }
      : !inRestrictionsReporterSet
        ? { score: IMPUTE.wtoData.score, weight: 0.15, certaintyCoverage: IMPUTE.wtoData.certaintyCoverage, imputed: true, imputationClass: IMPUTE.wtoData.imputationClass }
        : { score: normalizeLowerBetter(restrictionCount, 0, 30), weight: 0.15 },
    barriersRaw == null
      ? { score: null, weight: 0.15 }
      : !inBarriersReporterSet
        ? { score: IMPUTE.wtoData.score, weight: 0.15, certaintyCoverage: IMPUTE.wtoData.certaintyCoverage, imputed: true, imputationClass: IMPUTE.wtoData.imputationClass }
        : { score: normalizeLowerBetter(barrierCount, 0, 40), weight: 0.15 },
    { score: tariffRate == null ? null : normalizeLowerBetter(tariffRate, 0, 20), weight: 0.25 },
  ]);
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
  const tradeExposure = staticRecord == null ? null : (tradeToGdp != null ? Math.min(tradeToGdp / 50, 1.0) : 0.5);

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

export async function scoreEnergy(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
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
  const [staticRecord, displacementRaw, unrestRaw] = await Promise.all([
    readStaticCountry(countryCode, reader),
    reader(`${RESILIENCE_DISPLACEMENT_PREFIX}:${new Date().getFullYear()}`),
    reader(RESILIENCE_UNREST_KEY),
  ]);
  const gpiScore = safeNum(staticRecord?.gpi?.score);
  const displacement = getCountryDisplacement(displacementRaw, countryCode);
  const unrest = summarizeUnrest(unrestRaw, countryCode);
  const displacementMetric = safeNum(displacement?.totalDisplaced);
  const unrestMetric = unrest.unrestCount + Math.sqrt(unrest.fatalities);

  return weightedBlend([
    // GPI empirical range: 1.1 (Iceland) – 3.4 (Yemen 2024). Anchor worst=3.6 (slightly
    // above observed max) so the worst-peace countries score near 0, not 20.
    // The old anchor of 4.0 gave Yemen (3.4) a score of 20 instead of ~8.
    { score: gpiScore == null ? null : normalizeLowerBetter(gpiScore, 1.0, 3.6), weight: 0.55 },
    {
      score: displacementMetric == null
        ? null
        : normalizeLowerBetter(Math.log10(Math.max(1, displacementMetric)), 0, 7),
      weight: 0.25,
    },
    { score: unrestRaw != null ? normalizeLowerBetter(unrestMetric, 0, 20) : null, weight: 0.2 },
  ]);
}

export async function scoreBorderSecurity(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const [ucdpRaw, displacementRaw] = await Promise.all([
    reader(RESILIENCE_UCDP_KEY),
    reader(`${RESILIENCE_DISPLACEMENT_PREFIX}:${new Date().getFullYear()}`),
  ]);
  const ucdp = summarizeUcdp(ucdpRaw, countryCode);
  const displacement = getCountryDisplacement(displacementRaw, countryCode);
  const conflictMetric = ucdp.eventCount * 2 + ucdp.typeWeight + Math.sqrt(ucdp.deaths);
  const displacementMetric = safeNum(displacement?.hostTotal) ?? safeNum(displacement?.totalDisplaced);

  return weightedBlend([
    { score: ucdpRaw != null ? normalizeLowerBetter(conflictMetric, 0, 30) : null, weight: 0.65 },
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

interface RecoveryFuelStocksCountry {
  fuelStockDays?: number | null;
  meetsObligation?: boolean | null;
  belowObligation?: boolean | null;
}

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

export async function scoreReserveAdequacy(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const raw = await reader(RESILIENCE_RECOVERY_RESERVE_ADEQUACY_KEY);
  const entry = getRecoveryCountryEntry<RecoveryReserveAdequacyCountry>(raw, countryCode);
  if (!entry || entry.reserveMonths == null) {
    return {
      score: IMPUTE.recoveryReserveAdequacy.score,
      coverage: IMPUTE.recoveryReserveAdequacy.certaintyCoverage,
      observedWeight: 0,
      imputedWeight: 1,
      imputationClass: IMPUTE.recoveryReserveAdequacy.imputationClass,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }
  return weightedBlend([
    { score: normalizeHigherBetter(Math.min(entry.reserveMonths, 18), 1, 18), weight: 1.0 },
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
  return weightedBlend([
    { score: normalizeLowerBetter(entry.debtToReservesRatio, 0, 5), weight: 1.0 },
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

export async function scoreFuelStockDays(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<ResilienceDimensionScore> {
  const raw = await reader(RESILIENCE_RECOVERY_FUEL_STOCKS_KEY);
  const entry = getRecoveryCountryEntry<RecoveryFuelStocksCountry>(raw, countryCode);
  // The seeder writes `fuelStockDays`, not `stockDays`.
  if (!entry || entry.fuelStockDays == null) {
    return {
      score: IMPUTE.recoveryFuelStocks.score,
      coverage: IMPUTE.recoveryFuelStocks.certaintyCoverage,
      observedWeight: 0,
      imputedWeight: 1,
      imputationClass: IMPUTE.recoveryFuelStocks.imputationClass,
      freshness: { lastObservedAtMs: 0, staleness: '' },
    };
  }
  return weightedBlend([
    { score: normalizeHigherBetter(Math.min(entry.fuelStockDays, 120), 0, 120), weight: 1.0 },
  ]);
}

export const RESILIENCE_DIMENSION_SCORERS: Record<
ResilienceDimensionId,
(countryCode: string, reader?: ResilienceSeedReader) => Promise<ResilienceDimensionScore>
> = {
  macroFiscal: scoreMacroFiscal,
  currencyExternal: scoreCurrencyExternal,
  tradeSanctions: scoreTradeSanctions,
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
};

export async function scoreAllDimensions(
  countryCode: string,
  reader: ResilienceSeedReader = defaultSeedReader,
): Promise<Record<ResilienceDimensionId, ResilienceDimensionScore>> {
  const memoizedReader = createMemoizedSeedReader(reader);
  const [entries, freshnessMap, failedDatasets] = await Promise.all([
    Promise.all(
      RESILIENCE_DIMENSION_ORDER.map(async (dimensionId) => [
        dimensionId,
        await RESILIENCE_DIMENSION_SCORERS[dimensionId](countryCode, memoizedReader),
      ] as const),
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
