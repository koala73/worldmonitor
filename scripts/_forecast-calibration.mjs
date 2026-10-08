// Empirical recalibration of published-origin forecast probabilities (#7070).
//
// A CalibrationMap is data: per-domain monotone knots fitted by
// pool-adjacent-violators over individual resolved YES/NO published-origin
// ledger entries. `applyCalibration` is the only interpretation of that data.
// `decideCalibrationPublication` runs the same rule on every seeder run: the
// seeder publishes calibrated probabilities only while the activation gate is
// eligible for the current map and the kill switch is off.
//
// No wall-clock reads: every time is injected.

import {
  DEFAULT_ROLLING_WINDOW_DAYS,
  DEFAULT_SKILL_EXCLUDED_ORIGINS,
  evaluateActivationGate,
  generationOriginOf,
  hasPreLineageAnchor,
  isDuplicateWindow,
  isHorizonEntry,
  isPublishedOriginEntry,
  isScoredEntry,
  isWithheldEntry,
  summarizeCalibrationShadow,
} from './_forecast-scorecard.mjs';

/**
 * @typedef {{ x: number, y: number }} CalibrationKnot
 * @typedef {'identity' | 'isotonic'} CalibrationMode
 * @typedef {'insufficient_families' | 'insufficient_yes_families' | 'insufficient_no_families'} IneligibleReason
 * @typedef {{
 *   families: number,
 *   yesFamilies: number,
 *   noFamilies: number,
 *   eligible: boolean,
 *   ineligibleReason?: IneligibleReason,
 * }} DomainEligibility
 * @typedef {DomainEligibility & {
 *   n: number,
 *   positives: number,
 *   mode: CalibrationMode,
 *   knots: CalibrationKnot[],
 *   inputs?: Record<string, string>,
 *   carriedFrom?: string,
 * }} CalibrationDomain
 * @typedef {'absent' | 'invalid' | 'code_version_changed' | 'fit_input_withdrawn' | 'fit_invalidated' | 'domain_became_eligible' | 'family_growth' | 'fit_aged_out'} RefitReason
 * @typedef {{
 *   schemaVersion: number,
 *   version: string,
 *   codeVersion: string,
 *   dataVersion: number,
 *   refitReason: RefitReason,
 *   fittedAt: number,
 *   fitWindow: { from: number | null, to: number },
 *   cohortFilter: { excludedOrigins: string[], outcomes: string[], rollingWindowDays: number, emissionField: string },
 *   sourceStage: string,
 *   minFamilies: number,
 *   minOutcomeFamilies: number,
 *   probabilityBounds: { floor: number, ceiling: number },
 *   totalSample: number,
 *   domains: Record<string, CalibrationDomain>,
 * }} CalibrationMap
 */

export const CALIBRATION_MAP_SCHEMA_VERSION = 1;
// A change to the fitting rule bumps this; a persisted map with another code
// version is refitted on the next resolver run. Data refits bump the map's
// dataVersion instead (resolveCalibrationMapForRun).
// v2 refit without the rows voided under #5233. v3 counts families, not rows:
// v2 kept every domain identity on 25 rows, and v1 fit cyber to a constant
// 0.01 from 148 all-NO rows that came from 17 families.
export const CALIBRATION_CODE_VERSION = 'forecast-calibration-pav-v3';
export const CALIBRATION_SOURCE_STAGE = 'marketBlendedProbability';
// Fit eligibility counts families (forecast ids), because windows of one id
// share a generator, a region and much of an outcome history. A domain fits
// only with at least CALIBRATION_MIN_OUTCOME_FAMILIES families that resolved
// YES and as many that resolved NO; one-sided data has no curve to fit. With
// published-origin probabilities resampled from the live ledger, PAV lost to
// identity on expected out-of-sample Brier below 12 minority-class families
// in every miscalibration simulated (calibrated, over- and underconfident,
// biased); at 12 it first wins, for a biased forecaster. The family floor
// keeps the per-domain sample the row floor used to require (30) and makes
// it independent.
export const CALIBRATION_MIN_FAMILIES = 30;
export const CALIBRATION_MIN_OUTCOME_FAMILIES = 12;
// A fitted domain keeps its fit until its families fall below half of each
// minimum. Without the band, a domain at the floor flips between fitted and
// identity as one family ages out and the next resolves, and each refit
// empties the forward cohort the activation gate needs. The band is a pure
// function of the ledger, unlike a count of consecutive ineligible runs,
// which would have to be stored and could drift from the data.
export const CALIBRATION_RETAIN_FRACTION = 0.5;
// A fitted domain refits when the families first resolved since its fit
// bring its evidence to this multiple of the families it was fitted on. Each refit
// empties the forward cohort, and the PAV standard error falls with the
// square root of the sample, so a refit waits until the error can fall by
// about 30%. New evidence is counted since fittedAt, not as the rolling-window
// total, which plateaus at the arrival rate times the window.
export const CALIBRATION_REFIT_FAMILY_GROWTH = 2;
// A passing activation gate holds every trigger except a withdrawn input, with
// no time limit. The gate scores only forward outcomes resolved inside the
// scorecard's rolling window, so a map stays held only while recent evidence
// still validates it.
// A domain with no YES outcomes fits to 0. Publishing 0% is a claim of
// impossibility the sample cannot support, so knots are bounded.
export const CALIBRATION_PROBABILITY_FLOOR = 0.01;
export const CALIBRATION_PROBABILITY_CEILING = 0.99;

