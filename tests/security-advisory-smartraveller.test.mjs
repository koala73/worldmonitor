// The Australian Smartraveller register must reach the advisory level index,
// and a seed that publishes without it must say so.
//
// Production stored no Smartraveller item for at least a month (every retained
// seeder run since 2026-09-23 logged `Australia DFAT Smartraveller: HTTP 404`
// or `503`), so `byCountry` carried US levels only. Three defects were stacked:
//   1. Transport: Smartraveller's Akamai edge never answers a request without an
//      Accept-Encoding header, and the relay sent none (covered in
//      tests/ais-relay-rss-ssrf-e2e.test.mjs).
//   2. Dates: every item's pubDate ends in AEST or AEDT, which Date cannot
//      parse, and the RangeError from toISOString() dropped the whole feed.
//   3. Levels: the feed numbers advice on a five-point scale where 1/5 is "No
//      travel advice", so 2/5..5/5 are normal..do-not-travel. The parser read
//      them one level too severe.
// The fixture is five items captured verbatim from the live feed on
// 2026-10-23, one per level.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ADVISORY_SOURCE_HEALTH_FIELD,
  advisoryAfterPublish,
  advisoryPublishTransform,
  buildByCountryMap,
  fetchAll,
  fetchFeed,
  mapFeedItems,
  parseAuLevel,
  parseRssItems,
  validateAdvisoryReport,
} from '../scripts/seed-security-advisories.mjs';
import { freshnessMetaDiagnosticsPatch } from '../scripts/_seed-utils.mjs';

const FIXTURE = readFileSync(new URL('./fixtures/smartraveller-advisories-2026-10-23.rss', import.meta.url), 'utf8');

const SMARTRAVELLER = {
  name: 'Australia DFAT Smartraveller',
  sourceCountry: 'AU',
  sourceCategory: 'travel-advisory',
  url: 'https://www.smartraveller.gov.au/countries/documents/index.rss',
  levelParser: 'au',
};
const STATE_DEPT = {
  name: 'US State Dept',
  sourceCountry: 'US',
  sourceCategory: 'travel-advisory',
  url: 'https://travel.state.gov/_res/rss/TAsTWs.xml',
  levelParser: 'us',
};
const CDC = {
  name: 'CDC Travel Notices',
  sourceCountry: 'US',
  sourceCategory: 'health',
  url: 'https://wwwnc.cdc.gov/travel/rss/notices.xml',
};

const respond = (body, status = 200) => async () => new Response(body, { status });

