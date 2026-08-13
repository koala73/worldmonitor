import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import sovereignStatus from '../scripts/shared/sovereign-status.json' with { type: 'json' };
import { RESILIENCE_COHORTS } from './helpers/resilience-cohorts.mts';
import { applyExtractionRule } from '../scripts/compare-resilience-current-vs-proposed.mjs';
import {
  collectSourceFailures,
  evaluateExtractionCoverageGate,
  evaluateGates,
  evaluateMeasurementInputs,
  EXPECTED_EDUCATION_COVERAGE,
  parseEducationWeightOverride,
  spearman,
  summarizeAcceptanceGates,
  validateEducationAcceptanceArtifact,
} from '../scripts/dry-run-resilience-education-flip.mjs';

const universe = sovereignStatus.entries.map((entry) => entry.iso2);

const canonicalize = (value: any): any => {
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
const canonicalJson = (value: any) => JSON.stringify(canonicalize(value));
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function scorePass() {
  return new Map(universe.map((countryCode, index) => [countryCode, {
    pc: index,
    d6: index,
    sourceFailureDimensions: [],
  }]));
}

test('weight override accepts only the pre-agreed half-weight fallback', () => {
  assert.equal(parseEducationWeightOverride(undefined, 0.5), null);
  assert.equal(parseEducationWeightOverride('', 0.5), null);
  assert.equal(parseEducationWeightOverride('0.25', 0.5), 0.25);
  for (const value of ['0', '-0.25', '0.1', '0.5', 'NaN']) {
    assert.throws(
      () => parseEducationWeightOverride(value, 0.5),
      /must equal the pre-agreed half-weight fallback/,
    );
  }
});

test('Spearman uses average ranks for ties', () => {
  const baseline = new Map([['A', 10], ['B', 10], ['C', 5]]);
  const proposed = new Map([['A', 20], ['B', 20], ['C', 1]]);
  assert.equal(spearman(baseline, proposed), 1);
});

test('country-drift gate passes at 15 points and fails above 15', () => {
  const baseline = scorePass();
  const atLimit = scorePass();
  atLimit.get(universe[0])!.pc += 15;
  assert.equal(
    evaluateGates(baseline, atLimit, 'pc').find((gate) => gate.id === 'gate-2-country-drift')?.status,
    'pass',
  );

  const overLimit = scorePass();
  overLimit.get(universe[0])!.pc += 15.01;
  assert.equal(
    evaluateGates(baseline, overLimit, 'pc').find((gate) => gate.id === 'gate-2-country-drift')?.status,
    'fail',
  );
});

test('Spearman gate rejects an inverted ranking', () => {
  const baseline = scorePass();
  const proposed = new Map(
    [...baseline.entries()].map(([countryCode, row], index) => [
      countryCode,
      { ...row, pc: universe.length - index },
    ]),
  );
  const gate = evaluateGates(baseline, proposed, 'pc')
    .find((candidate) => candidate.id === 'gate-1-spearman');
  assert.equal(gate?.status, 'fail');
  assert.ok(gate!.evidence.spearman < 0.85);
});

test('cohort-median gate passes at 10 points and fails above 10', () => {
  const cohort = RESILIENCE_COHORTS.find((candidate) => candidate.countryCodes.length > 0)!;
  const baseline = scorePass();
  const atLimit = scorePass();
  for (const countryCode of cohort.countryCodes) atLimit.get(countryCode)!.pc += 10;
  assert.equal(
    evaluateGates(baseline, atLimit, 'pc').find((gate) => gate.id === 'gate-6-cohort-median')?.status,
    'pass',
  );

  const overLimit = scorePass();
  for (const countryCode of cohort.countryCodes) overLimit.get(countryCode)!.pc += 10.1;
  assert.equal(
    evaluateGates(baseline, overLimit, 'pc').find((gate) => gate.id === 'gate-6-cohort-median')?.status,
    'fail',
  );
});

test('matched-pair gate distinguishes flip regressions from pre-existing failures', () => {
  const baseline = scorePass();
  const proposed = scorePass();
  baseline.get('PT')!.pc = 60;
  baseline.get('UZ')!.pc = 50;
  proposed.get('PT')!.pc = 52;
  proposed.get('UZ')!.pc = 50;

  let pair = evaluateGates(baseline, proposed, 'pc')
    .find((gate) => gate.id === 'gate-7-matched-pair')
    ?.evidence.pairs.find((candidate) => candidate.pairId === 'pt-vs-uz');
  assert.equal(pair?.regression, true);
  assert.equal(pair?.preExisting, false);

  baseline.get('PT')!.pc = 52;
  pair = evaluateGates(baseline, proposed, 'pc')
    .find((gate) => gate.id === 'gate-7-matched-pair')
    ?.evidence.pairs.find((candidate) => candidate.pairId === 'pt-vs-uz');
  assert.equal(pair?.regression, false);
  assert.equal(pair?.preExisting, true);
});

test('acceptance verdict gates on the published active formula and retains legacy diagnostics', () => {
  const passingGates = [
    'gate-1-spearman',
    'gate-2-country-drift',
    'gate-6-cohort-median',
    'gate-7-matched-pair',
    'gate-9-effective-influence-baseline',
  ].map((id) => ({ id, status: 'pass', evidence: {} }));
  const legacyFailure = {
    id: 'gate-7-matched-pair',
    status: 'fail',
    evidence: { preExisting: ['de-vs-fr'], regressions: [] },
  };

  const summary = summarizeAcceptanceGates({
    pc: passingGates,
    d6: [legacyFailure],
  });
  assert.equal(summary.verdict, 'PASS');
  assert.deepEqual(summary.gatingFailures, []);
  assert.deepEqual(summary.nonGatingFailures, [legacyFailure]);

  const activeFailure = {
    id: 'gate-2-country-drift',
    status: 'fail',
    evidence: {},
  };
  assert.equal(summarizeAcceptanceGates({
    pc: passingGates.map((gate) => gate.id === activeFailure.id ? activeFailure : gate),
    d6: [passingGates[0]],
  }).verdict, 'FAIL');

  assert.throws(() => summarizeAcceptanceGates({}), /active pc acceptance gates/);
  assert.throws(() => summarizeAcceptanceGates({ pc: [] }), /active pc acceptance gates/);
  assert.throws(
    () => summarizeAcceptanceGates({ pc: passingGates.slice(0, -1) }),
    /active pc acceptance gates/,
  );
});

test('source-failure collection makes both passes and dimensions explicit', () => {
  const baseline = new Map([['FR', { sourceFailureDimensions: ['wgi', 'education'] }]]);
  const proposed = new Map([['FR', { sourceFailureDimensions: ['wgi'] }]]);
  assert.deepEqual(
    [...collectSourceFailures({ baseline, proposed }, ['FR']).entries()],
    [
      ['baseline:wgi', 1],
      ['baseline:education', 1],
      ['proposed:wgi', 1],
    ],
  );
});

test('source-failure validity guard remains fail-closed for every scored country', () => {
  const baseline = new Map([
    ['TW', {
      educationCoverage: 0,
      educationImputationClass: null,
      headlineEligible: false,
      sourceFailureDimensions: ['stateContinuity'],
    }],
  ]);
  const proposed = new Map([
    ['TW', {
      educationCoverage: 1,
      educationImputationClass: null,
      headlineEligible: false,
      sourceFailureDimensions: ['stateContinuity'],
    }],
  ]);

  const measurement = evaluateMeasurementInputs({
    baseline,
    proposed,
    countryCodes: ['TW'],
    expectedEducationCoverage: 1,
  });
  assert.equal(measurement.valid, false);
  assert.deepEqual([...measurement.sourceFailures.entries()], [
    ['baseline:stateContinuity', 1],
    ['proposed:stateContinuity', 1],
  ]);
  assert.deepEqual([...measurement.blockingSourceFailures.entries()], [
    ['baseline:stateContinuity', 1],
    ['proposed:stateContinuity', 1],
  ]);
});

test('measurement preconditions fail closed on unresolved, vacuous, contaminated, or failed inputs', () => {
  const cleanBaseline = new Map([
    ['FR', { educationCoverage: 0, educationImputationClass: null, sourceFailureDimensions: [] }],
  ]);
  const cleanProposed = new Map([
    ['FR', { educationCoverage: 1, educationImputationClass: null, sourceFailureDimensions: [] }],
  ]);
  const clean = evaluateMeasurementInputs({
    baseline: cleanBaseline,
    proposed: cleanProposed,
    countryCodes: ['FR'],
    expectedEducationCoverage: 1,
  });
  assert.equal(clean.valid, true);

  assert.equal(evaluateMeasurementInputs({
    baseline: cleanBaseline,
    proposed: cleanProposed,
    unresolvedEntries: ['resilience:key (timeout)'],
    countryCodes: ['FR'],
    expectedEducationCoverage: 1,
  }).valid, false);

  assert.equal(evaluateMeasurementInputs({
    baseline: cleanBaseline,
    proposed: new Map([['FR', { educationCoverage: 0.3, educationImputationClass: 'unmonitored', sourceFailureDimensions: [] }]]),
    countryCodes: ['FR'],
    expectedEducationCoverage: 1,
  }).valid, false);

  assert.equal(evaluateMeasurementInputs({
    baseline: new Map([['FR', { educationCoverage: 1, educationImputationClass: null, sourceFailureDimensions: [] }]]),
    proposed: cleanProposed,
    countryCodes: ['FR'],
    expectedEducationCoverage: 1,
  }).valid, false);

  assert.equal(evaluateMeasurementInputs({
    baseline: cleanBaseline,
    proposed: new Map([['FR', { educationCoverage: 1, educationImputationClass: null, sourceFailureDimensions: ['wgi'] }]]),
    countryCodes: ['FR'],
    expectedEducationCoverage: 1,
  }).valid, false);
});

test('gate 9 requires both Core coverage and a real 181-country education sample', () => {
  assert.equal(universe.length >= EXPECTED_EDUCATION_COVERAGE, true);
  const educationCodes = universe.slice(0, EXPECTED_EDUCATION_COVERAGE);
  const educationRule = {
    type: 'bulk-v1-country-value',
    key: 'resilience:education-attainment:v1',
  };
  const educationPayload = {
    countries: Object.fromEntries(educationCodes.map((countryCode) => [countryCode, { value: 50 }])),
  };
  const plan = [
    ...Array.from({ length: 5 }, (_, index) => ({
      indicator: `core-${index}`,
      tier: 'core',
      extractionStatus: index < 4 ? 'implemented' : 'not-implemented',
    })),
    {
      indicator: 'femaleUpperSecondaryAttainment',
      tier: 'experimental',
      extractionStatus: 'implemented',
    },
  ];

  const passing = evaluateExtractionCoverageGate({
    plan,
    educationRule,
    educationPayload,
    applyExtractionRule,
    countryCodes: universe,
  });
  assert.equal(passing.status, 'pass');
  assert.equal(passing.evidence.educationPairedSampleSize, EXPECTED_EDUCATION_COVERAGE);

  const missingSample = evaluateExtractionCoverageGate({
    plan,
    educationRule,
    educationPayload: { countries: {} },
    applyExtractionRule,
    countryCodes: universe,
  });
  assert.equal(missingSample.status, 'fail');

  const unimplementedEducation = evaluateExtractionCoverageGate({
    plan: plan.map((row) => row.indicator === 'femaleUpperSecondaryAttainment'
      ? { ...row, extractionStatus: 'not-implemented' }
      : row),
    educationRule,
    educationPayload,
    applyExtractionRule,
    countryCodes: universe,
  });
  assert.equal(unimplementedEducation.status, 'fail');
});

function readEducationAcceptanceArtifacts() {
  const filenames = readdirSync(new URL('../docs/snapshots/', import.meta.url))
    .filter((filename) => /^resilience-education-acceptance-\d{4}-\d{2}-\d{2}\.json$/.test(filename));
  return filenames.map((filename) => ({
    filename,
    artifact: JSON.parse(readFileSync(
      new URL(`../docs/snapshots/${filename}`, import.meta.url),
      'utf8',
    )),
  }));
}

function buildSyntheticAcceptanceArtifact(harnessCommitSha: string, harnessSha256: string) {
  const pairScores: Record<string, number> = {
    DE: 90, FR: 80,
    NO: 90, CA: 80,
    AE: 90, BH: 80,
    JP: 90, KR: 80,
    IN: 90, ZA: 80,
    CH: 90, SG: 80, TM: 70,
    PT: 90, UZ: 80,
    ES: 90, BY: 80,
  };
  const educationCountryCodes = universe.slice(0, EXPECTED_EDUCATION_COVERAGE);
  const observedEducation = new Set(educationCountryCodes);
  const baseline = new Map(universe.map((countryCode, index) => [countryCode, {
    pc: pairScores[countryCode] ?? 50 + index / 1_000,
    d6: pairScores[countryCode] ?? 50 + index / 1_000,
    educationCoverage: 0,
    educationImputationClass: null,
    sourceFailureDimensions: [],
  }]));
  const proposed = new Map([...baseline].map(([countryCode, row]) => [countryCode, {
    ...row,
    educationCoverage: observedEducation.has(countryCode) ? 1 : 0.3,
    educationImputationClass: observedEducation.has(countryCode) ? null : 'unmonitored',
  }]));
  const educationRule = {
    type: 'bulk-v1-country-value',
    key: 'resilience:education-attainment:v1',
  };
  const educationPayload = {
    countries: Object.fromEntries(educationCountryCodes.map((countryCode) => [countryCode, { value: 50 }])),
  };
  const plan = [
    ...Array.from({ length: 5 }, (_, index) => ({
      indicator: `core-${index}`,
      tier: 'core',
      extractionStatus: index < 4 ? 'implemented' : 'not-implemented',
    })),
    {
      indicator: 'femaleUpperSecondaryAttainment',
      tier: 'experimental',
      extractionStatus: 'implemented',
    },
  ];
  const results = {
    pc: [
      ...evaluateGates(baseline, proposed, 'pc'),
      evaluateExtractionCoverageGate({
        plan,
        educationRule,
        educationPayload,
        applyExtractionRule,
        countryCodes: universe,
      }),
    ],
    d6: evaluateGates(baseline, proposed, 'd6'),
  };
  const summary = summarizeAcceptanceGates(results);
  const keyDigests = {
    'resilience:education-attainment:v1': sha256(canonicalJson(educationPayload)),
  };

  return {
    schemaVersion: 2,
    measuredAt: '2026-08-13T00:01:00.000Z',
    capture: {
      source: 'production-seed-dry-run',
      activeFormula: 'pc',
      startedAt: '2026-08-13T00:00:00.000Z',
      completedAt: '2026-08-13T00:01:00.000Z',
      harness: 'scripts/dry-run-resilience-education-flip.mjs',
      harnessCommitSha,
      harnessSha256,
      redis: {
        source: 'production-upstash-redis-rest',
        resolvedKeyCount: 1,
        keyDigests,
        snapshotSha256: sha256(canonicalJson(keyDigests)),
      },
    },
    educationWeight: 0.5,
    shippedEducationWeight: 0.5,
    universeSize: universe.length,
    educationCoverageCountries: EXPECTED_EDUCATION_COVERAGE,
    sourceFailures: {},
    blockingSourceFailures: {},
    acceptanceGates: {
      verdict: summary.verdict,
      gatingFormula: 'pc',
      gates: results,
      nonGatingFailures: summary.nonGatingFailures,
    },
    scores: Object.fromEntries(universe.map((countryCode) => [countryCode, {
      baseline: baseline.get(countryCode),
      proposed: proposed.get(countryCode),
    }])),
  };
}

test('any committed education acceptance artifacts are internally consistent', () => {
  for (const { filename, artifact } of readEducationAcceptanceArtifacts()) {
    const validation = validateEducationAcceptanceArtifact(artifact, { filename });
    assert.equal(validation.verdict, 'PASS');
    assert.equal(validation.activeFormula, 'pc');
    assert.equal(validation.universeSize, universe.length);
    assert.equal(validation.educationCoverageCountries, EXPECTED_EDUCATION_COVERAGE);
  }
});

test('artifact validator rejects inconsistent verdicts, scores, gate 9 inputs, provenance, and weights', () => {
  const filename = 'resilience-education-acceptance-2026-08-13.json';
  const harnessCommitSha = execFileSync(
    'git',
    ['log', '-1', '--format=%H', '--', 'scripts/dry-run-resilience-education-flip.mjs'],
    { encoding: 'utf8' },
  ).trim();
  const harnessSource = execFileSync(
    'git',
    ['show', `${harnessCommitSha}:scripts/dry-run-resilience-education-flip.mjs`],
  );
  const original = buildSyntheticAcceptanceArtifact(harnessCommitSha, sha256(harnessSource));
  assert.equal(validateEducationAcceptanceArtifact(original, { filename }).verdict, 'PASS');
  type AcceptancePairFixture = {
    pairId: string;
    gap: number;
    minGap: number;
  };
  type AcceptanceGateFixture = {
    id: string;
    status: string;
    evidence: {
      spearman?: number;
      topMovers?: Array<{ delta: number }>;
      pairs?: AcceptancePairFixture[];
    };
  };
  const findGate = (
    artifact: ReturnType<typeof buildSyntheticAcceptanceArtifact>,
    formula: 'pc' | 'd6',
    id: string,
  ): AcceptanceGateFixture => (
    (artifact.acceptanceGates.gates[formula] as AcceptanceGateFixture[])
      .find((candidate) => candidate.id === id)!
  );
  const findNoVsCa = (
    artifact: ReturnType<typeof buildSyntheticAcceptanceArtifact>,
    formula: 'pc' | 'd6',
  ): AcceptancePairFixture => (
    findGate(artifact, formula, 'gate-7-matched-pair').evidence.pairs!
      .find((pair) => pair.pairId === 'no-vs-ca')!
  );
  const mutate = (change: (artifact: ReturnType<typeof buildSyntheticAcceptanceArtifact>) => void) => {
    const artifact = structuredClone(original);
    change(artifact);
    return () => validateEducationAcceptanceArtifact(artifact, { filename });
  };
  const artifactPathPattern = String.raw`docs/snapshots/resilience-education-acceptance-\d{4}-\d{2}-\d{2}\.json`;
  const productionRecaptureCommandPattern = String.raw`DRY_RUN_OUTPUT=docs/snapshots/resilience-education-acceptance-\$\(date -u \+%F\)\.json node --import tsx/esm scripts/dry-run-resilience-education-flip\.mjs`;
  const actionableArtifactMutation = new RegExp(
    `${artifactPathPattern}; re-capture against production seeds with: ${productionRecaptureCommandPattern}`,
  );

  const outcomeNeutralThresholdEdit = structuredClone(original);
  const noVsCa = findNoVsCa(outcomeNeutralThresholdEdit, 'pc');
  noVsCa.minGap += 1;
  assert.equal(
    validateEducationAcceptanceArtifact(outcomeNeutralThresholdEdit, { filename }).verdict,
    'PASS',
  );

  const d6OutcomeNeutralThresholdEdit = structuredClone(original);
  const d6NoVsCa = findNoVsCa(d6OutcomeNeutralThresholdEdit, 'd6');
  d6NoVsCa.minGap += 1;
  assert.equal(
    validateEducationAcceptanceArtifact(d6OutcomeNeutralThresholdEdit, { filename }).verdict,
    'PASS',
  );

  const nonGatingFailureArtifact = structuredClone(original);
  for (const [countryCode, row] of Object.entries(nonGatingFailureArtifact.scores)) {
    if (countryCode === 'US') row.proposed.d6 += 20;
  }
  const d6Baseline = new Map(
    Object.entries(nonGatingFailureArtifact.scores).map(([countryCode, row]) => [countryCode, row.baseline]),
  );
  const d6Proposed = new Map(
    Object.entries(nonGatingFailureArtifact.scores).map(([countryCode, row]) => [countryCode, row.proposed]),
  );
  const d6Gates = evaluateGates(d6Baseline, d6Proposed, 'd6');
  nonGatingFailureArtifact.acceptanceGates.gates.d6 = d6Gates;
  const nonGatingSummary = summarizeAcceptanceGates(nonGatingFailureArtifact.acceptanceGates.gates);
  nonGatingFailureArtifact.acceptanceGates.nonGatingFailures = structuredClone(nonGatingSummary.nonGatingFailures);
  nonGatingFailureArtifact.acceptanceGates.nonGatingFailures[0].detail = 'capture wording changed without changing the outcome';
  assert.equal(
    validateEducationAcceptanceArtifact(nonGatingFailureArtifact, { filename }).verdict,
    'PASS',
  );

  assert.throws(
    mutate((artifact) => { artifact.acceptanceGates.verdict = 'FAIL'; }),
    actionableArtifactMutation,
  );

  assert.throws(
    mutate((artifact) => {
      findGate(artifact, 'pc', 'gate-1-spearman').status = 'fail';
    }),
    actionableArtifactMutation,
  );

  assert.throws(
    mutate((artifact) => {
      findGate(artifact, 'pc', 'gate-1-spearman').evidence.spearman = 0.99;
    }),
    actionableArtifactMutation,
  );

  assert.throws(
    mutate((artifact) => {
      const pair = findNoVsCa(artifact, 'pc');
      pair.minGap = pair.gap + 1;
    }),
    actionableArtifactMutation,
  );

  assert.throws(
    mutate((artifact) => {
      findGate(artifact, 'pc', 'gate-2-country-drift').evidence.topMovers![0].delta = 1;
    }),
    actionableArtifactMutation,
  );

  assert.throws(
    mutate((artifact) => { artifact.scores.US.proposed.pc += 20; }),
    actionableArtifactMutation,
  );

  assert.throws(
    mutate((artifact) => {
      const gate = artifact.acceptanceGates.gates.pc
        .find((candidate) => candidate.id === 'gate-9-effective-influence-baseline');
      gate.evidence.coreImplemented = 0;
    }),
    actionableArtifactMutation,
  );

  assert.throws(
    mutate((artifact) => { delete artifact.capture.redis.snapshotSha256; }),
    /capture provenance is malformed/,
  );

  assert.throws(
    mutate((artifact) => { artifact.educationWeight = 0.25; }),
    /shipped education weight/,
  );

  assert.throws(
    mutate((artifact) => {
      const gate = artifact.acceptanceGates.gates.pc
        .find((candidate) => candidate.id === 'gate-9-effective-influence-baseline');
      gate.evidence.educationCountryCodes = universe.slice(-EXPECTED_EDUCATION_COVERAGE);
    }),
    /gate 9 education cohort/,
  );
});