const DAY_MS = 24 * 60 * 60 * 1000;

export class CalibrationCohortOverlapError extends Error {
  constructor(overlapping, fitWindowTo) {
    super(`${overlapping} evaluation entr${overlapping === 1 ? 'y was' : 'ies were'} emitted at or before the fit window end (${fitWindowTo}); refusing in-sample evaluation`);
    this.name = 'CalibrationCohortOverlapError';
    this.overlapping = overlapping;
    this.fitWindowTo = fitWindowTo;
  }
}

export function emissionTime(entry) {
  const generatedAt = Number(entry?.generatedAt);
  if (Number.isFinite(generatedAt)) return generatedAt;
  const firstSeenAt = Number(entry?.firstSeenAt);
  return Number.isFinite(firstSeenAt) ? firstSeenAt : NaN;
}

// The post-blend value before any published calibration: the stage the map
// is fitted on and applied to. A calibrated publication keeps it as
// `uncalibratedProbability`; otherwise #7071 lineage names it when an anchor
// applied, and the stored `probability` is it.
export function sourceProbability(entry) {
  const value = [entry?.uncalibratedProbability, entry?.calibration?.marketBlendedProbability, entry?.probability]
    .find((candidate) => typeof candidate === 'number' && Number.isFinite(candidate));
  return value === undefined ? NaN : Math.max(0, Math.min(1, value));
}

function domainOf(entry) {
  return entry?.domain || 'unknown';
}

function ledgerEntries(ledger) {
  if (!ledger) return [];
  if (Array.isArray(ledger)) return ledger.filter((entry) => entry && !isHorizonEntry(entry));
  if (ledger.data && typeof ledger.data === 'object') return ledgerEntries(ledger.data);
  if (typeof ledger === 'object') return Object.values(ledger).filter((entry) => entry && !isHorizonEntry(entry));
  return [];
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Scored published-origin entries resolved inside the rolling window ending at nowMs.
 * The scorecard's own predicates decide membership, so the fit never sees a
 * row the scorecard excludes: VOIDs (late reads and old-selection verdicts
 * among them), duplicates, withheld buckets and pre-lineage anchors.
 * A row rescored to its first-seen probability (#8990) lost the raw value
 * that came with that probability, so it has no fit input.
 */
export function selectFitCohort(ledger, nowMs, options = {}) {
  const rollingWindowDays = options.rollingWindowDays ?? DEFAULT_ROLLING_WINDOW_DAYS;
  const minResolvedAt = nowMs - rollingWindowDays * DAY_MS;
  return ledgerEntries(ledger).filter((entry) => {
    if (!isFitInput(entry)) return false;
    const resolvedAt = Number(entry.resolvedAt);
    const emittedAt = emissionTime(entry);
    return Number.isFinite(resolvedAt) && resolvedAt >= minResolvedAt && resolvedAt <= nowMs
      && Number.isFinite(emittedAt) && emittedAt <= nowMs;
  });
}

function isFitInput(entry) {
  if (!isScoredEntry(entry) || isWithheldEntry(entry) || isDuplicateWindow(entry)) return false;
  if (!isPublishedOriginEntry(entry) || hasPreLineageAnchor(entry) || entry.rescore) return false;
  return Number.isFinite(sourceProbability(entry));
}

/**
 * Weighted pool-adjacent-violators over (x, y) points. Returns monotone
 * non-decreasing knots: each pooled block contributes its x-extent at the
 * block mean, so interpolation is flat inside a block and linear between
 * blocks.
 */
export function isotonicKnots(points, bounds = {}) {
  const floor = bounds.floor ?? CALIBRATION_PROBABILITY_FLOOR;
  const ceiling = bounds.ceiling ?? CALIBRATION_PROBABILITY_CEILING;
  const byX = new Map();
  for (const { x, y } of points) {
    const cell = byX.get(x) ?? { x, sum: 0, weight: 0 };
    cell.sum += y;
    cell.weight += 1;
    byX.set(x, cell);
  }
  const blocks = [];
  for (const cell of [...byX.values()].sort((a, b) => a.x - b.x)) {
    blocks.push({ xMin: cell.x, xMax: cell.x, sum: cell.sum, weight: cell.weight });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.weight <= last.sum / last.weight) break;
      blocks.splice(-2, 2, { xMin: prev.xMin, xMax: last.xMax, sum: prev.sum + last.sum, weight: prev.weight + last.weight });
    }
  }
  const knots = [];
  for (const block of blocks) {
    const y = round6(Math.min(ceiling, Math.max(floor, block.sum / block.weight)));
    knots.push({ x: round6(block.xMin), y });
    if (block.xMax > block.xMin) knots.push({ x: round6(block.xMax), y });
  }
  return knots.filter((knot, i) => !(i > 0 && i < knots.length - 1 && knots[i - 1].y === knot.y && knots[i + 1].y === knot.y));
}

