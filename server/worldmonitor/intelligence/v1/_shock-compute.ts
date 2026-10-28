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

export interface ProductBalanceInput {
  crudeLossKbd: number;
  yieldFactor: number;
  demandKbd: number;
  /** Null when JODI does not report the flow: no import loss and no export buffer is invented. */
  importsKbd: number | null;
  exportsKbd: number | null;
  /** Gulf share of the product's imports × route exposure × disruption fraction; null when not attributed. */
  gulfImportLossFactor: number | null;
}

export interface ProductBalance {
  outputLossKbd: number;
  gulfImportLossKbd: number;
  exportBufferKbd: number;
  shortfallKbd: number;
  deficitPct: number;
}

/**
 * Domestic shortfall of one refined product: lost refinery output plus lost
 * Gulf-origin imports, less the exports a country can redirect home before
 * its own demand is hit.
 */
export function computeProductBalance(input: ProductBalanceInput): ProductBalance {
  const outputLossKbd = input.crudeLossKbd * input.yieldFactor;
  const gulfImportLossKbd = input.gulfImportLossFactor != null && input.importsKbd != null && input.importsKbd > 0
    ? input.importsKbd * input.gulfImportLossFactor : 0;
  const exportBufferKbd = input.exportsKbd != null && input.exportsKbd > 0 ? input.exportsKbd : 0;
  const shortfallKbd = Math.max(0, outputLossKbd + gulfImportLossKbd - exportBufferKbd);
  return { outputLossKbd, gulfImportLossKbd, exportBufferKbd, shortfallKbd, deficitPct: clamp((shortfallKbd / input.demandKbd) * 100, 0, 100) };
}

export interface ProductTradeFlows {
  demandKbd: number | null;
  importsKbd: number | null;
  exportsKbd: number | null;
}

export interface ProductTradeWindow {
  startMonth: string;
  endMonth: string;
  months: number;
  products: Partial<Record<RefineryProductKey, ProductTradeFlows>>;
}

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** One `productTrade` window from scripts/seed-jodi-oil.mjs, or null when malformed. */
export function parseProductTradeWindow(raw: unknown): ProductTradeWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { startMonth?: unknown; endMonth?: unknown; months?: unknown; products?: unknown };
  if (typeof w.startMonth !== 'string' || !MONTH_RE.test(w.startMonth)
    || typeof w.endMonth !== 'string' || !MONTH_RE.test(w.endMonth)
    || typeof w.months !== 'number' || !Number.isFinite(w.months) || w.months < 1
    || !w.products || typeof w.products !== 'object') return null;
  const products: Partial<Record<RefineryProductKey, ProductTradeFlows>> = {};
  for (const { key } of REFINERY_PRODUCTS) {
    const p = (w.products as Record<string, { demandKbd?: unknown; importsKbd?: unknown; exportsKbd?: unknown } | null>)[key];
    if (!p || typeof p !== 'object') continue;
    products[key] = { demandKbd: finiteOrNull(p.demandKbd), importsKbd: finiteOrNull(p.importsKbd), exportsKbd: finiteOrNull(p.exportsKbd) };
  }
  return { startMonth: w.startMonth, endMonth: w.endMonth, months: w.months, products };
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
): string {
  const country = countryLabel(code);
  const cp = chokepointLabel(chokepointId);
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
    return `With ${daysOfCover} days IEA cover, ${code} is indefinitely bridgeable against a ${disruptionPct}% ${chokepointId} disruption at this deficit rate${mix}${degradedNote}.`;
  }
  if (effectiveCoverDays > 90) {
    return `With ${daysOfCover} days IEA cover, ${country} can bridge a ${disruptionPct}% ${cp} disruption for ~${effectiveCoverDays} days${mix}${degradedNote}.`;
  }
  const worst = products.reduce<{ product: string; deficitPct: number }>(
    (best, p) => (p.deficitPct > best.deficitPct ? p : best),
    { product: '', deficitPct: 0 },
  );
  const worstDeficit = worst.deficitPct;
  const worstProduct = worst.product.toLowerCase();
  return `${country} faces ${worstDeficit.toFixed(1)}% ${worstProduct} deficit under ${disruptionPct}% ${cp} disruption${mix}; IEA cover: ${ieaCoverText}${degradedNote}.`;
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
  partners_unattributed: 'UN Comtrade books more than 10% of its LNG imports to unspecified partners ("Areas, nes", "Special categories" or value missing from the partner rows)',
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
  // Own keys only: a stored code such as "toString" must not resolve through the prototype.
  const reasonFor = (code: unknown, present: unknown): string =>
    (typeof code === 'string' && Object.prototype.hasOwnProperty.call(UNAVAILABLE_REASON, code) ? UNAVAILABLE_REASON[code] : undefined)
    || (present != null ? 'the stored UN Comtrade LNG share is malformed' : UNAVAILABLE_REASON.no_rows!);
  return {
    preCrisis,
    current,
    ...(preCrisis ? {} : { preCrisisReason: reasonFor(e.preCrisisUnavailable, e.preCrisis) }),
    ...(current ? {} : { currentReason: reasonFor(e.currentUnavailable, e.current) }),
  };
}

