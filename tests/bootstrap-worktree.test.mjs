import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertNoForbiddenEnvDumps,
  linkEnvFiles,
  parseArgs,
  shouldInstallDependencies,
} from '../scripts/bootstrap-worktree.mjs';

const makeTempDir = (prefix = 'wm-worktree-bootstrap-') => mkdtempSync(join(tmpdir(), prefix));
const quiet = () => {};

describe('worktree bootstrap helper', () => {
  it('links only ignored local env files from the selected source', (t) => {
    const root = makeTempDir();
    const source = makeTempDir('wm-worktree-env-source-');
    writeFileSync(join(source, '.env.local'), 'LOCAL_ONLY=1\n');
    writeFileSync(join(source, '.env'), 'BASE_ONLY=1\n');
    writeFileSync(join(source, '.env.vercel-export'), 'DO_NOT_LINK=1\n');

    try {
      const result = linkEnvFiles({ log: quiet, rootDir: root, sourceDir: source });

      assert.deepEqual(result.linked, ['.env.local', '.env']);
      assert.equal(readlinkSync(join(root, '.env.local')), join(source, '.env.local'));
      assert.equal(readlinkSync(join(root, '.env')), join(source, '.env'));
      assert.equal(existsSync(join(root, '.env.vercel-export')), false);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlink creation is unavailable in this environment');
        return;
      }
      throw error;
    }
  });

  it('leaves existing env targets untouched', () => {
    const root = makeTempDir();
    const source = makeTempDir('wm-worktree-env-source-');
    writeFileSync(join(root, '.env.local'), 'KEEP_ME=1\n');
    writeFileSync(join(source, '.env.local'), 'SOURCE=1\n');

    const result = linkEnvFiles({ log: quiet, rootDir: root, sourceDir: source });

    assert.deepEqual(result.linked, []);
    assert.deepEqual(result.skipped, ['.env.local']);
    assert.deepEqual(result.missing, ['.env']);
  });

  it('reports dry-run env links without creating files', () => {
    const root = makeTempDir();
    const source = makeTempDir('wm-worktree-env-source-');
    writeFileSync(join(source, '.env.local'), 'LOCAL_ONLY=1\n');
    writeFileSync(join(source, '.env'), 'BASE_ONLY=1\n');

    const result = linkEnvFiles({
      dryRun: true,
      log: quiet,
      rootDir: root,
      sourceDir: source,
    });

    assert.deepEqual(result.linked, []);
    assert.deepEqual(result.wouldLink, ['.env.local', '.env']);
    assert.equal(existsSync(join(root, '.env.local')), false);
    assert.equal(existsSync(join(root, '.env')), false);
  });

  it('rejects forbidden local Vercel env dumps even when they are symlinks', (t) => {
    const root = makeTempDir();

    try {
      symlinkSync('/tmp/nonexistent-vercel-env-backup', join(root, '.env.vercel-backup'));
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlink creation is unavailable in this environment');
        return;
      }
      throw error;
    }

    assert.throws(
      () => assertNoForbiddenEnvDumps(root),
      /local Vercel env dump files are present/,
    );
  });

  it('detects missing dependencies from node_modules absence', () => {
    const root = makeTempDir();

    assert.equal(shouldInstallDependencies({ rootDir: root }), true);

    mkdirSync(join(root, 'node_modules'));
    assert.equal(shouldInstallDependencies({ rootDir: root }), false);
    assert.equal(shouldInstallDependencies({ forceInstall: true, rootDir: root }), true);
  });

  it('parses bootstrap flags', () => {
    const options = parseArgs([
      '--env-source',
      '/tmp/source',
      '--cache=/tmp/cache',
      '--skip-install',
      '--ignore-scripts',
      '--dry-run',
    ]);

    assert.equal(options.envSource, '/tmp/source');
    assert.equal(options.cacheDir, '/tmp/cache');
    assert.equal(options.skipInstall, true);
    assert.equal(options.ignoreScripts, true);
    assert.equal(options.dryRun, true);
  });
});
