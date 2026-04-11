import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyDimensionFreshness,
  readFreshnessMap,
} from '../server/worldmonitor/resilience/v1/_dimension-freshness.ts';
import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import {
  AGING_MULTIPLIER,
  FRESH_MULTIPLIER,
  cadenceUnitMs,
} from '../server/_shared/resilience-freshness.ts';
import type { ResilienceDimensionId } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

// T1.5 propagation pass of the country-resilience reference-grade upgrade
// plan. PR #2947 shipped the classifier foundation; this suite pins the
// dimension-level aggregation so T1.6 (full grid) and T1.9 (bootstrap
// wiring) can consume the aggregated freshness with confidence.

const NOW = 1_700_000_000_000;

function freshAt(cadenceKey: Parameters<typeof cadenceUnitMs>[0], factor = 0.5): number {
  // factor < FRESH_MULTIPLIER keeps the age in the fresh band.
  return NOW - cadenceUnitMs(cadenceKey) * factor;
}

function agingAt(cadenceKey: Parameters<typeof cadenceUnitMs>[0]): number {
  // Between FRESH_MULTIPLIER and AGING_MULTIPLIER.
  const factor = (FRESH_MULTIPLIER + AGING_MULTIPLIER) / 2;
  return NOW - cadenceUnitMs(cadenceKey) * factor;
}

function staleAt(cadenceKey: Parameters<typeof cadenceUnitMs>[0]): number {
  // Well beyond AGING_MULTIPLIER.
  return NOW - cadenceUnitMs(cadenceKey) * (AGING_MULTIPLIER + 2);
}

function buildAllFreshMap(dimensionId: ResilienceDimensionId): Map<string, number> {
  const map = new Map<string, number>();
  for (const indicator of INDICATOR_REGISTRY) {
    if (indicator.dimension !== dimensionId) continue;
    map.set(indicator.sourceKey, freshAt(indicator.cadence));
  }
  return map;
}

describe('classifyDimensionFreshness (T1.5 propagation pass)', () => {
  it('all indicators fresh returns fresh and the oldest fetchedAt', () => {
    // macroFiscal has three indicators; two share a sourceKey but the map
    // is keyed by sourceKey so duplicates collapse to one entry.
    const map = buildAllFreshMap('macroFiscal');
    const result = classifyDimensionFreshness('macroFiscal', map, NOW);
    assert.equal(result.staleness, 'fresh');
    // lastObservedAtMs must be the MIN (oldest) fetchedAt across the
    // unique sourceKeys that back the dimension.
    const expectedOldest = Math.min(...map.values());
    assert.equal(result.lastObservedAtMs, expectedOldest);
  });

  it('one aging indicator + rest fresh returns aging and stays below stale', () => {
    // Pick a dimension with multiple source keys so we can tip one to aging.
    // socialCohesion has 3 indicators across 3 source keys.
    const dimensionId: ResilienceDimensionId = 'socialCohesion';
    const map = new Map<string, number>();
    const indicators = INDICATOR_REGISTRY.filter((i) => i.dimension === dimensionId);
    assert.ok(indicators.length >= 2);
    map.set(indicators[0]!.sourceKey, agingAt(indicators[0]!.cadence));
    for (let i = 1; i < indicators.length; i += 1) {
      map.set(indicators[i]!.sourceKey, freshAt(indicators[i]!.cadence));
    }
    const result = classifyDimensionFreshness(dimensionId, map, NOW);
    assert.equal(result.staleness, 'aging', 'one aging + rest fresh should escalate to aging');
  });

  it('one stale + one fresh returns stale (worst wins)', () => {
    const dimensionId: ResilienceDimensionId = 'socialCohesion';
    const map = new Map<string, number>();
    const indicators = INDICATOR_REGISTRY.filter((i) => i.dimension === dimensionId);
    assert.ok(indicators.length >= 2);
    map.set(indicators[0]!.sourceKey, staleAt(indicators[0]!.cadence));
    for (let i = 1; i < indicators.length; i += 1) {
      map.set(indicators[i]!.sourceKey, freshAt(indicators[i]!.cadence));
    }
    const result = classifyDimensionFreshness(dimensionId, map, NOW);
    assert.equal(result.staleness, 'stale', 'stale must dominate fresh in the aggregation');
  });

  it('empty freshnessMap collapses to stale with lastObservedAtMs=0', () => {
    const emptyMap = new Map<string, number>();
    const result = classifyDimensionFreshness('macroFiscal', emptyMap, NOW);
    assert.equal(result.staleness, 'stale', 'no data = stale');
    assert.equal(result.lastObservedAtMs, 0, 'no data = lastObservedAtMs zero');
  });

  it('dimension with no registry indicators returns empty payload (defensive)', () => {
    // Cast forces the defensive branch; every real dimension has entries,
    // but we want to pin the behavior for the defensive path.
    const unknownDimension = '__not_a_real_dimension__' as ResilienceDimensionId;
    const result = classifyDimensionFreshness(unknownDimension, new Map(), NOW);
    assert.equal(result.staleness, '');
    assert.equal(result.lastObservedAtMs, 0);
  });

  it('lastObservedAtMs is the MIN (oldest) across indicators, not the max', () => {
    // foodWater has 4 indicators, all sharing `resilience:static:{ISO2}`
    // as their sourceKey in the registry. The aggregation is keyed by
    // sourceKey so duplicate keys collapse. To test the MIN behavior we
    // use a dimension with distinct sourceKeys: energy (7 indicators).
    const dimensionId: ResilienceDimensionId = 'energy';
    const map = new Map<string, number>();
    const indicators = INDICATOR_REGISTRY.filter((i) => i.dimension === dimensionId);
    const uniqueKeys = [...new Set(indicators.map((i) => i.sourceKey))];
    assert.ok(uniqueKeys.length >= 3, 'energy should have at least 3 unique source keys');
    // Give each unique source key a distinct fetchedAt, all within the
    // fresh band so staleness stays fresh and we can isolate the MIN
    // calculation.
    const timestamps: number[] = [];
    uniqueKeys.forEach((key, index) => {
      const t = NOW - (index + 1) * 1000; // oldest = last key
      map.set(key, t);
      timestamps.push(t);
    });
    const result = classifyDimensionFreshness(dimensionId, map, NOW);
    const expectedMin = Math.min(...timestamps);
    assert.equal(result.lastObservedAtMs, expectedMin);
  });
});

