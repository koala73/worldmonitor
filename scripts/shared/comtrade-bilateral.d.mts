import type { ComtradePartner } from './comtrade-partners.mjs';
export interface ComtradeRecord {
 cmdCode: string; partnerCode: string; primaryValue: number; year: number;
 /** Present only on a world-exports response, whose request omits reporterCode. */
 reporterCode?: string;
 netWeightKg: number | null; netWeightEstimated: boolean; quantity: number | null; quantityUnitCode: number | null;
}
export interface ComtradeWorldExporter {
 reporterCode: number; iso2: string; valueUsd: number; netWeightKg: number | null;
}
export interface ComtradeWorldExportHeading {
 year: number; exporters: ComtradeWorldExporter[];
 /** Reporters whose newest filing for the heading predates `year`: not ranked. */
 unrankedReporterCount: number;
}
export interface ComtradeExporter { partnerCode: number; partnerIso2: string; value: number; share: number }
export interface ComtradePartnerRow extends ComtradeExporter {
 netWeightKg: number | null; netWeightEstimated: boolean; quantity: number | null; quantityUnitCode: number | null;
}
export interface ComtradeProduct {
 hs4: string; description: string; totalValue: number; year: number; denominatorBasis: string;
 topExporters: ComtradeExporter[]; partners: ComtradePartnerRow[]; worldNetWeightKg: number | null;
}
export interface ComtradeQuantityUnits {
 sourceUrl: string; retrievedAt: string; units: Record<string, {abbr: string; description: string}>;
}
export type ComtradeFailureState = 'malformed' | 'incomplete' | 'unavailable';
export const PREVIEW_MAX_RECORDS: number;
export const MIN_PARTNER_SHARE: number;
export const MIN_PARTNERS: number;
export const MAX_PARTNERS: number;
export class ComtradeResponseError extends Error {
 readonly kind: 'malformed' | 'incomplete';
 constructor(kind: 'malformed' | 'incomplete', message: string);
}
export function comtradeFailureState(error: unknown): ComtradeFailureState;
export function selectPartners(
 product: Pick<ComtradeProduct, 'totalValue' | 'partners'>,
 options?: {minShare?: number; minPartners?: number; maxPartners?: number},
): {partners: ComtradePartnerRow[]; omittedCount: number; omittedShare: number};
export function leadingExporters(product: Pick<ComtradeProduct, 'topExporters'>, n?: number): ComtradeExporter[];
/** One row of `comtrade:bilateral-hs4-partners:{iso2}:v1`. */
export interface ComtradePartnersProduct {
 hs4: string; year: number; denominatorBasis?: string; totalValue: number; worldNetWeightKg: number | null;
 partners: ComtradePartnerRow[]; omittedCount: number; omittedShare: number;
}
export function toCanonicalProduct<T extends {topExporters: ComtradeExporter[]}>(
 product: T & {partners?: unknown; worldNetWeightKg?: unknown},
): Omit<T, 'partners' | 'worldNetWeightKg'>;
export function toPartnersProduct(
 product: Pick<ComtradeProduct, 'hs4' | 'year' | 'totalValue'> & {denominatorBasis?: string; worldNetWeightKg?: number | null; partners?: ComtradePartnerRow[]},
): ComtradePartnersProduct;
export function createComtradeBilateralCatalogue(
 strategic: {products: {bilateralHs4Code?: string; bilateralLabel?: string; label: string}[]},
 commodities: {commodities: {hs4: string[]; basketLabel: string}[]},
 normalizeComtradePartner: (code: unknown) => ComtradePartner,
 quantityUnits?: ComtradeQuantityUnits,
): {
 HS4_CODES: string[]; HS4_LABELS: Record<string, string>; MAX_HS4_CODES_PER_BATCH: number; HS4_BATCHES: string[][];
 parseRecords(data: unknown, maxRecords?: number): ComtradeRecord[];
 groupByProduct(records: ComtradeRecord[], fallbackYear?: number): ComtradeProduct[];
 groupWorldExports(records: ComtradeRecord[]): Record<string, ComtradeWorldExportHeading>;
 quantityUnitAbbr(code: unknown): string | null;
};
