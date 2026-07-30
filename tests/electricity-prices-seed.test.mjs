import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEntsoEPrice,
  buildElectricityIndex,
  EIA_REGIONS,
  ELECTRICITY_INDEX_KEY,
  ELECTRICITY_KEY_PREFIX,
  ELECTRICITY_TTL_SECONDS,
  fetchEiaRegion,
} from '../scripts/seed-electricity-prices.mjs';

// ── parseEntsoEPrice ──────────────────────────────────────────────────────────

describe('parseEntsoEPrice', () => {
  it('extracts average from XML with 24 hourly price.amount values', () => {
    const prices = Array.from({ length: 24 }, (_, i) => 80 + i); // 80..103
    const xml = prices
      .map((p, i) => `<Point><position>${i + 1}</position><price.amount>${p}.00</price.amount></Point>`)
      .join('\n');
    const result = parseEntsoEPrice(xml);
    const expected = +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2);
    assert.equal(result, expected);
  });

  it('returns null when no price.amount tags present', () => {
    const xml = '<TimeSeries><Period><resolution>PT60M</resolution></Period></TimeSeries>';
    assert.equal(parseEntsoEPrice(xml), null);
  });

  it('handles a single price value', () => {
    const xml = '<price.amount>87.30</price.amount>';
    assert.equal(parseEntsoEPrice(xml), 87.3);
  });

  it('ignores non-numeric price values', () => {
    const xml = '<price.amount>abc</price.amount><price.amount>50.00</price.amount>';
    assert.equal(parseEntsoEPrice(xml), 50);
  });

  it('handles negative prices (common in EU wholesale markets)', () => {
    const xml = '<price.amount>-10.00</price.amount><price.amount>20.00</price.amount>';
    assert.equal(parseEntsoEPrice(xml), 5);
  });

  it('handles all-negative prices', () => {
    const xml = '<price.amount>-5.00</price.amount><price.amount>-15.00</price.amount>';
    assert.equal(parseEntsoEPrice(xml), -10);
  });
});

// ── buildElectricityIndex ─────────────────────────────────────────────────────

describe('buildElectricityIndex', () => {
  function makeRegions(count, base = 100) {
    return Array.from({ length: count }, (_, i) => ({
      region: `R${i}`,
      source: 'entso-e',
      priceMwhEur: base - i,
      priceMwhUsd: null,
      date: '2026-04-05',
      unit: 'EUR/MWh',
      seededAt: new Date().toISOString(),
    }));
  }

  it('returns only regions with valid priceMwhEur, sorted descending', () => {
    const regions = [
      { region: 'DE', source: 'entso-e', priceMwhEur: 87.3, priceMwhUsd: null, date: '2026-04-05', unit: 'EUR/MWh', seededAt: '' },
      { region: 'FR', source: 'entso-e', priceMwhEur: 62.1, priceMwhUsd: null, date: '2026-04-05', unit: 'EUR/MWh', seededAt: '' },
      { region: 'CISO', source: 'eia-930', priceMwhEur: null, priceMwhUsd: null, date: '2026-04-05', unit: 'MWh', seededAt: '' },
    ];
    const index = buildElectricityIndex(regions, '2026-04-05');
    assert.equal(index.regions.length, 2, 'should exclude null priceMwhEur entries');
    assert.equal(index.regions[0].region, 'DE', 'highest price first');
    assert.equal(index.regions[1].region, 'FR', 'second highest price second');
  });

  it('caps at 20 entries', () => {
    const regions = makeRegions(25);
    const index = buildElectricityIndex(regions, '2026-04-05');
    assert.equal(index.regions.length, 20);
  });

  it('returns updatedAt and date fields', () => {
    const regions = makeRegions(3);
    const index = buildElectricityIndex(regions, '2026-04-05');
    assert.ok(typeof index.updatedAt === 'string');
    assert.equal(index.date, '2026-04-05');
    assert.ok(Array.isArray(index.regions));
  });

  it('returns empty regions array when no valid prices exist', () => {
    const regions = [
      { region: 'CISO', source: 'eia-930', priceMwhEur: null, priceMwhUsd: null, date: '2026-04-05', unit: 'MWh', seededAt: '' },
    ];
    const index = buildElectricityIndex(regions, '2026-04-05');
    assert.equal(index.regions.length, 0);
  });
});

// ── Missing ENTSO_E_TOKEN path ────────────────────────────────────────────────

describe('ENTSO_E_TOKEN handling', () => {
  it('ELECTRICITY_INDEX_KEY is defined as a string (token absence not needed at module import level)', () => {
    // The absence-of-token path is a runtime branch in main().
    // We verify the key constant is defined so the module imported cleanly
    // even without ENTSO_E_TOKEN set.
    assert.equal(typeof ELECTRICITY_INDEX_KEY, 'string');
  });
});

// ── Key constants ─────────────────────────────────────────────────────────────

