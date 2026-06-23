import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'acorn';

import {
  DATASET_TO_DIMENSIONS,
  RESILIENCE_STATIC_META_KEY,
  STANDALONE_SOURCE_META_MAX_STALE_MIN,
  buildStandaloneMetaKeyToIndicators,
  failedDimensionsFromDatasets,
  readStandaloneSourceFailureDimensions,
  readFailedDatasets,
} from '../server/worldmonitor/resilience/v1/_source-failure.ts';
import { RESILIENCE_DIMENSION_ORDER } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { resolveSeedMetaKey } from '../server/worldmonitor/resilience/v1/_dimension-freshness.ts';
import {
  INDICATOR_REGISTRY,
  getIndicatorSourceKeys,
} from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import type { IndicatorSpec } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// Adapter keys enumerated in scripts/seed-resilience-static.mjs
// `fetchAllDatasetMaps()`. Every adapter that can end up in the
// `failedDatasets` array on the meta record MUST have a mapping in
// DATASET_TO_DIMENSIONS so the source-failure tag fires. This list is
// duplicated here deliberately so the test fails loudly when the seed
// grows a new adapter without updating the map.
const SEED_ADAPTER_KEYS = [
  'wgi',
  'infrastructure',
  'gpi',
  'rsf',
  'who',
  'fao',
  'aquastat',
  'iea',
  'tradeToGdp',
  'fxReservesMonths',
  'appliedTariffRate',
] as const;

const INTENTIONALLY_UNTRACKED_STANDALONE_META_KEYS = new Set([
  // scoreFuelStockDays is retired and always returns coverage=0 +
  // imputationClass=null. api/health.js intentionally removed this probe
  // because it reported "cron ran" for data that the score no longer reads.
  'seed-meta:resilience:recovery:fuel-stocks',
]);

const TRACKED_STANDALONE_META_KEYS_NOT_IN_HEALTH = new Set([
  // api/seed-health.js tracks this seed with intervalMin=360; /api/health
  // does not include a direct SEED_META entry because its data key is
  // parameterized by year.
  'seed-meta:displacement:summary',
  // api/health.js tracks seed-meta:economic:macro-signals and documents
  // energy-prices as the primary key with the same 150min threshold, but
  // it does not classify the energy-prices data key directly.
  'seed-meta:economic:energy-prices',
  // scripts/seed-supply-chain-trade.mjs writes these via
  // writeExtraKeyWithMeta. They feed scoreTradePolicy directly but are not
  // standalone /api/health probes today.
  'seed-meta:trade:restrictions:v1:tariff-overview:50',
  'seed-meta:trade:barriers:v1:tariff-gap:50',
]);

function literalKey(node: any): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function evaluateNumericExpression(node: any): number | null {
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (node.type === 'BinaryExpression') {
    const left = evaluateNumericExpression(node.left);
    const right = evaluateNumericExpression(node.right);
    if (left == null || right == null) return null;
    switch (node.operator) {
      case '*': return left * right;
      case '/': return left / right;
      case '+': return left + right;
      case '-': return left - right;
      default: return null;
    }
  }
  return null;
}

function readHealthSeedMetaThresholds(): Map<string, number> {
  const source = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as any;
  const declaration = ast.body
    .filter((node: any) => node.type === 'VariableDeclaration')
    .flatMap((node: any) => node.declarations)
    .find((node: any) => node.id?.type === 'Identifier' && node.id.name === 'SEED_META');

  assert.ok(declaration, 'api/health.js must declare SEED_META');
  assert.equal(declaration.init?.type, 'ObjectExpression', 'SEED_META must be an object literal');

  const out = new Map<string, number>();
  for (const entry of declaration.init.properties) {
    assert.equal(entry.type, 'Property', 'SEED_META must not use spread properties');
    assert.equal(entry.value?.type, 'ObjectExpression', 'each SEED_META entry must be an object literal');

    let key: string | null = null;
    let maxStaleMin: number | null = null;
    for (const prop of entry.value.properties) {
      assert.equal(prop.type, 'Property', 'SEED_META nested entries must not use spread properties');
      const name = literalKey(prop.key);
      if (name === 'key' && prop.value.type === 'Literal' && typeof prop.value.value === 'string') {
        key = prop.value.value;
      }
      if (name === 'maxStaleMin') {
        maxStaleMin = evaluateNumericExpression(prop.value);
      }
    }

    assert.ok(key, `SEED_META.${literalKey(entry.key) ?? '<computed>'} must include key`);
    assert.equal(typeof maxStaleMin, 'number', `SEED_META.${key} must include numeric maxStaleMin`);
    const existing = out.get(key);
    if (existing != null) {
      assert.equal(existing, maxStaleMin, `duplicate SEED_META key ${key} must use one threshold`);
    }
    out.set(key, maxStaleMin);
  }
  return out;
}

