import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyRoute, parseUkDaily, parseCbp } from '../scripts/lib/border-route-arrivals.mjs';

const end = Date.parse('2026-10-18T00:00:00Z');
const days = (latest = 100) => Array.from({ length: 121 }, (_, i) => ({ date: new Date(end - (120 - i) * 86400000).toISOString().slice(0, 10), count: i > 113 ? latest : 100 }));

test('complete daily windows compare independent periods and detect a surge, not a flat series', () => {
  const flat = dailyRoute(days());
  assert.equal(flat.last7Days, 700);
  assert.equal(flat.last30Days, 3000);
  assert.equal(flat.previous30Days, 3000);
  assert.equal(flat.surge, false);
  const surge = dailyRoute(days(1000));
  assert.equal(surge.last7Days, 7000);
  assert.equal(surge.surge, true);
  assert.equal(surge.asOf, '2026-10-18');
  assert.equal(dailyRoute(days().map(p => ({ ...p, count: 2000 }))).surge, true, 'absolute weekly threshold is independent of acceleration');
});

test('missing days mean unknown, while an explicitly reported zero stays zero', () => {
  assert.equal(dailyRoute(days().slice(-7)).last30Days, undefined);
  assert.equal(dailyRoute(days().filter((_, i) => i !== 118)).last7Days, undefined);
  assert.equal(dailyRoute(days().map(p => ({ ...p, count: 0 }))).last30Days, 0);
});

test('Home Office parser selects migrants, not boats, and rejects missing or suppressed observations', () => {
  const html = '<table><thead><tr><th>Date</th><th>Migrants arrived</th><th>Boats arrived</th></tr></thead><tbody><tr><th>18 October 2026</th><td>1,200</td><td>20</td></tr><tr><th>17 October 2026</th><td>0</td><td>0</td></tr>' + [12, 13, 14, 15, 16].map(d => `<tr><th>${d} October 2026</th><td>0</td><td>0</td></tr>`).join('') + '</tbody></table>';
  assert.deepEqual(parseUkDaily(html).slice(-2), [{ date: '2026-10-17', count: 0 }, { date: '2026-10-18', count: 1200 }]);
  assert.throws(() => parseUkDaily(html.replace('1,200', '..')), /count|observation/);
  assert.throws(() => parseUkDaily('<html>unavailable</html>'), /table|observation/);
});

test('Home Office headers select arrival and date columns independently of their order', () => {
  const html = '<table><tr><th>Boats arrived</th><th>Migrants arrived</th><th>Date</th></tr>'
    + [12, 13, 14, 15, 16, 17, 18].map(d => `<tr><td>9</td><td>100</td><th>${d} October 2026</th></tr>`).join('') + '</table>';
  assert.equal(parseUkDaily(html).at(-1).count, 100);
});

test('Home Office dates and counts reject impossible dates and embedded markup', () => {
  const html = '<table><tr><th>Date</th><th>Migrants arrived</th></tr>'
    + [12, 13, 14, 15, 16, 17, 18].map(d => `<tr><th>${d} October 2026</th><td>100</td></tr>`).join('') + '</table>';
  assert.throws(() => parseUkDaily(html.replace('18 October 2026', '30 February 2026')), /date/);
  assert.throws(() => parseUkDaily(html.replace('<td>100</td>', '<td><b>100</b></td>')), /count/);
});

test('CBP converts fiscal October, selects southwest only and counts enforcement events', () => {
  const csv = 'Fiscal Year,Month (abbv),Land Border Region,Encounter Count\n2026,OCT,Southwest Land Border,10\n2026,OCT,Southwest Land Border,2\n2026,OCT,Northern Land Border,500\n2026,SEP,Southwest Land Border,0\n';
  const points = parseCbp(csv);
  assert.deepEqual(points, [{ date: '2025-10-31', count: 12 }, { date: '2026-09-30', count: 0 }]);
  assert.throws(() => parseCbp(csv.replace(',10', ',unknown')), /count/);
  assert.throws(() => parseCbp('wrong,header\n1,2'), /columns/);
});

