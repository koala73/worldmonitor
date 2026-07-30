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
  const nonGateStatuses = Array.from({ length: 100 }, (_, index) => ({
    context: `railway-${index}`,
    state: 'success',
    updated_at: '2026-07-29T12:00:00Z',
  }));
  const gateStatuses = gateState === 'missing'
    ? []
    : [
        {
          context: 'gate',
          state: gateState,
          updated_at: '2026-07-29T12:01:00Z',
        },
        {
          context: 'gate',
          state: gateState === 'success' ? 'failure' : 'success',
          updated_at: '2026-07-29T12:01:00Z',
        },
      ];

  try {
    // Put the latest `gate` status on a second API page followed by an older
    // status with the same second-resolution timestamp. GitHub returns status
    // history newest-first, so this proves the workflow neither truncates the
    // response nor reorders equal timestamps into stale state.
    mkdirSync(fakeBin);
    writeFileSync(
      fakeGh,
      [
        '#!/bin/sh',
        'case " $* " in *" --paginate "*) ;; *) exit 91 ;; esac',
        'case " $* " in *" --slurp "*) ;; *) exit 92 ;; esac',
        'case "$*" in *"/statuses?per_page=100"*) ;; *) exit 93 ;; esac',
        'printf \'%s\\n\' "$FAKE_STATUS_PAGES"',
        '',
      ].join('\n'),
    );
    chmodSync(fakeGh, 0o755);

    return spawnSync(
      'bash',
      ['-e', '-c', scheduledGateStep().run],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          FAKE_STATUS_PAGES: JSON.stringify([nonGateStatuses, gateStatuses]),
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

function runRailwayContext({ token = 'project-token', projectId = 'project-123' } = {}) {
  const tempDir = mkdtempSync(join(repoRoot, '.tmp-seed-freshness-railway-'));
  const fakeBin = join(tempDir, 'bin');
  const fakeRailway = join(fakeBin, 'railway');

  try {
    mkdirSync(fakeBin);
    writeFileSync(
      fakeRailway,
      [
        '#!/bin/sh',
        '[ "$RAILWAY_TOKEN" = "project-token" ] || exit 91',
        '[ "$*" = "status --project project-123 --environment production --json" ] || exit 92',
        "printf '{}\\n'",
        '',
      ].join('\n'),
    );
    chmodSync(fakeRailway, 0o755);

    return spawnSync(
      'bash',
      ['-e', '-c', stepNamed('Verify Railway production context').run],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          RAILWAY_TOKEN: token,
          RAILWAY_PROJECT_ID: projectId,
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
    assert.match(gate.run, /gh api --paginate --slurp/);
    assert.match(gate.run, /statuses\?per_page=100/);
    assert.match(gate.run, /map\(select\(\.context == "gate"\)\) \| first/);
    assert.doesNotMatch(gate.run, /sort_by\(\.updated_at\)/);
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
    const contextIndex = monitorSteps.findIndex(
      (step) => step.name === 'Verify Railway production context',
    );
    const auditIndex = monitorSteps.findIndex(
      (step) => step.name === 'Audit Railway ingestion deployment controls',
    );
    const healthIndex = monitorSteps.findIndex(
      (step) => step.name === 'Check ingestion operational acceptance',
    );

    assert.ok(installIndex >= 0, 'workflow must install the Railway CLI');
    assert.ok(
      installIndex < contextIndex && contextIndex < auditIndex && auditIndex < healthIndex,
      'Railway context and watch-path drift must be checked before compact health',
    );

    assert.match(
      monitorSteps[installIndex].run,
      /npm install --global @railway\/cli@5\.30\.1/,
      'scheduled audits must use a deterministic Railway CLI version',
    );

    const context = monitorSteps[contextIndex];
    assert.equal(context.env.RAILWAY_TOKEN, '${{ secrets.RAILWAY_PRODUCTION_TOKEN }}');
    assert.equal(context.env.RAILWAY_PROJECT_ID, '${{ vars.RAILWAY_PROJECT_ID }}');
    assert.match(context.run, /RAILWAY_TOKEN/);
    assert.match(context.run, /RAILWAY_PROJECT_ID/);
    assert.match(
      context.run,
      /railway status --project "\$RAILWAY_PROJECT_ID" --environment production --json > \/dev\/null/,
    );
    assert.doesNotMatch(
      context.run,
      /railway link/,
      'project tokens resolve their own context and must not invoke account-scoped linking',
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

  it('validates the project token against the expected production context without linking', () => {
    const success = runRailwayContext();
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /valid for the expected production context/);

    for (const [label, options] of [
      ['missing project token', { token: '' }],
      ['missing project id', { projectId: '' }],
      ['wrong project token', { token: 'wrong-token' }],
      ['wrong project id', { projectId: 'wrong-project' }],
    ]) {
      const result = runRailwayContext(options);
      assert.notEqual(result.status, 0, `${label} must fail before the Railway audit`);
    }
  });
});
