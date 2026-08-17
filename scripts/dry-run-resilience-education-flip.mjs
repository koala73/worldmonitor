#!/usr/bin/env node
// #6460 — flag-on dry run for the `education` dimension activation.
//
// Scores every rankable country TWICE against production-seeded data — once
// with RESILIENCE_EDUCATION_ENABLED off (baseline) and once on (proposed) —
// and evaluates the five acceptance gates from
// `docs/methodology/education-flag-flip-runbook.md`.
//
// READ-ONLY. It calls `scoreAllDimensions` and the pure aggregation helpers,
// never `buildResilienceScore` / `ensureResilienceScoreCached`, because those
// append history and write the score cache. `_dimension-scorers.ts` performs no
// writes at all, which is what makes running it against production safe.
//
// Usage:
//   node --import tsx/esm scripts/dry-run-resilience-education-flip.mjs
//
// Optional:
//   EDUCATION_WEIGHT_OVERRIDE=0.25   # the runbook's pre-agreed weight fallback
//   DRY_RUN_OUTPUT=path.json         # also write the full measurement as JSON
//
// The weight override exists so the fallback rule ("if any gate fails, halve
// the weight and re-measure") is one env var rather than a source edit — a
// source edit would have to be reverted before the real measurement, which is
// exactly the kind of step that gets forgotten between two runs.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CHROME_UA, loadEnvFile } from './_seed-utils.mjs';
import { unwrapEnvelope } from '../server/_shared/seed-envelope.ts';
import {
  scoreAllDimensions,
  RESILIENCE_DIMENSION_WEIGHTS,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import {
  buildDimensionList,
  buildDomainList,
  penalizedPillarScore,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import { buildPillarList } from '../server/worldmonitor/resilience/v1/_pillar-membership.ts';
import {
  MATCHED_PAIRS,
  evaluateWholeIndexMatchedPairs,
} from '../tests/helpers/resilience-matched-pairs.mts';
import { RESILIENCE_COHORTS } from '../tests/helpers/resilience-cohorts.mts';

loadEnvFile(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HARNESS_PATH = 'scripts/dry-run-resilience-education-flip.mjs';
const EDUCATION_REDIS_KEY = 'resilience:education-attainment:v1';

// In-universe coverage of `resilience:education-attainment:v1`, measured
// against scripts/shared/sovereign-status.json on 2026-08-11 (recordCount 189
// total, 181 of them rankable; the 15 absent are BB, ER, GA, GQ, KG, KN, KP,
// LI, LY, MC, SS, ST, SY, TW, VC). Pinned as an exact expectation rather than a
// floor so a partially-read payload aborts the run instead of quietly imputing
// the remainder and reporting the result as a construct verdict.
const EXPECTED_EDUCATION_COVERAGE = 181;

const GATE_THRESHOLDS = {
  SPEARMAN_VS_BASELINE_MIN: 0.85,
  MAX_COUNTRY_ABS_DELTA_MAX: 15,
  COHORT_MEDIAN_SHIFT_MAX: 10,
  CORE_EXTRACTION_COVERAGE_MIN: 0.80,
};

const universe = Object.values(
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/shared/sovereign-status.json'), 'utf8')).entries,
).map((entry) => entry.iso2);

const shippedEducationWeight = RESILIENCE_DIMENSION_WEIGHTS.education;

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonEqual = (left, right) => canonicalJson(left) === canonicalJson(right);
const ACCEPTANCE_ARTIFACT_DIRECTORY = 'docs/snapshots';
const ACCEPTANCE_RECAPTURE_COMMAND = 'DRY_RUN_OUTPUT=docs/snapshots/resilience-education-acceptance-$(date -u +%F).json node --import tsx/esm scripts/dry-run-resilience-education-flip.mjs';

function formatAcceptanceArtifactPath(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    return `${ACCEPTANCE_ARTIFACT_DIRECTORY}/resilience-education-acceptance-{date}.json`;
  }
  return filename.includes('/') ? filename : `${ACCEPTANCE_ARTIFACT_DIRECTORY}/${filename}`;
}

function acceptanceArtifactMismatchError(filename, detail) {
  return new Error(
    `${detail} for ${formatAcceptanceArtifactPath(filename)}; `
    + `re-capture against production seeds with: ${ACCEPTANCE_RECAPTURE_COMMAND}`,
  );
}

/**
 * Project a serialized gate onto the acceptance conclusion it proves.
 *
 * Gate names, detail strings, thresholds, and rationales are useful capture
 * evidence, but they are not themselves acceptance outcomes.
 * Keep only the status and measured values here so a harmless calibration edit
 * does not invalidate an otherwise identical measurement. Acceptance-relevant
 * attribution is retained. A changed status or measured value still fails
 * closed.
 */
export function projectAcceptanceGateOutcome(gate) {
  const base = { id: gate?.id, status: gate?.status };
  const evidence = gate?.evidence ?? {};

  switch (gate?.id) {
    case 'gate-1-spearman':
      return {
        ...base,
        measured: {
          spearman: evidence.spearman,
          countries: evidence.countries,
        },
      };
    case 'gate-2-country-drift': {
      const topMovers = Array.isArray(evidence.topMovers)
        ? evidence.topMovers.map((mover) => ({
          countryCode: mover?.countryCode,
          delta: mover?.delta,
        }))
        : null;
      const topMover = topMovers?.[0] ?? null;
      return {
        ...base,
        measured: {
          maxAbsDelta: Number.isFinite(topMover?.delta) ? Math.abs(topMover.delta) : null,
          topMovers,
        },
      };
    }
    case 'gate-6-cohort-median':
      return {
        ...base,
        measured: Array.isArray(evidence.cohortShifts)
          ? evidence.cohortShifts
            .map((cohort) => ({
              cohort: cohort?.cohort,
              members: cohort?.members,
              medianShift: cohort?.medianShift,
            }))
            .sort((left, right) => String(left.cohort).localeCompare(String(right.cohort)))
          : null,
      };
    case 'gate-7-matched-pair':
      return {
        ...base,
        measured: Array.isArray(evidence.pairs)
          ? evidence.pairs
            .map((pair) => ({
              pairId: pair?.pairId,
              status: pair?.status,
              baselineStatus: pair?.baselineStatus,
              regression: pair?.regression,
              preExisting: pair?.preExisting,
              gap: pair?.gap,
              baselineGap: pair?.baselineGap,
              gapDelta: pair?.gapDelta,
            }))
            .sort((left, right) => String(left.pairId).localeCompare(String(right.pairId)))
          : null,
        regressions: Array.isArray(evidence.regressions)
          ? [...evidence.regressions].sort((left, right) => String(left).localeCompare(String(right)))
          : null,
        preExisting: Array.isArray(evidence.preExisting)
          ? [...evidence.preExisting].sort((left, right) => String(left).localeCompare(String(right)))
          : null,
      };
    case 'gate-9-effective-influence-baseline':
      return {
        ...base,
        measured: {
          coreImplemented: evidence.coreImplemented,
          coreTotal: evidence.coreTotal,
          educationPairedSampleSize: evidence.educationPairedSampleSize,
          educationCountryCodes: Array.isArray(evidence.educationCountryCodes)
            ? [...evidence.educationCountryCodes].sort()
            : null,
        },
      };
    default:
      throw new Error(`unknown acceptance gate id: ${String(gate?.id)}`);
  }
}

export function projectAcceptanceGateOutcomes(gates) {
  return Array.isArray(gates)
    ? gates
      .map(projectAcceptanceGateOutcome)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    : null;
}

function getCaptureSourceState() {
  const trackedChanges = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ).trim();
  if (trackedChanges) {
    throw new Error('DRY_RUN_OUTPUT requires a clean tracked worktree so the harness commit is exact');
  }
  return {
    harness: HARNESS_PATH,
    harnessCommitSha: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim(),
    harnessSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  };
}

function buildRedisCaptureProvenance(cache) {
  const keyDigests = Object.fromEntries(
    [...cache.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, sha256(canonicalJson(value))]),
  );
  return {
    source: 'production-upstash-redis-rest',
    resolvedKeyCount: Object.keys(keyDigests).length,
    keyDigests,
    snapshotSha256: sha256(canonicalJson(keyDigests)),
  };
}

