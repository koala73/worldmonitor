/**
 * Multi-sector cost shock model (Phase 5).
 *
 * Extends the energy-only shock model to all 10 seeded HS2 sectors with a simpler
 * freight + war-risk based estimator. For each sector we compute:
 *
 *   warRiskPremiumBps   = basis-point surcharge from chokepoint tier
 *   freightAddedPctPerTon = (addedCostMultiplier - 1) from best suitable bypass
 *   addedTransitDays    = bypass transit penalty (informational)
 *   dailyAddedCost      = importValueAnnual * (freightAddedPctPerTon + bps/10000) / 365
 *   totalCostShockNDays = dailyAddedCost * N
 *
 * HS27 (energy) keeps its dedicated energy shock model in get-country-cost-shock.ts;
 * this computation runs for HS!=27 and for presentation in the multi-sector calculator.
 */

import { BYPASS_CORRIDORS_BY_CHOKEPOINT, type BypassCorridor } from '../../../_shared/bypass-corridors';
import { warRiskTierToInsurancePremiumBps } from './_insurance-tier';

/** Top 10 HS2 sectors seeded by scripts/seed-comtrade-bilateral-hs4.mjs. */
export const SEEDED_HS2_CODES = ['27', '84', '85', '87', '30', '72', '39', '29', '10', '62'] as const;

/** Friendly labels for display. Mirrors HS2_SHORT_LABELS in src/services/supply-chain. */
export const MULTI_SECTOR_HS2_LABELS: Record<string, string> = {
  '27': 'Energy',
  '84': 'Machinery',
  '85': 'Electronics',
  '87': 'Vehicles',
  '30': 'Pharma',
  '72': 'Iron & Steel',
  '39': 'Plastics',
  '29': 'Chemicals',
  '10': 'Cereals',
  '62': 'Apparel',
};

/** HS4 → HS2 is always the first two digits, zero-padded. */
export function hs4ToHs2(hs4: string): string {
  const padded = hs4.padStart(4, '0');
  return padded.slice(0, 2).replace(/^0+/, '') || '0';
}

export interface MultiSectorCostShock {
  hs2: string;
  hs2Label: string;
  importValueAnnual: number;
  freightAddedPctPerTon: number;
  warRiskPremiumBps: number;
  addedTransitDays: number;
  totalCostShockPerDay: number;
  totalCostShock30Days: number;
  totalCostShock90Days: number;
  /** Cost for the requested closureDays window (matches clampClosureDays(closureDays)). */
  totalCostShock: number;
  /** Echoes the clamped closure duration used for totalCostShock (1-365). */
  closureDays: number;
}

/** Product row as persisted by seed-comtrade-bilateral-hs4. */
export interface SeededProduct {
  hs4: string;
  description: string;
  totalValue: number;
  year: number;
}

/**
 * Pick the cheapest viable bypass corridor for a chokepoint.
 * Excludes "no-bypass" placeholder entries (suitableCargoTypes.length === 0),
 * hypothetical/proposed corridors with negative uplift (addedCostMultiplier < 1),
 * and full-closure-only corridors (which only activate on 100% closure scenarios).
 * Prefers lower addedTransitDays, then lower addedCostMultiplier as tiebreaker.
 */
export function pickBestBypass(chokepointId: string): BypassCorridor | null {
  const corridors = BYPASS_CORRIDORS_BY_CHOKEPOINT[chokepointId] ?? [];
  const viable = corridors.filter(c =>
    c.suitableCargoTypes.length > 0
    && c.addedCostMultiplier >= 1
    && c.activationThreshold === 'partial_closure',
  );
  if (viable.length === 0) return null;
  return [...viable].sort((a, b) => {
    if (a.addedTransitDays !== b.addedTransitDays) return a.addedTransitDays - b.addedTransitDays;
    return a.addedCostMultiplier - b.addedCostMultiplier;
  })[0] ?? null;
}

/** Aggregate seeded HS4 product values to annual import totals keyed by HS2. */
export function aggregateAnnualImportsByHs2(
  products: readonly SeededProduct[] | undefined,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const hs2 of SEEDED_HS2_CODES) totals[hs2] = 0;
  if (!Array.isArray(products)) return totals;
  for (const p of products) {
    if (!p || typeof p.totalValue !== 'number' || !Number.isFinite(p.totalValue) || p.totalValue <= 0) continue;
    const hs2 = hs4ToHs2(String(p.hs4 ?? ''));
    if (!(hs2 in totals)) continue;
    totals[hs2] = (totals[hs2] ?? 0) + p.totalValue;
  }
  return totals;
}

/**
 * Compute cost shock for a single sector. Pure function; no I/O.
 *
 * @param hs2               HS2 sector code (e.g. "85")
 * @param importValueAnnual total annual import value (USD) for this sector
 * @param chokepointId      which chokepoint is assumed closed
 * @param warRiskTier       war risk tier string (proto enum format)
 * @param closureDays       how many days of closure to model (1-365)
 */
export function computeMultiSectorShock(
  hs2: string,
  importValueAnnual: number,
  chokepointId: string,
  warRiskTier: string,
  closureDays: number,
): MultiSectorCostShock {
  const normalizedDays = clampClosureDays(closureDays);
  const warRiskPremiumBps = warRiskTierToInsurancePremiumBps(warRiskTier);
  const bypass = pickBestBypass(chokepointId);
  const freightAddedPctPerTon = bypass ? Math.max(0, bypass.addedCostMultiplier - 1) : 0;
  const addedTransitDays = bypass?.addedTransitDays ?? 0;

  const annualImpactRate = freightAddedPctPerTon + warRiskPremiumBps / 10_000;
  const safeImports = Number.isFinite(importValueAnnual) && importValueAnnual > 0 ? importValueAnnual : 0;
  const dailyAddedCost = (safeImports * annualImpactRate) / 365;

  return {
    hs2,
    hs2Label: MULTI_SECTOR_HS2_LABELS[hs2] ?? `HS ${hs2}`,
    importValueAnnual: Math.round(safeImports),
    freightAddedPctPerTon: Math.round(freightAddedPctPerTon * 10_000) / 10_000,
    warRiskPremiumBps,
    addedTransitDays,
    totalCostShockPerDay: Math.round(dailyAddedCost),
    totalCostShock30Days: Math.round(dailyAddedCost * 30),
    totalCostShock90Days: Math.round(dailyAddedCost * 90),
    totalCostShock: Math.round(dailyAddedCost * normalizedDays),
    closureDays: normalizedDays,
  };
}

/** Bound user-supplied closure duration to a sane 1-365 day window. */
export function clampClosureDays(days: number | undefined | null): number {
  if (!Number.isFinite(days as number)) return 30;
  const n = Math.floor(days as number);
  if (n < 1) return 1;
  if (n > 365) return 365;
  return n;
}

/**
 * Compute shocks for all 10 seeded HS2 sectors in one pass.
 * Sorted by totalCostShockPerDay descending so top entries dominate the UI.
 */
export function computeMultiSectorShocks(
  importsByHs2: Record<string, number>,
  chokepointId: string,
  warRiskTier: string,
  closureDays: number,
): MultiSectorCostShock[] {
  const shocks = SEEDED_HS2_CODES.map(hs2 =>
    computeMultiSectorShock(hs2, importsByHs2[hs2] ?? 0, chokepointId, warRiskTier, closureDays),
  );
  return shocks.sort((a, b) => b.totalCostShockPerDay - a.totalCostShockPerDay);
}
