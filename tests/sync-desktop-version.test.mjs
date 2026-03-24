import test from 'node:test';
import assert from 'node:assert/strict';

import {
  updateCargoLockVersion,
  updatePackageLockVersion,
} from '../scripts/sync-desktop-version-lib.mjs';

test('updatePackageLockVersion updates both root version fields', () => {
  const packageLock = {
    name: 'worldmonitor-macos',
    version: '2.6.1',
    packages: {
      '': {
        name: 'worldmonitor-macos',
        version: '2.6.1',
      },
      'node_modules/esbuild': {
        version: '0.27.3',
      },
    },
  };

  const result = updatePackageLockVersion(packageLock, '2.7.0');

  assert.equal(result.changed, true);
  assert.equal(result.currentVersion, '2.6.1');
  assert.equal(result.updatedLockfile.version, '2.7.0');
  assert.equal(result.updatedLockfile.packages[''].version, '2.7.0');
  assert.equal(result.updatedLockfile.packages['node_modules/esbuild'].version, '0.27.3');
});

test('updateCargoLockVersion only updates the app package block', () => {
  const cargoLock = `[[package]]
name = "serde"
version = "1.0.0"

[[package]]
name = "worldmonitor-macos"
version = "2.6.1"
dependencies = [
 "serde",
]

[[package]]
name = "worldmonitor-macos-helper"
version = "9.9.9"
`;

  const result = updateCargoLockVersion(cargoLock, 'worldmonitor-macos', '2.7.0');

  assert.equal(result.changed, true);
  assert.equal(result.currentVersion, '2.6.1');
  assert.match(result.updatedLock, /name = "worldmonitor-macos"\nversion = "2.7.0"/);
  assert.match(result.updatedLock, /name = "worldmonitor-macos-helper"\nversion = "9.9.9"/);
});

test('updateCargoLockVersion parses Cargo.lock blocks with CRLF line endings', () => {
  const cargoLock = `[[package]]\r
name = "worldmonitor-macos"\r
version = "2.6.1"\r
\r
[[package]]\r
name = "serde"\r
version = "1.0.0"\r
`;

  const result = updateCargoLockVersion(cargoLock, 'worldmonitor-macos', '2.7.0');

  assert.equal(result.changed, true);
  assert.equal(result.currentVersion, '2.6.1');
  assert.match(result.updatedLock, /name = "worldmonitor-macos"\r?\nversion = "2.7.0"/);
});