export function parseEducationWeightOverride(raw, shippedWeight = shippedEducationWeight) {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  const approvedFallback = shippedWeight / 2;
  if (!Number.isFinite(value) || value !== approvedFallback) {
    throw new Error(
      `EDUCATION_WEIGHT_OVERRIDE must equal the pre-agreed half-weight fallback ${approvedFallback}; got ${raw}`,
    );
  }
  return value;
}

// ── read layer ─────────────────────────────────────────────────────────────
//
// This is deliberately NOT the scorers' `defaultSeedReader`. That path goes
// through `getCachedJson`, which collapses a MISS and a read ERROR to the same
// `null` — so under any rate limiting or connection pressure a failed read is
// indistinguishable from absent data, the dimension imputes, and the run
// reports a construct catastrophe that is really a network artifact. The first
// attempt at this script did exactly that: 196 countries x 2 passes of serial
// per-country reads produced ~88 silent read failures, education coverage of
// 93/196 against a known 181, and a uniform ~50-point collapse across the
// board that read as a total inversion.
//
// Two properties fix it:
//   1. Retry, and record any key that never resolved. A run with even one
//      unresolved key aborts instead of publishing a verdict over holes.
//   2. ONE cache shared by BOTH passes. The baseline and proposed passes then
//      see byte-identical inputs for every key except the education payload by
//      construction, so a delta cannot be manufactured by two reads of a
//      moving source.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const readCache = new Map();
const unresolvedKeys = new Set();
let readCount = 0;

async function fetchKeyOnce(key) {
  const resp = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const body = await resp.json();
  if (body?.error) throw new Error(`Redis: ${body.error}`);
  if (body?.result == null) return { ok: true, value: null }; // genuine miss
  return { ok: true, value: unwrapEnvelope(JSON.parse(body.result)).data };
}

/** GET with retry. Distinguishes a genuine miss (null) from an unresolved read. */
async function readKey(key) {
  if (readCache.has(key)) return readCache.get(key);
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { value } = await fetchKeyOnce(key);
      readCache.set(key, value);
      readCount++;
      return value;
    } catch (err) {
      lastErr = err;
      await sleep(250 * 2 ** attempt); // 250ms .. 4s
    }
  }
  // Never cache an unresolved read as `null` without recording it — that is
  // precisely the miss/error conflation this layer exists to avoid.
  unresolvedKeys.add(`${key} (${lastErr?.message ?? 'unknown'})`);
  readCache.set(key, null);
  return null;
}

// ── scoring ────────────────────────────────────────────────────────────────

/**
 * Reproduces the two published aggregations exactly as `buildResilienceScore`
 * derives them, from the same exported helpers, minus the cache/history writes:
 *   - `pc`  = penalizedPillarScore(pillars)          (the active formula)
 *   - `d6`  = Σ domain.score * domain.weight          (the legacy aggregate)
 */
async function scoreCountry(countryCode) {
  const scoreMap = await scoreAllDimensions(countryCode, readKey);
  const dimensions = buildDimensionList(scoreMap);
  const domains = buildDomainList(dimensions);
  const pillars = buildPillarList(domains, true);
  const pc = pillars.length > 0
    ? penalizedPillarScore(pillars.map((p) => ({ score: p.score, weight: p.weight })))
    : null;
  const d6 = Math.round(domains.reduce((sum, d) => sum + d.score * d.weight, 0) * 100) / 100;
  const education = dimensions.find((d) => d.id === 'education') ?? null;
  return {
    pc,
    d6,
    educationScore: education?.score ?? null,
    educationCoverage: education?.coverage ?? null,
    // '' when the dimension has observed data; a class label when it is fully
    // imputed. Absent countries take `unmonitored` at coverage 0.3, so
    // `coverage > 0` is NOT a test for "measured" — it counts the 15 imputed
    // ones too, which is why the coverage guard below keys on this instead.
    educationImputationClass: education?.imputationClass ?? null,
    // #6460 post-flip note: WGI was failing in production on 2026-08-11
    // (failedDatasets=wgi on every country). A source-failure in an unrelated
    // dimension depresses absolute scores in BOTH passes equally, so the
    // baseline-vs-proposed DELTA still isolates education — but gate-7 is
    // evaluated on PROPOSED absolute scores, so a pair could hold or break for
    // reasons that have nothing to do with this flag. Recorded so the run
    // reports the confound instead of silently ranking through it.
    sourceFailureDimensions: dimensions
      .filter((d) => d.imputationClass === 'source-failure')
      .map((d) => d.id),
  };
}

