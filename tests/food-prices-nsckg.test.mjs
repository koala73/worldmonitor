import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collect, parseNsckg, readSst, readXls } from '../scripts/lib/food-prices-adapters/nsckg.mjs';

const [october, september] = JSON.parse(readFileSync(new URL('./fixtures/food-prices/nsckg.json', import.meta.url), 'utf8'));
const dated = (now, offset) => new Date(now.getTime() + offset * 86400000).toISOString().slice(0, 10);

const record = (type, body) => {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(body.length, 2);
  return Buffer.concat([head, body]);
};
const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const wide = value => Buffer.concat([u16(value.length), Buffer.from([1]), Buffer.from(value, 'utf16le')]);

// Writes the real fixture sheets as a BIFF8 workbook inside a version-3 compound file.
function xls(sheets) {
  const strings = [...new Set(sheets.flatMap(sheet => sheet.rows.flat().filter(value => typeof value === 'string' && value)))];
  const sst = [Buffer.concat([u32(strings.length), u32(strings.length)])];
  for (const value of strings.map(wide)) {
    if (sst.at(-1).length + value.length > 8224) sst.push(Buffer.alloc(0));
    sst[sst.length - 1] = Buffer.concat([sst.at(-1), value]);
  }
  const bof = record(0x0809, Buffer.concat([u16(0x0600), u16(5), Buffer.alloc(12)]));
  const bodies = sheets.map(sheet => Buffer.concat([
    record(0x0809, Buffer.concat([u16(0x0600), u16(0x10), Buffer.alloc(12)])),
    ...sheet.rows.flatMap((row, r) => row.flatMap((value, c) => {
      const cell = Buffer.concat([u16(r), u16(c), u16(0)]);
      if (typeof value === 'number') { const n = Buffer.alloc(8); n.writeDoubleLE(value); return [record(0x0203, Buffer.concat([cell, n]))]; }
      return value ? [record(0x00FD, Buffer.concat([cell, u32(strings.indexOf(value))]))] : [];
    })),
    record(0x000A, Buffer.alloc(0)),
  ]));
  const bound = offset => sheets.map((sheet, i) => record(0x0085, Buffer.concat([u32(offset + bodies.slice(0, i).reduce((sum, b) => sum + b.length, 0)), Buffer.from([0, 0, sheet.name.length, 1]), Buffer.from(sheet.name, 'utf16le')])));
  const tail = [...sst.map((body, i) => record(i ? 0x003C : 0x00FC, body)), record(0x000A, Buffer.alloc(0))];
  const raw = Buffer.concat([bof, ...bound(Buffer.concat([bof, ...bound(0), ...tail]).length), ...tail, ...bodies]);
  const stream = Buffer.concat([raw, Buffer.alloc((512 - raw.length % 512) % 512)]);
  const n = stream.length / 512;
  let fatSectors = 1;
  while (n + fatSectors + 1 > fatSectors * 128) fatSectors++;
  const fat = Buffer.alloc(fatSectors * 512, 0xFF);
  for (let i = 0; i < n; i++) fat.writeUInt32LE(i === n - 1 ? 0xFFFFFFFE : i + 1, i * 4);
  for (let i = 0; i < fatSectors; i++) fat.writeUInt32LE(0xFFFFFFFD, (n + i) * 4);
  fat.writeUInt32LE(0xFFFFFFFE, (n + fatSectors) * 4);
  const dir = Buffer.alloc(512);
  const entry = (at, name, type, start, length) => {
    dir.write(name, at, 'utf16le');
    dir.writeUInt16LE((name.length + 1) * 2, at + 64);
    dir[at + 66] = type;
    dir.writeUInt32LE(start, at + 116);
    dir.writeUInt32LE(length, at + 120);
  };
  entry(0, 'Root Entry', 5, 0xFFFFFFFE, 0);
  entry(128, 'Workbook', 2, 0, raw.length);
  const header = Buffer.alloc(512);
  header.writeUInt32LE(0xE011CFD0, 0);
  header.writeUInt32LE(0xE11AB1A1, 4);
  header.writeUInt16LE(0x3E, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xFFFE, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(n + fatSectors, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(0xFFFFFFFE, 60);
  header.writeUInt32LE(0xFFFFFFFE, 68);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fatSectors ? n + i : 0xFFFFFFFF, 76 + i * 4);
  return Buffer.concat([header, stream, fat, dir]);
}

const workbook = xls([{ name: 'октябрь_2026', rows: october }, { name: 'сентябрь_2026', rows: september }]);
const INDEX = 'https://stat.gov.kg/ru/daily-prices/';
const FILE = 'https://stat.gov.kg/media/files/27092140-fcd5-42b3-8b1c-902414df391f.xls';
const context = (now, { ignoreRange = false } = {}) => {
  const warnings = [];
  const requests = [];
  return {
    warnings, requests, now, dated,
    links: html => [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(m => ({ url: new URL(m[1], INDEX).href, text: m[2] })),
    warn: message => warnings.push(message),
    async get(url, { headers = {} } = {}) {
      requests.push(headers.Range ?? url);
      if (url === INDEX) return `<a href="/media/files/c1.xls">ГСМ</a><a href="${new URL(FILE).pathname}" title="Продовольственные товары">Продовольственные товары</a>`;
      assert.equal(url, FILE);
      const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
      return ignoreRange ? Buffer.concat([workbook, Buffer.alloc(1 << 19)]) : workbook.subarray(Number(from), Number(to) + 1);
    },
  };
};

test('NSC KG daily sheet keeps settlement prices per published unit and date', () => {
  const rows = parseNsckg(october);
  const eggs = rows.find(r => r.item === 'Eggs (chicken)' && r.market === 'Bishkek' && r.date === '2026-10-30');
  assert.equal(eggs.price, 141.61);
  assert.equal(eggs.unit, '10 pieces');
  const tea = rows.filter(r => r.item === 'Black tea' && r.market === 'Osh');
  assert.equal(tea.find(r => r.date === '2026-10-30').price, 133.19);
  assert.equal(tea.find(r => r.date === '2026-10-23').price, 131.39);
  assert.equal(tea[0].unit, '100 g');
  assert.ok(rows.some(r => r.item === 'Wheat' && r.market === 'National average'));
  assert.deepEqual([...new Set(rows.map(r => r.item))], ['Wheat', 'Rice (medium-grain)', 'Eggs (chicken)', 'Black tea']);
  assert.equal(new Set(rows.map(r => r.date)).size, 22);
  assert.ok(rows.every(r => r.date.startsWith('2026-10-') && r.price > 0 && r.currency === 'KGS' && r.marketType === 'retail'));
  assert.equal(parseNsckg(september).find(r => r.market === 'Bishkek' && r.date === '2026-09-28').price, 50);
  assert.ok(!parseNsckg(september).some(r => r.market === 'Bishkek' && r.price === 40.46));
});

test('NSC KG parser rejects changed layouts and omits missing prices', () => {
  assert.throws(() => parseNsckg([['Unrelated'], ['sheet']]), /format changed/);
  const shifted = october.map((row, i) => i === 3 ? row.map(value => String(value).replace('October', 'November')) : row);
  assert.throws(() => parseNsckg(shifted), /month mismatch/);
  const blanks = october.map(row => row.map(value => (typeof value !== 'number' ? value : value > 100 ? '-' : value < 30 ? 0 : value)));
  const kept = parseNsckg(blanks);
  assert.ok(kept.length && kept.every(r => r.price >= 30 && r.price <= 100));
});

test('BIFF8 shared strings continue across records with a new width flag', () => {
  const first = Buffer.concat([u32(2), u32(2), u16(3), Buffer.from([1]), Buffer.from('Пш', 'utf16le')]);
  const second = Buffer.concat([Buffer.from([0]), Buffer.from('e'), u16(2), Buffer.from([0]), Buffer.from('kg')]);
  assert.deepEqual(readSst([first, second]), ['Пшe', 'kg']);
});

test('XLS reader decodes the compound workbook through byte ranges', async () => {
  const book = await readXls(async (offset, length) => workbook.subarray(offset, offset + length));
  assert.deepEqual(book.names, ['октябрь_2026', 'сентябрь_2026']);
  const rows = await book.rows('октябрь_2026');
  assert.deepEqual(rows[7].slice(0, 5), october[7].slice(0, 5));
  await assert.rejects(readXls(async () => Buffer.alloc(512)), /legacy XLS/);
});

test('XLS reader rejects cell indices that would densify into an oversized sheet', async () => {
  // Real rows keep the stream above the compound mini-stream cutoff; the extra cells carry hostile indices.
  const sparse = october.map(row => [...row]);
  for (const r of [30000, 65535]) { sparse[r] = []; sparse[r][255] = 1; }
  const crafted = xls([{ name: 'big', rows: sparse }]);
  const book = await readXls(async (offset, length) => crafted.subarray(offset, offset + length));
  await assert.rejects(book.rows('big'), /cell index out of range/);
  const wideRow = october.map(row => [...row]);
  wideRow[0][4000] = 1;
  const tooWide = xls([{ name: 'wide', rows: wideRow }]);
  await assert.rejects((await readXls(async (offset, length) => tooWide.subarray(offset, offset + length))).rows('wide'), /cell index out of range/);
});

test('XLS reader refuses a FAT table that repeats or overstates its sectors', async () => {
  // The DIFAT may name one FAT sector many times; each repeat used to re-read and append a full sector.
  const repeated = Buffer.from(workbook);
  const first = repeated.readUInt32LE(76);
  repeated.writeUInt32LE(109, 44);
  for (let i = 0; i < 109; i++) repeated.writeUInt32LE(first, 76 + i * 4);
  await assert.rejects(readXls(async (offset, length) => repeated.subarray(offset, offset + length)), /compound FAT table/);
  const huge = Buffer.from(workbook);
  huge.writeUInt32LE(5000, 44);
  for (let i = 1; i < 109; i++) huge.writeUInt32LE(i, 76 + i * 4);
  await assert.rejects(readXls(async (offset, length) => huge.subarray(offset, offset + length)), /compound FAT table/);
});

test('NSC KG collect returns the latest day and the same weekday a week earlier', async () => {
  const ctx = context(new Date('2026-10-31T06:00:00Z'));
  const result = await collect(ctx);
  assert.deepEqual([...new Set(result.observations.map(r => r.date))].sort(), ['2026-10-23', '2026-10-30']);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-30' }, { date: '2026-10-23' }]);
  assert.equal(result.reportUrl, FILE);
  assert.ok(ctx.requests.slice(1).every(r => r.startsWith('bytes=')));

  const early = await collect(context(new Date('2026-10-05T12:00:00Z')));
  assert.deepEqual([...new Set(early.observations.map(r => r.date))].sort(), ['2026-09-28', '2026-10-05']);
  assert.equal(early.observations.find(r => r.date === '2026-09-28' && r.market === 'Bishkek' && r.item === 'Wheat').price, 50);

  await assert.rejects(collect(context(new Date('2026-10-31T06:00:00Z'), { ignoreRange: true })), /ignored the byte range/);
});

test('NSC KG collect skips a newly opened month that has no prices yet', async () => {
  const november = october.map((row, i) => i === 0 || i === 3 ? row.map(v => String(v).replace('October', 'November')) : row.map(v => typeof v === 'number' ? '' : v));
  const fresh = xls([{ name: 'ноябрь_2026', rows: november }, { name: 'октябрь_2026', rows: october }]);
  const ctx = context(new Date('2026-11-02T03:00:00Z'));
  const get = ctx.get;
  ctx.get = async (url, options = {}) => {
    if (url !== FILE) return get(url, options);
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    return fresh.subarray(Number(from), Number(to) + 1);
  };
  const result = await collect(ctx);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-30' }, { date: '2026-10-23' }]);
  assert.match(ctx.warnings[0], /ноябрь_2026 unavailable: .*no dated food prices/);
});
