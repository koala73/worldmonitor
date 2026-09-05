import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gitLocalEnvVars = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
}).trim().split('\n').filter(Boolean);

function isolatedGitEnv(overrides = {}) {
  const env = {
    ...process.env,
    ...overrides,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  for (const name of gitLocalEnvVars) delete env[name];
  return env;
}

const OUTPUT = 'src/config/docs-page-dates.generated.ts';

function withDateFixture(run) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'wm-docs-page-dates-'));
  const gitEnv = isolatedGitEnv();
  try {
    mkdirSync(join(fixtureRoot, 'docs'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'src/config'), { recursive: true });
    copyFileSync(
      join(repoRoot, 'scripts/generate-docs-page-dates.mjs'),
      join(fixtureRoot, 'scripts/generate-docs-page-dates.mjs'),
    );
    writeFileSync(join(fixtureRoot, 'docs/about.mdx'), '# About\n');
    writeFileSync(join(fixtureRoot, 'src/config/.gitkeep'), '');

    execFileSync('git', ['init', '--quiet'], { cwd: fixtureRoot, env: gitEnv });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: fixtureRoot, env: gitEnv });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: fixtureRoot, env: gitEnv });
    execFileSync('git', ['add', '.'], { cwd: fixtureRoot, env: gitEnv });
    execFileSync('git', ['commit', '--quiet', '-m', 'docs: add about page'], {
      cwd: fixtureRoot,
      env: isolatedGitEnv({
        GIT_AUTHOR_DATE: '2026-07-28T01:21:52+04:00',
        GIT_COMMITTER_DATE: '2026-07-28T01:21:52+04:00',
      }),
    });

    return run(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function generate(root, args = [], env = {}) {
  return execFileSync(process.execPath, ['scripts/generate-docs-page-dates.mjs', ...args], {
    cwd: root,
    env: isolatedGitEnv(env),
    stdio: 'pipe',
    timeout: 30_000,
  });
}

it('renders docs commit dates in UTC regardless of the build timezone', () => withDateFixture((root) => {
  for (const TZ of ['Pacific/Honolulu', 'Asia/Tokyo']) {
    generate(root, [], { TZ });
    assert.match(readFileSync(join(root, OUTPUT), 'utf8'), /"about": "2026-07-27"/);
  }
}));

it('replaces pre-merge dates with the final commit date across a UTC day boundary', () => withDateFixture((root) => {
  generate(root);
  execFileSync('git', ['add', OUTPUT], { cwd: root, env: isolatedGitEnv() });
  execFileSync('git', ['commit', '--amend', '--no-edit', '--quiet'], {
    cwd: root,
    env: isolatedGitEnv({ GIT_COMMITTER_DATE: '2026-07-28T01:00:00Z' }),
  });
  assert.throws(() => generate(root, ['--check']), /is stale/);
  generate(root);
  assert.match(readFileSync(join(root, OUTPUT), 'utf8'), /"about": "2026-07-28"/);
  assert.doesNotThrow(() => generate(root, ['--check']));
}));

it('recovers a shallow build checkout without changing its selected revision', () => withDateFixture((root) => {
  writeFileSync(join(root, 'unrelated.txt'), 'newer commit\n');
  execFileSync('git', ['add', 'unrelated.txt'], { cwd: root, env: isolatedGitEnv() });
  execFileSync('git', ['commit', '--quiet', '-m', 'unrelated change'], {
    cwd: root,
    env: isolatedGitEnv({ GIT_AUTHOR_DATE: '2026-07-30T12:00:00Z', GIT_COMMITTER_DATE: '2026-07-30T12:00:00Z' }),
  });
  const shallow = mkdtempSync(join(tmpdir(), 'wm-docs-dates-shallow-'));
  try {
    execFileSync('git', ['clone', '--quiet', '--depth=1', pathToFileURL(root).href, shallow], { env: isolatedGitEnv() });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: shallow, env: isolatedGitEnv() });
    assert.throws(() => generate(shallow), /need full git history/);
    assert.equal(existsSync(join(shallow, OUTPUT)), false);
    execFileSync('git', ['remote', 'set-url', 'origin', join(shallow, 'missing-origin')], { cwd: shallow, env: isolatedGitEnv() });
    assert.throws(() => generate(shallow, ['--fetch-history']), /does not appear to be a git repository/);
    assert.equal(existsSync(join(shallow, OUTPUT)), false);
    execFileSync('git', ['remote', 'set-url', 'origin', pathToFileURL(root).href], { cwd: shallow, env: isolatedGitEnv() });
    generate(shallow, ['--fetch-history']);
    assert.match(readFileSync(join(shallow, OUTPUT), 'utf8'), /"about": "2026-07-27"/);
    assert.deepEqual(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: shallow, env: isolatedGitEnv() }), head);
    generate(shallow, ['--fetch-history', '--check']);
  } finally {
    rmSync(shallow, { recursive: true, force: true });
  }
}));

it('rejects missing history and corrupted generated dates', () => withDateFixture((root) => {
  generate(root);
  const good = readFileSync(join(root, OUTPUT), 'utf8');
  writeFileSync(join(root, OUTPUT), good.replace('2026-07-27', '2099-01-01'));
  assert.throws(() => generate(root, ['--check']), /is stale/);
  generate(root);
  writeFileSync(join(root, 'docs/new.mdx'), '# Uncommitted\n');
  assert.throws(() => generate(root), /missing git history/);
  assert.equal(readFileSync(join(root, OUTPUT), 'utf8'), good);
  rmSync(join(root, '.git'), { recursive: true, force: true });
  assert.throws(() => generate(root, ['--fetch-history']), /not a git repository/);
  assert.equal(readFileSync(join(root, OUTPUT), 'utf8'), good);
}));

it('generates dates before every web build and checks generated output in CI', () => {
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const build of ['build', 'build:full', 'build:tech', 'build:finance', 'build:happy', 'build:commodity', 'build:energy']) {
    assert.match(scripts[`pre${build}`], /npm run docs:dates -- --fetch-history/, build);
  }
  assert.match(scripts['pretest:data'], /npm run docs:dates/);
  const workflow = readFileSync(join(repoRoot, '.github/workflows/test.yml'), 'utf8');
  assert.match(workflow, /node scripts\/generate-docs-page-dates\.mjs\n\s+node scripts\/generate-docs-page-dates\.mjs --check/);
});
