import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing__ as healthTesting } from '../api/health.js';
import {
  IMD_BULLETIN_PRODUCT_IDS,
  IMD_CANONICAL_KEY,
  IMD_MAX_CONTENT_AGE_MIN,
  IMD_PAGE_DELAY_MS,
  IMD_PRODUCTS,
  IMD_PRODUCT_IDS,
  IMD_RIGHTS_DECISION,
  IMD_SEA_BULLETIN_PAGE,
  assembleImdSnapshot,
  declareImdRecords,
  fetchImdBulletinPage,
  fetchImdCycloneMarine,
  imdAfterPublish,
  imdContentMeta,
  isAllowedImdUrl,
  isNilText,
  parseImdBulletinHtml,
  parseImdKeralaPdfText,
  shouldActivateImdSnapshot,
  stripNonContentBlocks,
  validateImdEnvelope,
} from '../scripts/lib/imd-cyclone-marine.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => readFileSync(join(root, 'tests/fixtures/imd', name), 'utf8');
const pageFixture = (productId, pageKey) => fixture(`${productId}-${pageKey}.html`);
const ALL_PAGES = IMD_BULLETIN_PRODUCT_IDS.flatMap((id) => IMD_PRODUCTS[id].pages.map((page) => ({ id, page })));
const HOUR = 60 * 60 * 1000;
// The captured bulletins are valid 09/10 to 21/22 UTC on 2026-10-16.
const NOW = Date.parse('2026-10-16T11:00:00Z');
const AFTER_EXPIRY = Date.parse('2026-10-16T23:00:00Z');

function parsedResults(overrides = {}) {
  const results = {};
  for (const { id, page } of ALL_PAGES) {
    results[id] ??= {};
    results[id][page.key] = overrides[id]?.[page.key]
      ?? { status: 'parsed', bulletin: parseImdBulletinHtml(pageFixture(id, page.key), id) };
  }
  return results;
}

function parseCode(html, productId) {
  try {
    parseImdBulletinHtml(html, productId);
  } catch (err) {
    return err.code;
  }
  return 'PARSED';
}

function bulletinLinks(indexHtml) {
  const base = 'https://mausam.imd.gov.in/responsive/marine_forecast.php';
  return [...indexHtml.matchAll(/href="([^"]*(?:seaarea|coastal)_bulletin_[a-z]+\.php[^"]*)"/g)]
    .map((match) => new URL(match[1], base).href);
}

test('the page registry matches the bulletin links on the captured IMD index pages', () => {
  const links = new Set([
    ...bulletinLinks(fixture('marine-forecast-index.html')),
    ...bulletinLinks(fixture('coastal-forecast-index.html')),
  ]);
  const registered = ALL_PAGES.map(({ page }) => page.url);
  for (const url of registered) assert.ok(links.has(url), `${url} is not linked from an IMD index page`);
  const navtex = [...links].filter((url) => url.includes('coastal_bulletin_navtex.php'));
  assert.equal(navtex.length, 7, 'NAVTEX copies are linked and deliberately excluded');
  assert.deepEqual([...links].filter((url) => !navtex.includes(url)).sort(), [...registered].sort());
});

test('parses the header, validity window, and areas of every captured bulletin page', () => {
  const expected = {
    'seaBulletin/bay-of-bengal': ['ACWC KOLKATA', '2026-10-16T08:02:00.000Z', '2026-10-16T09:00:00.000Z', '2026-10-16T21:00:00.000Z', 8],
    'seaBulletin/arabian-sea': ['ACWC MUMBAI', '2026-10-16T09:17:00.000Z', '2026-10-16T09:00:00.000Z', '2026-10-16T21:00:00.000Z', 8],
    'coastalBulletin/west-bengal-andaman-nicobar': ['ACWC KOLKATA', '2026-10-16T08:03:00.000Z', '2026-10-16T09:00:00.000Z', '2026-10-16T21:00:00.000Z', 2],
    'coastalBulletin/kerala-karnataka-lakshadweep': ['CWC THIRUVANANTHAPURAM', '2026-10-16T06:16:00.000Z', '2026-10-16T10:00:00.000Z', '2026-10-16T22:00:00.000Z', 4],
    'coastalBulletin/gujarat': ['CWC AHMEDABAD', '2026-10-16T07:10:00.000Z', '2026-10-16T10:00:00.000Z', '2026-10-16T22:00:00.000Z', 2],
    'coastalBulletin/maharashtra-goa': ['ACWC MUMBAI', '2026-10-16T08:59:00.000Z', '2026-10-16T10:00:00.000Z', '2026-10-16T22:00:00.000Z', 2],
    'coastalBulletin/odisha': ['CWC BHUBANESWAR', '2026-10-16T07:44:00.000Z', '2026-10-16T10:00:00.000Z', '2026-10-16T22:00:00.000Z', 2],
    'coastalBulletin/tamil-nadu': ['ACWC CHENNAI', '2026-10-16T09:32:00.000Z', '2026-10-16T10:00:00.000Z', '2026-10-16T22:00:00.000Z', 2],
    'coastalBulletin/andhra-pradesh': ['CWC VISAKHAPATANAM PORT', '2026-10-16T08:01:00.000Z', '2026-10-16T09:00:00.000Z', '2026-10-16T21:00:00.000Z', 2],
  };
  assert.equal(Object.keys(expected).length, ALL_PAGES.length);
  for (const { id, page } of ALL_PAGES) {
    const bulletin = parseImdBulletinHtml(pageFixture(id, page.key), id);
    const [issuedBy, issuedAt, validFrom, validUntil, areaCount] = expected[`${id}/${page.key}`];
    assert.equal(bulletin.issuedBy, issuedBy, page.key);
    assert.equal(new Date(bulletin.issuedAt).toISOString(), issuedAt, page.key);
    assert.equal(new Date(bulletin.validFrom).toISOString(), validFrom, page.key);
    assert.equal(new Date(bulletin.validUntil).toISOString(), validUntil, page.key);
    assert.equal(bulletin.validityHours, 12, page.key);
    assert.equal(bulletin.areas.length, areaCount, page.key);
  }
});

