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

export type RefineryProductKey = 'gasoline' | 'diesel' | 'jet' | 'lpg' | 'naphtha';

/** Modeled refined products, in response order: JODI row key and display name. */
export const REFINERY_PRODUCTS: ReadonlyArray<{ key: RefineryProductKey; name: string; label: string }> = [
  { key: 'gasoline', name: 'Gasoline', label: 'gasoline' },
  { key: 'diesel', name: 'Diesel', label: 'diesel' },
  { key: 'jet', name: 'Jet fuel', label: 'jet fuel' },
  { key: 'lpg', name: 'LPG', label: 'LPG' },
  { key: 'naphtha', name: 'Naphtha', label: 'naphtha' },
];

/**
 * Fallback for a product without a measured country yield: the median of the
 * yields scripts/seed-jodi-oil.mjs computes (its own denominator rule) for the
 * 44 JODI reporters averaging ≥100 kb/d crude intake, over each one's latest
 * 12 months (ending 2025-08 to 2026-08), from the JODI files read 2026-10-28.
 */
export const GLOBAL_MEDIAN_REFINERY_YIELD: Record<RefineryProductKey, number> = {
  gasoline: 0.242,
  diesel: 0.394,
  jet: 0.069,
  lpg: 0.036,
  naphtha: 0.085,
};

export const GLOBAL_MEDIAN_REFINERY_YIELD_SOURCE = 'global median = median of 44 JODI refiners with ≥100 kb/d crude intake, latest 12 months to 2026-08 (JODI files read 2026-10-28)';

/** `refineryYields` as scripts/seed-jodi-oil.mjs publishes it on each country row. */
export interface JodiRefineryYieldsLike {
  basis?: string | null;
  intakeIssue?: string | null;
  startMonth?: string | null;
  endMonth?: string | null;
  months?: number | null;
  products?: Partial<Record<string, unknown>> | null;
}

export interface ResolvedRefineryYields {
  yields: Record<RefineryProductKey, number>;
  /** One limitation line naming the basis, window and every yield used. */
  basis: string;
}

const YIELD_BASES = new Set(['crude_refinery_intake', 'total_refinery_output']);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const INTAKE_ISSUE_TEXT: Record<string, string> = {
  balancing_item: 'JODI crude refinery intake is a balancing item (production + imports − exports), not an observation',
  implausible_output_ratio: 'JODI crude refinery intake is implausible against total refinery output',
  unreported: 'JODI crude refinery intake is not reported for enough months',
};

const pctText = (v: number) => `${(v * 100).toFixed(1)}%`;

function measuredYield(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

/**
 * Per-product yields for the modeled products: the country's own trailing
 * JODI yields where measured, the labelled global median for the rest. The
 * US-average constants previously applied to every country are gone.
 */
export function resolveRefineryYields(code: string, raw: JodiRefineryYieldsLike | null | undefined): ResolvedRefineryYields {
  const window = raw && typeof raw.basis === 'string' && YIELD_BASES.has(raw.basis)
    && typeof raw.startMonth === 'string' && MONTH_RE.test(raw.startMonth)
    && typeof raw.endMonth === 'string' && MONTH_RE.test(raw.endMonth)
    && raw.products != null && typeof raw.products === 'object'
    ? raw : null;
  const yields = {} as Record<RefineryProductKey, number>;
  const measured: string[] = [];
  const median: string[] = [];
  for (const { key, label } of REFINERY_PRODUCTS) {
    const value = window ? measuredYield(window.products?.[key]) : null;
    yields[key] = value ?? GLOBAL_MEDIAN_REFINERY_YIELD[key];
    if (value !== null) measured.push(`${label} ${pctText(value)}`);
    else median.push(`${label} ${pctText(GLOBAL_MEDIAN_REFINERY_YIELD[key])}`);
  }
  if (!window || measured.length === 0) {
    return { yields, basis: `refinery yields: no JODI country yields for ${code}; global median used: ${median.join(', ')} (${GLOBAL_MEDIAN_REFINERY_YIELD_SOURCE}).` };
  }
  const denominator = window.basis === 'crude_refinery_intake' ? 'crude refinery intake' : 'total refinery output';
  const months = typeof window.months === 'number' && Number.isFinite(window.months) ? ` (${window.months} months)` : '';
  const why = window.basis === 'total_refinery_output' && typeof window.intakeIssue === 'string' && INTAKE_ISSUE_TEXT[window.intakeIssue]
    ? ` because ${INTAKE_ISSUE_TEXT[window.intakeIssue]}` : '';
  const fallback = median.length > 0
    ? `; ${median.join(', ')} ${median.length === 1 ? 'is' : 'are'} the global median (no country output; ${GLOBAL_MEDIAN_REFINERY_YIELD_SOURCE})` : '';
  return {
    yields,
    basis: `refinery yields: ${code} JODI product output ÷ ${denominator}, ${window.startMonth}–${window.endMonth}${months}${why}: ${measured.join(', ')}${fallback}. Gross output includes non-crude refinery feeds.`,
  };
}

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

export const CHOKEPOINT_LNG_EXPOSURE: Record<string, number> = {
  hormuz_strait: 0.30,
  malacca_strait: 0.50,
  suez: 0.20,
  bab_el_mandeb: 0.20,
};

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

export function computeGasDisruption(
  lngImportsTj: number | null | undefined,
  totalDemandTj: number | null | undefined,
  chokepointId: string,
  disruptionPct: number,
): { lngDisruptionTj: number; deficitPct: number } | undefined {
  if (typeof lngImportsTj !== 'number' || !Number.isFinite(lngImportsTj) || lngImportsTj < 0
    || typeof totalDemandTj !== 'number' || !Number.isFinite(totalDemandTj) || totalDemandTj <= 0) return undefined;
  const baseExposure = CHOKEPOINT_LNG_EXPOSURE[chokepointId] ?? 0;
  const lngDisruptionTj = lngImportsTj * baseExposure * (disruptionPct / 100);
  const deficitPct = (lngDisruptionTj / totalDemandTj) * 100;
  return {
    lngDisruptionTj: Math.round(lngDisruptionTj * 10) / 10 || lngDisruptionTj,
    deficitPct: Math.round(deficitPct * 10) / 10 || deficitPct,
  };
}

export function buildGasAssessment(
  code: string,
  chokepointId: string,
  dataAvailable: boolean,
  lngImportsTj: number,
  deficitPct: number,
  disruptionPct: number,
  dataMonth: string,
): string {
  if (!dataAvailable) {
    return `Insufficient gas import data for ${code} to model ${chokepointId} LNG exposure.`;
  }
  if (lngImportsTj === 0) {
    return `${code} recorded zero LNG imports in ${dataMonth || 'an unknown observation month'}. The modeled direct LNG loss is zero; this does not establish total gas supply security.`;
  }
  const exposurePct = (CHOKEPOINT_LNG_EXPOSURE[chokepointId] ?? 0) * 100;
  const demandPct = deficitPct > 0 && deficitPct < 0.1 ? '<0.1' : deficitPct.toFixed(1);
  return `${code} gas sensitivity assumes ${exposurePct}% of recorded LNG imports use ${chokepointLabel(chokepointId)}. Under ${disruptionPct}% disruption of that assumed route baseline, modeled loss equals ${demandPct}% of JODI demand for ${dataMonth || 'an unknown observation month'}. This is not measured country-specific exposure or a supply-shortage forecast.`;
}
