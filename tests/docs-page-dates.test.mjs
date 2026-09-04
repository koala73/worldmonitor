import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

it('renders docs commit dates in UTC', () => {
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

    execFileSync('git', ['init', '--quiet'], { cwd: fixtureRoot, env: gitEnv });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: fixtureRoot, env: gitEnv });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: fixtureRoot, env: gitEnv });
    execFileSync('git', ['add', 'docs/about.mdx'], { cwd: fixtureRoot, env: gitEnv });
    execFileSync('git', ['commit', '--quiet', '-m', 'docs: add about page'], {
      cwd: fixtureRoot,
      env: isolatedGitEnv({
        GIT_AUTHOR_DATE: '2026-07-28T01:21:52+04:00',
        GIT_COMMITTER_DATE: '2026-07-28T01:21:52+04:00',
      }),
    });

    execFileSync(process.execPath, ['scripts/generate-docs-page-dates.mjs'], {
      cwd: fixtureRoot,
      stdio: 'pipe',
    });

    const manifest = readFileSync(
      join(fixtureRoot, 'src/config/docs-page-dates.generated.ts'),
      'utf8',
    );
    assert.match(manifest, /"about": "2026-07-27"/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
