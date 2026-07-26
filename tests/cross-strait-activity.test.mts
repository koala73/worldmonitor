import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';

import {
  DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS,
  validateDecisionSignalProvenance,
} from '../shared/decision-signal-provenance';
import {
  CROSS_STRAIT_ACTIVITY_KEY,
  CROSS_STRAIT_ACTIVITY_MAX_SERIALIZED_BYTES,
  CROSS_STRAIT_SOURCE_CONTRACTS,
  MND_MAX_DETAIL_REQUESTS_PER_RUN,
  MND_MAX_LIST_PAGES_PER_BACKFILL_RUN,
  MND_MAX_REVISION_VINTAGES_PER_DAY,
  MND_OUTBOUND_BUDGET_MS,
  MND_REFRESH_DETAIL_REQUESTS_PER_RUN,
  MND_RETENTION_REPORTING_DAYS,
  REVIEWED_JAPAN_MOD_OBSERVATIONS,
  buildCrossStraitActivitySnapshot,
  calculateActivityBaselines,
  constrainCrossStraitActivitySnapshotSize,
  fetchCrossStraitActivitySnapshot,
  parseJapanModIndex,
  parseTaiwanMndDetail,
  parseTaiwanMndList,
  readBoundedTextResponse,
  validateCrossStraitActivitySnapshot,
} from '../scripts/cross-strait-activity/adapters.mjs';
import {
  CROSS_STRAIT_ACTIVITY_MAX_CONTENT_AGE_MIN,
  CROSS_STRAIT_ACTIVITY_TTL_SECONDS,
  crossStraitActivityContentMeta,
} from '../scripts/seed-cross-strait-activity.mjs';

const fixtureRoot = resolve(import.meta.dirname, 'fixtures/cross-strait-activity');
const fixture = (name: string) => readFileSync(resolve(fixtureRoot, name), 'utf8');
const retrievedAt = '2026-07-25T08:30:00.000Z';

function mndListWithCount(count: number, firstId = 90_000): string {
  return `<div class="wrap-page3">${Array.from({ length: count }, (_, index) => `
    <a href="/en/News/PLAAct/${firstId + index}" class="news_list">
      <h5 class="date">2026.07.25</h5>
      <div>PLA activities in the waters and airspace around Taiwan</div>
    </a>`).join('')}
  </div>`;
}

