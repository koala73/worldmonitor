import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
  env?: Record<string, string>;
  jobs?: Record<string, Job>;
  on?: {
    pull_request?: null | Record<string, unknown>;
  };
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

function runChangeClassifier(files?: string[]) {
  const temp = mkdtempSync(join(tmpdir(), 'wm-proto-classifier-'));
  const fakeBin = join(temp, 'bin');
  const output = join(temp, 'output');
  const classifier = stepByName('changes', 'Classify proto codegen paths');

  try {
    mkdirSync(fakeBin);
    writeFileSync(output, '');
    writeFileSync(
      join(fakeBin, 'gh'),
      files
        ? `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify([files.map((filename) => ({ filename }))])}'\n`
        : '#!/bin/sh\nexit 73\n',
      { mode: 0o755 },
    );

    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', classifier.run ?? ''], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...workflow.env,
        GITHUB_OUTPUT: output,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PR_NUMBER: '7397',
        REPOSITORY: 'koala73/worldmonitor',
      },
    });

    return {
      output: readFileSync(output, 'utf8'),
      status: result.status,
      stderr: result.stderr,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe('proto codegen workflow trust boundaries (#3340)', () => {
  it('defaults to no token permissions and never uses pull_request_target', () => {
    assert.deepEqual(workflow.permissions, {});
    assert.doesNotMatch(workflowSource, /pull_request_target/);
    assert.equal(workflow.concurrency?.['cancel-in-progress'], true);
    assert.ok(
      workflow.on?.pull_request == null || Object.keys(workflow.on.pull_request).length === 0,
      'proto-check must always publish its aggregate check; the changes job owns path filtering',
    );
  });

  it('classifies the complete codegen path domain with decoded GitHub paths', () => {
    const input = workflow.env?.CODEGEN_INPUT_REGEX;
    const output = workflow.env?.GENERATED_OUTPUT_REGEX;
    const control = workflow.env?.PROTO_WORKFLOW_REGEX;
    assert.ok(input && output && control, 'workflow must define the three path classes once');

    for (const path of [
      'proto/worldmonitor/example/v1/service.proto',
      'proto/café.proto',
      'scripts/openapi-inject-security.mjs',
      'shared/openapi-filter-param-contracts.json',
      'server/gateway.ts',
      'src/shared/premium-paths.ts',
      'Makefile',
    ]) {
      assert.match(path, new RegExp(input), `${path} must be a codegen input`);
    }
    assert.match('src/generated/client.ts', new RegExp(output));
    assert.match('docs/api/worldmonitor.openapi.yaml', new RegExp(output));
    assert.match('.github/workflows/proto-check.yml', new RegExp(control));

    const unicode = runChangeClassifier(['proto/café.proto']);
    assert.equal(unicode.status, 0, unicode.stderr);
    assert.match(unicode.output, /^codegen=true$/m);
    assert.match(unicode.output, /^relevant=true$/m);

    const workflowOnly = runChangeClassifier(['.github/workflows/proto-check.yml']);
    assert.equal(workflowOnly.status, 0, workflowOnly.stderr);
    assert.match(workflowOnly.output, /^codegen=false$/m);
    assert.match(workflowOnly.output, /^relevant=true$/m);

    const unrelated = runChangeClassifier(['src/components/Panel.ts']);
    assert.equal(unrelated.status, 0, unrelated.stderr);
    assert.match(unrelated.output, /^codegen=false$/m);
    assert.match(unrelated.output, /^relevant=false$/m);
  });

  it('fails closed when GitHub cannot list pull request files', () => {
    const result = runChangeClassifier();
    assert.equal(result.status, 73, result.stderr);
    assert.equal(result.output, '');
  });

  it('never executes fork-controlled code and requires trusted codegen validation', () => {
    const fork = job('fork-artifact-check');
    assert.deepEqual(fork.permissions, {});
    assert.match(fork.if ?? '', /head\.repo\.full_name != github\.repository/);
    assert.match(fork.if ?? '', /dependabot\[bot\]/);
    assert.match(fork.if ?? '', /needs\.changes\.outputs\.codegen == 'true'/);

    const executedCommands = (fork.steps ?? [])
      .flatMap((step) => (step.run ?? '').split('\n'))
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
    assert.doesNotMatch(executedCommands, /^(?:make|npm|node|npx|tsx|buf)\s/m);
    assert.doesNotMatch(executedCommands, /git\s+diff|grep\s+-E/);
    assert.match(executedCommands, /trusted internal branch/i);
    assert.match(executedCommands, /exit 1/);
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

  it('isolates read-only generation from the credentialed writer', () => {
    const generation = job('internal-generate');
    assert.deepEqual(generation.permissions, { contents: 'read' });
    assert.match(generation.if ?? '', /user\.login != 'dependabot\[bot\]'/);
    assert.doesNotMatch(JSON.stringify(generation), /github\.token|GH_TOKEN/);

    const internal = job('internal-auto-generate');
    assert.deepEqual(internal.permissions, { contents: 'write', statuses: 'write' });
    assert.deepEqual(internal.needs, ['changes', 'internal-generate']);
    assert.match(internal.if ?? '', /user\.login != 'dependabot\[bot\]'/);

    const checkout = internal.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.['persist-credentials'], false);
    assert.match(String(checkout?.with?.ref), /pull_request\.head\.sha/);

    assert.equal(internal.steps?.some((step) => step.run === 'make generate'), false);
    assert.equal(
      generation.steps?.some((step) => step.run === 'make generate'),
      true,
      'the read-only job must own generation',
    );
    assert.equal(
      generation.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'))?.uses,
      'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f',
    );
    assert.equal(
      internal.steps?.find((step) => step.uses?.startsWith('actions/download-artifact@'))?.uses,
      'actions/download-artifact@018cc2cf5baa6db3ef3c5f8a56943fffe632ef53',
    );

    const commit = stepByName('internal-auto-generate', 'Commit generated artifacts to the internal PR branch');
    assert.match(commit.env?.GH_TOKEN ?? '', /github\.token/);
    assert.match(commit.run ?? '', /git apply --index --binary/);
    assert.match(commit.run ?? '', /core\.hooksPath=\/dev\/null/);
    assert.match(
      commit.run ?? '',
      /--force-with-lease="refs\/heads\/\$PR_HEAD_REF:\$EXPECTED_HEAD_SHA"/,
    );
  });

  it('fails generator writes outside the two generated directories', () => {
    const guard = stepByName(
      'internal-generate',
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
      'changes',
      'proto-breaking',
      'fork-artifact-check',
      'internal-generate',
      'internal-auto-generate',
      'internal-merge-freshness',
    ]);
    const aggregateRun = stepByName('proto-freshness', 'Publish aggregate proto freshness result').run ?? '';
    assert.match(aggregateRun, /BREAKING_RESULT/);
    assert.match(aggregateRun, /FORK_RESULT/);
    assert.match(aggregateRun, /GENERATE_RESULT/);
    assert.match(aggregateRun, /PUBLISH_RESULT/);
    assert.match(aggregateRun, /MERGE_RESULT/);
  });

  it('documents the internal and fork contributor contracts', () => {
    assert.match(contributing, /### Generated Artifacts in Pull Requests/);
    assert.match(contributing, /approval-required state/);
    assert.match(contributing, /`proto-generated-followup` remains pending/);
    assert.match(contributing, /CI does not execute the fork's `Makefile`/);
  });
});
