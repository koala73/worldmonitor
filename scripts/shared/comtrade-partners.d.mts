export interface ComtradePartner { iso2: string; kind: string; label: string; note: string }
export function createComtradePartnerNormalizer(registry: {partners: Record<string, ComtradePartner>}, standardCodes: Record<string, string>): {
 normalizeComtradePartner(code: unknown): ComtradePartner;
 normalizeComtradeProducts<T extends {topExporters: {partnerCode: number; partnerIso2: string}[]}>(products: T[]): T[];
};
