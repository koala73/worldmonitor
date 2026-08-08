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

// The one condition allowed to stop a probe: the fail-closed green-main gate.
// Anything else (an earlier probe failing) must leave the later probes running.
const GATE_GUARD = "${{ !cancelled() && steps.gate.conclusion != 'failure' }}";

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
    // Explicitly gated on the green-main check rather than on "every earlier
    // step passed". Default success() semantics skipped this probe on every run
    // from 2026-08-03, because an unrelated watch-path drift failed the config
    // audit above it — one red step silently switched off data-freshness
    // monitoring for the whole fleet.
    assert.equal(acceptance.if, GATE_GUARD, 'acceptance must stay behind the fail-closed gate and nothing else');
    assert.match(GATE_GUARD, /steps\.gate\.conclusion != 'failure'/);
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
    const driftIndex = monitorSteps.findIndex(
      (step) => step.name === 'Check Railway deploy drift against main',
    );
    const healthIndex = monitorSteps.findIndex(
      (step) => step.name === 'Check ingestion operational acceptance',
    );

    assert.ok(installIndex >= 0, 'workflow must install the Railway CLI');
    assert.ok(
      installIndex < contextIndex && contextIndex < auditIndex && auditIndex < healthIndex,
      'Railway context and watch-path drift must be checked before compact health',
    );
    // Deploy drift runs LAST. It fails whenever any service is off head —
    // including on a baseline expiry — and a failing step cancels the ones
    // behind it, so ordering it before compact health would let a deploy-drift
    // problem silently stop the data-health probe entirely.
    assert.ok(
      healthIndex < driftIndex,
      'deploy drift must not be able to cancel the compact-health probe',
    );

    // Two questions need local history: `git merge-base --is-ancestor` for a
    // merge that landed mid-run, and (#6142) the diff between the commit each
    // service is RUNNING and head. The second is why a fixed depth no longer
    // does — a service legitimately weeks behind on code it does not contain
    // sits outside any of them, and an unreachable running commit reports as
    // CLOSURE_UNKNOWN. Full history, no blobs.
    assert.equal(
      checkout.with?.['fetch-depth'],
      0,
      'the deploy-drift check needs history back to each service\'s running commit',
    );
    assert.equal(
      checkout.with?.filter,
      'blob:none',
      'full history must be fetched without blobs — the closure diff walks trees only',
    );

    const drift = monitorSteps[driftIndex];
    assert.equal(drift.env.RAILWAY_TOKEN, '${{ secrets.RAILWAY_PRODUCTION_TOKEN }}');
    assert.equal(drift.env.RAILWAY_PROJECT_ID, '${{ vars.RAILWAY_PROJECT_ID }}');
    assert.match(drift.run, /node scripts\/check-railway-deploy-drift\.mjs/);
    assert.match(
      drift.run,
      /git fetch --quiet origin main/,
      'a merge landing mid-run must be resolvable as ahead, not reported as behind',
    );
    // Passing --depth to a full clone SHALLOWS it, which would strand exactly
    // the running commits the closure comparison needs — the checkout above
    // fetches full history precisely so this cannot happen.
    assert.doesNotMatch(
      drift.run,
      /git fetch[^\n]*--depth/,
      're-fetching with a depth would re-shallow the full-history checkout',
    );
    assert.equal(
      drift['continue-on-error'],
      undefined,
      'a merge that never reached production must fail the monitor, not annotate it',
    );
    // Gated on the green-main check only, exactly as compact health is: an
    // earlier probe's failure must not be able to skip this one.
    assert.equal(drift.if, GATE_GUARD, 'deploy drift stays behind the fail-closed gate and nothing else');

    assert.equal(
      workflow.jobs.monitor['timeout-minutes'],
      20,
      'the job budget must cover one Railway round trip per service',
    );
    assert.deepEqual(
      workflow.concurrency,
      { group: 'seed-freshness-monitor', 'cancel-in-progress': true },
      'a run slower than the interval must be superseded, not stacked',
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
