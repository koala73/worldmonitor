import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_KEY,
  contentMeta,
  discoverUsgsMcsCsv,
  fetchBgsFill,
  minStagedCommodities,
  pickUsgsMcsCsvFromCatalog,
  validateFn,
} from '../scripts/seed-mineral-production.mjs';
import { loadMineralVocab } from '../scripts/shared/mineral-production-parse.mjs';

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
    // The picker itself is host-agnostic; discoverUsgsMcsCsv applies the
    // allowlist (see the off-host test below).
    assert.equal(picked.url, 'https://example.test/2026.csv');
  });

  it('rejects an off-host discovered CSV and falls back to the pinned edition', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [{
          title: 'Mineral Commodity Summaries 2027 Data Release - Commodity Salient U.S. and World Statistics',
          files: [{ name: 'MCS2027_Commodities_Data.csv', url: 'https://evil.example/2027_commodities_data.csv' }],
        }],
      }),
    });
    try {
      const discovered = await discoverUsgsMcsCsv();
      assert.match(discovered.url, /^https:\/\/www\.sciencebase\.gov\//);
      assert.equal(discovered.edition, 'mcs-2026-pinned');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('accepts a discovered CSV served from an allowlisted USGS host', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [{
          title: 'Mineral Commodity Summaries 2027 Data Release - Commodity Salient U.S. and World Statistics',
          files: [{
            name: 'MCS2027_Commodities_Data.csv',
            downloadUri: 'https://www.sciencebase.gov/catalog/file/get/abc123',
          }],
        }],
      }),
    });
    try {
      const discovered = await discoverUsgsMcsCsv();
      assert.equal(discovered.url, 'https://www.sciencebase.gov/catalog/file/get/abc123');
      assert.equal(discovered.edition, 'mcs-2027');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('contentMeta supplies both timestamps runSeed requires', () => {
    const meta = contentMeta({ dataYear: 2024 });
    assert.ok(meta);
    assert.equal(meta.newestItemAt, Date.parse('2024-12-31T00:00:00.000Z'));
    assert.equal(meta.oldestItemAt, meta.newestItemAt);
    assert.equal(contentMeta({}), null);
  });

  it('flags a total BGS outage instead of reporting an empty fill', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
      await assert.rejects(
        () => fetchBgsFill(loadMineralVocab(), []),
        (err) => err.totalBgsOutage === true && /all \d+ commodity names/.test(err.message),
        'every BGS name failing must be distinguishable from BGS having nothing to add',
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('tolerates a partial BGS outage without failing the run', async () => {
    const realFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      if (call % 2 === 0) throw new Error('upstream 503');
      return { ok: true, json: async () => ({ features: [] }) };
    };
    try {
      const rows = await fetchBgsFill(loadMineralVocab(), []);
      assert.deepEqual(rows, [], 'partial failure still returns the successful rows');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('derives the publish floor from the shipped vocabulary, not a constant', () => {
    const vocab = loadMineralVocab();
    const floor = minStagedCommodities();
    assert.equal(floor, Math.ceil(vocab.commodities.length * 0.7));
    // The floor must actually track the vocab: a hardcoded 8 would tolerate
    // losing 43% of a 14-commodity vocabulary with every gate still green.
    assert.ok(floor > 8, `floor ${floor} should exceed the old hardcoded 8`);
    assert.equal(minStagedCommodities({ commodities: new Array(20).fill({}) }), 14);
  });

  it('rejects payloads with too few staged commodities', () => {
    const floor = minStagedCommodities();
    const staged = (n) => ({
      commodities: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`c${i}`, { stages: { mine: { countries: [1] } } }]),
      ),
    });
    assert.equal(validateFn({ commodities: { cobalt: { stages: { mine: { countries: [] } } } } }), false);
    assert.equal(validateFn(staged(floor - 1)), false, 'one below the floor must not publish');
    assert.equal(validateFn(staged(floor)), true, 'exactly the floor must publish');
  });
});
