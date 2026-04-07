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
    const val = typeof flow.tradeValueUsd === 'number' ? flow.tradeValueUsd : 0;
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

export function buildAssessment(
  code: string,
  chokepointId: string,
  dataAvailable: boolean,
  gulfCrudeShare: number,
  effectiveCoverDays: number,
  daysOfCover: number,
  disruptionPct: number,
  products: Array<{ product: string; deficitPct: number }>,
): string {
  if (!dataAvailable) {
    return `Insufficient import data for ${code} to model ${chokepointId} exposure.`;
  }
  if (effectiveCoverDays === -1) {
    return `${code} is a net oil exporter; ${chokepointId} disruption affects export revenue, not domestic supply.`;
  }
  if (gulfCrudeShare < 0.1) {
    return `${code} has low Gulf crude dependence (${Math.round(gulfCrudeShare * 100)}%); ${chokepointId} disruption has limited direct impact.`;
  }
  if (effectiveCoverDays > 90) {
    return `With ${daysOfCover} days IEA cover, ${code} can bridge a ${disruptionPct}% ${chokepointId} disruption for ~${effectiveCoverDays} days.`;
  }
  const dieselDeficit = products.find((p) => p.product === 'Diesel')?.deficitPct ?? 0;
  const jetDeficit = products.find((p) => p.product === 'Jet fuel')?.deficitPct ?? 0;
  const worstDeficit = Math.max(dieselDeficit, jetDeficit);
  return `${code} faces ${worstDeficit.toFixed(1)}% diesel/jet deficit under ${disruptionPct}% ${chokepointId} disruption; IEA cover: ${daysOfCover} days.`;
}