test('keeps sea-area wind, weather, visibility, sea state and the bulletin storm-warning line', () => {
  const snapshot = assembleImdSnapshot({ pageResults: parsedResults(), now: NOW });
  const southWestBay = snapshot.seaBulletins.find((row) => row.area === 'South West Bay');
  assert.deepEqual({
    id: southWestBay.id,
    page: southWestBay.page,
    wind: southWestBay.wind,
    weather: southWestBay.weather,
    visibility: southWestBay.visibility,
    seaCondition: southWestBay.seaCondition,
    tttWarning: southWestBay.tttWarning,
    hasTttWarning: southWestBay.hasTttWarning,
    synopticSituation: southWestBay.synopticSituation,
    sourceUrl: southWestBay.sourceUrl,
  }, {
    id: 'imd-seaBulletin-bay-of-bengal-south-west-bay-2026101609',
    page: 'bay-of-bengal',
    wind: 'South to Southwesterly, 10 - 15 kts gusting 20 kts',
    weather: 'Fairly widespread rain or thundershowers with isolated heavy rain',
    visibility: 'Moderate becoming Poor in heavy rain/thundershower',
    seaCondition: 'Smooth to Slight occasionally Moderate',
    tttWarning: 'No Storm Warning.',
    hasTttWarning: false,
    synopticSituation: 'Weather seasonal over Bay of Bengal and Andaman sea.',
    sourceUrl: 'https://mausam.imd.gov.in/Forecast/seaarea_bulletin_new.php?id=1',
  });
  const arabian = snapshot.seaBulletins.filter((row) => row.page === 'arabian-sea');
  assert.equal(arabian.length, 8);
  assert.ok(arabian.every((row) => row.tttWarning === 'NIL' && row.hasTttWarning === false));
  assert.match(arabian[0].synopticSituation, /^The upper air cyclonic circulation over southeast Arabian Sea/);
  assert.ok(snapshot.records.every((row) => Array.isArray(row.centroid)), 'every captured area has a gazetteer centroid');
});

test('reads coastal port signals and storm-surge lines without treating NIL as a warning', () => {
  const snapshot = assembleImdSnapshot({ pageResults: parsedResults(), now: NOW });
  const karnataka = snapshot.coastalBulletins.find((row) => row.area === 'Karnataka coast');
  assert.equal(karnataka.portSignal, 'NIL AT ALL PORTS');
  assert.equal(karnataka.hasPortSignal, false);
  assert.equal(karnataka.stormSurgeWarning, 'NIL');
  assert.equal(karnataka.hasStormSurgeWarning, false);
  assert.ok(snapshot.coastalBulletins.every((row) => row.hasPortSignal === false));

  const andaman = snapshot.coastalBulletins.find((row) => row.area === 'Andaman area');
  assert.equal(andaman.hasStormSurgeWarning, true);
  assert.match(andaman.stormSurgeWarning, /^SWELL WAVES IN THE RANGE OF 15\.0 - 19\.0 SEC PERIOD/);
  const surgeAlerts = snapshot.marineBulletins.filter((row) => row.severity !== 'Minor');
  assert.deepEqual(surgeAlerts.map((row) => [row.areaDesc, row.severity]), [['Andaman area', 'Moderate']]);
  assert.match(surgeAlerts[0].headline, /^Andaman area: Storm surge\/tidal: SWELL WAVES/);
  assert.match(surgeAlerts[0].description.slice(0, 300), /^Storm surge\/tidal: SWELL WAVES/, 'the warning leads the popup text');
  assert.equal(snapshot.products.coastalBulletin.warningCount, 1);
  assert.equal(snapshot.products.seaBulletin.warningCount, 0);
});

