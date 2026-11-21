import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collect, discoverStatkz, parseStatkz } from '../scripts/lib/food-prices-adapters/statkz.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/food-prices/statkz.json', import.meta.url), 'utf8'));
const INDEX = 'https://stat.gov.kz/en/industries/economy/prices/spreadsheets/';
const links = html => [...html.matchAll(/<a href="([^"]+)">([\s\S]*?)<\/a>/g)].map(m => ({ url: new URL(m[1], INDEX).href, text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }));
const anchor = (id, text) => `<a href="/api/iblock/element/${id}/file/en/">\n\t\t\t${text}\t\t\t</a><a href="/api/iblock/element/${id}/file/en/"><span class="mr-1">153.6  KB, xlsx</span></a>`;
const series = 'Price index and average prices for socially important food products in the Republic of Kazakhstan';

test('stat.gov.kz discovery reads report dates from link titles, not file names', () => {
  const html = anchor(413870, `${series} (as 28 October 2026)`) + anchor(413892, 'Producer price indices for services in the Republic of Kazakhstan ( III quarter 2026)')
    + anchor(413561, `${series} ( as 9 September 2026)`) + anchor(413560, `${series} (as 2 September 2026 )`)
    + `<a href="https://evil.example/api/iblock/element/1/file/en/">${series} (as 4 November 2026)</a>`;
  assert.deepEqual(discoverStatkz(html, links), [
    { date: '2026-10-28', url: 'https://stat.gov.kz/api/iblock/element/413870/file/en/' },
    { date: '2026-09-09', url: 'https://stat.gov.kz/api/iblock/element/413561/file/en/' },
    { date: '2026-09-02', url: 'https://stat.gov.kz/api/iblock/element/413560/file/en/' },
  ]);
});

test('stat.gov.kz keeps city and surveyed-city average prices with published units', () => {
  const rows = parseStatkz(fixture['2026-10-28'], '2026-10-28');
  assert.equal(rows.find(r => r.item === 'Rice (polished)' && r.market === 'Almaty').price, 481);
  const eggs = rows.find(r => r.item === 'Eggs (category 1)' && r.market === 'National average');
  assert.equal(eggs.price, 610);
  assert.equal(eggs.unit, 'dozen');
  assert.equal(rows.find(r => r.item === 'Milk (pasteurized, 2.2-6% fat)' && r.market === 'Astana').unit, 'litre');
  assert.equal(rows.find(r => r.item === 'Black tea' && r.market === 'Turkistan').price, 6302);
  assert.ok(rows.some(r => r.market === 'Petropavlovsk') && rows.some(r => r.market === 'Shymkent'));
  assert.equal(new Set(rows.map(r => r.market)).size, 21);
  assert.equal(new Set(rows.map(r => r.item)).size, 31);
  assert.ok(rows.every(r => r.price > 0 && r.currency === 'KZT' && r.date === '2026-10-28' && r.marketType === 'retail'));
  assert.equal(parseStatkz(fixture['2026-10-21'], '2026-10-21').find(r => r.item === 'Eggs (category 1)' && r.market === 'National average').price, 605);
});

test('stat.gov.kz rejects mismatched dates and changed layouts', () => {
  assert.throws(() => parseStatkz(fixture['2026-10-21'], '2026-10-28'), /does not match report/);
  assert.throws(() => parseStatkz([[['Unrelated']]], '2026-10-28'), /format changed/);
  const [sheet] = fixture['2026-10-28'];
  assert.throws(() => parseStatkz([sheet.map((row, i) => i === 1 ? row.map(v => v && 'in tenge per 100 g') : row)], '2026-10-28'), /unit line/);
  assert.throws(() => parseStatkz([sheet.map((row, i) => i === 2 ? row.slice(0, 5) : row)], '2026-10-28'), /city header/);
  const blanks = sheet.map((row, i) => i < 3 ? row : row.map((v, c) => c > 1 ? '-' : v));
  assert.ok(parseStatkz([blanks], '2026-10-28').every(r => r.market === 'National average'));
});

test('stat.gov.kz collect fetches the latest weekly workbook and the one seven days earlier', async () => {
  const warnings = [];
  const requested = [];
  const pages = {
    [INDEX]: `<select name="name" id="collections-name-filter"><option value="" selected>All</option><option\n value="39329"\n>${series}</option></select>` + anchor(413870, `${series} (as 28 October 2026)`),
    [`${INDEX}?year=&name=39329&period=&type=`]: anchor(413870, `${series} (as 28 October 2026)`) + anchor(413869, `${series} (as 21 October 2026)`) + anchor(519391, `${series} (as 14 October 2026)`),
  };
  const files = { 413870: '2026-10-28', 413869: '2026-10-21' };
  const ctx = {
    now: new Date('2026-11-01T06:00:00Z'),
    dated: (now, offset) => new Date(now.getTime() + offset * 86400000).toISOString().slice(0, 10),
    links,
    selectOptions: (html, name) => [...(new RegExp(`<select\\b[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? '').matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/g)].map(m => ({ id: m[1], name: m[2].trim() })),
    warn: message => warnings.push(message),
    readWorkbook: async bytes => fixture[bytes.toString()],
    async get(url, options = {}) {
      requested.push(url);
      if (pages[url]) return pages[url];
      const id = /element\/(\d+)\//.exec(url)?.[1];
      assert.ok(options.binary && files[id]);
      return Buffer.from(files[id]);
    },
  };
  const result = await collect(ctx);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-28' }, { date: '2026-10-21' }]);
  assert.deepEqual([...new Set(result.observations.map(r => r.date))], ['2026-10-28', '2026-10-21']);
  assert.equal(result.reportUrl, 'https://stat.gov.kz/api/iblock/element/413870/file/en/');
  assert.equal(requested.length, 4);
  assert.deepEqual(warnings, []);

  files[413869] = '2026-10-28';
  const partial = await collect(ctx);
  assert.deepEqual(partial.refreshedReports, [{ date: '2026-10-28' }]);
  assert.match(warnings[0], /prior-week report unavailable/);
});