function eligibilityMinimums(options) {
  return {
    minFamilies: options.minFamilies ?? CALIBRATION_MIN_FAMILIES,
    minOutcomeFamilies: options.minOutcomeFamilies ?? CALIBRATION_MIN_OUTCOME_FAMILIES,
  };
}

function cohortByDomain(cohort) {
  const byDomain = new Map();
  for (const entry of cohort) {
    const domain = domainOf(entry);
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(entry);
  }
  return byDomain;
}

/**
 * A family is one forecast id. A family whose windows resolved both ways
 * counts on both sides.
 * @returns {DomainEligibility}
 */
function domainEligibility(entries, { minFamilies, minOutcomeFamilies }) {
  const families = new Map();
  for (const entry of entries) {
    const outcomes = families.get(entry.id) ?? new Set();
    outcomes.add(entry.outcome);
    families.set(entry.id, outcomes);
  }
  const counts = {
    families: families.size,
    yesFamilies: [...families.values()].filter((outcomes) => outcomes.has('YES')).length,
    noFamilies: [...families.values()].filter((outcomes) => outcomes.has('NO')).length,
  };
  const ineligibleReason = counts.families < minFamilies ? 'insufficient_families'
    : counts.yesFamilies < minOutcomeFamilies ? 'insufficient_yes_families'
      : counts.noFamilies < minOutcomeFamilies ? 'insufficient_no_families'
        : null;
  return ineligibleReason ? { ...counts, eligible: false, ineligibleReason } : { ...counts, eligible: true };
}

/**
 * Per-domain fit eligibility of the cohort the next fit at nowMs would read.
 * @returns {Record<string, DomainEligibility>}
 */
export function evaluateFitEligibility(ledger, nowMs, options = {}) {
  const minimums = eligibilityMinimums(options);
  const byDomain = cohortByDomain(selectFitCohort(ledger, nowMs, options));
  return Object.fromEntries([...byDomain.keys()].sort().map((domain) => [domain, domainEligibility(byDomain.get(domain), minimums)]));
}