// 120 State Dept register items, enough to clear MIN_ADVISORY_COUNTRY_COVERAGE.
const COUNTRY_NAMES = Object.keys(JSON.parse(readFileSync(new URL('../scripts/shared/country-names.json', import.meta.url), 'utf8')));
const STATE_DEPT_RSS = `<rss><channel>${COUNTRY_NAMES.slice(0, 400).map((name, i) => (
  `<item><title>${name} - Level ${(i % 4) + 1}: Advisory</title><link>https://travel.state.gov/${i}</link><pubDate>Mon, 20 Oct 2026 00:00:00 GMT</pubDate></item>`
)).join('')}</channel></rss>`;

function routedFetch(routes) {
  return async (proxyUrl) => {
    const target = new URL(proxyUrl).searchParams.get('url');
    const handler = routes[target];
    return handler ? handler() : new Response('', { status: 404 });
  };
}

describe('Smartraveller register', () => {
  it('reads every captured item and indexes each advice level at its published label', async () => {
    const items = await fetchFeed(SMARTRAVELLER, respond(FIXTURE));
    assert.equal(items.length, 5, 'an AEST/AEDT pubDate must not drop the feed');

    const byCountry = buildByCountryMap(items);
    assert.deepEqual(byCountry, {
      GU: 'normal', // 2/5 "Exercise normal safety precautions"
      AM: 'caution', // 3/5 "Exercise a high degree of caution", text also says "Do not travel within 5km"
      MR: 'reconsider', // 4/5 "Reconsider your need to travel"
      LY: 'do-not-travel', // 5/5 "Do not travel"
    });

    const guam = items.find((item) => item.country === 'GU');
    assert.equal(guam.pubDate, '2026-10-20T12:00:00.000Z', '20 Oct 2026 23:00:00 AEDT is UTC+11');
    const armenia = items.find((item) => item.country === 'AM');
    assert.equal(armenia.pubDate, '2026-06-17T12:00:00.000Z', '17 Jun 2026 22:00:00 AEST is UTC+10');
  });

  it('maps the five-point scale when the label is missing, and never guesses a bare number', () => {
    assert.equal(parseAuLevel({ advisoryLevel: '5/5' }), 'do-not-travel');
    assert.equal(parseAuLevel({ advisoryLevel: '4/5' }), 'reconsider');
    assert.equal(parseAuLevel({ advisoryLevel: '3/5' }), 'caution');
    assert.equal(parseAuLevel({ advisoryLevel: '2/5' }), 'normal');
    assert.equal(parseAuLevel({ advisoryLevel: '1/5' }), 'info', '1/5 is "No travel advice"');
    assert.equal(parseAuLevel({ advisoryLevel: '4' }), 'info', 'a bare number names no scale');
  });

  // The normalizer used to turn the apostrophe into a space, so the longest
  // country key left in this title was "republic of korea" and North Korea's
  // do-not-travel landed on KR. Checked against both live registers
  // (2026-10-23): deleting apostrophes changes no other title's country.
  it('maps the North Korea title to KP, not South Korea', () => {
    const items = mapFeedItems([
      { title: "North Korea (Democratic People's Republic of Korea)", link: 'https://www.smartraveller.gov.au/destinations/asia/north-korea', advisoryLabel: 'Do not travel' },
      { title: 'South Korea (Republic of Korea)', link: 'https://www.smartraveller.gov.au/destinations/asia/south-korea', advisoryLabel: 'Exercise normal safety precautions' },
      { title: "Cote d'Ivoire", link: 'https://www.smartraveller.gov.au/destinations/africa/cote-divoire', advisoryLabel: 'Exercise a high degree of caution' },
    ], SMARTRAVELLER);
    assert.deepEqual(buildByCountryMap(items), { KP: 'do-not-travel', KR: 'normal', CI: 'caution' });
  });

  it('prefers the published label over the level number', () => {
    const [item] = parseRssItems(`<rss xmlns:ta="t" xmlns:dc="d"><channel><item>
      <title>Mauritania</title><link>https://www.smartraveller.gov.au/x</link>
      <description>We continue to advise reconsider your need to travel. Do not travel to the border areas.</description>
      <ta:warnings><ta:level>9/9</ta:level><dc:description>Reconsider your need to travel</dc:description></ta:warnings>
    </item></channel></rss>`);
    assert.equal(item.advisoryLabel, 'Reconsider your need to travel');
    assert.equal(parseAuLevel(item), 'reconsider');
  });
});

describe('advisory source health', () => {
  it('publishes a US-only index but names the missing register in seed-meta', async () => {
    const report = await fetchAll({
      feeds: [STATE_DEPT, SMARTRAVELLER, CDC],
      doFetch: routedFetch({
        [STATE_DEPT.url]: respond(STATE_DEPT_RSS),
        [SMARTRAVELLER.url]: respond('{"error":"Feed in backoff"}', 503),
        [CDC.url]: respond('<rss><channel></channel></rss>'),
      }),
    });
    const published = advisoryPublishTransform(report);
    assert.equal(validateAdvisoryReport(published), true, 'the US register alone still clears the coverage floor');
    assert.equal(published[ADVISORY_SOURCE_HEALTH_FIELD], undefined, 'diagnostics never reach the served payload');

    const { freshnessMetaPatch } = await advisoryAfterPublish(report);
    assert.deepEqual(freshnessMetaPatch, {
      sourceState: 'degraded',
      errorCode: 'ADVISORY_REGISTER_MISSING_AU',
      failedSources: ['AU'],
      emptyFeeds: ['Australia DFAT Smartraveller', 'CDC Travel Notices'],
    });
  });

  it('counts a register that parses but yields no level as missing', async () => {
    const unlevelled = FIXTURE.replace(/<ta:warnings>[\s\S]*?<\/ta:warnings>/g, '')
      .replace(/<description>[\s\S]*?<\/description>/g, '<description>See the website.</description>');
    const report = await fetchAll({
      feeds: [STATE_DEPT, SMARTRAVELLER],
      doFetch: routedFetch({ [STATE_DEPT.url]: respond(STATE_DEPT_RSS), [SMARTRAVELLER.url]: respond(unlevelled) }),
    });
    const { freshnessMetaPatch } = await advisoryAfterPublish(report);
    assert.equal(freshnessMetaPatch.errorCode, 'ADVISORY_REGISTER_MISSING_AU');
    assert.deepEqual(freshnessMetaPatch.emptyFeeds, [], 'the feed returned items, none of them levelled');
  });

  it('reports ok when both registers contribute levels', async () => {
    const report = await fetchAll({
      feeds: [STATE_DEPT, SMARTRAVELLER],
      doFetch: routedFetch({ [STATE_DEPT.url]: respond(STATE_DEPT_RSS), [SMARTRAVELLER.url]: respond(FIXTURE) }),
    });
    assert.equal(report.byCountry.LY, 'do-not-travel');
    const { freshnessMetaPatch } = await advisoryAfterPublish(report);
    assert.equal(freshnessMetaPatch.sourceState, 'ok');
    assert.deepEqual(freshnessMetaPatch.emptyFeeds, []);
  });

  // A validation skip merges the previous seed-meta's diagnostics UNDER the
  // hook's patch (runSeed's skip path), so a recovered run must clear the old
  // failure fields explicitly or they sit next to sourceState 'ok'.
  it('clears a previous failure when the registers recover on a validation skip', async () => {
    const report = await fetchAll({
      feeds: [STATE_DEPT, SMARTRAVELLER],
      doFetch: routedFetch({ [STATE_DEPT.url]: respond(STATE_DEPT_RSS), [SMARTRAVELLER.url]: respond(FIXTURE) }),
    });
    const { freshnessMetaPatch } = await advisoryAfterPublish(report);
    const previous = { fetchedAt: 1, recordCount: 228, sourceState: 'degraded', errorCode: 'ADVISORY_REGISTER_MISSING_AU', failedSources: ['AU'], emptyFeeds: ['x'] };
    const merged = JSON.parse(JSON.stringify({
      ...freshnessMetaDiagnosticsPatch(previous),
      ...freshnessMetaDiagnosticsPatch(freshnessMetaPatch),
    }));
    assert.deepEqual(merged, { sourceState: 'ok', emptyFeeds: [] });
  });

  // When no register yields a level the report fails validation and runSeed
  // skips the publish. That path keeps the previous seed-meta diagnostics and
  // mirrors the old canonical fetchedAt, so without afterValidationSkip health
  // would keep reading the last run's sourceState 'ok' until the data aged out.
  it('names both registers when the rejected report has neither', async () => {
    const report = await fetchAll({
      feeds: [STATE_DEPT, SMARTRAVELLER, CDC],
      doFetch: routedFetch({ [CDC.url]: respond('<rss><channel><item><title>Measles</title><link>https://wwwnc.cdc.gov/m</link></item></channel></rss>') }),
    });
    assert.equal(validateAdvisoryReport(advisoryPublishTransform(report)), false);
    const { freshnessMetaPatch } = await advisoryAfterPublish(report);
    assert.equal(freshnessMetaPatch.sourceState, 'degraded');
    assert.equal(freshnessMetaPatch.errorCode, 'ADVISORY_REGISTER_MISSING_AU_US');
  });

  it('wires the diagnostics into the seed run: stripped from both keys, written on publish and on a validation skip', async () => {
    const source = readFileSync(new URL('../scripts/seed-security-advisories.mjs', import.meta.url), 'utf8');
    assert.match(source, /publishTransform: advisoryPublishTransform/);
    assert.match(source, /key: BOOTSTRAP_KEY, transform: advisoryPublishTransform/);
    assert.match(source, /afterPublish: advisoryAfterPublish/);
    assert.match(source, /afterValidationSkip: advisoryAfterPublish/);
  });
});