async function scorePass(label, educationEnabled) {
  process.env.RESILIENCE_EDUCATION_ENABLED = educationEnabled ? 'true' : 'false';
  const out = new Map();
  let done = 0;
  // Serial. 196 countries x ~20 scorers each opening concurrent Upstash reads
  // is what tripped rate limiting on the first attempt; this is a one-shot
  // measurement where wall-clock does not matter. After pass 1 the shared
  // readCache makes pass 2 almost entirely network-free.
  for (const countryCode of universe) {
    out.set(countryCode, await scoreCountry(countryCode));
    if (++done % 40 === 0) process.stderr.write(`  [${label}] ${done}/${universe.length} (${readCount} keys read)\n`);
  }
  return out;
}

// ── statistics ─────────────────────────────────────────────────────────────

function rank(values) {
  // Average ranks for ties — a dense/ordinal rank would bias Spearman when a
  // group of countries shares a score.
  const sorted = [...values.entries()].sort((a, b) => b[1] - a[1]);
  const ranks = new Map();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][1] === sorted[i][1]) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks.set(sorted[k][0], shared);
    i = j + 1;
  }
  return ranks;
}

function spearman(baseline, proposed) {
  const keys = [...baseline.keys()].filter((k) => proposed.has(k));
  const rb = rank(new Map(keys.map((k) => [k, baseline.get(k)])));
  const rp = rank(new Map(keys.map((k) => [k, proposed.get(k)])));
  const n = keys.length;
  const mean = (n + 1) / 2;
  let num = 0;
  let db = 0;
  let dp = 0;
  for (const k of keys) {
    const x = rb.get(k) - mean;
    const y = rp.get(k) - mean;
    num += x * y;
    db += x * x;
    dp += y * y;
  }
  return db === 0 || dp === 0 ? 0 : num / Math.sqrt(db * dp);
}

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// ── gates ──────────────────────────────────────────────────────────────────

function matchedPairStatus(gap, minGap) {
  if (gap == null) return 'missing';
  return gap >= minGap ? 'pass' : (gap > 0 ? 'near-flip' : 'inverted');
}

function evaluateGates(baseline, proposed, formula) {
  const gates = [];
  const add = (id, name, status, detail, evidence = {}) => gates.push({ id, name, status, detail, evidence });

  const scored = universe.filter((cc) => baseline.get(cc)?.[formula] != null && proposed.get(cc)?.[formula] != null);
  const b = new Map(scored.map((cc) => [cc, baseline.get(cc)[formula]]));
  const p = new Map(scored.map((cc) => [cc, proposed.get(cc)[formula]]));

  const rho = spearman(b, p);
  add('gate-1-spearman', 'Spearman vs baseline >= 0.85',
    rho >= GATE_THRESHOLDS.SPEARMAN_VS_BASELINE_MIN ? 'pass' : 'fail',
    `rho ${round2(rho)} over ${scored.length} countries`, { spearman: rho, countries: scored.length });

  const deltas = scored.map((cc) => ({ countryCode: cc, delta: p.get(cc) - b.get(cc) }));
  const movers = [...deltas].sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const maxDrift = movers.length ? Math.abs(movers[0].delta) : 0;
  add('gate-2-country-drift', 'Max country drift <= 15 points',
    maxDrift <= GATE_THRESHOLDS.MAX_COUNTRY_ABS_DELTA_MAX ? 'pass' : 'fail',
    `max |delta| ${round2(maxDrift)} (${movers[0]?.countryCode ?? 'n/a'})`,
    { topMovers: movers.slice(0, 15).map((m) => ({ ...m, delta: round2(m.delta) })) });

  const cohortShifts = RESILIENCE_COHORTS.map((cohort) => {
    const members = cohort.countryCodes.filter((cc) => b.has(cc));
    const shift = members.length
      ? median(members.map((cc) => p.get(cc))) - median(members.map((cc) => b.get(cc)))
      : null;
    return { cohort: cohort.id, members: members.length, medianShift: round2(shift) };
  });
  const worstCohort = cohortShifts
    .filter((c) => c.medianShift != null)
    .sort((x, y) => Math.abs(y.medianShift) - Math.abs(x.medianShift))[0] ?? null;
  add('gate-6-cohort-median', 'Cohort median shift <= 10 points',
    worstCohort == null || Math.abs(worstCohort.medianShift) <= GATE_THRESHOLDS.COHORT_MEDIAN_SHIFT_MAX ? 'pass' : 'fail',
    worstCohort ? `worst ${worstCohort.cohort} ${worstCohort.medianShift}` : 'no cohort members scored',
    { cohortShifts });

  // Direction AND minGap, evaluated on the PROPOSED scores. A pair that keeps
  // its sign but collapses to a near-tie is a near-flip, and the runbook treats
  // that as a stop just like an inversion. The pure evaluator is shared with
  // the deterministic fixture gate so CI and the credentialed dry run cannot
  // drift on missing-score or threshold semantics.
  const proposedPairEvaluations = evaluateWholeIndexMatchedPairs(p, MATCHED_PAIRS);
  const baselinePairEvaluations = evaluateWholeIndexMatchedPairs(b, MATCHED_PAIRS);
  const pairs = proposedPairEvaluations.map((evaluation, index) => {
    const baselineEvaluation = baselinePairEvaluations[index];
    const baseGap = baselineEvaluation?.gap ?? null;
    const status = evaluation.status;
    // A pair that ALREADY failed with the flag off was not broken by this
    // change, and the runbook's weight-fallback rule cannot fix it — halving
    // education's weight only walks the gap back toward a baseline that was
    // itself under the threshold. Separating the two is the difference between
    // "this flip is unsafe" and "this pair has a pre-existing problem".
    const baselineStatus = baseGap == null ? 'unknown' : baselineEvaluation.status;
    const regression = status !== 'pass' && baselineStatus === 'pass';
    const preExisting = status !== 'pass' && status !== 'missing' && baselineStatus !== 'pass';
    return {
      pairId: evaluation.pairId,
      status,
      baselineStatus,
      regression,
      preExisting,
      gap: evaluation.gap == null ? null : round2(evaluation.gap),
      baselineGap: round2(baseGap),
      gapDelta: evaluation.gap == null || baseGap == null ? null : round2(evaluation.gap - baseGap),
      minGap: evaluation.minGap,
    };
  });
  const pairFailures = pairs.filter((x) => x.status !== 'pass');
  const regressions = pairFailures.filter((x) => x.regression);
  const preExisting = pairFailures.filter((x) => x.preExisting);
  add('gate-7-matched-pair', 'Every matched pair holds direction and minGap',
    pairFailures.length === 0 ? 'pass' : 'fail',
    pairFailures.length === 0
      ? `${pairs.length}/${pairs.length} pairs pass`
      : `${regressions.length} caused by this flip${regressions.length ? ` (${regressions.map((x) => x.pairId).join(', ')})` : ''}; `
        + `${preExisting.length} already failing at baseline${preExisting.length ? ` (${preExisting.map((x) => `${x.pairId} ${x.baselineGap}->${x.gap} vs min ${x.minGap}`).join(', ')})` : ''}`,
    { pairs, regressions: regressions.map((x) => x.pairId), preExisting: preExisting.map((x) => x.pairId) });

  return gates;
}

