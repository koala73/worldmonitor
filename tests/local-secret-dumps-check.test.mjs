import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findLocalSecretDumps,
  findPushedSecretDumps,
  runLocalSecretDumpCheck,
} from '../scripts/check-local-secret-dumps.mjs';

const makeTempRepo = () => mkdtempSync(join(tmpdir(), 'wm-env-dump-check-'));
const guardScriptPath = fileURLToPath(
  new URL('../scripts/check-local-secret-dumps.mjs', import.meta.url),
);
const nestedGitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

function git(rootDir, ...args) {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    env: nestedGitEnv,
  }).trim();
}

function makeTempGitRepo() {
  const root = makeTempRepo();
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'WorldMonitor Test');
  git(root, 'config', 'user.email', 'test@worldmonitor.app');
  writeFileSync(join(root, '.gitignore'), '.env*.backup*\n');
  writeFileSync(join(root, '.env.example'), 'PLACEHOLDER=value\n');
  git(root, 'add', '.gitignore', '.env.example');
  git(root, 'commit', '--quiet', '-m', 'initial');
  return root;
}

function addSecretCommit(root, fileName = '.env.local.backup') {
  writeFileSync(join(root, fileName), 'do-not-read-this');
  git(root, 'add', '--force', fileName);
  git(root, 'commit', '--quiet', '-m', 'add local backup');
  return git(root, 'rev-parse', 'HEAD');
}

describe('local env dump guard', () => {
  it('passes when forbidden root env dumps are absent', () => {
    const root = makeTempRepo();

    assert.deepEqual(findLocalSecretDumps(root), []);
    assert.doesNotThrow(() => runLocalSecretDumpCheck(root));
  });

  it('fails when .env.vercel-backup exists in the repo root', () => {
    const root = makeTempRepo();
    writeFileSync(join(root, '.env.vercel-backup'), 'do-not-read-this');

    assert.deepEqual(findLocalSecretDumps(root), ['.env.vercel-backup']);
    assert.throws(
      () => runLocalSecretDumpCheck(root),
      /local environment dump files are present/,
    );
  });

  it('fails for renamed local env backups', () => {
    const root = makeTempRepo();
    writeFileSync(join(root, '.env.local.bak-strix-20260711'), 'do-not-read-this');

    assert.deepEqual(findLocalSecretDumps(root), ['.env.local.bak-strix-20260711']);
    assert.throws(
      () => runLocalSecretDumpCheck(root),
      /local environment dump files are present/,
    );
  });

  it('allows documented env templates', () => {
    const root = makeTempRepo();
    writeFileSync(join(root, '.env.example'), 'PLACEHOLDER=value');

    assert.deepEqual(findLocalSecretDumps(root), []);
    assert.doesNotThrow(() => runLocalSecretDumpCheck(root));
  });

  it('fails when .env.vercel-export is a symlink', (t) => {
    const root = makeTempRepo();
    try {
      symlinkSync('/tmp/nonexistent-vercel-env-export', join(root, '.env.vercel-export'));
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlink creation is unavailable in this environment');
        return;
      }
      throw error;
    }

    assert.deepEqual(findLocalSecretDumps(root), ['.env.vercel-export']);
    assert.throws(
      () => runLocalSecretDumpCheck(root),
      /local environment dump files are present/,
    );
  });

  it('rejects a committed dump removed only from the working tree', () => {
    const root = makeTempGitRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const secretCommit = addSecretCommit(root);
    unlinkSync(join(root, '.env.local.backup'));

    assert.deepEqual(findLocalSecretDumps(root), []);
    const prePushInput = [
      'refs/heads/topic',
      secretCommit,
      'refs/heads/topic',
      base,
    ].join(' ');

    assert.deepEqual(
      findPushedSecretDumps(root, prePushInput),
      [{ filePath: '.env.local.backup', commit: secretCommit }],
    );
    assert.throws(
      () => runLocalSecretDumpCheck(root, { prePushInput }),
      /commits being pushed/,
    );

    const cliResult = spawnSync(
      process.execPath,
      [guardScriptPath, '--pre-push', 'origin'],
      {
        cwd: root,
        input: prePushInput,
        encoding: 'utf8',
        env: nestedGitEnv,
      },
    );
    assert.notEqual(cliResult.status, 0);
    assert.match(cliResult.stderr, /commits being pushed/);
  });

  it('rejects a dump deleted only in a later pushed commit', () => {
    const root = makeTempGitRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const secretCommit = addSecretCommit(root);
    unlinkSync(join(root, '.env.local.backup'));
    git(root, 'add', '--all');
    git(root, 'commit', '--quiet', '-m', 'delete local backup');
    const head = git(root, 'rev-parse', 'HEAD');
    const prePushInput = [
      'refs/heads/topic',
      head,
      'refs/heads/topic',
      base,
    ].join(' ');

    assert.deepEqual(findLocalSecretDumps(root), []);
    assert.deepEqual(
      findPushedSecretDumps(root, prePushInput),
      [{ filePath: '.env.local.backup', commit: secretCommit }],
    );
    assert.throws(
      () => runLocalSecretDumpCheck(root, { prePushInput }),
      /\.env\.local\.backup \(commit /,
    );
  });

  it('uses destination remote refs to bound a first branch push', () => {
    const root = makeTempGitRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'update-ref', 'refs/remotes/origin/main', base);
    const secretCommit = addSecretCommit(root);
    const zeroSha = '0'.repeat(secretCommit.length);
    const prePushInput = [
      'refs/heads/topic',
      secretCommit,
      'refs/heads/topic',
      zeroSha,
    ].join(' ');

    assert.deepEqual(
      findPushedSecretDumps(root, prePushInput, 'origin'),
      [{ filePath: '.env.local.backup', commit: secretCommit }],
    );
  });
});
