import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { WEEK } from '../scripts/_bundle-runner.mjs';
import {
  RESILIENCE_VALIDATION_BUNDLE_MEMBERS,
  RESILIENCE_VALIDATION_BUNDLE_NAME,
} from '../scripts/resilience-validation-bundle.mjs';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

const EXPECTED_MEMBERS = [
  { label: 'External-Benchmark', script: 'benchmark-resilience-external.mjs', timeoutMs: 300_000 },
  { label: 'Outcome-Backtest', script: 'backtest-resilience-outcomes.mjs', timeoutMs: 300_000 },
  { label: 'Sensitivity-Suite', script: 'validate-resilience-sensitivity.mjs', timeoutMs: 600_000 },
];

describe('resilience validation bundle contract', () => {
  it('runs the three required validation members in the declared order', () => {
    assert.equal(RESILIENCE_VALIDATION_BUNDLE_NAME, 'resilience-validation');
    assert.deepEqual(
      RESILIENCE_VALIDATION_BUNDLE_MEMBERS.map(({ label, script, timeoutMs }) => ({ label, script, timeoutMs })),
      EXPECTED_MEMBERS,
    );
  });

  it('schedules every validation member weekly without seed metadata', () => {
    for (const member of RESILIENCE_VALIDATION_BUNDLE_MEMBERS) {
      assert.equal(member.intervalMs, WEEK, `${member.label} must use the weekly bundle interval`);
      assert.equal('seedMetaKey' in member, false, `${member.label} is validation-only and must not emit a seed heartbeat`);
    }
  });

  it('references executable member scripts', () => {
    for (const member of RESILIENCE_VALIDATION_BUNDLE_MEMBERS) {
      assert.equal(existsSync(join(scriptsDir, member.script)), true, `${member.script} must exist`);
    }
  });
});