function validateSerializedMatchedPairGate(gate, filename) {
  const evidence = gate?.evidence;
  if (!Array.isArray(evidence?.pairs)
    || !Array.isArray(evidence?.regressions)
    || !Array.isArray(evidence?.preExisting)) {
    throw acceptanceArtifactMismatchError(
      filename,
      'reported matched-pair evidence does not match its serialized gap, baselineGap, and minGap',
    );
  }

  const regressions = [];
  const preExisting = [];
  for (const pair of evidence.pairs) {
    const validPair = pair
      && typeof pair === 'object'
      && typeof pair.pairId === 'string'
      && Number.isFinite(pair.minGap)
      && pair.minGap >= 0
      && (pair.gap === null || Number.isFinite(pair.gap))
      && (pair.baselineGap === null || Number.isFinite(pair.baselineGap));
    if (!validPair) {
      throw acceptanceArtifactMismatchError(
        filename,
        'reported matched-pair evidence does not match its serialized gap, baselineGap, and minGap',
      );
    }

    const expectedStatus = matchedPairStatus(pair.gap, pair.minGap);
    const expectedBaselineStatus = pair.baselineGap == null
      ? 'unknown'
      : matchedPairStatus(pair.baselineGap, pair.minGap);
    const expectedRegression = expectedStatus !== 'pass' && expectedBaselineStatus === 'pass';
    const expectedPreExisting = expectedStatus !== 'pass'
      && expectedStatus !== 'missing'
      && expectedBaselineStatus !== 'pass';
    if (pair.status !== expectedStatus
      || pair.baselineStatus !== expectedBaselineStatus
      || pair.regression !== expectedRegression
      || pair.preExisting !== expectedPreExisting) {
      throw acceptanceArtifactMismatchError(
        filename,
        'reported matched-pair status or attribution does not match its serialized gap, baselineGap, and minGap',
      );
    }
    const expectedGapDelta = pair.gap == null || pair.baselineGap == null
      ? null
      : round2(pair.gap - pair.baselineGap);
    if (pair.gapDelta !== expectedGapDelta) {
      throw acceptanceArtifactMismatchError(
        filename,
        'reported matched-pair gapDelta does not match its serialized gap and baselineGap',
      );
    }
    if (expectedRegression) regressions.push(pair.pairId);
    if (expectedPreExisting) preExisting.push(pair.pairId);
  }

  const sortIds = (ids) => [...ids].sort((left, right) => String(left).localeCompare(String(right)));
  if (!jsonEqual(sortIds(evidence.regressions), sortIds(regressions))
    || !jsonEqual(sortIds(evidence.preExisting), sortIds(preExisting))) {
    throw acceptanceArtifactMismatchError(
      filename,
      'reported matched-pair attribution lists do not match their serialized pair outcomes',
    );
  }
}

function validateReportedMatchedPairAttribution(results, filename) {
  for (const gates of Object.values(results ?? {})) {
    if (!Array.isArray(gates)) continue;
    for (const gate of gates) {
      if (gate?.id === 'gate-7-matched-pair') validateSerializedMatchedPairGate(gate, filename);
    }
  }
}

export function evaluateExtractionCoverageGate({
  plan,
  educationRule,
  educationPayload,
  applyExtractionRule,
  countryCodes = universe,
}) {
  const coreTotal = plan.filter((e) => e.tier === 'core').length;
  const coreImplemented = plan.filter((e) => e.tier === 'core' && e.extractionStatus === 'implemented').length;
  const ratio = coreTotal > 0 ? coreImplemented / coreTotal : 0;
  const education = plan.find((e) => e.indicator === 'femaleUpperSecondaryAttainment') ?? null;
  const educationCountryCodes = educationRule && educationPayload
    ? countryCodes.filter((countryCode) => (
      applyExtractionRule(
        educationRule,
        { bulkV1: { [educationRule.key]: educationPayload } },
        countryCode,
      ) != null
    ))
    : [];
  return buildExtractionCoverageGate({
    coreImplemented,
    coreTotal,
    educationPairedSampleSize: educationCountryCodes.length,
    expectedEducationSampleSize: EXPECTED_EDUCATION_COVERAGE,
    educationCountryCodes,
    educationRow: education
      ? { tier: education.tier, extractionStatus: education.extractionStatus }
      : null,
  });
}

