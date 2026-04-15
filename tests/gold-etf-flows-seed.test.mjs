import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { parseGldArchiveXlsx, computeFlows } from '../scripts/seed-gold-etf-flows.mjs';

// exceljs lives in scripts/node_modules (not the repo root) — resolve from
// the scripts package the seeder itself ships from.
const require = createRequire(new URL('../scripts/package.json', import.meta.url));

// Build a synthetic XLSX in memory that mirrors the real SPDR layout:
//   sheet "US GLD Historical Archive"
//   row 1 = headers; col 1=Date, 2=Close, 10=Tonnes, 11=AUM
async function buildSyntheticXlsx(rows, sheetName = 'US GLD Historical Archive') {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Disclaimer').addRow(['SPDR GOLD SHARES DISCLAIMER — synthetic test data']);
  const ws = wb.addWorksheet(sheetName);
  ws.addRow([
    'Date', 'Closing Price', 'Ounces of Gold per Share', 'NAV/Share',
    'IOPV', 'Mid', 'Premium/Discount', 'Volume',
    'Total Ounces', 'Tonnes of Gold', 'Total Net Asset Value',
  ]);
  for (const r of rows) {
    ws.addRow([r.date, r.nav ?? 0, 0, 0, 0, 0, 0, 0, 0, r.tonnes ?? 0, r.aum ?? 0]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Parser guards on rowCount < 10 to reject nearly-empty sheets; tests that
// want data back must supply ≥ 9 data rows.
function daysAgoIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function spdrDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2,'0')}-${mon}-${d.getUTCFullYear()}`;
}

async function buildHistoricalXlsx(n, { tonnesBase = 900, aumBase = 90e9, navBase = 78 } = {}) {
  const rows = [];
  for (let i = n - 1; i >= 0; i--) {
    const iso = daysAgoIso(i);
    rows.push({ date: spdrDate(iso), nav: navBase + i * 0.01, tonnes: tonnesBase + i, aum: aumBase + i * 1e6 });
  }
  return buildSyntheticXlsx(rows);
}

describe('seed-gold-etf-flows: parseGldArchiveXlsx', () => {
  it('parses the real SPDR column layout (Date=1, Close=2, Tonnes=10, AUM=11)', async () => {
    const buf = await buildHistoricalXlsx(15);
    const rows = await parseGldArchiveXlsx(buf);
    assert.equal(rows.length, 15);
    // Sorted ascending
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].date <= rows[i].date);
    // Column mapping sanity
    assert.ok(rows[0].tonnes > 0);
    assert.ok(rows[0].aum > 0);
    assert.ok(rows[0].nav > 0);
  });

  it('accepts "DD-MMM-YYYY" dates (real SPDR format)', async () => {
    const buf = await buildSyntheticXlsx(
      Array.from({ length: 11 }, (_, i) => ({ date: `${String(i + 1).padStart(2,'0')}-Nov-2004`, tonnes: 8 + i * 0.1, aum: 1e8, nav: 44 })),
    );
    const rows = await parseGldArchiveXlsx(buf);
    assert.ok(rows.length >= 11);
    assert.ok(rows[0].date.startsWith('2004-11-'), `got ${rows[0].date}`);
  });

  it('skips rows with zero or negative tonnage', async () => {
    const good = Array.from({ length: 11 }, (_, i) => ({ date: spdrDate(daysAgoIso(i + 3)), tonnes: 900 + i }));
    const bad = [
      { date: spdrDate(daysAgoIso(1)), tonnes: 0 },
      { date: spdrDate(daysAgoIso(2)), tonnes: -5 },
    ];
    const buf = await buildSyntheticXlsx([...good, ...bad]);
    const rows = await parseGldArchiveXlsx(buf);
    assert.equal(rows.length, 11, 'zero/negative tonnage rows dropped');
  });

  it('returns empty when the data sheet has fewer than 10 rows (too little to trust)', async () => {
    const buf = await buildSyntheticXlsx([
      { date: '10-Apr-2026', tonnes: 905.20 },
      { date: '09-Apr-2026', tonnes: 904.10 },
    ]);
    const rows = await parseGldArchiveXlsx(buf);
    assert.equal(rows.length, 0);
  });
});

describe('seed-gold-etf-flows: computeFlows', () => {
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
    assert.equal(flows.sparkline90d[0], 800 + 170);
    assert.equal(flows.sparkline90d[89], 1059);
  });

  it('handles short histories (<252 days) without crashing', () => {
    const history = buildHistory(i => 800 + i).slice(0, 10);
    const flows = computeFlows(history);
    assert.ok(flows !== null);
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