/** @returns {CalibrationMap} */
export function fitCalibrationMap(ledger, nowMs, options = {}) {
  if (!Number.isFinite(nowMs)) throw new TypeError('fitCalibrationMap requires an injected nowMs');
  const rollingWindowDays = options.rollingWindowDays ?? DEFAULT_ROLLING_WINDOW_DAYS;
  const minimums = eligibilityMinimums(options);
  const codeVersion = options.codeVersion ?? CALIBRATION_CODE_VERSION;
  const bounds = { floor: CALIBRATION_PROBABILITY_FLOOR, ceiling: CALIBRATION_PROBABILITY_CEILING };
  const cohort = selectFitCohort(ledger, nowMs, { rollingWindowDays });
  const byDomain = cohortByDomain(cohort);

  const domains = {};
  for (const domain of [...byDomain.keys()].sort()) {
    const entries = byDomain.get(domain);
    const points = entries.map((entry) => ({ x: sourceProbability(entry), y: entry.outcome === 'YES' ? 1 : 0 }));
    const eligibility = domainEligibility(entries, minimums);
    const base = { n: points.length, positives: points.reduce((sum, point) => sum + point.y, 0), ...eligibility };
    // A fitted domain keeps its input rows, so a later correction to any of
    // them is visible (refitTrigger).
    const carried = options.carry?.[domain];
    domains[domain] = eligibility.eligible
      ? { ...base, mode: 'isotonic', knots: isotonicKnots(points, bounds), inputs: Object.fromEntries(entries.map((entry) => [entry.key, inputFingerprint(entry)])) }
      : carried ?? { ...base, mode: 'identity', knots: [] };
  }

  const emissions = cohort.map(emissionTime);
  return {
    schemaVersion: CALIBRATION_MAP_SCHEMA_VERSION,
    version: `${codeVersion}@${nowMs}`,
    codeVersion,
    dataVersion: options.dataVersion ?? 1,
    refitReason: options.refitReason ?? 'absent',
    fittedAt: nowMs,
    // Emission-time span the fit could have seen. Its end is fittedAt: an
    // entry emitted before the fit but unresolved then is still not forward.
    fitWindow: { from: emissions.length ? Math.min(...emissions) : null, to: nowMs },
    cohortFilter: {
      excludedOrigins: [...DEFAULT_SKILL_EXCLUDED_ORIGINS],
      outcomes: ['YES', 'NO'],
      rollingWindowDays,
      emissionField: 'generatedAt',
    },
    sourceStage: CALIBRATION_SOURCE_STAGE,
    ...minimums,
    probabilityBounds: bounds,
    totalSample: cohort.length,
    domains,
  };
}

function interpolate(knots, p) {
  if (p <= knots[0].x) return knots[0].y;
  const last = knots[knots.length - 1];
  if (p >= last.x) return last.y;
  for (let i = 1; i < knots.length; i += 1) {
    const right = knots[i];
    if (p <= right.x) {
      const left = knots[i - 1];
      if (right.x === left.x) return right.y;
      return left.y + ((p - left.x) / (right.x - left.x)) * (right.y - left.y);
    }
  }
  return last.y;
}

/** Pure: identity for a missing map, unknown domain, or identity domain. */
export function applyCalibration(map, domain, p) {
  const value = Number(p);
  if (!Number.isFinite(value)) return NaN;
  const clamped = Math.max(0, Math.min(1, value));
  const fit = map?.domains?.[domain];
  if (!fit || fit.mode !== 'isotonic' || !Array.isArray(fit.knots) || !fit.knots.length) return clamped;
  return interpolate(fit.knots, clamped);
}

export function knotsAreMonotone(knots) {
  if (!Array.isArray(knots)) return false;
  for (let i = 0; i < knots.length; i += 1) {
    const { x, y } = knots[i] ?? {};
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return false;
    if (i > 0 && (x < knots[i - 1].x || y < knots[i - 1].y)) return false;
  }
  return true;
}

/** Boundary parse for a map read back from Redis. Returns null when unusable. */
export function parseCalibrationMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion !== CALIBRATION_MAP_SCHEMA_VERSION) return null;
  if (typeof value.version !== 'string' || typeof value.codeVersion !== 'string') return null;
  if (value.codeVersion === CALIBRATION_CODE_VERSION && !Number.isInteger(value.dataVersion)) return null;
  if (!Number.isFinite(value.fittedAt) || !Number.isFinite(value.fitWindow?.to)) return null;
  if (!value.domains || typeof value.domains !== 'object') return null;
  for (const fit of Object.values(value.domains)) {
    if (fit?.mode !== 'identity' && fit?.mode !== 'isotonic') return null;
    if (fit.mode === 'isotonic' && (!fit.knots?.length || !knotsAreMonotone(fit.knots))) return null;
    if (fit.mode === 'isotonic' && value.codeVersion === CALIBRATION_CODE_VERSION && (!fit.inputs || typeof fit.inputs !== 'object')) return null;
  }
  return value;
}

// What the fit read from a row. Any later change to it is a correction.
function inputFingerprint(entry) {
  return `${entry.outcome}|${sourceProbability(entry)}|${domainOf(entry)}`;
}

