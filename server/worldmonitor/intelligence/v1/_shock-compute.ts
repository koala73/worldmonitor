import filterParamContracts from '../../../../shared/openapi-filter-param-contracts.json';
import { CURRENT_FLOWS_WINDOW, PRE_CRISIS_WINDOW } from '../../../../shared/hormuz-crisis.js';
import { BYPASS_RAMP_DAYS, HORMUZ_BYPASS_BY_EXPORTER } from './_hormuz-bypass';

const BYPASS_EXPORTERS = Object.keys(HORMUZ_BYPASS_BY_EXPORTER);

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
  /** Share of imports from each exporter with a Hormuz bypass (SA, AE, IQ) that the row lists. */
  byPartner?: Partial<Record<string, number>>;
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
  const byPartner: Partial<Record<string, number>> = {};
  for (const partner of product.partners) {
    const value = partner?.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    const iso2 = typeof partner.partnerIso2 === 'string' ? partner.partnerIso2.toUpperCase() : '';
    const code = partner.partnerCode != null ? String(partner.partnerCode).padStart(3, '0') : '';
    if (GULF_PARTNER_ISO2.has(iso2) || GULF_PARTNER_CODES.has(code)) gulf += value;
    const exporter = BYPASS_EXPORTERS.includes(iso2) ? iso2 : BYPASS_EXPORTER_BY_CODE[code];
    if (exporter) byPartner[exporter] = (byPartner[exporter] ?? 0) + value / total;
  }
  const omittedShare = typeof product.omittedShare === 'number' && Number.isFinite(product.omittedShare) && product.omittedShare > 0
    ? product.omittedShare : undefined;
  return {
    share: Math.min(gulf / total, 1),
    hasData: true,
    year: typeof product.year === 'number' && Number.isFinite(product.year) ? product.year : undefined,
    omittedShare,
    byPartner,
  };
}

const BYPASS_EXPORTER_BY_CODE: Record<string, string> = { '682': 'SA', '784': 'AE', '368': 'IQ' };

/** `crudeImportOrigin` in energy:oil-trade-series:v1 (scripts/seed-oil-trade-series.mjs). */
export interface CrudeImportOriginLike {
  status?: string;
  carriedForward?: boolean;
  fetchedAt?: string;
  months?: unknown;
  importers?: Record<string, {
    worldUsdM?: Array<number | null>;
    gulfUsdM?: Array<number | null>;
    bypassPartnersUsdM?: Record<string, Array<number | null> | undefined>;
  } | undefined> | null;
}

export interface MonthlyGulfShare {
  share: number;
  fromMonth: string;
  toMonth: string;
  monthsCovered: number;
  /** SA, AE and IQ shares over the same months; absent when the section has no per-exporter columns. */
  byPartner?: Partial<Record<string, number>>;
}

/** Fewest filed months of the 12-month pre-crisis window that still make a baseline. */
export const MIN_PRE_CRISIS_MONTHS = 9;

/**
 * Gulf share of one importer's crude imports by value, from its own monthly
 * Comtrade filings, over two windows (shared/hormuz-crisis.js):
 * - preCrisis: the filed months of the 12 full months before the crisis,
 *   at least MIN_PRE_CRISIS_MONTHS of them; reported against the window bounds.
 * - current: the latest CURRENT_FLOWS_WINDOW.months filed months no earlier
 *   than CURRENT_FLOWS_WINDOW.earliestMonth, all of them required.
 * A month without a World value is not filed; null means unavailable.
 */
export function computeMonthlyGulfShares(
  origin: CrudeImportOriginLike | null | undefined,
  iso2: string,
): { preCrisis: MonthlyGulfShare | null; current: MonthlyGulfShare | null } {
  const none = { preCrisis: null, current: null };
  const months = origin?.months;
  const importer = origin?.importers?.[iso2];
  if (!Array.isArray(months) || !importer || !Array.isArray(importer.worldUsdM) || !Array.isArray(importer.gulfUsdM)) return none;
  const perExporter = importer.bypassPartnersUsdM && typeof importer.bypassPartnersUsdM === 'object' ? importer.bypassPartnersUsdM : null;
  const filed: Array<{ month: string; world: number; gulf: number; byPartner: Record<string, number> }> = [];
  months.forEach((month, i) => {
    const world = importer.worldUsdM?.[i];
    const gulf = importer.gulfUsdM?.[i];
    if (typeof month !== 'string' || typeof world !== 'number' || !Number.isFinite(world) || world <= 0) return;
    if (typeof gulf !== 'number' || !Number.isFinite(gulf) || gulf < 0 || gulf > world) return;
    const byPartner: Record<string, number> = {};
    for (const [iso2, column] of Object.entries(perExporter ?? {})) {
      const v = Array.isArray(column) ? column[i] : null;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) byPartner[iso2] = v;
    }
    filed.push({ month, world, gulf, byPartner });
  });
  filed.sort((a, b) => a.month.localeCompare(b.month));
  const window = (rows: typeof filed): Omit<MonthlyGulfShare, 'fromMonth' | 'toMonth' | 'monthsCovered'> => {
    const world = rows.reduce((sum, r) => sum + r.world, 0);
    if (!(world > 0)) return { share: 0 };
    const out: Omit<MonthlyGulfShare, 'fromMonth' | 'toMonth' | 'monthsCovered'> = { share: rows.reduce((sum, r) => sum + r.gulf, 0) / world };
    if (perExporter) {
      const byPartner: Partial<Record<string, number>> = {};
      for (const r of rows) for (const [iso2, v] of Object.entries(r.byPartner)) byPartner[iso2] = (byPartner[iso2] ?? 0) + v / world;
      out.byPartner = byPartner;
    }
    return out;
  };

  const pre = filed.filter((r) => r.month >= PRE_CRISIS_WINDOW.startMonth && r.month <= PRE_CRISIS_WINDOW.endMonth);
  const preCrisis = pre.length >= MIN_PRE_CRISIS_MONTHS
    ? { ...window(pre), fromMonth: PRE_CRISIS_WINDOW.startMonth, toMonth: PRE_CRISIS_WINDOW.endMonth, monthsCovered: pre.length }
    : null;

  const recent = filed.filter((r) => r.month >= CURRENT_FLOWS_WINDOW.earliestMonth).slice(-CURRENT_FLOWS_WINDOW.months);
  const current = recent.length === CURRENT_FLOWS_WINDOW.months
    ? { ...window(recent), fromMonth: recent[0]!.month, toMonth: recent[recent.length - 1]!.month, monthsCovered: recent.length }
    : null;
  return { preCrisis, current };
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
 * Effective cover when the loss runs at `firstLossKbd` for the bypass ramp
 * (BYPASS_RAMP_DAYS) and at `steadyLossKbd` after it. Equal first and steady
 * losses reduce to computeEffectiveCoverDays. Stocks are daysOfCover days of
 * crude imports.
 */
