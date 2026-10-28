import filterParamContracts from '../../../../shared/openapi-filter-param-contracts.json';

// Crude exporters whose loadings sit inside the Strait of Hormuz, per EIA
// "World Oil Transit Chokepoints" (Saudi Arabia, Iraq, Kuwait, UAE, Iran, Qatar,
// Bahrain). Oman (512) loads outside the Strait and is deliberately absent.
// UN M49 numeric codes, as Comtrade reports partners.
export const GULF_PARTNER_CODES = new Set(['682', '784', '368', '414', '364', '634', '048']);
export const GULF_PARTNER_ISO2 = new Set(['SA', 'AE', 'IQ', 'KW', 'IR', 'QA', 'BH']);
export const GULF_SHARE_SOURCE_LABEL = 'SA, AE, IQ, KW, IR, QA, BH';

export const VALID_CHOKEPOINTS = new Set(filterParamContracts.intelligenceChokepointIds);
export const VALID_FUEL_MODES = new Set(filterParamContracts.intelligenceFuelModes);

const CHOKEPOINT_DISPLAY_NAMES: Record<string, string> = {
  hormuz_strait: 'Strait of Hormuz',
  malacca_strait: 'Strait of Malacca',
  suez: 'Suez Canal',
  bab_el_mandeb: 'Bab el-Mandeb',
};

function chokepointLabel(id: string): string {
  return CHOKEPOINT_DISPLAY_NAMES[id] ?? id.replace(/_/g, ' ');
}

// Intl.DisplayNames is available in Node 20+ and Vercel edge runtime; fall back to the raw ISO2
// if instantiation fails (unexpected locales, etc.) so assessment text never crashes.
let regionNames: { of(code: string): string | undefined } | null = null;
try {
  regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  regionNames = null;
}

function countryLabel(iso2: string): string {
  const resolved = regionNames?.of(iso2);
  return resolved && resolved !== iso2 ? resolved : iso2;
}

export const CHOKEPOINT_EXPOSURE: Record<string, number> = {
  hormuz_strait: 1.0,
  bab_el_mandeb: 1.0,
  suez: 0.6,
  malacca_strait: 0.7,
};

export const REFINERY_YIELD: Record<string, number> = {
  Gasoline: 0.44,
  Diesel: 0.30,
  'Jet fuel': 0.10,
  LPG: 0.05,
};

export const REFINERY_YIELD_BASIS = 'refinery yields: US-average EIA basis, gasoline 44%, diesel 30%, jet 10%, LPG 5%';

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export interface ComtradeFlowLike {
  tradeValueUsd: number;
  partnerCode: string | number;
}

export function computeGulfShare(flows: ComtradeFlowLike[]): { share: number; hasData: boolean } {
  let totalImports = 0;
  let gulfImports = 0;
  for (const flow of flows) {
    if (/^0+$/.test(String(flow.partnerCode))) continue;
    const val = Number.isFinite(flow.tradeValueUsd) ? flow.tradeValueUsd : 0;
    if (val <= 0) continue;
    totalImports += val;
    if (GULF_PARTNER_CODES.has(String(flow.partnerCode))) {
      gulfImports += val;
    }
  }
  if (totalImports === 0) return { share: 0, hasData: false };
  return { share: gulfImports / totalImports, hasData: true };
}

/** One HS heading of `comtrade:bilateral-hs4-partners:{iso2}:v1` (see supply-chain `PartnersProduct`). */
export interface PartnerShareProductLike {
  hs4?: string;
  year?: number;
  totalValue?: number | null;
  partners?: Array<{ partnerCode?: number | string; partnerIso2?: string; value?: number | null }> | null;
  omittedCount?: number;
  omittedShare?: number;
}

export interface GulfShareMeasurement {
  share: number;
  hasData: boolean;
  /** Comtrade reference year of the measurement; undefined when hasData is false. */
  year?: number;
  /** Fraction of imports held by partners the seeder dropped below its listing threshold. */
  omittedShare?: number;
}

/**
 * Gulf share of a reporter's crude imports from the partner-level HS 2709 row
 * the bilateral seeder publishes: Σ value(Gulf partners) / reported World total.
 * The World total is the denominator, so a partner the seeder omitted below its
 * listing threshold lowers the share by at most `omittedShare`.
 */
