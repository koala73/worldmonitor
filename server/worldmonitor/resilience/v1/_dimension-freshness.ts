// T1.5 Phase 1 of the country-resilience reference-grade upgrade plan
// (docs/internal/country-resilience-upgrade-plan.md).
//
// Propagation pass: PR #2947 shipped the staleness classifier foundation
// (classifyStaleness, cadence taxonomy, three staleness levels) and
// explicitly deferred the dimension-level propagation. This module owns
// that propagation pass.
//
// Design: aggregation happens one level above the 13 dimension scorers.
// The scorers stay unchanged; this module reads every seed-meta key
// referenced by INDICATOR_REGISTRY, builds a sourceKey → fetchedAtMs
// map, and aggregates per dimension:
//   - staleness: MAX (worst) level across the dimension's indicators
//     (stale > aging > fresh).
//   - lastObservedAtMs: MIN (oldest) fetchedAt across the dimension's
//     indicators (oldest signal is the most conservative bound).
//
// The module is pure. The Redis reader is injected so unit tests can
// pass a deterministic fake map without touching network or Redis.

import {
  classifyStaleness,
  type StalenessLevel,
} from '../../../_shared/resilience-freshness';
import type { ResilienceDimensionId } from './_dimension-scorers';
import { INDICATOR_REGISTRY } from './_indicator-registry';

export interface DimensionFreshnessResult {
  /** Oldest (min) `fetchedAt` across the dimension's indicators. 0 when nothing ever observed. */
  lastObservedAtMs: number;
  /** Worst (max) staleness across the dimension's indicators. `''` when no indicators exist for the dimension. */
  staleness: StalenessLevel | '';
}

// Strip `:{placeholder}` templates and `:*` wildcard segments from a
// registry sourceKey so we can project it onto a real seed-meta key.
// Cases:
//   'resilience:static:{ISO2}'        -> 'resilience:static'
//   'resilience:static:*'             -> 'resilience:static'
//   'energy:mix:v1:{ISO2}'            -> 'energy:mix:v1'
//   'displacement:summary:v1:{year}'  -> 'displacement:summary:v1'
//   'economic:imf:macro:v2'           -> 'economic:imf:macro:v2' (unchanged)
function stripTemplateTokens(sourceKey: string): string {
  return sourceKey.replace(/:\{[^}]+\}/g, '').replace(/:\*/g, '');
}

// Mirrors the version-strip in scripts/_seed-utils.mjs writeExtraKeyWithMeta:
//   const metaKey = metaKeyOverride || `seed-meta:${key.replace(/:v\d+$/, '')}`;
// runSeed() uses `seed-meta:${domain}:${resource}` and never appends a
// version suffix. Many registry sourceKeys end in `:v1` / `:v2` for
// canonical data-key versioning, but the seed-meta variant always drops
// the trailing version. Strip it here too so we line up with reality.
function stripTrailingVersion(stripped: string): string {
  return stripped.replace(/:v\d+$/, '');
}

