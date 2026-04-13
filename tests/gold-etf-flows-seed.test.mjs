import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseGldArchive, computeFlows } from '../scripts/seed-gold-etf-flows.mjs';

describe('seed-gold-etf-flows: parseGldArchive', () => {
  it('parses tonnes column directly when present', () => {
    const csv = `Date,Gold (Tonnes),Total Net Assets,NAV
10-Apr-26,905.20,90500000000,78.50
09-Apr-26,904.10,90000000000,78.20`;
    const rows = parseGldArchive(csv);
    assert.equal(rows.length, 2);
    // Sorted ascending
    assert.equal(rows[0].date, '2026-04-09');
    assert.equal(rows[1].date, '2026-04-10');
    assert.equal(rows[1].tonnes, 905.20);
    assert.equal(rows[1].aum, 90500000000);
  });

  it('falls back to troy oz → tonnes conversion', () => {
    const csv = `Date,Gold Troy Oz,Total Net Assets,NAV
10-Apr-26,29097063.5,90500000000,78.50`;
    const rows = parseGldArchive(csv);
    assert.equal(rows.length, 1);
    // 29,097,063.5 / 32,150.7 ≈ 905.02
    assert.ok(Math.abs(rows[0].tonnes - 905.02) < 0.1, `got ${rows[0].tonnes}`);
  });

  it('handles M/D/YYYY date format', () => {
    const csv = `Date,Gold (Tonnes)
4/10/2026,905.20`;
    const rows = parseGldArchive(csv);
    assert.equal(rows[0]?.date, '2026-04-10');
  });

  it('skips rows with zero or negative tonnage', () => {
    const csv = `Date,Gold (Tonnes)
10-Apr-26,905.20
09-Apr-26,0
08-Apr-26,-5`;
    const rows = parseGldArchive(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tonnes, 905.20);
  });

  it('strips UTF-8 BOM from the first header cell', () => {
    // Regression guard (PR #3037 review): SPDR has been observed serving the
    // CSV with a leading UTF-8 BOM. Without stripping, findCol('date') would
    // return -1 and parseGldArchive silently returns [].
    const csv = `\uFEFFDate,Gold (Tonnes)
10-Apr-26,905.20`;
    const rows = parseGldArchive(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tonnes, 905.20);
  });

  it('returns empty on malformed CSV', () => {
    assert.deepEqual(parseGldArchive(''), []);
    assert.deepEqual(parseGldArchive('junk\ndata'), []);
  });

  it('strips commas and dollar signs from numeric cells', () => {
    const csv = `Date,Gold (Tonnes),Total Net Assets
10-Apr-26,"905.20","$90,500,000,000"`;
    const rows = parseGldArchive(csv);
    assert.equal(rows[0].aum, 90500000000);
  });
});

describe('seed-gold-etf-flows: computeFlows', () => {
  // Build a 260-day synthetic history (~1 trading year + slack)
  const buildHistory = (tonnesFn) => {
    const out = [];
    const start = new Date('2025-04-15T00:00:00Z');
    for (let i = 0; i < 260; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      out.push({ date: d.toISOString().slice(0, 10), tonnes: tonnesFn(i), aum: 0, nav: 0 });
    }
    return out;
  };

  it('returns null on empty history', () => {
    assert.equal(computeFlows([]), null);
  });

  it('computes 1W / 1M / 1Y tonnage deltas correctly', () => {
    // Linear +1 tonne/day
    const history = buildHistory(i => 800 + i);
    const flows = computeFlows(history);
    // latest = 800 + 259 = 1059; 5d ago = 1054 → +5 tonnes; 21d ago = 1038 → +21; 252d ago = 807 → +252
    assert.equal(flows.tonnes, 1059);
    assert.equal(flows.changeW1Tonnes, 5);
    assert.equal(flows.changeM1Tonnes, 21);
    assert.equal(flows.changeY1Tonnes, 252);
  });

  it('sparkline is last 90 days of tonnage', () => {
    const history = buildHistory(i => 800 + i);
    const flows = computeFlows(history);
    assert.equal(flows.sparkline90d.length, 90);
    assert.equal(flows.sparkline90d[0], 800 + 170); // 260 - 90 = index 170
    assert.equal(flows.sparkline90d[89], 1059);
  });

  it('handles short histories (<252 days) without crashing', () => {
    const history = buildHistory(i => 800 + i).slice(0, 10);
    const flows = computeFlows(history);
    assert.ok(flows !== null);
    // With <5 days of prior data, changeW1 uses oldest row as baseline
    assert.ok(Number.isFinite(flows.changeW1Tonnes));
    assert.ok(Number.isFinite(flows.changeY1Tonnes));
  });

  it('percent deltas are zero when baseline is zero', () => {
    const history = [
      { date: '2026-04-09', tonnes: 0, aum: 0, nav: 0 },
      { date: '2026-04-10', tonnes: 900, aum: 0, nav: 0 },
    ];
    const flows = computeFlows(history);
    assert.equal(flows.changeW1Pct, 0);
  });
});
