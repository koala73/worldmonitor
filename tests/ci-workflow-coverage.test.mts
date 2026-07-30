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

// Jobs the deploy gate cannot require under their own name, and the check that
// blocks on their behalf instead. A matrix job publishes one check run per
// matrix entry (`audit-lockfile (root)`, `audit-lockfile (scripts)`, …) and
// never the bare job id, so listing the id in `required` would leave the gate
// waiting on a check run that is never published — pending forever, which
// deadlocks every PR. The `if: always()` aggregate job publishes the single
// blocking check for the whole matrix instead.
//
// An entry here is honoured only when both halves still hold: the job's `name:`
// is a template expression (so it structurally cannot be matched by id), and
// the covering check is itself a required gate check. That keeps this table
// from becoming a way to quietly drop a job out of the gate.
const GATE_CHECK_EXEMPTIONS: Record<string, { workflow: string; coveredBy: string }> = {
  'audit-lockfile': { workflow: 'Security Audit', coveredBy: 'security-audit' },
};

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

function workflowJobNames(workflow: string, label: string): string[] {
  const jobs: string[] = [];
  let inJobs = false;

  for (const line of workflow.split('\n')) {
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

  assert.ok(jobs.length > 0, `${label} must define at least one job under jobs:`);
  return jobs;
}

// Maps a workflow's display name (`name:` at column 0) to its source, so the
// gate checks below key off the same names deploy-gate.yml's `workflow_run`
// trigger uses rather than a hand-maintained name-to-filename table.
//
// Two workflows sharing a display name would make this map silently keep one
// and drop the other, so the checks below could pass while the dropped
// workflow's jobs gate nothing. `workflow_run` matches by name too, so the
// ambiguity is real for the gate, not just for this test — fail on it here.
function gatedWorkflowSources(): Map<string, string> {
  const byName = new Map<string, string>();
  const filesByName = new Map<string, string>();

  for (const file of readdirSync(workflowsDir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
    const source = read(resolve(workflowsDir, file));
    const name = source.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    if (!name) continue;

    assert.ok(
      !filesByName.has(name),
      `workflows must have unique names; ${filesByName.get(name)} and ${file} are both named "${name}", so workflow_run and the deploy gate cannot tell them apart`,
    );
    filesByName.set(name, file);
    byName.set(name, source);
  }

  return byName;
}

// The check-run name GitHub publishes for a job: its `name:` override when it
// has one, otherwise the job id. A `name:` containing a `${{ … }}` expression
// (matrix fan-out) resolves per matrix entry, so no single literal name exists
// for the gate to match.
function effectiveCheckName(workflow: string, job: string): { name: string; templated: boolean } {
  const nameOverride = workflowJobBlock(workflow, job).match(/^ {4}name:\s*(.+)$/m)?.[1];
  if (!nameOverride) {
    return { name: job, templated: false };
  }

  const value = nameOverride.trim().replace(/^['"]|['"]$/g, '');
  return { name: value, templated: value.includes('${{') };
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
    for (const job of workflowJobNames(testWorkflow, 'test.yml')) {
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

  // #5402: `sidecar` runs in CI but is not one of branch protection's four
  // required contexts (biome, typecheck, unit, gate). It blocks merge anyway,
  // because the required `gate` context aggregates it — but only because
  // someone remembered to list it. Nothing forced that, and the same omission
  // is invisible for every other job: a job absent from `required` is simply
  // never inspected, so it reports red on the PR and the gate still goes green.
  // The check below covers every workflow the gate aggregates, not just
  // test.yml, so a new job cannot land in an advisory-only state.
  it('requires every job of every workflow the deploy gate aggregates', () => {
    const requiredChecks = deployGateRequiredChecks();
    const sources = gatedWorkflowSources();
    const advisoryOnly: string[] = [];

    for (const workflowName of REQUIRED_GATE_WORKFLOWS) {
      const source = sources.get(workflowName);
      assert.ok(source, `a workflow named ${workflowName} must exist for the deploy gate to aggregate it`);

      for (const job of workflowJobNames(source, workflowName)) {
        const { name, templated } = effectiveCheckName(source, job);
        const exemption = GATE_CHECK_EXEMPTIONS[job];

        if (exemption && exemption.workflow === workflowName) {
          assert.ok(
            templated,
            `${workflowName}/${job} is exempt from the gate only because its check-run name is templated, but it publishes the literal name ${name} — require it directly instead`,
          );
          assert.ok(
            requiredChecks.includes(exemption.coveredBy),
            `${workflowName}/${job} is exempt because ${exemption.coveredBy} blocks on its behalf, so ${exemption.coveredBy} must itself be a required gate check`,
          );
          continue;
        }

        assert.ok(
          !templated,
          `${workflowName}/${job} publishes a per-matrix check-run name (${name}) that the gate cannot match, and has no GATE_CHECK_EXEMPTIONS entry naming the aggregate that covers it`,
        );

        if (!requiredChecks.includes(name)) {
          advisoryOnly.push(`${workflowName}/${name}`);
        }
      }
    }

    assert.deepEqual(
      advisoryOnly,
      [],
      `deploy-gate.yml must require every job of every workflow it aggregates. These run in CI but a red result does not block merge (#5402): ${advisoryOnly.join(', ')}`,
    );
  });

  // The mirror-image failure of the check above, and the more disruptive one:
  // a `required` entry that no job publishes never resolves, so the gate holds
  // at "Waiting for required PR gates" on every PR until someone edits the
  // workflow. Renaming or deleting a gated job must fail here, not in the queue.
  it('keeps the deploy gate required list free of checks no gated workflow publishes', () => {
    const sources = gatedWorkflowSources();
    const published = new Set<string>();

    for (const workflowName of REQUIRED_GATE_WORKFLOWS) {
      const source = sources.get(workflowName);
      assert.ok(source, `a workflow named ${workflowName} must exist for the deploy gate to aggregate it`);

      for (const job of workflowJobNames(source, workflowName)) {
        const { name, templated } = effectiveCheckName(source, job);
        if (!templated) {
          published.add(name);
        }
      }
    }

    const phantom = deployGateRequiredChecks().filter((check) => !published.has(check));

    assert.deepEqual(
      phantom,
      [],
      `deploy-gate.yml requires checks no gated workflow publishes, so the gate can never leave "pending": ${phantom.join(', ')}`,
    );
  });

  // #5822: the gate matches check runs by name alone, then keeps only the one
  // that finished last. Two jobs publishing the same name — in different
  // workflows or the same one — collapse to that single run and the others'
  // conclusions are discarded, so a failure in any of them is invisible.
  //
  // For a `changes`-style filter job that is fail-open twice over: its
  // dependents are `if: needs.changes.outputs.code == 'true'`, so when it fails
  // they are *skipped* rather than failed, and the gate deliberately counts
  // `skipped` as passing (docs-only PRs). A masked `changes` failure therefore
  // takes an entire required suite green with it.
  //
  // Scan every workflow, not just the four the gate aggregates: the gate reads
  // all check runs on the SHA regardless of which workflow published them, and
  // it evaluates main pushes too, where a push- or schedule-triggered workflow
  // lands its check runs on the very same commit.
  it('keeps every gate-required check-run name published by exactly one job', () => {
    const publishers = new Map<string, string[]>();

    for (const file of readdirSync(workflowsDir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
      const source = read(resolve(workflowsDir, file));

      for (const job of workflowJobNames(source, file)) {
        const { name, templated } = effectiveCheckName(source, job);
        if (templated) {
          continue;
        }
        publishers.set(name, [...(publishers.get(name) ?? []), `${file}:${job}`]);
      }
    }

    // Every gated job's effective name has to be in `required` (asserted
    // above), so keying off `required` still covers all four gated workflows
    // while leaving harmless duplicates alone — two cron-only workflows may
    // both call a job `monitor` without the gate ever reading either.
    //
    // Exactly one, not at-least-one: a zero-publisher name hangs the gate at
    // "pending" forever, and checking both directions means an empty or
    // mis-parsed scan above fails here instead of vacuously passing.
    const misrouted = deployGateRequiredChecks()
      .map((check) => ({ check, sites: publishers.get(check) ?? [] }))
      .filter(({ sites }) => sites.length !== 1)
      .map(({ check, sites }) => `${check} <- ${sites.length > 0 ? sites.join(', ') : 'no job publishes it'}`);

    assert.deepEqual(
      misrouted,
      [],
      `deploy-gate.yml keys on the check-run name only and keeps just the last-completed run, so a required name published by more than one job masks every other publisher's failure, and one published by none never leaves "pending" (#5822). Give each job a distinct name: ${misrouted.join('; ')}`,
    );
  });

  it('paginates gate status history during the scheduled self-healing sweep', () => {
    const deployGateJob = workflowJobBlock(deployGateWorkflow, 'gate');

    assert.match(deployGateJob, /gh api --paginate --slurp/);
    assert.match(deployGateJob, /commits\/\$s\/statuses\?per_page=100/);
    assert.match(
      deployGateJob,
      /flatten \| map\(select\(\.context == "gate"\)\) \| first/,
    );
    assert.doesNotMatch(deployGateJob, /sort_by\(\.updated_at\)/);
    assert.doesNotMatch(
      deployGateJob,
      /commits\/\$s\/status"/,
      'the combined status endpoint silently truncates large commit-status histories',
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