// Explicit overrides for cases where the template/version strip still
// diverges from the real seed-meta key. Keep this table short: add an
// entry only when verified against api/seed-health.js, api/health.js,
// or the relevant scripts/seed-*.mjs runSeed() / writeExtraKeyWithMeta
// call.
//
// Key: result of `stripTrailingVersion(stripTemplateTokens(sourceKey))`.
// Value: the bare seed-meta tail (prepend `seed-meta:` to get the full key).
const SOURCE_KEY_META_OVERRIDES: Readonly<Record<string, string>> = {
  // seed-imf-macro.mjs: runSeed('economic', 'imf-macro', ...) writes
  // seed-meta:economic:imf-macro (dash, not colon).
  'economic:imf:macro': 'economic:imf-macro',
  // seed-imf-growth.mjs / seed-imf-labor.mjs / seed-imf-external.mjs all use
  // runSeed('economic', 'imf-{theme}', ...) → seed-meta key uses dash.
  'economic:imf:growth': 'economic:imf-growth',
  'economic:imf:labor': 'economic:imf-labor',
  'economic:imf:external': 'economic:imf-external',
  // seed-bis-data.mjs: runSeed('economic', 'bis', ...) writes
  // seed-meta:economic:bis (the sub-resource 'eer' is only in the data
  // key, not the meta key).
  'economic:bis:eer': 'economic:bis',
  // seed-bis-extended.mjs writes per-dataset seed-meta keys
  // (seed-meta:economic:bis-dsr, seed-meta:economic:bis-property-residential,
  // seed-meta:economic:bis-property-commercial) so a DSR-only outage does
  // not falsely mark the property datasets as fresh (and vice versa).
  // These mirror the per-dataset SEED_META entries in api/health.js.
  // The aggregate seed-meta:economic:bis-extended key still exists as a
  // "seeder ran" signal read by api/seed-health.js; do not remove it, but
  // this resilience-freshness map must not collapse to it.
  'economic:bis:dsr': 'economic:bis-dsr',
  'economic:bis:property-residential': 'economic:bis-property-residential',
  'economic:bis:property-commercial': 'economic:bis-property-commercial',
  // seed-economy.mjs: runSeed('economic', 'energy-prices', ...) writes
  // seed-meta:economic:energy-prices for the economic:energy:v1:all key.
  // The :v1:all tail means neither template-strip nor version-strip
  // normalizes this one; it has to be an explicit override.
  'economic:energy:v1:all': 'economic:energy-prices',
  // OWID energy mix seeder: the data keys live under energy:mix:v1:{ISO2}
  // but the seed-meta is seed-meta:economic:owid-energy-mix (both
  // energyExposure and energyMixAll in api/health.js point at it).
  'energy:mix': 'economic:owid-energy-mix',
  // GIE gas storage per-country keys share one meta key.
  'energy:gas-storage': 'energy:gas-storage-countries',
  // ais-relay.cjs writes seed-meta:news:threat-summary (single dash).
  'news:threat:summary': 'news:threat-summary',
  // ais-relay.cjs writes seed-meta:intelligence:social-reddit (single dash).
  'intelligence:social:reddit': 'intelligence:social-reddit',
};

/**
 * Resolve a registry `sourceKey` to the real `seed-meta:<...>` key it
 * should be fetched under. Exposed for unit tests and a registry
 * coverage assertion; callers of `readFreshnessMap` do not need to use
 * this directly.
 *
 * Resolution order:
 *   1. Strip `:{placeholder}` and `:*` wildcard segments.
 *   2. Strip trailing `:v\d+` (mirrors writeExtraKeyWithMeta +
 *      runSeed() behavior in scripts/_seed-utils.mjs).
 *   3. Apply `SOURCE_KEY_META_OVERRIDES` if the stripped form is still
 *      divergent from the real seed-meta key.
 */
export function resolveSeedMetaKey(sourceKey: string): string {
  const stripped = stripTrailingVersion(stripTemplateTokens(sourceKey));
  const override = SOURCE_KEY_META_OVERRIDES[stripped];
  return `seed-meta:${override ?? stripped}`;
}

// Stale dominates aging dominates fresh. A single stale signal forces
// the whole dimension to stale, since the badge must represent the
// freshness floor of the dimension, not the ceiling.
const STALENESS_ORDER: Record<StalenessLevel, number> = {
  fresh: 0,
  aging: 1,
  stale: 2,
};

/**
 * Aggregate freshness across all indicators in a dimension.
 *
 * Pure function. Missing sourceKeys in `freshnessMap` are treated as
 * "never observed" (classifyStaleness returns `stale` with infinite
 * age), so a dimension with no seed-meta coverage at all collapses to
 * `stale` + `lastObservedAtMs: 0`.
 *
 * @param dimensionId - The dimension id to aggregate for.
 * @param freshnessMap - sourceKey → fetchedAtMs. Missing keys are
 *   treated as "never observed".
 * @param nowMs - Override clock for deterministic tests. Defaults to
 *   `Date.now()` via the classifier.
 */
