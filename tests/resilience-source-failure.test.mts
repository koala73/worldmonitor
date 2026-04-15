import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DATASET_TO_DIMENSIONS,
  RESILIENCE_STATIC_META_KEY,
  failedDimensionsFromDatasets,
  readFailedDatasets,
} from '../server/worldmonitor/resilience/v1/_source-failure.ts';
import type { ResilienceDimensionId } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

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
      const validIds: ReadonlySet<ResilienceDimensionId> = new Set([
        'macroFiscal',
        'currencyExternal',
        'tradeSanctions',
        'cyberDigital',
        'logisticsSupply',
        'infrastructure',
        'energy',
        'governanceInstitutional',
        'socialCohesion',
        'borderSecurity',
        'informationCognitive',
        'healthPublicService',
        'foodWater',
        'fiscalSpace',
        'reserveAdequacy',
        'externalDebtCoverage',
        'importConcentration',
        'stateContinuity',
        'fuelStockDays',
      ]);
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
