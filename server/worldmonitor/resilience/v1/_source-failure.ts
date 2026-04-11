// Phase 1 T1.7 source-failure wiring. Reads the resilience-static
// seed-meta and maps failed adapter keys to affected dimensions so the
// aggregation pass can re-tag imputed scores as 'source-failure'
// instead of the table default (stable-absence / unmonitored).
//
// This is the ONLY place in the resilience pipeline that distinguishes
// "country not in curated source" from "seed upstream is down". The 13
// dimension scorers stay oblivious.

import type { ResilienceDimensionId, ResilienceSeedReader } from './_dimension-scorers';

// Must match RESILIENCE_STATIC_META_KEY in scripts/seed-resilience-static.mjs.
export const RESILIENCE_STATIC_META_KEY = 'seed-meta:resilience:static';

/**
 * Mapping from the adapter keys used in scripts/seed-resilience-static.mjs
 * `fetchAllDatasetMaps()` to the ResilienceDimensionIds whose scorers
 * consume that dataset. A single adapter can affect multiple dimensions
 * (e.g. WGI feeds governance and macro-fiscal institutional-quality
 * sub-signals). When in doubt, prefer broader coverage so the tag fires
 * reliably rather than silently missing a failed source.
 *
 * Dataset keys not listed here do not cause any dimension to flip to
 * source-failure. If you add a new adapter to the seed, add its mapping
 * here in the same PR.
 */
export const DATASET_TO_DIMENSIONS: Readonly<Record<string, ReadonlyArray<ResilienceDimensionId>>> = {
  // WGI (Worldwide Governance Indicators) drives the governance signal
  // in governanceInstitutional (primary) and indirectly macroFiscal
  // (fiscal institutional quality weight).
  wgi: ['governanceInstitutional', 'macroFiscal'],
  // World Bank infrastructure indicators feed both the infrastructure
  // dimension (primary) and logisticsSupply (paved roads sub-signal).
  infrastructure: ['infrastructure', 'logisticsSupply'],
  // Global Peace Index → socialCohesion (peace / internal conflict
  // sub-signal).
  gpi: ['socialCohesion'],
  // RSF Press Freedom Index → informationCognitive.
  rsf: ['informationCognitive'],
  // WHO health indicators → healthPublicService.
  who: ['healthPublicService'],
  // FAO / FSIN food security → foodWater.
  fao: ['foodWater'],
  // AQUASTAT water stress → foodWater.
  aquastat: ['foodWater'],
  // IEA / Eurostat energy import dependency → energy.
  iea: ['energy'],
  // World Bank trade to GDP → logisticsSupply (trade exposure weighting).
  tradeToGdp: ['logisticsSupply'],
  // World Bank FX reserves (months of imports) → currencyExternal.
  fxReservesMonths: ['currencyExternal'],
  // WB applied tariff rate → tradeSanctions.
  appliedTariffRate: ['tradeSanctions'],
};

/**
 * Read the resilience-static seed-meta and extract the failed dataset
 * adapter keys. Returns an empty array when the seed-meta is missing,
 * malformed, or when failedDatasets is not an array of strings. Does
 * NOT throw.
 */
export async function readFailedDatasets(
  reader: ResilienceSeedReader,
): Promise<string[]> {
  try {
    const raw = await reader(RESILIENCE_STATIC_META_KEY);
    if (!raw || typeof raw !== 'object') return [];
    const maybe = (raw as { failedDatasets?: unknown }).failedDatasets;
    if (!Array.isArray(maybe)) return [];
    return maybe.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/**
 * Expand a list of failed adapter keys into the set of dimensions whose
 * imputed scores should be re-tagged as source-failure. Unmapped adapter
 * keys are ignored with no side effect.
 */
export function failedDimensionsFromDatasets(
  failedDatasets: ReadonlyArray<string>,
): Set<ResilienceDimensionId> {
  const out = new Set<ResilienceDimensionId>();
  for (const key of failedDatasets) {
    const dims = DATASET_TO_DIMENSIONS[key];
    if (!dims) continue;
    for (const dim of dims) out.add(dim);
  }
  return out;
}