test('a storm warning or port signal on the page becomes a severe marine alert', () => {
  const sea = pageFixture('seaBulletin', 'bay-of-bengal')
    .replace('No Storm Warning.', 'Deep Depression over southwest Bay of Bengal. Storm warning for all areas.');
  const coastal = pageFixture('coastalBulletin', 'andhra-pradesh')
    .replace('NIL AT ALL PORTS.', 'DC-III HOISTED AT VISAKHAPATNAM AND KAKINADA PORTS.');
  const snapshot = assembleImdSnapshot({
    now: NOW,
    pageResults: parsedResults({
      seaBulletin: { 'bay-of-bengal': { status: 'parsed', bulletin: parseImdBulletinHtml(sea, 'seaBulletin') } },
      coastalBulletin: { 'andhra-pradesh': { status: 'parsed', bulletin: parseImdBulletinHtml(coastal, 'coastalBulletin') } },
    }),
  });
  const storm = snapshot.marineBulletins.filter((row) => row.headline.includes('Storm warning for all areas'));
  assert.equal(storm.length, 8);
  assert.ok(storm.every((row) => row.severity === 'Severe' && row.event === 'IMD Sea Area Bulletin'));
  const port = snapshot.marineBulletins.filter((row) => row.description.includes('Port signal: DC-III'));
  assert.deepEqual(port.map((row) => [row.areaDesc, row.severity]), [['North Andhra coast', 'Severe']]);
  assert.equal(port[0].headline, 'North Andhra coast: Port signal: DC-III HOISTED AT VISAKHAPATNAM AND KAKINADA PORTS.');
  assert.match(port[0].description, /Weather: /, 'a warning-led alert keeps its weather text');
  assert.equal(snapshot.products.seaBulletin.warningCount, 8);
  assert.equal(snapshot.products.coastalBulletin.warningCount, 2);
});

test('every active warning is named inside the popup text, even behind a long one', () => {
  const longSignal = `DC-III HOISTED AT ${'PARADIP, GOPALPUR, '.repeat(20)}PURI.`;
  const coastal = pageFixture('coastalBulletin', 'west-bengal-andaman-nicobar').replace('NIL.', longSignal);
  const snapshot = assembleImdSnapshot({
    now: NOW,
    pageResults: parsedResults({
      coastalBulletin: { 'west-bengal-andaman-nicobar': { status: 'parsed', bulletin: parseImdBulletinHtml(coastal, 'coastalBulletin') } },
    }),
  });
  const andaman = snapshot.marineBulletins.find((row) => row.areaDesc === 'Andaman area');
  assert.ok(longSignal.length > 300);
  assert.equal(andaman.severity, 'Severe');
  assert.match(andaman.headline, /^Andaman area: Port signal: DC-III/);
  assert.match(andaman.description.slice(0, 300), /^Active: Port signal, Storm surge\/tidal · Port signal: DC-III/);
  assert.match(andaman.description, /Storm surge\/tidal: SWELL WAVES/);
});

test('isNilText accepts the NIL spellings IMD prints and nothing else', () => {
  for (const text of ['NIL', 'NIL.', 'NIL AT ALL PORTS', 'NIL AT ALL PORTS.', 'No Storm Warning.', ' nil ', '']) {
    assert.equal(isNilText(text), true, text);
  }
  for (const text of ['DC-III', 'Nilgiris coast warning', 'No storm warning for north areas; warning for south', 'Cyclone']) {
    assert.equal(isNilText(text), false, text);
  }
});

test('a changed page layout fails closed with the first structural check it breaks', () => {
  const sea = pageFixture('seaBulletin', 'bay-of-bengal');
  const coastal = pageFixture('coastalBulletin', 'kerala-karnataka-lakshadweep');
  const cases = [
    ['valid bulletin', sea, 'seaBulletin', 'PARSED'],
    ['wrong product title', coastal, 'seaBulletin', 'BULLETIN_TITLE_MISSING'],
    ['no validity line', sea.replace('Bulletin Valid for 12 hrs', 'Bulletin issued'), 'seaBulletin', 'BULLETIN_VALIDITY_MISSING'],
    ['inconsistent window', sea.replace('to 21 UTC', 'to 22 UTC'), 'seaBulletin', 'BULLETIN_VALIDITY_INCONSISTENT'],
    ['impossible date', sea.replaceAll('UTC of 2026-10-16', 'UTC of 2026-02-30'), 'seaBulletin', 'BULLETIN_VALIDITY_INCONSISTENT'],
    ['no issue time', sea.replace('13:32 IST of 2026-10-16', 'pending'), 'seaBulletin', 'BULLETIN_ISSUE_TIME_MISSING'],
    ['no storm warning row', sea.replace('TTT Warning', 'Remarks'), 'seaBulletin', 'BULLETIN_STORM_WARNING_MISSING'],
    ['no synoptic row', sea.replace('Synoptic Situation', 'Outlook'), 'seaBulletin', 'BULLETIN_SYNOPTIC_MISSING'],
    ['no issuing office', sea.replace('ACWC KOLKATA', 'Regional Centre'), 'seaBulletin', 'BULLETIN_OFFICE_MISSING'],
    ['area without wind', sea.replace('<td class="td-1">Wind</td>', '<td class="td-1">Breeze</td>'), 'seaBulletin', 'BULLETIN_AREA_INCOMPLETE'],
    ['coastal area without port signal', coastal.replace('Port Signal', 'Port Note'), 'coastalBulletin', 'BULLETIN_AREA_INCOMPLETE'],
    ['nested table', sea.replace('<td >Smooth</td>', '<td ><table><tr><td>x</td></tr></table></td>'), 'seaBulletin', 'BULLETIN_NESTED_TABLE'],
    ['no tables', sea.replace(/<table[\s\S]*<\/table>/, ''), 'seaBulletin', 'BULLETIN_AREAS_MISSING'],
    ['oversized field', sea.replace('<td >Smooth</td>', `<td >${'x'.repeat(4_001)}</td>`), 'seaBulletin', 'BULLETIN_FIELD_TOO_LONG'],
    ['empty body', '', 'seaBulletin', 'BULLETIN_AREAS_MISSING'],
  ];
  for (const [label, html, productId, code] of cases) {
    assert.equal(parseCode(html, productId), code, label);
  }
});

