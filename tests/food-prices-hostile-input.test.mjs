// Publisher pages and files are untrusted. Each parser must stay linear on hostile markup and refuse
// sizes that would exhaust the seeder, instead of stalling past its lock (CWE-1333, CWE-407, CWE-770).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { discoverReports, giewsCountries, htmlElements, parseSniim } from '../scripts/lib/food-prices.mjs';
import { pdfPages, readWorkbook, selectOptions } from '../scripts/lib/food-prices-fetch.mjs';
import { ammanFormState } from '../scripts/lib/food-prices-adapters/amman.mjs';
import { parseMaga } from '../scripts/lib/food-prices-adapters/maga.mjs';
import { mitRows } from '../scripts/lib/food-prices-adapters/mit.mjs';
import { nuxtData } from '../scripts/lib/food-prices-adapters/nabc.mjs';
import { ocpvRows } from '../scripts/lib/food-prices-adapters/ocpv.mjs';
import { simaRows } from '../scripts/lib/food-prices-adapters/sima.mjs';
import { parseTcbIndex } from '../scripts/lib/food-prices-adapters/tcb.mjs';
import { parseUcda } from '../scripts/lib/food-prices-adapters/ucda.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/food-prices/${name}`, import.meta.url), 'utf8');
const N = 40000;
const quick = (label, run) => {
  const started = performance.now();
  try { run(); } catch (error) { if (error instanceof RangeError) throw error; }
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `${label} took ${Math.round(ms)} ms`);
};

test('htmlElements pairs each opener with its close and ignores unclosed markup', () => {
  assert.deepEqual(htmlElements('<tr class="a"><td>1</td><TH>2</th></tr><tr>x', ['tr']).map(([open, inner]) => [open, inner]),
    [['<tr class="a">', '<td>1</td><TH>2</th>']]);
  assert.deepEqual(htmlElements('<td>1</th><td x="y">2</td>', ['td', 'th']).map(([, inner]) => inner), ['1', '2']);
  quick('unclosed openers', () => htmlElements('<td>'.repeat(N * 4), ['td', 'th']));
  quick('unclosed attributes', () => htmlElements('<tr class="'.repeat(N), ['tr']));
});

test('page parsers stay linear on unclosed rows, cells, options, anchors and scripts', () => {
  quick('GIEWS options', () => giewsCountries('<option value="country.jsp?code=AFG">'.repeat(N)));
  quick('report anchors', () => discoverReports('<a href="https://www.da.gov.ph/x.pdf">'.repeat(N), 'da'));
  quick('SNIIM table rows', () => parseSniim('<tr><td>'.repeat(N)));
  quick('form select', () => selectOptions(`<select name="m">${'<option value="1">'.repeat(N)}`, 'm'));
  quick('select opener', () => selectOptions('<select name="m" '.repeat(N), 'm'));
  quick('NABC payload', () => nuxtData('<script id="__NUXT_DATA__">'.repeat(N), 'x'));
  quick('TCB index cell', () => parseTcbIndex(`<tr>${'<td data-column="publish_date" '.repeat(N)}`));
  quick('Amman form state', () => ammanFormState('name="__VIEWSTATE" '.repeat(N)));
  quick('MAGA block opener', () => parseMaga('<div id="precios_diarios" '.repeat(N)));
  quick('MAGA headings and cells', () => parseMaga(`<div id="precios_diarios">${'<h4><tr ><td>'.repeat(N)}</table>`));
});

test('PDF row grouping stays linear and keeps the rows it found before', () => {
  const items = Array.from({ length: 200000 }, (_, i) => ({ text: 'x', x: i % 7, y: 100000 - i * 2 }));
  for (const [name, group] of [['MIT', mitRows], ['OCPV', ocpvRows], ['SIMA', simaRows]]) {
    quick(name, () => group(items));
    assert.deepEqual(group([{ text: 'b', x: 2, y: 10 }, { text: 'a', x: 1, y: 10.4 }, { text: 'c', x: 1, y: 8 }, { text: 'd', x: 1, y: 7 }])
      .map(row => row.items.map(item => item.text).join('')), ['ab', 'cd'], name);
  }
});

test('UCDA farmgate scan does not overflow the stack on a huge text layer', () => {
  const [page] = JSON.parse(fixture('ucda.json'));
  const header = page.find(item => item.text.trim() === 'Category of coffee');
  const huge = page.concat(Array.from({ length: 300000 }, (_, i) => ({ text: '1', x: 900 + (i % 50), y: (header?.y ?? 500) - 500 - i / 1000 })));
  quick('UCDA', () => parseUcda(huge));
});

test('workbooks with a cell far beyond any real sheet are refused before rows are materialised', async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('s').getCell('A1048576').value = 1;
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  const started = performance.now();
  await assert.rejects(readWorkbook(bytes), /sheet exceeds size limit/);
  assert.ok(performance.now() - started < 3000);
  const wide = new ExcelJS.Workbook();
  wide.addWorksheet('s').getCell(1, 16000).value = 1;
  await assert.rejects(readWorkbook(Buffer.from(await wide.xlsx.writeBuffer())), /sheet exceeds size limit/);
  const normal = new ExcelJS.Workbook();
  normal.addWorksheet('s').addRows([['a', 1], ['b', 2]]);
  assert.deepEqual(await readWorkbook(Buffer.from(await normal.xlsx.writeBuffer())), [[['a', 1], ['b', 2]]]);
});

test('NABC payload references nested past any real page are refused, not a stack overflow', () => {
  // A chain of single-element arrays: each link costs one recursive frame in the reviver.
  const nodes = [['ShallowReactive', 1], { data: 2 }, ['ShallowReactive', 3], { k: 4 }];
  for (let i = 4; i < 4 + 50000; i++) nodes.push([i + 1]);
  nodes.push('end');
  const html = `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(nodes)}</script>`;
  assert.throws(() => nuxtData(html, 'k'), /nested too deeply/);
  const shallow = [['ShallowReactive', 1], { data: 2 }, ['ShallowReactive', 3], { k: 4 }, [5], [6], 'leaf'];
  assert.deepEqual(nuxtData(`<script id="__NUXT_DATA__">${JSON.stringify(shallow)}</script>`, 'k'), [['leaf']]);
});

// A one-page PDF whose content stream shows `count` separate text items.
function textPdf(count) {
  const ops = Array.from({ length: count }, (_, i) => `BT /F1 8 Tf ${10 + (i % 8) * 70} ${760 - Math.floor(i / 8) % 70 * 10} Td (x${i}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => { const at = Buffer.byteLength(body); body += `${i + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

test('PDF text extraction stops once a document exceeds the item budget', async () => {
  const pages = await pdfPages(textPdf(300), { maxItems: 1000 });
  assert.equal(pages[0].length, 300);
  assert.equal(pages[0][0].text, 'x0');
  await assert.rejects(pdfPages(textPdf(3000), { maxItems: 1000 }), /text item limit/);
});
