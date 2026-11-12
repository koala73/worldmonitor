// Batch 3 regional fuel-price feeds (#10051): QatarEnergy, Zambia ERB, Ghana NPA,
// Burkina Faso SONABHY, Zimbabwe ZERA, Philippines DOE, Timor-Leste ANP,
// Colombia CREG and Uruguay URSEA. Expected values were read from the provider
// pages and files captured on 2026-11-02 (see tests/fixtures/regional-energy/README.md).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchRegionalEnergyFeed, regionalEnergyContentMeta } from '../scripts/_regional-energy-source.mjs';
import feeds from '../scripts/shared/regional-energy-feeds.json' with { type: 'json' };
import {
  QATARENERGY_PDF_URL, parseQatarFuel,
  ERB_INDEX_URL, discoverErbBuildUps, parseErbBuildUp,
  npaMediaUrl, discoverNpaWorkbook, parseNpaExPumpRows, parseNpaIndicatorRows,
  SONABHY_PAGE_URL, discoverSonabhyState, discoverSonabhyApi, parseSonabhyTariffs,
  ZERA_HOME_URL, parseZeraPrices,
  DOE_NCR_PAGE_URL, discoverDoeNcrPdfs, parseDoeNcrPrices,
  ANPTL_INDEX_URL, discoverAnpTlPosts, discoverAnpTlPdf, parseAnpTlStations,
  CREG_PAGE_URL, parseCregPrices,
  URSEA_TOPIC_URL, discoverUrseaPages, parseUrseaMaximumPrices, parseUrseaReferencePrices,
  decodeEntities,
} from '../scripts/lib/regional-fuel-feeds.mjs';
import { inEffect } from '../scripts/lib/regional-energy-feeds.mjs';
import { regionalFuelEntries } from '../scripts/seed-fuel-prices.mjs';

