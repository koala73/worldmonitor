import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  classifyDimensionFreshness,
  readFreshnessMap,
  resolveSeedMetaKey,
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
    // is exercised with actual registry data. Both resolve to drift
    // cases (v-strip + override) so this also exercises resolveSeedMetaKey.
    const sourceKeyA = 'economic:imf:macro:v2'; // macroFiscal -> seed-meta:economic:imf-macro
    // Replaced 'sanctions:country-counts:v1' here in plan 2026-04-25-004
    // Phase 1: that source key is no longer registered (the OFAC
    // sanctionCount indicator was dropped from the tradePolicy dim).
    // Use a different drift-case sourceKey that IS still in the registry
    // (the v-strip + override path goes through SOURCE_KEY_META_OVERRIDES
    // in _dimension-freshness.ts and resolves to seed-meta:economic:bis-dsr).
    const sourceKeyB = 'economic:bis:dsr:v1'; // -> seed-meta:economic:bis-dsr
    const metaKeyA = resolveSeedMetaKey(sourceKeyA);
    const metaKeyB = resolveSeedMetaKey(sourceKeyB);
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === metaKeyA) return { fetchedAt };
      if (key === metaKeyB) return { fetchedAt: fetchedAt + 1 };
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
    const metaKey = resolveSeedMetaKey(sourceKey);
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
        if (key === metaKey) return bogus;
        return null;
      };
      const map = await readFreshnessMap(reader);
      assert.ok(
        !map.has(sourceKey),
        `malformed seed-meta ${JSON.stringify(bogus)} should be omitted from the map`,
      );
    }
  });

  it('deduplicates by resolved meta key so shared keys are read only once', async () => {
    // 15+ resilience:static:{ISO2} registry entries collapse to one
    // seed-meta:resilience:static read. macroFiscal has two indicators
    // backed by economic:imf:macro:v2 that dedupe to one meta fetch.
    const callCount = new Map<string, number>();
    const reader = async (key: string): Promise<unknown | null> => {
      callCount.set(key, (callCount.get(key) ?? 0) + 1);
      return null;
    };
    await readFreshnessMap(reader);
    for (const [, count] of callCount) {
      assert.equal(count, 1, 'every seed-meta key should be read at most once');
    }
    // Spot-check: seed-meta:resilience:static was read exactly once even
    // though the registry has many resilience:static:{ISO2} / * entries.
    assert.equal(callCount.get('seed-meta:resilience:static'), 1);
  });

  it('swallows reader errors for a single key without failing the whole map', async () => {
    const failingSourceKey = 'economic:imf:macro:v2';
    // Replaced 'sanctions:country-counts:v1' here in plan 2026-04-25-004
    // Phase 1: that source key is no longer registered.
    const goodSourceKey = 'economic:bis:dsr:v1';
    const failingMetaKey = resolveSeedMetaKey(failingSourceKey);
    const goodMetaKey = resolveSeedMetaKey(goodSourceKey);
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === failingMetaKey) throw new Error('redis down');
      if (key === goodMetaKey) return { fetchedAt: NOW };
      return null;
    };
    const map = await readFreshnessMap(reader);
    // The failing key is absent; the good key is present.
    assert.ok(!map.has(failingSourceKey));
    assert.equal(map.get(goodSourceKey), NOW);
  });

  it('projects one seed-meta:resilience:static fetchedAt onto every resilience:static:{ISO2} / * sourceKey', async () => {
    // Greptile P1 regression (#2961): readFreshnessMap used to issue
    // literal seed-meta:resilience:static:{ISO2} reads, so every
    // templated entry was missing from the map. Assert every registry
    // sourceKey that resolves to seed-meta:resilience:static is
    // populated by a single fetchedAt read.
    const fetchedAt = NOW - 1_000_000;
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'seed-meta:resilience:static') return { fetchedAt };
      return null;
    };
    const map = await readFreshnessMap(reader);

    const staticSourceKeys = INDICATOR_REGISTRY.filter((i) =>
      /^resilience:static(:\{|:\*|$)/.test(i.sourceKey),
    ).map((i) => i.sourceKey);
    assert.ok(staticSourceKeys.length >= 10, 'registry should have many resilience:static:* entries');
    for (const sourceKey of staticSourceKeys) {
      assert.equal(
        map.get(sourceKey),
        fetchedAt,
        `registry sourceKey ${sourceKey} should be populated from seed-meta:resilience:static`,
      );
    }
  });

  it('skips seed-meta entries where status !== ok (P2: error-status guard)', async () => {
    const sourceKey = 'economic:imf:macro:v2';
    const metaKey = resolveSeedMetaKey(sourceKey);

    // status: 'error' with a recent fetchedAt should be treated as missing.
    const errorReader = async (key: string): Promise<unknown | null> => {
      if (key === metaKey) return { fetchedAt: Date.now(), status: 'error', failedDatasets: ['wgi'] };
      return null;
    };
    const errorMap = await readFreshnessMap(errorReader);
    assert.ok(
      !errorMap.has(sourceKey),
      'seed-meta with status: "error" must be excluded from the freshness map',
    );

    // status: 'ok' with the same fetchedAt should be included.
    const okReader = async (key: string): Promise<unknown | null> => {
      if (key === metaKey) return { fetchedAt: NOW, status: 'ok' };
      return null;
    };
    const okMap = await readFreshnessMap(okReader);
    assert.equal(
      okMap.get(sourceKey),
      NOW,
      'seed-meta with status: "ok" must be included in the freshness map',
    );
  });

  it('includes seed-meta entries with no status field (backward compat)', async () => {
    const sourceKey = 'economic:imf:macro:v2';
    const metaKey = resolveSeedMetaKey(sourceKey);
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === metaKey) return { fetchedAt: NOW };
      return null;
    };
    const map = await readFreshnessMap(reader);
    assert.equal(
      map.get(sourceKey),
      NOW,
      'seed-meta without a status field must be included (backward compat)',
    );
  });

  it('healthPublicService classifies fresh when seed-meta:resilience:static is recent', async () => {
    // End-to-end integration for the P1 fix. healthPublicService has
    // three indicators, all sharing resilience:static:{ISO2} as their
    // sourceKey. Before the fix, readFreshnessMap would miss all three
    // and classifyDimensionFreshness returned stale on healthy seeds.
    const fetchedAt = freshAt('annual', 0.1);
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'seed-meta:resilience:static') return { fetchedAt };
      return null;
    };
    const map = await readFreshnessMap(reader);
    const result = classifyDimensionFreshness('healthPublicService', map, NOW);
    assert.equal(
      result.staleness,
      'fresh',
      'healthPublicService should be fresh when seed-meta:resilience:static is recent',
    );
    assert.equal(result.lastObservedAtMs, fetchedAt);
  });
});

