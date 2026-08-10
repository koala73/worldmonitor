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

function assertBashSyntax(script) {
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function scheduledGateStep() {
  const step = monitorSteps.find((candidate) => candidate.id === 'gate');
  assert.ok(step, 'seed freshness workflow must define its scheduled gate step');
  return step;
}

const HEAD_SHA = '0123456789abcdef';
// Frozen so the age bound is a boundary, not a race against the wall clock:
// `date` is faked below and every ancestor age is expressed against this.
const FAKE_NOW_SECONDS = 1_785_000_000;

// Puts the latest `gate` status on a second API page followed by an older status
// with the same second-resolution timestamp. GitHub returns status history
// newest-first, so this proves the workflow neither truncates the response nor
// reorders equal timestamps into stale state.
function statusPages(gateState) {
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
  return JSON.stringify([nonGateStatuses, gateStatuses]);
}

/**
 * Execute the scheduled gate step against a fabricated main history.
 *
 * `ancestors` are `{ sha, state, ageSeconds }` in `git log --first-parent`
 * order (newest first), the same order the step consumes them in.
 */
function runScheduledGate(head, ancestors = []) {
  const tempDir = mkdtempSync(join(repoRoot, '.tmp-seed-freshness-gate-'));
  const fakeBin = join(tempDir, 'bin');
  const statusDir = join(tempDir, 'statuses');
  const outputFile = join(tempDir, 'github-output');
  const requestLog = join(tempDir, 'requested-shas');
  const gitLogFile = join(tempDir, 'git-log');

  try {
    mkdirSync(fakeBin);
    mkdirSync(statusDir);
    writeFileSync(outputFile, '');
    writeFileSync(requestLog, '');
    writeFileSync(join(statusDir, `${HEAD_SHA}.json`), statusPages(head));
    for (const ancestor of ancestors) {
      writeFileSync(join(statusDir, `${ancestor.sha}.json`), statusPages(ancestor.state));
    }
    writeFileSync(
      gitLogFile,
      [
        `${HEAD_SHA} ${FAKE_NOW_SECONDS}`,
        ...ancestors.map((ancestor) => `${ancestor.sha} ${FAKE_NOW_SECONDS - ancestor.ageSeconds}`),
        '',
      ].join('\n'),
    );

    // Answers per commit and records which commits were asked about, so a test
    // can prove the step did NOT walk when it had no reason to.
    writeFileSync(
      join(fakeBin, 'gh'),
      [
        '#!/bin/sh',
        'case " $* " in *" --paginate "*) ;; *) exit 91 ;; esac',
        'case " $* " in *" --slurp "*) ;; *) exit 92 ;; esac',
        'case "$*" in *"/statuses?per_page=100"*) ;; *) exit 93 ;; esac',
        'sha=""',
        'for arg in "$@"; do',
        '  case "$arg" in',
        '    */commits/*/statuses*)',
        '      rest=${arg#*/commits/}',
        '      sha=${rest%%/statuses*}',
        '      ;;',
        '  esac',
        'done',
        '[ -n "$sha" ] || exit 94',
        'printf \'%s\\n\' "$sha" >> "$FAKE_REQUEST_LOG"',
        '[ -f "$FAKE_STATUS_DIR/$sha.json" ] || exit 95',
        'cat "$FAKE_STATUS_DIR/$sha.json"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fakeBin, 'git'),
      [
        '#!/bin/sh',
        'case "$1" in log) ;; *) exit 90 ;; esac',
        'case " $* " in *" --first-parent "*) ;; *) exit 91 ;; esac',
        // The walk must start from the revision the job checked out, not from
        // whatever branch the runner happens to sit on.
        'case "$*" in *"$FAKE_HEAD_SHA"*) ;; *) exit 92 ;; esac',
        'cat "$FAKE_GIT_LOG"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fakeBin, 'date'),
      [
        '#!/bin/sh',
        'case "$1" in +%s) ;; *) exit 90 ;; esac',
        'printf \'%s\\n\' "$FAKE_NOW_SECONDS"',
        '',
      ].join('\n'),
    );
    for (const command of ['gh', 'git', 'date']) chmodSync(join(fakeBin, command), 0o755);

    const result = spawnSync(
      'bash',
      ['-e', '-c', scheduledGateStep().run],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          FAKE_GIT_LOG: gitLogFile,
          FAKE_HEAD_SHA: HEAD_SHA,
          FAKE_NOW_SECONDS: String(FAKE_NOW_SECONDS),
          FAKE_REQUEST_LOG: requestLog,
          FAKE_STATUS_DIR: statusDir,
          GATED_ANCESTOR_LIMIT: scheduledGateStep().env.GATED_ANCESTOR_LIMIT,
          GATED_ANCESTOR_MAX_AGE_SECONDS: scheduledGateStep().env.GATED_ANCESTOR_MAX_AGE_SECONDS,
          GH_TOKEN: 'test-token',
          GITHUB_OUTPUT: outputFile,
          GITHUB_REPOSITORY: 'koala73/worldmonitor',
          GITHUB_SHA: HEAD_SHA,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      },
    );
    return {
      ...result,
      output: readFileSync(outputFile, 'utf8'),
      requested: readFileSync(requestLog, 'utf8').split('\n').filter(Boolean),
    };
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
  it('monitors the checked-out main SHA when its gate passed', () => {
    const success = runScheduledGate('success', [
      { sha: 'aaaaaaaaaaaaaaaa', state: 'success', ageSeconds: 900 },
    ]);
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.output, new RegExp(`sha=${HEAD_SHA}`));
    // A decided head is the answer. Reading any ancestor here would mean the
    // step can silently grade a revision nobody asked about.
    assert.deepEqual(success.requested, [HEAD_SHA]);
  });

  it('fails closed when the gate DECIDED against the checked-out main SHA', () => {
    for (const state of ['failure', 'error']) {
      const result = runScheduledGate(state, [
        { sha: 'aaaaaaaaaaaaaaaa', state: 'success', ageSeconds: 900 },
      ]);
      assert.notEqual(
        result.status,
        0,
        `${state} must fail the workflow instead of falling back to an older revision`,
      );
      assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`main gate is ${state}`));
      assert.doesNotMatch(result.output, /sha=aaaaaaaaaaaaaaaa/);
      // A red main is a verdict, not a race. Walking past it would retire the
      // alarm this step exists to raise.
      assert.deepEqual(result.requested, [HEAD_SHA]);
    }
  });

  it('falls back to the newest gated ancestor while the head gate is undecided', () => {
    // The deploy gate posts about 6 minutes after a merge and this monitor runs
    // every 15, so an undecided head is the normal state right after a merge —
    // it made every merge produce at least one red run.
    for (const state of ['missing', 'pending']) {
      const result = runScheduledGate(state, [
        { sha: 'bbbbbbbbbbbbbbbb', state: 'pending', ageSeconds: 300 },
        { sha: 'cccccccccccccccc', state: 'success', ageSeconds: 1800 },
        { sha: 'dddddddddddddddd', state: 'success', ageSeconds: 3600 },
      ]);
      assert.equal(result.status, 0, `${state} head with a gated ancestor must still probe: ${result.stderr}`);
      assert.match(result.output, /sha=cccccccccccccccc/, 'must take the NEWEST gated ancestor');
      assert.doesNotMatch(result.output, /sha=dddddddddddddddd/);
      assert.match(`${result.stdout}`, new RegExp(`Head gate is ${state}`));
    }
  });

  it('fails closed when no revision in the window has a successful gate', () => {
    const result = runScheduledGate('pending', [
      { sha: 'bbbbbbbbbbbbbbbb', state: 'pending', ageSeconds: 300 },
      { sha: 'cccccccccccccccc', state: 'failure', ageSeconds: 900 },
    ]);
    assert.notEqual(result.status, 0, 'an ungated window must not produce a green acceptance');
    assert.match(`${result.stdout}\n${result.stderr}`, /none of the last 25 main revisions/);
    assert.equal(result.output.includes('sha='), false);
  });

  it('fails closed when the newest gated ancestor is older than the age bound', () => {
    const bound = Number(scheduledGateStep().env.GATED_ANCESTOR_MAX_AGE_SECONDS);

    const inside = runScheduledGate('pending', [
      { sha: 'cccccccccccccccc', state: 'success', ageSeconds: bound },
    ]);
    assert.equal(inside.status, 0, `exactly at the bound must still probe: ${inside.stderr}`);
    assert.match(inside.output, /sha=cccccccccccccccc/);

    const outside = runScheduledGate('pending', [
      { sha: 'cccccccccccccccc', state: 'success', ageSeconds: bound + 1 },
      // A newer green revision does not exist; an older one must not be reached
      // for, or "main has not been gated in hours" would monitor from last week.
      { sha: 'dddddddddddddddd', state: 'success', ageSeconds: bound + 2 },
    ]);
    assert.notEqual(outside.status, 0, 'past the bound the staleness IS the fault');
    assert.match(`${outside.stdout}\n${outside.stderr}`, new RegExp(`is ${bound + 1}s old \\(limit ${bound}s\\)`));
    assert.equal(outside.output.includes('sha='), false);
  });

  it('keeps the gate step fail-closed and newest-first', () => {
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

  it('checks out the resolved revision before any probe reads the repository', () => {
    const checkout = stepNamed('Check out the gated main revision');
    const checkoutIndex = monitorSteps.indexOf(checkout);
    const gateIndex = monitorSteps.indexOf(scheduledGateStep());
    // The audit reads scripts/railway-services.json and the acceptance probe
    // reads scripts/seed-freshness-baseline.json FROM THE WORKING TREE. Moving
    // the tree after either has run would grade one revision with another
    // revision's suppression list.
    const firstProbeIndex = monitorSteps.findIndex(
      (step) => step.name === 'Audit Railway ingestion deployment controls',
    );
    assert.ok(gateIndex < checkoutIndex && checkoutIndex < firstProbeIndex);
    assert.equal(checkout.if, "${{ steps.gate.outputs.sha != '' && steps.gate.outputs.sha != github.sha }}");
    // The SHA arrives as an environment value. Interpolating `${{ }}` straight
    // into the script would splice workflow-expression output into bash.
    assert.equal(checkout.env.GATED_SHA, '${{ steps.gate.outputs.sha }}');
    assert.match(checkout.run, /git checkout --detach "\$GATED_SHA"/);
    assert.doesNotMatch(checkout.run, /\$\{\{/);
    assertBashSyntax(checkout.run);
    assertBashSyntax(scheduledGateStep().run);
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