function resolvedStandaloneRegistryMetaKeys(): string[] {
  return [...new Set(
    INDICATOR_REGISTRY
      .flatMap((indicator) => getIndicatorSourceKeys(indicator).map((sourceKey) => resolveSeedMetaKey(sourceKey)))
      .filter((key) => key !== RESILIENCE_STATIC_META_KEY),
  )].sort();
}

describe('resilience source-failure module', () => {
  describe('readFailedDatasets', () => {
    it('returns the failedDatasets array when meta is well-formed', async () => {
      const reader = async (key: string) => {
        if (key === RESILIENCE_STATIC_META_KEY) {
          return { fetchedAt: 1, recordCount: 196, failedDatasets: ['wgi', 'rsf'] };
        }
        return null;
      };
      assert.deepEqual(await readFailedDatasets(reader), ['wgi', 'rsf']);
    });

    it('returns [] when the meta object has no failedDatasets field', async () => {
      const reader = async () => ({ fetchedAt: 1, recordCount: 196 });
      assert.deepEqual(await readFailedDatasets(reader), []);
    });

    it('returns [] when failedDatasets is not an array', async () => {
      const reader = async () => ({ fetchedAt: 1, failedDatasets: 'wgi,rsf' });
      assert.deepEqual(await readFailedDatasets(reader), []);
    });

    it('returns [] when the reader returns null', async () => {
      const reader = async () => null;
      assert.deepEqual(await readFailedDatasets(reader), []);
    });

    it('returns [] when the reader throws', async () => {
      const reader = async () => {
        throw new Error('redis down');
      };
      assert.deepEqual(await readFailedDatasets(reader), []);
    });

    it('filters non-string entries from failedDatasets without throwing', async () => {
      const reader = async () => ({
        fetchedAt: 1,
        failedDatasets: ['wgi', 42, null, { key: 'rsf' }, 'gpi'],
      });
      assert.deepEqual(await readFailedDatasets(reader), ['wgi', 'gpi']);
    });

    it('returns [] when the meta is a primitive, not an object', async () => {
      const reader = async () => 'ok' as unknown;
      assert.deepEqual(await readFailedDatasets(reader), []);
    });
  });

  describe('failedDimensionsFromDatasets', () => {
    it('maps wgi to governanceInstitutional, macroFiscal, and stateContinuity', () => {
      const affected = failedDimensionsFromDatasets(['wgi']);
      assert.equal(affected.has('governanceInstitutional'), true);
      assert.equal(affected.has('macroFiscal'), true);
      assert.equal(affected.has('stateContinuity'), true);
      assert.equal(affected.size, 3);
    });

    it('deduplicates dimensions across multiple failed adapters', () => {
      // wgi → {governanceInstitutional, macroFiscal}, gpi → {socialCohesion}.
      // Union has 4 entries, no duplication because the adapters touch
      // disjoint dimensions (wgi -> 3 dims + gpi -> 1 dim).
      const affected = failedDimensionsFromDatasets(['wgi', 'gpi']);
      assert.equal(affected.size, 4);
      assert.equal(affected.has('governanceInstitutional'), true);
      assert.equal(affected.has('macroFiscal'), true);
      assert.equal(affected.has('stateContinuity'), true);
      assert.equal(affected.has('socialCohesion'), true);
    });

    it('ignores unknown adapter keys without throwing', () => {
      const affected = failedDimensionsFromDatasets(['not-a-real-adapter', 'wgi']);
      assert.equal(affected.size, 3);
      assert.equal(affected.has('governanceInstitutional'), true);
      assert.equal(affected.has('macroFiscal'), true);
      assert.equal(affected.has('stateContinuity'), true);
    });

    it('returns an empty set for an empty input', () => {
      assert.equal(failedDimensionsFromDatasets([]).size, 0);
    });
  });

  describe('readStandaloneSourceFailureDimensions', () => {
    it('maps stale standalone recovery seed-meta to affected dimensions', async () => {
      const nowMs = 1_700_000_000_000;
      const reader = async (key: string): Promise<unknown | null> => {
        if (key === 'seed-meta:resilience:recovery:import-hhi') {
          return { status: 'ok', fetchedAt: nowMs - 36 * DAY_MS, recordCount: 190 };
        }
        return null;
      };

      const result = await readStandaloneSourceFailureDimensions(reader, nowMs);

      assert.equal(result.dimensions.has('importConcentration'), true);
      assert.deepEqual(result.failedMetaKeys, ['seed-meta:resilience:recovery:import-hhi']);
    });

    it('uses seeder freshness thresholds rather than annual source-data cadence', async () => {
      const nowMs = 1_700_000_000_000;
      const reader = async (key: string): Promise<unknown | null> => {
        if (key === 'seed-meta:resilience:recovery:import-hhi') {
          return { status: 'ok', fetchedAt: nowMs - 34 * DAY_MS, recordCount: 190 };
        }
        return null;
      };

      const result = await readStandaloneSourceFailureDimensions(reader, nowMs);

      assert.equal(
        STANDALONE_SOURCE_META_MAX_STALE_MIN['seed-meta:resilience:recovery:import-hhi'],
        50400,
      );
      assert.equal(result.dimensions.has('importConcentration'), false);
      assert.deepEqual(result.failedMetaKeys, []);
    });

    it('keeps UCDP annual source cadence separate from the 7-hour seeder liveness budget', async () => {
      const nowMs = 1_700_000_000_000;
      const ucdpIndicators = INDICATOR_REGISTRY.filter((indicator) => (
        indicator.sourceKey === 'conflict:ucdp-events:v1'
      ));
      assert.deepEqual(
        ucdpIndicators.map((indicator) => [indicator.id, indicator.cadence]),
        [
          ['ucdpConflict', 'annual'],
          ['recoveryConflictPressure', 'annual'],
        ],
      );
      assert.equal(resolveSeedMetaKey('conflict:ucdp-events:v1'), 'seed-meta:conflict:ucdp-events');
      assert.equal(STANDALONE_SOURCE_META_MAX_STALE_MIN['seed-meta:conflict:ucdp-events'], 420);

      const reader = async (key: string): Promise<unknown | null> => {
        if (key === 'seed-meta:conflict:ucdp-events') {
          return { status: 'ok', fetchedAt: nowMs - (8 * 60 * 60 * 1000), recordCount: 193 };
        }
        return null;
      };

      const result = await readStandaloneSourceFailureDimensions(reader, nowMs);

      assert.equal(result.dimensions.has('borderSecurity'), true);
      assert.equal(result.dimensions.has('stateContinuity'), true);
      assert.deepEqual(result.failedMetaKeys, ['seed-meta:conflict:ucdp-events']);
    });

    it('maps non-ok standalone seed-meta to affected dimensions even with a recent fetchedAt', async () => {
      const reader = async (key: string): Promise<unknown | null> => {
        if (key === 'seed-meta:resilience:recovery:external-debt') {
          return { status: 'error', fetchedAt: 1_700_000_000_000, recordCount: 0 };
        }
        return null;
      };

      const result = await readStandaloneSourceFailureDimensions(reader, 1_700_000_000_000);

      assert.equal(result.dimensions.has('externalDebtCoverage'), true);
      assert.deepEqual(result.failedMetaKeys, ['seed-meta:resilience:recovery:external-debt']);
    });

    it('treats truthy non-string seed-meta status values as non-ok', async () => {
      const reader = async (key: string): Promise<unknown | null> => {
        if (key === 'seed-meta:resilience:recovery:external-debt') {
          return { status: 1, fetchedAt: 1_700_000_000_000, recordCount: 0 };
        }
        return null;
      };

      const result = await readStandaloneSourceFailureDimensions(reader, 1_700_000_000_000);

      assert.equal(result.dimensions.has('externalDebtCoverage'), true);
      assert.deepEqual(result.failedMetaKeys, ['seed-meta:resilience:recovery:external-debt']);
    });

    it('does not duplicate the static failedDatasets path', async () => {
      const reader = async (key: string): Promise<unknown | null> => {
        if (key === RESILIENCE_STATIC_META_KEY) {
          return { status: 'error', fetchedAt: 1, failedDatasets: ['wgi'] };
        }
        return null;
      };

      const result = await readStandaloneSourceFailureDimensions(reader, 1_700_000_000_000);

      assert.equal(result.dimensions.size, 0);
      assert.deepEqual(result.failedMetaKeys, []);
    });

    it('deduplicates a composite indicator whose sourceKeys resolve to the same standalone meta key', () => {
      const base = INDICATOR_REGISTRY.find((indicator) => indicator.id === 'importedFossilDependence');
      assert.ok(base, 'fixture base indicator must exist');
      const duplicateMetaComposite: IndicatorSpec = {
        ...base,
        sourceKey: 'resilience:recovery:import-hhi:v1',
        sourceKeys: [
          'resilience:recovery:import-hhi:v1',
          'resilience:recovery:import-hhi',
        ],
      };

      const grouped = buildStandaloneMetaKeyToIndicators([duplicateMetaComposite]);

      assert.deepEqual(
        grouped.get('seed-meta:resilience:recovery:import-hhi'),
        [duplicateMetaComposite],
        'same indicator must appear once even when multiple composite sourceKeys collapse to one meta key',
      );
    });

    it('ignores retired standalone fuel-stock meta even when status is non-ok', async () => {
      const reader = async (key: string): Promise<unknown | null> => {
        if (key === 'seed-meta:resilience:recovery:fuel-stocks') {
          return { status: 'error', fetchedAt: 1, recordCount: 0 };
        }
        return null;
      };

      const result = await readStandaloneSourceFailureDimensions(reader, 1_700_000_000_000);

      assert.equal(result.dimensions.has('fuelStockDays'), false);
      assert.equal(result.dimensions.size, 0);
      assert.deepEqual(result.failedMetaKeys, []);
    });

    it('keeps health-owned standalone source-failure thresholds in sync with api/health.js SEED_META', () => {
      const healthThresholds = readHealthSeedMetaThresholds();
      for (const [key, maxStaleMin] of Object.entries(STANDALONE_SOURCE_META_MAX_STALE_MIN)) {
        if (TRACKED_STANDALONE_META_KEYS_NOT_IN_HEALTH.has(key)) continue;
        assert.equal(
          healthThresholds.get(key),
          maxStaleMin,
          `${key} must match api/health.js SEED_META maxStaleMin`,
        );
      }
    });

    it('requires explicit documentation for source-failure thresholds not owned by api/health.js', () => {
      const healthThresholds = readHealthSeedMetaThresholds();
      const trackedKeys = Object.keys(STANDALONE_SOURCE_META_MAX_STALE_MIN);
      const unownedKeys = trackedKeys.filter((key) => !healthThresholds.has(key)).sort();

      assert.deepEqual(unownedKeys, [...TRACKED_STANDALONE_META_KEYS_NOT_IN_HEALTH].sort());
    });

    it('covers every standalone registry seed-meta key except explicit retired sources', () => {
      const registryKeys = resolvedStandaloneRegistryMetaKeys();
      const expectedTrackedKeys = registryKeys
        .filter((key) => !INTENTIONALLY_UNTRACKED_STANDALONE_META_KEYS.has(key))
        .sort();
      const actualTrackedKeys = Object.keys(STANDALONE_SOURCE_META_MAX_STALE_MIN).sort();

      assert.deepEqual(actualTrackedKeys, expectedTrackedKeys);
    });

    it('documents retired standalone sources omitted from source-failure health tracking', () => {
      const registryKeys = new Set(resolvedStandaloneRegistryMetaKeys());
      const healthThresholds = readHealthSeedMetaThresholds();
      for (const key of INTENTIONALLY_UNTRACKED_STANDALONE_META_KEYS) {
        assert.equal(registryKeys.has(key), true, `${key} must remain a registry key while allowlisted`);
        assert.equal(
          healthThresholds.has(key),
          false,
          `${key} should be removed from the allowlist if api/health.js starts tracking it again`,
        );
        assert.equal(
          key in STANDALONE_SOURCE_META_MAX_STALE_MIN,
          false,
          `${key} should not be tracked while the retired source remains allowlisted`,
        );
      }
    });
  });

  describe('DATASET_TO_DIMENSIONS coverage', () => {
    it('maps every adapter key declared by the static seed', () => {
      for (const adapter of SEED_ADAPTER_KEYS) {
        const dims = DATASET_TO_DIMENSIONS[adapter];
        assert.ok(
          Array.isArray(dims) && dims.length > 0,
          `adapter ${adapter} is produced by fetchAllDatasetMaps() in `
            + 'scripts/seed-resilience-static.mjs but has no entry in '
            + 'DATASET_TO_DIMENSIONS; add its mapping so source-failure '
            + 'can propagate to the affected dimensions',
        );
      }
    });

    it('only references valid ResilienceDimensionIds', () => {
      const validIds: ReadonlySet<string> = new Set(RESILIENCE_DIMENSION_ORDER);
      for (const [adapter, dims] of Object.entries(DATASET_TO_DIMENSIONS)) {
        for (const dim of dims) {
          assert.ok(
            validIds.has(dim),
            `DATASET_TO_DIMENSIONS[${adapter}] contains invalid dimension id ${dim}`,
          );
        }
      }
    });
  });
});
