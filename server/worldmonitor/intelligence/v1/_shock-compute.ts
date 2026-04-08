export const GULF_PARTNER_CODES = new Set(['682', '784', '368', '414', '364']);

export const VALID_CHOKEPOINTS = new Set(['hormuz', 'malacca', 'suez', 'babelm']);

export const CHOKEPOINT_EXPOSURE: Record<string, number> = {
  hormuz: 1.0,
  babelm: 1.0,
  suez: 0.6,
  malacca: 0.7,
};

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

export function computeEffectiveCoverDays(
  daysOfCover: number,
  netExporter: boolean,
  crudeLossKbd: number,
  crudeImportsKbd: number,
): number {
  if (netExporter) return -1;
  if (daysOfCover > 0 && crudeLossKbd > 0 && crudeImportsKbd > 0) {
    return Math.round(daysOfCover / (crudeLossKbd / crudeImportsKbd));
  }
  return daysOfCover;
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
  if (coverageLevel === 'unsupported' || !dataAvailable) {
    return `Insufficient import data for ${code} to model ${chokepointId} exposure.`;
  }
  if (effectiveCoverDays === -1) {
    return `${code} is a net oil exporter; ${chokepointId} disruption affects export revenue, not domestic supply.`;
  }
  if (gulfCrudeShare < 0.1 && comtradeCoverage !== false) {
    return `${code} has low Gulf crude dependence (${Math.round(gulfCrudeShare * 100)}%); ${chokepointId} disruption has limited direct impact.`;
  }
  const degradedNote = degraded ? ' (live flow data unavailable, using historical baseline)' : '';
  const ieaCoverText = ieaStocksCoverage === false ? 'unknown' : `${daysOfCover} days`;
  if (effectiveCoverDays > 90) {
    return `With ${daysOfCover} days IEA cover, ${code} can bridge a ${disruptionPct}% ${chokepointId} disruption for ~${effectiveCoverDays} days${degradedNote}.`;
  }
  const dieselDeficit = products.find((p) => p.product === 'Diesel')?.deficitPct ?? 0;
  const jetDeficit = products.find((p) => p.product === 'Jet fuel')?.deficitPct ?? 0;
  const worstDeficit = Math.max(dieselDeficit, jetDeficit);
  const proxyNote = comtradeCoverage === false ? '. Gulf share proxied at 40%' : '';
  return `${code} faces ${worstDeficit.toFixed(1)}% diesel/jet deficit under ${disruptionPct}% ${chokepointId} disruption; IEA cover: ${ieaCoverText}${proxyNote}${degradedNote}.`;
}

export const CHOKEPOINT_LNG_EXPOSURE: Record<string, number> = {
  hormuz: 0.30,
  malacca: 0.50,
  suez: 0.20,
  babelm: 0.20,
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
