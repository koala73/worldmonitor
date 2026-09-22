import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCURACY_CONTENT_VERSION,
  ACCURACY_FAILURE_CODES,
  ACCURACY_PAGE_PATH,
  SCORECARD_DECLARED_FIELDS,
  SCORECARD_STALE_AFTER_HOURS,
  accuracyDatasetDownload,
  classifyAccuracyState,
  renderAccuracyPage,
  renderAccuracyLlmsSection,
  selectDeclaredScorecardFields,
  writeAccuracySection,
} from '../scripts/build-accuracy-page.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8');

// The live values captured from GET /api/forecast/v1/get-forecast-scorecard on
// the day this page shipped. Kept verbatim so the honesty rules are exercised
// against a real funnel — 96 entries awaiting a judge and a `political` domain
// with nothing scored are the states the page must not round away.
const LIVE_SCORECARD = Object.freeze({
  schemaVersion: 1,
  generatedAt: 1789020144012,
  rollingWindowDays: 180,
  methodology: 'Brier/log score over resolved YES/NO published forecast windows; VOID and pending entries are counted for coverage but excluded from accuracy math.',
  totals: {
    entries: 958,
    resolved: 772,
    pending: 90,
    pendingJudge: 96,
    scored: 490,
    void: 282,
    voidRate: 0.365285,
    publicationCoverage: 0.511482,
  },
  overall: { count: 490, brier: 0.192435, logScore: 0.558453 },
  byDomain: [
    { domain: 'conflict', resolved: 36, scored: 12, void: 24, voidRate: 0.666667, brier: 0.27301, logScore: 0.730444 },
    { domain: 'cyber', resolved: 146, scored: 144, void: 2, voidRate: 0.013699, brier: 0.07564, logScore: 0.27801 },
    { domain: 'energy', resolved: 24, scored: 24, void: 0, voidRate: 0, brier: 0.192409, logScore: 0.566588 },
    { domain: 'geopolitical', resolved: 6, scored: 6, void: 0, voidRate: 0, brier: 0.241783, logScore: 0.644906 },
    { domain: 'infrastructure', resolved: 89, scored: 11, void: 78, voidRate: 0.876404, brier: 0.285995, logScore: 0.763885 },
    { domain: 'macro', resolved: 5, scored: 5, void: 0, voidRate: 0, brier: 0.23488, logScore: 0.661951 },
    { domain: 'market', resolved: 346, scored: 272, void: 74, voidRate: 0.213873, brier: 0.241727, logScore: 0.678734 },
    { domain: 'military', resolved: 20, scored: 6, void: 14, voidRate: 0.7, brier: 0.26964, logScore: 0.731132 },
    { domain: 'political', resolved: 6, scored: 0, void: 6, voidRate: 1 },
    { domain: 'supply_chain', resolved: 94, scored: 10, void: 84, voidRate: 0.893617, brier: 0.236844, logScore: 0.666046 },
  ],
  byGenerationOrigin: [
    { generationOrigin: 'bet_engine', resolved: 299, scored: 299, void: 0, voidRate: 0, brier: 0.235571, logScore: 0.664496 },
    { generationOrigin: 'legacy_detector', resolved: 362, scored: 176, void: 186, voidRate: 0.513812, brier: 0.113943, logScore: 0.366094 },
    { generationOrigin: 'state_derived', resolved: 78, scored: 11, void: 67, voidRate: 0.858974, brier: 0.240823, logScore: 0.675878 },
    { generationOrigin: 'unknown', resolved: 33, scored: 4, void: 29, voidRate: 0.878788, brier: 0.288611, logScore: 0.772562 },
  ],
  calibration: [
    { bucket: '0-10', minProbability: 0, maxProbability: 0.1, count: 40, predictedMean: 0.060425, realizedRate: 0, brier: 0.004521 },
    { bucket: '10-20', minProbability: 0.1, maxProbability: 0.2, count: 53, predictedMean: 0.142774, realizedRate: 0.018868, brier: 0.034119 },
    { bucket: '20-30', minProbability: 0.2, maxProbability: 0.3, count: 80, predictedMean: 0.2539, realizedRate: 0.325, brier: 0.22695 },
    { bucket: '30-40', minProbability: 0.3, maxProbability: 0.4, count: 168, predictedMean: 0.351212, realizedRate: 0.35119, brier: 0.226701 },
    { bucket: '40-50', minProbability: 0.4, maxProbability: 0.5, count: 106, predictedMean: 0.411604, realizedRate: 0.367925, brier: 0.233726 },
    { bucket: '50-60', minProbability: 0.5, maxProbability: 0.6, count: 29, predictedMean: 0.530655, realizedRate: 0.275862, brier: 0.266429 },
    { bucket: '60-70', minProbability: 0.6, maxProbability: 0.7, count: 13, predictedMean: 0.639795, realizedRate: 0.461538, brier: 0.273534 },
    { bucket: '70-80', minProbability: 0.7, maxProbability: 0.8, count: 0 },
    { bucket: '80-90', minProbability: 0.8, maxProbability: 0.9, count: 0 },
    { bucket: '90-100', minProbability: 0.9, maxProbability: 1, count: 1, predictedMean: 0.93, realizedRate: 1, brier: 0.0049 },
  ],
  vsMarketSkill: { count: 78, forecastBrier: 0.154623, marketBrier: 0.073136, brierDelta: -0.081487 },
  skill: { count: 180, brier: 0.117824, logScore: 0.375127, excludedScored: 310, excludedOrigins: ['bet_engine', 'state_derived'] },
  degraded: false,
  stale: false,
  error: '',
});

// The freeze records when it tried, when it last succeeded, and the numbers'
// own generatedAt, so the page ages the measurements on their own clock rather
// than on the outer snapshot's or the build's.
const LIVE_SECTION = Object.freeze({
  attemptedAt: '2026-09-10',
  attemptedAtMs: Date.parse('2026-09-10T21:05:00Z'),
  capturedAt: '2026-09-10',
  generatedAt: LIVE_SCORECARD.generatedAt,
  scorecard: LIVE_SCORECARD,
  failureCode: '',
});