test('decodes entities and ignores commented-out markup inside the bulletin', () => {
  const html = pageFixture('seaBulletin', 'bay-of-bengal')
    .replace('<td >Smooth</td>', '<td >Smooth&nbsp;&amp; calm&#46;</td>')
    .replace('<!-- Layer -->', '<!-- <table class="tr"><caption>Old Area</caption><tr><td>Wind</td><td>x</td></tr></table> -->');
  const bulletin = parseImdBulletinHtml(html, 'seaBulletin');
  assert.equal(bulletin.areas.find((area) => area.name === 'South East Bay').seaCondition, 'Smooth & calm.');
  assert.equal(bulletin.areas.some((area) => area.name === 'Old Area'), false);
  assert.equal(bulletin.areas.length, 8);
});

test('strips comments and script/style blocks completely, including nested and split openers', () => {
  const cases = [
    ['plain comment', 'a<!-- x -->b', 'ab'],
    ['script block', 'a<SCRIPT type="x">alert(1)</script>b', 'ab'],
    ['style block', 'a<style>td{}</STYLE>b', 'ab'],
    ['nested script opener', 'a<scr<script>x</script>ipt>alert(1)</script>b', 'ab'],
    ['nested comment opener reopens an unterminated comment', 'a<!<!---->--b', 'a'],
    ['comment rebuilt around a script', 'a<!-<script></script>- x -->b', 'ab'],
    ['unterminated comment drops the rest', 'a<!-- never closed <table>', 'a'],
    ['unterminated script drops the rest', 'a<script>never closed', 'a'],
    ['tag-name boundary is respected', 'a<scripts>b</scripts>', 'a<scripts>b</scripts>'],
    ['non-ASCII text keeps its indexes', 'İ<!-- x -->İ', 'İİ'],
  ];
  for (const [label, input, expected] of cases) {
    const out = stripNonContentBlocks(input);
    assert.equal(out, expected, label);
    assert.doesNotMatch(out, /<!--|<script\b|<style\b/i, label);
  }
  assert.equal(stripNonContentBlocks(null), '');
});

test('an expired page publishes no records but still proves IMD replied', () => {
  const snapshot = assembleImdSnapshot({ pageResults: parsedResults(), now: AFTER_EXPIRY });
  assert.equal(snapshot.coverageState, 'ok');
  assert.equal(snapshot.seaBulletins.length + snapshot.coastalBulletins.length, 0);
  assert.equal(snapshot.products.seaBulletin.pages['bay-of-bengal'].status, 'expired');
  assert.equal(snapshot.products.coastalBulletin.emptyMeans, 'no-current-bulletin');
  assert.equal(shouldActivateImdSnapshot(snapshot), true);
  assert.equal(validateImdEnvelope(snapshot), true);
  assert.deepEqual(imdContentMeta(snapshot, AFTER_EXPIRY), {
    newestItemAt: Date.parse('2026-10-16T09:32:00Z'),
    oldestItemAt: Date.parse('2026-10-16T06:16:00Z'),
  });
});

test('rejects a future-dated bulletin instead of publishing it as current', () => {
  const early = Date.parse('2026-10-15T20:00:00Z');
  const snapshot = assembleImdSnapshot({ pageResults: parsedResults(), now: early });
  assert.equal(snapshot.coverageState, 'unavailable');
  assert.deepEqual(snapshot.products.seaBulletin.pages['bay-of-bengal'], { status: 'failed', reason: 'BULLETIN_FUTURE_DATED' });
  assert.equal(snapshot.records.length, 0);
  assert.equal(shouldActivateImdSnapshot(snapshot), false);

  const previous = assembleImdSnapshot({ pageResults: parsedResults(), now: NOW });
  const misdated = pageFixture('seaBulletin', 'bay-of-bengal').replaceAll('UTC of 2026-10-16', 'UTC of 2026-10-18');
  const carried = assembleImdSnapshot({
    previous,
    now: NOW + HOUR,
    pageResults: parsedResults({
      seaBulletin: { 'bay-of-bengal': { status: 'parsed', bulletin: parseImdBulletinHtml(misdated, 'seaBulletin') } },
    }),
  });
  assert.deepEqual(carried.products.seaBulletin.pages['bay-of-bengal'], { status: 'failed', reason: 'BULLETIN_FUTURE_DATED' });
  assert.equal(carried.products.seaBulletin.carried, true);
  assert.deepEqual(
    carried.seaBulletins.filter((row) => row.page === 'bay-of-bengal'),
    previous.seaBulletins.filter((row) => row.page === 'bay-of-bengal'),
    'a misdated page keeps its still-valid last-good bulletin',
  );
});

