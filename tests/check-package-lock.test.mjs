import test from 'node:test';
import assert from 'node:assert/strict';

import { findMissingPackageLockVersions } from '../scripts/check-package-lock.mjs';

test('findMissingPackageLockVersions accepts valid package entries', () => {
  const failures = findMissingPackageLockVersions({
    packages: {
      '': { name: 'worldmonitor-macos', version: '2.5.25' },
      'node_modules/esbuild': { version: '0.27.3', dev: true },
      'node_modules/example-link': { link: true }
    },
    dependencies: {
      esbuild: { version: '0.27.3' },
      'example-link': { link: true }
    }
  });

  assert.deepEqual(failures, []);
});

test('findMissingPackageLockVersions reports package and dependency entries with empty versions', () => {
  const failures = findMissingPackageLockVersions({
    packages: {
      '': { name: 'worldmonitor-macos', version: '2.5.25' },
      'node_modules/@esbuild/linux-mips64el': { optional: true, version: '' },
      'node_modules/@esbuild/win32-ia32': { optional: true }
    },
    dependencies: {
      '@esbuild/linux-mips64el': { version: '' },
      '@esbuild/win32-ia32': {}
    }
  });

  assert.deepEqual(failures, [
    'packages.node_modules/@esbuild/linux-mips64el',
    'packages.node_modules/@esbuild/win32-ia32',
    'dependencies.@esbuild/linux-mips64el',
    'dependencies.@esbuild/win32-ia32'
  ]);
});
