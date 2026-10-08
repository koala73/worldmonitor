#!/usr/bin/env node
// Deterministic generator for /accuracy/, the standing forecast-resolution
// record (issue #6646). Template helpers are injected by
// build-crawlable-corpus.mjs, the single owner of the corpus HTML shell.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  PUBLIC_RECEIPT_FIELDS,
  RECEIPT_SOURCE_LABELS,
  RECEIPT_VOID_REASON_LABELS,
  SKILL_MIN_FAMILIES,
  SKILL_MIN_OUTCOME_FAMILIES,
  wilsonInterval,
} from './_forecast-scorecard.mjs';
import { FORECAST_ACCURACY_AUDIT } from '../shared/forecast-accuracy-audit.js';

/** Bump when the page copy changes so its lastmod advances without touching every sibling. */
export const ACCURACY_CONTENT_VERSION = '2026-10-08';

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
  'publishedByDomain',
  'uncertainty',
  'funnel',
  'receipts',
  'marketAlerts',
]);

// Proto fields the frozen page and its download deliberately leave out.
// familyOutcomes keys the live forecast-card chips by forecast id; a weekly
// snapshot has no live cards, and the distribution publishes no forecast ids.
// underAudit mirrors FORECAST_ACCURACY_AUDIT, which the page and download read
// at build time, so a captured copy would only go stale.
export const SCORECARD_LIVE_ONLY_FIELDS = Object.freeze(['familyOutcomes', 'underAudit']);

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
const SKILL_FIELDS = Object.freeze(['count', 'brier', 'logScore', 'excludedScored', 'excludedOrigins', 'yesCount', 'bssCi95']);
const PUBLISHED_DOMAIN_FIELDS = Object.freeze(['domain', 'count', 'brier', 'yesCount', 'bss']);
const UNCERTAINTY_FIELDS = Object.freeze(['method', 'overallBrier', 'skillBrier']);
const INTERVAL_FIELDS = Object.freeze(['count', 'mean', 'ci95', 'insufficientSample']);
const FUNNEL_FIELDS = Object.freeze([
  'matured', 'immature', 'maturityUnknown', 'resolved', 'scored', 'pendingHardMatured', 'pendingJudgeMatured',
  'resolvedOfMatured', 'scoredOfMatured',
]);
const PROPORTION_FIELDS = Object.freeze(['count', 'successes', 'rate', 'ci95']);
// Mirrors MARKET_ALERT_FIELDS and MARKET_ALERT_ROW_FIELDS in
// server/worldmonitor/forecast/v1/scorecard-fields.ts (a test pins the parity).
const MARKET_ALERT_FIELDS = Object.freeze(['generatedAt', 'windowHours', 'rollingWindowDays', 'methodology', 'byType']);
const MARKET_ALERT_ROW_FIELDS = Object.freeze(['type', 'scored', 'hitRate', 'baseN', 'baseHitRate', 'pairedHitRate', 'medianLeadTimeMs']);

export const SCORECARD_NESTED_OBJECT_FIELDS = Object.freeze({
  totals: TOTALS_FIELDS,
  overall: SUMMARY_FIELDS,
  vsMarketSkill: MARKET_SKILL_FIELDS,
  skill: SKILL_FIELDS,
  uncertainty: UNCERTAINTY_FIELDS,
  funnel: FUNNEL_FIELDS,
  marketAlerts: MARKET_ALERT_FIELDS,
});
// Members that are themselves objects. The producer writes null for an
// interval it cannot compute, and null is kept: it is the not-measurable state.
export const SCORECARD_NESTED_CHILD_FIELDS = Object.freeze({
  uncertainty: { overallBrier: INTERVAL_FIELDS, skillBrier: INTERVAL_FIELDS },
  funnel: { resolvedOfMatured: PROPORTION_FIELDS, scoredOfMatured: PROPORTION_FIELDS },
});
// Members that are row lists, picked row by row.
export const SCORECARD_NESTED_ROW_CHILD_FIELDS = Object.freeze({
  marketAlerts: { byType: MARKET_ALERT_ROW_FIELDS },
});
export const SCORECARD_NESTED_ROW_FIELDS = Object.freeze({
  byDomain: DOMAIN_FIELDS,
  byGenerationOrigin: ORIGIN_FIELDS,
  calibration: CALIBRATION_FIELDS,
  publishedByDomain: PUBLISHED_DOMAIN_FIELDS,
  receipts: PUBLIC_RECEIPT_FIELDS,
});

const ISSUE_URL = 'https://github.com/koala73/worldmonitor/issues';
const CONFIDENCE_INTERVAL_ISSUE = `${ISSUE_URL}/7072`;
const HORIZON_SCORING_ISSUE = `${ISSUE_URL}/9057`;
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

const META_DESCRIPTION = 'World Monitor grades its own forecasts against always forecasting how often events actually happened: skill scores, Brier and log scores, and sample sizes.';
const AUDIT_META_DESCRIPTION = 'World Monitor\'s forecast accuracy record is under audit. Its scores are withdrawn while scoring errors are corrected; the method and the receipts stay public.';

export function auditIssueUrl(audit) {
  return `${ISSUE_URL}/${audit.issue}`;
}

const auditSinceSentence = (audit) => `Under audit since ${audit.since}.`;
const auditNoticeBody = (audit, where) => `${audit.reason} The scores previously shown ${where} were not reliable and are withdrawn while corrections are made. Forecasts are still being published and logged, and their outcomes will be rescored once the fixes land.`;

