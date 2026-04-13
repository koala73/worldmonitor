/**
 * Source tier system for news feed prioritization.
 * Data is in shared/source-tiers.json so server TS (this module via
 * resolveJsonModule) and the relay CJS (via requireShared('source-tiers.json'))
 * load the same bytes. Parity enforced structurally — no drift possible.
 *
 * Tier 1: Wire services / official gov/intl orgs — fastest, most authoritative
 * Tier 2: Major established outlets — high-quality journalism
 * Tier 3: Specialty / regional / think tank sources — domain expertise
 * Tier 4: Aggregators and blogs — useful but less authoritative
 */
import sourceTiersData from '../../shared/source-tiers.json';

export const SOURCE_TIERS: Record<string, number> = sourceTiersData as Record<string, number>;

export function getSourceTier(sourceName: string): number {
  return SOURCE_TIERS[sourceName] ?? 4;
}