describe('resolveSeedMetaKey (T1.5 propagation pass, P1 fix)', () => {
  it('strips {ISO2} template tokens', () => {
    assert.equal(resolveSeedMetaKey('resilience:static:{ISO2}'), 'seed-meta:resilience:static');
  });

  it('strips :* wildcard segments', () => {
    assert.equal(resolveSeedMetaKey('resilience:static:*'), 'seed-meta:resilience:static');
  });

  it('strips {year} template tokens and trailing :v1', () => {
    // displacement:summary:v1:{year} -> strip :{year} -> displacement:summary:v1
    //   -> strip trailing :v1 -> displacement:summary
    assert.equal(
      resolveSeedMetaKey('displacement:summary:v1:{year}'),
      'seed-meta:displacement:summary',
    );
  });

  it('strips trailing :v\\d+ on ordinary version suffixes', () => {
    assert.equal(resolveSeedMetaKey('cyber:threats:v2'), 'seed-meta:cyber:threats');
    assert.equal(resolveSeedMetaKey('infra:outages:v1'), 'seed-meta:infra:outages');
    assert.equal(resolveSeedMetaKey('unrest:events:v1'), 'seed-meta:unrest:events');
    assert.equal(resolveSeedMetaKey('intelligence:gpsjam:v2'), 'seed-meta:intelligence:gpsjam');
    assert.equal(
      resolveSeedMetaKey('economic:national-debt:v1'),
      'seed-meta:economic:national-debt',
    );
    assert.equal(
      resolveSeedMetaKey('sanctions:country-counts:v1'),
      'seed-meta:sanctions:country-counts',
    );
  });

  it('leaves embedded :v1 alone when followed by more segments', () => {
    // :v1 is not at the end, so the trailing-version strip must not
    // touch it. writeExtraKeyWithMeta has the same carve-out.
    assert.equal(
      resolveSeedMetaKey('trade:restrictions:v1:tariff-overview:50'),
      'seed-meta:trade:restrictions:v1:tariff-overview:50',
    );
    assert.equal(
      resolveSeedMetaKey('trade:barriers:v1:tariff-gap:50'),
      'seed-meta:trade:barriers:v1:tariff-gap:50',
    );
  });

  it('applies SOURCE_KEY_META_OVERRIDES for the drift cases', () => {
    // Overrides for sourceKeys that still diverge after strip.
    assert.equal(resolveSeedMetaKey('economic:imf:macro:v2'), 'seed-meta:economic:imf-macro');
    assert.equal(resolveSeedMetaKey('economic:bis:eer:v1'), 'seed-meta:economic:bis');
    // Per-dataset BIS seed-meta keys (P1 fix): seed-bis-extended.mjs writes
    // seed-meta:economic:bis-dsr / bis-property-residential / bis-property-commercial
    // independently. Must NOT collapse to the aggregate bis-extended key or a
    // DSR-only outage would falsely report macroFiscal inputs as fresh.
    assert.equal(resolveSeedMetaKey('economic:bis:dsr:v1'), 'seed-meta:economic:bis-dsr');
    assert.equal(
      resolveSeedMetaKey('economic:bis:property-residential:v1'),
      'seed-meta:economic:bis-property-residential',
    );
    assert.equal(
      resolveSeedMetaKey('economic:bis:property-commercial:v1'),
      'seed-meta:economic:bis-property-commercial',
    );
    assert.equal(resolveSeedMetaKey('economic:energy:v1:all'), 'seed-meta:economic:energy-prices');
    assert.equal(resolveSeedMetaKey('energy:mix:v1:{ISO2}'), 'seed-meta:economic:owid-energy-mix');
    assert.equal(
      resolveSeedMetaKey('energy:gas-storage:v1:{ISO2}'),
      'seed-meta:energy:gas-storage-countries',
    );
    assert.equal(resolveSeedMetaKey('news:threat:summary:v1'), 'seed-meta:news:threat-summary');
    assert.equal(
      resolveSeedMetaKey('intelligence:social:reddit:v1'),
      'seed-meta:intelligence:social-reddit',
    );
  });
});

