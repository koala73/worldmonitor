import type {
  ServerContext,
  ComputeEnergyShockScenarioRequest,
  ComputeEnergyShockScenarioResponse,
  ProductImpact,
  GasSensitivity,
  GasStorageObservation,
  CrudeShareBaseline,
  LngShareBaseline,
  ReserveEstimate,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { SPR_POLICIES_KEY } from '../../../_shared/cache-keys';
import {
  clamp,
  CHOKEPOINT_EXPOSURE,
  VALID_CHOKEPOINTS,
  computeGulfShare,
  computeGulfShareFromPartners,
  computeEffectiveCoverDaysWithRamp,
  jodiNetCrudeExporter,
  EFFECTIVE_COVER_DAYS_CAP,
  GULF_SHARE_SOURCE_LABEL,
  buildAssessment,
  deriveCoverageLevel,
  deriveChokepointConfidence,
  parseFuelMode,
  EU_GAS_STORAGE_COUNTRIES,
  CHOKEPOINT_LNG_EXPOSURE,
  GAS_MODEL_BASIS,
  LNG_HORMUZ_SHARE_KEY,
  computeGasDisruption,
  hasGasMeasurements,
  buildGasAssessment,
  buildLngOriginLimitation,
  lngOriginUnavailableAssessment,
  resolveLngOrigin,
  REFINERY_PRODUCTS,
  resolveRefineryYields,
  computeMonthlyGulfShares,
  MIN_PRE_CRISIS_MONTHS,
  computeProductBalance,
  parseProductTradeWindow,
} from './_shock-compute';
import type {
  CrudeImportOriginLike,
  GulfShareMeasurement,
  JodiRefineryYieldsLike,
  LngOriginForCountry,
  LngShareBaselineEntry,
  MonthlyGulfShare,
  PartnerShareProductLike,
  ProductBalance,
  ProductTradeFlows,
  RefineryProductKey,
} from './_shock-compute';
import { ISO2_TO_COMTRADE } from './_comtrade-reporters';
import { CURRENT_FLOWS_WINDOW, PRE_CRISIS_WINDOW } from '../../../../shared/hormuz-crisis.js';
import { HORMUZ_BYPASS_AS_OF, HORMUZ_BYPASS_BY_EXPORTER, lostShareAfterBypass } from './_hormuz-bypass';
import type { BypassScenario } from './_hormuz-bypass';
import { nonIeaReserveFor } from './_non-iea-reserves';

const BYPASS_EXPORTER_NAMES: Record<string, string> = { SA: 'Saudi Arabia', AE: 'UAE', IQ: 'Iraq' };
// Round to the reported 0.1 kbd first so prose and fields agree (2209.47 -> 2209.5 -> 2,210).
const fmtKbd = (v: number): string => Math.round(Math.round(v * 10) / 10).toLocaleString('en-US');

const SHOCK_CACHE_TTL = 300;

const CP_TO_PORTWATCH: Record<string, string> = {
  hormuz_strait: 'hormuz_strait',
  bab_el_mandeb: 'bab_el_mandeb',
  suez: 'suez',
  malacca_strait: 'malacca_strait',
};

// Partner-level crude (HS 2709) imports by reporter, written by
// scripts/seed-comtrade-bilateral-hs4.mjs for the country-port-cluster set.
const CRUDE_HS4 = '2709';
// Refined products (naphtha, gasoline, jet, gas oil, fuel oil) in the same key.
const PRODUCTS_HS4 = '2710';
const bilateralPartnersKey = (iso2: string): string => `comtrade:bilateral-hs4-partners:${iso2}:v1`;
// Importer-declared monthly crude imports from World and the Gulf, in the
// crudeImportOrigin section of the oil trade series (seed-oil-trade-series.mjs).
const OIL_TRADE_SERIES_KEY = 'energy:oil-trade-series:v1';
// HS 2711 mixes LPG with LNG, so LPG imports get no Gulf attribution.
const GULF_ATTRIBUTED_PRODUCTS = new Set<RefineryProductKey>(['gasoline', 'diesel', 'jet', 'naphtha']);

interface JodiProduct {
  demandKbd?: number | null;
  importsKbd?: number | null;
  exportsKbd?: number | null;
}

interface JodiOil {
  dataMonth?: string | null;
  gasoline?: JodiProduct | null;
  diesel?: JodiProduct | null;
  jet?: JodiProduct | null;
  lpg?: JodiProduct | null;
  naphtha?: JodiProduct | null;
  crude?: { importsKbd?: number | null } | null;
  refineryYields?: JodiRefineryYieldsLike | null;
  productTrade?: { preCrisisBaseline?: unknown; currentFlows?: unknown } | null;
}

interface IeaStocks {
  dataMonth?: string | null;
  daysOfCover?: number | null;
  netExporter?: boolean | null;
  belowObligation?: boolean | null;
  anomaly?: boolean | null;
}

interface JodiGas {
  dataMonth?: string | null;
  lngImportsTj?: number | null;
  pipeImportsTj?: number | null;
  totalDemandTj?: number | null;
  lngShareOfImports?: number | null;
  closingStockTj?: number | null;
}

interface GasStorageData {
  fillPct?: number | null;
  gasTwh?: number | null;
  trend?: string | null;
  date?: string | null;
}

interface ComtradeFlowRecord {
  reporterCode: string;
  partnerCode: string;
  cmdCode: string;
  tradeValueUsd: number;
  year: number;
}

interface ComtradeFlowsResult {
  flows?: ComtradeFlowRecord[];
  fetchedAt?: string;
}

interface BilateralPartnersPayload {
  iso2?: string;
  products?: PartnerShareProductLike[];
}

interface ChokepointEntry {
  currentMbd?: number;
  baselineMbd?: number;
  flowRatio: number;
  disrupted?: boolean;
  source?: string;
  hazardAlertLevel?: string | null;
  hazardAlertName?: string | null;
}

function n(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

const NO_GULF_SHARE: GulfShareMeasurement = { share: 0, hasData: false };

/**
 * Measured Gulf share of the country's crude imports. The partner-level
 * bilateral row is authoritative; the strategic trade-flows key is consulted
 * only when it carries partner rows (its seeder currently aggregates every
 * partner into one World total, which `computeGulfShare` rejects). No proxy:
 * when neither source has partner rows the share is unavailable.
 */
async function getGulfCrudeShare(countryCode: string): Promise<GulfShareMeasurement> {
  const partnersPayload = await getCachedJson(bilateralPartnersKey(countryCode), true)
    .then((v) => v as BilateralPartnersPayload | null)
    .catch(() => null);
  const crudeProduct = Array.isArray(partnersPayload?.products)
    ? partnersPayload.products.find((p) => String(p?.hs4 ?? '') === CRUDE_HS4)
    : undefined;
  const fromPartners = computeGulfShareFromPartners(crudeProduct);
  if (fromPartners.hasData) return fromPartners;

  const numericCode = ISO2_TO_COMTRADE[countryCode];
  if (!numericCode) return NO_GULF_SHARE;

  const result = await getCachedJson(`comtrade:flows:${numericCode}:${CRUDE_HS4}`, true).catch(() => null);
  if (!result) return NO_GULF_SHARE;

  const flowsResult = result as ComtradeFlowsResult;
  const flows: ComtradeFlowRecord[] = Array.isArray(result)
    ? (result as ComtradeFlowRecord[])
    : (flowsResult.flows ?? []);
  if (flows.length === 0) return NO_GULF_SHARE;

  const legacy = computeGulfShare(flows);
  const years = flows.map((f) => f.year).filter((y) => Number.isFinite(y));
  return legacy.hasData
    ? { ...legacy, year: years.length > 0 ? Math.max(...years) : undefined }
    : NO_GULF_SHARE;
}

/** Measured Gulf share of the country's refined-product (HS 2710) imports. */
async function getGulfProductShare(countryCode: string): Promise<GulfShareMeasurement> {
  const payload = await getCachedJson(bilateralPartnersKey(countryCode), true)
    .then((v) => v as BilateralPartnersPayload | null)
    .catch(() => null);
  const product = Array.isArray(payload?.products)
    ? payload.products.find((p) => String(p?.hs4 ?? '') === PRODUCTS_HS4)
    : undefined;
  return computeGulfShareFromPartners(product);
}

interface ProductBalanceRow {
  key: RefineryProductKey;
  name: string;
  label: string;
  flows: ProductTradeFlows & { demandKbd: number };
  balance: ProductBalance;
}

const kbd = (v: number) => v.toFixed(1);

/** "gasoline 366.6 + 0.0 − 298.3 = 68.3 of 268.9 (25.4%)"; n/a marks an unreported or unattributed flow. */
function balanceTerm(row: ProductBalanceRow, attributed: boolean): string {
  const { flows, balance } = row;
  const imports = attributed && flows.importsKbd != null ? kbd(balance.gulfImportLossKbd) : 'n/a';
  const exports = flows.exportsKbd != null ? kbd(flows.exportsKbd) : 'n/a';
  return `${row.label} ${kbd(balance.outputLossKbd)} + ${imports} − ${exports} = ${kbd(balance.shortfallKbd)} of ${kbd(flows.demandKbd)} (${balance.deficitPct.toFixed(1)}%)`;
}

export async function computeEnergyShockScenario(
  _ctx: ServerContext,
  req: ComputeEnergyShockScenarioRequest,
): Promise<ComputeEnergyShockScenarioResponse> {
  const code = req.countryCode?.trim().toUpperCase() ?? '';
  const chokepointId = req.chokepointId?.trim().toLowerCase() ?? '';
  const disruptionPct = clamp(Math.round(req.disruptionPct ?? 0), 10, 100);
  const fuelMode = parseFuelMode(req.fuelMode);
  const needsOil = fuelMode === 'oil' || fuelMode === 'both';
  const needsGas = fuelMode === 'gas' || fuelMode === 'both';

  const EMPTY: ComputeEnergyShockScenarioResponse = {
    countryCode: code,
    chokepointId,
    disruptionPct,
    gulfCrudeShare: 0,
    crudeLossKbd: 0,
    products: [],
    effectiveCoverDays: 0,
    assessment: `Insufficient data to compute shock scenario for ${code}.`,
    dataAvailable: false,
    jodiOilCoverage: false,
    comtradeCoverage: false,
    ieaStocksCoverage: false,
    portwatchCoverage: false,
    coverageLevel: 'unsupported',
    limitations: [],
    degraded: false,
    chokepointConfidence: 'none',
    liveFlowRatio: undefined,
    gasSensitivity: undefined,
  };

  if (!code || code.length !== 2) return EMPTY;
  if (!VALID_CHOKEPOINTS.has(chokepointId)) {
    return {
      ...EMPTY,
      assessment: `Unknown chokepoint: ${chokepointId}. Valid chokepoints: hormuz_strait, malacca_strait, suez, bab_el_mandeb.`,
    };
  }

  const chokepointFlowsRaw2 = await getCachedJson('energy:chokepoint-flows:v1', true)
    .then((v) => v as Record<string, ChokepointEntry> | null)
    .catch(() => null);

  const portWatchKey = CP_TO_PORTWATCH[chokepointId];
  const cpEntry = portWatchKey ? (chokepointFlowsRaw2?.[portWatchKey] ?? null) : null;

  const degraded = !chokepointFlowsRaw2 || cpEntry == null || !Number.isFinite(cpEntry.flowRatio as number);

  const rawFlowRatio = (!degraded && cpEntry != null && Number.isFinite(cpEntry.flowRatio as number))
    ? cpEntry.flowRatio
    : null;
  const liveFlowRatio: number | null = rawFlowRatio !== null ? clamp(rawFlowRatio, 0, 1.5) : null;

  // Oil v13: cover from non-IEA reserve estimates (India, China). v12 oil caches
  // report no cover for them; v11 count every Gulf barrel as lost.
  // Gas g2: the Hormuz LNG route share is the importer's measured Qatar + UAE
  // share, not a flat 30%.
  const cacheVersion = `${needsOil ? 'v13' : 'v4'}${needsGas ? '-g2' : ''}`;
  const cacheKey = `energy:shock:${cacheVersion}:${code}:${chokepointId}:${disruptionPct}:${degraded ? 'd' : 'l'}:${fuelMode}`;
  const cached = await getCachedJson(cacheKey);
  if (cached) return cached as ComputeEnergyShockScenarioResponse;

  const hormuzGas = needsGas && chokepointId === 'hormuz_strait';
  const [jodiOilResult, ieaStocksResult, gulfShareResult, emberResult, jodiGasResult, gasStorageResult, lngOriginResult, productShareResult, oilTradeResult] = await Promise.allSettled([
    getCachedJson(`energy:jodi-oil:v1:${code}`, true),
    getCachedJson(`energy:iea-oil-stocks:v1:${code}`, true),
    getGulfCrudeShare(code),
    getCachedJson(`energy:ember:v1:${code}`, true),
    needsGas ? getCachedJson(`energy:jodi-gas:v1:${code}`, true) : Promise.resolve(null),
    needsGas && EU_GAS_STORAGE_COUNTRIES.has(code)
      ? getCachedJson(`energy:gas-storage:v1:${code}`, true)
      : Promise.resolve(null),
    hormuzGas ? getCachedJson(LNG_HORMUZ_SHARE_KEY, true) : Promise.resolve(null),
    needsOil ? getGulfProductShare(code) : Promise.resolve(NO_GULF_SHARE),
    needsOil ? getCachedJson(OIL_TRADE_SERIES_KEY, true) : Promise.resolve(null),
  ]);
  const gulfProductShare: GulfShareMeasurement = productShareResult.status === 'fulfilled' ? productShareResult.value : NO_GULF_SHARE;

  const jodiOil = jodiOilResult.status === 'fulfilled' ? (jodiOilResult.value as JodiOil | null) : null;
  const ieaStocks = ieaStocksResult.status === 'fulfilled' ? (ieaStocksResult.value as IeaStocks | null) : null;
  const annualShare: GulfShareMeasurement = gulfShareResult.status === 'fulfilled' ? gulfShareResult.value : NO_GULF_SHARE;
  const crudeOrigin = oilTradeResult.status === 'fulfilled'
    ? ((oilTradeResult.value as { crudeImportOrigin?: CrudeImportOriginLike } | null)?.crudeImportOrigin ?? null)
    : null;
  const computed = computeMonthlyGulfShares(crudeOrigin, code);
  // A carried-forward section is last-good data from a failed refresh. The
  // pre-crisis window is fixed history and stays valid; "current" flows from
  // it are not current, so they are withheld.
  const originStale = crudeOrigin?.carriedForward === true;
  const monthly = { preCrisis: computed.preCrisis, current: originStale ? null : computed.current };
  // Why a monthly figure is missing: the series itself (seeder not run or
  // fetch failed with nothing to carry forward), or this importer's filings.
  const originSeriesMissing = !crudeOrigin?.importers || Object.keys(crudeOrigin.importers).length === 0;
  const preCrisisWindow = `${PRE_CRISIS_WINDOW.startMonth}..${PRE_CRISIS_WINDOW.endMonth}`;
  const monthlyGap = (filings: string): string => originSeriesMissing
    ? 'the monthly UN Comtrade crude-origin series is not available'
    : filings;
  // Pre-crisis baseline: monthly filings for the 12 months before the crisis,
  // else the annual partner share (also pre-crisis by vintage), labelled.
  const preCrisisShare: (MonthlyGulfShare & { basis: 'comtrade_monthly' | 'comtrade_annual' }) | null = monthly.preCrisis
    ? { ...monthly.preCrisis, basis: 'comtrade_monthly' }
    : annualShare.hasData
      ? {
        basis: 'comtrade_annual',
        share: annualShare.share,
        fromMonth: annualShare.year != null ? `${annualShare.year}-01` : '',
        toMonth: annualShare.year != null ? `${annualShare.year}-12` : '',
        monthsCovered: annualShare.year != null ? 12 : 0,
        byPartner: annualShare.byPartner,
      }
      : null;

  const emberData = emberResult.status === 'fulfilled' ? (emberResult.value as { fossilShare?: number } | null) : null;
  const jodiGas = jodiGasResult.status === 'fulfilled' ? (jodiGasResult.value as JodiGas | null) : null;
  const gasStorageData = gasStorageResult.status === 'fulfilled' ? (gasStorageResult.value as GasStorageData | null) : null;
  // Hormuz LNG: both measured baselines for this importer, or why each is missing.
  const lngOrigin: LngOriginForCountry | undefined = hormuzGas
    ? resolveLngOrigin(lngOriginResult.status === 'fulfilled' ? lngOriginResult.value : null, code)
    : undefined;

  // Static route factor only (fraction of Gulf crude that transits this
  // chokepoint). The live flow ratio is reported as context and never scales
  // the share or the loss: the scenario's severity is disruption_pct.
  const baseExposure = CHOKEPOINT_EXPOSURE[chokepointId] ?? 1.0;

  const jodiOilCoverage = jodiOil != null;
  const comtradeCoverage = preCrisisShare != null;
  const ieaStocksCoverage = ieaStocks != null && ieaStocks.anomaly !== true
    && (ieaStocks.netExporter === true || (ieaStocks.daysOfCover != null && Number.isFinite(ieaStocks.daysOfCover) && ieaStocks.daysOfCover >= 0));
  const portwatchCoverage = liveFlowRatio !== null;
  // IEA classifies its members; JODI production and trade classify the rest.
  // Only without any IEA record: an IEA importer record with unusable cover
  // still says the country imports.
  const jodiNetExporter = needsOil && ieaStocks == null ? jodiNetCrudeExporter(jodiOil?.crude) : null;
  const netExporter = needsOil && ((ieaStocksCoverage && ieaStocks?.netExporter === true) || jodiNetExporter != null);

  const observedCrudeImportsKbd = jodiOil?.crude?.importsKbd;
  const crudeImportsObserved = typeof observedCrudeImportsKbd === 'number'
    && Number.isFinite(observedCrudeImportsKbd) && observedCrudeImportsKbd >= 0;
  const crudeImportsKbd = crudeImportsObserved ? observedCrudeImportsKbd : 0;
  // Both measured inputs of the loss are required. An unavailable input is
  // reported as unavailable, never filled with a proxy or shown as zero loss.
  const oilModeled = crudeImportsObserved && comtradeCoverage;

  const limitations: string[] = [];
  if (needsOil) {
    // A net exporter's cover is -1 whatever the import inputs, so the
    // "reported as 0" lines below would contradict it.
    if (!crudeImportsObserved && !netExporter) {
      limitations.push(`JODI crude import observation unavailable for ${code}; oil loss, product deficits and effective cover are not modeled (reported as 0).`);
    }
    if (!comtradeCoverage || !preCrisisShare) {
      if (!netExporter) limitations.push(`Crude import origin share unavailable for ${code}: no UN Comtrade partner-level crude (HS 2709) import rows; oil loss, product deficits and effective cover are not modeled (reported as 0).`);
    } else {
      const window = preCrisisWindow;
      const applied = crudeImportsObserved
        ? `, applied to JODI crude imports for ${typeof jodiOil?.dataMonth === 'string' && jodiOil.dataMonth ? jodiOil.dataMonth : 'an unknown month'}`
        : '';
      if (preCrisisShare.basis === 'comtrade_monthly') {
        limitations.push(`Gulf crude share (headline, pre-crisis baseline): UN Comtrade monthly import value share ${window} (${preCrisisShare.monthsCovered} of 12 months) from ${GULF_SHARE_SOURCE_LABEL}${applied}.`);
      } else {
        const year = annualShare.year != null ? ` ${annualShare.year}` : '';
        const omitted = annualShare.omittedShare != null
          ? `; partners below the Comtrade partner-listing threshold (${(annualShare.omittedShare * 100).toFixed(1)}% of imports) are not attributed`
          : '';
        const why = monthlyGap(crudeOrigin?.importers?.[code]
          ? `fewer than ${MIN_PRE_CRISIS_MONTHS} of the 12 months ${window} have UN Comtrade monthly crude filings for ${code}`
          : `there are no UN Comtrade monthly crude filings for ${code} in ${window}`);
        limitations.push(`Gulf crude share (headline, pre-crisis baseline): UN Comtrade${year} annual import value share from ${GULF_SHARE_SOURCE_LABEL}${applied}, because ${why}${omitted}.`);
      }
    }
  }
  if (!ieaStocksCoverage) {
    limitations.push('IEA strategic stock data unavailable');
  }
  const refineryYields = resolveRefineryYields(code, jodiOil?.refineryYields);
  limitations.push(refineryYields.basis);
  if (degraded) {
    limitations.push('PortWatch flow data unavailable, using historical baseline multipliers');
  } else if (needsOil) {
    limitations.push('Shipping flow ratio is context only and does not scale the crude route share or the modeled oil loss.');
  }

  const fossilShare = typeof emberData?.fossilShare === 'number' ? emberData.fossilShare : null;
  if (fossilShare !== null && fossilShare > 70) {
    limitations.push('high fossil grid dependency: limited electricity substitution capacity');
  }

  if (needsOil) {
    const sprRegistryRaw = await getCachedJson(SPR_POLICIES_KEY, true).catch(() => null) as Record<string, unknown> | null;
    const sprPolicies = (sprRegistryRaw as { policies?: Record<string, { regime?: string; ieaMember?: boolean; operator?: string; capacityMb?: number }> } | null)?.policies;
    const sprPolicy = sprPolicies?.[code];
    if (sprPolicy) {
      if (sprPolicy.regime === 'government_spr' && !sprPolicy.ieaMember) {
        limitations.push(`strategic reserves: ${sprPolicy.regime} (${sprPolicy.operator ?? 'state-run'}, ${sprPolicy.capacityMb ?? '?'}Mb capacity)`);
      }
    } else {
      limitations.push('strategic reserve policy: not classified for this country');
    }
  }

  // The measured share is reported whenever Comtrade has it, even when JODI is
  // missing: it is an input, and the limitation above says the loss is not modeled.
  const gulfCrudeShare = preCrisisShare ? preCrisisShare.share * baseExposure : 0;

  // Keyed on oilModeled, not jodiOilCoverage: a JODI row can exist while its
  // crude.importsKbd is unusable, and a measured share can exist without JODI.
  // Reporting "full" coverage beside an insufficient-data message let the panel
  // paint a green badge; jodi_oil_coverage still reports row presence.
  const derivedCoverage = deriveCoverageLevel(crudeImportsObserved, comtradeCoverage, ieaStocksCoverage, degraded);
  const coverageLevel = netExporter && derivedCoverage === 'unsupported' ? 'partial' : derivedCoverage;
  // Before any rerouting: every Gulf barrel through the chokepoint is lost.
  const lossBeforeBypassKbd = oilModeled ? crudeImportsKbd * gulfCrudeShare * (disruptionPct / 100) : 0;

  // Hormuz bypass (Saudi East-West to Yanbu, UAE ADCOP to Fujairah, Iraqi
  // Kirkuk-Ceyhan) on the pre-crisis baseline. It needs the exporter split
  // of the Gulf share; without it the bypass is reported as not modeled.
  const bypassApplies = chokepointId === 'hormuz_strait' && preCrisisShare != null;
  const bypassByPartner = bypassApplies ? preCrisisShare?.byPartner : undefined;
  const bypassLossKbd = (scenario: BypassScenario): number => (oilModeled && preCrisisShare && bypassByPartner
    ? crudeImportsKbd * baseExposure * lostShareAfterBypass({ gulfShare: preCrisisShare.share, byPartner: bypassByPartner }, disruptionPct / 100, scenario)
    : lossBeforeBypassKbd);
  const bypassModeled = bypassByPartner != null;
  // Headline loss: the steady state after rerouting when the bypass is modeled.
  const crudeLossKbd = bypassModeled ? bypassLossKbd('central') : lossBeforeBypassKbd;

  const toBaseline = (b: MonthlyGulfShare & { basis: string }): CrudeShareBaseline => {
    const share = b.share * baseExposure;
    return {
      basis: b.basis,
      fromMonth: b.fromMonth,
      toMonth: b.toMonth,
      monthsCovered: b.monthsCovered,
      gulfCrudeShare: Math.round(share * 1000) / 1000,
      crudeLossKbd: oilModeled ? Math.round(crudeImportsKbd * share * (disruptionPct / 100) * 10) / 10 : 0,
    };
  };
  const preCrisisBaseline = preCrisisShare ? toBaseline(preCrisisShare) : undefined;
  if (preCrisisBaseline && bypassModeled && oilModeled) {
    preCrisisBaseline.crudeLossAfterBypassKbd = Math.round(crudeLossKbd * 10) / 10;
  }
  if (needsOil && bypassApplies) {
    if (bypassModeled) {
      const routes = Object.entries(HORMUZ_BYPASS_BY_EXPORTER)
        .map(([iso2, b]) => `${BYPASS_EXPORTER_NAMES[iso2] ?? iso2} reroutes ${Math.round(b.recovery.central * 100)}% of its Hormuz-loaded crude via the ${b.route} (${Math.round((1 - b.hormuzShare) * 100)}% already loads outside the Strait)`)
        .join('; ');
      const losses = oilModeled
        ? ` Pre-crisis baseline loss: ${fmtKbd(lossBeforeBypassKbd)} kbd before bypass, ${fmtKbd(crudeLossKbd)} kbd after (range ${fmtKbd(bypassLossKbd('high'))}-${fmtKbd(bypassLossKbd('low'))} kbd from high to low recovery).`
        : '';
      limitations.push(`Hormuz bypass, as of ${HORMUZ_BYPASS_AS_OF}, central case, allocated pro rata to buyers: ${routes}; Kuwait, Qatar, Iran and Bahrain have no bypass.${losses} The first month runs at the before-bypass loss while rerouting ramps up (Japan's imports fell 65% in Apr 2026 and recovered by Jul); products and cover use the after-bypass loss.`);
    } else {
      limitations.push(`Hormuz bypass recovery is not modeled for ${code}: per-exporter shares are unavailable for the pre-crisis baseline, so every Gulf barrel counts as lost.`);
    }
  }
  // Shown beside the headline only: the latest filings already reflect the
  // closure (cargoes rerouted via Yanbu and Fujairah, replacement supply), so
  // they answer "what is still exposed now", not "what if it closed".
  const currentFlows = monthly.current ? toBaseline({ ...monthly.current, basis: 'comtrade_monthly' }) : undefined;
  if (needsOil) {
    if (currentFlows) {
      const loss = oilModeled ? `, crude loss ${currentFlows.crudeLossKbd} kbd` : '';
      // Comtrade records supplier origin, not route: Saudi crude loaded at Yanbu still counts as Saudi.
      const rerouted = chokepointId === 'hormuz_strait' ? '; a supplier-share estimate (Comtrade records origin, not route), so it counts Gulf crude already loading at Yanbu or Fujairah and applies no bypass recovery' : '';
      limitations.push(`Current flows: UN Comtrade monthly import value share ${currentFlows.fromMonth}..${currentFlows.toMonth}: ${(currentFlows.gulfCrudeShare * 100).toFixed(1)}% Gulf${loss}${rerouted}; shown beside the headline, not used for the products table or cover.`);
    } else {
      const reason = originStale && computed.current
        ? 'the latest monthly UN Comtrade fetch failed, so the carried-forward filings are not shown as current'
        : monthlyGap(`fewer than ${CURRENT_FLOWS_WINDOW.months} UN Comtrade monthly crude import filings since ${CURRENT_FLOWS_WINDOW.earliestMonth}`);
      limitations.push(`Current flows unavailable for ${code}: ${reason}.`);
    }
    if (computed.preCrisis || computed.current) {
      if (originStale) {
        const fetched = typeof crudeOrigin.fetchedAt === 'string' ? crudeOrigin.fetchedAt.slice(0, 10) : 'an earlier';
        limitations.push(`Monthly Comtrade crude origin data is carried forward from the ${fetched} fetch; the latest fetch failed.`);
      }
    }
  }

  // Product shortfalls net product trade: exports are redirected home before
  // demand is hit, and Gulf-origin imports are lost with the route. The
  // headline rows use the pre-crisis window; a row seeded before the windows
  // existed nets its latest month instead, and says so. Current flows are
  // reported in one limitation line.
  const preCrisisTrade = parseProductTradeWindow(jodiOil?.productTrade?.preCrisisBaseline);
  const currentTrade = parseProductTradeWindow(jodiOil?.productTrade?.currentFlows);
  const gulfImportLossFactor = gulfProductShare.hasData ? gulfProductShare.share * baseExposure * (disruptionPct / 100) : null;
  const observed = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const latestFlows = (key: RefineryProductKey): ProductTradeFlows => ({
    demandKbd: observed(jodiOil?.[key]?.demandKbd),
    importsKbd: observed(jodiOil?.[key]?.importsKbd),
    exportsKbd: observed(jodiOil?.[key]?.exportsKbd),
  });
  const hasDemand = (flows: ProductTradeFlows | null | undefined): flows is ProductTradeFlows & { demandKbd: number } =>
    flows?.demandKbd != null && flows.demandKbd > 0;
  const balanceRows = (flowsFor: (key: RefineryProductKey) => ProductTradeFlows | null | undefined, lossKbd = crudeLossKbd): ProductBalanceRow[] =>
    REFINERY_PRODUCTS.flatMap(({ key, name, label }) => {
      const flows = flowsFor(key);
      if (!hasDemand(flows)) return [];
      const balance = computeProductBalance({
        crudeLossKbd: lossKbd,
        yieldFactor: refineryYields.yields[key],
        demandKbd: flows.demandKbd,
        importsKbd: flows.importsKbd,
        exportsKbd: flows.exportsKbd,
        gulfImportLossFactor: GULF_ATTRIBUTED_PRODUCTS.has(key) ? gulfImportLossFactor : null,
      });
      return [{ key, name, label, flows, balance }];
    });
  const fromWindow = (key: RefineryProductKey) => hasDemand(preCrisisTrade?.products[key]);
  const primaryRows = oilModeled
    ? balanceRows((key) => (fromWindow(key) ? preCrisisTrade?.products[key] : latestFlows(key)))
    : [];

  const products: ProductImpact[] = primaryRows.map((row) => ({
    product: row.name,
    outputLossKbd: Math.round(row.balance.outputLossKbd * 10) / 10,
    // Round to 1 decimal to match outputLossKbd precision; raw JODI values like
    // 136.5629 kbd wasted display space with fake precision (see #2971).
    demandKbd: Math.round(row.flows.demandKbd * 10) / 10,
    deficitPct: Math.round(row.balance.deficitPct * 10) / 10,
  }));

  if (needsOil && primaryRows.length > 0) {
    const dataMonth = typeof jodiOil?.dataMonth === 'string' ? jodiOil.dataMonth : 'unknown';
    // The label follows the rows actually used, not the window's presence: a
    // window can exist with too few months for any product's demand.
    const latestLabels = primaryRows.filter((row) => !fromWindow(row.key)).map((row) => row.label);
    const windowUsed = preCrisisTrade != null && latestLabels.length < primaryRows.length;
    const basis = !windowUsed
      ? `latest month (${dataMonth}; no usable pre-crisis product trade in this JODI row)`
      : `pre-crisis baseline (${preCrisisTrade.startMonth}–${preCrisisTrade.endMonth}${latestLabels.length > 0 ? `; latest month ${dataMonth} for ${latestLabels.join(', ')}` : ''})`;
    const terms = primaryRows.map((row) => balanceTerm(row, GULF_ATTRIBUTED_PRODUCTS.has(row.key) && gulfImportLossFactor != null));
    limitations.push(`product balance, ${basis}: deficit = refinery output loss + Gulf-origin import loss − exports redirected home, ÷ demand, kb/d${windowUsed ? ' averaged over the window' : ''}: ${terms.join('; ')}.`);
    if (windowUsed) {
      // Current product trade nets the current-flows crude loss when that Gulf share is measured.
      const currentLoss = currentFlows ? currentFlows.crudeLossKbd : crudeLossKbd;
      const lossLabel = currentFlows ? `crude loss at the current-flows Gulf share, ${currentFlows.crudeLossKbd} kbd` : 'crude loss as in the headline';
      const currentRows = currentTrade ? balanceRows((key) => currentTrade.products[key], currentLoss) : [];
      limitations.push(currentTrade && currentRows.length > 0
        ? `product balance, current flows (${currentTrade.startMonth}–${currentTrade.endMonth}, ${currentTrade.months} month${currentTrade.months === 1 ? '' : 's'}; ${lossLabel}): ${currentRows.map((row) => `${row.label} ${row.balance.deficitPct.toFixed(1)}%`).join(', ')}.`
        : `product balance, current flows: unavailable for ${code} in this JODI row.`);
    }
    if (gulfImportLossFactor != null) {
      const year = gulfProductShare.year != null ? ` ${gulfProductShare.year}` : '';
      limitations.push(`Gulf-origin product imports: UN Comtrade${year} HS 2710 import value share from ${GULF_SHARE_SOURCE_LABEL}: ${(gulfProductShare.share * 100).toFixed(1)}%, applied to gasoline, diesel, jet fuel and naphtha imports; LPG imports are not attributed (HS 2711 mixes LPG with LNG).`);
    } else {
      limitations.push(`Gulf-origin product imports are not modeled for ${code}: no UN Comtrade partner-level HS 2710 import rows; deficits net exports only.`);
    }
  }

  const rawDaysOfCover = n(ieaStocks?.daysOfCover);
  const daysOfCover = ieaStocksCoverage ? rawDaysOfCover : 0;
  // A net exporter (IEA or JODI) is -1 whatever the import inputs; the
  // "reported as 0" limitations are skipped for it above. Otherwise, without a
  // modeled loss there is no scenario cover to report: the raw IEA days would
  // pass as the scenario result. The panel keys its cover row on the same
  // "not modeled" limitation text.
  // Importers outside the IEA (India, China) have no stock observation. A
  // dated reserve estimate gives their cover instead, labelled as an estimate.
  const reserveSource = needsOil && !ieaStocksCoverage ? nonIeaReserveFor(code) : undefined;
  const reserveApplied = reserveSource != null && oilModeled && crudeImportsKbd > 0;
  // Stock in days of crude imports, so the IEA cover formula applies unchanged.
  const reserveStockDays = (mb: number): number => (mb * 1000) / crudeImportsKbd;
  const reserveCover = (mb: number): number =>
    computeEffectiveCoverDaysWithRamp(reserveStockDays(mb), false, lossBeforeBypassKbd, crudeLossKbd, crudeImportsKbd);
  const effectiveCoverDays = netExporter
    ? -1
    : !oilModeled
    ? 0
    : reserveApplied
      ? reserveCover(reserveSource.centralMb)
      : computeEffectiveCoverDaysWithRamp(daysOfCover, netExporter, lossBeforeBypassKbd, crudeLossKbd, crudeImportsKbd);
  let reserveEstimate: ReserveEstimate | undefined;
  if (reserveSource) {
    reserveEstimate = {
      scope: reserveSource.scope,
      asOf: reserveSource.asOf,
      credibility: reserveSource.credibility,
      lowMb: reserveSource.lowMb,
      centralMb: reserveSource.centralMb,
      highMb: reserveSource.highMb,
      coverDaysLow: reserveApplied ? reserveCover(reserveSource.lowMb) : undefined,
      coverDaysHigh: reserveApplied ? reserveCover(reserveSource.highMb) : undefined,
    };
    const mb = (v: number): string => v.toLocaleString('en-US');
    const coverText = reserveApplied
      ? `effective cover ~${effectiveCoverDays} days (range ${reserveEstimate.coverDaysLow}-${reserveEstimate.coverDaysHigh}) against the modeled loss`
      : 'cover is not modeled because the oil loss is not modeled';
    limitations.push(`Strategic reserve estimate (not IEA data, ${reserveSource.credibility} credibility): ${reserveSource.scope}; ${mb(reserveSource.centralMb)} M bbl central (range ${mb(reserveSource.lowMb)}-${mb(reserveSource.highMb)}) as of ${reserveSource.asOf}; ${coverText}. ${reserveSource.basis}`);
  }
  if (needsOil && effectiveCoverDays === -1) {
    const kbd = (v: number | null | undefined): string => (v == null ? 'not reported' : Math.round(v).toLocaleString('en-US'));
    limitations.push(jodiNetExporter
      ? `effectiveCoverDays -1 marks a net oil exporter: net crude exporter from JODI ${typeof jodiOil?.dataMonth === 'string' && jodiOil.dataMonth ? jodiOil.dataMonth : '(month unknown)'}, production ${kbd(jodiNetExporter.productionKbd)} kb/d against refinery intake ${kbd(jodiNetExporter.refineryIntakeKbd)}, exports ${kbd(jodiNetExporter.exportsKbd)} against imports ${kbd(jodiNetExporter.importsKbd)}; no import-cover duration applies.`
      : 'effectiveCoverDays -1 marks a net oil exporter (IEA); no import-cover duration applies.');
  } else if (needsOil && effectiveCoverDays >= EFFECTIVE_COVER_DAYS_CAP) {
    limitations.push(`effectiveCoverDays is capped at ${EFFECTIVE_COVER_DAYS_CAP}; the modeled deficit rate is bridgeable beyond the cap, not exhausted at it.`);
  }

  const chokepointConfidence = deriveChokepointConfidence(liveFlowRatio, degraded);

  const assessment = buildAssessment(
    code,
    chokepointId,
    crudeImportsObserved,
    gulfCrudeShare,
    effectiveCoverDays,
    reserveApplied ? Math.round(reserveStockDays(reserveSource.centralMb)) : daysOfCover,
    disruptionPct,
    products,
    coverageLevel,
    degraded,
    ieaStocksCoverage || reserveApplied,
    comtradeCoverage,
    (preCrisisShare?.basis === 'comtrade_monthly'
      ? 'the pre-crisis supply mix'
      : preCrisisShare?.fromMonth ? `the ${preCrisisShare.fromMonth.slice(0, 4)} supply mix` : '')
      + (bypassModeled ? ' after bypass rerouting' : '') || undefined,
    reserveApplied ? 'estimate' : 'iea',
  );

  let gasSensitivity: GasSensitivity | undefined;

  const gasMeasured = needsGas && jodiGas != null && hasGasMeasurements(jodiGas.lngImportsTj, jodiGas.totalDemandTj);
  const zeroLng = gasMeasured && jodiGas?.lngImportsTj === 0;
  // A Hormuz importer with recorded LNG imports and no measured origin share
  // is not modeled: the loss needs a share, and no fixed fraction stands in.
  // Zero recorded imports lose nothing whatever the share. The headline uses
  // the pre-crisis share, or current flows when that is the only measurement.
  const lngMeasured = Boolean(lngOrigin?.preCrisis || lngOrigin?.current);
  const lngOriginMissing = gasMeasured && hormuzGas && !zeroLng && !lngMeasured;
  const routeShare = hormuzGas
    ? (lngOrigin?.preCrisis?.share ?? lngOrigin?.current?.share ?? (zeroLng ? 0 : undefined))
    : CHOKEPOINT_LNG_EXPOSURE[chokepointId];
  const gasDisruption = gasMeasured && !lngOriginMissing && jodiGas
    ? computeGasDisruption(jodiGas.lngImportsTj, jodiGas.totalDemandTj, chokepointId, disruptionPct, routeShare)
    : undefined;
  const gasDataMonth = typeof jodiGas?.dataMonth === 'string' ? jodiGas.dataMonth : '';

  if (needsGas) {
    if (!hormuzGas) {
      limitations.push('Gas results are assumed route sensitivities, not measured country-specific supplier exposure or supply-shortage forecasts.');
    } else if (gasMeasured && lngOrigin && lngMeasured) {
      limitations.push(buildLngOriginLimitation(lngOrigin, gasDataMonth));
      if (!lngOrigin.current) limitations.push(`Current-flows LNG share unavailable for ${code}: ${lngOrigin.currentReason}.`);
      limitations.push('Gas results are route sensitivities, not supply-shortage forecasts.');
    } else if (lngOriginMissing) {
      limitations.push(`LNG origin share unavailable for ${code}: ${lngOrigin?.preCrisisReason}; Strait of Hormuz LNG loss is not modeled.`);
    }
    limitations.push('Gas input availability does not establish freshness or model confidence. JODI observation month and storage date apply separately.');
    limitations.push('Shipping flow ratio is context only, has no observation date in this feed, and does not scale the gas route share.');
    limitations.push('National gas stock does not establish accessible stock, withdrawal capacity, or operational endurance; no buffer duration is estimated.');
    if (!gasMeasured) limitations.push(`Insufficient gas measurements for ${code}: finite nonnegative LNG imports and positive demand are required.`);
  }

  if (gasDisruption && jodiGas) {
    const lngImportsTj = jodiGas.lngImportsTj!;
    const totalDemandTj = jodiGas.totalDemandTj!;
    const lngShareOfImports = typeof jodiGas.lngShareOfImports === 'number'
      && Number.isFinite(jodiGas.lngShareOfImports) && jodiGas.lngShareOfImports >= 0 && jodiGas.lngShareOfImports <= 1
      ? Math.round(jodiGas.lngShareOfImports * 1000) / 1000 : undefined;
    const dataMonth = gasDataMonth;
    const { lngDisruptionTj, deficitPct: gasDeficitPct } = gasDisruption;
    // Both measured baselines apply their share to the same JODI imports; the
    // headline fields equal the pre-crisis one.
    const measured = hormuzGas && lngMeasured ? lngOrigin : undefined;
    const lossAt = (share: number) => computeGasDisruption(lngImportsTj, totalDemandTj, chokepointId, disruptionPct, share)!;
    const toBaseline = (b: LngShareBaselineEntry): LngShareBaseline => ({
      basis: b.basis,
      fromMonth: b.fromMonth,
      toMonth: b.toMonth,
      monthsCovered: b.monthsCovered,
      hormuzLngShare: b.share,
      lngDisruptionTj: lossAt(b.share).lngDisruptionTj,
    });

    let storage: GasStorageObservation | undefined;
    const isEu = EU_GAS_STORAGE_COUNTRIES.has(code);

    if (isEu && gasStorageData
      && typeof gasStorageData.gasTwh === 'number' && Number.isFinite(gasStorageData.gasTwh) && gasStorageData.gasTwh >= 0
      && typeof gasStorageData.fillPct === 'number' && Number.isFinite(gasStorageData.fillPct)
      && gasStorageData.fillPct >= 0 && gasStorageData.fillPct <= 100) {
      storage = {
        fillPct: gasStorageData.fillPct,
        gasTwh: gasStorageData.gasTwh,
        trend: gasStorageData.trend ?? '',
        date: gasStorageData.date ?? '',
        scope: 'europe',
      };
    }

    gasSensitivity = {
      lngShareOfImports,
      lngImportsTj,
      lngDisruptionTj,
      totalDemandTj,
      deficitPct: gasDeficitPct,
      dataAvailable: true,
      assessment: buildGasAssessment(
        code, chokepointId, true, lngImportsTj, gasDeficitPct, disruptionPct, dataMonth,
        measured
          ? { preCrisis: measured.preCrisis, current: measured.current, currentDeficitPct: measured.current ? lossAt(measured.current.share).deficitPct : undefined }
          : undefined,
      ),
      storage,
      dataSource: 'jodi_monthly',
      dataMonth,
      modelBasis: measured ? GAS_MODEL_BASIS.measured : hormuzGas ? GAS_MODEL_BASIS.zeroLng : GAS_MODEL_BASIS.assumed,
      preCrisisBaseline: measured?.preCrisis ? toBaseline(measured.preCrisis) : undefined,
      currentFlows: measured?.current ? toBaseline(measured.current) : undefined,
    };
  }

  const response: ComputeEnergyShockScenarioResponse = {
    countryCode: code,
    chokepointId,
    disruptionPct,
    gulfCrudeShare: Math.round(gulfCrudeShare * 1000) / 1000,
    crudeLossKbd: Math.round(crudeLossKbd * 10) / 10,
    products,
    effectiveCoverDays,
    assessment,
    dataAvailable: oilModeled || netExporter,
    jodiOilCoverage,
    comtradeCoverage,
    ieaStocksCoverage,
    portwatchCoverage,
    coverageLevel,
    limitations,
    degraded,
    chokepointConfidence: needsGas ? 'none' : chokepointConfidence,
    liveFlowRatio: liveFlowRatio !== null ? Math.round(liveFlowRatio * 1000) / 1000 : undefined,
    gasSensitivity,
    preCrisisBaseline,
    currentFlows,
    reserveEstimate,
  };

  if (!needsOil) {
    response.assessment = gasSensitivity?.assessment
      ?? (lngOriginMissing ? lngOriginUnavailableAssessment(code, chokepointId) : buildGasAssessment(code, chokepointId, false, 0, 0, disruptionPct, ''));
    response.dataAvailable = gasSensitivity?.dataAvailable ?? false;
    response.coverageLevel = gasSensitivity ? 'partial' : 'unsupported';
    response.limitations = response.limitations.filter(l =>
      !l.includes('refinery yield') &&
      !l.includes('Gulf crude share') &&
      !l.startsWith('Current flows') &&
      !l.startsWith('Hormuz bypass') &&
      !l.startsWith('Strategic reserve estimate') &&
      !l.startsWith('Monthly Comtrade crude origin') &&
      !l.includes('IEA strategic stock') &&
      !l.includes('PortWatch flow data unavailable, using historical baseline multipliers')
    );
    // Zero out oil-specific fields for gas-only mode
    response.preCrisisBaseline = undefined;
    response.currentFlows = undefined;
    response.reserveEstimate = undefined;
    response.gulfCrudeShare = 0;
    response.crudeLossKbd = 0;
    response.products = [];
    response.effectiveCoverDays = 0;
    response.jodiOilCoverage = false;
    response.comtradeCoverage = false;
    response.ieaStocksCoverage = false;
  }

  if (needsOil && needsGas) {
    response.dataAvailable = oilModeled || netExporter || gasSensitivity != null;
    response.coverageLevel = response.dataAvailable ? 'partial' : 'unsupported';
    // An unavailable scenario renders as its assessment alone; name the missing
    // LNG origin too, or the gas reason would only reach the limitations.
    if (!response.dataAvailable && lngOriginMissing) {
      response.assessment = `${response.assessment} ${lngOriginUnavailableAssessment(code, chokepointId)}`;
    }
  }

  const cacheTtl = degraded ? 300 : SHOCK_CACHE_TTL;
  await setCachedJson(cacheKey, response, cacheTtl);
  return response;
}