export function computeEffectiveCoverDaysWithRamp(
  daysOfCover: number,
  netExporter: boolean,
  firstLossKbd: number,
  steadyLossKbd: number,
  crudeImportsKbd: number,
): number {
  if (netExporter) return -1;
  if (!(daysOfCover > 0 && firstLossKbd > 0 && crudeImportsKbd > 0)) {
    return computeEffectiveCoverDays(daysOfCover, netExporter, firstLossKbd, crudeImportsKbd);
  }
  const stock = daysOfCover * crudeImportsKbd;
  const rampDraw = BYPASS_RAMP_DAYS * firstLossKbd;
  if (stock <= rampDraw) return Math.min(Math.round(stock / firstLossKbd), EFFECTIVE_COVER_DAYS_CAP);
  if (!(steadyLossKbd > 0)) return EFFECTIVE_COVER_DAYS_CAP;
  return Math.min(Math.round(BYPASS_RAMP_DAYS + (stock - rampDraw) / steadyLossKbd), EFFECTIVE_COVER_DAYS_CAP);
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
  supplyMix?: string,
  /** 'estimate': daysOfCover is a non-IEA strategic reserve estimate, never called IEA cover. */
  coverSource: 'iea' | 'estimate' = 'iea',
): string {
  const country = countryLabel(code);
  const cp = chokepointLabel(chokepointId);
  const estimated = coverSource === 'estimate';
  const coverPhrase = estimated
    ? `an estimated ${daysOfCover} days of strategic reserves (not IEA data)`
    : `${daysOfCover} days IEA cover`;
  // Which Gulf share the figures rest on, e.g. "the pre-crisis supply mix".
  const mix = supplyMix ? ` at ${supplyMix}` : '';
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
    return `${country} has low Gulf crude dependence (${Math.round(gulfCrudeShare * 100)}%${mix}); ${cp} disruption has limited direct impact.`;
  }
  const degradedNote = degraded ? ' (live flow data unavailable, using historical baseline)' : '';
  const ieaCoverText = ieaStocksCoverage === false ? 'unknown' : `${daysOfCover} days`;
  if (effectiveCoverDays >= EFFECTIVE_COVER_DAYS_CAP) {
    return `With ${coverPhrase}, ${code} is indefinitely bridgeable against a ${disruptionPct}% ${chokepointId} disruption at this deficit rate${mix}${degradedNote}.`;
  }
  if (effectiveCoverDays > 90) {
    return `With ${coverPhrase}, ${country} can bridge a ${disruptionPct}% ${cp} disruption for ~${effectiveCoverDays} days${mix}${degradedNote}.`;
  }
  const coverText = estimated ? `estimated strategic reserve cover: ~${effectiveCoverDays} days (not IEA data)` : `IEA cover: ${ieaCoverText}`;
  // No product with recorded demand: there is no deficit to name, not a 0.0% one.
  if (products.length === 0) {
    return `${country} has no refined-product demand observation, so product deficits under ${disruptionPct}% ${cp} disruption${mix} are not modeled; ${coverText}${degradedNote}.`;
  }
  // Recorded demand with every deficit at 0 still names a product (a measured 0.0%).
  const worst = products.reduce((best, p) => (p.deficitPct > best.deficitPct ? p : best));
  const worstDeficit = worst.deficitPct;
  const worstProduct = worst.product.toLowerCase();
  return `${country} faces ${worstDeficit.toFixed(1)}% ${worstProduct} deficit under ${disruptionPct}% ${cp} disruption${mix}; ${coverText}${degradedNote}.`;
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
