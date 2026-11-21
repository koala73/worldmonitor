import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// git treats a path that does not exist as a file, so this asks how a
// node_modules symlink would be matched. be77a47129 committed one.
function isIgnored(path) {
  return spawnSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: root }).status === 0;
}

describe('.gitignore', () => {
  for (const path of ['node_modules', 'consumer-prices-core/node_modules', 'pro-test/node_modules']) {
    it(`ignores a ${path} symlink as well as a directory`, () => {
      assert.ok(isIgnored(path),
        `${path} is not ignored when it is a symlink. A trailing slash matches directories only, so write the root .gitignore entry as "node_modules".`);
    });
  }
});
