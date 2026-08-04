// #6142 — the control plane around the only workflow in this repository that
// deploys to production on its own.
//
// Everything asserted here is a property that, if it silently flipped, would
// either deploy an unverified commit or quietly stop deploying anything while
// the workflow still reported success.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

    for (const name of [
      'Install pinned Railway CLI',
      'Verify Railway production context',
      'Trigger deploys for services this merge changed',
    ]) {
      assert.equal(
        stepNamed(name).if,
        GATE_GUARD,
        `"${name}" must not run unless the gate is green`,
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

  it('only ever dry-runs when a human asked it to', () => {
    // A --dry-run that could leak into the scheduled path would leave the
    // workflow reporting a plan it never executed.
    const deploy = stepNamed('Trigger deploys for services this merge changed');
    if (!deploy.run.includes('--dry-run')) return;
    assert.match(deploy.run, /github\.event_name == 'workflow_dispatch'/);
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

  it('runs against the environment that holds the production Railway token', () => {
    assert.equal(workflow.jobs.trigger.environment?.name, 'ingestion-acceptance-production');
    assert.equal(
      stepNamed('Trigger deploys for services this merge changed').env.RAILWAY_TOKEN,
      '${{ secrets.RAILWAY_PRODUCTION_TOKEN }}',
    );
  });
});
