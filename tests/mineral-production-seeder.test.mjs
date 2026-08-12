import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_KEY,
  contentMeta,
  pickUsgsMcsCsvFromCatalog,
  validateFn,
} from '../scripts/seed-mineral-production.mjs';

describe('seed-mineral-production wiring', () => {
  it('publishes the issue-specified Redis key', () => {
    assert.equal(CANONICAL_KEY, 'supply-chain:mineral-production:v1');
  });

  it('picks the newest MCS Commodities_Data.csv from ScienceBase catalog items', () => {
    const picked = pickUsgsMcsCsvFromCatalog({
      items: [
        {
          title: 'Mineral Commodity Summaries 2025 Data Release - Commodity Salient U.S. and World Statistics',
          files: [{ name: 'MCS2025_Commodities_Data.csv', downloadUri: 'https://example.test/2025.csv' }],
        },
        {
          title: 'Mineral Commodity Summaries 2026 Data Release - Commodity Salient U.S. and World Statistics',
          files: [{ name: 'MCS2026_Commodities_Data.csv', downloadUri: 'https://example.test/2026.csv' }],
        },
      ],
    });
    assert.equal(picked.year, 2026);
    assert.equal(picked.url, 'https://example.test/2026.csv');
  });

  it('contentMeta supplies both timestamps runSeed requires', () => {
    const meta = contentMeta({ dataYear: 2024 });
    assert.ok(meta);
    assert.equal(meta.newestItemAt, Date.parse('2024-12-31T00:00:00.000Z'));
    assert.equal(meta.oldestItemAt, meta.newestItemAt);
    assert.equal(contentMeta({}), null);
  });

  it('rejects payloads with too few staged commodities', () => {
    assert.equal(validateFn({ commodities: { cobalt: { stages: { mine: { countries: [] } } } } }), false);
    assert.equal(validateFn({
      commodities: Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => [id, { stages: { mine: { countries: [1] } } }]),
      ),
    }), true);
  });
});