export function computeGulfShareFromPartners(product: PartnerShareProductLike | null | undefined): GulfShareMeasurement {
  if (!product || !Array.isArray(product.partners)) return { share: 0, hasData: false };
  const total = product.totalValue;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return { share: 0, hasData: false };
  let gulf = 0;
  for (const partner of product.partners) {
    const value = partner?.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    const iso2 = typeof partner.partnerIso2 === 'string' ? partner.partnerIso2.toUpperCase() : '';
    const code = partner.partnerCode != null ? String(partner.partnerCode).padStart(3, '0') : '';
    if (GULF_PARTNER_ISO2.has(iso2) || GULF_PARTNER_CODES.has(code)) gulf += value;
  }
  const omittedShare = typeof product.omittedShare === 'number' && Number.isFinite(product.omittedShare) && product.omittedShare > 0
    ? product.omittedShare : undefined;
  return {
    share: Math.min(gulf / total, 1),
    hasData: true,
    year: typeof product.year === 'number' && Number.isFinite(product.year) ? product.year : undefined,
    omittedShare,
  };
}

/**
 * Upper bound on shock scenario output days. Beyond this, the model is no longer meaningful;
 * a reader should understand the country as "indefinitely bridgeable" at the given deficit rate.
 * See #2971: raw output like 19,200 days (52 years) destroyed trust in the panel.
 *
 * Set to 730 (2 years) so legitimate ~365-day computations stay numeric and informative;
 * the cap only triggers for clearly-absurd outputs.
 */
export const EFFECTIVE_COVER_DAYS_CAP = 730;

export function computeEffectiveCoverDays(
  daysOfCover: number,
  netExporter: boolean,
  crudeLossKbd: number,
  crudeImportsKbd: number,
): number {
  if (netExporter) return -1;
  if (daysOfCover > 0 && crudeLossKbd > 0 && crudeImportsKbd > 0) {
    const raw = Math.round(daysOfCover / (crudeLossKbd / crudeImportsKbd));
    // Cap runaway outputs (small-deficit denominator blow-up). Consumers check against the cap
    // to render "indefinitely bridgeable" prose.
    return Math.min(raw, EFFECTIVE_COVER_DAYS_CAP);
  }
  return Math.min(daysOfCover, EFFECTIVE_COVER_DAYS_CAP);
}

/**
 * Observed crude imports (JODI) and a measured Gulf import share (Comtrade
 * partner rows) are both required inputs of the oil loss: without either the
 * scenario is unsupported, not partially modeled. IEA stocks and live shipping
 * only refine a supported scenario.
 */
export function deriveCoverageLevel(
  jodiOil: boolean,
  comtrade: boolean,
  ieaStocksCoverage?: boolean,
  degraded?: boolean,
): 'full' | 'partial' | 'unsupported' {
  if (!jodiOil || !comtrade) return 'unsupported';
  if (ieaStocksCoverage === false || degraded) return 'partial';
  return 'full';
}

export function deriveChokepointConfidence(
  liveFlowRatio: number | null,
  degraded: boolean,
): 'high' | 'low' | 'none' {
  if (degraded || liveFlowRatio === null || !Number.isFinite(liveFlowRatio)) return 'none';
  return 'high';
}

