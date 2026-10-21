// Nested workspaces (blog-site, pro-test) carry their own lockfiles, and
// installing one takes minutes. Whichever script installs them decides how many
// CI jobs pay that cost.
//
// Regression motivation: postinstall used to run `npm --prefix blog-site ci`,
// so every `npm ci` in the matrix installed the blog — including dom-tests,
// unit, typecheck and biome, none of which read a single file from it. Measured
// locally from a clean blog-site, that install is ~5 minutes against the
// dom-tests job's 10-minute budget, and it timed the job out on #7644 and #7645
// three times in a row while the tests themselves passed in seconds.
//
// The rule: a nested workspace is installed by the build script that needs it,
// never by postinstall. build:pro already did this; build:blog:raw now matches.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { scripts } = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));

const NESTED_WORKSPACES = [
  { name: 'blog-site', installedBy: 'build:blog:raw' },
  { name: 'pro-test', installedBy: 'build:pro' },
];

describe('nested workspace install topology', () => {
  for (const { name, installedBy } of NESTED_WORKSPACES) {
    const installs = (script) => new RegExp(`--prefix\\s+${name}\\s+ci\\b`).test(script ?? '');

    it(`${name} is installed by ${installedBy}, so the build path is self-sufficient`, () => {
      assert.ok(
        installs(scripts[installedBy]),
        `${installedBy} must install ${name} itself: a build that assumes postinstall did it `
          + 'breaks on any --ignore-scripts install, which is what the Dockerfile uses.',
      );
    });

    it(`postinstall does not install ${name}`, () => {
      assert.ok(
        !installs(scripts.postinstall),
        `postinstall must not install ${name}. Every npm ci in CI pays that cost, including `
          + 'the jobs that never read the workspace, and it has timed dom-tests out before.',
      );
    });
  }

  it('postinstall stays cheap enough for a test job to afford', () => {
    // inventory:facts is a boot artifact the whole repo reads and it runs in
    // under a second. Anything heavier belongs behind the script that needs it.
    assert.equal(scripts.postinstall, 'npm run inventory:facts');
  });

  it('every blog build path routes through the script that installs the blog', () => {
    for (const name of ['build', 'build:full', 'build:blog']) {
      assert.match(
        scripts[name],
        /build:blog:raw/,
        `${name} must reach the blog through build:blog:raw rather than invoking astro directly, `
          + 'or it will build against a missing or stale blog-site node_modules.',
      );
    }
  });
});
