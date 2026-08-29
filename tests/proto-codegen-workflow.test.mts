import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(root, '.github/workflows/proto-check.yml');
const workflowSource = readFileSync(workflowPath, 'utf8');
const contributing = readFileSync(resolve(root, 'CONTRIBUTING.md'), 'utf8');

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type Job = {
  if?: string;
  needs?: string[] | string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
};

type Workflow = {
  concurrency?: Record<string, unknown>;
  jobs?: Record<string, Job>;
  permissions?: Record<string, string>;
};

const workflow = parseYaml(workflowSource) as Workflow;
const jobs = workflow.jobs ?? {};

function job(name: string): Job {
  const value = jobs[name];
  assert.ok(value, `proto-check.yml must define ${name}`);
  return value;
}

function stepByName(jobName: string, name: string): Step {
  const value = job(jobName).steps?.find((step) => step.name === name);
  assert.ok(value, `${jobName} must define step: ${name}`);
  return value;
}

describe('proto codegen workflow trust boundaries (#3340)', () => {
  it('defaults to no token permissions and never uses pull_request_target', () => {
    assert.deepEqual(workflow.permissions, {});
    assert.doesNotMatch(workflowSource, /pull_request_target/);
    assert.equal(workflow.concurrency?.['cancel-in-progress'], true);
  });

  it('never executes fork-controlled code in the artifact-presence job', () => {
    const fork = job('fork-artifact-check');
    assert.deepEqual(fork.permissions, { contents: 'read' });
    assert.match(fork.if ?? '', /head\.repo\.full_name != github\.repository/);

    const executedCommands = (fork.steps ?? [])
      .flatMap((step) => (step.run ?? '').split('\n'))
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
    assert.doesNotMatch(executedCommands, /^(?:make|npm|node|npx|tsx|buf)\s/m);
    assert.equal(fork.steps?.[0]?.with?.['persist-credentials'], false);

    const inspection = stepByName('fork-artifact-check', 'Require generated artifacts when codegen inputs change').run ?? '';
    assert.match(inspection, /INPUT_CHANGED/);
    assert.match(inspection, /scripts\/generate-request-validation/);
    assert.match(inspection, /GENERATED_CHANGED/);
  });

  it('uses the trusted main Makefile for the fork-visible breaking check', () => {
    const breaking = job('proto-breaking');
    assert.deepEqual(breaking.permissions, { contents: 'read' });
    assert.doesNotMatch(breaking.if ?? '', /head\.repo/);
    assert.equal(breaking.steps?.[0]?.with?.['fetch-depth'], 0);
    assert.equal(breaking.steps?.[0]?.with?.['persist-credentials'], false);

    const restore = stepByName('proto-breaking', 'Restore the trusted main Makefile').run ?? '';
    assert.equal(restore, 'git show origin/main:Makefile > Makefile');
    assert.equal(stepByName('proto-breaking', 'Check for breaking proto changes').run, 'make breaking');
  });

  it('withholds the write credential until generation is complete', () => {
    const internal = job('internal-auto-generate');
    assert.deepEqual(internal.permissions, { contents: 'write', statuses: 'write' });

    const checkout = internal.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.['persist-credentials'], false);
    assert.match(String(checkout?.with?.ref), /pull_request\.head\.sha/);

    const generator = stepByName('internal-auto-generate', 'Run proto generation');
    assert.equal(generator.run, 'make generate');
    assert.equal(generator.env?.GH_TOKEN, undefined);

    const commit = stepByName('internal-auto-generate', 'Commit generated artifacts to the internal PR branch');
    assert.match(commit.env?.GH_TOKEN ?? '', /github\.token/);
    assert.match(commit.run ?? '', /REMOTE_HEAD.*EXPECTED_HEAD_SHA/s);
    assert.match(commit.run ?? '', /push origin "HEAD:refs\/heads\/\$PR_HEAD_REF"/);
    assert.doesNotMatch(commit.run ?? '', /push\s+--force|push\s+-f/);
  });

  it('fails generator writes outside the two generated directories', () => {
    const guard = stepByName(
      'internal-auto-generate',
      'Reject generator writes outside generated artifact directories',
    ).run ?? '';

    assert.match(guard, /exclude\)src\/generated\/\*\*/);
    assert.match(guard, /exclude\)docs\/api\/\*\*/);
    assert.match(guard, /git diff --cached --quiet/);
    assert.match(guard, /UNEXPECTED_UNTRACKED/);
  });

  it('requires a clean follow-up on the generated SHA and preserves the aggregate check name', () => {
    const commit = stepByName('internal-auto-generate', 'Commit generated artifacts to the internal PR branch').run ?? '';
    assert.match(commit, /context=proto-generated-followup/);
    assert.match(commit, /state=pending/);
    assert.match(commit, /state=success/);

    const aggregate = job('proto-freshness');
    assert.deepEqual(aggregate.permissions, {});
    assert.match(aggregate.if ?? '', /always\(\)/);
    assert.deepEqual(aggregate.needs, [
      'fork-artifact-check',
      'internal-auto-generate',
      'internal-merge-freshness',
    ]);
  });

  it('documents the internal and fork contributor contracts', () => {
    assert.match(contributing, /### Generated Artifacts in Pull Requests/);
    assert.match(contributing, /approval-required state/);
    assert.match(contributing, /`proto-generated-followup` remains pending/);
    assert.match(contributing, /CI does not execute the fork's `Makefile`/);
  });
});
