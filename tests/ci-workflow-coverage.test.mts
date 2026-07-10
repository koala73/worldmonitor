import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const deployGateWorkflow = read(resolve(workflowsDir, 'deploy-gate.yml'));
const securityAuditWorkflow = read(resolve(workflowsDir, 'security-audit.yml'));
const securityAuditScript = read(resolve(root, '.github/scripts/audit-production-dependencies.mjs'));
const testWorkflow = read(resolve(workflowsDir, 'test.yml'));
const lintCodeWorkflow = read(resolve(workflowsDir, 'lint-code.yml'));
const workflowText = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => read(resolve(workflowsDir, name)))
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
  'consumer-prices',
  'sidecar',
  'convex-tests',
  'variant-smoke-full',
  'resilience-validation-smoke',
] as const;

const REQUIRED_GATE_WORKFLOWS = ['Test', 'Typecheck', 'Lint Code', 'Security Audit'] as const;

const REQUIRED_NON_TEST_GATE_CHECKS = [
  'typecheck',
  'biome',
  'public-docs',
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

function workflowJobBlock(workflow: string, job: string): string {
  const match = workflow.match(new RegExp(`\\n  ${escapeRegExp(job)}:\\n[\\s\\S]*?(?=\\n  [\\w-]+:\\n|\\n$)`));
  assert.ok(match, `workflow must define ${job}`);
  return match[0];
}

function testWorkflowJobNames(): string[] {
  const jobs: string[] = [];
  let inJobs = false;

  for (const line of testWorkflow.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^\S[^:]*:\s*$/.test(line)) {
      break;
    }
    const match = inJobs ? line.match(/^ {2}([A-Za-z0-9_-]+):(?:\s|$)/) : null;
    if (match?.[1]) {
      jobs.push(match[1]);
    }
  }

  assert.ok(jobs.length > 0, 'test.yml must define at least one job under jobs:');
  return jobs;
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

function collectPackageLockfiles(): string[] {
  return execFileSync('git', ['ls-files', '*package-lock.json'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
}

function collectDockerfiles(): string[] {
  return execFileSync('git', ['ls-files', '*Dockerfile*'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /(^|\/)Dockerfile(\.|$)/.test(file))
    .sort();
}

function securityAuditMatrixLockfiles(): string[] {
  return Array.from(securityAuditWorkflow.matchAll(/^\s+lockfile:\s+(.+)$/gm), ([, value]) =>
    value.trim().replace(/^['"]|['"]$/g, ''),
  ).sort();
}

describe('CI workflow coverage', () => {
  it('runs the public documentation boundary on docs-only pull requests', () => {
    const publicDocsJob = workflowJobBlock(lintCodeWorkflow, 'public-docs');

    assert.match(publicDocsJob, /npm run lint:public-docs/);
    assert.doesNotMatch(publicDocsJob, /needs: changes/);
  });

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

  it('keeps the deploy gate wired to every Test workflow check job', () => {
    const workflowRunNames = deployGateWorkflowRunNames();
    const requiredChecks = deployGateRequiredChecks();

    for (const workflowName of REQUIRED_GATE_WORKFLOWS) {
      assert.ok(
        workflowRunNames.includes(workflowName),
        `deploy-gate.yml must run after ${workflowName} completes`,
      );
    }
    for (const job of testWorkflowJobNames()) {
      assert.ok(
        requiredChecks.includes(job),
        `deploy-gate.yml must require every test.yml job; missing ${job}`,
      );
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

  it('runs scheduled and per-PR production dependency audits for every package lockfile', () => {
    const packageLockfiles = collectPackageLockfiles();

    assert.match(securityAuditWorkflow, /\n {2}pull_request:\n/, 'security-audit.yml must run on PRs');
    assert.match(securityAuditWorkflow, /\n {2}push:\n {4}branches: \[main\]\n/, 'security-audit.yml must run on main pushes');
    assert.match(securityAuditWorkflow, /\n {2}schedule:\n/, 'security-audit.yml must run on a schedule');
    assert.match(securityAuditWorkflow, /\n {2}security-audit:\n/, 'security-audit.yml must define the aggregate security-audit check');
    assert.match(securityAuditWorkflow, /\n {4}name: security-audit\n/, 'security-audit.yml must publish a security-audit check run');
    assert.match(
      securityAuditWorkflow,
      /if:\s*\$\{\{\s*always\(\)\s*\}\}/,
      'security-audit.yml must always publish the aggregate check',
    );
    assert.match(
      securityAuditWorkflow,
      /AUDIT_RESULT"\s*=\s*"cancelled"/,
      'security-audit.yml must publish a failing aggregate check when the audit matrix is cancelled',
    );
    assert.match(
      securityAuditWorkflow,
      /--package-json "\$\{\{ matrix\.package_json \}\}"/,
      'security-audit.yml must pass nonstandard package manifests to the audit gate',
    );
    assert.match(
      securityAuditWorkflow,
      /node \.github\/scripts\/audit-production-dependencies\.mjs/,
      'security-audit.yml must run the production dependency audit gate',
    );
    assert.match(
      securityAuditScript,
      /npm['"],\s*\[\s*['"]audit['"],\s*['"]--omit=dev['"],\s*['"]--json['"]/,
      'the production dependency audit gate must run npm audit --omit=dev --json',
    );
    assert.match(
      securityAuditScript,
      /collectUnbaselinedFindings/,
      'the production dependency audit gate must fail on unbaselined high-severity production advisories',
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

  it('keeps Docker base images pinned to immutable digests', () => {
    const failures: string[] = [];

    for (const dockerfile of collectDockerfiles()) {
      const aliases = new Set<string>();
      const source = readFileSync(resolve(root, dockerfile), 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, index) => {
        const match = line.match(/^FROM\s+(.+)$/i);
        if (!match) return;

        const parts = match[1].trim().split(/\s+/);
        while (parts[0]?.startsWith('--')) {
          parts.shift();
        }

        const image = parts[0];
        const asIndex = parts.findIndex((part) => part.toUpperCase() === 'AS');
        const alias = asIndex >= 0 ? parts[asIndex + 1] : undefined;
        const isKnownStage = image ? aliases.has(image) : false;
        if (alias) {
          aliases.add(alias);
        }

        if (!image || image === 'scratch' || isKnownStage) return;

        if (!/@sha256:[0-9a-f]{64}$/i.test(image)) {
          failures.push(`${dockerfile}:${index + 1} ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      failures,
      [],
      `Docker FROM images must be pinned with full @sha256:<64 hex> digests:\n${failures.join('\n')}`,
    );
  });

  it('keeps GitHub Actions external uses pinned to commit SHAs', () => {
    const failures: string[] = [];
    const workflowFiles = readdirSync(workflowsDir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .sort();

    for (const workflowFile of workflowFiles) {
      const source = readFileSync(resolve(workflowsDir, workflowFile), 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, index) => {
        const match = line.match(/^\s*uses:\s*([^@\s#]+)@([^\s#]+)/);
        if (!match) return;

        const [, action, ref] = match;
        if (action.startsWith('./') || action.startsWith('docker://')) return;

        if (!/^[0-9a-f]{40}$/i.test(ref)) {
          failures.push(`${workflowFile}:${index + 1} ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      failures,
      [],
      `GitHub Actions uses refs must be 40-character commit SHAs:\n${failures.join('\n')}`,
    );
  });
});
