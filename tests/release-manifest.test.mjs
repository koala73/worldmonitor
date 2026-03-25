import test from 'node:test';
import assert from 'node:assert/strict';

import {
  combineReleaseManifests,
  isReleaseArtifactName,
  verifyDownloadedAssets,
} from '../scripts/release-manifest.mjs';

test('release manifest only accepts versioned distributable filenames', () => {
  assert.equal(isReleaseArtifactName('World Monitor_2.7.2_aarch64.dmg', '2.7.2'), true);
  assert.equal(isReleaseArtifactName('World Monitor.app', '2.7.2'), false);
  assert.equal(isReleaseArtifactName('notes.txt', '2.7.2'), false);
});

test('release manifest combine rejects duplicate asset names across platforms', () => {
  assert.throws(
    () => combineReleaseManifests([
      {
        version: '2.7.2',
        variant: 'full',
        tag: 'v2.7.2',
        commitSha: 'abc',
        generatedAt: '2026-03-17T00:00:00.000Z',
        assets: [{ name: 'World Monitor_2.7.2_aarch64.dmg', sha256: '1', size: 1 }],
      },
      {
        version: '2.7.2',
        variant: 'full',
        tag: 'v2.7.2',
        commitSha: 'abc',
        generatedAt: '2026-03-17T00:00:00.000Z',
        assets: [{ name: 'World Monitor_2.7.2_aarch64.dmg', sha256: '2', size: 2 }],
      },
    ]),
    /Duplicate asset names/,
  );
});

test('release manifest verification reports missing and unexpected assets', () => {
  assert.deepEqual(
    verifyDownloadedAssets(
      {
        assets: [{ name: 'World Monitor_2.7.2_aarch64.dmg' }],
      },
      ['/tmp/World Monitor_2.7.2_aarch64.dmg', '/tmp/unexpected.txt'],
    ),
    ['Unexpected release asset: unexpected.txt'],
  );
});

test('release manifest verification treats dot-vs-space app names as equivalent', () => {
  assert.deepEqual(
    verifyDownloadedAssets(
      {
        assets: [{ name: 'World Monitor_2.7.3_x64.dmg' }],
      },
      ['/tmp/World.Monitor_2.7.3_x64.dmg'],
    ),
    [],
  );
});
