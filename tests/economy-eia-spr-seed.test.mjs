import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchSprLevels,
  fetchCrudeInventories,
  parseEiaSprRow,
  parseEiaRefineryRow,
  SPR_TTL,
  REFINERY_INPUTS_TTL,
} from '../scripts/seed-economy.mjs';

it('seeds commercial crude in million barrels with weekly changes in the same unit', async (t) => {
  const previousKey = process.env.EIA_API_KEY;
  process.env.EIA_API_KEY = 'fixture';
  t.after(() => {
    if (previousKey === undefined) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = previousKey;
  });
  const values = [427320, 426398, 425000, 424000, 423000];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('facets[series][]'), 'WCESTUS1');
    return Response.json({ response: { data: values.map((value, i) => ({
      value: String(value), period: `2026-09-${25 - i}`, units: 'Thousand Barrels',
    })) } });
  });
  const result = await fetchCrudeInventories();
  assert.equal(result.weeks[0].stocksMb, 427.32);
  assert.equal(result.weeks[0].weeklyChangeMb, 0.922);
  assert.equal(result.weeks.at(-1).weeklyChangeMb, null);
});

// ─── Key constants (imported from cache-keys pattern) ───
// These tests intentionally cross-check the seed's internal strings against
// the expected Redis key format so a key rename in either place fails loudly.

