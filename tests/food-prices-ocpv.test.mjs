import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collect, ocpvFolderReports, parseOcpv, sameTable } from '../scripts/lib/food-prices-adapters/ocpv.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/food-prices/ocpv.json', import.meta.url), 'utf8'));
const latest = () => structuredClone(fixture['2026-10-25']);
const prior = () => structuredClone(fixture['2026-10-18']);
const find = (rows, item, market) => rows.find(row => row.item === item && row.market === market);

test('OCPV keeps the regional average column, published kg unit and week-ending date', () => {
  const rows = parseOcpv(latest());
  assert.deepEqual(find(rows, 'Maize (grain)', 'Agnebye Tiassa (Agboville)'),
    { item: 'Maize (grain)', market: 'Agnebye Tiassa (Agboville)', marketType: 'retail', unit: 'kg', currency: 'XOF', date: '2026-10-25', price: 500, origin: '' });
  assert.equal(find(rows, 'Carrot', 'District d’Abidjan').price, 1640);
  assert.equal(find(rows, 'Millet', 'Folon (Minignan)').price, 600);
  assert.equal(find(rows, 'Onion (Galmi purple)', 'District de Yamoussoukro'), undefined);
  assert.equal(find(rows, 'Onion (Galmi purple)', 'Grands-Ponts (Dabou)').price, 1500);
  assert.ok(rows.every(row => row.price > 0 && row.currency === 'XOF' && row.date === '2026-10-25'));
});

test('OCPV joins multi-line region headers on stacked blocks', () => {
  const rows = parseOcpv([...latest(), fixture.animal]);
  assert.equal(find(rows, 'Beef (bone-in)', 'Indenie Djuablin (Abengourou-Agnibilekro)').price, 3000);
  assert.equal(find(rows, 'Beef (boneless)', 'District d’Abidjan').price, 4400);
  assert.equal(find(rows, 'Beef (boneless)', 'Haut Sassandra (Daloa)'), undefined);
});

test('OCPV merges a figure that Word split into adjacent text runs', () => {
  const pages = latest();
  const cell = pages[1].find(item => item.text === '1640');
  pages[1].push({ ...cell, text: '0', x: cell.x + 13.6 });
  cell.text = '164';
  assert.equal(find(parseOcpv(pages), 'Carrot', 'District d’Abidjan').price, 1640);
});

test('OCPV detects a weekly table that repeats the prior week', () => {
  const a = parseOcpv(latest());
  const b = parseOcpv(prior());
  assert.equal(b[0].date, '2026-10-18');
  assert.ok(sameTable(a, b));
  assert.ok(!sameTable(a, b.map((row, i) => i ? row : { ...row, price: row.price + 10 })));
});

test('OCPV rejects changed layouts and undated tables', () => {
  const renamed = latest();
  renamed[1].find(item => item.text === 'moy').text = 'moyen';
  assert.throws(() => parseOcpv(renamed), /ocpv .*format changed|ocpv .*layout changed/);
  const undated = latest().map(page => page.filter(item => !/SEMAINE ALLANT|^\d$|^25$/.test(item.text)));
  assert.throws(() => parseOcpv(undated), /ocpv report date missing/);
  assert.throws(() => parseOcpv([[{ text: 'Page introuvable', x: 0, y: 0 }]]), /ocpv food PDF format changed/);
});

test('OCPV folder listing yields filename week identities', () => {
  const reports = ocpvFolderReports('<a href="PRIX_A_LA_CONSOMMATION__12_10_AU_18_10_2026.pdf">x</a><a href="PRIX_A_LA_CONSOMMATION_05_01_AU_11_01_2026.pdf">y</a><a href="?C=M;O=A">z</a>', 'https://www.ocpv-ci.com/doc/prix_consomation/2026/');
  assert.deepEqual(reports.map(report => [report.url.split('/').at(-1), report.end.join('-')]),
    [['PRIX_A_LA_CONSOMMATION__12_10_AU_18_10_2026.pdf', '2026-10-18'], ['PRIX_A_LA_CONSOMMATION_05_01_AU_11_01_2026.pdf', '2026-01-11']]);
});

function context(pagesByFile) {
  const warnings = [];
  const fetched = [];
  return {
    warnings, fetched,
    now: new Date('2026-11-01T06:00:00Z'),
    dated: (date, offset) => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10),
    links: (html, base) => [...html.matchAll(/href="([^"]+)"/g)].map(match => ({ url: new URL(match[1], base).href, text: '' })),
    warn: message => warnings.push(message),
    pdfPages: async name => pagesByFile[name],
    get: async url => {
      fetched.push(url);
      if (url === 'https://www.ocpv-ci.com/') return '<a href="doc/prix_consomation/2026/PRIX_A_LA_CONSOMMATION__19_10_AU_25_10_2026.pdf">Prix</a>';
      if (url.endsWith('/2026/')) return Object.keys(pagesByFile).map(name => `<a href="${name}">x</a>`).join('');
      const name = url.split('/').at(-1);
      if (!pagesByFile[name]) throw new Error('ocpv HTTP 404');
      return name;
    },
  };
}

test('OCPV collect publishes only the genuinely dated report when the latest repeats the prior week', async () => {
  const ctx = context({ 'PRIX_A_LA_CONSOMMATION__19_10_AU_25_10_2026.pdf': latest(), 'PRIX_A_LA_CONSOMMATION__12_10_AU_18_10_2026.pdf': prior() });
  const result = await collect(ctx);
  assert.deepEqual([...new Set(result.observations.map(row => row.date))], ['2026-10-18']);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-18' }]);
  assert.match(result.reportUrl, /12_10_AU_18_10_2026\.pdf$/);
  assert.ok(ctx.warnings.some(message => /2026-10-25 repeats the 2026-10-18 table/.test(message)));
});

test('OCPV collect pairs the latest report with the report seven days earlier', async () => {
  const changed = prior();
  changed[1].find(item => item.text === '1640').text = '1600';
  const ctx = context({ 'PRIX_A_LA_CONSOMMATION__19_10_AU_25_10_2026.pdf': latest(), 'PRIX_A_LA_CONSOMMATION__12_10_AU_18_10_2026.pdf': changed });
  const result = await collect(ctx);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-25' }, { date: '2026-10-18' }]);
  assert.equal(find(result.observations.filter(row => row.date === '2026-10-18'), 'Carrot', 'District d’Abidjan').price, 1600);
  assert.equal(ctx.warnings.length, 0);
});

test('OCPV collect keeps the latest report when the prior week is missing', async () => {
  const ctx = context({ 'PRIX_A_LA_CONSOMMATION__19_10_AU_25_10_2026.pdf': latest() });
  const result = await collect(ctx);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-25' }]);
  assert.ok(ctx.warnings.some(message => /prior-week report unavailable/.test(message)));
});
