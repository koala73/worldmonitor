#!/usr/bin/env node
// Deterministic generator for /accuracy/, the standing forecast-resolution
// record (issue #6646). Template helpers are injected by
// build-crawlable-corpus.mjs, the single owner of the corpus HTML shell.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Bump when the page copy changes so its lastmod advances without touching every sibling. */
export const ACCURACY_CONTENT_VERSION = '2026-09-12';

export const ACCURACY_PAGE_PATH = '/accuracy/';

// The RPC handler strips only `judgedLane` before spreading the seeder value,
// so undeclared seeder fields (a top-level `betEngine` experiment surface, as
// of this writing) reach the response. The capture, the page and the Dataset
// distribution are all whitelists against proto
// worldmonitor/forecast/v1/get_forecast_scorecard.proto, never spreads.
export const SCORECARD_DECLARED_FIELDS = Object.freeze([
  'schemaVersion',
  'generatedAt',
  'rollingWindowDays',
  'methodology',
  'totals',
  'overall',
  'byDomain',
  'byGenerationOrigin',
  'calibration',
  'vsMarketSkill',
  'degraded',
  'stale',
  'error',
  'skill',
]);

// A fixed vocabulary, because the page is public: an exception message or an
// upstream response body would publish internals and could carry attacker-
// controlled text. Anything outside this set normalises to 'unknown'.
export const ACCURACY_FAILURE_CODES = Object.freeze([
  'http-error',
  'request-failed',
  'malformed-response',
  'undated-response',
  'backend-degraded',
  'unknown',
]);

// The API itself calls this seed stale at MAX_STALE_MS in
// server/worldmonitor/forecast/v1/get-forecast-scorecard.ts. Reusing that
// number is the only choice that cannot contradict it: a higher ceiling here
// would call a payload current after the API had already called it stale, and a
// lower one would flag a payload the API considers fresh. The seeder is a daily
// cron, so a gap this wide also means it has missed a run.
export const SCORECARD_STALE_AFTER_HOURS = 36;

// Ordinary clock skew between the freeze runner and the API host. Beyond this a
// payload claiming to postdate the read that captured it is a real contradiction.
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

const TOTALS_FIELDS = Object.freeze([
  'entries', 'resolved', 'pending', 'pendingJudge', 'scored', 'void', 'voidRate', 'publicationCoverage',
]);
const SUMMARY_FIELDS = Object.freeze(['count', 'brier', 'logScore']);
const DOMAIN_FIELDS = Object.freeze(['domain', 'resolved', 'scored', 'void', 'voidRate', 'brier', 'logScore']);
const ORIGIN_FIELDS = Object.freeze(['generationOrigin', 'resolved', 'scored', 'void', 'voidRate', 'brier', 'logScore']);
const CALIBRATION_FIELDS = Object.freeze([
  'bucket', 'minProbability', 'maxProbability', 'count', 'predictedMean', 'realizedRate', 'brier',
]);
const MARKET_SKILL_FIELDS = Object.freeze(['count', 'forecastBrier', 'marketBrier', 'brierDelta']);
const SKILL_FIELDS = Object.freeze(['count', 'brier', 'logScore', 'excludedScored', 'excludedOrigins']);

const NESTED_OBJECT_FIELDS = Object.freeze({
  totals: TOTALS_FIELDS,
  overall: SUMMARY_FIELDS,
  vsMarketSkill: MARKET_SKILL_FIELDS,
  skill: SKILL_FIELDS,
});
const NESTED_ROW_FIELDS = Object.freeze({
  byDomain: DOMAIN_FIELDS,
  byGenerationOrigin: ORIGIN_FIELDS,
  calibration: CALIBRATION_FIELDS,
});

const ISSUE_URL = 'https://github.com/koala73/worldmonitor/issues';
const CONFIDENCE_INTERVAL_ISSUE = `${ISSUE_URL}/7072`;
const HORIZON_SCORING_ISSUE = `${ISSUE_URL}/7075`;
const DATASET_IDENTIFIER = 'forecast-resolution-scorecard';
const DATASET_LICENSE = {
  '@type': 'CreativeWork',
  name: 'World Monitor Terms of Service (27 July 2026)',
  url: 'https://www.worldmonitor.app/docs/terms',
};
const WORLD_MONITOR_ORG = Object.freeze({
  '@id': 'https://www.worldmonitor.app/#organization',
  '@type': 'Organization',
  name: 'World Monitor',
  url: 'https://www.worldmonitor.app/',
});
const SCHEMA_ORG_CONTEXT_URL = 'https://schema.org';
const INSUFFICIENT_SAMPLE = 'Insufficient sample';
const POOLED_POPULATION = 'all-scored-entries';
const BRIER_DELTA_CONVENTION = 'The published delta is the market Brier minus the forecast Brier, and lower is better, so a negative delta means the market scored better.';

