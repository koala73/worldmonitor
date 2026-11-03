// Batch 2 regional energy feeds (#9893): Vietnam EVN, Kazakhstan KOREM, Peru COES, Papua New Guinea ICCC and Fiji FCCC.
// Expected values were read from the provider pages and files captured on
// 2026-10-31 (see tests/fixtures/regional-energy/README.md).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchRegionalEnergyFeed, regionalEnergyContentMeta } from '../scripts/_regional-energy-source.mjs';
import feeds from '../scripts/shared/regional-energy-feeds.json' with { type: 'json' };
import {
  discoverEvnPost, parseEvn,
  koremEnergySeriesUrl, koremLastDateUrl, koremCtUrls, parseKorem, KOREM_FIXED_URLS,
  COES_DEMAND_URL, coesDemandBody, parseCoes,
  discoverPngFuelPosts, parsePngFuelPost,
  discoverFijiFuelPdfs, parseFijiFuel,
  memWorkbookUrl, parseMemPriceRows,
  pdfItems, buildFeedSnapshot, inEffect,
} from '../scripts/lib/regional-energy-feeds.mjs';

const path = name => new URL(`./fixtures/regional-energy/${name}`, import.meta.url);
const fixture = name => readFileSync(path(name), 'utf8');
const json = name => JSON.parse(fixture(name));
const value = (points, metric, period, area = '') => {
  const hits = points.filter(p => p.metric === metric && p.period === period && p.area === area);
  assert.equal(hits.length, 1, `${metric} ${period} [${area}]`);
  return hits[0].value;
};
const assertUnique = points => {
  const keys = points.map(p => `${p.metric}|${p.area}|${p.period}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate metric|area|period');
};
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

describe('Vietnam EVN system bulletin', () => {
  it('discovers the newest bulletin and reads its summary, mix and dispatch', async () => {
    const postUrl = 'https://evn.com.vn/d/vi-VN/news/Thong-tin-chung-ve-van-hanh-he-thong-dien-Quoc-gia-ngay-30102026-60-2015-510168';
    assert.equal(discoverEvnPost(fixture('evn-index.html')), postUrl);
    assert.throws(() => discoverEvnPost('<a href="https://evil.example/d/vi-VN/news/Thong-tin-chung-ve-van-hanh-he-thong-dien-Quoc-gia-ngay-30102026-60-2015-1">x</a>'), /Missing EVN/);
    const evn = parseEvn(fixture('evn-post.html'));
    assertUnique(evn);
    assert.equal(evn.length, 4 + 10 + 12 * 2);
    const d = '2026-10-30';
    assert.equal(value(evn, 'generation.peak', d, 'rooftop solar sales estimate'), 50068.9);
    assert.equal(value(evn, 'energy.generated_and_imported', d, 'rooftop solar terminal estimate'), 1031.9);
    assert.equal(value(evn, 'energy.coal', d), 504);
    assert.equal(value(evn, 'energy.oil', d), 0);
    assert.equal(value(evn, 'generation.hydro', d, 'evening peak'), 11420.6);
    assert.equal(value(evn, 'generation', d, 'midday trough; rooftop solar sales estimate'), 41622.6);
    assert.throws(() => parseEvn(fixture('evn-post.html').replace('Thủy điện&nbsp;243,2', 'Thủy năng&nbsp;243,2')), /Unknown EVN source/);
    assert.throws(() => parseEvn(fixture('evn-post.html').replace('50068,9 MW', '50068.9 MW')), /Invalid EVN measurement|Changed EVN/);

    const { fetchFn } = server({
      'https://evn.com.vn/vi-VN/news-l/Thong-tin-tom-tat-van-hanh-HTD-Quoc-gia-60-2015': fixture('evn-index.html'),
      [postUrl]: fixture('evn-post.html'),
    });
    const data = await fetchRegionalEnergyFeed('evn', { fetchFn, nowMs: Date.parse('2026-10-31T12:00:00Z') });
    assert.equal(data.observedAt, '2026-10-30T00:00:00.000Z');
    assert.deepEqual(data.dataUrls.at(-1), postUrl);
  });
});

describe('Kazakhstan KOREM', () => {
  const { responses } = json('korem.json');

  it('reads system energy and day-ahead auction series that match the portal summary cards', () => {
    const summary = responses[KOREM_FIXED_URLS.summary];
    const torgNames = responses[KOREM_FIXED_URLS.torgNames];
    const plan = koremCtUrls(torgNames, responses[KOREM_FIXED_URLS.zones], responses[koremLastDateUrl(torgNames)]);
    const korem = parseKorem({
      series: responses[koremEnergySeriesUrl(summary)],
      maxConsumption: responses[KOREM_FIXED_URLS.maxConsumption],
      ct: plan.map(z => ({ zone: z.zone, prices: responses[z.prices], volumes: responses[z.volumes] })),
    });
    assertUnique(korem);
    assert.equal(korem.length, 8 * 2 + 1 + 8 * 2 * 2);
    assert.equal(value(korem, 'energy.generated', summary.lastDate), summary.genDay);
    assert.equal(value(korem, 'energy.consumed', summary.lastDate), summary.consDay);
    assert.equal(value(korem, 'demand.peak', '2026-10-30'), 15565);
    // Zone volumes and the volume-weighted zone price reproduce the portal's KPI card.
    const kpi = responses['https://portal.korem.kz/api/ct/kpi?torgNameId=4'];
    const [north, west] = ['Север - Юг', 'Запад'].map(zone => ({
      volume: value(korem, 'trade.day_ahead.volume', '2026-11-01', zone),
      price: value(korem, 'price.day_ahead', '2026-11-01', zone),
    }));
    assert.ok(Math.abs(north.volume + west.volume - kpi.dealDay) < 0.01);
    assert.ok(Math.abs((north.price * north.volume + west.price * west.volume) / (north.volume + west.volume) - kpi.price) < 0.001);
    assert.throws(() => koremCtUrls([{ id: 3, name: 'ЦТ для ЦМ' }], responses[KOREM_FIXED_URLS.zones], '2026-11-01'), /Missing KOREM day-ahead/);
  });

  it('holds back the next delivery day until it starts', async () => {
    // Every portal endpoint returns JSON, including last-date's bare date string.
    const { fetchFn, calls } = server(Object.fromEntries(Object.entries(responses).map(([url, body]) => [url, JSON.stringify(body)])));
    const afternoon = await fetchRegionalEnergyFeed('korem', { fetchFn, nowMs: Date.parse('2026-10-31T17:22:00Z') });
    assert.equal(calls.length, 10);
    assert.ok(!afternoon.observations.some(p => p.period === '2026-11-01'));
    assert.equal(afternoon.observations.find(p => p.metric === 'price.day_ahead' && p.period === '2026-10-31' && p.area === 'Север - Юг').value, 18.541003080413162);
    // Delivery days are Kazakhstan dates (UTC+5): 1 November starts at 19:00Z on 31 October.
    const afterLocalMidnight = await fetchRegionalEnergyFeed('korem', { fetchFn, nowMs: Date.parse('2026-10-31T19:30:00Z') });
    assert.equal(afterLocalMidnight.observations.filter(p => p.period === '2026-11-01').length, 4);
  });
});

describe('Peru COES demand', () => {
  const coes = json('coes.json');

  it('reads executed and scheduled SEIN demand in Lima time', () => {
    assert.equal(coesDemandBody(Date.parse('2026-10-31T17:22:00Z')), coes.request.body);
    assert.equal(coesDemandBody(Date.parse('2026-11-01T03:00:00Z')), coes.request.body, 'Lima is still on 31 October at 03:00Z');
    const points = parseCoes(coes.response);
    assertUnique(points);
    assert.equal(value(points, 'demand', '2026-10-31T17:00:00.000Z', 'SEIN'), 7964.6302);
    assert.equal(value(points, 'demand.scheduled', '2026-10-30T05:30:00.000Z', 'SEIN'), 7118.71636);
    assert.equal(points.filter(p => p.metric === 'demand').length, 72);
  });

  it('posts the date window, publishes only elapsed slots and refuses a POST redirect', async () => {
    const nowMs = Date.parse('2026-10-31T17:22:00Z');
    const { fetchFn, calls } = server({ [COES_DEMAND_URL]: coes.response });
    const data = await fetchRegionalEnergyFeed('coes', { fetchFn, nowMs });
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.body, coes.request.body);
    assert.match(calls[0].options.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
    assert.ok(data.observations.every(p => Date.parse(p.period) <= nowMs + 3600000));
    assert.ok(data.observations.some(p => p.metric === 'demand.scheduled'));
    // Health reads a future newestItemAt as stale content, so content age counts
    // only slots that had started when the run began.
    const meta = regionalEnergyContentMeta(data, nowMs);
    assert.ok(meta.newestItemAt <= nowMs);
    assert.equal(meta.newestItemAt, Date.parse('2026-10-31T17:00:00.000Z'));
    const redirect = new Response(null, { status: 302, headers: { location: COES_DEMAND_URL } });
    await assert.rejects(fetchRegionalEnergyFeed('coes', { fetchFn: server({ [COES_DEMAND_URL]: redirect }).fetchFn, nowMs }), /POST redirect/);
  });
});

describe('Papua New Guinea ICCC fuel prices', () => {
  const index = json('iccc-index.json');
  const postUrl = id => `https://iccc.gov.pg/wp-json/wp/v2/posts/${id}?_fields=id,date,date_gmt,modified_gmt,link,title,content`;

  it('reads retail, unsubsidised and subsidy rows across both table layouts', () => {
    assert.deepEqual(discoverPngFuelPosts(index).slice(0, 2), [postUrl(10973), postUrl(10364)]);
    const oct = parsePngFuelPost(json('iccc-post-2026-10.json'));
    assert.equal(oct.length, 15);
    assert.equal(value(oct, 'fuel.retail_price', '2026-10-08', 'Diesel; Port Moresby'), 5.9);
    assert.equal(value(oct, 'fuel.retail_price.unsubsidized', '2026-10-08', 'Diesel; Port Moresby'), 7.31);
    // Toea rows convert to kina; the source prints the petrol direct subsidy as -0.81 toea.
    assert.equal(value(oct, 'fuel.subsidy', '2026-10-08', 'Petrol; Port Moresby; Direct subsidy'), 0.0081);
    assert.equal(value(oct, 'fuel.subsidy', '2026-10-08', 'Diesel; Port Moresby; Total'), 1.4132);
    const jul = parsePngFuelPost(json('iccc-post-2026-07.json'));
    assert.equal(value(jul, 'fuel.retail_price', '2026-07-08', 'Petrol; Port Moresby'), 4.39);
    const mar = parsePngFuelPost(json('iccc-post-2026-03.json'));
    assert.equal(mar.length, 3);
    assert.equal(value(mar, 'fuel.retail_price', '2026-03-08', 'Kerosene; Port Moresby'), 4.092);
    const post = json('iccc-post-2026-10.json');
    assert.throws(() => parsePngFuelPost({ ...post, content: { rendered: post.content.rendered.replace('<strong>K5.90</strong>', '<strong>K5.95</strong>') } }), /Conflicting fuel observations/);
    assert.throws(() => parsePngFuelPost({ ...post, date: '2026-01-07T18:11:41' }), /does not match post date/);
    assert.throws(() => discoverPngFuelPosts([{ ...index[0], link: 'https://evil.example/x' }]), /Unapproved/);
  });

  it('serves the previous release until the newest one takes effect', async () => {
    const { fetchFn, calls } = server({
      'https://iccc.gov.pg/wp-json/wp/v2/posts?categories=763309980&per_page=10&_fields=id,date,date_gmt,modified_gmt,link,title': index,
      [postUrl(10973)]: json('iccc-post-2026-10.json'),
      [postUrl(10364)]: json('iccc-post-2026-09.json'),
    });
    const beforeEffect = await fetchRegionalEnergyFeed('iccc', { fetchFn, nowMs: Date.parse('2026-10-07T12:00:00Z') });
    assert.deepEqual([...new Set(beforeEffect.observations.map(p => p.period))], ['2026-09-08']);
    assert.equal(beforeEffect.dataUrls.at(-1), postUrl(10364));
    calls.length = 0;
    // Effective dates are Port Moresby dates (UTC+10): 8 October starts at 14:00Z on 7 October.
    const afterEffect = await fetchRegionalEnergyFeed('iccc', { fetchFn, nowMs: Date.parse('2026-10-07T15:00:00Z') });
    assert.deepEqual([...new Set(afterEffect.observations.map(p => p.period))], ['2026-10-08']);
    assert.equal(calls.length, 2);
  });
});