export function classifyDimensionFreshness(
  dimensionId: ResilienceDimensionId,
  freshnessMap: Map<string, number>,
  nowMs?: number,
): DimensionFreshnessResult {
  const indicators = INDICATOR_REGISTRY.filter((indicator) => indicator.dimension === dimensionId);
  if (indicators.length === 0) {
    // Defensive: a dimension with no registry entries gets an empty
    // freshness payload rather than a spurious "stale" classification.
    return { lastObservedAtMs: 0, staleness: '' };
  }

  let oldestMs = Number.POSITIVE_INFINITY;
  let worstStaleness: StalenessLevel = 'fresh';

  for (const indicator of indicators) {
    const lastObservedAtMs = freshnessMap.get(indicator.sourceKey) ?? null;
    const result = classifyStaleness({
      lastObservedAtMs,
      cadence: indicator.cadence,
      nowMs,
    });
    if (STALENESS_ORDER[result.staleness] > STALENESS_ORDER[worstStaleness]) {
      worstStaleness = result.staleness;
    }
    if (lastObservedAtMs != null && Number.isFinite(lastObservedAtMs) && lastObservedAtMs < oldestMs) {
      oldestMs = lastObservedAtMs;
    }
  }

  return {
    lastObservedAtMs: Number.isFinite(oldestMs) ? oldestMs : 0,
    staleness: worstStaleness,
  };
}

/**
 * Read all seed-meta keys referenced by INDICATOR_REGISTRY and return
 * a `Map<sourceKey, fetchedAtMs>`. Missing or malformed seed-meta
 * entries are omitted; the map lookup then returns `undefined`, which
 * the classifier treats as "never observed" (stale).
 *
 * Registry sourceKeys that use template placeholders
 * (`resilience:static:{ISO2}`, `displacement:summary:v1:{year}`, etc.)
 * or trailing `:v\d+` suffixes are resolved to their real seed-meta
 * keys via `resolveSeedMetaKey`. Reads are deduplicated by the resolved
 * meta key so 15+ `resilience:static:*` indicators collapse to one
 * Redis fetch, and results are projected back onto every registry
 * sourceKey that shares the same meta key.
 *
 * The reader is injected so callers can pass `defaultSeedReader` in
 * production or a fixture reader in tests.
 */
export async function readFreshnessMap(
  reader: (key: string) => Promise<unknown | null>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();

  // sourceKey -> resolved seed-meta key. Preserves every registry
  // sourceKey (including templated ones) so we can project back.
  const sourceKeyToMetaKey = new Map<string, string>();
  for (const indicator of INDICATOR_REGISTRY) {
    if (!sourceKeyToMetaKey.has(indicator.sourceKey)) {
      sourceKeyToMetaKey.set(indicator.sourceKey, resolveSeedMetaKey(indicator.sourceKey));
    }
  }

  // Dedupe by resolved meta key: 15+ resilience:static:{ISO2} entries
  // all share seed-meta:resilience:static, and we only want one read.
  const uniqueMetaKeys = [...new Set(sourceKeyToMetaKey.values())];
  const metaKeyFetchedAt = new Map<string, number>();

  await Promise.all(
    uniqueMetaKeys.map(async (metaKey) => {
      try {
        const meta = await reader(metaKey);
        if (meta && typeof meta === 'object' && 'fetchedAt' in meta) {
          // P2 fix: a failed seed run writes fetchedAt: Date.now() but
          // status: 'error' while preserving the prior snapshot via
          // extendExistingTtl. Treat non-ok meta as missing so the
          // dimension classifies as stale, matching api/health.js behavior.
          const status = (meta as { status?: string }).status;
          if (status && status !== 'ok') return;
          const fetchedAt = Number((meta as { fetchedAt: unknown }).fetchedAt);
          if (Number.isFinite(fetchedAt) && fetchedAt > 0) {
            metaKeyFetchedAt.set(metaKey, fetchedAt);
          }
        }
      } catch {
        // Defensive: a bad seed-meta read is equivalent to the key
        // being missing (classifier returns stale on undefined). This
        // keeps the aggregation resilient to upstream Redis hiccups.
      }
    }),
  );

  // Project per-meta-key results back onto per-sourceKey map entries
  // so classifyDimensionFreshness can keep querying by raw registry
  // sourceKey without needing to know the resolution rules.
  for (const [sourceKey, metaKey] of sourceKeyToMetaKey) {
    const fetchedAt = metaKeyFetchedAt.get(metaKey);
    if (fetchedAt != null) {
      map.set(sourceKey, fetchedAt);
    }
  }

  return map;
}
