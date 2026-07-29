import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowSource = readFileSync(
  resolve(repoRoot, '.github/workflows/seed-freshness-monitor.yml'),
  'utf8',
);
const workflow = YAML.parse(workflowSource);
const monitorSteps = workflow.jobs.monitor.steps;

function stepNamed(name) {
  const step = monitorSteps.find((candidate) => candidate.name === name);
  assert.ok(step, `seed freshness workflow must define "${name}"`);
  return step;
}

function scheduledGateStep() {
  const step = monitorSteps.find((candidate) => candidate.id === 'gate');
  assert.ok(step, 'seed freshness workflow must define its scheduled gate step');
  return step;
}

function runScheduledGate(gateState) {
  const tempDir = mkdtempSync(join(repoRoot, '.tmp-seed-freshness-gate-'));
  const fakeBin = join(tempDir, 'bin');
  const fakeGh = join(fakeBin, 'gh');

  try {
    // The workflow's only external input is the latest `gate` commit status.
    // Replacing gh at PATH level executes the exact checked-in shell block
    // without relying on GitHub's API or duplicating its branching logic.
    mkdirSync(fakeBin);
    writeFileSync(fakeGh, '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_GATE_STATE"\n');
    chmodSync(fakeGh, 0o755);

    return spawnSync(
      'bash',
      ['-e', '-c', scheduledGateStep().run],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          FAKE_GATE_STATE: gateState,
          GH_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'koala73/worldmonitor',
          GITHUB_SHA: '0123456789abcdef',
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('seed freshness workflow control plane', () => {
  it('fails closed unless the exact checked-out main SHA has a successful gate', () => {
    const success = runScheduledGate('success');
    assert.equal(success.status, 0, success.stderr);

    for (const state of ['missing', 'pending', 'failure', 'error']) {
      const result = runScheduledGate(state);
      assert.notEqual(
        result.status,
        0,
        `${state} must fail the workflow instead of producing a green skipped acceptance`,
      );
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        new RegExp(`main gate is ${state}`),
      );
    }

    const gate = scheduledGateStep();
    assert.equal(gate.if, "github.event_name == 'schedule'");
    assert.equal(gate['continue-on-error'], undefined);
    assert.equal(workflow.jobs.monitor['continue-on-error'], undefined);
    assert.doesNotMatch(gate.run, /should_run|Skipping seed freshness/);
    const acceptance = stepNamed('Check ingestion operational acceptance');
    assert.equal(
      acceptance.if,
      undefined,
      'default success() semantics must keep acceptance behind the fail-closed gate',
    );
    assert.equal(acceptance['continue-on-error'], undefined);
  });

  it('audits read-only Railway production config before grading data health', () => {
    assert.deepEqual(
      workflow.jobs.monitor.environment,
      {
        name: 'ingestion-acceptance-production',
        deployment: false,
      },
      'production credentials must come from the main-only ingestion acceptance environment',
    );

    const checkout = monitorSteps.find(
      (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    );
    assert.ok(checkout, 'workflow must check out the audited repository revision');
    assert.equal(
      checkout.uses,
      'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
      'credential-bearing workflows must pin checkout to the repository-standard immutable SHA',
    );

    const installIndex = monitorSteps.findIndex(
      (step) => step.name === 'Install pinned Railway CLI',
    );
    const linkIndex = monitorSteps.findIndex(
      (step) => step.name === 'Link Railway production context',
    );
    const auditIndex = monitorSteps.findIndex(
      (step) => step.name === 'Audit Railway ingestion deployment controls',
    );
    const healthIndex = monitorSteps.findIndex(
      (step) => step.name === 'Check ingestion operational acceptance',
    );

    assert.ok(installIndex >= 0, 'workflow must install the Railway CLI');
    assert.ok(
      installIndex < linkIndex && linkIndex < auditIndex && auditIndex < healthIndex,
      'Railway context and watch-path drift must be checked before compact health',
    );

    assert.match(
      monitorSteps[installIndex].run,
      /npm install --global @railway\/cli@5\.30\.1/,
      'scheduled audits must use a deterministic Railway CLI version',
    );

    const link = monitorSteps[linkIndex];
    assert.equal(link.env.RAILWAY_TOKEN, '${{ secrets.RAILWAY_PRODUCTION_TOKEN }}');
    assert.equal(link.env.RAILWAY_PROJECT_ID, '${{ vars.RAILWAY_PROJECT_ID }}');
    assert.match(link.run, /RAILWAY_TOKEN/);
    assert.match(link.run, /RAILWAY_PROJECT_ID/);
    assert.match(
      link.run,
      /railway link --project "\$RAILWAY_PROJECT_ID" --environment production --json/,
    );

    const audit = monitorSteps[auditIndex];
    assert.equal(audit.env.RAILWAY_TOKEN, '${{ secrets.RAILWAY_PRODUCTION_TOKEN }}');
    assert.equal(audit.run.trim(), 'node scripts/audit-railway-watch-paths.mjs');
    assert.equal(audit['continue-on-error'], undefined);
    assert.doesNotMatch(
      audit.run,
      /--apply/,
      'scheduled acceptance must detect Railway drift without mutating production',
    );
    assert.doesNotMatch(
      workflowSource,
      /RAILWAY_API_TOKEN/,
      'the workflow must not use an account-scoped Railway credential',
    );
  });
});