function buildExtractionCoverageGate(evidence) {
  const ratio = evidence.coreTotal > 0 ? evidence.coreImplemented / evidence.coreTotal : 0;
  const educationReady = evidence.educationRow?.extractionStatus === 'implemented'
    && evidence.educationPairedSampleSize === EXPECTED_EDUCATION_COVERAGE;
  const coreReady = ratio >= GATE_THRESHOLDS.CORE_EXTRACTION_COVERAGE_MIN;
  return {
    id: 'gate-9-effective-influence-baseline',
    name: 'Core extraction baseline and education sample are measurable',
    status: coreReady && educationReady ? 'pass' : 'fail',
    detail: `${evidence.coreImplemented}/${evidence.coreTotal} Core indicators measurable (${round2(ratio * 100)}%); `
      + `education ${evidence.educationPairedSampleSize}/${EXPECTED_EDUCATION_COVERAGE}`,
    evidence,
  };
}

async function extractionCoverageGate() {
  const {
    applyExtractionRule,
    buildIndicatorExtractionPlan,
    EXTRACTION_RULES,
  } = await import('./compare-resilience-current-vs-proposed.mjs');
  const { INDICATOR_REGISTRY } = await import('../server/worldmonitor/resilience/v1/_indicator-registry.ts');
  const plan = buildIndicatorExtractionPlan(INDICATOR_REGISTRY);
  const educationRule = EXTRACTION_RULES.femaleUpperSecondaryAttainment;
  const educationPayload = educationRule?.key ? await readKey(educationRule.key) : null;
  return evaluateExtractionCoverageGate({
    plan,
    educationRule,
    educationPayload,
    applyExtractionRule,
  });
}