const META_DESCRIPTION = 'World Monitor grades its own forecasts. Published Brier and log scores, calibration buckets, per-domain accuracy, void rates, and every sample size behind them.';

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const CANONICAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function canonicalDate(value) {
  if (typeof value !== 'string' || !CANONICAL_DATE_RE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return value;
}

function positiveMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function pickFields(value, fields) {
  if (!isPlainObject(value)) return undefined;
  const out = {};
  for (const field of fields) {
    if (Object.hasOwn(value, field) && value[field] !== undefined) out[field] = value[field];
  }
  return out;
}

/** Whitelist a captured scorecard payload down to the proto-declared surface. */
export function selectDeclaredScorecardFields(payload) {
  if (!isPlainObject(payload)) return null;
  const out = {};
  for (const field of SCORECARD_DECLARED_FIELDS) {
    if (!Object.hasOwn(payload, field) || payload[field] === undefined) continue;
    if (Object.hasOwn(NESTED_OBJECT_FIELDS, field)) {
      const nested = pickFields(payload[field], NESTED_OBJECT_FIELDS[field]);
      if (nested) out[field] = nested;
      continue;
    }
    if (Object.hasOwn(NESTED_ROW_FIELDS, field)) {
      if (!Array.isArray(payload[field])) continue;
      out[field] = payload[field]
        .map((row) => pickFields(row, NESTED_ROW_FIELDS[field]))
        .filter(Boolean);
      continue;
    }
    out[field] = payload[field];
  }
  return out;
}

export function normalizeFailureCode(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return ACCURACY_FAILURE_CODES.includes(value) ? value : 'unknown';
}

// Sections written before the coded-failure contract carried the caught
// exception message in `error` and no `failureCode`. Read that as a failure so a
// rolled-back or hand-edited snapshot degrades honestly, and normalise it to
// 'unknown' rather than publishing upstream text this page cannot vouch for.
function sectionFailureCode(section) {
  const declared = normalizeFailureCode(section.failureCode);
  if (declared) return declared;
  return typeof section.error === 'string' && section.error.trim() ? 'unknown' : '';
}

function noRecord(availability, failureCode, attemptedAt) {
  // freshness and coverage are reported even with nothing captured, and both
  // read truthfully: there is no current measurement and no measurable sample.
  // The headline carries the availability fault, so no reader mistakes these
  // for a verdict about numbers that exist.
  return {
    availability,
    freshness: 'stale',
    coverage: 'insufficient',
    headline: availability,
    failureCode,
    attemptedAt,
    capturedAt: null,
    generatedAt: null,
    ageHours: null,
    scorecard: null,
  };
}

/**
 * Collapse a frozen capture into three independent facts, computed once, plus a
 * headline derived from them. The facts are reported separately because the
 * issue asks for each to be visible: one collapsed label would hide the other
 * two. The headline takes the strongest defect because each level is a strictly
 * weaker claim about the same figure — an unavailable record has no number to
 * judge, a stale number describes the wrong moment, and an unmeasurable cohort
 * is a real number over too small a population.
 */
export function classifyAccuracyState(section) {
  if (!isPlainObject(section)) return noRecord('missing', '', null);
  const attemptedAt = canonicalDate(section.attemptedAt);
  const failureCode = sectionFailureCode(section);

  const scorecard = selectDeclaredScorecardFields(section.scorecard);
  if (!scorecard) return noRecord(failureCode ? 'capture-failed' : 'missing', failureCode, attemptedAt);

  // The handler returns an all-zero body with degraded true when the backend is
  // unreachable, so the payload exists but carries no measurement.
  if (scorecard.degraded === true || (typeof scorecard.error === 'string' && scorecard.error.trim())) {
    return noRecord('capture-failed', 'backend-degraded', attemptedAt);
  }

  // An expired seed key answers with the same zeroed body minus the degraded
  // flag: generatedAt 0 is the only thing that distinguishes it from a reading.
  const generatedAt = positiveMs(section.generatedAt) ?? positiveMs(scorecard.generatedAt);
  if (generatedAt === null) return noRecord('capture-failed', 'undated-response', attemptedAt);

  const capturedAt = canonicalDate(section.capturedAt);
  const attemptedAtMs = positiveMs(section.attemptedAtMs)
    ?? (attemptedAt ? Date.parse(`${attemptedAt}T00:00:00Z`) : null);
  const rawAgeMs = attemptedAtMs === null ? null : attemptedAtMs - generatedAt;
  // Numbers cannot predate their own measurement. Clamping a negative age to
  // zero would publish the most suspicious payload there is as the freshest
  // possible record, so treat disagreeing clocks as an unusable date instead.
  // A minute of skew between our runner and the API host is ordinary.
  if (rawAgeMs !== null && rawAgeMs < -CLOCK_SKEW_TOLERANCE_MS) {
    return noRecord('capture-failed', 'undated-response', attemptedAt);
  }
  const ageHours = rawAgeMs === null ? null : Math.max(0, rawAgeMs / 3_600_000);

  const availability = failureCode ? 'capture-failed' : 'ok';
  // Honour whichever verdict is worse. The payload's own flag was computed
  // against the seed's fetchedAt at capture time; the measured age keeps ageing
  // a retained payload after that verdict was frozen.
  const freshness = scorecard.stale === true || ageHours === null || ageHours > SCORECARD_STALE_AFTER_HOURS
    ? 'stale'
    : 'current';
  // summarizeSkill returns null when nothing is scored at all, and a count of 0
  // when everything scored came from an excluded origin. Both mean the headline
  // is unmeasurable, and neither is a capture failure.
  const skillCount = isPlainObject(scorecard.skill) ? positiveMs(scorecard.skill.count) : null;
  const coverage = skillCount === null ? 'insufficient' : 'measurable';

  const headline = availability !== 'ok'
    ? availability
    : freshness === 'stale'
      ? 'stale'
      : coverage === 'insufficient'
        ? 'insufficient'
        : 'current';

  return {
    availability,
    freshness,
    coverage,
    headline,
    failureCode,
    attemptedAt,
    capturedAt,
    generatedAt,
    ageHours,
    scorecard,
  };
}

function formatScore(value) {
  return Number(value).toFixed(3);
}

function formatCount(value) {
  return Number(value).toLocaleString('en-US');
}

/** Every rate on this page prints its population. A bare percentage is a claim without a sample. */
function rateOf(rate, denominator, noun) {
  return `${(Number(rate) * 100).toFixed(1)}% of ${formatCount(denominator)} ${noun}`;
}

function probabilityBand(bucket) {
  return `${(Number(bucket.minProbability) * 100).toFixed(0)}% to ${(Number(bucket.maxProbability) * 100).toFixed(0)}%`;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function scoreCell(value, escapeHtml) {
  return isFiniteNumber(value) ? escapeHtml(formatScore(value)) : escapeHtml(INSUFFICIENT_SAMPLE);
}

function formatUtcDateTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function formatAge(ageHours) {
  const hours = Math.round(ageHours);
  const days = Math.round(ageHours / 24);
  return hours > 48 ? `${formatCount(hours)} hours (about ${formatCount(days)} days)` : `${formatCount(hours)} hours`;
}

const FAILURE_SENTENCES = Object.freeze({
  'http-error': 'The scoring service did not answer with a usable result when the capture ran.',
  'request-failed': 'The request to the scoring service failed before a result arrived.',
  'malformed-response': 'The scoring service answered in a shape this page could not be read from.',
  'undated-response': 'The scoring service answered without a generation timestamp, so its numbers could not be dated.',
  'backend-degraded': 'The scoring service reported that it could not reach its own data.',
  unknown: 'The capture failed for a reason this page does not classify.',
});

function excludedCohortPhrase(skill) {
  const origins = Array.isArray(skill?.excludedOrigins) ? skill.excludedOrigins : [];
  return origins.length > 0 ? origins.join(', ') : 'none';
}

function headlineResultSentence(scorecard) {
  const skill = isPlainObject(scorecard?.skill) ? scorecard.skill : {};
  if (!isFiniteNumber(skill.brier) || !isFiniteNumber(skill.count) || skill.count <= 0) return '';
  const windowDays = isFiniteNumber(scorecard.rollingWindowDays) ? scorecard.rollingWindowDays : null;
  const windowPhrase = windowDays
    ? `Over the current ${formatCount(windowDays)}-day window`
    : 'Over the current rolling window';
  return `${windowPhrase}, World Monitor's headline cohort scores a Brier of ${formatScore(skill.brier)} across ${formatCount(skill.count)} scored forecasts, against 0.25 for answering 0.5 to everything.`;
}

const ACCURACY_NEGATIVE_SCOPE = 'This page does not publish confidence intervals; each figure is published with the number of forecasts behind it instead. It does not score the 24-hour, 7-day and 30-day projections shown in the product. It publishes aggregates only — no individual forecasts, resolution evidence, judge inputs or archive locations.';

export function renderAccuracyLlmsSection(section) {
  const state = classifyAccuracyState(section);
  const page = new URL(ACCURACY_PAGE_PATH, WORLD_MONITOR_ORG.url).href;
  const paragraphs = [`The standing forecast-resolution record is published at ${page}.`];
  const result = state.scorecard ? headlineResultSentence(state.scorecard) : '';
  if (result) {
    paragraphs.push(result);
    if (state.capturedAt) {
      const vintage = `Captured ${state.capturedAt}.`;
      if (state.availability === 'capture-failed') {
        paragraphs.push(`${vintage} The latest capture failed; these are the last successful figures.`);
      } else if (state.freshness === 'stale') {
        paragraphs.push(`${vintage} The record is past the ${SCORECARD_STALE_AFTER_HOURS}-hour freshness threshold.`);
      } else {
        paragraphs.push(vintage);
      }
    }
  } else if (state.availability === 'capture-failed' && !state.scorecard) {
    paragraphs.push('The latest capture failed, so no figures are published.');
  } else if (state.availability === 'missing') {
    paragraphs.push('No scorecard has been captured for this page yet.');
  } else if (state.coverage === 'insufficient') {
    paragraphs.push('The headline cohort currently has no scored forecast in this window, so it carries no Brier score.');
  }
  paragraphs.push(ACCURACY_NEGATIVE_SCOPE);
  return `## Forecast accuracy\n\n${paragraphs.join('\n\n')}\n`;
}

function headlineTiles(scorecard, escapeHtml) {
  const skill = isPlainObject(scorecard.skill) ? scorecard.skill : {};
  const skillCount = isFiniteNumber(skill.count) ? skill.count : 0;
  const { overall, totals } = scorecard;
  const tiles = [
    [
      'Brier score, headline cohort',
      isFiniteNumber(skill.brier) ? formatScore(skill.brier) : 'Not measurable',
      `${formatCount(skillCount)} scored forecasts`,
    ],
    [
      'Log score, headline cohort',
      isFiniteNumber(skill.logScore) ? formatScore(skill.logScore) : 'Not measurable',
      `${formatCount(skillCount)} scored forecasts`,
    ],
    [
      'Brier score, every scored entry',
      isFiniteNumber(overall?.brier) ? formatScore(overall.brier) : 'Not measurable',
      `${formatCount(overall?.count ?? 0)} scored forecasts`,
    ],
    [
      'Scored entries',
      formatCount(totals?.scored ?? 0),
      `of ${formatCount(totals?.resolved ?? 0)} resolved`,
    ],
  ];
  // A space between </strong> and <small> is load-bearing: naive tag-strippers
  // that do not insert whitespace otherwise glue "0.118" to "180 scored forecasts".
  return `      <section class="grid" aria-label="Headline forecast accuracy metrics">
${tiles.map(([label, value, note]) => `        <div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong> <small>${escapeHtml(note)}</small></div>`).join('\n')}
      </section>`;
}

function headlineResultParagraph(scorecard, escapeHtml) {
  const sentence = headlineResultSentence(scorecard);
  return sentence ? `      <p data-accuracy-result>${escapeHtml(sentence)}</p>\n` : '';
}

const RECORD_FACT_LABELS = Object.freeze({
  ok: 'Captured',
  'capture-failed': 'Last capture failed',
  missing: 'Never captured',
  current: 'Current',
  stale: 'Stale',
  measurable: 'Measurable',
  insufficient: 'Not measurable',
});

function recordStatus(state, escapeHtml) {
  const facts = [
    ['Availability', 'availability', state.availability, availabilitySentence(state)],
    ['Freshness', 'freshness', state.freshness, freshnessSentence(state)],
    ['Coverage', 'coverage', state.coverage, coverageSentence(state)],
  ];
  return `      <section data-accuracy-headline="${escapeHtml(state.headline)}" aria-label="Record status">
        <h2>Record status</h2>
        <dl>
${facts.map(([label, key, value, sentence]) => `          <dt data-accuracy-${key}="${escapeHtml(value)}">${escapeHtml(label)}: ${escapeHtml(RECORD_FACT_LABELS[value])}</dt>
          <dd>${escapeHtml(sentence)}</dd>`).join('\n')}
        </dl>
      </section>`;
}

function availabilitySentence(state) {
  if (state.availability === 'missing') {
    return 'The weekly capture has not recorded a scorecard for this page yet.';
  }
  if (state.availability === 'capture-failed') {
    const cause = FAILURE_SENTENCES[state.failureCode] || FAILURE_SENTENCES.unknown;
    return state.scorecard
      ? `${cause} The figures below are the last ones successfully read, on ${state.capturedAt}. The failed attempt ran on ${state.attemptedAt}.`
      : `${cause} No figures are published, because a number from a failed read would be worse than none. The attempt ran on ${state.attemptedAt}.`;
  }
  return `Read from the live scoring service on ${state.capturedAt} and frozen into this page.`;
}

function freshnessSentence(state) {
  if (!state.scorecard) return 'There is no measurement here to be current or stale.';
  const measured = state.ageHours === null
    ? 'The capture recorded no attempt time, so the age of these numbers cannot be measured.'
    : `The scoring service generated these numbers ${formatAge(state.ageHours)} before the capture read them.`;
  if (state.freshness === 'stale') {
    return `${measured} Anything past ${SCORECARD_STALE_AFTER_HOURS} hours is stale on a job that runs daily, and the service reports its own staleness on the same threshold.`;
  }
  return `${measured} The threshold is ${SCORECARD_STALE_AFTER_HOURS} hours, matching the one the scoring service applies to itself.`;
}

function coverageSentence(state) {
  if (!state.scorecard) return 'No sample was captured, so nothing here is measurable.';
  const skill = isPlainObject(state.scorecard.skill) ? state.scorecard.skill : null;
  if (state.coverage === 'insufficient') {
    const excluded = skill && isFiniteNumber(skill.excludedScored)
      ? ` ${formatCount(skill.excludedScored)} scored entries came from excluded origins: ${excludedCohortPhrase(skill)}.`
      : ' Nothing in this window has been scored yet.';
    return `The headline cohort has no scored forecast in this window, so it carries no Brier score.${excluded} The breakdowns below are still real measurements.`;
  }
  return `The headline cohort has ${formatCount(skill.count)} scored forecasts, enough to publish a score.`;
}

function totalsTable(totals, escapeHtml) {
  const rows = [
    ['Entries in the rolling window', formatCount(totals.entries)],
    ['Resolved', formatCount(totals.resolved)],
    ['Scored', formatCount(totals.scored)],
    ['Voided', `${rateOf(totals.voidRate, totals.resolved, 'resolved entries')} (${formatCount(totals.void)} entries)`],
    ['Awaiting a judge', formatCount(totals.pendingJudge)],
    ['Still open, not yet resolvable', formatCount(totals.pending)],
    // The API calls this field publicationCoverage. It is scored over ALL
    // entries, which is not a publication property, so the page states the
    // definition instead of repeating a label the number does not earn.
    ['Scored share of the ledger', rateOf(totals.publicationCoverage, totals.entries, 'entries')],
  ];
  return `      <div class="table-scroll"><table data-ledger-totals>
        <caption>Resolution ledger totals for the rolling window. Voided entries are counted for coverage and excluded from every score below. A judging backlog is an ordinary state of the ledger, not a fault.</caption>
        <thead><tr><th scope="col">Ledger stage</th><th scope="col">Entries</th></tr></thead>
        <tbody>
${rows.map(([label, value]) => `          <tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('\n')}
        </tbody>
      </table></div>`;
}

function calibrationTable(scorecard, escapeHtml) {
  const buckets = scorecard.calibration;
  const populated = buckets.filter((bucket) => Number(bucket.count) > 0);
  const scored = scorecard.overall?.count ?? scorecard.totals?.scored ?? 0;
  return `      <div class="table-scroll"><table data-calibration>
        <caption>Calibration by predicted probability, computed over all ${escapeHtml(formatCount(scored))} scored entries rather than the narrower headline cohort. Average predicted and Brier are probabilities, not rates. Buckets that scored nothing are omitted rather than shown as zero.</caption>
        <thead><tr><th scope="col">Predicted probability</th><th scope="col">Forecasts</th><th scope="col">Average predicted</th><th scope="col">Actually happened</th><th scope="col">Brier</th></tr></thead>
        <tbody>
${populated.map((bucket) => `          <tr data-calibration-bucket="${escapeHtml(bucket.bucket)}"><th scope="row" data-probability-band>${escapeHtml(probabilityBand(bucket))}</th><td>${escapeHtml(formatCount(bucket.count))}</td><td>${scoreCell(bucket.predictedMean, escapeHtml)}</td><td>${escapeHtml(isFiniteNumber(bucket.realizedRate) ? rateOf(bucket.realizedRate, bucket.count, 'forecasts') : INSUFFICIENT_SAMPLE)}</td><td>${scoreCell(bucket.brier, escapeHtml)}</td></tr>`).join('\n')}
        </tbody>
      </table></div>`;
}

function domainTable(rows, escapeHtml) {
  return `      <div class="table-scroll"><table data-by-domain>
        <caption>Accuracy by forecast domain, over every scored entry in that domain. A domain that resolved entries but scored none is marked as an insufficient sample, never left blank.</caption>
        <thead><tr><th scope="col">Domain</th><th scope="col">Resolved</th><th scope="col">Scored</th><th scope="col">Voided</th><th scope="col">Brier</th><th scope="col">Log score</th></tr></thead>
        <tbody>
${rows.map((row) => `          <tr data-domain="${escapeHtml(row.domain)}"><th scope="row">${escapeHtml(row.domain)}</th><td>${escapeHtml(formatCount(row.resolved))}</td><td>${escapeHtml(formatCount(row.scored))}</td><td>${escapeHtml(rateOf(row.voidRate, row.resolved, 'resolved'))}</td><td>${scoreCell(row.brier, escapeHtml)}</td><td>${scoreCell(row.logScore, escapeHtml)}</td></tr>`).join('\n')}
        </tbody>
      </table></div>`;
}

function originTable(rows, skill, escapeHtml) {
  const excluded = new Set(Array.isArray(skill?.excludedOrigins) ? skill.excludedOrigins : []);
  return `      <div class="table-scroll"><table data-by-origin>
        <caption>Accuracy by generation origin, and whether each origin counts toward the headline cohort. An entry with no recorded origin is filed as unknown and does count.</caption>
        <thead><tr><th scope="col">Generation origin</th><th scope="col">In the headline cohort</th><th scope="col">Resolved</th><th scope="col">Scored</th><th scope="col">Voided</th><th scope="col">Brier</th><th scope="col">Log score</th></tr></thead>
        <tbody>
${rows.map((row) => `          <tr data-origin="${escapeHtml(row.generationOrigin)}"><th scope="row">${escapeHtml(row.generationOrigin)}</th><td>${escapeHtml(excluded.has(row.generationOrigin) ? 'No, excluded' : 'Yes')}</td><td>${escapeHtml(formatCount(row.resolved))}</td><td>${escapeHtml(formatCount(row.scored))}</td><td>${escapeHtml(rateOf(row.voidRate, row.resolved, 'resolved'))}</td><td>${scoreCell(row.brier, escapeHtml)}</td><td>${scoreCell(row.logScore, escapeHtml)}</td></tr>`).join('\n')}
        </tbody>
      </table></div>`;
}

function marketSection(vsMarketSkill, escapeHtml) {
  if (!isPlainObject(vsMarketSkill) || !isFiniteNumber(vsMarketSkill.count) || vsMarketSkill.count === 0) {
    return `      <h2>Against prediction markets</h2>
      <p>No resolved forecast in this window overlapped a liquid market, so there is no head-to-head comparison to publish.</p>`;
  }
  const delta = Number(vsMarketSkill.brierDelta);
  const verdict = delta < 0
    ? 'the market scored better'
    : delta > 0
      ? 'the forecast scored better'
      : 'the two tied';
  return `      <h2>Against prediction markets</h2>
      <p>Measured over all scored entries that overlapped a liquid market, not over the narrower headline cohort. On ${escapeHtml(formatCount(vsMarketSkill.count))} such resolved questions the forecast Brier was ${escapeHtml(formatScore(vsMarketSkill.forecastBrier))} and the market Brier was ${escapeHtml(formatScore(vsMarketSkill.marketBrier))}. ${escapeHtml(BRIER_DELTA_CONVENTION)} Here the delta is ${escapeHtml(formatScore(delta))}, so on this sample ${escapeHtml(verdict)}.</p>`;
}

function cohortSection(skill, escapeHtml) {
  const count = isFiniteNumber(skill?.count) ? skill.count : 0;
  const excludedScored = isFiniteNumber(skill?.excludedScored) ? skill.excludedScored : 0;
  return `      <h2>What the headline number counts</h2>
      <p>The headline Brier and log score cover ${escapeHtml(formatCount(count))} scored forecasts: every scored entry except those from the origins the scorecard excludes, currently ${escapeHtml(excludedCohortPhrase(skill))}. That exclusion costs ${escapeHtml(formatCount(excludedScored))} scored entries. An entry that carries no origin at all is filed as unknown and is counted, so this cohort is defined by what it leaves out and not by any property of the entries it keeps. The all-scored figure beside it is the same window with every origin put back, which is why the two numbers differ.</p>`;
}

function limitsSection(omittedBuckets, escapeHtml) {
  const bucketSentence = omittedBuckets.length > 0
    ? `Calibration buckets that scored nothing are omitted from the table rather than drawn as a zero: ${omittedBuckets.join(', ')} are empty in this window.`
    : 'Every calibration bucket scored at least one forecast in this window, so none is omitted.';
  return `      <h2>What this page does not publish</h2>
      <ul>
        <li>${escapeHtml(bucketSentence)}</li>
        <li>No confidence intervals. Each figure is published with the number of forecasts behind it instead, because stating a sample size without an interval is honest and inventing an interval is not. Tracking: <a href="${escapeHtml(CONFIDENCE_INTERVAL_ISSUE)}">issue #7072</a>.</li>
        <li>No accuracy for the 24-hour, 7-day and 30-day projections shown in the product. Those horizons are not scored yet, so nothing here describes them. Tracking: <a href="${escapeHtml(HORIZON_SCORING_ISSUE)}">issue #7075</a>.</li>
        <li>No individual forecasts, resolution evidence, judge inputs or archive locations. This page publishes aggregates only.</li>
      </ul>`;
}

function relatedSection(baseUrl, tpl) {
  const { escapeHtml, absoluteUrl, withUtmSource } = tpl;
  return `      <a class="cta" href="${escapeHtml(withUtmSource(absoluteUrl(baseUrl, '/dashboard'), 'seo-accuracy'))}">Open the live forecast panel in World Monitor →</a>
      <h2>Related reference</h2>
      <ul class="related">
        <li><a href="/blog/posts/ai-forecast-accuracy-brier-scorecard-worldmonitor/">Why we publish the ledger</a></li>
        <li><a href="/country-instability-index/">Country Instability Index</a></li>
        <li><a href="/countries/">Country Resilience Index</a></li>
        <li><a href="/crises/">Crisis trackers</a></li>
        <li><a href="/docs/methodology/cii-risk-scores">CII methodology</a></li>
      </ul>`;
}

function provenanceLine(state, dataset, snapshotPath, escapeHtml) {
  const dated = state.scorecard
    ? ` Numbers generated ${escapeHtml(formatUtcDateTime(state.generatedAt))} and read on ${escapeHtml(state.capturedAt || 'an unrecorded date')}.`
    : '';
  return `      <p class="source">Download: <a href="${escapeHtml(dataset.href)}">${escapeHtml(dataset.filename)}</a>. Source: ${escapeHtml(snapshotPath)}.${dated} Live results come from the credentialed forecast scorecard endpoint, which this page freezes so it can be read without one.</p>`;
}

function accuracyBody({ state, baseUrl, tpl, dataset, snapshotPath }) {
  const { escapeHtml } = tpl;
  const heading = `      <p class="eyebrow">Forecast accuracy</p>
      <h1>Forecast accuracy scorecard</h1>`;

  if (!state.scorecard) {
    return `${heading}
      <p class="lede">World Monitor scores its own forecasts with Brier and log scores over a rolling window and publishes the result here. This edition has no numbers to publish.</p>
${recordStatus(state, escapeHtml)}
      <p>No score, calibration table or domain breakdown is shown. The next weekly refresh republishes the record.</p>
${relatedSection(baseUrl, tpl)}
${provenanceLine(state, dataset, snapshotPath, escapeHtml)}`;
  }

  const { scorecard } = state;
  const omittedBuckets = scorecard.calibration
    .filter((bucket) => Number(bucket.count) === 0)
    .map((bucket) => bucket.bucket);

  return `${heading}
      <p class="lede">World Monitor scores every forecast it publishes once the outcome is knowable, over a rolling ${escapeHtml(formatCount(scorecard.rollingWindowDays))}-day window. This is the standing record: the scores, the calibration, the sample sizes, and the parts that are not measurable yet.</p>
${recordStatus(state, escapeHtml)}
${state.coverage === 'insufficient' ? '' : `${headlineTiles(scorecard, escapeHtml)}\n${headlineResultParagraph(scorecard, escapeHtml)}`}      <p><strong>Lower Brier is better.</strong> A Brier score is the mean squared error of a probability forecast, so 0 is perfect and answering 0.5 to everything scores 0.25. Log score is harsher on confident mistakes, and lower is better there too.</p>
${cohortSection(scorecard.skill, escapeHtml)}
      <h2>Resolution ledger</h2>
${totalsTable(scorecard.totals, escapeHtml)}
      <p>${escapeHtml(scorecard.methodology)}</p>
      <h2>Calibration</h2>
${calibrationTable(scorecard, escapeHtml)}
      <h2>Accuracy by domain</h2>
${domainTable(scorecard.byDomain, escapeHtml)}
      <h2>Accuracy by generation origin</h2>
${originTable(scorecard.byGenerationOrigin, scorecard.skill, escapeHtml)}
${marketSection(scorecard.vsMarketSkill, escapeHtml)}
${limitsSection(omittedBuckets, escapeHtml)}
${relatedSection(baseUrl, tpl)}
${provenanceLine(state, dataset, snapshotPath, escapeHtml)}`;
}

function assertMetaDescription(description) {
  const length = [...description].length;
  if (length < 155 || length > 160) {
    throw new Error(`/accuracy/ meta description must be 155–160 chars (got ${length})`);
  }
}

function accuracyDatasetLd({ baseUrl, tpl, state, dataset }) {
  const { absoluteUrl } = tpl;
  const canonical = absoluteUrl(baseUrl, ACCURACY_PAGE_PATH);
  return {
    '@context': SCHEMA_ORG_CONTEXT_URL,
    '@type': 'Dataset',
    '@id': `${canonical}#dataset`,
    name: 'World Monitor forecast resolution scorecard',
    description:
      'Aggregate accuracy of World Monitor forecasts over a rolling window: Brier and log scores for the headline cohort and for every scored entry, calibration buckets with their sample sizes, per-domain and per-origin breakdowns, void rates, and a head-to-head against liquid prediction markets. Frozen from the credentialed forecast scorecard API into a committed snapshot, so the published figures and the machine-readable distribution always agree.',
    identifier: DATASET_IDENTIFIER,
    keywords: [
      'forecast accuracy',
      'Brier score',
      'forecast calibration',
      'log score',
      'prediction track record',
    ],
    creator: { ...WORLD_MONITOR_ORG },
    license: DATASET_LICENSE,
    isAccessibleForFree: true,
    inLanguage: 'en-US',
    spatialCoverage: 'Worldwide',
    includedInDataCatalog: dataset.catalog,
    variableMeasured: [
      'Brier score',
      'Logarithmic score',
      'Calibration bucket realized rate',
      'Void rate',
      'Scored forecast count',
    ],
    measurementTechnique: 'Brier and logarithmic scoring of resolved binary forecast windows',
    ...(state.capturedAt ? { temporalCoverage: state.capturedAt } : {}),
    distribution: [dataset.download],
  };
}

