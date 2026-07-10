// Phase 1 T1.7 source-failure wiring. Reads the resilience-static
// seed-meta and maps failed adapter keys to affected dimensions so the
// aggregation pass can re-tag imputed scores as 'source-failure'
// instead of the table default (stable-absence / unmonitored).
//
// This is the ONLY place in the resilience pipeline that distinguishes
// "country not in curated source" from "seed upstream is down". The
// dimension scorers stay oblivious.

import type { ResilienceDimensionId, ResilienceSeedReader } from './_dimension-scorers';
import { resolveSeedMetaKey } from './_dimension-freshness';
import { INDICATOR_REGISTRY, getIndicatorSourceKeys, type IndicatorSpec } from './_indicator-registry';
import { STANDALONE_SOURCE_META_MAX_STALE_MIN } from './_standalone-source-thresholds';
export { STANDALONE_SOURCE_META_MAX_STALE_MIN } from './_standalone-source-thresholds';

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
  wgi: ['governanceInstitutional', 'macroFiscal', 'stateContinuity'],
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
  // WB applied tariff rate → tradePolicy.
  appliedTariffRate: ['tradePolicy'],
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

export interface StandaloneSourceFailureResult {
  dimensions: Set<ResilienceDimensionId>;
  failedMetaKeys: string[];
}

const MINUTE_MS = 60 * 1000;

const IGNORED_STANDALONE_SOURCE_META_KEYS = new Set([
  // Retired: scoreFuelStockDays always returns coverage=0 +
  // imputationClass=null. The seeder still writes historical data for a
  // possible future replacement dimension, but it should not pollute
  // source-failure logs while the dimension is intentionally inactive.
  'seed-meta:resilience:recovery:fuel-stocks',
]);

/**
 * Read standalone seed-meta records referenced by INDICATOR_REGISTRY and map
 * non-ok or stale source meta to affected dimensions. The resilience-static
 * aggregate is intentionally excluded here because static adapters carry
 * per-dataset failures via readFailedDatasets().
 */
export async function readStandaloneSourceFailureDimensions(
  reader: ResilienceSeedReader,
  nowMs?: number,
): Promise<StandaloneSourceFailureResult> {
  const metaKeyToIndicators = buildStandaloneMetaKeyToIndicators(INDICATOR_REGISTRY);

  const dimensions = new Set<ResilienceDimensionId>();
  const failedMetaKeys: string[] = [];

  await Promise.all(
    [...metaKeyToIndicators.entries()].map(async ([metaKey, indicators]) => {
      try {
        const meta = await reader(metaKey);
        if (!meta || typeof meta !== 'object') return;

        const status = (meta as { status?: unknown }).status;
        const nonOk = Boolean(status) && status !== 'ok';
        const fetchedAt = Number((meta as { fetchedAt?: unknown }).fetchedAt);
        const hasFetchedAt = Number.isFinite(fetchedAt) && fetchedAt > 0;
        const maxStaleMin = STANDALONE_SOURCE_META_MAX_STALE_MIN[metaKey];
        const stale = hasFetchedAt
          && typeof maxStaleMin === 'number'
          && ((nowMs ?? Date.now()) - fetchedAt) > maxStaleMin * MINUTE_MS;

        if (!nonOk && !stale) return;

        failedMetaKeys.push(metaKey);
        for (const indicator of indicators) {
          dimensions.add(indicator.dimension);
        }
      } catch {
        // Match readFreshnessMap/readFailedDatasets: Redis/meta read failures
        // should not fail the country score request.
      }
    }),
  );

  failedMetaKeys.sort();
  return { dimensions, failedMetaKeys };
}

export function buildStandaloneMetaKeyToIndicators(
  indicators: readonly IndicatorSpec[],
): Map<string, IndicatorSpec[]> {
  const metaKeyToIndicators = new Map<string, IndicatorSpec[]>();
  for (const indicator of indicators) {
    for (const sourceKey of getIndicatorSourceKeys(indicator)) {
      const metaKey = resolveSeedMetaKey(sourceKey);
      if (metaKey === RESILIENCE_STATIC_META_KEY) continue;
      if (IGNORED_STANDALONE_SOURCE_META_KEYS.has(metaKey)) continue;
      const existing = metaKeyToIndicators.get(metaKey);
      if (existing) {
        if (!existing.includes(indicator)) {
          existing.push(indicator);
        }
      } else {
        metaKeyToIndicators.set(metaKey, [indicator]);
      }
    }
  }
  return metaKeyToIndicators;
}