test('a failed page carries only its own last-good records', () => {
  const previous = assembleImdSnapshot({ pageResults: parsedResults(), now: NOW });
  const later = NOW + HOUR;
  const snapshot = assembleImdSnapshot({
    previous,
    now: later,
    pageResults: parsedResults({ coastalBulletin: { odisha: { status: 'failed', reason: 'BULLETIN_AREA_INCOMPLETE' } } }),
  });
  assert.equal(snapshot.coverageState, 'degraded');
  assert.deepEqual(snapshot.failedProducts, ['coastalBulletin']);
  assert.equal(snapshot.products.coastalBulletin.status, 'partial');
  assert.equal(snapshot.products.coastalBulletin.carried, true);
  assert.deepEqual(snapshot.products.coastalBulletin.pages.odisha, { status: 'failed', reason: 'BULLETIN_AREA_INCOMPLETE' });
  assert.equal(snapshot.products.seaBulletin.status, 'ok');
  assert.deepEqual(
    snapshot.coastalBulletins.filter((row) => row.page === 'odisha'),
    previous.coastalBulletins.filter((row) => row.page === 'odisha'),
  );
  assert.equal(snapshot.coastalBulletins.length, previous.coastalBulletins.length);
  assert.deepEqual(imdAfterPublish(snapshot).freshnessMetaPatch, {
    sourceState: 'degraded',
    errorCode: 'IMD_PRODUCT_PARTIAL',
    failedProducts: ['coastalBulletin'],
    coverageState: 'degraded',
  });

  const expiredCarry = assembleImdSnapshot({
    previous,
    now: AFTER_EXPIRY,
    pageResults: parsedResults({ coastalBulletin: { odisha: { status: 'failed', reason: 'HTTP 503' } } }),
  });
  assert.equal(expiredCarry.coastalBulletins.length, 0, 'last-good past its validity window is not carried');
  assert.equal(expiredCarry.products.coastalBulletin.carried, false);
});

test('a run where every page fails is unavailable and does not activate, even with carried records', () => {
  const failed = {};
  for (const { id, page } of ALL_PAGES) {
    failed[id] ??= {};
    failed[id][page.key] = { status: 'failed', reason: 'IMD_FETCH_FAILED' };
  }
  const previous = assembleImdSnapshot({ pageResults: parsedResults(), now: NOW });
  const snapshot = assembleImdSnapshot({ pageResults: failed, previous, now: NOW + HOUR });
  assert.equal(snapshot.coverageState, 'unavailable');
  assert.equal(snapshot.records.length, previous.records.length);
  assert.equal(shouldActivateImdSnapshot(snapshot), false);
  assert.equal(imdAfterPublish(snapshot).freshnessMetaPatch.errorCode, 'IMD_PRODUCTS_UNAVAILABLE');
});

test('API-only and PDF-only products are disabled with an explicit reason, not dropped', () => {
  const snapshot = assembleImdSnapshot({ pageResults: parsedResults(), now: NOW });
  assert.deepEqual(IMD_PRODUCT_IDS, [
    'cycloneTrack', 'cycloneWind', 'cycloneCou', 'portWarning', 'seaBulletin', 'coastalBulletin', 'fishermenWarning',
  ]);
  const disabled = Object.fromEntries(IMD_PRODUCT_IDS
    .filter((id) => snapshot.products[id].status === 'disabled')
    .map((id) => [id, snapshot.products[id].reason]));
  assert.deepEqual(disabled, {
    cycloneTrack: 'API_ONLY_COVERED_BY_GDACS',
    cycloneWind: 'API_ONLY_COVERED_BY_GDACS',
    cycloneCou: 'API_ONLY_COVERED_BY_GDACS',
    portWarning: 'PDF_ONLY_PORT_SIGNALS_IN_COASTAL_BULLETINS',
    fishermenWarning: 'PDF_ONLY',
  });
  for (const key of ['cyclones', 'windRadii', 'cones', 'portWarnings', 'fishermenWarnings', 'cycloneEvents', 'portAlerts']) {
    assert.deepEqual(snapshot[key], [], key);
  }
  assert.deepEqual(snapshot.rights, { ...IMD_RIGHTS_DECISION });
  assert.equal(snapshot.rights.commercialUse, 'rti-non-commercial-only');
  assert.equal(snapshot.sourceUrl, IMD_SEA_BULLETIN_PAGE);
});