/**
 * A fitted domain's input that the ledger still holds but the fit would now
 * refuse or read differently: a void, duplicate, rescore, withheld bucket,
 * re-grade, or a changed probability or domain written after the fit. An
 * input pruned from the ledger is absent, not withdrawn, and the rolling
 * window is not consulted, so ageing out is not a correction.
 */
function hasWithdrawnInput(fit, entriesByKey) {
  return Object.entries(fit.inputs).some(([key, fingerprint]) => {
    const entry = entriesByKey.get(key);
    return entry !== undefined && (!isFitInput(entry) || inputFingerprint(entry) !== fingerprint);
  });
}

function retainsFit(eligibility, { minFamilies, minOutcomeFamilies }) {
  const floor = (minimum) => Math.ceil(minimum * CALIBRATION_RETAIN_FRACTION);
  return Boolean(eligibility)
    && eligibility.families >= floor(minFamilies)
    && eligibility.yesFamilies >= floor(minOutcomeFamilies)
    && eligibility.noFamilies >= floor(minOutcomeFamilies);
}

/**
 * Every reason the current ledger gives to refit `map`, in rule order. Rules, in
 * order: a fitted domain one of whose inputs was corrected; a fitted domain
 * below half the minimums; an identity domain that became eligible; a fitted
 * domain whose families since the fit match its fitted families; and a fitted
 * domain none of whose inputs is left in the window.
 * @returns {{ triggers: { reason: RefitReason, domain: string }[], carry: Record<string, CalibrationDomain> }}
 */
function refitTrigger(map, ledger, nowMs, options) {
  const minimums = eligibilityMinimums(options);
  const cohort = cohortByDomain(selectFitCohort(ledger, nowMs, options));
  const entriesByKey = new Map(ledgerEntries(ledger).map((entry) => [entry.key, entry]));
  const eligibility = (domain) => (cohort.has(domain) ? domainEligibility(cohort.get(domain), minimums) : null);
  const fitted = (domain) => map.domains[domain]?.mode === 'isotonic';
  const rows = (domain) => cohort.get(domain) ?? [];
  // A ledger key is `<id>@<deadline>`, optionally with a `~<hash>` suffix, so a
  // pruned input still names its family.
  const fittedFamilies = (domain) => new Set(Object.keys(map.domains[domain].inputs)
    .map((key) => entriesByKey.get(key)?.id ?? key.slice(0, key.lastIndexOf('@'))));
  // A new window of a fitted family is not a new family.
  const familiesSinceFit = (domain) => {
    const known = fittedFamilies(domain);
    return new Set(rows(domain)
      .filter((entry) => Number(entry.resolvedAt) > map.fittedAt && !known.has(entry.id))
      .map((entry) => entry.id)).size;
  };
  const inputsInWindow = (domain) => rows(domain).some((entry) => Object.hasOwn(map.domains[domain].inputs, entry.key));
  const withdrawn = (domain) => hasWithdrawnInput(map.domains[domain], entriesByKey);
  const rules = [
    ['fit_input_withdrawn', (domain) => fitted(domain) && withdrawn(domain)],
    ['fit_invalidated', (domain) => fitted(domain) && !retainsFit(eligibility(domain), minimums)],
    ['domain_became_eligible', (domain) => !fitted(domain) && eligibility(domain)?.eligible],
    // An ineligible fitted domain would only be carried unchanged.
    ['family_growth', (domain) => fitted(domain) && eligibility(domain)?.eligible
      && map.domains[domain].families + familiesSinceFit(domain) >= CALIBRATION_REFIT_FAMILY_GROWTH * map.domains[domain].families],
    ['fit_aged_out', (domain) => fitted(domain) && !inputsInWindow(domain)],
  ];
  const domains = [...new Set([...Object.keys(map.domains), ...cohort.keys()])].sort();
  // A fit inside the retain band that gives no trigger of its own survives a
  // refit another domain caused; a fresh fit would drop it to identity.
  const carry = Object.fromEntries(domains
    .filter((domain) => fitted(domain) && !eligibility(domain)?.eligible && retainsFit(eligibility(domain), minimums)
      && !withdrawn(domain) && inputsInWindow(domain))
    .map((domain) => [domain, { ...map.domains[domain], carriedFrom: map.domains[domain].carriedFrom ?? map.version }]));
  const triggers = rules.flatMap(([reason, applies]) => domains.filter(applies).map((domain) => ({ reason, domain })));
  return { triggers, carry };
}

