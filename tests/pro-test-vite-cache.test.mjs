import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  ENV_CACHE_DIR,
  hashLockfile,
  resolveProTestViteCacheDir,
} from '../scripts/pro-test-vite-cache.mjs';
import { createTempDir } from './helpers/temp-dir.mjs';

describe('pro-test vite cacheDir (#6766)', () => {
  it('honours WM_PRO_TEST_VITE_CACHE over git and lockfile', () => {
    const dir = resolve('/tmp/explicit-pro-test-vite');
    const resolved = resolveProTestViteCacheDir({
      env: { [ENV_CACHE_DIR]: dir },
      gitCommonDir: '/repo/.git',
      lockfileContents: '{"lockfileVersion":3}',
    });
    assert.equal(resolved, dir);
  });

  it('shards a git-common-dir cache by the lockfile hash', () => {
    const lockfile = '{"lockfileVersion":3,"packages":{}}';
    const shard = hashLockfile(lockfile);
    const resolved = resolveProTestViteCacheDir({
      env: {},
      gitCommonDir: '/repos/wm/.git',
      lockfileContents: lockfile,
    });
    assert.equal(resolved, resolve('/repos/wm/.git/wm-vite-cache', `pro-test-${shard}`));
    assert.equal(shard, createHash('sha256').update(lockfile).digest('hex').slice(0, 12));
  });

  it('gives two worktrees the same path for the same lockfile', () => {
    const lockfile = '{"name":"worldmonitor-pro"}';
    const a = resolveProTestViteCacheDir({
      env: {},
      gitCommonDir: '/repos/wm/.git',
      lockfileContents: lockfile,
    });
    const b = resolveProTestViteCacheDir({
      env: {},
      gitCommonDir: '/repos/wm/.git',
      lockfileContents: lockfile,
    });
    assert.equal(a, b);
  });

  it('isolates a lockfile bump from a stale dep-optimize cache', () => {
    const common = '/repos/wm/.git';
    const before = resolveProTestViteCacheDir({
      env: {},
      gitCommonDir: common,
      lockfileContents: '{"packages":{"a":{}}}',
    });
    const after = resolveProTestViteCacheDir({
      env: {},
      gitCommonDir: common,
      lockfileContents: '{"packages":{"a":{},"b":{}}}',
    });
    assert.notEqual(before, after);
  });

  it('falls back to the per-package vite cache when git is unavailable', () => {
    const root = createTempDir('wm-pro-test-vite-');
    const resolved = resolveProTestViteCacheDir({
      env: {},
      proTestRoot: root,
      gitCommonDir: '',
      lockfileContents: '{}',
    });
    assert.equal(resolved, resolve(root, 'node_modules', '.vite'));
  });

  it('reads package-lock.json from the pro-test root when contents are not injected', () => {
    const root = createTempDir('wm-pro-test-lock-');
    const lockfile = '{"fromDisk":true}\n';
    writeFileSync(join(root, 'package-lock.json'), lockfile);
    const resolved = resolveProTestViteCacheDir({
      env: {},
      proTestRoot: root,
      gitCommonDir: '/repos/wm/.git',
    });
    assert.equal(
      resolved,
      resolve('/repos/wm/.git/wm-vite-cache', `pro-test-${hashLockfile(lockfile)}`),
    );
  });

  it('does not point cacheDir at node_modules or a symlink of it', () => {
    const root = createTempDir('wm-pro-test-nosym-');
    mkdirSync(join(root, 'node_modules'));
    const resolved = resolveProTestViteCacheDir({
      env: {},
      proTestRoot: root,
      gitCommonDir: '/repos/wm/.git',
      lockfileContents: '{}',
    });
    assert.ok(!resolved.startsWith(resolve(root, 'node_modules')));
    assert.match(resolved, /wm-vite-cache/);
  });
});