describe('readFreshnessMap (T1.5 propagation pass)', () => {
  it('builds the map from a fake reader that returns { fetchedAt } for some keys and null for others', async () => {
    const fetchedAt = 1_699_000_000_000;
    // Pick two real sourceKeys from the registry so the Set-dedupe path
    // is exercised with actual registry data.
    const sourceKeyA = 'economic:imf:macro:v2'; // macroFiscal
    const sourceKeyB = 'sanctions:country-counts:v1'; // tradeSanctions
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === `seed-meta:${sourceKeyA}`) return { fetchedAt };
      if (key === `seed-meta:${sourceKeyB}`) return { fetchedAt: fetchedAt + 1 };
      return null;
    };
    const map = await readFreshnessMap(reader);
    assert.equal(map.get(sourceKeyA), fetchedAt);
    assert.equal(map.get(sourceKeyB), fetchedAt + 1);
    // A key that doesn't appear in the reader output must not be in the map.
    assert.ok(!map.has('bogus-key-never-seeded'));
  });

  it('omits malformed entries: fetchedAt not a number, NaN, zero, negative', async () => {
    const sourceKey = 'economic:imf:macro:v2';
    const bogusCases: unknown[] = [
      { fetchedAt: 'not-a-number' },
      { fetchedAt: Number.NaN },
      { fetchedAt: 0 },
      { fetchedAt: -1 },
      { fetchedAt: null },
      { notAField: 123 },
      null,
      undefined,
      'raw-string',
      42,
    ];
    for (const bogus of bogusCases) {
      const reader = async (key: string): Promise<unknown | null> => {
        if (key === `seed-meta:${sourceKey}`) return bogus;
        return null;
      };
      const map = await readFreshnessMap(reader);
      assert.ok(
        !map.has(sourceKey),
        `malformed seed-meta ${JSON.stringify(bogus)} should be omitted from the map`,
      );
    }
  });

  it('deduplicates sourceKeys so shared keys are read only once', async () => {
    // macroFiscal has two indicators backed by `economic:imf:macro:v2`.
    // readFreshnessMap must dedupe so the reader is only called once
    // per unique sourceKey.
    const callCount = new Map<string, number>();
    const reader = async (key: string): Promise<unknown | null> => {
      callCount.set(key, (callCount.get(key) ?? 0) + 1);
      return null;
    };
    await readFreshnessMap(reader);
    for (const [, count] of callCount) {
      assert.equal(count, 1, 'every seed-meta key should be read at most once');
    }
  });

  it('swallows reader errors for a single key without failing the whole map', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'seed-meta:economic:imf:macro:v2') throw new Error('redis down');
      if (key === 'seed-meta:sanctions:country-counts:v1') return { fetchedAt: NOW };
      return null;
    };
    const map = await readFreshnessMap(reader);
    // The failing key is absent; the good key is present.
    assert.ok(!map.has('economic:imf:macro:v2'));
    assert.equal(map.get('sanctions:country-counts:v1'), NOW);
  });
});