// Triggers that ask for a better fit, not a correction. Before the gate has
// the forward sample to judge the stored map, such a refit would empty that
// sample again, and a domain whose families emit one or two windows each
// would never reach a verdict.
const WAITS_FOR_GATE_SAMPLE = new Set(['family_growth', 'domain_became_eligible']);
// Below the sample minimums the bootstrap interval is wide, so "not yet shown
// non-inferior" is the usual state of a map that helps, not evidence against it.
const UNDECIDED_GATE_REASONS = ['insufficient_forward_', 'overall_not_non_inferior', 'domain_not_non_inferior:'];

// Raw is better beyond the gate's margin even at the low end of the interval.
function inferiorityShown(shadow) {
  const { activationGate: gate, forward } = shadow;
  const margin = gate.thresholds.nonInferiorityMargin;
  const activated = new Set(gate.domains.map((row) => row.domain));
  const deltas = [forward.brierDelta, ...forward.byDomain.filter((row) => activated.has(row.domain)).map((row) => row.brierDelta)];
  return deltas.some((delta) => Array.isArray(delta?.ci95) && delta.ci95[0] > margin);
}

function holdsRefit(trigger, shadow) {
  const gate = shadow.activationGate;
  if (trigger.reason === 'fit_input_withdrawn') return false;
  if (gate.eligible) return true;
  if (!WAITS_FOR_GATE_SAMPLE.has(trigger.reason)) return false;
  const awaitingSample = gate.reasons.some((reason) => reason.startsWith('insufficient_forward_'));
  const undecided = gate.reasons.every((reason) => UNDECIDED_GATE_REASONS.some((prefix) => reason.startsWith(prefix)));
  return awaitingSample && undecided && !inferiorityShown(shadow);
}

/**
 * Keep the persisted map unless it is unusable, from another code version, or
 * the ledger gives a refit trigger. Refitting on every run would move
 * fittedAt forward daily and the forward cohort would never accumulate.
 * While the activation gate passes, a trigger other than a withdrawn input is
 * held: a refit would discard the forward evidence and revert a validated
 * publication. The gate reads only the recent window, so the hold ends when
 * recent evidence stops validating the map. Growth and new eligibility are
 * also held while the gate lacks the forward sample to judge the map, unless
 * that partial sample already shows raw better beyond the margin. The first
 * trigger the gate does not hold refits.
 */
export function resolveCalibrationMapForRun(existing, ledger, nowMs, options = {}) {
  const codeVersion = options.codeVersion ?? CALIBRATION_CODE_VERSION;
  const parsed = parseCalibrationMap(existing);
  if (!parsed || parsed.codeVersion !== codeVersion) {
    const reason = !existing ? 'absent' : parsed ? 'code_version_changed' : 'invalid';
    return { map: fitCalibrationMap(ledger, nowMs, { ...options, codeVersion, refitReason: reason }), action: 'fitted', reason };
  }
  const { triggers, carry } = refitTrigger(parsed, ledger, nowMs, options);
  if (!triggers.length) return { map: parsed, action: 'kept' };
  const shadow = evaluateCalibrationShadow(ledger, parsed, nowMs);
  const trigger = triggers.find((candidate) => !holdsRefit(candidate, shadow));
  if (!trigger) return { map: parsed, action: 'kept', held: triggers[0] };
  const map = fitCalibrationMap(ledger, nowMs, { ...options, codeVersion, dataVersion: parsed.dataVersion + 1, refitReason: trigger.reason, carry });
  return { map, action: 'fitted', reason: trigger.reason, domain: trigger.domain };
}

export function assertCohortOutsideFitWindow(map, entries) {
  const fitWindowTo = map.fitWindow.to;
  const overlapping = entries.filter((entry) => {
    const emittedAt = emissionTime(entry);
    return !Number.isFinite(emittedAt) || emittedAt <= fitWindowTo;
  }).length;
  if (overlapping) throw new CalibrationCohortOverlapError(overlapping, fitWindowTo);
}

function modeByDomainOf(map) {
  return Object.fromEntries(Object.entries(map.domains).map(([domain, fit]) => [domain, fit.mode]));
}

/**
 * Evaluate a cohort against the map. Throws CalibrationCohortOverlapError for
 * any entry the fit could have seen; the caller cannot opt out.
 */