/** The withdrawal notice every surface prints while the audit switch is set. */
export function accuracyAuditNotice(audit, where = 'here') {
  return `${auditSinceSentence(audit)} ${auditNoticeBody(audit, where)}`;
}

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
    if (Object.hasOwn(SCORECARD_NESTED_OBJECT_FIELDS, field)) {
      const nested = pickFields(payload[field], SCORECARD_NESTED_OBJECT_FIELDS[field]);
      if (!nested) continue;
      for (const [child, childFields] of Object.entries(SCORECARD_NESTED_CHILD_FIELDS[field] ?? {})) {
        if (!Object.hasOwn(nested, child) || nested[child] === null) continue;
        const picked = pickFields(nested[child], childFields);
        if (picked) nested[child] = picked;
        else delete nested[child];
      }
      for (const [child, rowFields] of Object.entries(SCORECARD_NESTED_ROW_CHILD_FIELDS[field] ?? {})) {
        if (!Object.hasOwn(nested, child)) continue;
        if (Array.isArray(nested[child])) nested[child] = nested[child].map((row) => pickFields(row, rowFields)).filter(Boolean);
        else delete nested[child];
      }
      out[field] = nested;
      continue;
    }
    if (Object.hasOwn(SCORECARD_NESTED_ROW_FIELDS, field)) {
      if (!Array.isArray(payload[field])) continue;
      out[field] = payload[field]
        .map((row) => pickFields(row, SCORECARD_NESTED_ROW_FIELDS[field]))
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
  // is unmeasurable, and neither is a capture failure. A scored cohort is
  // measurable only on the producer's family minimums (#8990); a capture that
  // predates them cannot show it met them, so it reads as a small sample.
  const skillCount = isPlainObject(scorecard.skill) ? positiveMs(scorecard.skill.count) : null;
  const coverage = skillCount === null
    ? 'insufficient'
    : familyGate(scorecard) === 'met' ? 'measurable' : 'small-sample';

  const headline = availability !== 'ok'
    ? availability
    : freshness === 'stale'
      ? 'stale'
      : coverage === 'measurable'
        ? 'current'
        : 'insufficient';

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

function formatPercent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatSkill(value) {
  const text = Number(value).toFixed(2);
  return Number(text) > 0 ? `+${text}` : text === '-0.00' ? '0.00' : text;
}

// The producer's Brier interval resamples whole forecast families, and its
// insufficientSample flag carries the family minimums (#8990). A capture whose
// interval predates that method cannot show it met them.
const FAMILY_INTERVAL_METHOD = /^family-level /;

/**
 * Whether the headline cohort meets the family minimums: 'met', 'short', or
 * 'unknown' for a capture without a family-bootstrap interval over the cohort.
 */
export function familyGate(scorecard) {
  const skill = isPlainObject(scorecard?.skill) ? scorecard.skill : null;
  const method = scorecard?.uncertainty?.method;
  if (!skill || typeof method !== 'string' || !FAMILY_INTERVAL_METHOD.test(method)) return 'unknown';
  const interval = scoreInterval(scorecard.uncertainty.skillBrier, skill.count, skill.brier);
  if (!interval) return 'unknown';
  return interval.small ? 'short' : 'met';
}

/**
 * Skill against the cohort's actual rate (#8990): how often these same
 * forecasts came true in the window. BSS = 1 - Brier / p(1-p), from the counts
 * the capture carries, the producer's formula. A better or worse verdict needs
 * the producer's family-bootstrap skill interval (skill.bssCi95), which lets p
 * vary across resamples, to sit wholly above or below 0. Mapping the Brier
 * interval with p held fixed instead overstated certainty: a 30-family cohort
 * read +0.17 to +0.47 that way, against -0.24 to +0.48 from the producer.
 */
export function baseRateSkill(scorecard) {
  const skill = isPlainObject(scorecard?.skill) ? scorecard.skill : null;
  if (!skill) return null;
  const { count, yesCount, brier } = skill;
  if (!isFiniteNumber(count) || count <= 0 || !isFiniteNumber(brier)) return null;
  if (!Number.isInteger(yesCount) || yesCount < 0 || yesCount > count) return null;
  const rate = yesCount / count;
  const referenceBrier = rate * (1 - rate);
  const bss = referenceBrier > 0 ? 1 - brier / referenceBrier : null;
  const gate = familyGate(scorecard);
  const familyGated = gate !== 'unknown';
  const measurable = bss !== null && gate === 'met';
  const [low, high] = Array.isArray(skill.bssCi95) && skill.bssCi95.length === 2 ? skill.bssCi95 : [];
  const ci95 = bss !== null && isFiniteNumber(low) && isFiniteNumber(high) && low <= high ? [low, high] : null;
  const verdict = !measurable
    ? 'small-sample'
    : ci95 && ci95[0] > 0 ? 'better' : ci95 && ci95[1] < 0 ? 'worse' : 'unclear';
  return { count, yesCount, rate, referenceBrier, brier, bss, ci95, familyGated, measurable, verdict };
}

// The reference in plain words: always forecasting how often these forecasts
// actually came true in the window, a rate known only in hindsight.
const REFERENCE = 'always forecasting how often these events actually happened';

const SKILL_LEADS = Object.freeze({
  better: `Better than ${REFERENCE}.`,
  worse: `Worse than ${REFERENCE}.`,
  unclear: `Cannot tell yet whether World Monitor beats ${REFERENCE}.`,
});

function skillIntervalPhrase(reading) {
  return reading.ci95 ? `, 95% interval ${formatSkill(reading.ci95[0])} to ${formatSkill(reading.ci95[1])}` : '';
}

const SKILL_RULE = `at least ${SKILL_MIN_FAMILIES} forecast families, with at least ${SKILL_MIN_OUTCOME_FAMILIES} that came true and ${SKILL_MIN_OUTCOME_FAMILIES} that did not`;

function familyPhrase({ familyGated, measurable }) {
  if (!familyGated) return 'forecast families this capture does not count';
  return measurable ? `at least ${SKILL_MIN_FAMILIES} forecast families` : 'too few forecast families';
}

const SKILL_SCALE = '0 means the same error as that rate, 1 means perfect, and below 0 means a larger error';

// Every binomial proportion the page shows is a count over a count it already
// publishes, so its Wilson interval needs nothing the capture does not carry.
// Mean scores are different: their interval needs the per-entry scores, which
// the public response does not carry, so the page never estimates one.
function proportionEstimate(successes, count) {
  if (!Number.isInteger(successes) || !Number.isInteger(count) || successes < 0 || successes > count) return null;
  const ci95 = wilsonInterval(successes, count);
  return ci95 ? { successes, count, ci95 } : null;
}

function keyedEstimates(rows, key, successesOf, countOf) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const estimate = proportionEstimate(successesOf(row), countOf(row));
    if (estimate && typeof row[key] === 'string') out[row[key]] = estimate;
  }
  return out;
}

export function proportionIntervals(scorecard) {
  if (!isPlainObject(scorecard)) return null;
  const voidOf = (row) => row.void;
  const resolvedOf = (row) => row.resolved;
  return {
    method: 'wilson-95',
    void: isPlainObject(scorecard.totals) ? proportionEstimate(scorecard.totals.void, scorecard.totals.resolved) : null,
    byDomain: keyedEstimates(scorecard.byDomain, 'domain', voidOf, resolvedOf),
    byGenerationOrigin: keyedEstimates(scorecard.byGenerationOrigin, 'generationOrigin', voidOf, resolvedOf),
    calibration: keyedEstimates(scorecard.calibration, 'bucket', bucketYesCount, (bucket) => Number(bucket.count)),
  };
}

