/**
 * Pre-push identity gate + git-env hygiene (the "Fixture author" incident class).
 *
 * Mechanism being defended against: test fixtures shell out to
 * `git config user.name/email`; when such a test runs UNDER A GIT HOOK, git
 * exports GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE to the hook's children and
 * those OVERRIDE the fixture's cwd — the identity write lands in the SHARED
 * .git/config, and every later commit from ANY worktree silently carries the
 * fake author (observed: "Fixture <fixture@example.invalid>" 2026-08-30,
 * "test <test@example.com>" 2026-08-29/30, "WorldMonitor Test", "e <e@e.co>").
 *
 * Contract under test:
 *  1. scripts/prepush-identity-gate.sh blocks a push whose outgoing commits
 *     carry a fixture-pattern author/committer email, and passes clean ones.
 *  2. It also blocks when the SHARED repo config currently holds a
 *     fixture-pattern user.email (the next commit would be poisoned), with a
 *     repair hint.
 *  3. .husky/pre-push strips git's exported local env vars before running
 *     anything, and wires the gate on the push stdin.
 *  4. Policy: every test file that writes a git identity must isolate its
 *     git spawns from hook-exported env (one of the recognized idioms).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(REPO_ROOT, 'scripts', 'prepush-identity-gate.sh');
const ZERO = '0'.repeat(40);

// This test is itself a git-writing fixture — practice what it preaches.
const GIT_LOCAL_ENV_VARS = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

function isolatedEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  for (const name of GIT_LOCAL_ENV_VARS) delete env[name];
  return env;
}

const fixtures: string[] = [];
process.on('exit', () => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: isolatedEnv(), encoding: 'utf8' }).trim();
}

function makeRepo(identity: { name: string; email: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'wm-identity-gate-'));
  fixtures.push(root);
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.name', identity.name]);
  git(root, ['config', 'user.email', identity.email]);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '--quiet', '-m', 'base']);
  return root;
}

function runGate(cwd: string, stdinLines: string[]): { status: number | null; out: string } {
  const result = spawnSync('bash', [GATE], {
    cwd,
    input: stdinLines.map((line) => `${line}\n`).join(''),
    encoding: 'utf8',
    env: isolatedEnv(),
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

describe('prepush-identity-gate.sh', () => {
  it('blocks a new-branch push whose commit is fixture-authored', () => {
    const repo = makeRepo({ name: 'Fixture', email: 'fixture@example.invalid' });
    const sha = git(repo, ['rev-parse', 'HEAD']);
    const { status, out } = runGate(repo, [`refs/heads/main ${sha} refs/heads/main ${ZERO}`]);
    assert.equal(status, 1, `gate must block a fixture-authored push; output:\n${out}`);
    assert.match(out, /fixture@example\.invalid/);
    assert.match(out, /--reset-author/, 'block message must include the rewrite recipe');
  });

  it('blocks an update push when a NEW commit in the range is fixture-authored', () => {
    const repo = makeRepo({ name: 'Real Person', email: 'real@worldmonitor.dev' });
    const base = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, ['add', 'x.txt']);
    git(repo, ['commit', '--quiet', '-m', 'leaked-identity commit']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    // Restore a clean config so only the commit range triggers.
    git(repo, ['config', 'user.email', 'real@worldmonitor.dev']);
    const { status, out } = runGate(repo, [`refs/heads/main ${head} refs/heads/main ${base}`]);
    assert.equal(status, 1, `gate must block; output:\n${out}`);
    assert.match(out, /test@example\.com/);
  });

  it('passes a clean push', () => {
    const repo = makeRepo({ name: 'Real Person', email: 'real@worldmonitor.dev' });
    const sha = git(repo, ['rev-parse', 'HEAD']);
    const { status, out } = runGate(repo, [`refs/heads/main ${sha} refs/heads/main ${ZERO}`]);
    assert.equal(status, 0, `gate must pass clean pushes; output:\n${out}`);
  });

  it('ignores branch deletions (all-zero local sha)', () => {
    const repo = makeRepo({ name: 'Real Person', email: 'real@worldmonitor.dev' });
    const sha = git(repo, ['rev-parse', 'HEAD']);
    const { status } = runGate(repo, [`(delete) ${ZERO} refs/heads/old ${sha}`]);
    assert.equal(status, 0);
  });

  it('blocks when the shared config is currently poisoned, even with clean commits', () => {
    const repo = makeRepo({ name: 'Real Person', email: 'real@worldmonitor.dev' });
    const sha = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    const { status, out } = runGate(repo, [`refs/heads/main ${sha} refs/heads/main ${ZERO}`]);
    assert.equal(status, 1, `poisoned shared config must fail the push; output:\n${out}`);
    assert.match(out, /--unset/, 'block message must include the config repair hint');
  });
});

describe('pre-push hook hygiene wiring', () => {
  const hook = readFileSync(join(REPO_ROOT, '.husky', 'pre-push'), 'utf8');

  it('strips git-exported local env vars before running anything test-shaped', () => {
    assert.match(hook, /--local-env-vars/,
      'pre-push must unset $(git rev-parse --local-env-vars) so hook-run test fixtures cannot write into the real repo');
    const stripIdx = hook.indexOf('--local-env-vars');
    const firstTestIdx = hook.search(/npx tsx --test|prepush-changed-tests/);
    assert.ok(stripIdx >= 0 && firstTestIdx > stripIdx,
      'the env strip must come before any test invocation');
  });

  it('wires the identity gate on the push stdin', () => {
    assert.match(hook, /prepush-identity-gate\.sh/,
      'pre-push must run the identity gate so a leaked fixture author fails loudly instead of reaching GitHub');
  });
});

describe('policy: git-identity-writing test fixtures must isolate their git env', () => {
  it('every test that sets user.name via git carries a recognized isolation idiom', () => {
    const testsDir = join(REPO_ROOT, 'tests');
    const offenders: string[] = [];
    for (const name of readdirSync(testsDir)) {
      if (!/\.test\.m[jt]s$/.test(name)) continue;
      const path = join(testsDir, name);
      const src = readFileSync(path, 'utf8');
      const writesIdentity = /['"]config['"],\s*['"]user\.name['"]|['"]user\.name['"],/.test(src)
        && /\bgit\b/i.test(src);
      if (!writesIdentity) continue;
      const isolated = src.includes('--local-env-vars')
        || src.includes("startsWith('GIT_')")
        || src.includes('GIT_CONFIG_GLOBAL')
        // hand-listed delete of the override vars (deploy-config idiom)
        || (src.includes("'GIT_DIR'") && src.includes('delete '));
      if (!isolated) offenders.push(name);
    }
    assert.deepEqual(offenders, [],
      `these tests write a git identity without isolating git's hook-exported env (GIT_DIR overrides cwd under a hook): ${offenders.join(', ')}`);
  });
});