test('CBP accepts its published FYTD label without shifting the fiscal year', () => {
  assert.deepEqual(parseCbp('Fiscal Year,Month (abbv),Land Border Region,Encounter Count\n2026 (FYTD),OCT,Southwest Land Border,10\n'), [{ date: '2025-10-31', count: 10 }]);
});

test('ODS parser reads numeric arrivals from the named sheet', async () => {
  const { zipSync, strToU8 } = await import('fflate');
  const { parseUkOds } = await import('../scripts/lib/border-route-arrivals.mjs');
  const rows = days().map(p => `<table:table-row><table:table-cell office:date-value="${p.date}"/><table:table-cell office:value="${p.count}"/><table:table-cell office:value="9"/></table:table-row>`).join('');
  const content = `<office:document-content xmlns:office="o" xmlns:table="t"><office:body><office:spreadsheet><table:table table:name="SB_01">${rows}</table:table></office:spreadsheet></office:body></office:document-content>`;
  const ods = zipSync({ 'content.xml': strToU8(content) });
  assert.deepEqual(parseUkOds(ods), days());
  assert.throws(() => parseUkOds(zipSync({ 'wrong.xml': strToU8(content) })), /content/);
});

test('each source declares independent fetch/content budgets and rejects unusable publication data', async () => {
  const { routeSeedOptions } = await import('../scripts/lib/border-route-sources.mjs');
  const uk = routeSeedOptions('uk');
  const cbp = routeSeedOptions('cbp');
  assert.equal(uk.maxStaleMin, 2880);
  assert.equal(uk.maxContentAgeMin, 10800);
  assert.equal(cbp.maxContentAgeMin, 108000);
  assert.equal(uk.emptyDataIsFailure, true);
  const route = { id: 'channel', countryCode: 'GB', asOf: '2026-10-18', latestCount: 0 };
  assert.equal(uk.validateFn({ routes: [route] }), true);
  for (const patch of [{ latestCount: -1 }, { latestCount: '0' }, { asOf: '2099-10-18' }, { countryCode: '' }]) {
    assert.equal(uk.validateFn({ routes: [{ ...route, ...patch }] }), false);
  }
  assert.equal(uk.validateFn({ routes: [] }), false);
  assert.equal(uk.contentMeta({ routes: [route] }).newestItemAt, Date.parse(route.asOf));
});

test('UK content budget absorbs a weekend gap plus a bank holiday and bundle pickup without prewarning', async () => {
  const { BORDER_SOURCES } = await import('../scripts/lib/border-route-sources.mjs');
  const { CONTENT_AGE_PREWARNING_RATIO } = await import('../api/_content-age.js');
  const { readFileSync } = await import('node:fs');
  const DAY_MIN = 1440;
  const bundle = readFileSync(new URL('../scripts/seed-bundle-health.mjs', import.meta.url), 'utf8');
  const ukSection = bundle.split('\n').find(line => line.includes("label: 'Border-UK'"));
  assert.match(ukSection, /intervalMs: 6 \* HOUR,/);
  // gov.uk posts day D's figures around 12:00Z on D+1 and skips weekends:
  // Thursday's figures (posted Friday) stay newest until Monday, 4.5 days after Thursday 00:00Z.
  const weekendAge = 4.5 * DAY_MIN;
  const bankHoliday = DAY_MIN;
  const pickup = 6 * 60;
  assert.ok(BORDER_SOURCES.uk.maxContentAgeMin * CONTENT_AGE_PREWARNING_RATIO > weekendAge + bankHoliday + pickup);
  const server = readFileSync(new URL('../server/worldmonitor/displacement/v1/cross-border-data.ts', import.meta.url), 'utf8');
  const serverUk = server.split('\n').find(line => line.includes("id: 'uk'"));
  assert.match(serverUk, new RegExp(`maxContentAgeMin: ${String(BORDER_SOURCES.uk.maxContentAgeMin / DAY_MIN).replace('.', '\\.')} \\* 1440 }`));
});
