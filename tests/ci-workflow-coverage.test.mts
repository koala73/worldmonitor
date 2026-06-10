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
const securityAuditWorkflow = readFileSync(resolve(workflowsDir, 'security-audit.yml'), 'utf8');
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

const REQUIRED_GATE_CHECKS = [
  'unit',
  'typecheck',
  'sidecar',
  'convex-tests',
  'variant-smoke-full',
  'resilience-validation-smoke',
  'security-audit',
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

function collectPackageLockfiles(relativeDir = ''): string[] {
  const ignoredDirs = new Set(['.git', '.worktrees', 'node_modules', 'dist', 'build', 'coverage', '.vercel']);
  const dir = resolve(root, relativeDir);
  const lockfiles: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        lockfiles.push(...collectPackageLockfiles(relativeDir ? `${relativeDir}/${entry.name}` : entry.name));
      }
      continue;
    }

    if (entry.isFile() && entry.name === 'package-lock.json') {
      lockfiles.push(relativeDir ? `${relativeDir}/package-lock.json` : 'package-lock.json');
    }
  }

  return lockfiles.sort();
}

function securityAuditMatrixLockfiles(): string[] {
  return Array.from(securityAuditWorkflow.matchAll(/^\s+lockfile:\s+(.+)$/gm), ([, value]) =>
    value.trim().replace(/^['"]|['"]$/g, ''),
  ).sort();
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
      assert.match(testJobBlock(job), /\n    timeout-minutes: \d+\n/, `${job} must set timeout-minutes`);
    }
  });

  it('keeps the deploy gate wired to every required PR smoke gate', () => {
    assert.match(
      deployGateWorkflow,
      /workflows:\s*\["Test",\s*"Typecheck",\s*"Security Audit"\]/,
      'deploy-gate.yml must run after Test, Typecheck, and Security Audit workflows',
    );
    for (const check of REQUIRED_GATE_CHECKS) {
      assert.match(
        deployGateWorkflow,
        new RegExp(`["']${escapeRegExp(check)}["']`),
        `deploy-gate.yml must require ${check}`,
      );
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

  it('runs scheduled and per-PR production dependency audits for every package lockfile', () => {
    const packageLockfiles = collectPackageLockfiles();

    assert.match(securityAuditWorkflow, /\n  pull_request:\n/, 'security-audit.yml must run on PRs');
    assert.match(securityAuditWorkflow, /\n  push:\n    branches: \[main\]\n/, 'security-audit.yml must run on main pushes');
    assert.match(securityAuditWorkflow, /\n  schedule:\n/, 'security-audit.yml must run on a schedule');
    assert.match(securityAuditWorkflow, /\n  security-audit:\n/, 'security-audit.yml must define the aggregate security-audit check');
    assert.match(securityAuditWorkflow, /\n    name: security-audit\n/, 'security-audit.yml must publish a security-audit check run');
    assert.match(
      securityAuditWorkflow,
      /npm audit --omit=dev --audit-level=high/,
      'security-audit.yml must block high-severity production dependency vulnerabilities',
    );
    assert.deepEqual(
      securityAuditMatrixLockfiles(),
      packageLockfiles,
      'security-audit.yml must cover exactly the repo package-lock.json files',
    );

    for (const lockfile of packageLockfiles) {
      assert.match(
        securityAuditWorkflow,
        new RegExp(`\\n\\s+lockfile:\\s+${escapeRegExp(lockfile)}\\n`),
        `security-audit.yml must cover ${lockfile}`,
      );
    }
  });
});
