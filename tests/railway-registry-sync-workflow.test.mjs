/**
 * Contract for .github/workflows/railway-registry-sync.yml (#7256).
 *
 * The six-hourly `Railway Native Deploy Health` monitor already detects live
 * watch-path drift, but only as a recurring red that then normalizes: it failed
 * 31 consecutive scheduled runs between 2026-08-20 and 2026-08-28 on a stale
 * watch-path set, and while it was permanently red no NEW drift was visible.
 * One of those latent gaps then turned real — Railway refused `6821a584e`
 * (#7196) for `ais-relay` with "No changes to watched files".
 *
 * This workflow closes the loop on the push that causes the drift. The test
 * proves the two things a YAML shape assertion cannot: that the step actually
 * exits non-zero when live watch paths trail the registry, and that it exits 0
 * when they match.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/railway-registry-sync.yml');
const source = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(source);

// The exact pattern Railway was missing when it refused #7196 for ais-relay.
const INCIDENT_SERVICE = 'ais-relay';
const INCIDENT_PATTERN = 'scripts/lib/x-poll-cycle.cjs';

function steps(job) {
  assert.ok(Array.isArray(job?.steps), 'job must define steps');
  return job.steps;
}

function stepNamed(job, name) {
  const step = steps(job).find((candidate) => candidate.name === name);
  assert.ok(step, `job must define ${JSON.stringify(name)}`);
  return step;
}

// Only the calls the deployment-only configuration audit makes: the service
// inventory, the environment id, and one ViewerDeploymentConfig projection per
// service. Anything else is a fixture bug or an unintended widening of the
// workflow, so it fails loudly instead of returning a plausible shape.
function fakeRailwayCli({ repoRoot: fixtureRoot, driftService, driftPattern }) {
  const { readFileSync: readFixture } = require('node:fs');

  const repository = 'koala73/worldmonitor';
  const rootDirectoryByDeployMode = {
    'nixpacks-root-scripts': 'scripts',
    'nixpacks-root-repo': '',
    dockerfile: '',
  };
  const manifest = JSON.parse(readFixture(`${fixtureRoot}/scripts/railway-native-autodeploy-fleet.json`, 'utf8'));
  const registry = JSON.parse(readFixture(`${fixtureRoot}/scripts/railway-services.json`, 'utf8'));
  const registryByName = new Map(registry.map((entry) => [entry.service, entry]));
  const servicesById = new Map(manifest.services.map((service) => [service.id, service]));
  const args = process.argv.slice(2);

  const writeJson = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const fail = (message) => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 97;
  };
  const argument = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };

  const liveWatchPatterns = (service) => {
    const declared = registryByName.get(service.name)?.watchPatterns ?? [];
    if (service.name !== driftService) return declared;
    return declared.filter((pattern) => pattern !== driftPattern);
  };

  const serviceInstance = (service) => {
    const entry = registryByName.get(service.name);
    return {
      serviceId: service.id,
      source: { repo: repository, image: null },
      rootDirectory: rootDirectoryByDeployMode[entry?.deployMode] ?? '',
      watchPatterns: liveWatchPatterns(service),
      dockerfilePath: entry?.dockerfile ?? null,
      startCommand: null,
      cronSchedule: entry?.cronSchedule ?? null,
    };
  };

  if (process.env.RAILWAY_API_TOKEN !== 'viewer') {
    fail(`unexpected fake Viewer token ${JSON.stringify(process.env.RAILWAY_API_TOKEN)}`);
  } else if (args[0] === 'service' && args[1] === 'list') {
    if (argument('--project') !== 'project-1') {
      fail(`Railway command was not scoped to project-1: ${JSON.stringify(args)}`);
    } else {
      writeJson(manifest.services.map((service) => ({
        ...service,
        source: { repo: repository, image: null },
      })));
    }
  } else if (args[0] === 'status') {
    writeJson({
      environments: { edges: [{ node: { id: 'environment-1', name: 'production' } }] },
    });
  } else if (args[0] === 'api' && (args[1] ?? '').includes('ViewerDeploymentConfig')) {
    const variables = JSON.parse(argument('--variables'));
    const service = servicesById.get(variables.serviceId);
    if (!service) {
      fail(`unknown service ${variables.serviceId}`);
    } else {
      writeJson({
        data: {
          serviceInstance: serviceInstance(service),
          deploymentTriggers: {
            pageInfo: { hasNextPage: false },
            edges: [{
              node: {
                serviceId: service.id,
                repository,
                branch: 'main',
                checkSuites: false,
                provider: 'github',
              },
            }],
          },
        },
      });
    }
  } else {
    fail(`unexpected Railway CLI arguments: ${JSON.stringify(args)}`);
  }
}

function createAuditFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'railway-registry-sync-'));
  const startedAtMs = Date.now();
  const fakeRailway = join(directory, 'railway');
  const fakeDate = join(directory, 'date');
  writeFileSync(fakeDate, `#!/bin/sh\nprintf '%s\\n' '${startedAtMs}'\n`);
  chmodSync(fakeDate, 0o755);
  const writeFake = ({ driftService = null, driftPattern = null } = {}) => {
    const fixture = { repoRoot, driftService, driftPattern };
    writeFileSync(
      fakeRailway,
      `#!/usr/bin/env node\nconst fixture = ${JSON.stringify(fixture)};\n(${fakeRailwayCli.toString()})(fixture);\n`,
    );
    chmodSync(fakeRailway, 0o755);
  };
  return { directory, startedAtMs, writeFake };
}

function executeWorkflowShell(run, fixture, {
  githubEnv,
  githubOutput,
  githubStepSummary,
  // A token the fake CLI does not recognize makes every Railway call fail, which
  // is how an auth/network/deadline failure reaches the audit: non-zero exit,
  // no drift verdict.
  token = 'viewer',
} = {}) {
  const runnerTemp = join(fixture.directory, 'runner-temp');
  mkdirSync(runnerTemp, { recursive: true });
  return spawnSync('bash', [
    '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', run,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${fixture.directory}:${process.env.PATH}`,
      GITHUB_ENV: githubEnv ?? join(fixture.directory, 'github-env'),
      GITHUB_OUTPUT: githubOutput ?? join(fixture.directory, 'github-output'),
      GITHUB_STEP_SUMMARY: githubStepSummary ?? join(fixture.directory, 'step-summary'),
      RUNNER_TEMP: runnerTemp,
      RAILWAY_API_TOKEN: token,
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS: String(fixture.startedAtMs),
    },
  });
}

describe('Railway Registry Sync workflow', () => {
  it('fires on a registry push to main and on demand, nothing else', () => {
    assert.equal(workflow.name, 'Railway Registry Sync');
    assert.deepEqual(workflow.on.push, {
      branches: ['main'],
      // The fleet identity contract is the audit's other input, and its guard
      // aborts before the config audit — so a provisioning edit must trigger
      // this check too, not just a watchPatterns edit.
      paths: [
        'scripts/railway-services.json',
        'scripts/railway-native-autodeploy-fleet.json',
      ],
    });
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    // A schedule here would duplicate Railway Native Deploy Health, which
    // already owns periodic coverage of drift no registry edit caused.
    assert.equal(Object.hasOwn(workflow.on, 'schedule'), false);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(workflow.concurrency, {
      group: 'railway-registry-sync-${{ github.ref }}',
      'cancel-in-progress': true,
    });
  });

  it('publishes one fail-closed conclusion from one job', () => {
    assert.deepEqual(Object.keys(workflow.jobs), ['audit']);
    const job = workflow.jobs.audit;
    assert.equal(job.needs, undefined);
    assert.equal(job['continue-on-error'], undefined);
    assert.deepEqual(job.environment, {
      name: 'ingestion-acceptance-production',
      deployment: false,
    });
  });

  it('uses only the dedicated Viewer API token and never a mutation surface', () => {
    const job = workflow.jobs.audit;
    assert.equal(job.env, undefined, 'checkout, setup, and package install must not inherit the Viewer token');
    const credentialed = steps(job).filter((step) => step.env?.RAILWAY_API_TOKEN);
    assert.equal(credentialed.length, 1);
    assert.equal(
      credentialed[0].env.RAILWAY_API_TOKEN,
      '${{ secrets.RAILWAY_PRODUCTION_VIEWER_API_TOKEN }}',
    );
    assert.equal(credentialed[0].env.RAILWAY_PROJECT_ID, '${{ vars.RAILWAY_PROJECT_ID }}');
    for (const step of steps(job).filter((candidate) => candidate.uses || candidate.name === 'Install pinned Railway CLI')) {
      assert.equal(step.env, undefined, `${step.name ?? step.uses} must not inherit the Viewer token`);
    }
    assert.doesNotMatch(source, /\bRAILWAY_TOKEN\b/);
    assert.doesNotMatch(source, /RECONCILE|HMAC|DEPLOY_TOKEN|OPERATOR_TOKEN|WATCHDOG/i);
    assert.doesNotMatch(source, /actions:\s*write|contents:\s*write|deployments:\s*write|statuses:\s*write/);
    // The Viewer token cannot mutate, so an --apply here would fail confusingly
    // rather than sync anything. Naming the command in guidance text is the
    // point of the workflow, so only an executed apply is forbidden.
    assert.doesNotMatch(source, /^\s*(?:run:\s*)?node scripts\/audit-railway-watch-paths\.mjs[^\n]*--apply/m);
    assert.doesNotMatch(source, /railway\s+(?:redeploy|up)|environment\s+edit/);
  });

  it('audits the configuration only, never the post-merge deployment history', () => {
    const check = stepNamed(
      workflow.jobs.audit,
      'Audit live Railway configuration against the registry',
    );
    assert.match(
      check.run,
      /node scripts\/audit-railway-watch-paths\.mjs --deployment-only --concurrency 2/,
    );
    // check-railway-deploy-drift.mjs also asks whether every service runs head,
    // which is legitimately false for the first minutes after a merge. Running
    // it here would red on ordinary build lag instead of on drift.
    //
    // Scoped to what the job EXECUTES, not to the file text: the header comment
    // has to name that script to explain why it is excluded, and a whole-source
    // assertion would make the explanation fail the test that enforces it.
    for (const step of steps(workflow.jobs.audit)) {
      assert.doesNotMatch(
        step.run ?? '',
        /check-railway-deploy-drift/,
        `${step.name ?? step.uses} must not run the deployment-history check`,
      );
    }
    // The step captures the audit's exit status so it can tell a drift verdict
    // apart from an observation failure, then re-raises it. Assert the re-raise
    // (and prove non-swallowing behaviorally below) rather than banning `||`,
    // which the status capture legitimately needs.
    assert.equal(check.id, 'audit', 'the guidance step gates on this step id');
    assert.match(check.run, /exit "\$status"/);
    assert.doesNotMatch(check.run, /continue-on-error/);
  });

  it('starts the run budget before every prerequisite', () => {
    const fixture = createAuditFixture();
    try {
      const job = workflow.jobs.audit;
      const budget = stepNamed(job, 'Start config-audit run budget');
      assert.equal(steps(job).indexOf(budget), 0);
      const githubEnv = join(fixture.directory, 'budget-env');
      const result = executeWorkflowShell(budget.run, fixture, { githubEnv });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(githubEnv, 'utf8'),
        `RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS=${fixture.startedAtMs}\n`,
      );
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('passes when live watch paths match the registry', () => {
    const fixture = createAuditFixture();
    try {
      fixture.writeFake();
      const check = stepNamed(
        workflow.jobs.audit,
        'Audit live Railway configuration against the registry',
      );
      const githubOutput = join(fixture.directory, 'match-output');
      writeFileSync(githubOutput, '');
      const result = executeWorkflowShell(check.run, fixture, { githubOutput });
      assert.equal(
        result.status,
        0,
        `matched configuration must pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(result.stdout, /Railway operational-config audit passed/);
      assert.doesNotMatch(readFileSync(githubOutput, 'utf8'), /drift_detected/);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('fails and names the service when live watch paths trail the registry', () => {
    const fixture = createAuditFixture();
    try {
      fixture.writeFake({
        driftService: INCIDENT_SERVICE,
        driftPattern: INCIDENT_PATTERN,
      });
      const check = stepNamed(
        workflow.jobs.audit,
        'Audit live Railway configuration against the registry',
      );
      const githubOutput = join(fixture.directory, 'drift-output');
      writeFileSync(githubOutput, '');
      const result = executeWorkflowShell(check.run, fixture, { githubOutput });
      assert.notEqual(
        result.status,
        0,
        `a service whose live watch paths omit ${INCIDENT_PATTERN} must fail the audit\nstdout:\n${result.stdout}`,
      );
      assert.match(
        result.stderr,
        new RegExp(`${INCIDENT_SERVICE}: watch paths missing ${INCIDENT_PATTERN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );
      // The step must still echo the audit's own stderr, not swallow it into
      // the capture file.
      assert.match(readFileSync(githubOutput, 'utf8'), /drift_detected=true/);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('keeps an observation failure on its own diagnosis, not on --apply', () => {
    const job = workflow.jobs.audit;
    const diagnosis = stepNamed(job, 'Report that the audit could not observe Railway');
    assert.equal(
      diagnosis.if,
      "failure() && steps.audit.outputs.drift_detected != 'true'",
    );
    assert.equal(steps(job).indexOf(diagnosis), steps(job).length - 1);
    // The two failure arms must be mutually exclusive, so exactly one speaks.
    const guidance = stepNamed(job, 'Name the operator sync command');
    assert.equal(
      guidance.if.replace("== 'true'", ''),
      diagnosis.if.replace("!= 'true'", ''),
    );

    const fixture = createAuditFixture();
    try {
      const summary = join(fixture.directory, 'diagnosis-summary');
      writeFileSync(summary, '');
      const result = executeWorkflowShell(diagnosis.run, fixture, {
        githubStepSummary: summary,
      });
      assert.equal(result.status, 0, result.stderr);
      const rendered = readFileSync(summary, 'utf8');
      assert.match(rendered, /No drift is implied and `--apply` is NOT the remedy/);
      assert.doesNotMatch(
        rendered,
        /^\s*node scripts\/audit-railway-watch-paths\.mjs --apply\s*$/m,
        'the non-verdict arm must not hand over the apply command as an action',
      );
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  // The regression for PR #7312 review: an unqualified `failure()` made every
  // checkout, npm-install, credential, network, and deadline failure claim that
  // live configuration trails the registry and send an operator to run a
  // production `--apply` on no evidence. A drift verdict and an observation
  // failure both exit 1, so the exit code alone cannot gate that guidance.
  it('fails without claiming drift when the audit cannot observe Railway', () => {
    const fixture = createAuditFixture();
    try {
      fixture.writeFake();
      const check = stepNamed(
        workflow.jobs.audit,
        'Audit live Railway configuration against the registry',
      );
      const githubOutput = join(fixture.directory, 'unreadable-output');
      writeFileSync(githubOutput, '');
      const result = executeWorkflowShell(check.run, fixture, {
        githubOutput,
        token: 'not-the-viewer-token',
      });
      assert.notEqual(
        result.status,
        0,
        `an unreadable Railway must still fail the job\nstdout:\n${result.stdout}`,
      );
      assert.doesNotMatch(
        readFileSync(githubOutput, 'utf8'),
        /drift_detected/,
        'an observation failure must not be reported as configuration drift',
      );
      assert.doesNotMatch(result.stderr, /audit found \d+ drifted service/);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('hands the operator the exact sync command when the audit fails', () => {
    const job = workflow.jobs.audit;
    const guidance = stepNamed(job, 'Name the operator sync command');
    // Gated on a positive drift verdict, never on bare failure(): a failed
    // checkout, npm install, credential, or deadline is not evidence of drift
    // and must not direct an operator at a production --apply.
    assert.equal(
      guidance.if,
      "failure() && steps.audit.outputs.drift_detected == 'true'",
    );

    const fixture = createAuditFixture();
    try {
      const summary = join(fixture.directory, 'guidance-summary');
      writeFileSync(summary, '');
      const result = executeWorkflowShell(guidance.run, fixture, {
        githubStepSummary: summary,
      });
      assert.equal(result.status, 0, result.stderr);
      const rendered = readFileSync(summary, 'utf8');
      assert.match(rendered, /node scripts\/audit-railway-watch-paths\.mjs --apply/);
      assert.match(rendered, /No changes to watched files/);
      // requireMainTrigger means this audit also reports source branch and
      // checkSuites drift, which --apply does not write. Pointing an operator
      // at the apply for those would send them round a loop that cannot end.
      assert.match(rendered, /source checkSuites.+`--apply` does NOT touch/s);
      assert.match(result.stdout, /::error::/);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
