import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DATASET_TO_DIMENSIONS,
  RESILIENCE_STATIC_META_KEY,
  STANDALONE_SOURCE_META_MAX_STALE_MIN,
  failedDimensionsFromDatasets,
  readStandaloneSourceFailureDimensions,
  readFailedDatasets,
} from '../server/worldmonitor/resilience/v1/_source-failure.ts';
import { RESILIENCE_DIMENSION_ORDER } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

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