describe('Fiji FCCC fuel prices', () => {
  it('reads every fuel and LPG schedule and reconciles each row', () => {
    const urls = discoverFijiFuelPdfs(json('fccc-index.json'));
    assert.deepEqual(urls.slice(0, 2), [
      'https://fccc.gov.fj/wp-content/uploads/2026/10/FCCC-Media-Release-New-Fuel-LPG-Prices-for-November-2026.pdf',
      'https://fccc.gov.fj/wp-content/uploads/2026/10/NEW-FUEL-AND-LPG-PRICES-FOR-OCTOBER-2026.pdf',
    ]);
    const nov = parseFijiFuel(json('fccc-items-2026-11.json'));
    assertUnique(nov);
    assert.equal(nov.length, 6 * 4 + 4 * 4);
    assert.equal(value(nov, 'fuel.retail_price', '2026-11-01', 'Motor Spirit; Schedule 1'), 3.7);
    assert.equal(value(nov, 'fuel.retail_price', '2026-11-01', 'Diesel; Schedule 6'), 4.47);
    assert.equal(value(nov, 'fuel.retail_price', '2026-11-01', 'LPG 12 Kg Cylinder; LPG Schedule 4'), 56.28);
    // October's tables split across pages; its approved prices are November's "current" column.
    const oct = parseFijiFuel(json('fccc-items-2026-10.json'));
    assert.equal(value(oct, 'fuel.retail_price', '2026-10-01', 'Motor Spirit; Schedule 1'), 3.15);
    assert.equal(value(oct, 'fuel.retail_price', '2026-10-01', 'LPG Autogas; LPG Schedule 1'), 2.24);
    const items = json('fccc-items-2026-11.json');
    assert.throws(() => parseFijiFuel(items.filter(i => !(i.page === 3 && i.y > 460))), /Changed FCCC schedule layout/);
    assert.throws(() => parseFijiFuel(items.map(i => (i.text === '$3.70 (VIP)' ? { ...i, text: '$3.80 (VIP)' } : i))), /do not reconcile/);
    assert.throws(() => parseFijiFuel(items.map(i => (i.text === '(Effective 1 November 2026)' ? { ...i, text: '(Effective 2 November 2026)' } : i))), /Inconsistent FCCC effective dates/);
    // Released on 31 October for 1 November: not in effect yet, so the snapshot keeps October.
    // Fiji is UTC+12, so 1 November starts at 12:00Z on 31 October.
    const fiji = feeds.find(f => f.id === 'fccc').utcOffsetMin;
    assert.equal(inEffect(nov, Date.parse('2026-10-31T09:00:00Z'), fiji).length, 0);
    // A price is not in effect before the day starts: no early-serving slack for calendar dates.
    assert.equal(inEffect(nov, Date.parse('2026-10-31T11:30:00Z'), fiji).length, 0);
    assert.equal(inEffect(nov, Date.parse('2026-10-31T12:00:00Z'), fiji).length, nov.length);
    assert.equal(inEffect(nov, Date.parse('2026-10-31T12:30:00Z'), fiji).length, nov.length);
    // Timestamp schedules keep their hour of lead.
    const slot = [{ metric: 'demand.scheduled_daily', period: '2026-10-31T12:00:00.000Z', value: 1, unit: 'MW', area: '' }];
    assert.equal(inEffect(slot, Date.parse('2026-10-31T11:30:00Z')).length, 1);
    const served = buildFeedSnapshot('fccc', nov, 'https://fccc.gov.fj/x.pdf', Date.parse('2026-10-31T12:30:00Z'));
    // Content age starts at Fiji's local midnight, not a UTC midnight 12 hours ahead.
    assert.equal(regionalEnergyContentMeta(served, Date.parse('2026-10-31T12:30:00Z')).newestItemAt, Date.parse('2026-10-31T12:00:00Z'));
  });
});

