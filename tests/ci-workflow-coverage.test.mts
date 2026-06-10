import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = resolve(root, '.github/workflows');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const packageScripts = packageJson.scripts ?? {};
const deployGateWorkflow = readFileSync(resolve(workflowsDir, 'deploy-gate.yml'), 'utf8');
const testWorkflow = readFileSync(resolve(workflowsDir, 'test.yml'), 'utf8');
const workflowText = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => readFileSync(resolve(workflowsDir, name), 'utf8'))
  .join('\n');

const REQUIRED_PR_SCRIPTS = [
  'test:data',
  'test:sidecar',
  'test:convex',
  'test:e2e:variant-smoke:full',
  'test:resilience-validation-smoke',
] as const;

const REQUIRED_TEST_JOBS = [
  'unit',
  'sidecar',
  'convex-tests',
  'variant-smoke-full',
  'resilience-validation-smoke',
] as const;

const TIMEOUT_CAPPED_TEST_JOBS = [
  'sidecar',
  'convex-tests',
  'variant-smoke-full',
  'resilience-validation-smoke',
] as const;

const REQUIRED_GATE_WORKFLOWS = ['Test', 'Typecheck', 'Lint Code'] as const;

const REQUIRED_NON_TEST_GATE_CHECKS = [
  'typecheck',
  'biome',
] as const;

const REQUIRED_RESILIENCE_VALIDATION_INPUTS = [
  'Dockerfile.seed-bundle-resilience-validation',
  'docs/methodology/country-resilience-index/validation/',
  'scripts/benchmark-resilience-external.mjs',
  'scripts/backtest-resilience-outcomes.mjs',
  'scripts/validate-resilience-sensitivity.mjs',
  'scripts/seed-bundle-resilience-validation.mjs',
  'scripts/_bundle-runner.mjs',
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function workflowRegexNeedle(path: string): string {
  return path.replaceAll('/', '\\/').replaceAll('.', '\\.');
}

function testJobBlock(job: string): string {
  const match = testWorkflow.match(new RegExp(`\\n  ${escapeRegExp(job)}:\\n[\\s\\S]*?(?=\\n  [\\w-]+:\\n|\\n$)`));
  assert.ok(match, `test.yml must define ${job}`);
  return match[0];
}

function parseJsonArrayLiteral(source: string, regex: RegExp, label: string): string[] {
  const match = source.match(regex);
  assert.ok(match?.[1], `deploy-gate.yml must define ${label}`);
  const parsed = JSON.parse(match[1]);
  assert.ok(Array.isArray(parsed), `${label} must be a JSON array`);
  for (const value of parsed) {
    assert.equal(typeof value, 'string', `${label} entries must be strings`);
  }
  return parsed;
}

function deployGateRequiredChecks(): string[] {
  return parseJsonArrayLiteral(deployGateWorkflow, /\n\s*required='(\[[^\n]+])'/, 'required checks');
}

function deployGateWorkflowRunNames(): string[] {
  return parseJsonArrayLiteral(deployGateWorkflow, /workflows:\s*(\[[^\n]+])/, 'workflow_run workflows');
}

describe('CI workflow coverage', () => {
  it('keeps required PR smoke scripts defined and wired into workflows', () => {
    for (const script of REQUIRED_PR_SCRIPTS) {
      assert.equal(typeof packageScripts[script], 'string', `package.json must define ${script}`);
      assert.match(
        workflowText,
        new RegExp(`npm\\s+run\\s+${escapeRegExp(script)}(?:\\s|$)`),
        `A workflow must run npm run ${script}`,
      );
    }
  });

  it('keeps the main Test workflow jobs for defensibility smoke gates', () => {
    for (const job of REQUIRED_TEST_JOBS) {
      assert.match(testWorkflow, new RegExp(`\\n  ${escapeRegExp(job)}:\\n`), `test.yml must define ${job}`);
    }
  });

  it('keeps required smoke jobs capped with explicit timeouts', () => {
    for (const job of TIMEOUT_CAPPED_TEST_JOBS) {
      assert.match(testJobBlock(job), /\n {4}timeout-minutes: \d+\n/, `${job} must set timeout-minutes`);
    }
  });

  it('keeps the deploy gate wired to every required PR smoke gate', () => {
    const workflowRunNames = deployGateWorkflowRunNames();
    const requiredChecks = deployGateRequiredChecks();

    for (const workflowName of REQUIRED_GATE_WORKFLOWS) {
      assert.ok(
        workflowRunNames.includes(workflowName),
        `deploy-gate.yml must run after ${workflowName} completes`,
      );
    }
    for (const job of REQUIRED_TEST_JOBS) {
      assert.ok(requiredChecks.includes(job), `deploy-gate.yml must require the test.yml job ${job}`);
    }
    for (const check of REQUIRED_NON_TEST_GATE_CHECKS) {
      assert.ok(requiredChecks.includes(check), `deploy-gate.yml must require ${check}`);
    }
    assert.match(
      deployGateWorkflow,
      /All required PR gates passed/,
      'deploy-gate.yml success status must describe the full gate set',
    );
    assert.doesNotMatch(
      deployGateWorkflow,
      /unit \+ typecheck/i,
      'deploy-gate.yml must not regress to the old unit+typecheck-only gate',
    );
  });

  it('treats sidecar changes as code for PR smoke gating', () => {
    assert.ok(
      testWorkflow.includes('^src-tauri\\/sidecar\\/'),
      'test.yml must not classify src-tauri/sidecar changes as docs-only changes',
    );
  });

  it('keeps resilience validation bundle inputs in the CI change filter', () => {
    assert.ok(
      testWorkflow.includes('validation: ${{ steps.diff.outputs.validation }}'),
      'test.yml must expose a validation change output',
    );
    for (const input of REQUIRED_RESILIENCE_VALIDATION_INPUTS) {
      assert.ok(testWorkflow.includes(workflowRegexNeedle(input)), `test.yml must cover ${input}`);
    }
  });
});
