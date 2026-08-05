import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  lookupEntityByAlias as lookupSharedEntityByAlias,
  lookupEntitiesByKeyword as lookupSharedEntitiesByKeyword,
  lookupEntitiesBySector as lookupSharedEntitiesBySector,
} from '../shared/entity-extraction-core.js';
import {
  lookupEntityByAlias as lookupClientEntityByAlias,
  lookupEntitiesByKeyword as lookupClientEntitiesByKeyword,
  lookupEntitiesBySector as lookupClientEntitiesBySector,
} from '../src/services/entity-index.ts';
import type { EntityEntry } from '../shared/entity-registry.js';

interface LegacyLookupExports {
  alias: (alias: string) => EntityEntry | undefined;
  keyword: (keyword: string) => EntityEntry[];
  sector: (sector: string) => EntityEntry[];
}

const implementations: Array<[string, LegacyLookupExports]> = [
  ['shared core', {
    alias: lookupSharedEntityByAlias,
    keyword: lookupSharedEntitiesByKeyword,
    sector: lookupSharedEntitiesBySector,
  }],
  ['TypeScript bridge', {
    alias: lookupClientEntityByAlias,
    keyword: lookupClientEntitiesByKeyword,
    sector: lookupClientEntitiesBySector,
  }],
];

describe('legacy entity-index lookup exports', () => {
  it('re-exports the shared implementation through the TypeScript bridge', () => {
    assert.equal(lookupClientEntityByAlias, lookupSharedEntityByAlias);
    assert.equal(lookupClientEntitiesByKeyword, lookupSharedEntitiesByKeyword);
    assert.equal(lookupClientEntitiesBySector, lookupSharedEntitiesBySector);
  });

  for (const [source, lookup] of implementations) {
    it(`preserves case-insensitive lookup behavior via the ${source}`, () => {
      assert.equal(lookup.alias('MiCrOsOfT')?.id, 'MSFT');
      assert.equal(lookup.alias('not-a-real-entity'), undefined);

      assert.deepEqual(lookup.keyword('GPU').map((entity) => entity.id), ['NVDA']);
      assert.deepEqual(lookup.keyword('not-a-real-keyword'), []);

      assert.deepEqual(
        lookup.sector('dEfEnSe').map((entity) => entity.id),
        ['LMT', 'RTX', 'NOC', 'BA', 'GD', 'RHM.DE', 'AIR.PA'],
      );
      assert.deepEqual(lookup.sector('not-a-real-sector'), []);
    });
  }
});
