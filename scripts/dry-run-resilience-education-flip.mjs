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

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEnvFile } from './_seed-utils.mjs';
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
import { MATCHED_PAIRS } from '../tests/helpers/resilience-matched-pairs.mts';
import { RESILIENCE_COHORTS } from '../tests/helpers/resilience-cohorts.mts';

loadEnvFile(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Mirrors scripts/dry-run-resilience-rebalance.mjs — a one-shot local
// validation runner, never a CI job. It reads production credentials.
if (process.env.CI === 'true') {
  console.error('FATAL: dry-run-resilience-education-flip.mjs must NOT run in CI (manual validation only)');
  process.exit(2);
}
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error('FATAL: Upstash Redis credentials missing — this measures against production seeds');
  process.exit(2);
}

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

const weightOverride = process.env.EDUCATION_WEIGHT_OVERRIDE
  ? Number(process.env.EDUCATION_WEIGHT_OVERRIDE)
  : null;
if (weightOverride != null && !Number.isFinite(weightOverride)) {
  console.error(`FATAL: EDUCATION_WEIGHT_OVERRIDE is not a number: ${process.env.EDUCATION_WEIGHT_OVERRIDE}`);
  process.exit(2);
}
const shippedEducationWeight = RESILIENCE_DIMENSION_WEIGHTS.education;

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
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
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
  // that as a stop just like an inversion.
  const pairs = MATCHED_PAIRS.map((pair) => {
    const hi = p.get(pair.higherExpected);
    const lo = p.get(pair.lowerExpected);
    const baseGap = b.has(pair.higherExpected) && b.has(pair.lowerExpected)
      ? b.get(pair.higherExpected) - b.get(pair.lowerExpected)
      : null;
    if (hi == null || lo == null) {
      return { pairId: pair.id, status: 'missing', gap: null, baselineGap: round2(baseGap), minGap: pair.minGap ?? 3 };
    }
    const gap = hi - lo;
    const minGap = pair.minGap ?? 3;
    const verdict = (g) => (g >= minGap ? 'pass' : (g > 0 ? 'near-flip' : 'inverted'));
    const status = verdict(gap);
    // A pair that ALREADY failed with the flag off was not broken by this
    // change, and the runbook's weight-fallback rule cannot fix it — halving
    // education's weight only walks the gap back toward a baseline that was
    // itself under the threshold. Separating the two is the difference between
    // "this flip is unsafe" and "this pair has a pre-existing problem".
    const baselineStatus = baseGap == null ? 'unknown' : verdict(baseGap);
    return {
      pairId: pair.id,
      status,
      baselineStatus,
      regression: status !== 'pass' && baselineStatus === 'pass',
      preExisting: status !== 'pass' && baselineStatus !== 'pass',
      gap: round2(gap),
      baselineGap: round2(baseGap),
      gapDelta: baseGap == null ? null : round2(gap - baseGap),
      minGap,
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

async function extractionCoverageGate() {
  const { buildIndicatorExtractionPlan } = await import('./compare-resilience-current-vs-proposed.mjs');
  const { INDICATOR_REGISTRY } = await import('../server/worldmonitor/resilience/v1/_indicator-registry.ts');
  const plan = buildIndicatorExtractionPlan(INDICATOR_REGISTRY);
  const coreTotal = plan.filter((e) => e.tier === 'core').length;
  const coreImplemented = plan.filter((e) => e.tier === 'core' && e.extractionStatus === 'implemented').length;
  const ratio = coreTotal > 0 ? coreImplemented / coreTotal : 0;
  // Reported separately because education is still tier='experimental' in this
  // branch — the promotion to 'core' is the activation PR. Without this the
  // gate would read green while saying nothing about the dimension being
  // activated, which is the exact failure mode the runbook's item 4 warns about.
  const education = plan.find((e) => e.indicator === 'femaleUpperSecondaryAttainment') ?? null;
  return {
    id: 'gate-9-effective-influence-baseline',
    name: 'Per-indicator effective-influence baseline exists (>= 80% of Core implemented)',
    status: ratio >= GATE_THRESHOLDS.CORE_EXTRACTION_COVERAGE_MIN ? 'pass' : 'fail',
    detail: `${coreImplemented}/${coreTotal} Core indicators measurable (${round2(ratio * 100)}%)`,
    evidence: {
      coreImplemented,
      coreTotal,
      educationRow: education
        ? { tier: education.tier, extractionStatus: education.extractionStatus }
        : null,
    },
  };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  if (weightOverride != null) {
    console.log(`[dry-run] EDUCATION WEIGHT OVERRIDE: ${shippedEducationWeight} -> ${weightOverride} (runbook fallback rule)`);
    RESILIENCE_DIMENSION_WEIGHTS.education = weightOverride;
  }
  console.log(`[dry-run] universe ${universe.length} countries; education weight ${RESILIENCE_DIMENSION_WEIGHTS.education}`);

  console.log('[dry-run] pass 1/2 — RESILIENCE_EDUCATION_ENABLED=false (baseline)');
  const baseline = await scorePass('baseline', false);
  console.log('[dry-run] pass 2/2 — RESILIENCE_EDUCATION_ENABLED=true (proposed)');
  const proposed = await scorePass('proposed', true);

  // Non-vacuity guard. If the flag-on pass produced no education coverage, the
  // two passes are identical and every gate would pass while proving nothing —
  // the same "green with no signal" failure the runbook calls out for stale
  // cache prefixes.
  // Guard 1 — no unresolved reads. This is the one that matters most. Without
  // it a degraded run publishes a full set of gate verdicts computed over
  // imputed holes, and the output is indistinguishable from a real construct
  // failure. Abort rather than report.
  if (unresolvedKeys.size > 0) {
    console.error(`\nFATAL: ${unresolvedKeys.size} key(s) never resolved after retries — the measurement would be computed over read holes, not data.`);
    for (const entry of [...unresolvedKeys].slice(0, 20)) console.error(`  ${entry}`);
    console.error('Re-run when Redis is reachable. Do NOT interpret a FAIL verdict from a degraded run.');
    process.exit(2);
  }

  // OBSERVED, not merely non-zero coverage: the 15 countries absent from the
  // World Bank series impute to `unmonitored` at coverage 0.3, so a
  // `coverage > 0` test returns 196/196 and proves nothing about how many
  // countries were actually measured.
  const observed = (cc, pass) => {
    const row = pass.get(cc);
    return row != null && (row.educationCoverage ?? 0) > 0 && !row.educationImputationClass;
  };
  const withEducation = universe.filter((cc) => observed(cc, proposed));
  const imputedEducation = universe.filter((cc) => (proposed.get(cc)?.educationCoverage ?? 0) > 0 && proposed.get(cc)?.educationImputationClass);
  const baselineWithEducation = universe.filter((cc) => (baseline.get(cc)?.educationCoverage ?? 0) > 0);
  console.log(`[dry-run] education: observed ${withEducation.length}, imputed ${imputedEducation.length}, baseline coverage ${baselineWithEducation.length} (${readCount} unique keys read)`);

  // Guard 2 — the flag-on pass must actually light the dimension up, and for
  // the RIGHT number of countries. `> 0` alone is too weak: a partially-read
  // payload still clears it while silently imputing the rest, which is how the
  // first attempt produced 93/196 and read as a catastrophe.
  if (withEducation.length !== EXPECTED_EDUCATION_COVERAGE) {
    console.error(`\nFATAL: education resolved for ${withEducation.length}/${universe.length} countries, expected ${EXPECTED_EDUCATION_COVERAGE}.`);
    console.error('Either the payload changed (re-measure and update EXPECTED_EDUCATION_COVERAGE) or reads were degraded. Not a construct verdict.');
    process.exit(2);
  }
  // Guard 3 — the passes must be isolated. If the baseline already carries
  // education coverage the two passes are not measuring different things.
  if (baselineWithEducation.length !== 0) {
    console.error('\nFATAL: flag-off baseline already carries education coverage — the passes are not isolated.');
    process.exit(2);
  }

  // Confound report. Not a gate — a source-failure elsewhere hits both passes
  // equally so the education delta survives it — but gate-7 reads PROPOSED
  // absolute scores, so an unrelated outage can move a pair. Report it rather
  // than let a reader assume every movement is education's.
  const failureTally = new Map();
  for (const cc of universe) {
    for (const dimensionId of baseline.get(cc)?.sourceFailureDimensions ?? []) {
      failureTally.set(dimensionId, (failureTally.get(dimensionId) ?? 0) + 1);
    }
  }
  if (failureTally.size > 0) {
    console.log('\n[dry-run] CONFOUND — dimensions in source-failure across the baseline:');
    for (const [dimensionId, count] of [...failureTally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${dimensionId.padEnd(26)} ${count}/${universe.length} countries`);
    }
    console.log('  These depress absolute scores in BOTH passes, so the education delta still isolates.');
    console.log('  But gate-7 pairs are read on proposed ABSOLUTE scores — attribute pair movement with care.');
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

  const allGates = [...results.pc, ...results.d6];
  const failed = allGates.filter((g) => g.status !== 'pass');
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL';

  // Attribution matters more than the bare verdict here. The runbook's
  // weight-fallback rule assumes a failing gate was CAUSED by the flip; it
  // cannot repair a pair whose flag-off baseline is already under its minGap,
  // because halving the weight only walks the gap back toward that baseline.
  // Reporting a bare FAIL would send an operator to a fallback that provably
  // does not apply.
  const allRegressions = [...new Set(allGates.flatMap((g) => g.evidence?.regressions ?? []))];
  const allPreExisting = [...new Set(allGates.flatMap((g) => g.evidence?.preExisting ?? []))];
  const nonPairFailures = failed.filter((g) => g.id !== 'gate-7-matched-pair');

  console.log(`\n================ VERDICT: ${verdict} ================`);
  if (failed.length) {
    console.log('Failed gates:', [...new Set(failed.map((g) => g.id))].join(', '));
    console.log(`  caused by this flip:      ${allRegressions.length ? allRegressions.join(', ') : 'none'}`);
    console.log(`  already failing at flag-off baseline: ${allPreExisting.length ? allPreExisting.join(', ') : 'none'}`);
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
    const payload = {
      measuredAt: new Date().toISOString(),
      educationWeight: RESILIENCE_DIMENSION_WEIGHTS.education,
      shippedEducationWeight,
      universeSize: universe.length,
      educationCoverageCountries: withEducation.length,
      acceptanceGates: { verdict, gates: results },
      scores: Object.fromEntries(universe.map((cc) => [cc, {
        baseline: baseline.get(cc) ?? null,
        proposed: proposed.get(cc) ?? null,
      }])),
    };
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

export { spearman, rank, median, evaluateGates, GATE_THRESHOLDS };
