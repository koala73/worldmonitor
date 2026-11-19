// scripts/prepush-unrelated-history-gate.sh refuses to push a branch that
// shares no history with origin/main. Orphan screenshot branches have no
// vercel.json, so each push failed a Vercel build; PR screenshots belong in
// the PR body via `gh pr edit --attach`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(REPO_ROOT, 'scripts', 'prepush-unrelated-history-gate.sh');
const ZERO = '0'.repeat(40);

const GIT_LOCAL_ENV_VARS = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

function isolatedEnv(overrides = {}) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Gate Fixture',
    GIT_AUTHOR_EMAIL: 'gate@worldmonitor.invalid',
    GIT_COMMITTER_NAME: 'Gate Fixture',
    GIT_COMMITTER_EMAIL: 'gate@worldmonitor.invalid',
    ...overrides,
  };
  for (const name of GIT_LOCAL_ENV_VARS) delete env[name];
  delete env.WM_ALLOW_UNRELATED_PUSH;
  return { ...env, ...overrides };
}

const fixtures = [];
after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: isolatedEnv(), encoding: 'utf8' }).trim();
}

function makeRepo({ withOriginMain = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wm-unrelated-gate-'));
  fixtures.push(root);
  git(root, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(root, 'package.json'), '{}\n');
  git(root, ['add', 'package.json']);
  git(root, ['commit', '--quiet', '-m', 'base']);
  if (withOriginMain) git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return root;
}

function orphanCommit(root) {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, env: isolatedEnv(), input: 'png-bytes', encoding: 'utf8',
  }).trim();
  const tree = execFileSync('git', ['mktree'], {
    cwd: root, env: isolatedEnv(), input: `100644 blob ${blob}\tshot.png\n`, encoding: 'utf8',
  }).trim();
  return git(root, ['commit-tree', tree, '-m', 'screenshots']);
}

function featureCommit(root) {
  git(root, ['checkout', '--quiet', '-b', 'feature']);
  writeFileSync(join(root, 'change.txt'), 'x\n');
  git(root, ['add', 'change.txt']);
  git(root, ['commit', '--quiet', '-m', 'feature']);
  return git(root, ['rev-parse', 'HEAD']);
}

function runGate(cwd, lines, env = {}) {
  const result = spawnSync('bash', [GATE], {
    cwd,
    input: lines.map((line) => `${line}\n`).join(''),
    encoding: 'utf8',
    env: isolatedEnv(env),
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

describe('prepush-unrelated-history-gate.sh', () => {
  it('refuses an orphan screenshot branch and points at gh pr edit --attach', () => {
    const root = makeRepo();
    const sha = orphanCommit(root);
    const { status, out } = runGate(root, [`${sha} ${sha} refs/heads/dogfood/1-screenshots ${ZERO}`]);
    assert.equal(status, 1, out);
    assert.match(out, /shares no history with origin\/main/);
    assert.match(out, /gh pr edit <number> --attach/);
  });

  it('refuses when one of several pushed refs is unrelated', () => {
    const root = makeRepo();
    const orphan = orphanCommit(root);
    const related = featureCommit(root);
    const { status, out } = runGate(root, [
      `refs/heads/feature ${related} refs/heads/feature ${ZERO}`,
      `${orphan} ${orphan} refs/heads/pr-assets ${ZERO}`,
    ]);
    assert.equal(status, 1, out);
    assert.match(out, /refs\/heads\/pr-assets/);
    assert.doesNotMatch(out, /-> refs\/heads\/feature/);
  });

  it('passes a branch cut from main', () => {
    const root = makeRepo();
    const sha = featureCommit(root);
    const { status, out } = runGate(root, [`refs/heads/feature ${sha} refs/heads/feature ${ZERO}`]);
    assert.equal(status, 0, out);
  });

  it('skips deletions and tags', () => {
    const root = makeRepo();
    const sha = orphanCommit(root);
    const { status, out } = runGate(root, [
      `(delete) ${ZERO} refs/heads/pr-assets ${sha}`,
      `refs/tags/v1 ${sha} refs/tags/v1 ${ZERO}`,
    ]);
    assert.equal(status, 0, out);
  });

  it('passes when origin/main is unknown locally', () => {
    const root = makeRepo({ withOriginMain: false });
    const sha = orphanCommit(root);
    const { status, out } = runGate(root, [`${sha} ${sha} refs/heads/pr-assets ${ZERO}`]);
    assert.equal(status, 0, out);
  });

  it('honours WM_ALLOW_UNRELATED_PUSH=1', () => {
    const root = makeRepo();
    const sha = orphanCommit(root);
    const { status, out } = runGate(
      root,
      [`${sha} ${sha} refs/heads/pr-assets ${ZERO}`],
      { WM_ALLOW_UNRELATED_PUSH: '1' },
    );
    assert.equal(status, 0, out);
  });

  it('is wired into .husky/pre-push on the captured push stdin', () => {
    const hook = readFileSync(join(REPO_ROOT, '.husky', 'pre-push'), 'utf8');
    assert.match(hook, /printf '%s\\n' "\$WM_PUSH_STDIN" \| bash scripts\/prepush-unrelated-history-gate\.sh \|\| exit 1/);
  });
});