test('a quiet run with no warnings is ok and reports healthy', () => {
  const snapshot = assembleImdSnapshot({ pageResults: parsedResults(), now: NOW });
  assert.equal(snapshot.coverageState, 'ok');
  assert.equal(snapshot.products.seaBulletin.warningCount, 0);
  assert.deepEqual(imdAfterPublish(snapshot).freshnessMetaPatch, { sourceState: 'ok', coverageState: 'ok' });

  const { SEED_META, STANDALONE_KEYS, STATUS_COUNTS, classifyKey } = healthTesting;
  const name = 'imdCycloneMarine';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const classify = (data, now) => classifyKey(name, dataKey, { allowOnDemand: true }, {
    keyStrens: new Map([[dataKey, 4096]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify({
      fetchedAt: now,
      recordCount: declareImdRecords(data),
      ...imdAfterPublish(data).freshnessMetaPatch,
      ...imdContentMeta(data, now),
      maxContentAgeMin: IMD_MAX_CONTENT_AGE_MIN,
    })]]),
    keyMetaErrors: new Map(),
    activationStates: new Map([[name, true]]),
    now,
  });
  const quiet = classify(snapshot, NOW);
  assert.equal(quiet.status, 'OK');
  assert.equal(STATUS_COUNTS[quiet.status], 'ok');
  const between = classify(assembleImdSnapshot({ pageResults: parsedResults(), now: AFTER_EXPIRY }), AFTER_EXPIRY);
  assert.equal(between.status, 'OK', 'a gap between bulletin windows is not an alarm');
  const broken = classify(assembleImdSnapshot({
    previous: snapshot,
    pageResults: parsedResults({ seaBulletin: { 'arabian-sea': { status: 'failed', reason: 'HTTP 503' } } }),
    now: NOW,
  }), NOW);
  assert.notEqual(STATUS_COUNTS[broken.status], 'ok', 'an unreadable page is a real fault');
});

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
}

