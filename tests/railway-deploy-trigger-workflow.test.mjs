// #6142 — the control plane around the only workflow in this repository that
// deploys to production on its own.
//
// Everything asserted here is a property that, if it silently flipped, would
// either deploy an unverified commit or quietly stop deploying anything while
// the workflow still reported success.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(repoRoot, '.github/workflows/railway-deploy-trigger.yml'), 'utf8');
const workflow = YAML.parse(source);
const steps = workflow.jobs.trigger.steps;

function stepNamed(name) {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `the deploy trigger workflow must define "${name}"`);
  return step;
}

const GATE_GUARD = "steps.head.outputs.gate == 'success'";

describe('Railway deploy trigger workflow', () => {
  it('requires main\'s required gates to be green before it can deploy', () => {
    // The whole design is "replace Railway's blunt whole-check-suite rule with
    // the repository's own required-gate rule". Losing this guard does not
    // degrade the workflow, it turns it into a way to deploy a red commit.
    const gate = steps.find((step) => step.id === 'head');
    assert.ok(gate, 'the workflow must resolve main\'s head and its gate status');
    assert.match(gate.run, /context == "gate"/);
    assert.match(gate.run, /rev-parse origin\/main/);

    // Only the MUTATING step is gate-gated. Installing the CLI and validating
    // the token mutate nothing, and gating those on a green gate is what broke
    // previewing while main was red — so the guard belongs on the deploy, not
    // on its prerequisites.
    const deploy = stepNamed('Trigger deploys for services this merge changed');
    assert.ok(
      String(deploy.if).includes(GATE_GUARD),
      'the deploying step must not run unless the gate is green',
    );
  });

  it('gates nothing that mutates production on anything weaker than the gate', () => {
    // The inverse of the above, so a future edit cannot quietly move a
    // production mutation into a step with a laxer condition. The preview is
    // the only step allowed to run without a green gate, and it is --dry-run.
    for (const step of steps) {
      const run = String(step.run ?? '');
      if (!run.includes('trigger-railway-deploys.mjs')) continue;
      const guarded = String(step.if ?? '').includes(GATE_GUARD);
      assert.ok(
        guarded || run.includes('--dry-run'),
        `"${step.name}" invokes the deploy trigger without a green-gate guard and without --dry-run`,
      );
    }
  });

  it('defers on a pending gate but fails on a red one', () => {
    const gate = steps.find((step) => step.id === 'head');
    // Pending is "not yet", which is normal seconds after a merge and must not
    // red a scheduled workflow. Failure is "this commit is not deployable" and
    // must be loud.
    assert.match(gate.run, /"pending"/);
    assert.match(gate.run, /exit 1/);
  });

  it('never cancels a run in progress', () => {
    // This is the mutating workflow. A cancelled sweep leaves part of the fleet
    // triggered and no record of where it stopped.
    assert.equal(workflow.concurrency?.['cancel-in-progress'], false);
  });

  it('checks out full history without blobs', () => {
    // Every service is compared against the commit IT is running, and an
    // unreachable running commit resolves to "deploy" — so a shallow checkout
    // would rebuild the entire fleet on every run rather than fail quietly.
    const checkout = steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
    assert.ok(checkout, 'the workflow must check the repository out');
    assert.equal(checkout.with?.['fetch-depth'], 0);
    assert.equal(checkout.with?.filter, 'blob:none');
  });

  it('pins the Railway CLI to the same version the monitor uses', () => {
    // The two read the same deployment records and must not drift into
    // different output shapes.
    const monitor = readFileSync(resolve(repoRoot, '.github/workflows/seed-freshness-monitor.yml'), 'utf8');
    const pinned = /@railway\/cli@(\d+\.\d+\.\d+)/;
    const here = stepNamed('Install pinned Railway CLI').run.match(pinned);
    const there = monitor.match(pinned);
    assert.ok(here && there, 'both workflows must pin the Railway CLI');
    assert.equal(here[1], there[1], 'deploy trigger and freshness monitor must pin the same Railway CLI');
  });

  it('lets a failed deploy red the run', () => {
    // An unauthorized mutation or an unreadable deployment history means
    // services stayed behind. Swallowing that reproduces the exact failure mode
    // this work exists to remove: a green report over a stale fleet.
    const deploy = stepNamed('Trigger deploys for services this merge changed');
    assert.equal(deploy['continue-on-error'], undefined);
    assert.match(deploy.run, /node scripts\/trigger-railway-deploys\.mjs/);
    assert.match(deploy.run, /--head/);
  });

  it('keeps previewing and deploying in separate steps', () => {
    // One step carrying a conditional --dry-run flag would need its run
    // condition and its flag expression to agree forever, and the day they
    // diverge the arm that still runs is the one that deploys. Separate steps
    // make each condition decide both whether it runs and what it does.
    const deploy = stepNamed('Trigger deploys for services this merge changed');
    assert.ok(
      !deploy.run.includes('--dry-run'),
      'the deploying step must never carry a conditional --dry-run flag',
    );
    const preview = stepNamed('Preview what would be deployed');
    assert.ok(preview.run.includes('--dry-run'), 'the preview step must pass --dry-run');
  });

  it('only ever previews on an explicit human dry-run request', () => {
    // A preview reachable from the schedule would leave the workflow reporting
    // a plan it never executed.
    const preview = stepNamed('Preview what would be deployed');
    assert.match(String(preview.if), /github\.event_name == 'workflow_dispatch'/);
    assert.match(String(preview.if), /inputs\.dryRun/);
  });

  it('never deploys on a run the operator asked to be a preview', () => {
    const deploy = stepNamed('Trigger deploys for services this merge changed');
    assert.match(
      String(deploy.if),
      /!\(github\.event_name == 'workflow_dispatch' && inputs\.dryRun\)/,
      'a dry-run dispatch must not also take the deploying arm',
    );
  });

  it('lets an operator preview while main is red', () => {
    // The moment you most need to read the plan is when the gate is not green
    // and the fleet is falling behind — which is exactly when the deploy step
    // is correctly refusing to run. Previewing mutates nothing.
    //
    // Asserting only that the preview's `if` omits the gate is NOT enough: that
    // passed while previewing on a red gate was broken two different ways —
    // the gate step exited 1 before the preview could run, and the CLI it
    // shells out to was installed only on a green gate. Both are pinned below.
    const preview = stepNamed('Preview what would be deployed');
    assert.ok(
      !String(preview.if).includes('steps.head.outputs.gate'),
      'previewing must not require a green gate',
    );
  });

  it('installs the Railway CLI on any run that shells out to it', () => {
    // The preview runs `railway` too. Gating the install on a green gate made
    // `railway: command not found` the actual behaviour of previewing while
    // main was red.
    const install = stepNamed('Install pinned Railway CLI');
    const preview = stepNamed('Preview what would be deployed');
    for (const clause of String(preview.if).split('&&').map((part) => part.trim())) {
      assert.ok(
        String(install.if).includes(clause),
        `the CLI install must also run when the preview does — missing "${clause}"`,
      );
    }
  });

  it('does not let the gate step hard-fail a dry run before it previews', () => {
    // The gate step `exit 1`s on a failed gate, and the preview defaults to
    // success() — so without an explicit dry-run carve-out the preview is
    // skipped entirely on exactly the runs it exists for.
    const gate = steps.find((step) => step.id === 'head');
    assert.ok(
      String(gate.env?.DRY_RUN ?? '').includes('inputs.dryRun'),
      'the gate step must know whether this run is a dry run',
    );
    assert.match(
      gate.run,
      /DRY_RUN[^\n]*!=\s*"success"|"\$\{DRY_RUN:-false\}"\s*=\s*"true"/,
      'the gate step must branch on the dry run before it can exit 1',
    );
  });

  // Expand the minute field of the cron shapes these two workflows use into the
  // concrete minutes it fires on. Comparing the raw strings would call `*/15`
  // and `7,22,37,52` disjoint no matter what they mean.
  function minutesOf(workflowDefinition) {
    const minutes = new Set();
    for (const entry of workflowDefinition.on?.schedule ?? []) {
      for (const term of entry.cron.split(' ')[0].split(',')) {
        const step = /^\*\/(\d+)$/.exec(term);
        if (step) {
          for (let minute = 0; minute < 60; minute += Number(step[1])) minutes.add(minute);
        } else if (term === '*') {
          for (let minute = 0; minute < 60; minute += 1) minutes.add(minute);
        } else {
          minutes.add(Number(term));
        }
      }
    }
    return minutes;
  }

  it('contains no empty GitHub expression, which fails the whole file to parse', () => {
    // Cost a full cycle. An EMPTY GitHub expression — the opener, whitespace,
    // the closer — written inside a shell COMMENT in a `run:` block is still
    // seen by GitHub's expression parser, which scans the entire block scalar,
    // and it rejects the workflow with "An expression was expected". (The
    // literal is deliberately not written here: this test would then flag its
    // own source.) The consequences are exactly the failure mode this file exists
    // to prevent, one level up: a workflow that fails to parse publishes NO
    // check run, so the PR stays green, it is absent from the deploy gate's
    // required list, and every trigger — event, cron and dispatch alike — stops
    // producing runs. Observed as run 30981164081: conclusion=failure, zero
    // jobs, and `name` reported as the file path instead of the workflow name.
    //
    // The `yaml` parser this file uses accepts it, so nothing else in CI can
    // catch this. Scan every workflow, not just this one.
    const workflowDir = resolve(repoRoot, '.github/workflows');
    const offenders = [];
    for (const file of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
      const text = readFileSync(resolve(workflowDir, file), 'utf8');
      text.split('\n').forEach((line, index) => {
        if (/\$\{\{\s*\}\}/.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    assert.deepEqual(offenders, [], 'empty GitHub expression(s) found; these make the workflow unparseable');
  });

  it('reconciles when the gate it waits on has just resolved', () => {
    // #6203: a 5-minute cron on this repository is not a cadence we have.
    // Measured over the 2h03m after e2db6b6a9 the workflow got ONE scheduled
    // run against ~24 expected ticks, because GitHub drops high-frequency
    // schedules under load — and the fleet sat 19.5h behind a green badge.
    //
    // Deploy Gate completing on main is both immediate and immune to schedule
    // throttling, and it fires exactly when the `gate` status this workflow
    // reads has just been written. Chain depth is Test -> Deploy Gate -> here,
    // which is inside GitHub's three-level workflow_run limit.
    const trigger = workflow.on?.workflow_run;
    assert.ok(trigger, 'the reconciler must be driven by an event, not by a schedule alone');
    assert.deepEqual(trigger.workflows, ['Deploy Gate']);
    assert.deepEqual(trigger.types, ['completed']);
    assert.deepEqual(
      trigger.branches,
      ['main'],
      'every PR head would otherwise wake the fleet reconciler',
    );
  });

  it('keeps the cron only as a slow backstop, never as the primary cadence', () => {
    // The cron survives the one failure an event trigger cannot self-heal (a
    // webhook outage, #6064) and nothing else. Asking for it more often than
    // hourly is asking for the tick GitHub already proved it drops, and it
    // would re-establish the burst this workflow's concurrency group exists to
    // collapse.
    const ours = minutesOf(workflow);
    assert.equal(
      ours.size,
      1,
      `the backstop must fire at most once an hour; it fires on ${ours.size} minute(s) past the hour`,
    );
  });

  it('runs on a schedule offset from the freshness monitor', () => {
    // Both make one Railway API call per service across a 77-service fleet;
    // sharing a minute is how one of them starts getting rate limited.
    const ours = minutesOf(workflow);
    assert.ok(ours.size > 0, 'the reconciler must run on a schedule');
    const monitor = minutesOf(YAML.parse(
      readFileSync(resolve(repoRoot, '.github/workflows/seed-freshness-monitor.yml'), 'utf8'),
    ));
    assert.ok(monitor.size > 0, 'the freshness monitor schedule stopped parsing — this comparison is now vacuous');
    const collisions = [...ours].filter((minute) => monitor.has(minute));
    assert.deepEqual(collisions, [], 'deploy trigger and freshness monitor fire on the same minute');
  });

  it('gives every Railway-invoking step the project id, not just the verify step', () => {
    // A clean runner has no .railway link, so `railway status` — which
    // resolveEnvironmentId calls on the deploy path — answers "No linked
    // project found" without --project, and JSON.parse fails at the moment of
    // deploying. Verified locally from an unlinked directory.
    for (const step of steps) {
      const run = String(step.run ?? '');
      const usesRailway = run.includes('trigger-railway-deploys.mjs') || run.includes('railway ');
      if (!usesRailway) continue;
      assert.ok(
        step.env?.RAILWAY_PROJECT_ID,
        `"${step.name}" talks to Railway but is not given RAILWAY_PROJECT_ID`,
      );
    }
  });

  it('says out loud when a run declined to deploy anything', () => {
    // #6203's second half. "Reconciled the fleet" and "skipped every step that
    // does work" are both `success` at the workflow-status level, so the fleet
    // can sit stranded behind a green badge. The distinction has to be written
    // somewhere a human reads without opening the raw log.
    const report = stepNamed('Report what this run did');
    assert.equal(String(report.if), 'always()', 'the outcome report must survive a failed step');
    assert.match(report.run, /GITHUB_STEP_SUMMARY/, 'the outcome must reach the job summary');
    assert.match(report.run, /::warning::/, 'a declined run must raise an annotation, not just a log line');

    // It can only tell the two apart if it is given the deploy step's outcome,
    // which needs that step to carry an id.
    const deploy = stepNamed('Trigger deploys for services this merge changed');
    assert.ok(deploy.id, 'the deploying step must be addressable by the outcome report');
    assert.ok(
      Object.values(report.env ?? {}).some(
        (value) => String(value).includes(`steps.${deploy.id}.outcome`),
      ),
      'the outcome report must read the deploying step\'s outcome',
    );
  });

  it('never asks the age question on a run whose own deploy just succeeded', () => {
    // The scan reads COMPLETED runs and excludes this one, so a run that just
    // reconciled cannot see its own work. After a drought past the threshold —
    // the exact recovery this workflow exists for — the run that FIXED the
    // fleet would report it stale and go red.
    //
    // And a red run here is not cosmetic: this workflow's runs carry a main
    // commit as head_sha, so the failure lands in that commit's check suite,
    // which is the `CI check suite failed` reason Railway uses to defer every
    // service. The alarm would cause the outage it detects.
    const step = steps.find((candidate) => String(candidate.run ?? '')
      .includes('check-railway-reconcile-age.mjs'));
    const deploy = stepNamed('Trigger deploys for services this merge changed');
    assert.match(
      String(step.if),
      /always\(\)/,
      'the age check must still run on a declined run — that is the case it exists for',
    );
    assert.ok(
      String(step.if).includes(`steps.${deploy.id}.outcome != 'success'`),
      'the age check must be skipped when this run already reconciled the fleet',
    );
  });

  it('reads its own run history, which needs the actions scope', () => {
    assert.equal(
      workflow.permissions?.actions,
      'read',
      'reading this workflow\'s own runs requires actions: read',
    );
  });

  it('keeps the age check warn-only on a dry run, in two explicit arms', () => {
    // One interpolated flag would have to agree with the env var forever; the
    // day they diverge the arm that still runs is the one that stays quiet.
    const step = steps.find((candidate) => String(candidate.run ?? '')
      .includes('check-railway-reconcile-age.mjs'));
    assert.match(String(step.env?.WARN_ONLY ?? ''), /inputs\.dryRun/);
    assert.match(step.run, /--warn-only/, 'the dry-run arm must pass --warn-only');
    assert.match(
      step.run,
      /check-railway-reconcile-age\.mjs\s*$/m,
      'the non-dry-run arm must invoke the check without --warn-only',
    );
  });

  it('surfaces a failed age check in the summary a human reads', () => {
    // Otherwise a run can be red for "the fleet is un-reconciled" while its
    // job summary reads as an ordinary decline.
    const report = stepNamed('Report what this run did');
    const step = steps.find((candidate) => String(candidate.run ?? '')
      .includes('check-railway-reconcile-age.mjs'));
    assert.ok(step.id, 'the age check must be addressable by the outcome report');
    assert.ok(
      Object.values(report.env ?? {}).some(
        (value) => String(value).includes(`steps.${step.id}.outcome`),
      ),
      'the outcome report must read the age check\'s outcome',
    );
  });

  it('fails when the fleet has gone un-reconciled longer than the backstop tolerates', () => {
    // The existing escalation only fires on a PENDING gate, and only when this
    // workflow runs — which is the precondition that failed. This one asks the
    // question that does not depend on why: when did anything last reconcile?
    const step = steps.find((candidate) => String(candidate.run ?? '')
      .includes('check-railway-reconcile-age.mjs'));
    assert.ok(step, 'the workflow must check how long the fleet has gone un-reconciled');
    assert.ok(step.env?.GH_TOKEN, 'the age check reads this workflow\'s own run history');
    assert.equal(
      step['continue-on-error'],
      undefined,
      'an un-reconciled fleet must red the run, not be swallowed',
    );
  });

  it('runs against the environment that holds the production Railway token', () => {
    assert.equal(workflow.jobs.trigger.environment?.name, 'ingestion-acceptance-production');
    assert.equal(
      stepNamed('Trigger deploys for services this merge changed').env.RAILWAY_TOKEN,
      '${{ secrets.RAILWAY_PRODUCTION_TOKEN }}',
    );
  });
});
