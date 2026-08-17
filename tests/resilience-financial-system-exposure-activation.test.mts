import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ACCEPTANCE_ARTIFACT_TYPE,
  buildAcceptanceArtifact,
  evaluateGates,
  normalizeProductionRead,
  validateAcceptanceArtifact,
} from '../scripts/dry-run-resilience-financial-system-exposure-flip.mjs';

function rows(values: Record<string, number>) {
  return new Map(Object.entries(values).map(([countryCode, pc]) => [countryCode, {
    pc,
    d6: pc,
    headlineEligible: true,
    overallCoverage: 0.8,
    financialSystemExposure: {
      score: 50,
      coverage: 0.65,
      observedWeight: 0.65,
      imputedWeight: 0,
      imputationClass: null,
    },
    sourceFailureDimensions: [],
  }]));
}

test('finance activation gates allow the documented sanctions exception only', () => {
  const baseline = rows({ US: 60, RU: 50, TD: 40, CA: 30, GB: 20 });
  const proposed = rows({ US: 59, RU: 36, TD: 35, CA: 29, GB: 19 });
  const result = evaluateGates({
    baseline,
    proposed,
    sanctionsCountryCodes: new Set(['RU']),
  });

  assert.equal(result.verdict, 'PASS');
  assert.equal(result.gates.find((gate) => gate.id === 'gate-1-spearman')?.status, 'pass');
  assert.equal(result.gates.find((gate) => gate.id === 'gate-2-bounded-movement')?.status, 'pass');
  assert.equal(result.gates.find((gate) => gate.id === 'gate-3-headline-eligibility')?.status, 'pass');
});

test('acceptance artifacts recompute their gates and preserve cache-generation evidence', () => {
  const baseline = rows({ US: 60, RU: 50, TD: 40, CA: 30, GB: 20 });
  const proposed = rows({ US: 59, RU: 36, TD: 35, CA: 29, GB: 19 });
  const keyDigests = { 'seed-meta:resilience:static': 'b'.repeat(64) };
  const snapshotSha256 = createHash('sha256').update(JSON.stringify(keyDigests)).digest('hex');
  const artifact = buildAcceptanceArtifact({
    measuredAt: '2026-08-13T00:00:00.000Z',
    capture: {
      source: 'production-upstash-redis-rest',
      activeFormula: 'pc',
      harness: 'scripts/dry-run-resilience-financial-system-exposure-flip.mjs',
      harnessCommitSha: '0123456789abcdef0123456789abcdef01234567',
      harnessSha256: 'a'.repeat(64),
      redis: {
        source: 'production-upstash-redis-rest',
        resolvedKeyCount: 1,
        keyDigests,
        snapshotSha256,
      },
    },
    baseline,
    proposed,
    sanctionsCountryCodes: new Set(['RU']),
    cacheNamespaces: {
      score: 'resilience:score:v28:',
      ranking: 'resilience:ranking:v28',
      history: 'resilience:history:v22:',
      intervals: 'resilience:intervals:v11:',
    },
  });

  assert.equal(artifact.artifactType, ACCEPTANCE_ARTIFACT_TYPE);
  assert.equal(validateAcceptanceArtifact(artifact), 'PASS');
});

test('production reads preserve the WB debt envelope required by the fail-closed scorer', () => {
  const envelope = {
    _seed: { fetchedAt: 1, schemaVersion: 2 },
    data: { countries: { US: { value: 1 } }, nonDrsCountryCodes: ['AD'] },
  };

  assert.deepEqual(
    normalizeProductionRead('economic:wb-external-debt:v1', envelope),
    envelope,
  );
  assert.deepEqual(
    normalizeProductionRead('economic:bis-lbs:v1', envelope),
    envelope.data,
  );
});

test('the committed production acceptance artifact is internally consistent', () => {
  const artifact = JSON.parse(readFileSync(
    new URL('../docs/snapshots/resilience-financial-system-exposure-acceptance-2026-08-13.json', import.meta.url),
    'utf8',
  ));

  assert.equal(validateAcceptanceArtifact(artifact), 'PASS');
  assert.deepEqual(artifact.capture.cacheNamespaces, {
    score: 'resilience:score:v28:',
    ranking: 'resilience:ranking:v28',
    history: 'resilience:history:v22:',
    intervals: 'resilience:intervals:v11:',
  });
  assert.equal(artifact.capture.redis.resolvedKeyCount, 650);
  assert.equal(artifact.acceptanceGates.gates[0].evidence.spearman >= 0.998, true);
  assert.equal(artifact.acceptanceGates.gates[1].evidence.underThreeCount, 196);
  assert.equal(artifact.acceptanceGates.gates[1].evidence.maxAbsDelta < 2.24, true);
  assert.equal(artifact.acceptanceGates.gates[2].evidence.changes.length, 0);
  const harnessSha256 = createHash('sha256')
    .update(readFileSync(new URL('../scripts/dry-run-resilience-financial-system-exposure-flip.mjs', import.meta.url)))
    .digest('hex');
  assert.equal(artifact.capture.harnessSha256, harnessSha256);
});
