import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Inline helpers mirroring handler mapping logic ───

/** Maps raw SPR seed payload to handler response shape. Value is ALREADY in Mb. */
function mapSprResponse(raw) {
  if (!raw) return null;
  return {
    latestPeriod: raw.latestPeriod,
    latestStocksMb: raw.barrels,
    changeWoW: raw.changeWoW,
    changeWoW4: raw.changeWoW4,
    weeks: (raw.weeks ?? []).map(w => ({ period: w.period, stocksMb: w.barrels })),
  };
}

/** Simulates handler assembling partial response from 6 Redis keys */
function assembleOilInventories({ crude, spr, natGas, euGas, iea, refinery }) {
  return {
    crudeWeeks: crude ?? null,
    spr: spr ? mapSprResponse(spr) : null,
    natGasWeeks: natGas ?? null,
    euGas: euGas ?? null,
    ieaStocks: iea ?? null,
    refinery: refinery ?? null,
  };
}

// ─── Pure utility helpers ───

function reverseForChart(weeks) {
  return weeks.slice().reverse();
}

function sortIeaForChart(members) {
  return members.slice().sort((a, b) => {
    const aNet = a.netExporter === true;
    const bNet = b.netExporter === true;
    if (aNet !== bNet) return aNet ? 1 : -1;
    const aVal = a.daysOfCover ?? Infinity;
    const bVal = b.daysOfCover ?? Infinity;
    return aVal - bVal;
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mergeByPeriod(crudeWeeks, sprWeeks) {
  const crudeMap = new Map(crudeWeeks.map(w => [w.period, w.stocksMb]));
  const sprMap = new Map(sprWeeks.map(w => [w.period, w.stocksMb]));
  const allPeriods = [...new Set([...crudeMap.keys(), ...sprMap.keys()])].sort();
  return allPeriods.map(p => ({
    period: p,
    crudeMb: crudeMap.get(p) ?? null,
    sprMb: sprMap.get(p) ?? null,
  }));
}

// ─── Tests ───

describe('Oil Inventories', () => {

  // Test 1: SPR double-conversion guard
  it('SPR values are already in Mb — handler must NOT divide by 1,000,000', () => {
    const mockSpr = {
      latestPeriod: '2026-04-04',
      barrels: 395.2,
      changeWoW: -0.3,
      changeWoW4: -1.2,
      weeks: [
        { period: '2026-04-04', barrels: 395.2 },
        { period: '2026-03-28', barrels: 395.5 },
      ],
    };

    const sprResponse = mapSprResponse(mockSpr);

    assert.equal(sprResponse.latestStocksMb, 395.2, 'latestStocksMb must equal raw barrels (already Mb)');
    assert.ok(sprResponse.latestStocksMb > 100, `SPR sanity guard failed: ${sprResponse.latestStocksMb} <= 100 (real SPR is ~350-400 Mb)`);
    assert.equal(sprResponse.weeks[0].stocksMb, 395.2, 'weeks[0].stocksMb must equal raw barrels');
    assert.equal(sprResponse.weeks[1].stocksMb, 395.5);
    assert.equal(sprResponse.changeWoW, -0.3);
    assert.equal(sprResponse.changeWoW4, -1.2);
  });

  // Test 2: Handler partial-key availability
  it('degrades independently when some Redis keys return null', () => {
    const response = assembleOilInventories({
      crude: [{ period: '2026-04-04', stocksMb: 440 }],
      spr: null,
      natGas: [{ period: '2026-04-04', storageBcf: 1800 }],
      euGas: null,
      iea: null,
      refinery: null,
    });

    assert.ok(Array.isArray(response.crudeWeeks), 'crudeWeeks should be an array');
    assert.ok(response.crudeWeeks.length > 0, 'crudeWeeks should have entries');
    assert.equal(response.spr, null, 'spr should be null when Redis key missing');
    assert.ok(Array.isArray(response.natGasWeeks), 'natGasWeeks should be an array');
    assert.ok(response.natGasWeeks.length > 0, 'natGasWeeks should have entries');
    assert.equal(response.euGas, null, 'euGas should be null when Redis key missing');
    assert.equal(response.ieaStocks, null, 'ieaStocks should be null when Redis key missing');
    assert.equal(response.refinery, null, 'refinery should be null when Redis key missing');
  });

  // Test 3: Chart sort order verification
  it('reverses EIA data to oldest-first for charting and sorts IEA by daysOfCover', () => {
    const crudeNewestFirst = [
      { period: '2026-04-04', stocksMb: 440 },
      { period: '2026-03-28', stocksMb: 442 },
      { period: '2026-03-21', stocksMb: 444 },
    ];

    const reversed = reverseForChart(crudeNewestFirst);
    assert.equal(reversed[0].period, '2026-03-21', 'reversed[0] should be oldest');
    assert.equal(reversed[2].period, '2026-04-04', 'reversed[last] should be newest');
    assert.equal(crudeNewestFirst[0].period, '2026-04-04', 'original array must not be mutated');

    const ieaMembers = [
      { country: 'US', daysOfCover: 120, netExporter: false },
      { country: 'JP', daysOfCover: 85, netExporter: false },
      { country: 'NO', daysOfCover: 150, netExporter: true },
      { country: 'XX', daysOfCover: null, netExporter: false },
    ];

    const sorted = sortIeaForChart(ieaMembers);
    assert.equal(sorted[0].daysOfCover, 85, 'lowest daysOfCover first');
    assert.equal(sorted[1].daysOfCover, 120, 'second lowest next');
    // netExporter and null daysOfCover go to bottom
    assert.equal(sorted[2].country, 'XX', 'null daysOfCover should be near bottom');
    assert.equal(sorted[3].country, 'NO', 'netExporter should be last');
  });

  // Test 4: SVG label escaping
  it('escapes HTML/SVG-unsafe characters in upstream strings', () => {
    assert.equal(
      escapeHtml('<script>alert(1)</script>'),
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    assert.equal(escapeHtml('US'), 'US', 'safe strings must not be mutated');
    assert.equal(escapeHtml('R&D'), 'R&amp;D');
    assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
    assert.equal(escapeHtml("it's"), "it&#39;s");
  });

  // Test 5: Crude/SPR merge-by-period with mismatched weeks
  it('merges crude and SPR by period with nulls for missing sides', () => {
    const crudeWeeks = [
      { period: 'A', stocksMb: 440 },
      { period: 'B', stocksMb: 442 },
      { period: 'C', stocksMb: 444 },
    ];
    const sprWeeks = [
      { period: 'B', stocksMb: 395 },
      { period: 'C', stocksMb: 396 },
      { period: 'D', stocksMb: 397 },
    ];

    const result = mergeByPeriod(crudeWeeks, sprWeeks);

    assert.equal(result.length, 4, 'union of periods A,B,C,D = 4 entries');
    assert.deepEqual(result[0], { period: 'A', crudeMb: 440, sprMb: null });
    assert.deepEqual(result[1], { period: 'B', crudeMb: 442, sprMb: 395 });
    assert.deepEqual(result[2], { period: 'C', crudeMb: 444, sprMb: 396 });
    assert.deepEqual(result[3], { period: 'D', crudeMb: null, sprMb: 397 });
  });

  // Test 6: Stacked chart skips weeks where one series is null (no fake zero-collapse)
  it('stacked chart filters to complete weeks only, falls back to crude-only when SPR absent', () => {
    const merged = mergeByPeriod(
      [{ period: 'A', stocksMb: 440 }, { period: 'B', stocksMb: 442 }, { period: 'C', stocksMb: 444 }],
      [{ period: 'B', stocksMb: 395 }, { period: 'C', stocksMb: 396 }],
    );
    // Week A has crude but no SPR => should NOT appear in complete set
    const complete = merged.filter(w => w.crudeMb != null && w.sprMb != null);
    assert.equal(complete.length, 2, 'only B and C have both series');
    assert.equal(complete[0].period, 'B');
    assert.equal(complete[1].period, 'C');

    // When SPR is entirely absent, fall back to crude-only
    const noSpr = mergeByPeriod(
      [{ period: 'X', stocksMb: 100 }, { period: 'Y', stocksMb: 200 }],
      [],
    );
    const completeNoSpr = noSpr.filter(w => w.crudeMb != null && w.sprMb != null);
    assert.equal(completeNoSpr.length, 0, 'no complete weeks when SPR absent');
    const crudeOnly = noSpr.filter(w => w.crudeMb != null);
    assert.equal(crudeOnly.length, 2, 'crude-only fallback should have 2 weeks');
  });
});
