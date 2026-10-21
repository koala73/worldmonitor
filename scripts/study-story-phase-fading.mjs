#!/usr/bin/env node
/**
 * StoryPhase.FADING lifecycle study — issue #7081.
 *
 * Replays the frozen production evidence in
 * tests/fixtures/story-phase-fading-study.json against the documented
 * `currentScore < 0.5 * peakScore` rule and against each bounded alternative
 * the issue proposed, then prints the verdict.
 *
 * Deterministic and offline: it reads only the frozen fixture, never Redis and
 * never the wall clock. The fixture stores every timestamp as an integer
 * millisecond offset from its own capture instant precisely so this stays true
 * — and as an integer rather than a float so the recorded sha256 is reproducible
 * from any language, not just the one that wrote it.
 *
 *   node scripts/study-story-phase-fading.mjs          # print the full study
 *   node scripts/study-story-phase-fading.mjs --check   # assert the verdict holds
 *
 * --check exits non-zero if the recorded evidence stops supporting the no-go,
 * which is the signal to re-open the question rather than to edit this file.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', 'tests', 'fixtures', 'story-phase-fading-study.json');

/** Weights and severity points mirrored from computeImportanceScore(). */
export const SCORE_WEIGHTS = { severity: 0.55, sourceTier: 0.2, corroboration: 0.15, recency: 0.1 };
export const SEVERITY_SCORES = { critical: 100, high: 75, medium: 50, low: 25, info: 0 };

/** Acceptance bar from the issue. */
export const ACCEPTANCE = {
  minFadingPrecision: 0.8,
  maxActiveHighSeverityFalsePositives: 0,
  minTrajectories: 60,
};

export function assessCandidate({
  precision,
  activeHighSeverityFalsePositives = 0,
  notComputableReason,
}) {
  if (precision == null) {
    return {
      verdict: 'not-computable-here',
      precision: null,
      activeHighSeverityFalsePositives,
      reason: notComputableReason ?? 'The frozen evidence cannot measure this candidate at this call site.',
    };
  }

  const meetsPrecision = precision >= ACCEPTANCE.minFadingPrecision;
  const meetsControl = activeHighSeverityFalsePositives <= ACCEPTANCE.maxActiveHighSeverityFalsePositives;
  return {
    verdict: meetsPrecision && meetsControl ? 'accept' : 'reject',
    precision,
    activeHighSeverityFalsePositives,
    reason: meetsPrecision && meetsControl
      ? `Measured precision ${(precision * 100).toFixed(1)}% clears the ${ACCEPTANCE.minFadingPrecision * 100}% bar with ${activeHighSeverityFalsePositives} active high-severity false positives.`
      : `Measured precision ${(precision * 100).toFixed(1)}% and ${activeHighSeverityFalsePositives} active high-severity false positives do not clear the acceptance bar.`,
  };
}

export function loadStudy(path = FIXTURE) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** The documented rule, repaired to read the authoritative ZSet peak. */
export function firesDocumentedRule(row) {
  return row.cur > 0 && row.peak > 0 && row.cur < row.peak * 0.5;
}

/**
 * Score range reachable at a fixed severity, holding the rule's other inputs at
 * their extremes. `minOverMax` is the smallest cur/peak a story can reach
 * WITHOUT a severity change, so a value at or above 0.5 proves the documented
 * rule can never fire on that severity class on merit.
 */
export function severityDynamicRange(severity) {
  const sev = SEVERITY_SCORES[severity];
  if (sev === undefined) throw new Error(`unknown severity: ${severity}`);
  const base = SCORE_WEIGHTS.severity * sev;
  // Floor: worst source tier (25), a single corroborating source (20), an
  // article past the 24h recency horizon (0).
  const min = base + SCORE_WEIGHTS.sourceTier * 25 + SCORE_WEIGHTS.corroboration * 20;
  // Ceiling: tier 1 (100), five corroborating sources (100), just published (100).
  const max = base + SCORE_WEIGHTS.sourceTier * 100 + SCORE_WEIGHTS.corroboration * 100
    + SCORE_WEIGHTS.recency * 100;
  return { severity, min, max, minOverMax: min / max, canFire: min / max < 0.5 };
}

/**
 * The recency term in isolation: the same item, scored while fresh and again
 * once its article passes the 24h horizon. Nothing about the story changed.
 */
export function recencyOnlyRatio(severity, tierScore, corroborationScore) {
  const base = SCORE_WEIGHTS.severity * SEVERITY_SCORES[severity]
    + SCORE_WEIGHTS.sourceTier * tierScore
    + SCORE_WEIGHTS.corroboration * corroborationScore;
  const fresh = base + SCORE_WEIGHTS.recency * 100;
  const aged = base;
  return { fresh, aged, ratio: aged / fresh };
}

