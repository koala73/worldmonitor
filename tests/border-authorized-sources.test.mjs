import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import ExcelJS from 'exceljs';
import { BORDER_SOURCES, FETCHERS, routeSeedOptions } from '../scripts/lib/border-route-sources.mjs';
import { parseFrontex, parsePanama, parsePanamaText } from '../scripts/lib/border-authorized-reports.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('authorized Frontex and Panama sources have independent fetchers and report clocks', () => {
  for (const id of ['frontex', 'panama']) {
    assert.equal(typeof FETCHERS[id], 'function', `${id} must have an automatic fetcher`);
    assert.equal(BORDER_SOURCES[id].maxContentAgeMin, 75 * 1440);
    assert.equal(routeSeedOptions(id).maxStaleMin, 2880);
  }
});

async function workbook(rows, months = ['MAY2026', 'JUN2026', 'JUL2026', 'AUG2026']) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Detections_of_IBC');
  sheet.addRow([]);
  sheet.addRow(['Route', 'Border type or inland', 'Nationality', ...months]);
  rows.forEach(row => sheet.addRow(row));
  return new Uint8Array(await book.xlsx.writeBuffer());
}

test('Frontex sums nationalities and border types once per route without turning detections into arrivals', async () => {
  const bytes = await workbook([
    ['Eastern Mediterranean Route', 'Sea', 'Sudan', 100, 100, 100, 1200],
    ['Eastern Mediterranean Route', 'Land', 'Sudan', 100, 100, 100, 200],
    ['Eastern Mediterranean Route', 'Sea', 'Syria', 100, 100, 100, 100],
    ['Black Sea Route', 'Sea', 'Unknown', 0, 0, 0, 0],
  ]);
  const routes = await parseFrontex(bytes);
  assert.equal(routes.length, 2);
  assert.deepEqual(routes.map(r => r.latestCount), [1500, 0]);
  assert.equal(routes[0].asOf, '2026-08-31');
  assert.equal(routes[0].kind, 'encounter');
  assert.equal(routes[0].surge, false);
  assert.equal(routes[0].countryCode, '', 'a multi-country route must not be attributed to one country');
  assert.equal(routeSeedOptions('frontex').validateFn({ routes }), true);
});

test('Frontex fails closed on missing, suppressed, duplicated or unknown route data', async () => {
  const row = ['Central Mediterranean Route', 'Sea', 'Sudan', 1, 2, 3, 4];
  for (const rows of [[row, row], [[...row.slice(0, -1), null]], [[...row.slice(0, -1), '..']], [['New Route', ...row.slice(1)]], [['Central Mediterranean Route', 'Sea', 'Total', 1, 2, 3, 4]]]) {
    await assert.rejects(() => workbook(rows).then(parseFrontex), /invalid|duplicate/);
  }
  await assert.rejects(() => workbook([row], ['MAY2026', 'JUN2026', 'JUL2026', 'AUGUST2026']).then(parseFrontex), /month/);
});

const panamaText = (counts = '539 34 19 39 43 43 102 40 148 71 - - -', cutoff = '30 de septiembre') => `
Cuadro No. 001 TRANSITO IRREGULAR DE EXTRANJEROS POR LA FRONTERA CON COLOMBIA POR REGION: ANO 2026
Region Total Ene. Feb. Mar. Abr. May. Jun. Jul. Ago. Sep. Oct. Nov. Dic.
Total ${counts}
Cifras preliminares sujetas a revision y actualizacion al ${cutoff} de 2026
`;

test('Panama takes complete monthly arrivals, not the year-to-date figure or a partial month', () => {
  const [route] = parsePanamaText(panamaText());
  assert.equal(route.latestCount, 71);
  assert.equal(route.asOf, '2026-09-30');
  assert.equal(route.kind, 'arrival');
  assert.equal(route.countryCode, 'PA');
  assert.equal(route.originCode, 'CO');
  assert.equal(parsePanamaText(panamaText(undefined, '15 de septiembre'))[0].latestCount, 148);
  assert.equal(parsePanamaText(panamaText(undefined, '15 de septiembre'))[0].asOf, '2026-08-31');
  assert.equal(parsePanamaText(panamaText('468 34 19 39 43 43 102 40 148 0 - - -'))[0].latestCount, 0);
});

test('Panama rejects unknown published months, inconsistent totals and invalid report dates', () => {
  for (const text of [panamaText().replace('539', '540'), panamaText().replace('148', '-'), panamaText().replace('539', '..'), panamaText(undefined, '31 de septiembre'), panamaText().replace('Ene.', 'Jan.'), '<html>unavailable</html>']) {
    assert.throws(() => parsePanamaText(text), /Panama|report count/);
  }
});

function pdf(text) {
  const stream = `BT /F1 10 Tf 30 750 Td ${text.trim().split('\n').map((line, i) => `${i ? '0 -15 Td ' : ''}(${line.replace(/[()\\]/g, '\\$&')}) Tj`).join('\n')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new Uint8Array(Buffer.from(body));
}

test('Panama reads PDF bytes through the real text parser', async () => {
  const [route] = await parsePanama(pdf(panamaText()));
  assert.equal(route.latestCount, 71);
  assert.equal(route.asOf, '2026-09-30');
  await assert.rejects(() => parsePanama(new Uint8Array(Buffer.from('not a PDF'))));
});

test('official page discovery follows changing release links and ignores external attachments', async () => {
  const frontexBytes = await workbook([['Black Sea Route', 'Sea', 'Unknown', 0, 0, 0, 0]]);
  const requests = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requests.push(url);
    if (url === BORDER_SOURCES.frontex.url) return new Response('<a href="https://untrusted.test/assets/Migratory_routes/2099/Monthly_detections_of_IBC_2099_12_31.xlsx">bad</a><a href="/assets/Migratory_routes/2026/Monthly_detections_of_IBC_2026_10_05.xlsx">current</a>');
    if (url.endsWith('.xlsx')) return new Response(frontexBytes);
    if (url === BORDER_SOURCES.panama.url) return new Response('<a href="https://www.migracion.gob.pa/wp-content/uploads/2026/11/IRREGULARES-POR-DARIEN-2025-2.pdf" aria-label="Abrir PDF: Tránsito Irregular por Darién 2025">archive</a><a href="https://www.migracion.gob.pa/wp-content/uploads/2026/07/IRREGULARES-POR-DARIEN.pdf" aria-label="Abrir PDF: Tránsito Irregular por Darién 2026">current</a>');
    if (url.endsWith('IRREGULARES-POR-DARIEN.pdf')) return new Response(pdf(panamaText()));
    throw new Error(`unexpected request ${url}`);
  };
  assert.equal((await FETCHERS.frontex()).routes[0].latestCount, 0);
  assert.equal((await FETCHERS.panama()).routes[0].latestCount, 71);
  assert.ok(requests.every(url => !url.includes('untrusted.test')));
});

test('Panama refuses a document whose report year disagrees with the source page', async () => {
  globalThis.fetch = async input => String(input) === BORDER_SOURCES.panama.url
    ? new Response('<a href="https://www.migracion.gob.pa/wp-content/uploads/2026/07/IRREGULARES-POR-DARIEN.pdf" aria-label="Abrir PDF: Tránsito Irregular por Darién 2025">report</a>')
    : new Response(pdf(panamaText()));
  await assert.rejects(() => FETCHERS.panama(), /report year/);
});
