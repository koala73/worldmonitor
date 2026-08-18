import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertNoForbiddenEnvDumps,
  assertNodeModulesNotSymlink,
  bootstrapWorktree,
  decideHooksPathAction,
  linkEnvFiles,
  normalizeWorktreeHooksPath,
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

  it('rejects forbidden local env dumps even when they are symlinks', (t) => {
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
      /local environment dump files are present/,
    );
  });

  it('requires installation when node_modules is absent', () => {
    const root = makeTempDir();

    assert.equal(shouldInstallDependencies({ rootDir: root }), true);
  });

  it('requires installation for an empty node_modules directory', () => {
    const root = makeTempDir();

    mkdirSync(join(root, 'node_modules'));
    assert.equal(shouldInstallDependencies({ rootDir: root }), true);
  });

  it('requires installation for a partial node_modules directory', () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'node_modules'));

    writeFileSync(join(root, 'node_modules', 'some-package'), 'partial');
    assert.equal(shouldInstallDependencies({ rootDir: root }), true);
  });

  it('skips only a completed installation unless forced', () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'node_modules'));

    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');
    assert.equal(shouldInstallDependencies({ rootDir: root }), false);
    assert.equal(shouldInstallDependencies({ forceInstall: true, rootDir: root }), true);
  });

  it('logs verified completion when skipping and npm ci when installing', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'package.json'), '{}');
    const logs = [];

    bootstrapWorktree({ dryRun: true, rootDir: root, skipEnv: true, log: line => logs.push(line) });
    assert.deepEqual(logs, [
      '[worktree] would run: npm ci --cache /tmp/worldmonitor-npm-cache --prefer-offline',
      '[worktree] bootstrap complete',
    ]);

    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');
    logs.length = 0;

    bootstrapWorktree({ rootDir: root, skipEnv: true, log: line => logs.push(line) });
    assert.deepEqual(logs, [
      '[worktree] verified npm install present; skipping npm ci',
      '[worktree] bootstrap complete',
    ]);
  });

  it('seeds pro-test deps when that package is present', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'pro-test'));
    writeFileSync(join(root, 'pro-test', 'package.json'), '{}');
    const logs = [];

    bootstrapWorktree({ dryRun: true, rootDir: root, skipEnv: true, log: line => logs.push(line) });
    assert.deepEqual(logs, [
      '[worktree] would run: npm ci --cache /tmp/worldmonitor-npm-cache --prefer-offline',
      '[worktree] would run: npm ci --cache /tmp/worldmonitor-npm-cache --prefer-offline',
      '[worktree] bootstrap complete',
    ]);

    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');
    mkdirSync(join(root, 'pro-test', 'node_modules'));
    writeFileSync(join(root, 'pro-test', 'node_modules', '.package-lock.json'), '{}');
    logs.length = 0;

    bootstrapWorktree({ rootDir: root, skipEnv: true, log: line => logs.push(line) });
    assert.deepEqual(logs, [
      '[worktree] verified npm install present; skipping npm ci',
      '[worktree] verified pro-test npm install present; skipping npm ci',
      '[worktree] bootstrap complete',
    ]);
  });

  it('refuses a node_modules symlink instead of following it', (t) => {
    const root = makeTempDir();
    const target = makeTempDir('wm-stolen-node-modules-');
    writeFileSync(join(root, 'package.json'), '{}');

    try {
      symlinkSync(target, join(root, 'node_modules'));
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlink creation is unavailable in this environment');
        return;
      }
      throw error;
    }

    assert.throws(
      () => assertNodeModulesNotSymlink(root),
      /node_modules is a symlink/,
    );
    assert.throws(
      () => bootstrapWorktree({ dryRun: true, rootDir: root, skipEnv: true, log: quiet }),
      /node_modules is a symlink/,
    );
    assert.equal(readlinkSync(join(root, 'node_modules')), target);
  });

  it('parses bootstrap flags', () => {
    const options = parseArgs([
      '--env-source',
      '/tmp/source',
      '--cache=/tmp/cache',
      '--skip-install',
      '--hooks-only',
      '--ignore-scripts',
      '--dry-run',
    ]);

    assert.equal(options.envSource, '/tmp/source');
    assert.equal(options.cacheDir, '/tmp/cache');
    assert.equal(options.skipInstall, true);
    assert.equal(options.hooksOnly, true);
    assert.equal(options.ignoreScripts, true);
    assert.equal(options.dryRun, true);
  });

  it('stops after hooks normalization in hooks-only mode', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, '.env.vercel-export'), 'MUST_NOT_BE_SCANNED=1\n');
    const logs = [];

    assert.doesNotThrow(() => bootstrapWorktree({
      forceInstall: true,
      hooksOnly: true,
      log: line => logs.push(line),
      rootDir: root,
    }));
    assert.deepEqual(logs, []);
    assert.equal(existsSync(join(root, 'node_modules')), false);
  });

  // A stale absolute core.hooksPath makes every worktree push run ANOTHER
  // checkout's (possibly ancient) pre-push hook — the 2026-07-24 "pushes
  // take minutes and time out" incident. Worktree-creation tooling stamps
  // the shared value into .git/worktrees/<n>/config.worktree at creation
  // time, so a one-time absolute value keeps resurfacing per worktree.
  describe('decideHooksPathAction', () => {
    const root = '/repos/wm/.claude/worktrees/my-feature';

    it('leaves unset and relative hooksPath alone', () => {
      assert.equal(
        decideHooksPathAction({ rootDir: root, hooksPathValue: '', originFile: '' }).action,
        'none',
      );
      assert.equal(
        decideHooksPathAction({
          rootDir: root,
          hooksPathValue: '.husky',
          originFile: '/repos/wm/.git/config',
        }).action,
        'none',
      );
    });

    it('leaves an absolute hooksPath alone when it points into this worktree', () => {
      const result = decideHooksPathAction({
        rootDir: root,
        hooksPathValue: `${root}/.husky`,
        originFile: `/repos/wm/.git/worktrees/my-feature/config.worktree`,
      });
      assert.equal(result.action, 'none');
    });

    it('unsets a per-worktree override pointing at another checkout', () => {
      const result = decideHooksPathAction({
        rootDir: root,
        hooksPathValue: '/repos/wm/.husky',
        originFile: '/repos/wm/.git/worktrees/my-feature/config.worktree',
      });
      assert.equal(result.action, 'unset-worktree');
    });

    it('repairs the shared config when it pins hooks to another checkout', () => {
      const result = decideHooksPathAction({
        rootDir: root,
        hooksPathValue: '/repos/wm/.husky',
        hooksPathOwnedByRepository: true,
        originFile: '/repos/wm/.git/config',
      });
      assert.equal(result.action, 'repair-shared');
    });

    // Absolute-into-THIS-worktree is only harmless as a worktree-local
    // override. In the shared config it welds every OTHER worktree's push to
    // this checkout's hook file — the same bug seen from the other side.
    it('repairs a shared absolute value even when it points into this worktree', () => {
      const result = decideHooksPathAction({
        rootDir: root,
        hooksPathValue: `${root}/.husky`,
        hooksPathOwnedByRepository: true,
        originFile: '/repos/wm/.git/config',
      });
      assert.equal(result.action, 'repair-shared');
    });

    it('warns instead of repairing when the shared value is not a .husky dir', () => {
      const result = decideHooksPathAction({
        rootDir: root,
        hooksPathValue: '/opt/central-hooks',
        originFile: '/repos/wm/.git/config',
      });
      assert.equal(result.action, 'warn-shared');
    });

    it('warns instead of repairing when foreign hooks are explicitly allowed', () => {
      const result = decideHooksPathAction({
        allowForeignHooks: true,
        rootDir: root,
        hooksPathValue: '/repos/wm/.husky',
        originFile: '/repos/wm/.git/config',
      });
      assert.equal(result.action, 'warn-shared');
    });

    it('warns instead of repairing an unverified external .husky dir', () => {
      const result = decideHooksPathAction({
        rootDir: root,
        hooksPathValue: '/opt/company/.husky',
        originFile: '/repos/wm/.git/config',
      });
      assert.equal(result.action, 'warn-shared');
    });
  });

  // Real linked worktrees, because the whole bug is about WHICH config layer
  // git reads. `--show-origin` reports only the winning value, so a
  // per-worktree override masks a broken shared config until it is gone, and
  // `git config` (no --worktree) writing to the shared file from inside a
  // worktree is the exact behaviour the repair depends on. A stubbed git
  // proves none of that.
  describe('normalizeWorktreeHooksPath', () => {
    const gitEnvVars = execFileSync('git', ['rev-parse', '--local-env-vars'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');

    const fixtures = [];
    after(() => {
      for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
    });

    const git = (args, cwd) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

    /**
     * git exports GIT_DIR/GIT_WORK_TREE/... to every child of a hook, and those
     * override cwd. test:data runs from the pre-push hook, so a fixture built
     * without stripping them would rewrite core.hooksPath in the REAL repo.
     */
    function withCleanGitEnv(run) {
      const saved = new Map();
      const set = (name, value) => {
        saved.set(name, process.env[name]);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };

      for (const name of gitEnvVars) set(name, undefined);
      set('WM_ALLOW_FOREIGN_HOOKS', undefined);
      set('GIT_CONFIG_GLOBAL', '/dev/null');
      set('GIT_CONFIG_SYSTEM', '/dev/null');

      try {
        return run();
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }

    function makeWorktreeFixture() {
      const base = makeTempDir('wm-worktree-hookspath-');
      fixtures.push(base);
      const main = join(base, 'main');
      const worktree = join(base, 'feature');

      git(['init', '--quiet', '--initial-branch=main', main], base);
      git(['config', 'user.email', 'fixture@example.test'], main);
      git(['config', 'user.name', 'Fixture'], main);
      writeFileSync(join(main, 'README.md'), 'fixture\n');
      git(['add', 'README.md'], main);
      git(['commit', '--quiet', '-m', 'init'], main);
      git(['worktree', 'add', '--quiet', '-b', 'feature', worktree], main);

      return { main, sharedConfig: join(main, '.git', 'config'), worktree };
    }

    it('rewrites an absolute shared hooksPath to a relative one', () =>
      withCleanGitEnv(() => {
        const fixture = makeWorktreeFixture();
        git(['config', 'core.hooksPath', join(fixture.main, '.husky')], fixture.main);

        const result = normalizeWorktreeHooksPath({ log: quiet, rootDir: fixture.worktree });

        assert.equal(result.action, 'repair-shared');
        assert.equal(git(['config', '--get', 'core.hooksPath'], fixture.worktree), '.husky');
        assert.match(readFileSync(fixture.sharedConfig, 'utf8'), /hooksPath = \.husky/);
      }));

    // Fixing one layer looked complete and silently wasn't (2026-07-24): the
    // override hid the shared value, so the shared value was never seen.
    it('repairs the shared value that a per-worktree override was masking', () =>
      withCleanGitEnv(() => {
        const fixture = makeWorktreeFixture();
        git(['config', 'extensions.worktreeConfig', 'true'], fixture.main);
        git(['config', 'core.hooksPath', join(fixture.main, '.husky')], fixture.main);
        git(['config', '--worktree', 'core.hooksPath', '/elsewhere/.husky'], fixture.worktree);

        const result = normalizeWorktreeHooksPath({ log: quiet, rootDir: fixture.worktree });

        assert.deepEqual(
          result.decisions.map((decision) => decision.action),
          ['unset-worktree', 'repair-shared'],
        );
        assert.equal(git(['config', '--get', 'core.hooksPath'], fixture.worktree), '.husky');
        assert.match(readFileSync(fixture.sharedConfig, 'utf8'), /hooksPath = \.husky/);
      }));

    it('reports the repair without writing it under --dry-run', () =>
      withCleanGitEnv(() => {
        const fixture = makeWorktreeFixture();
        const absolute = join(fixture.main, '.husky');
        git(['config', 'core.hooksPath', absolute], fixture.main);

        const result = normalizeWorktreeHooksPath({
          dryRun: true,
          log: quiet,
          rootDir: fixture.worktree,
        });

        assert.equal(result.action, 'repair-shared');
        assert.equal(git(['config', '--get', 'core.hooksPath'], fixture.worktree), absolute);
      }));

    it('leaves an external .husky directory alone', () =>
      withCleanGitEnv(() => {
        const fixture = makeWorktreeFixture();
        const external = join(fixture.main, '..', 'company-hooks', '.husky');
        mkdirSync(external, { recursive: true });
        git(['config', 'core.hooksPath', external], fixture.main);

        const result = normalizeWorktreeHooksPath({ log: quiet, rootDir: fixture.worktree });

        assert.equal(result.action, 'warn-shared');
        assert.equal(git(['config', '--get', 'core.hooksPath'], fixture.worktree), external);
      }));

    it('fails bootstrap when a worktree override cannot be removed', () =>
      withCleanGitEnv(() => {
        const fixture = makeWorktreeFixture();
        git(['config', 'extensions.worktreeConfig', 'true'], fixture.main);
        git(['config', '--worktree', 'core.hooksPath', '/elsewhere/.husky'], fixture.worktree);
        const runGit = (command, args, options) =>
          args.includes('--unset') ? { status: 128 } : spawnSync(command, args, options);

        assert.throws(
          () => normalizeWorktreeHooksPath({
            log: quiet,
            rootDir: fixture.worktree,
            runGit,
          }),
          /failed to remove stale worktree hooksPath override/,
        );
      }));

    it('fails bootstrap when the shared repair cannot be written', () =>
      withCleanGitEnv(() => {
        const fixture = makeWorktreeFixture();
        git(['config', 'core.hooksPath', join(fixture.main, '.husky')], fixture.main);
        const runGit = (command, args, options) =>
          args[0] === 'config' && args[1] === 'core.hooksPath'
            ? { status: 128 }
            : spawnSync(command, args, options);

        assert.throws(
          () => normalizeWorktreeHooksPath({
            log: quiet,
            rootDir: fixture.worktree,
            runGit,
          }),
          /failed to repair shared hooksPath/,
        );
      }));

    it('leaves an already-relative shared hooksPath untouched', () =>
      withCleanGitEnv(() => {
        const fixture = makeWorktreeFixture();
        git(['config', 'core.hooksPath', '.husky'], fixture.main);
        const before = readFileSync(fixture.sharedConfig, 'utf8');

        const result = normalizeWorktreeHooksPath({ log: quiet, rootDir: fixture.worktree });

        assert.equal(result.action, 'none');
        assert.equal(readFileSync(fixture.sharedConfig, 'utf8'), before);
      }));

    it('leaves the config alone when core.hooksPath is unset', () =>
      withCleanGitEnv(() => {
        const fixture = makeWorktreeFixture();
        const before = readFileSync(fixture.sharedConfig, 'utf8');

        const result = normalizeWorktreeHooksPath({ log: quiet, rootDir: fixture.worktree });

        assert.equal(result.action, 'none');
        assert.equal(readFileSync(fixture.sharedConfig, 'utf8'), before);
      }));
  });
});