export function buildAssessment(
  code: string,
  chokepointId: string,
  dataAvailable: boolean,
  gulfCrudeShare: number,
  effectiveCoverDays: number,
  daysOfCover: number,
  disruptionPct: number,
  products: Array<{ product: string; deficitPct: number }>,
  coverageLevel?: 'full' | 'partial' | 'unsupported',
  degraded?: boolean,
  ieaStocksCoverage?: boolean,
  comtradeCoverage?: boolean,
): string {
  const country = countryLabel(code);
  const cp = chokepointLabel(chokepointId);
  if (!dataAvailable) {
    return `Insufficient import data for ${country} to model ${cp} exposure.`;
  }
  // Observed imports but no partner-level origin share: the loss is not modeled.
  // A fixed proxy share used to fill this gap; it read as a measurement.
  if (comtradeCoverage === false || coverageLevel === 'unsupported') {
    return `Crude import origin data is unavailable for ${country}; ${cp} oil exposure is not modeled.`;
  }
  if (effectiveCoverDays === -1) {
    return `${country} is a net oil exporter; ${cp} disruption affects export revenue, not domestic supply.`;
  }
  // Reached only with a measured share (the branch above returns otherwise).
  if (gulfCrudeShare < 0.1) {
    return `${country} has low Gulf crude dependence (${Math.round(gulfCrudeShare * 100)}%); ${cp} disruption has limited direct impact.`;
  }
  const degradedNote = degraded ? ' (live flow data unavailable, using historical baseline)' : '';
  const ieaCoverText = ieaStocksCoverage === false ? 'unknown' : `${daysOfCover} days`;
  if (effectiveCoverDays >= EFFECTIVE_COVER_DAYS_CAP) {
    return `With ${daysOfCover} days IEA cover, ${code} is indefinitely bridgeable against a ${disruptionPct}% ${chokepointId} disruption at this deficit rate${degradedNote}.`;
  }
  if (effectiveCoverDays > 90) {
    return `With ${daysOfCover} days IEA cover, ${country} can bridge a ${disruptionPct}% ${cp} disruption for ~${effectiveCoverDays} days${degradedNote}.`;
  }
  const worst = products.reduce<{ product: string; deficitPct: number }>(
    (best, p) => (p.deficitPct > best.deficitPct ? p : best),
    { product: '', deficitPct: 0 },
  );
  const worstDeficit = worst.deficitPct;
  const worstProduct = worst.product.toLowerCase();
  return `${country} faces ${worstDeficit.toFixed(1)}% ${worstProduct} deficit under ${disruptionPct}% ${cp} disruption; IEA cover: ${ieaCoverText}${degradedNote}.`;
}

// Fixed, assumed fraction of an importer's LNG that uses each route. Hormuz is
// absent on purpose: its fraction is the measured Qatar + UAE share of the
// importer's LNG (LNG_HORMUZ_SHARE_KEY), and an importer without one is
// reported as unavailable, never given a flat 30%.
export const CHOKEPOINT_LNG_EXPOSURE: Record<string, number> = {
  malacca_strait: 0.50,
  suez: 0.20,
  bab_el_mandeb: 0.20,
};

/**
 * Written by scripts/seed-comtrade-bilateral-hs4.mjs (scripts/shared/comtrade-lng-origin.mjs).
 * tests/energy-shock-lng-origin.test.mjs seeds it through the seeder's own
 * constant, so the two names cannot drift apart unnoticed.
 */
export const LNG_HORMUZ_SHARE_KEY = 'comtrade:lng-hormuz-share:v1';

export const GAS_MODEL_BASIS = {
  /** Hormuz: the route fraction is the importer's measured Qatar + UAE share of LNG imports. */
  measured: 'comtrade_lng_origin_share',
  /** Zero recorded LNG imports: the loss is zero whatever the route fraction. */
  zeroLng: 'observed_zero_lng_imports',
  /** Other chokepoints: the fixed CHOKEPOINT_LNG_EXPOSURE fraction. */
  assumed: 'assumed_route_sensitivity',
} as const;

/** One stored baseline of the LNG origin snapshot, validated. */
export interface LngShareBaselineEntry {
  basis: 'comtrade_monthly' | 'comtrade_annual';
  fromMonth: string;
  toMonth: string;
  monthsCovered: number;
  share: number;
  measure: 'weight' | 'value';
  unattributedShare: number;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A stored baseline, or undefined when any field is missing or out of range. */
export function readLngShareBaseline(raw: unknown): LngShareBaselineEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Record<string, unknown>;
  if (b.basis !== 'comtrade_monthly' && b.basis !== 'comtrade_annual') return undefined;
  if (typeof b.fromMonth !== 'string' || !MONTH.test(b.fromMonth) || typeof b.toMonth !== 'string' || !MONTH.test(b.toMonth) || b.fromMonth > b.toMonth) return undefined;
  if (typeof b.monthsCovered !== 'number' || !Number.isInteger(b.monthsCovered) || b.monthsCovered < 1 || b.monthsCovered > 12) return undefined;
  if (typeof b.share !== 'number' || !Number.isFinite(b.share) || b.share < 0 || b.share > 1) return undefined;
  const unattributed = typeof b.unattributedShare === 'number' && Number.isFinite(b.unattributedShare) && b.unattributedShare >= 0 && b.unattributedShare <= 1
    ? b.unattributedShare : 0;
  return {
    basis: b.basis,
    fromMonth: b.fromMonth,
    toMonth: b.toMonth,
    monthsCovered: b.monthsCovered,
    share: b.share,
    measure: b.measure === 'value' ? 'value' : 'weight',
    unattributedShare: unattributed,
  };
}

