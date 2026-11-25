import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// git matches a path that does not exist as a file, the way it matches a
// symlink. An installed node_modules is a directory, which the old rule
// "node_modules/" also ignored, so probe under a prefix that cannot exist.
function isIgnored(path) {
  return spawnSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: root }).status === 0;
}

describe('.gitignore', () => {
  it('ignores a node_modules symlink as well as a directory', () => {
    const path = `gitignore-probe-${randomUUID()}/node_modules`;
    assert.ok(isIgnored(path),
      'A node_modules symlink is not ignored. A trailing slash matches directories only, so write the root .gitignore entry as "node_modules".');
  });
});