export function evaluateCalibrationCohort(entries, map, context = {}, options = {}) {
  assertCohortOutsideFitWindow(map, entries);
  const rows = entries
    .filter((entry) => isScoredEntry(entry) && isPublishedOriginEntry(entry))
    .map((entry) => {
      const domain = domainOf(entry);
      const raw = sourceProbability(entry);
      return { domain, y: entry.outcome === 'YES' ? 1 : 0, raw, calibrated: applyCalibration(map, domain, raw) };
    });
  const modeByDomain = modeByDomainOf(map);
  const forward = summarizeCalibrationShadow(rows, modeByDomain, options);
  const mapMonotone = Object.values(map.domains).every((fit) => fit.mode === 'identity' || knotsAreMonotone(fit.knots));
  return {
    forward,
    activationGate: evaluateActivationGate(forward, modeByDomain, context, { ...options, mapMonotone }),
  };
}

function forwardContext(forwardEntries, nowMs) {
  const originMix = {};
  for (const entry of forwardEntries) {
    const origin = generationOriginOf(entry);
    originMix[origin] = (originMix[origin] || 0) + 1;
  }
  const published = forwardEntries.filter(isPublishedOriginEntry);
  const matured = published.filter((entry) => Number(entry?.deadline) <= nowMs);
  const resolved = published.filter((entry) => entry?.status === 'resolved');
  const scored = resolved.filter(isScoredEntry);
  const voided = resolved.filter((entry) => entry?.outcome === 'VOID');
  const voidByReason = {};
  for (const entry of voided) {
    const reason = entry?.evidence?.reason || 'unknown';
    voidByReason[reason] = (voidByReason[reason] || 0) + 1;
  }
  return {
    registered: published.length,
    matured: matured.length,
    resolved: resolved.length,
    scored: scored.length,
    void: voided.length,
    pending: published.filter((entry) => entry?.status === 'pending' || entry?.status === 'pending-judge').length,
    scoredPerMatured: matured.length ? round6(scored.length / matured.length) : 0,
    voidPerResolved: resolved.length ? round6(voided.length / resolved.length) : 0,
    voidByReason,
    originMix,
  };
}

/**
 * Shadow block for the scorecard: the forward cohort is every ledger entry
 * emitted after the map's fit window, so the evaluation never sees an outcome
 * the fit used, less outcomes resolved before the scorecard's rolling window.
 */
export function evaluateCalibrationShadow(ledger, map, nowMs, options = {}) {
  if (!map) return { status: 'no_map' };
  // Same window as the scorecard: an outcome the public record no longer
  // grades cannot keep validating the map. An unresolved entry has no
  // resolvedAt, so it stays.
  const minResolvedAt = nowMs - (options.rollingWindowDays ?? DEFAULT_ROLLING_WINDOW_DAYS) * DAY_MS;
  const forwardEntries = ledgerEntries(ledger).filter((entry) => emissionTime(entry) > map.fitWindow.to
    && !(Number(entry.resolvedAt) < minResolvedAt));
  const { forward, activationGate } = evaluateCalibrationCohort(forwardEntries, map, forwardContext(forwardEntries, nowMs), options);
  return {
    status: 'shadow',
    mapVersion: map.version,
    fittedAt: map.fittedAt,
    sourceStage: map.sourceStage,
    nonIdentityDomains: Object.keys(map.domains).filter((domain) => map.domains[domain].mode !== 'identity').sort(),
    forward,
    activationGate,
  };
}

/**
 * @typedef {'calibrated' | 'raw'} PublicationMode
 * @typedef {'gate_eligible' | 'force_raw' | 'read_failed' | 'no_map' | 'map_code_version' | 'no_gate' | 'gate_stale' | 'gate_map_mismatch' | 'gate_ineligible'} PublicationReason
 * @typedef {{
 *   eligible: boolean,
 *   reasons: string[],
 *   forwardCount: number,
 *   brierDeltaUpper: number | null,
 *   domains: { domain: string, count: number, brierDeltaUpper: number | null }[],
 * }} PublicationGate
 * @typedef {{ mode: PublicationMode, reason: PublicationReason, mapVersion: string | null, gate: PublicationGate | null }} CalibrationPublicationDecision
 * @typedef {{ at: number, from: PublicationMode, to: PublicationMode, reason: PublicationReason, gate: PublicationGate | null }} CalibrationFlip
 * @typedef {CalibrationPublicationDecision & { decidedAt: number, lastFlip: CalibrationFlip | null }} CalibrationPublicationRecord
 */