test('the seeder fetch path reads every registered page in sequence with a User-Agent and pacing', async () => {
  const byUrl = new Map(ALL_PAGES.map(({ id, page }) => [page.url, pageFixture(id, page.key)]));
  const requests = [];
  const sleeps = [];
  const fetchFn = async (url, init) => {
    requests.push({ url, init });
    assert.equal(sleeps.length, requests.length - 1, 'requests are paced, never concurrent');
    return htmlResponse(byUrl.get(url));
  };
  const snapshot = await fetchImdCycloneMarine({
    fetchFn,
    now: NOW,
    userAgent: 'WorldMonitorTest/1.0',
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(requests.map((request) => request.url), ALL_PAGES.map(({ page }) => page.url));
  assert.ok(requests.every(({ init }) => init.headers['User-Agent'] === 'WorldMonitorTest/1.0'));
  assert.ok(requests.every(({ init }) => init.redirect === 'error' && init.signal instanceof AbortSignal));
  assert.deepEqual(sleeps, Array(ALL_PAGES.length - 1).fill(IMD_PAGE_DELAY_MS));
  assert.equal(snapshot.coverageState, 'ok');
  assert.equal(validateImdEnvelope(snapshot), true);
  assert.equal(declareImdRecords(snapshot), 32);
  assert.equal(snapshot.marineBulletins.length, 32);
  assert.equal(shouldActivateImdSnapshot(snapshot), true);
  assert.equal(JSON.parse(JSON.stringify(snapshot)).seaBulletins.length, 16);
});

test('transport failures fail the page with a bounded reason', async () => {
  const page = IMD_PRODUCTS.seaBulletin.pages[0];
  const run = (fetchFn, options = {}) => fetchImdBulletinPage('seaBulletin', page, { fetchFn, ...options });
  assert.deepEqual(await run(async () => htmlResponse('down', 503)), { status: 'failed', reason: 'HTTP 503' });
  assert.deepEqual(await run(async () => { throw new TypeError('fetch failed: secret-host'); }), { status: 'failed', reason: 'IMD_FETCH_FAILED' });
  assert.deepEqual(await run(async () => { throw new DOMException('timed out', 'TimeoutError'); }), { status: 'failed', reason: 'IMD_FETCH_TIMEOUT' });
  assert.deepEqual(
    await run(async () => htmlResponse(pageFixture('seaBulletin', 'bay-of-bengal')), { maxBytes: 1_000 }),
    { status: 'failed', reason: 'BULLETIN_RESPONSE_TOO_LARGE' },
  );
  assert.deepEqual(await run(async () => htmlResponse('<html>login</html>')), { status: 'failed', reason: 'BULLETIN_AREAS_MISSING' });
  let called = false;
  const untrusted = await fetchImdBulletinPage('seaBulletin', { key: 'x', url: 'https://evil.example/seaarea.php' }, {
    fetchFn: async () => { called = true; },
  });
  assert.deepEqual(untrusted, { status: 'failed', reason: 'UNTRUSTED_SOURCE_HOST' });
  assert.equal(called, false);
});

test('allows only https mausam.imd.gov.in bulletin URLs', () => {
  assert.equal(isAllowedImdUrl('https://mausam.imd.gov.in/Forecast/seaarea_bulletin_new.php?id=1'), true);
  for (const url of [
    'http://mausam.imd.gov.in/Forecast/seaarea_bulletin_new.php?id=1',
    'https://api.imd.gov.in/api/v1/seabulletin',
    'https://mausam.imd.gov.in.evil.example/',
    'https://user:pass@mausam.imd.gov.in/',
    'https://mausam.imd.gov.in:8443/',
    'not a url',
  ]) {
    assert.equal(isAllowedImdUrl(url), false, url);
  }
  assert.ok(ALL_PAGES.every(({ page }) => isAllowedImdUrl(page.url)));
});

test('validateImdEnvelope rejects records without a usable validity window', () => {
  const snapshot = assembleImdSnapshot({ pageResults: parsedResults(), now: NOW });
  assert.equal(validateImdEnvelope(snapshot), true);
  const [first, ...rest] = snapshot.seaBulletins;
  for (const broken of [{ validFrom: null }, { expiresAt: first.validFrom }, { issuedAt: undefined }, { area: '' }]) {
    assert.equal(validateImdEnvelope({ ...snapshot, seaBulletins: [{ ...first, ...broken }, ...rest] }), false, JSON.stringify(broken));
  }
  const { coastalBulletin: _dropped, ...products } = snapshot.products;
  assert.equal(validateImdEnvelope({ ...snapshot, products }), false);
  assert.equal(validateImdEnvelope({ ...snapshot, cones: null }), false);
});

test('the seeder publishes to its own key with no API credentials or proxy', () => {
  const seeder = readFileSync(join(root, 'scripts/seed-imd-cyclone-marine.mjs'), 'utf8');
  const lib = readFileSync(join(root, 'scripts/lib/imd-cyclone-marine.mjs'), 'utf8');
  assert.equal(IMD_CANONICAL_KEY, 'weather:imd-cyclone-marine:v1');
  assert.match(seeder, /runSeed\('weather', 'imd-cyclone-marine', IMD_CANONICAL_KEY/);
  assert.match(seeder, /seed-activated:weather:imd-cyclone-marine:v2/);
  assert.match(seeder, /shouldActivateImdSnapshot\(data\)/);
  for (const source of [seeder, lib]) {
    assert.doesNotMatch(source, /IMD_API_KEY|IMD_API_EMAIL|IMD_API_PASSWORD|PROXY_URL|_proxy-utils|oauth/);
  }
  const registry = JSON.parse(readFileSync(join(root, 'scripts/railway-services.json'), 'utf8'));
  const service = registry.find((entry) => entry.service === 'seed-imd-cyclone-marine');
  assert.deepEqual(service.requiredEnv, ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']);
});

test('a complete official Kerala PDF recovers an incomplete HTML bulletin without renewing its source clocks', async (t) => {
  const kerala = IMD_PRODUCTS.coastalBulletin.pages.find((page) => page.key === 'kerala-karnataka-lakshadweep');
  const fallbackUrl = 'https://mausam.imd.gov.in/thiruvananthapuram/mcdata/coastal%20bulletin.pdf';
  const pdf = readFileSync(join(root, 'tests/fixtures/imd/coastalBulletin-kerala-20261021.pdf'));
  const requests = [];
  const sleeps = [];
  const timersAtSleep = [];
  const timeout = AbortSignal.timeout;
  let timerCount = 0;
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timerCount++;
    return timeout(ms);
  });
  const fetchFn = async (url) => {
    requests.push(url);
    if (url === fallbackUrl) return new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } });
    const entry = ALL_PAGES.find(({ page }) => page.url === url);
    return new Response(entry.page.key === kerala.key
      ? fixture('coastalBulletin-kerala-missing-synoptic.html')
      : pageFixture(entry.id, entry.page.key));
  };
  const snapshot = await fetchImdCycloneMarine({ fetchFn, now: Date.parse('2026-10-21T18:30:00Z'), sleep: async (ms) => {
    timersAtSleep.push(timerCount);
    sleeps.push(ms);
  } });
  const rows = snapshot.coastalBulletins.filter((row) => row.page === kerala.key);
  assert.equal(rows.length, 4, 'recover all four complete official PDF areas');
  assert.equal(requests.filter((url) => url === fallbackUrl).length, 1);
  assert.deepEqual(sleeps, Array(requests.length - 1).fill(IMD_PAGE_DELAY_MS));
  assert.deepEqual(timersAtSleep, Array.from({ length: sleeps.length }, (_, index) => index + 1),
    'primary and fallback request timers start after their pacing waits');
  assert.equal(snapshot.products.coastalBulletin.requestCount, IMD_PRODUCTS.coastalBulletin.pages.length + 1);
  assert.equal(snapshot.products.coastalBulletin.pages[kerala.key].fallbackUsed, true);
  assert.equal(snapshot.products.coastalBulletin.pages[kerala.key].primaryFailure, 'BULLETIN_SYNOPTIC_MISSING');
  assert.equal(snapshot.products.coastalBulletin.pages[kerala.key].sourceUrl, fallbackUrl);
  for (const row of rows) {
    assert.equal(row.sourceUrl, fallbackUrl);
    assert.equal(row.issuedAt, Date.parse('2026-10-21T07:34:00Z'));
    assert.equal(row.validFrom, Date.parse('2026-10-21T10:00:00Z'));
    assert.equal(row.expiresAt, Date.parse('2026-10-21T22:00:00Z'));
    assert.match(row.synopticSituation, /^THE WELL MARKED LOW PRESSURE AREA/);
  }
  assert.equal(rows.find((row) => row.area === 'North Kerala coast').portSignal, 'LC III.');
  const expired = await fetchImdCycloneMarine({ fetchFn, previous: snapshot, now: Date.parse('2026-10-21T22:00:00Z'), delayMs: 0 });
  assert.equal(expired.coastalBulletins.length, 0);
  assert.equal(expired.products.coastalBulletin.pages[kerala.key].status, 'expired');
});