export function formatLngWindow(b: Pick<LngShareBaselineEntry, 'basis' | 'fromMonth' | 'toMonth'>): string {
  if (b.basis === 'comtrade_annual') return `${b.fromMonth.slice(0, 4)} annual`;
  return b.fromMonth === b.toMonth ? b.fromMonth : `${b.fromMonth} to ${b.toMonth}`;
}

const pct1 = (share: number): string => {
  const v = share * 100;
  return v > 0 && v < 0.1 ? '<0.1' : v.toFixed(1);
};

export interface LngOriginForCountry {
  preCrisis?: LngShareBaselineEntry;
  current?: LngShareBaselineEntry;
  /** Why the pre-crisis share is unavailable, as limitation text. */
  preCrisisReason?: string;
  /** Why the current-flows share is unavailable, as limitation text. */
  currentReason?: string;
}

const UNAVAILABLE_REASON: Record<string, string> = {
  partners_unattributed: 'UN Comtrade books its LNG imports to unspecified partners ("Areas, nes" or "Special categories")',
  no_rows: 'no UN Comtrade LNG (HS 271111) import rows for the window',
};

/** The country's two baselines from the snapshot, with a reason for each one that is missing. */
export function resolveLngOrigin(snapshot: unknown, iso2: string): LngOriginForCountry {
  const countries = snapshot && typeof snapshot === 'object' ? (snapshot as { countries?: unknown }).countries : undefined;
  if (!countries || typeof countries !== 'object') {
    const reason = 'the UN Comtrade LNG origin snapshot is unavailable';
    return { preCrisisReason: reason, currentReason: reason };
  }
  const entry = (countries as Record<string, unknown>)[iso2];
  if (!entry || typeof entry !== 'object') {
    const reason = 'no UN Comtrade LNG (HS 271111) import rows';
    return { preCrisisReason: reason, currentReason: reason };
  }
  const e = entry as Record<string, unknown>;
  const preCrisis = readLngShareBaseline(e.preCrisis);
  const current = readLngShareBaseline(e.current);
  const reasonFor = (code: unknown, present: unknown): string =>
    (typeof code === 'string' && UNAVAILABLE_REASON[code])
    || (present != null ? 'the stored UN Comtrade LNG share is malformed' : UNAVAILABLE_REASON.no_rows!);
  return {
    preCrisis,
    current,
    ...(preCrisis ? {} : { preCrisisReason: reasonFor(e.preCrisisUnavailable, e.preCrisis) }),
    ...(current ? {} : { currentReason: reasonFor(e.currentUnavailable, e.current) }),
  };
}

/** The source line for a measured Hormuz LNG share. */
export function buildLngOriginLimitation(origin: LngOriginForCountry, jodiMonth: string): string {
  const pre = origin.preCrisis!;
  const describe = (b: LngShareBaselineEntry, label: string): string => {
    const unattributed = b.unattributedShare >= 0.001
      ? `; ${(b.unattributedShare * 100).toFixed(1)}% booked to unspecified partners is not attributed`
      : '';
    return `${label}: ${pct1(b.share)}% by ${b.measure}, UN Comtrade ${b.basis === 'comtrade_monthly' ? 'monthly' : 'annual'} ${formatLngWindow(b)}${unattributed}.`;
  };
  return [
    "LNG Hormuz share: UN Comtrade HS 271111 imports from Qatar and the UAE (Das Island); Oman's Qalhat terminal loads outside the Strait and is excluded.",
    describe(pre, 'Pre-crisis baseline'),
    origin.current ? describe(origin.current, 'Current flows') : 'Current flows: unavailable.',
    `The headline loss applies the pre-crisis share to JODI LNG imports for ${jodiMonth || 'an unknown observation month'}; the current-flows loss applies the current share to the same imports.`,
  ].join(' ');
}

export const EU_GAS_STORAGE_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB',
]);

export type FuelMode = (typeof filterParamContracts.intelligenceFuelModes)[number];

const DEFAULT_FUEL_MODE = filterParamContracts.intelligenceFuelModes[0] ?? 'oil';

export function parseFuelMode(raw: string | undefined | null): FuelMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (VALID_FUEL_MODES.has(v)) return v;
  return DEFAULT_FUEL_MODE;
}