const sectionWith = (scorecardOverrides = {}, sectionOverrides = {}) => ({
  ...LIVE_SECTION,
  scorecard: { ...LIVE_SCORECARD, ...scorecardOverrides },
  ...sectionOverrides,
});

describe('forecast scorecard field whitelist', () => {
  it('declares exactly the fields proto GetForecastScorecardResponse declares', () => {
    const proto = read('proto/worldmonitor/forecast/v1/get_forecast_scorecard.proto');
    const responseBlock = proto.match(/message GetForecastScorecardResponse \{([\s\S]*?)\n\}/)[1];
    const declared = [...responseBlock.matchAll(/^\s*(?:optional |repeated )?[A-Za-z0-9_.]+ ([a-z0-9_]+) = \d+/gm)]
      .map(([, name]) => name.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase()));
    assert.ok(declared.length > 10, 'the proto parse must actually find fields');
    assert.deepEqual(
      [...SCORECARD_DECLARED_FIELDS].sort(),
      declared.sort(),
      'the published field list must track the proto, or an undeclared seeder field can reach the page',
    );
  });

  it('drops the undeclared betEngine object the handler passes through', () => {
    const leaky = { ...LIVE_SCORECARD, betEngine: { count: 299, brier: 0.235571 }, judgedLane: 'x' };
    const selected = selectDeclaredScorecardFields(leaky);
    assert.equal(Object.hasOwn(selected, 'betEngine'), false);
    assert.equal(Object.hasOwn(selected, 'judgedLane'), false);
    assert.doesNotMatch(JSON.stringify(selected), /betEngine/);
    assert.equal(selected.skill.count, 180, 'declared fields must survive the filter');
  });

  it('drops undeclared members of nested objects and rows', () => {
    const leaky = {
      ...LIVE_SCORECARD,
      totals: { ...LIVE_SCORECARD.totals, judgedLane: 4 },
      skill: { ...LIVE_SCORECARD.skill, promoted: true },
      byDomain: [{ ...LIVE_SCORECARD.byDomain[0], internalNote: 'x' }],
      calibration: [{ ...LIVE_SCORECARD.calibration[0], sampleIds: ['a'] }],
    };
    const selected = selectDeclaredScorecardFields(leaky);
    assert.equal(Object.hasOwn(selected.totals, 'judgedLane'), false);
    assert.equal(Object.hasOwn(selected.skill, 'promoted'), false);
    assert.equal(Object.hasOwn(selected.byDomain[0], 'internalNote'), false);
    assert.equal(Object.hasOwn(selected.calibration[0], 'sampleIds'), false);
  });

  it('omits absent optional fields rather than stamping them null', () => {
    const selected = selectDeclaredScorecardFields(LIVE_SCORECARD);
    const political = selected.byDomain.find((row) => row.domain === 'political');
    assert.equal(Object.hasOwn(political, 'brier'), false, 'an unscored domain has no Brier to publish');
    const emptyBucket = selected.calibration.find((row) => row.bucket === '70-80');
    assert.equal(Object.hasOwn(emptyBucket, 'predictedMean'), false);
  });

  it('returns null for a non-object payload instead of an empty shell', () => {
    for (const value of [null, undefined, 'x', 7, []]) {
      assert.equal(selectDeclaredScorecardFields(value), null);
    }
  });
});