test('the Kerala PDF adapter keeps all existing completeness and time checks', () => {
  const text = `CWC THIRUVANANTHAPURAM /
Coastal Weather Bulletin
Valid for 12 hrs from 10 UTC of 2026-10-21 to 22 UTC of 2026-10-21
Synoptic Situation
Weather seasonal.
${['Karnataka coast', 'North Kerala coast', 'South Kerala coast', 'Lakshadweep area'].map((area) => `${area}
Wind North 10 knots
Weather Fair
Visibility Good
Sea Condition Slight
Port Signal NIL
Storm Surge/Tidal Warning NIL`).join('\n')}
Time of Issue 13:04 IST of 2026-10-21`;
  assert.equal(parseImdKeralaPdfText(text).areas.length, 4);
  const cases = [
    [text.replace('Weather seasonal.', ''), 'BULLETIN_SYNOPTIC_MISSING'],
    [text.replace('North Kerala coast', 'Other coast'), 'BULLETIN_AREAS_MISSING'],
    [text.replace('Port Signal NIL\n', ''), 'BULLETIN_AREA_INCOMPLETE'],
    [text.replace('CWC THIRUVANANTHAPURAM', 'ACWC MUMBAI'), 'BULLETIN_OFFICE_MISSING'],
    [text.replace('to 22 UTC', 'to 23 UTC'), 'BULLETIN_VALIDITY_INCONSISTENT'],
    [text.replace('13:04 IST', 'pending'), 'BULLETIN_ISSUE_TIME_MISSING'],
    [text.replace('Wind North 10 knots', 'Wind North\nWind South'), 'BULLETIN_AREA_INCOMPLETE'],
    ['x'.repeat(64_001), 'BULLETIN_RESPONSE_TOO_LARGE'],
  ];
  for (const [input, code] of cases) assert.throws(() => parseImdKeralaPdfText(input), { code });
});

test('Kerala fallback rejects invalid responses and does not replace successful primary pages', async () => {
  const page = IMD_PRODUCTS.coastalBulletin.pages.find((entry) => entry.key === 'kerala-karnataka-lakshadweep');
  const broken = fixture('coastalBulletin-kerala-missing-synoptic.html');
  const pdf = readFileSync(join(root, 'tests/fixtures/imd/coastalBulletin-kerala-20261021.pdf'));
  const cases = [
    [() => new Response('unavailable', { status: 503 }), {}, 'HTTP 503'],
    [() => new Response('<html>not PDF</html>', { headers: { 'Content-Type': 'application/pdf' } }), {}, 'BULLETIN_PDF_INVALID'],
    [() => new Response('%PDF-invalid', { headers: { 'Content-Type': 'application/pdf' } }), {}, 'IMD_FETCH_FAILED'],
    [() => new Response(pdf, { headers: { 'Content-Type': 'text/html' } }), {}, 'BULLETIN_PDF_INVALID'],
    [() => new Response(pdf, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': '524289' } }), {}, 'BULLETIN_RESPONSE_TOO_LARGE'],
    [() => { throw new DOMException('timeout', 'TimeoutError'); }, {}, 'IMD_FETCH_TIMEOUT'],
    [() => new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } }), { maxBytes: 10_000 }, 'BULLETIN_RESPONSE_TOO_LARGE'],
  ];
  for (const [response, options, fallbackFailure] of cases) {
    const result = await fetchImdBulletinPage('coastalBulletin', page, {
      ...options,
      delayMs: 0,
      fetchFn: async (url, init) => {
        assert.equal(init.redirect, 'error');
        assert.ok(init.headers['User-Agent']);
        if (url === page.url) return new Response(broken);
        assert.equal(url, page.fallbackUrl);
        assert.equal(init.headers.Accept, 'application/pdf');
        return response();
      },
    });
    assert.deepEqual(result, { status: 'failed', reason: 'BULLETIN_SYNOPTIC_MISSING', fallbackFailure });
    const snapshot = assembleImdSnapshot({ pageResults: { coastalBulletin: { [page.key]: result } } });
    assert.equal(snapshot.products.coastalBulletin.requestCount, IMD_PRODUCTS.coastalBulletin.pages.length + 1);
    assert.equal(snapshot.products.coastalBulletin.pages[page.key].fallbackFailure, fallbackFailure);
    assert.equal(snapshot.coastalBulletins.length, 0);
  }
  let calls = 0;
  const good = await fetchImdBulletinPage('coastalBulletin', page, { fetchFn: async () => {
    calls++;
    return new Response(pageFixture('coastalBulletin', page.key));
  } });
  assert.equal(good.status, 'parsed');
  assert.equal(calls, 1);
  assert.equal(good.fallbackUsed, undefined);
});