const path = name => new URL(`./fixtures/regional-energy/${name}`, import.meta.url);
const fixture = name => readFileSync(path(name), 'utf8');
const json = name => JSON.parse(fixture(name));
const feed = id => feeds.find(f => f.id === id);
const value = (points, metric, period, area = '') => {
  const hits = points.filter(p => p.metric === metric && p.period === period && p.area === area);
  assert.equal(hits.length, 1, `${metric} ${period} [${area}]`);
  return hits[0].value;
};
const assertUnique = points => {
  const keys = points.map(p => `${p.metric}|${p.area}|${p.period}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate metric|area|period');
};
// ExcelJS reads date cells as Date objects; the fixtures store them as { date }.
const sheetRows = name => json(name).rows.map(row => row.map(v => (v && typeof v === 'object' && v.date ? new Date(v.date) : v)));
// Each sheet is [name, rows]; the first argument's sheet comes first in the file.
// Excel writes xl/workbook.xml before the sheet parts and the ExcelJS stream
// reader depends on that order; the ExcelJS writer puts the sheets first, so
// the archive is rewritten in Excel's order.
async function workbook(...sheets) {
  const { default: ExcelJS } = await import('exceljs');
  const { unzipSync, zipSync } = await import('fflate');
  const book = new ExcelJS.Workbook();
  for (const [name, rows] of sheets) {
    const sheet = book.addWorksheet(name);
    rows.forEach(row => sheet.addRow(row));
  }
  const entries = unzipSync(new Uint8Array(await book.xlsx.writeBuffer()));
  const first = name => (/^\[Content_Types\]\.xml$|^_rels\/|^xl\/_rels\/|^xl\/workbook\.xml$|sharedStrings|styles/.test(name) ? 0 : 1);
  const ordered = Object.fromEntries(Object.keys(entries).sort((a, b) => first(a) - first(b)).map(name => [name, entries[name]]));
  return Buffer.from(zipSync(ordered));
}
const captured = name => [json(name).sheet, sheetRows(name)];
// Serves fixture responses by URL and records each request.
function server(routes) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    assert.match(options.headers['User-Agent'], /^WorldMonitor\/1\.0/);
    assert.equal(options.redirect, 'manual');
    if (!Object.hasOwn(routes, url)) throw new Error(`unexpected request ${url}`);
    const body = routes[url];
    return body instanceof Response ? body : new Response(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  return { fetchFn, calls };
}
// A PDF fixture holds the text items pdfAllItems extracts; the fetch path
// receives the same items from a stub PDF reader.
const PDF_READERS = { pdfItems: items => async () => items, pdfAllItems: items => async () => items };
async function fetchWithPdf(id, routes, pdfsByUrl, nowMs) {
  const { fetchFn, calls } = server(routes);
  const data = await fetchRegionalEnergyFeed(id, {
    fetchFn, nowMs,
    pdfReader: async (_bytes, url) => {
      if (!Object.hasOwn(pdfsByUrl, url)) throw new Error(`unexpected PDF ${url}`);
      return pdfsByUrl[url];
    },
  });
  return { data, calls };
}

describe('QatarEnergy monthly fuel prices', () => {
  const items = json('qatarenergy-items.json');

  it('reads every month of the history table from the second page', () => {
    const points = parseQatarFuel(items);
    assertUnique(points);
    assert.equal(points.length, 11 * 3);
    assert.equal(value(points, 'fuel.retail_price', '2026-10-01', 'Gasoline Premium'), 1.95);
    assert.equal(value(points, 'fuel.retail_price', '2026-10-01', 'Gasoline Super'), 2.1);
    assert.equal(value(points, 'fuel.retail_price', '2026-10-01', 'Diesel'), 2.05);
    // "Mars 2026" is the source's spelling of March; split runs ("1", ".", "90") rejoin.
    assert.equal(value(points, 'fuel.retail_price', '2026-03-01', 'Gasoline Super'), 1.9);
    assert.equal(value(points, 'fuel.retail_price', '2025-12-01', 'Gasoline Premium'), 2);
    assert.deepEqual([...new Set(points.map(p => p.unit))], ['QAR/l']);
    assert.throws(() => parseQatarFuel(items.filter(i => i.text.trim() !== 'Diesel')), /Changed QatarEnergy price columns/);
    assert.throws(() => parseQatarFuel(items.filter(i => !/^(Oct|Sep|Aug|July|June|May|April|Mars|Feb) 2026$/.test(i.text.trim()))), /Missing QatarEnergy price history/);
    assert.throws(() => parseQatarFuel(items.filter(i => !(i.text === '95' && i.y > 479))), /Invalid energy measurement|Missing QatarEnergy/);
  });

  it('serves a month from its first day, Doha time, and keeps eight months per product', async () => {
    const pdf = { [QATARENERGY_PDF_URL]: items };
    const { data, calls } = await fetchWithPdf('qatarenergy', { [QATARENERGY_PDF_URL]: 'pdf' }, pdf, Date.parse('2026-10-31T12:00:00Z'));
    assert.equal(calls.length, 1);
    assert.equal(data.observations.length, 8 * 3);
    assert.equal(data.observedAt, '2026-10-01T00:00:00.000Z');
    assert.equal(regionalEnergyContentMeta(data, Date.parse('2026-10-31T12:00:00Z')).newestItemAt, Date.parse('2026-09-30T21:00:00Z'));
    // A November row published on 31 October would wait for 1 November in Doha (UTC+3).
    const november = [...items, ...items.filter(i => i.y > 479 && i.y < 481).map(i => ({ ...i, y: 490, text: i.text === 'Oct 2026' ? 'Nov 2026' : i.text }))];
    const early = inEffect(parseQatarFuel(november), Date.parse('2026-10-31T20:30:00Z'), feed('qatarenergy').utcOffsetMin);
    assert.ok(!early.some(p => p.period === '2026-11-01'));
    assert.ok(inEffect(parseQatarFuel(november), Date.parse('2026-10-31T21:00:00Z'), feed('qatarenergy').utcOffsetMin).some(p => p.period === '2026-11-01'));
  });
});

describe('Zambia ERB pump price build-up', () => {
  const posts = json('erb-posts.json');
  const novemberUrl = 'https://www.erb.org.zm/wp-content/uploads/files/FuelPumpPrices/NOVEMBER-2026-PUMP-PRICE-BUILD-UP.pdf';
  const octoberUrl = 'https://www.erb.org.zm/wp-content/uploads/files/FuelPumpPrices/OCTOBER-2026-PUMP-PRICE-BUILD-UP.pdf';

  it('finds each release and reads pump and wholesale prices per litre', () => {
    const releases = discoverErbBuildUps(posts);
    assert.deepEqual(releases.map(r => [r.period, r.url]), [['2026-11-01', novemberUrl], ['2026-10-01', octoberUrl]]);
    const items = json('erb-items-2026-11.json');
    const points = parseErbBuildUp(items, '2026-11-01');
    assertUnique(points);
    assert.equal(points.length, 6);
    // The build-up prints ZMW per cubic metre: 33,061.35 is K33.06 a litre.
    assert.equal(value(points, 'fuel.retail_price', '2026-11-01', 'Petrol'), 33.06135);
    assert.equal(value(points, 'fuel.retail_price', '2026-11-01', 'Diesel'), 34.44672);
    assert.equal(value(points, 'fuel.retail_price', '2026-11-01', 'Kerosene'), 32.08151);
    assert.equal(value(points, 'fuel.wholesale_price', '2026-11-01', 'Petrol'), 24.72103);
    assert.throws(() => parseErbBuildUp(items, '2026-10-01'), /does not match its release/);
    assert.throws(() => parseErbBuildUp(items.filter(i => i.text !== 'Uniform Pump Price'), '2026-11-01'), /Missing ERB build-up rows/);
    assert.throws(() => parseErbBuildUp(items.map(i => (i.text === 'ZMW/ M' ? { ...i, text: 'ZMW/ L' } : i)), '2026-11-01'), /Changed ERB build-up unit/);
    assert.throws(() => discoverErbBuildUps([{ ...posts[0], content: { rendered: posts[0].content.rendered.replace(/www\.erb\.org\.zm/g, 'evil.example') } }]), /Unapproved/);
  });

  it('serves October until November starts in Lusaka', async () => {
    const routes = { [ERB_INDEX_URL]: posts, [novemberUrl]: 'pdf', [octoberUrl]: 'pdf' };
    const october = json('erb-items-2026-11.json').map(i => ({ ...i, text: i.text.replace(/NOVEMBER/g, 'OCTOBER') }));
    const pdfs = { [novemberUrl]: json('erb-items-2026-11.json'), [octoberUrl]: october };
    // Posted 31 October at 16:39Z; Lusaka is UTC+2, so November starts at 22:00Z.
    const before = await fetchWithPdf('erb', routes, pdfs, Date.parse('2026-10-31T20:00:00Z'));
    assert.deepEqual([...new Set(before.data.observations.map(p => p.period))], ['2026-10-01']);
    assert.equal(before.data.dataUrls.at(-1), octoberUrl);
    const after = await fetchWithPdf('erb', routes, pdfs, Date.parse('2026-10-31T22:00:00Z'));
    assert.deepEqual([...new Set(after.data.observations.map(p => p.period))], ['2026-11-01']);
    assert.equal(after.calls.length, 2);
  });
});

describe('Ghana NPA ex-pump prices and price indicators', () => {
  it('tolerates the publication gaps NPA has actually shown', () => {
    // From npa.gov.gh/wp-json/wp/v2/media, read 2026-11-03: the workbook
    // as of 2026-08-12 was the newest until 2026-09-24, and the one as of
    // 2026-10-16 was still the newest on 2026-11-03. A threshold that alarms
    // inside those gaps reports NPA's cadence, not a broken seeder.
    const longestObservedGapMin = (Date.parse('2026-09-24') - Date.parse('2026-08-12')) / 60_000;
    assert.ok(feed('npa').maxContentAgeMin > longestObservedGapMin,
      `maxContentAgeMin ${feed('npa').maxContentAgeMin} must exceed the observed ${longestObservedGapMin}-minute gap`);
  });

  it('picks the newest "as of" workbook of each kind', () => {
    const listing = discoverNpaWorkbook(json('npa-media-expump.json'), 'expump');
    assert.equal(listing.day, '2026-10-16');
    assert.equal(listing.url, 'https://npa.gov.gh/wp-content/uploads/2026/10/Ex-Pump-Prices-of-OMCs-and-LPGMCs-as-of-16th-October-2026.xlsx');
    const indicators = discoverNpaWorkbook(json('npa-media-indicators.json'), 'indicators');
    assert.equal(indicators.day, '2026-10-20');
    // A re-upload of an older day never outranks the newest day.
    const media = json('npa-media-indicators.json');
    const reupload = { ...media[1], date_gmt: '2026-12-01T00:00:00', title: { rendered: 'Petroleum Price Indicators (As of 19th October, 2026)(1)' } };
    assert.equal(discoverNpaWorkbook([reupload, ...media], 'indicators').day, '2026-10-20');
    assert.throws(() => discoverNpaWorkbook(media.map(m => ({ ...m, mime_type: 'application/pdf' })), 'indicators'), /Missing NPA indicators workbook/);
  });

  it('reads the listing summary rows and the FOB indicators in effect', () => {
    const listing = parseNpaExPumpRows(sheetRows('npa-expump-2026-10-16.json'));
    assertUnique(listing);
    assert.equal(listing.length, 6 * 3);
    const d = '2026-10-16';
    assert.equal(value(listing, 'fuel.retail_price', d, 'Regular Petrol RON 91; average of OMCs'), 16.9919);
    assert.equal(value(listing, 'fuel.retail_price.low', d, 'Regular Petrol RON 91; across OMCs'), 15.15);
    assert.equal(value(listing, 'fuel.retail_price.high', d, 'Diesel; across OMCs'), 20);
    assert.equal(value(listing, 'fuel.retail_price', d, 'LPG; average of OMCs'), 17.2679);
    assert.equal(listing.find(p => p.area.startsWith('LPG;')).unit, 'GHS/kg');
    assert.equal(listing.find(p => p.area.startsWith('Diesel;')).unit, 'GHS/l');
    const rows = sheetRows('npa-expump-2026-10-16.json');
    assert.throws(() => parseNpaExPumpRows(rows.filter(row => !/^Average/.test(String(row[2])))), /Missing NPA price summary rows/);
    assert.throws(() => parseNpaExPumpRows(rows.filter(row => !Number.isInteger(row[1]) || row[1] <= 10)), /listing is incomplete/);
    assert.throws(() => parseNpaExPumpRows(rows.map(row => row.map(v => (v === 'DIESEL (GHS/Lt)' ? 'DIESEL (GHS/gal)' : v)))), /Changed NPA ex-pump header/);

    const indicators = parseNpaIndicatorRows(sheetRows('npa-indicators-2026-10-20.json'));
    assertUnique(indicators);
    assert.equal(indicators.length, 6);
    // The PBU in effect from 16 October, not the estimate for 1 November.
    assert.equal(value(indicators, 'fuel.fob_price', '2026-10-16', 'Crude Oil'), 126.73);
    assert.equal(value(indicators, 'fuel.fob_price', '2026-10-16', 'Diesel'), 1414.78);
    assert.equal(indicators.find(p => p.area === 'Crude Oil').unit, 'USD/bbl');
    assert.ok(!indicators.some(p => /FX|USD\/GHS/.test(p.area)));
    assert.throws(() => parseNpaIndicatorRows(sheetRows('npa-indicators-2026-10-20.json').filter(row => row[1] !== 'LPG (USD/MT)')), /Missing NPA indicator rows/);
  });

  // The 15 October sheet: same layout, an earlier title and a different diesel average.
  const older = () => ['Ex-Pump Prices 15th Oct 2026', sheetRows('npa-expump-2026-10-16.json').map(row => row.map(v => (
    v === 'EX-PUMP PRICES OF OMCs/LPGMCs AS OF 16th October 2026' ? 'EX-PUMP PRICES OF OMCs/LPGMCs AS OF 15th October 2026' : v === 18.403636046511632 ? 18.25 : v))) ];

  it('streams the newest listing sheet and loads the indicator sheet by name', async () => {
    const listingUrl = 'https://npa.gov.gh/wp-content/uploads/2026/10/Ex-Pump-Prices-of-OMCs-and-LPGMCs-as-of-16th-October-2026.xlsx';
    const indicatorsUrl = 'https://npa.gov.gh/wp-content/uploads/2026/10/Petroleum-Price-Indicators-As-of-20th-October-2026.xlsx';
    const { fetchFn, calls } = server({
      [npaMediaUrl('Ex-Pump Prices of OMCs')]: json('npa-media-expump.json'),
      [npaMediaUrl('Petroleum Price Indicators')]: json('npa-media-indicators.json'),
      // The real workbook keeps one sheet per day, newest first; the older day here has different prices.
      [listingUrl]: await workbook(captured('npa-expump-2026-10-16.json'), older()),
      [indicatorsUrl]: await workbook(captured('npa-indicators-2026-10-20.json')),
    });
    const data = await fetchRegionalEnergyFeed('npa', { fetchFn, nowMs: Date.parse('2026-11-02T12:00:00Z') });
    assert.equal(calls.length, 4);
    assert.equal(data.observations.find(p => p.area === 'Diesel; average of OMCs').value, 18.4036, 'the newest sheet, not the older one');
    assert.equal(data.observations.length, 18 + 6);
    // The listing day and the PBU's effective day both fall on 16 October.
    assert.equal(data.observedAt, '2026-10-16T00:00:00.000Z');
    assert.equal(data.observations.find(p => p.metric === 'fuel.fob_price' && p.area === 'Petrol').period, '2026-10-16');

    // A workbook whose first sheet is an older day than its upload is named for is refused.
    const stale = server({
      [npaMediaUrl('Ex-Pump Prices of OMCs')]: json('npa-media-expump.json'),
      [npaMediaUrl('Petroleum Price Indicators')]: json('npa-media-indicators.json'),
      [listingUrl]: await workbook(older(), captured('npa-expump-2026-10-16.json')),
      [indicatorsUrl]: await workbook(captured('npa-indicators-2026-10-20.json')),
    });
    await assert.rejects(fetchRegionalEnergyFeed('npa', { fetchFn: stale.fetchFn, nowMs: Date.parse('2026-11-02T12:00:00Z') }), /does not match its upload day/);
  });
});

describe('Burkina Faso SONABHY tariffs', () => {
  const stateUrl = 'https://www.sonabhy.bf/_nuxt/static/1788728541/tarif-hydrocarbures/state.js';
  const apiUrl = 'https://king-prawn-app-6bsvl.ondigitalocean.app/api/tarif-consommateurs';

  it('follows the page to its CMS and reads the retail price order', async () => {
    assert.equal(discoverSonabhyState(fixture('sonabhy-page.html')), stateUrl);
    assert.equal(discoverSonabhyApi(fixture('sonabhy-state.js')), apiUrl);
    assert.throws(() => discoverSonabhyApi('strapi:{url:"https:\\u002F\\u002Fevil.example\\u002Fapi"}'), /Unapproved/);
    const points = parseSonabhyTariffs(json('sonabhy-tarifs.json'));
    assertUnique(points);
    assert.equal(points.length, 7 * 2);
    // Order 2026-008 fixes retail prices; order 2026-007 (price structure) is not read.
    assert.equal(value(points, 'fuel.retail_price', '2026-07-08', 'Super 91; Ouagadougou'), 850);
    assert.equal(value(points, 'fuel.retail_price', '2026-07-08', 'Gazoil; Ouagadougou'), 750);
    assert.equal(value(points, 'fuel.retail_price', '2026-07-08', 'Gazoil; Bobo Dioulasso'), 745);
    assert.equal(value(points, 'fuel.retail_price', '2026-07-08', 'B12; Ouagadougou'), 5500);
    assert.equal(points.find(p => p.area === 'B12; Ouagadougou').unit, 'XOF/12.5kg');
    assert.equal(points.find(p => p.area === 'B3; Ouagadougou').unit, 'XOF/2.75kg');
    const payload = json('sonabhy-tarifs.json');
    assert.throws(() => parseSonabhyTariffs({ data: payload.data.filter(e => !/prix de vente/i.test(e.attributes.titre)) }), /Missing SONABHY retail tariff order/);
    assert.throws(() => parseSonabhyTariffs(JSON.parse(fixture('sonabhy-tarifs.json').replace('"750 F CFA"', '"750 FCFA"'))), /Changed SONABHY tariff/);

    const { fetchFn, calls } = server({ [SONABHY_PAGE_URL]: fixture('sonabhy-page.html'), [stateUrl]: fixture('sonabhy-state.js'), [apiUrl]: payload });
    const data = await fetchRegionalEnergyFeed('sonabhy', { fetchFn, nowMs: Date.parse('2026-11-02T12:00:00Z') });
    assert.deepEqual(calls.map(c => c.url), [SONABHY_PAGE_URL, stateUrl, apiUrl]);
    assert.equal(data.observedAt, '2026-07-08T00:00:00.000Z');
    assert.equal(data.dataUrls.at(-1), apiUrl);
  });
});

describe('Zimbabwe ZERA energy prices', () => {
  it('reads the USD and ZWG price of each product from the homepage widget', async () => {
    const points = parseZeraPrices(fixture('zera-home.html'));
    assertUnique(points);
    assert.equal(points.length, 8);
    // "As Of: 09-10-2026" is 9 October.
    assert.equal(value(points, 'fuel.retail_price', '2026-10-09', 'Petrol Blend (E20)'), 2.05);
    assert.equal(value(points, 'fuel.retail_price', '2026-10-09', 'Petrol Blend (E20); in ZWG'), 54.7);
    assert.equal(value(points, 'fuel.retail_price', '2026-10-09', 'Diesel (D50)'), 2.04);
    assert.equal(value(points, 'fuel.retail_price', '2026-10-09', 'LPG'), 1.76);
    assert.equal(value(points, 'electricity.tariff', '2026-10-09', 'Electricity; first 50 units'), 4.24);
    assert.equal(value(points, 'electricity.tariff', '2026-10-09', 'Electricity; first 50 units; in ZWG'), 109.04);
    assert.deepEqual([...new Set(points.map(p => p.unit))].sort(), ['USD/50kWh', 'USD/kg', 'USD/l', 'ZWG/50kWh', 'ZWG/kg', 'ZWG/l']);
    const html = fixture('zera-home.html');
    assert.throws(() => parseZeraPrices(html.replace('Petrol Blend (E20)', 'Petrol Blend (E10)')), /Unknown ZERA product/);
    assert.throws(() => parseZeraPrices(html.replace('USD Per Litre', 'USD Per Gallon')), /Changed ZERA price table/);
    assert.throws(() => parseZeraPrices(html.replace(/As Of: 09-10-2026/g, 'As Of: soon')), /Missing ZERA price date/);
    const { fetchFn } = server({ [ZERA_HOME_URL]: html });
    const data = await fetchRegionalEnergyFeed('zera', { fetchFn, nowMs: Date.parse('2026-11-02T12:00:00Z') });
    assert.equal(data.observedAt, '2026-10-09T00:00:00.000Z');
  });
});

describe('Philippines DOE NCR price monitoring', () => {
  const page = fixture('doe-ncr-page.html');
  const items = json('doe-ncr-items-2026-10-27.json');
  const latest = 'https://d24qbtp4vooyzi.cloudfront.net/api/media/file/NCR%20Price%20Monitoring%20for%2027%20October%20to%202%20November%202026.pdf?prefix=dev%2Fmedia';

  it('dates each weekly link without a year and reads range and common prices by city', () => {
    const weeks = discoverDoeNcrPdfs(page, Date.parse('2026-11-02T12:00:00Z'));
    assert.equal(weeks.length, 10);
    assert.deepEqual(weeks[0], { weekStart: '2026-10-27', url: latest });
    assert.equal(weeks.at(-1).weekStart, '2026-08-25');
    // Seen in January, an "October 27 to November 2" link is last year's.
    assert.equal(discoverDoeNcrPdfs(page, Date.parse('2027-01-10T12:00:00Z'))[0].weekStart, '2026-10-27');
    assert.throws(() => discoverDoeNcrPdfs(page.replace(/d24qbtp4vooyzi\.cloudfront\.net/g, 'evil.cloudfront.net')), /Unapproved|Missing DOE/);

    const points = parseDoeNcrPrices(items);
    assertUnique(points);
    const d = '2026-10-27';
    assert.equal(value(points, 'fuel.retail_price', d, 'RON 91; Manila City; common price'), 80.58);
    assert.equal(value(points, 'fuel.retail_price', d, 'Diesel; Manila City; common price'), 94.3);
    assert.equal(value(points, 'fuel.retail_price.low', d, 'RON 95; Caloocan City'), 77.7);
    assert.equal(value(points, 'fuel.retail_price.high', d, 'RON 95; Caloocan City'), 95.1);
    assert.equal(value(points, 'fuel.retail_price', d, 'RON 95; Caloocan City; common price'), 82.4);
    // A range printed without its dash still reads as two bounds.
    assert.equal(value(points, 'fuel.retail_price.low', d, 'Kerosene; Pasig City'), 123.3);
    assert.equal(value(points, 'fuel.retail_price.high', d, 'Kerosene; Pasig City'), 123.3);
    // "#N/A" common prices are not observations.
    assert.ok(!points.some(p => p.area === 'RON 100; Caloocan City; common price'));
    // The second page repeats "Caloocan City" beside Muntinlupa; the city already read is not reused.
    assert.equal(value(points, 'fuel.retail_price.low', d, 'RON 91; Muntinlupa City'), 79.85);
    // This week's sheet covers twelve of the seventeen NCR local governments.
    const cities = new Set(points.map(p => p.area.split('; ')[1]));
    assert.equal(cities.size, 12);
    assert.ok(cities.has('Navotas City') && cities.has('Parañaque City'));
    assert.throws(() => parseDoeNcrPrices(items.filter(i => i.text.trim() !== 'OVERALL RANGE')), /Changed DOE price monitoring layout/);
    assert.throws(() => parseDoeNcrPrices(items.filter(i => i.text.trim() !== 'Manila City')), /Ambiguous DOE city block/);
  });

  it('serves the previous week until a week posted early starts in Manila', async () => {
    const previous = 'https://d24qbtp4vooyzi.cloudfront.net/api/media/file/NCR%20Price%20Monitoring%2010202026.pdf?prefix=dev%2Fmedia';
    const lastWeek = items.map(i => (i.text.includes('October 27 - November 2') ? { ...i, text: '(For the week of October 20 - 26, 2026)' } : i));
    const routes = { [DOE_NCR_PAGE_URL]: page, [latest]: 'pdf', [previous]: 'pdf' };
    const pdfs = { [latest]: items, [previous]: lastWeek };
    // Manila is UTC+8: 27 October starts at 16:00Z on 26 October.
    const early = await fetchWithPdf('doe', routes, pdfs, Date.parse('2026-10-26T12:00:00Z'));
    assert.deepEqual([...new Set(early.data.observations.map(p => p.period))], ['2026-10-20']);
    const started = await fetchWithPdf('doe', routes, pdfs, Date.parse('2026-10-26T16:00:00Z'));
    assert.deepEqual([...new Set(started.data.observations.map(p => p.period))], ['2026-10-27']);
    assert.equal(started.calls.length, 2);
    await assert.rejects(fetchWithPdf('doe', routes, { ...pdfs, [latest]: lastWeek }, Date.parse('2026-11-02T12:00:00Z')), /does not match its link/);
  });
});

describe('Timor-Leste ANP station prices', () => {
  const postUrl = 'https://www.anp.tl/wp-json/wp/v2/posts/12450?_fields=id,date,date_gmt,link,title,content';
  const pdfUrl = 'https://www.anp.tl/wp-content/uploads/2026/10/Fuel-Prices-16-20-Oct-2026-English.pdf';

  it('reads the English listing and publishes the lowest and highest price per municipality', async () => {
    const posts = discoverAnpTlPosts(json('anptl-posts.json'));
    assert.deepEqual(posts.slice(0, 2).map(p => [p.period, p.url]), [['2026-10-16', postUrl], ['2026-10-15', 'https://www.anp.tl/wp-json/wp/v2/posts/12436?_fields=id,date,date_gmt,link,title,content']]);
    assert.ok(posts.every(p => !p.url.includes('/tl/')), 'Tetum editions are skipped');
    assert.equal(discoverAnpTlPdf(json('anptl-post-12450.json')), pdfUrl);
    const items = json('anptl-items-2026-10-20.json');
    const points = parseAnpTlStations(items, '2026-10-16');
    assertUnique(points);
    assert.equal(points.length, (1 + 13) * 2 * 2);
    const d = '2026-10-16';
    assert.equal(value(points, 'fuel.retail_price.low', d, 'Petrol; all municipalities'), 1.4);
    assert.equal(value(points, 'fuel.retail_price.high', d, 'Petrol; all municipalities'), 1.51);
    assert.equal(value(points, 'fuel.retail_price.low', d, 'Diesel; Dili'), 1.54);
    assert.equal(value(points, 'fuel.retail_price.high', d, 'Diesel; Dili'), 1.65);
    // Viqueque's rows cross the page break.
    assert.equal(value(points, 'fuel.retail_price.high', d, 'Petrol; Viqueque'), 1.51);
    assert.deepEqual([...new Set(points.map(p => p.unit))], ['USD/l']);
    assert.throws(() => parseAnpTlStations(items.filter(i => i.page === 1 && i.y > 500), '2026-10-16'), /listing is incomplete/);
    assert.throws(() => parseAnpTlStations(items.map(i => (i.text === '1,50' ? { ...i, text: '1.50' } : i)), '2026-10-16'), /Invalid ANP station price/);

    const { fetchFn, calls } = server({ [ANPTL_INDEX_URL]: json('anptl-posts.json'), [postUrl]: json('anptl-post-12450.json'), [pdfUrl]: 'pdf' });
    const data = await fetchRegionalEnergyFeed('anptl', { fetchFn, nowMs: Date.parse('2026-11-02T12:00:00Z'), pdfReader: async () => items });
    assert.equal(calls.length, 3);
    assert.equal(data.observedAt, '2026-10-16T00:00:00.000Z');
    assert.equal(data.dataUrls.at(-1), pdfUrl);
  });
});

describe('Colombia CREG city prices', () => {
  it('reads the three newest price tables with their effective days', async () => {
    const points = parseCregPrices(fixture('creg-page.html'));
    assertUnique(points);
    assert.deepEqual([...new Set(points.map(p => p.period))], ['2026-11-01', '2026-10-02', '2026-10-01']);
    // Pesos per US gallon, printed with a thousands dot.
    assert.equal(value(points, 'fuel.retail_price', '2026-11-01', 'Gasolina MC; Bogotá'), 16331);
    assert.equal(value(points, 'fuel.retail_price', '2026-11-01', 'ACPM; Bogotá'), 11616);
    assert.equal(value(points, 'fuel.retail_price', '2026-11-01', 'ACPM; Cúcuta'), 9486);
    assert.equal(value(points, 'fuel.retail_price', '2026-10-01', 'Gasolina MC; Bogotá'), 16377);
    assert.equal(value(points, 'fuel.retail_price', '2026-11-01', 'Gasolina MC; Promedio PVP precio (13 ciudades principales)'), 15886);
    assert.equal(decodeEntities('Bogot&aacute; &amp; Cali &#241;'), 'Bogotá & Cali ñ');
    const html = fixture('creg-page.html');
    assert.throws(() => parseCregPrices(html.replace('ACPM ($/gal)', 'ACPM ($/l)')), /Changed CREG price table/);
    assert.throws(() => parseCregPrices(html.replace(/<caption>[\s\S]*?<\/caption>/g, '')), /Missing CREG price tables/);
    assert.throws(() => parseCregPrices(html.replace('<td>16.331</td>', '<td>16,331.5</td>')), /Invalid CREG price/);

    const { fetchFn } = server({ [CREG_PAGE_URL]: html });
    // Bogotá is UTC-5: 1 November starts at 05:00Z. Before that the October table is the newest.
    const before = await fetchRegionalEnergyFeed('creg', { fetchFn, nowMs: Date.parse('2026-11-01T04:00:00Z') });
    assert.equal(before.observedAt, '2026-10-02T00:00:00.000Z');
    const after = await fetchRegionalEnergyFeed('creg', { fetchFn, nowMs: Date.parse('2026-11-01T05:00:00Z') });
    assert.equal(after.observedAt, '2026-11-01T00:00:00.000Z');
    assert.equal(after.observations.filter(p => p.area === 'Gasolina MC; Bogotá').length, 3);
  });
});

describe('Uruguay URSEA prices', () => {
  const base = 'https://www.gub.uy/unidad-reguladora-servicios-energia-agua/comunicacion';
  const maximumUrl = `${base}/noticias/ursea-determino-valor-del-pmit-poder-ejecutivo-actualizo-pvp-0`;
  const referenceUrl = `${base}/publicaciones/precios-venta-publico-referencia-para-gasolinas-gasoil-50-s-4`;

  it('finds the newest announcements and reads maximum, PMIT, reference and parity prices', () => {
    const pages = discoverUrseaPages(fixture('ursea-topic.html'));
    assert.equal(pages.maximum[0], maximumUrl);
    assert.equal(pages.maximum[1], `${base}/noticias/ursea-determino-valor-del-pmit-poder-ejecutivo-actualizo-pvp`);
    assert.equal(pages.reference[0], referenceUrl);
    const maximum = parseUrseaMaximumPrices(fixture('ursea-pmit-2026-11.html'));
    assertUnique(maximum);
    assert.equal(maximum.length, 5 + 6);
    assert.equal(value(maximum, 'fuel.retail_price', '2026-11-01', 'Gasolina Súper 95'), 90.45);
    assert.equal(value(maximum, 'fuel.retail_price', '2026-11-01', 'Gas Oil 50S'), 62.79);
    assert.equal(value(maximum, 'fuel.retail_price', '2026-11-01', 'Supergás (GLP)'), 93.56);
    assert.equal(maximum.find(p => p.area === 'Supergás (GLP)').unit, 'UYU/kg');
    assert.equal(value(maximum, 'fuel.wholesale_price', '2026-11-01', 'Gasolina Super 95; PMIT'), 80.08);
    assert.equal(value(maximum, 'fuel.wholesale_price', '2026-11-01', 'GLP Envasado; PMIT'), 54.08);
    const reference = parseUrseaReferencePrices(fixture('ursea-pvp-2026-11.html'));
    assertUnique(reference);
    assert.equal(reference.length, 6);
    assert.equal(value(reference, 'fuel.reference_price', '2026-11-01', 'Gasolina Súper 95'), 93.59);
    assert.equal(value(reference, 'fuel.import_parity_price', '2026-11-01', 'Gas Oil 50S; PPI, before taxes'), 53.03);
    assert.throws(() => parseUrseaMaximumPrices(fixture('ursea-pmit-2026-11.html').replace('Gasolina Súper 95: $90,45', 'Gasolina Súper 95: $ninety')), /Missing URSEA Gasolina Súper 95 maximum price/);
    assert.throws(() => parseUrseaReferencePrices(fixture('ursea-pvp-2026-11.html').replace('Gasoil 50-S ($/l)', 'Gasoil 10-S ($/l)')), /Changed URSEA reference price columns/);
  });

  it('serves the previous month until the new prices start in Montevideo', async () => {
    const previousMaximum = `${base}/noticias/ursea-determino-valor-del-pmit-poder-ejecutivo-actualizo-pvp`;
    const previousReference = `${base}/publicaciones/precios-venta-publico-referencia-para-gasolinas-gasoil-50-s-3`;
    const october = html => html.replace(/1[.]?[º°] de noviembre de 2026/g, '1.º de octubre de 2026').replace('período 1/11 al 30/11 del 2026', 'período 1/10 al 31/10 del 2026');
    const { fetchFn, calls } = server({
      [URSEA_TOPIC_URL]: fixture('ursea-topic.html'),
      [maximumUrl]: fixture('ursea-pmit-2026-11.html'), [previousMaximum]: october(fixture('ursea-pmit-2026-11.html')),
      [referenceUrl]: fixture('ursea-pvp-2026-11.html'), [previousReference]: october(fixture('ursea-pvp-2026-11.html')),
    });
    // Montevideo is UTC-3: 1 November starts at 03:00Z.
    const before = await fetchRegionalEnergyFeed('ursea', { fetchFn, nowMs: Date.parse('2026-11-01T02:00:00Z') });
    assert.deepEqual([...new Set(before.observations.map(p => p.period))], ['2026-10-01']);
    assert.equal(calls.length, 5);
    calls.length = 0;
    const after = await fetchRegionalEnergyFeed('ursea', { fetchFn, nowMs: Date.parse('2026-11-01T03:00:00Z') });
    assert.deepEqual([...new Set(after.observations.map(p => p.period))], ['2026-11-01']);
    assert.equal(calls.length, 3);
  });
});

describe('fuel-price panel rows from batch 3 feeds', () => {
  it('maps each country\'s headline gasoline and diesel price per litre', () => {
    const NOW = Date.parse('2026-11-02T12:00:00Z');
    const obs = (period, value, unit, area, metric = 'fuel.retail_price') => ({ metric, period, value, unit, area });
    const entries = regionalFuelEntries({
      qatarenergy: { sourceId: 'qatarenergy', observations: parseQatarFuel(json('qatarenergy-items.json')) },
      erb: { sourceId: 'erb', observations: parseErbBuildUp(json('erb-items-2026-11.json'), '2026-11-01') },
      npa: { sourceId: 'npa', observations: parseNpaExPumpRows(sheetRows('npa-expump-2026-10-16.json')) },
      sonabhy: { sourceId: 'sonabhy', observations: parseSonabhyTariffs(json('sonabhy-tarifs.json')) },
      zera: { sourceId: 'zera', observations: parseZeraPrices(fixture('zera-home.html')) },
      doe: { sourceId: 'doe', observations: parseDoeNcrPrices(json('doe-ncr-items-2026-10-27.json')) },
      anptl: { sourceId: 'anptl', observations: parseAnpTlStations(json('anptl-items-2026-10-20.json'), '2026-10-16') },
      creg: { sourceId: 'creg', observations: parseCregPrices(fixture('creg-page.html')) },
      ursea: { sourceId: 'ursea', observations: [...parseUrseaMaximumPrices(fixture('ursea-pmit-2026-11.html')), obs('2026-11-01', 93.59, 'UYU/l', 'Gasolina Súper 95', 'fuel.reference_price')] },
    }, NOW);
    const by = Object.fromEntries(entries.map(e => [e.code, e]));
    assert.deepEqual(Object.keys(by).sort(), ['BF', 'CO', 'GH', 'PH', 'QA', 'UY', 'ZM', 'ZW']);
    assert.equal(by.QA.gasoline.localPrice, 2.1, 'Super 95, not Premium 91');
    assert.equal(by.QA.diesel.observedAt, '2026-10-01');
    assert.ok(Math.abs(by.ZM.gasoline.localPrice - 33.0614) < 0.0001, String(by.ZM.gasoline.localPrice));
    assert.equal(by.GH.gasoline.localPrice, 16.9919, 'the NPA average row');
    assert.equal(by.GH.diesel.localPrice, 18.4036);
    assert.equal(by.BF.diesel.localPrice, 750);
    assert.equal(by.ZW.currency, 'USD');
    assert.equal(by.ZW.gasoline.localPrice, 2.05);
    assert.equal(by.PH.gasoline.localPrice, 80.58, 'Manila City common price');
    assert.equal(by.PH.diesel.localPrice, 94.3);
    assert.equal(by.CO.gasoline.localPrice, +(16331 / 3.785411784).toFixed(4), 'Bogotá, per litre from the gallon price');
    assert.equal(by.UY.gasoline.localPrice, 90.45, 'the maximum pump price, not the reference price');
    assert.equal(by.UY.diesel.localPrice, 62.79);
  });
});
