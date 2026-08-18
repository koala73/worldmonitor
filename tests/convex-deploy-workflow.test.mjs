// The Convex workflow mutates production on its own. These tests pin the gate
// that prevents a failing main commit from being deployed while preserving the
// existing explicit operator override for manual recovery runs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(repoRoot, '.github/workflows/convex-deploy.yml'), 'utf8');
const workflow = YAML.parse(source);
const gate = workflow.jobs.gate;
const deploy = workflow.jobs.deploy;
const waitStep = gate.steps.find((step) => step.name === 'Wait for the merge gate on this commit');

describe('Convex deploy workflow', () => {
  it('waits for the required gate before deploying a push', () => {
    assert.ok(waitStep, 'the workflow must define a merge-gate wait step');
    assert.match(waitStep.run, /context == "gate"/);
    assert.match(waitStep.run, /failure\|error/);
    assert.match(waitStep.run, /timed out[\s\S]*exit 1/);
  });

  it('reads the complete newest-first gate status history', () => {
    assert.match(waitStep.run, /gh api --paginate --slurp/);
    assert.match(waitStep.run, /statuses\?per_page=100/);
    assert.match(waitStep.run, /map\(select\(\.context == "gate"\)\) \| first/);
    assert.doesNotMatch(waitStep.run, /sort_by/);
  });

  it('grants only the gate job permission to read statuses', () => {
    assert.equal(workflow.permissions?.statuses, undefined);
    assert.equal(gate.permissions?.contents, 'read');
    assert.equal(gate.permissions?.statuses, 'read');
  });

  it('requires the gate job to succeed before the deploy job can run', () => {
    assert.deepEqual(deploy.needs, ['changes', 'gate']);
    assert.match(String(deploy.if), /needs\.gate\.result == 'success'/);
  });

  it('keeps the explicit manual recovery override inside the non-mutating gate job', () => {
    assert.match(waitStep.run, /github\.event_name[^\n]*workflow_dispatch/);
    assert.match(waitStep.run, /workflow_dispatch: skipping gate wait/);
    assert.doesNotMatch(String(deploy.if), /workflow_dispatch/);
  });

  it('never cancels a production deployment in progress', () => {
    assert.equal(workflow.concurrency?.['cancel-in-progress'], false);
  });
});
