/**
 * #4865 — free/anon users flooded the premium-gated classify-event endpoint
 * (~95k tier_403/day from signed-in free users with NO 403 backoff, plus
 * ~475k/day anon 401s from the retry loop) after #4779 premium-gated it
 * server-side without a client-side entitlement gate.
 *
 * Two layers under test:
 *   1. src/services/classify-gate.ts — pure session gate (probe + timed
 *      suppression), node-test-safe (threat-classifier itself imports
 *      @/utils and cannot be loaded under tsx --test).
 *   2. Source-grep wiring assertions on threat-classifier.ts — the gate is
 *      only effective if the enqueue path consults it and the 403 branch
 *      suppresses + drains (the project's source-grep regression pattern).
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canAttemptAiClassification,
  configureClassifyGate,
  suppressAiClassification,
  CLASSIFY_SUPPRESS_MS,
  __resetClassifyGateForTests,
} from '../src/services/classify-gate.ts';

describe('classify-gate — entitlement probe + timed suppression', () => {
  beforeEach(() => {
    __resetClassifyGateForTests();
  });

  it('allows by default when no probe is configured (fail-open; server still gates)', () => {
    assert.equal(canAttemptAiClassification(), true);
  });

  it('denies when the probe reports not entitled', () => {
    configureClassifyGate(() => false);
    assert.equal(canAttemptAiClassification(), false);
  });

  it('allows when the probe reports entitled', () => {
    configureClassifyGate(() => true);
    assert.equal(canAttemptAiClassification(), true);
  });

  it('fails OPEN when the probe throws — a gating bug must not silence Pro classification', () => {
    configureClassifyGate(() => { throw new Error('gating module exploded'); });
    assert.equal(canAttemptAiClassification(), true);
  });

  it('suppression denies even an entitled probe for the full window', () => {
    configureClassifyGate(() => true);
    const t0 = 1_000_000;
    suppressAiClassification(t0);
    assert.equal(canAttemptAiClassification(t0), false);
    assert.equal(canAttemptAiClassification(t0 + CLASSIFY_SUPPRESS_MS - 1), false);
  });

  it('suppression expires after the window — self-heals a mid-session upgrade without event plumbing', () => {
    configureClassifyGate(() => true);
    const t0 = 1_000_000;
    suppressAiClassification(t0);
    assert.equal(canAttemptAiClassification(t0 + CLASSIFY_SUPPRESS_MS), true);
  });

  it('post-suppression attempts still consult the probe (free user stays denied)', () => {
    configureClassifyGate(() => false);
    const t0 = 1_000_000;
    suppressAiClassification(t0);
    assert.equal(canAttemptAiClassification(t0 + CLASSIFY_SUPPRESS_MS), false);
  });

  it('suppression window is long enough to matter (>= 5 minutes)', () => {
    // The flood ran at ~1 request per ~2s per user; the suppression window is
    // the worst-case retry cadence under persistent signal drift. Guard the
    // constant so a refactor can't quietly turn it back into a hot loop.
    assert.ok(CLASSIFY_SUPPRESS_MS >= 5 * 60_000, `window too short: ${CLASSIFY_SUPPRESS_MS}`);
  });
});

describe('threat-classifier wiring (source-grep — module not loadable under node:test)', () => {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(dirname, '..', 'src', 'services', 'threat-classifier.ts'),
    'utf8',
  );

  it('enqueue path consults canAttemptAiClassification() before queueing', () => {
    const uncached = src.slice(src.indexOf('function classifyWithAIUncached'));
    const gateIdx = uncached.indexOf('canAttemptAiClassification()');
    const pushIdx = uncached.indexOf('batchQueue.push');
    assert.ok(gateIdx > -1, 'classifyWithAIUncached must call canAttemptAiClassification()');
    assert.ok(pushIdx > -1, 'expected batchQueue.push in classifyWithAIUncached');
    assert.ok(gateIdx < pushIdx, 'the gate must run BEFORE the job is queued');
  });

  it('batch loop handles 403 by suppressing + draining (never retrying)', () => {
    assert.match(src, /statusCode === 403/, 'must branch on 403 explicitly');
    const branch = src.slice(src.indexOf('statusCode === 403'));
    assert.ok(
      branch.indexOf('suppressAiClassification()') > -1 &&
        branch.indexOf('suppressAiClassification()') < branch.indexOf('statusCode === 401'),
      '403 branch must call suppressAiClassification()',
    );
    assert.ok(
      branch.indexOf('batchQueue.splice(0)') > -1 &&
        branch.indexOf('batchQueue.splice(0)') < branch.indexOf('statusCode === 401'),
      '403 branch must drain the entire queue (resolve nulls → keyword fallback)',
    );
  });

  it('gate probe is wired to hasPremiumAccess (dual-signal entitlement)', () => {
    assert.match(src, /configureClassifyGate\(\s*\(\)\s*=>\s*hasPremiumAccess\(\)/);
  });
});