export function verifyIntegrity(study) {
  // Re-serialise with sorted keys and no whitespace, exactly as the capture
  // script did. Every numeric field in a row is an integer, so this round-trips
  // identically across languages.
  const actualRowsSha256 = digestCanonical(study.rows);
  const { evidenceSha256: _evidenceSha256, ...evidencePayload } = study;
  const actualEvidenceSha256 = digestCanonical(evidencePayload);
  const rowsOk = actualRowsSha256 === study.rowsSha256;
  const evidenceOk = actualEvidenceSha256 === study.evidenceSha256;
  return {
    expected: study.rowsSha256,
    actual: actualRowsSha256,
    rowsOk,
    evidenceExpected: study.evidenceSha256,
    evidenceActual: actualEvidenceSha256,
    evidenceOk,
    ok: rowsOk && evidenceOk,
  };
}

function digestCanonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** Evaluate every candidate rule the issue asked for against the same rows. */
export function evaluateCandidates(study) {
  const rows = study.rows;
  const serving = rows.filter((r) => r.strata.includes('serving_now'));
  const population = study.populationAggregates;
  const fires = population.firesUnderDocumentedRule;
  const firesOnControls = population.firesThatAreCriticalOrHigh;
  const firesInfoOrLow = population.firesThatAreInfoOrLow;

  const documented = {
    id: 'documented-score-ratio',
    description: 'currentScore < 0.5 * peakScore (the rule the proto comment promised)',
    fires,
    firesOnControls,
    firesInfoOrLow,
    ...assessCandidate({
      precision: fires > 0 ? (fires - firesInfoOrLow) / fires : 0,
      activeHighSeverityFalsePositives: firesOnControls,
    }),
  };

  const silence = {
    id: 'time-since-last-appearance',
    description: 'silence since the previous appearance exceeds a threshold',
    servingRows: serving.length,
    servingMaxSilentMs: serving.reduce((m, r) => Math.max(m, r.silentMs), 0),
    ...assessCandidate({
      precision: null,
      notComputableReason: 'derivePhase only runs for stories present in the current cycle and is '
        + 'handed lastSeen = now, so this feature is ~0 for every row it can see. It is '
        + 'computable in the notification seeder, which iterates the accumulator instead.',
    }),
  };

  const velocity = {
    id: 'mention-velocity',
    description: 'mentionCount per hour of story age',
    medianServingMentionCount: median(serving.map((r) => r.mc)),
    ...assessCandidate({
      precision: null,
      notComputableReason: 'mentionCount increments once per (variant, lang, build cycle), not per '
        + 'editorial mention, so it tracks build cadence and variant fan-out rather than attention.',
    }),
  };

  const publishers = {
    id: 'publisher-narrowing',
    description: 'current-cycle publishers over the historical distinct-publisher set',
    servingSinglePublisher: serving.filter((r) => r.srcSet <= 1).length,
    servingRows: serving.length,
    ...assessCandidate({
      precision: null,
      notComputableReason: 'The historical publisher set is a singleton for the large majority of served '
        + 'stories, so the ratio is 1/1 and there is no dynamic range to threshold.',
    }),
  };

  return [documented, silence, velocity, publishers];
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function main() {
  const check = process.argv.includes('--check');
  const study = loadStudy();
  const integrity = verifyIntegrity(study);
  const agg = study.populationAggregates;
  const candidates = evaluateCandidates(study);
  const failures = [];

  const out = [];
  out.push(`StoryPhase.FADING study — issue #${study.issue}`);
  out.push(`  repository ref : ${study.repositoryRef}`);
  out.push(`  capture (UTC)  : ${study.captureUtc}`);
  out.push(`  sampled rows   : ${agg.sampledRows}`);
  out.push(`  retained rows  : ${study.retainedRows}`);
  out.push(`  rows sha256    : ${integrity.rowsOk ? 'OK' : `MISMATCH (${integrity.actual})`}`);
  out.push(`  evidence sha256: ${integrity.evidenceOk ? 'OK' : `MISMATCH (${integrity.evidenceActual})`}`);
  out.push('');

  out.push('Finding 1 — the shipped rule was unreachable');
  out.push(`  rows whose story:track hash carried a peakScore field: ${agg.hashPeakScorePresent} / ${agg.sampledRows}`);
  out.push(`  rows with a positive peak in the story:peak ZSet     : ${agg.zsetPeakPositive} / ${agg.sampledRows}`);
  out.push(`  rows with a positive currentScore                    : ${agg.currentScorePositive} / ${agg.sampledRows}`);
  out.push('');

  out.push('Finding 2 — repaired, the ratio tracks severity class, not traction');
  out.push('  severity   n      minRatio  median   fires(<0.5)');
  for (const [sev, s] of Object.entries(agg.bySeverity)) {
    out.push(`  ${sev.padEnd(9)} ${String(s.n).padStart(6)}  ${s.minRatio.toFixed(4).padStart(8)}  `
      + `${s.medianRatio.toFixed(4).padStart(7)}  ${String(s.firesUnderDocumentedRule).padStart(6)}`);
  }
  out.push(`  total firings ${agg.firesUnderDocumentedRule}; info/low ${agg.firesThatAreInfoOrLow}; `
    + `critical/high ${agg.firesThatAreCriticalOrHigh} of ${agg.criticalOrHighRows} such rows`);
  out.push('');

  out.push('  reachable score range at fixed severity (analytic, from the score weights):');
  for (const sev of ['critical', 'high', 'medium', 'low', 'info']) {
    const r = severityDynamicRange(sev);
    out.push(`    ${sev.padEnd(9)} min=${r.min.toFixed(2).padStart(6)} max=${r.max.toFixed(2).padStart(6)} `
      + `min/max=${r.minOverMax.toFixed(3)}  ${r.canFire ? 'can fire' : 'CANNOT fire without a severity change'}`);
  }
  out.push('');
  out.push('  the recency term alone, nothing else about the story changing:');
  for (const sev of ['critical', 'high', 'medium', 'low', 'info']) {
    const r = recencyOnlyRatio(sev, 25, 20);
    out.push(`    ${sev.padEnd(9)} fresh=${r.fresh.toFixed(2).padStart(6)} aged=${r.aged.toFixed(2).padStart(6)} `
      + `ratio=${r.ratio.toFixed(3)}${r.ratio < 0.5 ? '  <-- crosses the threshold on article age alone' : ''}`);
  }
  out.push('');

  out.push('Finding 3 — fading is not observable at this call site');
  out.push(`  rows present in the current cycle        : ${agg.servingNowRows}`
    + ` (max silence ${(agg.servingNowMaxSilentMs / 60000).toFixed(1)} min)`);
  out.push(`  rows absent from it, i.e. actually silent: ${agg.notServingRows}`);
  out.push('  derivePhase never sees the second group, and is handed lastSeen = now for the first.');
  out.push('');

  out.push('Candidate rules');
  for (const c of candidates) {
    out.push(`  [${c.verdict}] ${c.id} — ${c.description}`);
    if (c.precision != null) {
      out.push(`      measured precision ${(c.precision * 100).toFixed(1)}%; active high-severity false positives ${c.activeHighSeverityFalsePositives}`);
    }
    out.push(`      ${c.reason}`);
  }
  out.push('');
  out.push('VERDICT: no-go. No candidate meets the acceptance bar '
    + `(FADING precision >= ${ACCEPTANCE.minFadingPrecision}, `
    + `${ACCEPTANCE.maxActiveHighSeverityFalsePositives} active high-severity false positives).`);
  out.push('StoryPhase.FADING stays in the wire enum and stays unemitted by the feed digest.');

  if (!integrity.rowsOk) failures.push(`fixture rows sha256 mismatch: ${integrity.actual} != ${study.rowsSha256}`);
  if (!integrity.evidenceOk) failures.push(`fixture evidence sha256 mismatch: ${integrity.evidenceActual} != ${study.evidenceSha256}`);
  if (agg.hashPeakScorePresent !== 0) {
    failures.push('a story:track hash now carries peakScore — the unreachability finding needs re-checking');
  }
  if (agg.firesThatAreCriticalOrHigh !== 0) {
    failures.push('the documented rule fired on a critical/high row — re-run the study');
  }
  if (study.retainedRows < ACCEPTANCE.minTrajectories) {
    failures.push(`fixture holds ${study.retainedRows} rows, below the ${ACCEPTANCE.minTrajectories} minimum`);
  }
  for (const sev of ['critical', 'high']) {
    if (severityDynamicRange(sev).canFire) {
      failures.push(`${sev} severity can now reach the 0.5 ratio — the score weights changed`);
    }
  }
  for (const candidate of candidates) {
    if (candidate.verdict === 'accept') {
      failures.push(`candidate ${candidate.id} meets the acceptance bar — re-run the study`);
    }
  }

  console.log(out.join('\n'));
  if (check) {
    if (failures.length) {
      console.error(`\n--check FAILED:\n  - ${failures.join('\n  - ')}`);
      process.exit(1);
    }
    console.log('\n--check OK: the frozen evidence still supports the recorded no-go.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