// Bounds are marked so the page's population rule can tell them apart from a
// rate: an interval belongs to the counted rate printed beside it.
function intervalHtml(estimate, escapeHtml) {
  const text = estimate ? `${formatPercent(estimate.ci95[0])} to ${formatPercent(estimate.ci95[1])}` : 'No interval';
  return `<span data-rate-interval>${escapeHtml(text)}</span>`;
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

// A mean score's interval needs every forecast's own score, so the page cannot
// derive it and prints the producer's. It is shown only beside a score over the
// same forecasts (same count, same mean); anything else is not measurable.
// Both sides round to six decimals, so equal means agree to 1e-6.
function scoreInterval(interval, count, score) {
  // One forecast resamples to itself, so its interval has zero width.
  if (!isPlainObject(interval) || !isFiniteNumber(count) || count < 2 || interval.count !== count) return null;
  if (!isFiniteNumber(score) || !isFiniteNumber(interval.mean) || Math.abs(interval.mean - score) > 1e-6) return null;
  const [low, high] = Array.isArray(interval.ci95) && interval.ci95.length === 2 ? interval.ci95 : [];
  if (!isFiniteNumber(low) || !isFiniteNumber(high) || low < 0 || low > high || high > 1) return null;
  return { low, high, small: interval.insufficientSample === true };
}

// The headline tiles carry the Brier intervals and render only for a
// measurable cohort, so the page and the distribution both ask this.
function shownBrierIntervals(state) {
  const scorecard = state.scorecard;
  if (!scorecard || state.coverage === 'insufficient') return { skill: null, overall: null };
  const uncertainty = scorecard.uncertainty;
  return {
    skill: scoreInterval(uncertainty?.skillBrier, scorecard.skill?.count, scorecard.skill?.brier),
    overall: scoreInterval(uncertainty?.overallBrier, scorecard.overall?.count, scorecard.overall?.brier),
  };
}

function scoreIntervalText(interval) {
  if (!interval) return '95% interval not measurable';
  return `95% interval ${formatScore(interval.low)} to ${formatScore(interval.high)}${interval.small ? ', small sample' : ''}`;
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

// One answer for the caption, the cohort paragraph, the origin row and the
// download (#5240). excludedOrigins names only origins that had scored entries,
// so it can say "excluded" or "counted" only when unknown entries were scored.
// Captures from before #5240 counted them.
function unknownOriginStatus(scorecard) {
  const rows = Array.isArray(scorecard?.byGenerationOrigin) ? scorecard.byGenerationOrigin : [];
  if (!rows.some((row) => row?.generationOrigin === 'unknown' && row.scored > 0)) return 'none-scored';
  const excluded = scorecard?.skill?.excludedOrigins;
  return Array.isArray(excluded) && excluded.includes('unknown') ? 'excluded' : 'counted';
}

const UNKNOWN_ORIGIN_SENTENCES = Object.freeze({
  counted: 'An entry that carries no origin at all is filed as unknown and is counted.',
  excluded: 'An entry that carries no origin at all is filed as unknown and is left out: those entries predate origin tagging and cannot be attributed to a generator.',
  'none-scored': 'An entry that carries no origin at all is filed as unknown; none was scored in this window.',
});

const UNKNOWN_ORIGIN_DEFINITIONS = Object.freeze({
  counted: ' and is included',
  excluded: ' and is excluded',
  'none-scored': '; none was scored in this window',
});

function unknownOriginSentence(scorecard) {
  return UNKNOWN_ORIGIN_SENTENCES[unknownOriginStatus(scorecard)];
}

function originCohortCell(row, excluded, status) {
  if (row.generationOrigin === 'unknown') {
    return { counted: 'Yes', excluded: 'No, excluded', 'none-scored': 'No scored entries' }[status];
  }
  return excluded.has(row.generationOrigin) ? 'No, excluded' : 'Yes';
}

function excludedCohortPhrase(skill) {
  const origins = Array.isArray(skill?.excludedOrigins) ? skill.excludedOrigins : [];
  return origins.length > 0 ? origins.join(', ') : 'none';
}

function headlineResultSentence(scorecard, interval) {
  const skill = isPlainObject(scorecard?.skill) ? scorecard.skill : {};
  if (!isFiniteNumber(skill.brier) || !isFiniteNumber(skill.count) || skill.count <= 0) return '';
  const windowDays = isFiniteNumber(scorecard.rollingWindowDays) ? scorecard.rollingWindowDays : null;
  const windowPhrase = windowDays
    ? `Over the current ${formatCount(windowDays)}-day window`
    : 'Over the current rolling window';
  const brierPhrase = `${formatScore(skill.brier)}${interval ? ` (${scoreIntervalText(interval)})` : ''}`;
  const reading = baseRateSkill(scorecard);
  if (!reading || reading.bss === null) {
    return `${windowPhrase}, World Monitor's headline cohort scores a Brier of ${brierPhrase} across ${formatCount(skill.count)} scored forecasts. This capture cannot compare that with ${REFERENCE}.`;
  }
  const against = `against ${formatScore(reading.referenceBrier)} for always forecasting the actual rate of ${formatPercent(reading.rate)}`;
  if (!reading.measurable) {
    return `${windowPhrase}, World Monitor's headline cohort has ${formatCount(reading.count)} scored forecasts from ${familyPhrase(reading)}: a small sample, too few to judge whether it beats ${REFERENCE}. On it the Brier score is ${brierPhrase}, ${against}.`;
  }
  const outcome = reading.verdict === 'unclear'
    ? `it is not yet clear whether World Monitor's headline forecasts beat ${REFERENCE}`
    : `World Monitor's headline forecasts were ${reading.verdict} than ${REFERENCE}`;
  return `${windowPhrase}, ${outcome}: a skill score of ${formatSkill(reading.bss)}${skillIntervalPhrase(reading)}, where ${SKILL_SCALE}, over ${formatCount(reading.count)} scored forecasts from ${familyPhrase(reading)}. Their Brier score was ${brierPhrase}, ${against}.`;
}

const ACCURACY_NEGATIVE_SCOPE = 'This page does not publish confidence intervals for the log scores or the per-domain skill scores yet. Brier scores and the headline skill score carry a 95% interval, resampled by forecast family, when the scorecard includes one, and each score is published with the number of forecasts behind it and whether they come from enough forecast families to judge. Void rates and calibration-bucket rates carry a 95% Wilson interval; the scored share of the ledger and the base rates do not yet. World Monitor no longer publishes its 24-hour, 7-day and 30-day projections (since 2026-10-07), and this page does not score them. World Monitor still grades some of those horizons internally, and removing the projections changed none of the scores here. Individual forecasts appear only as receipts for the most recently resolved published forecasts; judge reasoning, the full news archive and internal data locations are not published.';

export function renderAccuracyLlmsSection(section, audit = FORECAST_ACCURACY_AUDIT) {
  const state = classifyAccuracyState(section);
  const page = new URL(ACCURACY_PAGE_PATH, WORLD_MONITOR_ORG.url).href;
  const paragraphs = [`The standing forecast-resolution record is published at ${page}.`];
  if (audit) {
    paragraphs.push(accuracyAuditNotice(audit, 'on that page'), `The audit's findings and fixes are tracked at ${auditIssueUrl(audit)}.`);
    return `## Forecast accuracy\n\n${paragraphs.join('\n\n')}\n`;
  }
  const result = state.scorecard ? headlineResultSentence(state.scorecard, shownBrierIntervals(state).skill) : '';
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

function skillTile(scorecard) {
  const reading = baseRateSkill(scorecard);
  if (!reading || reading.bss === null) {
    return ['Skill vs actual rate, headline cohort', 'Not measurable', 'This capture cannot compare the cohort with its actual rate'];
  }
  const sample = `${formatCount(reading.count)} scored forecasts from ${familyPhrase(reading)}`;
  return reading.measurable
    ? ['Skill vs actual rate, headline cohort', formatSkill(reading.bss), `${sample}${reading.ci95 ? skillIntervalPhrase(reading) : ', 95% interval not measurable'}`]
    : ['Skill vs actual rate, headline cohort', 'Too few to judge', `Small sample: reads ${formatSkill(reading.bss)} on ${sample}`];
}

function headlineTiles(scorecard, intervals, escapeHtml) {
  const skill = isPlainObject(scorecard.skill) ? scorecard.skill : {};
  const skillCount = isFiniteNumber(skill.count) ? skill.count : 0;
  const { overall, totals } = scorecard;
  const tiles = [
    skillTile(scorecard),
    [
      'Brier score, headline cohort',
      isFiniteNumber(skill.brier) ? formatScore(skill.brier) : 'Not measurable',
      `${formatCount(skillCount)} scored forecasts, ${scoreIntervalText(intervals.skill)}`,
    ],
    [
      'Log score, headline cohort',
      isFiniteNumber(skill.logScore) ? formatScore(skill.logScore) : 'Not measurable',
      `${formatCount(skillCount)} scored forecasts`,
    ],
    [
      'Brier score, every scored entry',
      isFiniteNumber(overall?.brier) ? formatScore(overall.brier) : 'Not measurable',
      `${formatCount(overall?.count ?? 0)} scored forecasts, ${scoreIntervalText(intervals.overall)}`,
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

function headlineResultParagraph(scorecard, interval, escapeHtml) {
  const sentence = headlineResultSentence(scorecard, interval);
  return sentence ? `      <p data-accuracy-result>${escapeHtml(sentence)}</p>\n` : '';
}

const RECORD_FACT_LABELS = Object.freeze({
  ok: 'Captured',
  'capture-failed': 'Last capture failed',
  missing: 'Never captured',
  current: 'Current',
  stale: 'Stale',
  measurable: 'Measurable',
  'small-sample': 'Small sample',
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
  const gate = familyGate(state.scorecard);
  const reading = { familyGated: gate !== 'unknown', measurable: gate === 'met' };
  const sample = `The headline cohort has ${formatCount(skill.count)} scored forecasts from ${familyPhrase(reading)}.`;
  if (state.coverage === 'small-sample') {
    return `${sample} Judging skill needs ${SKILL_RULE}, because the forecasts in one family are not independent. Read every headline score below as a small sample.`;
  }
  return `${sample} That meets the minimum for judging skill: ${SKILL_RULE}.`;
}

function totalsTable(totals, intervals, escapeHtml) {
  const rows = [
    ['Entries in the rolling window', escapeHtml(formatCount(totals.entries))],
    ['Resolved', escapeHtml(formatCount(totals.resolved))],
    ['Scored', escapeHtml(formatCount(totals.scored))],
    ['Voided', `${escapeHtml(`${rateOf(totals.voidRate, totals.resolved, 'resolved entries')} (${formatCount(totals.void)} entries), 95% interval`)} ${intervalHtml(intervals.void, escapeHtml)}`],
    ['Awaiting a judge', escapeHtml(formatCount(totals.pendingJudge))],
    ['Still open, not yet resolvable', escapeHtml(formatCount(totals.pending))],
    // The API calls this field publicationCoverage. It is scored over ALL
    // entries, which is not a publication property, so the page states the
    // definition instead of repeating a label the number does not earn.
    ['Scored share of the ledger', escapeHtml(rateOf(totals.publicationCoverage, totals.entries, 'entries'))],
  ];
  return `      <div class="table-scroll"><table data-ledger-totals>
        <caption>Resolution ledger totals for the rolling window. Forecasts withheld under issue #5234 are left out. These are state-derived sovereign risk, rates and inflation, and FX stress forecasts that no feed can check. Voided entries are counted for coverage and excluded from every score below. A judging backlog is an ordinary state of the ledger, not a fault. The void rate's 95% interval is a Wilson interval on the counts shown.</caption>
        <thead><tr><th scope="col">Ledger stage</th><th scope="col">Entries</th></tr></thead>
        <tbody>
${rows.map(([label, valueHtml]) => `          <tr><th scope="row">${escapeHtml(label)}</th><td>${valueHtml}</td></tr>`).join('\n')}
        </tbody>
      </table></div>`;
}

// Both rates are derived from the stage counts the table prints, so a rate can
// never describe a different population from the row above it.
function funnelRateHtml(successes, count, escapeHtml) {
  const estimate = proportionEstimate(successes, count);
  if (!estimate) return escapeHtml('Not measurable');
  const text = `${rateOf(estimate.successes / estimate.count, estimate.count, 'due or resolved forecasts')} (${formatCount(estimate.successes)} forecasts), 95% interval`;
  return `${escapeHtml(text)} ${intervalHtml(estimate, escapeHtml)}`;
}

function funnelSection(funnel, escapeHtml) {
  const heading = '      <h2>From deadline to grade</h2>';
  if (!isPlainObject(funnel)) {
    return `${heading}
      <p>This capture does not carry the maturity funnel yet, so the share of due forecasts that were resolved and graded is not shown.</p>`;
  }
  const count = (value) => escapeHtml(Number.isInteger(value) && value >= 0 ? formatCount(value) : 'Not measurable');
  const rows = [
    ['Past their deadline or resolved', count(funnel.matured)],
    ['Resolved', funnelRateHtml(funnel.resolved, funnel.matured, escapeHtml)],
    ['Graded', funnelRateHtml(funnel.scored, funnel.matured, escapeHtml)],
    ['Past their deadline, still open', count(funnel.pendingHardMatured)],
    ['Past their deadline, awaiting a judge', count(funnel.pendingJudgeMatured)],
    ['Not yet due, unresolved', count(funnel.immature)],
    ['No recorded deadline', count(funnel.maturityUnknown)],
  ];
  return `${heading}
      <div class="table-scroll"><table data-maturity-funnel>
        <caption>Of the forecasts in the ledger that are past their deadline or already resolved, how many were resolved and how many could be graded. Unresolved forecasts not yet due are left out of both rates, so a young forecast never counts as a miss. The 95% interval is a Wilson interval on the counts shown.</caption>
        <thead><tr><th scope="col">Stage</th><th scope="col">Forecasts</th></tr></thead>
        <tbody>
${rows.map(([label, valueHtml]) => `          <tr><th scope="row">${escapeHtml(label)}</th><td>${valueHtml}</td></tr>`).join('\n')}
        </tbody>
      </table></div>`;
}

const RECEIPT_OUTCOME_LABELS = Object.freeze({ YES: 'Happened', NO: 'Did not happen', VOID: 'Void' });

function utcDate(ms) {
  const date = new Date(isFiniteNumber(ms) ? ms : NaN);
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toISOString().slice(0, 10);
}

// The snapshot is a repo file a person can edit, so the page re-checks the
// link scheme the producer already enforced.
function httpsHref(value) {
  try {
    return typeof value === 'string' && new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function labelFor(labels, code) {
  return Object.hasOwn(labels, code) ? labels[code] : labels.other;
}

function receiptSourceHtml(receipt, escapeHtml) {
  if (receipt.outcome === 'VOID') {
    return escapeHtml(labelFor(RECEIPT_VOID_REASON_LABELS, receipt.voidReason));
  }
  if (typeof receipt.sourceFeed === 'string') {
    const label = labelFor(RECEIPT_SOURCE_LABELS, receipt.sourceFeed);
    const reading = isFiniteNumber(receipt.observedValue) ? ` read ${Number(receipt.observedValue.toPrecision(8))}` : '';
    return escapeHtml(`${label}${reading}`);
  }
  if (typeof receipt.citationTitle !== 'string' || !receipt.citationTitle) {
    return escapeHtml('Judged against archived news');
  }
  const href = httpsHref(receipt.citationUrl);
  const title = escapeHtml(receipt.citationTitle);
  return `${escapeHtml('Judged against archived news: ')}${href ? `<a href="${escapeHtml(href)}" rel="nofollow noopener">${title}</a>` : title}`;
}

const UNVERIFIED_RECEIPTS = 'Not yet rechecked. These outcomes were recorded by the scoring system the audit found errors in, so some may be wrong.';
const SCORED_CHANCE = 'The chance is the probability the forecast was scored at.';
const UNVERIFIED_SCORED_CHANCE = 'The chance is the probability each forecast was scored at. This may differ from the probability first published.';

function receiptsSection(scorecard, escapeHtml, unverified = false) {
  const heading = unverified
    ? '      <h2>Recently resolved forecasts, unverified</h2>'
    : '      <h2>Recently resolved forecasts</h2>';
  const { receipts } = scorecard;
  if (!Array.isArray(receipts)) {
    return `${heading}
      <p>This capture does not carry per-forecast receipts.</p>`;
  }
  // The API defaults the field to [], so an old seed and a window where only
  // excluded origins resolved look the same; name both rather than guess.
  if (receipts.length === 0 && Number(scorecard.totals?.resolved) > 0) {
    return `${heading}
      <p>This capture carries no receipts: it predates them, or no published forecast resolved in the window.</p>`;
  }
  const rows = receipts.filter((receipt) => (
    isPlainObject(receipt) && Object.hasOwn(RECEIPT_OUTCOME_LABELS, receipt.outcome) && typeof receipt.question === 'string'
  ));
  if (rows.length === 0) {
    return `${heading}
      <p>No forecast has resolved in this window yet, so there are no receipts to show.</p>`;
  }
  return `${heading}
      <div class="table-scroll"><table data-forecast-receipts${unverified ? ' data-receipts-unverified' : ''}>
        <caption>${unverified ? `${escapeHtml(UNVERIFIED_RECEIPTS)} ` : ''}The ${escapeHtml(formatCount(rows.length))} most recently resolved published forecasts, newest first, leaving out experimental, synthetic and unattributed origins, voids included. ${escapeHtml(unverified ? UNVERIFIED_SCORED_CHANCE : SCORED_CHANCE)} A hard forecast is settled by reading a World Monitor data feed; a judged one by AI judges reading archived news, and the linked item is one they cited. Dates are UTC.</caption>
        <thead><tr><th scope="col">Forecast</th><th scope="col">Made</th><th scope="col">${unverified ? 'Chance scored' : 'Chance given'}</th><th scope="col">Outcome</th><th scope="col">Resolved</th><th scope="col">How it was settled</th></tr></thead>
        <tbody>
${rows.map((receipt) => `          <tr data-receipt-outcome="${escapeHtml(receipt.outcome)}"><th scope="row">${escapeHtml(receipt.question)}</th><td>${escapeHtml(utcDate(receipt.forecastAt))}</td><td><span data-probability-band>${escapeHtml(isFiniteNumber(receipt.probability) ? `${Number((receipt.probability * 100).toFixed(1))}%` : 'Not recorded')}</span></td><td>${escapeHtml(RECEIPT_OUTCOME_LABELS[receipt.outcome])}</td><td>${escapeHtml(utcDate(receipt.resolvedAt))}</td><td>${receiptSourceHtml(receipt, escapeHtml)}</td></tr>`).join('\n')}
        </tbody>
      </table></div>`;
}

function calibrationTable(scorecard, intervals, escapeHtml) {
  const buckets = scorecard.calibration;
  const populated = buckets.filter((bucket) => Number(bucket.count) > 0);
  const scored = scorecard.overall?.count ?? scorecard.totals?.scored ?? 0;
  return `      <div class="table-scroll"><table data-calibration>
        <caption>Calibration by predicted probability, computed over all ${escapeHtml(formatCount(scored))} scored entries rather than the narrower headline cohort. Average predicted and Brier are probabilities, not rates. The 95% interval is a Wilson interval on how often the bucket's forecasts happened; a narrow bucket has a wide one. Buckets that scored nothing are omitted rather than shown as zero.</caption>
        <thead><tr><th scope="col">Predicted probability</th><th scope="col">Forecasts</th><th scope="col">Average predicted</th><th scope="col">Actually happened</th><th scope="col">95% interval</th><th scope="col">Brier</th></tr></thead>
        <tbody>
${populated.map((bucket) => `          <tr data-calibration-bucket="${escapeHtml(bucket.bucket)}"><th scope="row" data-probability-band>${escapeHtml(probabilityBand(bucket))}</th><td>${escapeHtml(formatCount(bucket.count))}</td><td>${scoreCell(bucket.predictedMean, escapeHtml)}</td><td>${escapeHtml(isFiniteNumber(bucket.realizedRate) ? rateOf(bucket.realizedRate, bucket.count, 'forecasts') : INSUFFICIENT_SAMPLE)}</td><td>${intervalHtml(intervals.calibration[bucket.bucket], escapeHtml)}</td><td>${scoreCell(bucket.brier, escapeHtml)}</td></tr>`).join('\n')}
        </tbody>
      </table></div>`;
}

// The forecast-card badge links here, so this table uses the badge's
// population (publishedByDomain) and sample floor. byDomain pools shadow and
// synthetic origins; it stays in the API and the download, not on the page.
const PUBLISHED_BY_DOMAIN_SCHEMA = 2;
const NOT_YET_MEASURED = 'Not yet measured';

// Mirrors DOMAIN_LABELS in src/components/ForecastPanel.ts, which the badge
// uses; scripts/ cannot import browser components, so a test pins the copy.
export const ACCURACY_DOMAIN_LABELS = Object.freeze({
  conflict: 'Conflict',
  market: 'Market',
  supply_chain: 'Supply Chain',
  political: 'Political',
  military: 'Military',
  cyber: 'Cyber',
  infrastructure: 'Infra',
});

export const MARKET_ALERT_TYPE_LABELS = Object.freeze({
  prediction_leads_news: 'Prediction market moved on a quiet news day',
  explained_market_move: 'Market moved alongside related news',
  silent_divergence: 'Market moved with no news found',
  flow_price_divergence: 'Energy price rose with no pipeline news',
});

function domainLabel(domain) {
  return ACCURACY_DOMAIN_LABELS[domain]
    ?? String(domain).split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// The producer writes a domain's bss only once the domain meets the family
// minimums (#8990), so its presence is the measurable gate.
function domainSkill(row) {
  const n = Number(row?.count);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (!isFiniteNumber(row?.bss) || !isFiniteNumber(row.brier)) return null;
  if (!Number.isInteger(row.yesCount) || row.yesCount < 0 || row.yesCount > n) return null;
  const rate = row.yesCount / n;
  return { bss: row.bss, brier: row.brier, referenceBrier: rate * (1 - rate) };
}

function domainSection(scorecard, escapeHtml) {
  const rows = scorecard.publishedByDomain;
  if (!isFiniteNumber(scorecard.schemaVersion) || scorecard.schemaVersion < PUBLISHED_BY_DOMAIN_SCHEMA || !Array.isArray(rows)) {
    return '      <p>This edition\'s scorecard predates the published-origin domain breakdown, so no per-domain accuracy is shown. The next weekly refresh publishes it.</p>';
  }
  if (rows.length === 0) {
    return '      <p>No published forecast has been graded in any domain yet.</p>';
  }
  return `      <div class="table-scroll"><table data-by-domain>
        <caption>Accuracy by forecast domain for published forecasts only: synthetic, unattributed and bet_engine entries are always left out, the same population as the forecast-card badges. A domain shows its scores once its graded forecasts come from ${escapeHtml(SKILL_RULE)}, and reads Not yet measured below that. The actual-rate Brier is what always forecasting how often the domain's forecasts actually came true would have scored, p(1-p). The skill score compares the two: ${escapeHtml(SKILL_SCALE)}. Per-domain skill scores carry no interval yet, so the table does not say which domains beat that rate.</caption>
        <thead><tr><th scope="col">Domain</th><th scope="col">Graded forecasts</th><th scope="col">Skill vs actual rate</th><th scope="col">Brier</th><th scope="col">Actual-rate Brier</th></tr></thead>
        <tbody>
${rows.map((row) => {
    const reading = domainSkill(row);
    const cells = reading
      ? [formatSkill(reading.bss), formatScore(reading.brier), formatScore(reading.referenceBrier)]
      : [NOT_YET_MEASURED, NOT_YET_MEASURED, NOT_YET_MEASURED];
    return `          <tr data-domain="${escapeHtml(row.domain)}"><th scope="row">${escapeHtml(domainLabel(row.domain))}</th><td>${escapeHtml(formatCount(row.count))}</td>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`;
  }).join('\n')}
        </tbody>
      </table></div>`;
}

function originTable(rows, skill, unknownStatus, intervals, escapeHtml) {
  const excluded = new Set(Array.isArray(skill?.excludedOrigins) ? skill.excludedOrigins : []);
  const unknownSentence = UNKNOWN_ORIGIN_SENTENCES[unknownStatus];
  return `      <div class="table-scroll"><table data-by-origin>
        <caption>Accuracy by generation origin, and whether each origin counts toward the headline cohort. ${escapeHtml(unknownSentence)}</caption>
        <thead><tr><th scope="col">Generation origin</th><th scope="col">In the headline cohort</th><th scope="col">Resolved</th><th scope="col">Scored</th><th scope="col">Voided</th><th scope="col">Voided, 95% interval</th><th scope="col">Brier</th><th scope="col">Log score</th></tr></thead>
        <tbody>
${rows.map((row) => `          <tr data-origin="${escapeHtml(row.generationOrigin)}"><th scope="row">${escapeHtml(row.generationOrigin)}</th><td>${escapeHtml(originCohortCell(row, excluded, unknownStatus))}</td><td>${escapeHtml(formatCount(row.resolved))}</td><td>${escapeHtml(formatCount(row.scored))}</td><td>${escapeHtml(rateOf(row.voidRate, row.resolved, 'resolved'))}</td><td>${intervalHtml(intervals.byGenerationOrigin[row.generationOrigin], escapeHtml)}</td><td>${scoreCell(row.brier, escapeHtml)}</td><td>${scoreCell(row.logScore, escapeHtml)}</td></tr>`).join('\n')}
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
      <p>Measured over every scored entry whose own question a liquid prediction market priced, not over the narrower headline cohort. On ${escapeHtml(formatCount(vsMarketSkill.count))} such resolved questions the forecast Brier was ${escapeHtml(formatScore(vsMarketSkill.forecastBrier))} and the market Brier was ${escapeHtml(formatScore(vsMarketSkill.marketBrier))}. ${escapeHtml(BRIER_DELTA_CONVENTION)} Here the delta is ${escapeHtml(formatScore(delta))}, so on this sample ${escapeHtml(verdict)}.</p>`;
}

const NOT_YET_MEASURABLE = 'Not yet measurable';
// A prediction question's topic words reach the news often with or without an
// alert, so its hit rate means nothing until the control windows have scored.
const CONTROL_GATED_ALERT_TYPES = new Set(['prediction_leads_news']);

const isRate = (value) => isFiniteNumber(value) && value >= 0 && value <= 1;
// Alerts are not forecast families, so they keep their own row count floor.
// The API withholds the median below MARKET_ALERT_MEDIAN_MIN_HITS in
// server/worldmonitor/forecast/v1/scorecard-fields.ts (a test pins the parity).
export const MARKET_ALERT_MIN_SAMPLE = 30;
const isMeasurableCount = (value) => Number.isInteger(value) && value >= MARKET_ALERT_MIN_SAMPLE;

function formatLeadTime(ms) {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

function marketAlertGates(row) {
  const compared = isMeasurableCount(row.baseN) && isRate(row.pairedHitRate) && isRate(row.baseHitRate);
  const published = compared || !CONTROL_GATED_ALERT_TYPES.has(row.type);
  const hit = published && isMeasurableCount(row.scored) && isRate(row.hitRate);
  return { compared, published, hit };
}

// hitRate × scored is the hit count exactly: the ledger's hitRate is hit / n.
// The API applies the same gate (selectMarketAlertRow, test-pinned).
export function marketAlertMedianPublished(row) {
  return marketAlertGates(row).hit && Math.round(row.hitRate * row.scored) >= MARKET_ALERT_MIN_SAMPLE
    && isFiniteNumber(row.medianLeadTimeMs) && row.medianLeadTimeMs >= 0;
}

function marketAlertCells(row) {
  const { compared, published, hit } = marketAlertGates(row);
  return [
    hit ? rateOf(row.hitRate, row.scored, 'alerts') : NOT_YET_MEASURABLE,
    published && compared ? rateOf(row.pairedHitRate, row.baseN, 'alerts') : NOT_YET_MEASURABLE,
    published && compared ? rateOf(row.baseHitRate, row.baseN, 'earlier windows') : NOT_YET_MEASURABLE,
    marketAlertMedianPublished(row) ? formatLeadTime(row.medianLeadTimeMs) : NOT_YET_MEASURABLE,
  ];
}

const MARKET_ALERTS_OUTSIDE_AUDIT = 'The audit did not cover this section. Market alerts are scored from a separate ledger, and these figures have not been rechecked.';

function marketAlertsSection(marketAlerts, escapeHtml, audited = false) {
  const heading = `      <h2 id="market-alerts">Market alerts: did the news follow?</h2>${audited ? `\n      <p data-market-alerts-audit-scope>${escapeHtml(MARKET_ALERTS_OUTSIDE_AUDIT)}</p>` : ''}`;
  if (!isPlainObject(marketAlerts) || !Array.isArray(marketAlerts.byType)) {
    return `${heading}
      <p>This edition carries no market-alert scores, so no market-alert hit rates are shown.</p>`;
  }
  const hours = isFiniteNumber(marketAlerts.windowHours) ? marketAlerts.windowHours : 6;
  const days = isFiniteNumber(marketAlerts.rollingWindowDays) ? marketAlerts.rollingWindowDays : 30;
  const generated = isFiniteNumber(marketAlerts.generatedAt) ? ` and were generated ${formatUtcDateTime(marketAlerts.generatedAt)}` : '';
  const intro = `      <p>World Monitor raises a market alert when a market or a prediction market makes an unusual move. Some alerts fire when there is no news behind the move, and one type fires when related news is already out. Each alert is checked ${escapeHtml(formatCount(hours))} hours later. It counts as a hit if an established news outlet published a new story about the same company, commodity or topic in that time. The same check also runs on the same market for a stretch of the same length one day earlier, when no alert was raised, and that gives the base rate. An alert type is useful only when its hit rate is clearly above the base rate on the same alerts. The figures cover the last ${escapeHtml(formatCount(days))} days${escapeHtml(generated)}.</p>`;
  // The rules come from the capture, so a rule change after it never sits
  // beside figures scored under the old rules.
  const methodology = typeof marketAlerts.methodology === 'string' ? marketAlerts.methodology.trim() : '';
  const rules = `      <h3>How an alert is scored</h3>
      <p>${escapeHtml(methodology || 'This edition did not capture the rules these alerts were scored under.')}</p>`;
  if (marketAlerts.byType.length === 0) {
    return `${heading}
${intro}
      <p>No market alert has been scored yet.</p>
${rules}`;
  }
  return `${heading}
${intro}
      <div class="table-scroll"><table data-market-alerts>
        <caption>Market-alert hit rates by alert type. Each figure is shown once ${escapeHtml(formatCount(MARKET_ALERT_MIN_SAMPLE))} alerts are behind it and reads Not yet measurable below that. The two comparison columns count only the alerts whose earlier window could also be checked, so both rates describe the same alerts. The typical wait is shown once ${escapeHtml(formatCount(MARKET_ALERT_MIN_SAMPLE))} alerts were followed by news. Prediction-market alerts are shown only once their earlier windows have been checked, because the topic words in a prediction question turn up in the news often anyway.</caption>
        <thead><tr><th scope="col">Alert type</th><th scope="col">Alerts scored</th><th scope="col">News followed</th><th scope="col">News followed, compared alerts</th><th scope="col">News a day earlier, same markets</th><th scope="col">Typical wait for the news (median)</th></tr></thead>
        <tbody>
${marketAlerts.byType.map((row) => `          <tr data-alert-type="${escapeHtml(row.type)}"><th scope="row">${escapeHtml(MARKET_ALERT_TYPE_LABELS[row.type] ?? row.type)}</th><td>${escapeHtml(formatCount(row.scored))}</td>${marketAlertCells(row).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('\n')}
        </tbody>
      </table></div>
${rules}`;
}

function cohortSection(skill, unknownSentence, escapeHtml) {
  const count = isFiniteNumber(skill?.count) ? skill.count : 0;
  const excludedScored = isFiniteNumber(skill?.excludedScored) ? skill.excludedScored : 0;
  return `      <h2>What the headline number counts</h2>
      <p>The headline Brier and log score cover ${escapeHtml(formatCount(count))} scored forecasts: every scored entry except those from the origins the scorecard excludes, currently ${escapeHtml(excludedCohortPhrase(skill))}. That exclusion costs ${escapeHtml(formatCount(excludedScored))} scored entries. ${escapeHtml(unknownSentence)} This cohort is defined by what it leaves out and not by any property of the entries it keeps. The all-scored figure beside it is the same window with every origin put back, which is why the two numbers differ.</p>`;
}

// The verdict block (#8873) leads with skill against the headline cohort's
// actual rate (#8990): the forecaster who answers that rate to everything,
// whose Brier is rate × (1 − rate). Outcomes in this ledger are rare, so that
// null is far stricter than the 0.25 coin flip.
const PROBABILITY_BANDS = Object.freeze([
  { lead: 'When World Monitor put the chance', phrase: 'under 20%', subject: 'the forecast', from: 0, below: 0.2 },
  { lead: 'When it put the chance', phrase: 'between 20% and 50%', subject: 'it', from: 0.2, below: 0.5 },
  { lead: 'When it put the chance at', phrase: '50% or more', subject: 'it', from: 0.5, below: Infinity },
]);

// The producer rounds realizedRate to six decimals, so count × realizedRate is
// within count × 5e-7 of the true YES count: Math.round is exact for any
// ledger under a million entries.
function bucketYesCount(bucket) {
  return Number(bucket.count) > 0 && isFiniteNumber(bucket.realizedRate)
    ? Math.round(Number(bucket.count) * bucket.realizedRate)
    : 0;
}

function bandOutcomes(calibration) {
  const buckets = Array.isArray(calibration) ? calibration : [];
  return PROBABILITY_BANDS.map((band) => {
    const rows = buckets.filter((bucket) => Number(bucket.minProbability) >= band.from && Number(bucket.minProbability) < band.below);
    return {
      band,
      count: rows.reduce((sum, bucket) => sum + Number(bucket.count), 0),
      yesCount: rows.reduce((sum, bucket) => sum + bucketYesCount(bucket), 0),
    };
  });
}

// null when the buckets do not account for every graded forecast: a base rate
// over a different population would be a number from nowhere.
function pooledCohort(scorecard) {
  const { overall } = scorecard;
  if (!isPlainObject(overall) || !isFiniteNumber(overall.count) || overall.count <= 0 || !isFiniteNumber(overall.brier)) return null;
  const bands = bandOutcomes(scorecard.calibration);
  if (bands.reduce((sum, band) => sum + band.count, 0) !== overall.count) return null;
  return {
    count: overall.count,
    yesCount: bands.reduce((sum, band) => sum + band.yesCount, 0),
    brier: overall.brier,
  };
}

function ledgerVerdictSentences(totals, windowDays) {
  const windowPhrase = isFiniteNumber(windowDays) ? `Over the current ${formatCount(windowDays)}-day window` : 'Over the current rolling window';
  return `${windowPhrase}, ${formatCount(totals.resolved)} forecasts came due and were resolved. ${formatCount(totals.scored)} could be graded against what happened. ${formatCount(totals.void)} could not be graded and were set aside: ${rateOf(totals.voidRate, totals.resolved, 'resolved forecasts')}. The scorecard does not yet publish why each one was set aside, so the reasons are not broken out here. Another ${formatCount(totals.pendingJudge)} are in the queue for a judge, counted whether or not their deadline has passed.`;
}

function bandSentence({ band, count, yesCount }, escapeHtml) {
  const outcome = count > 0
    ? `${band.subject} came true in ${formatCount(yesCount)} of ${formatCount(count)} cases.`
    : 'there were no graded forecasts.';
  return `${escapeHtml(band.lead)} <span data-probability-band>${escapeHtml(band.phrase)}</span>, ${escapeHtml(outcome)}`;
}

function marketVerdictSentence(vsMarketSkill) {
  if (!isPlainObject(vsMarketSkill) || !isFiniteNumber(vsMarketSkill.count) || vsMarketSkill.count === 0) {
    return 'No graded forecast overlapped a liquid prediction market, so there is no market comparison.';
  }
  const delta = Number(vsMarketSkill.brierDelta);
  const closer = delta < 0
    ? "the market's odds were closer to what happened than World Monitor's"
    : delta > 0
      ? "World Monitor's odds were closer to what happened than the market's"
      : 'the two were equally close to what happened';
  return `In the ${formatCount(vsMarketSkill.count)} cases where a liquid prediction market covered the same question, ${closer}.`;
}

// One rate over every graded forecast mixes domains whose outcomes come true
// at very different rates, so it is reported as a count, never as a verdict.
function pooledVerdictSentences(scorecard) {
  const cohort = pooledCohort(scorecard);
  if (!cohort) {
    return 'How often all graded forecasts came true cannot be derived from this capture, because its probability buckets do not account for every graded forecast.';
  }
  return `Across all ${formatCount(cohort.count)} graded forecasts, ${formatCount(cohort.yesCount)} came true: ${rateOf(cohort.yesCount / cohort.count, cohort.count, 'graded forecasts')}. That count pools kinds of forecast that come true at very different rates, so it is not compared with a single rate. Skill is judged within the headline cohort and within each domain.`;
}

// The page's lead (#8990): did the headline forecasts beat always forecasting
// how often these events actually happened? Better or worse only when the
// family-bootstrap interval excludes 0; a small sample reads as one.
function skillVerdict(scorecard) {
  const { skill } = scorecard;
  const count = isPlainObject(skill) && isFiniteNumber(skill.count) ? skill.count : 0;
  if (count <= 0 || !isFiniteNumber(skill.brier)) {
    return { verdict: 'none', lead: 'No skill to report yet.', text: 'The headline cohort has no graded forecast in this window, so there is nothing to compare with how often events actually happened.' };
  }
  const reading = baseRateSkill(scorecard);
  if (!reading) {
    return { verdict: 'none', lead: 'No skill to report yet.', text: `This capture does not record how many of the ${formatCount(count)} headline forecasts came true, so it cannot compare them with ${REFERENCE}.` };
  }
  const tally = `Of ${formatCount(reading.count)} graded forecasts, ${formatCount(reading.yesCount)} came true: ${rateOf(reading.rate, reading.count, 'forecasts')}.`;
  if (reading.bss === null) {
    return { verdict: 'none', lead: 'No skill to report yet.', text: `${tally} Every one went the same way, so always forecasting how often they happened was never wrong and there is nothing to beat.` };
  }
  const errors = `Always forecasting that ${formatPercent(reading.rate)} would have had an error of ${formatScore(reading.referenceBrier)}. World Monitor's error was ${formatScore(reading.brier)}.`;
  const sample = `They come from ${familyPhrase(reading)}.`;
  if (!reading.measurable) {
    return {
      verdict: 'small-sample',
      lead: 'Too few independent forecasts to judge yet.',
      text: `${tally} ${sample} Judging skill needs ${SKILL_RULE}. On this small sample the skill score reads ${formatSkill(reading.bss)}, which is not a result.`,
    };
  }
  const certainty = reading.verdict === 'unclear'
    ? reading.ci95 ? ' The interval includes 0, so the difference may be chance.' : ' This capture carries no interval for it, so the difference may be chance.'
    : ` The whole interval is ${reading.verdict === 'better' ? 'above' : 'below'} 0.`;
  return {
    verdict: reading.verdict,
    lead: SKILL_LEADS[reading.verdict],
    text: `${tally} ${errors} On a scale where ${SKILL_SCALE}, that is a skill score of ${formatSkill(reading.bss)}${skillIntervalPhrase(reading)}.${certainty} ${sample}`,
  };
}

function verdictSection(scorecard, escapeHtml) {
  const skill = skillVerdict(scorecard);
  const paragraphs = [
    escapeHtml(ledgerVerdictSentences(scorecard.totals, scorecard.rollingWindowDays)),
    bandOutcomes(scorecard.calibration).map((outcome) => bandSentence(outcome, escapeHtml)).join(' '),
    escapeHtml(marketVerdictSentence(scorecard.vsMarketSkill)),
    escapeHtml(pooledVerdictSentences(scorecard)),
  ];
  return `      <section data-accuracy-verdict aria-label="Plain-language verdict">
        <h2>In plain terms</h2>
        <p data-accuracy-skill="${escapeHtml(skill.verdict)}"><strong>${escapeHtml(skill.lead)}</strong> ${escapeHtml(skill.text)}</p>
${paragraphs.map((paragraph) => `        <p>${paragraph}</p>`).join('\n')}
      </section>
      <dl data-accuracy-definitions>
        <dt>Brier score</dt>
        <dd>${escapeHtml('The error figure used above: the average squared gap between the chance World Monitor gave and what happened. 0 is perfect and lower is better. Answering even odds to everything scores 0.25, a coin flip.')}</dd>
        <dt>Actual rate</dt>
        <dd>${escapeHtml('How often a set of forecasts came true in the period scored, whatever the question. It is known only afterwards, so always forecasting it is a hindsight benchmark: it uses the right overall rate and nothing about any single question. Its Brier score is the rate times one minus the rate. Beating it is the first test of skill.')}</dd>
        <dt>Skill score</dt>
        <dd>${escapeHtml(`One minus World Monitor's Brier score divided by the actual-rate Brier score, over the same forecasts: ${SKILL_SCALE}. Its 95% interval resamples whole forecast families.`)}</dd>
        <dt>Forecast family</dt>
        <dd>${escapeHtml('One forecast question that World Monitor issues again over time, such as the same threshold for the same country. Its forecasts share a question and an outcome, so a family counts once when deciding whether a sample is large enough. A family is one forecast id, which only approximates independence: the same question is sometimes issued under more than one id.')}</dd>
      </dl>`;
}

function limitsSection(omittedBuckets, escapeHtml) {
  const bucketSentence = omittedBuckets.length > 0
    ? `Calibration buckets that scored nothing are omitted from the table rather than drawn as a zero: ${omittedBuckets.join(', ')} are empty in this window.`
    : 'Every calibration bucket scored at least one forecast in this window, so none is omitted.';
  return `      <h2>What this page does not publish</h2>
      <ul>
        <li>${escapeHtml(bucketSentence)}</li>
        <li>No confidence intervals on the log scores or the per-domain skill scores, so the domain table does not say which domains beat their actual rate. An interval on a mean score needs every forecast's own score, which the public scorecard does not carry, and this page will not invent one from the averages. The Brier scores and the headline skill score carry a 95% interval when the scorecard includes one, computed by the scoring service by resampling whole forecast families. Void rates and calibration-bucket rates do carry a 95% Wilson interval, because a rate's interval needs only the two counts printed beside it; the scored share of the ledger and the base rates in the summary do not carry one yet. Tracking: <a href="${escapeHtml(CONFIDENCE_INTERVAL_ISSUE)}">issue #7072</a>.</li>
        <li>No 24-hour, 7-day or 30-day projections, and no accuracy for them. World Monitor no longer publishes those projections, as of 2026-10-07. It still grades some of those horizons internally, and removing the projections changed none of the scores on this page. Those horizon grades are not published yet. Tracking: <a href="${escapeHtml(HORIZON_SCORING_ISSUE)}">issue #9057</a>.</li>
        <li>Individual forecasts appear only as the receipts for the most recently resolved ones. The judges' reasoning, the full news archive they read and internal data locations are not published.</li>
      </ul>`;
}

function relatedSection(baseUrl, tpl) {
  const { escapeHtml, absoluteUrl } = tpl;
  return `      <a class="cta" href="${escapeHtml(absoluteUrl(baseUrl, '/dashboard'))}">Open the live forecast panel in World Monitor →</a>
      <h2>Related reference</h2>
      <ul class="related">
        <li><a href="/blog/posts/ai-forecast-accuracy-brier-scorecard-worldmonitor/">Why we publish the ledger</a></li>
        <li><a href="/country-instability-index/">Country Instability Index</a></li>
        <li><a href="/countries/">Country Resilience Index</a></li>
        <li><a href="/crises/">Crisis trackers</a></li>
        <li><a href="/docs/methodology/cii-risk-scores">CII methodology</a></li>
      </ul>`;
}

function provenanceLine(state, dataset, snapshotPath, escapeHtml, audited = false) {
  const generated = state.scorecard ? escapeHtml(formatUtcDateTime(state.generatedAt)) : '';
  const read = escapeHtml(state.capturedAt || 'an unrecorded date');
  const dated = !state.scorecard
    ? ''
    : audited
      ? ` The raw figures in the download were generated ${generated} and read on ${read}, and are under audit.`
      : ` Numbers generated ${generated} and read on ${read}.`;
  return `      <p class="source" data-snapshot-source="${escapeHtml(snapshotPath)}">Download: <a href="${escapeHtml(dataset.href)}">${escapeHtml(dataset.filename)}</a>. Source: World Monitor forecast scorecard snapshot.${dated} Live results come from the credentialed forecast scorecard endpoint, which this page freezes so it can be read without one.</p>`;
}

function auditSection(audit, escapeHtml) {
  return `      <section id="under-audit" class="card" role="note" data-accuracy-audit="${escapeHtml(audit.since)}" aria-label="Accuracy under audit">
        <p><strong>${escapeHtml(auditSinceSentence(audit))}</strong> ${escapeHtml(auditNoticeBody(audit, 'here'))}</p>
        <p>The findings and the fixes are tracked in <a href="${escapeHtml(auditIssueUrl(audit))}">issue #${escapeHtml(String(audit.issue))}</a>. The download below keeps the raw figures and marks them as under audit.</p>
      </section>`;
}

// While the audit switch is set, nothing on the page presents a score as a
// verdict: no headline, no intervals, no calibration, domain, origin or market
// comparison, and no ledger or funnel counts built from the same windows.
function auditedBody({ state, baseUrl, tpl, dataset, snapshotPath, heading, audit }) {
  const { escapeHtml } = tpl;
  const lede = '      <p class="lede">World Monitor logs every forecast it publishes and aims to score each one once its outcome is known. While the audit below is open, this page publishes no scores.</p>';
  if (!state.scorecard) {
    return `${heading}
${lede}
${auditSection(audit, escapeHtml)}
${relatedSection(baseUrl, tpl)}
${provenanceLine(state, dataset, snapshotPath, escapeHtml, true)}`;
  }
  const { scorecard } = state;
  return `${heading}
${lede}
${auditSection(audit, escapeHtml)}
      <h2>Methodology</h2>
      <p>This is the scoring method as documented. The audit found places where the scoring did not follow it.</p>
      <p>${escapeHtml(scorecard.methodology)}</p>
${receiptsSection(scorecard, escapeHtml, true)}
${marketAlertsSection(scorecard.marketAlerts, escapeHtml, true)}
${relatedSection(baseUrl, tpl)}
${provenanceLine(state, dataset, snapshotPath, escapeHtml, true)}`;
}

function accuracyBody({ state, baseUrl, tpl, dataset, snapshotPath, audit }) {
  const { escapeHtml } = tpl;
  const heading = `      <p class="eyebrow">Forecast accuracy</p>
      <h1>Forecast accuracy scorecard</h1>`;
  if (audit) return auditedBody({ state, baseUrl, tpl, dataset, snapshotPath, heading, audit });

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
  const intervals = proportionIntervals(scorecard);
  const brierIntervals = shownBrierIntervals(state);

  return `${heading}
      <p class="lede">World Monitor scores every forecast it publishes once the outcome is knowable, over a rolling ${escapeHtml(formatCount(scorecard.rollingWindowDays))}-day window. This is the standing record: the scores, the calibration, the sample sizes, and the parts that are not measurable yet.</p>
${verdictSection(scorecard, escapeHtml)}
${recordStatus(state, escapeHtml)}
${state.coverage === 'insufficient' ? '' : `${headlineTiles(scorecard, brierIntervals, escapeHtml)}\n${headlineResultParagraph(scorecard, brierIntervals.skill, escapeHtml)}`}      <p><strong>Lower Brier is better.</strong> A Brier score is the mean squared error of a probability forecast, so 0 is perfect and answering 0.5 to everything scores 0.25. Log score is harsher on confident mistakes, and lower is better there too.</p>
${cohortSection(scorecard.skill, unknownOriginSentence(scorecard), escapeHtml)}
      <h2>Resolution ledger</h2>
${totalsTable(scorecard.totals, intervals, escapeHtml)}
      <p>${escapeHtml(scorecard.methodology)}</p>
${funnelSection(scorecard.funnel, escapeHtml)}
${receiptsSection(scorecard, escapeHtml)}
      <h2>Calibration</h2>
${calibrationTable(scorecard, intervals, escapeHtml)}
      <h2 id="by-domain">Accuracy by domain</h2>
${domainSection(scorecard, escapeHtml)}
      <h2>Accuracy by generation origin</h2>
${originTable(scorecard.byGenerationOrigin, scorecard.skill, unknownOriginStatus(scorecard), intervals, escapeHtml)}
${marketSection(scorecard.vsMarketSkill, escapeHtml)}
${marketAlertsSection(scorecard.marketAlerts, escapeHtml)}
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

function accuracyDatasetLd({ baseUrl, tpl, state, dataset, audit }) {
  const { absoluteUrl } = tpl;
  const canonical = absoluteUrl(baseUrl, ACCURACY_PAGE_PATH);
  return {
    '@context': SCHEMA_ORG_CONTEXT_URL,
    '@type': 'Dataset',
    '@id': `${canonical}#dataset`,
    name: 'World Monitor forecast resolution scorecard',
    description: audit
      ? `${accuracyAuditNotice(audit, 'in this dataset')} Findings: ${auditIssueUrl(audit)}. The download keeps the raw scorecard fields as captured, flagged underAudit; they are not reliable while the audit is open.`
      : 'Aggregate accuracy of World Monitor forecasts over a rolling window: skill against always forecasting how often the forecast events actually happened, Brier and log scores for the headline cohort and for every scored entry, calibration buckets with their sample sizes, per-domain and per-origin breakdowns, void rates, a head-to-head against liquid prediction markets, and receipts for the most recently resolved forecasts. Frozen from the credentialed forecast scorecard API into a committed snapshot, so the published figures and the machine-readable distribution always agree.',
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
      'Brier skill score against the actual rate',
      'Brier score',
      'Logarithmic score',
      'Calibration bucket realized rate',
      'Void rate',
      'Scored forecast count',
    ],
    measurementTechnique: 'Brier and logarithmic scoring of resolved binary forecast windows, with skill measured against always forecasting the rate at which the same forecasts came true',
    ...(state.capturedAt ? { temporalCoverage: state.capturedAt } : {}),
    distribution: [dataset.download],
  };
}

export function renderAccuracyPage({ baseUrl, tpl, state, lastmod, dataset, dataCatalog, snapshotPath, audit = FORECAST_ACCURACY_AUDIT }) {
  const { breadcrumbLd, absoluteUrl, pageDocument } = tpl;
  const description = audit ? AUDIT_META_DESCRIPTION : META_DESCRIPTION;
  assertMetaDescription(description);
  const canonical = absoluteUrl(baseUrl, ACCURACY_PAGE_PATH);
  return pageDocument({
    baseUrl,
    path: ACCURACY_PAGE_PATH,
    title: 'Forecast Accuracy Scorecard | World Monitor',
    description,
    lastmod,
    ogType: 'article',
    jsonLd: [
      {
        '@context': SCHEMA_ORG_CONTEXT_URL,
        '@type': 'WebPage',
        name: 'Forecast accuracy scorecard',
        description,
        url: canonical,
        inLanguage: 'en-US',
        dateModified: lastmod,
        publisher: { ...WORLD_MONITOR_ORG },
      },
      accuracyDatasetLd({ baseUrl, tpl, state, dataset, audit }),
      dataCatalog,
    ].filter(Boolean),
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Forecast accuracy', path: ACCURACY_PAGE_PATH },
    ]),
    body: accuracyBody({ state, baseUrl, tpl, dataset, snapshotPath, audit }),
  });
}

// Skill against the actual rate (#8990), derived from the captured counts
// with the producer's formula, beside the minimums its verdict needs.
function skillDownload(scorecard) {
  if (!scorecard) return null;
  const reading = baseRateSkill(scorecard);
  return {
    definition: 'skillScore = 1 - brier / actualRateBrier over the same forecasts, where actualRateBrier = p(1-p) and p is the share that came true in the window. 0 is the same error as always forecasting p, 1 is perfect, below 0 is a larger error. verdict is better or worse only when the family-bootstrap ci95 lies wholly above or below 0.',
    minimums: { families: SKILL_MIN_FAMILIES, yesFamilies: SKILL_MIN_OUTCOME_FAMILIES, noFamilies: SKILL_MIN_OUTCOME_FAMILIES },
    perDomainInterval: 'not carried: the public API has no room for it under its size cap. Domain intervals, family counts and effective n are in the MCP get_forecast_scorecard result.',
    headline: reading
      ? {
        scored: reading.count,
        yesCount: reading.yesCount,
        actualRate: reading.rate,
        actualRateBrier: reading.referenceBrier,
        brier: reading.brier,
        skillScore: reading.bss,
        ci95: reading.ci95,
        measurable: reading.measurable,
        verdict: reading.verdict,
      }
      : null,
    byDomain: (Array.isArray(scorecard.publishedByDomain) ? scorecard.publishedByDomain : []).flatMap((row) => {
      const reading = domainSkill(row);
      return reading
        ? [{ domain: row.domain, scored: row.count, brier: reading.brier, actualRateBrier: reading.referenceBrier, skillScore: reading.bss }]
        : [];
    }),
  };
}

// A capture taken before the API applied the median floor can still carry a
// median the page withholds; the download must not publish it either.
function withPublishedMarketAlertMedians(scorecard) {
  const marketAlerts = scorecard?.marketAlerts;
  if (!isPlainObject(marketAlerts) || !Array.isArray(marketAlerts.byType)) return scorecard;
  return {
    ...scorecard,
    marketAlerts: {
      ...marketAlerts,
      byType: marketAlerts.byType.map((row) => {
        if (!isPlainObject(row) || !('medianLeadTimeMs' in row) || marketAlertMedianPublished(row)) return row;
        const { medianLeadTimeMs: _withheld, ...rest } = row;
        return rest;
      }),
    },
  };
}

export function accuracyDatasetDownload({ state, snapshotPath, audit = FORECAST_ACCURACY_AUDIT }) {
  const skill = isPlainObject(state.scorecard?.skill) ? state.scorecard.skill : null;
  const payload = {
    dataset: DATASET_IDENTIFIER,
    underAudit: audit ? { since: audit.since, reason: audit.reason, issue: audit.issue } : null,
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
        definition: `every scored entry except those whose generationOrigin is listed in excludedOrigins; an absent origin is filed as unknown${UNKNOWN_ORIGIN_DEFINITIONS[unknownOriginStatus(state.scorecard)]}`,
      }
      : null,
    // calibrationBuckets, summarizeMarketSkill and summarizeScored all run over
    // the full scored set, so a consumer must not read them as the cohort above.
    pooledPopulations: {
      calibration: POOLED_POPULATION,
      vsMarketSkill: POOLED_POPULATION,
      overall: POOLED_POPULATION,
    },
    confidenceIntervals: {
      proportions: { published: true, method: 'wilson-95' },
      meanScores: {
        brier: {
          published: Object.values(shownBrierIntervals(state)).some(Boolean),
          method: state.scorecard?.uncertainty?.method ?? null,
        },
        logScore: { published: false, trackedIn: CONFIDENCE_INTERVAL_ISSUE },
        skillScore: {
          published: Boolean(state.coverage !== 'insufficient' && baseRateSkill(state.scorecard)?.ci95),
          method: state.scorecard?.uncertainty?.method ?? null,
          perDomain: false,
        },
      },
    },
    intervals: proportionIntervals(state.scorecard),
    skillVsActualRate: skillDownload(state.scorecard),
    // Point-in-time horizons are graded internally (#8939); neither the
    // projection values (#8967) nor those grades are published here.
    horizonProjections: { valuesPublished: false, gradesPublished: false, trackedIn: HORIZON_SCORING_ISSUE },
    scorecard: withPublishedMarketAlertMedians(state.scorecard),
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
  audit = FORECAST_ACCURACY_AUDIT,
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
    renderAccuracyPage({ baseUrl, tpl, state, lastmod, dataset, dataCatalog, snapshotPath, audit }),
  );
  const downloadPath = join(outDir, dataset.file);
  mkdirSync(dirname(downloadPath), { recursive: true });
  writeFileSync(downloadPath, accuracyDatasetDownload({ state, snapshotPath, audit }));
  return { state };
}