// Registry-coverage assertion: every sourceKey in INDICATOR_REGISTRY must
// resolve to a seed-meta key that is actually written by some seeder,
// verified against the literal seed-meta:<...> strings in api/health.js
// and api/seed-health.js. This locks the drift down so a future registry
// entry with a bad sourceKey fails CI loudly instead of silently
// returning stale. To add a sourceKey that is intentionally untracked
// by the health files, allowlist it in KNOWN_SEEDS_NOT_IN_HEALTH with a
// one-line justification.
describe('INDICATOR_REGISTRY seed-meta coverage (T1.5 P1 regression lock)', () => {
  // Seeds that are legitimately written by some seeder but do not appear
  // in api/health.js or api/seed-health.js (e.g. because they are
  // extra-key writes via writeExtraKeyWithMeta that no health monitor
  // tracks yet). Each entry must be verified against scripts/seed-*.mjs
  // before being added.
  const KNOWN_SEEDS_NOT_IN_HEALTH: ReadonlySet<string> = new Set([
    // scripts/seed-supply-chain-trade.mjs writes these via
    // writeExtraKeyWithMeta. The :v\d+ is not trailing (has :tariff-*:50
    // suffix) so the strip is a no-op and the meta key equals the key.
    'seed-meta:trade:restrictions:v1:tariff-overview:50',
    'seed-meta:trade:barriers:v1:tariff-gap:50',
    // scripts/seed-sanctions-pressure.mjs afterPublish writes this via
    // writeExtraKeyWithMeta(COUNTRY_COUNTS_KEY, ...). The :v1 suffix is
    // stripped by writeExtraKeyWithMeta's regex, matching resolveSeedMetaKey.
    'seed-meta:sanctions:country-counts',
    // scripts/seed-economy.mjs: runSeed('economic', 'energy-prices', ...)
    // writes this. The registry sourceKey economic:energy:v1:all does
    // not strip to this shape, so SOURCE_KEY_META_OVERRIDES maps it.
    'seed-meta:economic:energy-prices',
    // PR 2 §3.4: seed-sovereign-wealth.mjs writes this via runSeed. Not
    // yet registered in api/health.js SEED_META — per project memory
    // feedback_health_required_key_needs_railway_cron_first.md, new
    // seed keys go through ON_DEMAND_KEYS for ~7 days of clean Railway
    // cron runs before promotion to SEED_META. A follow-up PR wires
    // this once the cron has baked in; until then, allowlist it so
    // the registry consistency check passes.
    'seed-meta:resilience:recovery:sovereign-wealth',
  ]);

  function extractSeedMetaKeys(filePath: string): Set<string> {
    const text = readFileSync(filePath, 'utf8');
    const set = new Set<string>();
    // Capture every 'seed-meta:...' literal up to the closing quote.
    for (const match of text.matchAll(/['"`](seed-meta:[^'"`]+)['"`]/g)) {
      set.add(match[1]!);
    }
    return set;
  }

  it('every registry sourceKey resolves to a known seed-meta key', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '..');
    const known = new Set<string>(KNOWN_SEEDS_NOT_IN_HEALTH);
    for (const path of ['api/health.js', 'api/seed-health.js']) {
      for (const key of extractSeedMetaKeys(resolve(repoRoot, path))) {
        known.add(key);
      }
    }

    const unknownResolutions: { sourceKey: string; metaKey: string }[] = [];
    const uniqueSourceKeys = [...new Set(INDICATOR_REGISTRY.map((i) => i.sourceKey))];
    for (const sourceKey of uniqueSourceKeys) {
      const metaKey = resolveSeedMetaKey(sourceKey);
      if (!known.has(metaKey)) {
        unknownResolutions.push({ sourceKey, metaKey });
      }
    }

    assert.deepEqual(
      unknownResolutions,
      [],
      `INDICATOR_REGISTRY sourceKeys resolved to seed-meta keys that do not appear in api/health.js, api/seed-health.js, or KNOWN_SEEDS_NOT_IN_HEALTH. ` +
        `Either update SOURCE_KEY_META_OVERRIDES in _dimension-freshness.ts or allowlist the key in KNOWN_SEEDS_NOT_IN_HEALTH with verification against scripts/seed-*.mjs: ` +
        JSON.stringify(unknownResolutions, null, 2),
    );
  });
});