describe('accuracy record classifier', () => {
  it('reports three independent facts plus a derived headline', () => {
    const state = classifyAccuracyState(LIVE_SECTION);
    assert.deepEqual(
      { availability: state.availability, freshness: state.freshness, coverage: state.coverage, headline: state.headline },
      { availability: 'ok', freshness: 'current', coverage: 'measurable', headline: 'current' },
    );
    assert.equal(state.capturedAt, '2026-09-10');
    assert.equal(state.attemptedAt, '2026-09-10');
    assert.equal(state.generatedAt, LIVE_SCORECARD.generatedAt);
  });

  it('does not read an ordinary judging backlog or an unscored domain as a fault', () => {
    // pendingJudge is 96 in the live capture and is essentially never zero, so a
    // rule keyed on it would pin the page to a permanent warning nobody reads.
    const state = classifyAccuracyState(LIVE_SECTION);
    assert.equal(LIVE_SCORECARD.totals.pendingJudge > 0, true, 'the fixture must actually carry a backlog');
    assert.equal(LIVE_SCORECARD.byDomain.some((row) => row.scored === 0), true, 'the fixture must carry an unscored domain');
    assert.equal(state.headline, 'current');
  });

  it('reports a missing section as missing, with no numbers attached', () => {
    for (const section of [null, undefined, {}]) {
      const state = classifyAccuracyState(section);
      assert.equal(state.availability, 'missing');
      assert.equal(state.headline, 'missing');
      assert.equal(state.scorecard, null);
    }
  });

  it('reports a failed capture with a code from a fixed vocabulary, never upstream text', () => {
    const state = classifyAccuracyState({
      attemptedAt: '2026-09-10',
      capturedAt: null,
      generatedAt: null,
      scorecard: null,
      failureCode: 'http-error',
    });
    assert.equal(state.availability, 'capture-failed');
    assert.equal(state.headline, 'capture-failed');
    assert.equal(state.failureCode, 'http-error');
    assert.ok(ACCURACY_FAILURE_CODES.includes(state.failureCode));
    assert.equal(
      classifyAccuracyState({
        attemptedAt: '2026-09-10',
        scorecard: null,
        failureCode: 'HTTP 503 from upstream: {"error":"x"}',
      }).failureCode,
      'unknown',
      'a code outside the vocabulary must be normalised, not echoed',
    );
  });

  it('classifies a retained scorecard by its own age, not the capture that failed', () => {
    // The outer snapshot timestamp is fresh every week. Carried-forward numbers
    // must age on their own clock or a failed capture republishes them as current.
    const state = classifyAccuracyState({
      attemptedAt: '2026-09-17',
      attemptedAtMs: Date.parse('2026-09-17T21:05:00Z'),
      capturedAt: '2026-09-10',
      generatedAt: LIVE_SCORECARD.generatedAt,
      scorecard: LIVE_SCORECARD,
      failureCode: 'http-error',
    });
    assert.equal(state.availability, 'capture-failed');
    assert.equal(state.freshness, 'stale');
    assert.equal(state.coverage, 'measurable');
    assert.equal(state.headline, 'capture-failed', 'an availability fault outranks the staleness it caused');
    assert.ok(state.scorecard, 'retained numbers stay renderable');
    assert.ok(state.ageHours > 24 * 7);
  });

  it('reports a degraded or errored payload as a failed capture', () => {
    assert.equal(classifyAccuracyState(sectionWith({ degraded: true })).availability, 'capture-failed');
    assert.equal(classifyAccuracyState(sectionWith({ degraded: true })).failureCode, 'backend-degraded');
    assert.equal(
      classifyAccuracyState(sectionWith({ error: 'forecast_scorecard_backend_unavailable' })).availability,
      'capture-failed',
    );
    assert.equal(
      classifyAccuracyState(sectionWith({ degraded: true })).scorecard,
      null,
      'a degraded payload is all zeros; it must not be rendered as numbers',
    );
  });

  it('reports an undatable payload as a failed capture rather than a fresh one', () => {
    // The handler answers an expired seed key with a zeroed body: generatedAt 0,
    // degraded false. Nothing else distinguishes it from a real reading.
    for (const generatedAt of [0, -1, Number.NaN, 'x', undefined, null]) {
      const state = classifyAccuracyState(sectionWith({ generatedAt }, { generatedAt }));
      assert.equal(state.availability, 'capture-failed', `generatedAt ${String(generatedAt)} must not publish`);
      assert.equal(state.failureCode, 'undated-response');
    }
  });

  it('honours the payload own stale verdict and its measured age, whichever is worse', () => {
    assert.equal(classifyAccuracyState(sectionWith({ stale: true })).freshness, 'stale');
    assert.equal(classifyAccuracyState(sectionWith({ stale: true })).headline, 'stale');
    const aged = classifyAccuracyState(sectionWith({}, { generatedAt: Date.parse('2026-09-08T06:00:00Z') }));
    assert.equal(aged.freshness, 'stale', 'measured age past the ceiling is stale even when the payload says otherwise');
    assert.ok(aged.ageHours >= 48);
  });

  it('refuses to publish numbers dated after the attempt that read them', () => {
    // Clamping a negative age to zero would report the most suspicious payload
    // there is — measurements postdating the read that captured them — as the
    // freshest possible record. Two clocks disagree, so no freshness verdict
    // about this figure is trustworthy and none is offered.
    const impossible = classifyAccuracyState(sectionWith({}, {
      generatedAt: LIVE_SECTION.attemptedAtMs + 6 * 60 * 60 * 1000,
    }));
    assert.equal(impossible.availability, 'capture-failed');
    assert.equal(impossible.failureCode, 'undated-response');
    assert.notEqual(impossible.freshness, 'current', 'an impossible age must never read as current');

    // Small skew between our runner and the API host is ordinary and must not
    // flag a healthy capture.
    const skewed = classifyAccuracyState(sectionWith({}, {
      generatedAt: LIVE_SECTION.attemptedAtMs + 60 * 1000,
    }));
    assert.equal(skewed.availability, 'ok');
    assert.equal(skewed.freshness, 'current');
  });

  it('pins the staleness ceiling to the one the API itself publishes', () => {
    // server/worldmonitor/forecast/v1/get-forecast-scorecard.ts sets `stale` at
    // MAX_STALE_MS on this seed key. A page ceiling above that would call a
    // payload current after the API had already called it stale, and one below
    // it would flag a payload the API considers fresh. The page constant is
    // declared rather than parsed at build time — a generator that read a
    // TypeScript server file would fail the whole build on an unrelated
    // refactor — so this assertion is what makes the correspondence real: it
    // reds when the handler's value moves AND when the expression it pins moves.
    const path = 'server/worldmonitor/forecast/v1/get-forecast-scorecard.ts';
    const declaration = read(path).match(/const MAX_STALE_MS = (\d+) \* 60 \* 1000;/);
    assert.ok(
      declaration,
      `${path} no longer declares MAX_STALE_MS as "<minutes> * 60 * 1000";`
        + ' re-pin this assertion to its new shape rather than deleting it',
    );
    assert.equal(
      Number(declaration[1]) / 60,
      SCORECARD_STALE_AFTER_HOURS,
      `the API calls this seed stale after ${Number(declaration[1]) / 60}h but the page uses`
        + ` ${SCORECARD_STALE_AFTER_HOURS}h; update SCORECARD_STALE_AFTER_HOURS to match the handler`,
    );
  });

  it('reads an absent skill summary as insufficient coverage, not a capture failure', () => {
    // summarizeSkill returns null when nothing is scored at all, so `skill` is
    // ABSENT rather than present with count 0. Both shapes reach this page.
    const { skill: _skill, ...withoutSkill } = LIVE_SCORECARD;
    const absent = classifyAccuracyState({ ...LIVE_SECTION, scorecard: withoutSkill });
    assert.equal(absent.availability, 'ok');
    assert.equal(absent.coverage, 'insufficient');
    assert.equal(absent.headline, 'insufficient');
    const zeroed = classifyAccuracyState(sectionWith({
      skill: { count: 0, excludedScored: 310, excludedOrigins: ['bet_engine', 'state_derived'] },
    }));
    assert.equal(zeroed.coverage, 'insufficient');
    assert.equal(zeroed.headline, 'insufficient');
    assert.equal(zeroed.scorecard.skill.excludedScored, 310);
  });

  it('orders the headline strongest defect first, and never hides a weaker one', () => {
    const worst = classifyAccuracyState({
      attemptedAt: '2026-09-17',
      capturedAt: '2026-09-10',
      generatedAt: Date.parse('2026-09-01T06:00:00Z'),
      scorecard: {
        ...LIVE_SCORECARD,
        stale: true,
        skill: { count: 0, excludedScored: 5, excludedOrigins: ['bet_engine'] },
      },
      failureCode: 'http-error',
    });
    assert.equal(worst.headline, 'capture-failed');
    assert.equal(worst.freshness, 'stale', 'the weaker facts must stay readable behind the headline');
    assert.equal(worst.coverage, 'insufficient');
    const staleOnly = classifyAccuracyState(sectionWith({
      stale: true,
      skill: { count: 0, excludedScored: 5, excludedOrigins: ['bet_engine'] },
    }));
    assert.equal(staleOnly.headline, 'stale');
    assert.equal(staleOnly.coverage, 'insufficient');
  });

  // The snapshot files this reads are owned elsewhere and may be rewritten or
  // rolled back independently. A pre-contract section carried {capturedAt,
  // generatedAt, scorecard, error: <exception message>} and no failureCode, so
  // the classifier must degrade rather than trust an absent field, and must
  // never promote a caught exception string into the published record.
  it('accepts a pre-contract section without inventing a clean record', () => {
    const legacyOk = classifyAccuracyState({
      capturedAt: '2026-09-10',
      generatedAt: LIVE_SCORECARD.generatedAt,
      scorecard: LIVE_SCORECARD,
      error: '',
    });
    assert.equal(legacyOk.availability, 'ok');
    assert.equal(legacyOk.coverage, 'measurable');
    assert.equal(legacyOk.ageHours, null, 'a section with no attempt clock cannot be aged');
    assert.equal(legacyOk.freshness, 'stale', 'an unmeasurable age must not read as current');

    const legacyFailed = classifyAccuracyState({
      capturedAt: '2026-09-10',
      generatedAt: 0,
      scorecard: null,
      error: 'HTTP 503 for https://www.worldmonitor.app/api/forecast/v1/get-forecast-scorecard',
    });
    assert.equal(legacyFailed.availability, 'capture-failed');
    assert.equal(legacyFailed.failureCode, 'unknown', 'a legacy message maps to the vocabulary');
    assert.doesNotMatch(JSON.stringify(legacyFailed), /503|HTTP/, 'the exception text must not survive');
    const { html } = renderState({
      capturedAt: '2026-09-10',
      generatedAt: 0,
      scorecard: null,
      error: 'HTTP 503 for get-forecast-scorecard',
    });
    assert.doesNotMatch(stripTags(html.match(/<section data-accuracy-headline[\s\S]*?<\/section>/)[0]), /503|HTTP/);
  });

  it('measures age from committed timestamps only, so the page is deterministic', () => {
    const section = sectionWith({}, { attemptedAt: '2026-09-10', generatedAt: Date.parse('2026-09-09T06:00:00Z') });
    const first = classifyAccuracyState(section);
    const second = classifyAccuracyState(section);
    assert.equal(first.ageHours, second.ageHours);
    assert.equal(first.headline, second.headline);
    assert.ok(first.ageHours > 0, 'the age must be measured, not stubbed');
  });

  it('exposes a content version so the page lastmod can advance without a snapshot change', () => {
    assert.match(ACCURACY_CONTENT_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  });
});

const BASE_URL = 'https://www.worldmonitor.app';
const SNAPSHOT_PATH = 'docs/snapshots/crawlable-live-pulse-2026-09-09.json';
const DATASET = Object.freeze({
  filename: 'scorecard.json',
  href: '/accuracy/scorecard.json',
  file: 'accuracy/scorecard.json',
  download: {
    '@type': 'DataDownload',
    encodingFormat: 'application/json',
    contentUrl: 'https://www.worldmonitor.app/accuracy/scorecard.json',
  },
  catalog: { '@type': 'DataCatalog', '@id': 'https://www.worldmonitor.app/#data-catalog', name: 'World Monitor open data catalog' },
});
const DATA_CATALOG = Object.freeze({
  '@context': 'https://schema.org',
  '@type': 'DataCatalog',
  '@id': 'https://www.worldmonitor.app/#data-catalog',
  name: 'World Monitor open data catalog',
  isAccessibleForFree: true,
  publisher: { '@id': 'https://www.worldmonitor.app/#organization', '@type': 'Organization', name: 'World Monitor', url: 'https://www.worldmonitor.app/' },
  creator: { '@id': 'https://www.worldmonitor.app/#organization', '@type': 'Organization', name: 'World Monitor', url: 'https://www.worldmonitor.app/' },
});

// The corpus builder owns the real HTML shell and injects it. This stands in for
// it, recording what the page hands the shell so the JSON-LD and canonical are
// asserted as values rather than scraped back out of a template.
function fakeTpl() {
  const calls = [];
  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const absoluteUrl = (baseUrl, pathname) => `${String(baseUrl).replace(/\/+$/, '')}${pathname}`;
  return {
    calls,
    tpl: {
      escapeHtml,
      absoluteUrl,
      withUtmSource: (url, source) => `${url}${url.includes('?') ? '&' : '?'}utm_source=${source}`,
      breadcrumbLd: (baseUrl, items) => ({
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: items.map((item, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: item.name,
          item: absoluteUrl(baseUrl, item.path),
        })),
      }),
      pageDocument: (args) => {
        calls.push(args);
        const ld = (Array.isArray(args.jsonLd) ? args.jsonLd : [args.jsonLd])
          .filter(Boolean)
          .concat(args.breadcrumbs ? [args.breadcrumbs] : []);
        return [
          '<!doctype html><html lang="en"><head>',
          `<title>${escapeHtml(args.title)}</title>`,
          `<meta name="description" content="${escapeHtml(args.description)}">`,
          `<link rel="canonical" href="${escapeHtml(absoluteUrl(args.baseUrl, args.path))}">`,
          `<meta name="lastmod" content="${escapeHtml(args.lastmod)}">`,
          ...ld.map((entry) => `<script type="application/ld+json">${JSON.stringify(entry)}</script>`),
          '</head><body>',
          args.body,
          '</body></html>',
        ].join('\n');
      },
    },
  };
}