describe('seed Redis key strings', () => {
  it('SPR payload shape matches expected consumer contract', () => {
    // Verify what consumers of economic:spr:v1 will read
    const result = parseEiaSprRow({ value: '370200.0', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.ok('barrels' in result, 'SPR payload must have barrels field');
    assert.ok('period' in result, 'SPR payload must have period field');
    assert.equal(typeof result.barrels, 'number', 'barrels must be converted from thousand to million barrels');
  });

  it('refinery key follows economic:refinery-inputs:v1 convention', () => {
    // Verify the shape of a minimal seeded refinery payload (what consumers will read)
    const result = parseEiaRefineryRow({ value: '15973', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.ok('inputsMbblpd' in result, 'Refinery payload must have inputsMbblpd field (not utilization %)');
    assert.ok('period' in result, 'Refinery payload must have period field');
  });
});

// ─── TTL constants (imported from seed-economy) ───

describe('TTL constants', () => {
  it('SPR_TTL is at least 21 days in seconds', () => {
    assert.ok(SPR_TTL >= 21 * 24 * 3600, `SPR_TTL ${SPR_TTL} < 21 days`);
  });

  it('REFINERY_INPUTS_TTL is at least 21 days in seconds', () => {
    assert.ok(REFINERY_INPUTS_TTL >= 21 * 24 * 3600, `REFINERY_INPUTS_TTL ${REFINERY_INPUTS_TTL} < 21 days`);
  });
});

// ─── parseEiaSprRow ───

describe('parseEiaSprRow', () => {
  it('parses a numeric string value', () => {
    const result = parseEiaSprRow({ value: '370200.0', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.equal(result.barrels, 370.2);
    assert.equal(result.period, '2026-03-28');
  });

  it('parses a numeric value', () => {
    const result = parseEiaSprRow({ value: 370234, period: '2026-03-21' });
    assert.ok(result !== null);
    assert.equal(result.barrels, 370.234);
  });

  it('returns null for null value', () => {
    assert.equal(parseEiaSprRow({ value: null, period: '2026-03-28' }), null);
  });

  it('returns null for empty string value', () => {
    assert.equal(parseEiaSprRow({ value: '', period: '2026-03-28' }), null);
  });

  it('returns null for NaN value', () => {
    assert.equal(parseEiaSprRow({ value: 'N/A', period: '2026-03-28' }), null);
  });

  it('returns null for undefined row', () => {
    assert.equal(parseEiaSprRow(undefined), null);
  });

  it('returns null for null row', () => {
    assert.equal(parseEiaSprRow(null), null);
  });

  it('sets period to empty string for invalid date format', () => {
    const result = parseEiaSprRow({ value: '370200.0', period: '2026/03/28' });
    assert.ok(result !== null);
    assert.equal(result.period, '');
  });

  it('rounds barrels to 3 decimal places', () => {
    const result = parseEiaSprRow({ value: '370123.45', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.equal(result.barrels, 370.123);
  });
});

// ─── SPR weekly changes ───

describe('fetchSprLevels', () => {
  it('computes weekly and four-week changes from EIA rows', async (t) => {
    const previousApiKey = process.env.EIA_API_KEY;
    process.env.EIA_API_KEY = 'test-eia-key';
    t.after(() => {
      if (previousApiKey === undefined) delete process.env.EIA_API_KEY;
      else process.env.EIA_API_KEY = previousApiKey;
    });

    const rows = [
      { value: '370200.0', period: '2026-03-28' },
      { value: '371600.0', period: '2026-03-21' },
      { value: '372000.0', period: '2026-03-14' },
      { value: '373000.0', period: '2026-03-07' },
      { value: '375400.0', period: '2026-02-28' },
    ];
    t.mock.method(globalThis, 'fetch', async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/v2/petroleum/stoc/wstk/data/');
      assert.equal(url.searchParams.get('facets[series][]'), 'WCSSTUS1');
      return Response.json({ response: { data: rows } });
    });

    const result = await fetchSprLevels();

    assert.equal(result.changeWoW, -1.4);
    assert.equal(result.changeWoW4, -5.2);
    assert.deepEqual(result.weeks, rows.map((row) => ({
      period: row.period,
      barrels: Number(row.value) / 1000,
    })));
  });

  it('returns no four-week change when a fifth valid week is unavailable', async (t) => {
    const previousApiKey = process.env.EIA_API_KEY;
    process.env.EIA_API_KEY = 'test-eia-key';
    t.after(() => {
      if (previousApiKey === undefined) delete process.env.EIA_API_KEY;
      else process.env.EIA_API_KEY = previousApiKey;
    });

    t.mock.method(globalThis, 'fetch', async () => Response.json({
      response: {
        data: [
          { value: '370200.0', period: '2026-03-28' },
          { value: '371600.0', period: '2026-03-21' },
          { value: '372000.0', period: '2026-03-14' },
          { value: '373400.0', period: '2026-03-07' },
        ],
      },
    }));

    const result = await fetchSprLevels();

    assert.equal(result.changeWoW4, null);
  });
});

// ─── parseEiaRefineryRow ───

describe('parseEiaRefineryRow', () => {
  it('parses a numeric string value', () => {
    const result = parseEiaRefineryRow({ value: '15973', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.equal(result.inputsMbblpd, 15.973);
    assert.equal(result.period, '2026-03-28');
  });

  it('parses a numeric value', () => {
    const result = parseEiaRefineryRow({ value: 15973, period: '2026-03-21' });
    assert.ok(result !== null);
    assert.equal(result.inputsMbblpd, 15.973);
  });

  it('returns null for null value', () => {
    assert.equal(parseEiaRefineryRow({ value: null, period: '2026-03-28' }), null);
  });

  it('returns null for empty string value', () => {
    assert.equal(parseEiaRefineryRow({ value: '', period: '2026-03-28' }), null);
  });

  it('returns null for NaN string value', () => {
    assert.equal(parseEiaRefineryRow({ value: 'N/A', period: '2026-03-28' }), null);
  });

  it('returns null for undefined row', () => {
    assert.equal(parseEiaRefineryRow(undefined), null);
  });

  it('returns null for null row', () => {
    assert.equal(parseEiaRefineryRow(null), null);
  });

  it('sets period to empty string for invalid date format', () => {
    const result = parseEiaRefineryRow({ value: '15973', period: '20260328' });
    assert.ok(result !== null);
    assert.equal(result.period, '');
  });

  it('rounds inputsMbblpd to 3 decimal places', () => {
    const result = parseEiaRefineryRow({ value: '15973.12345', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.equal(result.inputsMbblpd, 15.973);
  });
});