export function renderAccuracyPage({ baseUrl, tpl, state, lastmod, dataset, dataCatalog, snapshotPath }) {
  const { breadcrumbLd, absoluteUrl, pageDocument } = tpl;
  assertMetaDescription(META_DESCRIPTION);
  const canonical = absoluteUrl(baseUrl, ACCURACY_PAGE_PATH);
  return pageDocument({
    baseUrl,
    path: ACCURACY_PAGE_PATH,
    title: 'Forecast Accuracy Scorecard | World Monitor',
    description: META_DESCRIPTION,
    lastmod,
    ogType: 'article',
    jsonLd: [
      {
        '@context': SCHEMA_ORG_CONTEXT_URL,
        '@type': 'WebPage',
        name: 'Forecast accuracy scorecard',
        description: META_DESCRIPTION,
        url: canonical,
        inLanguage: 'en-US',
        dateModified: lastmod,
        publisher: { ...WORLD_MONITOR_ORG },
      },
      accuracyDatasetLd({ baseUrl, tpl, state, dataset }),
      dataCatalog,
    ].filter(Boolean),
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Forecast accuracy', path: ACCURACY_PAGE_PATH },
    ]),
    body: accuracyBody({ state, baseUrl, tpl, dataset, snapshotPath }),
  });
}