describe('Guatemala MEM fuel prices', () => {
  const capture = json('mem-daily.json');
  // ExcelJS reads date cells as Date objects; the fixture stores them as { date }.
  const sheetRows = () => capture.rows.map(row => row.map(v => (v && typeof v === 'object' && v.date ? new Date(v.date) : v)));
  const city = label => `${label}; Guatemala City`;
  const workbook = async (rows = sheetRows()) => {
    const { default: ExcelJS } = await import('exceljs');
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet(capture.sheet);
    rows.forEach(row => sheet.addRow(row));
    return Buffer.from(await book.xlsx.writeBuffer());
  };
  // Serves the upload folder: listed files answer HEAD and GET, anything else is 404.
  function uploads(files, overrides = {}) {
    const calls = [];
    const fetchFn = async (url, options) => {
      calls.push({ url, method: options.method ?? 'GET' });
      assert.match(options.headers['User-Agent'], /^WorldMonitor\/1\.0/);
      assert.equal(options.redirect, 'manual');
      if (Object.hasOwn(overrides, url)) return overrides[url];
      if (!Object.hasOwn(files, url)) return new Response('', { status: 404 });
      return new Response(options.method === 'HEAD' ? null : files[url]);
    };
    return { fetchFn, calls };
  }

  it('reads the Guatemala City price table by header and unit', () => {
    const points = parseMemPriceRows(sheetRows());
    assertUnique(points);
    const d = '2026-10-28';
    assert.equal(value(points, 'fuel.retail_price', d, city('Gasolina Superior')), 34.49);
    assert.equal(value(points, 'fuel.retail_price', d, city('Gasolina Regular')), 32.07);
    assert.equal(value(points, 'fuel.retail_price', d, city('Diésel')), 42.69);
    assert.equal(value(points, 'fuel.retail_price', d, city('GLP 25 lb cylinder')), 126);
    assert.equal(value(points, 'fuel.retail_price', d, city('GLP')), 5.04);
    assert.equal(value(points, 'fuel.retail_price', '2026-10-26', city('GLP 25 lb cylinder')), 124.67);
    assert.equal(value(points, 'fuel.price', d, city('Bunker')), 26.99);
    assert.equal(value(points, 'fuel.price', d, city('AvGas')), 74.75);
    assert.equal(value(points, 'fuel.price', d, city('Jet A-1')), 53.79);
    assert.deepEqual([...new Set(points.map(p => p.unit))].sort(), ['GTQ/25lb', 'GTQ/gal', 'GTQ/lb']);
    // The exchange-rate column is not an energy price.
    assert.ok(!points.some(p => /USD/.test(p.unit)));
    // Only the newest 31 days are read; the snapshot keeps eight per series.
    assert.ok(points.every(p => p.period >= '2026-09-27' && p.period <= d));
  });

  it('rejects a changed table instead of guessing at columns', () => {
    const edit = (match, replace) => sheetRows().map(row => row.map(v => (v === match ? replace : v)));
    assert.throws(() => parseMemPriceRows(edit('Gasolina Regular', 'Gasolina Normal')), /Changed MEM price header/);
    assert.throws(() => parseMemPriceRows(edit('GTQ/LB', 'GTQ/KG')), /Changed MEM price header/);
    assert.throws(() => parseMemPriceRows(edit('PRECIOS  PROMEDIO MONITOREADOS EN CIUDAD CAPITAL', 'PRECIOS PROMEDIO NACIONALES')), /Changed MEM price area/);
    assert.throws(() => parseMemPriceRows(edit(34.49, 'n/d')), /Invalid energy measurement/);
    assert.throws(() => parseMemPriceRows(edit(126, -126)), /Invalid MEM price/);
    assert.throws(() => parseMemPriceRows(sheetRows().filter(row => !(row[0] instanceof Date))), /No MEM price rows/);
    // A stray blank row inside the table does not hide the newer days below it.
    const rows = sheetRows();
    rows.splice(rows.findIndex(row => row[0] instanceof Date) + 5, 0, []);
    assert.equal(value(parseMemPriceRows(rows), 'fuel.retail_price', '2026-10-28', city('Gasolina Superior')), 34.49);
  });

  it('finds the newest upload of the month by suffix and reads only upload files', async () => {
    const bytes = await workbook();
    const oct = n => memWorkbookUrl(2026, 10, 2026, n);
    assert.equal(oct(0), 'https://mem.gob.gt/wp-content/uploads/2026/10/Precios-Promedio-Nacionales-Diarios-2026.xlsx');
    assert.equal(oct(3), 'https://mem.gob.gt/wp-content/uploads/2026/10/Precios-Promedio-Nacionales-Diarios-2026-3.xlsx');
    const files = { [oct(0)]: 'old', [oct(1)]: 'old', [oct(2)]: 'old', [oct(3)]: bytes };
    const { fetchFn, calls } = uploads(files);
    // Nothing uploaded yet in November: fall back to October's newest file.
    const data = await fetchRegionalEnergyFeed('mem', { fetchFn, nowMs: Date.parse('2026-11-01T12:00:00Z') });
    assert.equal(data.dataUrls.at(-1), oct(3));
    assert.equal(data.observedAt, '2026-10-28T00:00:00.000Z');
    assert.ok(calls.every(c => c.url.startsWith('https://mem.gob.gt/wp-content/uploads/')), 'MEM pages and REST API are never requested');
    assert.deepEqual(calls.filter(c => c.method === 'GET').map(c => c.url), [oct(3)]);
    assert.equal(regionalEnergyContentMeta(data, Date.parse('2026-11-01T12:00:00Z')).newestItemAt, Date.parse('2026-10-28T00:00:00Z'));

    // A November upload wins, and October is not probed.
    const nov = memWorkbookUrl(2026, 11, 2026, 0);
    const later = uploads({ ...files, [nov]: bytes });
    const current = await fetchRegionalEnergyFeed('mem', { fetchFn: later.fetchFn, nowMs: Date.parse('2026-11-03T18:00:00Z') });
    assert.equal(current.dataUrls.at(-1), nov);
    assert.ok(!later.calls.some(c => c.url.includes('/2026/10/')));
  });

  it('fails on a challenged upload instead of reading it as missing', async () => {
    const oct = memWorkbookUrl(2026, 10, 2026, 0);
    const { fetchFn } = uploads({}, { [memWorkbookUrl(2026, 11, 2026, 0)]: new Response('', { status: 403 }), [oct]: new Response(null) });
    await assert.rejects(fetchRegionalEnergyFeed('mem', { fetchFn, nowMs: Date.parse('2026-11-01T12:00:00Z') }), /mem provider HTTP 403/);
    await assert.rejects(fetchRegionalEnergyFeed('mem', { fetchFn: uploads({}).fetchFn, nowMs: Date.parse('2026-11-01T12:00:00Z') }), /Missing MEM daily price workbook/);
  });
});

describe('forward-dated sources', () => {
  it('only feeds that publish ahead may drop future periods; others still reject them', () => {
    const future = [{ metric: 'demand', period: '2026-11-01T05:00:00.000Z', value: 1, unit: 'MW', area: 'SEIN' }];
    assert.throws(() => buildFeedSnapshot('cammesa', future, 'https://x', Date.parse('2026-10-31T17:22:00Z')), /Invalid regional energy observation/);
  });

  it('rejects a PDF whose text item count would make cell matching quadratic', async () => {
    // A one-page PDF with 5,001 text runs; pdfjs rebuilds the missing xref.
    const runs = Array.from({ length: 5001 }, (_, i) => `BT /F1 4 Tf ${i % 100} ${Math.floor(i / 100)} Td (a) Tj ET`).join('\n');
    const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${runs.length} >> stream
${runs}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
    await assert.rejects(pdfItems(Buffer.from(pdf, 'latin1')), /text item budget/);
  });
});