function renderState(section, overrides = {}) {
  const { calls, tpl } = fakeTpl();
  const state = classifyAccuracyState(section);
  const html = renderAccuracyPage({
    baseUrl: BASE_URL,
    tpl,
    state,
    lastmod: '2026-09-10',
    dataset: DATASET,
    dataCatalog: DATA_CATALOG,
    snapshotPath: SNAPSHOT_PATH,
    ...overrides,
  });
  return { html, state, shell: calls[0], jsonLd: calls[0].jsonLd };
}

function downloadFor(section) {
  return JSON.parse(accuracyDatasetDownload({
    state: classifyAccuracyState(section),
    snapshotPath: SNAPSHOT_PATH,
  }));
}

const stripTags = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/** Table cells holding a predicted-probability RANGE, which is not a rate. */
const withoutProbabilityBands = (html) => html.replace(/<th scope="row" data-probability-band>[\s\S]*?<\/th>/g, '<th></th>');

describe('accuracy page honesty rules', () => {
  it('renders all three record facts in text, always, not one headline that erases the others', () => {
    const { html, state } = renderState(LIVE_SECTION);
    assert.match(html, /data-accuracy-headline="current"/);
    for (const [fact, value] of [['availability', state.availability], ['freshness', state.freshness], ['coverage', state.coverage]]) {
      assert.match(html, new RegExp(`data-accuracy-${fact}="${value}"`), `${fact} must be published`);
    }
    const text = stripTags(html);
    for (const label of ['Availability', 'Freshness', 'Coverage']) {
      assert.ok(text.includes(label), `${label} must be a readable label, not a colour`);
    }
  });

  it('prints a denominator with every percentage it publishes', () => {
    const { html } = renderState(LIVE_SECTION);
    const text = stripTags(withoutProbabilityBands(html));
    const percentages = [...text.matchAll(/\d[\d.]*%/g)];
    assert.ok(percentages.length >= 5, `expected the page to publish rates, found ${percentages.length}`);
    for (const match of percentages) {
      const trailing = text.slice(match.index, match.index + 60);
      assert.match(
        trailing,
        /% of [\d,]+/,
        `a bare percentage has no population: ...${text.slice(Math.max(0, match.index - 60), match.index + 60)}...`,
      );
    }
  });

  it('states that lower Brier is better next to the headline number', () => {
    const { html } = renderState(LIVE_SECTION);
    const text = stripTags(html);
    const headline = text.indexOf('0.118');
    const rule = text.search(/[Ll]ower .{0,20}Brier .{0,20}is better|[Ll]ower is better/);
    assert.ok(headline > 0, 'the headline-cohort Brier must be rendered');
    assert.ok(rule > 0, 'the page must state the direction of the scale');
    assert.ok(Math.abs(rule - headline) < 700, `the scale direction must sit beside the number (gap ${Math.abs(rule - headline)})`);
  });

  it('states the headline Brier in a sentence, not only in a metric tile', () => {
    const { html } = renderState(LIVE_SECTION);
    const result = html.match(/<p data-accuracy-result>([\s\S]*?)<\/p>/);
    assert.ok(result, 'the headline result must be a sentence an extractor can lift, not a tile');
    const sentence = stripTags(result[1]);
    assert.match(sentence, /180-day window/);
    assert.match(sentence, /Brier of 0\.118/);
    assert.match(sentence, /180 scored forecasts/);
    assert.match(sentence, /0\.25/);
    assert.match(sentence, /0\.5 to everything/);
    assert.doesNotMatch(result[0], /class="metric"/);
    const insufficient = renderState(sectionWith({
      skill: { count: 0, excludedScored: 310, excludedOrigins: ['bet_engine', 'state_derived'] },
    }));
    assert.doesNotMatch(insufficient.html, /data-accuracy-result/, 'a collapsed cohort has no result sentence');
  });

  it('separates metric values from their qualifiers so naive tag-stripping cannot glue them', () => {
    const { html } = renderState(LIVE_SECTION);
    assert.match(html, /<\/strong> <small>/);
    assert.doesNotMatch(html, /<\/strong><small>/);
    // Drop tags by splitting, not by replace-as-sanitizer: CodeQL treats
    // .replace(/<[^>]+>/g, '') as incomplete HTML sanitization.
    const naive = html.split(/<[^>]*>/).join('');
    assert.doesNotMatch(naive, /0\.118180/);
    assert.doesNotMatch(naive, /0\.375180/);
    assert.doesNotMatch(naive, /0\.192490/);
    assert.doesNotMatch(naive, /490of 772/);
    assert.match(naive, /0\.118\s+180 scored forecasts/);
    assert.match(naive, /490\s+of 772/);
  });

  it('renders the llms-full accuracy section from the same classifier the page uses', () => {
    const measurable = renderAccuracyLlmsSection(LIVE_SECTION);
    assert.match(measurable, /^## Forecast accuracy$/m);
    assert.match(measurable, /Brier of 0\.118/);
    assert.match(measurable, /180 scored forecasts/);
    assert.match(measurable, /180-day window/);
    assert.match(measurable, /Captured 2026-09-10/);
    assert.match(measurable, /does not publish/);
    assert.doesNotMatch(measurable, /issue #\d+/);

    const insufficient = renderAccuracyLlmsSection(sectionWith({
      skill: { count: 0, excludedScored: 310, excludedOrigins: ['bet_engine', 'state_derived'] },
    }));
    assert.match(insufficient, /headline cohort currently has no scored forecast/);
    assert.doesNotMatch(insufficient, /Brier of 0\.118/);

    const failed = renderAccuracyLlmsSection({
      attemptedAt: '2026-09-10',
      capturedAt: null,
      generatedAt: null,
      scorecard: null,
      failureCode: 'http-error',
    });
    assert.match(failed, /latest capture failed, so no figures are published/);
    assert.doesNotMatch(failed, /no scored forecast in this window/);

    const missing = renderAccuracyLlmsSection(null);
    assert.match(missing, /No scorecard has been captured for this page yet/);

    const retained = renderAccuracyLlmsSection({
      attemptedAt: '2026-09-17',
      attemptedAtMs: Date.parse('2026-09-17T21:05:00Z'),
      capturedAt: '2026-09-10',
      generatedAt: LIVE_SCORECARD.generatedAt,
      scorecard: LIVE_SCORECARD,
      failureCode: 'http-error',
    });
    assert.match(retained, /Brier of 0\.118/);
    assert.match(retained, /The latest capture failed; these are the last successful figures/);
  });

  it('omits empty calibration buckets and states the omission with their labels', () => {
    const { html } = renderState(LIVE_SECTION);
    const table = html.match(/<table data-calibration>[\s\S]*?<\/table>/)[0];
    const rows = [...table.matchAll(/<tr data-calibration-bucket="([^"]+)"/g)].map(([, bucket]) => bucket);
    assert.deepEqual(rows, ['0-10', '10-20', '20-30', '30-40', '40-50', '50-60', '60-70', '90-100']);
    const text = stripTags(html);
    assert.match(text, /empty/i, 'the page must say empty buckets are omitted');
    assert.match(text, /70-80/, 'the omitted buckets must be named');
    assert.match(text, /80-90/);
  });

  it('marks an unscored domain as insufficient sample rather than leaving a cell empty', () => {
    const { html } = renderState(LIVE_SECTION);
    const row = html.match(/<tr data-domain="political">[\s\S]*?<\/tr>/)[0];
    assert.equal((row.match(/<td[^>]*>\s*<\/td>/g) || []).length, 0, 'an empty cell reads as a measured zero');
    assert.equal((row.match(/Insufficient sample/g) || []).length, 2, 'both score columns must be marked');
    const scoredRow = html.match(/<tr data-domain="cyber">[\s\S]*?<\/tr>/)[0];
    assert.doesNotMatch(scoredRow, /Insufficient sample/);
  });

  it('labels every table and comparison with the population it covers', () => {
    // calibrationBuckets and summarizeMarketSkill are computed over ALL scored
    // entries; the headline uses the filtered cohort. An unlabelled table reads
    // as the headline cohort's calibration, which it is not.
    const { html } = renderState(LIVE_SECTION);
    for (const marker of ['data-calibration', 'data-by-domain', 'data-by-origin', 'data-ledger-totals']) {
      const table = html.match(new RegExp(`<table ${marker}>[\\s\\S]*?</table>`))[0];
      assert.match(table, /<caption>/, `${marker} must carry a caption`);
    }
    const calibration = html.match(/<table data-calibration>[\s\S]*?<\/caption>/)[0];
    assert.match(calibration, /all .{0,40}scored/i, 'the calibration caption must name its population');
    const text = stripTags(html);
    const market = text.slice(text.indexOf('Against prediction markets'));
    assert.match(market, /all .{0,40}scored|every scored/i, 'the market comparison must name its population');
  });

  it('derives the market verdict from the captured delta instead of asserting one', () => {
    const text = stripTags(renderState(LIVE_SECTION).html);
    assert.match(text, /78/, 'the market comparison must publish its n');
    assert.match(text, /market Brier minus|minus the forecast Brier/i, 'the sign convention must be spelled out');
    assert.match(text, /on this sample the market scored better/i, 'the delta is negative in this capture');
    const flipped = sectionWith({
      vsMarketSkill: { count: 78, forecastBrier: 0.073136, marketBrier: 0.154623, brierDelta: 0.081487 },
    });
    const flippedText = stripTags(renderState(flipped).html);
    assert.match(flippedText, /on this sample the forecast scored better/i, 'a positive delta must not still read as a market win');
    assert.doesNotMatch(flippedText, /on this sample the market scored better/i);
    const tied = sectionWith({ vsMarketSkill: { count: 4, forecastBrier: 0.1, marketBrier: 0.1, brierDelta: 0 } });
    assert.match(stripTags(renderState(tied).html), /tied|the same/i);
    const absent = sectionWith({ vsMarketSkill: { count: 0, forecastBrier: 0, marketBrier: 0, brierDelta: 0 } });
    assert.match(stripTags(renderState(absent).html), /no resolved forecast .{0,40}overlapped/i);
  });

  it('describes the headline cohort by what it excludes, not by a publication property', () => {
    // Entries with no generationOrigin fall back to 'unknown', which is NOT
    // excluded, so the cohort is not "published origins". Name the exclusions.
    const text = stripTags(renderState(LIVE_SECTION).html);
    assert.match(text, /bet_engine/);
    assert.match(text, /state_derived/);
    assert.match(text, /310/, 'excludedScored must be published so the headline population is unambiguous');
    assert.doesNotMatch(text, /published origin/i, 'the code does not enforce a publication property');
  });

  it('describes the scored share of the ledger by its definition, not by its field name', () => {
    const text = stripTags(renderState(LIVE_SECTION).html);
    assert.doesNotMatch(text, /publicationCoverage/, 'the field name states a property the number does not have');
    assert.match(text, /51\.1% of 958/, 'scored over all entries, with both counts');
  });

  it('explains the unscored horizons and the absent intervals without leaning on issue numbers', () => {
    const { html } = renderState(LIVE_SECTION);
    const text = stripTags(html);
    assert.match(text, /confidence interval/i);
    assert.match(text, /24h|24-hour/i);
    assert.doesNotMatch(text, /±/, 'an interval must never be invented');
    // A tracking link may follow as supporting detail, but no sentence may
    // depend on a reader being able to open our issue tracker.
    for (const sentence of text.split(/(?<=\.)\s+/)) {
      if (!/issue #\d+|issues\/\d+/.test(sentence)) continue;
      assert.match(
        sentence.replace(/[^.]*?(?:issue #\d+|issues\/\d+)/, ''),
        /^[^a-z]*$|^\s*$|\./,
        `a sentence must not need the tracker to parse: ${sentence}`,
      );
    }
  });

  it('ships the calibration and per-domain data as real tables, with any chart aria-hidden', () => {
    const { html } = renderState(LIVE_SECTION);
    assert.ok((html.match(/<table/g) || []).length >= 4, 'totals, calibration, domains and origins are tables');
    for (const svg of html.match(/<svg[^>]*>/g) || []) {
      assert.match(svg, /aria-hidden="true"/, 'a decorative chart must not be the accessible representation');
    }
    assert.match(html, /<caption>/, 'every data table needs a caption');
  });

  it('publishes aggregates only, with no receipt, evidence or judge-input surface', () => {
    const { html } = renderState(LIVE_SECTION);
    const download = downloadFor(LIVE_SECTION);
    for (const forbidden of [/betEngine/, /judgedLane/, /r2:\/\//, /forecastId/, /evidenceKey/, /receipt/i]) {
      assert.doesNotMatch(html, forbidden, `the page must not publish ${forbidden}`);
      assert.doesNotMatch(JSON.stringify(download), forbidden, `the distribution must not publish ${forbidden}`);
    }
  });

  it('whitelists the distribution rather than spreading the captured payload', () => {
    const leaky = {
      ...LIVE_SECTION,
      scorecard: { ...LIVE_SCORECARD, betEngine: { count: 299 }, judgedLane: 'shadow' },
    };
    const { html } = renderState(leaky);
    const download = downloadFor(leaky);
    assert.doesNotMatch(html, /betEngine|judgedLane|shadow/);
    assert.doesNotMatch(JSON.stringify(download), /betEngine|judgedLane|shadow/);
    assert.deepEqual(
      Object.keys(download.scorecard).sort(),
      [...SCORECARD_DECLARED_FIELDS].sort(),
      'the distribution carries the declared surface and nothing else',
    );
  });

  it('describes its own three facts and provenance in the distribution', () => {
    const download = downloadFor(LIVE_SECTION);
    assert.equal(download.dataset, 'forecast-resolution-scorecard');
    assert.deepEqual(download.record, {
      availability: 'ok',
      freshness: 'current',
      coverage: 'measurable',
      headline: 'current',
      failureCode: '',
    });
    assert.equal(download.attemptedAt, '2026-09-10');
    assert.equal(download.capturedAt, '2026-09-10');
    assert.equal(download.generatedAt, new Date(LIVE_SCORECARD.generatedAt).toISOString());
    assert.equal(download.measurementAgeHours, 15);
    assert.equal(download.staleAfterHours, SCORECARD_STALE_AFTER_HOURS);
    assert.equal(download.source, SNAPSHOT_PATH);
    assert.match(download.license, /^https:\/\//);
    assert.equal(download.confidenceIntervals.published, false);
    assert.equal(download.horizonProjections.scored, false);
    assert.equal(download.headlineCohort.excludedScored, 310);
    assert.deepEqual(download.headlineCohort.excludedOrigins, ['bet_engine', 'state_derived']);
    assert.deepEqual(download.pooledPopulations, {
      calibration: 'all-scored-entries',
      vsMarketSkill: 'all-scored-entries',
      overall: 'all-scored-entries',
    });
  });
});

describe('accuracy page records', () => {
  it('renders a missing record without a single number', () => {
    const { html } = renderState(null);
    assert.match(html, /data-accuracy-headline="missing"/);
    assert.match(html, /data-accuracy-availability="missing"/);
    assert.doesNotMatch(html, /<table data-calibration>/);
    assert.doesNotMatch(html, /class="metric"/, 'a missing record must publish no headline tile');
    const download = downloadFor(null);
    assert.equal(download.record.availability, 'missing');
    assert.equal(download.scorecard, null);
  });

  it('renders a failed capture with a plain-language cause and no upstream text', () => {
    const section = { attemptedAt: '2026-09-10', capturedAt: null, generatedAt: null, scorecard: null, failureCode: 'http-error' };
    const { html } = renderState(section);
    assert.match(html, /data-accuracy-headline="capture-failed"/);
    const status = stripTags(html.match(/<section data-accuracy-headline[\s\S]*?<\/section>/)[0]);
    assert.doesNotMatch(status, /HTTP|503|\{|Error:/, 'raw upstream text must never reach the page');
    assert.match(status, /did not answer|could not be read|request failed/i, 'the cause must be readable');
    assert.equal(downloadFor(section).record.failureCode, 'http-error');
  });

  it('renders retained numbers behind a failed capture, dated by their own clock', () => {
    const section = {
      attemptedAt: '2026-09-17',
      attemptedAtMs: Date.parse('2026-09-17T21:05:00Z'),
      capturedAt: '2026-09-10',
      generatedAt: LIVE_SCORECARD.generatedAt,
      scorecard: LIVE_SCORECARD,
      failureCode: 'http-error',
    };
    const { html, state } = renderState(section);
    assert.match(html, /data-accuracy-headline="capture-failed"/);
    assert.match(html, /data-accuracy-freshness="stale"/);
    assert.match(html, /<table data-calibration>/, 'retained numbers stay published');
    const text = stripTags(html);
    assert.ok(text.includes('2026-09-10'), 'the page must date the retained capture');
    assert.ok(text.includes('2026-09-17'), 'the page must date the failed attempt');
    assert.ok(state.ageHours > 24 * 7);
  });

  it('renders insufficient coverage naming the population that was excluded', () => {
    const section = sectionWith({
      skill: { count: 0, excludedScored: 310, excludedOrigins: ['bet_engine', 'state_derived'] },
    });
    const { html } = renderState(section);
    assert.match(html, /data-accuracy-headline="insufficient"/);
    assert.match(html, /data-accuracy-coverage="insufficient"/);
    const text = stripTags(html);
    assert.match(text, /310/);
    assert.match(text, /bet_engine/);
    assert.doesNotMatch(text, /0\.118/, 'a collapsed cohort has no headline Brier to show');
  });

  it('renders an absent skill summary the same way as a zeroed one', () => {
    const { skill: _skill, ...withoutSkill } = LIVE_SCORECARD;
    const { html } = renderState({ ...LIVE_SECTION, scorecard: withoutSkill });
    assert.match(html, /data-accuracy-coverage="insufficient"/);
    assert.match(html, /<table data-by-domain>/, 'the breakdowns are still real measurements');
    assert.doesNotMatch(html, /undefined|NaN/);
  });

  it('renders a stale record with the measured age of the numbers', () => {
    const section = sectionWith({}, { generatedAt: Date.parse('2026-09-01T06:00:00Z') });
    const { html, state } = renderState(section);
    assert.match(html, /data-accuracy-headline="stale"/);
    assert.equal(state.freshness, 'stale');
    assert.ok(stripTags(html).includes(String(Math.round(state.ageHours))), 'the page must publish the age it measured');
  });
});

describe('accuracy page publishing contract', () => {
  it('canonicalises to exactly the /accuracy/ path the corpus discovery expects', () => {
    const { shell } = renderState(LIVE_SECTION);
    assert.equal(ACCURACY_PAGE_PATH, '/accuracy/');
    assert.equal(shell.path, '/accuracy/');
    assert.equal(shell.lastmod, '2026-09-10');
  });

  it('emits a Dataset whose only distribution is the sibling JSON the builder writes', () => {
    const { jsonLd } = renderState(LIVE_SECTION);
    const dataset = jsonLd.find((entry) => entry['@type'] === 'Dataset');
    assert.ok(dataset, 'the page must emit a Dataset node');
    assert.deepEqual(dataset.distribution, [DATASET.download]);
    assert.equal(dataset.identifier, 'forecast-resolution-scorecard', 'a build-dated identifier would churn every refresh');
    assert.ok(dataset.description.length >= 50 && dataset.description.length <= 5000);
    assert.ok(Array.isArray(dataset.keywords) && dataset.keywords.length > 0);
    assert.ok(Array.isArray(dataset.variableMeasured) && dataset.variableMeasured.length > 0);
    assert.equal(dataset.isAccessibleForFree, true);
    assert.equal(dataset.spatialCoverage, 'Worldwide');
    assert.equal(dataset.creator['@id'], 'https://www.worldmonitor.app/#organization');
    assert.match(dataset.license.url, /^https:\/\//);
    assert.equal(dataset.includedInDataCatalog['@id'], 'https://www.worldmonitor.app/#data-catalog');
    assert.ok(jsonLd.some((entry) => entry['@type'] === 'DataCatalog'), 'the Dataset reference must resolve in-page');
  });

  it('links the machine-readable distribution from the visible page', () => {
    const { html } = renderState(LIVE_SECTION);
    assert.match(html, /href="\/accuracy\/scorecard\.json"/);
    assert.ok(html.includes(SNAPSHOT_PATH), 'the page must name the committed snapshot it rendered');
  });

  // The issue behind this page is that the record was unreachable, not that it
  // was unwritten. A page nothing links to reproduces the reported bug, so the
  // inbound links are part of the contract rather than a follow-up.
  it('is linked from every surface that carries a score', () => {
    const nav = read('scripts/build-crawlable-corpus.mjs');
    assert.match(nav, /<a href="\/accuracy\/">Accuracy<\/a>/, 'the shared corpus nav must carry the page');
    assert.equal(
      (nav.match(/href="\/accuracy\/"/g) || []).length >= 4,
      true,
      'the nav plus the country, crisis and CII page links must all be present',
    );
    assert.match(
      read('src/app/panel-layout.ts'),
      /\{ label: 'Accuracy', path: '\/accuracy\/' \}/,
      'DASHBOARD_REFERENCE_LINKS feeds both the desktop footer and the mobile menu',
    );
    assert.match(
      read('docs/methodology/cii-risk-scores.mdx'),
      /\]\(https:\/\/www\.worldmonitor\.app\/accuracy\/\)/,
      'the CII methodology doc says the score is not a forecast; it must point at the graded record',
    );
    const post = read('blog-site/src/content/blog/ai-forecast-accuracy-brier-scorecard-worldmonitor.md');
    assert.equal(
      post.split('](https://www.worldmonitor.app/accuracy/)').length - 1,
      1,
      'the July snapshot post must point at the standing record exactly once',
    );
    const editorialLinks = JSON.parse(read('tests/fixtures/editorial-corpus-links.json'));
    assert.ok(
      editorialLinks['ai-forecast-accuracy-brier-scorecard-worldmonitor']?.includes('/accuracy/'),
      'tests/blog-seo-contract.test.mjs enforces the link only for targets listed in its fixture',
    );
  });

  it('writes both artifacts under public/accuracy and nothing else', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'wm-accuracy-'));
    try {
      const { tpl } = fakeTpl();
      writeAccuracySection({
        outDir,
        baseUrl: BASE_URL,
        tpl,
        section: LIVE_SECTION,
        lastmod: '2026-09-10',
        dataset: DATASET,
        dataCatalog: DATA_CATALOG,
        snapshotPath: SNAPSHOT_PATH,
      });
      assert.ok(existsSync(join(outDir, 'accuracy', 'index.html')));
      assert.ok(existsSync(join(outDir, 'accuracy', 'scorecard.json')));
      const written = JSON.parse(readFileSync(join(outDir, 'accuracy', 'scorecard.json'), 'utf8'));
      assert.equal(written.record.headline, 'current');
      assert.doesNotMatch(readFileSync(join(outDir, 'accuracy', 'index.html'), 'utf8'), /betEngine/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
