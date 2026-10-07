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
  isHorizonEntry,
  isPublishedOriginEntry,
  isScoredEntry,
  summarizeCalibrationShadow,
} from './_forecast-scorecard.mjs';

/**
 * @typedef {{ x: number, y: number }} CalibrationKnot
 * @typedef {'identity' | 'isotonic'} CalibrationMode
 * @typedef {{
 *   n: number,
 *   positives: number,
 *   mode: CalibrationMode,
 *   identityReason?: 'insufficient_total_sample' | 'insufficient_domain_sample',
 *   knots: CalibrationKnot[],
 * }} CalibrationDomain
 * @typedef {{
 *   schemaVersion: number,
 *   version: string,
 *   codeVersion: string,
 *   fittedAt: number,
 *   fitWindow: { from: number | null, to: number },
 *   cohortFilter: { excludedOrigins: string[], outcomes: string[], rollingWindowDays: number, emissionField: string },
 *   sourceStage: string,
 *   minTotalSample: number,
 *   minDomainSample: number,
 *   probabilityBounds: { floor: number, ceiling: number },
 *   totalSample: number,
 *   domains: Record<string, CalibrationDomain>,
 * }} CalibrationMap
 */

export const CALIBRATION_MAP_SCHEMA_VERSION = 1;
// Bumping this is the only refit path: a persisted map with another code
// version is replaced on the next resolver run, which also restarts the
// forward cohort at the new fittedAt.
export const CALIBRATION_CODE_VERSION = 'forecast-calibration-pav-v1';
export const CALIBRATION_SOURCE_STAGE = 'marketBlendedProbability';
export const CALIBRATION_MIN_TOTAL_SAMPLE = 60;
export const CALIBRATION_MIN_DOMAIN_SAMPLE = 30;
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

// An anchor without lineage was chosen by the pre-#7071 matcher, which paired
// forecasts with unrelated markets, so its blended probability is not an
// input the current seeder can produce.
function hasPreLineageAnchor(entry) {
  const calibration = entry?.calibration;
  return Number.isFinite(Number(calibration?.marketPrice)) && !Number.isFinite(Number(calibration?.marketBlendedProbability));
}

/** Scored published-origin entries resolved inside the rolling window ending at nowMs. */
export function selectFitCohort(ledger, nowMs, options = {}) {
  const rollingWindowDays = options.rollingWindowDays ?? DEFAULT_ROLLING_WINDOW_DAYS;
  const minResolvedAt = nowMs - rollingWindowDays * DAY_MS;
  return ledgerEntries(ledger).filter((entry) => {
    if (!isScoredEntry(entry) || !isPublishedOriginEntry(entry) || hasPreLineageAnchor(entry)) return false;
    const resolvedAt = Number(entry.resolvedAt);
    const emittedAt = emissionTime(entry);
    return Number.isFinite(resolvedAt) && resolvedAt >= minResolvedAt && resolvedAt <= nowMs
      && Number.isFinite(emittedAt) && emittedAt <= nowMs
      && Number.isFinite(sourceProbability(entry));
  });
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

/** @returns {CalibrationMap} */
export function fitCalibrationMap(ledger, nowMs, options = {}) {
  if (!Number.isFinite(nowMs)) throw new TypeError('fitCalibrationMap requires an injected nowMs');
  const rollingWindowDays = options.rollingWindowDays ?? DEFAULT_ROLLING_WINDOW_DAYS;
  const minTotalSample = options.minTotalSample ?? CALIBRATION_MIN_TOTAL_SAMPLE;
  const minDomainSample = options.minDomainSample ?? CALIBRATION_MIN_DOMAIN_SAMPLE;
  const codeVersion = options.codeVersion ?? CALIBRATION_CODE_VERSION;
  const bounds = { floor: CALIBRATION_PROBABILITY_FLOOR, ceiling: CALIBRATION_PROBABILITY_CEILING };
  const cohort = selectFitCohort(ledger, nowMs, { rollingWindowDays });
  const totalSufficient = cohort.length >= minTotalSample;

  const byDomain = new Map();
  for (const entry of cohort) {
    const domain = domainOf(entry);
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push({ x: sourceProbability(entry), y: entry.outcome === 'YES' ? 1 : 0 });
  }

  const domains = {};
  for (const domain of [...byDomain.keys()].sort()) {
    const points = byDomain.get(domain);
    const base = { n: points.length, positives: points.reduce((sum, point) => sum + point.y, 0) };
    if (!totalSufficient) {
      domains[domain] = { ...base, mode: 'identity', identityReason: 'insufficient_total_sample', knots: [] };
    } else if (points.length < minDomainSample) {
      domains[domain] = { ...base, mode: 'identity', identityReason: 'insufficient_domain_sample', knots: [] };
    } else {
      domains[domain] = { ...base, mode: 'isotonic', knots: isotonicKnots(points, bounds) };
    }
  }

  const emissions = cohort.map(emissionTime);
  return {
    schemaVersion: CALIBRATION_MAP_SCHEMA_VERSION,
    version: `${codeVersion}@${nowMs}`,
    codeVersion,
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
    minTotalSample,
    minDomainSample,
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
  if (!Number.isFinite(value.fittedAt) || !Number.isFinite(value.fitWindow?.to)) return null;
  if (!value.domains || typeof value.domains !== 'object') return null;
  for (const fit of Object.values(value.domains)) {
    if (fit?.mode !== 'identity' && fit?.mode !== 'isotonic') return null;
    if (fit.mode === 'isotonic' && (!fit.knots?.length || !knotsAreMonotone(fit.knots))) return null;
  }
  return value;
}

/**
 * Keep the persisted map unless it is unusable or from another code version.
 * Refitting on every run would move fittedAt forward daily and the forward
 * cohort would never accumulate, so the map stays frozen between deliberate
 * version bumps.
 */
export function resolveCalibrationMapForRun(existing, ledger, nowMs, options = {}) {
  const codeVersion = options.codeVersion ?? CALIBRATION_CODE_VERSION;
  const parsed = parseCalibrationMap(existing);
  if (parsed && parsed.codeVersion === codeVersion) return { map: parsed, action: 'kept' };
  const reason = !existing ? 'absent' : parsed ? 'code_version_changed' : 'invalid';
  return { map: fitCalibrationMap(ledger, nowMs, { ...options, codeVersion }), action: 'fitted', reason };
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
 * the fit used.
 */
export function evaluateCalibrationShadow(ledger, map, nowMs, options = {}) {
  if (!map) return { status: 'no_map' };
  const forwardEntries = ledgerEntries(ledger).filter((entry) => emissionTime(entry) > map.fitWindow.to);
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
 * @typedef {'gate_eligible' | 'force_raw' | 'read_failed' | 'no_map' | 'no_gate' | 'gate_map_mismatch' | 'gate_ineligible'} PublicationReason
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
 * is never an input. `shadow` is the scorecard's calibrationShadow block.
 * @returns {CalibrationPublicationDecision}
 */
export function decideCalibrationPublication(map, shadow, { forceRaw = false, readFailed = false } = {}) {
  const gate = publicationGate(shadow?.activationGate);
  const decide = (mode, reason) => ({ mode, reason, mapVersion: map?.version ?? null, gate });
  if (forceRaw) return decide('raw', 'force_raw');
  if (readFailed) return decide('raw', 'read_failed');
  if (!map) return decide('raw', 'no_map');
  if (!gate) return decide('raw', 'no_gate');
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
