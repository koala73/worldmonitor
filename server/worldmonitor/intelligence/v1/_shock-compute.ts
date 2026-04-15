export const GULF_PARTNER_CODES = new Set(['682', '784', '368', '414', '364']);

export const VALID_CHOKEPOINTS = new Set(['hormuz_strait', 'malacca_strait', 'suez', 'bab_el_mandeb']);

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

export function deriveCoverageLevel(
  jodiOil: boolean,
  comtrade: boolean,
  ieaStocksCoverage?: boolean,
  degraded?: boolean,
): 'full' | 'partial' | 'unsupported' {
  if (!jodiOil) return 'unsupported';
  if (!comtrade) return 'partial';
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
  if (coverageLevel === 'unsupported' || !dataAvailable) {
    return `Insufficient import data for ${country} to model ${cp} exposure.`;
  }
  if (effectiveCoverDays === -1) {
    return `${country} is a net oil exporter; ${cp} disruption affects export revenue, not domestic supply.`;
  }
  if (gulfCrudeShare < 0.1 && comtradeCoverage !== false) {
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
  const proxyNote = comtradeCoverage === false ? '. Gulf share proxied at 40%' : '';
  return `${country} faces ${worstDeficit.toFixed(1)}% ${worstProduct} deficit under ${disruptionPct}% ${cp} disruption; IEA cover: ${ieaCoverText}${proxyNote}${degradedNote}.`;
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

export type FuelMode = 'oil' | 'gas' | 'both';

export function parseFuelMode(raw: string | undefined | null): FuelMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'gas' || v === 'both') return v;
  return 'oil';
}

export function computeGasDisruption(
  lngImportsTj: number,
  totalDemandTj: number,
  chokepointId: string,
  disruptionPct: number,
  liveFlowRatio?: number | null,
): { lngDisruptionTj: number; deficitPct: number } {
  const baseExposure = CHOKEPOINT_LNG_EXPOSURE[chokepointId] ?? 0;
  const exposure = liveFlowRatio != null ? baseExposure * liveFlowRatio : baseExposure;
  const lngDisruptionTj = lngImportsTj * exposure * (disruptionPct / 100);
  const deficitPct = totalDemandTj > 0
    ? clamp((lngDisruptionTj / totalDemandTj) * 100, 0, 100)
    : 0;
  return {
    lngDisruptionTj: Math.round(lngDisruptionTj * 10) / 10,
    deficitPct: Math.round(deficitPct * 10) / 10,
  };
}

export function computeGasBufferDays(gasTwh: number, lngDisruptionTj: number): number {
  if (lngDisruptionTj <= 0 || gasTwh <= 0) return 0;
  const storedTj = gasTwh * 3600;
  const dailyLossTj = lngDisruptionTj / 30;
  return Math.round(storedTj / dailyLossTj);
}

export function buildGasAssessment(
  code: string,
  chokepointId: string,
  dataAvailable: boolean,
  lngImportsTj: number,
  lngShareOfImports: number,
  deficitPct: number,
  bufferDays: number,
  disruptionPct: number,
  hasStorage: boolean,
): string {
  if (!dataAvailable) {
    return `Insufficient gas import data for ${code} to model ${chokepointId} LNG exposure.`;
  }
  if (lngImportsTj === 0) {
    return `${code} imports gas via pipeline only (no LNG); ${chokepointId} disruption has no direct LNG impact.`;
  }
  if (lngShareOfImports < 0.1) {
    return `${code} has low LNG dependence (${Math.round(lngShareOfImports * 100)}% of gas imports via LNG); ${chokepointId} disruption has limited gas impact.`;
  }
  if (hasStorage && bufferDays > 90) {
    return `${code} has ${bufferDays} days of gas storage buffer under ${disruptionPct}% ${chokepointId} LNG disruption.`;
  }
  const storageNote = hasStorage ? `; gas storage covers ~${bufferDays} days` : '';
  return `${code} faces ${deficitPct.toFixed(1)}% gas supply deficit under ${disruptionPct}% ${chokepointId} LNG disruption${storageNote}.`;
}
