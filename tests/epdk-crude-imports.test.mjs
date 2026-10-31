/**
 * Turkey files no partner-level crude imports to UN Comtrade, so its Gulf
 * crude share comes from the monthly petroleum reports of EPDK, its energy
 * market regulator (scripts/_epdk-crude-imports.mjs). Word reports (to 2025)
 * carry the month's table; the 2026 Excel annexes carry a January-to-month
 * cumulative table, so a month is a difference of two of them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

import {
  assertZipExpansionWithin,
  crudeImportsFromTable,
  epdkImporterColumns,
  fetchEpdkCrudeImports,
  isEpdkUrl,
  iso2FromTurkishName,
  monthFromLabel,
  monthlyCrudeByOrigin,
  parseEpdkListing,
  parseTonnes,
  tablesFromDocx,
  tablesFromXlsx,
} from '../scripts/_epdk-crude-imports.mjs';
import { CRUDE_ORIGIN_GULF_ISO2, crudeImportOriginNationalSection, epdkFetch } from '../scripts/seed-oil-trade-series.mjs';

const HEADER = ['Ülke', 'Ham Petrol', 'Motorin Türleri', 'Toplam', 'Pay (%)'];

// Word splits text into runs at arbitrary points ("202" + "5").
const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (...runs) => `<w:p>${runs.map(run).join('')}</w:p>`;
const wordTable = (rows) => `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${para(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
async function docx(body) {
  const zip = new JSZip();
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function xlsx(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Hand-written SpreadsheetML, for the parts of the format ExcelJS never
// writes on its own (inline strings, merges, self-closing rows, sheet order).
async function rawXlsx({ sheets, sharedStrings = [] }) {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns:r="r"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="${s.target}"/>`).join('')}</Relationships>`);
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0"?><sst>${sharedStrings.map((s) => `<si>${s}</si>`).join('')}</sst>`);
  for (const s of sheets) zip.file(`xl/${s.target.replace(/^\/?xl\//, '')}`, `<?xml version="1.0"?><worksheet><sheetData>${s.rows}</sheetData>${s.tail ?? ''}</worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const DEC_2025_DOCX = () => docx([
  para('Tablo 2', '.1.1. Aralık 202', '5 Dönemi Ülkelere Göre İthalat (ton)'),
  wordTable([
    HEADER,
    ['Rusya Federasyonu', '985.525,78', '941.448,35', '1.926.974,13', '47,55'],
    ['Irak', '852.937,77', '0,00', '852.937,77', '18,79'],
    ['Mısır', '', '152.176,66', '152.176,66', '3,35'],
    ['Suudi Arabistan', '127.220,07', '0,00', '127.220,07', '2,86'],
    ['Toplam', '1.965.683,62', '1.093.625,01', '3.059.308,63', '100'],
  ]),
  para('Tablo 2.1.2. Ocak-Aralık 2025 Dönemi Ülkelere Göre İthalat (ton)'),
  wordTable([HEADER, ['Rusya Federasyonu', '15.229.330,93', '0', '15.229.330,93', '100'], ['Toplam', '15.229.330,93', '0', '15.229.330,93', '100']]),
  para('Tablo 2.2.1. Aralık 2025 Dönemi Ülkelere Göre İhracat (ton)'),
  wordTable([HEADER, ['Irak', '0', '5', '5', '100'], ['Toplam', '0', '5', '5', '100']]),
].join(''));

const cumulativeXlsx = (endMonth, rows) => xlsx({
  'Tablo2&6': [
    [],
    [null, `Tablo 2:  Ülkelere Göre Kümülatif Petrol İthalatı (Ocak-${endMonth} 2026)`],
    [],
    [null, ...HEADER],
    ...rows.map((r) => [null, ...r]),
  ],
});
const JAN_2026_XLSX = () => xlsx({
  'Tablo2&6': [[null, 'Tablo 2: Ocak 2026 Dönemi Ülkelere Göre Petrol İthalatı'], [null, ...HEADER],
    [null, 'Rusya Federasyonu', 1000, 0, 1000, 50], [null, 'Irak', 600, 0, 600, 30], [null, 'Suudi Arabistan', 400, 0, 400, 20], [null, 'Toplam', 2000, 0, 2000, 100]],
});
const FEB_2026_XLSX = () => cumulativeXlsx('Şubat', [
  ['Rusya Federasyonu', 1700, 0, 1700, 0], ['Irak', 1300, 0, 1300, 0], ['Suudi Arabistan', 400, 0, 400, 0], ['Toplam', 3400, 0, 3400, 100],
]);

describe('EPDK listing', () => {
  it('reads the report month from the label variants EPDK uses', () => {
    assert.equal(monthFromLabel('2026 Yılı Petrol Piyasası Ağustos Ayı Sektör Raporu'), '2026-08');
    assert.equal(monthFromLabel('Petrol Piyasası Sektör Raporu Ocak 2024'), '2024-01');
    assert.equal(monthFromLabel('2024_Kasım_Petrol Piyasası Sektör Raporu'), '2024-11');
    assert.equal(monthFromLabel('2025 Yılı Petrol Piyasası Nisan_Ayı Sektör Raporu_Rev'), '2025-04');
    assert.equal(monthFromLabel('2025 Yılı Petrol Piyasası Eyl&#252;l Ayı'.replace('&#252;', 'ü')), '2025-09');
    assert.equal(monthFromLabel('2026'), null);
    assert.equal(monthFromLabel('Petrol Piyasası Resmi İstatistikleri'), null);
  });

  it('lists each month with its downloads and their kinds, skipping year headers', () => {
    const html = `
      <ul><li class="accordion-pop"><a data-toggle="collapse" data-target="#y">2026 &nbsp;</a><div><ul>
        <li class="accordion-pop"><a data-toggle="collapse" data-target="#a">2026 Yılı Petrol Piyasası Ocak Ayı Sekt&#246;r Raporu &nbsp;</a> <br />
          <a href="/Detay/DownloadDocument?id=O3+H6EouTaI=" title="x"><img src ='/Content/img/pdf.png' /></a>
          <a href="/Detay/DownloadDocument?id=cTHWx7K9DI8=" title="Ocak 2026"><img src ='/Content/img/excel.png' /></a></li>
        <li class="accordion-pop"><a data-toggle="collapse" data-target="#b">2025 Yılı Petrol Piyasası Aralık Ayı Sekt&#246;r Raporu</a>
          <a href="/Detay/DownloadDocument?id=z4dR8e3MWFA=" title="y"><img src ='/Content/img/word.png' /></a></li>
      </ul></div></li></ul>`;
    assert.deepEqual(parseEpdkListing(html), [
      { month: '2026-01', label: '2026 Yılı Petrol Piyasası Ocak Ayı Sektör Raporu', documents: [
        { url: 'https://www.epdk.gov.tr/Detay/DownloadDocument?id=O3+H6EouTaI=', kind: 'pdf' },
        { url: 'https://www.epdk.gov.tr/Detay/DownloadDocument?id=cTHWx7K9DI8=', kind: 'excel' },
      ] },
      { month: '2025-12', label: '2025 Yılı Petrol Piyasası Aralık Ayı Sektör Raporu', documents: [
        { url: 'https://www.epdk.gov.tr/Detay/DownloadDocument?id=z4dR8e3MWFA=', kind: 'word' },
      ] },
    ]);
  });

  it('drops download links that leave the EPDK origin (absolute, protocol-relative, plain http)', () => {
    const html = `
      <li class="accordion-pop"><a data-toggle="collapse" data-target="#a">2026 Yılı Petrol Piyasası Ocak Ayı Sektör Raporu</a>
        <a href="https://internal-host/DownloadDocument?id=1"><img src ='/Content/img/excel.png' /></a>
        <a href="//internal-host/DownloadDocument?id=2"><img src ='/Content/img/excel.png' /></a>
        <a href="http://169.254.169.254/latest/meta-data/?DownloadDocument?id=5"><img src ='/Content/img/excel.png' /></a>
        <a href="http://www.epdk.gov.tr/Detay/DownloadDocument?id=6"><img src ='/Content/img/excel.png' /></a>
        <a href="/Detay/DownloadDocument?id=ok"><img src ='/Content/img/word.png' /></a></li>`;
    assert.deepEqual(parseEpdkListing(html)[0].documents, [{ url: 'https://www.epdk.gov.tr/Detay/DownloadDocument?id=ok', kind: 'word' }]);
  });

  it('isEpdkUrl accepts only https://www.epdk.gov.tr', () => {
    assert.equal(isEpdkUrl('https://www.epdk.gov.tr/Detay/DownloadDocument?id=1'), true);
    for (const url of ['http://www.epdk.gov.tr/x', 'https://epdk.gov.tr/x', 'https://www.epdk.gov.tr.evil.test/x', 'https://www.epdk.gov.tr:8443/x', 'not a url']) {
      assert.equal(isEpdkUrl(url), false, url);
    }
  });
});

describe('epdkFetch', () => {
  it('refuses an off-origin URL before any request, and never follows redirects', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), redirect: init?.redirect });
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    };
    await assert.rejects(epdkFetch('http://169.254.169.254/latest/meta-data/', Date.now() + 60_000), /off-origin/);
    assert.equal(calls.length, 0);
    const buf = await epdkFetch('https://www.epdk.gov.tr/Detay/DownloadDocument?id=1', Date.now() + 60_000);
    assert.equal(buf.length, 2);
    assert.deepEqual(calls, [{ url: 'https://www.epdk.gov.tr/Detay/DownloadDocument?id=1', redirect: 'error' }]);
  });

  it('refuses a document over the byte cap, by declared length or while streaming', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const url = 'https://www.epdk.gov.tr/Detay/DownloadDocument?id=1';
    let pulled = 0;
    const body = (chunks) => new ReadableStream({
      pull(controller) {
        if (pulled >= chunks) return controller.close();
        pulled++;
        controller.enqueue(new Uint8Array(64));
      },
    }, { highWaterMark: 0 });
    globalThis.fetch = async () => new Response(body(100), { status: 200, headers: { 'content-length': '6400' } });
    await assert.rejects(epdkFetch(url, Date.now() + 60_000, 1000), /too large/);
    assert.equal(pulled, 0);
    globalThis.fetch = async () => new Response(body(100), { status: 200 });
    await assert.rejects(epdkFetch(url, Date.now() + 60_000, 1000), /too large/);
    assert.ok(pulled < 100, `read ${pulled} chunks`);
    pulled = 0;
    globalThis.fetch = async () => new Response(body(10), { status: 200 });
    assert.equal((await epdkFetch(url, Date.now() + 60_000, 1000)).length, 640);
  });
});

describe('assertZipExpansionWithin', () => {
  const padded = async (bytes) => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    zip.file('word/media/pad.bin', Buffer.alloc(bytes));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  };

  it('passes an archive under the cap and refuses one that inflates past it', async () => {
    const buf = await padded(2_000_000);
    assert.ok(buf.length < 10_000, 'zeros compress to a small archive');
    assertZipExpansionWithin(buf, 3_000_000);
    assert.throws(() => assertZipExpansionWithin(buf, 1_000_000), /expands past/);
  });

  it('counts real inflated bytes, not the sizes the archive declares', async () => {
    const buf = Buffer.from(await padded(2_000_000));
    // Rewrite every declared uncompressed size to 1 byte.
    for (let i = 0; i + 4 <= buf.length; i++) {
      const sig = buf.readUInt32LE(i);
      if (sig === 0x04034b50) buf.writeUInt32LE(1, i + 22);
      if (sig === 0x02014b50) buf.writeUInt32LE(1, i + 24);
    }
    assert.throws(() => assertZipExpansionWithin(buf, 1_000_000), /expands past/);
  });

  it('measures every central-directory record, whatever entry count the archive declares', async () => {
    const buf = Buffer.from(await padded(2_000_000));
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    buf.writeUInt16LE(1, eocd + 8);
    buf.writeUInt16LE(1, eocd + 10);
    assert.throws(() => assertZipExpansionWithin(buf, 1_000_000), /expands past/);
  });

  it('refuses a buffer that is not a readable ZIP', () => {
    assert.throws(() => assertZipExpansionWithin(Buffer.from('PK not really a zip'), 1_000_000), /ZIP/);
  });
});

describe('EPDK crude import tables', () => {
  it('parses a Word document with unclosed tags in linear time', async () => {
    const doc = await docx(`${para('Tablo 2.1.1. Aralık 2025')}${'<w:tbl><w:tr><w:tc><w:p>'.repeat(40_000)}`);
    const started = Date.now();
    assert.deepEqual(await tablesFromDocx(doc), []);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  });

  it('parses Turkish-formatted tonnes; a blank cell is zero; text is not a number', () => {
    assert.equal(parseTonnes('2.923.092,68'), 2923092.68);
    assert.equal(parseTonnes('0,00'), 0);
    assert.equal(parseTonnes(''), 0);
    assert.equal(parseTonnes(1005833.653), 1005833.653);
    assert.equal(parseTonnes('n/a'), null);
  });

  it('reads the monthly Word table even when a run splits the year', async () => {
    const tables = await tablesFromDocx(await DEC_2025_DOCX());
    const entries = tables.map(crudeImportsFromTable).filter(Boolean);
    assert.equal(entries.length, 2, 'the imports tables only, not exports');
    const [month, cumulative] = entries;
    assert.deepEqual({ ...month, rows: undefined }, { month: '2025-12', cumulative: false, totalT: 1965683.62, rows: undefined });
    assert.deepEqual(month.rows.find((r) => r.name === 'Mısır'), { name: 'Mısır', tonnes: 0 });
    assert.equal(cumulative.cumulative, true);
    assert.equal(cumulative.month, '2025-12');
  });

  it('reads the cumulative Excel Tablo 2', async () => {
    const [entry] = (await tablesFromXlsx(await FEB_2026_XLSX())).map(crudeImportsFromTable).filter(Boolean);
    assert.equal(entry.month, '2026-02');
    assert.equal(entry.cumulative, true);
    assert.equal(entry.totalT, 3400);
    const janCumulative = { title: 'Tablo 2: Ülkelere Göre Kümülatif Petrol İthalatı (Ocak 2026)', rows: [HEADER, ['Irak', 5, 0, 5, 100], ['Toplam', 5, 0, 5, 100]] };
    assert.deepEqual({ ...crudeImportsFromTable(janCumulative), rows: undefined }, { month: '2026-01', cumulative: true, totalT: 5, rows: undefined });
  });

  it('reads cell values the way the annexes store them', async () => {
    const buf = await rawXlsx({
      sharedStrings: [
        '<t>Tablo 2: Ocak 2026 Dönemi Ülkelere Göre Petrol İthalatı</t>',
        '<t>Ülke</t>',
        '<r><t>Ham </t></r><r><rPr><b/></rPr><t xml:space="preserve">Petrol</t></r>',
        '<t>Irak &amp; Körfez</t>',
      ],
      sheets: [
        // Workbook order, not file names, orders the sheets: this one is
        // listed first but stored as sheet2.xml.
        {
          name: 'Tablo 1',
          target: 'worksheets/sheet2.xml',
          rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>Tablo 1: Özet</t></is></c></row>'
            + '<row r="2"><c r="A2" t="inlineStr"><is><r><t>Ham </t></r><r><t>Petrol</t></r></is></c><c r="B2"><v>7</v></c></row>',
        },
        {
          name: 'Tablo 2',
          target: '/xl/worksheets/sheet1.xml',
          rows: [
            '<row r="1" spans="1:3"/>',
            '<row r="2"><c r="B2" t="s"><v>0</v></c></row>',
            '<row r="3"><c r="B3" t="s"><v>1</v></c><c r="C3" t="s"><v>2</v></c><c r="D3" s="4"/></row>',
            '<row r="4"><c r="B4" t="s"><v>3</v></c><c r="C4"><f>SUM(X1:X2)</f><v>600.5</v></c></row>',
            '<row r="5"><c r="B5" t="str"><f>"Top"&amp;"lam"</f><v>Toplam</v></c><c r="C5" s="2"><v>600.5</v></c></row>',
          ].join(''),
          tail: '<mergeCells count="1"><mergeCell ref="B4:B5"/></mergeCells>',
        },
      ],
    });
    // A merged cell reads as its range's top-left value, an empty styled cell
    // as nothing, and a formula as its cached result.
    // Inline strings join their runs like shared ones.
    const tables = await tablesFromXlsx(buf);
    assert.deepEqual(tables.map((t) => t.title), ['Tablo 1: Özet', 'Tablo 2: Ocak 2026 Dönemi Ülkelere Göre Petrol İthalatı']);
    assert.deepEqual(tables[0].rows, [['Ham Petrol', 7]]);
    assert.deepEqual(tables[1].rows.map((r) => Array.from(r, (c) => c ?? '')), [
      ['', 'Ülke', 'Ham Petrol'],
      ['', 'Irak & Körfez', 600.5],
      ['', 'Irak & Körfez', 600.5],
    ]);
  });

  it('parses a real 2026 Excel annex inside a 128 MB heap', () => {
    // The 2026-08 annex: ~80k cells and ~2,100 merged ranges in 514 KB.
    // ExcelJS could not load it in a 256 MB heap; with the bundle's 8 GB heap
    // ceiling it pushed the 1 GB Railway container into a SIGKILL (2026-10-29).
    const file = fileURLToPath(new URL('./fixtures/epdk-2026-08-annex.xlsx', import.meta.url));
    const moduleUrl = new URL('../scripts/_epdk-crude-imports.mjs', import.meta.url).href;
    const script = `import { readFileSync } from 'node:fs';
      const m = await import(${JSON.stringify(moduleUrl)});
      const tables = await m.tablesFromXlsx(readFileSync(${JSON.stringify(file)}));
      process.stdout.write(JSON.stringify(tables.map(m.crudeImportsFromTable).filter(Boolean)));`;
    const child = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(child.status, 0, child.stderr.slice(-400));
    const entries = JSON.parse(child.stdout);
    assert.deepEqual(entries.map((e) => ({ month: e.month, cumulative: e.cumulative, totalT: e.totalT, rows: e.rows.length })), [
      { month: '2026-08', cumulative: true, totalT: 21744885.293, rows: 43 },
    ]);
  });

  it('names the origins EPDK uses, including every Gulf exporter', () => {
    const names = {
      'Rusya Federasyonu': 'RU', Irak: 'IQ', 'Suudi Arabistan': 'SA', 'Birleşik Arap Emirlikleri': 'AE', İran: 'IR',
      Kuveyt: 'KW', Katar: 'QA', Bahreyn: 'BH', 'A.B.D.': 'US', İngiltere: 'GB', Kazakistan: 'KZ', Guyana: 'GY', Nijerya: 'NG',
    };
    for (const [name, iso2] of Object.entries(names)) assert.equal(iso2FromTurkishName(name), iso2, name);
    assert.equal(iso2FromTurkishName('Atlantis'), null);
  });
});

describe('EPDK monthly crude by origin', () => {
  const entry = (month, cumulative, rows) => ({ month, cumulative, totalT: rows.reduce((s, [, t]) => s + t, 0), rows: rows.map(([name, tonnes]) => ({ name, tonnes })) });

  it('takes a month from its own table, else from cumulative differences; January cumulative is the month', () => {
    const { months } = monthlyCrudeByOrigin([
      entry('2025-12', false, [['Irak', 800], ['Rusya Federasyonu', 1200]]),
      entry('2026-02', true, [['Irak', 1300], ['Suudi Arabistan', 400], ['Rusya Federasyonu', 1700]]),
      entry('2026-01', true, [['Irak', 600], ['Suudi Arabistan', 400], ['Rusya Federasyonu', 1000]]),
    ]);
    assert.deepEqual(months.get('2025-12'), { totalT: 2000, byIso2: { IQ: 800, RU: 1200 } });
    assert.deepEqual(months.get('2026-01'), { totalT: 2000, byIso2: { IQ: 600, SA: 400, RU: 1000 } });
    assert.deepEqual(months.get('2026-02'), { totalT: 1400, byIso2: { IQ: 700, RU: 700 } });
  });

  it('voids a month with an unrecognised origin name, and reports the name', () => {
    const { months, unmatched } = monthlyCrudeByOrigin([entry('2025-12', false, [['Irak', 800], ['Atlantis', 100]])]);
    assert.equal(months.has('2025-12'), false, 'an unnamed origin could be a Gulf exporter');
    assert.deepEqual(unmatched, ['Atlantis']);
  });

  it('voids a month whose rows do not add up to the total, or whose difference goes negative', () => {
    const bad = { ...entry('2025-12', false, [['Irak', 800]]), totalT: 1000 };
    assert.equal(monthlyCrudeByOrigin([bad]).months.has('2025-12'), false);
    const { months } = monthlyCrudeByOrigin([
      entry('2026-01', true, [['Irak', 600]]),
      entry('2026-02', true, [['Irak', 500], ['Rusya Federasyonu', 400]]),
    ]);
    assert.equal(months.has('2026-02'), false, 'a revised January above February cumulative is not a month');
  });

  it('rechecks a derived month against its own total: two tables in tolerance can difference out of it', () => {
    // Rows 1,004,000 vs total 1,000,000 and 1,996,000 vs 2,000,000 each pass
    // 0.5%; the derived month's rows (992,000) miss its total (1,000,000) by 0.8%.
    const table = (month, total, rows) => ({ month, cumulative: true, totalT: total, rows: rows.map(([name, tonnes]) => ({ name, tonnes })) });
    const { months } = monthlyCrudeByOrigin([
      table('2026-01', 1_000_000, [['Irak', 504_000], ['Rusya Federasyonu', 500_000]]),
      table('2026-02', 2_000_000, [['Irak', 996_000], ['Rusya Federasyonu', 1_000_000]]),
    ]);
    assert.equal(months.has('2026-01'), true);
    assert.equal(months.has('2026-02'), false);
  });

  it('a cumulative month without the previous month is absent, never the cumulative total', () => {
    const { months } = monthlyCrudeByOrigin([entry('2026-03', true, [['Irak', 900]])]);
    assert.equal(months.has('2026-03'), false);
  });

  it('aligns World, Gulf and bypass-exporter tonnes to the requested months', () => {
    const byMonth = new Map([['2026-01', { totalT: 2000, byIso2: { IQ: 600, SA: 400, KW: 50, RU: 950 } }]]);
    assert.deepEqual(epdkImporterColumns(byMonth, ['2025-12', '2026-01'], CRUDE_ORIGIN_GULF_ISO2, ['SA', 'AE', 'IQ']), {
      worldT: [null, 2000],
      gulfT: [null, 1050],
      bypassPartnersT: { SA: [null, 400], AE: [null, 0], IQ: [null, 600] },
    });
  });
});

describe('EPDK fetch', () => {
  const LISTING = `
    <li class="accordion-pop"><a data-toggle="collapse">2026 Yılı Petrol Piyasası Şubat Ayı Sektör Raporu</a>
      <a href="/Detay/DownloadDocument?id=febpdf"><img src='/Content/img/pdf.png' /></a>
      <a href="/Detay/DownloadDocument?id=febxlsx"><img src='/Content/img/excel.png' /></a></li>
    <li class="accordion-pop"><a data-toggle="collapse">2026 Yılı Petrol Piyasası Ocak Ayı Sektör Raporu</a>
      <a href="/Detay/DownloadDocument?id=janxlsx"><img src='/Content/img/excel.png' /></a></li>
    <li class="accordion-pop"><a data-toggle="collapse">2025 Yılı Petrol Piyasası Aralık Ayı Sektör Raporu</a>
      <a href="/Detay/DownloadDocument?id=decdocx"><img src='/Content/img/word.png' /></a>
      <a href="/Detay/DownloadDocument?id=decannex"><img src='/Content/img/excel.png' /></a></li>
    <li class="accordion-pop"><a data-toggle="collapse">2024 Yılı Petrol Piyasası Aralık Ayı Sektör Raporu</a>
      <a href="/Detay/DownloadDocument?id=old"><img src='/Content/img/word.png' /></a></li>`;

  it('downloads only wanted months, Word before Excel, never PDF', async () => {
    const files = { decdocx: await DEC_2025_DOCX(), janxlsx: await JAN_2026_XLSX(), febxlsx: await FEB_2026_XLSX() };
    const fetched = [];
    const { months, unmatched, failedMonths } = await fetchEpdkCrudeImports({
      wantedMonths: ['2025-12', '2026-01', '2026-02', '2026-03'],
      fetchText: async () => LISTING,
      fetchBuffer: async (url) => {
        const id = url.split('id=')[1];
        fetched.push(id);
        if (!files[id]) throw new Error(`unexpected ${id}`);
        return files[id];
      },
    });
    assert.deepEqual(fetched, ['febxlsx', 'janxlsx', 'decdocx']);
    assert.deepEqual(unmatched, []);
    assert.deepEqual(failedMonths, []);
    assert.deepEqual([...months.keys()].sort(), ['2025-12', '2026-01', '2026-02']);
    assert.deepEqual(months.get('2026-02'), { totalT: 1400, byIso2: { IQ: 700, RU: 700 } });
    assert.equal(months.get('2025-12').byIso2.SA, 127220.07);
  });

  it('a month whose documents all fail is a failed month; one not yet published is not', async () => {
    const { months, failedMonths } = await fetchEpdkCrudeImports({
      wantedMonths: ['2025-12'],
      fetchText: async () => LISTING,
      fetchBuffer: async (url) => {
        if (url.endsWith('decdocx')) throw new Error('socket hang up');
        return Buffer.from('%PDF-1.4');
      },
    });
    assert.equal(months.size, 0);
    assert.deepEqual(failedMonths, ['2025-12']);
  });

  it('stops downloading at the deadline and reports the remaining listed months as failed', async () => {
    let downloads = 0;
    const { months, failedMonths } = await fetchEpdkCrudeImports({
      wantedMonths: ['2025-12', '2026-01', '2026-02', '2027-01'],
      fetchText: async () => LISTING,
      fetchBuffer: async () => { downloads++; return Buffer.alloc(0); },
      deadlineAtMs: Date.now() - 1,
    });
    assert.equal(downloads, 0);
    assert.equal(months.size, 0);
    assert.deepEqual(failedMonths, ['2025-12', '2026-01', '2026-02']);
  });

  it('a document that inflates past the cap is a failure, never parsed', async () => {
    const zip = await JSZip.loadAsync(await DEC_2025_DOCX());
    zip.file('word/media/pad.bin', Buffer.alloc(2_000_000));
    const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const logs = [];
    const { months, failedMonths } = await fetchEpdkCrudeImports({
      wantedMonths: ['2025-12'],
      fetchText: async () => LISTING,
      fetchBuffer: async (url) => (url.endsWith('decdocx') ? bomb : Buffer.from('%PDF-1.4')),
      log: (line) => logs.push(line),
      maxInflatedBytes: 1_000_000,
    });
    assert.equal(months.size, 0);
    assert.deepEqual(failedMonths, ['2025-12']);
    assert.match(logs.join('\n'), /expands past/);
  });

  it('checks the deadline before each document, not only each month', async () => {
    const fetched = [];
    const { months, failedMonths } = await fetchEpdkCrudeImports({
      wantedMonths: ['2025-12'],
      fetchText: async () => LISTING,
      fetchBuffer: async (url) => {
        fetched.push(url.split('id=')[1]);
        await new Promise((resolve) => setTimeout(resolve, 80));
        return Buffer.from('%PDF-1.4');
      },
      deadlineAtMs: Date.now() + 40,
    });
    assert.deepEqual(fetched, ['decdocx']);
    assert.equal(months.size, 0);
    assert.deepEqual(failedMonths, ['2025-12']);
  });

  it('a listing with no report months throws, so the seeder keeps its previous section', async () => {
    await assert.rejects(fetchEpdkCrudeImports({ wantedMonths: ['2026-01'], fetchText: async () => '<html></html>', fetchBuffer: async () => Buffer.alloc(0) }), /no report months/);
  });
});

describe('crudeImportOriginNational section', () => {
  const months = ['2026-01', '2026-02'];
  const byMonth = new Map([['2026-02', { totalT: 1400, byIso2: { IQ: 700, RU: 700 } }]]);

  it('publishes Turkey in tonnes with its source', () => {
    const s = crudeImportOriginNationalSection({ months, byMonth, fetchedAt: '2026-10-28T00:00:00.000Z' });
    assert.equal(s.status, 'ok');
    assert.equal(s.unit, 'tonnes');
    assert.deepEqual(s.importers.TR, { source: 'EPDK', worldT: [null, 1400], gulfT: [null, 700], bypassPartnersT: { SA: [null, 0], AE: [null, 0], IQ: [null, 700] } });
  });

  it('a fetch that lost listed months fills them from the previous section and is carried forward', () => {
    const wider = ['2026-01', '2026-02', '2026-03'];
    const previous = crudeImportOriginNationalSection({
      months: ['2025-12', ...wider.slice(0, 2)],
      byMonth: new Map([['2026-01', { totalT: 2000, byIso2: { IQ: 600, SA: 400, RU: 1000 } }], ['2026-02', { totalT: 1400, byIso2: { IQ: 700, RU: 700 } }]]),
      fetchedAt: '2026-10-21T00:00:00.000Z',
    });
    const fresh = new Map([['2026-02', { totalT: 1400, byIso2: { IQ: 700, RU: 700 } }]]);
    const s = crudeImportOriginNationalSection({ months: wider, byMonth: fresh, failedMonths: ['2026-01', '2026-03', '2025-01'], fetchedAt: '2026-10-28T00:00:00.000Z', previous });
    assert.equal(s.status, 'unavailable');
    assert.equal(s.carriedForward, true, 'the reader then withholds current flows');
    assert.equal(s.fetchedAt, '2026-10-21T00:00:00.000Z');
    assert.deepEqual(s.failedMonths, ['2026-01', '2026-03']);
    assert.deepEqual(s.importers.TR.worldT, [2000, 1400, null], 'January from the previous run, March has no earlier value');
    assert.deepEqual(s.importers.TR.bypassPartnersT.SA, [400, 0, null]);

    const first = crudeImportOriginNationalSection({ months: wider, byMonth: fresh, failedMonths: ['2026-03'], fetchedAt: '2026-10-28T00:00:00.000Z' });
    assert.equal(first.carriedForward, true, 'a first run that lost months is not a clean refresh either');
    assert.deepEqual(first.importers.TR.worldT, [null, 1400, null]);
  });

  it('a failed or empty fetch carries the previous section forward', () => {
    const previous = crudeImportOriginNationalSection({ months, byMonth, fetchedAt: '2026-10-21T00:00:00.000Z' });
    for (const args of [{ error: new Error('timeout') }, { byMonth: new Map() }]) {
      const s = crudeImportOriginNationalSection({ months, fetchedAt: '2026-10-28T00:00:00.000Z', previous, ...args });
      assert.equal(s.status, 'unavailable');
      assert.equal(s.carriedForward, true);
      assert.equal(s.fetchedAt, '2026-10-21T00:00:00.000Z');
      assert.deepEqual(s.importers.TR, previous.importers.TR);
    }
    assert.deepEqual(crudeImportOriginNationalSection({ months, error: new Error('x'), fetchedAt: 'now' }).importers, {});
  });
});
