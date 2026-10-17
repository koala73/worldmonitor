import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  BUN_INSTALL_MARKER,
  hasFreshBunInstall,
  shouldInstallDependencies,
  writeBunInstallMarker,
} from '../scripts/bootstrap-worktree.mjs';

const roots = [];

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'wm-bun-marker-'));
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('bun completed-install marker', () => {
  it('treats an npm-installed tree exactly as before (no bun lockfile present)', () => {
    const root = makeRoot();
    assert.equal(shouldInstallDependencies({ rootDir: root }), true);
    writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}');
    assert.equal(shouldInstallDependencies({ rootDir: root }), false);
  });

  it('does not trust a bun tree that carries no marker', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'bun.lock'), 'lock-v1');
    // node_modules/.bin exists after an INTERRUPTED install too, so its
    // presence must not be enough to skip the install.
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    assert.equal(hasFreshBunInstall(root), false);
    assert.equal(shouldInstallDependencies({ rootDir: root }), true);
  });

  it('trusts a marker that matches the current lockfile', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'bun.lock'), 'lock-v1');
    assert.equal(writeBunInstallMarker(root), true);
    assert.equal(hasFreshBunInstall(root), true);
    assert.equal(shouldInstallDependencies({ rootDir: root }), false);
  });

  it('rejects a STALE marker after the lockfile changes', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'bun.lock'), 'lock-v1');
    writeBunInstallMarker(root);
    assert.equal(hasFreshBunInstall(root), true);

    // A dependency bump rewrites the lockfile. npm's .package-lock.json marker
    // cannot detect this; the digest marker must.
    writeFileSync(join(root, 'bun.lock'), 'lock-v2');
    assert.equal(hasFreshBunInstall(root), false);
    assert.equal(shouldInstallDependencies({ rootDir: root }), true);
  });

  it('writes no marker when there is no bun lockfile to hash', () => {
    const root = makeRoot();
    assert.equal(writeBunInstallMarker(root), false);
    assert.equal(hasFreshBunInstall(root), false);
  });

  it('still honours forceInstall over a fresh marker', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'bun.lock'), 'lock-v1');
    writeBunInstallMarker(root);
    assert.equal(shouldInstallDependencies({ rootDir: root, forceInstall: true }), true);
  });

  it('names the marker inside node_modules so a clean wipe resets it', () => {
    assert.equal(BUN_INSTALL_MARKER, 'node_modules/.wm-bun-install');
  });
});
