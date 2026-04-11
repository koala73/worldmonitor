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
 * Duplicates in the registry are deduped so we only read each
 * `seed-meta:<key>` once. The reader is injected so callers can pass
 * `defaultSeedReader` in production or a fixture reader in tests.
 */
export async function readFreshnessMap(
  reader: (key: string) => Promise<unknown | null>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const uniqueSourceKeys = [...new Set(INDICATOR_REGISTRY.map((indicator) => indicator.sourceKey))];

  await Promise.all(
    uniqueSourceKeys.map(async (sourceKey) => {
      try {
        const meta = await reader(`seed-meta:${sourceKey}`);
        if (meta && typeof meta === 'object' && 'fetchedAt' in meta) {
          const fetchedAt = Number((meta as { fetchedAt: unknown }).fetchedAt);
          if (Number.isFinite(fetchedAt) && fetchedAt > 0) {
            map.set(sourceKey, fetchedAt);
          }
        }
      } catch {
        // Defensive: a bad seed-meta read is equivalent to the key
        // being missing (classifier returns stale on undefined). This
        // keeps the aggregation resilient to upstream Redis hiccups.
      }
    }),
  );

  return map;
}