/** Finite nonnegative LNG imports and positive demand: the JODI inputs every gas result needs. */
export function hasGasMeasurements(lngImportsTj: unknown, totalDemandTj: unknown): boolean {
  return typeof lngImportsTj === 'number' && Number.isFinite(lngImportsTj) && lngImportsTj >= 0
    && typeof totalDemandTj === 'number' && Number.isFinite(totalDemandTj) && totalDemandTj > 0;
}

/**
 * Monthly LNG loss at `routeShare` (the fraction of LNG imports using the
 * chokepoint). Undefined without valid JODI inputs or a valid route share;
 * Hormuz has no default share, so a caller must pass the measured one.
 */
export function computeGasDisruption(
  lngImportsTj: number | null | undefined,
  totalDemandTj: number | null | undefined,
  chokepointId: string,
  disruptionPct: number,
  routeShare: unknown = CHOKEPOINT_LNG_EXPOSURE[chokepointId],
): { lngDisruptionTj: number; deficitPct: number } | undefined {
  if (!hasGasMeasurements(lngImportsTj, totalDemandTj)) return undefined;
  if (typeof routeShare !== 'number' || !Number.isFinite(routeShare) || routeShare < 0 || routeShare > 1) return undefined;
  const lngDisruptionTj = (lngImportsTj as number) * routeShare * (disruptionPct / 100);
  const deficitPct = (lngDisruptionTj / (totalDemandTj as number)) * 100;
  return {
    lngDisruptionTj: Math.round(lngDisruptionTj * 10) / 10 || lngDisruptionTj,
    deficitPct: Math.round(deficitPct * 10) / 10 || deficitPct,
  };
}

/** The measured Hormuz shares behind a gas result, for its assessment text. */
export interface MeasuredLngAssessment {
  preCrisis: LngShareBaselineEntry;
  current?: LngShareBaselineEntry;
  /** Loss at the current-flows share as percent of demand. */
  currentDeficitPct?: number;
}

const demandPctText = (deficitPct: number): string => (deficitPct > 0 && deficitPct < 0.1 ? '<0.1' : deficitPct.toFixed(1));

/** Assessment for an importer whose LNG origin share is unavailable. */
export function lngOriginUnavailableAssessment(code: string, chokepointId: string): string {
  return `LNG origin share unavailable for ${code}; ${chokepointLabel(chokepointId)} LNG exposure is not modeled.`;
}

export function buildGasAssessment(
  code: string,
  chokepointId: string,
  dataAvailable: boolean,
  lngImportsTj: number,
  deficitPct: number,
  disruptionPct: number,
  dataMonth: string,
  measured?: MeasuredLngAssessment,
): string {
  if (!dataAvailable) {
    return `Insufficient gas import data for ${code} to model ${chokepointId} LNG exposure.`;
  }
  if (lngImportsTj === 0) {
    return `${code} recorded zero LNG imports in ${dataMonth || 'an unknown observation month'}. The modeled direct LNG loss is zero; this does not establish total gas supply security.`;
  }
  const month = dataMonth || 'an unknown observation month';
  if (measured) {
    const { preCrisis, current, currentDeficitPct } = measured;
    const now = current
      ? ` and ${pct1(current.share)}% in current flows (${formatLngWindow(current)})`
      : '; current-flows share unavailable';
    const nowLoss = current && currentDeficitPct != null ? `; at the current-flows share it equals ${demandPctText(currentDeficitPct)}%` : '';
    return `${code} LNG exposure to ${chokepointLabel(chokepointId)}: Qatar and the UAE supplied ${pct1(preCrisis.share)}% of LNG imports before the crisis (${formatLngWindow(preCrisis)})${now}. Under ${disruptionPct}% disruption at the pre-crisis share, modeled loss equals ${demandPctText(deficitPct)}% of JODI demand for ${month}${nowLoss}. This is not a supply-shortage forecast.`;
  }
  const exposure = CHOKEPOINT_LNG_EXPOSURE[chokepointId];
  if (exposure === undefined) return lngOriginUnavailableAssessment(code, chokepointId);
  return `${code} gas sensitivity assumes ${exposure * 100}% of recorded LNG imports use ${chokepointLabel(chokepointId)}. Under ${disruptionPct}% disruption of that assumed route baseline, modeled loss equals ${demandPctText(deficitPct)}% of JODI demand for ${month}. This is not measured country-specific exposure or a supply-shortage forecast.`;
}
