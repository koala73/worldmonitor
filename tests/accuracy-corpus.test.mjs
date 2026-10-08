import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCURACY_CONTENT_VERSION,
  ACCURACY_DOMAIN_LABELS,
  ACCURACY_FAILURE_CODES,
  ACCURACY_PAGE_PATH,
  MARKET_ALERT_TYPE_LABELS,
  SCORECARD_DECLARED_FIELDS,
  SCORECARD_LIVE_ONLY_FIELDS,
  SCORECARD_STALE_AFTER_HOURS,
  accuracyAuditNotice,
  accuracyDatasetDownload,
  classifyAccuracyState,
  proportionIntervals,
  renderAccuracyPage,
  renderAccuracyLlmsSection,
  selectDeclaredScorecardFields,
  writeAccuracySection,
} from '../scripts/build-accuracy-page.mjs';
import { MARKET_ALERT_BASE_RATE_RULE, MARKET_ALERT_RESOLUTION_RULE, buildScorecard } from '../scripts/_market-alert-ledger.mjs';
import { MARKET_ALERT_TYPES } from '../scripts/shared/market-alert-core.js';
import { FORECAST_ACCURACY_AUDIT } from '../shared/forecast-accuracy-audit.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Every suite below except the #8990 one pins the record as it reads once the
// audit switch is lifted; that suite pins the state the switch publishes today.
const LIFTED = null;
const read = (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8');

// Issue #7072: the scorecard now carries a bootstrap interval on each mean
// Brier and the matured-to-scored funnel. Bounds on a mean score cannot be
// recomputed from published counts, so the page prints the producer's and only
// when the interval covers the same population as the score beside it.
// Since #8990 the intervals resample whole forecast families, and
// insufficientSample carries the family minimums: the headline's measurable gate.
const UNCERTAINTY = Object.freeze({
  method: 'family-level percentile bootstrap (each resample draws whole forecast families), 2000 resamples, seed 7072',
  overallBrier: { count: 490, mean: 0.192435, ci95: [0.178214, 0.207013], insufficientSample: false },
  skillBrier: { count: 180, mean: 0.117824, ci95: [0.098461, 0.139207], insufficientSample: false },
});
// The live values captured from GET /api/forecast/v1/get-forecast-scorecard on
// the day this page shipped. Kept verbatim so the honesty rules are exercised
// against a real funnel — 96 entries awaiting a judge and a `political` domain
// with nothing scored are the states the page must not round away.
const LIVE_SCORECARD = Object.freeze({
  schemaVersion: 2,
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
  // Added with #8990: the family gate rides on the headline interval.
  uncertainty: UNCERTAINTY,
  // The live capture predates skill.yesCount (#8873).
  skill: { count: 180, brier: 0.117824, logScore: 0.375127, excludedScored: 310, excludedOrigins: ['bet_engine', 'state_derived'] },
  // conflict met the family minimums, so the producer wrote its bss; the
  // others did not.
  publishedByDomain: [
    { domain: 'conflict', count: 120, brier: 0.11, yesCount: 30, bss: 0.413333 },
    { domain: 'market', count: 60, brier: 0.13, yesCount: 22 },
    { domain: 'political', count: 12, brier: 0.2, yesCount: 4 },
  ],
  familyOutcomes: [{ forecastId: 'fc-conflict-1', outcome: 'YES' }],
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

// A headline cohort with its family-bootstrap Brier interval over the same
// forecasts; `small` is the producer's family-minimums flag (#8990).
const skillSection = (skill, { ci95 = [skill.brier - 0.02, skill.brier + 0.02], small = false } = {}) => sectionWith({
  skill: { ...LIVE_SCORECARD.skill, ...skill },
  uncertainty: {
    ...UNCERTAINTY,
    skillBrier: { count: skill.count ?? LIVE_SCORECARD.skill.count, mean: skill.brier ?? LIVE_SCORECARD.skill.brier, ci95, insufficientSample: small },
  },
});

const FUNNEL = Object.freeze({
  matured: 820,
  immature: 130,
  maturityUnknown: 8,
  resolved: 772,
  scored: 490,
  pendingHardMatured: 12,
  pendingJudgeMatured: 36,
  resolvedOfMatured: { count: 820, successes: 772, rate: 0.941463, ci95: [0.923243, 0.955567] },
  scoredOfMatured: { count: 820, successes: 490, rate: 0.597561, ci95: [0.563617, 0.630595] },
});
// Issue #5092: the newest resolved forecasts, as the seeder publishes them.
const RECEIPTS = Object.freeze([
  { question: 'Will the Brent crude oil price rise to at least 104.89 USD/bbl by 2026-09-09?', forecastAt: Date.parse('2026-09-05T12:00:00Z'), probability: 0.35, outcome: 'NO', resolvedAt: Date.parse('2026-09-10T03:00:00Z'), sourceFeed: 'commodity-prices', observedValue: 100.75 },
  { question: 'Within the 30d horizon, did Nigeria see escalated armed conflict?', forecastAt: Date.parse('2026-08-10T00:00:00Z'), probability: 0.7, outcome: 'YES', resolvedAt: Date.parse('2026-09-09T22:00:00Z'), citationTitle: 'Dozens abducted in attacks on villages in Nigeria - BBC', citationUrl: 'https://www.bbc.co.uk/news/world-africa-1' },
  { question: 'Within the 30d horizon, did Syria see escalated armed conflict?', forecastAt: Date.parse('2026-08-09T00:00:00Z'), probability: 0.697, outcome: 'VOID', resolvedAt: Date.parse('2026-09-09T21:00:00Z'), voidReason: 'beyond_archive_horizon' },
  { question: 'Will cyber threat reports rise <img src=x onerror=alert(1)>?', forecastAt: Date.parse('2026-09-01T00:00:00Z'), probability: 0.6, outcome: 'YES', resolvedAt: Date.parse('2026-09-08T00:00:00Z'), sourceFeed: 'cyber-threats', observedValue: 41 },
]);
const WITH_INTERVALS = sectionWith({ uncertainty: UNCERTAINTY, funnel: FUNNEL, receipts: RECEIPTS });
// Issue #8867: the market-alert ledger's rolling hit rates, as the RPC serves
// them after its own whitelist.
const MARKET_ALERTS = Object.freeze({
  generatedAt: Date.parse('2026-09-10T20:00:00Z'),
  windowHours: 6,
  rollingWindowDays: 30,
  methodology: 'An emission resolves HIT when a tracked story names the same entity within six hours.',
  byType: [
    { type: 'market', scored: 40, hitRate: 0.75, baseN: 2, baseHitRate: 0.5, pairedHitRate: 0.5, medianLeadTimeMs: 3600000 },
    { type: 'prediction-market', scored: 0, baseN: 0 },
  ],
});

function protoMessageFields(messageName) {
  const proto = read('proto/worldmonitor/forecast/v1/get_forecast_scorecard.proto');
  const block = proto.match(new RegExp(`message ${messageName} \\{([\\s\\S]*?)\\n\\}`))[1];
  return [...block.matchAll(/^\s*(?:optional |repeated )?[A-Za-z0-9_.]+ ([a-z0-9_]+) = \d+/gm)]
    .map(([, name]) => name.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase()));
}

describe('forecast scorecard field whitelist', () => {
  it('declares exactly the fields proto GetForecastScorecardResponse declares', () => {
    const declared = protoMessageFields('GetForecastScorecardResponse');
    assert.ok(declared.length > 10, 'the proto parse must actually find fields');
    assert.deepEqual(
      [...SCORECARD_DECLARED_FIELDS, ...SCORECARD_LIVE_ONLY_FIELDS].sort(),
      declared.sort(),
      'the published field list must track the proto, or an undeclared seeder field can reach the page',
    );
  });

  it('whitelists the market-alert block to the members proto MarketAlertScorecard and MarketAlertRow declare (#8867)', () => {
    const containerFields = protoMessageFields('MarketAlertScorecard');
    const rowFields = protoMessageFields('MarketAlertRow');
    assert.ok(containerFields.length > 3 && rowFields.length > 5, 'the proto parse must actually find fields');
    const numbered = (fields) => Object.fromEntries(fields.map((field, index) => [field, index + 1]));
    const selected = selectDeclaredScorecardFields({
      ...LIVE_SCORECARD,
      marketAlerts: {
        ...numbered([...containerFields, 'schemaVersion', 'totals', 'archive']),
        byType: [numbered([...rowFields, 'pending', 'resolved', 'hit', 'miss', 'void'])],
      },
    });
    assert.deepEqual(Object.keys(selected.marketAlerts).sort(), containerFields.sort());
    assert.deepEqual(Object.keys(selected.marketAlerts.byType[0]).sort(), rowFields.sort());
  });

  it('yields no marketAlerts key for a payload captured before the block existed', () => {
    const selected = selectDeclaredScorecardFields(LIVE_SCORECARD);
    assert.equal(Object.hasOwn(selected, 'marketAlerts'), false);
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
      publishedByDomain: [{ domain: 'market', count: 40, brier: 0.21, yesCount: 12, origins: ['detector'] }],
    };
    const selected = selectDeclaredScorecardFields(leaky);
    assert.deepEqual(selected.publishedByDomain, [{ domain: 'market', count: 40, brier: 0.21, yesCount: 12 }]);
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
    audit: LIFTED,
    ...overrides,
  });
  return { html, state, shell: calls[0], jsonLd: calls[0].jsonLd };
}

function downloadFor(section) {
  return JSON.parse(accuracyDatasetDownload({
    state: classifyAccuracyState(section),
    snapshotPath: SNAPSHOT_PATH,
    audit: LIFTED,
  }));
}

const stripTags = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/** Elements holding a predicted-probability RANGE, which is not a rate. */
const withoutProbabilityBands = (html) => html.replace(/<(th|span)\b[^>]*\bdata-probability-band\b[^>]*>[\s\S]*?<\/\1>/g, '<$1></$1>');
// Interval bounds belong to the counted rate printed beside them, and "95%"
// names a confidence level, not a rate; neither needs a population of its own.
const withoutIntervals = (html) => html
  .replace(/<span data-rate-interval>[\s\S]*?<\/span>/g, '<span></span>')
  .replace(/95% (?:Wilson )?interval/g, 'confidence interval');

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
    const text = stripTags(withoutIntervals(withoutProbabilityBands(html)));
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
    const rules = [...text.matchAll(/[Ll]ower .{0,20}Brier .{0,20}is better|[Ll]ower is better/g)].map((match) => match.index);
    assert.ok(headline > 0, 'the headline-cohort Brier must be rendered');
    assert.ok(rules.length > 0, 'the page must state the direction of the scale');
    const gap = Math.min(...rules.map((index) => Math.abs(index - headline)));
    assert.ok(gap < 700, `the scale direction must sit beside the number (gap ${gap})`);
  });

  it('states the headline result in a sentence, not only in a metric tile, and never against a coin flip (#8990)', () => {
    // p = 40/180, p(1-p) = 0.1728, so the skill score is 1 - 0.117824 / 0.1728 = +0.32.
    const { html } = renderState(skillSection({ yesCount: 40, brier: 0.117824, bssCi95: [-0.05, 0.6] }, { ci95: [0.098461, 0.18] }));
    const result = html.match(/<p data-accuracy-result>([\s\S]*?)<\/p>/);
    assert.ok(result, 'the headline result must be a sentence an extractor can lift, not a tile');
    const sentence = stripTags(result[1]);
    assert.match(sentence, /180-day window/);
    assert.match(sentence, /it is not yet clear whether World Monitor(?:'|&#39;)s headline forecasts beat always forecasting how often these events actually happened: a skill score of \+0\.32, 95% interval -0\.05 to \+0\.60/);
    assert.match(sentence, /Brier score was 0\.118/);
    assert.match(sentence, /over 180 scored forecasts from at least 30 forecast families/);
    // p = 40/180, p(1-p) = 0.1728.
    assert.match(sentence, /against 0\.173 for always forecasting the actual rate of 22\.2%/);
    assert.doesNotMatch(sentence, /historical/);
    assert.doesNotMatch(sentence, /0\.25|0\.5 to everything|coin/);
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
    const measurable = renderAccuracyLlmsSection(LIVE_SECTION, LIFTED);
    assert.match(measurable, /^## Forecast accuracy$/m);
    assert.match(measurable, /Brier of 0\.118/);
    assert.match(measurable, /180 scored forecasts/);
    assert.match(measurable, /180-day window/);
    assert.match(measurable, /Captured 2026-09-10/);
    assert.match(measurable, /does not publish/);
    assert.doesNotMatch(measurable, /issue #\d+/);

    const insufficient = renderAccuracyLlmsSection(sectionWith({
      skill: { count: 0, excludedScored: 310, excludedOrigins: ['bet_engine', 'state_derived'] },
    }), LIFTED);
    assert.match(insufficient, /headline cohort currently has no scored forecast/);
    assert.doesNotMatch(insufficient, /Brier of 0\.118/);

    const failed = renderAccuracyLlmsSection({
      attemptedAt: '2026-09-10',
      capturedAt: null,
      generatedAt: null,
      scorecard: null,
      failureCode: 'http-error',
    }, LIFTED);
    assert.match(failed, /latest capture failed, so no figures are published/);
    assert.doesNotMatch(failed, /no scored forecast in this window/);

    const missing = renderAccuracyLlmsSection(null, LIFTED);
    assert.match(missing, /No scorecard has been captured for this page yet/);

    const retained = renderAccuracyLlmsSection({
      attemptedAt: '2026-09-17',
      attemptedAtMs: Date.parse('2026-09-17T21:05:00Z'),
      capturedAt: '2026-09-10',
      generatedAt: LIVE_SCORECARD.generatedAt,
      scorecard: LIVE_SCORECARD,
      failureCode: 'http-error',
    }, LIFTED);
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

  it('marks a domain below the sample floor as not yet measured rather than leaving a cell empty', () => {
    const { html } = renderState(LIVE_SECTION);
    const row = html.match(/<tr data-domain="political">[\s\S]*?<\/tr>/)[0];
    assert.equal((row.match(/<td[^>]*>\s*<\/td>/g) || []).length, 0, 'an empty cell reads as a measured zero');
    assert.equal((row.match(/Not yet measured/g) || []).length, 3, 'every score column must be marked');
    assert.doesNotMatch(row, /0\.200/, 'a below-floor Brier is never printed');
    const scoredRow = html.match(/<tr data-domain="conflict">[\s\S]*?<\/tr>/)[0];
    assert.doesNotMatch(scoredRow, /Not yet measured/);
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
    // The cohort is the scored set minus excludedOrigins, not "published
    // origins". Name the exclusions.
    const text = stripTags(renderState(LIVE_SECTION).html);
    assert.match(text, /bet_engine/);
    assert.match(text, /state_derived/);
    assert.match(text, /310/, 'excludedScored must be published so the headline population is unambiguous');
    assert.doesNotMatch(text, /published origin/i, 'the code does not enforce a publication property');
  });

  it('states whether entries with no recorded origin count, from the excluded origins it renders', () => {
    const counted = stripTags(renderState(LIVE_SECTION).html);
    assert.match(counted, /filed as unknown and is counted/);
    assert.doesNotMatch(counted, /filed as unknown and is left out/);
    assert.match(downloadFor(LIVE_SECTION).headlineCohort.definition, /unknown and is included/);

    const excludedSection = sectionWith({
      skill: { count: 176, brier: 0.113943, logScore: 0.366094, excludedScored: 314, excludedOrigins: ['bet_engine', 'state_derived', 'unknown'] },
    });
    const html = renderState(excludedSection).html;
    const text = stripTags(html);
    assert.match(text, /filed as unknown and is left out/);
    assert.match(text, /predate origin tagging/);
    assert.doesNotMatch(text, /unknown and (is counted|does count)/);
    assert.match(html, /<tr data-origin="unknown"><th scope="row">unknown<\/th><td>No, excluded<\/td>/);
    const definition = downloadFor(excludedSection).headlineCohort.definition;
    assert.match(definition, /unknown and is excluded/);
    assert.doesNotMatch(definition, /is included/);

    // excludedOrigins lists only origins with scored entries, so once unknown
    // rows age out of the window its absence must not read as "counted".
    const agedOut = sectionWith({
      byGenerationOrigin: LIVE_SCORECARD.byGenerationOrigin.filter((row) => row.generationOrigin !== 'unknown'),
      skill: { count: 176, brier: 0.113943, logScore: 0.366094, excludedScored: 310, excludedOrigins: ['bet_engine', 'state_derived'] },
    });
    assert.match(stripTags(renderState(agedOut).html), /filed as unknown; none was scored in this window/);
    assert.match(downloadFor(agedOut).headlineCohort.definition, /none was scored in this window/);

    // A VOID-only unknown row: the caption and the row must give one answer.
    const voidOnly = sectionWith({
      byGenerationOrigin: LIVE_SCORECARD.byGenerationOrigin.map((row) => (row.generationOrigin === 'unknown' ? { ...row, scored: 0, brier: undefined, logScore: undefined } : row)),
      skill: { count: 176, brier: 0.113943, logScore: 0.366094, excludedScored: 310, excludedOrigins: ['bet_engine', 'state_derived'] },
    });
    const voidOnlyHtml = renderState(voidOnly).html;
    assert.match(stripTags(voidOnlyHtml), /filed as unknown; none was scored in this window/);
    assert.match(voidOnlyHtml, /<tr data-origin="unknown"><th scope="row">unknown<\/th><td>No scored entries<\/td>/);
  });

  it('describes the scored share of the ledger by its definition, not by its field name', () => {
    const text = stripTags(renderState(LIVE_SECTION).html);
    assert.doesNotMatch(text, /publicationCoverage/, 'the field name states a property the number does not have');
    assert.match(text, /51\.1% of 958/, 'scored over all entries, with both counts');
  });

  it('explains the unscored horizons and the absent score intervals without leaning on issue numbers', () => {
    const { html } = renderState(LIVE_SECTION);
    const text = stripTags(html);
    assert.match(text, /No confidence intervals on the log scores/i);
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

  it('says the horizon projections are no longer published, never that the product shows them (#8967)', () => {
    const text = stripTags(renderState(LIVE_SECTION).html);
    const llms = renderAccuracyLlmsSection(LIVE_SECTION, LIFTED);
    for (const [surface, body] of [['page', text], ['llms-full', llms]]) {
      assert.doesNotMatch(body, /shown in the product/i, `${surface} claims the product shows the projections`);
      assert.match(body, /no longer publishe[sd]/i, `${surface} must say the projections are no longer published`);
      assert.match(body, /2026-10-07|7 October 2026/, `${surface} must date the change`);
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

  it('publishes no evidence store, judge input or internal key surface', () => {
    const { html } = renderState(WITH_INTERVALS);
    const download = downloadFor(WITH_INTERVALS);
    for (const forbidden of [/betEngine/, /judgedLane/, /r2:\/\//, /forecastId/, /evidenceKey/, /rationale/, /judgments/, /metricKey/, /seed-data\//]) {
      assert.doesNotMatch(html, forbidden, `the page must not publish ${forbidden}`);
      assert.doesNotMatch(JSON.stringify(download), forbidden, `the distribution must not publish ${forbidden}`);
    }
  });

  it('whitelists the distribution rather than spreading the captured payload', () => {
    const leaky = {
      ...LIVE_SECTION,
      scorecard: {
        ...WITH_INTERVALS.scorecard,
        betEngine: { count: 299 },
        judgedLane: 'shadow',
        marketAlerts: {
          ...MARKET_ALERTS,
          archive: { coveredFromMs: 1 },
          byType: MARKET_ALERTS.byType.map((row) => ({ ...row, pending: 1 })),
        },
      },
    };
    const { html } = renderState(leaky);
    const download = downloadFor(leaky);
    assert.doesNotMatch(html, /betEngine|judgedLane|shadow|coveredFromMs/);
    assert.doesNotMatch(JSON.stringify(download), /betEngine|judgedLane|shadow|coveredFromMs/);
    assert.deepEqual(
      Object.keys(download.scorecard).sort(),
      [...SCORECARD_DECLARED_FIELDS].sort(),
      'the distribution carries the declared surface and nothing else',
    );
    assert.deepEqual(download.scorecard.marketAlerts, MARKET_ALERTS);
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
    assert.deepEqual(download.confidenceIntervals.proportions, { published: true, method: 'wilson-95' });
    assert.equal(download.confidenceIntervals.meanScores.logScore.published, false);
    // Some horizons are graded internally since #8939, so a bare `scored: false`
    // was untrue. The flags say what this file and page publish, nothing more.
    assert.deepEqual(download.horizonProjections, {
      valuesPublished: false,
      gradesPublished: false,
      trackedIn: 'https://github.com/koala73/worldmonitor/issues/7075',
    });
    assert.equal(download.headlineCohort.excludedScored, 310);
    assert.deepEqual(download.headlineCohort.excludedOrigins, ['bet_engine', 'state_derived']);
    assert.deepEqual(download.pooledPopulations, {
      calibration: 'all-scored-entries',
      vsMarketSkill: 'all-scored-entries',
      overall: 'all-scored-entries',
    });
  });
});

// Issue #7072: every binomial proportion on the page carries a Wilson 95%
// interval derived from the two counts the page already publishes. Expected
// bounds are golden values, so a formula change cannot pass by moving both sides.
describe('accuracy page published-origin domain table (#8952)', () => {
  const tableOf = (html) => html.match(/<table data-by-domain>[\s\S]*?<\/table>/)?.[0] ?? null;
  const rowText = (html, domain) => stripTags(html.match(new RegExp(`<tr data-domain="${domain}">[\\s\\S]*?</tr>`))[0]);

  it('renders publishedByDomain under an anchor, with skill, Brier and the actual-rate Brier p(1-p)', () => {
    const { html } = renderState(LIVE_SECTION);
    assert.match(html, /<h2 id="by-domain">Accuracy by domain<\/h2>/);
    const table = tableOf(html);
    assert.ok(table, 'the published domain table renders');
    assert.deepEqual([...table.matchAll(/<tr data-domain="([^"]+)"/g)].map(([, d]) => d), ['conflict', 'market', 'political']);
    // conflict: p = 30/120, p(1-p) = 0.1875; the producer wrote bss once it met the minimums.
    assert.match(rowText(html, 'conflict'), /Conflict\s*120\s*\+0\.41\s*0\.110\s*0\.188/);
    // market carries no bss: below the family minimums, so no score is printed.
    assert.match(rowText(html, 'market'), /Market\s*60\s*Not yet measured\s*Not yet measured\s*Not yet measured/);
  });

  it('labels rows with the same human domain names the card badge uses', () => {
    const { html } = renderState(sectionWith({
      publishedByDomain: [
        { domain: 'supply_chain', count: 40, brier: 0.2, yesCount: 10, bss: -0.07 },
        { domain: 'infrastructure', count: 40, brier: 0.2, yesCount: 10, bss: -0.07 },
        { domain: 'geopolitical', count: 40, brier: 0.2, yesCount: 10, bss: -0.07 },
      ],
    }));
    const headers = [...tableOf(html).matchAll(/<th scope="row">([^<]+)<\/th>/g)].map(([, label]) => label);
    assert.deepEqual(headers, ['Supply Chain', 'Infra', 'Geopolitical']);
    const panel = read('src/components/ForecastPanel.ts');
    const badgeLabels = Object.fromEntries([...panel.match(/const DOMAIN_LABELS[^{]*\{([\s\S]*?)\};/)[1].matchAll(/(\w+):\s*'([^']+)'/g)].map(([, k, v]) => [k, v]));
    delete badgeLabels.all;
    assert.deepEqual(ACCURACY_DOMAIN_LABELS, badgeLabels, 'the page and the badge must share domain labels');
  });

  it('treats a row with no graded count as not yet measured, even when it carries bss', () => {
    for (const count of [0, -1, 2.5]) {
      const { html } = renderState(sectionWith({ publishedByDomain: [{ domain: 'conflict', count, brier: 0.2, yesCount: 0, bss: 0.1 }] }));
      assert.match(rowText(html, 'conflict'), /Not yet measured/, `count ${count}`);
      assert.doesNotMatch(rowText(html, 'conflict'), /NaN/);
    }
  });

  it('treats a non-integer yesCount as not yet measured, matching the badge', () => {
    const { html } = renderState(sectionWith({ publishedByDomain: [{ domain: 'conflict', count: 40, brier: 0.2, yesCount: 10.5, bss: -0.07 }] }));
    assert.match(rowText(html, 'conflict'), /Not yet measured/);
  });

  it('drops the pooled all-origin domain table from the page', () => {
    const { html } = renderState(LIVE_SECTION);
    const table = tableOf(html);
    assert.doesNotMatch(table, /data-domain="cyber"|data-domain="energy"/, 'domains with only pooled rows do not appear');
    assert.doesNotMatch(table, /0\.241727|0\.242|272/, 'the pooled market row is not printed');
    assert.equal((html.match(/<table data-by-domain/g) || []).length, 1);
  });

  it('applies the producer family gate: a row is measured only when it carries bss, whatever its count (#8990)', () => {
    const { html } = renderState(sectionWith({
      publishedByDomain: [
        { domain: 'conflict', count: 300, brier: 0.2, yesCount: 100 },
        { domain: 'market', count: 30, brier: 0.21, yesCount: 10, bss: 0.055 },
      ],
    }));
    assert.match(rowText(html, 'conflict'), /300\s*Not yet measured\s*Not yet measured\s*Not yet measured/, '300 rows from too few families stay unmeasured');
    assert.match(rowText(html, 'market'), /30\s*\+0\.06\s*0\.210\s*0\.222/);
  });

  it('names its population and its sample rule in the caption', () => {
    const caption = stripTags(tableOf(renderState(LIVE_SECTION).html).match(/<caption>[\s\S]*?<\/caption>/)[0]);
    assert.match(caption, /published/i);
    assert.match(caption, /bet_engine/);
    assert.doesNotMatch(caption, /unpromoted/, 'the table excludes bet_engine even when promotion is on');
    assert.match(caption, /at least 30 forecast families, with at least 5 that came true and 5 that did not/);
    assert.doesNotMatch(caption, /better|worse/i, 'a domain score carries no interval, so the caption claims no direction');
  });

  it('says so instead of a table when the scorecard predates the published breakdown', () => {
    const { publishedByDomain: _omit, ...legacy } = LIVE_SCORECARD;
    for (const scorecard of [{ ...legacy, schemaVersion: 1 }, { ...LIVE_SCORECARD, schemaVersion: 1 }]) {
      const { html } = renderState({ ...LIVE_SECTION, scorecard });
      assert.match(html, /<h2 id="by-domain">/);
      assert.equal(tableOf(html), null);
      assert.match(stripTags(html), /predates the published-origin domain breakdown/);
    }
  });

  it('says no published forecast is graded yet when the breakdown is empty', () => {
    const { html } = renderState(sectionWith({ publishedByDomain: [] }));
    assert.equal(tableOf(html), null);
    assert.match(stripTags(html), /No published forecast has been graded in any domain/);
  });
});

describe('accuracy page market-alert hit rates (#8867)', () => {
  const HOUR = 3_600_000;
  const row = (type, overrides = {}) => ({
    type, scored: 80, hitRate: 0.625, baseN: 32, baseHitRate: 0.25, pairedHitRate: 0.59375, medianLeadTimeMs: 2.5 * HOUR, ...overrides,
  });
  const withAlerts = (byType, overrides = {}) => sectionWith({
    marketAlerts: { ...MARKET_ALERTS, methodology: buildScorecard({}, 0, { archive: {} }).methodology, byType, ...overrides },
  });
  const tableOf = (html) => html.match(/<table data-market-alerts>[\s\S]*?<\/table>/)?.[0] ?? null;
  const cellsOf = (html, type) => [...html.match(new RegExp(`<tr data-alert-type="${type}">([\\s\\S]*?)</tr>`))[1]
    .matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(([, cell]) => stripTags(cell).trim());

  it('shows count, hit rate, the paired comparison with its base count, and the median lead time', () => {
    const { html } = renderState(withAlerts([row('silent_divergence')]));
    assert.match(html, /<h2 id="market-alerts">/);
    assert.deepEqual(cellsOf(html, 'silent_divergence'), [
      MARKET_ALERT_TYPE_LABELS.silent_divergence,
      '80',
      '62.5% of 80 alerts',
      '59.4% of 32 alerts',
      '25.0% of 32 earlier windows',
      '2 h 30 min',
    ]);
  });

  it('applies the n>=30 floor separately to the hit rate and to the paired comparison', () => {
    const { html } = renderState(withAlerts([
      row('explained_market_move', { scored: 29, baseN: 29 }),
      row('silent_divergence', { scored: 30, baseN: 29 }),
      row('flow_price_divergence', { scored: 30, baseN: 30 }),
    ]));
    const [, , belowHit, belowPaired, belowBase, belowLead] = cellsOf(html, 'explained_market_move');
    assert.deepEqual([belowHit, belowPaired, belowBase, belowLead], Array(4).fill('Not yet measurable'));
    const [, , hit, paired, base, lead] = cellsOf(html, 'silent_divergence');
    assert.equal(hit, '62.5% of 30 alerts');
    assert.deepEqual([paired, base], ['Not yet measurable', 'Not yet measurable']);
    assert.equal(lead, 'Not yet measurable', '19 hits are too few for a median');
    assert.deepEqual(cellsOf(html, 'flow_price_divergence').slice(3, 5), ['59.4% of 30 alerts', '25.0% of 30 earlier windows']);
  });

  it('shows the median lead time only once 30 alerts were followed by news', () => {
    const { html } = renderState(withAlerts([
      row('silent_divergence', { scored: 48, hitRate: 0.625 }),
      row('explained_market_move', { scored: 48, hitRate: 0.6 }),
    ]));
    assert.equal(cellsOf(html, 'silent_divergence')[5], '2 h 30 min', '30 hits');
    assert.equal(cellsOf(html, 'explained_market_move')[5], 'Not yet measurable', '29 hits');
  });

  it('publishes nothing measured for prediction_leads_news until its control windows scored', () => {
    const unpaired = renderState(withAlerts([row('prediction_leads_news', { scored: 120, baseN: 12 })])).html;
    assert.deepEqual(cellsOf(unpaired, 'prediction_leads_news').slice(2), Array(4).fill('Not yet measurable'));
    assert.doesNotMatch(tableOf(unpaired), /62\.5%|25\.0%|2 h 30 min/);
    const paired = renderState(withAlerts([row('prediction_leads_news', { scored: 120, baseN: 30 })])).html;
    assert.deepEqual(cellsOf(paired, 'prediction_leads_news').slice(2), [
      '62.5% of 120 alerts', '59.4% of 30 alerts', '25.0% of 30 earlier windows', '2 h 30 min',
    ]);
  });

  it('treats a missing or out-of-range rate as not yet measurable rather than printing it', () => {
    const { html } = renderState(withAlerts([row('silent_divergence', { hitRate: undefined, pairedHitRate: 1.2, medianLeadTimeMs: undefined })]));
    assert.deepEqual(cellsOf(html, 'silent_divergence').slice(2), [
      'Not yet measurable', 'Not yet measurable', 'Not yet measurable', 'Not yet measurable',
    ]);
    assert.doesNotMatch(html, /undefined|NaN/);
  });

  it('describes alerts raised with related news as well as alerts raised without it', () => {
    const intro = stripTags(renderState(withAlerts([row('silent_divergence')])).html.match(/<h2 id="market-alerts">[\s\S]*?<\/h2>\s*<p>([\s\S]*?)<\/p>/)[1]);
    assert.match(intro, /no news/);
    assert.match(intro, /related news is already out/);
    assert.doesNotMatch(intro, /news does not explain the move yet/);
  });

  it('quotes the ledger resolution and base-rate rules verbatim', () => {
    const { html } = renderState(withAlerts([row('silent_divergence')]));
    const text = stripTags(html).replaceAll('&#39;', "'");
    for (const rule of [MARKET_ALERT_RESOLUTION_RULE, MARKET_ALERT_BASE_RATE_RULE]) {
      assert.ok(text.includes(rule), `the page must quote: ${rule.slice(0, 50)}...`);
    }
    assert.equal(buildScorecard({}, 0, { archive: {} }).methodology, `${MARKET_ALERT_RESOLUTION_RULE} ${MARKET_ALERT_BASE_RATE_RULE}`,
      'the quoted rules are the ones the ledger scores under');
  });

  it('quotes the rules captured with the figures, not the rules in the current code (#8985)', () => {
    const captured = 'Captured rule: an alert resolves HIT when a fixture story names it.';
    const text = stripTags(renderState(withAlerts([row('silent_divergence')], { methodology: captured })).html);
    assert.ok(text.includes(captured), 'the page quotes the rules the figures were scored under');
    for (const rule of [MARKET_ALERT_RESOLUTION_RULE, MARKET_ALERT_BASE_RATE_RULE]) {
      assert.equal(text.replaceAll('&#39;', "'").includes(rule), false, 'a rule changed after the capture must not sit beside the old figures');
    }
  });

  it('applies the page median floor and control gate to the dataset download (#8985)', () => {
    const download = downloadFor(withAlerts([
      row('silent_divergence', { scored: 48, hitRate: 0.625 }),
      row('explained_market_move', { scored: 48, hitRate: 0.6 }),
      row('prediction_leads_news', { scored: 120, baseN: 12 }),
      row('flow_price_divergence', { scored: 120, baseN: 30 }),
    ]));
    const median = Object.fromEntries(download.scorecard.marketAlerts.byType.map((entry) => [entry.type, entry.medianLeadTimeMs]));
    assert.deepEqual(median, {
      silent_divergence: 2.5 * HOUR,
      explained_market_move: undefined,
      prediction_leads_news: undefined,
      flow_price_divergence: 2.5 * HOUR,
    }, 'a capture taken before the API floor must not publish a median the page withholds');
    const kept = download.scorecard.marketAlerts.byType.find((entry) => entry.type === 'explained_market_move');
    assert.equal(kept.scored, 48, 'only the median is withheld; the row stays');
  });

  it('says the rules were not captured rather than quoting the current code', () => {
    for (const methodology of [undefined, '', '   ']) {
      for (const byType of [[row('silent_divergence')], []]) {
        const text = stripTags(renderState(withAlerts(byType, { methodology })).html);
        assert.match(text, /This edition did not capture the rules these alerts were scored under\./);
        assert.equal(text.replaceAll('&#39;', "'").includes(MARKET_ALERT_RESOLUTION_RULE), false);
      }
    }
  });

  it('labels every alert type the ledger scores in plain words', () => {
    assert.deepEqual(Object.keys(MARKET_ALERT_TYPE_LABELS).sort(), [...MARKET_ALERT_TYPES].sort());
    const { html } = renderState(withAlerts(MARKET_ALERT_TYPES.map((type) => row(type))));
    for (const type of MARKET_ALERT_TYPES) assert.equal(cellsOf(html, type)[0], MARKET_ALERT_TYPE_LABELS[type]);
    assert.doesNotMatch(stripTags(tableOf(html)), /_/, 'no internal type ids in the table text');
  });

  it('keeps every published percentage next to its population', () => {
    const { html } = renderState(withAlerts(MARKET_ALERT_TYPES.map((type) => row(type))));
    const text = stripTags(tableOf(html));
    const percentages = [...text.matchAll(/\d[\d.]*%/g)];
    assert.equal(percentages.length, 12);
    for (const match of percentages) assert.match(text.slice(match.index, match.index + 30), /% of [\d,]+ /);
  });

  it('renders an honest absent state for a snapshot captured before the block existed', () => {
    const { html } = renderState(LIVE_SECTION);
    assert.match(html, /<h2 id="market-alerts">/);
    assert.equal(tableOf(html), null);
    assert.match(stripTags(html), /This edition carries no market-alert scores/);
    assert.doesNotMatch(stripTags(html), /captured before/, 'an absent block can also mean a failed read');
  });

  it('says no alert has been scored when the ledger has no rows', () => {
    const { html } = renderState(withAlerts([]));
    assert.equal(tableOf(html), null);
    assert.match(stripTags(html), /No market alert has been scored yet/);
  });
});

describe('accuracy page proportion intervals', () => {
  const rowOf = (html, marker) => stripTags(html.match(new RegExp(`<tr ${marker}[\\s\\S]*?</tr>`))[0]);

  it('prints no interval for counts that cannot form a proportion', () => {
    const intervals = proportionIntervals({
      totals: { void: 12, resolved: 10 },
      calibration: [{ bucket: '0.9-1.0', minProbability: 0.9, maxProbability: 1, count: 4, realizedRate: 1.5 }],
    });
    assert.equal(intervals.void, null);
    assert.equal(intervals.calibration['0.9-1.0'], undefined);
  });

  it('promises intervals only for the rates that carry one', () => {
    const text = stripTags(renderState(LIVE_SECTION).html);
    assert.doesNotMatch(text, /Every rate (does )?carr/);
    assert.match(text, /scored share of the ledger and the base rates/);
  });

  it('says the ledger totals leave out forecasts withheld under #5234', () => {
    const caption = renderState(LIVE_SECTION).html.match(/<table data-ledger-totals>[\s\S]*?<\/caption>/)[0];
    assert.match(stripTags(caption), /withheld under issue #5234/);
  });

  it('puts a Wilson interval beside the overall void rate', () => {
    const totals = renderState(LIVE_SECTION).html.match(/<table data-ledger-totals>[\s\S]*?<\/table>/)[0];
    assert.match(stripTags(totals), /36\.5% of 772 resolved entries \(282 entries\), 95% interval 33\.2% to 40\.0%/);
  });

  it('puts a Wilson interval beside every calibration realized rate', () => {
    const { html } = renderState(LIVE_SECTION);
    assert.match(rowOf(html, 'data-calibration-bucket="0-10"'), /0\.0% of 40 forecasts 0\.0% to 8\.8%/);
    assert.match(rowOf(html, 'data-calibration-bucket="90-100"'), /100\.0% of 1 forecasts 20\.7% to 100\.0%/, 'n=1 is published with its full width');
  });

  it('puts a Wilson interval beside each domain and origin void rate, and none on an empty denominator', () => {
    const { html } = renderState(LIVE_SECTION);
    assert.match(rowOf(html, 'data-origin="bet_engine"'), /0\.0% of 299 resolved 0\.0% to 1\.3%/);
    const empty = sectionWith({ byGenerationOrigin: [{ generationOrigin: 'macro_engine', resolved: 0, scored: 0, void: 0, voidRate: 0 }] });
    assert.match(rowOf(renderState(empty).html, 'data-origin="macro_engine"'), /No interval/);
  });

  it('publishes the same intervals in the distribution, with their counts', () => {
    const { intervals } = downloadFor(LIVE_SECTION);
    assert.equal(intervals.method, 'wilson-95');
    assert.deepEqual(intervals.void, { successes: 282, count: 772, ci95: [0.332064, 0.39984] });
    assert.deepEqual(intervals.calibration['0-10'], { successes: 0, count: 40, ci95: [0, 0.087622] });
    assert.deepEqual(intervals.byDomain.political, { successes: 6, count: 6, ci95: [0.609666, 1] });
    assert.equal(Object.hasOwn(intervals.calibration, '70-80'), false, 'an empty bucket has no estimate');
  });
});

describe('accuracy page forecast receipts (#5092)', () => {
  const receiptsOf = (html) => {
    const table = html.match(/<table data-forecast-receipts>[\s\S]*?<\/table>/);
    return table ? table[0] : null;
  };

  it('whitelists receipt rows down to their declared members', () => {
    const selected = selectDeclaredScorecardFields({
      ...WITH_INTERVALS.scorecard,
      receipts: [{ ...RECEIPTS[0], key: 'commodity:BZ=F@1', rationale: 'judge text', evidence: { metricKey: 'x' } }],
    });
    assert.deepEqual(selected.receipts, [RECEIPTS[0]]);
  });

  it('leaves the live-card family outcomes out of the frozen page and download', () => {
    const selected = selectDeclaredScorecardFields({
      ...WITH_INTERVALS.scorecard,
      familyOutcomes: [{ forecastId: 'fc-1', outcome: 'VOID', voidReason: 'other' }],
    });
    assert.equal(Object.hasOwn(selected, 'familyOutcomes'), false);
    assert.deepEqual([...SCORECARD_LIVE_ONLY_FIELDS], ['familyOutcomes', 'underAudit']);
  });

  it('renders the receipts newest first with what was forecast, when, the chance, the outcome and the source', () => {
    const table = receiptsOf(renderState(WITH_INTERVALS).html);
    assert.ok(table, 'the receipts must be a real table');
    assert.match(table, /<caption>[^<]*published forecasts[^<]*experimental, synthetic and unattributed origins[^<]*<\/caption>/);
    const head = stripTags(table.match(/<thead>[\s\S]*?<\/thead>/)[0]);
    assert.match(head, /Forecast Made Chance given Outcome Resolved How it was settled/);
    const rows = [...table.matchAll(/<tr data-receipt-outcome="([A-Z]+)">([\s\S]*?)<\/tr>/g)];
    assert.deepEqual(rows.map(([, outcome]) => outcome), ['NO', 'YES', 'VOID', 'YES']);
    const text = rows.map(([, , cells]) => stripTags(cells).trim());
    assert.match(text[0], /Brent crude .* 2026-09-05 35% Did not happen 2026-09-10 Commodity prices read 100\.75/);
    assert.match(text[1], /Nigeria .* 2026-08-10 70% Happened 2026-09-09 Judged against archived news: Dozens abducted in attacks on villages in Nigeria - BBC/);
    assert.match(text[2], /Syria .* 69\.7% Void 2026-09-09 The news archive no longer covered the question window/);
  });

  it('escapes attacker-controllable text and links only https citations', () => {
    const hostile = sectionWith({
      receipts: [
        RECEIPTS[3],
        { ...RECEIPTS[1], citationTitle: 'Headline "><script>x</script>', citationUrl: 'javascript:alert(1)' },
      ],
    });
    const table = receiptsOf(renderState(hostile).html);
    assert.doesNotMatch(table, /<img|<script|javascript:/);
    assert.match(table, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.equal((table.match(/<a /g) || []).length, 0, 'a non-https citation is printed without a link');
    const linked = receiptsOf(renderState(WITH_INTERVALS).html);
    assert.match(linked, /<a href="https:\/\/www\.bbc\.co\.uk\/news\/world-africa-1" rel="nofollow noopener">/);
  });

  it('reads unknown codes in plain words and drops rows with an unknown outcome', () => {
    const odd = sectionWith({
      receipts: [
        { ...RECEIPTS[0], sourceFeed: 'internal-feed' },
        { ...RECEIPTS[2], voidReason: 'something_new' },
        { ...RECEIPTS[0], outcome: 'MAYBE' },
        { ...RECEIPTS[0], sourceFeed: 'toString' },
        { ...RECEIPTS[2], voidReason: 'constructor' },
      ],
    });
    const text = stripTags(receiptsOf(renderState(odd).html));
    assert.match(text, /A World Monitor data feed read 100\.75/);
    assert.match(text, /Void 2026-09-09 Could not be resolved/);
    assert.doesNotMatch(text, /internal-feed|something_new|MAYBE|function|native code/);
    assert.equal(text.match(/A World Monitor data feed read 100\.75/g).length, 2, 'an inherited key is not a label');
    assert.equal(text.match(/Could not be resolved/g).length, 2);
  });

  it('shows an empty state when the capture carries no resolved forecasts', () => {
    const { html } = renderState(sectionWith({ receipts: [], totals: { ...LIVE_SCORECARD.totals, resolved: 0 } }));
    assert.equal(receiptsOf(html), null);
    assert.match(stripTags(html), /No forecast has resolved in this window yet/);
  });

  it('says the receipts are not carried when the field is absent', () => {
    const { html } = renderState(LIVE_SECTION);
    assert.equal(receiptsOf(html), null);
    assert.match(stripTags(html), /This capture does not carry per-forecast receipts\./);
    assert.doesNotMatch(stripTags(html), /No forecast has resolved|refresh adds/);
  });

  it('names both causes of an empty list beside resolved forecasts instead of guessing one', () => {
    // The API defaults the field to [], so an old seed and a window where only
    // excluded origins resolved look the same.
    const text = stripTags(renderState(sectionWith({ receipts: [] })).html);
    assert.match(text, /This capture carries no receipts: it predates them, or no published forecast resolved in the window\./);
    assert.doesNotMatch(text, /does not carry per-forecast receipts/);
  });

  it('does not tell LLM readers the page publishes aggregates only', () => {
    const llms = renderAccuracyLlmsSection(WITH_INTERVALS, LIFTED);
    assert.doesNotMatch(llms, /aggregates only|no individual forecasts/);
    assert.match(llms, /receipts for the most recently resolved published forecasts/);
  });

  it('prints an out-of-range receipt date as not recorded instead of failing the build', () => {
    const damaged = sectionWith({ receipts: [{ ...RECEIPTS[0], forecastAt: 1e20, resolvedAt: -1e20 }] });
    const text = stripTags(receiptsOf(renderState(damaged).html));
    assert.match(text, /35% Did not happen Not recorded/);
    assert.match(text, /Brent crude .* Not recorded 35%/);
  });

  it('publishes the receipts in the distribution as captured', () => {
    assert.deepEqual(downloadFor(WITH_INTERVALS).scorecard.receipts, RECEIPTS);
  });
});

describe('accuracy page Brier intervals and maturity funnel (#7072)', () => {
  const tileOf = (html, label) => stripTags(html.match(new RegExp(`<div class="metric"><span>${label}</span>[\\s\\S]*?</div>`))[0]);
  const funnelOf = (html) => {
    const table = html.match(/<table data-maturity-funnel>[\s\S]*?<\/table>/);
    return table ? stripTags(table[0]) : null;
  };

  it('whitelists both blocks down to their declared members, keeping a null interval', () => {
    const selected = selectDeclaredScorecardFields({
      ...WITH_INTERVALS.scorecard,
      uncertainty: { ...UNCERTAINTY, skillBrier: null, draws: [0.1], overallBrier: { ...UNCERTAINTY.overallBrier, scope: 'overall' } },
      funnel: { ...FUNNEL, entryIds: ['a'], scoredOfMatured: { ...FUNNEL.scoredOfMatured, sampleIds: ['b'] } },
    });
    assert.deepEqual(selected.uncertainty, { ...UNCERTAINTY, skillBrier: null });
    assert.deepEqual(selected.funnel, FUNNEL);
  });

  it('prints the headline Brier interval in the result sentence and beside both Brier tiles', () => {
    const { html } = renderState(WITH_INTERVALS);
    const sentence = stripTags(html.match(/<p data-accuracy-result>([\s\S]*?)<\/p>/)[1]);
    assert.match(sentence, /Brier of 0\.118 \(95% interval 0\.098 to 0\.139\) across 180 scored forecasts/);
    assert.match(tileOf(html, 'Brier score, headline cohort'), /180 scored forecasts, 95% interval 0\.098 to 0\.139/);
    assert.match(tileOf(html, 'Brier score, every scored entry'), /490 scored forecasts, 95% interval 0\.178 to 0\.207/);
    assert.match(renderAccuracyLlmsSection(WITH_INTERVALS, LIFTED), /Brier of 0\.118 \(95% interval 0\.098 to 0\.139\)/);
  });

  it('shows a not-measurable interval when it is null, absent, or over a different population', () => {
    const cases = [
      sectionWith({ uncertainty: { ...UNCERTAINTY, skillBrier: null, overallBrier: null } }),
      sectionWith({ uncertainty: undefined }),
      sectionWith({ uncertainty: { ...UNCERTAINTY, skillBrier: { ...UNCERTAINTY.skillBrier, count: 179 }, overallBrier: { ...UNCERTAINTY.overallBrier, ci95: [0.2] } } }),
    ];
    for (const section of cases) {
      const { html } = renderState(section);
      assert.match(tileOf(html, 'Brier score, headline cohort'), /95% interval not measurable/);
      assert.match(tileOf(html, 'Brier score, every scored entry'), /95% interval not measurable/);
      assert.doesNotMatch(stripTags(html.match(/<p data-accuracy-result>([\s\S]*?)<\/p>/)[1]), /interval/);
    }
  });

  it('refuses an interval whose mean or bounds cannot belong to the printed score', () => {
    for (const skillBrier of [
      { ...UNCERTAINTY.skillBrier, mean: 0.2 },
      { ...UNCERTAINTY.skillBrier, ci95: [-0.01, 0.139207] },
      { ...UNCERTAINTY.skillBrier, ci95: [0.098461, 1.2] },
      {},
    ]) {
      const section = sectionWith({ uncertainty: { ...UNCERTAINTY, overallBrier: null, skillBrier } });
      assert.match(tileOf(renderState(section).html, 'Brier score, headline cohort'), /95% interval not measurable/);
      assert.equal(downloadFor(section).confidenceIntervals.meanScores.brier.published, false);
    }
  });

  it('treats a one-forecast interval as not measurable, since it has zero width', () => {
    const single = sectionWith({
      overall: { ...LIVE_SCORECARD.overall, count: 1 },
      uncertainty: { ...UNCERTAINTY, overallBrier: { count: 1, mean: 0.04, ci95: [0.04, 0.04], insufficientSample: true } },
    });
    assert.match(tileOf(renderState(single).html, 'Brier score, every scored entry'), /1 scored forecasts, 95% interval not measurable/);
  });

  it('flags an interval resting on fewer forecasts than the producer trusts', () => {
    const small = sectionWith({ uncertainty: { ...UNCERTAINTY, skillBrier: { ...UNCERTAINTY.skillBrier, insufficientSample: true } } });
    assert.match(tileOf(renderState(small).html, 'Brier score, headline cohort'), /95% interval 0\.098 to 0\.139, small sample/);
  });

  it('renders the funnel from matured to resolved to scored with Wilson intervals', () => {
    const text = funnelOf(renderState(WITH_INTERVALS).html);
    assert.ok(text, 'the funnel must be a real table');
    assert.match(text, /Past their deadline or resolved 820/);
    assert.match(text, /Resolved 94\.1% of 820 due or resolved forecasts \(772 forecasts\), 95% interval 92\.3% to 95\.6%/);
    assert.match(text, /Graded 59\.8% of 820 due or resolved forecasts \(490 forecasts\), 95% interval 56\.4% to 63\.1%/);
    assert.match(text, /Past their deadline, still open 12/);
    assert.match(text, /Past their deadline, awaiting a judge 36/);
    assert.match(text, /Not yet due, unresolved 130/);
    assert.match(text, /No recorded deadline 8/);
  });

  it('prints a denominator with every funnel percentage', () => {
    const text = funnelOf(withoutIntervals(renderState(WITH_INTERVALS).html));
    for (const match of text.matchAll(/\d[\d.]*%/g)) {
      assert.match(text.slice(match.index, match.index + 40), /% of [\d,]+/);
    }
  });

  it('shows the funnel rates as not measurable when nothing has matured', () => {
    const empty = {
      ...FUNNEL, matured: 0, resolved: 0, scored: 0, pendingHardMatured: 0, pendingJudgeMatured: 0, resolvedOfMatured: null, scoredOfMatured: null,
    };
    const text = funnelOf(renderState(sectionWith({ uncertainty: UNCERTAINTY, funnel: empty })).html);
    assert.match(text, /Resolved Not measurable/);
    assert.match(text, /Graded Not measurable/);
  });

  it('shows a missing stage count as not measurable rather than zero', () => {
    const text = funnelOf(renderState(sectionWith({ uncertainty: UNCERTAINTY, funnel: {} })).html);
    assert.doesNotMatch(text, /\b0\b/);
    assert.match(text, /Past their deadline or resolved Not measurable/);
    assert.match(text, /Resolved Not measurable/);
  });

  it('derives both funnel rates from the stage counts it prints, not from a disagreeing rate object', () => {
    const disagreeing = {
      ...FUNNEL,
      resolvedOfMatured: { count: 100, successes: 50, rate: 0.5, ci95: [0.4, 0.6] },
      scoredOfMatured: { count: 100, successes: 10, rate: 0.1, ci95: [0.05, 0.17] },
    };
    const text = funnelOf(renderState(sectionWith({ uncertainty: UNCERTAINTY, funnel: disagreeing })).html);
    assert.match(text, /Resolved 94\.1% of 820 due or resolved forecasts \(772 forecasts\)/);
    assert.match(text, /Graded 59\.8% of 820 due or resolved forecasts \(490 forecasts\)/);
  });

  it('says the funnel is not carried rather than drawing zeros for an older capture', () => {
    const { html } = renderState(LIVE_SECTION);
    assert.equal(funnelOf(html), null);
    assert.match(stripTags(html), /This capture does not carry the maturity funnel yet/);
  });

  it('describes which mean scores carry an interval, on the page and in the distribution', () => {
    const text = stripTags(renderState(WITH_INTERVALS).html);
    assert.match(text, /No confidence intervals on the log scores/);
    const download = downloadFor(WITH_INTERVALS);
    assert.equal(download.confidenceIntervals.meanScores.brier.published, true);
    assert.equal(download.confidenceIntervals.meanScores.logScore.published, false);
    assert.equal(downloadFor(sectionWith({ uncertainty: undefined })).confidenceIntervals.meanScores.brier.published, false);
    const bothNull = sectionWith({ uncertainty: { ...UNCERTAINTY, overallBrier: null, skillBrier: null } });
    assert.equal(downloadFor(bothNull).confidenceIntervals.meanScores.brier.published, false, 'a method with no interval publishes nothing');
    const unrendered = sectionWith({
      uncertainty: {
        ...UNCERTAINTY,
        overallBrier: { ...UNCERTAINTY.overallBrier, count: 489 },
        skillBrier: { ...UNCERTAINTY.skillBrier, ci95: [0.2] },
      },
    });
    assert.equal(downloadFor(unrendered).confidenceIntervals.meanScores.brier.published, false, 'an interval the page refuses to print is not published');
    const collapsed = sectionWith({
      skill: { count: 0, excludedScored: 40, excludedOrigins: ['bet_engine', 'state_derived'] },
      overall: { count: 40, brier: 0.2, logScore: 0.6 },
      uncertainty: { ...UNCERTAINTY, overallBrier: { count: 40, mean: 0.2, ci95: [0.15, 0.25], insufficientSample: false }, skillBrier: null },
    });
    assert.equal(classifyAccuracyState(collapsed).coverage, 'insufficient');
    assert.doesNotMatch(renderState(collapsed).html, /95% interval 0\.150 to 0\.250/, 'an insufficient cohort renders no tiles');
    assert.equal(downloadFor(collapsed).confidenceIntervals.meanScores.brier.published, false, 'the download claims only an interval the page printed');
    const skillOnly = sectionWith({ uncertainty: { ...UNCERTAINTY, overallBrier: null } });
    assert.equal(downloadFor(skillOnly).confidenceIntervals.meanScores.brier.published, true);
  });
});

// Issue #8873: a reader must be able to answer "is it predicting accurately?"
// and "how much is it voiding?" from the first block, in sentences with
// counts, with every number traceable to scorecard.json. The expected values
// below are recomputed from the fixture's own tables so the assertion is
// "block equals table", not "block equals a constant somebody typed".
describe('accuracy verdict block', () => {
  const verdictText = (html) => {
    const section = html.match(/<section data-accuracy-verdict[\s\S]*?<\/section>/);
    assert.ok(section, 'the page must carry a verdict block');
    return stripTags(section[0]).replace(/&#39;/g, "'");
  };
  const yesIn = (bucket) => Math.round(bucket.count * (bucket.realizedRate ?? 0));
  const band = (keep) => {
    const rows = LIVE_SCORECARD.calibration.filter(keep);
    return { count: rows.reduce((n, row) => n + row.count, 0), yes: rows.reduce((n, row) => n + yesIn(row), 0) };
  };
  const unlikely = band((row) => row.minProbability < 0.2);
  const middle = band((row) => row.minProbability >= 0.2 && row.minProbability < 0.5);
  const likely = band((row) => row.minProbability >= 0.5);
  const pooledYes = unlikely.yes + middle.yes + likely.yes;

  it('leads the page: before the record status, with definitions right after it', () => {
    const { html } = renderState(LIVE_SECTION);
    const verdict = html.indexOf('<section data-accuracy-verdict');
    const definitions = html.indexOf('data-accuracy-definitions');
    const status = html.indexOf('<section data-accuracy-headline');
    assert.ok(verdict > 0 && definitions > 0 && status > 0);
    assert.ok(verdict < definitions && definitions < status, 'verdict, then definitions on first use, then the record');
    const defined = stripTags(html.match(/<dl data-accuracy-definitions>[\s\S]*?<\/dl>/)[0]);
    assert.match(defined, /Brier score/);
    assert.match(defined, /0\.25, a coin flip/, 'the coin flip stays, as context only');
    assert.match(defined, /Actual rate/);
    assert.match(defined, /known only afterwards/);
    assert.doesNotMatch(defined, /knows the history|historical/i, 'the reference is the same-window rate, not a prior period');
    assert.match(defined, /A family is one forecast id, which only approximates independence/);
    assert.match(defined, /rate times one minus the rate/, 'p(1-p) must be stated in words');
    assert.match(defined, /Skill score/);
    assert.match(defined, /Forecast family/);
  });

  it('states the ledger counts the totals table publishes, and that void reasons are not yet published', () => {
    const text = verdictText(renderState(LIVE_SECTION).html);
    const { totals } = LIVE_SCORECARD;
    assert.equal(unlikely.count + middle.count + likely.count, totals.scored, 'fixture buckets must cover every scored entry');
    assert.match(text, new RegExp(`${totals.resolved} forecasts came due and were resolved`));
    assert.match(text, new RegExp(`${totals.scored} could be graded`));
    assert.match(text, new RegExp(`${totals.void} could not be graded`));
    assert.match(text, new RegExp(`36\\.5% of ${totals.resolved} resolved forecasts`));
    assert.match(text, new RegExp(`Another ${totals.pendingJudge} are in the queue for a judge, counted whether or not their deadline has passed`));
    assert.doesNotMatch(text, /have come due and are waiting/);
    assert.match(text, /does not yet publish why/, 'the void-reason breakdown is not in the scorecard; say so rather than invent it');
  });

  it('states how often unlikely and likely calls came true, from the calibration table', () => {
    const text = verdictText(renderState(LIVE_SECTION).html);
    assert.equal(unlikely.yes, 1, 'the fixture has one realised forecast under 20%');
    // stripTags leaves a space where the band's closing tag was.
    assert.match(text, new RegExp(`under 20%\\s*, the forecast came true in ${unlikely.yes} of ${unlikely.count} cases`));
    assert.match(text, new RegExp(`between 20% and 50%\\s*, it came true in ${middle.yes} of ${middle.count} cases`));
    assert.match(text, new RegExp(`50% or more\\s*, it came true in ${likely.yes} of ${likely.count} cases`));
    const empty = sectionWith({
      calibration: LIVE_SCORECARD.calibration.map((row) => (row.minProbability >= 0.5 ? { ...row, count: 0, predictedMean: undefined, realizedRate: undefined, brier: undefined } : row)),
      overall: { ...LIVE_SCORECARD.overall, count: unlikely.count + middle.count },
    });
    assert.match(verdictText(renderState(empty).html), /50% or more\s*, there were no graded forecasts/);
  });

  it('names no metric in its sentences', () => {
    const text = verdictText(renderState(LIVE_SECTION).html);
    assert.doesNotMatch(text, /Brier|log score|calibration|cohort Brier/i);
    assert.ok(text.length > 400, 'the block must carry the full set of sentences');
  });

  it('states the market comparison in words that follow the delta sign', () => {
    assert.match(verdictText(renderState(LIVE_SECTION).html), /In the 78 cases where a liquid prediction market covered the same question, the market's odds were closer to what happened than World Monitor's/);
    const flipped = sectionWith({ vsMarketSkill: { count: 78, forecastBrier: 0.073136, marketBrier: 0.154623, brierDelta: 0.081487 } });
    assert.match(verdictText(renderState(flipped).html), /World Monitor's odds were closer to what happened than the market's/);
    const tied = sectionWith({ vsMarketSkill: { count: 4, forecastBrier: 0.1, marketBrier: 0.1, brierDelta: 0 } });
    assert.match(verdictText(renderState(tied).html), /the two were equally close/);
    const absent = sectionWith({ vsMarketSkill: { count: 0, forecastBrier: 0, marketBrier: 0, brierDelta: 0 } });
    assert.match(verdictText(renderState(absent).html), /No graded forecast overlapped a liquid prediction market/);
  });

  it('reports the all-scored count from the calibration buckets but never judges skill on the pooled rate (#8990)', () => {
    const { overall } = LIVE_SCORECARD;
    assert.equal(pooledYes, 140, 'the fixture buckets recover 140 realised outcomes');
    const text = verdictText(renderState(LIVE_SECTION).html);
    assert.match(text, new RegExp(`Across all ${overall.count} graded forecasts, ${pooledYes} came true: 28\\.6% of ${overall.count}`));
    assert.match(text, /pools kinds of forecast that come true at very different rates, so it is not compared with a single rate/);
    for (const brier of [0.1, 0.192435, 0.3]) {
      assert.doesNotMatch(verdictText(renderState(sectionWith({ overall: { ...overall, brier } })).html), /beat|0\.204/, 'a pooled comparison is a pooling artifact');
    }
  });

  it('withholds the derived base rate when the buckets do not cover every graded forecast', () => {
    const short = sectionWith({ calibration: LIVE_SCORECARD.calibration.filter((row) => row.bucket !== '30-40') });
    const text = verdictText(renderState(short).html);
    assert.match(text, /cannot be derived/);
    assert.doesNotMatch(text, /came true: /, 'a base rate over the wrong population must not be published');
  });

  // The headline skill paragraph leads the block (#8990). 30 of 180 came true,
  // so the actual-rate error is p(1-p) = 0.139 and the score 1 - B / 0.139.
  const skillOf = (changes, interval) => skillSection({ yesCount: 30, ...changes }, interval);
  const skillParagraph = (section) => {
    const html = renderState(section).html;
    const paragraph = html.match(/<p data-accuracy-skill="([^"]+)">([\s\S]*?)<\/p>/);
    assert.ok(html.indexOf('data-accuracy-skill') < html.indexOf('came due and were resolved'), 'skill leads the block');
    return { verdict: paragraph[1], text: stripTags(paragraph[2]).trim() };
  };

  it('says better only when the family-bootstrap skill interval lies wholly above 0', () => {
    const better = skillParagraph(skillOf({ brier: 0.1, bssCi95: [0.05, 0.4] }));
    assert.equal(better.verdict, 'better');
    assert.match(better.text, /^Better than always forecasting how often these events actually happened\./);
    assert.match(better.text, /Of 180 graded forecasts, 30 came true: 16\.7% of 180 forecasts/);
    assert.match(better.text, /Always forecasting that 16\.7% would have had an error of 0\.139\. World Monitor(?:'|&#39;)s error was 0\.100\./);
    assert.match(better.text, /a skill score of \+0\.28, 95% interval \+0\.05 to \+0\.40\. The whole interval is above 0\./);
    assert.match(better.text, /They come from at least 30 forecast families\./);
  });

  it('reads a measured negative score plainly as worse when the whole interval is below 0', () => {
    // The reviewer's case: 243 forecasts, 43 came true (ref 0.146), Brier 0.296, BSS -1.03.
    const worse = skillParagraph(skillSection({ count: 243, yesCount: 43, brier: 0.296, bssCi95: [-1.45, -0.68] }, { ci95: [0.25, 0.34] }));
    assert.equal(worse.verdict, 'worse');
    assert.match(worse.text, /^Worse than always forecasting how often these events actually happened\./);
    assert.match(worse.text, /a skill score of -1\.03, 95% interval -1\.45 to -0\.68\. The whole interval is below 0\./);
  });

  it('cannot tell when the interval includes 0 or is missing, and never maps the Brier interval instead', () => {
    const straddles = skillParagraph(skillOf({ brier: 0.1, bssCi95: [-0.24, 0.48] }, { ci95: [0.083333, 0.131944] }));
    assert.equal(straddles.verdict, 'unclear');
    assert.match(straddles.text, /^Cannot tell yet whether World Monitor beats always forecasting how often these events actually happened\./);
    assert.match(straddles.text, /95% interval -0\.24 to \+0\.48\. The interval includes 0, so the difference may be chance\./);
    // Holding the rate fixed, that Brier interval maps to +0.05 to +0.40, which would wrongly read as better.
    const negativeStraddle = skillParagraph(skillOf({ brier: 0.2, bssCi95: [-0.9, 0.1] }));
    assert.equal(negativeStraddle.verdict, 'unclear', 'a negative score whose interval reaches above 0 is not worse');
    const missing = skillParagraph(skillOf({ brier: 0.1 }, { ci95: [0.083333, 0.131944] }));
    assert.equal(missing.verdict, 'unclear');
    assert.match(missing.text, /This capture carries no interval for it, so the difference may be chance\./);
    assert.doesNotMatch(missing.text, /\+0\.05|\+0\.40|^Better|^Worse/);
  });

  it('reads a cohort below the family minimums as a small sample, with its number, never as a result', () => {
    const small = skillParagraph(skillOf({ brier: 0.2 }, { ci95: [0.125, 0.264], small: true }));
    assert.equal(small.verdict, 'small-sample');
    assert.match(small.text, /^Too few independent forecasts to judge yet\./);
    assert.match(small.text, /They come from too few forecast families\./);
    assert.match(small.text, /Judging skill needs at least 30 forecast families, with at least 5 that came true and 5 that did not/);
    assert.match(small.text, /reads -0\.44, which is not a result/);
    assert.doesNotMatch(small.text, /Better|Worse|Not clearly/);
    const rowLevel = sectionWith({
      skill: { ...LIVE_SCORECARD.skill, yesCount: 30 },
      uncertainty: { ...UNCERTAINTY, method: 'entry-level percentile bootstrap, 1000 resamples, seed 7072' },
    });
    assert.equal(skillParagraph(rowLevel).verdict, 'small-sample', 'a row-level interval predates the family minimums and cannot show they were met');
    assert.match(skillParagraph(rowLevel).text, /forecast families this capture does not count/);
  });

  it('gives a small sample no verdict even when its interval lies below 0', () => {
    const section = skillSection({ count: 11, yesCount: 9, brier: 0.310849, bssCi95: [-3.4, -0.03] }, { ci95: [0.246, 0.388], small: true });
    assert.equal(skillParagraph(section).verdict, 'small-sample');
    assert.equal(downloadFor(section).skillVsActualRate.headline.verdict, 'small-sample');
    assert.doesNotMatch(stripTags(renderState(section).html.match(/<p data-accuracy-result>([\s\S]*?)<\/p>/)[1]), /better than|worse than/);
  });

  it('reports no skill when the yes count is missing, every outcome went one way, or nothing is graded', () => {
    const { skill } = LIVE_SCORECARD;
    assert.equal(Object.hasOwn(skill, 'yesCount'), false, 'the shipped fixture predates the field');
    const waiting = skillParagraph(LIVE_SECTION);
    assert.equal(waiting.verdict, 'none');
    assert.match(waiting.text, /does not record how many of the 180 headline forecasts came true/);
    assert.doesNotMatch(waiting.text, /0\.118/);

    const oneWay = skillParagraph(skillOf({ yesCount: 0 }));
    assert.equal(oneWay.verdict, 'none');
    assert.match(oneWay.text, /Every one went the same way/);

    const collapsed = skillParagraph(sectionWith({ skill: { count: 0, excludedScored: 310, excludedOrigins: ['bet_engine', 'state_derived'] } }));
    assert.equal(collapsed.verdict, 'none');
    assert.match(collapsed.text, /headline cohort has no graded forecast in this window/);
    assert.doesNotMatch(collapsed.text, /undefined|NaN/);
  });

  it('publishes skill.yesCount through the whitelist once the API carries it', () => {
    assert.equal(selectDeclaredScorecardFields({ ...LIVE_SCORECARD, skill: { ...LIVE_SCORECARD.skill, yesCount: 30 } }).skill.yesCount, 30);
    assert.match(read('proto/worldmonitor/forecast/v1/get_forecast_scorecard.proto'), /message ScorecardSkill \{[\s\S]*?int32 yes_count = \d+;[\s\S]*?\}/);
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
        audit: LIFTED,
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

describe('accuracy page after the #5233 correction', () => {
  const CORRECTION = 'could not read';

  it('the committed pre-correction snapshot carries no correction note', () => {
    const snapshot = JSON.parse(read('docs/snapshots/crawlable-live-pulse-2026-10-05.json'));
    const { html } = renderState(snapshot.forecastScorecard);
    assert.doesNotMatch(stripTags(html), new RegExp(CORRECTION));
  });

  it('shows the note when the captured scorecard reports the voids', () => {
    const methodology = `${LIVE_SCORECARD.methodology} 215 forecasts scored against a data feed we could not read correctly are voided and left out of every score (issue #5233).`;
    const { html } = renderState(sectionWith({ methodology }));
    assert.match(stripTags(html), /215 forecasts scored against a data feed we could not read correctly are voided/);
  });

  it('calls the post-correction headline a small sample by its families, not its rows (#8990)', () => {
    // The 2026-10-07 audit: 28 rows from 20 families after #8986, BSS -0.53.
    const section = skillSection({ count: 28, yesCount: 20, brier: 0.311271 }, { ci95: [0.22, 0.41], small: true });
    const state = classifyAccuracyState(section);
    assert.equal(state.coverage, 'small-sample');
    assert.equal(state.headline, 'insufficient');
    const small = stripTags(renderState(section).html);
    assert.match(small, /Coverage: Small sample The headline cohort has 28 scored forecasts from too few forecast families\. Judging skill needs at least 30 forecast families/);
    assert.match(small, /Read every headline score below as a small sample\./);
    assert.match(small, /Skill vs actual rate, headline cohort Too few to judge Small sample: reads -0\.53 on 28 scored forecasts from too few forecast families/);
    assert.doesNotMatch(small, /meets the minimum/);
    const large = stripTags(renderState(LIVE_SECTION).html);
    assert.match(large, /The headline cohort has 180 scored forecasts from at least 30 forecast families\. That meets the minimum for judging skill/);
    assert.doesNotMatch(large, /small sample/i);
  });
});

describe('accuracy record under audit (#8990)', () => {
  // A fixture, not the live switch: these suites must stay green when the switch is lifted to null,
  // so the audited branch stays tested for the next audit.
  const AUDIT = Object.freeze({
    since: '2026-10-07',
    issue: 8990,
    reason: 'An audit found three errors in how forecasts were scored. Some outcomes were recorded as "did not happen" without reading the data that decides them. Some forecasts were counted more than once. Some were scored at a probability other than the one published.',
  });
  const FULL = sectionWith({ uncertainty: UNCERTAINTY, funnel: FUNNEL, receipts: RECEIPTS, marketAlerts: MARKET_ALERTS });
  const NOTICE = `Under audit since 2026-10-07. ${AUDIT.reason} The scores previously shown here were not reliable and are withdrawn while corrections are made. Forecasts are still being published and logged, and their outcomes will be rescored once the fixes land.`;
  const audited = () => renderState(FULL, { audit: AUDIT });
  // The page body only: JSON-LD lives in the head, so it never counts as visible copy.
  const visibleText = ({ shell }) => stripTags(shell.body).replaceAll('&quot;', '"');

  it('keeps the switch either lifted or a well-formed audit', () => {
    if (FORECAST_ACCURACY_AUDIT === null) return;
    assert.match(FORECAST_ACCURACY_AUDIT.since, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isInteger(FORECAST_ACCURACY_AUDIT.issue) && FORECAST_ACCURACY_AUDIT.issue > 0);
    assert.ok(FORECAST_ACCURACY_AUDIT.reason.length > 40);
    assert.ok(Object.isFrozen(FORECAST_ACCURACY_AUDIT));
  });

  it('names the three flaws and the rescoring in the notice, with no skill verdict', () => {
    assert.equal(accuracyAuditNotice(AUDIT), NOTICE);
    if (FORECAST_ACCURACY_AUDIT) assert.equal(FORECAST_ACCURACY_AUDIT.reason, AUDIT.reason, 'the live reason is the reviewed copy');
    assert.doesNotMatch(NOTICE, /skill|beat|base rate/i);
  });

  it('defaults every renderer to the switch', () => {
    const { tpl } = fakeTpl();
    const state = classifyAccuracyState(FULL);
    const page = (audit) => renderAccuracyPage({
      baseUrl: BASE_URL, tpl, state, lastmod: '2026-10-07', dataset: DATASET, dataCatalog: DATA_CATALOG, snapshotPath: SNAPSHOT_PATH, ...audit,
    });
    assert.equal(page({}), page({ audit: FORECAST_ACCURACY_AUDIT }));
    assert.equal(renderAccuracyLlmsSection(FULL), renderAccuracyLlmsSection(FULL, FORECAST_ACCURACY_AUDIT));
    assert.equal(
      accuracyDatasetDownload({ state, snapshotPath: SNAPSHOT_PATH }),
      accuracyDatasetDownload({ state, snapshotPath: SNAPSHOT_PATH, audit: FORECAST_ACCURACY_AUDIT }),
    );
  });

  it('replaces the headline, the verdict and every score with the dated notice', () => {
    const rendered = audited();
    const { html } = rendered;
    const text = visibleText(rendered);
    assert.ok(text.includes(NOTICE), 'the notice must read in full');
    assert.match(html, /<a href="https:\/\/github\.com\/koala73\/worldmonitor\/issues\/8990">issue #8990<\/a>/);
    for (const marker of [
      'data-accuracy-verdict', 'data-accuracy-result', 'aria-label="Headline forecast accuracy metrics"', 'data-accuracy-headline',
      'data-ledger-totals', 'data-maturity-funnel', 'data-calibration', 'data-by-domain', 'data-by-origin', 'data-accuracy-definitions',
    ]) {
      assert.ok(!html.includes(marker), `${marker} presents a score or a verdict and must be withdrawn`);
    }
    assert.doesNotMatch(text, /\bbeat\b|did not beat|Against prediction markets|What the headline number counts|95% interval|Lower Brier is better/);
    for (const figure of ['0.118', '0.192', '0.155', '0.073', '0.098', '0.139', '0.375']) {
      assert.ok(!text.includes(figure), `score ${figure} must not be published while under audit`);
    }
  });

  it('renders the notice once, as a callout, with no heading that repeats it', () => {
    const { html } = audited();
    const callout = html.match(/<section id="under-audit" class="card" role="note"[^>]*>[\s\S]*?<\/section>/)?.[0];
    assert.ok(callout, 'the notice is a bordered callout');
    assert.doesNotMatch(callout, /<h2/);
    assert.match(callout, /<p><strong>Under audit since 2026-10-07\.<\/strong> An audit found three errors/);
    assert.equal(visibleText(audited()).split('Under audit since').length - 1, 1);
  });

  it('states in the lede what the page does without claiming every forecast is scored', () => {
    const { html } = audited();
    assert.match(html, /<p class="lede">World Monitor logs every forecast it publishes and aims to score each one once its outcome is known\. While the audit below is open, this page publishes no scores\.<\/p>/);
    assert.doesNotMatch(stripTags(html), /scores every forecast it publishes/);
  });

  it('keeps the methodology and the receipts, marks the receipts unverified and names the scored chance', () => {
    const { html } = audited();
    assert.match(html, /<h2>Methodology<\/h2>/);
    assert.ok(html.includes(LIVE_SCORECARD.methodology));
    assert.match(html, /<h2>Recently resolved forecasts, unverified<\/h2>/);
    const table = html.match(/<table data-forecast-receipts data-receipts-unverified>[\s\S]*?<\/table>/)?.[0];
    assert.ok(table, 'the receipts table must carry the unverified marker');
    assert.match(table, /<caption>Not yet rechecked\. These outcomes were recorded by the scoring system the audit found errors in, so some may be wrong\./);
    assert.match(table, /The chance is the probability each forecast was scored at\. This may differ from the probability first published\./);
    assert.match(table, /<th scope="col">Chance scored<\/th>/);
    assert.doesNotMatch(table, /Chance given/);
    assert.equal([...table.matchAll(/<tr data-receipt-outcome=/g)].length, RECEIPTS.length);
  });

  it('keeps the market-alert section and says the audit did not cover or recheck it', () => {
    const { html } = audited();
    assert.match(html, /<h2 id="market-alerts">/);
    assert.match(html, /<table data-market-alerts>/);
    assert.match(html, /<p data-market-alerts-audit-scope>The audit did not cover this section\. Market alerts are scored from a separate ledger, and these figures have not been rechecked\.<\/p>/);
  });

  it('withdraws the score claims from the meta and Dataset descriptions', () => {
    const { shell, jsonLd } = audited();
    assert.doesNotMatch(shell.description, /Brier|calibration/);
    assert.match(shell.description, /under audit/);
    const dataset = jsonLd.find((entry) => entry?.['@type'] === 'Dataset');
    assert.match(dataset.description, /^Under audit since 2026-10-07\./);
    assert.match(dataset.description, /issues\/8990/);
    assert.match(dataset.description, /The download keeps the raw scorecard fields as captured, flagged underAudit; they are not reliable while the audit is open\.$/);
    assert.doesNotMatch(dataset.description, /always agree|Aggregate accuracy/);
  });

  it('does not call the raw figures published numbers in the footer', () => {
    const footer = audited().html.match(/<p class="source"[\s\S]*?<\/p>/)[0];
    assert.doesNotMatch(footer, /Numbers generated/);
    assert.match(footer, /The raw figures in the download were generated [^<]+ and read on 2026-09-10, and are under audit\./);
    assert.match(renderState(FULL, { audit: LIFTED }).html, /Numbers generated/);
  });

  it('shows the notice even when no scorecard was captured', () => {
    const { html } = renderState(null, { audit: AUDIT });
    assert.match(html, /data-accuracy-audit="2026-10-07"/);
    assert.doesNotMatch(html, /data-accuracy-headline/);
  });

  it('puts the notice in llms-full in place of the accuracy claims', () => {
    const llms = renderAccuracyLlmsSection(FULL, AUDIT);
    assert.match(llms, /^## Forecast accuracy$/m);
    assert.ok(llms.includes(accuracyAuditNotice(AUDIT, 'on that page')));
    assert.match(llms, /https:\/\/github\.com\/koala73\/worldmonitor\/issues\/8990/);
    assert.doesNotMatch(llms, /Brier|0\.118|confidence intervals/);
  });

  it('flags scorecard.json under audit and keeps every raw field', () => {
    const state = classifyAccuracyState(FULL);
    const audit = JSON.parse(accuracyDatasetDownload({ state, snapshotPath: SNAPSHOT_PATH, audit: AUDIT }));
    const lifted = JSON.parse(accuracyDatasetDownload({ state, snapshotPath: SNAPSHOT_PATH, audit: LIFTED }));
    assert.deepEqual(audit.underAudit, { since: '2026-10-07', reason: AUDIT.reason, issue: 8990 });
    assert.equal(lifted.underAudit, null);
    const { underAudit: _a, ...auditRest } = audit;
    const { underAudit: _l, ...liftedRest } = lifted;
    assert.deepEqual(auditRest, liftedRest, 'the flag must be the only difference');
    assert.equal(audit.scorecard.skill.brier, LIVE_SCORECARD.skill.brier);
  });

  const BLOG = 'blog-site/src/content/blog/ai-forecast-accuracy-brier-scorecard-worldmonitor.md';
  const BLOG_NOTE = '> **Update, October 7, 2026.**';

  it('dates a correction on the July post that covers its method claims as well as its figures', () => {
    const post = read(BLOG);
    const note = post.split('\n').find((line) => line.startsWith(BLOG_NOTE));
    assert.ok(note, 'the dated note is present');
    assert.match(note, /some outcomes were recorded without reading the data that decides them/);
    assert.match(note, /some forecasts were counted more than once/);
    assert.match(note, /some were scored at a probability other than the one first published/);
    assert.match(note, /The figures in this post are not reliable, and the method described above was not always followed\./);
    assert.match(note, /\(https:\/\/github\.com\/koala73\/worldmonitor\/issues\/8990\)/);
  });

  it('qualifies every method claim in the July post that the audit disproved', () => {
    const post = read(BLOG);
    const lineWith = (needle) => post.split('\n').find((line) => line.includes(needle)) ?? '';
    assert.match(lineWith('keep their original probabilities forever'), /\(Update, October 7, 2026: the audit in issue #8990 found the scorer did not always follow this\./);
    assert.match(lineWith('Once a forecast enters the resolution ledger'), /That is the design\. The October 2026 audit \(issue #8990\) found the scorer sometimes replaced a forecast's first probability with a later one, and that is being fixed\./);
    assert.match(lineWith('demonstrated track record of its domain'), /\(while the record is under audit, do not\)/);
    const description = post.match(/^description: "([^"]*)"$/m)[1];
    assert.equal(description, 'How WorldMonitor scores its own AI forecasts, with a July 2026 snapshot of 32 forecasts. An audit found scoring errors and withdrew those figures in October 2026.');
  });

  // Public surfaces that describe the record. Each must be true in both states, so none may state a score
  // as a verdict or promise that the record page carries scores. llms-full is generated from the switch, so
  // it is held to this only while the audit is on.
  const STATIC_SURFACES = [
    'README.md',
    'public/llms.txt',
    'public/.well-known/mcp/server-card.json',
    'public/.well-known/agent-skills/check-forecast-signals/SKILL.md',
    'docs/methodology/cii-risk-scores.mdx',
    'docs/zh/methodology/cii-risk-scores.mdx',
    'docs/agent-skills.mdx',
    'docs/mcp-overview.mdx',
    'scripts/build-crawlable-corpus.mjs',
  ];
  const CLAIM_PHRASES = [
    /carries\s+the\s+Brier/i,
    /with its Brier scores/i,
    /how well World Monitor forecasts have scored/i,
    /republishes the current scores/i,
    /ledger currently reads/i,
    /headline cohort scores a Brier/i,
    /graded and published/i,
    /载有 Brier/,
    /Brier\s+(?:score\s+)?(?:of\s+)?\d?\.\d/i,
    /beat(?:s|ing)?\s+(?:a\s+)?coin[- ]flip/i,
    /beats maximal ignorance/i,
    /Brier-score audit/i,
  ];
  const claimsIn = (text) => CLAIM_PHRASES.filter((phrase) => phrase.test(text)).map(String);

  it('keeps every static surface free of score claims', () => {
    const surfaces = FORECAST_ACCURACY_AUDIT ? [...STATIC_SURFACES, 'public/llms-full.txt'] : STATIC_SURFACES;
    for (const path of surfaces) assert.deepEqual(claimsIn(read(path)), [], `${path} states accuracy as a verdict`);
    const post = read(BLOG);
    const noteAt = post.indexOf(BLOG_NOTE);
    assert.ok(noteAt > 0, 'the July post keeps its dated note');
    assert.deepEqual(claimsIn(post.slice(0, noteAt)), [], 'the July post states a verdict above its dated note, front matter included');
  });

  it('catches a new numeric claim, not only the retired wording', () => {
    for (const planted of [
      'World Monitor forecasts score a Brier of 0.111 over 243 forecasts, beating a coin flip.',
      'Brier score 0.074 for cyber.',
      'Our forecasts beat a coin flip.',
    ]) {
      assert.notDeepEqual(claimsIn(planted), [], planted);
    }
  });

  it('restores the full record when the switch is lifted', () => {
    const { html, shell } = renderState(FULL, { audit: LIFTED });
    assert.doesNotMatch(html, /data-accuracy-audit|Under audit since|data-receipts-unverified|data-market-alerts-audit-scope|Chance scored/);
    assert.match(html, /data-accuracy-verdict/);
    assert.match(html, /<table data-by-domain>/);
    assert.match(html, /<th scope="col">Chance given<\/th>/);
    assert.match(shell.description, /against always forecasting how often events actually happened: skill scores/);
    assert.match(html, /data-accuracy-skill=/);
  });
});

describe('accuracy page skill against the actual rate, both audit states (#8990)', () => {
  const AUDIT = Object.freeze({ since: '2026-10-07', issue: 8990, reason: 'Fixture reason for the audit notice, long enough to read as one.' });
  // 30 of 180 came true, so the actual-rate Brier is 0.139 and the BSS 1 - 0.1 / 0.138889 = +0.28.
  const MEASURED = skillSection({ yesCount: 30, brier: 0.1, bssCi95: [0.05, 0.4] }, { ci95: [0.083333, 0.131944] });

  it('leads the lifted page and llms-full with the skill verdict and its sample', () => {
    const { html, state } = renderState(MEASURED);
    assert.equal(state.coverage, 'measurable');
    assert.match(html, /<p data-accuracy-skill="better"><strong>Better than always forecasting how often these events actually happened\.<\/strong>/);
    const tile = stripTags(html.match(/<section class="grid"[\s\S]*?<\/section>/)[0]);
    assert.match(tile, /Skill vs actual rate, headline cohort \+0\.28 180 scored forecasts from at least 30 forecast families, 95% interval \+0\.05 to \+0\.40/);
    const llms = renderAccuracyLlmsSection(MEASURED, null);
    assert.match(llms, /headline forecasts were better than always forecasting how often these events actually happened: a skill score of \+0\.28, 95% interval \+0\.05 to \+0\.40, where 0 means the same error as that rate, 1 means perfect, and below 0 means a larger error, over 180 scored forecasts from at least 30 forecast families/);
    assert.doesNotMatch(llms, /0\.5 to everything/);
  });

  it('names the reference as the same-window rate everywhere, never a historical one', () => {
    const { shell } = renderState(MEASURED);
    assert.doesNotMatch(`${shell.body} ${shell.description} ${renderAccuracyLlmsSection(MEASURED, null)}`, /historical|knows the history/i);
  });

  it('withholds every skill figure while under audit', () => {
    const { shell } = renderState(MEASURED, { audit: AUDIT });
    assert.doesNotMatch(shell.body, /data-accuracy-skill|Skill vs actual rate|\+0\.28|actually happened/);
    const llms = renderAccuracyLlmsSection(MEASURED, AUDIT);
    assert.doesNotMatch(llms, /skill|actually happened|\+0\.28/i);
  });

  it('puts the skill block in the download, with only measured domains, in both states', () => {
    const lifted = downloadFor(MEASURED);
    assert.deepEqual(lifted.skillVsActualRate.minimums, { families: 30, yesFamilies: 5, noFamilies: 5 });
    const reference = (30 / 180) * (150 / 180);
    assert.deepEqual(lifted.skillVsActualRate.headline, {
      scored: 180, yesCount: 30, actualRate: 30 / 180, actualRateBrier: reference,
      brier: 0.1, skillScore: 1 - 0.1 / reference, ci95: [0.05, 0.4], measurable: true, verdict: 'better',
    });
    assert.match(lifted.skillVsActualRate.perDomainInterval, /MCP get_forecast_scorecard result/);
    assert.deepEqual(lifted.skillVsActualRate.byDomain, [
      { domain: 'conflict', scored: 120, brier: 0.11, actualRateBrier: 0.1875, skillScore: 0.413333 },
    ], 'a domain without a producer bss is not published');
    assert.equal(lifted.confidenceIntervals.meanScores.skillScore.published, true);
    assert.equal(lifted.confidenceIntervals.meanScores.skillScore.perDomain, false);

    const audited = JSON.parse(accuracyDatasetDownload({ state: classifyAccuracyState(MEASURED), snapshotPath: SNAPSHOT_PATH, audit: AUDIT }));
    assert.equal(audited.underAudit.issue, 8990, 'the raw block is flagged, as the rest of the download is');
    assert.deepEqual(audited.skillVsActualRate, lifted.skillVsActualRate);
  });

  it('gates the coverage fact on the producer family flag, never on the row count', () => {
    assert.equal(classifyAccuracyState(skillSection({ count: 5000, brier: 0.2 }, { small: true })).coverage, 'small-sample');
    assert.equal(classifyAccuracyState(skillSection({ count: 50, brier: 0.2 })).coverage, 'measurable');
    const rowLevel = sectionWith({ uncertainty: { ...UNCERTAINTY, method: 'entry-level percentile bootstrap, 1000 resamples, seed 7072' } });
    assert.equal(classifyAccuracyState(rowLevel).coverage, 'small-sample', 'a row-level flag predates the family rule');
    assert.equal(classifyAccuracyState(sectionWith({ uncertainty: undefined })).coverage, 'small-sample');
    assert.match(renderState(skillSection({ brier: 0.2 }, { small: true })).html, /data-accuracy-coverage="small-sample">Coverage: Small sample/);
  });
});
