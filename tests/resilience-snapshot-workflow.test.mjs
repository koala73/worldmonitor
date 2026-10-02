import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../.github/workflows/resilience-snapshot-refresh.yml', import.meta.url), 'utf8'));
const step = (name) => workflow.jobs.refresh.steps.find((entry) => entry.name === name);

function execute(name, { policy = '', existingPr = '', existingBranch = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wm-snapshot-workflow-'));
  try {
    const gh = join(root, 'gh');
    const git = join(root, 'git');
    writeFileSync(gh, `#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$*" == 'pr list '* ]]; then printf '%s' "$EXISTING_PR"; exit 0; fi
if [[ "$*" == 'pr create '* ]]; then
  if [[ -n "$POLICY_ERROR" ]]; then printf '%s\\n' "$POLICY_ERROR" >&2; exit 1; fi
  printf '%s\\n' 'https://github.com/fixture/repo/pull/1'; exit 0
fi
exit 2
`);
    writeFileSync(git, `#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
case "$1" in
  ls-remote) [[ "$EXISTING_BRANCH" == true ]]; exit $? ;;
  fetch) exit 0 ;;
  diff) printf '%s\\n' 'diff --git a/snapshot.json b/snapshot.json'; exit 0 ;;
  *) exit 2 ;;
esac
`);
    chmodSync(gh, 0o755);
    chmodSync(git, 0o755);
    for (const name of ['output', 'summary', 'calls']) writeFileSync(join(root, name), '');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step(name).run], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: {
        PATH: `${root}:${process.env.PATH}`, RUNNER_TEMP: root,
        GITHUB_OUTPUT: join(root, 'output'), GITHUB_STEP_SUMMARY: join(root, 'summary'),
        GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'fixture/repo',
        BRANCH_NAME: 'automation/resilience-snapshot-2026-09', CALLS: join(root, 'calls'),
        POLICY_ERROR: policy, EXISTING_PR: existingPr, EXISTING_BRANCH: String(existingBranch),
      },
    });
    return {
      ...result,
      output: readFileSync(join(root, 'output'), 'utf8'),
      summary: readFileSync(join(root, 'summary'), 'utf8'),
      calls: readFileSync(join(root, 'calls'), 'utf8'),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('hands off a reviewable patch when repository policy blocks bot PR creation', () => {
  const result = execute('Open the monthly snapshot PR', { policy: 'GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /manual=true/);
  assert.match(result.summary, /Maintainer action required/);
  assert.match(result.summary, /compare\/main\.\.\.automation\/resilience-snapshot-2026-09/);
  assert.match(result.calls, /diff --binary/);
  const upload = step('Retain the monthly snapshot handoff');
  assert.match(upload.if, /steps\.delivery\.outputs\.manual == 'true'/);
  assert.match(upload.with.path, /resilience-snapshot\.patch/);
  assert.equal(upload.with['if-no-files-found'], 'error');
});

it('records normal PR delivery and keeps unexpected failures fatal', () => {
  const success = execute('Open the monthly snapshot PR');
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.summary, /https:\/\/github.com\/fixture\/repo\/pull\/1/);
  assert.doesNotMatch(success.output, /manual=true/);
  const failed = execute('Open the monthly snapshot PR', { policy: 'Bad credentials' });
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.output, /manual=true/);
});

it('reuses a branch without recapturing, and skips a month already represented by a PR', () => {
  const branch = execute('Reconcile the monthly review branch', { existingBranch: true });
  assert.equal(branch.status, 0, branch.stderr);
  assert.match(branch.output, /skip=true/);
  assert.doesNotMatch(branch.calls, /pr create/);
  assert.doesNotMatch(branch.output, /existing_pr=true/);
  const pr = execute('Reconcile the monthly review branch', { existingPr: '42' });
  assert.equal(pr.status, 0, pr.stderr);
  assert.match(pr.output, /existing_pr=true/);
  assert.match(step('Open the monthly snapshot PR').if, /steps\.reconcile\.outputs\.existing_pr != 'true'/);
});