/**
 * The source line for a measured Hormuz LNG share. The headline loss uses the
 * pre-crisis share, or the current-flows share when that is the only one.
 */
export function buildLngOriginLimitation(origin: LngOriginForCountry, jodiMonth: string): string {
  const pre = origin.preCrisis;
  const describe = (b: LngShareBaselineEntry, label: string): string => {
    const unattributed = b.unattributedShare >= 0.001
      ? `; ${(b.unattributedShare * 100).toFixed(1)}% booked to unspecified partners is not attributed`
      : '';
    return `${label}: ${pct1(b.share)}% by ${b.measure}, UN Comtrade ${b.basis === 'comtrade_monthly' ? 'monthly' : 'annual'} ${formatLngWindow(b)}${unattributed}.`;
  };
  return [
    "LNG Hormuz share: UN Comtrade HS 271111 imports from Qatar and the UAE (Das Island); Oman's Qalhat terminal loads outside the Strait and is excluded.",
    pre ? describe(pre, 'Pre-crisis baseline') : `Pre-crisis baseline: unavailable (${origin.preCrisisReason ?? UNAVAILABLE_REASON.no_rows}).`,
    origin.current ? describe(origin.current, 'Current flows') : 'Current flows: unavailable.',
    pre
      ? `The headline loss applies the pre-crisis share to JODI LNG imports for ${jodiMonth || 'an unknown observation month'}; the current-flows loss applies the current share to the same imports.`
      : `The headline loss applies the current-flows share to JODI LNG imports for ${jodiMonth || 'an unknown observation month'}.`,
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

/** The measured Hormuz shares behind a gas result, for its assessment text. At least one is present. */
export interface MeasuredLngAssessment {
  preCrisis?: LngShareBaselineEntry;
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
  if (measured?.preCrisis) {
    const { preCrisis, current, currentDeficitPct } = measured;
    const now = current
      ? ` and ${pct1(current.share)}% in current flows (${formatLngWindow(current)})`
      : '; current-flows share unavailable';
    const nowLoss = current && currentDeficitPct != null ? `; at the current-flows share it equals ${demandPctText(currentDeficitPct)}%` : '';
    return `${code} LNG exposure to ${chokepointLabel(chokepointId)}: Qatar and the UAE supplied ${pct1(preCrisis.share)}% of LNG imports before the crisis (${formatLngWindow(preCrisis)})${now}. Under ${disruptionPct}% disruption at the pre-crisis share, modeled loss equals ${demandPctText(deficitPct)}% of JODI demand for ${month}${nowLoss}. This is not a supply-shortage forecast.`;
  }
  if (measured?.current) {
    // Only current flows are measured: they drive the loss, and the text says so.
    const { current } = measured;
    return `${code} LNG exposure to ${chokepointLabel(chokepointId)}: Qatar and the UAE supplied ${pct1(current.share)}% of LNG imports in current flows (${formatLngWindow(current)}); pre-crisis share unavailable. Under ${disruptionPct}% disruption at the current-flows share, modeled loss equals ${demandPctText(deficitPct)}% of JODI demand for ${month}. This is not a supply-shortage forecast.`;
  }
  const exposure = CHOKEPOINT_LNG_EXPOSURE[chokepointId];
  if (exposure === undefined) return lngOriginUnavailableAssessment(code, chokepointId);
  return `${code} gas sensitivity assumes ${exposure * 100}% of recorded LNG imports use ${chokepointLabel(chokepointId)}. Under ${disruptionPct}% disruption of that assumed route baseline, modeled loss equals ${demandPctText(deficitPct)}% of JODI demand for ${month}. This is not measured country-specific exposure or a supply-shortage forecast.`;
}