export const CALIBRATION_FORCE_RAW_ENV = 'FORECAST_CALIBRATION_FORCE_RAW';
// The resolver runs daily; a verdict older than two runs is not current.
export const CALIBRATION_GATE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function publicationGate(gate) {
  if (!gate || typeof gate !== 'object') return null;
  return {
    eligible: gate.eligible === true,
    reasons: Array.isArray(gate.reasons) ? [...gate.reasons] : [],
    forwardCount: gate.forwardCount ?? 0,
    brierDeltaUpper: gate.overall?.brierDeltaUpper ?? null,
    domains: (gate.domains ?? []).map(({ domain, count, brierDeltaUpper }) => ({ domain, count, brierDeltaUpper })),
  };
}

/**
 * Stateless: the same inputs always give the same mode, and the previous mode
 * is never an input. `shadow` is the scorecard's calibrationShadow block and
 * `gateGeneratedAt` the scorecard's generatedAt.
 * @returns {CalibrationPublicationDecision}
 */
export function decideCalibrationPublication(map, shadow, { forceRaw = false, readFailed = false, nowMs = NaN, gateGeneratedAt = NaN } = {}) {
  const gate = publicationGate(shadow?.activationGate);
  const decide = (mode, reason) => ({ mode, reason, mapVersion: map?.version ?? null, gate });
  if (forceRaw) return decide('raw', 'force_raw');
  if (readFailed) return decide('raw', 'read_failed');
  if (!map) return decide('raw', 'no_map');
  if (map.codeVersion !== CALIBRATION_CODE_VERSION) return decide('raw', 'map_code_version');
  if (!gate) return decide('raw', 'no_gate');
  if (!(nowMs - gateGeneratedAt <= CALIBRATION_GATE_MAX_AGE_MS)) return decide('raw', 'gate_stale');
  // A verdict on another map says nothing about this one.
  if (shadow.mapVersion !== map.version) return decide('raw', 'gate_map_mismatch');
  if (!gate.eligible) return decide('raw', 'gate_ineligible');
  return decide('calibrated', 'gate_eligible');
}

/**
 * Audit record for a decision. A missing previous record reads as raw, since
 * every publication before activation was raw.
 * @returns {{ flipped: boolean, record: CalibrationPublicationRecord }}
 */
export function recordCalibrationPublication(previous, decision, nowMs) {
  const previousMode = previous?.mode === 'calibrated' ? 'calibrated' : 'raw';
  const flipped = previousMode !== decision.mode;
  const lastFlip = flipped
    ? { at: nowMs, from: previousMode, to: decision.mode, reason: decision.reason, gate: decision.gate }
    : previous?.lastFlip ?? null;
  return { flipped, record: { ...decision, decidedAt: nowMs, lastFlip } };
}

/**
 * Applies the map to post-blend probabilities in place, for the population it
 * was fitted on. A moved forecast keeps its post-blend value as
 * `uncalibratedProbability`, which the fit and the shadow read back.
 * Returns how many forecasts moved.
 */
export function applyPublishedCalibration(predictions, map, decision) {
  if (decision?.mode !== 'calibrated' || !map) return 0;
  let moved = 0;
  for (const pred of predictions) {
    if (!isPublishedOriginEntry(pred)) continue;
    const raw = pred.probability;
    const calibrated = Math.round(applyCalibration(map, domainOf(pred), raw) * 1000) / 1000;
    if (!Number.isFinite(calibrated) || calibrated === raw) continue;
    pred.uncalibratedProbability = raw;
    pred.probability = calibrated;
    moved += 1;
  }
  return moved;
}

/**
 * Re-expresses the prior run's probabilities on this run's scale, so a trend
 * or change summary across a flip (or a refit) compares like with like
 * instead of reporting the change of method as a move.
 */
export function alignPriorToPublication(prior, map, decision) {
  if (!Array.isArray(prior?.predictions)) return prior;
  const scratch = prior.predictions.map((prev) => {
    const raw = typeof prev?.uncalibratedProbability === 'number' ? prev.uncalibratedProbability : prev?.probability;
    const { uncalibratedProbability: _dropped, ...rest } = prev ?? {};
    return { ...rest, probability: raw };
  });
  applyPublishedCalibration(scratch, map, decision);
  return {
    ...prior,
    predictions: scratch.map(({ uncalibratedProbability: _dropped, ...rest }) => rest),
  };
}