function mndObservationForDay(day: number, aircraft = day) {
  const date = new Date(Date.UTC(2026, 3, day, 22));
  const reportingDay = date.toISOString().slice(0, 10);
  const start = new Date(date.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const signalId = `cross-strait:taiwan-mnd:${reportingDay}:v1`;
  return {
    id: `taiwan-mnd:${reportingDay}`,
    sourceId: 'taiwan-mnd',
    observationKind: 'official_daily_claim',
    reportingDay,
    reportingPeriod: {
      start,
      end: date.toISOString(),
      timezone: 'Asia/Taipei',
      utcOffset: '+08:00',
      semantics: 'publisher-defined-06:00-to-06:00',
    },
    publicationTime: `${reportingDay}T08:00:00.000Z`,
    retrievalTime: retrievedAt,
    categories: {
      plaAircraftSorties: aircraft,
      planShips: Math.max(1, day % 9),
      officialShips: day % 5,
      medianLineCrossings: day % 11,
      adizEntries: day % 13,
    },
    originalTerminology: {
      plaAircraftSorties: 'sorties of PLA aircraft',
      planShips: 'PLAN ships',
      officialShips: 'official ships',
      medianLineCrossings: 'crossed the median line',
      adizEntries: 'entered Taiwan ADIZ',
    },
    sourceUrl: `https://www.mnd.gov.tw/en/News/PLAAct/${86000 + day}`,
    revision: { sequence: 1, state: 'original', vintageId: `fixture-${day}` },
    history: [],
    provenance: {
      contractVersion: 'decision-signal-provenance/v1',
      signalId,
      familyId: 'operational_activity_record',
      claims: {},
    },
  };
}

describe('quantified cross-Strait activity (#5575)', () => {
  it('records the admitted source and Railway transport contracts without widening collection', () => {
    assert.equal(CROSS_STRAIT_ACTIVITY_KEY, 'military:cross-strait-activity:v1');
    assert.deepEqual(Object.keys(CROSS_STRAIT_SOURCE_CONTRACTS), ['taiwanMnd', 'japanMod']);

    const mnd = CROSS_STRAIT_SOURCE_CONTRACTS.taiwanMnd;
    assert.equal(mnd.launchStatus, 'launched');
    assert.equal(mnd.preflight.environment, 'railway-production');
    assert.equal(mnd.preflight.reachable, true);
    assert.equal(mnd.redirectPolicy, 'error');
    assert.ok(mnd.maxResponseBytes <= 524_288);
    assert.ok(MND_MAX_LIST_PAGES_PER_BACKFILL_RUN <= 11);
    assert.ok(MND_MAX_DETAIL_REQUESTS_PER_RUN <= 20);

    const jmod = CROSS_STRAIT_SOURCE_CONTRACTS.japanMod;
    assert.equal(jmod.launchStatus, 'launched_reviewed_only');
    assert.equal(jmod.preflight.environment, 'railway-production');
    assert.equal(jmod.preflight.reachable, true);
    assert.equal(jmod.documentAdmission, 'manual_review_required');
    assert.equal(jmod.runtimePdfRequestsPerRun, 0);
  });

  it('parses MND list links and preserves the publisher reporting window and categories', () => {
    assert.deepEqual(parseTaiwanMndList(fixture('mnd-list.html')), [
      {
        publicationDay: '2026-07-25',
        sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      },
      {
        publicationDay: '2026-07-24',
        sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87105',
      },
      {
        publicationDay: '2026-07-23',
        sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87086',
      },
    ]);

    const observation = parseTaiwanMndDetail(fixture('mnd-detail.html'), {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    assert.equal(observation.reportingDay, '2026-07-25');
    assert.deepEqual(observation.reportingPeriod, {
      start: '2026-07-23T22:00:00.000Z',
      end: '2026-07-24T22:00:00.000Z',
      timezone: 'Asia/Taipei',
      utcOffset: '+08:00',
      semantics: 'publisher-defined-06:00-to-06:00',
    });
    assert.deepEqual(observation.categories, {
      plaAircraftSorties: 29,
      planShips: 6,
      officialShips: 5,
      medianLineCrossings: 17,
      adizEntries: 17,
    });
    assert.equal(observation.observationKind, 'official_daily_claim');
    assert.equal(observation.originalLanguage, 'en');
    assert.deepEqual(observation.translation, { state: 'not_translated' });
    assert.equal(validateDecisionSignalProvenance(observation.provenance).ok, true);
  });

  it('decodes malformed numeric HTML entities without crashing the source parser', () => {
    const rows = parseJapanModIndex(`
      <a href="/js/pdf/2026/p20260724_05e.pdf">
        Invalid scalar &#1114112; and surrogate &#55296;
      </a>
    `);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Invalid scalar � and surrogate �');
  });

  it('strips hostile unmatched HTML tag prefixes in linear time', () => {
    const hostileTitle = '<'.repeat(64 * 1024);
    const startedAt = performance.now();
    const rows = parseJapanModIndex(`
      <a href="/js/pdf/2026/p20260724_05e.pdf">${hostileTitle}</a>
    `);
    const elapsedMs = performance.now() - startedAt;

    assert.equal(rows[0].title, hostileTitle);
    assert.ok(elapsedMs < 1_500, `expected bounded linear decode, took ${Math.round(elapsedMs)}ms`);
  });

  it('extracts the MND report body through near-limit malformed nested tags in linear time', () => {
    const malformedTags = '<div data-broken='.repeat(8_192);
    const hostileDetail = fixture('mnd-detail.html').replace(
      '<p>1.Date:',
      `${malformedTags}<p>1.Date:`,
    );
    const startedAt = performance.now();
    const observation = parseTaiwanMndDetail(hostileDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(observation.categories.plaAircraftSorties, 29);
    assert.ok(elapsedMs < 1_500, `expected bounded linear report-body scan, took ${Math.round(elapsedMs)}ms`);
  });

  it('keeps deep ancestry lookups linear when near-limit closing tags do not match', () => {
    const hostileAncestry = `${'<x>'.repeat(12_000)}${'</y>'.repeat(12_000)}`;
    const hostileDetail = fixture('mnd-detail.html').replace(
      '<p>2.PLA activities',
      `<div hidden>${hostileAncestry}</div><p>2.PLA activities`,
    );
    const startedAt = performance.now();
    const observation = parseTaiwanMndDetail(hostileDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(observation.categories.planShips, 6);
    assert.ok(elapsedMs < 1_500, `expected indexed ancestry lookup, took ${Math.round(elapsedMs)}ms`);
  });

  it('extracts MND list and publication dates through near-limit malformed tags in linear time', () => {
    const malformedTags = '<span data-broken='.repeat(7_000);
    const hostileList = `
      <a href="/en/News/PLAAct/87151">
        ${malformedTags}<h5 class="date">2026.07.25</h5>
      </a>
    `;
    const hostileDetail = fixture('mnd-detail.html').replace(
      '<span class="body-2">',
      `${malformedTags}<span class="body-2">`,
    );
    const startedAt = performance.now();
    const rows = parseTaiwanMndList(hostileList);
    const observation = parseTaiwanMndDetail(hostileDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(rows[0]?.publicationDay, '2026-07-25');
    assert.equal(observation.publicationTime, '2026-07-25');
    assert.ok(elapsedMs < 1_500, `expected bounded linear date scans, took ${Math.round(elapsedMs)}ms`);
  });

  it('does not interpret count-like text after a quoted attribute angle bracket as an official claim', () => {
    const hostileDetail = fixture('mnd-detail.html').replace(
      '<p>2.PLA activities',
      `<div=data-note 96 PLAN ships, 85 official ships <p></p>
      <div data-note=98 PLAN ships, 87 official ships <p></p>
      <!bogus 94 PLAN ships, 83 official ships <p></p>
      <?bogus 92 PLAN ships, 81 official ships <p></p>
      <![CDATA[ 90 PLAN ships, 79 official ships <p></p>
      <?1 89 PLAN ships, 78 official ships <p></p>
      <script>88 PLAN ships, 77 official ships</script>
      <style>.fake::before { content: "86 PLAN ships, 75 official ships"; }</style>
      <template>84 PLAN ships, 73 official ships</template>
      <template><script>const marker = "</template>"; 83 PLAN ships, 72 official ships</script></template>
      <template><textarea>decoy </template> 80 PLAN ships, 69 official ships</textarea></template>
      <script/>81 PLAN ships, 70 official ships</script>
      <script>const marker = "<!--"; 79 PLAN ships, 68 official ships</script>
      <script><!--<script></script>77 PLAN ships, 66 official ships</script>
      <noscript>82 PLAN ships, 71 official ships</noscript>
      <iframe>78 PLAN ships, 67 official ships</iframe>
      <noembed>76 PLAN ships, 65 official ships</noembed>
      <noframes>74 PLAN ships, 63 official ships</noframes>
      <title>72 PLAN ships, 61 official ships</title>
      <span hidden>70 PLAN ships, 59 official ships</span>
      <div/hidden>69 PLAN ships, 58 official ships</div>
      <datalist>69 PLAN ships, 58 official ships</datalist>
      <dialog>67 PLAN ships, 56 official ships</dialog>
      <details><summary>hidden detail</summary>65 PLAN ships, 54 official ships</details>
      <details hidden><summary>64 PLAN ships, 53 official ships</summary></details>
      <details popover><summary>62 PLAN ships, 51 official ships</summary></details>
      <details><div><summary>60 PLAN ships, 49 official ships</summary></div></details>
      <details><x.foo><summary>59 PLAN ships, 48 official ships</summary></x.foo></details>
      <details><summary>outer<details open hidden>58 PLAN ships, 47 official ships</details></summary>
        56 PLAN ships, 45 official ships
      </details>
      <canvas>63 PLAN ships, 52 official ships</canvas>
      <audio>61 PLAN ships, 50 official ships</audio>
      <video>59 PLAN ships, 48 official ships</video>
      <progress>57 PLAN ships, 46 official ships</progress>
      <meter>55 PLAN ships, 44 official ships</meter>
      <rp>54 PLAN ships, 43 official ships</rp>
      <div popover>52 PLAN ships, 41 official ships</div>
      <li hidden>outer<ul><li>53 PLAN ships, 42 official ships</li></ul></li>
      <p hidden><button><div>51 PLAN ships, 40 official ships</div></button></p>
      <p hidden><svg><foreignObject><div>50 PLAN ships, 39 official ships</div></foreignObject></svg></p>
      <span hidden><table></span><span>47 PLAN ships, 36 official ships</span></table></span>
      <span hidden><div></span><span>46 PLAN ships, 35 official ships</span></div></span>
      <script>decoy</script data-note="> 68 PLAN ships, 57 official ships">
      <div data-note="ignored > 99 PLAN ships, 88 official ships, and 77 out of 77 sorties crossed the median line"></div>
      <p hidden>66 PLAN ships, 55 official ships
      <p>2.PLA activities`,
    );
    const observation = parseTaiwanMndDetail(hostileDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });

    assert.deepEqual(observation.categories, {
      plaAircraftSorties: 29,
      planShips: 6,
      officialShips: 5,
      medianLineCrossings: 17,
      adizEntries: 17,
    });
  });

  it('matches browser recovery when an ignored nested form is followed by a visible figure', () => {
    const hostileDetail = fixture('mnd-detail.html').replace(
      '<p>2.PLA activities',
      `<form><p hidden>decoy<form><figure>
        49 PLAN ships and 38 official ships.
      </figure></p></form>
      <p>2.PLA activities`,
    );
    const observation = parseTaiwanMndDetail(hostileDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });

    assert.equal(observation.categories.planShips, 49);
    assert.equal(observation.categories.officialShips, 38);
  });

  it('treats the first form as a paragraph boundary but keeps its collapsed details content hidden', () => {
    const visibleDetail = fixture('mnd-detail.html').replace(
      '<p>2.PLA activities',
      '<p hidden>decoy<form>41 PLAN ships and 30 official ships</form><p>2.PLA activities',
    );
    const visibleObservation = parseTaiwanMndDetail(visibleDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    assert.equal(visibleObservation.categories.planShips, 41);
    assert.equal(visibleObservation.categories.officialShips, 30);

    const collapsedDetail = fixture('mnd-detail.html').replace(
      '<p>2.PLA activities',
      `<details><p><form>
        <summary>39 PLAN ships and 28 official ships</summary>
      </form></details>
      <p>2.PLA activities`,
    );
    const collapsedObservation = parseTaiwanMndDetail(collapsedDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    assert.equal(collapsedObservation.categories.planShips, 6);
    assert.equal(collapsedObservation.categories.officialShips, 5);

    const templateDetail = fixture('mnd-detail.html').replace(
      '<p>2.PLA activities',
      `<form><template></form></template>
      <p hidden>decoy<form>37 PLAN ships and 26 official ships</form></p>
      </form>
      <p>2.PLA activities`,
    );
    const templateObservation = parseTaiwanMndDetail(templateDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    assert.equal(templateObservation.categories.planShips, 6);
    assert.equal(templateObservation.categories.officialShips, 5);
  });

  it('preserves the visible summary but hides the collapsed body of closed details', () => {
    const hostileDetail = fixture('mnd-detail.html')
      .replace(
        '<p>2.PLA activities',
        '<details><!-- publisher note --><p>intro<summary><p>2.PLA activities',
      )
      .replace(
        '</p>\n</div>',
        `</p></summary>
        <p>99 PLAN ships, 88 official ships</p>
        </details>
        </div>`,
      );
    const observation = parseTaiwanMndDetail(hostileDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });

    assert.deepEqual(observation.categories, {
      plaAircraftSorties: 29,
      planShips: 6,
      officialShips: 5,
      medianLineCrossings: 17,
      adizEntries: 17,
    });
  });

  it('does not expose an unfinished collapsed details body at end of input', () => {
    const hostileDetail = fixture('mnd-detail.html').replace(
      '<p>2.PLA activities',
      `<details><summary>collapsed</summary>
      99 PLAN ships, 88 official ships
      <p>2.PLA activities`,
    );

    assert.throws(
      () => parseTaiwanMndDetail(hostileDetail, {
        sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
        retrievedAt,
        expectedPublicationDay: '2026-07-25',
      }),
      /MND_ACTIVITY_COUNTS_MISSING/,
    );
  });

  it('recovers a visible figure after a hidden paragraph omits its end tag', () => {
    const hostileDetail = fixture('mnd-detail.html')
      .replace(
        '<p>2.PLA activities',
        '<p hidden><button>outer<button>inner</button><figure>2.PLA activities',
      )
      .replace('</p>\n</div>', '</figure>\n</div>');
    const observation = parseTaiwanMndDetail(hostileDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });

    assert.equal(observation.categories.planShips, 6);
    assert.equal(observation.categories.officialShips, 5);

    const genericHiddenDetail = fixture('mnd-detail.html')
      .replace(
        '<p>2.PLA activities',
        '<div hidden><button></div><figure>2.PLA activities',
      )
      .replace('</p>\n</div>', '</figure>\n</div>');
    const genericHiddenObservation = parseTaiwanMndDetail(genericHiddenDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });

    assert.equal(genericHiddenObservation.categories.planShips, 6);
    assert.equal(genericHiddenObservation.categories.officialShips, 5);
  });

  it('honors the browser first-wins rule for duplicate class attributes', () => {
    const hostileDetail = fixture('mnd-detail.html').replace(
      '<div class="maincontent">',
      `<div class=chrome class="maincontent">
        <p>1.Date: 6 a.m. Jul. 24 to 6 a.m. Jul. 25 (UTC+8)</p>
        <p>99 PLAN ships and 88 official ships</p>
      </div>
      <div class="maincontent">`,
    );
    const observation = parseTaiwanMndDetail(hostileDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });

    assert.equal(observation.categories.planShips, 6);
    assert.equal(observation.categories.officialShips, 5);
  });

  it('ignores a template report-body decoy before the published MND report', () => {
    const hostileDetail = fixture('mnd-detail.html').replace(
      '<div class="maincontent">',
      `<template>
        <div class="maincontent">
          <p>1.Date: 6 a.m. Jul. 24 to 6 a.m. Jul. 25 (UTC+8)</p>
          <p>99 sorties of PLA aircraft, 98 PLAN ships and 97 official ships were detected.
            96 out of 99 sorties crossed the median line and entered Taiwan ADIZ.</p>
        </div>
      </template>
      <div class="maincontent">`,
    );
    const observation = parseTaiwanMndDetail(hostileDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });

    assert.deepEqual(observation.categories, {
      plaAircraftSorties: 29,
      planShips: 6,
      officialShips: 5,
      medianLineCrossings: 17,
      adizEntries: 17,
    });
  });

  it('keeps the selected MND report open across template-local closing tags', () => {
    const hostileDetail = fixture('mnd-detail.html').replace(
      '<p>2.PLA activities',
      `<template>
        </div>
        <div>99 PLAN ships and 88 official ships</div>
      </template>
      <p>2.PLA activities`,
    );
    const observation = parseTaiwanMndDetail(hostileDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });

    assert.equal(observation.categories.planShips, 6);
    assert.equal(observation.categories.officialShips, 5);
  });

  it('does not interpret count-like attributes from an unfinished trailing report tag', () => {
    const hostileDetail = fixture('mnd-detail.html').replace(
      '</p>\n</div>',
      `</p>
      <div data-note=99 PLAN ships, 88 official ships, and 77 out of 77 sorties crossed the median line
      </div>`,
    );
    const observation = parseTaiwanMndDetail(hostileDetail, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });

    assert.deepEqual(observation.categories, {
      plaAircraftSorties: 29,
      planShips: 6,
      officialShips: 5,
      medianLineCrossings: 17,
      adizEntries: 17,
    });
  });

  it('scans repeated unterminated list anchors in linear time and recovers at valid anchors', () => {
    const japanPrefix = '<a href="/js/pdf/2026/unterminated.pdf">x'.repeat(1_500);
    const mndPrefix = '<a href="/en/News/PLAAct/99999"><h5 class="date">2026.07.25'.repeat(1_000);
    const startedAt = performance.now();
    const japanRows = parseJapanModIndex(`${japanPrefix}${fixture('jmod-index.html')}`);
    const mndRows = parseTaiwanMndList(`${mndPrefix}${fixture('mnd-list.html')}`);
    const elapsedMs = performance.now() - startedAt;

    assert.equal(japanRows.length, 3);
    assert.ok(japanRows.every((row) => !row.sourceUrl.endsWith('/unterminated.pdf')));
    assert.equal(mndRows.length, 3);
    assert.ok(mndRows.every((row) => !row.sourceUrl.endsWith('/99999')));
    assert.ok(elapsedMs < 1_500, `expected bounded linear anchor scan, took ${Math.round(elapsedMs)}ms`);
  });

  it('keeps source offsets stable and reads only an exact quoted href attribute', () => {
    const japanRows = parseJapanModIndex(`
      <!-- publisher's archived anchor should stay ignored -->
      <div data-note="<a href='/js/pdf/2026/quoted-decoy.pdf'>decoy</a>"></div>
      İ<a data-note="location.href='/js/pdf/2026/decoy.pdf'"
        href="/js/pdf/2026/p20260724_05e.pdf">Reviewed document</a>
    `);
    const mndRows = parseTaiwanMndList(`
      <!-- publisher's archived anchor should stay ignored -->
      <div data-note="<a href='/en/News/PLAAct/88888'><h5 class='date'>2026.07.25</h5></a>"></div>
      İ<a data-note="location.href='/en/News/PLAAct/99999'"
        href="/en/News/PLAAct/87151"><h5 class="date">2026.07.25</h5></a>
    `);

    assert.deepEqual(japanRows.map((row) => row.sourceUrl), [
      'https://www.mod.go.jp/js/pdf/2026/p20260724_05e.pdf',
    ]);
    assert.deepEqual(mndRows, [{
      publicationDay: '2026-07-25',
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
    }]);
  });

  it('ignores anchors inside template content for both official source indexes', () => {
    const japanRows = parseJapanModIndex(`
      <template>
        <a href="/js/pdf/2026/template-decoy.pdf">Template decoy</a>
      </template>
      <a href="/js/pdf/2026/p20260724_05e.pdf">Reviewed document</a>
    `);
    const mndRows = parseTaiwanMndList(`
      <template>
        <a href="/en/News/PLAAct/99999"><h5 class="date">2026.07.25</h5></a>
      </template>
      <a href="/en/News/PLAAct/87151"><h5 class="date">2026.07.25</h5></a>
    `);

    assert.deepEqual(japanRows.map((row) => row.sourceUrl), [
      'https://www.mod.go.jp/js/pdf/2026/p20260724_05e.pdf',
    ]);
    assert.deepEqual(mndRows, [{
      publicationDay: '2026-07-25',
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
    }]);
  });

  it('skips a malformed Japan MOD document URL without aborting later rows', () => {
    const rows = parseJapanModIndex(`
      <a href="https://[invalid].pdf">Malformed document URL</a>
      <a href="/js/pdf/2026/p20260724_05e.pdf">Reviewed document</a>
    `);

    assert.deepEqual(rows.map((row) => row.sourceUrl), [
      'https://www.mod.go.jp/js/pdf/2026/p20260724_05e.pdf',
    ]);
  });

  it('keeps an omitted category unknown rather than inventing a zero', () => {
    const observation = parseTaiwanMndDetail(fixture('mnd-detail-omitted-category.html'), {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87105',
      retrievedAt,
      expectedPublicationDay: '2026-07-24',
    });
    assert.equal(observation.categories.plaAircraftSorties, 12);
    assert.equal(observation.categories.planShips, 7);
    assert.equal(observation.categories.officialShips, null);
    assert.equal(observation.categories.medianLineCrossings, null);
    assert.equal(observation.categories.adizEntries, 8);
  });

  it('preserves an explicit zero instead of treating it as missing', () => {
    const explicitZero = fixture('mnd-detail.html').replace(
      /29 sorties of PLA aircraft,[\s\S]*?entered Taiwan’s northern, central and southwestern ADIZ\./,
      'No PLA aircraft, no PLAN ships and no official ships were detected. 0 out of 0 sorties crossed the median line and entered Taiwan ADIZ.',
    );
    const observation = parseTaiwanMndDetail(explicitZero, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    assert.deepEqual(observation.categories, {
      plaAircraftSorties: 0,
      planShips: 0,
      officialShips: 0,
      medianLineCrossings: 0,
      adizEntries: 0,
    });
  });

  it('parses only the MND report body, never matching hostile page chrome', () => {
    const observation = parseTaiwanMndDetail(fixture('mnd-detail-hostile-chrome.html'), {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    assert.deepEqual(observation.categories, {
      plaAircraftSorties: 29,
      planShips: 6,
      officialShips: 5,
      medianLineCrossings: 17,
      adizEntries: 17,
    });
    assert.equal(observation.reportingDay, '2026-07-25');
  });

  it('cross-checks scoped, calendar-valid publication metadata against the list row and retrieval time', () => {
    const mismatched = fixture('mnd-detail.html').replace('2026.07.25', '2099.07.25');
    assert.throws(
      () => parseTaiwanMndDetail(mismatched, {
        sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
        retrievedAt,
        expectedPublicationDay: '2026-07-25',
      }),
      /MND_PUBLICATION_DATE_MISMATCH/,
    );
    const invalidCalendarDay = fixture('mnd-detail.html').replace('2026.07.25', '2026.02.31');
    assert.throws(
      () => parseTaiwanMndDetail(invalidCalendarDay, {
        sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
        retrievedAt,
        expectedPublicationDay: '2026-02-31',
      }),
      /MND_PUBLICATION_DATE_MISSING/,
    );
    const ambiguousDate = fixture('mnd-detail.html').replace(
      '2026.07.25',
      '2026.07.25 updated 2099.07.25',
    );
    assert.throws(
      () => parseTaiwanMndDetail(ambiguousDate, {
        sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
        retrievedAt,
        expectedPublicationDay: '2026-07-25',
      }),
      /MND_PUBLICATION_DATE_MISSING/,
    );
  });

  it('rejects impossible publisher-stated reporting-window calendar dates', () => {
    const impossibleWindow = fixture('mnd-detail.html')
      .replace('2026.07.25', '2026.03.01')
      .replace(
        '6 a.m. Jul. 24 (Fri.) to 6 a.m. Jul. 25 (Sat.) (UTC+8)',
        '6 a.m. Feb. 30 (Fri.) to 6 a.m. Feb. 31 (Sat.) (UTC+8)',
      );
    assert.throws(
      () => parseTaiwanMndDetail(impossibleWindow, {
        sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
        retrievedAt,
        expectedPublicationDay: '2026-03-01',
      }),
      /MND_REPORTING_WINDOW_INVALID/,
    );
  });

  it('accepts compact MND windows, singular counts, and year-rollover reporting periods', () => {
    const compact = fixture('mnd-detail.html')
      .replace(
        '6 a.m. Jul. 24 (Fri.) to 6 a.m. Jul. 25 (Sat.) (UTC+8)',
        '6a.m.Jul.24(Fri.) to 6a.m.Jul.25(Sat.)(UTC+8)',
      )
      .replace(
        /29 sorties of PLA aircraft,[\s\S]*?entered Taiwan’s northern, central and southwestern ADIZ\./,
        '1 sortie of PLA aircraft, 1 PLAN ship and 1 official ship were detected. 1 out of 1 sortie crossed the median line and entered Taiwan ADIZ.',
      );
    const compactObservation = parseTaiwanMndDetail(compact, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    assert.deepEqual(compactObservation.categories, {
      plaAircraftSorties: 1,
      planShips: 1,
      officialShips: 1,
      medianLineCrossings: 1,
      adizEntries: 1,
    });

    const rollover = fixture('mnd-detail.html')
      .replace('2026.07.25', '2027.01.01')
      .replace(
        '6 a.m. Jul. 24 (Fri.) to 6 a.m. Jul. 25 (Sat.) (UTC+8)',
        '6 a.m. Dec. 31 to 6 a.m. Jan. 1 (UTC+8)',
      );
    const rolloverObservation = parseTaiwanMndDetail(rollover, {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt: '2027-01-01T08:30:00.000Z',
      expectedPublicationDay: '2027-01-01',
    });
    assert.equal(rolloverObservation.reportingPeriod.start, '2026-12-30T22:00:00.000Z');
    assert.equal(rolloverObservation.reportingPeriod.end, '2026-12-31T22:00:00.000Z');
    assert.equal(rolloverObservation.reportingDay, '2027-01-01');
  });

  it('rejects MND URLs with non-default ports before list, detail, or network use', async () => {
    const hostileList = fixture('mnd-list.html').replace(
      '/en/News/PLAAct/87151',
      'https://www.mnd.gov.tw:444/en/News/PLAAct/87151',
    );
    assert.equal(parseTaiwanMndList(hostileList).length, 2);
    assert.throws(
      () => parseTaiwanMndDetail(fixture('mnd-detail.html'), {
        sourceUrl: 'https://www.mnd.gov.tw:444/en/News/PLAAct/87151',
        retrievedAt,
        expectedPublicationDay: '2026-07-25',
      }),
      /MND_UNSAFE_SOURCE_URL/,
    );

    let called = false;
    const snapshot = await fetchCrossStraitActivitySnapshot({
      fetchFn: async (input: string | URL | Request) => {
        called = true;
        if (String(input).includes('mod.go.jp')) return new Response(fixture('jmod-index.html'));
        return new Response(fixture('mnd-list.html'));
      },
      previousSnapshot: null,
      mndListUrl: 'https://www.mnd.gov.tw:444/en/news/plaactlist',
      sleepFn: async () => {},
    });
    assert.equal(called, true); // Japan's independent index still runs.
    assert.equal(snapshot.sources[0].requestCount, 0);
    assert.deepEqual(snapshot.sources[0].errorCodes, ['UNSAFE_SOURCE_URL']);
  });

  it('applies a correction to its reporting day and retains the original vintage', () => {
    const original = parseTaiwanMndDetail(fixture('mnd-detail.html'), {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    const first = buildCrossStraitActivitySnapshot({
      generatedAt: retrievedAt,
      previousSnapshot: null,
      mndOutcome: { ok: true, requestCount: 2, observations: [original] },
      japanOutcome: { ok: true, requestCount: 1, availableDocumentUrls: [] },
    });
    const corrected = parseTaiwanMndDetail(fixture('mnd-detail-corrected.html'), {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt: '2026-07-26T09:00:00.000Z',
      expectedPublicationDay: '2026-07-26',
    });
    const second = buildCrossStraitActivitySnapshot({
      generatedAt: '2026-07-26T09:00:00.000Z',
      previousSnapshot: first,
      mndOutcome: { ok: true, requestCount: 2, observations: [corrected] },
      japanOutcome: { ok: true, requestCount: 1, availableDocumentUrls: [] },
    });

    const current = second.observations.find((row: { sourceId: string }) => row.sourceId === 'taiwan-mnd');
    assert.ok(current);
    assert.equal(current.reportingDay, '2026-07-25');
    assert.equal(current.publicationTime, '2026-07-26');
    assert.equal(current.categories.plaAircraftSorties, 30);
    assert.equal(current.revision.sequence, 2);
    assert.equal(current.revision.state, 'corrected');
    assert.equal(current.history.length, 1);
    assert.equal(current.history[0].categories.plaAircraftSorties, 29);
    assert.equal(
      current.history[0].provenance.claims.supersession.value.state,
      'superseded',
    );
    assert.equal(validateDecisionSignalProvenance(current.provenance).ok, true);
    assert.equal(validateDecisionSignalProvenance(current.history[0].provenance).ok, true);
  });

  it('uses prior usable reporting days, exposes coverage, and never mixes Japan observations into MND baselines', () => {
    const mnd = Array.from({ length: 96 }, (_, index) => mndObservationForDay(index + 1));
    // Put two gaps into the reporting-day calendar without turning them into zeroes.
    mnd.splice(20, 1);
    mnd.splice(40, 1);
    const japan = REVIEWED_JAPAN_MOD_OBSERVATIONS.map((row) => ({ ...row }));
    const baselines = calculateActivityBaselines([...mnd, ...japan]);

    const aircraft = baselines.categories.plaAircraftSorties;
    assert.equal(aircraft.current.sourceId, 'taiwan-mnd');
    assert.equal(aircraft.windows[30].sampleSize, 30);
    assert.equal(aircraft.windows[30].state, 'sufficient');
    assert.equal(aircraft.windows[30].statistic, 'median');
    assert.equal(aircraft.windows[90].sampleSize, 90);
    assert.equal(aircraft.windows[90].state, 'sufficient');
    assert.ok(aircraft.windows[90].calendarSpanDays > 90);
    assert.ok(aircraft.windows[90].missingCalendarDays > 0);
    assert.equal(aircraft.windows[90].sourceIds.join(','), 'taiwan-mnd');

    const partial = calculateActivityBaselines(mnd.slice(0, 29));
    assert.equal(partial.categories.plaAircraftSorties.windows[30].state, 'insufficient_data');
    assert.equal(partial.categories.plaAircraftSorties.windows[30].sampleSize, 28);
    assert.equal(partial.categories.plaAircraftSorties.windows[90].state, 'insufficient_data');
  });

  it('retains a sufficient prior median when the current category is omitted', () => {
    const mnd = Array.from({ length: 91 }, (_, index) => mndObservationForDay(index + 1));
    mnd.at(-1)!.categories.officialShips = null;
    const window = calculateActivityBaselines(mnd).categories.officialShips.windows[90];
    assert.equal(window.state, 'sufficient');
    assert.equal(window.sampleSize, 90);
    assert.equal(window.value, 2);
    assert.equal(window.difference, null);
    assert.equal(window.ratio, null);
  });

  it('bounds the hydrated reporting-day and correction-vintage history', () => {
    const mnd = Array.from(
      { length: MND_RETENTION_REPORTING_DAYS + 30 },
      (_, index) => ({
        ...mndObservationForDay(index + 1),
        history: [] as Array<{ vintageId: string }>,
      }),
    );
    mnd.at(-1)!.history = Array.from(
      { length: MND_MAX_REVISION_VINTAGES_PER_DAY + 5 },
      (_, index) => ({ vintageId: `v${index}` }),
    );
    const snapshot = buildCrossStraitActivitySnapshot({
      generatedAt: retrievedAt,
      previousSnapshot: null,
      mndOutcome: { ok: true, requestCount: 1, observations: mnd },
      japanOutcome: { ok: true, requestCount: 1, availableDocumentUrls: [] },
    });
    const retainedMnd = snapshot.observations.filter(
      (row: { sourceId: string }) => row.sourceId === 'taiwan-mnd',
    );

    assert.equal(retainedMnd.length, MND_RETENTION_REPORTING_DAYS);
    assert.equal(retainedMnd[0].history.length, MND_MAX_REVISION_VINTAGES_PER_DAY);
    assert.equal(retainedMnd[0].history[0].vintageId, 'v5');
  });

  it('prunes oldest correction vintages below the canonical Redis payload ceiling', () => {
    const mnd = Array.from({ length: MND_RETENTION_REPORTING_DAYS }, (_, index) => {
      const current = mndObservationForDay(index + 1);
      return {
        ...current,
        history: Array.from({ length: MND_MAX_REVISION_VINTAGES_PER_DAY }, (_, revisionIndex) => ({
          ...structuredClone(current),
          history: [],
          revision: {
            sequence: revisionIndex + 1,
            state: revisionIndex === 0 ? 'original' : 'corrected',
            vintageId: `v-${index}-${revisionIndex}`,
          },
          auditNote: `${index}:${revisionIndex}:${'x'.repeat(1_500)}`,
        })),
      };
    });
    const snapshot = buildCrossStraitActivitySnapshot({
      generatedAt: retrievedAt,
      previousSnapshot: null,
      mndOutcome: { ok: true, requestCount: 1, observations: mnd },
      japanOutcome: { ok: true, requestCount: 1, availableDocumentUrls: [] },
    });
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    const retainedHistory = snapshot.observations
      .filter((row: { sourceId: string }) => row.sourceId === 'taiwan-mnd')
      .reduce((sum: number, row: { history: unknown[] }) => sum + row.history.length, 0);

    assert.ok(bytes <= CROSS_STRAIT_ACTIVITY_MAX_SERIALIZED_BYTES);
    assert.ok(retainedHistory > 0, 'the bounded archive should retain recent correction evidence');
    assert.ok(
      retainedHistory < MND_RETENTION_REPORTING_DAYS * MND_MAX_REVISION_VINTAGES_PER_DAY,
      'the oldest vintages should be pruned when the byte budget is reached',
    );
    assert.equal(validateCrossStraitActivitySnapshot(snapshot), true);
  });

  it('prunes histories by vintage age instead of the parent report day', () => {
    const auditChunks = Array.from(
      { length: 1_200 },
      (_, index) => `${index}:${'x'.repeat(1_800)}`,
    );
    const constrained = constrainCrossStraitActivitySnapshotSize({
      observations: [
        {
          sourceId: 'taiwan-mnd',
          reportingDay: '2026-01-01',
          history: [{
            vintageId: 'recent-correction-on-old-report',
            retrievalTime: '2026-07-25T08:00:00.000Z',
            auditChunks,
          }],
        },
        {
          sourceId: 'taiwan-mnd',
          reportingDay: '2026-07-01',
          history: [{
            vintageId: 'older-vintage-on-newer-report',
            retrievalTime: '2026-07-02T08:00:00.000Z',
            auditChunks,
          }],
        },
      ],
    });
    assert.equal(constrained.observations[0].history.length, 1);
    assert.equal(constrained.observations[1].history.length, 0);
  });

  it('retains enough bounded history for categories reported only every fourth day', () => {
    const sparse = Array.from({ length: MND_RETENTION_REPORTING_DAYS + 35 }, (_, index) => {
      const observation = mndObservationForDay(index + 1);
      if ((index + 1) % 4 !== 0) observation.categories.medianLineCrossings = null;
      return observation;
    });
    const snapshot = buildCrossStraitActivitySnapshot({
      generatedAt: retrievedAt,
      previousSnapshot: null,
      mndOutcome: { ok: true, requestCount: 1, observations: sparse },
      japanOutcome: { ok: true, requestCount: 0, availableDocumentUrls: [] },
    });
    const window = snapshot.baselines.categories.medianLineCrossings.windows[90];
    assert.equal(window.state, 'sufficient');
    assert.equal(window.sampleSize, 90);
    assert.equal(window.value, 5);
  });

  it('admits only reviewed Japan MOD documents and keeps PLAN, RFN, and aircraft counts separate', () => {
    const discovered = parseJapanModIndex(fixture('jmod-index.html'));
    assert.equal(discovered.length, 3);
    assert.deepEqual(
      REVIEWED_JAPAN_MOD_OBSERVATIONS.map((row) => row.sourceUrl),
      [
        'https://www.mod.go.jp/js/pdf/2026/p20260724_05e.pdf',
        'https://www.mod.go.jp/js/pdf/2026/p20260708_01e.pdf',
      ],
    );
    assert.deepEqual(REVIEWED_JAPAN_MOD_OBSERVATIONS[0].categories, {
      plaAircraft: null,
      planShips: 3,
      russianNavyShips: 1,
    });
    assert.deepEqual(REVIEWED_JAPAN_MOD_OBSERVATIONS[1].categories, {
      plaAircraft: 1,
      planShips: null,
      russianNavyShips: null,
    });
    assert.ok(
      REVIEWED_JAPAN_MOD_OBSERVATIONS.every(
        (row) => validateDecisionSignalProvenance(row.provenance).ok,
      ),
    );
  });

  it('enforces streamed response limits and the staged request ceiling', async () => {
    await assert.rejects(
      () => readBoundedTextResponse(new Response('unavailable', { status: 503 }), 64),
      /HTTP_503/,
    );
    await assert.rejects(
      () => readBoundedTextResponse(new Response('x'.repeat(100)), 64),
      /RESPONSE_TOO_LARGE/,
    );

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('mnd.gov.tw') && /plaactlist/i.test(url)) {
        return new Response(fixture('mnd-list.html'), { headers: { 'Content-Type': 'text/html' } });
      }
      if (url.includes('mnd.gov.tw')) {
        return new Response(fixture('mnd-detail.html'), { headers: { 'Content-Type': 'text/html' } });
      }
      if (url.includes('mod.go.jp')) {
        return new Response(fixture('jmod-index.html'), { headers: { 'Content-Type': 'text/html' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const delays: number[] = [];
    const snapshot = await fetchCrossStraitActivitySnapshot({
      fetchFn,
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      sleepFn: async (ms) => { delays.push(ms); },
    });
    assert.ok(snapshot.observations.length >= 3);
    assert.ok(
      calls.length
        <= MND_MAX_LIST_PAGES_PER_BACKFILL_RUN + MND_MAX_DETAIL_REQUESTS_PER_RUN + 1,
    );
    assert.equal(calls.every((call) => call.init?.redirect === 'error'), true);
    assert.equal(
      calls.every((call) => new Headers(call.init?.headers).get('User-Agent')?.includes('WorldMonitor')),
      true,
    );
    assert.ok(delays.length > 0);
    assert.equal(
      delays.every((ms) => ms === CROSS_STRAIT_SOURCE_CONTRACTS.taiwanMnd.requestCadenceMs),
      true,
    );
  });

  it('marks an empty or challenge-page Japan index as a transport error while retaining reviewed rows', async () => {
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('mod.go.jp')) return new Response('<html><title>Access denied</title></html>');
      if (/plaactlist/i.test(url)) return new Response(fixture('mnd-list.html'));
      return new Response(fixture('mnd-detail.html'));
    };
    const snapshot = await fetchCrossStraitActivitySnapshot({
      fetchFn,
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      sleepFn: async () => {},
    });
    const japan = snapshot.sources.find((source: { id: string }) => source.id === 'japan-mod');
    assert.equal(japan?.transportStatus, 'error');
    assert.deepEqual(japan?.errorCodes, ['JMOD_INDEX_EMPTY']);
    assert.equal(snapshot.status, 'degraded');
    assert.equal(
      snapshot.observations.filter((row: { sourceId: string }) => row.sourceId === 'japan-mod').length,
      REVIEWED_JAPAN_MOD_OBSERVATIONS.length,
    );
  });

  it('records a rejected Japan index request as a source transport failure', async () => {
    const snapshot = await fetchCrossStraitActivitySnapshot({
      fetchFn: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('mod.go.jp')) throw new Error('network reset');
        if (/plaactlist/i.test(url)) return new Response(fixture('mnd-list.html'));
        return new Response(fixture('mnd-detail.html'));
      },
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      sleepFn: async () => {},
    });
    const japan = snapshot.sources.find((source: { id: string }) => source.id === 'japan-mod');

    assert.equal(japan?.transportStatus, 'error');
    assert.deepEqual(japan?.errorCodes, ['SOURCE_ERROR']);
    assert.equal(japan?.requestCount, 1);
  });

  it('keeps MND outbound work inside its monotonically checked persistence-safe budget', async () => {
    let clock = 0;
    const calls: string[] = [];
    const fetchFn = async (input: string | URL | Request) => {
      calls.push(String(input));
      clock += 20_000;
      if (String(input).includes('mod.go.jp')) return new Response(fixture('jmod-index.html'));
      return new Response(fixture('mnd-list.html'));
    };
    const snapshot = await fetchCrossStraitActivitySnapshot({
      fetchFn,
      previousSnapshot: null,
      now: Date.parse(retrievedAt),
      nowFn: () => clock,
      sleepFn: async (ms) => { clock += ms; },
    });
    const mndCalls = calls.filter((url) => url.includes('mnd.gov.tw'));
    assert.ok(mndCalls.length < MND_MAX_LIST_PAGES_PER_BACKFILL_RUN + MND_MAX_DETAIL_REQUESTS_PER_RUN);
    assert.ok(clock <= MND_OUTBOUND_BUDGET_MS);
    assert.equal(snapshot.sources[0].requestCount, mndCalls.length);
  });

  it('keeps a partial MND collection fresh when only the outbound budget stops more work', async () => {
    let budgetCheck = 0;
    const list = mndListWithCount(MND_MAX_DETAIL_REQUESTS_PER_RUN);
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('mod.go.jp')) return new Response(fixture('jmod-index.html'));
      if (url.includes('plaactlist')) return new Response(list);
      return new Response(fixture('mnd-detail.html'));
    };
    const snapshot = await fetchCrossStraitActivitySnapshot({
      fetchFn,
      previousSnapshot: null,
      now: Date.parse(retrievedAt),
      nowFn: () => {
        budgetCheck += 1;
        return budgetCheck < 4 ? 0 : MND_OUTBOUND_BUDGET_MS;
      },
      sleepFn: async () => {},
    });
    const mnd = snapshot.sources.find((source: { id: string }) => source.id === 'taiwan-mnd');

    assert.equal(mnd?.transportStatus, 'fresh');
    assert.ok(mnd?.errorCodes.includes('OUTBOUND_BUDGET_EXHAUSTED'));
    assert.equal(
      snapshot.observations.filter((row: { sourceId: string }) => row.sourceId === 'taiwan-mnd').length,
      1,
    );
  });

  it('uses the full detail budget on first-run backfill when there are no rows to refresh', async () => {
    const list = mndListWithCount(MND_MAX_DETAIL_REQUESTS_PER_RUN);
    const detailCalls: string[] = [];
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('mod.go.jp')) return new Response(fixture('jmod-index.html'));
      if (url.includes('plaactlist')) return new Response(list);
      detailCalls.push(url);
      return new Response(fixture('mnd-detail.html'));
    };

    const snapshot = await fetchCrossStraitActivitySnapshot({
      fetchFn,
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      sleepFn: async () => {},
    });

    assert.equal(detailCalls.length, MND_MAX_DETAIL_REQUESTS_PER_RUN);
    assert.equal(snapshot.status, 'backfilling');
    assert.equal(snapshot.coverage.backfillComplete, false);
  });

  it('accumulates unique first-run backfill candidates across multiple list pages', async () => {
    const pageOne = mndListWithCount(MND_MAX_DETAIL_REQUESTS_PER_RUN / 2, 90_000);
    const pageTwo = mndListWithCount(MND_MAX_DETAIL_REQUESTS_PER_RUN / 2, 91_000);
    const detailCalls: string[] = [];
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('mod.go.jp')) return new Response(fixture('jmod-index.html'));
      if (url.endsWith('/plaactlist')) return new Response(pageOne);
      if (url.endsWith('/plaactlist/2')) return new Response(pageTwo);
      detailCalls.push(url);
      return new Response(fixture('mnd-detail.html'));
    };

    await fetchCrossStraitActivitySnapshot({
      fetchFn,
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      sleepFn: async () => {},
    });

    assert.equal(detailCalls.length, MND_MAX_DETAIL_REQUESTS_PER_RUN);
    assert.equal(detailCalls.some((url) => url.endsWith('/90000')), true);
    assert.equal(detailCalls.some((url) => url.endsWith('/91000')), true);
  });

  it('reserves bounded, deduplicated rotating detail refreshes for older known reports', async () => {
    const previousSnapshot = buildCrossStraitActivitySnapshot({
      generatedAt: retrievedAt,
      previousSnapshot: null,
      mndOutcome: {
        ok: true,
        requestCount: 0,
        observations: Array.from({ length: 28 }, (_, index) => mndObservationForDay(index + 1)),
      },
      japanOutcome: { ok: true, requestCount: 0, availableDocumentUrls: [] },
    });
    const detailCalls: string[] = [];
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('mod.go.jp')) return new Response(fixture('jmod-index.html'));
      if (url.includes('plaactlist')) return new Response(fixture('mnd-list.html'));
      detailCalls.push(url);
      return new Response(fixture('mnd-detail.html'));
    };
    await fetchCrossStraitActivitySnapshot({
      fetchFn,
      now: Date.parse(retrievedAt),
      previousSnapshot,
      sleepFn: async () => {},
    });
    const olderRefreshes = detailCalls.filter((url) => !url.endsWith('/87151') && !url.endsWith('/87105') && !url.endsWith('/87086'));
    assert.equal(new Set(detailCalls).size, detailCalls.length);
    assert.ok(olderRefreshes.length > 0);
    assert.ok(olderRefreshes.length <= MND_REFRESH_DETAIL_REQUESTS_PER_RUN);
    assert.ok(detailCalls.length <= MND_MAX_DETAIL_REQUESTS_PER_RUN);
  });

  it('accepts an advanced publication date only for a rotating correction refresh', async () => {
    const original = parseTaiwanMndDetail(fixture('mnd-detail.html'), {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/99999',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    const previousSnapshot = buildCrossStraitActivitySnapshot({
      generatedAt: retrievedAt,
      previousSnapshot: null,
      mndOutcome: { ok: true, requestCount: 1, observations: [original] },
      japanOutcome: { ok: true, requestCount: 0, availableDocumentUrls: [] },
    });
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('mod.go.jp')) return new Response(fixture('jmod-index.html'));
      if (url.includes('plaactlist')) return new Response(fixture('mnd-list.html'));
      if (url.endsWith('/99999')) return new Response(fixture('mnd-detail-corrected.html'));
      return new Response(fixture('mnd-detail.html'));
    };
    const correctedSnapshot = await fetchCrossStraitActivitySnapshot({
      fetchFn,
      now: Date.parse('2026-07-26T09:00:00.000Z'),
      previousSnapshot,
      sleepFn: async () => {},
    });
    const corrected = correctedSnapshot.observations.find(
      (row: { sourceUrl?: string }) => row.sourceUrl?.endsWith('/99999'),
    );
    assert.equal(corrected?.publicationTime, '2026-07-26');
    assert.equal(corrected?.categories.plaAircraftSorties, 30);
    assert.equal(corrected?.revision.state, 'corrected');
    assert.equal(corrected?.history.length, 1);
  });

  it('rejects a rotating correction when a known URL moves to another reporting day', () => {
    const movedWindow = fixture('mnd-detail-corrected.html').replace(
      '6 a.m. Jul. 24 (Fri.) to 6 a.m. Jul. 25 (Sat.) (UTC+8)',
      '6 a.m. Jul. 25 (Sat.) to 6 a.m. Jul. 26 (Sun.) (UTC+8)',
    );
    assert.throws(
      () => parseTaiwanMndDetail(movedWindow, {
        sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/99999',
        retrievedAt: '2026-07-26T09:00:00.000Z',
        expectedPublicationDay: '2026-07-25',
        allowPublicationAdvance: true,
        expectedReportingDay: '2026-07-25',
      }),
      /MND_REPORTING_DAY_MISMATCH/,
    );
  });

  it('rejects a rediscovered page-one URL when its reporting day changes', async () => {
    const original = parseTaiwanMndDetail(fixture('mnd-detail.html'), {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    const previousSnapshot = buildCrossStraitActivitySnapshot({
      generatedAt: retrievedAt,
      previousSnapshot: null,
      mndOutcome: { ok: true, requestCount: 1, observations: [original] },
      japanOutcome: { ok: true, requestCount: 0, availableDocumentUrls: [] },
    });
    const movedWindow = fixture('mnd-detail.html').replace(
      '6 a.m. Jul. 24 (Fri.) to 6 a.m. Jul. 25 (Sat.) (UTC+8)',
      '6 a.m. Jul. 25 (Sat.) to 6 a.m. Jul. 26 (Sun.) (UTC+8)',
    );
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('mod.go.jp')) return new Response(fixture('jmod-index.html'));
      if (url.includes('plaactlist')) return new Response(fixture('mnd-list.html'));
      if (url.endsWith('/87151')) return new Response(movedWindow);
      return new Response(fixture('mnd-detail.html'));
    };
    const snapshot = await fetchCrossStraitActivitySnapshot({
      fetchFn,
      now: Date.parse('2026-07-26T09:00:00.000Z'),
      previousSnapshot,
      sleepFn: async () => {},
    });
    const knownUrlRows = snapshot.observations.filter(
      (row: { sourceUrl?: string }) => row.sourceUrl?.endsWith('/87151'),
    );
    assert.equal(knownUrlRows.length, 1);
    assert.equal(knownUrlRows[0].reportingDay, '2026-07-25');
    assert.ok(snapshot.sources[0].errorCodes.includes('MND_REPORTING_DAY_MISMATCH'));
  });

  it('publishes long-lived history with freshness anchored to the latest reporting window', () => {
    const older = mndObservationForDay(1);
    const newer = mndObservationForDay(2);
    assert.equal(CROSS_STRAIT_ACTIVITY_TTL_SECONDS, 180 * 24 * 60 * 60);
    assert.equal(CROSS_STRAIT_ACTIVITY_MAX_CONTENT_AGE_MIN, 3 * 24 * 60);
    assert.deepEqual(crossStraitActivityContentMeta({ observations: [older, newer] }), {
      newestItemAt: Date.parse(newer.reportingPeriod.end),
      oldestItemAt: Date.parse(older.reportingPeriod.end),
    });
    assert.equal(
      crossStraitActivityContentMeta({ observations: REVIEWED_JAPAN_MOD_OBSERVATIONS }),
      null,
    );
  });

  it('degrades transport when any staged MND request fails instead of hiding partial collection', async () => {
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/plaactlist')) {
        return new Response(fixture('mnd-list.html'));
      }
      if (url.includes('/plaactlist/')) {
        throw new Error('HTTP_503');
      }
      if (url.includes('mnd.gov.tw')) {
        return new Response(fixture('mnd-detail.html'));
      }
      return new Response(fixture('jmod-index.html'));
    };
    const snapshot = await fetchCrossStraitActivitySnapshot({
      fetchFn,
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      sleepFn: async () => {},
    });

    assert.equal(snapshot.status, 'degraded');
    assert.equal(snapshot.sources[0].transportStatus, 'error');
    assert.ok(snapshot.sources[0].errorCodes.includes('HTTP_503'));
    assert.ok(snapshot.observations.some((row: { sourceId: string }) => row.sourceId === 'taiwan-mnd'));
  });

  it('rejects malformed retained records at the publication gate', () => {
    const observation = parseTaiwanMndDetail(fixture('mnd-detail.html'), {
      sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      retrievedAt,
      expectedPublicationDay: '2026-07-25',
    });
    const snapshot = buildCrossStraitActivitySnapshot({
      generatedAt: retrievedAt,
      previousSnapshot: null,
      mndOutcome: { ok: true, requestCount: 2, observations: [observation] },
      japanOutcome: { ok: true, requestCount: 1, availableDocumentUrls: [] },
    });
    assert.equal(validateCrossStraitActivitySnapshot(snapshot), true);
    snapshot.observations[0].categories.plaAircraftSorties = -1;
    assert.equal(validateCrossStraitActivitySnapshot(snapshot), false);
  });

  it('drops malformed retained rows and preserves source success timestamps during transport failure', () => {
    const valid = mndObservationForDay(1);
    const malformed = {
      ...mndObservationForDay(2),
      sourceUrl: 'https://example.com/not-an-admitted-source',
    };
    const previousSnapshot = {
      observations: [valid, malformed],
      sources: [
        { id: 'taiwan-mnd', lastSuccessAt: '2026-07-24T08:00:00.000Z' },
        { id: 'japan-mod', lastSuccessAt: '2026-07-23T08:00:00.000Z' },
      ],
    };
    const snapshot = buildCrossStraitActivitySnapshot({
      generatedAt: retrievedAt,
      previousSnapshot,
      mndOutcome: { ok: false, requestCount: 1, observations: [], errorCodes: ['TIMEOUT'] },
      japanOutcome: { ok: false, requestCount: 1, availableDocumentUrls: [], errorCodes: ['HTTP_503'] },
    });
    const retainedMnd = snapshot.observations.filter(
      (row: { sourceId: string }) => row.sourceId === 'taiwan-mnd',
    );

    assert.deepEqual(retainedMnd.map((row: { id: string }) => row.id), [valid.id]);
    assert.equal(snapshot.sources[0].lastSuccessAt, '2026-07-24T08:00:00.000Z');
    assert.equal(snapshot.sources[1].lastSuccessAt, '2026-07-23T08:00:00.000Z');
    assert.equal(snapshot.status, 'degraded');
  });

  it('launches the shared operational-activity family only with domain fixtures', () => {
    assert.equal(
      DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS.operational_activity_record.launchStatus,
      'launched',
    );
  });
});