export function accuracyDatasetDownload({ state, snapshotPath }) {
  const skill = isPlainObject(state.scorecard?.skill) ? state.scorecard.skill : null;
  const payload = {
    dataset: DATASET_IDENTIFIER,
    record: {
      availability: state.availability,
      freshness: state.freshness,
      coverage: state.coverage,
      headline: state.headline,
      failureCode: state.failureCode,
    },
    attemptedAt: state.attemptedAt,
    capturedAt: state.capturedAt,
    generatedAt: state.generatedAt === null ? null : new Date(state.generatedAt).toISOString(),
    measurementAgeHours: state.ageHours === null ? null : Math.round(state.ageHours),
    staleAfterHours: SCORECARD_STALE_AFTER_HOURS,
    source: snapshotPath,
    license: DATASET_LICENSE.url,
    scoreConvention: `Lower Brier and lower log score are better. ${BRIER_DELTA_CONVENTION}`,
    headlineCohort: skill
      ? {
        scored: isFiniteNumber(skill.count) ? skill.count : 0,
        excludedScored: isFiniteNumber(skill.excludedScored) ? skill.excludedScored : 0,
        excludedOrigins: Array.isArray(skill.excludedOrigins) ? [...skill.excludedOrigins] : [],
        definition: 'every scored entry except those whose generationOrigin is listed in excludedOrigins; an absent origin is filed as unknown and is included',
      }
      : null,
    // calibrationBuckets, summarizeMarketSkill and summarizeScored all run over
    // the full scored set, so a consumer must not read them as the cohort above.
    pooledPopulations: {
      calibration: POOLED_POPULATION,
      vsMarketSkill: POOLED_POPULATION,
      overall: POOLED_POPULATION,
    },
    confidenceIntervals: { published: false, trackedIn: CONFIDENCE_INTERVAL_ISSUE },
    horizonProjections: { scored: false, trackedIn: HORIZON_SCORING_ISSUE },
    scorecard: state.scorecard,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function writeAccuracySection({
  outDir,
  baseUrl,
  tpl,
  section,
  lastmod = ACCURACY_CONTENT_VERSION,
  dataset,
  dataCatalog,
  snapshotPath,
}) {
  if (!dataCatalog?.['@id'] || !dataset?.catalog?.['@id']) {
    throw new Error(
      'writeAccuracySection requires the canonical DataCatalog identity so the scorecard Dataset joins the catalog graph',
    );
  }
  const state = classifyAccuracyState(section);
  mkdirSync(join(outDir, 'accuracy'), { recursive: true });
  writeFileSync(
    join(outDir, 'accuracy', 'index.html'),
    renderAccuracyPage({ baseUrl, tpl, state, lastmod, dataset, dataCatalog, snapshotPath }),
  );
  const downloadPath = join(outDir, dataset.file);
  mkdirSync(dirname(downloadPath), { recursive: true });
  writeFileSync(downloadPath, accuracyDatasetDownload({ state, snapshotPath }));
  return { state };
}