describe('exported key constants', () => {
  it('ELECTRICITY_INDEX_KEY matches expected pattern', () => {
    assert.equal(ELECTRICITY_INDEX_KEY, 'energy:electricity:v1:index');
  });

  it('ELECTRICITY_KEY_PREFIX matches expected pattern', () => {
    assert.equal(ELECTRICITY_KEY_PREFIX, 'energy:electricity:v1:');
  });

  it('ELECTRICITY_TTL_SECONDS is at least 3 days', () => {
    assert.ok(
      ELECTRICITY_TTL_SECONDS >= 3 * 24 * 3600,
      `TTL ${ELECTRICITY_TTL_SECONDS}s is less than 3 days`,
    );
  });
});

// ── EIA region/respondent mapping ────────────────────────────────────────────

describe('EIA_REGIONS respondent codes', () => {
  const EXPECTED = {
    CISO: 'CISO',
    MISO: 'MISO',
    PJM: 'PJM',
    NYISO: 'NYIS',
    ERCO: 'ERCO',
    SPP: 'SWPP',
    ISNE: 'ISNE',
  };

  it('every entry has distinct region and respondent fields', () => {
    for (const entry of EIA_REGIONS) {
      assert.ok(typeof entry.region === 'string' && entry.region.length > 0, `missing region`);
      assert.ok(typeof entry.respondent === 'string' && entry.respondent.length > 0, `missing respondent for ${entry.region}`);
    }
  });

  it('maps public region IDs to correct EIA respondent codes', () => {
    for (const [region, respondent] of Object.entries(EXPECTED)) {
      const entry = EIA_REGIONS.find((r) => r.region === region);
      assert.ok(entry, `missing EIA_REGIONS entry for ${region}`);
      assert.equal(entry.respondent, respondent, `${region} should use respondent ${respondent}, got ${entry.respondent}`);
    }
  });

  it('covers all expected regions', () => {
    const regions = EIA_REGIONS.map((r) => r.region);
    for (const expected of Object.keys(EXPECTED)) {
      assert.ok(regions.includes(expected), `EIA_REGIONS missing ${expected}`);
    }
  });
});

// ── fetchEiaRegion query construction ────────────────────────────────────────
//
// EIA-930 region-data interleaves type=D (Demand), DF (Day-ahead Forecast),
// NG (Net Generation), and TI (Total Interchange) in one series. Without
// frequency=hourly + facets[type][]=D, `length=1 sort=desc` can return a
// forecast/generation/interchange row instead of actual demand — silent data
// corruption that goes undetected because the row still parses.

describe('fetchEiaRegion query construction', () => {
  const REGION = { region: 'ISNE', respondent: 'ISNE', name: 'New England' };
  const TODAY = new Date('2026-05-24T00:00:00Z');

  function mockFetch(response, captured) {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      captured.url = url;
      return response;
    };
    return () => {
      globalThis.fetch = original;
    };
  }

  it('pins frequency=hourly and facets[type][]=D so non-Demand rows cannot win sort=desc', async () => {
    const captured = {};
    const restore = mockFetch(
      {
        ok: true,
        json: async () => ({ response: { data: [{ period: '2026-05-24T05', value: 10271, type: 'D' }] } }),
      },
      captured,
    );
    try {
      await fetchEiaRegion(REGION, 'test-key', TODAY);
    } finally {
      restore();
    }
    const params = new URL(captured.url).searchParams;
    assert.equal(params.get('frequency'), 'hourly', 'must request hourly to avoid daily-aggregate fallback');
    assert.equal(params.get('facets[type][]'), 'D', 'must filter to Demand rows');
    assert.equal(params.get('facets[respondent][]'), 'ISNE');
  });

  it('parses a Demand row into a record with demandMwh + source=eia-930', async () => {
    const restore = mockFetch(
      {
        ok: true,
        json: async () => ({ response: { data: [{ period: '2026-05-24T05', value: 10271, type: 'D' }] } }),
      },
      {},
    );
    let result;
    try {
      result = await fetchEiaRegion(REGION, 'test-key', TODAY);
    } finally {
      restore();
    }
    assert.ok(result, 'expected a record');
    assert.equal(result.region, 'ISNE');
    assert.equal(result.demandMwh, 10271);
    assert.equal(result.source, 'eia-930');
    assert.equal(result.priceMwhEur, null);
  });

  it('anchors the start/end window to the today argument, not wall-clock', async () => {
    // Backfill / test-harness scenario: caller passes a historical `today`.
    // If start were derived from Date.now() it would land after end and EIA
    // would return zero rows silently. Window must be self-consistent with
    // the today argument.
    const historicalToday = new Date('2024-01-15T00:00:00Z');
    const captured = {};
    const restore = mockFetch(
      {
        ok: true,
        json: async () => ({ response: { data: [{ period: '2024-01-15T05', value: 9000, type: 'D' }] } }),
      },
      captured,
    );
    try {
      await fetchEiaRegion(REGION, 'test-key', historicalToday);
    } finally {
      restore();
    }
    const params = new URL(captured.url).searchParams;
    assert.equal(params.get('end'), '2024-01-15');
    assert.equal(params.get('start'), '2024-01-13', 'start must be today-2d, not Date.now()-2d');
  });

  it('returns null when the API returns no data rows', async () => {
    const restore = mockFetch(
      { ok: true, json: async () => ({ response: { data: [] } }) },
      {},
    );
    let result;
    try {
      result = await fetchEiaRegion(REGION, 'test-key', TODAY);
    } finally {
      restore();
    }
    assert.equal(result, null);
  });
});