export function collectSourceFailures(passes, countryCodes = universe) {
  const tally = new Map();
  for (const [passName, pass] of Object.entries(passes)) {
    for (const countryCode of countryCodes) {
      for (const dimensionId of pass.get(countryCode)?.sourceFailureDimensions ?? []) {
        const key = `${passName}:${dimensionId}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
    }
  }
  return tally;
}

export function evaluateMeasurementInputs({
  baseline,
  proposed,
  unresolvedEntries = [],
  countryCodes = universe,
  expectedEducationCoverage = EXPECTED_EDUCATION_COVERAGE,
}) {
  const observed = (countryCode, pass) => {
    const row = pass.get(countryCode);
    return row != null && (row.educationCoverage ?? 0) > 0 && !row.educationImputationClass;
  };
  const observedEducation = countryCodes.filter((countryCode) => observed(countryCode, proposed));
  const imputedEducation = countryCodes.filter((countryCode) => (
    (proposed.get(countryCode)?.educationCoverage ?? 0) > 0
    && proposed.get(countryCode)?.educationImputationClass
  ));
  const baselineWithEducation = countryCodes.filter((countryCode) => (
    (baseline.get(countryCode)?.educationCoverage ?? 0) > 0
  ));
  const sourceFailures = collectSourceFailures({ baseline, proposed }, countryCodes);

  return {
    valid: unresolvedEntries.length === 0
      && observedEducation.length === expectedEducationCoverage
      && baselineWithEducation.length === 0
      && sourceFailures.size === 0,
    unresolvedEntries,
    observedEducation,
    imputedEducation,
    baselineWithEducation,
    sourceFailures,
    blockingSourceFailures: sourceFailures,
  };
}

const REQUIRED_ACTIVE_GATE_IDS = new Set([
  'gate-1-spearman',
  'gate-2-country-drift',
  'gate-6-cohort-median',
  'gate-7-matched-pair',
  'gate-9-effective-influence-baseline',
]);

export function summarizeAcceptanceGates(results) {
  const activeGates = results.pc;
  const activeGateIds = Array.isArray(activeGates) ? activeGates.map((gate) => gate?.id) : [];
  const validActiveGates = activeGateIds.length === REQUIRED_ACTIVE_GATE_IDS.size
    && new Set(activeGateIds).size === REQUIRED_ACTIVE_GATE_IDS.size
    && activeGateIds.every((id) => REQUIRED_ACTIVE_GATE_IDS.has(id))
    && activeGates.every((gate) => gate?.status === 'pass' || gate?.status === 'fail');
  if (!validActiveGates) {
    throw new Error('active pc acceptance gates are missing, duplicated, or malformed');
  }
  const gatingFailures = activeGates.filter((gate) => gate.status !== 'pass');
  const nonGatingFailures = Object.entries(results)
    .filter(([formula]) => formula !== 'pc')
    .flatMap(([, gates]) => gates.filter((gate) => gate.status !== 'pass'));
  return {
    verdict: gatingFailures.length === 0 ? 'PASS' : 'FAIL',
    gatingFailures,
    nonGatingFailures,
  };
}

function deriveRecordedExtractionCoverageGate(evidence) {
  const countryCodes = evidence?.educationCountryCodes;
  const validCountryCodes = Array.isArray(countryCodes)
    && countryCodes.length === new Set(countryCodes).size
    && countryCodes.every((countryCode) => universe.includes(countryCode));
  const validCounts = Number.isInteger(evidence?.coreImplemented)
    && Number.isInteger(evidence?.coreTotal)
    && evidence.coreImplemented >= 0
    && evidence.coreTotal > 0
    && evidence.coreImplemented <= evidence.coreTotal
    && Number.isInteger(evidence?.educationPairedSampleSize)
    && Number.isInteger(evidence?.expectedEducationSampleSize);
  if (!validCountryCodes || !validCounts) {
    throw new Error('recorded gate 9 inputs are malformed');
  }

  if (evidence.expectedEducationSampleSize !== EXPECTED_EDUCATION_COVERAGE
    || evidence.educationPairedSampleSize !== countryCodes.length) {
    throw new Error('recorded gate 9 inputs are internally inconsistent');
  }
  return buildExtractionCoverageGate(evidence);
}

function readHarnessAtCommit(commitSha) {
  return execFileSync('git', ['show', `${commitSha}:${HARNESS_PATH}`], {
    cwd: REPO_ROOT,
  });
}

function validateCaptureProvenance(artifact, filename) {
  const capture = artifact?.capture;
  const redis = capture?.redis;
  const keyDigests = redis?.keyDigests;
  const validIso = (value) => typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
  const validDigests = keyDigests && typeof keyDigests === 'object' && !Array.isArray(keyDigests)
    && Object.values(keyDigests).every((digest) => /^[a-f0-9]{64}$/.test(digest));
  const valid = artifact?.schemaVersion === 2
    && capture?.source === 'production-seed-dry-run'
    && capture?.activeFormula === 'pc'
    && capture?.harness === HARNESS_PATH
    && /^[a-f0-9]{40}$/.test(capture?.harnessCommitSha ?? '')
    && /^[a-f0-9]{64}$/.test(capture?.harnessSha256 ?? '')
    && capture.harnessSha256 === sha256(readHarnessAtCommit(capture.harnessCommitSha))
    && validIso(capture?.startedAt)
    && validIso(capture?.completedAt)
    && validIso(artifact?.measuredAt)
    && capture.startedAt <= capture.completedAt
    && capture.completedAt === artifact.measuredAt
    && redis?.source === 'production-upstash-redis-rest'
    && Number.isInteger(redis?.resolvedKeyCount)
    && redis.resolvedKeyCount > 0
    && validDigests
    && redis.resolvedKeyCount === Object.keys(keyDigests).length
    && /^[a-f0-9]{64}$/.test(redis?.snapshotSha256 ?? '')
    && redis.snapshotSha256 === sha256(canonicalJson(keyDigests))
    && /^[a-f0-9]{64}$/.test(keyDigests?.[EDUCATION_REDIS_KEY] ?? '');
  if (!valid) throw new Error('capture provenance is malformed or internally inconsistent');

  const match = filename?.match(/^resilience-education-acceptance-(\d{4}-\d{2}-\d{2})\.json$/);
  if (match && (
    !artifact.measuredAt.startsWith(match[1])
    || !capture.startedAt.startsWith(match[1])
    || !capture.completedAt.startsWith(match[1])
  )) {
    throw new Error('capture timestamps do not match the artifact filename date');
  }
}

export function validateEducationAcceptanceArtifact(artifact, { filename } = {}) {
  validateCaptureProvenance(artifact, filename);
  if (artifact.educationWeight !== shippedEducationWeight
    || artifact.shippedEducationWeight !== shippedEducationWeight) {
    throw new Error('acceptance artifact must measure the shipped education weight');
  }

  const scoreEntries = artifact?.scores && typeof artifact.scores === 'object' && !Array.isArray(artifact.scores)
    ? Object.entries(artifact.scores)
    : [];
  const scoreKeys = scoreEntries.map(([countryCode]) => countryCode);
  if (scoreKeys.length !== universe.length
    || new Set(scoreKeys).size !== universe.length
    || universe.some((countryCode) => !artifact.scores[countryCode])) {
    throw new Error('artifact scores do not cover the exact sovereign universe');
  }
  for (const [countryCode, row] of scoreEntries) {
    if (!row?.baseline || !row?.proposed
      || !['pc', 'd6'].every((formula) => Number.isFinite(row.baseline[formula]) && Number.isFinite(row.proposed[formula]))) {
      throw new Error(`artifact score row ${countryCode} is malformed`);
    }
  }

  const baseline = new Map(scoreEntries.map(([countryCode, row]) => [countryCode, row.baseline]));
  const proposed = new Map(scoreEntries.map(([countryCode, row]) => [countryCode, row.proposed]));
  const measurement = evaluateMeasurementInputs({ baseline, proposed });
  if (!measurement.valid) throw new Error('artifact measurement inputs fail closed validation');
  if (artifact.universeSize !== universe.length
    || artifact.educationCoverageCountries !== measurement.observedEducation.length
    || !jsonEqual(artifact.sourceFailures, Object.fromEntries(measurement.sourceFailures))
    || !jsonEqual(artifact.blockingSourceFailures, Object.fromEntries(measurement.blockingSourceFailures))) {
    throw new Error('artifact measurement summary does not match the captured scores');
  }

  const reportedResults = artifact.acceptanceGates?.gates;
  const reportedGate9 = Array.isArray(reportedResults?.pc)
    ? reportedResults.pc.find((gate) => gate?.id === 'gate-9-effective-influence-baseline')
    : null;
  const gate9CountryCodes = reportedGate9?.evidence?.educationCountryCodes;
  if (!Array.isArray(gate9CountryCodes)
    || !jsonEqual([...gate9CountryCodes].sort(), [...measurement.observedEducation].sort())) {
    throw new Error('gate 9 education cohort does not match observed score coverage');
  }
  const recomputedResults = {
    pc: [...evaluateGates(baseline, proposed, 'pc'), deriveRecordedExtractionCoverageGate(reportedGate9?.evidence)],
    d6: evaluateGates(baseline, proposed, 'd6'),
  };
  if (!jsonEqual(
    Object.fromEntries(Object.entries(reportedResults ?? {}).map(([formula, gates]) => [formula, projectAcceptanceGateOutcomes(gates)])),
    Object.fromEntries(Object.entries(recomputedResults).map(([formula, gates]) => [formula, projectAcceptanceGateOutcomes(gates)])),
  )) {
    throw acceptanceArtifactMismatchError(filename, 'reported gate outcomes do not match recomputed outcomes');
  }

  validateReportedMatchedPairAttribution(reportedResults, filename);
  const summary = summarizeAcceptanceGates(recomputedResults);
  if (artifact.acceptanceGates.gatingFormula !== 'pc'
    || artifact.acceptanceGates.verdict !== summary.verdict) {
    throw acceptanceArtifactMismatchError(filename, 'artifact verdict does not match recomputed gates');
  }
  if (!jsonEqual(
    projectAcceptanceGateOutcomes(artifact.acceptanceGates.nonGatingFailures),
    projectAcceptanceGateOutcomes(summary.nonGatingFailures),
  )) {
    throw acceptanceArtifactMismatchError(filename, 'artifact non-gating failures do not match recomputed outcomes');
  }

  return {
    verdict: summary.verdict,
    activeFormula: 'pc',
    universeSize: universe.length,
    educationCoverageCountries: measurement.observedEducation.length,
  };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  // Mirrors scripts/dry-run-resilience-rebalance.mjs — this executable reads
  // production credentials. Keep the guards inside main so CI can import and
  // test the pure gate helpers without running the credentialed workflow.
  if (process.env.CI === 'true') {
    console.error('FATAL: dry-run-resilience-education-flip.mjs must NOT run in CI (manual validation only)');
    process.exit(2);
  }
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.error('FATAL: Upstash Redis credentials missing — this measures against production seeds');
    process.exit(2);
  }
  const captureStartedAt = new Date().toISOString();
  const captureSource = process.env.DRY_RUN_OUTPUT ? getCaptureSourceState() : null;

  let weightOverride;
  try {
    weightOverride = parseEducationWeightOverride(process.env.EDUCATION_WEIGHT_OVERRIDE);
  } catch (error) {
    console.error(`FATAL: ${error.message}`);
    process.exit(2);
  }
  if (weightOverride != null) {
    console.log(`[dry-run] EDUCATION WEIGHT OVERRIDE: ${shippedEducationWeight} -> ${weightOverride} (runbook fallback rule)`);
    RESILIENCE_DIMENSION_WEIGHTS.education = weightOverride;
  }
  console.log(`[dry-run] universe ${universe.length} countries; education weight ${RESILIENCE_DIMENSION_WEIGHTS.education}`);

  console.log('[dry-run] pass 1/2 — RESILIENCE_EDUCATION_ENABLED=false (baseline)');
  const baseline = await scorePass('baseline', false);
  console.log('[dry-run] pass 2/2 — RESILIENCE_EDUCATION_ENABLED=true (proposed)');
  const proposed = await scorePass('proposed', true);

  const measurementInputs = evaluateMeasurementInputs({
    baseline,
    proposed,
    unresolvedEntries: [...unresolvedKeys],
  });

  // Non-vacuity guard. If the flag-on pass produced no education coverage, the
  // two passes are identical and every gate would pass while proving nothing —
  // the same "green with no signal" failure the runbook calls out for stale
  // cache prefixes.
  // Guard 1 — no unresolved reads. This is the one that matters most. Without
  // it a degraded run publishes a full set of gate verdicts computed over
  // imputed holes, and the output is indistinguishable from a real construct
  // failure. Abort rather than report.
  if (measurementInputs.unresolvedEntries.length > 0) {
    console.error(`\nFATAL: ${measurementInputs.unresolvedEntries.length} key(s) never resolved after retries — the measurement would be computed over read holes, not data.`);
    for (const entry of measurementInputs.unresolvedEntries.slice(0, 20)) console.error(`  ${entry}`);
    console.error('Re-run when Redis is reachable. Do NOT interpret a FAIL verdict from a degraded run.');
    process.exit(2);
  }

  // OBSERVED, not merely non-zero coverage: the 15 countries absent from the
  // World Bank series impute to `unmonitored` at coverage 0.3, so a
  // `coverage > 0` test returns 196/196 and proves nothing about how many
  // countries were actually measured.
  const {
    observedEducation,
    imputedEducation,
    baselineWithEducation,
    sourceFailures,
    blockingSourceFailures,
  } = measurementInputs;
  console.log(`[dry-run] education: observed ${observedEducation.length}, imputed ${imputedEducation.length}, baseline coverage ${baselineWithEducation.length} (${readCount} unique keys read)`);

  // Guard 2 — the flag-on pass must actually light the dimension up, and for
  // the RIGHT number of countries. `> 0` alone is too weak: a partially-read
  // payload still clears it while silently imputing the rest, which is how the
  // first attempt produced 93/196 and read as a catastrophe.
  if (observedEducation.length !== EXPECTED_EDUCATION_COVERAGE) {
    console.error(`\nFATAL: education resolved for ${observedEducation.length}/${universe.length} countries, expected ${EXPECTED_EDUCATION_COVERAGE}.`);
    console.error('Either the payload changed (re-measure and update EXPECTED_EDUCATION_COVERAGE) or reads were degraded. Not a construct verdict.');
    process.exit(2);
  }
  // Guard 3 — the passes must be isolated. If the baseline already carries
  // education coverage the two passes are not measuring different things.
  if (baselineWithEducation.length !== 0) {
    console.error('\nFATAL: flag-off baseline already carries education coverage — the passes are not isolated.');
    process.exit(2);
  }

  // Any real source failure invalidates the measurement because the global
  // Spearman and drift gates consume the full scored universe. Structural
  // source absences must be removed by the source-failure classifier instead
  // of weakening this validity guard.
  if (blockingSourceFailures.size > 0) {
    console.error('\nFATAL: source-failure dimensions make the acceptance measurement invalid:');
    for (const [passAndDimension, count] of [...blockingSourceFailures.entries()].sort((a, b) => b[1] - a[1])) {
      console.error(`  ${passAndDimension.padEnd(35)} ${count}/${universe.length} countries`);
    }
    console.error('Re-run after source health recovers. Do NOT interpret PASS or FAIL from this run.');
    process.exit(2);
  }
  const results = {};
  for (const formula of ['pc', 'd6']) {
    const gates = evaluateGates(baseline, proposed, formula);
    if (formula === 'pc') gates.push(await extractionCoverageGate());
    results[formula] = gates;
  }

  for (const [formula, gates] of Object.entries(results)) {
    const label = formula === 'pc' ? 'pillar-combined penalized (ACTIVE)' : 'domain-weighted overall (legacy)';
    console.log(`\n=== ${label} ===`);
    for (const gate of gates) {
      console.log(`  ${gate.status === 'pass' ? 'PASS' : 'FAIL'}  ${gate.id.padEnd(36)} ${gate.detail}`);
    }
  }

  const pcPairs = results.pc.find((g) => g.id === 'gate-7-matched-pair')?.evidence?.pairs ?? [];
  console.log('\n=== matched pairs (pillar-combined) ===');
  for (const pair of pcPairs) {
    const origin = pair.regression ? '  <- REGRESSION caused by this flip' : (pair.preExisting ? '  <- pre-existing, already failing at baseline' : '');
    console.log(`  ${pair.status.padEnd(10)} ${pair.pairId.padEnd(16)} gap ${String(pair.gap).padStart(7)} (min ${pair.minGap}, baseline ${pair.baselineGap} [${pair.baselineStatus}], delta ${pair.gapDelta})${origin}`);
  }

  const movers = results.pc.find((g) => g.id === 'gate-2-country-drift')?.evidence?.topMovers ?? [];
  console.log('\n=== largest movers (pillar-combined) ===');
  for (const mover of movers.slice(0, 12)) {
    console.log(`  ${mover.countryCode}  ${mover.delta > 0 ? '+' : ''}${mover.delta}`);
  }

  const SOUTHERN_EUROPE = ['PT', 'ES', 'IT', 'MT', 'GR'];
  console.log('\n=== southern-Europe cohort (runbook taste bound: within ~1.5 points) ===');
  for (const cc of SOUTHERN_EUROPE) {
    const before = baseline.get(cc)?.pc;
    const after = proposed.get(cc)?.pc;
    if (before == null || after == null) { console.log(`  ${cc}  not scored`); continue; }
    console.log(`  ${cc}  ${round2(before)} -> ${round2(after)}  (${after - before > 0 ? '+' : ''}${round2(after - before)})  education dim ${proposed.get(cc)?.educationScore}`);
  }

  const {
    verdict,
    gatingFailures: failed,
    nonGatingFailures,
  } = summarizeAcceptanceGates(results);

  // Attribution matters more than the bare verdict here. The runbook's
  // weight-fallback rule assumes a failing gate was CAUSED by the flip; it
  // cannot repair a pair whose flag-off baseline is already under its minGap,
  // because halving the weight only walks the gap back toward that baseline.
  // Reporting a bare FAIL would send an operator to a fallback that provably
  // does not apply.
  const allRegressions = [...new Set(results.pc.flatMap((g) => g.evidence?.regressions ?? []))];
  const allPreExisting = [...new Set(results.pc.flatMap((g) => g.evidence?.preExisting ?? []))];
  const nonPairFailures = failed.filter((g) => g.id !== 'gate-7-matched-pair');

  console.log(`\n================ VERDICT: ${verdict} ================`);
  if (failed.length) {
    console.log('Failed gates:', [...new Set(failed.map((g) => g.id))].join(', '));
    console.log(`  caused by this flip:      ${allRegressions.length ? allRegressions.join(', ') : 'none'}`);
    console.log(`  already failing at flag-off baseline: ${allPreExisting.length ? allPreExisting.join(', ') : 'none'}`);
  }
  if (nonGatingFailures.length) {
    console.log('Legacy diagnostic failures (not part of the active pc acceptance verdict):',
      [...new Set(nonGatingFailures.map((g) => g.id))].join(', '));
  }
  const fallbackIndicated = nonPairFailures.length > 0 || allRegressions.length > 0;
  if (fallbackIndicated) {
    console.log('\nRunbook rule: do NOT waive. Halve the education weight and re-measure:');
    console.log('  EDUCATION_WEIGHT_OVERRIDE=0.25 node --import tsx/esm scripts/dry-run-resilience-education-flip.mjs');
  } else if (failed.length) {
    console.log('\nWeight fallback is NOT indicated: every failing gate was already failing with the');
    console.log('flag OFF, so it is a pre-existing condition this flip did not cause and halving the');
    console.log('education weight cannot repair. Fix or re-baseline those pairs on their own merits.');
  }

  if (process.env.DRY_RUN_OUTPUT) {
    const measuredAt = new Date().toISOString();
    const payload = {
      schemaVersion: 2,
      measuredAt,
      capture: {
        source: 'production-seed-dry-run',
        activeFormula: 'pc',
        startedAt: captureStartedAt,
        completedAt: measuredAt,
        ...captureSource,
        redis: buildRedisCaptureProvenance(readCache),
      },
      educationWeight: RESILIENCE_DIMENSION_WEIGHTS.education,
      shippedEducationWeight,
      universeSize: universe.length,
      educationCoverageCountries: observedEducation.length,
      sourceFailures: Object.fromEntries(sourceFailures),
      blockingSourceFailures: Object.fromEntries(blockingSourceFailures),
      acceptanceGates: {
        verdict,
        gatingFormula: 'pc',
        gates: results,
        nonGatingFailures,
      },
      scores: Object.fromEntries(universe.map((cc) => [cc, {
        baseline: baseline.get(cc) ?? null,
        proposed: proposed.get(cc) ?? null,
      }])),
    };
    validateEducationAcceptanceArtifact(payload, {
      filename: path.basename(process.env.DRY_RUN_OUTPUT),
    });
    writeFileSync(process.env.DRY_RUN_OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nwrote ${process.env.DRY_RUN_OUTPUT}`);
  }

  process.exit(verdict === 'PASS' ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('FATAL:', err?.stack || err?.message || err);
    process.exit(1);
  });
}

export {
  spearman,
  rank,
  median,
  evaluateGates,
  GATE_THRESHOLDS,
  EXPECTED_EDUCATION_COVERAGE,
};
