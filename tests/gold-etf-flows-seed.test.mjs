import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';

import {
  MAX_GLD_ARCHIVE_BYTES,
  MAX_GLD_XLSX_EXPANDED_BYTES,
  assertXlsxExpansionWithin,
  computeFlows,
  parseGldArchiveXlsx,
  readGldArchive,
} from '../scripts/seed-gold-etf-flows.mjs';

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

// A one-entry ZIP whose central directory declares `declaredSize` bytes once
// inflated. `method` 0 stores `data`; 8 deflates it. `entryCount` is what the
// end-of-central-directory record claims.
function buildZip(data, { declaredSize = data.length, method = 0, entryCount = 1, patchEnd = () => {} } = {}) {
  const body = method === 8 ? deflateRawSync(data) : data;
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  patchEnd(end);
  return Buffer.concat([local, name, body, central, name, end]);
}

describe('seed-gold-etf-flows: archive size limits', () => {
  it('rejects an archive whose entries declare more than the expansion cap, before ExcelJS inflates it', async () => {
    const started = performance.now();
    await assert.rejects(
      parseGldArchiveXlsx(buildZip(Buffer.from('<x/>'), { declaredSize: 1_000_000_000 })),
      /expands past/,
    );
    assert.ok(performance.now() - started < 250);
  });

  it('rejects an entry that inflates past the cap even when it declares a small size', () => {
    const bomb = buildZip(Buffer.alloc(4 * 1024 * 1024), { declaredSize: 100, method: 8 });
    assert.throws(() => assertXlsxExpansionWithin(bomb, 1024 * 1024), /expands past/);
  });

  it('checks every central-directory record, not just the count the archive claims', () => {
    // JSZip walks the records by signature and ignores this count.
    const bomb = (entryCount) => buildZip(Buffer.alloc(4 * 1024 * 1024), { declaredSize: 100, method: 8, entryCount });
    assert.throws(() => assertXlsxExpansionWithin(bomb(0), 1024 * 1024));
    assert.throws(() => assertXlsxExpansionWithin(bomb(2), 1024 * 1024));
    const small = (entryCount) => buildZip(Buffer.from('<x/>'), { entryCount });
    assert.throws(() => assertXlsxExpansionWithin(small(0)), /1 central directory records, expected 0/);
    assert.doesNotThrow(() => assertXlsxExpansionWithin(small(1)));
  });

  it('refuses a directory JSZip would locate differently from the end record', () => {
    // A MAX-valued field sends JSZip down its ZIP64 branch, which reads a
    // different directory; a size that does not reach the end record makes it
    // shift every offset by the gap.
    const small = (patchEnd) => buildZip(Buffer.from('<x/>'), { patchEnd });
    assert.throws(() => assertXlsxExpansionWithin(small((end) => end.writeUInt16LE(0xFFFF, 4))), /ZIP64/);
    assert.throws(() => assertXlsxExpansionWithin(small((end) => end.writeUInt32LE(end.readUInt32LE(12) + 4, 12))), /does not end at/);
    assert.throws(() => assertXlsxExpansionWithin(Buffer.concat([Buffer.alloc(16), small()])), /not a readable XLSX/);
  });

  it('accepts a real workbook', async () => {
    const buf = await buildHistoricalXlsx(40);
    assert.doesNotThrow(() => assertXlsxExpansionWithin(buf, MAX_GLD_XLSX_EXPANDED_BYTES));
    assert.equal((await parseGldArchiveXlsx(buf)).length, 40);
  });

  it('stops reading an endless archive download at the byte cap', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1 << 20);
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (pulled >= 64 * chunk.length) return controller.close();
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
      // No read-ahead: each chunk is pulled only when the reader asks for it.
    }, { highWaterMark: 0 }));
    await assert.rejects(readGldArchive(response), /RESPONSE_TOO_LARGE/);
    assert.ok(pulled <= MAX_GLD_ARCHIVE_BYTES + chunk.length, `pulled ${pulled} bytes`);
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
