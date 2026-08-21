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

function stepNamed(name, steps = monitorSteps) {
  const step = steps.find((candidate) => candidate.name === name);
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

function runPublisherWithoutActivation(acceptanceOutcome) {
  const tempDir = mkdtempSync(join(repoRoot, '.tmp-seed-freshness-publisher-'));
  try {
    const publisher = stepNamed('Publish ingestion operational transitions');
    return spawnSync('bash', ['-e', '-c', publisher.run], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        SEED_ACCEPTANCE_OUTCOME: acceptanceOutcome,
        SEED_ACCEPTANCE_SHA: HEAD_SHA,
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runPublisherFromLegacyRevision() {
  const tempDir = mkdtempSync(join(repoRoot, '.tmp-seed-freshness-legacy-publisher-'));
  const scriptsDir = join(tempDir, 'scripts');
  const argsLog = join(tempDir, 'publisher-args.json');
  const reportPath = join(tempDir, 'seed-freshness-observation.json');
  try {
    mkdirSync(scriptsDir);
    writeFileSync(join(scriptsDir, 'update-seed-health-statuses.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(process.env.ARGS_LOG, JSON.stringify(process.argv.slice(2)));',
      '',
    ].join('\n'));
    const publisher = stepNamed('Publish ingestion operational transitions');
    const result = spawnSync('bash', ['-e', '-c', publisher.run], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ARGS_LOG: argsLog,
        RUNNER_TEMP: tempDir,
        SEED_ACCEPTANCE_OUTCOME: 'success',
        SEED_ACCEPTANCE_SHA: HEAD_SHA,
        SEED_STATUS_SHA: 'b93afd05d0f4ea2c465e79fd064e87fc1f9fb2f3',
      },
    });
    return { result, args: JSON.parse(readFileSync(argsLog, 'utf8')), reportPath };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

  it('falls back to the newest gated ancestor when the head gate is not success', () => {
    // pending/missing: deploy gate posts ~6 minutes after a merge and this
    // monitor runs every 15, so an undecided head is the normal post-merge
    // state — failing on it made every merge produce at least one red run.
    // failure/error: the `gate` status already owns that verdict. Failing
    // this job too reds the ingestion monitor without looking at seeds.
    for (const state of ['missing', 'pending', 'failure', 'error']) {
      const result = runScheduledGate(state, [
        { sha: 'bbbbbbbbbbbbbbbb', state: 'pending', ageSeconds: 300 },
        { sha: 'cccccccccccccccc', state: 'success', ageSeconds: 1800 },
        { sha: 'dddddddddddddddd', state: 'success', ageSeconds: 3600 },
      ]);
      assert.equal(result.status, 0, `${state} head with a gated ancestor must still probe: ${result.stderr}`);
      assert.match(result.output, /sha=cccccccccccccccc/, 'must take the NEWEST gated ancestor');
      assert.doesNotMatch(result.output, /sha=dddddddddddddddd/);
      assert.match(`${result.stdout}`, new RegExp(`Head gate is ${state}`));
      assert.ok(
        result.requested.includes('cccccccccccccccc'),
        `${state} must walk past the head to the newest gated ancestor`,
      );
    }
  });

  it('fails closed when no revision in the window has a successful gate', () => {
    for (const state of ['pending', 'failure']) {
      const result = runScheduledGate(state, [
        { sha: 'bbbbbbbbbbbbbbbb', state: 'pending', ageSeconds: 300 },
        { sha: 'cccccccccccccccc', state: 'failure', ageSeconds: 900 },
      ]);
      assert.notEqual(result.status, 0, `${state} head with an ungated window must not produce a green acceptance`);
      assert.match(`${result.stdout}\n${result.stderr}`, /none of the last 25 main revisions/);
      assert.equal(result.output.includes('sha='), false);
    }
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
    assert.equal(acceptance.id, 'acceptance');
    assert.match(GATE_GUARD, /steps\.gate\.conclusion != 'failure'/);
    assert.equal(acceptance['continue-on-error'], true, 'health incidents are classified by the status publisher');
    assert.match(acceptance.run, /--json-output "\$RUNNER_TEMP\/seed-freshness-observation\.json"/);

    const publisher = stepNamed('Publish ingestion operational transitions');
    assert.equal(publisher.if, GATE_GUARD);
    assert.equal(publisher['continue-on-error'], undefined);
    assert.equal(publisher.env.GH_TOKEN, '${{ github.token }}');
    assert.equal(publisher.env.SEED_ACCEPTANCE_SHA, '${{ steps.gate.outputs.sha || github.sha }}');
    assert.equal(publisher.env.SEED_ACCEPTANCE_OUTCOME, '${{ steps.acceptance.outcome }}');
    assert.equal(publisher.env.SEED_STATUS_SHA, 'b93afd05d0f4ea2c465e79fd064e87fc1f9fb2f3');
    assert.equal(publisher.env.SEED_STATUS_WRITER_LOGIN, 'github-actions[bot]');
    assert.match(publisher.run, /update-seed-health-statuses\.mjs/);
    assert.match(publisher.run, /if \[ ! -f scripts\/update-seed-health-statuses\.mjs \]/);
    assert.match(publisher.run, /not active on gated revision/);
    assert.match(publisher.run, /--sha "\$SEED_ACCEPTANCE_SHA"/);
    assert.match(publisher.run, /status_args=\(\)/);
    assert.match(publisher.run, /grep -q -- "'status-sha':"/);
    assert.match(publisher.run, /status_args=\(--status-sha "\$SEED_STATUS_SHA"\)/);
    assert.match(publisher.run, /"\$\{status_args\[@\]\}"/);
    assert.match(publisher.run, /--report "\$RUNNER_TEMP\/seed-freshness-observation\.json"/);
    assertBashSyntax(publisher.run);
    assert.equal(workflow.permissions.statuses, 'write');
  });

  it('fails closed when a strict probe fails before the transition publisher is active', () => {
    const failure = runPublisherWithoutActivation('failure');
    assert.notEqual(failure.status, 0, 'a failed strict probe must not finish green without its publisher');
    assert.match(`${failure.stdout}\n${failure.stderr}`, /acceptance failed.*no transition publisher is available/i);

    const success = runPublisherWithoutActivation('success');
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /waiting for a gated activation revision/);
  });

  it('keeps the pre-anchor publisher compatible during the first gated-revision race', () => {
    const legacy = runPublisherFromLegacyRevision();
    assert.equal(legacy.result.status, 0, legacy.result.stderr);
    assert.deepEqual(legacy.args, [
      '--sha', HEAD_SHA,
      '--report', legacy.reportPath,
    ]);
  });

  it('checks out the resolved revision before the ingestion probe', () => {
    const checkout = stepNamed('Check out the gated main revision');
    const checkoutIndex = monitorSteps.indexOf(checkout);
    const gateIndex = monitorSteps.indexOf(scheduledGateStep());
    const acceptanceIndex = monitorSteps.findIndex(
      (step) => step.name === 'Check ingestion operational acceptance',
    );
    const publisherIndex = monitorSteps.findIndex(
      (step) => step.name === 'Publish ingestion operational transitions',
    );
    assert.ok(gateIndex < checkoutIndex && checkoutIndex < acceptanceIndex && acceptanceIndex < publisherIndex);
    assert.equal(checkout.if, "${{ steps.gate.outputs.sha != '' && steps.gate.outputs.sha != github.sha }}");
    assert.equal(checkout.env.GATED_SHA, '${{ steps.gate.outputs.sha }}');
    assert.match(checkout.run, /git checkout --detach "\$GATED_SHA"/);
    assert.doesNotMatch(checkout.run, /\$\{\{/);
    assertBashSyntax(checkout.run);
    assertBashSyntax(scheduledGateStep().run);
  });

  it('reports ingestion acceptance only', () => {
    assert.deepEqual(Object.keys(workflow.jobs), ['monitor']);
    assert.deepEqual(workflow.jobs.monitor.environment, {
      name: 'ingestion-acceptance-production',
      deployment: false,
    });
    const checkout = monitorSteps.find(
      (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    );
    assert.equal(checkout.with?.['fetch-depth'], 0);
    assert.equal(checkout.with?.filter, 'blob:none');
    assert.deepEqual(
      workflow.concurrency,
      { group: 'seed-freshness-monitor', 'cancel-in-progress': false },
    );
    assert.equal(workflow.on.schedule[0].cron, '*/15 * * * *');
    assert.doesNotMatch(
      workflowSource,
      /Railway|RAILWAY_|railway-deploy|audit-railway-watch-paths|check-railway-deploy-drift|@railway\/cli/i,
      'deployment configuration and image drift belong to their own workflow',
    );
  });
});
