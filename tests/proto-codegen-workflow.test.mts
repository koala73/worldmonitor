import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(root, '.github/workflows/proto-check.yml');
const workflowSource = readFileSync(workflowPath, 'utf8');
const deployGateSource = readFileSync(resolve(root, '.github/workflows/deploy-gate.yml'), 'utf8');
const contributing = readFileSync(resolve(root, 'CONTRIBUTING.md'), 'utf8');
const scorecardMirrorSource = readFileSync(
  resolve(root, 'scripts/generate-scorecard-edge-mirrors.mjs'),
  'utf8',
);
const scorecardMirrorPaths = [
  ...scorecardMirrorSource.matchAll(/['"](server\/worldmonitor\/scorecard\/v1\/_[-a-z]+\.ts)['"]/g),
].map((match) => match[1]);

type Step = {
  if?: string;
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
  'timeout-minutes'?: number;
};

type Workflow = {
  concurrency?: Record<string, unknown>;
  env?: Record<string, string>;
  jobs?: Record<string, Job>;
  on?: {
    pull_request?: null | Record<string, unknown>;
    push?: null | { branches?: string[] };
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

type PullFile = {
  filename: string;
  previous_filename?: string;
  status?: string;
};

function runChangeClassifier(
  files?: Array<string | PullFile> | Array<Array<string | PullFile>>,
  options: {
    action?: string;
    actor?: string;
    baseSha?: string;
    changedFiles?: number;
    headRepository?: string;
    headSha?: string;
    pullRequestAuthor?: string;
    repositoryOwner?: string;
  } = {},
) {
  const temp = mkdtempSync(join(tmpdir(), 'wm-proto-classifier-'));
  const fakeBin = join(temp, 'bin');
    const output = join(temp, 'output');
    const commands = join(temp, 'commands');
    const filesJson = join(temp, 'files.json');
    const metadataJson = join(temp, 'metadata.json');
  const classifier = stepByName('changes', 'Classify proto codegen paths');
  const eventHeadSha = '1111111111111111111111111111111111111111';
  const eventBaseSha = '2222222222222222222222222222222222222222';

  try {
    mkdirSync(fakeBin);
    writeFileSync(output, '');
    writeFileSync(commands, '');
    const pages = files
      ? (Array.isArray(files[0]) ? files : [files]).map((page) =>
          (page as Array<string | PullFile>).map((file) =>
            typeof file === 'string' ? { filename: file } : file,
          ),
        )
      : undefined;
    const returnedFileCount = pages?.reduce((count, page) => count + page.length, 0) ?? 0;
    const metadata = {
      changed_files: options.changedFiles ?? returnedFileCount,
      head: { sha: options.headSha ?? eventHeadSha },
      base: { sha: options.baseSha ?? eventBaseSha },
    };
    writeFileSync(filesJson, JSON.stringify(pages ?? []));
    writeFileSync(metadataJson, JSON.stringify(metadata));
    writeFileSync(
      join(fakeBin, 'gh'),
      pages
        ? `#!/bin/sh\nprintf '%s\\n' "$*" >> '${commands}'\ncase "$*" in\n  */files*) /bin/cat '${filesJson}' ;;\n  *) /bin/cat '${metadataJson}' ;;\nesac\n`
        : '#!/bin/sh\nexit 73\n',
      { mode: 0o755 },
    );

    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', classifier.run ?? ''], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...workflow.env,
        EVENT_ACTION: options.action ?? 'opened',
        EVENT_ACTOR: options.actor ?? 'contributor',
        EVENT_BASE_SHA: eventBaseSha,
        EVENT_HEAD_REPOSITORY: options.headRepository ?? 'contributor/worldmonitor',
        EVENT_HEAD_SHA: eventHeadSha,
        GITHUB_OUTPUT: output,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PR_AUTHOR: options.pullRequestAuthor ?? 'contributor',
        PR_NUMBER: '7397',
        REPOSITORY: 'koala73/worldmonitor',
        REPOSITORY_OWNER: options.repositoryOwner ?? 'koala73',
      },
    });

    return {
      output: readFileSync(output, 'utf8'),
      commands: readFileSync(commands, 'utf8'),
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function runAggregate(env: Record<string, string>) {
  const aggregate = stepByName('proto-freshness', 'Publish aggregate proto freshness result');
  return spawnSync('bash', ['-euo', 'pipefail', '-c', aggregate.run ?? ''], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const gitLocalEnvVars = spawnSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
}).stdout.trim().split('\n').filter(Boolean);

function isolatedGitEnv() {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  for (const name of gitLocalEnvVars) delete env[name];
  return env;
}

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: isolatedGitEnv(),
  });
}

type GenerationMode =
  | 'clean'
  | 'generated-drift'
  | 'unexpected-staged'
  | 'unexpected-tracked'
  | 'unexpected-untracked';

function runGenerationVerdict(mode: GenerationMode, trustedFork: boolean) {
  const temp = mkdtempSync(join(tmpdir(), 'wm-proto-generation-'));
  const repo = join(temp, 'repo');
  const output = join(temp, 'output');
  const patch = join(temp, 'generated.patch');
  const generatedPaths = (workflow.env?.GENERATED_PATHS ?? '').split(/\s+/).filter(Boolean);
  const guard = stepByName(
    'internal-generate',
    'Reject generator writes outside generated artifact paths',
  );
  const verdict = stepByName('internal-generate', 'Prepare generated artifact patch');

  mkdirSync(repo);
  writeFileSync(output, '');
  assert.equal(git(repo, ['init', '--quiet', '--initial-branch=generation']).status, 0);
  assert.equal(git(repo, ['config', 'user.email', 'fixture@example.invalid']).status, 0);
  assert.equal(git(repo, ['config', 'user.name', 'Fixture']).status, 0);

  for (const generatedPath of generatedPaths) {
    const fixturePath = generatedPath.endsWith('/')
      ? join(generatedPath, generatedPath.startsWith('docs/') ? 'fixture.yaml' : 'fixture.ts')
      : generatedPath;
    mkdirSync(dirname(join(repo, fixturePath)), { recursive: true });
    writeFileSync(join(repo, fixturePath), 'generated fixture\n');
  }
  mkdirSync(join(repo, 'src/components'), { recursive: true });
  writeFileSync(join(repo, 'src/components/Panel.ts'), 'export const panel = 1;\n');
  assert.equal(git(repo, ['add', '-A']).status, 0);
  assert.equal(git(repo, ['commit', '--quiet', '-m', 'base']).status, 0);

  if (mode === 'generated-drift') {
    writeFileSync(join(repo, 'src/generated/fixture.ts'), 'generated fixture changed\n');
  } else if (mode === 'unexpected-tracked' || mode === 'unexpected-staged') {
    writeFileSync(join(repo, 'src/components/Panel.ts'), 'export const panel = 2;\n');
    if (mode === 'unexpected-staged') assert.equal(git(repo, ['add', 'src/components/Panel.ts']).status, 0);
  } else if (mode === 'unexpected-untracked') {
    writeFileSync(join(repo, 'src/components/Unexpected.ts'), 'export const unexpected = true;\n');
  }

  const env = {
    ...isolatedGitEnv(),
    ...workflow.env,
    GITHUB_OUTPUT: output,
    RUNNER_TEMP: temp,
    TRUSTED_FORK: String(trustedFork),
  };
  const guardResult = spawnSync('bash', ['-euo', 'pipefail', '-c', guard.run ?? ''], {
    cwd: repo,
    encoding: 'utf8',
    env,
  });
  const verdictResult = guardResult.status === 0
    ? spawnSync('bash', ['-euo', 'pipefail', '-c', verdict.run ?? ''], {
        cwd: repo,
        encoding: 'utf8',
        env,
      })
    : undefined;

  const returned = {
    guardResult,
    output: readFileSync(output, 'utf8'),
    patchExists: existsSync(patch),
    verdictResult,
  };
  rmSync(temp, { recursive: true, force: true });
  return returned;
}

function runWriter(mode: 'valid' | 'valid-mirror' | 'unexpected' | 'lease-failure' | 'current') {
  const temp = mkdtempSync(join(tmpdir(), 'wm-proto-writer-'));
  const repo = join(temp, 'repo');
  const origin = join(temp, 'origin.git');
  const fakeBin = join(temp, 'bin');
  const output = join(temp, 'output');
  const ghLog = join(temp, 'gh.log');
  const writer = stepByName('internal-auto-generate', 'Commit generated artifacts to the internal PR branch');

  mkdirSync(repo);
  mkdirSync(fakeBin);
  writeFileSync(output, '');
  writeFileSync(ghLog, '');
  writeFileSync(join(fakeBin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\n`, { mode: 0o755 });
  writeFileSync(join(fakeBin, 'base64'), '#!/bin/sh\ncat >/dev/null\nprintf encoded-token', { mode: 0o755 });

  assert.equal(git(repo, ['init', '--quiet', '--initial-branch=writer']).status, 0);
  assert.equal(git(repo, ['config', 'user.email', 'fixture@example.invalid']).status, 0);
  assert.equal(git(repo, ['config', 'user.name', 'Fixture']).status, 0);
  mkdirSync(join(repo, 'src/generated'), { recursive: true });
  mkdirSync(join(repo, 'src/components'), { recursive: true });
  mkdirSync(join(repo, 'server/worldmonitor/scorecard/v1'), { recursive: true });
  writeFileSync(join(repo, 'src/generated/client.ts'), 'export const value = 1;\n');
  writeFileSync(join(repo, 'src/components/Panel.ts'), 'export const panel = 1;\n');
  writeFileSync(
    join(repo, 'server/worldmonitor/scorecard/v1/_types.ts'),
    'export type Score = number;\n',
  );
  assert.equal(git(repo, ['add', '-A']).status, 0);
  assert.equal(git(repo, ['commit', '--quiet', '-m', 'base']).status, 0);
  const expectedSha = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(temp, ['init', '--quiet', '--bare', origin]).status, 0);
  assert.equal(git(repo, ['remote', 'add', 'origin', origin]).status, 0);
  assert.equal(git(repo, ['push', '--quiet', '-u', 'origin', 'writer']).status, 0);

  if (mode !== 'current') {
    const target = mode === 'unexpected'
      ? 'src/components/Panel.ts'
      : mode === 'valid-mirror'
        ? 'server/worldmonitor/scorecard/v1/_types.ts'
        : 'src/generated/client.ts';
    writeFileSync(join(repo, target), `export const value = ${mode === 'unexpected' ? 2 : 3};\n`);
    const patch = git(repo, ['diff', '--binary', '--full-index', '--', target]).stdout;
    writeFileSync(join(temp, 'generated.patch'), patch);
    assert.equal(git(repo, ['restore', '--', target]).status, 0);
  }

  if (mode === 'lease-failure') {
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
    const advancedResult = spawnSync('git', ['commit-tree', tree, '-p', expectedSha, '-m', 'advanced'], {
      cwd: repo,
      encoding: 'utf8',
      env: isolatedGitEnv(),
    });
    assert.equal(advancedResult.status, 0, advancedResult.stderr);
    const advanced = advancedResult.stdout.trim();
    const update = git(repo, [
      'push',
      '--quiet',
      '--force',
      'origin',
      `${advanced}:refs/heads/writer`,
    ]);
    assert.equal(update.status, 0, update.stderr);
  }

  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', writer.run ?? ''], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...isolatedGitEnv(),
      ...workflow.env,
      EXPECTED_HEAD_SHA: expectedSha,
      GENERATED_CHANGED: mode === 'current' ? 'false' : 'true',
      GH_TOKEN: 'fixture-token',
      GITHUB_OUTPUT: output,
      PATH: `${fakeBin}:${process.env.PATH}`,
      PR_HEAD_REF: 'writer',
      REPOSITORY: 'koala73/worldmonitor',
      RUNNER_TEMP: temp,
    },
  });

  const returned = {
    expectedSha,
    ghLog: readFileSync(ghLog, 'utf8'),
    output: readFileSync(output, 'utf8'),
    remoteSha: git(temp, [`--git-dir=${origin}`, 'rev-parse', 'refs/heads/writer']).stdout.trim(),
    result,
  };
  rmSync(temp, { recursive: true, force: true });
  return returned;
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
    assert.deepEqual(
      workflow.on?.push?.branches,
      ['main'],
      'proto-check must publish skipped job names on main so Deploy Gate can evaluate push SHAs',
    );
  });

  it('bounds every proto job with an explicit timeout', () => {
    for (const [name, value] of Object.entries(jobs)) {
      const timeout = value['timeout-minutes'];
      assert.ok(timeout && timeout <= 25, `${name} must finish or fail within 25 minutes`);
    }
  });

  it('classifies the complete codegen path domain with decoded GitHub paths', () => {
    const input = workflow.env?.CODEGEN_INPUT_REGEX;
    const generatedPaths = (workflow.env?.GENERATED_PATHS ?? '').split(/\s+/).filter(Boolean);
    const isGenerated = (path: string) => generatedPaths.some((generated) =>
      generated.endsWith('/') ? path.startsWith(generated) : path === generated,
    );
    assert.ok(input, 'workflow must define the codegen input class');
    assert.ok(generatedPaths.length > 0, 'workflow must define one generated-output registry');
    assert.equal(workflow.env?.GENERATED_OUTPUT_REGEX, undefined);

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
    assert.equal(isGenerated('src/generated/client.ts'), true);
    assert.equal(isGenerated('docs/api/worldmonitor.openapi.yaml'), true);
    assert.equal(scorecardMirrorPaths.length, 7, 'the fixture must discover every scorecard Edge mirror');
    for (const path of scorecardMirrorPaths) assert.equal(isGenerated(path), true);
    const unicode = runChangeClassifier(['proto/café.proto']);
    assert.equal(unicode.status, 0, unicode.stderr);
    assert.match(unicode.output, /^codegen=true$/m);
    assert.match(unicode.output, /^breaking=true$/m);

    const workflowOnly = runChangeClassifier(['.github/workflows/proto-check.yml']);
    assert.equal(workflowOnly.status, 0, workflowOnly.stderr);
    assert.match(workflowOnly.output, /^codegen=false$/m);
    assert.match(workflowOnly.output, /^breaking=false$/m);

    const unrelated = runChangeClassifier(['src/components/Panel.ts']);
    assert.equal(unrelated.status, 0, unrelated.stderr);
    assert.match(unrelated.output, /^codegen=false$/m);
    assert.match(unrelated.output, /^breaking=false$/m);

    const generatedOnly = runChangeClassifier(['docs/api/worldmonitor.openapi.yaml']);
    assert.equal(generatedOnly.status, 0, generatedOnly.stderr);
    assert.match(generatedOnly.output, /^codegen=true$/m);
    assert.match(generatedOnly.output, /^breaking=false$/m);

    const renamedProto = runChangeClassifier([
      { filename: 'archive/service.proto', previous_filename: 'proto/service.proto', status: 'renamed' },
    ]);
    assert.equal(renamedProto.status, 0, renamedProto.stderr);
    assert.match(renamedProto.output, /^codegen=true$/m);
    assert.match(renamedProto.output, /^breaking=true$/m);

    const renamedOutput = runChangeClassifier([
      {
        filename: 'archive/client.ts',
        previous_filename: 'src/generated/client.ts',
        status: 'renamed',
      },
    ]);
    assert.equal(renamedOutput.status, 0, renamedOutput.stderr);
    assert.match(renamedOutput.output, /^codegen=true$/m);
    assert.match(renamedOutput.output, /^breaking=false$/m);
  });

  it('fails closed when GitHub cannot list pull request files', () => {
    const result = runChangeClassifier();
    assert.equal(result.status, 73, result.stderr);
    assert.equal(result.output, '');
  });

  it('fails closed when PR metadata moves or GitHub truncates the file list', () => {
    const moved = runChangeClassifier(['src/components/Panel.ts'], { headSha: 'moved' });
    assert.notEqual(moved.status, 0);
    assert.equal(moved.output, '');
    assert.match(moved.stdout, /metadata moved/i);

    const truncated = runChangeClassifier(['src/components/Panel.ts'], { changedFiles: 3001 });
    assert.notEqual(truncated.status, 0);
    assert.equal(truncated.output, '');
    assert.match(truncated.stdout, /returned 1 of 3001 changed files/i);
  });

  it('classifies every paginated PR-files page', () => {
    const result = runChangeClassifier([
      [{ filename: 'src/components/Panel.ts' }],
      [{ filename: 'proto/worldmonitor/example/v1/service.proto' }],
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^codegen=true$/m);
    assert.match(result.output, /^breaking=true$/m);
    assert.match(result.commands, /^api repos\/koala73\/worldmonitor\/pulls\/7397$/m);
    assert.match(
      result.commands,
      /^api repos\/koala73\/worldmonitor\/pulls\/7397\/files --paginate --slurp$/m,
    );
  });

  it('trusts only an owner-started exact-head fork synchronization with codegen changes', () => {
    const trusted = runChangeClassifier(['proto/worldmonitor/example/v1/service.proto'], {
      action: 'synchronize',
      actor: 'koala73',
    });
    assert.equal(trusted.status, 0, trusted.stderr);
    assert.match(trusted.output, /^trusted_fork=true$/m);

    const untrustedCases: Array<[string, Parameters<typeof runChangeClassifier>[0], Parameters<typeof runChangeClassifier>[1]]> = [
      ['contributor push', ['proto/service.proto'], { action: 'synchronize', actor: 'contributor' }],
      ['opened by owner', ['proto/service.proto'], { action: 'opened', actor: 'koala73' }],
      ['reopened by owner', ['proto/service.proto'], { action: 'reopened', actor: 'koala73' }],
      [
        'same-repository head',
        ['proto/service.proto'],
        { action: 'synchronize', actor: 'koala73', headRepository: 'koala73/worldmonitor' },
      ],
      [
        'Dependabot author',
        ['proto/service.proto'],
        { action: 'synchronize', actor: 'koala73', pullRequestAuthor: 'dependabot[bot]' },
      ],
      ['non-codegen change', ['src/components/Panel.ts'], { action: 'synchronize', actor: 'koala73' }],
      ['missing actor', ['proto/service.proto'], { action: 'synchronize', actor: '' }],
      [
        'missing repository owner',
        ['proto/service.proto'],
        { action: 'synchronize', actor: 'koala73', repositoryOwner: '' },
      ],
      [
        'missing head repository',
        ['proto/service.proto'],
        { action: 'synchronize', actor: 'koala73', headRepository: '' },
      ],
      [
        'missing pull request author',
        ['proto/service.proto'],
        { action: 'synchronize', actor: 'koala73', pullRequestAuthor: '' },
      ],
    ];

    for (const [name, files, options] of untrustedCases) {
      const result = runChangeClassifier(files, options);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.match(result.output, /^trusted_fork=false$/m, name);
    }
  });

  it('wires original event identity into the executable trusted-fork classifier', () => {
    const classifier = stepByName('changes', 'Classify proto codegen paths');
    assert.equal(classifier.env?.EVENT_ACTION, '${{ github.event.action }}');
    assert.equal(classifier.env?.EVENT_ACTOR, '${{ github.actor }}');
    assert.equal(classifier.env?.REPOSITORY_OWNER, '${{ github.repository_owner }}');
    assert.equal(
      classifier.env?.EVENT_HEAD_REPOSITORY,
      '${{ github.event.pull_request.head.repo.full_name }}',
    );
    assert.equal(classifier.env?.PR_AUTHOR, '${{ github.event.pull_request.user.login }}');
    assert.equal(
      job('changes').outputs?.trusted_fork,
      '${{ steps.paths.outputs.trusted_fork || steps.non-pr.outputs.trusted_fork }}',
    );
    assert.match(stepByName('changes', 'Publish non-PR path classification').run ?? '', /trusted_fork=false/);
    assert.doesNotMatch(workflowSource, /github\.triggering_actor/);
    assert.doesNotMatch(workflowSource, /commit(?:ter)?\.(?:name|email|login)/i);
  });

  it('never executes fork-controlled code and requires trusted codegen validation', () => {
    const fork = job('fork-artifact-check');
    assert.deepEqual(fork.permissions, {});
    assert.match(fork.if ?? '', /head\.repo\.full_name != github\.repository/);
    assert.match(fork.if ?? '', /dependabot\[bot\]/);
    assert.match(fork.if ?? '', /needs\.changes\.outputs\.codegen == 'true'/);
    assert.match(fork.if ?? '', /needs\.changes\.outputs\.trusted_fork != 'true'/);

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
    assert.match(breaking.if ?? '', /needs\.changes\.outputs\.breaking == 'true'/);
    assert.equal(breaking.steps?.[0]?.with?.['fetch-depth'], 0);
    assert.equal(breaking.steps?.[0]?.with?.['persist-credentials'], false);

    const restore = stepByName('proto-breaking', 'Restore the trusted main Makefile').run ?? '';
    assert.equal(restore, 'git show origin/main:Makefile > Makefile');
    assert.equal(stepByName('proto-breaking', 'Check for breaking proto changes').run, 'make breaking');
  });

  it('runs trusted-fork generation read-only while keeping the writer internal-only', () => {
    const generation = job('internal-generate');
    assert.deepEqual(generation.permissions, { contents: 'read' });
    assert.match(generation.if ?? '', /head\.repo\.full_name == github\.repository/);
    assert.match(generation.if ?? '', /needs\.changes\.outputs\.trusted_fork == 'true'/);
    assert.match(generation.if ?? '', /user\.login != 'dependabot\[bot\]'/);
    assert.doesNotMatch(JSON.stringify(generation), /github\.token|GH_TOKEN/);

    const generationCheckout = generation.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(generationCheckout?.with?.['persist-credentials'], false);
    assert.match(String(generationCheckout?.with?.ref), /pull_request\.head\.sha/);

    const verdict = stepByName('internal-generate', 'Prepare generated artifact patch');
    assert.match(verdict.env?.TRUSTED_FORK ?? '', /needs\.changes\.outputs\.trusted_fork/);
    assert.match(verdict.run ?? '', /TRUSTED_FORK/);
    assert.match(verdict.run ?? '', /Generated artifacts are stale on the owner-trusted fork head/);

    const upload = generation.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert.match(upload?.if ?? '', /needs\.changes\.outputs\.trusted_fork != 'true'/);

    const internal = job('internal-auto-generate');
    assert.deepEqual(internal.permissions, { contents: 'write', statuses: 'write' });
    assert.deepEqual(internal.needs, ['changes', 'internal-generate']);
    assert.match(internal.if ?? '', /head\.repo\.full_name == github\.repository/);
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

  it('executes clean, drift, and unexpected-write generation verdicts', () => {
    for (const trustedFork of [false, true]) {
      const clean = runGenerationVerdict('clean', trustedFork);
      assert.equal(clean.guardResult.status, 0, clean.guardResult.stderr);
      assert.equal(clean.verdictResult?.status, 0, clean.verdictResult?.stderr);
      assert.match(clean.output, /^changed=false$/m);
      assert.equal(clean.patchExists, false);
    }

    const internalDrift = runGenerationVerdict('generated-drift', false);
    assert.equal(internalDrift.guardResult.status, 0, internalDrift.guardResult.stderr);
    assert.equal(internalDrift.verdictResult?.status, 0, internalDrift.verdictResult?.stderr);
    assert.match(internalDrift.output, /^changed=true$/m);
    assert.equal(internalDrift.patchExists, true);

    const trustedDrift = runGenerationVerdict('generated-drift', true);
    assert.equal(trustedDrift.guardResult.status, 0, trustedDrift.guardResult.stderr);
    assert.notEqual(trustedDrift.verdictResult?.status, 0);
    assert.equal(trustedDrift.output, '');
    assert.equal(trustedDrift.patchExists, false);

    for (const mode of [
      'unexpected-tracked',
      'unexpected-staged',
      'unexpected-untracked',
    ] satisfies GenerationMode[]) {
      const result = runGenerationVerdict(mode, true);
      assert.notEqual(result.guardResult.status, 0, mode);
      assert.equal(result.verdictResult, undefined);
      assert.equal(result.output, '');
      assert.equal(result.patchExists, false);
    }
  });

  it('fails generator writes outside the complete generated-output allowlist', () => {
    const guard = stepByName(
      'internal-generate',
      'Reject generator writes outside generated artifact paths',
    ).run ?? '';

    assert.match(guard, /GENERATED_PATHS/);
    assert.match(guard, /git diff --cached --quiet/);
    assert.match(guard, /UNEXPECTED_UNTRACKED/);

    const generatedPaths = new Set((workflow.env?.GENERATED_PATHS ?? '').split(/\s+/).filter(Boolean));
    assert.ok(generatedPaths.has('src/generated/'));
    assert.ok(generatedPaths.has('docs/api/'));
    for (const path of scorecardMirrorPaths) {
      assert.ok(generatedPaths.has(path), `${path} must cross the generator/writer boundary`);
    }

    const writer = stepByName(
      'internal-auto-generate',
      'Commit generated artifacts to the internal PR branch',
    ).run ?? '';
    const mergeCheck = stepByName(
      'internal-merge-freshness',
      'Verify generated artifacts are fresh against the merge result',
    ).run ?? '';
    assert.match(writer, /GENERATED_PATHS/);
    assert.match(writer, /PATHNAME.*GENERATED_PATH/);
    assert.match(mergeCheck, /GENERATED_PATHS/);
  });

  it('runs merge freshness after a deliberately skipped trusted-fork writer', () => {
    const merge = job('internal-merge-freshness');
    assert.deepEqual(merge.needs, ['changes', 'internal-generate', 'internal-auto-generate']);
    assert.match(merge.if ?? '', /always\(\)/);
    assert.match(merge.if ?? '', /needs\.changes\.result == 'success'/);
    assert.match(merge.if ?? '', /needs\.internal-generate\.result == 'success'/);
    assert.match(merge.if ?? '', /needs\.changes\.outputs\.trusted_fork == 'true'/);
    assert.match(merge.if ?? '', /needs\.internal-auto-generate\.result == 'skipped'/);
    assert.match(merge.if ?? '', /needs\.internal-auto-generate\.result == 'success'/);
    assert.match(merge.if ?? '', /needs\.internal-auto-generate\.outputs\.pushed != 'true'/);
  });

  it('uses a closed-world aggregate while preserving every published proto check', () => {
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
    for (const checkName of [
      'proto-changes',
      'proto-breaking',
      'fork-artifact-check',
      'internal-generate',
      'internal-auto-generate',
      'internal-merge-freshness',
      'proto-freshness',
    ]) {
      assert.match(deployGateSource, new RegExp(`"${checkName}"`), `${checkName} must remain required`);
    }
    const aggregateStep = stepByName('proto-freshness', 'Publish aggregate proto freshness result');
    assert.equal(aggregateStep.env?.TRUSTED_FORK, '${{ needs.changes.outputs.trusted_fork }}');
    const base = {
      CHANGE_RESULT: 'success',
      CODEGEN_CHANGED: 'true',
      BREAKING_CHANGED: 'false',
      TRUSTED_FORK: 'false',
      WRITABLE_INTERNAL_PR: 'true',
      BREAKING_RESULT: 'skipped',
      FORK_RESULT: 'skipped',
      GENERATE_RESULT: 'success',
      PUBLISH_RESULT: 'success',
      MERGE_RESULT: 'success',
      GENERATED_PUSHED: 'false',
    };
    const cases: Array<[string, Record<string, string>, number]> = [
      ['non-codegen push', { ...base, CODEGEN_CHANGED: 'false' }, 0],
      ['failed classification', { ...base, CHANGE_RESULT: 'failure' }, 1],
      [
        'untrusted fork stays red after blocker failure',
        { ...base, WRITABLE_INTERNAL_PR: 'false', FORK_RESULT: 'failure' },
        1,
      ],
      [
        'untrusted fork stays red if blocker unexpectedly succeeds',
        { ...base, WRITABLE_INTERNAL_PR: 'false', FORK_RESULT: 'success' },
        1,
      ],
      ['failed generation', { ...base, GENERATE_RESULT: 'failure' }, 1],
      ['failed publication', { ...base, PUBLISH_RESULT: 'failure' }, 1],
      ['generated push', { ...base, GENERATED_PUSHED: 'true', MERGE_RESULT: 'skipped' }, 0],
      ['failed merge freshness', { ...base, MERGE_RESULT: 'failure' }, 1],
      ['clean no-push success', base, 0],
      [
        'clean trusted fork',
        {
          ...base,
          TRUSTED_FORK: 'true',
          WRITABLE_INTERNAL_PR: 'false',
          PUBLISH_RESULT: 'skipped',
        },
        0,
      ],
      [
        'trusted fork generation failure',
        {
          ...base,
          TRUSTED_FORK: 'true',
          WRITABLE_INTERNAL_PR: 'false',
          GENERATE_RESULT: 'failure',
          PUBLISH_RESULT: 'skipped',
          MERGE_RESULT: 'skipped',
        },
        1,
      ],
      [
        'trusted fork merge failure',
        {
          ...base,
          TRUSTED_FORK: 'true',
          WRITABLE_INTERNAL_PR: 'false',
          PUBLISH_RESULT: 'skipped',
          MERGE_RESULT: 'failure',
        },
        1,
      ],
      [
        'trusted fork requires skipped blocker',
        {
          ...base,
          TRUSTED_FORK: 'true',
          WRITABLE_INTERNAL_PR: 'false',
          FORK_RESULT: 'failure',
          PUBLISH_RESULT: 'skipped',
        },
        1,
      ],
      [
        'trusted fork requires skipped writer',
        {
          ...base,
          TRUSTED_FORK: 'true',
          WRITABLE_INTERNAL_PR: 'false',
          PUBLISH_RESULT: 'success',
        },
        1,
      ],
    ];
    for (const [name, env, expected] of cases) {
      const result = runAggregate(env);
      assert.equal(result.status, expected, `${name}: ${result.stdout}${result.stderr}`);
    }
  });

  it('executes writer boundary, status, and lease failure paths', () => {
    const current = runWriter('current');
    assert.equal(
      current.result.status,
      0,
      `${current.result.stderr || ''}\nsignal=${String(current.result.signal)}`,
    );
    assert.match(current.output, /^pushed=false$/m);
    assert.match(current.ghLog, new RegExp(`statuses/${current.expectedSha}.*state=success`));

    const valid = runWriter('valid');
    assert.equal(valid.result.status, 0, valid.result.stderr);
    assert.match(valid.output, /^pushed=true$/m);
    assert.notEqual(valid.remoteSha, valid.expectedSha);
    assert.match(valid.ghLog, new RegExp(`statuses/${valid.remoteSha}.*state=pending`));

    const validMirror = runWriter('valid-mirror');
    assert.equal(validMirror.result.status, 0, validMirror.result.stderr);
    assert.match(validMirror.output, /^pushed=true$/m);

    const unexpected = runWriter('unexpected');
    assert.notEqual(unexpected.result.status, 0);
    assert.equal(unexpected.output, '');
    assert.equal(unexpected.remoteSha, unexpected.expectedSha);
    assert.equal(unexpected.ghLog, '');

    const leaseFailure = runWriter('lease-failure');
    assert.notEqual(leaseFailure.result.status, 0);
    assert.equal(leaseFailure.output, '');
    assert.notEqual(leaseFailure.remoteSha, leaseFailure.expectedSha);
    assert.equal(leaseFailure.ghLog, '');
  });

  it('documents the internal and fork contributor contracts', () => {
    assert.match(contributing, /### Generated Artifacts in Pull Requests/);
    assert.match(contributing, /approval-required state/);
    assert.match(contributing, /`proto-generated-followup` remains pending/);
    assert.match(contributing, /CI does not execute the fork's `Makefile`/);
  });
});
